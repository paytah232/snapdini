// The photo pool the landing page's "strip" draws from.
//
// It used to be four fixed files (sample/1…4). Every visitor saw the same four wedding shots, which
// made a product that works for birthdays, trips and office parties look like a wedding product.
// The pool is now every real event photo we have, and the page picks four at random per request —
// so two people comparing notes see different events, which is the point being made.
//
// Keys are file stems under static/sample/. Each needs -220 and -330 in BOTH .jpg and .webp; see
// docs/screenshots/README.md for how they are generated.
/* The photos the landing page's strip draws from, grouped BY EVENT.
 *
 *  The grouping is load-bearing, not tidiness. The strip stamps consecutive frame numbers on the
 *  four frames — ▶12 ▶13 ▶14 ▶15 — which says "four frames off one roll". Drawing the four at
 *  random from every photo we have put a wedding, a birthday and a ski slope on the same roll,
 *  which is a thing that cannot happen. So a visit picks one ROLL and shows four frames from it.
 *
 *  Each entry needs -220 and -330 in BOTH .jpg and .webp under static/sample/; see
 *  docs/DEVELOPMENT.md for how they are generated.
 */
export type Roll = { label: string; photos: readonly string[] };

export const SAMPLE_ROLLS: Record<string, Roll> = {
  // The four originals turned out to be the same wedding as the four new ones, so they are ONE roll
  // of eight rather than two rolls that would occasionally show the same couple twice under two
  // different names.
  wedding: {
    label: 'Sarah & Peter',
    photos: ['1', '2', '3', '4', 'wedding-1', 'wedding-2', 'wedding-3', 'wedding-4'],
  },
  birthday: { label: "Megan's birthday", photos: ['birthday-1', 'birthday-2', 'birthday-3', 'birthday-4'] },
  nz:       { label: 'NZ 2026',          photos: ['nz-1', 'nz-2', 'nz-3', 'nz-4'] },
  japan:    { label: 'Japan 2026',       photos: ['japan-1', 'japan-2', 'japan-3', 'japan-4'] },
  camping:  { label: 'Camping trip',     photos: ['camping-1', 'camping-2', 'camping-3', 'camping-4'] },
};

/** The photos shown on a use-case page, so a birthday page shows a birthday.
 *
 *  Built from the rolls above rather than listing filenames again — the four files a set points at
 *  then change in exactly one place when better photos turn up. `travel` is the exception and is
 *  deliberately mixed: three different trips in four frames say "any trip" where four shots of one
 *  holiday would just say "somebody's holiday". It is a page header, not a roll, so the
 *  one-event rule that governs the landing strip does not apply. */
export const SAMPLE_SETS: Record<string, readonly string[]> = {
  birthday: SAMPLE_ROLLS.birthday.photos,
  // The four newest of the eight: the originals are lower-resolution and look it at this size.
  wedding: SAMPLE_ROLLS.wedding.photos.slice(4),
  travel: ['nz-1', 'japan-1', 'camping-2', 'japan-4'],
};

/** One roll, shuffled — four frames from a single event.
 *
 *  Called from a SERVER load, never in the component: picking during render would run once on the
 *  server and again on the client with a different answer, and the hydration mismatch shows up as
 *  the strip visibly swapping images after load.
 */
/** Every roll, shuffled within itself and rotated to start on a random one.
 *
 *  The strip cycles through them, so a visitor sees a wedding, then a trip, then a birthday — the
 *  "any event" claim made by the page rather than asserted in a sentence. The STARTING roll is
 *  random so the first frame a visitor lands on is not always the same wedding.
 */
export function pickDeck(n = 4): { photos: string[]; label: string }[] {
  const keys = Object.keys(SAMPLE_ROLLS);
  const start = Math.floor(Math.random() * keys.length);
  return keys.map((_, i) => pickSamples(n, keys[(start + i) % keys.length]));
}

export function pickSamples(n = 4, key?: string): { photos: string[]; label: string } {
  const rolls = Object.values(SAMPLE_ROLLS);
  const roll = key ? SAMPLE_ROLLS[key] : rolls[Math.floor(Math.random() * rolls.length)];
  const photos = [...roll.photos];
  // Shuffled WITHIN the roll: the same event every time, but not the same four frames in the same
  // order, so a second visit does not look like a cached page.
  for (let i = photos.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [photos[i], photos[j]] = [photos[j], photos[i]];
  }
  return { photos: photos.slice(0, n), label: roll.label };
}

/** Where the strip's frame numbers start.
 *
 *  They are stamped ▶24 ▶25 ▶26 ▶27 on every visit, which is the one detail that gives away that
 *  the strip is a fixed decoration rather than somebody's roll. The numbers stay CONSECUTIVE —
 *  they are four frames off one roll, and a roll does not skip — so only the starting frame moves.
 *  Kept under 36 because that is where a real roll ends. */
export function pickStampStart(): number {
  return 3 + Math.floor(Math.random() * 30);
}
