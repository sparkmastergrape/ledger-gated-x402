/**
 * The four-beat demo: an x402 agent payment gated by a Ledger approval.
 *
 *   node x402-ledger-demo.mjs                       a person approves in the approver app
 *   node x402-ledger-demo.mjs --approver=software   unattended; a SOFTWARE key plays the approver
 *
 * Beats: 1 small payment auto-releases · 2 over-cap payment, human declines ·
 * 3 same payment, human approves · 4 sanctions hit, nothing can release it.
 *
 * Testnet only. In --approver=software mode no Ledger device (physical or
 * emulated) is involved, and the output says so. Starts the gate and the
 * merchant itself if they are not already running.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { Client, Wallet, decode, dropsToXrp } from 'xrpl';

const require = createRequire(import.meta.url);
const { payViaGate } = require('./x402-xrpl-agent.cjs');
const { toHex } = require('./xrpl-payment-verify.cjs');

const SOFTWARE = process.argv.includes('--approver=software');
const GATE = process.env.GATE_URL || 'http://127.0.0.1:8787';
const MERCHANT_PORT = Number(process.env.DEMO_MERCHANT_PORT || 4031);
const XRPL_WS = process.env.XRPL_WS || 'wss://s.altnet.rippletest.net:51233';
const SMALL_XRP = 5;
const LARGE_XRP = 75;

const tty = process.stdout.isTTY;
const c = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s) => c('1', s), dim = (s) => c('2', s), green = (s) => c('32', s), red = (s) => c('31', s), yellow = (s) => c('33', s), cyan = (s) => c('36', s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rule = (s = '') => console.log(`\n${bold(cyan('═'.repeat(72)))}\n${bold(s)}`);
const line = (k, v) => console.log(`  ${k.padEnd(16)}${v}`);

const children = [];
function start(name, cmd, args, opts) {
  const p = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  const echo = (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(dim(`  [${name}] ${l}`)));
  p.stdout.on('data', echo); p.stderr.on('data', echo);
  children.push(p);
  return p;
}
const stopAll = () => children.forEach((p) => p.kill());
process.on('exit', stopAll);
process.on('SIGINT', () => { stopAll(); process.exit(130); });

async function until(what, fn, ms = 120_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* not up yet */ } await sleep(1000); }
  throw new Error(`timed out waiting for ${what}`);
}
const gateGet = async (path) => (await fetch(GATE + path)).json();
const gatePost = async (path, body = {}) => {
  const r = await fetch(GATE + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};

// ── Setup ───────────────────────────────────────────────────────────────────
async function setup() {
  rule('SETUP');
  let health = await gateGet('/health').catch(() => null);
  if (!health) {
    console.log('  starting the approval gate (funds demo wallets from the testnet faucet)…');
    start('gate', process.execPath, ['server/gate-server.mjs'], { cwd: new URL('./ledger-approver/', import.meta.url) });
    health = await until('gate demo wallets', async () => { const h = await gateGet('/health'); return h.demo?.ready ? h : null; });
  }
  if (!health.demo?.ready) throw new Error(`gate is up but demo wallets are not ready: ${health.demo?.error ?? 'still starting'}`);

  const merchantAddress = health.demo.merchant;
  const url = `http://localhost:${MERCHANT_PORT}/resource`;
  const offered = await fetch(url).then((r) => r.json()).catch(() => null);
  if (!offered?.accepts?.some((a) => a.scheme === 'exact' && a.payTo === merchantAddress)) {
    if (offered) throw new Error(`something on port ${MERCHANT_PORT} does not pay to ${merchantAddress}; stop it or set DEMO_MERCHANT_PORT`);
    console.log('  starting the x402 merchant…');
    start('merchant', process.execPath, ['xrpl-merchant.cjs'], {
      env: { ...process.env, PORT: String(MERCHANT_PORT), XRPL_PAY_TO: merchantAddress, X402_QUOTE_TTL: '900' },
    });
    await until('merchant', () => fetch(url).then((r) => r.status === 402));
  }
  process.env.X402_MERCHANT_URL = url;

  const policy = await gateGet('/policy');
  line('gate', GATE);
  line('merchant', `${url}  pays to ${merchantAddress}`);
  line('hot wallet', health.demo.hot);
  line('policy', `auto-release up to ${policy.perTxCapXrp} XRP per payment; anything above waits for a signature`);
  return { health, merchantAddress, policy };
}

// ── Approver ────────────────────────────────────────────────────────────────
let soft = null; // { wallet, client }
async function setupSoftwareApprover() {
  const client = new Client(XRPL_WS);
  await client.connect();
  const label = yellow('SOFTWARE KEY — no Ledger device of any kind is involved');
  const seed = process.env.DEMO_APPROVER_SEED;
  // With a seed the demo makes no faucet call. Beat 3 sends LARGE_XRP, so leave headroom for fees.
  const need = LARGE_XRP + 10;
  if (!seed) {
    const funded = await client.fundWallet(Wallet.generate('ecdsa-secp256k1'));
    soft = { wallet: funded.wallet, client };
    line('approver', `${funded.wallet.address}  ${label}  (testnet faucet)`);
    return;
  }
  let wallet;
  try { wallet = Wallet.fromSeed(seed); }
  catch (e) { throw new Error(`DEMO_APPROVER_SEED is not a valid XRPL seed (${e.message}).`); }
  let balance;
  try {
    const info = await client.request({ command: 'account_info', account: wallet.classicAddress, ledger_index: 'validated' });
    balance = Number(dropsToXrp(info.result.account_data.Balance));
  } catch (e) {
    const why = e?.data?.error === 'actNotFound' ? 'does not exist on testnet' : `could not be read (${e?.data?.error ?? e.message})`;
    throw new Error(`DEMO_APPROVER_SEED gives ${wallet.classicAddress}, which ${why}. Fund it, or clear the seed to use the faucet.`);
  }
  if (balance < need) throw new Error(`approver ${wallet.classicAddress} holds ${balance} XRP, under the ${need} XRP beat 3 needs. Top it up, or clear DEMO_APPROVER_SEED.`);
  soft = { wallet, client };
  line('approver', `${wallet.address}  ${label}  (pre-funded seed, ${balance} XRP)`);
}

/** Software stand-in for the human: acts once the intent is waiting. */
async function softwareDecide(invoiceId, action) {
  await until('intent to wait for approval', async () => (await gateGet(`/intents/${invoiceId}`)).state === 'PENDING_APPROVAL');
  if (action === 'reject') {
    await gatePost(`/intents/${invoiceId}/reject`, { reason: 'rejected by SOFTWARE approver (simulated veto, no device)' });
    return;
  }
  const { wallet } = soft;
  const a = (await gatePost(`/intents/${invoiceId}/approve`, { address: wallet.address, publicKey: wallet.publicKey })).body;
  const sig = decode(wallet.sign({ ...a.tx, SigningPubKey: wallet.publicKey }).tx_blob).TxnSignature;
  await gatePost(`/intents/${invoiceId}/signature`, { signature: sig });
}

// ── One purchase, with progress ─────────────────────────────────────────────
async function purchase({ xrp, risk = 'low', health = 'healthy', note, human }) {
  let deciding = null;
  const result = await payViaGate({
    xrp, risk, health, note,
    onEvent: (kind, d) => {
      if (kind === 'challenge') line('merchant', `402 Payment Required; offers ${d.accepts.map((a) => `${a.scheme} (${a.network})`).join(' and ')}`);
      if (kind === 'picked') line('agent', `picks exact/xrpl-testnet: ${d.xrp} XRP to ${d.entry.payTo.slice(0, 10)}…  invoice ${d.entry.extra.invoiceId}`);
      if (kind === 'intent') {
        line('gate', `${d.state}${d.decision.reasons.length ? '  ' + d.decision.reasons.map((r) => r.code).join(', ') : ''}`);
        if (d.state === 'PENDING_APPROVAL') {
          line('', yellow('payment is waiting; the agent holds no key and cannot continue'));
          if (SOFTWARE) deciding = softwareDecide(d.id, human);
          else console.log(yellow(`\n  >>> ${human === 'reject' ? 'DECLINE' : 'APPROVE'} it now: approver app (http://localhost:5173) → select the ${xrp} XRP payment → Approve and sign on device${human === 'reject' ? ', then REJECT on the device (or press Reject)' : ''}\n`));
        }
      }
      if (kind === 'state') line('gate', `${d.state}${d.txHash ? '  ' + d.txHash : ''}`);
    },
  });
  if (deciding) await deciding;
  return result;
}

// ── The proof for beat 2 ────────────────────────────────────────────────────
async function proveAbsence(invoiceId, accounts) {
  const client = new Client(XRPL_WS);
  await client.connect();
  const want = toHex(invoiceId);
  let scanned = 0, found = 0;
  const per = [];
  try {
    for (const [label, address] of accounts) {
      const r = await client.request({ command: 'account_tx', account: address, ledger_index_min: -1, ledger_index_max: -1, limit: 400 });
      const txs = r.result.transactions ?? [];
      const hits = txs.filter((t) => (t.tx_json?.Memos ?? t.tx?.Memos ?? []).some((m) => (m.Memo?.MemoData ?? '').toUpperCase() === want));
      scanned += txs.length; found += hits.length;
      per.push(`${label} ${address.slice(0, 8)}…: ${txs.length} txs, ${hits.length} carrying the invoice`);
    }
  } finally { await client.disconnect(); }
  return { scanned, found, per };
}

// ── Beats ───────────────────────────────────────────────────────────────────
const outcomes = [];
const record = (beat, expected, got) => outcomes.push({ beat, expected, got, ok: expected === got });

async function beat1(ctx) {
  rule('BEAT 1 · small payment, under the cap — should look boring');
  const r = await purchase({ xrp: SMALL_XRP, note: 'beat 1: small' });
  line('outcome', r.outcome === 'paid' ? green('PAID') : red(r.outcome.toUpperCase()));
  if (r.intent.txHash) line('ledger', `${r.intent.engineResult}  ${r.intent.txHash}`);
  if (r.resource) line('merchant', `200, released: "${r.resource.body.slice(0, 40)}…"`);
  if (r.outcome !== 'paid') line('why not', JSON.stringify({ state: r.intent.state, error: r.intent.error, merchant: r.merchantError, detail: r.merchantDetail }));
  record(1, 'paid', r.outcome);
}

async function beat2(ctx) {
  rule(`BEAT 2 · ${LARGE_XRP} XRP, over the cap — the human says NO`);
  const r = await purchase({ xrp: LARGE_XRP, note: 'beat 2: over cap, to be declined', human: 'reject' });
  const sawSubmitted = r.intent.history.some((h) => ['SUBMITTED', 'CONFIRMED'].includes(h.state));
  const health = await gateGet('/health');
  const accounts = [['merchant', ctx.merchantAddress], ['hot wallet', health.demo.hot]];
  const approver = soft?.wallet.address ?? health.approver;
  if (approver) accounts.push(['approver', approver]);
  console.log(dim('\n  asking the ledger (account_tx) whether anything carrying this invoice exists…'));
  const proof = await proveAbsence(r.invoiceId, accounts);
  const reason = r.intent.history.filter((h) => h.state === 'REJECTED').map((h) => h.note).pop() ?? '';

  console.log(`\n  ${bold('┌' + '─'.repeat(66) + '┐')}`);
  console.log(`  ${bold('│ RESULT OF BEAT 2' + ' '.repeat(49) + '│')}`);
  console.log(`  ${bold('└' + '─'.repeat(66) + '┘')}`);
  line('outcome', r.outcome === 'declined' ? yellow(bold('DECLINED')) + dim('  — a human veto, not an error') : red(bold(r.outcome.toUpperCase())));
  line('decision', reason || '(none)');
  line('signed?', r.intent.txHash === null && !sawSubmitted ? green(bold('NO')) + dim('  intent has no tx hash; history never reached SUBMITTED') : red(bold('YES — unexpected')));
  line('on the ledger?', proof.found === 0 ? green(bold('NO')) + dim(`  ${proof.scanned} transactions scanned, 0 carry ${r.invoiceId}`) : red(bold(`YES — ${proof.found} found`)));
  proof.per.forEach((p) => line('', dim(p)));
  line('merchant', 'never shown a payment, so the resource stays locked');
  record(2, 'declined', r.outcome === 'declined' && r.intent.txHash === null && !sawSubmitted && proof.found === 0 ? 'declined' : `${r.outcome} (proof failed)`);
}

async function beat3(ctx) {
  rule(`BEAT 3 · the same ${LARGE_XRP} XRP payment again — this time the human approves`);
  const r = await purchase({ xrp: LARGE_XRP, note: 'beat 3: over cap, to be approved', human: 'approve' });
  line('outcome', r.outcome === 'paid' ? green(bold('PAID')) : red(bold(r.outcome.toUpperCase())));
  if (r.intent.txHash) line('ledger', `${r.intent.engineResult}  ${r.intent.txHash}`);
  if (r.intent.approver) line('signed by', `${r.intent.approver}${SOFTWARE ? yellow('  (software key)') : ''}`);
  if (r.resource) line('merchant', `200, verified the transaction on the ledger and released the resource`);
  if (r.outcome !== 'paid') line('why not', JSON.stringify({ state: r.intent.state, error: r.intent.error, merchant: r.merchantError, detail: r.merchantDetail }));
  // Replay: show the merchant the same transaction again for the same invoice. It must refuse.
  let replayOk = true;
  if (r.outcome === 'paid') {
    const entry = r.challenge.accepts.find((a) => a.scheme === 'exact');
    const header = Buffer.from(JSON.stringify({ x402Version: 2, accepted: entry, payload: { txHash: r.intent.txHash } })).toString('base64');
    const again = await fetch(`${process.env.X402_MERCHANT_URL}?xrp=${LARGE_XRP}`, { headers: { 'PAYMENT-SIGNATURE': header } });
    const body = await again.json().catch(() => ({}));
    replayOk = again.status === 402 && body.error === 'invoice_already_used';
    line('replay', `same payment shown again: HTTP ${again.status} ${body.error ?? ''}  ${replayOk ? green('refused') : red('NOT REFUSED')}`);
  }
  record(3, 'paid', r.outcome === 'paid' && !replayOk ? 'paid / replay accepted' : r.outcome);
}

async function beat4(ctx) {
  rule('BEAT 4 · sanctions hit — no signature can release this');
  const r = await purchase({ xrp: SMALL_XRP, risk: 'blocked', note: 'beat 4: sanctions match' });
  line('outcome', r.outcome === 'blocked' ? red(bold('BLOCKED')) : red(`UNEXPECTED ${r.outcome}`));
  line('reason', r.intent.decision.reasons.map((x) => `${x.code}: ${x.text}`).join('; '));
  const tryApprove = await gatePost(`/intents/${r.invoiceId}/approve`, {});
  line('try to approve', `HTTP ${tryApprove.status} ${tryApprove.body.error ?? ''} — ${tryApprove.body.message ?? ''}`);
  record(4, 'blocked', r.outcome === 'blocked' && tryApprove.status === 409 ? 'blocked' : `${r.outcome} / approve ${tryApprove.status}`);
}

// ── Main ────────────────────────────────────────────────────────────────────
try {
  console.log(bold('x402 payment gated by a Ledger approval — XRPL testnet'));
  const ctx = await setup();
  if (SOFTWARE) await setupSoftwareApprover();
  else {
    line('approver', 'a person, in the approver app (npm run dev in ledger-approver/), with the Speculos emulator or a USB device');
    console.log(yellow('  Before beat 3: connect the device in the app and press Fund so the approving account has XRP.'));
  }
  await beat1(ctx);
  await beat2(ctx);
  await beat3(ctx);
  await beat4(ctx);
} catch (e) {
  console.error(red(`\nDemo stopped: ${e.message}`));
  process.exitCode = 1;
}

rule('SUMMARY');
outcomes.forEach((o) => console.log(`  beat ${o.beat}  expected ${o.expected.padEnd(9)} got ${o.got.padEnd(9)} ${o.ok ? green('ok') : red('MISMATCH')}`));
if (outcomes.length < 4 || outcomes.some((o) => !o.ok)) process.exitCode = 1;
if (soft) await soft.client.disconnect().catch(() => {});
process.exit(process.exitCode ?? 0);
