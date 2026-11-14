const BASE = import.meta.env.VITE_GATE_URL ?? 'http://127.0.0.1:8787';

export type Reason = { code: string; text: string };
export type Intent = {
  id: string;
  state: string;
  createdAt: number;
  expiresAt: number;
  input: { end_to_end_id: string; destination: string; amountXrp: number; destinationTag?: number; risk?: string; health?: string; note?: string };
  decision: { outcome: 'auto' | 'approval' | 'block'; reasons: Reason[] };
  approver: string | null;
  tx: Record<string, unknown> | null;
  txHash: string | null;
  engineResult: string | null;
  error: string | null;
  history: { at: number; state: string; note: string }[];
};

// The approver token, only if the gate asks for one (GATE_APPROVER_TOKEN). It lives in this tab's sessionStorage and
// nowhere else (never localStorage, never in a URL). If the browser blocks storage it is held in memory for the page.
const TOKEN_KEY = 'gate.approverToken';
let memoryToken = '';
export const tokenStore = {
  get(): string {
    try { return sessionStorage.getItem(TOKEN_KEY) ?? memoryToken; } catch { return memoryToken; }
  },
  set(token: string) {
    memoryToken = token;
    try { if (token) sessionStorage.setItem(TOKEN_KEY, token); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage blocked: memory only */ }
  },
};

// The gate answered 401: it wants an approver token, or did not accept the one sent.
export class GateAuthError extends Error {}

// `auth: false` is for the two routes the gate leaves open, so a token is not sent where it is not needed.
async function call<T>(path: string, init?: RequestInit, auth = true): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = auth ? tokenStore.get() : '';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new GateAuthError(body.message ?? 'The gate wants a valid token.');
  if (!res.ok) throw new Error(body.message ?? `${res.status} ${res.statusText}`);
  return body as T;
}
const post = (path: string, body: unknown = {}) => call<any>(path, { method: 'POST', body: JSON.stringify(body) });

export const api = {
  health: () => call<{ ok: boolean; approver: string | null; approverToken?: boolean; demo: { ready: boolean; error: string | null; merchant: string | null } }>('/health', undefined, false),
  policy: () => call<{ perTxCapXrp: number; dailyCapXrp: number; travelRuleUsd: number }>('/policy', undefined, false),
  list: () => call<Intent[]>('/intents'),
  seed: () => post('/demo/seed'),
  approve: (id: string, address: string, publicKey: string) => post(`/intents/${encodeURIComponent(id)}/approve`, { address, publicKey }) as Promise<{ tx: Record<string, unknown>; txHex: string }>,
  signature: (id: string, signature: string) => post(`/intents/${encodeURIComponent(id)}/signature`, { signature }) as Promise<Intent>,
  reject: (id: string, reason: string) => post(`/intents/${encodeURIComponent(id)}/reject`, { reason }) as Promise<Intent>,
};
