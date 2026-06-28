// src/precos.js
// Coleta preços reais de APIs públicas gratuitas
// Fontes: Yahoo Finance (câmbio + commodities), Banco Central do Brasil

const fetch = require('node-fetch');

// Cache em memória para evitar excesso de requisições
let cache = {};
const CACHE_TTL = 15 * 60 * 1000; // 15 minutos

function cacheValido(chave) {
  return cache[chave] && (Date.now() - cache[chave].ts) < CACHE_TTL;
}

// ─── DÓLAR (Banco Central do Brasil) ────────────────────────────────────────
// API oficial do BCB — sem chave necessária
async function buscarDolar() {
  if (cacheValido('dolar')) return cache['dolar'].valor;

  try {
    const hoje = new Date();
    const ontem = new Date(hoje - 86400000);
    const fmt = (d) => `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}-${d.getFullYear()}`;

    const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)?@dataCotacao='${fmt(ontem)}'&$format=json&$select=cotacaoCompra,cotacaoVenda`;

    const res = await fetch(url, { timeout: 8000 });
    const data = await res.json();

    if (data?.value?.length > 0) {
      const cotacao = data.value[data.value.length - 1];
      const valor = ((cotacao.cotacaoCompra + cotacao.cotacaoVenda) / 2).toFixed(4);
      cache['dolar'] = { valor: parseFloat(valor), ts: Date.now() };
      return parseFloat(valor);
    }
  } catch (e) {
    console.warn('BCB indisponível:', e.message);
  }

  // Fallback: tentar Yahoo Finance
  return await buscarDolarYahoo();
}

async function buscarDolarYahoo() {
  try {
    const url = 'https://query1.finance.yahoo.com/v8/finance/chart/BRL=X?interval=1d&range=2d';
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    });
    const data = await res.json();
    const preco = data?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (preco) {
      // BRL=X é USD/BRL invertido no Yahoo — converter
      const dolar = (1 / preco).toFixed(4);
      cache['dolar'] = { valor: parseFloat(dolar), ts: Date.now() };
      return parseFloat(dolar);
    }
  } catch (e) {
    console.warn('Yahoo Finance (dólar) indisponível:', e.message);
  }
  return null;
}

// ─── COMMODITIES via Yahoo Finance ──────────────────────────────────────────
// Tickers: KC=F (café arábica USD/lb), ZS=F (soja USD/bushel),
//          ZC=F (milho USD/bushel), LE=F (boi gordo USD/cwt)
const TICKERS_YAHOO = {
  cafe:    { ticker: 'KC=F', fator_saca: 'cafe' },
  soja:    { ticker: 'ZS=F', fator_saca: 'soja' },
  milho:   { ticker: 'ZC=F', fator_saca: 'milho' },
  boi:     { ticker: 'LE=F', fator_saca: 'boi' },
  algodao: { ticker: 'CT=F', fator_saca: 'algodao' },
  trigo:   { ticker: 'ZW=F', fator_saca: 'trigo' },
  acucar:  { ticker: 'SB=F', fator_saca: 'acucar' }
};

// Conversão: cotação internacional → preço em R$/unidade local
// Café: USD/lb × 132,276 (libras/saca) × câmbio
// Soja: USD/bushel ÷ 100 × 60 (kg/saca) ÷ 27,2155 (kg/bushel) × câmbio
// Milho: mesma lógica da soja
// Boi: USD/cwt × 453,592 ÷ 15 (kg/@) × câmbio ÷ 100
function converterParaReal(cultura, precoUSD, dolar) {
  if (!precoUSD || !dolar) return null;
  switch(cultura) {
    case 'cafe':    return Math.round(precoUSD * 132.276 * dolar / 100); // cents/lb → R$/saca60kg
    case 'soja':    return Math.round(precoUSD * 60 / 27.2155 / 100 * dolar); // cents/bu → R$/saca60kg
    case 'milho':   return Math.round(precoUSD * 60 / 25.4012 / 100 * dolar); // cents/bu → R$/saca60kg
    case 'boi':     return Math.round(precoUSD * 453.592 / 1500 * dolar); // cents/lb → R$/@
    case 'algodao': return Math.round(precoUSD * 60 / 100 * dolar); // cents/lb → R$/arroba aprox
    case 'trigo':   return Math.round(precoUSD * 60 / 27.2155 / 100 * dolar); // cents/bu → R$/saca60kg
    case 'acucar':  return Math.round(precoUSD * 50 / 100 * dolar / 2.2046); // cents/lb → R$/saca50kg
    default:        return Math.round(precoUSD * dolar);
  }
}

async function buscarPrecoYahoo(cultura) {
  const cfg = TICKERS_YAHOO[cultura];
  if (!cfg) return null;
  if (cacheValido(cultura)) return cache[cultura].valor;

  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${cfg.ticker}?interval=1d&range=2d`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    });
    const data = await res.json();
    const preco = data?.chart?.result?.[0]?.meta?.regularMarketPrice;

    if (preco) {
      cache[cultura] = { valor: preco, ts: Date.now() };
      return preco;
    }
  } catch (e) {
    console.warn(`Yahoo Finance (${cultura}) indisponível:`, e.message);
  }
  return null;
}

// ─── FUNÇÃO PRINCIPAL ────────────────────────────────────────────────────────
async function buscarTodosPrecos() {
  console.log('Buscando preços reais...');

  const dolar = await buscarDolar();
  const culturas = ['cafe', 'soja', 'milho', 'boi', 'algodao', 'trigo', 'acucar'];

  const precosUSD = {};
  await Promise.all(culturas.map(async (c) => {
    precosUSD[c] = await buscarPrecoYahoo(c);
  }));

  const resultado = {
    timestamp: new Date().toISOString(),
    fonte: 'Yahoo Finance + Banco Central do Brasil',
    dolar: dolar,
    precos: {}
  };

  culturas.forEach(c => {
    const usd = precosUSD[c];
    const brl = dolar ? converterParaReal(c, usd, dolar) : null;
    resultado.precos[c] = {
      usd: usd ? parseFloat(usd.toFixed(2)) : null,
      brl: brl,
      disponivel: brl !== null
    };
  });

  // Log de status
  const ok = Object.values(resultado.precos).filter(p => p.disponivel).length;
  console.log(`Preços obtidos: ${ok}/${culturas.length} culturas | Dólar: R$ ${dolar || 'indisponível'}`);

  return resultado;
}

module.exports = { buscarTodosPrecos, buscarDolar };
