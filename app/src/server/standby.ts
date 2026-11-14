import crypto from 'node:crypto';
import { get, run } from './db';

// ── Failover standby: the operator's view, and the one action it allows ─────────────────────────
//
// THE APP NEVER TOUCHES THE STANDBY. It has no SSH key, no Docker socket and no idea where the
// standby lives, and it must stay that way: a web process that can rebuild a database server is one
// request-forgery bug away from doing it for somebody else. Everything here is two rows in
// app_state, and the authority lives on the host:
//
//   standby_status           written by a host-side runner (cron, outside this repo) every minute:
//                            its own health checks plus whether a rebuild is currently allowed.
//   standby_rebuild_request  written HERE when a site admin asks for a rebuild; the runner claims
//                            it, re-checks every gate itself, runs its vetted script and writes the
//                            progress back into the same row.
//
// So the button is a REQUEST, not a command. The runner re-decides from live state and may refuse,
// which is why the gates below are a courtesy (a fast, explained "no") and not the safety: a stale
// page, a second tab or a forged request can at most ask for something the runner then declines.
//
// Self-hosters without a standby simply never get a status row, and the panel says so.

export const STATUS_KEY = 'standby_status';
export const REQUEST_KEY = 'standby_rebuild_request';
/** The runner reports every minute. Ten silent minutes means it is not running, and a button that
 *  queues work for a worker nobody is running is a button that lies. */
export const STALE_MS = 10 * 60 * 1000;
/** Typed, not clicked: this throws away the standby's database and re-clones it. */
export const CONFIRM_WORD = 'REBUILD';

export interface StandbyCheck { name: string; ok: boolean; detail: string }
export interface StandbyStatus {
  checkedAt: number;
  healthy: boolean;
  summary: string;
  checks: StandbyCheck[];
  canRebuild: boolean;
  blockReason: string | null;
}
export type RequestState = 'requested' | 'running' | 'done' | 'failed' | 'refused';
export interface RebuildRequest {
  id: string;
  state: RequestState;
  requestedBy: string;
  requestedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  steps: { at: number; msg: string }[];
  error: string | null;
}

const STATES: RequestState[] = ['requested', 'running', 'done', 'failed', 'refused'];
const ACTIVE: RequestState[] = ['requested', 'running'];
const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The runner is a shell script writing JSON; read it as untrusted. A malformed row renders as
 *  "no status" rather than taking the console down, and nothing in it is ever treated as markup. */
export function parseStatus(raw: string | null | undefined): StandbyStatus | null {
  if (!raw) return null;
  let o: any;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const checkedAt = num(o.checkedAt);
  if (checkedAt == null) return null;
  const checks = Array.isArray(o.checks) ? o.checks.slice(0, 30).map((c: any) => ({
    name: str(c?.name, 80), ok: c?.ok === true, detail: str(c?.detail, 300),
  })).filter((c: StandbyCheck) => c.name) : [];
  return {
    checkedAt,
    healthy: o.healthy === true,
    summary: str(o.summary, 300),
    checks,
    canRebuild: o.canRebuild === true,
    blockReason: str(o.blockReason, 300) || null,
  };
}

export function parseRequest(raw: string | null | undefined): RebuildRequest | null {
  if (!raw) return null;
  let o: any;
  try { o = JSON.parse(raw); } catch { return null; }
  if (!o || typeof o !== 'object' || !STATES.includes(o.state) || !str(o.id)) return null;
  return {
    id: str(o.id, 64),
    state: o.state,
    requestedBy: str(o.requestedBy, 200),
    requestedAt: num(o.requestedAt) ?? 0,
    startedAt: num(o.startedAt),
    finishedAt: num(o.finishedAt),
    steps: Array.isArray(o.steps) ? o.steps.slice(-60).map((s: any) => ({ at: num(s?.at) ?? 0, msg: str(s?.msg, 300) })) : [],
    error: str(o.error, 500) || null,
  };
}

export type Decision = { ok: true } | { ok: false; status: number; error: string };

/** May a rebuild be requested right now? Pure, so every refusal is tested without a database. */
export function rebuildDecision(status: StandbyStatus | null, request: RebuildRequest | null, now: number): Decision {
  if (!status) return { ok: false, status: 409, error: 'No standby runner is reporting, so there is nothing to ask.' };
  const age = now - status.checkedAt;
  if (age > STALE_MS) {
    return { ok: false, status: 409, error: `The standby runner last reported ${Math.round(age / 60000)} minutes ago — it is not running, so a request would never be picked up.` };
  }
  if (request && ACTIVE.includes(request.state)) {
    return { ok: false, status: 409, error: `A rebuild is already ${request.state}.` };
  }
  if (!status.canRebuild) {
    return { ok: false, status: 409, error: status.blockReason || 'The runner reports that a rebuild is not allowed right now.' };
  }
  return { ok: true };
}

async function read(key: string): Promise<string | null> {
  const r = await get<{ value: string }>(`SELECT value FROM app_state WHERE key = ?`, [key]);
  return r?.value ?? null;
}

export async function standbyView() {
  const [status, request] = await Promise.all([read(STATUS_KEY), read(REQUEST_KEY)]);
  return { status: parseStatus(status), request: parseRequest(request), staleAfterMs: STALE_MS, confirmWord: CONFIRM_WORD };
}

/** Record a request. Returns the decision; on success the request row. */
export async function requestRebuild(by: string, now = Date.now()): Promise<Decision & { request?: RebuildRequest }> {
  const view = await standbyView();
  const d = rebuildDecision(view.status, view.request, now);
  if (!d.ok) return d;
  const request: RebuildRequest = {
    id: crypto.randomUUID(), state: 'requested', requestedBy: by, requestedAt: now,
    startedAt: null, finishedAt: null, steps: [{ at: now, msg: `requested by ${by}` }], error: null,
  };
  // Two tabs pressing at once: the upsert only replaces a row that is NOT active, and the read-back
  // tells the loser it lost instead of both believing they queued the one rebuild. A regex, not a
  // ::jsonb cast: the row is written by a shell script, and a cast would turn one malformed row into
  // a 500 on the only button that fixes things.
  await run(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
     WHERE app_state.value !~ '"state"\\s*:\\s*"(requested|running)"'`,
    [REQUEST_KEY, JSON.stringify(request), now]);
  const stored = parseRequest(await read(REQUEST_KEY));
  if (stored?.id !== request.id) return { ok: false, status: 409, error: 'Another rebuild request got there first.' };
  return { ok: true, request };
}
