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
import { MAIL_BATCH_SIZE } from '../../../../shared/mail-batch';
import { v4 as uuidv4 } from 'uuid';
import { and, eq, desc, inArray, sql } from 'drizzle-orm';
import { db, pgErrorCode, PG_NOT_NULL_VIOLATION, PG_UNIQUE_VIOLATION } from '../db';
import { events, eventGuests, guestInvites, emailSuppressions } from '../schema';
import { requireOrganizer } from './events';
import * as email from '../email';
import { baseUrl, isDemoEvent } from '../lib';
import { ACCOUNT_DAILY_RECIPIENTS, accountRecipientsInDay, eventInviteCap, eventInvitesEver } from '../email-budget';
import { parseCsv, guessMapping, buildImport, isEmail, MAX_IMPORT_ROWS, FIELD_MAX,
         type GuestField, type ImportRow, type CsvTable } from '../csv';
import { verifySignature, normaliseEvent, webhookConfigured, tokenSeen, rememberToken,
         INVITE_VAR, INVITE_TAG } from '../mailgun';
import { shouldApply, suppressionReason, normaliseAddress, type DeliveryStatus } from '../delivery';
import { blocksFor, maskAddress, partitionRecipients, unsubscribeHeaders,
         unsubscribePageUrl } from '../unsubscribe';
import { guestInviteEmail } from '../inline-emails';
import { SUPPORT_EMAIL } from '../email-theme';

const router = Router();

/** One press of "Send invites" mails at most this many people. Matches the existing gallery-blast
 *  ceiling, and bounds how long one request can hold a connection open — sends are sequential. */
const MAX_PER_SEND = MAIL_BATCH_SIZE;
/** A guest list is a party, not a mailing list. Past this the feature is being used for something
 *  it was not built for and will not do well. Enforced inside a row lock — see the seating note on
 *  the import commit — so it is a number the list cannot go past rather than one it is compared to. */
const MAX_GUESTS_PER_EVENT = 2000;

/** How many guest rows ONE READ returns. A bound on the payload, and deliberately NOT the cap.
 *
 *  It was `.limit(MAX_GUESTS_PER_EVENT)`, which meant the read hid exactly the rows a broken cap
 *  produces: a check-then-act race put 2008 guests on a 2000 list, and the eight past the line
 *  existed in the database while appearing in no response — so they could not be edited, invited or
 *  removed by the host they belonged to, and nothing on screen said they were there. The race is
 *  fixed below, and this is the other half of that fix: a limit set to the very number an invariant
 *  breach exceeds is a limit that conceals the breach. Well above the cap, so it still bounds the
 *  response for a pathological event while never being the reason a row is invisible. */
const GUEST_READ_LIMIT = MAX_GUESTS_PER_EVENT * 2;

/** ALPHABETICAL, and deterministic. Defined once and used by every read of the list, so the order
 *  the host sees is the order every other path agrees with.
 *
 *  Alphabetical because of what this list is FOR. A host opens it to find a person — "did I put
 *  Nan's address in?" — and creation order answers a question nobody asks. It was `created_at`,
 *  which is also why editing a guest appeared to move them: a bulk import writes its whole batch
 *  with ONE timestamp, `ORDER BY` over ties has no defined order in Postgres, and an UPDATE writes
 *  a new tuple that a heap scan then returns last. So the host edited a name and watched the row
 *  drop to the bottom of the list. Nothing was reordered; there was never an order to begin with.
 *
 *  Each term earns its place:
 *   · lower(name) — "alice" and "Alice" belong next to each other, not in separate byte ranges.
 *   · NULLS LAST, stated rather than assumed. A guest may legitimately have no name (an
 *     email-only import is supported), and the nameless must not pile up above everyone.
 *   · lower(email) second, so the nameless have a sensible order among themselves.
 *   · id LAST, and this is the term that actually kills the instability. Without a UNIQUE final
 *     key, two guests with the same name and address can still swap places on every edit. */
const GUEST_ORDER = [
  sql`lower(${eventGuests.name}) asc nulls last`,
  sql`lower(${eventGuests.email}) asc nulls last`,
  eventGuests.id,
];

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
    .orderBy(...GUEST_ORDER)
    .limit(GUEST_READ_LIMIT);

  // `id` LAST, for the same reason GUEST_ORDER ends with it. `sent_at` is not unique — a resend
  // double-tap, or one send loop writing its whole batch, lands several rows on the same
  // millisecond — and the pick below takes the FIRST row it sees per guest, so without a unique
  // final key which invite is "latest" is whatever order the scan happened to return. Observed
  // flipping between 'bounced' and 'delivered' across identical reads of one guest. A uuid is an
  // arbitrary tiebreaker but a STABLE one, and stability is the whole property being bought: the
  // host must not watch a delivery state change on its own.
  const invites = await db.select().from(guestInvites)
    .where(eq(guestInvites.eventId, eventId))
    .orderBy(desc(guestInvites.sentAt), desc(guestInvites.id))
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
      // normaliseAddress, not the raw stored value — the same key blocksFor() built the map with
      // and the same one partitionRecipients() looks up at send time. Reading it raw meant a guest
      // whose stored address was not in canonical form showed as perfectly mailable here and was
      // then refused by the send, which is the one place the two must never disagree: the host
      // presses Send on a list they were shown and some of it silently does not go.
      const sup = g.email ? blocked.get(normaliseAddress(g.email)) : undefined;
      return {
        id: g.id, name: g.name, email: g.email, notes: g.notes,
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

interface GuestBody { name?: unknown; email?: unknown; notes?: unknown }

/** Said by cleanGuest when the host left the address out, and by the catch below when the COLUMN
 *  refuses a null one — same refusal, so the same sentence. It names the fix rather than the rule:
 *  "email is required" leaves a host looking for the asterisk they missed, while this says what the
 *  address is FOR and what to do about the guest who hasn't got one. */
const NEEDS_EMAIL = 'Add an email address — that is how the join link is sent. Print a card for anyone without one.';

/** Trim, cap and normalise one submitted field set. Returns null for anything empty, because an
 *  empty string and "not given" are the same thing for every OPTIONAL field here, and storing both
 *  makes every later read test for two things.
 *
 *  The email is not optional, and the return type says so. This list exists to mail a lot of people
 *  one link: a row without an address is a row no send can ever reach, and the host's answer for
 *  those people is a printed card or a message of their own — not a database row here. */
function cleanGuest(b: GuestBody): { name: string | null; email: string; notes: string | null } | { error: string } {
  const pick = (v: unknown, max: number) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s ? s.slice(0, max) : null;
  };
  const name = pick(b.name, FIELD_MAX.name);
  const notes = pick(b.notes, FIELD_MAX.notes);
  const rawEmail = pick(b.email, FIELD_MAX.email);
  // Lower-cased on the way in, always. Every duplicate check and every suppression lookup in this
  // feature is a byte comparison, so an address stored with its original casing is an address that
  // silently escapes both.
  const address = rawEmail ? normaliseAddress(rawEmail) : null;
  if (address && !isEmail(address)) return { error: 'That does not look like an email address' };
  if (!address) return { error: NEEDS_EMAIL };
  return { name, email: address, notes };
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
  } catch (e) {
    // TWO things can refuse this insert, not one. The unique index on (event_id, lower(btrim(email)))
    // is the expected one; `email NOT NULL` (0054) is the other, and the catch that assumed only the
    // first reported a null address as "that email is already on this guest list" — sending the host
    // to hunt a duplicate that does not exist. cleanGuest refuses a missing address before either can
    // fire, so neither is reachable today; a second line of defence that answers the WRONG thing is
    // worth no more than one that answers nothing, and this is the cheap moment to fix it.
    //
    // Discriminated on SQLSTATE (see pgErrorCode in db.ts): the message text belongs to the server's
    // locale and version, the constraint NAME belongs to whichever migration last touched it, and the
    // code belongs to the standard.
    switch (pgErrorCode(e)) {
      case PG_UNIQUE_VIOLATION:
        return res.status(409).json({ error: 'That email is already on this guest list' });
      case PG_NOT_NULL_VIOLATION:
        // Same refusal cleanGuest makes, so the same words and the same 400: the host's fix is to
        // type an address, not to go looking for whoever already has this one.
        return res.status(400).json({ error: NEEDS_EMAIL });
      default:
        // Anything else is a fault. It belongs in the log and in a 500, not dressed up as a 409 the
        // host can do nothing about.
        throw e;
    }
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
  } catch (e) {
    // The same two failure modes as the insert above, and the same reason to tell them apart — an
    // UPDATE can violate the unique index and the NOT NULL column just as an INSERT can.
    switch (pgErrorCode(e)) {
      case PG_UNIQUE_VIOLATION:
        return res.status(409).json({ error: 'Another guest on this list already has that email' });
      case PG_NOT_NULL_VIOLATION:
        return res.status(400).json({ error: NEEDS_EMAIL });
      default:
        throw e;
    }
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
 *  malformed mapping costs a column rather than throwing.
 *
 *  The whole TABLE goes to the guess, not just the headers: with no header row (or with one whose
 *  names we do not recognise) the only thing that can say which column is which is what is in it.
 *  A mapping the client DID send is used verbatim — that is the host's own correction, and second-
 *  guessing it would make the mapper a suggestion box.
 *
 *  'phone' is deliberately NOT in `valid`: it is not a field any more (see looksPhone() in csv.ts),
 *  so an older client that still posts one has that column coerced to 'ignore' by the same rule
 *  that handles every other unrecognised value. The import succeeds and the numbers are skipped. */
function readMapping(raw: unknown, table: CsvTable): GuestField[] {
  const valid: GuestField[] = ['name', 'email', 'notes', 'ignore'];
  if (!Array.isArray(raw)) return guessMapping(table.headers, table.rows);
  return table.headers.map((_, i) => (valid.includes(raw[i] as GuestField) ? raw[i] as GuestField : 'ignore'));
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

  // The slack — two rows — is what lets the exact-count message below stay exact. A file AT the
  // limit has MAX_IMPORT_ROWS data rows plus possibly a header, so it must parse in full; one row
  // past that is enough to know the file is too long, and the parser stops there rather than
  // reading however many megabytes follow. See the note on `kept` in parseCsv.
  const table = parseCsv(text, undefined, MAX_IMPORT_ROWS + 2);
  if (!table.rows.length) return { error: 'No rows found in that' } as const;
  if (table.overflow)
    return { error: `That has more than ${MAX_IMPORT_ROWS} rows — the limit is ${MAX_IMPORT_ROWS}` } as const;
  if (table.rows.length > MAX_IMPORT_ROWS)
    return { error: `That has ${table.rows.length} rows — the limit is ${MAX_IMPORT_ROWS}` } as const;

  const mapping = readMapping(body.mapping, table);
  // ONE identity: the address. Every guest has one (the column is NOT NULL as of 0054), so a
  // re-import of the same spreadsheet is caught by the same key the unique index uses, and the
  // name+note fallback this used to need went with it — see buildImport().
  const existing = await db.select({ email: eventGuests.email })
    .from(eventGuests).where(eq(eventGuests.eventId, req.event!.id));
  return {
    table, mapping,
    plan: buildImport(table, mapping, existing.map((e) => e.email)),
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
  // `action: 'add'` implies an address — buildImport skips every row without one — but that
  // invariant lives in another module and the column is NOT NULL, so it is re-checked at the insert
  // rather than asserted through it. One bad row would otherwise take the whole batch down.
  const adding = p.plan.rows.filter((r: ImportRow) => r.action === 'add' && !!r.guest.email);
  if (n + adding.length > MAX_GUESTS_PER_EVENT)
    return res.status(400).json({ error: `That would take the list past ${MAX_GUESTS_PER_EVENT} people` });

  const now = Date.now();
  const values = adding.map((r) => ({
    id: uuidv4(), eventId: req.event!.id,
    name: r.guest.name, email: r.guest.email as string, notes: r.guest.notes,
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

// The invite itself lives in inline-emails.ts guestInviteEmail() — subject, HTML and text part
// together, built from raw values it escapes itself. It was a template literal here, which meant
// app/scripts/email-sampler.ts had to carry a second verbatim copy of it in order to render it,
// and there was nowhere to put the plain-text version of its sentences. Both are fixed by it being
// a builder. This route’s job is to decide WHO gets it and to record what happened.

// ── WHO IS ALLOWED TO PUT MAIL IN OTHER PEOPLE'S INBOXES ─────────────────────
//
// This is the only route in the product that sends caller-supplied text to caller-supplied
// addresses from a domain carrying our SPF, DKIM and DMARC. Everything above it — requireOrganizer,
// the suppression chokepoint, emailLimiter — was written for a leaked organizer code, and none of
// it noticed that the product HANDS OUT organizer codes: POST /api/events/demo mints an event with
// no account and no payment and returns its code to whoever asked. From there it is import 2000
// addresses, press Send, and the subject line is `You're invited to ${ev.name}` — eighty characters
// the caller chose. The tell was the asymmetry: a guest JOINING is gated on event.paid
// (routes/participants.ts), and sending was gated on nothing but the code.
//
// Four defences, narrowest first, and the order matters.
//
//  1. THE DEMO IS ANSWERED, NOT REFUSED — and it is checked FIRST, because every gate below would
//     otherwise refuse it. A demo exists to show a stranger what this product does, and a red error
//     on the one feature it is demonstrating is a worse outcome than the abuse we are stopping. So
//     a demo's send takes the same path, records the same rows and returns the same shape — and
//     never calls sendMail. See the DEMO branch in the loop below.
//  2. AN IDENTITY, NOT A CAPABILITY. An organizer code is a string that travels in links, group
//     chats and screenshots, and the demo endpoint gives one away on request; an account is a
//     verified address that can be suspended and talked to. Owner and accepted co-host both qualify
//     — a co-host was invited BY the owner, accepted with their own verified account, and manages
//     the event by identity exactly as the owner does (requireOrganizer has treated the two the
//     same since co-hosts existed); making them ask the owner to press Send would break a feature
//     whose whole point is sharing the work, and would buy nothing, because the co-host is just as
//     nameable as the owner. Everything ELSE an organizer code can do stays exactly as it was.
//  3. A LIFETIME CAP PER EVENT — three passes over the guest list (email-budget.ts).
//  4. A ROLLING DAILY CAP PER ACCOUNT — the backstop for someone who makes many events.
//
// 3 and 4 live in email-budget.ts because that module already owns "how much mail has this product
// sent", derived from these same rows. What it lacked was enforcement — its own comment said so:
// "'over' is reported, never enforced."
/** One invite, handed to the transport — or, for a DEMO event, handed to nothing at all.
 *
 *  THIS IS THE ONLY PLACE A DEMO'S SEND BECOMES A NON-SEND, and it takes the transport as a
 *  parameter for one reason: so that "a demo event reaches no transport" is something a test can
 *  OBSERVE rather than something a reader has to trace through a loop. Not a suppressed send, not
 *  a send to a black hole, not a send with a flag on it — sendMail is not called.
 *
 *  `null` means "nothing was sent, and that was deliberate", which is distinct from both a
 *  SendResult and a throw. The caller records it as `mailed: false` (0056). */
export async function deliverInvite(
  demo: boolean,
  msg: email.Mail,
  send: (m: email.Mail) => Promise<email.SendResult> = email.sendMail,
): Promise<email.SendResult | null> {
  if (demo) return null;
  return send(msg);
}

router.post('/:joinCode/guests/invite', requireOrganizer, async (req: Request, res: Response) => {
  if (!email.enabled) return res.status(503).json({ error: 'Email is not configured on this server' });
  const ev = req.event!;

  // A DEMO SENDS NOTHING. Resolved once, here, and carried through the handler — so the gate below,
  // the budgets and the loop all read one decision rather than three chances to disagree.
  const demo = isDemoEvent(ev);

  // The message is written for the person most likely to read it, who is not an attacker: a real
  // host on the manage link, signed out. It says what is wrong and what to do about it.
  if (!demo && req.organizerVia !== 'owner' && req.organizerVia !== 'cohost')
    return res.status(403).json({
      error: 'Sending invitations needs the host account. Sign in as the host (or as a co-host who '
        + 'has accepted their invitation) and try again — the organizer link can do everything else.',
      needsAccount: true,
    });

  const wanted = (req.body as { guestIds?: unknown }).guestIds;
  const ids = Array.isArray(wanted) ? wanted.filter((i): i is string => typeof i === 'string') : null;

  // THE WHOLE SELECTION, then one batch out of it — not a truncated selection, which is what this
  // was. `.limit(MAX_PER_SEND)` straight on the query meant a 250-guest list answered
  // `{ sent: 200, failed: 0, skipped: [] }`: fifty guests never touched, nothing in the response
  // with anywhere to say so, and a second press re-selecting the SAME two hundred because the
  // ordering is deterministic. MAX_GUESTS_PER_EVENT is 2000, so the product sells lists ten times
  // the batch — this is not an edge case, it is the tenth wedding.
  const selected = await db.select().from(eventGuests)
    .where(ids && ids.length
      ? and(eq(eventGuests.eventId, ev.id), inArray(eventGuests.id, ids.slice(0, MAX_GUESTS_PER_EVENT)))
      : eq(eventGuests.eventId, ev.id))
    .orderBy(...GUEST_ORDER)
    .limit(MAX_GUESTS_PER_EVENT);

  // There is no address-less guest to filter out or apologise for any more: every row on this list
  // has an address, enforced by the column and by cleanGuest(). What used to be reported back as
  // `noAddress` was a count that can only ever be zero.
  if (!selected.length) return res.status(400).json({ error: 'Nobody to send to' });

  // THE suppression check. Every send path in this feature goes through it, and it runs as one
  // query against the whole selection rather than per address — a per-address check is the kind of
  // thing that gets skipped "just for the resend button" and quietly un-protects the domain.
  // It covers both refusals: the global list (bounces, complaints, "never email me again") and the
  // people who asked to hear nothing more about THIS event.
  //
  // BEFORE the batch is cut, not after, and that ordering is load-bearing: an address that can
  // never be mailed must not hold a place in the batch. Cutting first meant a list whose first two
  // hundred entries had all bounced spent every press refusing the same two hundred, and the
  // guests at the end of the alphabet could never be reached at all.
  const blocked = await blocksFor(ev.id, selected.map((g) => g.email));
  const { mailable: reachable, skipped: refused } = partitionRecipients(selected, blocked);

  // ANYONE WHO HAS NEVER HAD ONE GOES FIRST, so pressing Send again reaches the people the last
  // press could not. Without this the batch is the same two hundred every time — the ordering is
  // deterministic — and the last fifty guests on a 250-person list can never be invited, however
  // many times the host presses. Within each group the order is still GUEST_ORDER, so the list the
  // host is looking at and the batch the server takes agree.
  //
  // Cheap: the guest list is capped at 2000 and the invite index is (event_id, sent_at), so this is
  // one indexed read and a partition in memory rather than a join that has to be got right.
  const priorRows = await db.select({ guestId: guestInvites.guestId }).from(guestInvites)
    .where(eq(guestInvites.eventId, ev.id));
  const invitedBefore = new Set(priorRows.map((r) => r.guestId).filter((id): id is string => !!id));
  //
  // A "send to everyone" press mails ONLY people who have never had one. Ordering the un-invited
  // first was meant to make repeated presses converge, and it does not: once they run out the batch
  // FILLS UP with people who already have an invite. On a 250-guest list press one mails 200 and
  // reports "50 still to go"; press two mails the 50 plus 150 second copies and still reports 50;
  // press three mails 200 duplicates. A host following the instruction on screen sends about 750
  // messages to 250 people and is then refused by the per-event cap and told to contact support.
  // `notSent` was the other half of it — measured against the whole reachable list, so it could
  // never reach zero and the instruction never went away.
  //
  // An EXPLICIT selection is deliberately left alone: choosing people by hand and pressing send
  // means "mail these", and that legitimately includes somebody who already has one.
  const fresh = reachable.filter((g) => !invitedBefore.has(g.id));
  const queue = ids && ids.length ? reachable : fresh;
  const mailable = queue.slice(0, MAX_PER_SEND);
  /** Mailable, and not attempted this press. `skipped` cannot hold these — it means "not mailed,
   *  and here is WHY" — so they are counted separately and the host is told to press again.
   *  Measured against the QUEUE, which is what "press again to finish" actually has left to do. */
  const notSent = queue.length - mailable.length;

  // ── The two budgets ────────────────────────────────────────────────────────
  // Counted against `mailable`, which is the number of people who would actually be mailed — not
  // the number asked for, and not the ones the suppression check already refused. A host is never
  // charged for a message the product declined to send.
  //
  // Refused WHOLE rather than sending the first N and stopping: a partial send leaves the host with
  // no way to know which half went, and "some of your guests were invited" is a worse thing to
  // discover on the day than "none were, here is who to ask".
  //
  // Skipped entirely for a demo, which sends nothing to charge for.
  if (!demo && mailable.length) {
    const [{ n: guestCount }] = await db.select({ n: sql<number>`count(*)::int` }).from(eventGuests)
      .where(eq(eventGuests.eventId, ev.id));
    const cap = eventInviteCap(Number(guestCount));
    const already = await eventInvitesEver(ev.id);
    if (already + mailable.length > cap)
      return res.status(429).json({
        error: `This event has now sent ${already} invitations, which is as many as one event can `
          + `send (${cap} for a list of ${guestCount}). Nothing was sent. If you still need to reach `
          + `your guests, email ${SUPPORT_EMAIL} and we will sort it out.`,
      });

    // The account cap needs an account. An event that reached here has one — the gate above admits
    // only an owner or a co-host, and both imply an owner — so the conditional is a type guard
    // rather than a real branch, and a missing owner is treated as "no budget to spend" instead of
    // silently skipping the backstop.
    if (ev.ownerUserId) {
      const today = await accountRecipientsInDay(ev.ownerUserId, Date.now());
      if (today + mailable.length > ACCOUNT_DAILY_RECIPIENTS)
        return res.status(429).json({
          error: `This account has emailed ${today} people in the last 24 hours, which is the daily `
            + `limit (${ACCOUNT_DAILY_RECIPIENTS}). Nothing was sent. Try again tomorrow, or email `
            + `${SUPPORT_EMAIL} if you have a genuinely large event coming up.`,
        });
    }
  }

  const base = baseUrl(req);
  const joinUrl = base + (ev.slug ? `/e/${ev.slug}` : `/join/${ev.joinCode}`);
  const now = Date.now();

  const inserts: (typeof guestInvites.$inferInsert)[] = [];
  // Not silently. The host is told, by address and by reason, that these people were not mailed.
  // "We sent 19 of your 20" with no explanation is how a guest ends up never being invited and
  // nobody finding out until the day.
  const skipped: { email: string; name: string | null; reason: string }[] = refused.map((r) => ({
    email: r.guest.email, name: r.guest.name, reason: r.block.reason,
  }));
  let sent = 0, failed = 0;

  for (const g of mailable) {
    const address = g.email;

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
    // Built per guest: the greeting is their name and the unsubscribe link carries THEIR token.
    // Subject, HTML and text part come out of the one builder, so the three encodings of the event
    // name (raw in the subject, escaped in the markup, raw again in the text) cannot drift apart.
    const msg = guestInviteEmail({
      eventName: ev.name, guestName: g.name, joinCode: ev.joinCode,
      joinUrl, unsubUrl: unsubscribePageUrl(base, token),
    });
    try {
      const r = await deliverInvite(demo, {
        to: address, subject: msg.subject, html: msg.html, text: msg.text,
        variables: { [INVITE_VAR]: token },
        tag: INVITE_TAG,
        // Both halves, because they serve different people. The header is what a mail client turns
        // into its own one-press unsubscribe, sitting beside the report-spam button; the body link
        // is for the guest who wants to choose between this event and all of it. These are cold
        // addresses off a host's spreadsheet — without an unsubscribe the only lever the recipient
        // has is "mark as spam", and that one is charged to our sending reputation.
        headers: unsubscribeHeaders(base, token),
        // Scopes the chokepoint's own re-check to this event, so the backstop asks exactly the
        // question the batch check above asked — global list AND this event's opt-outs. Without it
        // the two disagree, and the weaker one is the one standing closest to the send.
        eventId: ev.id,
      });
      // ── A DEMO EVENT SENT NOTHING. READ THIS BEFORE COPYING ANY OF IT. ──
      //
      // `msg` was built above and deliberately thrown away; deliverInvite() did not call the
      // transport. A demo event is minted by an unauthenticated POST and its organizer code is
      // handed to whoever asked for it, so "a demo can mail arbitrary addresses" and "the demo is
      // public" cannot both be true. This is which one gives.
      //
      // The RECORD is written anyway and counted as `sent`, because showing the feature working is
      // the demo's entire job: the visitor presses Send, the list says delivered, and the manager
      // view they are being shown is the real one. NOTHING IN THE RESPONSE SAYS ANY OF THIS — the
      // caller cannot tell a demo's send from a real one and is not meant to be able to.
      //
      // `mailed: false` is where the truth lives (0056): not in a response, in the row. It is the
      // only marker, and email-budget.ts — the only global reader of this table — filters on it, so
      // a demo's fake sends never move the operator's allowance figure. providerMessageId stays
      // null, so no inbound delivery webhook can ever match one of these rows either.
      if (r === null) {
        row.mailed = false;
        sent++;
        inserts.push(row);
        continue;
      }
      row.provider = r.provider;
      row.providerMessageId = r.messageId;
      if (r.suppressed) {
        // The batch check said mailable and the chokepoint said no: somebody unsubscribed in the
        // seconds between. The chokepoint wins. Recording this as 'sent' would show the host a
        // delivery that never happened and leave the guest looking invited — so it is recorded in
        // the vocabulary that already exists for it, and reported beside the ones the batch caught.
        row.status = 'unsubscribed';
        skipped.push({ email: address, name: g.name, reason: 'unsubscribed' });
      } else {
        sent++;
      }
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

  res.json({ sent, failed, notSent, perSend: MAX_PER_SEND, skipped, ...(await listPayload(ev.id)) });
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
      // Masked — same helper as the HTTP responses. This line is reached from an UNAUTHENTICATED,
      // unrate-limited webhook, so it is also the log line most easily made to write whatever the
      // caller likes; the less of a real address it carries the better.
      if (!invite) console.warn(`[mailgun] ${ev.status} for ${maskAddress(address)} matched no invite — address suppressed anyway`);
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
