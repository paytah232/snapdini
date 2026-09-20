// The client-error panel on the site-admin screen, as assertions about its SOURCE.
//
// Every defect this panel was rebuilt for is one that fails silently and that jsdom cannot see.
// A list that renders one row per report instead of one per problem renders perfectly; a detail
// pane that drops the stack renders perfectly; a resolve button scoped to a single row returns
// 200 and leaves eleven identical reports behind. There is nothing to throw and nothing to catch
// — the failure is that the screen stops being worth opening, which is where it was when fifty
// production reports turned out to be eleven problems.
//
// So these are source assertions, the same call reviewLayout.test.ts and adminLock.test.ts make
// and for the same reason. `?raw` via Vite, never node:fs: the web tsconfig carries no node
// types, so fs/path typecheck clean under vitest and then fail svelte-check.
import { describe, it, expect } from 'vitest';
import SITEADMIN from '../routes/siteadmin/+page.svelte?raw';

/** Just the client-errors panel. Scoped, because half of these strings ("resolve", `.drill`,
 *  `aria-expanded`) also appear in the contact mailbox and the events table, and a test that
 *  matched those would go green on a panel that had been deleted. */
const PANEL = (() => {
  const at = SITEADMIN.indexOf('<h2>Client errors');
  expect(at, 'the client-errors panel has gone').toBeGreaterThan(-1);
  const end = SITEADMIN.indexOf('</section>', at);
  return SITEADMIN.slice(at, end);
})();

describe('the list is one row per problem', () => {
  it('renders groups, and the flat per-report list is gone', () => {
    // The whole complaint: twelve consecutive lines of one camera failure, then eight of the
    // next, and the six upload failures that may have cost somebody their photos below them.
    expect(PANEL).toContain('{#each errPaged as g}');
    expect(SITEADMIN).toContain('let errGroups');
    expect(SITEADMIN).not.toContain('let clientErrors');
  });

  it('shows how many times each one happened', () => {
    // Without the count, collapsing twelve rows into one HIDES the twelve rather than summarising
    // them, and a rare fault and a constant one look identical.
    expect(PANEL).toMatch(/\{g\.count\}/);
  });

  it('counts problems in the badge, not reports', () => {
    // "50 open" and "6 open" describe the same queue and only one of them is a workload.
    expect(PANEL).toContain('{errOpenGroups} open');
  });

  it('says when a resolved problem has started happening again', () => {
    // New reports insert unhandled, so a group that was cleared and recurred comes back open on
    // its own. It only means anything if the screen distinguishes it from one never looked at.
    expect(PANEL).toContain('since resolved');
  });
});

describe('the expandable detail row', () => {
  it('opens in the same way the rest of the page opens things', () => {
    // `.drill` is the events and revenue tables' expansion. One way of opening something beats
    // three that look slightly different.
    expect(PANEL).toContain('<tr class="drill">');
    expect(PANEL).toContain('aria-expanded={openErr === g.key}');
  });

  it('is keyed by the group, not by a row index', () => {
    // The list reloads after every resolve. Keyed by position, the open pane would jump to a
    // different problem underneath the operator mid-read; the server's key does not move.
    expect(PANEL).toMatch(/openErr = openErr === g\.key \? null : g\.key/);
  });

  it('shows the stack, and says so out loud when there is not one', () => {
    // The row that started this: `camera: TypeError Type error`, with nothing behind it. An empty
    // box would read as a rendering fault rather than as a client too old to have sent one.
    expect(PANEL).toContain('{g.latest.stack}');
    expect(PANEL).toContain('No stack');
  });

  it('shows the device, the connection and the build', () => {
    // effectiveType is the field that settles the standing question about the upload failures —
    // whether those phones were on a usable connection at all.
    expect(PANEL).toContain('{g.latest?.displayMode');
    expect(PANEL).toContain('{g.latest?.viewport');
    expect(PANEL).toContain('{g.latest?.connection');
    expect(PANEL).toContain('{g.latest?.clientBuild');
  });

  it('shows which guest, when, and on which event — per occurrence', () => {
    // Six "Event has ended" failures from one event: one phone retrying, or six people losing
    // their photos? Nobody could tell, so nobody could be contacted.
    expect(PANEL).toContain('{errGuest(o)}');
    expect(PANEL).toContain('{fmtDate(o.at)}');
    expect(PANEL).toContain('{o.eventCode');
  });

  it('is honest when it is showing a sample of a big group', () => {
    expect(PANEL).toContain('most recent of');
  });

  it('caps the stack box rather than letting it grow', () => {
    // One forty-frame stack would push every other group off the screen — the exact defect the
    // panel was rebuilt to stop, reintroduced by the fix for it.
    const at = SITEADMIN.indexOf('.stack {');
    expect(at, 'the .stack rule has gone').toBeGreaterThan(-1);
    const rule = SITEADMIN.slice(at, SITEADMIN.indexOf('}', at));
    expect(rule).toContain('max-height');
    expect(rule).toContain('overflow: auto');
  });
});

describe('resolving', () => {
  it('resolves the whole group, naming its newest report', () => {
    // Twelve identical reports used to be twelve presses.
    expect(SITEADMIN).toContain('/api/admin/client-errors/${g.latestId}/handled');
  });

  it('says which way, rather than asking the server to toggle', () => {
    // A group is routinely mixed — resolved last week, recurred this morning — so there is no
    // single value to negate. The button sends the state it is showing.
    expect(SITEADMIN).toContain('{ handled: !g.handled }');
  });
});

describe('what grouping was not allowed to cost', () => {
  it('keeps the search', () => {
    expect(PANEL).toContain('bind:value={errQuery}');
  });

  it('keeps the open / all filter', () => {
    expect(PANEL).toContain('errShowDone = false');
    expect(PANEL).toContain('errShowDone = true');
  });

  it('searches a group by its wording, where it happened and the events it came from', () => {
    // Not the stack: a search over minified frame names matches everything from one build and
    // nothing from the next.
    expect(SITEADMIN).toContain('match([g.message, g.context, ...(g.eventCodes ?? [])], errQuery)');
    expect(SITEADMIN).toContain('(errShowDone || !g.handled)');
  });
});
