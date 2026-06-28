// src/server.js
// AgroVenda Pro v2 — Backend completo
// Supabase + preços reais + automação Telegram

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');
const { buscarTodosPrecos } = require('./precos');
const { iniciarAutomacao, enviarTelegram } = require('./automacao');

const app = express();
app.use(express.json());
app.use(cors());

// ─── VERIFICAR VARIÁVEIS OBRIGATÓRIAS ───────────────────────────────────────
const VARS_OBRIGATORIAS = ['ANTHROPIC_API_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'];
const varsFaltando = VARS_OBRIGATORIAS.filter(v => !process.env[v]);
if (varsFaltando.length > 0) {
  console.error('❌ ERRO: Variáveis de ambiente não configuradas:', varsFaltando.join(', '));
  console.error('Configure essas variáveis no Railway/Render antes de continuar.');
  process.exit(1);
}

// ─── SUPABASE ────────────────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── MIDDLEWARE: AUTENTICAR TOKEN ────────────────────────────────────────────
async function autenticar(req, res, next) {
  const token = (req.headers['x-access-token'] || req.body?.token || '').toUpperCase().trim();
  if (!token) return res.status(401).json({ erro: 'Token não informado.' });

  const { data: assinante, error } = await supabase
    .from('assinantes')
    .select('*')
    .eq('token', token)
    .single();

  if (error || !assinante) return res.status(401).json({ erro: 'Token inválido.' });
  if (!assinante.ativo) return res.status(403).json({ erro: 'Acesso suspenso. Entre em contato.' });

  const hoje = new Date().toISOString().split('T')[0];
  if (assinante.validade < hoje) return res.status(403).json({ erro: 'Assinatura vencida. Renove seu plano.' });

  req.assinante = assinante;
  next();
}

// ─── ROTAS DE AUTENTICAÇÃO ───────────────────────────────────────────────────

// Verificar token
app.post('/verificar', async (req, res) => {
  const token = (req.body?.token || '').toUpperCase().trim();
  if (!token) return res.json({ ok: false, erro: 'Token não informado.' });

  const { data: assinante } = await supabase
    .from('assinantes')
    .select('nome, plano, validade, ativo, telegram_chat_id, culturas_interesse')
    .eq('token', token)
    .single();

  if (!assinante || !assinante.ativo) return res.json({ ok: false, erro: 'Token inválido.' });

  const hoje = new Date().toISOString().split('T')[0];
  if (assinante.validade < hoje) return res.json({ ok: false, erro: 'Assinatura vencida.' });

  res.json({
    ok: true,
    nome: assinante.nome,
    plano: assinante.plano,
    telegram_configurado: !!assinante.telegram_chat_id,
    culturas: assinante.culturas_interesse || ['cafe','soja','milho','boi']
  });
});

// ─── ROTAS DE PREÇOS ─────────────────────────────────────────────────────────

// Preços reais em tempo real
app.get('/precos', autenticar, async (req, res) => {
  try {
    const precos = await buscarTodosPrecos();
    res.json({ ok: true, ...precos });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// ─── ROTAS DE ANÁLISE ────────────────────────────────────────────────────────

app.post('/analisar', autenticar, async (req, res) => {
  const { cultura, prompt } = req.body;
  if (!prompt) return res.status(400).json({ erro: 'Prompt não informado.' });

  try {
    // Buscar preços reais para incluir na análise
    const precos = await buscarTodosPrecos();
    const precoAtual = precos.precos[cultura]?.brl;
    const dolar = precos.dolar;

    // Enriquecer o prompt com dados reais
    const promptEnriquecido = prompt +
      `\n\nDADOS REAIS AGORA (use estes valores na análise):\n` +
      `- Dólar (USD/BRL): R$ ${dolar ? dolar.toFixed(2) : 'indisponível'}\n` +
      `- Preço ${cultura} agora: ${precoAtual ? `R$ ${precoAtual.toLocaleString('pt-BR')}` : 'indisponível'}\n` +
      `- Fonte: Banco Central do Brasil + Yahoo Finance\n` +
      `- Coletado em: ${precos.timestamp}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: promptEnriquecido }]
      }),
      timeout: 60000
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ erro: data?.error?.message || 'Erro na API Anthropic.' });
    }

    // Extrair texto da resposta
    const texto = (data.content || [])
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    // Salvar análise no banco
    try {
      const jsonMatch = texto.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const analise = JSON.parse(jsonMatch[0]);
        await supabase.from('analises').insert({
          assinante_id: req.assinante.id,
          cultura,
          veredito: analise.veredito || '',
          score: analise.score || 0,
          resumo: analise.resumo || '',
          analise_completa: analise,
          preco_na_analise: precoAtual,
          dolar_na_analise: dolar
        });
      }
    } catch (e) {
      console.warn('Aviso: não foi possível salvar análise no banco:', e.message);
    }

    res.json(data);

  } catch (e) {
    console.error('Erro análise:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ─── ROTAS DE TELEGRAM ───────────────────────────────────────────────────────

// Cadastrar/atualizar grupo Telegram do assinante
app.post('/telegram/cadastrar', autenticar, async (req, res) => {
  const { bot_token, chat_id } = req.body;
  if (!bot_token || !chat_id) {
    return res.status(400).json({ erro: 'bot_token e chat_id são obrigatórios.' });
  }

  const { error } = await supabase
    .from('assinantes')
    .update({
      telegram_bot_token: bot_token,
      telegram_chat_id: chat_id,
      atualizado_em: new Date().toISOString()
    })
    .eq('id', req.assinante.id);

  if (error) return res.status(500).json({ erro: 'Erro ao salvar configuração.' });

  // Enviar mensagem de confirmação
  const confirmacao =
    `✅ <b>AgroVenda Pro configurado!</b>\n\n` +
    `Olá, <b>${req.assinante.nome}</b>!\n` +
    `Seu grupo está conectado. Você receberá:\n\n` +
    `📊 Relatório diário às 8h\n` +
    `🚨 Alertas quando preços atingirem seus alvos\n` +
    `💡 Recomendações de venda automáticas\n\n` +
    `🌾 AgroVenda Pro`;

  const enviado = await enviarTelegram(bot_token, chat_id, confirmacao);
  res.json({ ok: true, telegram_confirmado: enviado });
});

// Enviar alerta manual
app.post('/telegram/enviar', autenticar, async (req, res) => {
  const { mensagem } = req.body;
  const assinante = req.assinante;

  if (!assinante.telegram_bot_token || !assinante.telegram_chat_id) {
    return res.status(400).json({ erro: 'Telegram não configurado. Use /telegram/cadastrar primeiro.' });
  }

  const enviado = await enviarTelegram(
    assinante.telegram_bot_token,
    assinante.telegram_chat_id,
    mensagem || '🌾 Alerta AgroVenda Pro'
  );

  await supabase.from('alertas').insert({
    assinante_id: assinante.id,
    cultura: 'geral',
    tipo: 'manual',
    mensagem: mensagem || '',
    telegram_enviado: enviado
  });

  res.json({ ok: enviado });
});

// ─── ROTAS DE CONFIGURAÇÃO DE ALERTAS ───────────────────────────────────────

// Configurar preço alvo para alerta automático
app.post('/alertas/configurar', autenticar, async (req, res) => {
  const { cultura, preco_alvo, percentual_venda } = req.body;
  if (!cultura || !preco_alvo) {
    return res.status(400).json({ erro: 'cultura e preco_alvo são obrigatórios.' });
  }

  const { error } = await supabase
    .from('configuracoes_alertas')
    .upsert({
      assinante_id: req.assinante.id,
      cultura,
      preco_alvo,
      percentual_venda: percentual_venda || 30,
      alerta_ativo: true
    }, { onConflict: 'assinante_id,cultura' });

  if (error) return res.status(500).json({ erro: 'Erro ao salvar configuração.' });
  res.json({ ok: true, mensagem: `Alerta configurado: ${cultura} @ R$ ${preco_alvo}` });
});

// Listar alertas configurados
app.get('/alertas/meus', autenticar, async (req, res) => {
  const { data } = await supabase
    .from('configuracoes_alertas')
    .select('*')
    .eq('assinante_id', req.assinante.id);
  res.json({ ok: true, alertas: data || [] });
});

// Histórico de alertas recebidos
app.get('/alertas/historico', autenticar, async (req, res) => {
  const { data } = await supabase
    .from('alertas')
    .select('*')
    .eq('assinante_id', req.assinante.id)
    .order('criado_em', { ascending: false })
    .limit(50);
  res.json({ ok: true, historico: data || [] });
});

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: '🌾 AgroVenda Pro API v2 rodando',
    versao: '2.0.0',
    recursos: ['precos_reais', 'supabase', 'automacao_telegram', 'analise_ia'],
    timestamp: new Date().toISOString()
  });
});

// ─── INICIAR ─────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🌾 AgroVenda Pro v2 rodando na porta ${PORT}`);
  console.log(`✅ Supabase: ${process.env.SUPABASE_URL}`);
  console.log(`✅ Anthropic API: configurada`);

  // Iniciar automação
  iniciarAutomacao(supabase, process.env.ANTHROPIC_API_KEY);
});
