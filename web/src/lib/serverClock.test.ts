import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLOCK_DEADBAND_MS, clockSynced, noteServerDate, resetServerClock, serverNow, serverOffsetMs } from './serverClock';
import API from './api?raw';
import CAMERA from './components/Camera.svelte?raw';

/* Reading the server's clock off a header we were already being sent.
 *
 * Every deadline here is the server's — `expiresAt` is an absolute epoch — and every reading was
 * the device's. That was survivable while the answer only drew a countdown. It stopped being
 * survivable when the camera began closing its own shutter on it: a fast phone locks its guest out
 * early, a slow one lets them shoot past the end and then hands the server a capture timestamp its
 * own clock invented. */
const at = (ms: number) => new Date(ms).toUTCString();

beforeEach(() => resetServerClock());
afterEach(() => { vi.useRealTimers(); resetServerClock(); });

describe('estimating the offset', () => {
	it('is the device clock until something has been measured', () => {
		vi.useFakeTimers().setSystemTime(1_000_000);
		expect(clockSynced()).toBe(false);
		expect(serverOffsetMs()).toBe(0);
		expect(serverNow()).toBe(1_000_000);
	});

	it('places the stamp in the middle of the round trip', () => {
		vi.useFakeTimers().setSystemTime(0);
		// Device says 1000 when the reply lands; the server said 61000 and the trip took 200ms, so
		// the server's clock at that instant was about 61100 — a minute ahead.
		noteServerDate(at(61_000), 800, 1_000);
		vi.setSystemTime(1_000);
		expect(serverOffsetMs()).toBe(60_100);
		expect(serverNow()).toBe(61_100);
	});

	it('leaves a phone that is near enough alone', () => {
		// Below the dead band the measurement is worth less than the clock it would be correcting:
		// a second of header resolution plus half a round trip is the noise floor.
		vi.useFakeTimers().setSystemTime(0);
		noteServerDate(at(1_900), 0, 1_000);
		expect(Math.abs(CLOCK_DEADBAND_MS)).toBeGreaterThan(0);
		expect(serverOffsetMs(), 'inside the dead band, trust the device').toBe(0);
		vi.setSystemTime(5_000);
		expect(serverNow()).toBe(5_000);
	});

	it('keeps the FASTEST sample, not the newest', () => {
		// A short round trip is a narrow window for the stamp to hide in, so it pins the offset
		// better. A phone at a party produces 40ms replies and 3s replies in the same minute, and
		// letting the latest win would let the worst measurement overwrite the best.
		vi.useFakeTimers().setSystemTime(0);
		noteServerDate(at(60_000), 0, 100);        // rtt 100ms
		const sharp = serverOffsetMs();
		noteServerDate(at(120_000), 1_000, 5_000); // rtt 4s, and a wildly different answer
		expect(serverOffsetMs(), 'the slow sample must not win').toBe(sharp);
	});

	it('ignores a round trip too long to mean anything', () => {
		vi.useFakeTimers().setSystemTime(0);
		noteServerDate(at(999_000), 0, 60_000);
		expect(clockSynced(), 'a minute of uncertainty measures nothing').toBe(false);
	});

	it('shrugs off a header that is missing or nonsense', () => {
		vi.useFakeTimers().setSystemTime(0);
		noteServerDate(null, 0, 50);
		noteServerDate(undefined, 0, 50);
		noteServerDate('not a date at all', 0, 50);
		expect(clockSynced()).toBe(false);
		expect(serverNow()).toBe(0);
	});
});

describe('a reply out of the browser cache must not become the clock', () => {
	// THE FAILURE THIS WHOLE MODULE EXISTS TO PREVENT, arriving through the module itself.
	//
	// Gallery replies are `public, max-age=30`, so an ordinary load can be served from the
	// browser's own disk cache: a `Date` header up to thirty seconds old, delivered in a few
	// milliseconds. The fastest-sample rule then rates that the most trustworthy reading it has
	// ever seen, adopts an offset tens of seconds wrong, and — because nothing can beat a cache
	// hit on round trip — refuses every genuine network sample for the whole staleness window.
	// The device whose clock was fine ends up deliberately pushed half a minute out.
	//
	// Both guards against it were unpinned until now. An audit deleted each in turn and all
	// fourteen tests in this file still passed, because none of them ever called noteServerDate
	// with an Age header or with a round trip under the floor — the two inputs the guards are
	// entirely about. A source-string check on api.ts proved the argument was being PASSED, and
	// nothing proved it was being USED.

	it('adds Age back on, so a cached reply reads as the time it was generated', () => {
		vi.useFakeTimers().setSystemTime(0);
		// A proxy hit: generated 30s ago, cached since, and honest about it. Server time at the
		// moment it landed is 30_000 + 30_000 = 60_000, so a device reading 1_000 is 59s behind
		// — NOT 29s ahead, which is what believing the bare Date would conclude.
		noteServerDate(at(30_000), 990, 1_000, '30');
		vi.setSystemTime(1_000);
		expect(serverOffsetMs()).toBe(59_005);
	});

	it('ignores a reply that came back faster than a network can answer', () => {
		vi.useFakeTimers().setSystemTime(0);
		// A browser serving its own disk cache sends no Age at all — that header is added by
		// shared caches, not private ones — so Age cannot save us here and the round trip is the
		// only tell. 1ms did not cross a network.
		noteServerDate(at(-28_000), 0, 1);
		expect(clockSynced(), 'a 1ms reply is a cache hit, not a measurement').toBe(false);
		expect(serverNow()).toBe(0);
	});

	it('and having refused it, still accepts the real reply that follows', () => {
		// The guards must not be so keen that a genuine sample is lost behind a cached one. This
		// is the sequence a real session produces: reload serves from cache, then something
		// actually goes to the origin.
		vi.useFakeTimers().setSystemTime(0);
		noteServerDate(at(-28_000), 0, 1);          // cache hit, refused
		noteServerDate(at(60_000), 0, 100);         // real round trip
		expect(clockSynced()).toBe(true);
		expect(serverOffsetMs()).toBe(59_950);
	});
});

describe('where it is read from and used', () => {
	it('is sampled once, in the shared wrapper, from the headers', () => {
		// The only place both instants exist. Taken before the body is read on purpose: a
		// thousand-photo gallery body can take far longer to arrive than its headers did, and
		// folding that into the round trip makes every large response look like a broken clock.
		expect(API).toContain('const sentAt = Date.now();');
		// Optional-chained: fetch is replaceable, and a stand-in Response with a status and a json()
		// but no `headers` turned every call in that file into a TypeError. A clock sample is the
		// least important thing the wrapper does and must never take the response down with it.
		// `Age` as well as `Date`. A reply from the browser's own cache carries the Date it was first
		// generated with and lands in about a millisecond — which the fastest-sample rule rated the
		// best reading it had ever seen, adopting an offset tens of seconds wrong and refusing every
		// real sample for five minutes. Age is what turns that back into an honest reading.
		expect(API).toContain("noteServerDate(res.headers?.get?.('date') ?? null, sentAt, Date.now(), res.headers?.get?.('age') ?? null);");
		const sample = API.indexOf('noteServerDate(');
		const body = API.indexOf('await res.json()');
		expect(sample, 'sampled before the body is read').toBeLessThan(body);
	});

	it('is what the camera counts down and closes on', () => {
		expect(CAMERA).toContain("import { serverNow } from '$lib/serverClock';");
		expect(CAMERA).toMatch(/const left = \(ev\?\.expiresAt \?\? 0\) - serverNow\(\);/);
		expect(CAMERA).toMatch(/if \(left <= COUNTDOWN_MS \+ 1000\) nowMs = serverNow\(\);/);
		// And nothing in the end watch may go back to the device clock behind its back.
		const watch = CAMERA.slice(CAMERA.indexOf('function startEndWatch()'));
		expect(watch.slice(0, watch.indexOf('function stopEndWatch'))).not.toContain('Date.now()');
	});
});

describe('when a capture began', () => {
	it('a clip is stamped at record START, not at enqueue', () => {
		// Enqueue happens once the recorder has flushed, which for a long clip is minutes after the
		// press. Stamped there, a 90s clip begun one second before the end claimed to have been
		// captured 89 seconds AFTER it — accepted only because the server's clock-skew pad happened
		// to be bigger than the clip. That is a coincidence, not a rule, and it fails outright for
		// a clip longer than the pad.
		expect(CAMERA).toContain('recStartedAt = serverNow();');
		const start = CAMERA.indexOf('recStartedAt = serverNow();');
		const turn = CAMERA.indexOf('recTurn = -glyphRotation();');
		expect(Math.abs(start - turn), 'stamped with recTurn, at the same instant').toBeLessThan(120);
		expect(CAMERA).toMatch(/capturedAt: recStartedAt \|\| serverNow\(\)/);
	});

	it('is read once and written to both records', () => {
		// The queue row and the IndexedDB row are two records of ONE instant. They used to call
		// Date.now() each, a few statements apart, so anything that made them disagree made a
		// reload silently change when a photo was taken.
		expect(CAMERA).toContain('const capturedAt = extra?.capturedAt ?? serverNow();');
		const enqueue = CAMERA.slice(CAMERA.indexOf('const capturedAt = extra?.capturedAt'));
		const body = enqueue.slice(0, enqueue.indexOf('if (saveToDevice)'));
		expect(body).not.toContain('capturedAt: Date.now()');
		expect(body).toContain('...extra, capturedAt }];');
	});

	it('tells the server how long the camera actually ran', () => {
		// The other half of a start-stamp. The server cannot tell a start stamp from an older
		// client's stop stamp — there is no version marker on the wire — so it honours both by
		// allowing the stamp to sit anywhere within the clip's length of the true start. With no
		// duration sent, that window falls back to the longest clip it will keep: ten minutes.
		// Sending the real figure closes it to this clip's own length.
		//
		// It was already on the queue item and simply never left the phone, which is the kind of
		// gap that survives precisely because nothing is visibly broken by it.
		expect(CAMERA).toContain("form.append('durationSecs', String(item.durationSecs))");
		expect(CAMERA).toContain('durationSecs: item.durationSecs }),');
	});

	it('cannot be passed a key the queue item does not have', () => {
		// The typed `extra` is what caught an earlier version of this bug class, where a key was
		// spread in under a name the uploader never read and the value silently went nowhere.
		expect(CAMERA).toMatch(/extra\?: \{[^}]*capturedAt\?: number[^}]*\}/);
	});
});

describe('a sample does not stay authoritative for ever', () => {
	it('lets a worse round trip win once the good one has gone stale', () => {
		// The fastest-sample rule has an obvious failure mode on its own: the first quick reply of
		// a session wins permanently, INCLUDING across the phone being asleep in a pocket for an
		// hour — which is exactly when an OS is most likely to have quietly stepped the clock
		// underneath us. The staleness window is what stops a good measurement of a clock that no
		// longer exists outranking a mediocre measurement of the one that does.
		//
		// Previously unpinned: setting the staleness check to a constant `false` left every test
		// in this file passing.
		vi.useFakeTimers().setSystemTime(0);
		noteServerDate(at(60_000), 0, 100);            // rtt 100ms — very good
		// serverMs + rtt/2 - receivedAt = 60000 + 50 - 100
		expect(serverOffsetMs()).toBe(59_950);

		// Six minutes later, and only a sluggish reply available. Inside the window it would be
		// refused for being slower; past it, it is the only thing describing the clock we have now.
		vi.setSystemTime(360_000);
		noteServerDate(at(360_000 + 120_000), 360_000, 362_000);   // rtt 2s
		// 480000 + 1000 - 362000
		expect(serverOffsetMs(), 'the stale fast sample must not outrank a current one').toBe(119_000);
	});

	it('still prefers the faster of two samples inside the window', () => {
		// The other half, or the first test above would pass with the freshness rule replaced by
		// "always take the newest", which would throw away every good measurement.
		vi.useFakeTimers().setSystemTime(0);
		noteServerDate(at(60_000), 0, 100);
		const sharp = serverOffsetMs();
		vi.setSystemTime(30_000);
		noteServerDate(at(999_000), 30_000, 33_000);
		expect(serverOffsetMs()).toBe(sharp);
	});
});
