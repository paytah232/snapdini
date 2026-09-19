// The rule for `drizzle/meta/_journal.json`, pinned — because nothing else enforces it and a
// breach of it is SILENT.
//
// Drizzle resumes migrations from a single high-water mark. It reads the newest row already in
// `drizzle.__drizzle_migrations` and then applies a migration only when
//
//     lastDbMigration.created_at < migration.folderMillis
//
// (node_modules/drizzle-orm/pg-core/dialect.cjs). There is no per-migration bookkeeping, no hash
// comparison, and no complaint when the test fails: a migration below the water mark is skipped
// with no error and no log line, and the app boots against a schema missing whatever the new code
// expects.
//
// So a `when` that is HAND-WRITTEN AND IN THE FUTURE is a trap set for the next person, not a
// cosmetic oddity. Entries 0040–0056 once carried round numbers running to 1791200000000
// (2026-10-05). Everything already in the repo applied in order, which is exactly why it looked
// fine — but the next migration from a real `npx drizzle-kit generate`, stamped `Date.now()`, would
// have come in BELOW that water mark and been dropped on the floor, on every database, for ever.
//
// THE RULE, for anyone hand-editing this file: a migration's `when` must be a real timestamp — in
// the past, never invented — and must be greater than every `when` before it. `drizzle-kit
// generate` gets this right on its own; only hand-editing can break it.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DRIZZLE = path.join(__dirname, '..', 'drizzle');
const journal = JSON.parse(fs.readFileSync(path.join(DRIZZLE, 'meta', '_journal.json'), 'utf8')) as {
  version: string; dialect: string;
  entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
};

// Snapdini's first migration. Anything below this is not a date, it is a typo.
const FLOOR = Date.UTC(2025, 0, 1);

describe('drizzle/meta/_journal.json', () => {
  test('there are entries at all, and the file is the shape drizzle reads', () => {
    assert.equal(journal.dialect, 'postgresql');
    assert.ok(journal.entries.length > 0, 'an empty journal means no migrations run');
  });

  test('no `when` is in the future — the whole trap', () => {
    // Read once: a slow suite must not let an entry "become" past halfway through the file.
    const now = Date.now();
    const ahead = journal.entries.filter((e) => e.when > now);
    assert.deepEqual(
      ahead.map((e) => `${e.tag} @ ${e.when} (${new Date(e.when).toISOString()})`), [],
      'a future stamp silently skips every migration generated before that date',
    );
  });

  test('every `when` is a real millisecond timestamp, not an invented round number', () => {
    for (const e of journal.entries) {
      assert.equal(typeof e.when, 'number', `${e.tag}: when must be a number`);
      assert.ok(Number.isInteger(e.when), `${e.tag}: when must be whole milliseconds`);
      assert.ok(e.when > FLOOR, `${e.tag}: ${e.when} predates the project — seconds instead of ms?`);
    }
  });

  test('`when` is strictly increasing, in the order drizzle applies them', () => {
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1], cur = journal.entries[i];
      assert.ok(cur.when > prev.when,
        `${cur.tag} (${cur.when}) must come after ${prev.tag} (${prev.when}) — ` +
        'equal or lower and it is skipped on any database that already applied the earlier one');
    }
  });

  test('idx is dense, ordered, and agrees with the filename', () => {
    journal.entries.forEach((e, i) => {
      assert.equal(e.idx, i, `entry ${i} carries idx ${e.idx}`);
      assert.ok(e.tag.startsWith(String(i).padStart(4, '0') + '_'),
        `${e.tag} does not carry its own index`);
    });
  });

  test('every entry has its SQL, and every SQL file has its entry', () => {
    const onDisk = fs.readdirSync(DRIZZLE).filter((f) => f.endsWith('.sql')).map((f) => f.slice(0, -4)).sort();
    // A journal entry with no file is a crash on boot; a file with no entry never runs at all,
    // which is the same silent-skip failure wearing a different hat.
    assert.deepEqual(journal.entries.map((e) => e.tag).sort(), onDisk);
  });
});
