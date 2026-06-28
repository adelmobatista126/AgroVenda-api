const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(cors());

// =====================================================
// CONFIGURAÇÃO — edite aqui antes de subir no Render
// =====================================================
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-SUA-CHAVE-AQUI';

// Tokens de acesso dos seus clientes
// Formato: 'TOKEN': { nome, plano, ativo, validade }
// Para gerar um token: qualquer string única, ex: 'JOAO-FAZENDA-2025'
const TOKENS_VALIDOS = {
  'DEMO-AGROVENDA-2025': {
    nome: 'Demo',
    plano: 'trial',
    ativo: true,
    validade: '2099-12-31'
  },
  // Adicione clientes aqui:
  // 'TOKEN-DO-CLIENTE': { nome: 'Nome', plano: 'mensal', ativo: true, validade: '2025-12-31' }
};
// =====================================================

// Middleware de autenticação
function autenticar(req, res, next) {
  const token = req.headers['x-access-token'] || req.body?.accessToken;
  if (!token) {
    return res.status(401).json({ erro: 'Token de acesso não informado.' });
  }
  const cliente = TOKENS_VALIDOS[token.toUpperCase()];
  if (!cliente) {
    return res.status(401).json({ erro: 'Token inválido. Verifique seu acesso.' });
  }
  if (!cliente.ativo) {
    return res.status(403).json({ erro: 'Acesso suspenso. Entre em contato.' });
  }
  const hoje = new Date().toISOString().split('T')[0];
  if (cliente.validade < hoje) {
    return res.status(403).json({ erro: 'Assinatura vencida. Renove seu plano.' });
  }
  req.cliente = cliente;
  next();
}

// Rota de verificação de token
app.post('/verificar', (req, res) => {
  const token = req.body?.token;
  if (!token) return res.json({ ok: false, erro: 'Token não informado.' });

  const cliente = TOKENS_VALIDOS[token.toUpperCase()];
  if (!cliente || !cliente.ativo) return res.json({ ok: false, erro: 'Token inválido.' });

  const hoje = new Date().toISOString().split('T')[0];
  if (cliente.validade < hoje) return res.json({ ok: false, erro: 'Assinatura vencida.' });

  res.json({ ok: true, nome: cliente.nome, plano: cliente.plano });
});

// Rota principal — proxy para Anthropic
app.post('/analisar', autenticar, async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) return res.status(400).json({ erro: 'Prompt não informado.' });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(500).json({ erro: data?.error?.message || 'Erro na API.' });
    }

    res.json(data);

  } catch (err) {
    res.status(500).json({ erro: 'Erro interno: ' + err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'AgroVenda Pro API rodando ✅', versao: '1.0.0' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AgroVenda Pro API rodando na porta ${PORT}`));
