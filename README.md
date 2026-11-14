# ledger-gated-x402

A testnet demo. An AI agent buys a resource over x402. The payment is a classic XRP Ledger
payment. A small payment releases by itself. A payment over a cap waits until a person
approves it on a Ledger device. A payment that matches a hard block cannot be approved by anyone.

**This is a demo, not a product.** Read [Limits](#limits) before you reuse any of it.
Testnet only. Do not point it at mainnet.

## What it does

```
agent --GET--> merchant            402: pay 5 XRP to rMerchant (scheme exact, network xrpl-testnet)
agent --POST /intents--> gate      the agent holds no key. It states the payment it wants.
gate: policy
   under the cap        -> pays from a hot wallet
   over the cap         -> PENDING_APPROVAL -> approver app -> Ledger device -> signature -> submit
   hard block           -> BLOCKED (approve returns HTTP 409)
agent --GET + tx hash--> merchant  merchant reads the transaction from the ledger, then releases
```

- The invoice id from the 402 becomes the gate's `end_to_end_id`. It lands in the transaction
  memo. The merchant checks that the memo carries the invoice, so a payment is bound to one purchase.
- The merchant trusts only the hash. It checks that the transaction is validated, is a `Payment`,
  has `tesSUCCESS`, pays the quoted destination, delivers the quoted drops of XRP, and carries the invoice.
- One invoice buys one resource. A second try with the same payment is refused.

## Run it

Needs Node 22 or later. No device is needed for the first two commands.

```bash
npm install && (cd ledger-approver && npm install)
npm test                 # offline: verifier, merchant refusals, gate, policy
npm run prefund          # once: create and fund three testnet accounts, seeds go to .env
npm run demo:software    # all four beats, unattended
```

`npm run demo:software` uses a **software key** as the approver. **No Ledger device of any kind
takes part**, not even an emulator. The output says so in yellow.

The demo starts the gate on `127.0.0.1:8787` and the merchant on port 4031. If something else
holds a port, change it:

```bash
PORT=8788 GATE_URL=http://127.0.0.1:8788 DEMO_MERCHANT_PORT=4032 npm run demo:software
```

### With a Ledger device or the emulator

```bash
npm run demo                                                # terminal 1
cd ledger-approver && VITE_SPECULOS_URL=http://127.0.0.1:5000 npm run dev   # terminal 2
```

Open `http://localhost:5173`, connect (Speculos emulator or USB), press Fund once, then approve
or reject each over-cap payment as the demo asks. For the emulator, use a **Stax or Flex** build
with the XRP app. See [Limits](#limits) for the Nano X result.

## The four beats

| Beat | Payment | Expected |
|---|---|---|
| 1 | 5 XRP, under the 50 XRP cap | releases from the hot wallet |
| 2 | 75 XRP, over the cap | waits. The person rejects. The script asks the ledger (`account_tx`) and finds no signature and no transaction. |
| 3 | the same 75 XRP | the person approves. `tesSUCCESS`. The merchant releases. Then the same payment shown again is refused. |
| 4 | caller states `risk: blocked` | `BLOCKED`. Approve returns HTTP 409. |

A device reject (status word `0x6985`) shows as a clean DECLINED, not an error, and the device
session stays open for the next payment.

## What was checked

Each claim carries a label. `measured` means someone watched it happen. `inferred` means it follows
from the code or the docs but nobody watched it. `not run` means no check was made.

- **measured** (2026-11-14, this repository): `npm test` passes. 15 tests in the verifier and the
  merchant, and 27 in the gate and policy. `tsc --noEmit` is clean on the approver app.
- **measured** (2026-11-14, this repository): `npm run demo:software` ran twice against XRPL testnet.
  All four beats gave the expected outcome both times. The second run also showed the merchant refusing a
  replayed payment with `invoice_already_used`. A software key played the approver.
- **measured** (2026-11-14, this repository): `npm run demo` with the approver app connected to the
  **Speculos Stax emulator** (XRP app 2.8.2) gave the expected outcome in all four beats. No physical device took part.
  - Beat 2: Reject on the emulator made DMK fail with status word `0x6985`. The gate recorded `declined on device
    (0x6985)`. The script printed DECLINED. The intent had no tx hash. `account_tx` on the three accounts found no
    transaction that carries the invoice.
  - Beat 3, right after beat 2, with no reconnect: the device session survived. The emulator showed the invoice id as
    `Memo Data [1]`. The payment reached `tesSUCCESS`, and the merchant released the resource. The same payment shown
    again was refused with `invoice_already_used`.
  - Beat 4: `BLOCKED`. Approve returned HTTP 409.
  - The taps, swipes and the hold-to-sign were sent to the emulator through Speculos's HTTP API by a script, in place
    of a finger. The app clicks were made in a browser.
- **measured** (earlier run, in the repository this was extracted from): on a Speculos **Nano X** build, signing fails 0.3 to 1.0 seconds after the
  request with status `6901`, with no button pressed, while the device keeps showing the review. The cause is **not
  known**. The code does not treat `6901` as a decline. Not reported to Ledger.
- **not run:** a physical Ledger device. A Flex. A mainnet anything.
- **inferred:** a stock x402 client cannot pay this merchant, because the payload carries a transaction hash
  and not a presigned transaction.
- **inferred:** the approver app needs Chrome, Edge or Brave for USB, because it uses WebHID.

## Limits

- **The gate has no authentication.** It binds to `127.0.0.1` and allows CORS only from
  `localhost:5173` and `127.0.0.1:5173`. Anything on the same machine can call it. State is in memory and a restart loses it.
- **`risk` and `health` are stated by the caller.** Nothing here screens a destination or reads
  ledger health. Beat 4 shows the gate's rule. It does not show a sanctions check.
- **The caps are placeholders** (50 XRP per payment, 200 XRP per rolling day). The policy is in
  `ledger-approver/server/policy.mjs`.
- **The merchant is a demo.** In-memory invoices, no auth, one fixed resource, no rate limit.
- **The hot wallet is a software key** that the gate holds in memory. It signs the under-cap payments.
  Only the over-cap path needs the device.
- **The device path covers classic XRPL payments only.** The Ledger XRP signer kit has no typed-data
  method, so an EIP-712 voucher scheme cannot go through it.
- **The gate's memo type is `obsidian/e2e`.** This is a leftover label from the code's origin. The
  verifier matches the memo data, which holds the invoice id.
- The one-use rule for invoices lives in the merchant's memory. It does not survive a restart.

## Layout

| Path | What it is |
|---|---|
| `ledger-approver/server/policy.mjs` | The rules: auto, approval or block. Default deny. |
| `ledger-approver/server/gate.mjs` | The intent queue and state machine. Builds the transaction when a person approves. |
| `ledger-approver/server/gate-server.mjs` | HTTP on `127.0.0.1:8787`. |
| `ledger-approver/src/` | The React approver app. Signs through the Ledger Device Management Kit and the XRP signer kit. |
| `xrpl-merchant.cjs` | The demo x402 merchant. |
| `xrpl-payment-verify.cjs` | Pure checks of a ledger transaction against a quote. |
| `x402-xrpl-agent.cjs` | The agent. Reads the 402, hands the intent to the gate, waits, shows the hash. |
| `x402-ledger-demo.mjs` | The four-beat runner. |
| `prefund-demo-wallets.mjs` | Creates and funds the three testnet accounts. |

## Safety

- Testnet only. The scripts connect to `wss://s.altnet.rippletest.net:51233` by default.
- `.env` holds testnet seeds and is git-ignored. `.env.example` is committed and holds no secret.
- No script prints a seed. `npm run prefund` refuses to overwrite a seed that `.env` already holds.

## License

Apache-2.0. See [LICENSE](LICENSE). The approver app depends on Ledger's Device Management Kit
packages (also Apache-2.0) and on `xrpl`, React and Vite. This project is not made by or endorsed by Ledger.
