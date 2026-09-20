// The client half of read-only mode.
//
// Written after an audit found the first version of this did nothing at all. The pause check was
// `e instanceof ApiError && e.status === 503`, but the upload paths use XHR directly rather than
// api(), and they rejected with a bare `new Error('Upload failed (503)')` — so the branch was never
// taken and the toast storm it exists to prevent would have happened in full, in production, during
// a failover. The server was verified, the banner was verified, and the one path between them was
// not. That is why these assertions are about the WIRING, not the behaviour.
import { describe, it, expect } from 'vitest';
// Vite's ?raw, the same way PosterModal.select.test.ts reads its component. Not node:fs — the web
// tsconfig carries no node types, so fs/path/__dirname typecheck clean under vitest and then fail
// svelte-check, which is how this file shipped four errors in its first draft.
import CAMERA from './components/Camera.svelte?raw';
import LAYOUT from '../routes/+layout.svelte?raw';

describe('an upload refused because the database is read-only', () => {
  it('carries the HTTP status, so 503 can be told from a real failure', () => {
    // All three upload paths, because a photo under 5MB, a chunk, and the completion call are three
    // different code paths and only one of them being fixed is the same bug wearing a hat.
    const apiErrors = CAMERA.match(/reject\(new ApiError\(|throw new ApiError\(/g) ?? [];
    expect(apiErrors.length, 'single upload, chunk, and complete must all use ApiError').toBe(3);
    // And none of them may go back to a bare Error carrying the code only in its message.
    expect(CAMERA).not.toMatch(/reject\(new Error\(d\?\.error/);
    expect(CAMERA).not.toMatch(/reject\(new Error\(`Chunk/);
    expect(CAMERA).not.toMatch(/throw new Error\(\(d && d\.error\)/);
  });

  it('pauses rather than failing: no toast, no error state, no retry limit', () => {
    const c = CAMERA.slice(CAMERA.indexOf('async function processQueue'));
    expect(c).toMatch(/e instanceof ApiError && e\.status === 503/);
    const branch = c.slice(c.indexOf('e instanceof ApiError && e.status === 503'));
    const body = branch.slice(0, branch.indexOf('item.retries ='));
    // The three things that make it a pause. A toast here would argue with the banner; an error
    // state would show the guest a failure; counting retries would make it eventually give up on a
    // condition that ends by itself.
    expect(body).not.toMatch(/showToast/);
    expect(body).toMatch(/item\.status = 'pending'/);
    expect(body).not.toMatch(/item\.retries/);
    // It must return before the ordinary retry path, or both run.
    expect(body).toMatch(/return;/);
  });
});

describe('the recovery banner', () => {
  it('reads a FRESH config, because the memoised one never changes', () => {
    // getConfig() caches for the life of the page. Promotion back to read-write happens under a
    // running tab, so a cached config would leave the banner up on a site that had recovered.
    // Asserted against the poll BODY, not the whole file: the word getConfig() also appears in
    // the comment explaining why it is not used, and matching prose is how the last two of these
    // assertions went wrong.
    const look = LAYOUT.slice(LAYOUT.indexOf('const look = async'));
    const body = look.slice(0, look.indexOf('};'));
    expect(body).toMatch(/refreshConfig\(\)/);
    expect(body).not.toMatch(/getConfig\(\)/);
  });

  it('polls, and stops polling when the layout goes away', () => {
    expect(LAYOUT).toMatch(/setInterval\(look, 60_000\)/);
    expect(LAYOUT).toMatch(/clearInterval/);
  });

  it('keeps the banner as it was when the check itself fails', () => {
    // Mid-restart or offline: flipping the banner off because one poll failed would hide a real
    // outage, and flipping it on would invent one.
    const m = LAYOUT.slice(LAYOUT.indexOf('const look = async'));
    expect(m.slice(0, m.indexOf('};'))).toMatch(/catch \{/);
  });
});
