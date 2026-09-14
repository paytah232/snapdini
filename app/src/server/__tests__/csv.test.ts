// CSV import — the parser and the import plan.
//
// Tested hard because the cost of being wrong is silent and lands at the party: a guest list that
// imported "successfully" while dropping, duplicating or mangling people is indistinguishable from
// a correct one until the invites go out. Every case below is a real shape a spreadsheet export or
// a clipboard paste actually produces.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, sniffDelimiter, guessMapping, buildImport, identityKey, MAX_IMPORT_ROWS, FIELD_MAX,
         type GuestField } from '../csv';

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
    const t = parseCsv('Name,Email,Phone\nJo,jo@x.com\nSam,sam@x.com,0400,extra\n');
    assert.deepEqual(t.rows[0], ['Jo', 'jo@x.com']);
    assert.deepEqual(t.rows[1], ['Sam', 'sam@x.com', '0400', 'extra']);
    const plan = buildImport(t, ['name', 'email', 'phone']);
    assert.equal(plan.counts.add, 2);
    assert.equal(plan.rows[0].guest.phone, null);      // absent, not the next column's value
    assert.equal(plan.rows[1].guest.phone, '0400');
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
    assert.equal(withHeader.rows[0].line, 2);           // row 1 is the header
    const without = buildImport(parseCsv('Jo,jo@x.com\n'), ['name', 'email']);
    assert.equal(without.rows[0].line, 1);
  });
});

describe('guessMapping', () => {
  test('the headers real exports use', () => {
    assert.deepEqual(guessMapping(['Guest Name', 'Email Address', 'Mobile Phone', 'Notes']),
      ['name', 'email', 'phone', 'notes']);
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

  test('an invalid address keeps the GUEST and drops only the address', () => {
    const plan = buildImport(table('Name,Email\nJo,not-an-email\nSam,sam@x.com\n'), MAP);
    assert.equal(plan.counts.add, 2);
    assert.equal(plan.counts.invalid, 1);
    assert.equal(plan.rows[0].guest.email, null);
    assert.equal(plan.rows[0].guest.name, 'Jo');
    assert.match(plan.rows[0].problems[0], /not a valid email/);
  });

  test('addresses are lower-cased, which is what makes duplicate detection work at all', () => {
    const plan = buildImport(table('Name,Email\nJo,JO@X.COM\nJoanne,jo@x.com\n'), MAP);
    assert.equal(plan.rows[0].guest.email, 'jo@x.com');
    assert.equal(plan.rows[1].action, 'skip');
    assert.equal(plan.counts.duplicate, 1);
  });

  test('a duplicate of someone already on the list is skipped, not overwritten', () => {
    // Re-importing the same spreadsheet after hand-editing a row must not undo the hand edit.
    const plan = buildImport(table('Name,Email\nJo,jo@x.com\nNew,new@x.com\n'), MAP, ['JO@x.com']);
    assert.equal(plan.rows[0].action, 'skip');
    assert.match(plan.rows[0].problems[0], /Already on the guest list/);
    assert.equal(plan.counts.add, 1);
  });

  test('rows with nothing in the mapped columns are SHOWN as skipped, not dropped in silence', () => {
    // The third line has an RSVP and nothing else. It is a real line in the host's file, so it
    // appears in the preview with a reason — a row that vanishes between the file and the result
    // is the failure mode this whole preview exists to prevent. A line that is blank in EVERY
    // column is different: there is nothing to show and nothing to explain, so it never arrives.
    const plan = buildImport(table('Name,Email,RSVP\nJo,jo@x.com,yes\n,,no\n\n'), ['name', 'email', 'ignore']);
    assert.equal(plan.rows.length, 2);
    assert.equal(plan.counts.add, 1);
    assert.equal(plan.rows[1].action, 'skip');
    assert.match(plan.rows[1].problems[0], /Nothing in the mapped columns/);
  });

  test('guests with no email are perfectly valid list entries', () => {
    // A phone-only guest, and a name-only plus-one. Requiring an email would make the guest list
    // refuse the thing it exists to record.
    const plan = buildImport(table('Name,Email,Phone\nDan’s partner,,\nPat,,0400111222\n'),
      ['name', 'email', 'phone']);
    assert.equal(plan.counts.add, 2);
    assert.equal(plan.rows[1].guest.phone, '0400111222');
  });

  test('over-long fields are shortened with a note, not rejected', () => {
    const long = 'x'.repeat(FIELD_MAX.name + 50);
    const plan = buildImport(table(`Name,Email\n${long},jo@x.com\n`), MAP);
    assert.equal(plan.counts.add, 1);
    assert.equal(plan.rows[0].guest.name!.length, FIELD_MAX.name);
    assert.match(plan.rows[0].problems[0], /shortened/);
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

  test('re-importing the same file does not duplicate the guests who have NO email', () => {
    // The bug this exists to prevent, found by importing the same file twice and watching the list
    // grow: the duplicate check keys on the address, and a plus-one or a phone-only cousin has
    // none, so every re-import added them again. The fallback identity is name+phone.
    const t = table('Name,Email,Phone\nPlus one,,\nPat,,0400 000 000\nJo,jo@x.com,\n');
    const MAP3: GuestField[] = ['name', 'email', 'phone'];

    const first = buildImport(t, MAP3);
    assert.equal(first.counts.add, 3);

    // Second run, with the first run's guests now on the list.
    const second = buildImport(
      t, MAP3,
      ['jo@x.com'],
      [identityKey('Plus one', null)!, identityKey('Pat', '0400000000')!],
    );
    assert.equal(second.counts.add, 0, 'nobody should be added twice');
    assert.equal(second.counts.duplicate, 3);
  });

  test('the same file twice in ONE import does not duplicate address-less rows either', () => {
    const t = table('Name,Email,Phone\nPlus one,,\nPlus one,,\n');
    const plan = buildImport(t, ['name', 'email', 'phone']);
    assert.equal(plan.counts.add, 1);
    assert.match(plan.rows[1].problems[0], /more than once in this file/);
  });

  test('two DIFFERENT people who share a name are both kept', () => {
    // The error in the other direction, and the worse one: collapsing them loses a guest, where a
    // duplicate merely shows a row the host can delete. The phone is what tells them apart.
    const t = table('Name,Email,Phone\nJohn Smith,,0400111222\nJohn Smith,,0400333444\n');
    const plan = buildImport(t, ['name', 'email', 'phone']);
    assert.equal(plan.counts.add, 2);
  });

  test('identityKey normalises the way a person would', () => {
    // "0400 000 000" and "0400000000" are the same number, and "  Jo  Smith " is the same person
    // as "jo smith". If these drifted apart the fallback check would silently stop matching.
    assert.equal(identityKey('  Jo   Smith ', '0400 000 000'), identityKey('jo smith', '0400000000'));
    assert.equal(identityKey('Jo', '+61 400 000 000'), identityKey('jo', '61400000000'));
    // Nothing to key on ⇒ no key, and a null key must never match anything.
    assert.equal(identityKey(null, null), null);
    assert.equal(identityKey('', '  '), null);
    // A name alone and a phone alone are each enough.
    assert.ok(identityKey('Jo', null));
    assert.ok(identityKey(null, '0400'));
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
