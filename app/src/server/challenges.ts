// Photo missions, server side.
//
// The server holds NO opinion on what a mission says. The wording library lives in the front end
// (web/src/lib/challenges.ts) because a host can write their own, so validating against a list of
// ours would break the exact case we built for. What is enforced here is shape: how many, how long,
// what an id may look like, and that ids are unique — everything needed to store them safely and to
// trust `challenge_id` on a photo later.
//
// Text is stored as the host wrote it rather than resolved from an id at read time, deliberately:
// a printed card in someone's hand cannot be updated, so improving our wording later must never
// silently disagree with the card on the table.
//
// ── Sets ─────────────────────────────────────────────────────────────────────
// An event has one or more SETS of missions. One set is the ordinary case. Several exist so a host
// can hand out different cards — table A gets one list, table B another — which spreads coverage
// across the evening instead of getting forty photos of the same cake. Each set prints separately,
// and a guest is tied to exactly one for the life of their roll.

/** Must match CHALLENGE_MAX_LEN in web/src/lib/challenges.ts — the printed card is the constraint. */
export const CHALLENGE_MAX_LEN = 48;
/** Must match MAX_COUNT in web/src/lib/challenges.ts. Printed lists run 15-25; 20 is the ceiling. */
export const MAX_CHALLENGES = 20;
/** Enough for a card per table at a big event, bounded so the stored blob stays small. */
export const MAX_SETS = 8;
const MAX_LABEL_LEN = 24;
/** Hard ceiling on the stored JSON, same instinct as poster_config's. */
const MAX_BLOB = 16_000;

/** Ours look like `wed-first-dance`; a host's own look like `own-3`. Both are safe in a URL, a
 *  column and a query string. */
const ID_RE = /^[a-z][a-z0-9-]{2,39}$/;
const TYPE_RE = /^[a-z][a-z0-9-]{2,30}$/;
/** A set key ends up in a QR link (`/join/CODE?set=b`), so keep it short and URL-trivial. */
const SET_RE = /^[a-z0-9]{1,8}$/;

export type StoredChallenge = { id: string; text: string };

/**
 * The tick glyph, stored WITH the trick list rather than with the poster.
 *
 * A host may never print anything — a digital-only list is a perfectly good way to run this — so the
 * glyph has to live where the list lives, or the guest's screen and the card would disagree about
 * what a tick looks like. One character, counted by code point because an emoji is two UTF-16 units
 * and .length would reject a perfectly good bottle.
 */
export function parseTick(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  // Must match cleanTick() on the client exactly: variation selectors are stripped before the
  // single-code-point check, so a tick pasted from an emoji picker ("\u2714\uFE0F") is accepted
  // rather than silently dropped on save while the UI still shows it.
  const chars = [...input.trim().replace(/[\uFE0E\uFE0F]/g, '')];
  if (chars.length !== 1) return null;
  const code = chars[0].codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f ? null : chars[0];
}
export type ChallengeSet = { key: string; label: string; items: StoredChallenge[] };

function parseItems(input: unknown): StoredChallenge[] {
  if (!Array.isArray(input)) return [];
  const out: StoredChallenge[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (out.length >= MAX_CHALLENGES) break;
    if (!raw || typeof raw !== 'object') continue;
    const { id, text } = raw as { id?: unknown; text?: unknown };
    if (typeof id !== 'string' || typeof text !== 'string') continue;
    const cleanId = id.trim();
    // Collapse whitespace: a newline pasted into a card line breaks the print layout.
    const cleanText = text.trim().replace(/\s+/g, ' ');
    if (!ID_RE.test(cleanId) || !cleanText || cleanText.length > CHALLENGE_MAX_LEN) continue;
    if (seen.has(cleanId)) continue;   // ids key photo tagging; a duplicate would be ambiguous
    seen.add(cleanId);
    out.push({ id: cleanId, text: cleanText });
  }
  return out;
}

/**
 * Validate and normalise what a host saved.
 *
 * Accepts either a bare array (the ordinary one-set case, which is what most hosts will ever send)
 * or `{ sets: [...] }`. Returns null only when the input is neither — so a caller can tell "no
 * opinion" from "cleared it". Malformed entries are DROPPED rather than failing the whole save:
 * losing one bad row beats refusing a host's entire list over a stray entry.
 */
export function parseChallengeSets(input: unknown): ChallengeSet[] | null {
  let rawSets: unknown[];
  if (Array.isArray(input)) {
    rawSets = [{ key: 'a', label: 'Set A', items: input }];
  } else if (input && typeof input === 'object' && Array.isArray((input as { sets?: unknown }).sets)) {
    rawSets = (input as { sets: unknown[] }).sets;
  } else {
    return null;
  }

  const out: ChallengeSet[] = [];
  const keys = new Set<string>();
  for (const raw of rawSets) {
    if (out.length >= MAX_SETS) break;
    if (!raw || typeof raw !== 'object') continue;
    const { key, label, items } = raw as { key?: unknown; label?: unknown; items?: unknown };
    const parsed = parseItems(items);
    if (!parsed.length) continue;                      // an empty set would print a blank card
    // Fall back to a positional key rather than dropping the set: the host's wording matters, a
    // missing key does not.
    let k = typeof key === 'string' && SET_RE.test(key.trim().toLowerCase()) ? key.trim().toLowerCase() : '';
    if (!k || keys.has(k)) k = String.fromCharCode(97 + out.length);   // a, b, c …
    if (keys.has(k)) continue;
    keys.add(k);
    const l = typeof label === 'string' ? label.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL_LEN) : '';
    out.push({ key: k, label: l || `Set ${k.toUpperCase()}`, items: parsed });
  }
  return out;
}

/** Serialise for the column, or null when there is nothing to store. Refuses anything absurdly
 *  large rather than truncating mid-JSON, which would be unreadable on the way back. */
export function serialiseSets(sets: ChallengeSet[], tick?: string | null): string | null {
  if (!sets.length) return null;
  const json = JSON.stringify(tick ? { sets, tick } : { sets });
  return json.length <= MAX_BLOB ? json : null;
}

export function readSets(stored: string | null | undefined): ChallengeSet[] {
  if (!stored) return [];
  try {
    const v = JSON.parse(stored) as unknown;
    // Tolerate the bare-array shape in case anything was ever written that way.
    return parseChallengeSets(v) ?? [];
  } catch {
    return [];
  }
}

/** The event type a host picked in their theming. Null for "they never said", which is a valid
 *  state meaning the general pack — not an error. */
export function parseEventType(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const t = input.trim().toLowerCase();
  return TYPE_RE.test(t) ? t : null;
}

/** Which set a guest should get.
 *
 *  A printed card can name one (`?set=b`); honoured when it exists. Otherwise round-robin by how
 *  many guests have already joined — not random, because the whole point of multiple sets is even
 *  coverage of the evening, and random assignment clusters.
 */
export function assignSet(sets: ChallengeSet[], requested: unknown, joinedSoFar: number): string | null {
  if (!sets.length) return null;
  if (typeof requested === 'string') {
    const r = requested.trim().toLowerCase();
    if (sets.some((s) => s.key === r)) return r;
  }
  return sets[Math.abs(joinedSoFar) % sets.length].key;
}

export const setByKey = (sets: ChallengeSet[], key: string | null | undefined): ChallengeSet | null =>
  sets.find((s) => s.key === key) ?? sets[0] ?? null;

/** Is this id one of the missions the guest's OWN set offers? Guards `challenge_id` on upload: a
 *  guest must not tag a photo with an arbitrary string, because that string is shown as the photo's
 *  caption in the gallery — and must not tick off a mission from somebody else's card. */
export function isOfferedChallenge(sets: ChallengeSet[], setKey: string | null | undefined, id: unknown): boolean {
  if (typeof id !== 'string') return false;
  const set = setByKey(sets, setKey);
  return !!set && set.items.some((c) => c.id === id.trim());
}

/** The glyph a host chose, or null to let the front end fall back to the event type's default. */
export function readTick(stored: string | null | undefined): string | null {
  if (!stored) return null;
  try { return parseTick((JSON.parse(stored) as { tick?: unknown }).tick); } catch { return null; }
}
