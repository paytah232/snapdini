// Straightening a photo the phone stored sideways.
//
// The whole feature is one rule — PREVIEW LOCALLY, COMMIT ONCE — and every way it can go wrong is
// a way that rule gets broken: a request per tap, a full circle posted as a rotation, a pending
// turn that survives onto the next photograph, or the old filename kept after a correction that
// renamed it (which is not a stale picture, it is a broken one: the server unlinks the old name).
//
// Behaviour tests against a rendered component and against the one pure helper, rather than
// assertions about markup. `?raw` is not used here — unlike readonlyClient.test.ts, which pins
// wiring that cannot be rendered, everything below can be pressed. Where a source check WOULD have
// been needed ("does Save ever send 0?"), pressing four times and counting the requests answers the
// same question without pinning the spelling of the guard.
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';
import Lightbox from './Lightbox.svelte';
import { normalizeTurn, type Photo, type PhotoRotation } from '$lib/events';

const photo = (over: Partial<Photo> = {}): Photo => ({
  id: 'p1', url: '/uploads/p1.jpg', takenAt: 1_700_000_000_000,
  participantName: 'Ada', participantId: 'g1', isHighlighted: false, rating: 0,
  mediaType: 'photo', ...over,
});

/** A reply in the shape the route really sends. */
const reply = (over: Partial<PhotoRotation> = {}): PhotoRotation => ({
  success: true, id: 'p1', url: '/uploads/p1-r.jpg', thumbUrl: '/uploads/p1-r_thumb.webp',
  width: 3, height: 4, captureRotation: 90, shotSideways: false, ...over,
});

/** The control that is actually OFFERED.
 *
 *  Both faces of the rotate slot are in the DOM at all times — that is the mechanism that stops it
 *  resizing when you press it (see RotateControl.svelte) — so a bare querySelector finds the
 *  hidden one as happily as the shown one. Everything below is about what a person can reach, so
 *  everything below goes through here. */
const live = (c: HTMLElement, label: string) => {
  // ALL of them, not the first: "Turn left" is on both faces, so a querySelector that stops at the
  // first match keeps finding the hidden one and reporting the control as absent.
  const all = [...c.querySelectorAll<HTMLButtonElement>(`[aria-label="${label}"]`)];
  return all.find((el) => !el.closest('[aria-hidden="true"]')) ?? null;
};
/** Turning clockwise is one press whichever face is up: the resting button, or the right-hand
 *  segment it becomes. */
const rotateBtn = (c: HTMLElement) =>
  live(c, 'Rotate this photo a quarter turn clockwise') ?? live(c, 'Turn right');
const leftBtn = (c: HTMLElement) => live(c, 'Turn left');
const saveBtn = (c: HTMLElement) => live(c, 'Save this rotation');
const cancelBtn = (c: HTMLElement) => live(c, 'Discard this rotation');

/** jsdom's cssstyle does not implement `transform`, so read what the directive actually wrote. */
const transformOf = (el: Element | null) =>
  (el as HTMLElement | null)?.style.transform || el?.getAttribute('style') || '';

const tap = async (c: HTMLElement, times = 1) => {
  for (let i = 0; i < times; i++) await fireEvent.click(rotateBtn(c)!);
  await tick();
};

/** A fetch that answers every call with one body, and remembers what it was asked. */
function stubFetch(body: unknown = reply()) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return { calls, fn };
}

/* jsdom does not fetch anything, so a real `new Image()` here never fires load OR error and the
 * save sits out preloadStills' whole timeout before the preview comes off. That is correct
 * behaviour against a browser that cannot load images and useless for testing one that can — so
 * these tests get an Image that resolves immediately, which is what the code is written against.
 *
 * Without it the two assertions about what is on screen AFTER a save are really assertions about
 * what is on screen DURING one, and they read as regressions in the fix that put them there. */
class InstantImage {
  set src(_v: string) { queueMicrotask(() => this.onload?.()); }
  onload?: () => void;
  onerror?: () => void;
  decode() { return Promise.resolve(); }
}
/** Two ticks used to be enough, because saving a turn was one await deep: post, then swap.
 *  Holding the preview until the turned bytes are decoded adds a preload, a decode() and the
 *  promise plumbing around them, so the assertions were landing partway through the save and
 *  reporting the half-finished state as the finished one. Drain properly instead of counting
 *  ticks — a count is a thing that silently becomes wrong the next time the chain grows. */
async function settled() {
  // A macrotask, not a pile of microtask awaits: one setTimeout(0) lets everything already queued
  // run, however deep the chain gets, and does not have to be re-tuned when it grows again.
  await new Promise((r) => setTimeout(r, 0));
  await tick();
}

beforeEach(() => vi.stubGlobal('Image', InstantImage as never));
afterEach(() => vi.unstubAllGlobals());

// ── Agreeing with the server on what a turn is called ────────────────────────────────────────
describe('folding a running total into the window the API speaks in', () => {
  it('names every turn the one way the route accepts', () => {
    // The route refuses 270 outright rather than folding it — a client sending 270 has a bug worth
    // seeing. Which makes this fold the thing that keeps an accumulating control honest.
    expect(normalizeTurn(90)).toBe(90);
    expect(normalizeTurn(180)).toBe(180);
    expect(normalizeTurn(270)).toBe(-90);
    expect(normalizeTurn(360)).toBe(0);
    expect(normalizeTurn(450)).toBe(90);
    expect(normalizeTurn(-90)).toBe(-90);
    expect(normalizeTurn(-270)).toBe(90);
    // 180 stays 180 and never becomes -180: the window is (-180, 180].
    expect(normalizeTurn(-180)).toBe(180);
  });
});

// ── Who is offered the control ───────────────────────────────────────────────────────────────
describe('who may turn a photo', () => {
  it('nobody, by default — every surface has to opt in', () => {
    const { container } = render(Lightbox, { photos: [photo()], index: 0 });
    expect(rotateBtn(container)).toBeNull();
  });

  it("'own' offers it on a guest's own shot and on nothing else", () => {
    const mine = render(Lightbox, { photos: [photo({ isOwn: true })], index: 0, rotateMode: 'own' });
    expect(rotateBtn(mine.container)).not.toBeNull();
    // isOwn absent reads the same as false: the gallery payload is shared-cacheable and does not
    // carry the field at all for a viewer the server declined to identify.
    const theirs = render(Lightbox, { photos: [photo()], index: 0, rotateMode: 'own' });
    expect(rotateBtn(theirs.container)).toBeNull();
  });

  it("'any' offers it on somebody else's shot — that is the host", () => {
    const { container } = render(Lightbox, { photos: [photo()], index: 0, rotateMode: 'any' });
    expect(rotateBtn(container)).not.toBeNull();
  });

  it('is reachable by keyboard and says what it does', () => {
    const { container } = render(Lightbox, { photos: [photo()], index: 0, rotateMode: 'any' });
    const b = rotateBtn(container)!;
    expect(b.tagName).toBe('BUTTON');            // a real button, so Enter and Space already work
    expect(b.getAttribute('aria-label')).toContain('clockwise');
    // The lightbox's own skin of the shared control, so it is the same pill as Download beside it
    // rather than a second look for the same kind of thing.
    expect(b.closest('.rot.bar'), 'wearing the lightbox skin of RotateControl').not.toBeNull();
  });
});

// ── The slot the control lives in ────────────────────────────────────────────────────────────
describe('the rotate control keeps its place', () => {
  it('swaps its face in one slot rather than adding buttons to the bar', async () => {
    const { container } = render(Lightbox, { photos: [photo()], index: 0, rotateMode: 'any' });
    const slot = container.querySelector('.rot')!;
    const before = container.querySelectorAll('.lb-bar button').length;
    // Every segment is present from the start: that is WHY the slot cannot resize, and it is why
    // `live()` exists. Only the resting pair is reachable.
    expect(slot.querySelectorAll('button')).toHaveLength(6);
    expect(saveBtn(container)).toBeNull();
    expect(cancelBtn(container)).toBeNull();

    await tap(container);

    // Same slot, same buttons, different face. A bar that grew by two controls is the complaint
    // this replaced: it moved Download out from under the next tap.
    expect(container.querySelector('.rot')).toBe(slot);
    expect(container.querySelectorAll('.lb-bar button')).toHaveLength(before);
    expect(saveBtn(container)).not.toBeNull();
    expect(cancelBtn(container)).not.toBeNull();
    expect(live(container, 'Rotate this photo a quarter turn clockwise')).toBeNull();
  });

  it('turns anticlockwise in ONE press from rest, not three', async () => {
    const { fn } = stubFetch();
    const { container } = render(Lightbox, { photos: [photo()], index: 0, rotateMode: 'any' });
    // The point of the left arrow, and the reason it is offered at rest rather than only once
    // something is pending: revealing it by first going the wrong way would still be three presses.
    await fireEvent.click(leftBtn(container)!);
    await tick();
    expect(transformOf(container.querySelector('img'))).toContain('rotate(-90deg)');
    expect(saveBtn(container)).not.toBeNull();
    expect(fn, 'still nothing on the wire until Save').not.toHaveBeenCalled();

    // …and back again, which returns the slot to its resting face with nothing to save.
    await fireEvent.click(rotateBtn(container)!);
    await tick();
    expect(transformOf(container.querySelector('img'))).not.toContain('rotate');
    expect(saveBtn(container)).toBeNull();
  });
});

// ── The preview ──────────────────────────────────────────────────────────────────────────────
describe('turning the picture on screen', () => {
  it('turns it with a transform and asks the server nothing', async () => {
    const { fn } = stubFetch();
    const { container } = render(Lightbox, { photos: [photo()], index: 0, rotateMode: 'any' });
    const img = container.querySelector('img')!;
    expect(transformOf(img)).not.toContain('rotate');

    await tap(container);
    expect(transformOf(img)).toContain('rotate(90deg)');
    await tap(container);
    expect(transformOf(img)).toContain('rotate(180deg)');
    // The whole point: two taps, no requests. A write per 90° would rename and republish the file
    // twice on the way to where one request lands.
    expect(fn).not.toHaveBeenCalled();
  });

  it('a video turns too', async () => {
    const { container } = render(Lightbox, {
      photos: [photo({ mediaType: 'video', url: '/uploads/p1.webm', playUrl: '/uploads/p1.mp4' })],
      index: 0, rotateMode: 'any',
    });
    await tap(container);
    expect(transformOf(container.querySelector('video'))).toContain('rotate(90deg)');
  });

  it('offers Save and Cancel only while something is pending', async () => {
    const { container } = render(Lightbox, { photos: [photo()], index: 0, rotateMode: 'any' });
    expect(saveBtn(container)).toBeNull();
    expect(cancelBtn(container)).toBeNull();
    await tap(container);
    expect(saveBtn(container)).not.toBeNull();
    expect(cancelBtn(container)).not.toBeNull();
  });

  it('a fourth tap is a full circle, so there is nothing left to save', async () => {
    const { fn } = stubFetch();
    const { container } = render(Lightbox, { photos: [photo()], index: 0, rotateMode: 'any' });
    await tap(container, 4);
    expect(transformOf(container.querySelector('img'))).not.toContain('rotate');
    // Not merely "0 is refused" — there is no Save to press, so a full circle cannot be posted at
    // all. The route rejects 0 anyway; asking it to is a round trip that renames nothing.
    expect(saveBtn(container)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
  });

  it('Cancel puts it back', async () => {
    const { container } = render(Lightbox, { photos: [photo()], index: 0, rotateMode: 'any' });
    await tap(container, 2);
    await fireEvent.click(cancelBtn(container)!);
    await tick();
    expect(transformOf(container.querySelector('img'))).not.toContain('rotate');
    expect(saveBtn(container)).toBeNull();
  });
});

// ── Committing it ────────────────────────────────────────────────────────────────────────────
describe('saving the turn', () => {
  it('sends the accumulated total ONCE, clockwise, with the guest’s session', async () => {
    const { calls, fn } = stubFetch(reply({ captureRotation: -90 }));
    const { container } = render(Lightbox, {
      photos: [photo({ isOwn: true })], index: 0, rotateMode: 'own', sessionToken: 's1',
    });
    await tap(container, 3);                     // 90, 180, then -90 — never 270, which the route refuses
    await fireEvent.click(saveBtn(container)!);
    await tick();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe('/api/photos/p1/rotate');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ quarter: -90, sessionToken: 's1' });
  });

  it('the host sends the organizer code in the header, and no session with it', async () => {
    const { calls } = stubFetch();
    const { container } = render(Lightbox, {
      photos: [photo()], index: 0, rotateMode: 'any', organizerCode: 'OC1', sessionToken: 's1',
    });
    await tap(container);
    await fireEvent.click(saveBtn(container)!);
    await tick();

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['X-Organizer-Code']).toBe('OC1');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ quarter: 90 });
  });

  it('shows the file under its NEW name, because the old one no longer exists', async () => {
    stubFetch(reply({ url: '/uploads/p1-r.jpg' }));
    const { container } = render(Lightbox, {
      photos: [photo()], index: 0, rotateMode: 'any', sessionToken: 's1',
    });
    await tap(container);
    await fireEvent.click(saveBtn(container)!);
    await settled();

    // The rename IS the cache-bust. Keeping /uploads/p1.jpg here would be a broken image, not a
    // stale one — the server unlinks the old name the moment the row moves.
    expect(container.querySelector('img')!.getAttribute('src')).toBe('/uploads/p1-r.jpg');
    // And the pending turn is gone, so the corrected bytes are not drawn turned a second time.
    expect(transformOf(container.querySelector('img'))).not.toContain('rotate');
  });

  it('plays the corrected clip, and the original until the rebuilt copy lands', async () => {
    const clip = () => photo({ mediaType: 'video', url: '/uploads/p1.mp4', playUrl: '/uploads/p1_play.mp4' });

    stubFetch(reply({ url: '/uploads/p1-r.mp4', playUrl: '/uploads/p1-r_play.mp4' }));
    const withPlay = render(Lightbox, { photos: [clip()], index: 0, rotateMode: 'any', sessionToken: 's1' });
    await tap(withPlay.container);
    await fireEvent.click(saveBtn(withPlay.container)!);
    await settled();
    expect(withPlay.container.querySelector('video')!.getAttribute('src')).toBe('/uploads/p1-r_play.mp4');

    // playUrl is absent for a moment after a clip is turned — the crop is rebuilt behind the
    // reply. The original is the right thing to play until it lands, which is the same ladder the
    // markup walks for every other clip. What must NOT happen is falling back to the old name.
    vi.unstubAllGlobals();
    stubFetch(reply({ url: '/uploads/p1-r.mp4', playUrl: undefined }));
    const noPlay = render(Lightbox, { photos: [clip()], index: 0, rotateMode: 'any', sessionToken: 's1' });
    await tap(noPlay.container);
    await fireEvent.click(saveBtn(noPlay.container)!);
    await settled();
    expect(noPlay.container.querySelector('video')!.getAttribute('src')).toBe('/uploads/p1-r.mp4');
  });

  it('hands the parent the whole reply, rather than reaching into its photos', async () => {
    const body = reply({ shotSideways: false, width: 3, height: 4 });
    stubFetch(body);
    const told: { id: string; quarter: number; result: PhotoRotation }[] = [];
    const { container } = render(Lightbox, {
      props: { photos: [photo({ shotSideways: true })], index: 0, rotateMode: 'any', sessionToken: 's1' },
      events: {
        rotated: (e: CustomEvent<{ id: string; quarter: number; result: PhotoRotation }>) =>
          told.push(e.detail)
      }
    });

    await tap(container);
    await fireEvent.click(saveBtn(container)!);
    await settled();

    expect(told).toHaveLength(1);
    expect(told[0].id).toBe('p1');
    expect(told[0].quarter).toBe(90);
    // The new names, the swapped dimensions AND shotSideways as a real boolean — everything the
    // gallery needs to correct its tile and drop the ↻ mark without a refetch.
    expect(told[0].result).toEqual(body);
    expect(told[0].result.shotSideways).toBe(false);
  });

  it('keeps the turn on screen and says so when the server refuses', async () => {
    // 404 is what this route answers for "not yours" as well as "not there".
    vi.stubGlobal('fetch', vi.fn(async () => (
      { ok: false, status: 404, json: async () => ({}) } as unknown as Response)));
    const told: unknown[] = [];
    const { container } = render(Lightbox, {
      props: { photos: [photo()], index: 0, rotateMode: 'any', sessionToken: 's1' },
      events: { rotated: (e: CustomEvent<unknown>) => told.push(e.detail) }
    });

    await tap(container);
    await fireEvent.click(saveBtn(container)!);
    await settled();

    // Nothing was corrected, so nothing pretends it was: the turn is still pending and still
    // saveable, the picture keeps the name it came in with, and the parent is not sent off to
    // merge a rotation that did not happen.
    expect(transformOf(container.querySelector('img'))).toContain('rotate(90deg)');
    expect(saveBtn(container)).not.toBeNull();
    expect(container.querySelector('img')!.getAttribute('src')).toBe('/uploads/p1.jpg');
    expect(told).toHaveLength(0);
  });

  it('disables the controls while the request is in flight', async () => {
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', vi.fn(async () => {
      await hang;
      return { ok: true, status: 200, json: async () => reply() } as unknown as Response;
    }));
    const { container } = render(Lightbox, {
      photos: [photo(), photo({ id: 'p2' })], index: 0, rotateMode: 'any', sessionToken: 's1',
    });
    await tap(container);
    await fireEvent.click(saveBtn(container)!);
    await tick();

    expect(rotateBtn(container)!.disabled).toBe(true);
    expect(saveBtn(container)!.disabled).toBe(true);
    expect(cancelBtn(container)!.disabled).toBe(true);
    release();
  });
});

// ── A pending turn must not leak onto the next photograph ────────────────────────────────────
describe('paging away with a turn pending', () => {
  it('discards it rather than carrying it to the next photo', async () => {
    const moved: number[] = [];
    const { container } = render(Lightbox, {
      props: { photos: [photo(), photo({ id: 'p2', url: '/uploads/p2.jpg' })], index: 0, rotateMode: 'any' },
      events: { photochange: (e: CustomEvent<number>) => moved.push(e.detail) }
    });

    await tap(container, 1);
    await fireEvent.click(container.querySelector('.nav.r')!);
    await tick();

    expect(moved).toEqual([1]);
    expect(container.querySelector('img')!.getAttribute('src')).toBe('/uploads/p2.jpg');
    expect(transformOf(container.querySelector('img'))).not.toContain('rotate');
    expect(saveBtn(container)).toBeNull();
  });

  it('discards it when the photo underneath changes on its own — the gallery polls', async () => {
    // Nothing in the component is called for this: the parent re-assigns `photos` and the picture
    // at `index` becomes a different photograph. A turn keyed to the index rather than the id
    // would silently belong to the wrong file.
    const { container, rerender } = render(Lightbox, {
      photos: [photo()], index: 0, rotateMode: 'any',
    });
    await tap(container);
    expect(transformOf(container.querySelector('img'))).toContain('rotate(90deg)');

    await rerender({ photos: [photo({ id: 'p9', url: '/uploads/p9.jpg' })] });
    await tick();
    expect(transformOf(container.querySelector('img'))).not.toContain('rotate');
  });

  it('will not move while a save is in flight', async () => {
    let release!: () => void;
    const hang = new Promise<void>((r) => (release = r));
    vi.stubGlobal('fetch', vi.fn(async () => {
      await hang;
      return { ok: true, status: 200, json: async () => reply() } as unknown as Response;
    }));
    const moved: number[] = [];
    const { container } = render(Lightbox, {
      props: {
        photos: [photo(), photo({ id: 'p2', url: '/uploads/p2.jpg' })], index: 0, rotateMode: 'any',
        sessionToken: 's1',
      },
      events: { photochange: (e: CustomEvent<number>) => moved.push(e.detail) }
    });

    await tap(container);
    await fireEvent.click(saveBtn(container)!);
    await tick();
    await fireEvent.click(container.querySelector('.nav.r')!);
    await tick();

    // For the moment the write is in flight, the photo under the request stays the photo on screen.
    expect(moved).toEqual([]);
    release();
  });

  it('Escape backs out of the turn before it backs out of the photo', async () => {
    let closed = 0;
    const { container } = render(Lightbox, {
      props: { photos: [photo()], index: 0, rotateMode: 'any' },
      events: { close: () => closed++ }
    });

    await tap(container);
    await fireEvent.keyDown(window, { key: 'Escape' });
    await tick();
    expect(transformOf(container.querySelector('img'))).not.toContain('rotate');
    expect(closed, 'the first Escape spends itself on the rotation').toBe(0);

    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(closed).toBe(1);
  });
});
