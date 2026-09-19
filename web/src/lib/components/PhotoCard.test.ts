// Three things a host complained about on a phone, pinned so they cannot come back.
//
//  1. The save arrow was a different character at a different size on every surface, and all of
//     them were small. It is one drawn SVG now, from one component.
//  2. The save plate sat ON the photo, bottom-right — over the part of the card somebody is
//     actually looking at. It belongs in the card's foot.
//  3. In select mode only the picture picked the photo. The caption and the name under it look
//     exactly as pressable and did nothing.
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';

/** fireEvent has no dblclick shorthand; the component listens for the real event. */
const dblclick = (el: Element) =>
  fireEvent(el, new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
import { tick } from 'svelte';
import PhotoCard from './PhotoCard.svelte';
import type { Photo } from '$lib/events';

const photo = (over: Partial<Photo> = {}): Photo => ({
  id: 'p1', url: '/u/p1.jpg', thumbUrl: '/u/p1t.jpg', takenAt: 1_700_000_000_000,
  participantName: 'Ada', participantId: 'g1', isHighlighted: false, rating: 0,
  mediaType: 'photo', width: 1000, height: 1000, ...over,
});

describe('the download control sits in the card, not on the photo', () => {
  it('renders the download plate in the foot and never inside the tile', () => {
    const { container } = render(PhotoCard, { photo: photo(), canDownload: true });
    const dl = container.querySelector('.dl-corner');
    expect(dl).not.toBeNull();
    // The point of the change: the tile is the picture, and nothing of ours is on top of it.
    expect(container.querySelector('.ptile .dl-corner')).toBeNull();
    expect(dl!.closest('.pmeta')).not.toBeNull();
  });

  it('draws the shared SVG arrow rather than a text glyph', () => {
    const { container } = render(PhotoCard, { photo: photo(), canDownload: true });
    const dl = container.querySelector('.dl-corner')!;
    expect(dl.querySelector('svg')).not.toBeNull();
    // U+2B07 and U+2913 are what the four surfaces used to disagree over. Neither renders the same
    // on iOS and Android, which was the whole complaint.
    expect(dl.textContent).not.toMatch(/[⬇⤓]/);
  });

  it('keeps its own accessible name, and the icon out of the accessibility tree', () => {
    const { container } = render(PhotoCard, { photo: photo(), canDownload: true });
    const dl = container.querySelector('.dl-corner')!;
    expect(dl.getAttribute('aria-label')).toBe('Download to your device');
    expect(dl.querySelector('svg')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('says so when the file is already on this device, without becoming a tick', () => {
    const { container } = render(PhotoCard, { photo: photo(), canDownload: true, saved: true });
    const dl = container.querySelector('.dl-corner')!;
    expect(dl.classList.contains('done')).toBe(true);
    expect(dl.querySelector('svg')).not.toBeNull();
    expect(dl.getAttribute('aria-label')).toBe('Downloaded — download again');
  });

  it('adds nothing to the foot at all when the surface does not offer downloads', () => {
    // The card foot's reserve is meant to collapse to nothing on a grid with no captions — a
    // control that is not offered must not leave a hole where it would have been.
    const { container } = render(PhotoCard, { photo: photo() });
    expect(container.querySelector('.dl-corner')).toBeNull();
    expect(container.querySelector('.pmeta')!.children.length).toBe(1);
  });
});

describe('selecting works on the whole card, not just the picture', () => {
  it('picks the photo when the text under it is pressed', async () => {
    const { container, component } = render(PhotoCard, {
      photo: photo({ caption: 'Nice' }), selectable: true, meta: 'Ada · 7:04 pm',
    });
    const open = vi.fn();
    component.$on('open', open);
    await fireEvent.click(container.querySelector('.pmeta')!);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('leaves the foot inert when the grid is not selecting', async () => {
    const { container, component } = render(PhotoCard, { photo: photo(), meta: 'Ada · 7:04 pm' });
    const open = vi.fn();
    component.$on('open', open);
    await fireEvent.click(container.querySelector('.pmeta')!);
    expect(open).not.toHaveBeenCalled();
  });

  it('marks the foot as a control so a finger does not start selecting its text', () => {
    // A tapped region that is still selectable text raises the phone's Copy/Look Up menu under a
    // thumb. app.css's list at the top of the file matches control SHAPES; a card foot is only
    // sometimes a control, so it carries the class instead.
    const { container } = render(PhotoCard, { photo: photo(), selectable: true });
    expect(container.querySelector('.pmeta')!.classList.contains('pickable')).toBe(true);
    expect(render(PhotoCard, { photo: photo() }).container
      .querySelector('.pmeta')!.classList.contains('pickable')).toBe(false);
  });

  it('still saves — and does not pick — when the save plate itself is pressed', async () => {
    const { container, component } = render(PhotoCard, {
      photo: photo(), selectable: true, canDownload: true,
    });
    const open = vi.fn();
    const download = vi.fn();
    component.$on('open', open);
    component.$on('download', download);
    await fireEvent.click(container.querySelector('.dl-corner')!);
    expect(download).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });

  it('does not pick the photo when a disabled save plate swallows the press', async () => {
    // A `disabled` button fires no events at all, so the click lands on the foot behind it. Saving
    // is not picking, and a press that looked like it did nothing must not quietly do something.
    const { container, component } = render(PhotoCard, {
      photo: photo(), selectable: true, canDownload: true, saving: true,
    });
    const open = vi.fn();
    component.$on('open', open);
    // Dispatched from the plate so it bubbles through the foot exactly as a real stray press
    // would; fireEvent would not deliver one to a disabled control at all.
    container.querySelector('.dl-corner')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick();
    expect(open).not.toHaveBeenCalled();
  });

  it('opens the caption editor rather than picking, when a card offers one', async () => {
    const { container, component } = render(PhotoCard, {
      photo: photo({ caption: 'Nice' }), selectable: true, captionMode: 'edit',
    });
    const open = vi.fn();
    const caption = vi.fn();
    component.$on('open', open);
    component.$on('caption', caption);
    await fireEvent.click(container.querySelector('.capstrip.edit')!);
    expect(caption).toHaveBeenCalledTimes(1);
    expect(open).not.toHaveBeenCalled();
  });
});

describe('one arrow, everywhere', () => {
  // The drift this is here to stop: four surfaces, four glyphs, four sizes. If a new download or
  // save control is written with a character instead of <DownloadIcon />, this fails.
  //
  // Read through Vite rather than node:fs — `web/` has no @types/node, and a test that will not
  // typecheck is a test nobody keeps.
  const sources = import.meta.glob('/src/**/*.svelte', {
    query: '?raw', import: 'default', eager: true,
  }) as Record<string, string>;

  /** Comments are where the OLD glyphs are written down on purpose — DownloadIcon.svelte spends a
   *  paragraph on why neither of them works. Only what renders is checked. */
  const markup = (src: string) =>
    src.replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  it('has a glob that actually matched the app', () => {
    // A glob that silently found nothing would make the assertion below vacuously true.
    expect(Object.keys(sources).length).toBeGreaterThan(30);
  });

  it('leaves no download or save control drawn with a font character', () => {
    const offenders = Object.entries(sources)
      .filter(([, src]) =>
        /[⬇⤓⭳📥]/u.test(
          markup(src)
            // The header-image DROP ZONE is an upload, not a save: an arrow pointing INTO the page
            // means the opposite thing there, and a download icon would be a lie. Left alone.
            .replace('⤓ Drop image to upload', ''),
        ),
      )
      .map(([f]) => f);
    expect(offenders).toEqual([]);
  });

  it('is imported by every surface that offers one', () => {
    const surfaces = [
      '/src/lib/components/PhotoCard.svelte',      // the event gallery's card
      '/src/lib/components/Lightbox.svelte',       // the single-photo view
      '/src/lib/components/Camera.svelte',         // the guest's own roll
      '/src/routes/admin/[code]/+page.svelte',     // the QR save
      '/src/routes/gallery/[code]/+page.svelte',
      '/src/routes/s/[token]/+page.svelte',
      '/src/routes/admin/[code]/review/+page.svelte',
      '/src/lib/components/SlideshowPanel.svelte',
    ];
    for (const f of surfaces) {
      expect(sources[f]).toContain("import DownloadIcon from '$lib/components/DownloadIcon.svelte'");
    }
  });
});

// ── The heart ────────────────────────────────────────────────────────────────────────────────
describe('hearting a photo', () => {
  const heartable = { photo: photo(), hearts: 0, canHeart: true };

  it('draws the heart, not a heart-shaped character', () => {
    // ♥ / ♡ are typographic hearts drawn by whatever font the device picks for that codepoint,
    // which is why the same control was a different shape on every phone.
    const { container } = render(PhotoCard, { props: heartable });
    const btn = container.querySelector('.heart')!;
    expect(btn.querySelector('svg.heart-i'), 'the heart should be drawn').not.toBeNull();
    expect(btn.textContent ?? '').not.toMatch(/[\u2665\u2661]/);
  });

  it('wears no button chrome — the heart sits on the picture by itself', () => {
    const { container } = render(PhotoCard, { props: heartable });
    const btn = container.querySelector('.heart') as HTMLElement;
    // Still a real button, for the keyboard and for aria-pressed.
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
  });

  it('shows the count in the event gallery and hides it in your own roll', () => {
    const withCount = render(PhotoCard, { props: { ...heartable, hearts: 7 } });
    expect(withCount.container.querySelector('.heart .hn')?.textContent).toBe('7');
    // A count on your own photographs is a score on your own photographs.
    const own = render(PhotoCard, { props: { ...heartable, hearts: 7, showHeartCount: false } });
    expect(own.container.querySelector('.heart .hn'), 'no number in the guest roll').toBeNull();
    expect(own.container.querySelector('.heart'), 'but the heart is still there to press').not.toBeNull();
  });

  it('hearts on a double tap of the picture, and does not also open it', async () => {
    const { container, component } = render(PhotoCard, { props: heartable });
    const hearted = vi.fn(); const opened = vi.fn();
    component.$on('heart', (e) => hearted(e.detail));
    component.$on('open', opened);

    const cell = container.querySelector('.pcell') as HTMLElement;
    await fireEvent.click(cell);
    await fireEvent(cell, new MouseEvent("dblclick", { bubbles: true, cancelable: true }));
    await tick();
    expect(hearted, 'a double tap should heart').toHaveBeenCalledWith(true);
    // The pending single-tap open must have been cancelled, or the lightbox opens behind the heart.
    await new Promise((r) => setTimeout(r, 400));
    expect(opened, 'the double tap should not also open the photo').not.toHaveBeenCalled();
  });

  it('still opens the photo on a single tap', async () => {
    const { container, component } = render(PhotoCard, { props: heartable });
    const opened = vi.fn();
    component.$on('open', opened);
    await fireEvent.click(container.querySelector('.pcell') as HTMLElement);
    await new Promise((r) => setTimeout(r, 400));
    expect(opened).toHaveBeenCalled();
  });

  // A mistimed second tap must never take a heart away: undoing silently is worse than doing
  // nothing, and the heart itself is right there for taking it back on purpose.
  it('never un-hearts on a double tap', async () => {
    const { container, component } = render(PhotoCard, { props: { ...heartable, hearts: 3, hearted: true } });
    const hearted = vi.fn();
    component.$on('heart', (e) => hearted(e.detail));
    await dblclick(container.querySelector('.pcell') as HTMLElement);
    expect(hearted).not.toHaveBeenCalled();
  });

  it('does nothing for somebody who was not at the event', async () => {
    const { container, component } = render(PhotoCard, { props: { photo: photo(), hearts: 5, canHeart: false } });
    const hearted = vi.fn(); const opened = vi.fn();
    component.$on('heart', (e) => hearted(e.detail));
    component.$on('open', opened);
    await dblclick(container.querySelector('.pcell') as HTMLElement);
    expect(hearted).not.toHaveBeenCalled();
    // …and their tap still opens the photo with no delay in the way.
    await fireEvent.click(container.querySelector('.pcell') as HTMLElement);
    expect(opened).toHaveBeenCalled();
  });
});

// ── The same gesture, the mark that belongs to whoever is looking ────────────────────────────
describe('double tap on the host’s review grid favourites instead', () => {
  const reviewable = { photo: photo(), hearts: 4, canHeart: false, doubleTap: 'favourite' as const };

  it('marks the photo a favourite, and does not open it', async () => {
    const { container, component } = render(PhotoCard, { props: reviewable });
    const faved = vi.fn(); const opened = vi.fn();
    component.$on('favourite', faved);
    component.$on('open', opened);
    await dblclick(container.querySelector('.pcell') as HTMLElement);
    expect(faved).toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 400));
    expect(opened).not.toHaveBeenCalled();
  });

  it('never un-favourites — the corner star is how you take it back', async () => {
    const { container, component } = render(PhotoCard, { props: { ...reviewable, favourite: true } });
    const faved = vi.fn();
    component.$on('favourite', faved);
    await dblclick(container.querySelector('.pcell') as HTMLElement);
    expect(faved).not.toHaveBeenCalled();
  });

  it('does not heart, because the count on this screen is the room’s', async () => {
    const { container, component } = render(PhotoCard, { props: reviewable });
    const hearted = vi.fn();
    component.$on('heart', hearted);
    await dblclick(container.querySelector('.pcell') as HTMLElement);
    expect(hearted).not.toHaveBeenCalled();
    // …and the count is still shown, just not pressable.
    expect(container.querySelector('.heart .hn')?.textContent).toBe('4');
    expect(container.querySelector('button.heart'), 'a host gets no vote').toBeNull();
  });

  it('opens on the FIRST tap when the gesture is switched off', async () => {
    // Select mode: a tap means "pick this", and a delay waiting for a second tap that does nothing
    // would be felt on every single card.
    const { container, component } = render(PhotoCard, { props: { ...reviewable, doubleTap: 'none' as const } });
    const opened = vi.fn();
    component.$on('open', opened);
    await fireEvent.click(container.querySelector('.pcell') as HTMLElement);
    expect(opened, 'no waiting around').toHaveBeenCalled();
  });
});
