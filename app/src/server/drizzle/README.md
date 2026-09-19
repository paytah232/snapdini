# Migrations — the one rule, and why it bites silently

Generate migrations with `npx drizzle-kit generate` and let it write `meta/_journal.json` itself.

If you ever hand-edit that file:

> **A migration's `when` must be a real timestamp — in the past — and greater than every `when`
> before it.**

## Why

Drizzle keeps **one high-water mark**, not a per-migration record. On boot it reads the newest row
in `drizzle.__drizzle_migrations` and applies a migration only when

```js
lastDbMigration.created_at < migration.folderMillis    // pg-core/dialect.cjs
```

There is no hash comparison and **no error when the test fails**. A migration whose `when` sits
below the water mark is skipped with no log line, and the app then boots against a schema missing
whatever the new code expects. The first symptom is a query failing in production against a column
that "definitely exists".

## The trap this is written down for

Entries 0040–0056 were once stamped by hand with round numbers running up to `1791200000000`
— 2026-10-05, about eighteen days in the future. Every migration already in the repo still applied
in order, which is exactly why it looked fine. But the *next* one from a real `drizzle-kit
generate`, stamped `Date.now()`, would have landed **below** that water mark and been dropped on the
floor — on every database, for ever, silently. They were renumbered to real past timestamps in
1.5.0, while production had applied none of them.

Renumbering the journal is only half the job on a database that has **already applied** the future
stamps: its `__drizzle_migrations.created_at` rows still hold them, so its water mark stays poisoned
and every future migration is still skipped there. Correct the rows to match the journal (same
hashes, only the clock moves) or the database has to be rebuilt.

## Guardrails

- `src/server/__tests__/migration-journal.test.ts` fails on a future stamp, a non-monotonic one, an
  index that disagrees with its filename, and an entry with no `.sql` file (or the reverse).
- Before shipping a migration chain, rehearse it against a `pg_dump` of production restored into a
  scratch database — and then apply one throwaway migration stamped `Date.now()` on top. That second
  step is the one that catches this bug; the chain itself will look healthy either way.
