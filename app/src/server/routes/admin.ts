import { Router, type Request, type Response } from 'express';
import path from 'path';
import { requireAdmin } from '../auth';
import { get, all, run } from '../db';
import { billingEnabled, stripe, CURRENCY } from '../billing';
import { sweep } from '../cleanup';
import { UPLOADS_DIR } from '../paths';
import { DEMO_NAME } from '../lib';

// ── Site-admin API ────────────────────────────────────────────────────────────
// Every route is gated by requireAdmin (signed-in user with the is_admin flag).
// Admins are bootstrapped from ADMIN_EMAIL/ADMIN_PASSWORD (see auth.ensureAdminFromEnv);
// self-host default is no admin at all. Promo-code management is mounted here too.
const router = Router();
router.use(requireAdmin);


// ── Listing helpers ───────────────────────────────────────────────────────────
// These lists were fixed LIMITs with the page filtering whatever happened to arrive. That works
// until the table outgrows the cap, at which point rows stop existing as far as the operator is
// concerned — silently, which is the bad part. Every list below takes paging + a search term and
// returns a total, so the page can always say "showing 50 of 4,312" rather than quietly lying.
const MAX_PAGE = 200;
type Listing = { limit: number; offset: number; q: string };
const listing = (req: Request, def = 50): Listing => ({
  limit:  Math.min(MAX_PAGE, Math.max(1, Number(req.query.limit) || def)),
  offset: Math.max(0, Number(req.query.offset) || 0),
  q:      String(req.query.q || '').trim().slice(0, 120),
});
/** A case-insensitive LIKE across several columns, as a (sql, params) fragment. */
const searchClause = (q: string, cols: string[]): { sql: string; params: string[] } =>
  !q ? { sql: '', params: [] }
     : { sql: ' AND (' + cols.map((c) => `${c} ILIKE ?`).join(' OR ') + ')', params: cols.map(() => `%${q}%`) };
const countOf = async (sql: string, params: unknown[]): Promise<number> =>
  Number((await get<{ n: number }>(`SELECT count(*) AS n FROM (${sql}) t`, params))?.n || 0);

// Instance overview — headline counts for the dashboard.
router.get('/overview', async (_req: Request, res: Response) => {
  const now = Date.now();
  const stats = await get(
    `SELECT
       (SELECT count(*) FROM users)                          AS users,
       (SELECT count(*) FROM users WHERE is_admin)           AS admins,
       -- Demo events are created unauthenticated (owner_user_id IS NULL) and are flagged paid=true
       -- with amount_paid_cents = 0 so they bypass billing. Counting them as "paid" reported 21
       -- demos alongside 2 real sales. Real events and demos are now counted separately, and
       -- "paid" means money was actually taken.
       (SELECT count(*) FROM events WHERE owner_user_id IS NOT NULL)  AS events,
       (SELECT count(*) FROM events WHERE owner_user_id IS NULL)      AS demo_events,
       (SELECT count(*) FROM events
         WHERE amount_paid_cents > 0 AND refunded_at IS NULL)         AS paid_events,
       (SELECT count(*) FROM events
         WHERE expires_at > ? AND owner_user_id IS NOT NULL)          AS active_events,
       (SELECT count(*) FROM participants)                   AS participants,
       (SELECT count(*) FROM photos)                         AS photos,
       (SELECT count(*) FROM photos WHERE media_type = 'video')       AS videos,
       -- How often guests actually exceed the seconds they paid for. Over-length clips are KEPT
       -- (see photos.ts), so this is the number that says whether the leniency costs anything and
       -- whether the seconds ladder is worth enforcing at all.
       (SELECT count(*) FROM photos p JOIN events e ON e.id = p.event_id
         WHERE p.media_type = 'video' AND e.video_seconds > 0
           AND p.duration_ms > (e.video_seconds + 3) * 1000)          AS videos_over_limit,
       -- Split by source, because the two mean opposite things. An over-length clip from the CAMERA
       -- ROLL is the feature working: a guest shot it outside the app and we kept it. The same
       -- overage from in-app CAPTURE is a defect — the recorder was supposed to stop itself — and is
       -- the number to actually chase.
       (SELECT count(*) FROM photos p JOIN events e ON e.id = p.event_id
         WHERE p.media_type = 'video' AND e.video_seconds > 0 AND p.source = 'capture'
           AND p.duration_ms > (e.video_seconds + 3) * 1000)          AS capture_overshoots`,
    [now],
  );
  // The detail behind videos_over_limit: which event, what they paid for, what they actually sent.
  const videoOverages = await all(
    `SELECT e.join_code, e.name, e.video_seconds AS purchased_secs, p.source,
            round(p.duration_ms / 1000.0)  AS actual_secs,
            round((p.duration_ms / 1000.0) - e.video_seconds) AS over_by_secs,
            p.taken_at
       FROM photos p JOIN events e ON e.id = p.event_id
      WHERE p.media_type = 'video' AND e.video_seconds > 0
        AND p.duration_ms > (e.video_seconds + 3) * 1000
      ORDER BY p.taken_at DESC, p.id
      LIMIT 20`);
  res.json({ stats, videoOverages, now });
});

// ── GET /api/admin/referral-funnel ────────────────────────────────────────────
// The whole point of the referral work: does a guest who came from someone else's gallery actually
// run an event? Codes-redeemed is a vanity metric; the step that matters is signup → event created,
// because that is exactly where paid traffic dies.
router.get('/referral-funnel', async (_req: Request, res: Response) => {
  const totals = await get<Record<string, number>>(
    `SELECT
       (SELECT COALESCE(sum(gallery_views), 0)   FROM events)                             AS gallery_views,
       (SELECT COALESCE(sum(referral_clicks), 0) FROM events)                             AS referral_clicks,
       (SELECT count(*) FROM users  WHERE referred_by_event_id IS NOT NULL)               AS referred_signups,
       (SELECT count(*) FROM events WHERE referred_by_event_id IS NOT NULL)               AS referred_events,
       (SELECT count(*) FROM events WHERE referred_by_event_id IS NOT NULL
                                     AND amount_paid_cents > 0 AND refunded_at IS NULL)   AS referred_paid,
       (SELECT COALESCE(sum(amount_paid_cents), 0) FROM events
         WHERE referred_by_event_id IS NOT NULL AND refunded_at IS NULL)                  AS referred_cents`);

  // Which galleries are actually generating anything, so the operator knows where it works.
  const sources = await all(
    `SELECT e.join_code, e.name, e.gallery_views, e.referral_clicks,
            (SELECT count(*) FROM users  u WHERE u.referred_by_event_id = e.id) AS signups,
            (SELECT count(*) FROM events c WHERE c.referred_by_event_id = e.id) AS events_created
       FROM events e
      WHERE e.gallery_views > 0 OR e.referral_clicks > 0
      ORDER BY e.referral_clicks DESC, e.gallery_views DESC, e.id
      LIMIT 50`);

  // Engagement, so "did anyone look at the photos" is answerable without a separate tool.
  const engagement = await get<Record<string, number>>(
    `SELECT COALESCE(sum(view_count),0) AS photo_views, COALESCE(sum(download_count),0) AS photo_downloads
       FROM photos`);

  res.json({ totals, sources, engagement });
});

// ── GET /api/admin/actions — what the operator changed on other people's events ──
//
// The read side of admin_actions (0068). Site-admin only, like everything on this router, and that
// gate is the whole of the access control: the entries quote customers' event names, guest email
// addresses and the words people wrote under photos, because that is what makes them actionable.
//
// NEWEST FIRST, with `id` as the final key. `at` is milliseconds and an operator flipping three
// switches in one second gives Postgres a tie it may break differently per query — which under
// LIMIT/OFFSET means consecutive pages OVERLAP, showing one row twice and another never. That is
// not hypothetical here: it was demonstrated on the users listing above and fixed the same way.
//
// NO N+1, and no joins for the body of the row either. Who did it and which event it was are
// columns on the entry itself, captured when it happened — see the denormalisation note in the
// migration. The one join is a LEFT JOIN to events, purely so the page can tell a live event
// (drill into it) from one that has since been deleted (there is nowhere to go).
router.get('/actions', async (req: Request, res: Response) => {
  const { limit, offset, q } = listing(req, 50);
  const eventId = String(req.query.eventId || '').trim();

  let where = ' WHERE 1=1';
  const params: unknown[] = [];
  // The second of the two indexed reads. Matched on the recorded id rather than the join code, so
  // an event renamed or re-slugged since still returns its own history.
  if (eventId) { where += ' AND a.event_id = ?'; params.push(eventId); }
  const search = searchClause(q, ['a.admin_email', 'a.event_name', 'a.event_join_code', 'a.action']);
  where += search.sql; params.push(...search.params);

  const base =
    `SELECT a.id, a.at, a.admin_user_id AS "adminUserId", a.admin_email AS "adminEmail",
            a.admin_name AS "adminName", a.event_id AS "eventId", a.event_name AS "eventName",
            a.event_join_code AS "eventJoinCode", a.action,
            a.target_type AS "targetType", a.target_id AS "targetId",
            a.before_value AS "before", a.after_value AS "after",
            (e.id IS NOT NULL) AS "eventExists"
       FROM admin_actions a
       LEFT JOIN events e ON e.id = a.event_id` + where;

  const total = await countOf(base, params);
  const actions = await all(`${base} ORDER BY a.at DESC, a.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({ actions, total, limit, offset });
});

// Recent events (newest first).
// Events. `kind` exists because demo rolls are the majority of rows on a live instance and none of
// them are anybody's event — leaving them in "All" buries the real ones. There is no is_demo
// column: a demo is the demo name with NO owner, so it is derived here from the same definition
// the public event route uses.
router.get('/events', async (req: Request, res: Response) => {
  const kind = String(req.query.kind || 'real');   // real | demo | all
  const demoExpr = '(e.owner_user_id IS NULL AND e.name = ?)';
  // Placeholders are positional, so this list must follow the order the ?s appear in the SQL
  // below: the CTE's WHERE first, then the is_demo expression in the outer SELECT.
  const whereParams: unknown[] = [];
  let where = ' WHERE 1=1';
  if (kind === 'real') { where += ` AND NOT ${demoExpr}`; whereParams.push(DEMO_NAME); }
  if (kind === 'demo') { where += ` AND ${demoExpr}`;     whereParams.push(DEMO_NAME); }

  // Pick the PAGE first, then count only those rows. The previous shape hash-aggregated every
  // participant and every photo on the instance before applying LIMIT 200 — measured at 327ms on
  // 50k events / 400k photos. Selecting 200 events first and counting each by index takes 2.4ms,
  // because the counts become 200 index-only lookups instead of two full aggregates. The ordering
  // index is 0036.
  const events = await all(
    `WITH page AS (
       SELECT e.id, e.join_code, e.slug, e.name, e.guest_cap, e.video_seconds, e.paid,
              e.amount_paid_cents, e.refunded_at, e.organizer_code, e.purged_at, e.purge_at,
              e.starts_at, e.expires_at, e.created_at, e.owner_user_id,
              -- What the host actually set up. Scalars only, plus DERIVED flags for the text
              -- columns holding serialised blobs: challenges is a whole prompt pack, theme and
              -- poster_config are designs, and 200 of any of them would be most of the response
              -- for something the row only needs a yes/no from.
              -- (No backticks in here: this SQL lives inside a JS template literal.)
              e.max_photos, e.event_type, e.reveal_mode, e.reveal_delay_hours, e.moderation_enabled,
              e.allow_downloads, e.hearts_enabled, e.comments_enabled, e.gallery_hearts_enabled,
              e.gallery_comments_enabled, e.face_matching_enabled, e.aspect_ratios, e.rating_mode,
              e.no_flash, e.retention_days, e.branding_removal_paid, e.timezone,
              e.guest_may_buy_shots, e.guest_may_buy_video, e.guest_may_buy_frames, e.guest_may_request,
              (e.challenges IS NOT NULL AND e.challenges <> '') AS has_challenges,
              (e.theme IS NOT NULL AND e.theme <> '') AS has_theme,
              (e.poster_config IS NOT NULL AND e.poster_config <> '') AS has_poster,
              (e.blurb IS NOT NULL AND e.blurb <> '') AS has_blurb
         FROM events e${where}
        ORDER BY e.created_at DESC, e.id
        LIMIT 200)
     SELECT p.id, p.join_code, p.slug, p.name, p.guest_cap, p.video_seconds, p.paid,
            (p.owner_user_id IS NULL AND p.name = ?) AS is_demo,
            p.amount_paid_cents, p.refunded_at, p.organizer_code, p.purged_at, p.purge_at,
            p.starts_at, p.expires_at, p.created_at,
            p.max_photos, p.event_type, p.reveal_mode, p.reveal_delay_hours, p.moderation_enabled,
            p.allow_downloads, p.hearts_enabled, p.comments_enabled, p.gallery_hearts_enabled,
            p.gallery_comments_enabled, p.face_matching_enabled, p.aspect_ratios, p.rating_mode,
            p.no_flash, p.retention_days, p.branding_removal_paid, p.timezone,
            p.guest_may_buy_shots, p.guest_may_buy_video, p.guest_may_buy_frames, p.guest_may_request,
            p.has_challenges, p.has_theme, p.has_poster, p.has_blurb,
            (SELECT count(*) FROM participants x WHERE x.event_id = p.id) AS participants,
            (SELECT count(*) FROM photos       x WHERE x.event_id = p.id) AS photos,
            u.email AS owner
       FROM page p
       LEFT JOIN users u ON u.id = p.owner_user_id
      ORDER BY p.created_at DESC, p.id`, [...whereParams, DEMO_NAME]);

  // Tab counts, so the page can label them without fetching every row.
  const tallies = await get<{ real: number; demo: number }>(
    `SELECT count(*) FILTER (WHERE NOT ${demoExpr}) AS real,
            count(*) FILTER (WHERE ${demoExpr})     AS demo
       FROM events e`, [DEMO_NAME, DEMO_NAME]);
  res.json({ events, counts: { real: Number(tallies?.real || 0), demo: Number(tallies?.demo || 0) } });
});

// Users, paginated and filterable. `status` and `has` exist because "who signed up but never
// verified" and "who verified but never ran an event" are the two questions this list is actually
// for — the funnel drop-offs — and scrolling for them stops working almost immediately.
router.get('/users', async (req: Request, res: Response) => {
  const { limit, offset, q } = listing(req, 50);
  const status = String(req.query.status || 'all');   // all | verified | unverified | admin
  const has    = String(req.query.has || 'all');      // all | events | none

  let where = ' WHERE 1=1';
  const params: unknown[] = [];
  const search = searchClause(q, ['u.email', 'COALESCE(u.display_name, \'\')']);
  where += search.sql; params.push(...search.params);
  if (status === 'verified')   where += ' AND u.email_verified_at IS NOT NULL';
  if (status === 'unverified') where += ' AND u.email_verified_at IS NULL';
  if (status === 'admin')      where += ' AND u.is_admin = true';
  if (has === 'events') where += ' AND COALESCE(ec.n, 0) > 0';
  if (has === 'none')   where += ' AND COALESCE(ec.n, 0) = 0';

  const base =
    `SELECT u.id, u.email, u.display_name, u.plan, u.is_admin, u.email_verified_at, u.created_at,
            COALESCE(ec.n, 0) AS events
       FROM users u
       LEFT JOIN (SELECT owner_user_id, count(*) AS n FROM events WHERE owner_user_id IS NOT NULL GROUP BY owner_user_id) ec
              ON ec.owner_user_id = u.id` + where;

  const total = await countOf(base, params);
  // A paged ORDER BY needs a UNIQUE final key. `created_at` is not one — two signups in the same
  // millisecond, or any bulk insert, give Postgres a tie it may break differently per query. With
  // LIMIT/OFFSET that means consecutive pages OVERLAP: a row appears twice and another is never
  // shown at all. Demonstrated on this endpoint — page 1 gave [A, B] and page 2 gave [A, C], so B
  // simply stopped existing as far as the operator was concerned. Same defect the guest list had.
  const users = await all(`${base} ORDER BY u.created_at DESC, u.id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({ users, total, limit, offset });
});

// Contact-form messages (DB-backed mailbox). Unhandled first, newest first.
router.get('/contact', async (_req: Request, res: Response) => {
  const messages = await all(
    `SELECT id, name, email, message, kind, image_filename AS "imageFilename", emailed, handled, created_at
       FROM contact_messages ORDER BY handled ASC, created_at DESC, id LIMIT 200`);
  const unhandled = await get<{ n: number }>(`SELECT count(*) AS n FROM contact_messages WHERE NOT handled`);
  res.json({ messages, unhandled: Number(unhandled?.n ?? 0) });
});

// Admin-gated view of a feedback screenshot (kept out of the public /uploads tree).
router.get('/feedback-image/:file', (req: Request, res: Response) => {
  const file = String(req.params.file || '');
  if (!/^[A-Za-z0-9_-]+\.jpg$/.test(file)) return res.status(400).end();
  return res.sendFile(path.join(UPLOADS_DIR, 'feedback', file));
});
router.post('/contact/:id/handled', async (req: Request, res: Response) => {
  await run(`UPDATE contact_messages SET handled = NOT handled WHERE id = ?`, [String(req.params.id)]);
  res.json({ ok: true });
});

// ── Client-side error reports (diagnostic) ───────────────────────────────────
//
// GROUPED, which is the entire point of this endpoint and was the entire problem with the one it
// replaces. Fifty production rows returned newest-first were eleven distinct problems: twelve
// consecutive lines of one camera permission failure, eight of the next, and the six upload
// failures that may have cost a guest their photos pushed below them. A list nobody finishes
// reading is not a shorter list, it is no list — so the unit here is a PROBLEM, and the
// occurrences hang off it.

/** One report, as the console shows it inside an opened group. */
export interface ClientErrorOccurrence {
  key: string; id: string; message: string; context: string | null;
  eventCode: string | null; url: string | null; userAgent: string | null;
  stack: string | null; participantId: string | null; participantName: string | null;
  appVersion: string | null; clientBuild: string | null; displayMode: string | null;
  viewport: string | null; connection: string | null; outcome: string | null;
  handled: boolean; at: number;
}

/** The tallies, straight off the aggregate — counted over the WHOLE table, not over the sample of
 *  occurrences below. That distinction is the reason these come from SQL rather than from
 *  counting the rows we happened to fetch: a count that silently means "of the last 300" answers
 *  "is this still happening" with a number that stops growing. */
export interface ClientErrorSummary {
  key: string; count: number; open: number; guests: number;
  firstSeen: number; lastSeen: number;
  eventCodes: string[]; versions: string[];
}

export interface ClientErrorGroup extends ClientErrorSummary {
  message: string; context: string | null; handled: boolean; latestId: string;
  latest: ClientErrorOccurrence; occurrences: ClientErrorOccurrence[];
}

/** Hang the occurrences off their summaries. Pure, and separate from the queries, because this is
 *  where the claims worth testing live: that a group carries its own occurrences and nobody
 *  else's, that the newest one is the one whose detail gets shown, and that a group is `handled`
 *  only when nothing in it is still open.
 *
 *  `occurrences` must arrive NEWEST FIRST — the queries below order it that way, and `latest`
 *  is simply the first one. Sorting again here would be a second ordering rule to keep in step
 *  with the SQL, and the two would disagree the first time a tie-break changed. */
export function assembleErrorGroups(
  summaries: ClientErrorSummary[], occurrences: ClientErrorOccurrence[],
): ClientErrorGroup[] {
  const byKey = new Map<string, ClientErrorOccurrence[]>();
  for (const o of occurrences) {
    const list = byKey.get(o.key);
    if (list) list.push(o); else byKey.set(o.key, [o]);
  }
  const groups: ClientErrorGroup[] = [];
  for (const s of summaries) {
    const occ = byKey.get(s.key);
    // A summary with no occurrences cannot happen from one connection — but it CAN from two
    // statements a purge ran between, and a group rendered with no detail row and no message
    // would look like a rendering bug rather than a race. Drop it; the next load has it right.
    if (!occ?.length) continue;
    const latest = occ[0];
    groups.push({
      ...s,
      // From the newest occurrence, not from the oldest: the message is display text and a group
      // whose wording changed should read as it reads TODAY.
      message: latest.message, context: latest.context,
      // A group is only done when every report in it is. This is what makes a resolved group that
      // recurs reopen on its own — new reports insert `handled = false`, the open count goes back
      // above zero, and the group returns to the top of the operator's list without anyone having
      // to notice. It is the "is it still happening" signal, and it is free.
      handled: s.open === 0,
      latestId: latest.id,
      latest, occurrences: occ,
    });
  }
  return groups;
}

/** How many reports of one problem the console can show. Twenty is "when did this start, who hit
 *  it, did it follow a deploy" — everything past that is the same answer again, at the cost of a
 *  stack apiece in a payload the operator reads on a phone. The group's `count` is the real
 *  total and is not capped. */
const OCCURRENCE_SAMPLE = 20;

router.get('/client-errors', async (_req: Request, res: Response) => {
  // ONE aggregate over the whole table. `COALESCE(fingerprint, 'id:' || id)` is a guard, not a
  // fallback anyone should hit: 0071 backfilled every row and the capture path always writes the
  // column. It matters because GROUP BY collapses NULLs TOGETHER — a code path that forgot the
  // fingerprint would not produce ungrouped rows, it would produce one enormous group containing
  // every unrelated error in the system, which is a worse screen than the one this replaces.
  const summaries = await all<ClientErrorSummary>(
    `SELECT COALESCE(fingerprint, 'id:' || id)                 AS "key",
            count(*)::int                                      AS "count",
            count(*) FILTER (WHERE NOT handled)::int           AS "open",
            -- Distinct IDENTIFIED guests. count(DISTINCT …) skips NULLs, so an entirely anonymous
            -- group reads 0 — which is the truth ("we cannot tell you who"), not "nobody".
            count(DISTINCT participant_id)::int                AS "guests",
            min(created_at)                                    AS "firstSeen",
            max(created_at)                                    AS "lastSeen",
            array_remove(array_agg(DISTINCT event_code), NULL)  AS "eventCodes",
            array_remove(array_agg(DISTINCT app_version), NULL) AS "versions"
       FROM client_errors
      GROUP BY 1
      -- Anything still open first, then most recent. Not the flat list's handled-ASC: a group
      -- is a mix of both, and sorting a mix by a column it does not have is how the twelve
      -- identical rows ended up interleaved with everything else in the first place.
      ORDER BY (count(*) FILTER (WHERE NOT handled)) > 0 DESC, max(created_at) DESC, 1
      LIMIT 200`);

  // The sample, for the expandable detail. Window-functioned per group rather than a flat
  // "newest 300 rows overall", because those are not the same fetch: one noisy group would
  // otherwise fill the whole budget and every other group would open on nothing.
  const keys = summaries.map((s) => s.key);
  const occurrences = keys.length ? await all<ClientErrorOccurrence>(
    `SELECT g."key", g.id, g.message, g.context,
            g.event_code AS "eventCode", g.url, g.user_agent AS "userAgent", g.stack,
            g.participant_id AS "participantId",
            -- JOINED, NEVER STORED. Deleting a guest — retention purge, or an erasure request —
            -- takes their name off this screen with it, because this is the only place it comes
            -- from. A name copied into client_errors at capture time would outlive them.
            p.name AS "participantName",
            g.app_version AS "appVersion", g.client_build AS "clientBuild",
            g.display_mode AS "displayMode", g.viewport, g.connection, g.outcome,
            g.handled, g.created_at AS "at"
       FROM (SELECT ce.*, COALESCE(ce.fingerprint, 'id:' || ce.id) AS "key",
                    row_number() OVER (PARTITION BY COALESCE(ce.fingerprint, 'id:' || ce.id)
                                       ORDER BY ce.created_at DESC, ce.id DESC) AS rn
               FROM client_errors ce) g
       LEFT JOIN participants p ON p.id = g.participant_id
      WHERE g.rn <= ? AND g."key" = ANY(?::text[])
      ORDER BY g.created_at DESC, g.id DESC`, [OCCURRENCE_SAMPLE, keys]) : [];

  const groups = assembleErrorGroups(summaries, occurrences);
  // Both counts, because they answer different questions and the old single `open` silently
  // answered the less useful one. `open` is reports (the denominator for "how bad was it");
  // `openGroups` is PROBLEMS, which is the number the operator is deciding whether to act on.
  const open = await get<{ n: number }>(
    `SELECT count(*) FILTER (WHERE NOT handled)::int AS n FROM client_errors`);
  res.json({
    groups,
    open: Number(open?.n ?? 0),
    openGroups: groups.filter((g) => g.open > 0).length,
  });
});

// Mark a whole GROUP handled, named by any one report in it.
//
// THE ROUTE STILL TAKES AN ID on purpose. The fingerprint is derived from a message and can
// contain every character a browser's error text can, including slashes — it has no business in a
// path segment, and encoding it there would make the URL in the operator's history a copy of a
// string we may yet change the rule for. The client names a row it can see; the server expands it
// to the group. It also means this endpoint keeps working, unchanged, for the one caller that
// might legitimately mean a single row.
router.post('/client-errors/:id/handled', async (req: Request, res: Response) => {
  const id = String(req.params.id);
  const row = await get<{ fingerprint: string | null; handled: boolean }>(
    `SELECT fingerprint, handled FROM client_errors WHERE id = ?`, [id]);
  if (!row) return res.status(404).json({ error: 'not found' });
  // EXPLICIT, not `NOT handled`. A group is routinely MIXED — resolved last week, recurred this
  // morning — and there is no single value to negate: toggling off the representative row flips
  // the whole group to whatever the newest report happened not to be, so the operator presses
  // "resolve" on a twelve-report group and watches eleven of them reopen. The console sends what
  // it is showing; the negate is kept only as the answer for a caller that sends no body.
  const body = req.body as { handled?: unknown } | undefined;
  const target = typeof body?.handled === 'boolean' ? body.handled : !row.handled;
  // The NULL-fingerprint arm is unreachable after 0071's backfill and is here anyway, because the
  // alternative is `WHERE fingerprint = NULL` matching nothing and the button doing nothing at
  // all — a silent no-op on the one control this screen has.
  if (row.fingerprint) {
    await run(`UPDATE client_errors SET handled = ? WHERE fingerprint = ?`, [target, row.fingerprint]);
  } else {
    await run(`UPDATE client_errors SET handled = ? WHERE id = ?`, [target, id]);
  }
  res.json({ ok: true, handled: target });
});

// Post-event survey responses (newest first), with the event they belong to.
router.get('/survey-responses', async (req: Request, res: Response) => {
  const { limit, offset, q } = listing(req, 50);
  let where = ' WHERE 1=1';
  const params: unknown[] = [];
  const search = searchClause(q, ['COALESCE(s.comments, \'\')', 'e.name', 'e.join_code']);
  where += search.sql; params.push(...search.params);
  // The two filters worth having: the ones we may quote, and the ones that need a reply.
  const filter = String(req.query.filter || 'all');   // all | testimonial | promoter | detractor
  if (filter === 'testimonial') where += ' AND s.testimonial_ok = true';
  if (filter === 'promoter')    where += ' AND s.nps >= 9';
  if (filter === 'detractor')   where += ' AND s.nps IS NOT NULL AND s.nps <= 6';

  const base =
    `SELECT s.id, s.overall, s.setup, s.guest_experience AS "guestExperience", s.value, s.nps,
            s.comments, s.contact_opt_in AS "contactOptIn",
            s.testimonial_ok AS "testimonialOk", s.testimonial_name AS "testimonialName",
            s.published_at AS "publishedAt", s.created_at,
            e.name AS "eventName", e.join_code AS "joinCode"
       FROM survey_responses s JOIN events e ON e.id = s.event_id` + where;
  const total = await countOf(base, params);
  // Unique final key, same reason as the user listing above.
  const responses = await all(`${base} ORDER BY s.created_at DESC, s.id LIMIT ? OFFSET ?`, [...params, limit, offset]);
  res.json({ responses, total, limit, offset });
});

// One-click FULL refund of an event's payment via Stripe, then lock the event (a full refund is a
// cancellation). Partial/goodwill refunds stay in the Stripe dashboard. Idempotent: refuses if
// already refunded, and requires a payment intent on file (captured at checkout).
router.post('/refund/:eventId', async (req: Request, res: Response) => {
  if (!billingEnabled || !stripe) return res.status(400).json({ error: 'Billing is not enabled' });
  const eventId = String(req.params.eventId);
  const ev = await get<{ pi: string | null; refunded: number | null; cents: number }>(
    `SELECT stripe_payment_intent AS pi, refunded_at AS refunded, amount_paid_cents AS cents FROM events WHERE id = ?`, [eventId]);
  if (!ev) return res.status(404).json({ error: 'Event not found' });
  if (ev.refunded) return res.status(400).json({ error: 'This event has already been refunded' });
  if (!ev.pi) return res.status(400).json({ error: 'No Stripe payment on file — refund manually in the Stripe dashboard' });
  try {
    const refund = await stripe.refunds.create({ payment_intent: ev.pi });
    await run(`UPDATE events SET refunded_at = ?, is_locked = true WHERE id = ?`, [Date.now(), eventId]);
    res.json({ ok: true, refundId: refund.id, amountCents: ev.cents });
  } catch (e) {
    res.status(502).json({ error: 'Stripe refund failed: ' + (e as Error).message });
  }
});

// Guest top-ups. These are participant-level payments and were invisible here, so a chargeback or
// a genuine failure meant going to the Stripe dashboard by hand. Australian Consumer Law does not
// let you contract out of consumer guarantees, so a refund path has to exist even though the stated
// position is that change-of-mind top-ups are not refunded.
router.get('/guest-payments', async (_req: Request, res: Response) => {
  const rows = await all(
    `SELECT p.id, p.name, COALESCE(p.upgrade_email, p.email) AS email, p.extra_photos,
            p.amount_paid_cents, p.stripe_payment_intent, p.requested_more_at,
            e.join_code, e.name AS event_name
       FROM participants p JOIN events e ON e.id = p.event_id
      WHERE p.amount_paid_cents > 0
      ORDER BY p.joined_at DESC, p.id
      LIMIT 100`);
  res.json({ payments: rows });
});

router.post('/refund-guest/:participantId', async (req: Request, res: Response) => {
  if (!billingEnabled || !stripe) return res.status(400).json({ error: 'Billing is not enabled' });
  const id = String(req.params.participantId);
  const p = await get<{ pi: string | null; cents: number; extra: number }>(
    `SELECT stripe_payment_intent AS pi, amount_paid_cents AS cents, extra_photos AS extra
       FROM participants WHERE id = ?`, [id]);
  if (!p) return res.status(404).json({ error: 'Guest not found' });
  if (!p.cents) return res.status(400).json({ error: 'This guest has not paid for anything' });
  if (!p.pi) return res.status(400).json({ error: 'No Stripe payment on file — refund manually in the Stripe dashboard' });
  try {
    const refund = await stripe.refunds.create({ payment_intent: p.pi });
    // Take the shots back with the money. Photos they already took are untouched — the roll simply
    // returns to whatever the event allows.
    await run(`UPDATE participants SET amount_paid_cents = 0, extra_photos = 0, stripe_payment_intent = NULL WHERE id = ?`, [id]);
    res.json({ ok: true, refundId: refund.id, amountCents: p.cents, shotsRemoved: p.extra });
  } catch (e) {
    res.status(502).json({ error: 'Stripe refund failed: ' + (e as Error).message });
  }
});

// Guest feedback. Collecting it without a way to read it is just a table that fills up, so this
// exists for the same reason the collection does.
router.get('/guest-feedback', async (_req: Request, res: Response) => {
  const rows = await all(
    `SELECT gf.id, gf.rating, gf.comment, gf.created_at,
            p.name AS guest_name, e.join_code, e.name AS event_name
       FROM guest_feedback gf
       LEFT JOIN participants p ON p.id = gf.participant_id
       JOIN events e            ON e.id = gf.event_id
      ORDER BY gf.created_at DESC, gf.id
      LIMIT 100`);
  const stats = await get<{ n: number; avg: number | null }>(
    `SELECT count(*) AS n, avg(rating)::float AS avg FROM guest_feedback WHERE rating IS NOT NULL`);
  res.json({ feedback: rows, count: Number(stats?.n || 0), average: stats?.avg ?? null });
});

// Run the retention sweeper on demand (the same job the hourly timer runs) — purges events past
// their retention window. Useful for ops + lets the test suite exercise purge deterministically.
router.post('/run-sweep', async (_req: Request, res: Response) => {
  const purged = await sweep();
  res.json({ ok: true, purged });
});

// ── Product analytics ─────────────────────────────────────────────────────────
// The question this answers is "where do people give up", so it reports funnel STEPS with the
// drop-off between them rather than a wall of event counts. `days` windows everything; the raw
// rows are pruned by the sweeper (ANALYTICS_RETENTION_DAYS).
router.get('/analytics', async (req: Request, res: Response) => {
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
  const since = Date.now() - days * 86_400_000;

  // Distinct VISITS per event name, not raw hits: one person reloading the pricing page five times
  // is one person considering the price, and counting hits would flatter every step.
  // count(DISTINCT visit) rather than COALESCE(visit, id::text): the cast forced a heap fetch and
  // a text conversion per row (858ms vs 621ms over 170k rows at 2M total). A null visit means we
  // had no IP, which is rare, and each such row counts as its own visit — same answer, cheaper.
  // If this ever needs to be fast at millions of rows the answer is a daily rollup table, not a
  // wider index: a covering index only reached 511ms and would slow every insert on the hottest
  // table in the schema.
  const rows = await all<{ name: string; visits: number; hits: number }>(
    `SELECT name,
            count(DISTINCT visit) + count(*) FILTER (WHERE visit IS NULL) AS visits,
            count(*) AS hits
       FROM site_events WHERE created_at >= ?
      GROUP BY name`, [since]);
  const byName = new Map(rows.map((r) => [r.name, { visits: Number(r.visits), hits: Number(r.hits) }]));
  const at = (n: string) => byName.get(n) ?? { visits: 0, hits: 0 };

  // Two funnels, because the host and the guest are different people with different journeys.
  const hostFunnel = [
    { step: 'Visited the site',      ...at('page_view') },
    { step: 'Started a signup',      ...at('signup_started') },
    { step: 'Submitted the signup',  ...at('signup_submitted') },
    { step: 'Started an event',      ...at('event_create_started') },
    { step: 'Went to checkout',      ...at('checkout_started') },
    { step: 'Came back paid',        ...at('checkout_returned') },
  ];
  const guestFunnel = [
    { step: 'Opened a join link',        ...at('join_opened') },
    { step: 'Joined',                    ...at('joined') },
    { step: 'Allowed the camera',        ...at('camera_permission_granted') },
    { step: 'Took a photo',              ...at('photo_captured') },
    { step: 'Finished their roll',       ...at('roll_completed') },
    { step: 'Opened their gallery',      ...at('guest_gallery_opened') },
  ];
  // Drop-off is measured against the PREVIOUS step, which is the number a funnel is read for.
  const withDrop = (f: typeof hostFunnel) => f.map((s, i) => ({
    ...s,
    dropFromPrev: i === 0 || f[i - 1].visits === 0 ? null
      : Math.round((1 - s.visits / f[i - 1].visits) * 1000) / 10,
  }));

  // Camera permission is the one ratio worth stating outright — denials were visible before but had
  // no denominator, so nobody could say whether they mattered.
  const granted = at('camera_permission_granted').visits;
  const denied  = at('camera_permission_denied').visits;
  const cameraGrantRate = granted + denied > 0 ? Math.round((granted / (granted + denied)) * 1000) / 10 : null;

  const topPages = await all(
    `SELECT path, count(DISTINCT visit) + count(*) FILTER (WHERE visit IS NULL) AS visits, count(*) AS views
       FROM site_events WHERE name = 'page_view' AND created_at >= ? AND path IS NOT NULL
      GROUP BY path ORDER BY visits DESC, path LIMIT 15`, [since]);

  // Which pricing tier gets clicked, and which FAQs get opened — the two "what are people
  // responding to" questions the marketing pages could not answer.
  const tierClicks = await all(
    `SELECT props->>'tier' AS tier, count(*) AS clicks
       FROM site_events WHERE name = 'pricing_tier_click' AND created_at >= ?
      GROUP BY 1 ORDER BY clicks DESC, 1`, [since]);
  const ctaClicks = await all(
    `SELECT props->>'cta' AS cta, count(*) AS clicks
       FROM site_events WHERE name = 'cta_click' AND created_at >= ?
      GROUP BY 1 ORDER BY clicks DESC, 1 LIMIT 10`, [since]);
  const faqOpens = await all(
    `SELECT props->>'q' AS q, count(*) AS opens
       FROM site_events WHERE name = 'faq_open' AND created_at >= ?
      GROUP BY 1 ORDER BY opens DESC, 1 LIMIT 10`, [since]);

  const totals = await get<{ events: number; visits: number }>(
    `SELECT count(*) AS events, count(DISTINCT visit) AS visits FROM site_events WHERE created_at >= ?`, [since]);

  res.json({
    days,
    totals: { events: Number(totals?.events || 0), visits: Number(totals?.visits || 0) },
    hostFunnel: withDrop(hostFunnel),
    guestFunnel: withDrop(guestFunnel),
    cameraGrantRate, cameraGranted: granted, cameraDenied: denied,
    topPages, tierClicks, ctaClicks, faqOpens,
    allEvents: [...byName.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => b.hits - a.hits),
  });
});

// ── Promo codes (Stripe-native) ───────────────────────────────────────────────
// Codes are created as a Stripe coupon (the discount) + promotion code (what guests type
// at Checkout). Stripe enforces redemption limits + expiry; allow_promotion_codes is already
// set on the checkout session. Only available when billing is enabled.

router.get('/promos', async (req: Request, res: Response) => {
  if (!billingEnabled || !stripe) return res.json({ billingEnabled: false, promos: [] });
  const state = String(req.query.state || 'all');   // all | active | used | expired | off
  const list = await stripe.promotionCodes.list({ limit: 100, expand: ['data.promotion.coupon'] });
  const promos = list.data.map((p) => {
    const coupon = (p.promotion as { coupon?: { percent_off?: number | null; amount_off?: number | null; currency?: string | null } })?.coupon;
    // "Active" in Stripe only means the switch is on — a code can be switched on, fully redeemed
    // and long expired all at once, which is exactly the code you no longer want in the list.
    const expired  = !!p.expires_at && p.expires_at * 1000 < Date.now();
    const usedUp   = p.max_redemptions != null && p.times_redeemed >= p.max_redemptions;
    const state    = !p.active || expired || usedUp ? (usedUp ? 'used' : expired ? 'expired' : 'off') : 'active';
    return {
      state,
      id: p.id,
      code: p.code,
      active: p.active,
      timesRedeemed: p.times_redeemed,
      maxRedemptions: p.max_redemptions ?? null,
      expiresAt: p.expires_at ? p.expires_at * 1000 : null,
      percentOff: coupon?.percent_off ?? null,
      amountOff: coupon?.amount_off ?? null,
      currency: coupon?.currency ?? null,
      created: p.created * 1000,
    };
  });
  const shown = state === 'all' ? promos : promos.filter((p) => p.state === state);
  res.json({ billingEnabled: true, promos: shown, total: promos.length });
});

router.post('/promos', async (req: Request, res: Response) => {
  if (!billingEnabled || !stripe) return res.status(400).json({ error: 'Billing is not enabled' });
  const code = String(req.body?.code || '').trim().toUpperCase();
  const percentOff = req.body?.percentOff != null ? Number(req.body.percentOff) : null;
  const amountOff = req.body?.amountOff != null ? Math.round(Number(req.body.amountOff) * 100) : null; // dollars → cents
  const maxRedemptions = req.body?.maxRedemptions != null ? parseInt(req.body.maxRedemptions, 10) : null;
  const expiresAt = req.body?.expiresAt != null ? parseInt(req.body.expiresAt, 10) : null; // epoch ms

  if (!code || !/^[A-Z0-9_-]{3,40}$/.test(code)) return res.status(400).json({ error: 'Code must be 3–40 chars (A–Z, 0–9, - or _)' });
  const hasPct = percentOff != null && percentOff > 0 && percentOff <= 100;
  const hasAmt = amountOff != null && amountOff > 0;
  if (hasPct === hasAmt) return res.status(400).json({ error: 'Set exactly one of percentOff (1–100) or amountOff (>0)' });
  if (maxRedemptions != null && (!Number.isFinite(maxRedemptions) || maxRedemptions < 1)) return res.status(400).json({ error: 'maxRedemptions must be ≥ 1' });
  if (expiresAt != null && (!Number.isFinite(expiresAt) || expiresAt <= Date.now())) return res.status(400).json({ error: 'expiresAt must be in the future' });

  // Discount lives on the coupon (one-off payment ⇒ duration 'once').
  const coupon = await stripe.coupons.create(
    hasPct
      ? { percent_off: percentOff as number, duration: 'once', name: `Snapdini ${code}` }
      : { amount_off: amountOff as number, currency: CURRENCY, duration: 'once', name: `Snapdini ${code}` },
  );
  const promo = await stripe.promotionCodes.create({
    promotion: { type: 'coupon', coupon: coupon.id },
    code,
    ...(maxRedemptions != null ? { max_redemptions: maxRedemptions } : {}),
    ...(expiresAt != null ? { expires_at: Math.floor(expiresAt / 1000) } : {}),
  });
  res.json({ id: promo.id, code: promo.code });
});

// Deactivate a promo code (Stripe codes can't be deleted, only deactivated).
router.post('/promos/:id/deactivate', async (req: Request, res: Response) => {
  if (!billingEnabled || !stripe) return res.status(400).json({ error: 'Billing is not enabled' });
  await stripe.promotionCodes.update(String(req.params.id), { active: false });
  res.json({ ok: true });
});

// ── Revenue & spend history ───────────────────────────────────────────────────
// All money is events.amount_paid_cents (cumulative real $ per event, incl. upgrades + the branding
// add-on). Time basis = the event's created_at (there's no separate per-payment timestamp). Read-only.
router.get('/revenue', async (req: Request, res: Response) => {
  if (!billingEnabled) return res.json({ billingEnabled: false, currency: CURRENCY, totals: { all: 0, d30: 0, d7: 0 }, users: [] });
  const now = Date.now();
  const d30 = now - 30 * 24 * 3600 * 1000;
  const d7 = now - 7 * 24 * 3600 * 1000;

  const totals = await get<{ all_cents: number; d30_cents: number; d7_cents: number }>(
    `SELECT COALESCE(SUM(amount_paid_cents),0) AS all_cents,
            COALESCE(SUM(CASE WHEN created_at >= ? THEN amount_paid_cents ELSE 0 END),0) AS d30_cents,
            COALESCE(SUM(CASE WHEN created_at >= ? THEN amount_paid_cents ELSE 0 END),0) AS d7_cents
       FROM events WHERE amount_paid_cents > 0`, [d30, d7]);

  // Group in SQL and page the GROUPS. This previously selected every paid event ever, with no
  // limit, and grouped them in memory — fine at two customers, not a thing to leave in place.
  const { limit, offset, q } = listing(req, 50);
  const search = searchClause(q, ['COALESCE(u.email, \'\')', 'COALESCE(u.display_name, \'\')', 'e.name']);
  const groupBase =
    `SELECT COALESCE(u.id, '(none)') AS key, MIN(u.id) AS userid,
            COALESCE(MIN(u.email), '(no account)') AS email, MIN(u.display_name) AS displayname,
            SUM(e.amount_paid_cents) AS totalcents
       FROM events e LEFT JOIN users u ON u.id = e.owner_user_id
      WHERE e.amount_paid_cents > 0${search.sql}
      GROUP BY COALESCE(u.id, '(none)')`;
  const totalCustomers = await countOf(groupBase, search.params);
  const groups = await all<{ key: string; userid: string | null; email: string; displayname: string | null; totalcents: number }>(
    // `key` is the GROUP BY expression, so it is unique per row here — the stable tiebreaker.
    `${groupBase} ORDER BY totalcents DESC, key LIMIT ? OFFSET ?`, [...search.params, limit, offset]);

  // Only the events belonging to the customers on THIS page.
  const keys = groups.map((g) => g.key);
  const rows = keys.length
    ? await all<{ eventid: string; name: string; cents: number; createdat: number; branding: boolean; key: string }>(
        `SELECT e.id AS eventId, e.name AS name, e.amount_paid_cents AS cents, e.created_at AS createdAt,
                e.branding_removal_paid AS branding, COALESCE(e.owner_user_id, '(none)') AS key
           FROM events e
          WHERE e.amount_paid_cents > 0 AND COALESCE(e.owner_user_id, '(none)') IN (${keys.map(() => '?').join(',')})
          ORDER BY e.created_at DESC, e.id`, keys)
    : [];

  const map = new Map<string, { userId: string | null; email: string; displayName: string | null; totalCents: number; events: { id: string; name: string; cents: number; createdAt: number; branding: boolean }[] }>();
  for (const g of groups) {
    map.set(g.key, { userId: g.userid, email: g.email, displayName: g.displayname, totalCents: Number(g.totalcents), events: [] });
  }
  for (const r of rows) {
    map.get(r.key)?.events.push({ id: r.eventid, name: r.name, cents: r.cents, createdAt: r.createdat, branding: !!r.branding });
  }
  const users = [...map.values()];

  res.json({
    billingEnabled: true,
    currency: CURRENCY,
    totals: { all: totals?.all_cents || 0, d30: totals?.d30_cents || 0, d7: totals?.d7_cents || 0 },
    users, total: totalCustomers, limit, offset,
  });
});

export default router;
