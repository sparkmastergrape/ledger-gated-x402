'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checkPayment, toHex } = require('./xrpl-payment-verify.cjs');

const requirement = { payTo: 'rMerchant', amount: '5000000', extra: { invoiceId: 'INV-abc' } };
const good = () => ({
  TransactionType: 'Payment', validated: true, hash: 'H', Account: 'rPayer', Destination: 'rMerchant',
  Memos: [{ Memo: { MemoType: toHex('obsidian/e2e'), MemoData: toHex('INV-abc') } }],
  meta: { TransactionResult: 'tesSUCCESS', delivered_amount: '5000000' },
});

test('accepts the API v2 shape (tx_json nested)', () => {
  const g = good();
  const { meta, validated, hash } = g;
  delete g.meta; delete g.validated; delete g.hash;
  assert.equal(checkPayment({ tx_json: g, meta, validated, hash }, requirement).ok, true);
});

test('accepts a matching payment', () => assert.equal(checkPayment(good(), requirement).ok, true));

const refuse = (name, mutate, reason) => test(`refuses: ${name}`, () => {
  const tx = good(); mutate(tx);
  const r = checkPayment(tx, requirement);
  assert.equal(r.ok, false);
  assert.equal(r.reason, reason);
});

refuse('not validated', (t) => { t.validated = false; }, 'tx_not_validated');
refuse('not a Payment', (t) => { t.TransactionType = 'TrustSet'; }, 'not_a_payment');
refuse('failed result', (t) => { t.meta.TransactionResult = 'tecUNFUNDED_PAYMENT'; }, 'tx_failed');
refuse('wrong destination', (t) => { t.Destination = 'rSomeoneElse'; }, 'wrong_destination');
refuse('short amount', (t) => { t.meta.delivered_amount = '4999999'; }, 'amount_mismatch');
refuse('token amount', (t) => { t.meta.delivered_amount = { currency: 'USD', value: '5' }; }, 'not_xrp');
refuse('other invoice', (t) => { t.Memos[0].Memo.MemoData = toHex('INV-other'); }, 'invoice_not_bound');
refuse('no memo', (t) => { delete t.Memos; }, 'invoice_not_bound');
test('refuses a missing transaction', () => assert.equal(checkPayment(null, requirement).reason, 'tx_not_found'));
