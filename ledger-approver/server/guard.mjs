// Request guard for the gate's HTTP front. No dependency on the gate itself, so it can be tested alone.
//
// What it closes (see README, "Network guard"):
//   0. Target      The request target must be a plain path: not an absolute URL (421), not "//x" or a backslash (400).
//   1. Host        DNS rebinding. Only 127.0.0.1, localhost and [::1], on the port the request arrived on.      -> 421
//   2. Origin      A request that carries an Origin header must carry one from the allow-list (every method).   -> 403
//                  A request with no Origin (curl, the agent process, a Node script) is not a browser; it passes.
//   3. Preflight   OPTIONS answers CORS permission only for an allow-listed origin, and only for what the gate uses.
//   4. Media type  Every request that is not GET or HEAD must be application/json, or it is refused.            -> 415
//                  A cross-site page cannot send application/json without a preflight, and the preflight fails.
//   5. Tokens      Optional bearer tokens per role (agent, approver), compared in constant time.                -> 401
//
// Order in the server: Host, target, then (OPTIONS answers here), Origin, media type, then the route's own token check.
// Nothing here reads a body, and nothing here changes gate state, so a refused request cannot change anything.
import crypto from 'node:crypto';

// A refusal that the server turns into the gate's usual { error, message } body.
export class GuardError extends Error {
  constructor(code, message, status, { headers, bare = false, noGrant = false } = {}) {
    super(message);
    this.code = code; this.status = status;
    this.headers = headers;
    this.bare = bare;       // true: no CORS headers at all, not even Vary (the answer does not depend on Origin: Host and target refusals)
    this.noGrant = noGrant; // true: no Access-Control-Allow-* header, but Vary: Origin stays (a refused preflight depends on Origin)
  }
}

// The two origins of the approver app (Vite, strictPort 5173). GATE_ALLOWED_ORIGINS replaces them.
export const DEFAULT_ORIGINS = Object.freeze(['http://localhost:5173', 'http://127.0.0.1:5173']);
export const TOKEN_MIN_LENGTH = 16;
const PREFLIGHT_METHODS = ['GET', 'POST']; // what the gate's own app uses
const PREFLIGHT_HEADERS = ['content-type', 'authorization'];
const NO_BODY_METHODS = new Set(['GET', 'HEAD']); // everything else is treated as able to change state

// GATE_ALLOWED_ORIGINS: a comma list of exact origins, written the way a browser sends them. No wildcard, no path,
// no trailing slash, no default port. A bad entry stops the gate: a typo must not widen (or silently narrow) the list.
// An empty list is allowed and means no browser origin at all (curl and local processes only).
export function parseOrigins(raw) {
  if (raw === undefined) return new Set(DEFAULT_ORIGINS);
  const out = new Set();
  for (const part of String(raw).split(',')) {
    const entry = part.trim();
    if (entry === '') continue;
    let ok = false;
    try {
      const u = new URL(entry);
      ok = (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === entry && !entry.includes('*');
    } catch { ok = false; }
    if (!ok) throw new Error(`GATE_ALLOWED_ORIGINS has an entry that is not an exact origin like http://localhost:5173 (lower case, no wildcard, path, trailing slash or default port): ${JSON.stringify(entry.slice(0, 60))}`);
    out.add(entry);
  }
  return out;
}

// GATE_AGENT_TOKEN / GATE_APPROVER_TOKEN. Unset means "no guard". Set but unusable stops the gate, because an empty
// or too-short value silently meaning "open" (or "easy to guess") is the wrong way round. The value is never put in a message.
export function parseToken(name, raw) {
  if (raw === undefined) return null;
  if (!new RegExp(`^[\\x21-\\x7e]{${TOKEN_MIN_LENGTH},}$`).test(raw)) {
    throw new Error(`${name} is set but cannot be used: it must be at least ${TOKEN_MIN_LENGTH} printable characters with no spaces. (The value is not shown.) Unset it for no token.`);
  }
  return raw;
}

// Reads both token variables from `env`, checks them, and REMOVES them from `env` (also when they are refused), so nothing
// else in the process can read them back. Returns the two tokens, or null for one that is not set.
export function takeTokens(env = process.env) {
  try {
    const agentToken = parseToken('GATE_AGENT_TOKEN', env.GATE_AGENT_TOKEN);
    const approverToken = parseToken('GATE_APPROVER_TOKEN', env.GATE_APPROVER_TOKEN);
    if (agentToken !== null && agentToken === approverToken) throw new Error('GATE_AGENT_TOKEN and GATE_APPROVER_TOKEN must be different: the agent must not be able to approve. (The values are not shown.)');
    return { agentToken, approverToken };
  } finally {
    delete env.GATE_AGENT_TOKEN;
    delete env.GATE_APPROVER_TOKEN;
  }
}

// A message that is safe to write to a log: each secret given is cut out, a URL keeps its host but loses user info, path and
// query (an RPC key often sits in the path), and it is one short line. Used for errors that come from outside the gate.
export function redact(message, secrets = []) {
  let s = String(message ?? '');
  for (const secret of secrets) if (typeof secret === 'string' && secret !== '') s = s.split(secret).join('<hidden>');
  return s.replace(/\b((?:wss?|https?):\/\/)(?:[^/\s@]*@)?([^/\s?#]*)\S*/gi, '$1$2/<hidden>').replace(/\s+/g, ' ').slice(0, 300);
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();

// Constant-time comparison. Both sides are hashed first, so the two buffers always have the same length (32 bytes)
// and timingSafeEqual neither throws on a different length nor lets the length of the token show through.
export function tokenMatches(presented, expectedDigest) {
  return crypto.timingSafeEqual(sha256(typeof presented === 'string' ? presented : ''), expectedDigest);
}

export const isJsonContentType = (v) => typeof v === 'string' && v.split(';', 1)[0].trim().toLowerCase() === 'application/json';

const countHeader = (req, name) => { let n = 0; for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name) n++; return n; };

export function createGuard({ origins, agentToken = null, approverToken = null }) {
  const digests = { agent: agentToken === null ? null : sha256(agentToken), approver: approverToken === null ? null : sha256(approverToken) };
  const originOk = (o) => typeof o === 'string' && origins.has(o);

  return {
    origins: [...origins],
    // Booleans only. Shown by /health so the app knows whether to ask for a token.
    status: { agentToken: digests.agent !== null, approverToken: digests.approver !== null },

    // Headers every answer carries. Vary: Origin always; the origin is echoed only when it is on the list (never "*").
    cors(origin) {
      return originOk(origin) ? { 'access-control-allow-origin': origin, vary: 'Origin' } : { vary: 'Origin' };
    },

    // DNS rebinding: a page on evil.test whose name now points at 127.0.0.1 sends Host: evil.test:<port>.
    // The port is the one the request arrived on (the socket's own local port), not a number taken from the request.
    checkHost(req) {
      const port = req.socket.localPort;
      const host = req.headers.host;
      const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
      if (typeof host !== 'string' || countHeader(req, 'host') !== 1 || !allowed.includes(host.toLowerCase())) {
        throw new GuardError('BAD_HOST', 'This gate answers only to 127.0.0.1, localhost or [::1] on its own port.', 421, { bare: true });
      }
    },

    // The request target must be a path. An absolute-form target (POST http://evil.test/intents) carries an authority the Host
    // check never saw, and "//x/intents" or "/\x/intents" is read by URL parsing as a host "x", so both are refused.
    checkTarget(req) {
      const t = req.url;
      if (typeof t === 'string' && /^[a-z][a-z0-9+.-]*:/i.test(t)) {
        throw new GuardError('BAD_HOST', 'This gate does not take an absolute URL as the request target. Use a path.', 421, { bare: true });
      }
      if (typeof t !== 'string' || t[0] !== '/' || t.startsWith('//') || t.includes('\\')) {
        throw new GuardError('BAD_PATH', 'The request path is not valid.', 400, { bare: true });
      }
    },

    // Any request that names an Origin must name an allowed one. "null", a malformed value and a list are all refused.
    checkOrigin(req) {
      const origin = req.headers.origin;
      if (origin !== undefined && !originOk(origin)) throw new GuardError('ORIGIN_NOT_ALLOWED', 'This origin is not allowed to use the gate.', 403);
    },

    checkContentType(req) {
      // Two Content-Type headers are refused too: Node keeps the first, another parser might keep the last.
      if (!NO_BODY_METHODS.has(req.method) && (!isJsonContentType(req.headers['content-type']) || countHeader(req, 'content-type') !== 1)) {
        throw new GuardError('UNSUPPORTED_MEDIA_TYPE', 'Send the request with Content-Type: application/json.', 415);
      }
    },

    // OPTIONS. Returns the headers for a 204, or throws. No Origin header means this is not a CORS preflight:
    // answer 204 with no CORS headers, so nothing is granted to anyone.
    preflight(req) {
      const origin = req.headers.origin;
      if (origin === undefined) return { vary: 'Origin', allow: 'GET, POST, OPTIONS' };
      if (!originOk(origin)) throw new GuardError('ORIGIN_NOT_ALLOWED', 'This origin is not allowed to use the gate.', 403);
      if (!PREFLIGHT_METHODS.includes(req.headers['access-control-request-method'])) {
        throw new GuardError('PREFLIGHT_REFUSED', `The gate allows ${PREFLIGHT_METHODS.join(' and ')} from a browser.`, 403, { noGrant: true });
      }
      const asked = req.headers['access-control-request-headers'];
      if (typeof asked === 'string') {
        for (const h of asked.split(',').map((x) => x.trim().toLowerCase())) {
          if (h !== '' && !PREFLIGHT_HEADERS.includes(h)) throw new GuardError('PREFLIGHT_REFUSED', 'That request header is not allowed.', 403, { noGrant: true });
        }
      }
      return {
        'access-control-allow-origin': origin, vary: 'Origin',
        'access-control-allow-methods': PREFLIGHT_METHODS.join(', '),
        'access-control-allow-headers': 'Content-Type, Authorization',
        'access-control-max-age': '600',
      };
    },

    // A route names the roles that may use it. If none of those roles has a token, the route is open (as before).
    // Otherwise the request needs `Authorization: Bearer <token>` matching the token of one of those roles.
    // The same 401 and message for a missing, malformed, wrong or too-long token: nothing says which.
    authorize(req, roles) {
      const active = roles.filter((r) => digests[r] !== null);
      if (active.length === 0) return;
      const refuse = () => new GuardError('UNAUTHORIZED', 'A valid bearer token is required.', 401, { headers: { 'www-authenticate': 'Bearer' } });
      // Two Authorization headers are refused: Node keeps the first, another parser might keep the last.
      if (countHeader(req, 'authorization') > 1) throw refuse();
      const m = /^Bearer +(\S+)$/i.exec(req.headers.authorization ?? '');
      let ok = false;
      for (const r of active) ok = tokenMatches(m ? m[1] : '', digests[r]) || ok; // no early exit between roles
      if (!ok || m === null) throw refuse();
    },
  };
}
