// HTTP front for the approval gate. Local demo service, bound to 127.0.0.1 only.
// Run:  node server/gate-server.mjs
// Wallets: set HOT_WALLET_SEED and MERCHANT_WALLET_SEED to pre-funded testnet accounts.
// The gate then makes no faucet call. Leave a seed empty and it asks the faucet for that wallet.
//
// What guards the HTTP surface (all in server/guard.mjs; see README.md, "Network guard"):
//   - Host must be 127.0.0.1, localhost or [::1] on the gate's own port (DNS rebinding guard): 421 otherwise.
//   - The request target must be a path: an absolute URL is 421, "//x/...", a backslash are 400.
//   - A request with an Origin header must have an allowed one (default: the approver app on port 5173; replace the
//     list with GATE_ALLOWED_ORIGINS, a comma list of exact origins): 403 otherwise. No Origin (curl, the agent) passes.
//   - Every request except GET and HEAD must be Content-Type: application/json: 415 otherwise.
//   - OPTIONS answers only for an allowed origin and only for GET and POST with Content-Type and Authorization.
//   - Optional bearer tokens, read from the environment at start and never over HTTP:
//       GATE_AGENT_TOKEN     guards POST /intents
//       GATE_APPROVER_TOKEN  guards the list of intents, approve, signature and reject
//     Unset means that route group is open. /health says which are on (booleans), never the value.
// It is NOT a login. With no token set, any local process that sends no Origin can still call the gate.
import http from 'node:http';
import { Wallet, dropsToXrp } from 'xrpl';
import { Gate, GateError, XrplLedger } from './gate.mjs';
import { DEFAULT_POLICY } from './policy.mjs';
import { GuardError, createGuard, parseOrigins, takeTokens } from './guard.mjs';

const PORT = Number(process.env.PORT ?? 8787);

// Read once at startup. None of these can be changed over HTTP.
let guard;
try {
  // takeTokens also removes both variables from process.env: the tokens live only inside the guard (as hashes) from here on.
  const { agentToken, approverToken } = takeTokens(process.env);
  guard = createGuard({ origins: parseOrigins(process.env.GATE_ALLOWED_ORIGINS), agentToken, approverToken });
} catch (e) {
  console.error(e.message);
  process.exit(1);
}
// Which routes each token unlocks. A route is open when none of its roles has a token set.
const AGENT = ['agent'];
const APPROVER = ['approver'];
const EITHER = ['agent', 'approver']; // reading one intent by id, and the demo helper the app's button calls

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

// Vary: Origin on every answer that can depend on the Origin; Access-Control-Allow-Origin only for an allowed origin
// (guard.cors), never "*". `noCors` (Host and target refusals, which do not depend on Origin) sends neither.
const send = (res, status, body, origin, extra = {}, noCors = false) => {
  res.writeHead(status, { 'content-type': 'application/json', ...extra, ...(noCors ? {} : guard.cors(origin)) });
  res.end(JSON.stringify(body));
};
const readJson = (req) => new Promise((resolve, reject) => {
  let s = '';
  req.on('data', (c) => { s += c; if (s.length > 100_000) reject(new GateError('BAD_INPUT', 'Body too large.', 413)); });
  req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch { reject(new GateError('BAD_INPUT', 'Invalid JSON.')); } });
});

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  try {
    // The guard runs before any routing or body reading. A refusal throws, so it can change nothing.
    guard.checkHost(req);
    guard.checkTarget(req);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, guard.preflight(req));
      return res.end();
    }
    guard.checkOrigin(req);
    guard.checkContentType(req);
    const url = new URL(req.url, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    // The intent id is decoded only AFTER the route's token check, and a bad escape is the caller's 400, not a 500.
    const idOf = () => { try { return decodeURIComponent(parts[1]); } catch { throw new GateError('BAD_PATH', 'The intent id in the path is not valid.', 400); } };

    // /health and /policy stay open (the app reads /health to learn whether to ask for a token). Each other route
    // calls guard.authorize with the roles that may use it, before it reads the body or touches the gate.
    if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true, demo, approver: gate.approverAddress, ...guard.status }, origin);
    if (req.method === 'GET' && url.pathname === '/policy') return send(res, 200, DEFAULT_POLICY, origin);
    if (req.method === 'GET' && url.pathname === '/intents') { guard.authorize(req, APPROVER); return send(res, 200, gate.list(), origin); }
    if (req.method === 'POST' && url.pathname === '/intents') { guard.authorize(req, AGENT); return send(res, 201, await gate.submitIntent(await readJson(req)), origin); }
    if (parts[0] === 'intents' && parts[1]) {
      if (req.method === 'GET' && !parts[2]) { guard.authorize(req, EITHER); return send(res, 200, gate.get(idOf()), origin); }
      if (req.method === 'POST' && parts[2] === 'approve') { guard.authorize(req, APPROVER); return send(res, 200, await gate.approve(idOf(), await readJson(req)), origin); }
      if (req.method === 'POST' && parts[2] === 'signature') { guard.authorize(req, APPROVER); return send(res, 200, await gate.submitSignature(idOf(), (await readJson(req)).signature), origin); }
      if (req.method === 'POST' && parts[2] === 'reject') { guard.authorize(req, APPROVER); return send(res, 200, gate.reject(idOf(), (await readJson(req)).reason), origin); }
    }
    // Demo helper: four payments an agent might try (small, over cap, high risk, sanctioned).
    if (req.method === 'POST' && url.pathname === '/demo/seed') {
      guard.authorize(req, EITHER);
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
    // A guard refusal never echoes the request: its message is fixed text. A Host or target refusal carries no CORS
    // headers at all. A refused preflight carries Vary: Origin but no Access-Control-Allow-* header.
    if (e instanceof GuardError) return send(res, e.status, { error: e.code, message: e.message }, e.bare || e.noGrant ? undefined : origin, e.headers, e.bare);
    if (e instanceof GateError) return send(res, e.status, { error: e.code, message: e.message }, origin);
    // One short line, never a stack trace: what went wrong may have been caused by what a client sent.
    console.error('internal error:', `${e?.name}: ${String(e?.message).slice(0, 200)}`);
    send(res, 500, { error: 'INTERNAL', message: 'Internal error.' }, origin);
  }
});

server.listen(PORT, '127.0.0.1', () => { console.log(`gate listening on http://127.0.0.1:${PORT}`); bootstrap(); });
