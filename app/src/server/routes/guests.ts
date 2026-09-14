// The guest list, the invites sent to it, and the Mailgun webhook that says what became of them.
//
// Three groups of routes, all organizer-gated except the last:
//   /:joinCode/guests…      the list itself — add, edit, remove, import
//   /:joinCode/invites      send, and read back what happened
//   the webhook             public, signature-verified, and the only writer of delivery state
//
// The design decision the rest of this file follows from: SENDING is easy and KNOWING is the
// feature. A send that reports "20 sent" and nothing else is what hosts already have, and it is
// exactly as informative as a send that silently dropped nineteen of them.
import { Router, type Request, type Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { db } from '../db';
import { eventGuests, guestInvites, emailSuppressions } from '../schema';
import { requireOrganizer } from './events';
import * as email from '../email';
import { baseUrl, escapeHtml } from '../lib';
import { parseCsv, guessMapping, buildImport, isEmail, identityKey, MAX_IMPORT_ROWS, FIELD_MAX,
         type GuestField, type ImportRow } from '../csv';
import { verifySignature, normaliseEvent, webhookConfigured, tokenSeen, rememberToken,
         INVITE_VAR, INVITE_TAG } from '../mailgun';
import { shouldApply, suppressionReason, normaliseAddress, type DeliveryStatus } from '../delivery';
import { blocksFor, partitionRecipients, unsubscribeHeaders, unsubscribePageUrl } from '../unsubscribe';

const router = Router();

/** One press of "Send invites" mails at most this many people. Matches the existing gallery-blast
 *  ceiling, and bounds how long one request can hold a connection open — sends are sequential. */
const MAX_PER_SEND = 200;
/** A guest list is a party, not a mailing list. Past this the feature is being used for something
 *  it was not built for and will not do well. */
const MAX_GUESTS_PER_EVENT = 2000;

// ── Reading the list ─────────────────────────────────────────────────────────

/** The list plus everything needed to render its state, in three queries rather than N.
 *
 *  The suppression lookup is a join against a GLOBAL table, so a guest can show as suppressed
 *  because of something that happened at a completely different host's event. That is deliberate
 *  and is the whole point — see 0044_guest_invites.sql — but it does mean the UI has to explain
 *  itself, which is why the reason travels with the flag rather than just a boolean. */
async function listPayload(eventId: string) {
  const guests = await db.select().from(eventGuests)
    .where(eq(eventGuests.eventId, eventId))
    .orderBy(eventGuests.createdAt)
    .limit(MAX_GUESTS_PER_EVENT);

  const invites = await db.select().from(guestInvites)
    .where(eq(guestInvites.eventId, eventId))
    .orderBy(desc(guestInvites.sentAt))
    .limit(5000);

  const addresses = guests.map((g) => g.email).filter((e): e is string => !!e);
  // Both reasons an address will not be mailed, in one shape. A guest who used the body link to
  // stop mail about THIS event has not bounced and is not globally suppressed, so reading only the
  // global table would show them as perfectly mailable right up until the send skipped them.
  const blocked = await blocksFor(eventId, addresses);

  // Invites come back newest-first, so the FIRST one seen for a guest is their latest.
  const latest = new Map<string, typeof invites[number]>();
  for (const i of invites) if (i.guestId && !latest.has(i.guestId)) latest.set(i.guestId, i);

  return {
    guests: guests.map((g) => {
      const last = latest.get(g.id);
      const sup = g.email ? blocked.get(g.email) : undefined;
      return {
        id: g.id, name: g.name, email: g.email, phone: g.phone, notes: g.notes,
        createdAt: g.createdAt,
        lastInvite: last
          ? { status: last.status, reason: last.reason, provider: last.provider,
              sentAt: last.sentAt, updatedAt: last.updatedAt }
          : null,
        suppressed: sup ? { reason: sup.reason, detail: sup.detail, since: sup.since, scope: sup.scope } : null,
      };
    }),
    invites: invites.slice(0, 500).map((i) => ({
      id: i.id, guestId: i.guestId, email: i.email, status: i.status, reason: i.reason,
      provider: i.provider, sentAt: i.sentAt, updatedAt: i.updatedAt,
    })),
    emailEnabled: email.enabled,
    /** Whether a 'sent' on this deployment will ever become something else. False on SMTP, and
     *  false on Mailgun with no signing key — in both cases the UI must say "we can't tell"
     *  rather than implying an update is on its way. */
    deliveryTracking: email.provider === 'mailgun' && webhookConfigured(),
  };
}

router.get('/:joinCode/guests', requireOrganizer, async (req: Request, res: Response) => {
  res.json(await listPayload(req.event!.id));
});

// ── Adding and editing one guest ─────────────────────────────────────────────

interface GuestBody { name?: unknown; email?: unknown; phone?: unknown; notes?: unknown }

/** Trim, cap and normalise one submitted field set. Returns null for anything empty, because an
 *  empty string and "not given" are the same thing for every field here, and storing both makes
 *  every later read test for two things. */
function cleanGuest(b: GuestBody): { name: string | null; email: string | null; phone: string | null; notes: string | null } | { error: string } {
  const pick = (v: unknown, max: number) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s.slice(0, max) : null;
  };
  const name = pick(b.name, FIELD_MAX.name);
  const phone = pick(b.phone, FIELD_MAX.phone);
  const notes = pick(b.notes, FIELD_MAX.notes);
  const rawEmail = pick(b.email, FIELD_MAX.email);
  // Lower-cased on the way in, always. Every duplicate check and every suppression lookup in this
  // feature is a byte comparison, so an address stored with its original casing is an address that
  // silently escapes both.
  const address = rawEmail ? normaliseAddress(rawEmail) : null;
  if (address && !isEmail(address)) return { error: 'That does not look like an email address' };
  if (!name && !address && !phone) return { error: 'Give the guest at least a name, an email or a phone number' };
  return { name, email: address, phone, notes };
}

router.post('/:joinCode/guests', requireOrganizer, async (req: Request, res: Response) => {
  const cleaned = cleanGuest(req.body as GuestBody);
  if ('error' in cleaned) return res.status(400).json({ error: cleaned.error });

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(eventGuests)
    .where(eq(eventGuests.eventId, req.event!.id));
  if (n >= MAX_GUESTS_PER_EVENT)
    return res.status(400).json({ error: `A guest list tops out at ${MAX_GUESTS_PER_EVENT} people` });

  const now = Date.now();
  try {
    await db.insert(eventGuests).values({ id: uuidv4(), eventId: req.event!.id, ...cleaned, createdAt: now, updatedAt: now });
  } catch {
    // The partial unique index on (event_id, email) is the only thing that can fail here, and it
    // means precisely one thing. Reported as a 409 with words rather than a 500 with none.
    return res.status(409).json({ error: 'That email is already on this guest list' });
  }
  res.json(await listPayload(req.event!.id));
});

router.patch('/:joinCode/guests/:id', requireOrganizer, async (req: Request, res: Response) => {
  const cleaned = cleanGuest(req.body as GuestBody);
  if ('error' in cleaned) return res.status(400).json({ error: cleaned.error });
  // Scoped to THIS event, not just the id: an organizer code for one event must not be usable to
  // edit another event's guest list by guessing an id.
  const [row] = await db.select({ id: eventGuests.id }).from(eventGuests)
    .where(and(eq(eventGuests.id, String(req.params.id)), eq(eventGuests.eventId, req.event!.id)));
  if (!row) return res.status(404).json({ error: 'That guest is no longer on the list' });

  try {
    await db.update(eventGuests).set({ ...cleaned, updatedAt: Date.now() }).where(eq(eventGuests.id, row.id));
  } catch {
    return res.status(409).json({ error: 'Another guest on this list already has that email' });
  }
  res.json(await listPayload(req.event!.id));
});

router.delete('/:joinCode/guests/:id', requireOrganizer, async (req: Request, res: Response) => {
  // The invites keep their row and their address (guest_id is ON DELETE SET NULL): removing
  // someone from the list must not erase the record that we mailed them, or a bounce the host
  // still needs to act on disappears along with the typo that caused it.
  await db.delete(eventGuests)
    .where(and(eq(eventGuests.id, String(req.params.id)), eq(eventGuests.eventId, req.event!.id)));
  res.json(await listPayload(req.event!.id));
});

// ── CSV import ───────────────────────────────────────────────────────────────

/** Read the mapping the client sent, or guess one. Anything unrecognised becomes 'ignore', so a
 *  malformed mapping costs a column rather than throwing. */
function readMapping(raw: unknown, headers: string[]): GuestField[] {
  const valid: GuestField[] = ['name', 'email', 'phone', 'notes', 'ignore'];
  if (!Array.isArray(raw)) return guessMapping(headers);
  return headers.map((_, i) => (valid.includes(raw[i] as GuestField) ? raw[i] as GuestField : 'ignore'));
}

/** Everything both import endpoints do before they diverge.
 *
 *  Preview and commit run the SAME functions over the SAME text, which is what makes the preview a
 *  promise rather than an illustration. The client posts the text back for the commit instead of
 *  the server holding a parsed draft between two requests — no server-side session state to
 *  expire, to leak across events, or to get out of step with what the host is looking at.
 *
 *  Upload and paste are the same endpoint because the browser turns a chosen file into text before
 *  it sends it. That removes a multipart upload path, a temp file, and a second size limit, for a
 *  feature whose input is a few tens of kilobytes of text. */
async function plan(req: Request) {
  const body = req.body as { text?: unknown; mapping?: unknown };
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return { error: 'Paste some rows, or choose a file' } as const;
  // A .xlsx is a zip, and every zip starts "PK". Saying so plainly beats letting the CSV parser
  // render the host's spreadsheet as one row of mojibake and calling it a guest.
  if (text.startsWith('PK'))
    return { error: 'That looks like an Excel file. Open it and choose File → Save As → CSV, then try again.' } as const;

  const table = parseCsv(text);
  if (!table.rows.length) return { error: 'No rows found in that' } as const;
  if (table.rows.length > MAX_IMPORT_ROWS)
    return { error: `That has ${table.rows.length} rows — the limit is ${MAX_IMPORT_ROWS}` } as const;

  const mapping = readMapping(body.mapping, table.headers);
  // Both identities: the addresses, and the name+phone key for the guests who have no address.
  // Without the second, a host who imports the same spreadsheet twice gets every plus-one and
  // phone-only guest a second time — there is nothing on those rows for the email check to match.
  const existing = await db.select({ email: eventGuests.email, name: eventGuests.name, phone: eventGuests.phone })
    .from(eventGuests).where(eq(eventGuests.eventId, req.event!.id));
  return {
    table, mapping,
    plan: buildImport(
      table, mapping,
      existing.map((e) => e.email).filter((e): e is string => !!e),
      existing.filter((e) => !e.email).map((e) => identityKey(e.name, e.phone)).filter((k): k is string => !!k),
    ),
  } as const;
}

/** What the import WOULD do. Nothing is written. */
router.post('/:joinCode/guests/import/preview', requireOrganizer, async (req: Request, res: Response) => {
  const p = await plan(req);
  if ('error' in p) return res.status(400).json({ error: p.error });
  res.json({
    headers: p.table.headers,
    headerless: p.table.headerless,
    delimiter: p.table.delimiter === '\t' ? 'tab' : p.table.delimiter,
    mapping: p.mapping,
    counts: p.plan.counts,
    fatal: p.plan.fatal,
    // Capped for the response only. The host is shown the first slice plus the totals; shipping
    // 2000 rows of preview to render is a lot of payload for a decision made on the first few.
    rows: p.plan.rows.slice(0, 200),
    truncated: p.plan.rows.length > 200,
    total: p.plan.rows.length,
  });
});

/** Commit it. */
router.post('/:joinCode/guests/import', requireOrganizer, async (req: Request, res: Response) => {
  const p = await plan(req);
  if ('error' in p) return res.status(400).json({ error: p.error });
  if (p.plan.fatal) return res.status(400).json({ error: p.plan.fatal });

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(eventGuests)
    .where(eq(eventGuests.eventId, req.event!.id));
  const adding = p.plan.rows.filter((r: ImportRow) => r.action === 'add');
  if (n + adding.length > MAX_GUESTS_PER_EVENT)
    return res.status(400).json({ error: `That would take the list past ${MAX_GUESTS_PER_EVENT} people` });

  const now = Date.now();
  const values = adding.map((r) => ({
    id: uuidv4(), eventId: req.event!.id,
    name: r.guest.name, email: r.guest.email, phone: r.guest.phone, notes: r.guest.notes,
    createdAt: now, updatedAt: now,
  }));

  // onConflictDoNothing rather than a transaction that rolls the lot back. The unique index is a
  // second line of defence behind buildImport's own duplicate check — it catches the race where
  // two imports of the same file overlap — and when it fires, the right answer is to keep the 199
  // guests that are fine, not to discard them because one was already there.
  if (values.length) await db.insert(eventGuests).values(values).onConflictDoNothing();

  res.json({ imported: values.length, skipped: p.plan.counts.skip, ...(await listPayload(req.event!.id)) });
});

// ── Sending ──────────────────────────────────────────────────────────────────

/** The invite itself. Snapdini's own layout (email.htmlEmail), so it arrives looking like the
 *  product rather than like a line pasted into a host's mail client — which is the thing that was
 *  actually asked for.
 *
 *  Everything interpolated is organizer-controlled and therefore escaped. The event name and the
 *  guest's name both come from a text box someone else typed into, and this string ends up as HTML
 *  in somebody's inbox. */
function inviteHtml(
  ev: { name: string; joinCode: string },
  guestName: string | null,
  joinUrl: string,
  unsubUrl: string,
): string {
  const safeEvent = escapeHtml(ev.name);
  const hello = guestName ? `<p>Hi ${escapeHtml(guestName)},</p>` : '';
  return email.htmlEmail(`You're invited to ${safeEvent}`, `
    ${hello}
    <p>You're invited to be a photographer at <strong>${safeEvent}</strong>.</p>
    <p>Snapdini is a disposable camera for the event — take your shots on your phone, and
       everyone's photos land in one shared album afterwards. There is nothing to install.</p>
    <p style="margin:24px 0"><a href="${joinUrl}" class="btn">Join the event →</a></p>
    <p>Or go to <a href="${joinUrl}">${escapeHtml(joinUrl)}</a> and enter the code
       <strong>${escapeHtml(ev.joinCode)}</strong>.</p>
    <p style="color:#888;font-size:13px">You are getting this because the host of ${safeEvent} added
       you to their guest list. If it was not meant for you, you can ignore it &mdash; or
       <a href="${unsubUrl}" style="color:#888">unsubscribe</a>, and choose whether that means this
       event or every Snapdini email.</p>
  `);
}

router.post('/:joinCode/guests/invite', requireOrganizer, async (req: Request, res: Response) => {
  if (!email.enabled) return res.status(503).json({ error: 'Email is not configured on this server' });
  const ev = req.event!;
  const wanted = (req.body as { guestIds?: unknown }).guestIds;
  const ids = Array.isArray(wanted) ? wanted.filter((i): i is string => typeof i === 'string') : null;

  let rows = await db.select().from(eventGuests)
    .where(ids && ids.length
      ? and(eq(eventGuests.eventId, ev.id), inArray(eventGuests.id, ids.slice(0, MAX_PER_SEND)))
      : eq(eventGuests.eventId, ev.id))
    .orderBy(eventGuests.createdAt)
    .limit(MAX_PER_SEND);

  // A guest with no email is not an error and not a failure — they are on the list for their phone
  // number. They are simply not part of an email send, and the count the host is shown says so.
  const noAddress = rows.filter((g) => !g.email).length;
  rows = rows.filter((g) => !!g.email);
  if (!rows.length)
    return res.status(400).json({ error: noAddress ? 'None of those guests have an email address' : 'Nobody to send to' });

  // THE suppression check. Every send path in this feature goes through it, and it runs as one
  // query against the whole batch rather than per address — a per-address check is the kind of
  // thing that gets skipped "just for the resend button" and quietly un-protects the domain.
  // It covers both refusals: the global list (bounces, complaints, "never email me again") and the
  // people who asked to hear nothing more about THIS event.
  const blocked = await blocksFor(ev.id, rows.map((g) => g.email as string));
  const { mailable, skipped: refused } = partitionRecipients(rows, blocked);

  const base = baseUrl(req);
  const joinUrl = base + (ev.slug ? `/e/${ev.slug}` : `/join/${ev.joinCode}`);
  const subject = `You're invited to ${ev.name} \u{1F4F7}`;
  const now = Date.now();

  const inserts: (typeof guestInvites.$inferInsert)[] = [];
  // Not silently. The host is told, by address and by reason, that these people were not mailed.
  // "We sent 19 of your 20" with no explanation is how a guest ends up never being invited and
  // nobody finding out until the day.
  const skipped: { email: string; name: string | null; reason: string }[] = refused.map((r) => ({
    email: r.guest.email as string, name: r.guest.name, reason: r.block.reason,
  }));
  let sent = 0, failed = 0;

  for (const g of mailable) {
    const address = g.email as string;

    // Minted BEFORE the send, so it exists even if the provider's response never arrives. This is
    // the id the webhook will come back with, AND the bearer token in this guest's unsubscribe
    // links — one token, because a second scheme would be a second thing to expire and get wrong.
    const token = uuidv4();
    const row: typeof guestInvites.$inferInsert = {
      id: uuidv4(), eventId: ev.id, guestId: g.id, email: address,
      status: 'sent', provider: email.provider, token,
      providerMessageId: null, reason: null, severity: null,
      sentAt: now, updatedAt: now, eventAt: null,
    };
    try {
      const r = await email.sendMail({
        to: address, subject, html: inviteHtml(ev, g.name, joinUrl, unsubscribePageUrl(base, token)),
        variables: { [INVITE_VAR]: token },
        tag: INVITE_TAG,
        // Both halves, because they serve different people. The header is what a mail client turns
        // into its own one-press unsubscribe, sitting beside the report-spam button; the body link
        // is for the guest who wants to choose between this event and all of it. These are cold
        // addresses off a host's spreadsheet — without an unsubscribe the only lever the recipient
        // has is "mark as spam", and that one is charged to our sending reputation.
        headers: unsubscribeHeaders(base, token),
      });
      row.provider = r.provider;
      row.providerMessageId = r.messageId;
      sent++;
    } catch (e) {
      // An immediate refusal — bad credentials, a malformed address, a provider 4xx. Recorded as
      // 'failed' (temporary) rather than 'bounced': the transport refused to CARRY it, which says
      // nothing about whether the mailbox exists, and suppressing on it would punish the guest for
      // our own misconfiguration.
      row.status = 'failed';
      row.reason = String((e as Error).message || 'Send failed').slice(0, 500);
      row.severity = 'temporary';
      failed++;
    }
    inserts.push(row);
  }

  // One insert for the batch. A failure to RECORD must not fail the response: the mail has gone by
  // this point, and an error here would invite the host to send the whole lot again.
  try { if (inserts.length) await db.insert(guestInvites).values(inserts); }
  catch (e) { console.error('[invites] could not record sends', e); }

  res.json({ sent, failed, skipped, noAddress, ...(await listPayload(ev.id)) });
});

/** The send history for one event, newest first. */
router.get('/:joinCode/invites', requireOrganizer, async (req: Request, res: Response) => {
  const p = await listPayload(req.event!.id);
  res.json({ invites: p.invites, deliveryTracking: p.deliveryTracking });
});

// ── The webhook ──────────────────────────────────────────────────────────────

/** Mailgun's delivery events. Public by necessity, and therefore verified before anything else.
 *
 *  Mounted separately in index.ts rather than on this organizer-gated router, because it is called
 *  by Mailgun — which has no organizer code and no idea which event a message belonged to. The
 *  message itself carries that, in the custom variable attached when we sent it.
 *
 *  On status codes, which matter more here than usual. Mailgun retries ANY non-2xx for about eight
 *  hours, and treats 406 as "rejected, do not retry". So:
 *    200 — handled, or deliberately ignored. Stop.
 *    406 — we will never accept this. A bad signature is permanent: retrying changes nothing, and
 *          eight hours of retries against forged traffic is a free amplifier.
 *    5xx — WE failed (the database was down). Please retry: that ladder is the only thing standing
 *          between a transient blip and permanently losing a bounce. */
export async function mailgunWebhookHandler(req: Request, res: Response) {
  // No signing key ⇒ this endpoint does not exist. Answering anything else advertises an
  // unverifiable webhook receiver to anyone scanning for one.
  if (!webhookConfigured()) return res.status(404).end();

  const body = req.body as { signature?: Record<string, unknown>; 'event-data'?: unknown };
  const sig = body?.signature || {};
  const check = verifySignature(sig);
  if (!check.ok) {
    // Loud, because the two causes look identical from here and call for opposite responses:
    // somebody is forging events, or MAILGUN_WEBHOOK_SIGNING_KEY is wrong and every delivery event
    // on this deployment is being thrown away.
    console.error(`[mailgun] REJECTED webhook: ${check.reason}`);
    return res.status(406).json({ error: 'signature verification failed' });
  }

  const token = String(sig.token);
  // Already handled. Acknowledged, not rejected — this is a retry of something that worked, and a
  // 406 here would be telling Mailgun off for doing exactly what it should.
  if (tokenSeen(token)) return res.json({ ok: true, duplicate: true });

  const ev = normaliseEvent(body['event-data']);
  if (!ev) { rememberToken(token); return res.json({ ok: true, ignored: 'unreadable' }); }
  if (!ev.status) { rememberToken(token); return res.json({ ok: true, ignored: ev.name }); }

  const address = ev.recipient ? normaliseAddress(ev.recipient) : null;

  try {
    // Find the send this is about. The token is the primary join key; the message id is the
    // fallback for an event that lost it (Mailgun truncates user-variables past 4KB, and a message
    // sent by an older version of this code carries none at all).
    let invite = ev.inviteToken
      ? (await db.select().from(guestInvites).where(eq(guestInvites.token, ev.inviteToken)))[0]
      : undefined;
    if (!invite && ev.messageId)
      invite = (await db.select().from(guestInvites)
        .where(eq(guestInvites.providerMessageId, ev.messageId))
        .orderBy(desc(guestInvites.sentAt)).limit(1))[0];

    if (invite) {
      const current = invite.status as DeliveryStatus;
      if (shouldApply(current, ev.status, ev.at, invite.eventAt)) {
        await db.update(guestInvites).set({
          status: ev.status,
          reason: ev.reason,
          severity: ev.severity,
          eventAt: ev.at,
          updatedAt: Date.now(),
          // Backfill the id when the send response never gave us one — it is how a host looks the
          // message up in Mailgun's own logs for more than we recorded.
          providerMessageId: invite.providerMessageId || ev.messageId,
        }).where(eq(guestInvites.id, invite.id));
      }
    }

    // Suppression is applied from the EVENT, not from the row update above — deliberately. A bounce
    // for a message we cannot match to a row is still a bounce, and the address is still dead;
    // refusing to record it because the join failed would let exactly the addresses we have lost
    // track of go on being mailed. This is also why the table is keyed by address and has no event:
    // it is a fact about the address, independent of anything we sent.
    const reason = suppressionReason(ev.status);
    if (reason && address) {
      await db.insert(emailSuppressions)
        .values({ email: address, reason, detail: ev.reason, createdAt: Date.now() })
        // First one wins. The original bounce carries the useful reason; a later complaint from the
        // same address should not overwrite "550 no such user" with nothing.
        .onConflictDoNothing();
      if (!invite) console.warn(`[mailgun] ${ev.status} for ${address} matched no invite — address suppressed anyway`);
    }
  } catch (e) {
    // Do NOT remember the token: this needs to come back. Mailgun's retry ladder is the recovery
    // path for precisely this, and caching the token here would turn a ten-second database hiccup
    // into a bounce we never learn about.
    console.error('[mailgun] webhook processing failed', e);
    return res.status(500).json({ error: 'could not process' });
  }

  rememberToken(token);
  res.json({ ok: true });
}

export default router;
