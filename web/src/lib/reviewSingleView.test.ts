// Entering the review page's single view has TWO halves, and they have to stay together.
//
// `view = 'single'` puts it on screen; `pushState('', { sv: true })` is the history entry that
// browser-Back pops to leave it again. A reactive guard mirrors that state back into the view:
//
//     $: if (view === 'single' && !$page.state.sv) view = 'cards';
//
// …which means any code that sets the view WITHOUT pushing the state is undone on the same tick.
// The Single button in the header did exactly that, so it could never work — you could reach the
// single view by opening a card (which goes through openSingle) and never by pressing the control
// labelled Single. Nothing failed, nothing logged; the button just did nothing, forever.
//
// A source check rather than a rendered one: the fault is an assignment that a component test would
// have to reproduce the whole history integration to catch, and the rule is simply "there is one
// way in". See reactiveDeps.test.ts for the same approach.
import { describe, it, expect } from 'vitest';
import reviewSrc from '../routes/admin/[code]/review/+page.svelte?raw';

describe('the review page has one way into the single view', () => {
  it('only openSingle() puts the view into single', () => {
    const assignments = [...reviewSrc.matchAll(/view\s*=\s*'single'/g)];
    // One inside openSingle, and nothing else. Any second one is a control that cannot work.
    expect(assignments.length, 'every entry point must go through openSingle()').toBe(1);
    // The whole declaration line — `[^}]*` cannot be used, the body contains braces.
    const fn = reviewSrc.split('\n').find((l) => l.includes('function openSingle'));
    expect(fn, 'openSingle should still exist').toBeDefined();
    expect(fn!).toContain("view = 'single'");
    expect(fn!, 'the history entry is the other half').toContain('pushState');
    // ORDER: the state the guard reads has to exist before the view it guards is entered.
    expect(fn!.indexOf('pushState'), 'push the history state BEFORE entering the view')
      .toBeLessThan(fn!.indexOf("view = 'single'"));
  });

  it('leaves the single view on Back, through the window listener and nothing else', () => {
    // The mechanism, and the ONE mechanism. A second copy of this rule as a reactive statement
    // reading $page.state is what made entering the view a coin flip: that store does not update
    // synchronously with pushState, so the guard could bounce the view straight back.
    expect(reviewSrc).toContain('on:popstate={onPopState}');
    expect(reviewSrc).toMatch(/function onPopState\(\)\s*\{[^\n]*view = 'cards'/);
    expect(reviewSrc, 'no reactive mirror of $page.state.sv — it races with pushState')
      .not.toMatch(/\$:\s*if \(view === 'single' && !\$page\.state\.sv\)/);
  });

  it('the header button routes through it', () => {
    expect(reviewSrc).toContain('on:click={() => openSingle(singleIndex)}');
  });
});
