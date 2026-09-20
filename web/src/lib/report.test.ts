// The error reporter, and the two ways it can fail that nobody would ever see.
//
//   1. IT CAN THROW. It runs on the worst path in the app — a camera that would not open, an
//      upload that died — usually inside a `catch`, sometimes while the page is being torn down.
//      An exception here replaces the error the guest actually hit with one from the code that
//      was supposed to write it down, and the original is gone. So every assertion below that
//      looks trivial ("returns undefined") is really "the guest still got their own error".
//   2. IT CAN OVER-COLLECT. This is a public repo with a privacy policy attached, and the natural
//      drift of a diagnostics payload is upward — one more field, always defensible on its own.
//      The field test here is therefore an ALLOWLIST: anything new has to be added deliberately,
//      with a reason, rather than arriving with a passing suite.
//
// jsdom, not a browser: what is real here is the payload and the headers, which is where both
// failures live. What a browser would add — that `keepalive` survives a page unload, that
// `navigator.connection` exists on the Android handsets the upload question is about — cannot be
// asserted here and is not pretended at.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { reportClientError } from './report';

/** Every field the reporter is allowed to send. Adding one here is the deliberate act; the test
 *  below fails on anything that turns up without being listed.
 *
 *  What is NOT here, and why, in the order someone would be tempted to add them: no email or
 *  guest name (the server keeps a participant id and joins the name in, so erasing a guest erases
 *  it from the console too); no session or organizer token in the body (the session token goes in
 *  the header it already goes in on every other call, and is exchanged server-side for an id);
 *  no `location.href`, `search` or `hash` (a custom join link carries a code and an organizer
 *  link carries a credential); no caption, filename, photo or anything a person typed; no
 *  geolocation, device memory or CPU count; and of the connection, only the coarse
 *  `effectiveType` bucket — downlink and rtt are continuous values that make a handset more
 *  identifiable and would not have answered anything. */
const ALLOWED = [
  'message', 'context', 'eventCode', 'url', 'stack',
  'build', 'displayMode', 'viewport', 'connection', 'outcome',
].sort();

const SESSION_TOKEN = 'session-token-not-a-real-one';

let fetchMock: ReturnType<typeof vi.fn>;

/** The one call the reporter made, in the shape it actually made it — `vi.fn()` infers nothing
 *  useful about a stubbed global, and a cast in one place beats ten. */
type PostedCall = [string, { headers: Record<string, string>; body: string }];
function posted(): PostedCall {
  expect(fetchMock).toHaveBeenCalled();
  return fetchMock.mock.calls[0] as unknown as PostedCall;
}
const sent = (): Record<string, unknown> => JSON.parse(posted()[1].body) as Record<string, unknown>;
const headers = (): Record<string, string> => posted()[1].headers;

beforeEach(() => {
  localStorage.clear();
  fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
  vi.stubGlobal('fetch', fetchMock);
  history.replaceState({}, '', '/');
});

describe('it never becomes a second error', () => {
  it('reports from a page with no session at all', () => {
    // The common case, not an edge one: the marketing pages, the host dashboard, and any guest
    // whose browser cleared its storage. There is no token to find and that is not a failure.
    expect(() => reportClientError('camera: TypeError Type error', 'camera')).not.toThrow();
    expect(sent().message).toBe('camera: TypeError Type error');
  });

  it('reports when the call site knows an event but the browser has no session for it', () => {
    expect(() => reportClientError('Event has ended', 'upload', 'ABC123')).not.toThrow();
    expect(headers()['X-Session-Token']).toBeUndefined();
  });

  it('swallows a fetch that throws outright', () => {
    fetchMock.mockImplementation(() => { throw new Error('no network stack at all'); });
    expect(() => reportClientError('Load failed', 'upload')).not.toThrow();
  });

  it('swallows a fetch that rejects later', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('offline')));
    expect(() => reportClientError('Load failed', 'upload')).not.toThrow();
    // An unhandled rejection would surface as a console error on a guest's phone and, under a
    // strict host, as a page-level error event — the exact noise this function exists to avoid.
    await Promise.resolve();
  });

  it('returns nothing, so no caller can come to depend on a result', () => {
    expect(reportClientError('x')).toBeUndefined();
  });
});

describe('what it captures', () => {
  it('sends only the fields on the allowlist', () => {
    localStorage.setItem('session_ABC123', SESSION_TOKEN);
    history.replaceState({}, '', '/join/ABC123?invite=a-secret#org=another');
    reportClientError('Event has ended', 'upload', 'ABC123', { error: new Error('boom'), outcome: 'lost' });
    for (const key of Object.keys(sent())) {
      expect(ALLOWED, `${key} is being sent and is not on the allowlist`).toContain(key);
    }
  });

  it('never puts the session token in the body — it goes in the header the API already uses', () => {
    localStorage.setItem('session_ABC123', SESSION_TOKEN);
    reportClientError('Event has ended', 'upload', 'ABC123');
    expect(headers()['X-Session-Token']).toBe(SESSION_TOKEN);
    // A bearer credential must not come to rest in a diagnostic log a human reads. The server
    // exchanges the header for a participant id and stores that.
    expect(posted()[1].body).not.toContain(SESSION_TOKEN);
  });

  it('sends the path and nothing after it', () => {
    // A custom join link carries its code in the path; an organizer link carries a credential in
    // the fragment. The server strips these again, which is the second lock on the same door.
    history.replaceState({}, '', '/join/ABC123?invite=a-secret#org=another');
    reportClientError('Load failed', 'upload');
    expect(sent().url).toBe('/join/ABC123');
    expect(JSON.stringify(sent())).not.toContain('a-secret');
  });

  it('identifies the guest by their event session, with no call site passing anything extra', () => {
    // The identity is taken from where the app already keeps it. Six upload failures from one
    // event used to be indistinguishable from one phone retrying six times.
    localStorage.setItem('session_ABC123', SESSION_TOKEN);
    reportClientError('Event has ended', 'upload', 'ABC123');
    expect(headers()['X-Session-Token']).toBe(SESSION_TOKEN);
  });
});

describe('the stack — the field whose absence made a report unactionable', () => {
  it('prefers the thrown error’s own frames', () => {
    const boom = new Error('TypeError-ish');
    reportClientError('camera: TypeError Type error', 'camera', undefined, { error: boom });
    expect(sent().stack).toBe(boom.stack?.trim().slice(0, 4000));
  });

  it('takes a stack off anything that carries one, not just a real Error', () => {
    // A DOMException, a cross-realm error from a worker or an iframe, and most library errors all
    // carry `.stack` and fail an `instanceof Error` against this realm.
    reportClientError('camera: NotAllowedError', 'camera', undefined,
      { error: { stack: 'at getUserMedia\nat openCamera' } });
    expect(sent().stack).toContain('at getUserMedia');
  });

  it('falls back to where the report was made, and says so', () => {
    // Production holds a row reading `camera: TypeError Type error` with nothing behind it. Most
    // call sites here format a caught error into a string and drop the object, so the frames that
    // reported it are the difference between an unactionable row and a one-line fix — as long as
    // nobody mistakes them for the error's own.
    reportClientError('camera: TypeError Type error', 'camera');
    expect(String(sent().stack)).toContain('no error object was passed to reportClientError');
  });

  it('does not leave a bare "Error" heading above that note', () => {
    // V8 prefixes `new Error().stack` with a header line and JavaScriptCore does not; left in, it
    // reads as a second, real error sitting above our explanation.
    reportClientError('x', 'camera');
    expect(String(sent().stack).split('\n')[0]).not.toMatch(/^\s*Error\b/);
  });
});

describe('the device', () => {
  it('reports which build the tab is running', () => {
    // From the build, never a constant edited by hand — that is the kind that stops being true on
    // the deploy nobody remembers. The server stamps its own deployed version separately, and a
    // disagreement between the two is a guest on a bundle we had already replaced.
    reportClientError('x');
    expect(typeof sent().build).toBe('string');
    expect(String(sent().build).length).toBeGreaterThan(0);
  });

  it('says browser or standalone, and a viewport', () => {
    reportClientError('x');
    expect(['browser', 'standalone']).toContain(sent().displayMode);
    expect(String(sent().viewport)).toMatch(/^\d+x\d+$/);
  });

  it('carries the outcome the call site gives it, and stays silent when it gets none', () => {
    // NULL means "nobody said", never "no harm done": an upload that recovered on retry and one
    // that lost the photo are the same row without this.
    reportClientError('x', 'upload', undefined, { outcome: 'lost' });
    expect(sent().outcome).toBe('lost');
    fetchMock.mockClear();
    reportClientError('x', 'upload');
    expect(sent()).not.toHaveProperty('outcome');
  });

  it('omits the connection rather than guessing when the browser has no such API', () => {
    // Safari has none. Absent must read as "we could not tell", which is why it is left out of
    // the body entirely instead of being sent as 'unknown'.
    reportClientError('x');
    expect('connection' in navigator || !('connection' in sent())).toBe(true);
  });
});
