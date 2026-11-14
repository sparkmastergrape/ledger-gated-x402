/**
 * Verify that a classic XRPL Payment paid an x402 `exact` requirement.
 *
 * The merchant never takes the payer's word. It is handed a transaction hash,
 * asks the ledger for that transaction, and checks five things:
 *
 *   1. the ledger has validated it (final, not merely submitted)
 *   2. it is a Payment and its result is tesSUCCESS
 *   3. it paid the merchant's destination
 *   4. it delivered exactly the quoted drops
 *   5. it carries the invoice id in a memo (the binding that stops one payment
 *      buying two resources)
 *
 * checkPayment() is pure, so it is tested offline. fetchTransaction() is the
 * only part that touches the network.
 */

'use strict';

const MEMO_BINDING_TYPE = 'obsidian/e2e'; // memo type the Ledger gate writes; MemoData is the intent id
const toHex = (text) => Buffer.from(text, 'utf8').toString('hex').toUpperCase();

/** The invoice id the gate wrote into the memo, or null. */
function memoCarriesInvoice(memos, invoiceId) {
  const want = toHex(invoiceId);
  return (memos ?? []).some((m) => (m.Memo?.MemoData ?? '').toUpperCase() === want);
}

/** API v2 nests the transaction under tx_json; v1 puts it at the top level. Accept both. */
function flatten(r) {
  if (!r?.tx_json) return r;
  return { ...r.tx_json, hash: r.hash, validated: r.validated, meta: r.meta };
}

/**
 * @param raw         the `result` object of an XRPL `tx` request
 * @param requirement { payTo, amount (drops, string), extra: { invoiceId } }
 * @returns { ok: true, detail } or { ok: false, reason, detail }
 */
function checkPayment(raw, requirement) {
  const result = flatten(raw);
  if (!result || result.TransactionType === undefined) return { ok: false, reason: 'tx_not_found' };
  if (result.validated !== true) return { ok: false, reason: 'tx_not_validated' };
  if (result.TransactionType !== 'Payment') return { ok: false, reason: 'not_a_payment' };

  const code = result.meta?.TransactionResult;
  if (code !== 'tesSUCCESS') return { ok: false, reason: 'tx_failed', detail: String(code) };

  if (result.Destination !== requirement.payTo) {
    return { ok: false, reason: 'wrong_destination', detail: `paid ${result.Destination}, quote says ${requirement.payTo}` };
  }

  // delivered_amount is what actually arrived; Amount is only what was asked for.
  const delivered = result.meta?.delivered_amount ?? result.DeliveredAmount;
  if (typeof delivered !== 'string') return { ok: false, reason: 'not_xrp', detail: 'delivered amount is not drops of XRP' };
  if (delivered !== requirement.amount) {
    return { ok: false, reason: 'amount_mismatch', detail: `delivered ${delivered} drops, quote says ${requirement.amount}` };
  }

  if (!memoCarriesInvoice(result.Memos, requirement.extra.invoiceId)) {
    return { ok: false, reason: 'invoice_not_bound', detail: `no memo carries ${requirement.extra.invoiceId}` };
  }

  return { ok: true, detail: { payer: result.Account, txHash: result.hash, drops: delivered } };
}

/** Ask a validated-ledger server for one transaction. `client` is a connected xrpl.Client. */
async function fetchTransaction(client, txHash) {
  try {
    const r = await client.request({ command: 'tx', transaction: txHash });
    return r.result;
  } catch (error) {
    if (error?.data?.error === 'txnNotFound' || /txnNotFound/.test(String(error?.message))) return null;
    throw error;
  }
}

module.exports = { checkPayment, fetchTransaction, memoCarriesInvoice, toHex };
