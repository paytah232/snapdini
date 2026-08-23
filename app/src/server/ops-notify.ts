import { get, all, run } from './db';
import * as email from './email';

// Operator (support@) notifications, separate from customer lifecycle emails. Two tiers:
//   • Instant alerts for things that need attention now (unhappy survey, client-error spike).
//   • A once-a-day digest of outstanding actions — sent ONLY when there's something pending.
// Contact/bug/feedback/refund already email support@ on submission (see routes/contact.ts).
// Everything here is gated by OPS_NOTIFICATIONS=1 and needs SUPPORT_EMAIL + an email transport.

const SWEEP_MS = 15 * 60 * 1000;
const TZ = process.env.OPS_TZ || 'Australia/Brisbane';
const DIGEST_HOUR = parseInt(process.env.OPS_DIGEST_HOUR || '8', 10);          // local hour to send the daily digest
const SPIKE_THRESHOLD = parseInt(process.env.OPS_ERROR_SPIKE || '20', 10);     // client errors in the last hour = a spike
const SPIKE_COOLDOWN_MS = 3 * 60 * 60 * 1000;                                   // at most one spike alert per 3h

const enabled = () => process.env.OPS_NOTIFICATIONS === '1';
const support = () => process.env.SUPPORT_EMAIL || '';
const BASE = () => (process.env.BASE_URL || 'https://snapdini.com').replace(/\/$/, '');

async function getState(key: string): Promise<string | null> {
  const r = await get<{ value: string }>(`SELECT value FROM app_state WHERE key = ?`, [key]);
  return r?.value ?? null;
}
async function setState(key: string, value: string): Promise<void> {
  await run(`INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, Date.now()]);
}

async function mail(subject: string, bodyHtml: string): Promise<void> {
  if (!support() || !email.enabled) return;
  try { await email.sendMail({ to: support(), subject, html: email.htmlEmail(subject, bodyHtml) }); }
  catch (e) { console.error('[ops] mail failed:', (e as Error).message); }
}

const localDate = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(ms)); // YYYY-MM-DD
const localHour = (ms: number) => parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date(ms)), 10);

// ── Instant: unhappy survey ──────────────────────────────────────────────────
// Called from the survey POST when a response is low (overall ≤2 of 5, or NPS ≤6 = a detractor).
export function isUnhappy(overall: number | null, nps: number | null): boolean {
  return (overall !== null && overall <= 2) || (nps !== null && nps <= 6);
}
export async function notifyUnhappySurvey(
  ev: { name: string; joinCode: string },
  r: { overall: number | null; setup: number | null; guestExperience: number | null; value: number | null; nps: number | null; comments: string | null; contactOptIn: boolean },
): Promise<void> {
  if (!enabled()) return;
  const rows: string[] = [];
  const line = (k: string, v: number | null) => { if (v !== null) rows.push(`<tr><td style="padding:2px 12px 2px 0;color:#a39b8c">${k}</td><td><b>${v}</b></td></tr>`); };
  line('Overall (1–5)', r.overall); line('Setup (1–5)', r.setup); line('Guest experience (1–5)', r.guestExperience);
  line('Value (1–5)', r.value); line('NPS (0–10)', r.nps);
  let comments = '';
  try { const c = r.comments ? JSON.parse(r.comments) as Record<string, string> : {}; comments = Object.entries(c).map(([k, v]) => `<p style="margin:6px 0"><b>${k}:</b> ${String(v)}</p>`).join(''); } catch { /* */ }
  await mail(`⚠️ Unhappy feedback — ${ev.name}`, `
    <p>A guest left low feedback for <b>${ev.name}</b> (<code>${ev.joinCode}</code>)${r.contactOptIn ? ' and <b>opted in to be contacted</b>.' : '.'}</p>
    <table style="border-collapse:collapse;margin:10px 0">${rows.join('')}</table>
    ${comments || '<p style="color:#a39b8c">(no written comments)</p>'}
    <p style="margin-top:16px"><a class="btn" href="${BASE()}/siteadmin">Open Site admin</a></p>
  `);
}

// ── The ops sweep: client-error spike + daily digest ─────────────────────────
async function spikeCheck(now: number): Promise<void> {
  const r = await get<{ n: number }>(`SELECT count(*) AS n FROM client_errors WHERE created_at > ?`, [now - 60 * 60 * 1000]);
  const n = Number(r?.n ?? 0);
  if (n < SPIKE_THRESHOLD) return;
  const last = parseInt((await getState('ops:last_spike_at')) || '0', 10);
  if (now - last < SPIKE_COOLDOWN_MS) return;
  await setState('ops:last_spike_at', String(now));
  await mail(`🚨 Client-error spike — ${n} in the last hour`, `
    <p><b>${n}</b> client-side errors were reported in the last hour (threshold ${SPIKE_THRESHOLD}). Something may be broken in the field.</p>
    <p style="margin-top:16px"><a class="btn" href="${BASE()}/siteadmin">Review in Site admin</a></p>
  `);
}

async function dailyDigest(now: number): Promise<void> {
  if (localHour(now) < DIGEST_HOUR) return;                 // not yet the digest hour today
  if ((await getState('ops:last_digest_date')) === localDate(now)) return; // already sent today
  await composeAndSendDigest(now, false);
}

// Force-send a digest now (ignores time-of-day + already-sent, doesn't touch state) — for previews.
export async function sendDigestPreview(): Promise<void> { await composeAndSendDigest(Date.now(), true); }

async function composeAndSendDigest(now: number, force: boolean): Promise<void> {
  const since = parseInt((await getState('ops:last_digest_at')) || String(now - 86_400_000), 10);
  const msgs = await all<{ kind: string; n: number; oldest: number }>(
    `SELECT kind, count(*) AS n, min(created_at) AS oldest FROM contact_messages WHERE NOT handled GROUP BY kind`);
  const openErr = Number((await get<{ n: number }>(`SELECT count(*) AS n FROM client_errors WHERE NOT handled`))?.n ?? 0);
  const surv = await get<{ n: number; avg_overall: number | null; avg_nps: number | null; low: number }>(
    `SELECT count(*) AS n, avg(overall) AS avg_overall, avg(nps) AS avg_nps,
            sum(CASE WHEN overall <= 2 THEN 1 ELSE 0 END) AS low
       FROM survey_responses WHERE created_at > ?`, [since]);
  const upcoming = Number((await get<{ n: number }>(
    `SELECT count(*) AS n FROM events WHERE owner_user_id IS NOT NULL AND starts_at BETWEEN ? AND ?`, [now, now + 7 * 86_400_000]))?.n ?? 0);

  const totalMsgs = msgs.reduce((s, m) => s + Number(m.n), 0);
  const newSurveys = Number(surv?.n ?? 0);
  // Nothing pending and no fresh feedback → stay silent (unless force-previewing).
  if (!force && totalMsgs === 0 && openErr === 0 && newSurveys === 0) { await setState('ops:last_digest_date', localDate(now)); await setState('ops:last_digest_at', String(now)); return; }

  const age = (ms: number) => { const d = Math.floor((now - ms) / 86_400_000); return d <= 0 ? 'today' : `${d}d ago`; };
  const msgLines = msgs.length
    ? msgs.map((m) => `<li><b>${Number(m.n)}</b> ${m.kind}${Number(m.n) > 1 ? 's' : ''} — oldest ${age(Number(m.oldest))}</li>`).join('')
    : '<li>None 🎉</li>';

  await mail(`Snapdini daily summary — ${totalMsgs} to action${openErr ? `, ${openErr} open errors` : ''}`, `
    <p><b>Outstanding actions</b></p>
    <ul>${msgLines}</ul>
    <p><b>Open client errors:</b> ${openErr}</p>
    ${newSurveys ? `<p><b>New survey responses (24h):</b> ${newSurveys} · avg overall ${surv?.avg_overall ? Number(surv.avg_overall).toFixed(1) : '—'}/5 · avg NPS ${surv?.avg_nps ? Number(surv.avg_nps).toFixed(1) : '—'}${Number(surv?.low ?? 0) ? ` · <b>${surv?.low} unhappy</b>` : ''}</p>` : ''}
    <p><b>Events starting in the next 7 days:</b> ${upcoming}</p>
    <p style="margin-top:16px"><a class="btn" href="${BASE()}/siteadmin">Open Site admin</a></p>
  `);
  if (!force) { await setState('ops:last_digest_date', localDate(now)); await setState('ops:last_digest_at', String(now)); }
}

async function opsSweep(): Promise<void> {
  if (!enabled() || !email.enabled || !support()) return;
  const now = Date.now();
  try { await spikeCheck(now); } catch (e) { console.error('[ops] spike check:', (e as Error).message); }
  try { await dailyDigest(now); } catch (e) { console.error('[ops] digest:', (e as Error).message); }
}

export function startOps(): void {
  if (!enabled()) { console.log('[ops] operator notifications disabled (set OPS_NOTIFICATIONS=1 to enable)'); return; }
  if (!support()) { console.warn('[ops] OPS_NOTIFICATIONS on but SUPPORT_EMAIL unset — no digests will send'); }
  opsSweep().catch((e) => console.error('[ops] sweep error:', (e as Error).message));
  const timer = setInterval(() => opsSweep().catch((e) => console.error('[ops] sweep error:', (e as Error).message)), SWEEP_MS);
  timer.unref?.();
  console.log('[ops] operator notifications ENABLED (daily digest + instant alerts)');
}
