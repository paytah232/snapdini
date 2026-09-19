// A truncating query must have a TOTAL order.
//
// `ORDER BY` on a non-unique key is undefined in SQL — Postgres promises nothing about the order
// within a tie group, and is free to answer differently for the same query. With LIMIT/OFFSET that
// means consecutive pages OVERLAP: a row appears on both and another appears on neither. Measured
// against the production database: `ORDER BY paid DESC LIMIT 10` at offsets 0 and 10 returned 20
// rows but only 19 distinct events, and four real customer events fell outside both pages. With a
// plain truncating LIMIT it is milder but still wrong — the cut falls inside the tie group and its
// membership changes between refreshes with no data change.
//
// This is a SOURCE test on purpose. The runtime behaviour is famously hard to provoke on demand
// (a small table in one transaction comes back in insertion order every time), so a test that
// tried to observe it would pass while the defect was present. What can be checked reliably is the
// thing that makes the defect impossible: every truncating ORDER BY ends in a unique column.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROUTES = path.join(__dirname, '..', 'routes');

/** Columns that are unique per row in the query they close, so they make the order total. */
const UNIQUE_TAIL = /,\s*(?:[a-z]+\.)?(?:id|key|path|1)\s*(?:ASC|DESC)?\s*$/i;

/** Source with comments removed.
 *
 *  LINE comments first, then block comments — not the other way round. A previous sweep in this
 *  codebase stripped block comments first, and a `/api/*` inside a line comment then opened a
 *  block comment that swallowed 200 lines of real code, so the test passed by seeing nothing.
 */
function code(src: string): string {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Truncating ORDER BY clauses, one per raw SQL template.
 *
 *  The match may not cross a backtick: raw SQL lives in template literals, and a pattern that runs
 *  from one query's ORDER BY to the NEXT query's LIMIT reports a clause that does not exist. That
 *  false positive is why this is written with `[^`]` rather than a lazy `[\s\S]`.
 */
function truncatingOrderBys(src: string): string[] {
  const out: string[] = [];
  const re = /ORDER BY[^`]*?\bLIMIT\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code(src)))) {
    out.push(m[0].replace(/\s+LIMIT$/i, '').replace(/\s+/g, ' ').trim());
  }
  return out;
}

describe('a truncating query orders by something unique', () => {
  const files = fs.readdirSync(ROUTES).filter((f) => f.endsWith('.ts'));

  for (const f of files) {
    const src = fs.readFileSync(path.join(ROUTES, f), 'utf8');

    test(`${f}: every truncating ORDER BY ends in a unique key`, () => {
      const bad = truncatingOrderBys(src).filter((c) => !UNIQUE_TAIL.test(c));
      assert.deepEqual(bad, [],
        `${f}: ${bad.length} truncating ORDER BY clause(s) with no unique final key — `
        + bad.join(' | ')
        + '. Append the table\'s id (or the GROUP BY key) so the order is total; otherwise the cut '
        + 'falls arbitrarily inside a tie group and paged reads can skip rows entirely.');
    });
  }

  test('the sweep is actually looking at something', () => {
    const admin = fs.readFileSync(path.join(ROUTES, 'admin.ts'), 'utf8');
    const found = truncatingOrderBys(admin);
    assert.ok(found.length >= 8, `expected several truncating ORDER BYs in admin.ts, saw ${found.length}`);
    // And it must be able to SEE a bad one, or it is asserting nothing.
    assert.deepEqual(truncatingOrderBys('const q = `SELECT 1 ORDER BY created_at DESC LIMIT 10`;')
      .filter((c) => !UNIQUE_TAIL.test(c)).length, 1);
  });
});
