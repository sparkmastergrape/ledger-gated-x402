// Unit tests for server/guard.mjs: no server, no network. The HTTP-level behaviour is in gate-http-guard.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  GuardError, DEFAULT_ORIGINS, TOKEN_MIN_LENGTH, createGuard, isJsonContentType, parseOrigins, parseToken, redact, takeTokens, tokenMatches,
} from '../server/guard.mjs';

const AGENT = 'unit-agent-token-0123456789';
const APPROVER = 'unit-approver-token-9876543210';
const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();

// A request as the guard reads it: headers, the raw header list, the socket's local port, the method.
const fakeReq = ({ method = 'GET', headers = {}, port = 8791 } = {}) => {
  const raw = [];
  for (const [k, v] of Object.entries(headers)) raw.push(k, v);
  return { method, headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])), rawHeaders: raw, socket: { localPort: port } };
};
const refusal = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof GuardError, `expected a GuardError, got ${e}`); return e; } assert.fail('expected the guard to refuse'); };

// ---- GATE_ALLOWED_ORIGINS ----

test('parseOrigins: unset gives the two approver-app origins, and they are the documented default', () => {
  assert.deepEqual([...parseOrigins(undefined)], ['http://localhost:5173', 'http://127.0.0.1:5173']);
  assert.deepEqual([...DEFAULT_ORIGINS], ['http://localhost:5173', 'http://127.0.0.1:5173']);
});

test('parseOrigins: a comma list of exact origins is trimmed, empties are skipped, and it replaces the default', () => {
  const s = parseOrigins(' https://approver.example.test , http://localhost:6001,, ');
  assert.deepEqual([...s], ['https://approver.example.test', 'http://localhost:6001']);
  assert.equal(s.has('http://localhost:5173'), false);
});

test('parseOrigins: an empty value is an empty list (no browser origin at all), not "allow everything"', () => {
  assert.equal(parseOrigins('').size, 0);
  assert.equal(parseOrigins(' , ').size, 0);
});

for (const bad of [
  '*', 'http://*.example.com', 'https://*', 'null', 'localhost:5173', '//localhost:5173', 'http://localhost:5173/', 'http://localhost:5173/app',
  'http://localhost:5173?x=1', 'http://localhost:5173#x', 'HTTP://LOCALHOST:5173', 'http://localhost:80', 'https://localhost:443', 'ftp://localhost:5173',
  'file:///tmp', 'javascript:alert(1)', 'http://user@localhost:5173', 'http://', 'http://localhost:5173 http://x.test', 'not a url',
]) {
  test(`parseOrigins: ${JSON.stringify(bad)} is refused (the gate would not start)`, () => {
    assert.throws(() => parseOrigins(bad), /GATE_ALLOWED_ORIGINS/);
    assert.throws(() => parseOrigins(`http://localhost:5173,${bad}`), /GATE_ALLOWED_ORIGINS/);
  });
}

// ---- tokens ----

test('parseToken: unset is no token; a usable value is returned unchanged', () => {
  assert.equal(parseToken('GATE_AGENT_TOKEN', undefined), null);
  assert.equal(parseToken('GATE_AGENT_TOKEN', AGENT), AGENT);
  assert.equal(parseToken('GATE_AGENT_TOKEN', 'x'.repeat(TOKEN_MIN_LENGTH)), 'x'.repeat(TOKEN_MIN_LENGTH));
});

for (const bad of ['', ' ', 'short', 'x'.repeat(TOKEN_MIN_LENGTH - 1), 'has a space in the middle 123', `${'x'.repeat(20)} `, `\t${'x'.repeat(20)}`, `${'x'.repeat(20)}\n`, `${'x'.repeat(20)}é`, `${'x'.repeat(20)}\u0000`]) {
  test(`parseToken: ${JSON.stringify(bad)} stops the gate, and the message does not contain the value`, () => {
    let msg = '';
    try { parseToken('GATE_AGENT_TOKEN', bad); } catch (e) { msg = e.message; }
    assert.match(msg, /GATE_AGENT_TOKEN is set but cannot be used/);
    if (bad.trim() !== '') assert.equal(msg.includes(bad.trim()), false);
  });
}

test('tokenMatches: always hashes both sides first, so timingSafeEqual sees two 32-byte buffers whatever the lengths', () => {
  const calls = [];
  const real = crypto.timingSafeEqual;
  crypto.timingSafeEqual = (a, b) => { calls.push([a.length, b.length]); return real(a, b); };
  try {
    const expected = sha(AGENT);
    assert.equal(tokenMatches(AGENT, expected), true);
    for (const wrong of ['', 'a', AGENT.slice(0, -1), `${AGENT}x`, 'z'.repeat(5000), undefined, null, 42]) assert.equal(tokenMatches(wrong, expected), false);
    assert.equal(calls.length, 9, 'one constant-time comparison per attempt, none skipped for a different length');
    assert.deepEqual([...new Set(calls.map((c) => c.join('x')))], ['32x32']);
  } finally { crypto.timingSafeEqual = real; }
});

test('authorize: compares with crypto.timingSafeEqual once per active role, with no early exit between roles', () => {
  const g = createGuard({ origins: new Set(), agentToken: AGENT, approverToken: APPROVER });
  let n = 0;
  const real = crypto.timingSafeEqual;
  crypto.timingSafeEqual = (a, b) => { n++; return real(a, b); };
  try {
    g.authorize(fakeReq({ headers: { Authorization: `Bearer ${AGENT}` } }), ['agent', 'approver']); // the first role matches
    assert.equal(n, 2);
    n = 0;
    refusal(() => g.authorize(fakeReq({ headers: { Authorization: 'Bearer nope' } }), ['agent', 'approver']));
    assert.equal(n, 2);
    n = 0;
    refusal(() => g.authorize(fakeReq(), ['agent', 'approver'])); // no header at all is still compared (as an empty token)
    assert.equal(n, 2);
  } finally { crypto.timingSafeEqual = real; }
});

// ---- authorize: open and closed routes, by roles ----

test('authorize: a route whose roles have no token is open, whatever the header says', () => {
  const g = createGuard({ origins: new Set() });
  g.authorize(fakeReq(), ['agent']);
  g.authorize(fakeReq({ headers: { Authorization: 'Bearer wrong' } }), ['agent', 'approver']);
  const onlyAgent = createGuard({ origins: new Set(), agentToken: AGENT });
  onlyAgent.authorize(fakeReq(), ['approver']); // the approver token is not set, so the approver routes stay open
});

test('authorize: refusal is 401 with a fixed message and a WWW-Authenticate header, for every kind of bad credential', () => {
  const g = createGuard({ origins: new Set(), agentToken: AGENT, approverToken: APPROVER });
  const messages = new Set();
  for (const h of [undefined, '', 'Bearer', 'Bearer ', 'Bearer wrong-wrong-wrong-wrong', `Bearer ${AGENT.slice(0, -1)}`, `Bearer ${AGENT}x`, `Basic ${AGENT}`, AGENT, `Bearer ${AGENT} extra`, `Bearer ${APPROVER}`]) {
    const e = refusal(() => g.authorize(fakeReq({ headers: h === undefined ? {} : { Authorization: h } }), ['agent']));
    assert.equal(e.status, 401);
    assert.equal(e.code, 'UNAUTHORIZED');
    assert.deepEqual(e.headers, { 'www-authenticate': 'Bearer' });
    assert.equal(e.message.includes(AGENT) || e.message.includes(APPROVER), false);
    messages.add(e.message);
  }
  assert.equal(messages.size, 1, 'the same message whatever was wrong, so it is not an oracle');
});

test('authorize: the scheme is case-insensitive, one or more spaces are allowed, and the token itself is case-sensitive', () => {
  const g = createGuard({ origins: new Set(), agentToken: AGENT });
  for (const scheme of ['Bearer', 'bearer', 'BEARER', 'bEaReR']) g.authorize(fakeReq({ headers: { Authorization: `${scheme} ${AGENT}` } }), ['agent']);
  g.authorize(fakeReq({ headers: { Authorization: `Bearer   ${AGENT}` } }), ['agent']);
  refusal(() => g.authorize(fakeReq({ headers: { Authorization: `Bearer ${AGENT.toUpperCase()}` } }), ['agent']));
});

test('authorize: a role is accepted only on the routes that list it', () => {
  const g = createGuard({ origins: new Set(), agentToken: AGENT, approverToken: APPROVER });
  const as = (token) => fakeReq({ headers: { Authorization: `Bearer ${token}` } });
  g.authorize(as(AGENT), ['agent']);
  refusal(() => g.authorize(as(APPROVER), ['agent']));
  g.authorize(as(APPROVER), ['approver']);
  refusal(() => g.authorize(as(AGENT), ['approver']));
  g.authorize(as(AGENT), ['agent', 'approver']);
  g.authorize(as(APPROVER), ['agent', 'approver']);
});

test('status: booleans only, and createGuard keeps no readable copy of a token', () => {
  const g = createGuard({ origins: new Set(), agentToken: AGENT });
  assert.deepEqual(g.status, { agentToken: true, approverToken: false });
  assert.equal(JSON.stringify(g).includes(AGENT), false);
  assert.deepEqual(createGuard({ origins: new Set() }).status, { agentToken: false, approverToken: false });
});

// ---- Content-Type ----

test('isJsonContentType: application/json with or without parameters, any case; nothing else', () => {
  for (const ok of ['application/json', 'application/json; charset=utf-8', 'application/json;charset=UTF-8', 'Application/JSON', ' application/json ', 'application/json ; charset=utf-8', 'APPLICATION/JSON;x=y']) {
    assert.equal(isJsonContentType(ok), true, ok);
  }
  for (const no of [undefined, '', 'text/plain', 'text/plain;charset=UTF-8', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/jsonp',
    'application/json-patch+json', 'application/vnd.api+json', 'text/json', 'application/octet-stream', 'application/json, text/plain', 'application/json/x', '*/*', 'json', 'text/plain; application/json']) {
    assert.equal(isJsonContentType(no), false, String(no));
  }
});

test('checkContentType: GET and HEAD need nothing; every other method needs JSON', () => {
  const g = createGuard({ origins: new Set() });
  g.checkContentType(fakeReq({ method: 'GET' }));
  g.checkContentType(fakeReq({ method: 'HEAD', headers: { 'Content-Type': 'text/plain' } }));
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'TRACE', 'PURGE']) {
    const e = refusal(() => g.checkContentType(fakeReq({ method })));
    assert.equal(e.status, 415);
    refusal(() => g.checkContentType(fakeReq({ method, headers: { 'Content-Type': 'text/plain' } })));
    g.checkContentType(fakeReq({ method, headers: { 'Content-Type': 'application/json; charset=utf-8' } }));
  }
});

test('checkContentType: two Content-Type headers are refused, even if the first one is JSON', () => {
  const g = createGuard({ origins: new Set() });
  const two = fakeReq({ method: 'POST', headers: { 'Content-Type': 'application/json' } });
  two.rawHeaders.push('Content-Type', 'text/plain');
  assert.equal(refusal(() => g.checkContentType(two)).status, 415);
});

// ---- Origin and CORS headers ----

test('checkOrigin: no Origin passes; an allowed Origin passes; everything else is 403', () => {
  const g = createGuard({ origins: parseOrigins(undefined) });
  g.checkOrigin(fakeReq());
  g.checkOrigin(fakeReq({ headers: { Origin: 'http://localhost:5173' } }));
  g.checkOrigin(fakeReq({ headers: { Origin: 'http://127.0.0.1:5173' } }));
  for (const bad of ['', 'null', 'http://evil.test', 'http://localhost', 'http://localhost:5174', 'https://localhost:5173', 'http://localhost:5173/', 'http://localhost:5173.evil.test',
    'http://localhost:5173, http://evil.test', 'HTTP://LOCALHOST:5173', '*', 'http://localhost:5173 ']) {
    const e = refusal(() => g.checkOrigin(fakeReq({ headers: { Origin: bad } })));
    assert.equal(e.status, 403);
    assert.equal(e.code, 'ORIGIN_NOT_ALLOWED');
  }
});

test('cors: Vary: Origin always; the origin is echoed only when allowed; never a wildcard', () => {
  const g = createGuard({ origins: new Set(['http://localhost:5173']) });
  assert.deepEqual(g.cors('http://localhost:5173'), { 'access-control-allow-origin': 'http://localhost:5173', vary: 'Origin' });
  for (const o of [undefined, 'http://evil.test', 'null', '', '*', 'http://localhost:5173/']) assert.deepEqual(g.cors(o), { vary: 'Origin' });
});

// ---- Host ----

test('checkHost: only 127.0.0.1, localhost and [::1] on the port the request arrived on', () => {
  const g = createGuard({ origins: new Set() });
  const host = (h, port = 8791) => fakeReq({ headers: { Host: h }, port });
  for (const ok of ['127.0.0.1:8791', 'localhost:8791', '[::1]:8791', 'LOCALHOST:8791', 'Localhost:8791']) g.checkHost(host(ok));
  g.checkHost(host('127.0.0.1:51234', 51234)); // the port is the socket's own, so an ephemeral port works
  for (const bad of ['evil.test:8791', '127.0.0.1.evil.test:8791', 'localhost.evil.test:8791', 'localhost.:8791', '127.0.0.1', 'localhost', '[::1]', '127.0.0.1:8792', '127.0.0.1:80',
    '0.0.0.0:8791', '127.0.0.2:8791', '[::ffff:127.0.0.1]:8791', 'evil.test', '127.0.0.1:8791.evil.test', 'localhost:8791 evil.test', 'localhost:8791,evil.test', '', ' ', 'user@localhost:8791', 'localhost:08791']) {
    const e = refusal(() => g.checkHost(host(bad)));
    assert.equal(e.status, 421, bad);
    assert.equal(e.bare, true, 'a Host refusal carries no CORS headers');
  }
  refusal(() => g.checkHost(host('127.0.0.1:8791', 9999))); // a Host that names a different port than the socket's
});

test('checkHost: no Host header, or two of them, is refused', () => {
  const g = createGuard({ origins: new Set() });
  refusal(() => g.checkHost(fakeReq()));
  const two = fakeReq({ headers: { Host: '127.0.0.1:8791' } });
  two.rawHeaders.push('Host', 'evil.test');
  refusal(() => g.checkHost(two));
});

test('checkHost: two IDENTICAL Host headers are refused too', () => {
  const g = createGuard({ origins: new Set() });
  const two = fakeReq({ headers: { Host: '127.0.0.1:8791' } });
  two.rawHeaders.push('host', '127.0.0.1:8791');
  assert.equal(refusal(() => g.checkHost(two)).status, 421);
  g.checkHost(fakeReq({ headers: { Host: '127.0.0.1:8791' } })); // one is fine
});

// ---- request target ----

test('checkTarget: a plain path passes; an absolute URL is 421; "//x", a backslash and anything not starting with "/" is 400', () => {
  const g = createGuard({ origins: new Set() });
  const target = (url) => ({ ...fakeReq(), url });
  for (const ok of ['/', '/intents', '/intents/abc/reject', '/intents?x=1', '/intents/%20x', '/a//b', '/a%2F%2Fb']) g.checkTarget(target(ok));
  for (const abs of ['http://evil.test:8795/intents', 'https://127.0.0.1:8791/intents', 'HTTP://x/', 'ws://x/', 'ftp://x/y', 'javascript:alert(1)']) {
    const e = refusal(() => g.checkTarget(target(abs)));
    assert.equal(e.status, 421, abs);
    assert.equal(e.code, 'BAD_HOST');
    assert.equal(e.bare, true);
  }
  for (const bad of ['//x/intents', '//', '///intents', '/\\x/intents', '/intents\\x', '\\\\x\\intents', '*', 'intents', '', ' /intents']) {
    const e = refusal(() => g.checkTarget(target(bad)));
    assert.equal(e.status, 400, JSON.stringify(bad));
    assert.equal(e.code, 'BAD_PATH');
  }
  refusal(() => g.checkTarget({ ...fakeReq(), url: undefined }));
});

// ---- duplicate Authorization ----

test('authorize: two Authorization headers are refused whichever comes first, and even when both are right', () => {
  const g = createGuard({ origins: new Set(), agentToken: AGENT });
  const withTwo = (a, b) => { const r = fakeReq({ headers: { Authorization: a } }); r.rawHeaders.push('authorization', b); return r; };
  for (const [a, b] of [[`Bearer ${AGENT}`, 'Bearer wrong-wrong-wrong-wrong'], ['Bearer wrong-wrong-wrong-wrong', `Bearer ${AGENT}`], [`Bearer ${AGENT}`, `Bearer ${AGENT}`]]) {
    const e = refusal(() => g.authorize(withTwo(a, b), ['agent']));
    assert.equal(e.status, 401);
    assert.equal(e.code, 'UNAUTHORIZED');
    assert.deepEqual(e.headers, { 'www-authenticate': 'Bearer' });
  }
  g.authorize(fakeReq({ headers: { Authorization: `Bearer ${AGENT}` } }), ['agent']);
  // A route with no token set is open and ignores the header, one or two.
  createGuard({ origins: new Set() }).authorize(withTwo('Bearer a', 'Bearer b'), ['agent']);
});

// ---- tokens: length boundary, and removal from the environment ----

test('parseToken: 15 characters is refused and 16 is accepted (the numbers are written out, not taken from the constant)', () => {
  assert.equal(TOKEN_MIN_LENGTH, 16);
  assert.throws(() => parseToken('GATE_AGENT_TOKEN', 'a'.repeat(15)), /cannot be used/);
  assert.equal(parseToken('GATE_AGENT_TOKEN', 'a'.repeat(16)), 'a'.repeat(16));
  assert.equal(parseToken('GATE_AGENT_TOKEN', 'a'.repeat(300)), 'a'.repeat(300));
});

test('takeTokens: returns the tokens and removes both variables from the environment it was given', () => {
  const env = { GATE_AGENT_TOKEN: AGENT, GATE_APPROVER_TOKEN: APPROVER, GATE_LEDGER: 'stub' };
  assert.deepEqual(takeTokens(env), { agentToken: AGENT, approverToken: APPROVER });
  assert.deepEqual(env, { GATE_LEDGER: 'stub' }, 'both tokens are gone, nothing else was touched');
  const one = { GATE_AGENT_TOKEN: AGENT };
  assert.deepEqual(takeTokens(one), { agentToken: AGENT, approverToken: null });
  assert.deepEqual(one, {});
  assert.deepEqual(takeTokens({}), { agentToken: null, approverToken: null });
});

test('takeTokens: when it refuses a value, both variables are still removed, and the message does not show a token', () => {
  for (const env of [
    { GATE_AGENT_TOKEN: 'short', GATE_APPROVER_TOKEN: APPROVER },
    { GATE_AGENT_TOKEN: AGENT, GATE_APPROVER_TOKEN: '' },
    { GATE_AGENT_TOKEN: AGENT, GATE_APPROVER_TOKEN: AGENT },
    { GATE_AGENT_TOKEN: AGENT, GATE_APPROVER_TOKEN: `${APPROVER} with space` },
  ]) {
    const copy = { ...env };
    let msg = '';
    try { takeTokens(env); } catch (e) { msg = e.message; }
    assert.notEqual(msg, '', 'it must refuse');
    assert.deepEqual(env, {}, 'the variables are removed even though it refused');
    for (const v of Object.values(copy)) if (v.length > 6) assert.equal(msg.includes(v), false);
  }
  assert.throws(() => takeTokens({ GATE_AGENT_TOKEN: AGENT, GATE_APPROVER_TOKEN: AGENT }), /must be different/);
});

test('takeTokens: with no argument it uses process.env, and leaves nothing behind there', () => {
  const saved = [process.env.GATE_AGENT_TOKEN, process.env.GATE_APPROVER_TOKEN];
  process.env.GATE_AGENT_TOKEN = AGENT;
  process.env.GATE_APPROVER_TOKEN = APPROVER;
  try {
    assert.deepEqual(takeTokens(), { agentToken: AGENT, approverToken: APPROVER });
    assert.equal(process.env.GATE_AGENT_TOKEN, undefined);
    assert.equal(process.env.GATE_APPROVER_TOKEN, undefined);
  } finally {
    if (saved[0] !== undefined) process.env.GATE_AGENT_TOKEN = saved[0];
    if (saved[1] !== undefined) process.env.GATE_APPROVER_TOKEN = saved[1];
  }
});

// ---- log hygiene ----

test('redact: cuts out secrets, keeps a URL\'s host but not its user info, path or query, and returns one short line', () => {
  assert.equal(redact('failed wss://user:pw@node.example.com/SECRETKEY/ws?token=abc rest'), 'failed wss://node.example.com/<hidden> rest');
  assert.equal(redact('ws://127.0.0.1:1/abc'), 'ws://127.0.0.1:1/<hidden>');
  assert.equal(redact('bad seed sMYSEEDVALUE here', ['sMYSEEDVALUE']), 'bad seed <hidden> here');
  assert.equal(redact('the secret is KEY1 and KEY1', ['KEY1', undefined, '']), 'the secret is <hidden> and <hidden>');
  assert.equal(redact('two\nlines\r\n  and   gaps'), 'two lines and gaps');
  assert.equal(redact('x'.repeat(1000)).length, 300);
  assert.equal(redact(undefined), '');
});

// ---- Vary / CORS flags on refusals ----

test('refusals: a Host or target refusal is "bare" (no CORS header, not even Vary); a refused preflight keeps Vary but grants nothing', () => {
  const g = createGuard({ origins: new Set(['http://localhost:5173']) });
  const host = refusal(() => g.checkHost(fakeReq({ headers: { Host: 'evil.test:8791' } })));
  assert.equal(host.bare, true);
  const pf = (extra) => refusal(() => g.preflight(fakeReq({ method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', ...extra } })));
  for (const e of [pf({ 'Access-Control-Request-Method': 'PUT' }), pf({ 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'x-evil' })]) {
    assert.equal(e.bare, false, 'it depends on Origin, so Vary: Origin stays');
    assert.equal(e.noGrant, true, 'and no Access-Control-Allow-* header is sent');
  }
  const foreign = refusal(() => g.checkOrigin(fakeReq({ headers: { Origin: 'http://evil.test' } })));
  assert.equal(foreign.bare, false);
  assert.equal(foreign.noGrant, false);
});

// ---- Preflight ----

test('preflight: an allowed origin gets the exact origin back and only the gate\'s own methods and headers', () => {
  const g = createGuard({ origins: new Set(['http://localhost:5173']) });
  const pf = (extra = {}) => g.preflight(fakeReq({ method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', ...extra } }));
  const h = pf({ 'Access-Control-Request-Headers': 'content-type,authorization' });
  assert.equal(h['access-control-allow-origin'], 'http://localhost:5173');
  assert.equal(h.vary, 'Origin');
  assert.equal(h['access-control-allow-methods'], 'GET, POST');
  assert.equal(h['access-control-allow-headers'], 'Content-Type, Authorization');
  assert.equal(Object.keys(h).some((k) => k === 'access-control-allow-credentials'), false);
  pf({ 'Access-Control-Request-Headers': 'Content-Type' });
  pf({ 'Access-Control-Request-Headers': '' });
  pf({ 'Access-Control-Request-Method': 'GET' });
  for (const method of [undefined, 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'post', '*', 'POST, PUT']) {
    refusal(() => g.preflight(fakeReq({ method: 'OPTIONS', headers: method === undefined ? { Origin: 'http://localhost:5173' } : { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': method } })));
  }
  for (const hd of ['x-evil', 'content-type, x-evil', 'authorization,x-gate-token', '*', 'cookie']) refusal(() => pf({ 'Access-Control-Request-Headers': hd }));
});

test('preflight: a foreign, null or malformed origin is refused with no CORS headers; no Origin means no CORS grant at all', () => {
  const g = createGuard({ origins: new Set(['http://localhost:5173']) });
  for (const o of ['http://evil.test', 'null', '', '*', 'http://localhost:5173/']) {
    const e = refusal(() => g.preflight(fakeReq({ method: 'OPTIONS', headers: { Origin: o, 'Access-Control-Request-Method': 'POST' } })));
    assert.equal(e.status, 403);
  }
  const h = g.preflight(fakeReq({ method: 'OPTIONS' }));
  assert.equal(Object.keys(h).some((k) => k.startsWith('access-control-allow')), false);
});
