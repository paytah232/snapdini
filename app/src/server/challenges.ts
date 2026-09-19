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
    // First unused letter. `97 + out.length` collides whenever the incoming keys are not a
    // contiguous prefix — which happens the moment a host removes a card and adds another — and
    // the collision then fell straight into the `continue` below, DROPPING a card the host had
    // just written while the response still said success. Scan instead of deriving.
    if (!k || keys.has(k)) {
      for (let i = 0; i < 26; i++) {
        const c = String.fromCharCode(97 + i);
        if (!keys.has(c)) { k = c; break; }
      }
    }
    if (keys.has(k)) continue;   // only reachable if all 26 letters are taken
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

/**
 * The kind of event as a SETTING: what the column should hold after a save that may or may not
 * have mentioned it.
 *
 * `undefined` means nothing was said, and must leave the stored value exactly as it is — an older
 * client, or a save that only touched the event name, cannot be allowed to clear a type the host
 * chose on another screen. Anything else is the host speaking, and parseEventType turns it into a
 * stored value or into null, which is how they un-say it after picking one by mistake.
 *
 * Its own function rather than a ternary inside a two-hundred-line handler, because this rule is
 * the whole of the decision and a ternary in there is not something a test can reach. Note what it
 * does NOT do: it never looks at the trick list. Nothing on the server derives one from the other —
 * the mission packs live in the front end because a host can write their own.
 */
export function nextEventType(given: unknown, current: string | null | undefined): string | null {
  return given === undefined ? (current ?? null) : parseEventType(given);
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


// ── Which card is the guest actually holding? ────────────────────────────────
//
// assignSet answers "which card" and cannot answer "how sure are we". That was fine while the only
// two ways to get a card were a QR that named it and the round-robin, because neither needed the
// guest's opinion. Trick cards now print without a QR by default — most sets are deliberately
// minimal and guests join off the main event sign — so the round-robin is quietly handing card A to
// someone sitting in front of card B.
//
// The fix is to ask them, and asking needs two things this file did not have: a record of "we have
// not asked yet", and a rule that the answer is final.

/** How a guest came by their card.
 *
 *  'pending' is the odd one out: it is not a provenance but a question still open. It is the ONLY
 *  state that puts the "which card are you?" prompt in front of a guest, which is what keeps this
 *  out of the way of every event already running — their participants have no source at all, and an
 *  absent source reads as 'auto'. */
export type SetSource = 'qr' | 'self' | 'auto' | 'pending';

/** What the API says out loud: 'pending' is our bookkeeping, not a thing a guest was told. It
 *  reports as what it is — a round-robin assignment — and the still-open half travels separately as
 *  `setPending`, so a client can nudge on one and prompt on the other without decoding a state
 *  machine. */
export type PublicSetSource = 'qr' | 'self' | 'auto';

/** The stored column, read defensively. NULL — every participant who joined before any of this
 *  existed — is 'auto': settled, never asked, never reassigned. */
export function readSetSource(stored: string | null | undefined): SetSource {
  return stored === 'qr' || stored === 'self' || stored === 'pending' ? stored : 'auto';
}

export const publicSetSource = (s: SetSource): PublicSetSource => (s === 'pending' ? 'auto' : s);

/** assignSet, plus how it decided.
 *
 *  Deliberately a wrapper rather than a replacement: assignSet is the rule about even coverage and
 *  it is unchanged, including its refusal to be random. All this adds is whether the answer came
 *  from the card in someone's hand ('qr' — final, those cards are printed), or from the round-robin
 *  — and a round-robin answer is only worth asking about when there is more than one card to
 *  confuse, so a single-card event settles straight to 'auto' and no guest is ever interrupted.
 *
 *  ── 'qr' IS NOT AUTHENTICATED, AND CANNOT BE ────────────────────────────────
 *
 *  A guest who POSTs `{"set":"a"}` at join time is recorded as 'qr' without ever having seen a
 *  printed card. That is not fixable here, and it is worth writing down why rather than leaving
 *  the next reader to rediscover it and "fix" it.
 *
 *  It cannot be distinguished server-side. `?set=` is a QUERY parameter on a page the guest's
 *  browser loads; the join request is a POST to /api/participants, which carries no query string
 *  of its own. The only thing that can move the key from the address bar into the request is the
 *  guest's own JavaScript (Camera.svelte reads window.location.search and passes it to joinEvent),
 *  so by the time it reaches this function a scanned card and a hand-written body are byte-for-byte
 *  the same request. Refusing the body and reading only req.query would break every printed card
 *  in existence, which is the one outcome that is not allowed: those cards cannot be reprinted.
 *
 *  And it buys nothing. 'qr' and 'self' are the same state everywhere it is read — resolveSetChoice
 *  locks on `source !== 'pending'` and nothing else compares the two — so the forged path ends at
 *  exactly the card a guest can reach honestly: join, get asked "which card are you?", and answer.
 *  Both answers are final, both give the guest the set they named. What the forgery changes is the
 *  PROVENANCE LABEL, not the outcome, and the label is only ever read back to the client as
 *  information. There is no fairness advantage to take, so there is nothing here worth trading a
 *  printed card for.
 *
 *  If provenance ever has to be trustworthy — a per-card secret in the QR, checked here — that is a
 *  new column and a new print format, not a tightening of this function, and it can only apply to
 *  cards printed after it ships. */
export function assignSetWithSource(
  sets: ChallengeSet[], requested: unknown, joinedSoFar: number,
): { key: string | null; source: SetSource | null } {
  const key = assignSet(sets, requested, joinedSoFar);
  if (key === null) return { key: null, source: null };
  const asked = typeof requested === 'string' ? requested.trim().toLowerCase() : '';
  if (asked && asked === key) return { key, source: 'qr' };
  return { key, source: sets.length > 1 ? 'pending' : 'auto' };
}

/** Is there a question to put to this guest? */
export const shouldAskWhichSet = (sets: ChallengeSet[], source: SetSource): boolean =>
  sets.length > 1 && source === 'pending';

/** A card as somebody choosing between cards has to see it: the label they can read off the thing
 *  in their hand, and enough of the list to recognise it when two cards are labelled A and B and
 *  nothing else. */
export type SetChoice = { key: string; label: string; preview: string[]; count: number };
export function setChoices(sets: ChallengeSet[], previewCount = 3): SetChoice[] {
  return sets.map((s) => ({
    key: s.key, label: s.label, count: s.items.length,
    preview: s.items.slice(0, Math.max(0, previewCount)).map((i) => i.text),
  }));
}

/** Does this event's saved card design actually PRINT a QR on the cards?
 *
 *  Only so the camera can make a better suggestion than "pick one": a guest who was handed a card
 *  by the round-robin, at an event whose cards each carry their own code, is one scan away from the
 *  right answer, and telling them that beats asking them to guess. Cards default to no QR now, so
 *  this is false for most events and the suggestion simply does not appear.
 *
 *  Strictly `=== true`: the blob is host-authored, may be absent entirely, and "we could not tell"
 *  must read as "do not suggest scanning something that may not be there".
 */
export function cardDesignHasQr(posterConfig: string | null | undefined): boolean {
  if (!posterConfig) return false;
  try { return (JSON.parse(posterConfig) as { cardShowQr?: unknown }).cardShowQr === true; }
  catch { return false; }
}

export type SetChoiceResult =
  | { ok: true; key: string; source: SetSource }
  | { ok: false; reason: 'no-sets' | 'locked' | 'unknown-set' };

/** A guest answering "which card are you?".
 *
 *  Three outcomes, and the third is the one that is easy to leave out:
 *
 *   · a card they named — theirs, and 'self' means nobody may change it again. The warning shown
 *     before the tap says so, and this is where that promise is actually kept: a second attempt is
 *     refused here, not merely hidden in the client.
 *   · nothing, or 'none' — "I don't have a card". The round-robin's answer STANDS, because for
 *     someone who joined off the main sign a guess at a card is worse than even coverage, and if
 *     every such guest tapped the first button the coverage that several cards exist for would be
 *     gone. Settled as 'auto' so they are not asked twice.
 *   · anything else is a client sending a key this event does not have, which must not leave a
 *     guest holding a set that does not exist — missionsFor() would fall back to the first one and
 *     answer wrongly in silence. */
export function resolveSetChoice(
  sets: ChallengeSet[], current: { key: string | null; source: SetSource }, want: unknown,
): SetChoiceResult {
  if (!sets.length) return { ok: false, reason: 'no-sets' };
  if (current.source !== 'pending') return { ok: false, reason: 'locked' };
  const w = typeof want === 'string' ? want.trim().toLowerCase()
          : want === null || want === undefined ? '' : null;
  if (w === null) return { ok: false, reason: 'unknown-set' };
  if (w === '' || w === 'none') return { ok: true, key: current.key ?? sets[0].key, source: 'auto' };
  if (!sets.some((s) => s.key === w)) return { ok: false, reason: 'unknown-set' };
  return { ok: true, key: w, source: 'self' };
}

export const setByKey = (sets: ChallengeSet[], key: string | null | undefined): ChallengeSet | null =>
  sets.find((s) => s.key === key) ?? sets[0] ?? null;

// ── When the host deletes a card somebody is holding ─────────────────────────
//
// setByKey falls back to `sets[0]`, and that fallback is doing something much larger than it looks.
// A host who removes card B mid-event does not remove the guests holding card B: their
// `challenge_set` still says 'b', nothing points at it any more, and every read silently answers
// card A instead. What that guest sees is their list replaced by somebody else's, every tick they
// had reset to zero, and the captions on the photos they already took resolving to nothing —
// `challengeCaptions` only knows ids that still exist. And because their `source` is 'self' or
// 'qr', the "which card are you?" question is settled and they are never asked again. The whole
// thing is silent.
//
// The fallback stays: it is the right answer for a READ, which must return something. What was
// missing is that a SAVE has to put the affected guests back into a state the product can recover
// from — which is the state they were in before anybody asked them: 'pending'.

/** What a participant's card becomes after a challenges save, or null when nothing changes.
 *
 *  Three cases, and the middle one is the only one with a decision in it:
 *
 *   · their card still exists → null. Untouched, whatever else the host changed.
 *   · their card is gone, and there is more than one left → 'pending', on the first remaining card.
 *     Re-asking is better than choosing for them: the guest has a physical card in their hand and
 *     is the only one who knows which. 'pending' is also the ONLY state that puts the question back
 *     on screen, which is the whole reason it exists.
 *   · their card is gone and exactly one is left → 'auto'. There is nothing to ask: one card is not
 *     a choice, and prompting for it would be an interruption with a single button.
 *
 *  A host who deleted the entire list gets `{ key: null, source: null }` — no card, no question,
 *  which is the same state a participant of an event with no trick list is in.
 *
 *  It does NOT reassign anyone whose card survived, even to rebalance the round-robin. A card in
 *  somebody's hand outranks even coverage. */
export function reseatParticipant(
  sets: ChallengeSet[],
  current: { key: string | null | undefined },
): { key: string | null; source: SetSource | null } | null {
  if (!sets.length) return current.key === null ? null : { key: null, source: null };
  if (current.key !== null && current.key !== undefined && sets.some((s) => s.key === current.key)) return null;
  // A participant with no card at all (NULL) at an event that HAS cards is not "orphaned" — they
  // joined before the list existed and assignSet has never run for them. Leave them alone; the
  // camera's own read path already answers them, and reassigning would be this function inventing
  // a change nobody asked for.
  if (current.key === null || current.key === undefined) return null;
  return { key: sets[0].key, source: sets.length > 1 ? 'pending' : 'auto' };
}

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
