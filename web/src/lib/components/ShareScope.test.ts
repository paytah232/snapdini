// The sheet now has TWO kinds of favourite in it — the host's stars and the guests' hearts — and
// the whole risk of that is offering a row whose answer is another row's answer. What is pinned
// here is which rows appear, which is a question about SETS, not about counts that merely look
// different: a union the size of both its inputs proves the two inputs are the same photos.
//
// The other half is voice. A guest must never be shown the host's workflow words; being told about
// "the 25 you starred" describes a control panel they do not have.
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import ShareScope from './ShareScope.svelte';

/** The rows as a reader sees them: their headings, in order. */
const rows = (c: HTMLElement) => [...c.querySelectorAll('.opt b')].map((b) => b.textContent ?? '');
const row = (c: HTMLElement, text: string) =>
  [...c.querySelectorAll('.opt')].find((o) => o.querySelector('b')?.textContent === text) as HTMLElement | undefined;

/** A download sheet over a 20-photo gallery: 5 starred by the host, 8 hearted by guests, 11
 *  between them — so both halves add something and every row is worth showing. */
const props = (over: Record<string, unknown> = {}) => ({
  action: 'download' as const, approvedCount: 20, favouriteCount: 5,
  heartedCount: 8, bothCount: 11, canSelect: true, ...over,
});

describe('the guest-favourites row', () => {
  it('offers the hearted ones, most-hearted first, and answers with the hearts scope', async () => {
    const { container, component } = render(ShareScope, { props: props({ voice: 'guest' }) });
    const picked = vi.fn();
    component.$on('pickHearts', (e) => picked(e.detail));
    const r = row(container, 'What everyone loved')!;
    expect(r.textContent).toContain('The 8 with at least one');
    expect(r.textContent).toContain('most-hearted first');
    await fireEvent.click(r);
    expect(picked).toHaveBeenCalledWith('hearts');
  });

  it('is absent when the event has no hearts at all', () => {
    // How "hearts are switched off for this event" reaches the sheet: the caller passes no counts,
    // so the component needs no opinion about feature flags.
    const { container } = render(ShareScope, { props: props({ heartedCount: 0, bothCount: 5 }) });
    expect(rows(container)).not.toContain('What your guests loved');
    expect(rows(container)).not.toContain('Stars and hearts');
  });

  it('is absent when every photo is hearted, because that is the whole gallery', () => {
    const { container } = render(ShareScope, { props: props({ heartedCount: 20, bothCount: 20 }) });
    expect(rows(container)).not.toContain('What your guests loved');
  });

  it('is absent when the guests hearted exactly what the host starred', () => {
    // Same size is not the test — a union that is the size of BOTH inputs is, because that can only
    // happen when each contains the other. The host's row above is then already this row.
    const { container } = render(ShareScope, { props: props({ favouriteCount: 6, heartedCount: 6, bothCount: 6 }) });
    expect(rows(container)).not.toContain('What your guests loved');
    expect(rows(container)).toContain('Favourites only');
  });

  it('survives when there is no host-favourites row to duplicate', () => {
    // A guest's own roll: canFavourite is false, so identical counts prove nothing and hide nothing.
    const { container } = render(ShareScope, { props: props({
      canFavourite: false, subject: 'roll', voice: 'guest', favouriteCount: 6, heartedCount: 6, bothCount: 6 }) });
    expect(rows(container)).toContain('What everyone loved');
  });
});

describe('the both-sets row', () => {
  it('appears when each half adds something the other does not, and answers with the both scope', async () => {
    const { container, component } = render(ShareScope, { props: props() });
    const picked = vi.fn();
    component.$on('pickHearts', (e) => picked(e.detail));
    const r = row(container, 'Stars and hearts')!;
    expect(r.textContent).toContain('11 in all');
    await fireEvent.click(r);
    expect(picked).toHaveBeenCalledWith('both');
  });

  it('is absent when one set already contains the other', () => {
    // Union = the stars: every hearted photo was starred too, so "both" is the Favourites row.
    const starsWin = render(ShareScope, { props: props({ favouriteCount: 8, heartedCount: 3, bothCount: 8 }) });
    expect(rows(starsWin.container)).not.toContain('Stars and hearts');
    // Union = the hearts: the same duplication the other way round.
    const heartsWin = render(ShareScope, { props: props({ favouriteCount: 3, heartedCount: 8, bothCount: 8 }) });
    expect(rows(heartsWin.container)).not.toContain('Stars and hearts');
  });

  it('is absent when the two sets between them are the whole gallery', () => {
    const { container } = render(ShareScope, { props: props({ bothCount: 20 }) });
    expect(rows(container)).not.toContain('Stars and hearts');
    expect(rows(container)).toContain('The whole gallery');
  });
});

describe('who is being spoken to', () => {
  it('never puts the host-s workflow in a guest-s mouth', () => {
    const { container } = render(ShareScope, { props: props({ voice: 'guest' }) });
    const text = container.textContent ?? '';
    expect(text).not.toContain('you starred');
    expect(text).not.toContain('your guests');
    expect(row(container, 'Highlights and hearts')!.textContent).toContain("The host's 5 highlights");
  });

  it('tells the host whose favourites each row is', () => {
    const { container } = render(ShareScope, { props: props() });
    expect(row(container, 'What your guests loved')).toBeTruthy();
    expect(row(container, 'Stars and hearts')!.textContent).toContain('The 5 you starred');
  });
});

describe('sharing has no hearts axis', () => {
  // shares.kind is 'all' | 'favourites' | 'selected'. A share link is a query the server resolves
  // when it is opened, and there is no query for "the hearted ones" — so offering it here would
  // promise a link that cannot be made.
  it('offers neither hearts row under Share', () => {
    const { container } = render(ShareScope, { props: props({ action: 'share' }) });
    expect(rows(container)).toEqual(['The whole gallery', 'Favourites only', 'Pick them myself']);
  });
});

describe('rows come and go, the sheet does not', () => {
  it('still asks the question when every optional row has collapsed', () => {
    // Nothing hearted, nothing new, nothing starred: the one answer left is still a real answer,
    // and hiding the sheet here is the bug this rule exists for.
    const { container } = render(ShareScope, { props: props({ favouriteCount: 0, heartedCount: 0, bothCount: 0 }) });
    expect(rows(container)).toContain('Pick them myself');
  });
});
