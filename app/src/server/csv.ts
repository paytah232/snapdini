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

/** Hard ceiling on one import. Past this it is not a guest list, it is a mailing list, and this
 *  feature is not that. The route refuses rather than silently truncating. */
export const MAX_IMPORT_ROWS = 2000;

/** Per-field caps, applied by truncation with a note on the row rather than rejection. A 300-
 *  character name is a malformed export, not a reason to throw away the other 199 guests. */
export const FIELD_MAX = { name: 120, email: 200, phone: 40, notes: 500 } as const;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The same shape the rest of the server uses. Kept local so this module imports nothing. */
export const isEmail = (s: string): boolean => s.length <= FIELD_MAX.email && EMAIL_RE.test(s);

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
  /** True when row 1 looks like DATA rather than column names (it contains an email address).
   *  A host who pastes a selection without the header row is a completely ordinary mistake, and
   *  silently eating their first guest as a header is the worst possible response to it. */
  headerless: boolean;
}

/** RFC 4180-ish reader: quoted fields, embedded delimiters, embedded newlines, `""` for a literal
 *  quote, CR/LF/CRLF line endings, and a leading UTF-8 BOM (which Excel writes and which would
 *  otherwise become part of the first header's name, quietly breaking the auto-mapping). */
export function parseCsv(text: string, delimiter?: string): CsvTable {
  const src = text.replace(/^﻿/, '');
  const delim = delimiter || sniffDelimiter(src);

  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;

  const endField = () => { row.push(field); field = ''; };
  const endRow = () => { endField(); rows.push(row); row = []; };

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
    if (c === '\r') { if (src[i + 1] === '\n') i++; endRow(); i++; continue; }
    if (c === '\n') { endRow(); i++; continue; }
    field += c; i++;
  }
  // A file ending in a newline must not produce a trailing empty row — otherwise every import
  // reports one more "blank row skipped" than the host can see in their own file.
  if (field !== '' || row.length) endRow();

  const cleaned = rows
    .map((r) => r.map((c) => c.trim()))
    .filter((r) => r.some((c) => c !== ''));

  const headers = cleaned.length ? cleaned[0] : [];
  const headerless = headers.some((h) => EMAIL_RE.test(h));
  return {
    headers: headerless ? headers.map((_, n) => `Column ${n + 1}`) : headers,
    rows: headerless ? cleaned : cleaned.slice(1),
    delimiter: delim,
    headerless,
  };
}

// ── Column mapping ───────────────────────────────────────────────────────────

export type GuestField = 'name' | 'email' | 'phone' | 'notes' | 'ignore';

/** Header text → field, by substring match on a normalised header. Substring rather than equality
 *  because real exports say "Email Address", "Guest Name", "Mobile Phone", "E-mail". */
const HEADER_HINTS: [GuestField, string[]][] = [
  ['email', ['email', 'e-mail', 'mail']],
  ['phone', ['phone', 'mobile', 'cell', 'tel', 'number']],
  ['name',  ['name', 'guest', 'person', 'who']],
  ['notes', ['note', 'comment', 'remark', 'table', 'group', 'relation']],
];

/** A first guess at which column is which, which the host then corrects in the preview.
 *
 *  A guess, not a decision: the preview is where the mapping is confirmed, and this exists only so
 *  the common spreadsheet needs no clicking at all. Each field is claimed by at most one column —
 *  a sheet with both "Name" and "First Name" must not map both onto `name` and have the second
 *  silently win. */
export function guessMapping(headers: string[]): GuestField[] {
  const taken = new Set<GuestField>();
  const out: GuestField[] = headers.map(() => 'ignore');
  // Two passes so an exact-ish match ("email") claims the field before a loose one ("mail merge").
  for (const exact of [true, false]) {
    headers.forEach((h, i) => {
      if (out[i] !== 'ignore') return;
      const norm = h.toLowerCase().replace(/[^a-z]/g, '');
      for (const [field, hints] of HEADER_HINTS) {
        if (taken.has(field)) continue;
        const hit = hints.some((hint) => {
          const hn = hint.replace(/[^a-z]/g, '');
          return exact ? norm === hn : norm.includes(hn);
        });
        if (hit) { out[i] = field; taken.add(field); return; }
      }
    });
  }
  return out;
}

// ── Building the import ──────────────────────────────────────────────────────

export interface DraftGuest { name: string | null; email: string | null; phone: string | null; notes: string | null }

/** A fallback identity for a guest with NO email address.
 *
 *  Without this, re-importing the same spreadsheet silently duplicates every row that has no
 *  address — the plus-ones, the phone-only cousins, and anyone whose email was a typo and got
 *  dropped. The email check cannot catch them because there is nothing to compare. Found by
 *  importing the same file twice and watching the list grow.
 *
 *  Name AND phone together, not name alone: two guests genuinely called "John Smith" are a real
 *  thing at a wedding, and collapsing them would lose a person — which is a worse error than
 *  showing a duplicate the host can delete. The phone is reduced to its digits so that
 *  "0400 000 000" and "0400000000" are the same number, which they are.
 *
 *  Returns null when there is nothing to key on, and a null key never matches anything. */
export function identityKey(name: string | null | undefined, phone: string | null | undefined): string | null {
  const n = (name || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const p = (phone || '').replace(/\D/g, '');
  return n || p ? `${n}|${p}` : null;
}

/** What the preview shows for one line of the file, and what the commit acts on.
 *
 *  'skip' rows are shown to the host greyed out rather than hidden. A file where 40 of 200 rows
 *  are duplicates is a file the host needs to LOOK at — telling them "160 imported" and nothing
 *  else is how someone discovers at the party that half their guests were never invited. */
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
  counts: { add: number; skip: number; duplicate: number; invalid: number };
  /** Set when the mapping cannot produce anything usable — the host mapped no column to a name
   *  or an email, so every row would be empty. Worth saying once, loudly, rather than 200 times. */
  fatal: string | null;
}

const clip = (s: string, max: number) => (s.length > max ? s.slice(0, max) : s);

/** Turn a parsed table plus a column mapping into the exact list of rows that will be written.
 *
 *  `existingEmails` is the addresses already on this event's guest list, lower-cased. Duplicates
 *  are skipped rather than merged or overwritten: the row already on the list may have been edited
 *  by hand since, and a re-import of the same spreadsheet must not quietly undo that.
 *
 *  Nothing here throws. A malformed row becomes a skipped row with a reason attached — the whole
 *  point is that one bad line out of two hundred does not cost the host the other hundred and
 *  ninety-nine. */
export function buildImport(
  table: CsvTable,
  mapping: GuestField[],
  existingEmails: Iterable<string> = [],
  /** identityKey() for every guest already on the list who has no email. Lets a second import of
   *  the same file recognise the address-less rows it added the first time. */
  existingKeys: Iterable<string> = [],
): ImportPlan {
  const col = (f: GuestField) => mapping.indexOf(f);
  const iName = col('name'), iEmail = col('email'), iPhone = col('phone'), iNotes = col('notes');

  if (iName < 0 && iEmail < 0) {
    return { rows: [], counts: { add: 0, skip: 0, duplicate: 0, invalid: 0 },
             fatal: 'Map at least one column to Name or Email — otherwise there is nothing to import.' };
  }

  const already = new Set<string>();
  for (const e of existingEmails) already.add(e.trim().toLowerCase());
  const alreadyKeys = new Set<string>();
  for (const k of existingKeys) alreadyKeys.add(k);
  const seenInFile = new Set<string>();
  const keysInFile = new Set<string>();

  const rows: ImportRow[] = [];
  let duplicate = 0, invalid = 0;

  table.rows.forEach((cells, n) => {
    // +1 for 1-based, +1 again for the header row the host can see — unless there wasn't one.
    const line = n + 1 + (table.headerless ? 0 : 1);
    const at = (i: number) => (i >= 0 && i < cells.length ? cells[i].trim() : '');
    const problems: string[] = [];

    const rawName = at(iName);
    const rawEmail = at(iEmail);
    const rawPhone = at(iPhone);
    const rawNotes = at(iNotes);

    for (const [label, raw, max] of [['Name', rawName, FIELD_MAX.name], ['Phone', rawPhone, FIELD_MAX.phone],
                                     ['Notes', rawNotes, FIELD_MAX.notes]] as const) {
      if (raw.length > max) problems.push(`${label} was longer than ${max} characters and has been shortened`);
    }

    let email: string | null = null;
    if (rawEmail) {
      const lower = rawEmail.toLowerCase();
      if (!isEmail(lower)) {
        // Kept, not dropped. The host can still see them in the list, ring them, and fix the
        // address — a typo'd email is not a reason to lose the person.
        problems.push(`"${clip(rawEmail, 60)}" is not a valid email address — the guest will be added without one`);
        invalid++;
      } else {
        email = lower;
      }
    }

    const guest: DraftGuest = {
      name: rawName ? clip(rawName, FIELD_MAX.name) : null,
      email,
      phone: rawPhone ? clip(rawPhone, FIELD_MAX.phone) : null,
      notes: rawNotes ? clip(rawNotes, FIELD_MAX.notes) : null,
    };

    // The address is the identity when there is one; name+phone is the fallback when there is not.
    // Checked in that order, because an address is decisive and a name is a guess.
    const key = email ? null : identityKey(guest.name, guest.phone);

    let action: ImportRow['action'] = 'add';
    if (!guest.name && !guest.email && !guest.phone) {
      action = 'skip';
      problems.push('Nothing in the mapped columns — skipped');
    } else if (email ? already.has(email) : !!key && alreadyKeys.has(key)) {
      action = 'skip';
      problems.push('Already on the guest list — skipped');
      duplicate++;
    } else if (email ? seenInFile.has(email) : !!key && keysInFile.has(key)) {
      action = 'skip';
      problems.push('Appears more than once in this file — skipped');
      duplicate++;
    }

    if (action === 'add') {
      if (email) seenInFile.add(email);
      else if (key) keysInFile.add(key);
    }
    rows.push({ line, guest, action, problems });
  });

  const add = rows.filter((r) => r.action === 'add').length;
  return { rows, counts: { add, skip: rows.length - add, duplicate, invalid }, fatal: null };
}
