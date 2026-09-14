// Wall-clock times, snapped to the tick the product actually runs on.
//
// Everything timed in snapdini happens on a 15-minute beat (REVEAL_TICK_MS, shared/reveal.ts): the
// sweep that opens a gallery and the sweep that sends an email both wake on it, so a moment between
// ticks is one we cannot honour.
//
// `<input type="time" step="900">` says so but does not enforce it. `step` is a VALIDATION rule —
// an off-grid value still lands in the field, it merely fails checkValidity() — and it has no say
// over the picker a browser chooses to draw, so Chrome's list and Android's dial offer five-minute
// options regardless. A host picked 9:05, saw 9:05, and got something else with nothing saying so.
//
// So the input stays native (it is the right control, and on a phone it is the one people know) and
// the value is snapped after the fact, out loud.
import { REVEAL_TICK_MS } from '../../../shared/reveal';

export const TICK_MIN = REVEAL_TICK_MS / 60_000;

/** "HH:MM" → minutes since midnight, or null if it is not a time. */
export function parseHhmm(v: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((v ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

const hhmm = (mins: number) =>
  `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;

/**
 * The nearest quarter hour at or AFTER the given time.
 *
 * The mirror of snapDown, and it exists because the two ends of the product want opposite answers.
 * A REVEAL that lands early is the one mistake with no undo — the photos are out — which is why the
 * server already ceilings reveal instants onto the tick (ceilToRevealTick, shared/reveal.ts). A
 * field that snapped a typed 7:07 reveal DOWN to 7:00 would quietly undo that and show everybody
 * the album seven minutes before the host meant to. The same goes for a scheduled guest send, which
 * must never beat the gallery it links to.
 *
 * 23:50 has nowhere to go but midnight, so it stays put rather than wrapping into the previous day.
 */
export function snapUp(v: string | null | undefined): string {
  const mins = parseHhmm(v);
  if (mins === null) return v ?? '';
  const up = Math.ceil(mins / TICK_MIN) * TICK_MIN;
  return up > 23 * 60 + 45 ? hhmm(Math.floor(mins / TICK_MIN) * TICK_MIN) : hhmm(up);
}

/**
 * The nearest quarter hour at or BEFORE the given time.
 *
 * Down, not to-nearest, and the difference matters at both ends of the product. A start time that
 * rounds down opens the doors a few minutes early, which costs nothing — a guest who scans then is
 * simply in. Rounding 9:50 UP to 10:00 would lock out somebody standing at the door at 9:55.
 *
 * Empty stays empty: a blank time means "the host only picked a day", which the server reads as
 * midnight. Snapping a blank to 00:00 here would turn an absence into a decision.
 */
export function snapDown(v: string | null | undefined): string {
  const mins = parseHhmm(v);
  if (mins === null) return v ?? '';
  return hhmm(Math.floor(mins / TICK_MIN) * TICK_MIN);
}

/** Did snapping actually move it? Used to decide whether the host is owed an explanation. */
export const isOnGrid = (v: string | null | undefined): boolean => {
  const mins = parseHhmm(v);
  return mins === null ? true : mins % TICK_MIN === 0;
};
