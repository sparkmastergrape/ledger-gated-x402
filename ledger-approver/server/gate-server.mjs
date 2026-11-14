// HTTP front for the approval gate. Local demo service: no authentication yet.
// Run:  node server/gate-server.mjs
// Wallets: set HOT_WALLET_SEED and MERCHANT_WALLET_SEED to pre-funded testnet accounts.
// The gate then makes no faucet call. Leave a seed empty and it asks the faucet for that wallet.
import http from 'node:http';
import { Wallet, dropsToXrp } from 'xrpl';
import { Gate, GateError, XrplLedger } from './gate.mjs';
import { DEFAULT_POLICY } from './policy.mjs';

const PORT = Number(process.env.PORT ?? 8787);
const ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);

const ledger = new XrplLedger(process.env.XRPL_WS);
const gate = new Gate({ ledger, policy: DEFAULT_POLICY });
let demo = { hot: null, merchant: null, ready: false, error: null };
let faucetCalls = 0;

// A pre-funded wallet must hold this much XRP, so the demo does not stop part way through.
const MIN_XRP = { 'hot wallet': 20, merchant: 10 };

// Returns the wallet for a seed, or a new faucet wallet when the seed is empty.
// A seeded wallet is never topped up, so a fully seeded run calls the faucet zero times.
async function loadWallet(label, seed, minXrp) {
  if (!seed) {
    faucetCalls += 1;
    const r = await ledger.fund(null);
    return { wallet: r.wallet, source: 'funded from the testnet faucet' };
  }
  let wallet;
  try { wallet = Wallet.fromSeed(seed); }
  catch (e) { throw new Error(`${label}: the seed in the environment is not a valid XRPL seed (${e.message}).`); }
  let balance;
  try {
    const info = await ledger.client.request({ command: 'account_info', account: wallet.classicAddress, ledger_index: 'validated' });
    balance = Number(dropsToXrp(info.result.account_data.Balance));
  } catch (e) {
    const why = e?.data?.error === 'actNotFound' ? 'does not exist on testnet' : `could not be read (${e?.data?.error ?? e.message})`;
    throw new Error(`${label}: the seed gives ${wallet.classicAddress}, which ${why}. Fund it, or clear the seed to use the faucet.`);
  }
  if (balance < minXrp) throw new Error(`${label}: ${wallet.classicAddress} holds ${balance} XRP, under the ${minXrp} XRP the demo needs. Top it up, or clear the seed to use the faucet.`);
  return { wallet, source: `pre-funded seed, ${balance} XRP` };
}

async function bootstrap() {
  try {
    await ledger.connect();
    // Testnet only. A service-controlled hot wallet pays the auto-released, below-cap payments.
    const hot = await loadWallet('hot wallet', process.env.HOT_WALLET_SEED, MIN_XRP['hot wallet']);
    const merchant = await loadWallet('merchant', process.env.MERCHANT_WALLET_SEED, MIN_XRP.merchant);
    gate.hotWallet = hot.wallet;
    gate.known.add(merchant.wallet.address); // a destination we have paid before, so a small payment can auto-release
    demo = { hot: hot.wallet.address, merchant: merchant.wallet.address, ready: true, error: null };
    console.log('hot wallet :', demo.hot, `(${hot.source})`);
    console.log('merchant   :', demo.merchant, `(${merchant.source})`);
    console.log('faucet     :', faucetCalls === 0 ? 'not called - both wallets came from a seed' : `called ${faucetCalls} time(s)`);
  } catch (e) {
    demo.error = e.message;
    console.error('bootstrap failed:', e.message);
  }
}

const send = (res, status, body, origin) => {
  const h = { 'content-type': 'application/json' };
  if (ORIGINS.has(origin)) { h['access-control-allow-origin'] = origin; h['vary'] = 'Origin'; }
  res.writeHead(status, h);
  res.end(JSON.stringify(body));
};
const readJson = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 100_000) reject(new GateError('BAD_INPUT', 'Body too large.', 413)); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new GateError('BAD_INPUT', 'Invalid JSON.')); } });
});

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': ORIGINS.has(origin) ? origin : '', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }
  const url = new URL(req.url, 'http://x');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, demo, approver: gate.approverAddress }, origin);
    if (req.method === 'GET' && url.pathname === '/policy') return send(res, 200, DEFAULT_POLICY, origin);
    if (req.method === 'GET' && url.pathname === '/intents') return send(res, 200, gate.list(), origin);
    if (req.method === 'POST' && url.pathname === '/intents') return send(res, 201, await gate.submitIntent(await readJson(req)), origin);
    if (parts[0] === 'intents' && parts[1]) {
      const id = decodeURIComponent(parts[1]);
      if (req.method === 'GET' && !parts[2]) return send(res, 200, gate.get(id), origin);
      if (req.method === 'POST' && parts[2] === 'approve') return send(res, 200, await gate.approve(id, await readJson(req)), origin);
      if (req.method === 'POST' && parts[2] === 'signature') return send(res, 200, await gate.submitSignature(id, (await readJson(req)).signature), origin);
      if (req.method === 'POST' && parts[2] === 'reject') return send(res, 200, gate.reject(id, (await readJson(req)).reason), origin);
    }
    // Demo helper: four payments an agent might try (small, over cap, high risk, sanctioned).
    if (req.method === 'POST' && url.pathname === '/demo/seed') {
      if (!demo.ready) throw new GateError('NOT_READY', `Demo wallets are not ready: ${demo.error ?? 'still starting'}`, 503);
      const n = Date.now().toString(36);
      const dest = demo.merchant;
      const base = { destination: dest, health: 'healthy' };
      const out = [];
      out.push(await gate.submitIntent({ ...base, end_to_end_id: `small-${n}`, amountXrp: 5, risk: 'low', note: 'Small payment to a known merchant' }));
      out.push(await gate.submitIntent({ ...base, end_to_end_id: `large-${n}`, amountXrp: 75, risk: 'low', note: 'Large payment, above the per-transaction cap' }));
      out.push(await gate.submitIntent({ ...base, end_to_end_id: `flagged-${n}`, amountXrp: 6, risk: 'high', note: 'Screening returned high risk' }));
      out.push(await gate.submitIntent({ ...base, end_to_end_id: `sanctioned-${n}`, amountXrp: 6, risk: 'blocked', note: 'Sanctions match' }));
      return send(res, 201, out, origin);
    }
    send(res, 404, { error: 'NOT_FOUND', message: 'No such route.' }, origin);
  } catch (e) {
    if (e instanceof GateError) return send(res, e.status, { error: e.code, message: e.message }, origin);
    console.error(e);
    send(res, 500, { error: 'INTERNAL', message: 'Internal error.' }, origin);
  }
});

server.listen(PORT, '127.0.0.1', () => { console.log(`gate listening on http://127.0.0.1:${PORT}`); bootstrap(); });
