/** A heart count, short enough to sit in a row without moving anything.
 *
 *  Counts live beside an icon in a fixed slot, so what matters is that the string stops growing:
 *  "1247" is four characters and climbing, "1.2k" is four and stays four until a million. Below a
 *  thousand the exact number is worth having — the difference between 8 and 9 hearts is a real
 *  difference to the person who got them — so nothing is rounded until it stops being readable.
 *
 *  Truncated, never rounded up: 1999 is "1.9k", not "2k". A count that reads higher than the number
 *  of people who actually pressed it is a small lie, and this one is easy to avoid.
 */
export function compactCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0';
  const v = Math.floor(n);
  if (v < 1000) return String(v);
  if (v < 1_000_000) return trim(v / 1000) + 'k';
  return trim(v / 1_000_000) + 'm';
}

/** One decimal, and only when it says something: 1.2k, but 2k rather than 2.0k. */
function trim(x: number): string {
  const one = Math.floor(x * 10) / 10;
  return Number.isInteger(one) ? String(one) : one.toFixed(1);
}
