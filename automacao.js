// src/automacao.js
// Envia alertas automáticos pelo Telegram quando preços atingem alvos
// Roda a cada 30 minutos via cron job — produtor não precisa entrar na plataforma

const cron = require('node-cron');
const fetch = require('node-fetch');
const { buscarTodosPrecos } = require('./precos');

const NOMES_CULTURA = {
  cafe: 'Café Arábica ☕',
  soja: 'Soja 🌱',
  milho: 'Milho 🌽',
  boi: 'Boi Gordo 🐂',
  algodao: 'Algodão 🌸',
  trigo: 'Trigo 🌾',
  acucar: 'Açúcar 🍬'
};

const UNIDADES = {
  cafe: 'saca', soja: 'saca', milho: 'saca',
  boi: '@', algodao: 'arroba', trigo: 'saca', acucar: 'saca'
};

// Enviar mensagem pelo Telegram
async function enviarTelegram(botToken, chatId, mensagem) {
  try {
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: mensagem,
        parse_mode: 'HTML'
      }),
      timeout: 10000
    });
    const data = await res.json();
    return data.ok;
  } catch (e) {
    console.error('Erro Telegram:', e.message);
    return false;
  }
}

// Verificar e disparar alertas de preço
async function verificarAlertas(supabase) {
  try {
    // Buscar preços reais agora
    const precos = await buscarTodosPrecos();
    if (!precos.dolar) {
      console.log('Automação: dólar indisponível, pulando ciclo');
      return;
    }

    // Salvar preços no histórico
    const registros = Object.entries(precos.precos)
      .filter(([, v]) => v.disponivel)
      .map(([cultura, v]) => ({
        cultura,
        preco_brl: v.brl,
        preco_usd: v.usd,
        dolar: precos.dolar,
        fonte: precos.fonte
      }));

    if (registros.length > 0) {
      await supabase.from('historico_precos').insert(registros);
    }

    // Buscar todas as configurações de alerta ativas com assinante ativo
    const { data: configs, error } = await supabase
      .from('configuracoes_alertas')
      .select(`
        *,
        assinantes (
          id, nome, telegram_bot_token, telegram_chat_id,
          ativo, validade, plano
        )
      `)
      .eq('alerta_ativo', true);

    if (error || !configs?.length) return;

    const hoje = new Date().toISOString().split('T')[0];

    for (const config of configs) {
      const assinante = config.assinantes;

      // Verificar assinatura válida
      if (!assinante?.ativo) continue;
      if (assinante.validade < hoje) continue;
      if (!assinante.telegram_bot_token || !assinante.telegram_chat_id) continue;

      const precoAtual = precos.precos[config.cultura]?.brl;
      if (!precoAtual || !config.preco_alvo) continue;

      // Verificar se preço atingiu o alvo
      if (precoAtual >= config.preco_alvo) {
        // Evitar spam: verificar se já enviou alerta há menos de 6 horas
        if (config.ultimo_alerta) {
          const diff = Date.now() - new Date(config.ultimo_alerta).getTime();
          if (diff < 6 * 60 * 60 * 1000) continue;
        }

        const cultura = config.cultura;
        const unidade = UNIDADES[cultura] || 'unidade';
        const pct = config.percentual_venda || 30;
        const nomeCultura = NOMES_CULTURA[cultura] || cultura;

        const mensagem =
          `🚨 <b>ALERTA AGROVENDA PRO</b>\n\n` +
          `${nomeCultura} atingiu <b>R$ ${precoAtual.toLocaleString('pt-BR')}/${unidade}</b>\n\n` +
          `📊 Seu alvo era: R$ ${config.preco_alvo.toLocaleString('pt-BR')}/${unidade}\n` +
          `💵 Dólar atual: R$ ${precos.dolar.toFixed(2)}\n\n` +
          `✅ <b>Recomendação: venda ${pct}% da produção agora</b>\n\n` +
          `⏰ ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n` +
          `🔗 AgroVenda Pro`;

        const enviado = await enviarTelegram(
          assinante.telegram_bot_token,
          assinante.telegram_chat_id,
          mensagem
        );

        // Registrar alerta no banco
        await supabase.from('alertas').insert({
          assinante_id: assinante.id,
          cultura,
          tipo: 'preco_atingido',
          mensagem,
          preco_gatilho: precoAtual,
          telegram_enviado: enviado,
          telegram_erro: enviado ? null : 'Falha no envio'
        });

        // Atualizar timestamp do último alerta
        await supabase
          .from('configuracoes_alertas')
          .update({ ultimo_alerta: new Date().toISOString() })
          .eq('id', config.id);

        console.log(`✅ Alerta enviado: ${assinante.nome} | ${cultura} | R$ ${precoAtual}`);
      }
    }
  } catch (e) {
    console.error('Erro na automação:', e.message);
  }
}

// Análise diária automática (8h da manhã, horário de Brasília)
async function analiseDiaria(supabase, anthropicKey) {
  try {
    const precos = await buscarTodosPrecos();
    if (!precos.dolar) return;

    const hoje = new Date().toISOString().split('T')[0];

    // Buscar assinantes ativos com Telegram configurado
    const { data: assinantes } = await supabase
      .from('assinantes')
      .select('*')
      .eq('ativo', true)
      .gte('validade', hoje);

    if (!assinantes?.length) return;

    for (const assinante of assinantes) {
      if (!assinante.telegram_bot_token || !assinante.telegram_chat_id) continue;

      const culturas = assinante.culturas_interesse || ['cafe', 'soja', 'milho', 'boi'];

      // Montar resumo dos preços do dia
      let linhasPrecos = '';
      for (const c of culturas.slice(0, 4)) {
        const p = precos.precos[c];
        if (p?.brl) {
          linhasPrecos += `${NOMES_CULTURA[c]}: <b>R$ ${p.brl.toLocaleString('pt-BR')}</b>\n`;
        }
      }

      const mensagem =
        `🌾 <b>BOM DIA! Relatório AgroVenda Pro</b>\n` +
        `📅 ${new Date().toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', day: 'numeric', month: 'long' })}\n\n` +
        `💵 Dólar: <b>R$ ${precos.dolar.toFixed(2)}</b>\n\n` +
        `📊 <b>Preços de hoje:</b>\n${linhasPrecos}\n` +
        `💡 Acesse a plataforma para análise completa com IA.\n\n` +
        `🔗 AgroVenda Pro`;

      const enviado = await enviarTelegram(
        assinante.telegram_bot_token,
        assinante.telegram_chat_id,
        mensagem
      );

      if (enviado) {
        await supabase.from('alertas').insert({
          assinante_id: assinante.id,
          cultura: 'geral',
          tipo: 'analise_diaria',
          mensagem,
          telegram_enviado: true
        });
      }
    }

    console.log(`📊 Análise diária enviada para ${assinantes.length} assinantes`);
  } catch (e) {
    console.error('Erro análise diária:', e.message);
  }
}

// Iniciar automação
function iniciarAutomacao(supabase, anthropicKey) {
  console.log('🤖 Automação iniciada');

  // Verificar preços e alertas a cada 30 minutos
  cron.schedule('*/30 * * * *', () => {
    console.log('⏰ Verificando alertas de preço...');
    verificarAlertas(supabase);
  });

  // Análise diária às 8h (horário de Brasília = UTC-3)
  cron.schedule('0 11 * * *', () => {
    console.log('📊 Enviando análise diária...');
    analiseDiaria(supabase, anthropicKey);
  });

  // Executar imediatamente ao iniciar (para testar)
  setTimeout(() => verificarAlertas(supabase), 5000);
}

module.exports = { iniciarAutomacao, verificarAlertas, enviarTelegram };
