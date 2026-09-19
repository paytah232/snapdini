// Which rungs of a ladder the wizard shows at once.
//
// Out here rather than inside +page.svelte for the reason upgradePlan.ts gives: a rule that lives
// only in a component is a rule no test can reach, and this one has two edges that are easy to get
// wrong and invisible when they are — a window that runs off the end of the ladder, and a window
// that hides the very option the host has already chosen.

/** Where the visible window should start.
 *
 *  `want` is where the caller is asking to be; `selectedIndex` pulls it back far enough to keep the
 *  chosen rung on screen, and `-1` means "do not pull" — which is the difference between the two
 *  things that move this window, and the whole reason the argument exists:
 *
 *   · OPENING the step, where the window has to be wherever the host's saved answer is, or the
 *     wizard shows them three rungs that do not include the one they picked last time.
 *   · PRESSING go bigger / go smaller, where pulling would make the button inert. With 12 selected
 *     and the window at the bottom, "go bigger" wants rung 1 — and a rule that always keeps the
 *     selection visible drags it straight back to 0, so the control does nothing at all and the
 *     bigger rolls are unreachable until you somehow select one first.
 *
 *  Clamped last either way, so neither input can push the window past an end of the ladder.
 */
export function shotWindowStart(
  ladderLength: number,
  selectedIndex: number,
  want: number,
  size: number,
): number {
  const last = Math.max(0, ladderLength - size);
  let start = want;
  if (selectedIndex >= 0) {
    if (selectedIndex < start) start = selectedIndex;
    else if (selectedIndex >= start + size) start = selectedIndex - size + 1;
  }
  return Math.max(0, Math.min(start, last));
}
