/**
 * Demo x402 merchant for a classic XRPL payment (testnet only).
 *
 * Ask for /resource with no payment and it answers HTTP 402 with one
 * requirement: scheme "exact" on network "xrpl-testnet", priced in drops. Retry
 * with a PAYMENT-SIGNATURE header that holds the hash of a payment the payer
 * already sent, and it looks that transaction up on the ledger, checks it with
 * xrpl-payment-verify.cjs, and answers 200 with a PAYMENT-RESPONSE header.
 *
 * Usage:
 *   XRPL_PAY_TO=r... node xrpl-merchant.cjs        # listens on PORT (default 4021)
 *
 * The envelope follows x402 v2: a PaymentRequired challenge with an accepts[]
 * array, base64 JSON in the PAYMENT-REQUIRED, PAYMENT-SIGNATURE and
 * PAYMENT-RESPONSE headers. The payload carries a transaction hash, not a
 * presigned transaction, so this is not byte-compatible with a stock x402 client.
 *
 * This is a demo. Invoices live in memory and nothing is authenticated.
 */

'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { Client, xrpToDrops } = require('xrpl');
const { checkPayment, fetchTransaction } = require('./xrpl-payment-verify.cjs');

const PORT = Number(process.env.PORT || 4021);
const XRPL_WS = process.env.XRPL_WS || 'wss://s.altnet.rippletest.net:51233';
const PAY_TO = process.env.XRPL_PAY_TO || '';
const DEFAULT_XRP = process.env.PAYMENT_XRP || '5';
const QUOTE_TTL_SECONDS = Number(process.env.X402_QUOTE_TTL || 300);

const SCHEME = 'exact';
const NETWORK = 'xrpl-testnet';
const RESOURCE = 'market-sentiment/v1';

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64');
const unb64 = (text) => JSON.parse(Buffer.from(text, 'base64').toString('utf8'));

const invoices = new Map(); // invoiceId -> { requirement, expiresAt, used }

function buildChallenge(xrp = DEFAULT_XRP) {
  const invoiceId = 'INV-' + crypto.randomBytes(12).toString('hex');
  const requirement = {
    scheme: SCHEME,
    network: NETWORK,
    asset: 'XRP',
    amount: xrpToDrops(String(xrp)), // drops, as a string
    payTo: PAY_TO,
    maxTimeoutSeconds: QUOTE_TTL_SECONDS,
    extra: { invoiceId },
  };
  invoices.set(invoiceId, { requirement, expiresAt: Date.now() + QUOTE_TTL_SECONDS * 1000, used: false });
  return { x402Version: 2, resource: RESOURCE, accepts: [requirement] };
}

/** Returns { ok: true, detail } or { ok: false, reason, detail }. */
async function verifyPayload(payload) {
  if (payload?.x402Version !== 2) return { ok: false, reason: 'invalid_envelope' };
  const accepted = payload.accepted;
  if (accepted?.scheme !== SCHEME) return { ok: false, reason: 'unsupported_scheme' };
  if (accepted.network !== NETWORK) return { ok: false, reason: 'invalid_network' };
  const record = invoices.get(accepted.extra?.invoiceId);
  if (!record) return { ok: false, reason: 'unknown_invoice' };
  if (record.used) return { ok: false, reason: 'invoice_already_used' };
  if (Date.now() > record.expiresAt) return { ok: false, reason: 'invoice_expired' };
  const txHash = payload.payload?.txHash;
  if (!/^[0-9a-fA-F]{64}$/.test(txHash ?? '')) {
    return { ok: false, reason: 'malformed_payment', detail: 'payload.txHash must be a 64-hex hash' };
  }

  // The merchant trusts nothing in the payload except the hash. It reads the
  // transaction from the ledger and compares it with the quote it issued.
  const client = new Client(XRPL_WS);
  await client.connect();
  try {
    const tx = await fetchTransaction(client, txHash);
    const result = checkPayment(tx, record.requirement);
    return result.ok ? { ok: true, detail: { ...result.detail, invoiceId: record.requirement.extra.invoiceId } } : result;
  } finally {
    await client.disconnect();
  }
}

const send = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body, null, 2));
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname !== '/resource') return send(res, 404, { error: 'only /resource exists' });

  const header = req.headers['payment-signature'];

  // No payment: answer with the challenge, in the header and in the body.
  if (!header) {
    const xrp = url.searchParams.get('xrp') ?? DEFAULT_XRP;
    if (!(Number(xrp) > 0 && Number(xrp) <= 100000)) return send(res, 400, { error: 'xrp must be a positive number' });
    const challenge = buildChallenge(xrp);
    console.log(`402  invoice ${challenge.accepts[0].extra.invoiceId}  price ${xrp} XRP`);
    return send(res, 402, challenge, { 'PAYMENT-REQUIRED': b64(challenge) });
  }

  let payload;
  try {
    payload = unb64(header);
  } catch {
    return send(res, 400, { error: 'PAYMENT-SIGNATURE is not base64 JSON' });
  }

  const paid = await verifyPayload(payload).catch((error) => ({ ok: false, reason: 'verify_failed', detail: error.message }));
  if (!paid.ok) {
    console.log(`402  refused: ${paid.reason}${paid.detail ? ' - ' + paid.detail : ''}`);
    const challenge = buildChallenge();
    return send(res, 402, { ...challenge, error: paid.reason, detail: paid.detail }, { 'PAYMENT-REQUIRED': b64(challenge) });
  }

  invoices.get(paid.detail.invoiceId).used = true; // replay guard: one invoice buys one resource
  console.log(`200  released to ${paid.detail.payer} - XRPL tx ${paid.detail.txHash}`);
  return send(res, 200, {
    resource: RESOURCE,
    generatedAt: new Date().toISOString(),
    paidBy: paid.detail.payer,
    amountXrp: Number(paid.detail.drops) / 1e6,
    body: 'Sentiment for the requested window: 0.62 positive, 0.21 neutral, 0.17 negative.',
  }, {
    'PAYMENT-RESPONSE': b64({
      success: true,
      scheme: SCHEME,
      network: NETWORK,
      payer: paid.detail.payer,
      transaction: paid.detail.txHash,
    }),
  });
});

if (!PAY_TO) {
  console.error('XRPL_PAY_TO is not set. Set it to the XRPL address that should receive payment.');
  process.exit(1);
}
server.listen(PORT, () => {
  console.log(`x402 XRPL merchant on http://localhost:${PORT}/resource`);
  console.log(`scheme ${SCHEME}  network ${NETWORK}  pays to ${PAY_TO}`);
});
