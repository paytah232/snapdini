import { describe, expect, it } from 'vitest';
import CAMERA from './components/Camera.svelte?raw';

/* When the shutter actually closes.
 *
 * Measured on a real device: six captures — three clips and three photos — landed 10 to 25
 * seconds AFTER the event's expiry, and every one of them was accepted and stored.
 *
 * Two gates failed in sequence, and the order matters because only one of them is a bug.
 *
 *   THE CLIENT was the gate, and it was asleep. `eventEnded` was set in exactly one place —
 *   checkStillOpen(), reached on every sixtieth tick of the end watch — so the camera watched its
 *   own countdown pass 00:00 and went on shooting until the next minute-boundary poll.
 *
 *   THE SERVER was the safety net, and it did what a safety net does. lateUploadAllowed() forgives
 *   a capture timestamp up to five minutes past the end, because that pad protects a photo taken
 *   just BEFORE the end by a phone whose clock is out, and nothing in a self-reported timestamp
 *   distinguishes that from a photo genuinely taken after. Tightening it would start throwing away
 *   real photographs to compensate for a client that should not have taken them.
 *
 * So the fix belongs in the client, and these assertions are about the client. */
describe('the camera stops when the countdown does', () => {
	it('closes on the local clock, not on the next server poll', () => {
		// And it marks the close as LOCAL. That flag is what keeps checkStillOpen() running: its
		// early return used to be self-consistent because the only way to be ended was to have been
		// told, and closing on our own clock quietly turned it into the thing that made a wrong
		// close permanent.
		expect(CAMERA).toMatch(
			/\$: if \(!eventEnded && !localCloseOverruled && ev\?\.expiresAt && msLeft <= 0\) \{ eventEnded = true; endedLocally = true; \}/
		);
		expect(CAMERA).toMatch(/let endedLocally = false;/);
	});

	it('still keeps the poll, because a LOCK has no local signal', () => {
		// Expiry is arithmetic this client can do. "The host pressed Lock" is not — it can only be
		// asked for, so the reactive close above must not be read as a replacement for the poll.
		expect(CAMERA).toMatch(/if \(fresh\.isExpired \|\| fresh\.isLocked\) \{/);
		expect(CAMERA).toMatch(/ticks % \(endedLocally \? 5 : 60\) === 0/);
		// A server that says the event is open takes a LOCAL close back — a fast clock or a host
		// extending must not lock a guest out of a running event with no way back.
		expect(CAMERA).toMatch(/\} else if \(endedLocally\) \{/);
		expect(CAMERA).toMatch(/eventEnded = false; endedLocally = false;/);
		// ...but never a confirmed one.
		expect(CAMERA).toMatch(/if \(screen !== 'camera' \|\| \(eventEnded && !endedLocally\)\) return;/);
		// AND THE REOPEN HAS TO STICK, which the first version of it did not.
		//
		// The reactive close reads `eventEnded`, so setting it false re-ran the statement, found
		// msLeft still <= 0 — the device clock has not changed its mind — and latched it back in
		// the same flush. A phone four minutes fast sat in a loop: shut, reopened every five
		// seconds, re-shut immediately, never usable. The mechanism for handing the camera back
		// never once handed it back, and every test still passed.
		expect(CAMERA).toMatch(/\$: localCloseOverruled = overruledFor !== null && ev\?\.expiresAt === overruledFor;/);
		expect(CAMERA).toMatch(/\$: if \(!eventEnded && !localCloseOverruled && ev\?\.expiresAt && msLeft <= 0\)/);
		expect(CAMERA).toMatch(/overruledFor = fresh\.expiresAt \?\? null;/);
		// Keyed to the deadline, not a bare flag, so a host moving the end date lapses it by
		// itself — a new instant has been contradicted by nobody and the clock may act on it.
		const ov = CAMERA.slice(CAMERA.indexOf('let overruledFor'));
		expect(ov.slice(0, 200)).not.toMatch(/overruledFor = (true|false)/);
	});

	it('keeps the clock ticking PAST zero, or the close can never be seen', () => {
		// nowMs is only reassigned inside the countdown window, to avoid re-rendering a live video
		// preview once a second all evening. That window has no lower bound on purpose: bounding it
		// at zero would freeze the clock one tick before the crossing the reactive close is
		// watching for, and the shutter would stay open exactly as it did before.
		expect(CAMERA).toMatch(/if \(left <= COUNTDOWN_MS \+ 1000\) nowMs = serverNow\(\);/);
		expect(CAMERA).not.toMatch(/if \(left > 0 && left <= COUNTDOWN_MS/);
	});

	it('puts the note IN FRONT of the camera, not behind it', () => {
		// It was the only child of .cam left in normal flow, and .cam's other children are all
		// absolutely positioned. Positioned boxes paint above non-positioned ones whatever the
		// document order says, so the note sat UNDER the viewfinder and was visible only where the
		// picture happened not to cover it.
		//
		// That is why it looked intermittent in the two places it was reported: flipping the lens
		// raises .cam-loading (inset: 0, solid black) over it, and switching photo/video moves the
		// letterbox geometry it had been showing through. Nothing hid it — it was never in front.
		const rule = CAMERA.slice(CAMERA.indexOf('.endnote {'));
		const body = rule.slice(0, rule.indexOf('}'));
		expect(body).toMatch(/position:\s*absolute/);
		// The slot this file keeps for exactly this, so two stacked controls cannot disagree about
		// where the mode pill stops.
		expect(body).toMatch(/bottom:\s*var\(--above-modes\)/);
		const z = body.match(/z-index:\s*(\d+)/);
		expect(z, 'it needs a z-index or the overlay wins again').toBeTruthy();
		// Clear of the loading overlay (3), the install strip (7), the bottom bar (8) and the
		// mode pill (10) — every layer that was painting over it.
		expect(Number(z![1])).toBeGreaterThan(10);
	});

	it('does not leave the install strip sharing its line', () => {
		// Both want --above-modes, and they can be up at the same time.
		expect(CAMERA).toMatch(/\.cam\.has-note \.install-offer \{[^}]*bottom:\s*calc\(var\(--above-modes\)/);
		expect(CAMERA).toContain('class:has-note={eventEnded || endingSoon}');
	});

	it('stops asking differently when the camera is simply held by something else', () => {
		// The retry ladder in startCamera() is built out of asking for the same camera in slightly
		// different ways: the same lens without a resolution, then any lens on this side, then the
		// same again without audio. That is the right answer to OverconstrainedError and
		// NotFoundError — "you cannot have THAT". Against a camera another tab is holding, every
		// rung fails identically, and the guest waits out four getUserMedia calls and a 250ms sleep
		// to be told what the first one already knew. That wait was the reported complaint.
		expect(CAMERA).toMatch(/const isBusyError = \(e: unknown\) =>/);
		expect(CAMERA).toMatch(/e\.name === 'NotReadableError' \|\| e\.name === 'AbortError'/);
		// The short-circuit has to come BEFORE the constraint-varying retries, or it saves nothing.
		// Ordered against CODE, not against prose. The first version anchored the ladder on the
		// string 'Give the CHOSEN lens a second chance', which occurs exactly once in
		// Camera.svelte — as a comment. So it ordered the short-circuit against an explanation:
		// move the real ladder above the short-circuit and leave the comment where it is and the
		// test stayed green, while rewording the comment would have reddened a test about code.
		// Fourth instance of this shape found in this codebase; the fix is always the same.
		const fn = CAMERA.slice(CAMERA.indexOf('async function startCamera()'))
			.replace(/\/\*[\s\S]*?\*\//g, ' ')
			.replace(/^[ \t]*\/\/.*$/gm, ' ');
		const busy = fn.indexOf('if (isBusyError(err1))');
		// The first rung of the ladder proper: the retry that gives the CHOSEN device a second go.
		const ladder = fn.indexOf('await attachCamera({ video: { deviceId: { exact: deviceId } }, audio })');
		expect(busy, 'the short-circuit exists').toBeGreaterThan(-1);
		expect(ladder, 'the constraint-varying ladder exists').toBeGreaterThan(-1);
		expect(ladder).toBeGreaterThan(busy);
	});

	it('asks once more before blaming the other tab, because it is usually us', () => {
		// The thing holding the camera is most often our OWN other tab, releasing it at this very
		// moment — switching to this tab is what made that one hidden, and onVisibility stops the
		// camera there. The two are the same gesture, so we arrive a few hundred milliseconds
		// early. A working camera on the second ask beats the truth delivered quickly.
		expect(CAMERA).toMatch(/const BUSY_SETTLE_MS = \d+;/);
		expect(CAMERA).toMatch(/await new Promise\(\(r\) => setTimeout\(r, BUSY_SETTLE_MS\)\);/);
		// Still busy afterwards is a real answer; anything else means the device came free and the
		// ordinary ladder should handle whatever is actually wrong.
		// `&& !audio` is load-bearing. In video mode the request asks for the microphone too, and a
		// busy MIC rejects with the same NotReadableError — short-circuiting there would skip the
		// audio-free rung that leaves the guest recording silent clips, turning a busy microphone
		// into no camera at all. Worse than the slow error this block exists to avoid.
		expect(CAMERA).toMatch(/if \(isBusyError\(busyAgain\) && !audio\) \{ failCamera\(busyAgain\); return; \}/);
	});

	it('a backgrounded tab really does let go of the camera', () => {
		// Worth pinning: the whole argument for the settle-and-retry above rests on this being
		// true. If a hidden tab ever stopped releasing the camera, the retry would become a wasted
		// 600ms in front of an error rather than a rescue.
		const vis = CAMERA.slice(CAMERA.indexOf('function onVisibility()'));
		expect(vis.slice(0, vis.indexOf('\n  }'))).toContain("if (screen === 'camera') stopCamera();");
	});

	it('lets a rolling clip be stopped, and refuses only a NEW one', () => {
		// The one press that must survive the end of the event. A guest holding a recording with no
		// way to end it loses the take, so `recording` is checked and only STARTING is refused —
		// which also closes the window the host found by spamming the button after a clip ended.
		expect(CAMERA).toMatch(
			/if \(eventEnded && !recording\) \{ showToast\(endedNote, true\); return; \}/
		);
		// The still shutter has no such exemption: there is no half-finished photo to rescue.
		expect(CAMERA).toMatch(/if \(eventEnded\) \{ showToast\(endedNote, true\); return; \}/);
	});
});
