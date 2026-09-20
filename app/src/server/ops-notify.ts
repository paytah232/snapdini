import { get, all, run } from './db';
import * as email from './email';
// The one place a button is defined. `.btn` used to be a class in a <style> block that Outlook.com
// and the Gmail app both delete — see email-theme.ts.
import { button } from './email-theme';
import { describeUsage, monthUsage, type MonthUsage } from './email-budget';
import { escapeHtml } from './lib';
import { maskAddress } from './unsubscribe';
import { skipWriteSweep } from './readonly';

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

/** `subject` is RAW TEXT, like every other builder in this product.
 *
 *  THE SPLIT, and this is the third time this exact bug has been written here. htmlEmail() drops
 *  its first argument straight into an <h2>, so the subject was being pre-escaped by its callers
 *  to keep the heading safe — and the SAME escaped string then went out as the `Subject:` header,
 *  where a header is not HTML and nothing decodes it back. An event called "Priya & Tom" reached
 *  support@ as "Priya &amp;amp; Tom" (twice over, because `&` in `&amp;` escapes again).
 *
 *  So the escaping happens HERE, once, at the boundary where the two encodings part: the header
 *  gets the raw words, the heading gets the escaped ones. It is the same rule inline-emails.ts
 *  states at the top of the file — subject RAW, html ESCAPED, text RAW — and putting it in the one
 *  function every ops alert goes through means no future alert can get it wrong by being written. */
async function mail(subject: string, bodyHtml: string): Promise<void> {
  if (!support() || !email.enabled) return;
  // Addressed to our own support inbox, not to a member of the public — there is no one here to
  // have unsubscribed, and an ops alert that suppresses itself is an outage nobody hears about.
  try { await email.sendMail({ to: support(), subject, html: email.htmlEmail(escapeHtml(subject), bodyHtml), always: true }); }
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
  // ESCAPED, and this is the one place in the product where forgetting it mattered most: the
  // trigger is POST /api/survey/:token, which needs no session — only a token from an emailed link
  // — and the words land in the operator's own inbox, where a link is trusted precisely because
  // the mail came from us. htmlEmail() interpolates both title and body raw (every other caller
  // pre-escapes), so the escaping has to happen here. Mail clients strip <script>, so the realistic
  // damage is injected markup and a forged link rather than script — but anything that renders this
  // mail in a browser-like preview (a ticket queue, a webmail with a permissive sanitiser) closes
  // that gap for us.
  let comments = '';
  try {
    const c = r.comments ? JSON.parse(r.comments) as Record<string, string> : {};
    comments = Object.entries(c)
      .map(([k, v]) => `<p style="margin:6px 0"><b>${escapeHtml(k)}:</b> ${escapeHtml(v)}</p>`)
      .join('');
  } catch { /* */ }
  // The event name is host-supplied, 80 chars, unstripped, and settable on a free signup.
  const safeName = escapeHtml(ev.name);
  // RAW in the subject, escaped in the body — mail() escapes what it puts in the heading. Passing
  // safeName here is what put "Priya &amp;amp; Tom" in the operator's inbox.
  await mail(`⚠️ Unhappy feedback — ${ev.name}`, `
    <p>A guest left low feedback for <b>${safeName}</b> (<code>${escapeHtml(ev.joinCode)}</code>)${r.contactOptIn ? ' and <b>opted in to be contacted</b>.' : '.'}</p>
    <table style="border-collapse:collapse;margin:10px 0">${rows.join('')}</table>
    ${comments || '<p style="color:#a39b8c">(no written comments)</p>'}
    ${button('Open Site admin', `${BASE()}/siteadmin`)}
  `);
}

// ── Instant: a recovery that looks like a takeover ───────────────────────────
//
// POST /api/participants recovers a returning guest by their EMAIL ALONE. That is deliberate and
// stays (see the long note on the recovery branch in routes/participants.ts, pinned by
// specs/97-participant-email.mjs) — but a join code is printed on a venue sign, so code + address
// is enough to mint a session on somebody else's roll. The mitigation is not to change the
// matching, it is to make the abuse case SLOW (the per-address limiter in routes/participants.ts)
// and NOISY. This is the noisy half.
//
// The reported shape is narrow on purpose: a recovery that RENAMES a roll that ALREADY HAS PHOTOS.
//   · a guest coming back to a roll they have not shot yet — the ordinary case — says nothing;
//   · a guest retyping the same name says nothing;
//   · putting a DIFFERENT name on a roll that already holds someone's photos is the exact signature
//     of a takeover, and rare enough that alerting on it will not cry wolf.
// Nothing a guest sees changes either way.
export function isRiskyRecovery(prev: { name: string; photosTaken: number }, newName: string): boolean {
  return prev.photosTaken > 0 && newName !== prev.name;
}

export async function notifyRiskyRecovery(
  ev: { name: string; joinCode: string },
  r: { email: string; previousName: string; newName: string; photosTaken: number },
): Promise<void> {
  // MASKED with the same helper the HTTP responses and guest-delivery's failure lines use
  // (unsubscribe.maskAddress). An alert ABOUT an address is not a licence to write the address
  // into a log file or an inbox.
  const who = maskAddress(r.email);
  // Logged whether or not OPS_NOTIFICATIONS is on, and BEFORE the gate below: a self-hoster who
  // never set SUPPORT_EMAIL still deserves to be able to find this after the fact, and the log is
  // the only record if the mail fails. Same reasoning as the other single-line ops facts.
  console.warn(`[ops] risky recovery at ${ev.joinCode}: ${who} renamed a roll holding ${r.photosTaken} photo(s) — "${r.previousName}" → "${r.newName}"`);
  if (!enabled()) return;
  // escapeHtml on every one of these: htmlEmail() interpolates title and body raw (see the note in
  // notifyUnhappySurvey), the event name is host-supplied, and BOTH names here were typed by
  // whoever made the request — including the attacker, in the case this alert exists for.
  const safeName = escapeHtml(ev.name);
  await mail(`⚠️ Possible roll takeover — ${ev.name}`, `
    <p>A returning guest at <b>${safeName}</b> (<code>${escapeHtml(ev.joinCode)}</code>) recovered a roll
       that <b>already had ${r.photosTaken} photo(s)</b> on it and <b>changed the name</b> on it.</p>
    <table style="border-collapse:collapse;margin:10px 0">
      <tr><td style="padding:2px 12px 2px 0;color:#a39b8c">Address</td><td><b>${escapeHtml(who)}</b></td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#a39b8c">Name was</td><td><b>${escapeHtml(r.previousName)}</b></td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#a39b8c">Name now</td><td><b>${escapeHtml(r.newName)}</b></td></tr>
      <tr><td style="padding:2px 12px 2px 0;color:#a39b8c">Photos on the roll</td><td><b>${r.photosTaken}</b></td></tr>
    </table>
    <p style="color:#a39b8c;font-size:13px">Usually innocent — a shared inbox, or a guest who typed a
       different name on a new phone. It is worth a look because recovery is keyed on the address alone,
       so an event's join code plus a guest's address is enough to reach their roll.</p>
    ${button('Open Site admin', `${BASE()}/siteadmin`)}
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
    ${button('Review in Site admin', `${BASE()}/siteadmin`)}
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

  // The month's email allowance. Read before the silence check below, because running out of it is
  // exactly the kind of thing that happens on a quiet week — no support messages, no errors, and
  // the invites nobody complained about yet are the ones that stopped going out. A budget that
  // only ever reported when something ELSE was already wrong would miss its own emergency.
  let budget: MonthUsage | null = null;
  try { budget = await monthUsage(now); }
  catch (e) { console.error('[ops] email budget:', (e as Error).message); }

  // Nothing pending and no fresh feedback → stay silent (unless force-previewing, or the allowance
  // needs saying something about).
  const quiet = totalMsgs === 0 && openErr === 0 && newSurveys === 0 && (!budget || budget.level === 'ok');
  if (!force && quiet) { await setState('ops:last_digest_date', localDate(now)); await setState('ops:last_digest_at', String(now)); return; }

  const age = (ms: number) => { const d = Math.floor((now - ms) / 86_400_000); return d <= 0 ? 'today' : `${d}d ago`; };
  const msgLines = msgs.length
    ? msgs.map((m) => `<li><b>${Number(m.n)}</b> ${m.kind}${Number(m.n) > 1 ? 's' : ''} — oldest ${age(Number(m.oldest))}</li>`).join('')
    : '<li>None 🎉</li>';

  // The allowance leads the SUBJECT when it is in trouble: a line halfway down a digest is read
  // after the fact, and the whole point of this number is to be seen before the month runs out.
  const budgetFlag = budget && budget.level !== 'ok' ? `${budget.level === 'over' ? '🛑 email allowance SPENT' : '⚠️ email allowance low'} — ` : '';
  const budgetLine = budget
    ? `<p><b>Email allowance:</b> ${describeUsage(budget)}<br>
       <span style="color:#a39b8c;font-size:13px">Counts invites (${budget.invites}) and gallery/share sends (${budget.shares}).
       Account and lifecycle mail is not recorded per recipient, so treat this as a floor.</span></p>`
    : '<p><b>Email allowance:</b> could not be read this morning.</p>';

  await mail(`${budgetFlag}Snapdini daily summary — ${totalMsgs} to action${openErr ? `, ${openErr} open errors` : ''}`, `
    <p><b>Outstanding actions</b></p>
    <ul>${msgLines}</ul>
    <p><b>Open client errors:</b> ${openErr}</p>
    ${budgetLine}
    ${newSurveys ? `<p><b>New survey responses (24h):</b> ${newSurveys} · avg overall ${surv?.avg_overall ? Number(surv.avg_overall).toFixed(1) : '—'}/5 · avg NPS ${surv?.avg_nps ? Number(surv.avg_nps).toFixed(1) : '—'}${Number(surv?.low ?? 0) ? ` · <b>${surv?.low} unhappy</b>` : ''}</p>` : ''}
    <p><b>Events starting in the next 7 days:</b> ${upcoming}</p>
    ${button('Open Site admin', `${BASE()}/siteadmin`)}
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
  if (!skipWriteSweep('ops'))
    opsSweep().catch((e) => console.error('[ops] sweep error:', (e as Error).message));
  const timer = setInterval(() => {
    if (skipWriteSweep('ops')) return;
    void opsSweep().catch((e) => console.error('[ops] sweep error:', (e as Error).message));
  }, SWEEP_MS);
  timer.unref?.();
  console.log('[ops] operator notifications ENABLED (daily digest + instant alerts)');
}
