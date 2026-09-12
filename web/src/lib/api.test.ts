// These messages are shown to GUESTS, in a toast, at a party. Someone who had just taken a photo
// saw "Request failed (502)" and had no way to know whether their photo was lost. A status code is
// for us; it belongs on the error object, not on the screen.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { api, ApiError } from './api';

const respond = (status: number, body: unknown, ok = status >= 200 && status < 300) => {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok, status,
    json: async () => { if (body === undefined) throw new Error('not json'); return body; },
  })));
};

afterEach(() => vi.unstubAllGlobals());

/** The rejection, typed — `.catch(e => e)` alone gives `unknown` and every assertion then fails to
 *  compile rather than to run. */
const failure = async (path = '/x'): Promise<ApiError> =>
  (await api(path).catch((e: unknown) => e)) as ApiError;

describe('what a failed request tells the person using it', () => {
  it('never puts a bare status code on the screen', async () => {
    for (const status of [400, 401, 404, 413, 429, 500, 502, 503, 504]) {
      respond(status, undefined);   // a proxy's HTML page — no JSON to read
      const err = await failure();
      expect(err).toBeInstanceOf(ApiError);
      expect(err.message).not.toMatch(/\d{3}/);
      expect(err.message.length).toBeGreaterThan(10);
    }
  });

  it('says a 502 is temporary, because the guest did nothing and can do nothing', async () => {
    respond(502, undefined);
    const err = await failure();
    expect(err.message).toMatch(/busy|try again shortly/i);
  });

  it('keeps the status on the error for the console and client_errors', async () => {
    respond(503, undefined);
    const err = await failure();
    expect(err.status).toBe(503);
  });

  it('prefers the server’s own words when it sent any', async () => {
    // Our API writes these for people already — replacing them would be a downgrade.
    respond(400, { error: 'That email doesn’t look right' });
    const err = await failure();
    expect(err.message).toBe('That email doesn’t look right');
    expect(err.status).toBe(400);
  });

  it('turns a dropped connection into something readable', async () => {
    // Browsers disagree here: "Failed to fetch", "Load failed", "NetworkError when attempting…".
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = await failure();
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/connection/i);
    expect(err.message).not.toMatch(/fetch/i);
  });

  it('returns the body untouched when the request worked', async () => {
    respond(200, { hello: 'there' });
    await expect(api('/x')).resolves.toEqual({ hello: 'there' });
  });

  it('treats a 200 with an unreadable body as empty rather than throwing', async () => {
    respond(200, undefined);
    await expect(api('/x')).resolves.toEqual({});
  });
});
