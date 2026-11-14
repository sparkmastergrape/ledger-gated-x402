/**
 * x402 agent that pays through the Ledger approval gate.
 *
 * It never holds a key for this payment. It reads the merchant's 402, picks the
 * classic-XRPL `exact` entry, and hands the payment intent to the gate
 * (ledger-approver/server/gate-server.mjs). The gate decides: pay from its hot
 * wallet, wait for a human to sign on a Ledger, or refuse. On release the agent
 * shows the merchant the transaction hash and gets the resource.
 *
 * Usage (merchant and gate already running):
 *   node x402-xrpl-agent.cjs                 # 5 XRP, expected to auto-release
 *   XRP=75 node x402-xrpl-agent.cjs          # over the cap: waits for the device
 *   RISK=blocked node x402-xrpl-agent.cjs    # sanctions hit: refused outright
 *
 * RISK and HEALTH stand in for a screening service and a ledger-health oracle.
 * Here the caller states them; nothing in this repo computes them.
 */

'use strict';

const merchantUrl = () => process.env.X402_MERCHANT_URL || 'http://localhost:4021/resource';
const GATE_URL = process.env.GATE_URL || 'http://127.0.0.1:8787';
const XRPL_SCHEME = 'exact';
const XRPL_NETWORK = 'xrpl-testnet';
const TERMINAL = new Set(['CONFIRMED', 'FAILED', 'REJECTED', 'EXPIRED', 'BLOCKED']);

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const unb64 = (text) => JSON.parse(Buffer.from(text, 'base64').toString('utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gate(path, init) {
  const headers = { 'content-type': 'application/json' };
  if (process.env.GATE_AGENT_TOKEN) headers.authorization = `Bearer ${process.env.GATE_AGENT_TOKEN}`; // only when the gate asks for one
  const res = await fetch(GATE_URL + path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`gate ${path}: ${body.message ?? res.status}`);
  return body;
}

/**
 * One purchase. Resolves to { outcome, intent, challenge, resource } where
 * outcome is one of paid | declined | blocked | failed | expired. A refusal is
 * an outcome, not an exception: a human veto must not look like a crash.
 *
 * @param opts.xrp       price asked of the merchant, in XRP
 * @param opts.risk      screening result passed to the gate (low|medium|high|blocked)
 * @param opts.health    ledger health passed to the gate (healthy|degraded|critical)
 * @param opts.onEvent   (kind, data) progress callback
 */
async function payViaGate({ xrp = 5, risk = 'low', health = 'healthy', note, timeoutMs = 10 * 60 * 1000, onEvent = () => {} } = {}) {
  // 1. Ask for the resource unpaid.
  const first = await fetch(`${merchantUrl()}?xrp=${encodeURIComponent(xrp)}`);
  if (first.status !== 402) throw new Error(`expected 402 from the merchant, got ${first.status}`);
  const challenge = unb64(first.headers.get('payment-required'));
  onEvent('challenge', challenge);

  // 2. Pick the XRPL entry.
  const entry = challenge.accepts.find((a) => a.scheme === XRPL_SCHEME && a.network === XRPL_NETWORK);
  if (!entry) throw new Error('merchant offers no exact/xrpl-testnet entry');
  const drops = BigInt(entry.amount);
  if (drops <= 0n) throw new Error(`refusing amount ${entry.amount}`);
  const invoiceId = entry.extra?.invoiceId;
  if (!invoiceId) throw new Error('requirement carries no invoiceId');
  onEvent('picked', { entry, xrp: Number(drops) / 1e6 });

  // 3. Do not sign. Give the gate the intent; the invoice id is the end_to_end_id,
  // so it lands in the transaction memo and binds payment to purchase.
  const intent = await gate('/intents', {
    method: 'POST',
    body: JSON.stringify({
      end_to_end_id: invoiceId,
      destination: entry.payTo,
      amountXrp: Number(drops) / 1e6,
      risk,
      health,
      note: note ?? `x402 ${challenge.resource}`,
    }),
  });
  onEvent('intent', intent);

  // 4. Wait for a terminal state.
  let current = intent;
  let last = current.state;
  const deadline = Date.now() + timeoutMs;
  while (!TERMINAL.has(current.state)) {
    if (Date.now() > deadline) throw new Error(`gave up waiting for ${invoiceId} after ${timeoutMs / 1000}s (still ${current.state})`);
    await sleep(1500);
    current = await gate(`/intents/${encodeURIComponent(invoiceId)}`);
    if (current.state !== last) { onEvent('state', current); last = current.state; }
  }

  const base = { intent: current, challenge, invoiceId };
  if (current.state === 'REJECTED') return { ...base, outcome: 'declined' };
  if (current.state === 'BLOCKED') return { ...base, outcome: 'blocked' };
  if (current.state === 'EXPIRED') return { ...base, outcome: 'expired' };
  if (current.state === 'FAILED') return { ...base, outcome: 'failed' };

  // 5. Released and validated: show the merchant the transaction.
  const retry = await fetch(`${merchantUrl()}?xrp=${encodeURIComponent(xrp)}`, {
    headers: { 'PAYMENT-SIGNATURE': b64({ x402Version: 2, accepted: entry, payload: { txHash: current.txHash } }) },
  });
  const body = await retry.json().catch(() => ({}));
  if (retry.status !== 200) return { ...base, outcome: 'failed', merchantStatus: retry.status, merchantError: body.error, merchantDetail: body.detail };
  const receipt = retry.headers.get('payment-response') ? unb64(retry.headers.get('payment-response')) : null;
  return { ...base, outcome: 'paid', resource: body, receipt };
}

module.exports = { payViaGate };

if (require.main === module) {
  const show = (kind, d) => {
    if (kind === 'challenge') console.log(`402 from merchant; offers: ${d.accepts.map((a) => `${a.scheme}@${a.network}`).join(', ')}`);
    if (kind === 'picked') console.log(`picked exact/xrpl-testnet: ${d.xrp} XRP to ${d.entry.payTo}`);
    if (kind === 'intent' || kind === 'state') console.log(`gate: ${d.state}${d.decision?.reasons?.length ? '  [' + d.decision.reasons.map((r) => r.code).join(', ') + ']' : ''}`);
  };
  payViaGate({ xrp: Number(process.env.XRP || 5), risk: process.env.RISK || 'low', health: process.env.HEALTH || 'healthy', onEvent: show })
    .then((r) => {
      console.log(`outcome: ${r.outcome}${r.intent.txHash ? '  tx ' + r.intent.txHash : ''}`);
      if (r.resource) console.log(r.resource.body);
      process.exit(r.outcome === 'paid' ? 0 : 2);
    })
    .catch((e) => { console.error('error:', e.message); process.exit(1); });
}
