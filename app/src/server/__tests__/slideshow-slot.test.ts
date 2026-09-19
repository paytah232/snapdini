// How many slideshow encodes this box will run at once.
//
// The answer used to be "as many as there are events". `startSlideshow` queues a second render for
// the SAME event behind the first — deliberately, and the comment there explains why: one ffmpeg
// run here already asks for `-threads NCPU`, stages 4K intermediates under `UPLOADS_DIR/.ss-tmp`,
// and is the reason the timeline is cut into chunks at all (one 4K graph peaked at 9.9GB). But that
// queue is keyed by event id, and nothing was keyed by the machine. Ten hosts pressing Build at the
// same moment meant ten of those, concurrently, and the only thing in the way was that hosts do not
// usually press Build at the same moment.
//
// It is organizer-gated, which is a bound on WHO, not on HOW MUCH. There is no rate limiter in
// front of it.
//
// The gate is a second slot, NOT images.ts's video slot, and that choice is the interesting part:
// reusing the video slot would have been the DRY answer and the wrong one. That slot is what a
// guest's clip waits in for its crop and its playback proxy, so a 4K render holding it for the
// several minutes it takes would leave every guest at every other event on the box with a clip
// their phone may not be able to decode at all — a Firefox or iOS WebM without its H.264 proxy is
// not "lower quality", it is unplayable. That trades an organizer's wait, which their panel is
// already showing them, for guests losing playback. One slot each is the right shape.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startSlideshow, withSlideshowSlot } from '../slideshow';
import { makeSlot } from '../images';

// Opts is internal; take its shape from the function rather than restating it. Every field is
// optional, so {} is a valid render request — and this test never gets far enough to render.
type Opts = Parameters<typeof startSlideshow>[1];
const anyRender: Opts = {};

describe('the render gate', () => {
  test('a render on one event blocks a render on another', () => {
    // Occupy the slot the way a render already in progress does. Held for the life of the test:
    // releasing it would let the queued renders reach the database, and they have no business
    // there — the assertion is about what got as far as starting, which is the whole finding.
    let holding = false;
    void withSlideshowSlot(() => { holding = true; return new Promise<void>(() => { /* held */ }); });
    assert.equal(holding, true, 'the first caller runs immediately');
    assert.deepEqual(withSlideshowSlot.stats(), { active: 1, waiting: 0 });

    // Two different events press Build. Neither may start.
    startSlideshow('slot-test-event-a', anyRender);
    startSlideshow('slot-test-event-b', anyRender);

    const st = withSlideshowSlot.stats();
    assert.equal(st.active, 1, 'only the render already holding the slot is running');
    assert.equal(st.waiting, 2, 'both new renders are queued behind it, ACROSS events');
  });

  test('the queue is cross-event, so the per-event queue is not what is doing this', () => {
    // Belt and braces on the line above: per-event queueing would have put these two nowhere near
    // each other. `pending` is keyed by event id and both ids here are fresh, so if the count above
    // were coming from that map it would be 0.
    const st = withSlideshowSlot.stats();
    assert.equal(st.waiting, 2, 'still queued — nothing released them');
  });
});

// The primitive itself, since three different limits now depend on it behaving.
describe('makeSlot', () => {
  test('never runs more than the limit at once, and runs everything eventually', async () => {
    const slot = makeSlot(2);
    let running = 0, peak = 0;
    const done: number[] = [];
    const task = (i: number) => slot(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running--; done.push(i);
    });
    await Promise.all([1, 2, 3, 4, 5, 6].map(task));
    assert.equal(peak, 2, 'two at a time, never three');
    assert.equal(done.length, 6, 'and all six ran');
    assert.deepEqual(slot.stats(), { active: 0, waiting: 0 });
  });

  test('a task that throws still gives up its slot', async () => {
    const slot = makeSlot(1);
    await assert.rejects(slot(async () => { throw new Error('boom'); }), /boom/);
    assert.deepEqual(slot.stats(), { active: 0, waiting: 0 }, 'a thrown task must not wedge the slot');
    // And the slot is genuinely usable afterwards.
    assert.equal(await slot(async () => 'through'), 'through');
  });
});
