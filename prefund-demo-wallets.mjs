// Create and fund the three demo wallets once, so `npm run demo` makes no faucet call.
//
// The seeds go straight to .env. This script prints addresses and balances, never a seed.
// It refuses to overwrite a seed that .env already holds.
//
// Usage:
//   node prefund-demo-wallets.mjs
//
// Testnet only. The faucet is slow and rate-limited at a busy event, which is the whole
// reason to call it the day before instead of during the demo.
import * as fs from 'node:fs';
import { Client, Wallet, dropsToXrp } from 'xrpl';

const XRPL_WS = process.env.XRPL_WS || 'wss://s.altnet.rippletest.net:51233';
const MAX_FAUCET_CALLS = 5;

// name, .env key, XRP the demo needs in it
const WALLETS = [
  ['hot wallet', 'HOT_WALLET_SEED', 25],
  ['merchant', 'MERCHANT_WALLET_SEED', 15],
  ['software approver', 'DEMO_APPROVER_SEED', 95],
];

const envPath = '.env';
const envBefore = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';

// Refuse to clobber anything already set, so a second run cannot lose a funded account.
const taken = WALLETS.filter(([, key]) => new RegExp(`^\s*${key}\s*=\s*"?s`, 'm').test(envBefore));
if (taken.length) {
  console.error('These seeds are already set in .env, so nothing was changed:');
  for (const [name, key] of taken) console.error(`  ${key}  (${name})`);
  console.error('Clear them yourself if you want new wallets.');
  process.exit(1);
}

// Keep .env out of git before writing a secret to it.
const gitignore = fs.existsSync('.gitignore') ? fs.readFileSync('.gitignore', 'utf8') : '';
if (!gitignore.split('\n').map((l) => l.trim()).includes('.env')) {
  fs.appendFileSync('.gitignore', `${gitignore.endsWith('\n') ? '' : '\n'}.env\n`, 'utf8');
  console.log('added .env to .gitignore');
}

const client = new Client(XRPL_WS);
await client.connect();

async function balanceXrp(address) {
  const info = await client.request({ command: 'account_info', account: address, ledger_index: 'validated' });
  return Number(dropsToXrp(info.result.account_data.Balance));
}

try {
  const rows = [];
  for (const [name, key, needXrp] of WALLETS) {
    const wallet = Wallet.generate('ecdsa-secp256k1');

    // Write the seed before touching the network. A funded account whose seed was lost is useless.
    const text = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    fs.appendFileSync(envPath, `${text.length && !text.endsWith('\n') ? '\n' : ''}${key}="${wallet.seed}"\n`, 'utf8');

    let balance = 0;
    let calls = 0;
    while (balance < needXrp && calls < MAX_FAUCET_CALLS) {
      await client.fundWallet(wallet);
      calls += 1;
      balance = await balanceXrp(wallet.classicAddress);
    }
    if (balance < needXrp) {
      console.error(`${name}: reached only ${balance} XRP after ${calls} faucet calls, under the ${needXrp} XRP needed.`);
      console.error(`Its seed is saved as ${key}. Top the account up and run the demo, or clear the seed.`);
      process.exitCode = 1;
    }
    rows.push([name, key, wallet.classicAddress, balance, calls]);
  }

  console.log('');
  console.log('name                address                              XRP     faucet calls');
  for (const [name, , address, balance, calls] of rows) {
    console.log(`${name.padEnd(19)} ${address.padEnd(36)} ${String(balance).padEnd(7)} ${calls}`);
  }
  console.log('');
  console.log('Seeds are saved in .env. No seed was printed.');
  console.log('Run the demo with: npm run demo:software   (or npm run demo for the device path)');
} finally {
  await client.disconnect();
}
