// Refusal paths of the merchant over real HTTP. No network: each case is refused
// before the merchant opens an XRPL connection. The accept path and the replay
// guard need the ledger, and the four-beat demo covers them.
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');

const PORT = 4590 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}/resource`;
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const PAY_TO = 'rPT1Sjq2YGrBMTttX4GZHjKu9dyfzbpAYe';

let child;
test.before(async () => {
  child = spawn(process.execPath, [path.join(__dirname, 'xrpl-merchant.cjs')], {
    env: { ...process.env, PORT: String(PORT), XRPL_PAY_TO: PAY_TO },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(BASE); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('merchant did not start');
});
test.after(() => child.kill());

async function challenge(xrp = 5) {
  const res = await fetch(`${BASE}?xrp=${xrp}`);
  assert.equal(res.status, 402);
  return res.json();
}
async function present(payload) {
  const res = await fetch(BASE, { headers: { 'PAYMENT-SIGNATURE': b64(payload) } });
  return { status: res.status, body: await res.json() };
}

test('an unpaid request gets a 402 with one exact/xrpl-testnet entry priced in drops', async () => {
  const c = await challenge(5);
  assert.equal(c.accepts.length, 1);
  const [a] = c.accepts;
  assert.deepEqual([a.scheme, a.network, a.asset, a.amount, a.payTo], ['exact', 'xrpl-testnet', 'XRP', '5000000', PAY_TO]);
  assert.match(a.extra.invoiceId, /^INV-[0-9a-f]{24}$/);
});

test('a bad price is refused with 400', async () => {
  for (const xrp of ['0', '-1', 'abc', '100001']) {
    const res = await fetch(`${BASE}?xrp=${xrp}`);
    assert.equal(res.status, 400, `xrp=${xrp}`);
  }
});

test('a payment header that is not base64 JSON is refused with 400', async () => {
  const res = await fetch(BASE, { headers: { 'PAYMENT-SIGNATURE': '%%%not-base64-json' } });
  assert.equal(res.status, 400);
});

test('refusals: wrong envelope, scheme, network, unknown invoice, malformed hash', async () => {
  const c = await challenge();
  const entry = c.accepts[0];
  const good = { x402Version: 2, accepted: entry, payload: { txHash: 'A'.repeat(64) } };
  const cases = [
    ['invalid_envelope', { ...good, x402Version: 1 }],
    ['unsupported_scheme', { ...good, accepted: { ...entry, scheme: 'other' } }],
    ['invalid_network', { ...good, accepted: { ...entry, network: 'xrpl-mainnet' } }],
    ['unknown_invoice', { ...good, accepted: { ...entry, extra: { invoiceId: 'INV-nope' } } }],
    ['malformed_payment', { ...good, payload: { txHash: 'not-a-hash' } }],
  ];
  for (const [reason, payload] of cases) {
    const r = await present(payload);
    assert.equal(r.status, 402, reason);
    assert.equal(r.body.error, reason);
    assert.equal(r.body.accepts.length, 1, 'a refusal carries a fresh challenge');
  }
});
