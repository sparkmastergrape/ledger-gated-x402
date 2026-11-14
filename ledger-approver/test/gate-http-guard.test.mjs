// The guard, wired into the real gate server, over real HTTP. No network: the gate is pointed at a dead
// ledger address, so its demo wallets never start. Every case here is decided by the guard before the gate is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8800 + Math.floor(Math.random() * 150);
const AGENT = 'agent-token-0123456789abcdef';
const APPROVER = 'approver-token-0123456789abcdef';
const APP_ORIGIN = 'http://localhost:5173';

function start(env) {
  const child = spawn(process.execPath, [path.join(here, '../server/gate-server.mjs')], {
    env: { ...process.env, PORT: String(PORT), XRPL_WS: 'ws://127.0.0.1:9', HOT_WALLET_SEED: '', MERCHANT_WALLET_SEED: '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { child, output: () => out };
}

// Plain http.request, because fetch will not let a test set the Host header.
function call({ method = 'GET', target = '/health', headers = {}, body, port = PORT }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: target, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ } resolve({ status: res.statusCode, headers: res.headers, text, json }); });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const json = { 'content-type': 'application/json' };
const bearer = (t) => ({ authorization: `Bearer ${t}` });

let gate;
test.before(async () => {
  gate = start({ GATE_AGENT_TOKEN: AGENT, GATE_APPROVER_TOKEN: APPROVER });
  for (let i = 0; i < 60; i++) {
    try { await call({}); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error(`gate did not start: ${gate.output()}`);
});
test.after(() => gate.child.kill());

test('/health is open, says which tokens are on, and never shows a token', async () => {
  const r = await call({});
  assert.equal(r.status, 200);
  assert.equal(r.json.agentToken, true);
  assert.equal(r.json.approverToken, true);
  assert.ok(!r.text.includes(AGENT) && !r.text.includes(APPROVER));
});

test('a Host that is not loopback on this port is refused with 421 and no CORS headers', async () => {
  for (const host of ['evil.test', `evil.test:${PORT}`, `127.0.0.1:${PORT + 1}`]) {
    const r = await call({ headers: { host } });
    assert.equal(r.status, 421, host);
    assert.equal(r.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await call({ headers: { host: `localhost:${PORT}` } })).status, 200);
});

test('an absolute-form or double-slash target is refused', async () => {
  assert.equal((await call({ target: 'http://evil.test/health' })).status, 421);
  assert.equal((await call({ target: '//evil.test/health' })).status, 400);
});

test('an Origin that is not on the list is refused with 403, on every method', async () => {
  const bad = { origin: 'http://evil.test' };
  assert.equal((await call({ headers: bad })).status, 403);
  assert.equal((await call({ target: '/intents', method: 'POST', headers: { ...json, ...bad, ...bearer(AGENT) }, body: '{}' })).status, 403);
});

test('the approver app origin is allowed and echoed, never "*"', async () => {
  const r = await call({ headers: { origin: APP_ORIGIN } });
  assert.equal(r.status, 200);
  assert.equal(r.headers['access-control-allow-origin'], APP_ORIGIN);
});

test('a preflight is answered only for an allowed origin, and only for GET and POST', async () => {
  const ok = await call({ method: 'OPTIONS', target: '/intents', headers: { origin: APP_ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type, authorization' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers['access-control-allow-origin'], APP_ORIGIN);
  const evil = await call({ method: 'OPTIONS', target: '/intents', headers: { origin: 'http://evil.test', 'access-control-request-method': 'POST' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const del = await call({ method: 'OPTIONS', target: '/intents', headers: { origin: APP_ORIGIN, 'access-control-request-method': 'DELETE' } });
  assert.equal(del.status, 403);
  assert.equal(del.headers['access-control-allow-origin'], undefined);
});

test('a POST that is not application/json is refused with 415', async () => {
  const r = await call({ target: '/intents', method: 'POST', headers: { 'content-type': 'text/plain', ...bearer(AGENT) }, body: '{}' });
  assert.equal(r.status, 415);
});

test('with tokens set, a route with no token or a wrong token is 401 and says nothing about which', async () => {
  const none = await call({ target: '/intents' });
  const wrong = await call({ target: '/intents', headers: bearer('x'.repeat(30)) });
  assert.equal(none.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(none.json, wrong.json);
  assert.equal(none.headers['www-authenticate'], 'Bearer');
});

test('the agent token can submit but cannot list or approve; the approver token can list but cannot submit', async () => {
  assert.equal((await call({ target: '/intents', headers: bearer(AGENT) })).status, 401);
  assert.equal((await call({ target: '/intents/x/approve', method: 'POST', headers: { ...json, ...bearer(AGENT) }, body: '{}' })).status, 401);
  assert.equal((await call({ target: '/intents', method: 'POST', headers: { ...json, ...bearer(APPROVER) }, body: '{}' })).status, 401);
  assert.equal((await call({ target: '/intents', headers: bearer(APPROVER) })).status, 200);
});

test('a refusal happens before the body is read or the gate is touched: an agent POST with a valid token reaches the gate', async () => {
  const r = await call({ target: '/intents', method: 'POST', headers: { ...json, ...bearer(AGENT) }, body: '{}' });
  assert.notEqual(r.status, 401);
  assert.notEqual(r.status, 403);
  assert.notEqual(r.status, 415);
});

test('a bad percent escape in the intent id is a 400 after the token check, not a 500', async () => {
  assert.equal((await call({ target: '/intents/%zz', headers: bearer(APPROVER) })).status, 400);
  assert.equal((await call({ target: '/intents/%zz' })).status, 401);
});

test('a token that is too short stops the gate at start, and the value is not printed', async () => {
  const short = 'short';
  const g = start({ PORT: String(PORT + 200), GATE_AGENT_TOKEN: short });
  const code = await new Promise((resolve) => g.child.on('exit', resolve));
  assert.equal(code, 1);
  assert.ok(!g.output().includes(`"${short}"`));
  assert.match(g.output(), /GATE_AGENT_TOKEN is set but cannot be used/);
});

test('with no tokens set, the routes are open as before', async () => {
  const port = PORT + 201;
  const g = start({ PORT: String(port), GATE_AGENT_TOKEN: undefined, GATE_APPROVER_TOKEN: undefined });
  try {
    for (let i = 0; i < 60; i++) { try { await call({ port }); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const h = await call({ port });
    assert.equal(h.json.agentToken, false);
    assert.equal(h.json.approverToken, false);
    assert.equal((await call({ port, target: '/intents' })).status, 200);
  } finally { g.child.kill(); }
});
