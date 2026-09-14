// Which way up the PHONE is, as distinct from which way up the PAGE is.
//
// Those are usually the same thing and occasionally not, and the gap between them is this module's
// whole reason to exist. Turn a phone with rotation unlocked and the page turns with it: the layout
// goes landscape, and everything on screen is already the right way up. Turn a phone with rotation
// LOCKED and the page does not move at all — the layout stays portrait while the person holding it
// is now looking at it sideways. Nothing in CSS can see that second case. `matchMedia('(orientation:
// landscape)')` reports the viewport, which has not changed, so as far as the page is concerned
// nothing happened.
//
// DeviceOrientationEvent can see it, because it reports the hardware rather than the layout. This
// is what native camera apps use: they pin their own layout to portrait and counter-rotate the
// glyphs, so the controls never move but always read upright. That is the effect `tilt` is for.
//
// It is also the answer to "was this shot taken sideways?", which the captured pixels cannot tell
// you: with rotation locked the sensor and the viewfinder agree with each other and both disagree
// with the person, so a landscape scene arrives in a portrait-shaped file and looks, to every later
// reader of that file, exactly like a portrait photo.
//
// WHERE IT WORKS: Android (Chrome, Brave, Samsung, Firefox) fires these events freely. iOS gates
// them behind DeviceOrientationEvent.requestPermission(), which must be called from inside a user
// gesture — so it is asked for on the Join tap, alongside the camera, where one short run of
// prompts is what a guest expects anyway. Asking later, out of the blue, is what would be
// intrusive. Declined or unavailable, this reports 0 forever and every caller falls back to
// layout-only behaviour, which is what the app did before this existed.

export type Quarter = 0 | 90 | -90 | 180;

// HOW THE ANGLE IS MEASURED, and why not the obvious way.
//
// The obvious way is to read `gamma`, the event's left-to-right tilt, and call it sideways past
// some number. That is what this did first, with a threshold of 50, and it turned the UI at about
// 25° of real tilt — the constant and the behaviour disagreed by a factor of two.
//
// The reason is that alpha/beta/gamma are Euler angles, and Euler angles have a singularity. This
// convention's is at beta = 90°, which is to say: a phone held UPRIGHT, which is exactly how a
// phone is held to take a photo. Right at that point gamma is degenerate — a few degrees of real
// movement swings it wildly — so any threshold on gamma means something different depending on how
// the phone happens to be pitched, and near-vertical it means almost nothing.
//
// So convert to the gravity vector first and measure the angle in the plane of the SCREEN. That
// quantity is what "which way up is the phone" actually means, and it is well-behaved everywhere
// except flat on a table, where it is undefined for the good reason that a flat phone has no up.
//
//   g = (-cos β · sin γ,  -sin β,  -cos β · cos γ)     (unit gravity, device axes: x right, y up)
//   θ = atan2(-gx, -gy)                                 (0 = upright, POSITIVE = clockwise)
//
// Sanity checks, all three of which hold: upright is g=(0,-1,0) → θ=0. Right edge down (turned
// clockwise) is g=(-1,0,0) → θ=+90. Left edge down is g=(+1,0,0) → θ=-90.
//
// Note this also corrects a sign error in the first version, which had gamma>0 meaning "turned
// clockwise". It is the other way round: right-edge-down is gamma = -90.

/** Past this many degrees the phone is genuinely being held sideways. Now that the measurement is
 *  real degrees rather than a degenerate Euler reading, 50 means 50 — a large, deliberate turn that
 *  lining up a crooked shot does not reach. */
const ENTER = 50;
/** Comes back upright well inside that. The gap is the hysteresis: with one threshold, a hand
 *  resting near it flickers the entire UI back and forth. */
const LEAVE = 32;
/** And it must HOLD. Putting a phone down, or swinging it up to shoot, sweeps through 50° on the
 *  way to somewhere else; a UI that spins during the sweep is noise. A third of a second is not
 *  noticeable when you meant it, and filters out everything you did not. */
const DWELL_MS = 350;
/** Below this much gravity in the plane of the screen, the phone is flat and the angle is noise. */
const FLAT = 0.35;

let everFired = false;
/** The settled answer — what callers see. Only moves after a reading has held past DWELL_MS. */
let settled: Quarter = 0;
/** What the readings currently say, which may not have held long enough to count yet. */
let candidate: Quarter = 0;
let candidateSince = 0;

const DEG = 180 / Math.PI;

/** Rotation of the phone within the plane of its own screen: 0 upright, positive clockwise.
 *  NaN when the phone is flat enough that the question has no answer. */
function screenAngle(beta: number, gamma: number): number {
  const b = beta / DEG, g = gamma / DEG;
  const gx = -Math.cos(b) * Math.sin(g);
  const gy = -Math.sin(b);
  if (Math.hypot(gx, gy) < FLAT) return NaN;
  return Math.atan2(-gx, -gy) * DEG;
}

/** Which quarter an angle implies, given where we already are. The asymmetry IS the hysteresis: a
 *  high bar to start turning, a low one to stay turned. */
function quarterFor(theta: number, current: Quarter): Quarter {
  if (Number.isNaN(theta)) return current;   // flat: hold whatever we had, do not guess
  if (current === 0) {
    if (theta > ENTER) return 90;
    if (theta < -ENTER) return -90;
    return 0;
  }
  return Math.abs(theta) < LEAVE ? 0 : current;
}

function onOrient(e: DeviceOrientationEvent) {
  if (e.gamma === null || e.gamma === undefined || e.beta === null || e.beta === undefined) return;
  everFired = true;
  const want = quarterFor(screenAngle(e.beta, e.gamma), settled);
  const now = Date.now();
  if (want !== candidate) { candidate = want; candidateSince = now; return; }
  if (want !== settled && now - candidateSince >= DWELL_MS) settled = want;
}

type GatedDOE = { requestPermission?: () => Promise<'granted' | 'denied' | 'default'> };

/** Ask for permission where it is gated. MUST be called synchronously inside a user gesture — iOS
 *  rejects it otherwise, and does so in a way indistinguishable from the guest saying no.
 *
 *  Returns whether events may now arrive. Android has no prompt, so it answers true without showing
 *  anything. */
export async function requestTiltPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return false;
  const DOE = window.DeviceOrientationEvent as unknown as GatedDOE;
  if (typeof DOE.requestPermission !== 'function') return true;   // ungated — Android and desktop
  try { return (await DOE.requestPermission()) === 'granted'; } catch { return false; }
}

/** Begin watching. Safe to call repeatedly; returns a stop function. */
export function watchTilt(onChange?: () => void): () => void {
  if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) return () => {};
  const handler = (e: Event) => {
    const before = deviceQuarter();
    onOrient(e as DeviceOrientationEvent);
    if (onChange && deviceQuarter() !== before) onChange();
  };
  window.addEventListener('deviceorientation', handler);
  return () => window.removeEventListener('deviceorientation', handler);
}

/** True once the hardware has actually told us something. Until then every reading below is a
 *  default, not a measurement, and callers should not act on it. */
export const tiltKnown = (): boolean => everFired;

/** How the phone itself is being held: 0 upright, 90 turned one way, -90 the other.
 *
 *  +90 is turned clockwise (right edge down), -90 counter-clockwise. This is the SETTLED answer,
 *  past the thresholds and the dwell above, not a raw reading. */
export function deviceQuarter(): Quarter {
  return everFired ? settled : 0;
}

/** Has the page already turned to follow the phone? */
function layoutIsLandscape(): boolean {
  try { return window.matchMedia('(orientation: landscape)').matches; } catch { return false; }
}

/** How far to rotate on-screen glyphs so they read upright to the person holding the phone.
 *
 *  Zero whenever the layout has already followed the device — then the page is upright by itself
 *  and rotating anything would tip it back over. Non-zero only in the locked case, which is the one
 *  CSS cannot see. */
export function glyphRotation(): Quarter {
  if (layoutIsLandscape()) return 0;
  const q = deviceQuarter();
  return q === 90 ? -90 : q === -90 ? 90 : 0;
}

/** How the SCENE was framed, for recording against a photo.
 *
 *  'landscape' covers both routes to it — the layout turned, or the phone turned inside a locked
 *  layout — because from the photograph's point of view they are the same event. 'unknown' is a
 *  real and common answer (iOS, or before the first reading) and is stored as such rather than
 *  being quietly rounded down to 'portrait'. */
export function captureOrientation(): 'portrait' | 'landscape' | 'unknown' {
  if (layoutIsLandscape()) return 'landscape';
  if (!everFired) return 'unknown';
  return deviceQuarter() === 0 ? 'portrait' : 'landscape';
}
