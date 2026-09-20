import fs from 'fs';
import path from 'path';
import { and, eq, isNotNull, lt, count } from 'drizzle-orm';
import { db } from './db';
import { RESCHEDULE_WINDOW_MS, RESCHEDULE_RETENTION_GRACE_MS } from './lib';
import { events, photos, participants, clientErrors, slideshows, shares, emailTokens, sessions, adminActions } from './schema';
import { UPLOADS_DIR, uploadDiskPath, insideUploads, eventDir, INCOMING_DIR } from './paths';
import { playName, thumbName } from './images';
import { purgeOldSlideshows } from './slideshow';
import { pruneAnalytics } from './analytics';
import { skipWriteSweep } from './readonly';

const SWEEP_MS = 60 * 60 * 1000; // hourly
const CLIENT_ERROR_TTL_MS = 30 * 24 * 60 * 60 * 1000; // keep diagnostic reports ~30 days
// Expired auth tokens are kept briefly so an expired link still reports itself as expired.
const EXPIRED_TOKEN_GRACE_MS = 24 * 60 * 60 * 1000;

function safeUnlink(file: string): void {
  // Containment is checked HERE, not at the call sites, because every delete path funnels through
  // this one function — event deletion, the retention purge and the thumb/proxy siblings. The
  // filenames come from DB columns, which are only as trustworthy as whatever wrote them.
  if (!insideUploads(file)) return;
  fs.promises.unlink(file).catch(() => {}); // best-effort; ignore missing
}

// Remove a photo's uploaded file (and its grid thumbnail) given its stored filename.
export function unlinkUpload(filename?: string | null): void {
  if (!filename) return;
  safeUnlink(path.join(UPLOADS_DIR, filename));
  safeUnlink(path.join(UPLOADS_DIR, thumbName(filename))); // <name>_thumb.webp (no-op for videos)
  safeUnlink(path.join(UPLOADS_DIR, playName(filename)));  // <name>_play.mp4 (no-op for photos)
}

// Delete every file owned by an event (photos + theme header image) from disk.
// Call this BEFORE deleting the event row (the row cascade removes DB records).
export async function deleteEventFiles(eventId: string): Promise<void> {
  const rows = await db.select({ filename: photos.filename }).from(photos).where(eq(photos.eventId, eventId));
  for (const p of rows) unlinkUpload(p.filename);

  // Every /uploads/ path the event's own JSON mentions, not a hand-listed key.
  //
  // This used to unlink `theme.headerImage` and nothing else, which was right while that was the
  // only file a theme could own. It is now one of three (the original it was cut from, and a poster
  // logo live beside it), and a list of keys here is a list that gets out of date silently — the
  // symptom is orphaned files sitting in an event folder after the event is gone, which nobody
  // sees. Walking the JSON for upload paths cannot fall behind a new key.
  const [ev] = await db.select({ theme: events.theme, posterConfig: events.posterConfig })
    .from(events).where(eq(events.id, eventId));
  for (const raw of [ev?.theme, ev?.posterConfig]) {
    if (!raw) continue;
    // Deliberately over the RAW JSON rather than a parsed shape: it finds a path wherever it is
    // nested, and a malformed blob still gets swept instead of throwing the whole delete away.
    for (const m of raw.matchAll(/"(\/uploads\/[A-Za-z0-9._/-]+)"/g)) {
      try { safeUnlink(uploadDiskPath(m[1])); } catch { /* outside UPLOADS_DIR — not ours to delete */ }
    }
  }
}

// Purge events whose retention window (purgeAt) has passed. We delete all the heavy /
// personal data — photo + video files, the slideshow, photo rows, and participant rows
// (names/emails) — but KEEP a slim event record (settings + final stats) as the organizer's
// history. The record's purge_at is cleared so it isn't swept again.
export async function sweep(): Promise<number> {
  let skipped = 0;
  const due = await db.select({ id: events.id, startsAt: events.startsAt, originalStartsAt: events.originalStartsAt })
    .from(events)
    .where(and(isNotNull(events.purgeAt), lt(events.purgeAt, Date.now())));
  for (const e of due) {
    // snapshot final stats before deleting the child rows
    const [pc] = await db.select({ n: count() }).from(participants).where(eq(participants.eventId, e.id));
    const [phc] = await db.select({ n: count() }).from(photos).where(eq(photos.eventId, e.id));

    // Retention exists to delete guest media and PII. An event nobody ever joined has neither, so
    // purging it destroys nothing and only costs the organizer the ability to reschedule it — the
    // exact case (bought, guests never scanned the QR, window lapsed) reschedule was built for.
    // Leave those alone until the reschedule window itself closes; it is one empty row.
    if (Number(pc?.n ?? 0) === 0 && Number(phc?.n ?? 0) === 0) {
      const anchor = e.originalStartsAt ?? e.startsAt;
      // + grace so the record always outlives the deadline it advertises.
      if (Date.now() < anchor + RESCHEDULE_WINDOW_MS + RESCHEDULE_RETENTION_GRACE_MS) { skipped++; continue; }
    }

    await deleteEventFiles(e.id);                 // photo/video + theme image files
    // All slideshow renders for this event (versioned files + rows), incl. favourited ones.
    try {
      const ss = await db.select().from(slideshows).where(eq(slideshows.eventId, e.id));
      for (const s of ss) safeUnlink(path.join(UPLOADS_DIR, s.filename));
      await db.delete(slideshows).where(eq(slideshows.eventId, e.id));
    } catch { /* best-effort */ }
    // Legacy pre-per-event backing track(s) in the shared slideshow-audio/ dir (named "<eventId>-*").
    try {
      const adir = path.join(UPLOADS_DIR, 'slideshow-audio');
      for (const f of fs.readdirSync(adir)) if (f.startsWith(`${e.id}-`)) safeUnlink(path.join(adir, f));
    } catch { /* none */ }
    // Finally, remove the event's whole per-event folder — sweeps everything now stored there
    // (audio, theme image, any leftover render temp), so nothing is orphaned. (Legacy flat files,
    // if any, were already handled by the per-file unlinks above.)
    try { fs.rmSync(eventDir(e.id), { recursive: true, force: true }); } catch { /* none */ }

    // No `photos_taken` reconciliation here, and that is not an oversight. The counter lives on the
    // participant row, and the very next statement deletes those rows for the same event — so no
    // guest is left holding a count of photos that no longer exist. The same holds wherever else
    // photo rows go: removing one participant cascades their photos away via
    // `photos.participant_id ON DELETE CASCADE` (routes/events.ts), the per-photo guest delete
    // decrements inside its own transaction (routes/photos.ts), and moderation REJECT is an UPDATE
    // of `status`, never a delete — a rejected photo still spent a shot, so its count must NOT be
    // refunded. There is no path that deletes a photo row and keeps the participant, which is the
    // only shape that would strand a counter.
    await db.delete(photos).where(eq(photos.eventId, e.id));
    await db.delete(participants).where(eq(participants.eventId, e.id)); // clears guest PII
    await db.delete(shares).where(eq(shares.eventId, e.id));             // dead links; frees their /s/ slugs
    // The admin action log goes WITH the event's data, in the same sweep that clears guest PII.
    //
    // It holds copies of the very things the line above is deleting: a removed guest's name and
    // email, a deleted comment's text, a caption. Left behind it would quietly outlive every
    // promise made about them — the privacy policy says deleted content is gone, and `client_errors`
    // goes to the trouble of storing only a participant ID so that erasing a guest erases it there
    // too. A table that keeps the same facts for ever is a contradiction of both.
    //
    // Deleting rather than redacting, because the log is an OPERATIONAL record and not an audit
    // trail: its whole job is "I changed something by accident, what was it before?", and there is
    // nothing left to restore once the photos, the guests and the shares are gone. Keeping a
    // hollowed-out row would preserve the shape of a record while destroying the part that made it
    // useful. What survives is what survives for everything else here — the event's summary row.
    await db.delete(adminActions).where(eq(adminActions.eventId, e.id));

    await db.update(events).set({
      purgeAt: null,
      purgedAt: Date.now(),
      slug: null,             // free the pretty /e/ URL so a future event can reuse it
      theme: null,            // the theme image file is deleted above; drop its dead path reference too
      statParticipants: Number(pc?.n ?? 0),
      statPhotos: Number(phc?.n ?? 0),
    }).where(eq(events.id, e.id));
  }
  if (due.length) console.log(`[sweeper] purged media for ${due.length - skipped} event(s) (kept stats archive)` + (skipped ? `; skipped ${skipped} unused event(s) still inside the reschedule window` : ''));

  // Reclaim NFS silly-rename orphans. Uploads live on an NFS share, and unlinking a file that some
  // process still has open does not free it there — the server renames it to `.nfs*` and keeps it
  // forever. The retention purge hits exactly that case (deleting an event's photos while a read is
  // in flight), so every purge can strand megabytes AND leave the event folder undeletable. Retry
  // once they are cold: if a holder remains the unlink simply fails again and we try next sweep.
  try {
    const cutoff = Date.now() - 60 * 60 * 1000;   // an hour is well past any in-flight read
    const dirs = [UPLOADS_DIR, ...fs.readdirSync(UPLOADS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => path.join(UPLOADS_DIR, d.name))];
    let reclaimed = 0;
    for (const dir of dirs) {
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.startsWith('.nfs')) continue;
        const f = path.join(dir, n);
        try { if (fs.statSync(f).mtimeMs < cutoff) { fs.unlinkSync(f); reclaimed++; } } catch { /* still held */ }
      }
      // A purged event's folder is left behind once its orphans are gone — drop it if now empty.
      // ONLY event folders (uuid-named): `.incoming`, `themes` and any other structural directory
      // must survive. They are recreated on demand, so deleting them is not fatal, but it is churn
      // and it makes the uploads tree look alarming to anyone inspecting it.
      if (dir !== UPLOADS_DIR && /^[0-9a-f-]{36}$/i.test(path.basename(dir))) {
        try { if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch { /* not empty / in use */ }
      }
    }
    if (reclaimed) console.log(`[sweeper] reclaimed ${reclaimed} stale NFS orphan(s)`);
  } catch (e) { console.warn('[sweeper] nfs orphan sweep:', (e as Error).message); }

  // Sweep abandoned upload staging — chunk-part dirs and staged single files that were never
  // completed (client gave up mid-upload) — once they're older than 6h.
  try {
    const cutoff = Date.now() - 6 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(INCOMING_DIR)) {
      const p = path.join(INCOMING_DIR, name);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true }); } catch { /* */ }
    }
  } catch { /* no staging dir yet */ }

  // Keep the diagnostics table bounded — drop client error reports older than the TTL.
  try { await db.delete(clientErrors).where(lt(clientErrors.createdAt, Date.now() - CLIENT_ERROR_TTL_MS)); }
  catch (e) { console.error('[sweeper] client_errors prune failed:', (e as Error).message); }

  // Auto-purge non-favourite slideshow renders older than a day (favourites kept until event purge).
  try { await purgeOldSlideshows(); } catch (e) { console.error('[sweeper] slideshow purge failed:', (e as Error).message); }
  // Raw analytics rows age out too — they answer questions that are only interesting while fresh.
  try { const n = await pruneAnalytics(); if (n) console.log(`[sweeper] pruned ${n} analytics row(s)`); }
  catch (e) { console.error('[sweeper] analytics prune failed:', (e as Error).message); }

  // Single-use auth tokens and dead sessions were never cleaned up, so both tables only ever grew:
  // a row per verification email, per sign-in link and (since the cross-device sign-up poll) per
  // registration again. Nothing read them once expired — they just made every token lookup, which
  // is on the sign-in path, progressively more expensive.
  //
  // A short grace period past expiry keeps a just-expired token available long enough to answer
  // "this link has expired" properly rather than as "invalid".
  try {
    const cutoff = Date.now() - EXPIRED_TOKEN_GRACE_MS;
    const r = await db.delete(emailTokens).where(lt(emailTokens.expiresAt, cutoff));
    const n = (r as { rowCount?: number }).rowCount ?? 0;
    if (n) console.log(`[sweeper] pruned ${n} expired auth token(s)`);
  } catch (e) { console.error('[sweeper] auth token prune failed:', (e as Error).message); }

  try {
    const r = await db.delete(sessions).where(lt(sessions.expiresAt, Date.now()));
    const n = (r as { rowCount?: number }).rowCount ?? 0;
    if (n) console.log(`[sweeper] pruned ${n} expired session(s)`);
  } catch (e) { console.error('[sweeper] session prune failed:', (e as Error).message); }

  return due.length;
}

// Start the periodic sweeper (and run once on boot).
export function start() {
  const run = () => sweep().catch((err) => console.error('[sweeper] failed:', err.message));
  // Guarded like the interval below: this fires on a replica too, and did.
  if (!skipWriteSweep('cleanup')) run();
  const timer = setInterval(() => { if (!skipWriteSweep('cleanup')) void run(); }, SWEEP_MS);
  timer.unref?.(); // don't keep the process alive just for the sweeper
  return timer;
}
