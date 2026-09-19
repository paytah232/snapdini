// CSV import — the parser and the import plan.
//
// Tested hard because the cost of being wrong is silent and lands at the party: a guest list that
// imported "successfully" while dropping, duplicating or mangling people is indistinguishable from
// a correct one until the invites go out. Every case below is a real shape a spreadsheet export or
// a clipboard paste actually produces.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, sniffDelimiter, guessMapping, buildImport, looksPhone, MAX_IMPORT_ROWS, FIELD_MAX, type GuestField, HEADER_CONSUMED, ImportRow } from '../csv';

describe('parseCsv — the shapes real files arrive in', () => {
  test('the ordinary case', () => {
    const t = parseCsv('Name,Email\nJo,jo@x.com\nSam,sam@x.com\n');
    assert.deepEqual(t.headers, ['Name', 'Email']);
    assert.deepEqual(t.rows, [['Jo', 'jo@x.com'], ['Sam', 'sam@x.com']]);
    assert.equal(t.headerless, false);
  });

  test('a trailing newline does not invent an empty row', () => {
    // Every editor and every export writes one. Counting it produced a phantom "1 blank row
    // skipped" on every single import, which trains a host to ignore the warnings that matter.
    assert.equal(parseCsv('Name,Email\nJo,jo@x.com\n').rows.length, 1);
    assert.equal(parseCsv('Name,Email\nJo,jo@x.com').rows.length, 1);
    assert.equal(parseCsv('Name,Email\nJo,jo@x.com\n\n\n').rows.length, 1);
  });

  test('a quoted field may contain the delimiter', () => {
    const t = parseCsv('Name,Email\n"Smith, Jane",jane@x.com\n');
    assert.deepEqual(t.rows[0], ['Smith, Jane', 'jane@x.com']);
  });

  test('a quoted field may contain a newline', () => {
    // Excel writes these whenever a notes cell has a line break in it. A naive split('\n') turns
    // one guest into two, the second of them nonsense.
    const t = parseCsv('Name,Notes\n"Jo","line one\nline two"\nSam,ok\n');
    assert.equal(t.rows.length, 2);
    assert.deepEqual(t.rows[0], ['Jo', 'line one\nline two']);
    assert.deepEqual(t.rows[1], ['Sam', 'ok']);
  });

  test('"" is one literal quote, and does not end the field', () => {
    const t = parseCsv('Name,Notes\n"Jo","she said ""hi"", then left"\n');
    assert.deepEqual(t.rows[0], ['Jo', 'she said "hi", then left']);
  });

  test('CRLF and lone CR both end a row', () => {
    assert.deepEqual(parseCsv('Name,Email\r\nJo,jo@x.com\r\n').rows, [['Jo', 'jo@x.com']]);
    assert.deepEqual(parseCsv('Name,Email\rJo,jo@x.com\r').rows, [['Jo', 'jo@x.com']]);
  });

  test('a UTF-8 BOM is stripped, so the first header is still recognisable', () => {
    // Excel writes a BOM. Left in place it becomes part of the first header's text, the
    // auto-mapping misses "Name", and the host is asked to map a column called "﻿Name".
    const t = parseCsv('﻿Name,Email\nJo,jo@x.com\n');
    assert.deepEqual(t.headers, ['Name', 'Email']);
    assert.deepEqual(guessMapping(t.headers), ['name', 'email']);
  });

  test('ragged rows do not throw or shift columns', () => {
    // A short row is missing cells, not shifted ones; a long row has a stray trailing comma.
    // The third column is mapped to `notes` rather than to a phone field, which no longer exists.
    // What is being pinned is unchanged: a missing cell reads as absent, not as the NEXT column's
    // value sliding left into it.
    const t = parseCsv('Name,Email,Notes\nJo,jo@x.com\nSam,sam@x.com,table 4,extra\n');
    assert.deepEqual(t.rows[0], ['Jo', 'jo@x.com']);
    assert.deepEqual(t.rows[1], ['Sam', 'sam@x.com', 'table 4', 'extra']);
    const plan = buildImport(t, ['name', 'email', 'notes']);
    assert.equal(plan.counts.add, 2);
    // rows[0] is the CONSUMED HEADER ROW. Every non-blank line of the host's file now has a row,
    // including line 1 when it was read as column names — which is what stopped a guest whose
    // address had a typo from vanishing with no count mentioning them. So the guests are 1 and 2.
    assert.equal(plan.rows[1].guest.notes, null);      // absent, not the next column's value
    assert.equal(plan.rows[2].guest.notes, 'table 4');
  });

  test('an empty file yields nothing rather than throwing', () => {
    for (const input of ['', '\n', '   ', ',,,\n,,,\n']) {
      const t = parseCsv(input);
      assert.equal(t.rows.length, 0, JSON.stringify(input));
    }
  });

  test('unterminated quotes do not hang or lose the rest of the file', () => {
    // Truncated exports and hand-edited files really do end mid-quote.
    const t = parseCsv('Name,Email\n"Jo,jo@x.com\n');
    assert.equal(t.rows.length, 1);
  });
});

describe('a file past the limit stops being read', () => {
  // The row-count check used to run after a FULL parse, so refusing a file cost the same as
  // accepting it: the import endpoints take a 2 MB body, and 2 MB of `a\n` is a million rows built
  // and thrown away. The scan now stops, which bounds the work by the limit instead of by the body.
  test('the scan gives up and says so', () => {
    const t = parseCsv('Name,Email\n' + 'a,a@x.com\n'.repeat(50), undefined, 10);
    assert.equal(t.overflow, true, 'a file well past the limit was read to the end');
    assert.ok(t.rows.length <= 11, `it kept reading: ${t.rows.length} rows`);
  });

  test('a file AT the limit is read in full, so the exact-count message stays exact', () => {
    // The route passes MAX_IMPORT_ROWS + 2 for exactly this: a file at the limit has a header plus
    // MAX_IMPORT_ROWS data rows, and must parse completely.
    const body = 'a,a@x.com\n'.repeat(10);
    const t = parseCsv('Name,Email\n' + body, undefined, 12);
    assert.equal(t.overflow, false, 'a file at the limit was cut short');
    assert.equal(t.rows.length, 10);
  });

  test('blank lines in the middle of a file do not count towards it', () => {
    // A host whose export has empty rows in it must not be told their list is too long. The
    // cleanup drops them, so the early bail must not count them either.
    const t = parseCsv('Name,Email\n' + 'a,a@x.com\n\n\n\n\n'.repeat(4), undefined, 6);
    assert.equal(t.overflow, false, 'blank rows were counted against the limit');
    assert.equal(t.rows.length, 4);
  });

  test('and with no limit given, nothing changes', () => {
    const t = parseCsv('Name,Email\n' + 'a,a@x.com\n'.repeat(5000));
    assert.equal(t.overflow, false);
    assert.equal(t.rows.length, 5000);
  });

  test('MAX_IMPORT_ROWS is still the rule the route applies', () => {
    assert.equal(MAX_IMPORT_ROWS, 2000);
  });
});

describe('sniffDelimiter — because "paste from Excel" is tab-separated', () => {
  test('tabs win, which is what the clipboard carries', () => {
    assert.equal(sniffDelimiter('Name\tEmail\nJo\tjo@x.com'), '\t');
  });
  test('semicolons, which is what Excel writes in comma-decimal locales', () => {
    assert.equal(sniffDelimiter('Name;Email\nJo;jo@x.com'), ';');
  });
  test('commas by default, including for a single column with no delimiter at all', () => {
    assert.equal(sniffDelimiter('Name,Email\nJo,jo@x.com'), ',');
    assert.equal(sniffDelimiter('jo@x.com\nsam@x.com'), ',');
  });
  test('a comma INSIDE a quoted name does not beat the real tab delimiter', () => {
    // The bug this exists to prevent: counting delimiters without tracking quotes finds two commas
    // and one tab in this line, picks the comma, and splits every surname off into its own column.
    const text = '"Smith, Jane"\tjane@x.com\n"Doe, John"\tjohn@x.com\n';
    assert.equal(sniffDelimiter(text), '\t');
    // No header row here (row 1 holds an address), so both lines are guests.
    const t = parseCsv(text);
    assert.deepEqual(t.rows, [['Smith, Jane', 'jane@x.com'], ['Doe, John', 'john@x.com']]);
  });
});

describe('headerless pastes', () => {
  test('a first row containing an email is treated as data, not as column names', () => {
    // Selecting the cells without the header row is an entirely ordinary thing to do, and eating
    // the host's first guest as a header is the worst available response to it.
    const t = parseCsv('Jo,jo@x.com\nSam,sam@x.com\n');
    assert.equal(t.headerless, true);
    assert.equal(t.rows.length, 2);
    assert.deepEqual(t.headers, ['Column 1', 'Column 2']);
  });

  test('line numbers still point at what the host sees in their own file', () => {
    const withHeader = buildImport(parseCsv('Name,Email\nJo,jo@x.com\n'), ['name', 'email']);
    // The header row is REPORTED now, not silently dropped: rows[0] is line 1, skipped, and the
    // first guest is rows[1] at line 2. The invariant being pinned is that no line the host can
    // see in their own file is missing a row here.
    assert.equal(withHeader.rows[0].line, 1);
    assert.equal(withHeader.rows[0].action, 'skip');
    assert.equal(withHeader.rows[1].line, 2);
    const without = buildImport(parseCsv('Jo,jo@x.com\n'), ['name', 'email']);
    assert.equal(without.rows[0].line, 1);
  });
});

describe('guessMapping', () => {
  test('the headers real exports use', () => {
    // 'Mobile Phone' is still recognised as a phone column — it just resolves to 'ignore' now
    // rather than to a stored field, because Snapdini sends email and can do nothing with a
    // number. The point of the assertion is that Notes still lands on the FOURTH column: the
    // phone column is skipped by decision, not left to drift into another field.
    assert.deepEqual(guessMapping(['Guest Name', 'Email Address', 'Mobile Phone', 'Notes']),
      ['name', 'email', 'ignore', 'notes']);
    assert.deepEqual(guessMapping(['name', 'e-mail']), ['name', 'email']);
  });
  test('unknown columns are ignored rather than guessed at', () => {
    assert.deepEqual(guessMapping(['RSVP', 'Dietary']), ['ignore', 'ignore']);
  });
  test('a field is claimed once — a second candidate column does not silently overwrite it', () => {
    const m = guessMapping(['Name', 'First Name', 'Email']);
    assert.equal(m.filter((f) => f === 'name').length, 1);
    assert.equal(m[0], 'name');       // the exact match wins over the loose one
    assert.equal(m[2], 'email');
  });
});

describe('buildImport — one bad row must not cost the good ones', () => {
  const table = (csv: string) => parseCsv(csv);
  const MAP: GuestField[] = ['name', 'email'];
  /** The GUEST lines. Every non-blank line of the host's file now gets a row — including line 1
   *  when it was read as column names — which is what stopped a typo'd first guest vanishing with
   *  no count mentioning them. A test about guests therefore has to say so rather than index from
   *  zero, or it silently starts asserting about the header. */
  const guests = (p: { rows: ImportRow[] }) => p.rows.filter((r) => r.problems[0] !== HEADER_CONSUMED);

  test('an invalid address is skipped, and the row says which text failed', () => {
    // CHANGED with the email requirement. This used to import Jo without an address, on the
    // reasoning that a typo is not a reason to lose the person. With an address required there is
    // nowhere for that person to go: a row that cannot be mailed is a row the send will never
    // reach, so importing it would put a name on the list that quietly gets no invite.
    // What matters is that the failure is VISIBLE and FIXABLE — the host sees their own text back,
    // on a greyed line, and can correct the file and import again.
    const plan = buildImport(table('Name,Email\nJo,not-an-email\nSam,sam@x.com\n'), MAP);
    assert.equal(plan.counts.add, 1);
    assert.equal(plan.counts.invalid, 1);
    // A bad address is NOT counted as a missing one: the two need different things done about them.
    assert.equal(plan.counts.noEmail, 0);
    assert.equal(guests(plan)[0].action, 'skip');
    assert.equal(guests(plan)[0].guest.name, 'Jo');
    assert.match(guests(plan)[0].problems[0], /"not-an-email" is not a valid email address/);
  });

  test('addresses are lower-cased, which is what makes duplicate detection work at all', () => {
    const plan = buildImport(table('Name,Email\nJo,JO@X.COM\nJoanne,jo@x.com\n'), MAP);
    assert.equal(guests(plan)[0].guest.email, 'jo@x.com');
    assert.equal(guests(plan)[1].action, 'skip');
    assert.equal(plan.counts.duplicate, 1);
  });

  test('a duplicate of someone already on the list is skipped, not overwritten', () => {
    // Re-importing the same spreadsheet after hand-editing a row must not undo the hand edit.
    const plan = buildImport(table('Name,Email\nJo,jo@x.com\nNew,new@x.com\n'), MAP, ['JO@x.com']);
    assert.equal(guests(plan)[0].action, 'skip');
    assert.match(guests(plan)[0].problems[0], /Already on the guest list/);
    assert.equal(plan.counts.add, 1);
  });

  test('rows with nothing in the mapped columns are SHOWN as skipped, not dropped in silence', () => {
    // The third line has an RSVP and nothing else. It is a real line in the host's file, so it
    // appears in the preview with a reason — a row that vanishes between the file and the result
    // is the failure mode this whole preview exists to prevent. A line that is blank in EVERY
    // column is different: there is nothing to show and nothing to explain, so it never arrives.
    const plan = buildImport(table('Name,Email,RSVP\nJo,jo@x.com,yes\n,,no\n\n'), ['name', 'email', 'ignore']);
    // Three rows for three non-blank lines: the header, Jo, and the RSVP-only line. The wholly
    // blank line is the one exception and never arrives.
    assert.equal(plan.rows.length, 3);
    assert.equal(plan.rows[0].problems[0], HEADER_CONSUMED);
    assert.equal(plan.counts.add, 1);
    assert.equal(guests(plan)[1].action, 'skip');
    assert.match(guests(plan)[1].problems[0], /Nothing in the mapped columns/);
  });

  test('a guest with no email is NOT imported — the list is for emailing links', () => {
    // REVERSED on purpose. This test used to read "guests with no email are perfectly valid list
    // entries", and under the old scope it was right. The scope changed: this is not an invitation
    // service, it is a way to mail a lot of people one link, so a row with no address is a row
    // nothing here can ever act on. The host hands those people a printed card instead.
    const plan = buildImport(table('Name,Email,Phone\nDan’s partner,,\nPat,,0400111222\n'),
      ['name', 'email', 'ignore']);
    assert.equal(plan.counts.add, 0);
    assert.equal(plan.counts.noEmail, 2);
    // Still true, and still worth pinning: the number is read, recognised and stored nowhere.
    assert.ok(!JSON.stringify(plan.rows.map((r) => r.guest)).includes('0400111222'));
  });

  test('a row with no email is REPORTED, not silently dropped', () => {
    // The half that makes the rule survivable. A host pasting a spreadsheet where half the people
    // have no address must SEE that, by line, with a reason — "3 imported" out of six rows, with
    // nothing else said, is how someone finds out at the party that half their guests were never
    // invited. Every skipped row is still a row in the plan, in its own file's numbering.
    const plan = buildImport(
      table('Name,Email\nJo,jo@x.com\nDan’s partner,\nSam,sam@x.com\nPat,\n'), MAP);
    // Five: the header line plus the host's four guests. Every line they can see has a row.
    assert.equal(plan.rows.length, 5);
    assert.equal(plan.counts.add, 2);
    // Three, not two: the consumed header line is a skipped LINE like any other. It is deliberately
    // not counted as `invalid`, `noEmail` or `duplicate` — it is none of those, and counting it as
    // one would trade one wrong number for another. Those three are the actionable counts; `skip`
    // is simply every line that produced no guest.
    assert.equal(plan.counts.skip, 3);
    // Counted apart from the other skip reasons, because it is the one the host can act on.
    assert.equal(plan.counts.noEmail, 2);
    assert.equal(plan.counts.duplicate, 0);
    assert.equal(plan.counts.invalid, 0);
    // Line numbers are the host's own, header included, so the greyed rows match their file.
    // Scoped to the GUEST lines: line 1 is also skipped, but as the header, and this assertion is
    // about the two people who cannot be mailed.
    assert.deepEqual(guests(plan).filter((r) => r.action === 'skip').map((r) => r.line), [3, 5]);
    for (const r of guests(plan).filter((r) => r.action === 'skip')) {
      assert.match(r.problems[0], /No email address/);
      // The name survives onto the greyed row: the host has to be able to tell WHO to print a card
      // for, which a row reading "— · —" cannot answer.
      assert.ok(r.guest.name);
    }
  });

  test('a mapping with no email column is one loud failure, not a page of grey', () => {
    // The end of the same rule. Every row would be skipped for the identical reason, and the fix is
    // the mapper the host is looking at — so it is said once, above it.
    const plan = buildImport(table('Name,Notes\nJo,table 4\nSam,table 9\n'), ['name', 'notes']);
    assert.match(plan.fatal!, /Map a column to Email/);
    assert.equal(plan.rows.length, 0);
  });

  test('over-long fields are shortened with a note, not rejected', () => {
    const long = 'x'.repeat(FIELD_MAX.name + 50);
    const plan = buildImport(table(`Name,Email\n${long},jo@x.com\n`), MAP);
    assert.equal(plan.counts.add, 1);
    assert.equal(guests(plan)[0].guest.name!.length, FIELD_MAX.name);
    assert.match(guests(plan)[0].problems[0], /shortened/);
  });

  test('mapping nothing usable is one loud failure, not two hundred quiet ones', () => {
    const plan = buildImport(table('A,B\n1,2\n'), ['ignore', 'ignore']);
    assert.ok(plan.fatal);
    assert.equal(plan.rows.length, 0);
  });

  test('the plan a host previews is the plan that gets committed', () => {
    // The preview and the commit must be the same computation over the same text, or the host is
    // approving something other than what happens. This asserts the function is deterministic and
    // side-effect free, which is what lets the route run it twice.
    const t = table('Name,Email\nJo,jo@x.com\nJo2,jo@x.com\nSam,SAM@x.com\n');
    const a = buildImport(t, MAP, ['old@x.com']);
    const b = buildImport(t, MAP, ['old@x.com']);
    assert.deepEqual(a, b);
    assert.deepEqual(a.rows.filter((r) => r.action === 'add').map((r) => r.guest.email),
      ['jo@x.com', 'sam@x.com']);
  });

  test('re-importing the same file adds nobody a second time', () => {
    // The bug this exists to prevent, found by importing the same file twice and watching the list
    // grow. It used to need TWO identities — the address, plus identityKey(name, notes) for the
    // rows that had no address — and the second one is gone with the requirement that created it.
    // One key now: the address, which is also the key the unique index on (event_id, email) uses,
    // so the preview and the database cannot disagree about what a duplicate is.
    const t = table('Name,Email,Phone\nJo,jo@x.com,\nSam,sam@x.com,0400 000 000\n');
    const MAP3: GuestField[] = ['name', 'email', 'ignore'];

    const first = buildImport(t, MAP3);
    assert.equal(first.counts.add, 2);

    // Second run, with the first run's guests now on the list. Cased differently on purpose: the
    // existing addresses are folded before they are compared.
    const second = buildImport(t, MAP3, ['JO@X.COM', 'sam@x.com']);
    assert.equal(second.counts.add, 0, 'nobody should be added twice');
    assert.equal(second.counts.duplicate, 2);
  });

  test('two DIFFERENT people who share a name are both kept', () => {
    // The error in the other direction, and the worse one: collapsing them loses a guest, where a
    // duplicate merely shows a row the host can delete. Two guests really called "John Smith" used
    // to be the hard case, because with no address the only thing telling them apart was whatever
    // the host had written beside them. With an address required they are simply two addresses.
    const t = table("Name,Email,Notes\nJohn Smith,john1@x.com,Jo's cousin\nJohn Smith,john2@x.com,Sam's uncle\n");
    const plan = buildImport(t, ['name', 'email', 'notes']);
    assert.equal(plan.counts.add, 2);
  });

  test('a host who wants the digits kept can map the phone column to notes by hand', () => {
    // Not our decision to make for them. The mapper offers `notes`, and a mapping the client sends
    // is used verbatim — so the numbers can be kept, as a note, because the host chose that.
    const t = table('Name,Email,Phone\nJo Smith,jo@example.com,0400 000 000\n');
    const plan = buildImport(t, ['name', 'email', 'notes']);
    assert.equal(plan.counts.add, 1);
    assert.equal(guests(plan)[0].guest.notes, '0400 000 000');
  });

  test('an address still beats the name fallback', () => {
    // Two rows with the same name but different real addresses are two people, not one.
    const t = table('Name,Email\nJohn Smith,john1@x.com\nJohn Smith,john2@x.com\n');
    assert.equal(buildImport(t, ['name', 'email']).counts.add, 2);
  });

  test('a large but legal file is handled, and the ceiling is a real number', () => {
    const rows = Array.from({ length: 500 }, (_, i) => `Guest ${i},g${i}@x.com`).join('\n');
    const plan = buildImport(table(`Name,Email\n${rows}\n`), MAP);
    assert.equal(plan.counts.add, 500);
    assert.ok(MAX_IMPORT_ROWS >= 500);
  });
});

// ── The defect this file grew for ────────────────────────────────────────────
//
// "The preview for guest list still doesn't seem to do anything if I don't put a header in the csv.
//  Why doesn't it just detect 2 csvs so 2 rows and assume, or smart enough to detect email format"
//
// He is describing the dead end exactly. A headerless paste came back HTTP 200 with a full payload
// and every column set to 'ignore', which produced buildImport's fatal — a message telling the host
// to map a column, for a file where the machine can see perfectly well which column is which. The
// tests below are the shapes that used to end there.
describe('inferring the mapping from the data, when the header cannot say', () => {
  const mapOf = (csv: string) => {
    const t = parseCsv(csv);
    return { t, mapping: guessMapping(t.headers, t.rows) };
  };

  test('a phone column is detected and skipped — never mistaken for a name', () => {
    // THE regression this change has to be guarded against. A phone number is not stored (Snapdini
    // sends email and can do nothing with a number — data minimisation, see looksPhone), but a host
    // pasting the perfectly ordinary spreadsheet they already have MUST still get a clean import.
    // The failure to prevent is the phone column being treated as a name or a note, which would put
    // digits in the row title and make the list unreadable.

    // With a header row, the label is recognised.
    assert.deepEqual(guessMapping(['Name', 'Email', 'Phone']), ['name', 'email', 'ignore']);
    for (const label of ['Phone', 'Mobile', 'Cell', 'Telephone', 'Mobile Number', 'Phone Number'])
      assert.deepEqual(guessMapping(['Name', label]), ['name', 'ignore'], label);

    // Without one, the VALUES are recognised — which is the case a header cannot help with.
    const head = mapOf('Name,Email,Phone\nJo Smith,jo@example.com,0400 000 000\n');
    assert.deepEqual(head.mapping, ['name', 'email', 'ignore']);
    const bare = mapOf('Jo Smith,jo@example.com,0400 000 000\nSam Lee,sam@example.com,0400 111 222\n');
    assert.equal(bare.t.headerless, true);
    assert.deepEqual(bare.mapping, ['name', 'email', 'ignore']);

    // Column order is not an assumption: the phone can come first.
    assert.deepEqual(guessMapping(['Phone', 'Name', 'Email']), ['ignore', 'name', 'email']);
    assert.deepEqual(mapOf('0400 000 000,Jo Smith,jo@example.com\n0400 111 222,Sam Lee,sam@example.com\n').mapping,
      ['ignore', 'name', 'email']);

    // And the digits reach no stored field, on any of those shapes.
    for (const m of [head, bare]) {
      const plan = buildImport(m.t, m.mapping);
      assert.equal(plan.fatal, null);
      assert.equal(plan.counts.add, m.t.rows.length);
      assert.ok(!JSON.stringify(plan.rows.map((r) => r.guest)).includes('0400'));
    }
  });

  test('a phone column ALONE has nothing to import, and says so once', () => {
    // The end of the same rule. A file that is only numbers maps to nothing storable, so the host
    // gets the one loud fatal rather than a list of blank guests — and certainly not a list of
    // guests called "0400 000 000".
    const { t, mapping } = mapOf('0400 000 000\n0400 111 222\n');
    assert.equal(t.headerless, true);
    assert.deepEqual(mapping, ['ignore']);
    const plan = buildImport(t, mapping);
    assert.ok(plan.fatal);
    assert.equal(plan.rows.length, 0);
  });

  test('two columns, no header: name and email, and nothing to ask the host', () => {
    const { t, mapping } = mapOf('Jo Smith,jo@example.com\nSam Lee,sam@example.com\n');
    assert.equal(t.headerless, true);
    assert.deepEqual(mapping, ['name', 'email']);
    const plan = buildImport(t, mapping);
    assert.equal(plan.fatal, null);
    assert.equal(plan.counts.add, 2);
    // Both lines are guests. Eating the first one as a header is the failure this whole path exists
    // to avoid, and it is invisible if you only count what was imported.
    assert.deepEqual(plan.rows.map((r) => r.guest.name), ['Jo Smith', 'Sam Lee']);
  });

  test('the address column is found wherever it is, not assumed to be second', () => {
    assert.deepEqual(mapOf('jo@example.com,Jo Smith\nsam@example.com,Sam Lee\n').mapping,
      ['email', 'name']);
    // The middle column is phone-shaped. It is still DETECTED, and resolves to 'ignore' — the
    // name does not slide into it and the address does not move off the third column.
    assert.deepEqual(mapOf('Jo Smith,0400 000 000,jo@example.com\nSam Lee,0400 111 222,sam@example.com\n').mapping,
      ['name', 'ignore', 'email']);
  });

  test('one column of addresses is a guest list', () => {
    const { t, mapping } = mapOf('jo@example.com\nsam@example.com\n');
    assert.deepEqual(mapping, ['email']);
    assert.equal(buildImport(t, mapping).counts.add, 2);
  });

  test('tab-separated, which is what a spreadsheet paste actually is', () => {
    const { t, mapping } = mapOf('Jo Smith\tjo@example.com\nSam Lee\tsam@example.com\n');
    assert.equal(t.delimiter, '\t');
    assert.deepEqual(mapping, ['name', 'email']);
    assert.equal(buildImport(t, mapping).counts.add, 2);
  });

  test('a header row whose names we do not recognise is the same problem', () => {
    // "Col A"/"Col B", a foreign-language export, a sheet someone titled by hand. The header is
    // still consumed as a header (it is not a guest) — but the columns are named from the data
    // rather than left as a dead end.
    const { t, mapping } = mapOf('Col A,Col B\nJo Smith,jo@example.com\nSam Lee,sam@example.com\n');
    assert.equal(t.headerless, false);
    assert.deepEqual(mapping, ['name', 'email']);
    assert.equal(buildImport(t, mapping).counts.add, 2);
  });

  test('a recognised header still wins — a labelled column is not a guess', () => {
    // Values that would infer the other way round if the label were ignored.
    const { mapping } = mapOf('Email,Name\njo@example.com,Jo Smith\n');
    assert.deepEqual(mapping, ['email', 'name']);
  });

  test('a phone number in row 1 proves row 1 is data', () => {
    // The silent half of the bug: with no address anywhere, `headerless` was false, so "Jo Smith"
    // became the column name and Jo was never imported. Nothing on screen said a guest had gone.
    const { t, mapping } = mapOf('Jo Smith,0400 000 000\nSam Lee,+61 400 111 222\n');
    assert.equal(t.headerless, true);
    // 'ignore' rather than 'phone' now, but the guard is unchanged and this is the second reason
    // looksPhone() survived the column being dropped: without it, "Jo Smith" becomes the column
    // name and Jo is never imported.
    assert.deepEqual(mapping, ['name', 'ignore']);
    // The proof that neither line was eaten lives in the PARSE, which is where that decision is
    // made — both names are still there as data rows.
    assert.deepEqual(t.rows.map((r) => r[0]), ['Jo Smith', 'Sam Lee']);
    // CHANGED with the email requirement: this used to import both. A name-and-phone file has no
    // address column, so there is nothing importable in it, and the host gets the one loud fatal
    // naming the fix. That is a different failure from row 1 vanishing — they are TOLD.
    assert.match(buildImport(t, mapping).fatal!, /Map a column to Email/);
  });

  test('a column is decided by the MAJORITY of its rows, not by the first one', () => {
    // One typo'd address must not demote the address column to free text, and one phone number
    // written into a notes cell must not let notes claim the phone field.
    const { mapping } = mapOf(
      'Jo Smith,not-an-email\nSam Lee,sam@example.com\nAli Ray,ali@example.com\nBo Tan,bo@example.com\n',
    );
    assert.deepEqual(mapping, ['name', 'email']);
  });

  test('a second address column is left alone rather than guessed at', () => {
    // It is not a name and it is certainly not a note. 'ignore' is the honest answer, and the
    // mapper — which is now on screen even when the plan is fatal — is one click.
    assert.deepEqual(mapOf('jo@example.com,jo.work@example.com\nsam@example.com,sam.work@example.com\n').mapping,
      ['email', 'ignore']);
  });

  test('a third free-text column becomes notes, a fourth is ignored', () => {
    assert.deepEqual(mapOf('Jo Smith,jo@example.com,table 4\nSam Lee,sam@example.com,bride side\n').mapping,
      ['name', 'email', 'notes']);
    assert.deepEqual(mapOf('Jo Smith,table 4,bride side,plus one\nSam Lee,table 2,groom side,alone\n').mapping,
      ['name', 'notes', 'ignore', 'ignore']);
  });

  test('an empty column is not a field', () => {
    // Guessing one puts every guest's name in a column that has nothing in it.
    assert.deepEqual(mapOf('Jo Smith,,jo@example.com\nSam Lee,,sam@example.com\n').mapping,
      ['name', 'ignore', 'email']);
  });

  test('a table number is not a phone number', () => {
    // The 6-digit floor. Without it a "Table" column of small integers claimed the phone field.
    assert.equal(looksPhone('4'), false);
    assert.equal(looksPhone('table 4'), false);
    assert.equal(looksPhone('2026'), false);
    assert.equal(looksPhone('0400 000 000'), true);
    assert.equal(looksPhone('+61 400 111 222'), true);
    assert.equal(looksPhone('(07) 3333 4444'), true);
    // Past E.164's own ceiling it is an account number, not a phone.
    assert.equal(looksPhone('1234567890123456'), false);
  });

  test('headers alone still infer nothing — the guess needs the data to have a say', () => {
    // guessMapping(headers) with no rows is still the header-only guess it always was, which is
    // what every existing caller and every existing expectation relies on.
    assert.deepEqual(guessMapping(['RSVP', 'Dietary']), ['ignore', 'ignore']);
  });

  test('the guess is pure, so preview and commit cannot disagree', () => {
    // The commit endpoint re-runs the identical computation over the same text. If the guess were
    // not deterministic, the host would approve one plan and get another.
    const csv = 'Jo Smith,jo@example.com,0400 000 000\nSam Lee,sam@example.com,0400 111 222\n';
    const a = mapOf(csv), b = mapOf(csv);
    assert.deepEqual(a.mapping, b.mapping);
    assert.deepEqual(buildImport(a.t, a.mapping).rows, buildImport(b.t, b.mapping).rows);
  });
});
