// Reading a guest list out of whatever the host already has it in.
//
// DECISION: CSV (and tab-separated) only — no .xlsx reader, deliberately.
//
// A spreadsheet library is a big, awkward dependency for this: .xlsx is a zip of XML, so it needs
// a zip reader and an XML parser in a container that currently ships neither, and the popular
// JavaScript reader has a long history of prototype-pollution and ReDoS advisories while being
// distributed outside npm. That is a lot of attack surface and image weight to accept for a file
// format that is one click from CSV in every program that produces it.
//
// It also would not buy much. The way people actually move a list is to SELECT THE CELLS AND PASTE
// THEM, and what lands on the clipboard from Excel, Numbers and Google Sheets is TAB-separated
// text. That path is handled here, so "I have it in Excel" already works without .xlsx ever being
// involved. If a host does upload a real .xlsx the route says so plainly and tells them to
// File → Save As → CSV, which is a better outcome than a half-working binary parser.
//
// Everything in this file is pure: text in, rows out, no database and no I/O. That is what makes
// the preview the host approves and the import that is committed provably the same computation —
// the route runs exactly these functions over exactly the same text.
//
// The one import is normaliseAddress, and it is the point rather than an exception: delivery.ts is
// itself pure policy with no imports of its own, and an ADDRESS HAS TO MEAN THE SAME THING HERE AS
// IT DOES AT THE ADD FORM. This module used to spell the rule as `rawEmail.toLowerCase()` while
// routes/guests.ts spelled it as normaliseAddress(), which differ over a trailing dot — so
// `mum@example.com.` typed into the form and the identical cell imported from a spreadsheet became
// TWO rows for one person, past both dedupe checks and past the unique index. One definition, in
// the file that documents why each part of it exists.
import { normaliseAddress } from './delivery';

/** Hard ceiling on one import. Past this it is not a guest list, it is a mailing list, and this
 *  feature is not that. The route refuses rather than silently truncating. */
export const MAX_IMPORT_ROWS = 2000;

/** Per-field caps, applied by truncation with a note on the row rather than rejection. A 300-
 *  character name is a malformed export, not a reason to throw away the other 199 guests. */
export const FIELD_MAX = { name: 120, email: 200, notes: 500 } as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The same shape the rest of the server uses, kept local rather than imported from a route. */
export const isEmail = (s: string): boolean => s.length <= FIELD_MAX.email && EMAIL_RE.test(s);

/** Something-@-something: a cell nobody types as a COLUMN LABEL.
 *
 *  DELIBERATELY WIDER THAN isEmail, and that width is the whole fix. Row 1 used to be called DATA
 *  only when it held a VALID address, so a guest whose address had one typo in it (`nan@example`,
 *  no TLD) or was blank failed the test, row 1 was eaten as the column-name row, and that guest
 *  reached no count and no row — a three-person paste reported "Imported 2 guests" and said nothing
 *  else. Validity is a question about whether we can MAIL the cell; it has no bearing on whether
 *  the line is a guest, and answering the second question with the first is what lost the guest.
 *
 *  A non-space, non-@ character is required on BOTH sides, so this recognises `nan@example` and
 *  `mum@example.com.` while a header literally called "Email@" or "@" is still a header. A typo'd
 *  address now arrives as a VISIBLE invalid row, named and counted, which is the outcome the whole
 *  preview exists for. */
export const looksAddress = (s: string): boolean => /[^\s@]@[^\s@]/.test(s);

/** WHY A PHONE NUMBER IS RECOGNISED HERE AND STORED NOWHERE.
 *
 *  Snapdini reaches a guest by EMAIL and by nothing else — the guest list exists to send a lot of
 *  people a link, not to run an invitation process. A phone number is therefore a field no part of
 *  this product can act on, and keeping personal data we have no use for is precisely what data
 *  minimisation forbids. This product ships a privacy impact assessment (docs/PIA-face-matching.md),
 *  so that is a commitment rather than a preference. The column was dropped in
 *  0053_guest_drop_phone.sql. Do not re-add it "for completeness".
 *
 *  Contrast `notes`, which stays. A note is RENDERED BACK TO THE HOST in the guest row, so being
 *  read is the thing it does — it passes the test phone fails. That distinction, not tidiness, is
 *  the reason for the asymmetry.
 *
 *  Detecting a number is still needed, and both jobs are about READING the host's file rather than
 *  storing anything out of it:
 *    · a phone-shaped cell in row 1 proves row 1 is DATA and not column names (see parseCsv);
 *    · a phone column must resolve to 'ignore' — identified and skipped — so that an ordinary
 *      `Name,Email,Phone` spreadsheet still pastes cleanly and a column of numbers is never
 *      mistaken for a column of names. A host who wants the digits kept can map that column to
 *      `notes` by hand: that is their call to make, not ours to make for them.
 *
 *  Phone-SHAPED, which is a different question from phone-valid. Its only job is to decide which
 *  COLUMN a value belongs to, so a mistyped number is still obviously a phone number. The 6-digit
 *  floor is what keeps a table number, a row index and an age out of it; the 15-digit ceiling is
 *  E.164's own. Letters anywhere disqualify it, which separates "0400 000 000" from "table 4". */
const PHONE_RE = /^[+(]?\d[\d\s().+-]*$/;
/** A bound for DETECTION only, deliberately not a member of FIELD_MAX: nothing stores a phone
 *  number, so there is no storage cap for this to be. */
const PHONE_DETECT_MAX = 40;
export const looksPhone = (s: string): boolean => {
  if (s.length > PHONE_DETECT_MAX || !PHONE_RE.test(s)) return false;
  const digits = s.replace(/\D/g, '').length;
  return digits >= 6 && digits <= 15;
};

// ── Delimiter ────────────────────────────────────────────────────────────────

/** Comma, semicolon or tab, chosen by counting them OUTSIDE quotes on the first few lines.
 *
 *  All three are real: comma is the format's name, semicolon is what Excel writes in locales where
 *  the comma is the decimal separator (most of Europe), and tab is what the clipboard carries when
 *  someone pastes cells straight out of a spreadsheet — which is the single most common way this
 *  feature will actually be used.
 *
 *  Counting only outside quotes matters: `"Smith, Jane"\t"jane@x.com"` has more commas than tabs,
 *  and picking the comma would split the name in half. */
export function sniffDelimiter(text: string): string {
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  let lines = 0;
  for (let i = 0; i < text.length && lines < 5; i++) {
    const c = text[i];
    if (c === '"') { quoted = !quoted; continue; }
    if (quoted) continue;
    if (c === '\n') { lines++; continue; }
    if (c in counts) counts[c]++;
  }
  // Tab wins ties over semicolon, which wins over comma: a tab is almost never incidental in a
  // pasted list, whereas a comma appears inside ordinary names and notes.
  const best = (['\t', ';', ','] as const).reduce((a, b) => (counts[b] > counts[a] ? b : a), '\t');
  return counts[best] > 0 ? best : ',';
}

// ── The parser ───────────────────────────────────────────────────────────────

export interface CsvTable {
  headers: string[];
  rows: string[][];
  delimiter: string;
  /** True when row 1 looks like DATA rather than column names — it holds an address-SHAPED or
   *  phone-shaped cell. A host who pastes a selection without the header row is a completely
   *  ordinary mistake, and silently eating their first guest as a header is the worst possible
   *  response to it. When this is FALSE, row 1 is still reported: buildImport returns it as a
   *  skipped row carrying HEADER_CONSUMED, so it is counted and on screen either way. */
  headerless: boolean;
  /** The scan stopped early because the file is past the `maxRows` it was given, so `rows` holds a
   *  PREFIX of the file and nothing else here can be trusted to describe it. Always false when no
   *  `maxRows` was passed. */
  overflow: boolean;
}

/** RFC 4180-ish reader: quoted fields, embedded delimiters, embedded newlines, `""` for a literal
 *  quote, CR/LF/CRLF line endings, and a leading UTF-8 BOM (which Excel writes and which would
 *  otherwise become part of the first header's name, quietly breaking the auto-mapping). */
export function parseCsv(text: string, delimiter?: string, maxRows?: number): CsvTable {
  const src = text.replace(/^﻿/, '');
  const delim = delimiter || sniffDelimiter(src);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  // Non-blank rows seen so far, counted as they are completed rather than after the scan.
  //
  // WHY THE SCAN CAN STOP. The row-count check used to sit after a FULL parse, so the cost of
  // refusing a file was the cost of reading all of it: 2 MB of `a\n` is a million rows built and
  // thrown away, and the endpoint accepts a 2 MB body. Stopping at the limit makes the work bounded
  // by MAX_IMPORT_ROWS instead of by the body size, which is what the caller is actually allowed to
  // choose.
  //
  // BLANK ROWS ARE NOT COUNTED, because the cleanup below drops them and a host whose export has a
  // few empty lines in the middle of it must not be told their list is too long. That is also why
  // the caller passes a couple of rows of slack (see plan() in routes/guests.ts): a file at or under
  // the limit parses in full and still gets the exact-count message, and only a file genuinely past
  // it is cut short.
  let kept = 0;
  const overflow = () => maxRows !== undefined && kept > maxRows;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => {
    endField();
    if (row.some((c) => c.trim() !== '')) kept++;
    rows.push(row); row = [];
  };

  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        // A doubled quote inside a quoted field is one literal quote; a single one closes it.
        if (src[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      // A CRLF inside a quoted cell (what Excel writes for an in-cell line break) is normalised
      // to a plain newline, so the stored note does not carry stray carriage returns.
      if (c === '\r') { if (src[i + 1] === '\n') i++; field += '\n'; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { quoted = true; i++; continue; }
    if (c === delim) { endField(); i++; continue; }
    // All three line endings end a row: LF, CRLF, and a lone CR. The lone CR is not theoretical —
    // it is what a classic-Mac export and some older tools still write, and treating it as
    // whitespace (as an earlier version of this did) silently glued the ENTIRE file into one row,
    // which then parsed as a single guest with a hundred columns.
    if (c === '\r') { if (src[i + 1] === '\n') i++; endRow(); if (overflow()) break; i++; continue; }
    if (c === '\n') { endRow(); if (overflow()) break; i++; continue; }
    field += c; i++;
  }
  // A file ending in a newline must not produce a trailing empty row — otherwise every import
  // reports one more "blank row skipped" than the host can see in their own file.
  if (field !== '' || row.length) endRow();

  const cleaned = rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ''));

  const headers = cleaned.length ? cleaned[0] : [];
  // An ADDRESS-SHAPED or phone-shaped cell in row 1 proves that row is DATA: neither is anything a
  // person types as a column label. Before the phone half was here, a name-and-phone paste with no
  // header had its first guest eaten as the header row, silently, with no sign of it anywhere.
  //
  // ADDRESS-SHAPED, not address-VALID — see looksAddress(). Testing validity here is what dropped
  // a guest whose address had a typo in it, because "can we mail this" is a different question from
  // "is this line a guest", and only the second one is being asked.
  //
  // Only those two shapes, deliberately. A row of ordinary words is genuinely ambiguous — "Name"
  // and "Jo Smith" have the same shape — so a free-text row 1 is still read as a header. What is
  // no longer true is that such a row disappears: buildImport emits it as a skipped ROW with its
  // reason (see HEADER_CONSUMED), so it is in the preview, in the line numbering and in the counts,
  // and a host who disagrees with the guess can see exactly what happened.
  const headerless = headers.some((h) => looksAddress(h) || looksPhone(h));
  return {
    headers: headerless ? headers.map((_, n) => `Column ${n + 1}`) : headers,
    rows: headerless ? cleaned : cleaned.slice(1),
    delimiter: delim,
    headerless,
    // True only when the scan gave up. `rows` is then a PREFIX of the file and must not be imported
    // or previewed — the caller's job is to refuse, not to truncate.
    overflow: overflow(),
  };
}

// ── Column mapping ───────────────────────────────────────────────────────────

export type GuestField = 'name' | 'email' | 'notes' | 'ignore';

/** Headers that name a column we deliberately DO NOT import, matched BEFORE the hints below.
 *
 *  Phone only, for now — see looksPhone() for why the number is recognised and never stored. It is
 *  listed here rather than left to fall off the end of HEADER_HINTS so that the skip is a decision
 *  with a reason attached: "Mobile", "Cell" and "Number" are words that must never be allowed to
 *  drift into `name` or `notes` as someone widens a hint list later. */
const SKIP_HINTS: string[] = ['phone', 'mobile', 'cell', 'tel', 'number'];

/** Header text → field, by substring match on a normalised header. Substring rather than equality
 *  because real exports say "Email Address", "Guest Name", "Mobile Phone", "E-mail". */
const HEADER_HINTS: [GuestField, string[]][] = [
  ['email', ['email', 'e-mail', 'mail']],
  ['name',  ['name', 'guest', 'person', 'who']],
  ['notes', ['note', 'comment', 'remark', 'table', 'group', 'relation']],
];

/** How many rows the data inference reads. Enough that one odd row cannot decide a column, few
 *  enough that a 2000-row paste costs nothing to classify. */
const INFER_SAMPLE = 20;

/** What one cell looks like. 'text' is the catch-all: a name, a note, a table, a nickname.
 *
 *  'phone' is a SHAPE, not a field — there is no phone field any more. It stays in this union
 *  because a column of numbers still has to be told apart from a column of names in order to be
 *  skipped. */
type CellKind = 'email' | 'phone' | 'text';

const kindOf = (s: string): CellKind =>
  isEmail(s.toLowerCase()) ? 'email' : looksPhone(s) ? 'phone' : 'text';

/** What each column IS, decided by the MAJORITY of its non-empty values across a sample of rows.
 *
 *  Majority over a sample, not the first row: a list of twenty addresses with one typo in it is
 *  still the email column, and one phone number written into a notes cell must not turn that whole
 *  column into a skipped one. Reading only row 1 is how a single odd line mis-maps a column.
 *
 *  A column with nothing in it at all returns null and is mapped to nothing — an empty column is
 *  not a field, and guessing one would put every guest's name in the wrong place. */
function columnKinds(rows: string[][], width: number): (CellKind | null)[] {
  return Array.from({ length: width }, (_unused, i) => {
    const tally: Record<CellKind, number> = { email: 0, phone: 0, text: 0 };
    let seen = 0;
    for (const r of rows.slice(0, INFER_SAMPLE)) {
      const v = (r[i] || '').trim();
      if (!v) continue;
      seen++;
      tally[kindOf(v)]++;
    }
    if (!seen) return null;
    // Ties fall to the more specific kind (email, then phone, then text) — a column that is half
    // addresses is an address column with bad rows in it, not a free-text column.
    const best = (['email', 'phone', 'text'] as const).reduce((a, b) => (tally[b] > tally[a] ? b : a));
    return tally[best] * 2 >= seen ? best : 'text';
  });
}

/** Fill in the columns the header could not name, by looking at what is IN them.
 *
 *  This is the answer to "why doesn't it just detect two columns and work it out". A paste with no
 *  header row used to come back with every column set to 'ignore' and a fatal telling the host to
 *  map something — which is the machine asking a person to do the one thing the machine can see
 *  perfectly well for itself.
 *
 *  Ambiguity is resolved by preferring the LEFTMOST column and claiming each field exactly once:
 *   · two address columns — the first becomes `email` and the second is left alone. A second
 *     address is not a name and certainly not a note, so any guess puts an address in a field that
 *     is not for addresses; 'ignore' is the honest answer and one click fixes it.
 *   · no address column — then there is nothing importable at all, and buildImport says so ONCE
 *     rather than greying out two hundred rows for the same reason.
 *   · a phone column — detected, and claimed by nothing. It stays 'ignore' on purpose.
 *   · free text — the first is `name` (who the guest is), the second is `notes` (whatever the host
 *     wrote beside them). A third is ignored rather than invented.
 *
 *  None of it is final. It is a guess the host is SHOWN, next to a mapper they can change, which is
 *  why guessing beats refusing: a wrong guess costs one click, and a refusal cost the whole
 *  feature. */
function inferFromData(
  out: GuestField[], taken: Set<GuestField>, skip: Set<number>, rows: string[][],
): void {
  if (!rows.length) return;
  const kinds = columnKinds(rows, out.length);
  const open = (want: CellKind) =>
    kinds.findIndex((k, n) => k === want && out[n] === 'ignore' && !skip.has(n));
  const claim = (field: GuestField, want: CellKind) => {
    if (taken.has(field)) return;
    const i = open(want);
    if (i >= 0) { out[i] = field; taken.add(field); }
  };
  // The address first: it is the only kind a value can PROVE it is that we also store, so it
  // should claim its column before free text gets a chance to be called a name.
  claim('email', 'email');
  // A phone-shaped column is claimed by NOTHING and is left at 'ignore'. That is the point of
  // detecting it, not an omission — and because 'phone' is a kind no field asks for, the two
  // claims below can never mistake a column of numbers for a name or a note.
  claim('name', 'text');
  claim('notes', 'text');
}

/** A first guess at which column is which, which the host then corrects in the preview.
 *
 *  A guess, not a decision: the preview is where the mapping is confirmed, and this exists only so
 *  the common spreadsheet needs no clicking at all. Each field is claimed by at most one column —
 *  a sheet with both "Name" and "First Name" must not map both onto `name` and have the second
 *  silently win.
 *
 *  Pass `rows` to let the DATA have a say where the header could not. It runs in two situations
 *  that are really one situation — the host's columns are not labelled in a way we recognise:
 *    · a headerless paste, where the labels are synthetic ("Column 1") and match nothing;
 *    · a header row whose names we do not know ("Col A", "Guests 2026", a foreign-language export).
 *  Both used to end at the same dead end, and both are answerable by reading the values. Header
 *  names still win where they are recognised — a column the host LABELLED "Email" is not a guess. */
export function guessMapping(headers: string[], rows: string[][] = []): GuestField[] {
  const taken = new Set<GuestField>();
  const out: GuestField[] = headers.map(() => 'ignore');
  const norm = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');

  // Columns the host LABELLED as something we do not import. Held in their own set rather than
  // written into `out`, because 'ignore' in `out` means "nothing has claimed this column yet" and
  // the passes below would simply go and claim it.
  const skip = new Set<number>();
  headers.forEach((h, i) => { if (SKIP_HINTS.some((s) => norm(h).includes(s))) skip.add(i); });

  // Two passes so an exact-ish match ("email") claims the field before a loose one ("mail merge").
  for (const exact of [true, false]) {
    headers.forEach((h, i) => {
      if (out[i] !== 'ignore' || skip.has(i)) return;
      const n = norm(h);
      for (const [field, hints] of HEADER_HINTS) {
        if (taken.has(field)) continue;
        const hit = hints.some((hint) => {
          const hn = norm(hint);
          return exact ? n === hn : n.includes(hn);
        });
        if (hit) { out[i] = field; taken.add(field); return; }
      }
    });
  }
  inferFromData(out, taken, skip, rows);
  return out;
}

// ── Building the import ──────────────────────────────────────────────────────

export interface DraftGuest { name: string | null; email: string | null; notes: string | null }

/** What the preview shows for one line of the file, and what the commit acts on.
 *
 *  'skip' rows are shown to the host greyed out rather than hidden. A file where 40 of 200 rows
 *  are duplicates is a file the host needs to LOOK at — telling them "160 imported" and nothing
 *  else is how someone discovers at the party that half their guests were never invited.
 *
 *  EVERY non-blank line of the file is one of these, including line 1 when it was consumed as the
 *  column-name row (HEADER_CONSUMED). There is no line the host can see in their own file that has
 *  no row here. */
export interface ImportRow {
  /** 1-based row number in the host's own file, header included, so it matches what they see when
   *  they open it. */
  line: number;
  guest: DraftGuest;
  action: 'add' | 'skip';
  /** Why, in words meant for the host. Empty on a clean row. */
  problems: string[];
}

export interface ImportPlan {
  rows: ImportRow[];
  /** `noEmail` is counted apart from `skip` on purpose. A host pasting a spreadsheet where half the
   *  people have no address must see THAT number, not a lump labelled "skipped" that reads like
   *  blank lines and duplicates. It is the one skip reason they can act on — print those people a
   *  card — so it is the one that gets its own word in the tally. */
  counts: { add: number; skip: number; duplicate: number; invalid: number; noEmail: number };
  /** Set when the mapping cannot produce anything usable — no column is mapped to Email, so every
   *  row would be skipped for the same reason. Worth saying once, loudly, rather than 200 times. */
  fatal: string | null;
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/** Why line 1 is not a guest, when it was read as the column-name row.
 *
 *  It is a ROW with a REASON rather than an absence, and the difference is the whole defect. A
 *  consumed row 1 reached no count at all: `counts` described the file minus its first line, so a
 *  three-person paste answered "Imported 2 guests" and nothing anywhere mentioned the third
 *  person. Being a row puts it in `rows`, in the line numbering the host recognises, and in
 *  `counts.skip` — which is what makes the tally agree with the lines on screen instead of
 *  describing a different file.
 *
 *  It also says what to DO, because this is the one skip the host can be wrong about: the guess is
 *  right for a real header and wrong for a guest called "Nan" with no address beside her, and the
 *  fix for the second case is a header row of their own. */
export const HEADER_CONSUMED =
  'Read as the column names, not a guest — not imported. If this line is a guest, put a header row above it.';

/** Turn a parsed table plus a column mapping into the exact list of rows that will be written.
 *
 *  AN EMAIL ADDRESS IS REQUIRED, and that is what makes this function as short as it is. The guest
 *  list exists so a host can mail a lot of people one link; a row with no address is a row nothing
 *  here can ever send to, and the host already has an answer for those people — hand them a printed
 *  card, or message them directly. This is not an invitation planner.
 *
 *  It also collapses the duplicate check to ONE rule. There used to be a second, `identityKey()`,
 *  keying an address-less guest on their name plus their note, with a genuine trade-off in it about
 *  two guests really called "John Smith". With an address on every row that mechanism has nothing
 *  left to match, so dedupe is now exactly the unique index the database already enforces on
 *  (event_id, lower(email)) — one rule, in one place, agreed on by the preview and the table.
 *
 *  `existingEmails` is the addresses already on this event's guest list, lower-cased. Duplicates
 *  are skipped rather than merged or overwritten: the row already on the list may have been edited
 *  by hand since, and a re-import of the same spreadsheet must not quietly undo that.
 *
 *  Nothing here throws. A malformed row becomes a skipped row with a reason attached — the whole
 *  point is that one bad line out of two hundred does not cost the host the other hundred and
 *  ninety-nine, and that the ones it did cost are VISIBLE. */
export function buildImport(
  table: CsvTable,
  mapping: GuestField[],
  existingEmails: Iterable<string> = [],
): ImportPlan {
  const col = (f: GuestField) => mapping.indexOf(f);
  const iName = col('name'), iEmail = col('email'), iNotes = col('notes');

  // No email column ⇒ every row would be skipped for the same reason. Said once, above a mapper the
  // host can fix it with, rather than two hundred identical grey rows.
  if (iEmail < 0) {
    return { rows: [], counts: { add: 0, skip: 0, duplicate: 0, invalid: 0, noEmail: 0 },
             fatal: 'Map a column to Email — that is how the join link is sent, so every guest needs one.' };
  }

  // normaliseAddress on BOTH sides, and on the same rule the add form writes with: the stored
  // addresses being compared here were written by it, so anything else compares two spellings of
  // one inbox and calls them two people.
  const already = new Set<string>();
  for (const e of existingEmails) already.add(normaliseAddress(e));
  const seenInFile = new Set<string>();

  const rows: ImportRow[] = [];
  let duplicate = 0, invalid = 0, noEmail = 0;

  // EVERY non-blank line of the host's file, line 1 included. A consumed header row used to be
  // dropped here — `table.rows` is already `cleaned.slice(1)` — and dropping it is what let a guest
  // vanish between the file and the result with no count mentioning them. Putting it back means
  // `line` is simply the 1-based index again, in both shapes, rather than an offset that has to be
  // reasoned about.
  const lines = table.headerless ? table.rows : [table.headers, ...table.rows];

  lines.forEach((cells, n) => {
    const line = n + 1;
    const at = (i: number) => (i >= 0 && i < cells.length ? cells[i].trim() : '');
    const problems: string[] = [];

    const rawName = at(iName);
    const rawEmail = at(iEmail);
    const rawNotes = at(iNotes);

    // Line 1, read as the column names. A skip with a reason, and NOTHING below runs for it: a
    // header is not a malformed address (`invalid`), not a guest without one (`noEmail`) and not a
    // duplicate of anybody, so counting it as any of those would trade one wrong number for
    // another. It lands in `counts.skip` alone, which is the honest description of it.
    if (!table.headerless && n === 0) {
      rows.push({
        line,
        // The cells verbatim, so the host sees their own line 1 rather than a blank row: "Name ·
        // Email" for a real header, and "Nan · —" for the case where the guess is wrong.
        guest: {
          name: rawName ? clip(rawName, FIELD_MAX.name) : null,
          email: rawEmail ? clip(rawEmail, FIELD_MAX.email) : null,
          notes: rawNotes ? clip(rawNotes, FIELD_MAX.notes) : null,
        },
        action: 'skip',
        problems: [HEADER_CONSUMED],
      });
      return;
    }

    for (const [label, raw, max] of [['Name', rawName, FIELD_MAX.name],
                                     ['Notes', rawNotes, FIELD_MAX.notes]] as const) {
      if (raw.length > max) problems.push(`${label} was longer than ${max} characters and has been shortened`);
    }

    let email: string | null = null;
    if (rawEmail) {
      // THE canonical form, from delivery.ts — the same function the add form writes through. It
      // was `rawEmail.toLowerCase()`, which agreed with it on everything but a trailing dot, and
      // that one disagreement put `mum@example.com.` and `mum@example.com` on one list as two
      // rows: past this dedupe, past the form's, and past the unique index on
      // lower(btrim(email)) — which sees exactly the bytes a writer stores, so whatever the
      // writers disagree about, the database cannot catch.
      const lower = normaliseAddress(rawEmail);
      if (!isEmail(lower)) {
        // Skipped, and named. The guest cannot be mailed without a working address, so importing
        // them would put a row on the list that no send will ever reach — but the host is shown the
        // exact text that failed, on its own greyed line, which is what they need to fix the typo
        // in their file and import again.
        problems.push(`"${clip(rawEmail, 60)}" is not a valid email address — skipped`);
        invalid++;
      } else {
        email = lower;
      }
    }

    const guest: DraftGuest = {
      name: rawName ? clip(rawName, FIELD_MAX.name) : null,
      email,
      notes: rawNotes ? clip(rawNotes, FIELD_MAX.notes) : null,
    };

    let action: ImportRow['action'] = 'add';
    // Tested on the RAW cells, not on the cleaned guest: a row carrying nothing but a typo'd
    // address is not an empty row, and telling the host "nothing in the mapped columns" about a
    // line they can plainly see has something in it is how a real reason gets lost.
    if (!rawName && !rawEmail && !rawNotes) {
      action = 'skip';
      problems.push('Nothing in the mapped columns — skipped');
    } else if (!email) {
      action = 'skip';
      // An address that was present but malformed already said so above, in the host's own text.
      // Counted apart from `noEmail` because the two need different things done about them: a typo
      // is fixed in the file, a missing address means that person gets a printed card instead.
      if (!rawEmail) { problems.push('No email address — skipped'); noEmail++; }
    } else if (already.has(email)) {
      action = 'skip';
      problems.push('Already on the guest list — skipped');
      duplicate++;
    } else if (seenInFile.has(email)) {
      action = 'skip';
      problems.push('Appears more than once in this file — skipped');
      duplicate++;
    }

    if (action === 'add' && email) seenInFile.add(email);
    rows.push({ line, guest, action, problems });
  });

  const add = rows.filter((r) => r.action === 'add').length;
  return { rows, counts: { add, skip: rows.length - add, duplicate, invalid, noEmail }, fatal: null };
}
