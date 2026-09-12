// Photo missions — the shot list a host hands their guests.
//
// A printed "I spy" card is the common version of this, and its own instruction usually reads
// "upload these to our shared album". Snapdini IS the album and the camera, so the list can be
// live: a guest picks a scene, shoots it, and it ticks off. What makes that worth doing here rather
// than on card stock is the roll — a guest gets a fixed number of shots and sees nothing until the
// reveal, so spending one on a mission is a real decision.
//
// This file is CONTENT plus pure selection helpers. It carries no state and talks to nothing, so it
// is unit-testable (challenges.test.ts) and safe to import anywhere in the front end. The server
// deliberately does NOT import it: it validates the shape of whatever a host saved (id, length,
// count) without an opinion on the text, which is what lets a host write their own.

/** A feeling, not a category — how a challenge makes the room behave. A host picks a mood and gets
 *  a list that fits the event they are actually running: a 21st and a memorial are not the same. */
export type Mood = 'classic' | 'fun' | 'silly' | 'heartfelt' | 'social';

export const MOODS: { key: Mood; label: string; hint: string }[] = [
  { key: 'classic',   label: 'The classics',  hint: "The shots you'd regret not having" },
  { key: 'fun',       label: 'Fun',           hint: 'Light, easy, everyone joins in' },
  { key: 'silly',     label: 'Silly',         hint: 'Daft — breaks the ice fast' },
  { key: 'heartfelt', label: 'Heartfelt',     hint: 'The ones that get framed' },
  { key: 'social',    label: 'Get them mixing', hint: 'Sends guests to people they’ve not met' },
];

export type Challenge = {
  /** STABLE for the life of the product. Ids are stored on photos and counted to rank packs, so
   *  renaming or reusing one silently rewrites history. Add a new id instead. */
  id: string;
  /** What the guest reads. Kept short enough to sit on one line of a printed card. */
  text: string;
  moods: Mood[];
  /** Asks for a clip. Excluded automatically when the event allows no video — see pickChallenges. */
  video?: true;
};

/** Longest a challenge may be, custom ones included. The constraint is the printed card, not the
 *  screen: past this it wraps to three lines on a 4-up A6 and the card stops looking designed. */
export const CHALLENGE_MAX_LEN = 48;

/** Hosts may set any number. 5 is the default because a list you can finish is worth more than a
 *  thorough one — and the cap is the roll, not the card: 20 missions against a 10-shot roll is a
 *  trap, so the picker warns rather than forbids. Printed "i spy" lists usually run 15-25, which is
 *  why the ceiling is there rather than lower. */
export const DEFAULT_COUNT = 5;
export const MAX_COUNT = 20;

export type Pack = {
  /** Matches the use-case landing-page slug where one exists, so the marketing page and the picker
   *  can show the same list. */
  key: string;
  label: string;
  /** Ordered as a host would most likely want them: the default pick is simply the first N. */
  challenges: Challenge[];
};

const C = (id: string, text: string, moods: Mood[], video?: true): Challenge =>
  video ? { id, text, moods, video } : { id, text, moods };

export const PACKS: Pack[] = [
  {
    // The default. An event needs no declared type to get missions — plenty of gatherings are none
    // of the eight we market a page for (a reunion, a christening, a leaving do), and those hosts
    // should not be the only ones handed an empty feature. Everything here works anywhere people
    // gather, and mentions no cake, no couple and no venue.
    key: 'general', label: 'Any event',
    challenges: [
      C('gen-your-group',   'Everyone you came with',               ['classic', 'social']),
      C('gen-whole-room',   'The whole room, in one shot',          ['classic']),
      C('gen-host',         'Whoever made this happen',             ['classic', 'heartfelt']),
      C('gen-laughing',     'Someone laughing properly',            ['classic', 'fun']),
      C('gen-just-met',     'Someone you met today',                ['social']),
      C('gen-food',         'The food, before anyone touches it',   ['classic']),
      C('gen-glass-raised', 'A glass raised',                       ['classic', 'fun']),
      C('gen-three-gens',   'Three generations in one frame',       ['heartfelt', 'social']),
      C('gen-quietest',     'The quietest corner of the room',      ['heartfelt']),
      C('gen-travelled',    'Whoever came the furthest',            ['social']),
      C('gen-best-dressed', 'Best dressed, by your judgement',      ['fun']),
      C('gen-keen-dancer',  'The most enthusiastic dancer',         ['fun', 'silly']),
      C('gen-photobomb',    'A successful photobomb',               ['silly', 'fun']),
      C('gen-best-shoes',   'The best shoes in the room',           ['silly', 'fun']),
      C('gen-last-ones',    'The last ones to leave',               ['fun']),
      C('gen-message',      'A message for whoever this is for',    ['heartfelt'], true),
      C('gen-old-young', 'The oldest and youngest here, together', ['heartfelt', 'social']),
      C('gen-room-back', 'The room from as far as you can get', ['classic']),
      C('gen-smallest', 'The smallest detail you can find', ['classic']),
      C('gen-packed-floor', 'The dance floor at its fullest', ['fun']),
      C('gen-two-strangers', 'Two people who’d never met, talking', ['social']),
      C('gen-decorations', 'The best bit of decoration', ['classic']),
      C('gen-resting', 'Someone resting their eyes', ['silly']),
      C('gen-seconds', 'Someone going back for seconds', ['silly', 'fun']),
    ],
  },
  {
    key: 'wedding', label: 'Wedding',
    challenges: [
      C('wed-table-group',  'Your whole table, squeezed in',        ['classic', 'social']),
      C('wed-first-dance',  'The couple’s first dance',             ['classic']),
      C('wed-unposed',      'The couple when they’re not looking',  ['classic', 'heartfelt']),
      C('wed-happy-tears',  'The happiest tears of the night',      ['heartfelt']),
      C('wed-just-met',     'Cheers with someone you just met',     ['social', 'fun']),
      C('wed-cake',         'The cake, before it’s cut',            ['classic']),
      C('wed-speech-laugh', 'The speech that got the biggest laugh', ['fun', 'heartfelt']),
      C('wed-grandparents', 'Someone’s grandparents, together',     ['heartfelt']),
      C('wed-three-gens',   'Three generations in one frame',       ['heartfelt', 'social']),
      C('wed-travelled',    'Whoever came the furthest to be here', ['social']),
      C('wed-shoes-off',    'Shoes off, dance floor on',            ['fun', 'silly']),
      C('wed-teach-move',   'Ask someone to teach you a dance move', ['silly', 'social'], true),
      C('wed-best-dancer',  'The best dancer on the floor',         ['fun'], true),
      C('wed-last-song',    'The last song of the night',           ['classic', 'heartfelt']),
      C('wed-photobomb', 'A successful photobomb', ['silly', 'fun']),
      C('wed-guestbook', 'Someone signing the guest book', ['classic']),
      C('wed-oldest-guest', 'The oldest guest here', ['heartfelt', 'social']),
      C('wed-youngest', 'The youngest guest, mid-mischief', ['fun', 'heartfelt']),
      C('wed-packed-floor', 'The dance floor when it’s completely packed', ['classic', 'fun']),
      C('wed-pulled-in', 'Someone who swore they wouldn’t dance', ['fun', 'silly']),
      C('wed-centrepiece', 'Your table centrepiece, up close', ['classic']),
      C('wed-smallest', 'The smallest detail you can find', ['classic']),
      C('wed-band', 'The DJ or band, mid-song', ['fun']),
      C('wed-seconds', 'Someone going back for seconds', ['silly', 'fun']),
    ],
  },
  {
    key: 'birthday', label: 'Birthday party',
    challenges: [
      C('bday-wish',        'The birthday face, mid-wish',          ['classic']),
      C('bday-group-star',  'A group shot with the birthday star',  ['classic', 'social']),
      C('bday-singing',     'Everyone singing',                     ['classic', 'fun'], true),
      C('bday-first-slice', 'The first slice',                      ['classic']),
      C('bday-eyes-shut',   'Someone laughing with their eyes shut', ['fun', 'heartfelt']),
      C('bday-worst-hat',   'The worst party hat',                  ['silly']),
      C('bday-best-move',   'Someone’s best dance move',            ['fun', 'silly'], true),
      C('bday-present-pile', 'The present pile, before',            ['classic']),
      C('bday-brought-cake', 'Whoever brought the cake',            ['heartfelt', 'social']),
      C('bday-oldest-youngest', 'The oldest and youngest guest, together', ['heartfelt', 'social']),
      C('bday-just-met',    'A selfie with someone you just met',   ['social']),
      C('bday-messiest',    'The messiest plate of the night',      ['silly']),
      C('bday-message',     'A birthday message to camera',         ['heartfelt'], true),
      C('bday-last-standing', 'The last ones standing',             ['fun']),
      C('bday-balloon', 'The best balloon in the room', ['silly', 'fun']),
      C('bday-gift-face', 'The face when they open your gift', ['classic', 'heartfelt']),
      C('bday-selfie-star', 'A selfie with the birthday person', ['classic', 'social']),
      C('bday-spot-cake', 'The cake, wherever it’s hiding', ['classic']),
      C('bday-candles', 'The candles, still lit', ['classic']),
      C('bday-packed-floor', 'The dance floor at its fullest', ['fun']),
      C('bday-party-hat', 'A selfie with someone in a party hat', ['fun', 'social']),
      C('bday-decorations', 'The best bit of decoration', ['classic']),
      C('bday-pulled-in', 'Someone who swore they wouldn’t dance', ['fun', 'silly']),
      C('bday-seconds', 'Someone going back for seconds', ['silly', 'fun']),
    ],
  },
  {
    key: 'corporate', label: 'Corporate event',
    challenges: [
      C('corp-team',        'Your team, all in frame',              ['classic', 'social']),
      C('corp-never-met',   'A colleague you’d never met before',   ['social']),
      C('corp-made-laugh',  'Someone who made you laugh today',     ['fun', 'social']),
      C('corp-running-show', 'Whoever’s running the show',          ['classic', 'heartfelt']),
      C('corp-end-of-day',  'The end-of-day group shot',            ['classic', 'social']),
      C('corp-presenting',  'Someone presenting',                   ['classic'], true),
      C('corp-view-seat',   'The view from your seat',              ['classic']),
      C('corp-handshake',   'A handshake, mid-shake',               ['classic']),
      C('corp-coffee-queue', 'The coffee queue',                    ['fun']),
      C('corp-best-badge',  'The best name badge',                  ['silly']),
      C('corp-other-team',  'Someone from a team you never work with', ['social']),
      C('corp-quiet-hero',  'The person doing the unglamorous job',  ['heartfelt']),
      C('corp-thanks',      'A thank-you to someone, to camera',    ['heartfelt'], true),
      C('corp-notebook',    'The most written-in notebook',         ['silly']),
      C('corp-loud-table', 'The table laughing loudest', ['fun', 'social']),
      C('corp-best-swag', 'The best bit of free swag', ['silly', 'fun']),
      C('corp-branded', 'Someone in company-branded anything', ['silly', 'fun']),
      C('corp-all-shoes', 'Everyone’s shoes, from above', ['silly', 'social']),
      C('corp-longest-serving', 'The longest-serving person here', ['heartfelt', 'social']),
      C('corp-new-starter', 'Someone who joined this year', ['social', 'heartfelt']),
      C('corp-room-back', 'The room from the very back', ['classic']),
      C('corp-whiteboard', 'The busiest whiteboard or flipchart', ['classic', 'fun']),
      C('corp-two-teams', 'Two people from different teams talking', ['social']),
      C('corp-seconds', 'Someone going back for seconds', ['silly', 'fun']),
    ],
  },
  {
    key: 'baby-shower', label: 'Baby shower',
    challenges: [
      C('baby-parents',     'The parents-to-be, together',          ['classic', 'heartfelt']),
      C('baby-biggest-aww', 'The gift that got the biggest “aww”',  ['classic', 'fun']),
      C('baby-grandparents', 'Grandparents-to-be',                  ['heartfelt']),
      C('baby-message',     'A message for the baby',               ['heartfelt'], true),
      C('baby-organiser',   'Whoever organised all this',           ['heartfelt', 'social']),
      C('baby-dessert',     'The dessert table, untouched',         ['classic']),
      C('baby-due-guess',   'Someone guessing the due date',        ['fun', 'social']),
      C('baby-game',        'A game in progress',                   ['fun'], true),
      C('baby-bump',        'The bump — if they’re up for it',      ['classic', 'heartfelt']),
      C('baby-siblings',    'The big brother or sister to be',      ['heartfelt']),
      C('baby-advice',      'Your best bit of advice, to camera',   ['heartfelt', 'social'], true),
      C('baby-quietest',    'The quietest moment of the day',       ['heartfelt']),
      C('baby-tiniest',     'The tiniest thing on the gift table',  ['fun']),
      C('baby-just-met',    'Someone you’ve only met today',        ['social']),
      C('baby-worst-guess', 'The worst due-date guess on the board', ['silly', 'fun']),
      C('baby-tiny-clothes', 'Someone holding up the tiniest outfit', ['silly', 'fun']),
      C('baby-guess-board', 'The guess board, once it’s full', ['classic']),
      C('baby-old-young', 'The oldest and youngest here, together', ['heartfelt', 'social']),
      C('baby-decorations', 'The best bit of decoration', ['classic']),
      C('baby-two-families', 'Two people from different sides, talking', ['social']),
      C('baby-name-guess', 'Someone guessing the name', ['fun', 'social']),
      C('baby-hands', 'Everyone’s hands in one frame', ['heartfelt', 'social']),
      C('baby-handmade', 'Something handmade for the baby', ['heartfelt']),
      C('baby-seconds', 'Someone going back for seconds', ['silly', 'fun']),
    ],
  },
  {
    key: 'hens', label: 'Hens / bachelorette',
    challenges: [
      C('hens-best-pose',   'The bride-to-be’s best pose',          ['classic', 'fun']),
      C('hens-matching',    'Matching outfits, all together',       ['classic', 'social']),
      C('hens-mid-laugh',   'The group, mid-laugh',                 ['classic', 'fun']),
      C('hens-message',     'A message for the bride',              ['heartfelt'], true),
      C('hens-organiser',   'Whoever organised all this',           ['heartfelt', 'social']),
      C('hens-first-round', 'The first round of the day', ['classic', 'fun']),
      C('hens-sash',        'The sash on someone unexpected',       ['silly']),
      C('hens-mirror',      'The best bathroom-mirror selfie',      ['fun', 'silly']),
      C('hens-how-met',     'How you met the bride, to camera',     ['heartfelt', 'social'], true),
      C('hens-first-last',  'The first photo of the day, recreated', ['fun', 'silly']),
      C('hens-shoes-end',   'Everyone’s shoes by the end of it',    ['silly']),
      C('hens-best-outfit', 'Best outfit that isn’t the bride’s',   ['fun']),
      C('hens-quietest',    'The one quiet moment of the whole day', ['heartfelt']),
      C('hens-just-met',    'A photo with someone you just met',    ['social']),
      C('hens-all-together', 'Everyone in one frame, no one missing', ['classic', 'social']),
      C('hens-bride-laughing', 'The bride laughing properly', ['classic', 'heartfelt']),
      C('hens-worst-move',  'Someone’s worst dance move',           ['silly'], true),
      C('hens-outfit-change', 'An outfit change, before and after', ['fun']),
      C('hens-packed-floor', 'The dance floor at its fullest', ['fun']),
      C('hens-old-young', 'The oldest and youngest of the group', ['heartfelt', 'social']),
      C('hens-decorations', 'The best bit of decoration', ['classic']),
      C('hens-group-stranger', 'The group, with someone you just met', ['social']),
      C('hens-most-tired', 'The most tired face of the day', ['silly', 'fun']),
      C('hens-seconds', 'Someone going back for seconds', ['silly', 'fun']),
    ],
  },
  {
    key: 'engagement', label: 'Engagement party',
    challenges: [
      C('eng-ring',         'The ring, close up',                   ['classic']),
      C('eng-unposed',      'The couple, unposed',                  ['classic', 'heartfelt']),
      C('eng-both-families', 'Both families in one frame',          ['heartfelt', 'social']),
      C('eng-cheers',       'Cheers, all glasses up',               ['classic', 'social']),
      C('eng-proposal-story', 'Someone telling the proposal story', ['fun', 'social'], true),
      C('eng-quiet-corner', 'The quietest corner of the party',     ['heartfelt']),
      C('eng-happiest',     'The happiest person here, not the couple', ['heartfelt', 'fun']),
      C('eng-not-met',      'A guest you’ve not met before',        ['social']),
      C('eng-hands',        'The couple’s hands',                   ['heartfelt']),
      C('eng-longest-married', 'The longest-married couple here',   ['heartfelt', 'social']),
      C('eng-advice',       'Your advice for the couple',           ['heartfelt'], true),
      C('eng-how-long',     'Ask someone how long they gave it',    ['silly', 'fun'], true),
      C('eng-best-dressed', 'Best dressed, by your judgement',      ['fun']),
      C('eng-last-ones',    'The last ones to leave',               ['fun']),
      C('eng-ring-guess', 'Someone guessing the ring size', ['silly', 'fun']),
      C('eng-families-mixing', 'Two people from different families talking', ['social', 'heartfelt']),
      C('eng-oldest-guest', 'The oldest guest here', ['heartfelt', 'social']),
      C('eng-youngest', 'The youngest guest, mid-mischief', ['fun', 'heartfelt']),
      C('eng-with-parents', 'The couple with both sets of parents', ['classic', 'heartfelt']),
      C('eng-packed-floor', 'The dance floor at its fullest', ['fun']),
      C('eng-centrepiece', 'Your table centrepiece, up close', ['classic']),
      C('eng-decorations', 'The best bit of decoration', ['classic']),
      C('eng-two-groups', 'Two friend groups mixing', ['social']),
      C('eng-seconds', 'Someone going back for seconds', ['silly', 'fun']),
    ],
  },
  {
    key: 'graduation', label: 'Graduation',
    challenges: [
      C('grad-certificate', 'The graduate with their certificate',  ['classic']),
      C('grad-cap-air',     'The cap, mid-air',                     ['classic', 'fun']),
      C('grad-family',      'The whole family, squeezed in',        ['classic', 'social']),
      C('grad-proudest',    'Whoever’s proudest, and it isn’t them', ['heartfelt']),
      C('grad-day-one',     'A friend from day one',                ['heartfelt', 'social']),
      C('grad-cheer',      'The loudest cheer of the day',         ['classic', 'fun'], true),
      C('grad-happy-tears', 'Someone crying happy tears',           ['heartfelt']),
      C('grad-message',     'A message for the graduate',           ['heartfelt'], true),
      C('grad-group-gowns', 'Everyone in gowns, together',          ['classic', 'social']),
      C('grad-best-cap',    'The best-decorated cap',               ['silly', 'fun']),
      C('grad-teacher',     'A teacher or mentor who mattered',     ['heartfelt']),
      C('grad-next',        'Ask the graduate what’s next',         ['social'], true),
      C('grad-who-paid',    'Whoever paid for all this',            ['silly', 'heartfelt']),
      C('grad-old-photo',   'A photo of a photo from first year',   ['heartfelt', 'silly']),
      C('grad-all-caps', 'Every cap in one frame', ['classic', 'fun']),
      C('grad-relieved', 'The most relieved face here', ['fun', 'silly']),
      C('grad-gown-selfie', 'A selfie in the gown', ['fun', 'social']),
      C('grad-hall', 'The hall, full', ['classic']),
      C('grad-venue-far', 'The venue from as far as you can get', ['classic']),
      C('grad-classmates', 'As many classmates as fit in one frame', ['fun', 'social']),
      C('grad-longest-hug', 'The longest hug of the day', ['heartfelt']),
      C('grad-best-sign', 'The best sign or banner here', ['fun']),
      C('grad-decorations', 'The best bit of decoration', ['classic']),
      C('grad-seconds', 'Someone going back for seconds', ['silly', 'fun']),
    ],
  },
  {
    key: 'christmas', label: 'Christmas / holiday party',
    challenges: [
      C('xmas-worst-jumper', 'The worst Christmas jumper',          ['classic', 'silly']),
      C('xmas-by-tree',     'A group photo by the tree',            ['classic', 'social']),
      C('xmas-under-lights', 'Everyone under the lights',           ['classic', 'social']),
      C('xmas-secret-santa', 'The Secret Santa reveal',             ['classic', 'fun']),
      C('xmas-other-team',  'Someone from a team you never work with', ['social']),
      C('xmas-most-food',   'The most food on one plate',           ['silly', 'fun']),
      C('xmas-loudest',     'Whoever’s singing loudest',            ['fun', 'silly'], true),
      C('xmas-paper-hats',  'Everyone in paper hats',               ['silly', 'social']),
      C('xmas-first-pie',   'The first mince pie of the night',     ['fun']),
      C('xmas-best-decoration', 'The best decoration in the room',  ['classic']),
      C('xmas-quiet-corner', 'The quiet corner conversation',       ['heartfelt']),
      C('xmas-thanks',      'A thank-you to someone who helped',    ['heartfelt', 'social'], true),
      C('xmas-cheers',      'Cheers to the year',                   ['classic', 'heartfelt']),
      C('xmas-dance-last',  'The last ones on the dance floor',     ['fun']),
      C('xmas-longest-here', 'Whoever’s been here the longest', ['heartfelt', 'social']),
      C('xmas-new-starter', 'Someone who only started this year', ['heartfelt', 'social']),
      C('xmas-branded', 'Someone in company-branded anything', ['silly', 'fun']),
      C('xmas-all-shoes', 'Everyone’s shoes, from above', ['silly', 'social']),
      C('xmas-cracker', 'A cracker, mid-pull', ['classic', 'fun']),
      C('xmas-packed-floor', 'The dance floor at its fullest', ['fun']),
      C('xmas-two-teams', 'Two people from different teams talking', ['social']),
      C('xmas-best-ornament', 'The best ornament on the tree', ['classic']),
      C('xmas-resting', 'Someone resting their eyes', ['silly']),
      C('xmas-seconds', 'Someone going back for seconds', ['silly', 'fun']),
    ],
  },
];

export const GENERAL_KEY = 'general';

/** Falls back to the general pack rather than null: an unrecognised or absent event type still
 *  deserves a list. Callers that genuinely need "is this a known type?" should check EVENT_TYPES. */
// ── The tick box on the printed card ────────────────────────────────────────
//
// A square is fine; a heart on a wedding card is better, and costs nothing. The event type only
// sets the DEFAULT — a host can pick any of these or type their own single character.
//
// Two groups on purpose. The outline glyphs are drawn in the card's own ink colour and print
// predictably on any printer. The emoji are drawn in colour by the device's own font, so they
// ignore the card's palette and will not match a monochrome print — worth it for a bottle on a
// baby-shower card, but the picker should say so rather than surprise someone at the printer.
export const TICKS_OUTLINE = ['\u25CB', '\u2610', '\u2661', '\u2606', '\u2727', '\u274D', '\u25A2'] as const;
export const TICKS_EMOJI = ['\u{1F37C}', '\u{1F393}', '\u{1F384}', '\u{1F388}', '\u{1F942}', '\u{1F48D}', '\u{1F381}', '\u{1F37E}'] as const;

export const DEFAULT_TICK: Record<string, string> = {
  wedding: '\u2661',            // white heart
  engagement: '\u{1F48D}',      // ring
  'baby-shower': '\u{1F37C}',   // baby bottle
  birthday: '\u{1F388}',        // balloon
  graduation: '\u{1F393}',      // mortar board
  christmas: '\u{1F384}',       // tree
  corporate: '\u2610',          // ballot box
  hens: '\u{1F942}',            // clinking glasses
  general: '\u25CB',            // circle
};

/** The tick a host starts with for this event type. Falls back to a plain circle, which suits
 *  anything and prints cleanly. */
export const tickFor = (eventType: string | null | undefined): string =>
  DEFAULT_TICK[eventType ?? ''] ?? '\u25CB';

/** A host's own tick: exactly one character, so the card's row height stays predictable.
 *
 *  Counts with the spread operator rather than .length, because an emoji is two UTF-16 units and
 *  .length would see two characters and wrongly reject it. */
export function cleanTick(input: string | null | undefined): string | null {
  // Drop variation selectors first. "\u2714\uFE0F" is what you get from pasting a tick out of an
  // emoji picker, and it is TWO code points — so the bare length check below silently rejected the
  // most obvious thing a host would choose, reverting to the default with no explanation.
  const chars = [...(input ?? '').trim().replace(/[\uFE0E\uFE0F]/g, '')];
  if (chars.length !== 1) return null;
  const code = chars[0].codePointAt(0) ?? 0;
  // A control character or a space renders as an invisible box on the card.
  return code < 0x20 || code === 0x7f || chars[0] === ' ' ? null : chars[0];
}

export const packFor = (key: string | null | undefined): Pack =>
  PACKS.find((p) => p.key === key) ?? PACKS.find((p) => p.key === GENERAL_KEY)!;

/** What a host can choose in the event's theming, general first because it is the default. */
export const EVENT_TYPES: { key: string; label: string }[] = PACKS.map((p) => ({ key: p.key, label: p.label }));

/** Every challenge we ship, for looking up the text behind an id stored on a photo. */
export const ALL_BY_ID: Record<string, Challenge> = Object.fromEntries(
  PACKS.flatMap((p) => p.challenges.map((c) => [c.id, c])),
);

// A seedable shuffle so "Shuffle" is reproducible in tests and a host can be handed the same list
// twice if we ever want to. Math.random by default.
export type Rng = () => number;
function shuffled<T>(arr: readonly T[], rng: Rng): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export type PickOpts = {
  count?: number;
  /** Null/absent ⇒ the curated order, which is what a host who just wants a sensible list gets. */
  mood?: Mood | null;
  /** False strips clip prompts entirely. Events can be configured with no video at all, and a
   *  mission a guest physically cannot complete is worse than one fewer mission. */
  allowVideo?: boolean;
  rng?: Rng;
  /** Draw from the WHOLE pack at random rather than its curated order. Without this, "shuffle"
   *  with no mood re-applied the curated order — which is the list the host is already looking at,
   *  so the button appeared to do nothing. */
  shuffle?: boolean;
  /** Cap on clip prompts in one list. A clip eats the guest's video allowance and takes longer to
   *  set up than a still, so a list of mostly-video missions quietly ruins the roll. */
  maxVideo?: number;
};

/**
 * Choose a list for a host.
 *
 * No mood ⇒ the pack's curated order (best-first), which is the default a host sees.
 * A mood ⇒ shuffled among the challenges carrying it, topped up from the rest in curated order so
 * the host always gets the number they asked for even from a thinly-tagged mood.
 */
export function pickChallenges(pack: Pack, opts: PickOpts = {}): Challenge[] {
  const { count = DEFAULT_COUNT, mood = null, allowVideo = true, rng = Math.random, maxVideo = 2, shuffle = false } = opts;
  const n = Math.max(1, Math.min(MAX_COUNT, Math.floor(count)));

  const usable = pack.challenges.filter((c) => allowVideo || !c.video);
  const preferred = mood ? shuffled(usable.filter((c) => c.moods.includes(mood)), rng)
                  : shuffle ? shuffled(usable, rng) : usable;
  const rest = mood ? usable.filter((c) => !c.moods.includes(mood)) : [];

  const out: Challenge[] = [];
  let videos = 0;
  const take = (c: Challenge) => {
    if (out.length >= n || out.some((o) => o.id === c.id)) return;
    if (c.video && videos >= maxVideo) return;
    if (c.video) videos++;
    out.push(c);
  };
  for (const c of preferred) take(c);
  for (const c of rest) take(c);
  // Last resort: the video cap alone kept us short, so relax it rather than return a short list.
  if (out.length < n) for (const c of [...preferred, ...rest]) { if (out.length >= n) break; if (!out.some((o) => o.id === c.id)) out.push(c); }
  return out;
}

/** A host's own wording. Same length rule as ours, and an id that cannot collide with a shipped
 *  one — popularity counting and photo tagging both key on the id. */
export function customChallenge(text: string, seq: number): Challenge | null {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t || t.length > CHALLENGE_MAX_LEN) return null;
  return { id: `own-${seq}`, text: t, moods: [] };
}

export const isCustomId = (id: string): boolean => /^own-\d+$/.test(id);

/** A named card. Several exist so a host can hand out different lists — one per table, say. */
export type MissionSet = { key: string; label: string; items: Challenge[] };
export const MAX_SETS = 8;

/**
 * Build several cards that differ, but not completely.
 *
 * The obvious implementation — pick each card independently — is wrong in a way that only shows up
 * after the event: the shots a host would actually regret missing end up on one card out of six, so
 * whether the cake got photographed comes down to which table that card landed on. So every card
 * shares a CORE taken from the front of the pack's curated order (the must-haves), and only the
 * remainder varies. Coverage of the important moments is guaranteed; the rest spreads out.
 *
 * `shared` is how many of the `count` are the common core. Default is about a third, minimum one —
 * enough to guarantee the essentials without making the cards feel identical.
 */
export function varySets(pack: Pack, opts: PickOpts & { sets?: number; shared?: number } = {}): MissionSet[] {
  const {
    sets = 2, count = DEFAULT_COUNT, mood = null, allowVideo = true, rng = Math.random, maxVideo = 2,
  } = opts;
  const n = Math.max(1, Math.min(MAX_SETS, Math.floor(sets)));
  const per = Math.max(1, Math.min(MAX_COUNT, Math.floor(count)));
  const shared = Math.max(0, Math.min(per, opts.shared ?? Math.max(1, Math.round(per / 3))));

  const usable = pack.challenges.filter((c) => allowVideo || !c.video);
  const core = usable.slice(0, shared);
  const coreIds = new Set(core.map((c) => c.id));
  // Everything not in the core, shuffled once and then DEALT round-robin, so each card gets its own
  // slice rather than each card re-rolling and duplicating the others by chance.
  const pool = shuffled(usable.filter((c) => !coreIds.has(c.id)), rng);

  const out: MissionSet[] = [];
  let cursor = 0;
  for (let i = 0; i < n; i++) {
    const items = [...core];
    let videos = items.filter((c) => c.video).length;
    let guard = 0;
    while (items.length < per && guard++ < pool.length * 2) {
      const c = pool[cursor++ % pool.length];
      if (items.some((o) => o.id === c.id)) continue;
      if (c.video && videos >= maxVideo) continue;
      if (c.video) videos++;
      items.push(c);
    }
    // If the pool is thinner than the ask, top up from anything left rather than hand back a short
    // card — a host who asked for eight should get eight.
    if (items.length < per) for (const c of usable) { if (items.length >= per) break; if (!items.some((o) => o.id === c.id)) items.push(c); }
    const key = String.fromCharCode(97 + i);
    out.push({ key, label: `Card ${key.toUpperCase()}`, items });
  }
  // A mood only narrows which challenges are eligible, applied by re-running the single-set picker
  // per card when one is set — the dealing above already guarantees variety.
  if (mood) {
    for (let i = 0; i < out.length; i++) {
      const picked = pickChallenges(pack, { count: per, mood, allowVideo, maxVideo, rng });
      // Keep the core so the essentials survive a mood the host chose for flavour.
      const merged = [...core];
      for (const c of picked) { if (merged.length >= per) break; if (!merged.some((o) => o.id === c.id)) merged.push(c); }
      out[i] = { ...out[i], items: merged };
    }
  }
  return out;
}

/**
 * One more card, varied against the cards that already exist.
 *
 * Adding a card used to call the plain picker, which returns the pack's curated order — so the
 * second card came out identical to the first and the host had to rebuild it by hand before it was
 * worth printing.
 *
 * The core is taken from what the existing cards ALREADY share, rather than from the pack: a host
 * who has reworked card A should get a card B that agrees with their version, not with ours. With a
 * single card to go on there is nothing to intersect, so its opening run stands in for the core —
 * those are the ones a host is most likely to have chosen deliberately.
 *
 * Everything after the core prefers challenges no existing card is using, so a new card genuinely
 * adds coverage instead of reshuffling what is already out there.
 */
export function varyOne(pack: Pack, existing: Challenge[][], opts: PickOpts & { shared?: number } = {}): Challenge[] {
  const { count = DEFAULT_COUNT, allowVideo = true, rng = Math.random, maxVideo = 2 } = opts;
  const per = Math.max(1, Math.min(MAX_COUNT, Math.floor(count)));
  const shared = Math.max(0, Math.min(per, opts.shared ?? Math.max(1, Math.round(per / 3))));

  const usable = pack.challenges.filter((c) => allowVideo || !c.video);
  const byId = new Map(usable.map((c) => [c.id, c]));

  let core: Challenge[] = [];
  if (existing.length === 1) {
    core = existing[0].slice(0, shared).map((c) => byId.get(c.id) ?? c);
  } else if (existing.length > 1) {
    const common = existing[0].filter((c) => existing.every((e) => e.some((x) => x.id === c.id)));
    core = common.slice(0, shared).map((c) => byId.get(c.id) ?? c);
  }
  if (!core.length) core = usable.slice(0, shared);

  const coreIds = new Set(core.map((c) => c.id));
  const usedElsewhere = new Set(existing.flat().map((c) => c.id));
  const fresh = shuffled(usable.filter((c) => !coreIds.has(c.id) && !usedElsewhere.has(c.id)), rng);
  const rest = shuffled(usable.filter((c) => !coreIds.has(c.id) && usedElsewhere.has(c.id)), rng);

  const out = [...core];
  let videos = out.filter((c) => c.video).length;
  for (const c of [...fresh, ...rest]) {
    if (out.length >= per) break;
    if (out.some((o) => o.id === c.id)) continue;
    if (c.video && videos >= maxVideo) continue;
    if (c.video) videos++;
    out.push(c);
  }
  // Never hand back a short card because the video cap or the pool ran dry.
  if (out.length < per) for (const c of usable) { if (out.length >= per) break; if (!out.some((o) => o.id === c.id)) out.push(c); }
  return out;
}
