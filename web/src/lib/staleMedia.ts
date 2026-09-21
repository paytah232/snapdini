// A tile pointing at a file that is no longer there.
//
// Rotating a photo or a clip does not rewrite it. It CANNOT: /uploads is served
// `immutable, max-age=31536000`, so the pixels behind a name are promised never to change and
// every cache between us and the guest is entitled to hold them for a year. The only honest way to
// change what a photo looks like is to change its name — write the turned file under a fresh uuid,
// commit, and unlink the old one.
//
// Which leaves every client that already has the old name holding a 404.
//
// The grid is the sharp case. A gallery that has revealed deliberately does not poll (see
// shouldPollGallery — a shared gallery is not a live feed), so there is no refresh coming: tiles
// that have already painted keep their decoded bitmaps and look fine, and every tile that has NOT
// yet been scrolled into view fetches a name that is gone. The guest sees a grid that breaks as
// they scroll, and the old fallback made it worse by falling back from the missing thumbnail to
// the full-resolution original — the same rotated-away stem, the same 404.
//
// Polling is the wrong instrument for this. The event is rare, unpredictable and caused by someone
// else entirely, so a timer either runs constantly for nothing or is not running at the moment it
// matters. The tile already knows: `on:error` fires the instant the fetch fails. So the grid heals
// itself on the evidence rather than on a schedule — one refetch, cache skipped, new names, done.
//
// The policy lives here rather than in the page because it is the awkward kind: a debounce, a cap
// and a quiet period, each guarding against a different way of turning a broken image into an
// infinite request loop. That wants tests with an injectable clock, which a component is not.

type Listener = (url: string) => void;

const listeners = new Set<Listener>();

/** Called from an `on:error` handler. A no-op when nothing is listening, which is most pages. */
export function reportStaleMedia(url: string): void {
	for (const l of [...listeners]) {
		try { l(url); } catch { /* one bad listener must not stop the others healing */ }
	}
}

/** Subscribe. Returns the unsubscribe, for onDestroy. */
export function onStaleMedia(l: Listener): () => void {
	listeners.add(l);
	return () => { listeners.delete(l); };
}

/** One refetch per burst. A screenful of tiles scrolled into view together all fail together, and
 *  they must produce ONE request between them, not thirty. */
export const STALE_DEBOUNCE_MS = 400;

/** How long after a heal before another may be triggered.
 *
 *  Covers the lag between the refetch landing and the browser actually re-requesting the new URLs:
 *  during it, tiles that were already mid-fetch against the old names keep failing, and without
 *  this each of those late errors would start another burst. */
export const STALE_QUIET_MS = 6_000;

/** How many times a page may heal itself before it stops trying.
 *
 *  The cap is the whole safety argument. "The name changed" is recoverable and a refetch fixes it.
 *  "The file is gone" — purged, or a derivative that ffmpeg never managed to write — looks exactly
 *  the same from here, and is not recoverable at all: the refetch returns the very same name, the
 *  tile fails again, and without a cap that is a request loop running for the life of the tab, on
 *  the highest-fan-out surface in the product, triggered by nothing the guest did.
 *
 *  Three is enough for any real sequence of renames (a host working through a roll rotating several
 *  shots) and short enough that the unrecoverable case costs three requests and then stops. */
export const STALE_MAX_HEALS = 3;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface StaleHeal {
	/** A tile failed. Safe to call from every broken tile on the page. */
	report(): void;
	stop(): void;
	readonly heals: number;
	readonly spent: boolean;
}

export interface StaleHealOptions {
	/** Refetch the listing with the shared cache skipped. Must not throw — but is guarded. */
	refetch: () => Promise<void>;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => TimerHandle;
	clearTimer?: (h: TimerHandle) => void;
	debounceMs?: number;
	quietMs?: number;
	maxHeals?: number;
}

export function createStaleHeal(opts: StaleHealOptions): StaleHeal {
	const now = opts.now ?? (() => Date.now());
	const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h));
	const debounceMs = opts.debounceMs ?? STALE_DEBOUNCE_MS;
	const quietMs = opts.quietMs ?? STALE_QUIET_MS;
	const maxHeals = opts.maxHeals ?? STALE_MAX_HEALS;

	let handle: TimerHandle | undefined;
	let heals = 0;
	let lastHealAt = -Infinity;
	let stopped = false;
	let inFlight = false;

	async function fire() {
		handle = undefined;
		if (stopped || inFlight) return;
		// Re-checked HERE as well as at report() time: a report can arrive during the debounce
		// window and the quiet period can expire inside it, so the decision has to be made against
		// the clock as it is when the request would actually go out.
		if (heals >= maxHeals || now() - lastHealAt < quietMs) return;
		inFlight = true;
		heals += 1;
		try { await opts.refetch(); } catch { /* a failed heal is not worth a second failure */ }
		// Stamped AFTER the refetch, not before. The quiet period exists to cover the stragglers
		// that keep failing while the new names are on their way — so it has to be measured from
		// the moment they arrive. Started at the request instead, a five-second refetch spent five
		// of its six seconds before anything had changed, and left one second of actual cover.
		lastHealAt = now();
		inFlight = false;
	}

	return {
		report() {
			if (stopped || inFlight) return;
			if (heals >= maxHeals) return;
			if (now() - lastHealAt < quietMs) return;
			if (handle !== undefined) return;   // a burst is already being collected
			handle = setTimer(fire, debounceMs);
		},
		stop() {
			stopped = true;
			if (handle !== undefined) { clearTimer(handle); handle = undefined; }
		},
		get heals() { return heals; },
		get spent() { return heals >= maxHeals; },
	};
}
