import type { PosterTextItem } from './posterRender';

// ── Two rules the poster designer runs on, kept out of the component so they can be tested ──
//
// Neither is about drawing a poster, so neither belongs in posterRender.ts; both are about when the
// designer is allowed to do something, and both were the kind of one-line condition that is written
// inline, gets a case wrong, and is only noticed by the host it strands.

/** Has this host finished designing enough to be offered Print / PDF / PNG / JPG?
 *
 *  The export row used to sit at the foot of the designer from the moment it opened — on screen
 *  while the host was still on step 1 of six, being asked what their sign says. A poster printed
 *  then is a poster with the preset's words on it.
 *
 *  So the buttons are held back until the design is finished, where "finished" is any ONE of three
 *  things — because the point is to not interrupt a first-time host, NOT to make anyone walk a
 *  wizard to reach a button:
 *
 *   · `hasSavedDesign` — they are REOPENING a design they already made. It is finished; being sent
 *     back through six steps to reprint it would be the worst version of this change.
 *   · `!guided` — they took the "Skip — show me every control" escape hatch, or they reached the end
 *     of the flow (which turns guiding off). Someone who has asked for every control has asked for
 *     these too.
 *   · `seenLastStep` — they have reached the last step at least once in this session. Stepping back
 *     to fix a colour afterwards must not take the export row away again. */
export function posterExportsReady(o: {
  hasSavedDesign: boolean;
  guided: boolean;
  seenLastStep: boolean;
}): boolean {
  return o.hasSavedDesign || !o.guided || o.seenLastStep;
}

/** Is this `initialConfig` a design the host has already MADE, or only a starting point that has
 *  just been handed to the designer?
 *
 *  It matters because both arrive by the same door. The admin page passes
 *  `posterSeed ?? ev.posterConfig`, so `initialConfig` is a gallery preset when one was just picked,
 *  the empty object when "Start from scratch" was, and the host's saved design when they reopened
 *  one — and only the last of those is finished work that must not be sent back through the flow.
 *
 *  `layout` is what separates them, and not arbitrarily: it is where every element has been dragged
 *  to, so it is the part of a poster that only exists once someone has designed one. The designer
 *  always serialises it (see `cfg`); a preset is documented as setting the LOOK only — paper, ink,
 *  decoration, type — and sets no layout at all; and "start from scratch" is literally `{}`. That
 *  also means a design saved long before any of this existed still reads as finished, which is the
 *  case that must not break: those hosts have posters they print, and being made to walk a wizard to
 *  reprint one would be the worst version of this. */
export function isSavedDesign(cfg: Record<string, unknown> | null | undefined): boolean {
  if (!cfg) return false;
  const layout = (cfg as { layout?: unknown }).layout;
  return typeof layout === 'object' && layout !== null;
}

/** Should a click on a modal's backdrop close it?
 *
 *  `on:click|self` alone is not enough, and the bug it caused was losing work: select text inside
 *  the poster's inline editor by dragging, release the mouse past the edge of the sheet, and the
 *  browser delivers a click whose target IS the backdrop — so `|self` passed and the whole designer
 *  closed mid-edit. The same gesture shape closes it when a drag of a poster element ends over the
 *  backdrop.
 *
 *  A dismiss is a click ON the backdrop, which means the gesture has to have STARTED there too. One
 *  that began inside the sheet is the tail of something else, whatever it happens to end on.
 *
 *  `blockedByEditor` is the second rule: with the inline editor open, the first press outside it
 *  ends the edit and nothing more. Two different outcomes must not share one gesture. */
export function shouldDismissBackdrop(o: {
  downOnBackdrop: boolean;
  clickOnBackdrop: boolean;
  blockedByEditor?: boolean;
}): boolean {
  if (o.blockedByEditor) return false;
  return o.downOnBackdrop && o.clickOnBackdrop;
}

// ── Colours that follow the title, until they don't ──────────────────────────────
//
// The small lines bracketing the title and the name lockup are drawn in the title's colour. That is
// the right DEFAULT — they are parts of one piece of typography — but it had been a weld: there was
// no way for a host to say "not that one". Each now carries an optional override, blank meaning
// "the title's", so a design saved before any of it opens identically.
//
// Which leaves a smaller question: how does anyone find out the link is there, or get back to it?
// A permanent "sync" button beside every colour is clutter on a panel with none to spare, and it
// would be on screen at all times to say nothing. So it is offered only where there is something to
// reconcile — which is exactly the set this computes.

/** The overrides that are SET and DIFFER from the title's colour.
 *
 *  Blank is not a difference: it already means "the title's". Nor is an override that happens to
 *  hold the same value — a host who picked the title's own colour by hand has nothing to sync, and
 *  offering it anyway is an affordance for a no-op. Compared case-insensitively because `<input
 *  type="color">` emits lower case and a stored preset may not.
 *
 *  Order follows the keys given, so the caller decides what the list reads like. */
export function inkSyncTargets(title: string, overrides: Record<string, string | undefined>): string[] {
  const t = (title ?? '').trim().toLowerCase();
  return Object.keys(overrides).filter((k) => {
    const v = (overrides[k] ?? '').trim().toLowerCase();
    return !!v && v !== t;
  });
}

// ── One home per colour ──────────────────────────────────────────────────────
//
// The poster's text colours were reachable from TWO places at once. Each had a contextual swatch
// sitting on the field it colours ("Title" and its dot, on the Words step), and the Background step
// also carried a flat "Text colours" list of all eight — so six of the eight were two controls for
// one setting, and in "show all controls" (where every step's block renders at the same time) both
// copies were literally on screen together.
//
// A colour belongs beside the thing it colours: that is the only arrangement in which "what colour
// is this line" is answered where the question is asked, rather than by holding a mapping between a
// list of words and a list of colours four screens apart. So the flat list is gone in both modes,
// and this is the table that says where each swatch lives instead.
//
// It is here rather than inline in the component for the usual reason: it is the sort of mapping
// that grows a target, gets one wrong, and strands the host who wanted that one colour.

/** The poster's own text-colour targets. The trick card's four are a separate set on another tab. */
export type PosterColorTarget =
  'headline' | 'headTop' | 'headBottom' | 'names' | 'message' | 'steps' | 'code' | 'footer';

/** The guided step whose controls each colour sits beside.
 *
 *  Words (1) owns the six that colour words. Join (3) owns the two that do not — the code or link
 *  under the QR and the footer URL along the bottom — because that is the step holding the switches
 *  that put them on the page at all. Nothing lives on Background (5): a colour for the words is not
 *  a decision about the card stock, and that mix-up is what the host reported. */
export const POSTER_COLOR_STEP: Record<PosterColorTarget, number> = {
  headline: 1, headTop: 1, headBottom: 1, names: 1, message: 1, steps: 1,
  code: 3, footer: 3,
};

/** The colour rows whose control is on screen right now.
 *
 *  `step` is the guided step, or `null` for "show all controls" — where every step's block renders
 *  at once, so every row given is on screen. Pass the rows already filtered down to the elements
 *  actually being printed; this only narrows them to the current screen.
 *
 *  Three things read it: the label on the image-swatch strip, the target that strip writes to, and
 *  the re-point that keeps that target from being one the host cannot see. */
export function colorRowsForStep<T extends { key: string }>(
  step: number | null, rows: readonly T[], table: Record<string, number> = POSTER_COLOR_STEP,
): T[] {
  return rows.filter((r) => step === null || table[r.key] === step);
}

/** The trick card's four colours. */
export type CardColorTarget = 'cardTitle' | 'cardBody' | 'cardCode' | 'cardBg';

/** The cards' guided step each colour sits on — the same idea as POSTER_COLOR_STEP, and the same
 *  table it has to be, because the swatch strip aims at whatever is on screen.
 *
 *  It is a HYBRID, and deliberately: only two of the four have a field to sit beside. The title is
 *  typed on Words, and the code/link is switched on on Layout, so those two get a dot on the field
 *  that puts them on the card — exactly as the poster's do. The trick list's ink and the card's
 *  background have no field anywhere in the modal: the list comes from the event's trick list and
 *  the background is a colour and nothing else. So those two keep a control of their own, on the
 *  Colour step, which is what that step is now FOR. */
export const CARD_COLOR_STEP: Record<CardColorTarget, number> = {
  cardTitle: 1,
  cardCode: 3,
  // Step 2 — the List step, which now carries the card's own colours as its second section. It was
  // step 5, a page of its own; the owner's point was that a colour belongs beside the thing it
  // colours, and the cards flow is four steps now. Keep this in step with C_COLOUR_STEP in
  // PosterModal: the swatch strip aims at whatever is on screen, so a step moved in one place and
  // not the other aims at nothing.
  cardBody: 2, cardBg: 2,
};

/** Which control the image swatches are aimed at, given the ones on screen.
 *
 *  The swatch strip writes to one target at a time — whichever colour control was last focused —
 *  so an aim left pointing at something the host cannot see swallows colours with nothing in front
 *  of them changing. Two ways that happens: the element gets switched off (no footer URL, no footer
 *  colour), and the host walks to another step.
 *
 *  Aim held when it is still on screen, moved to the first row when it is not, and left ALONE when
 *  there is nothing on screen at all — a screen with no colour control has nothing to aim at, and
 *  clobbering the aim there would lose it on the way through. */
export function aimedColorTarget<K extends string>(current: K, onScreen: readonly { key: K }[]): K {
  if (!onScreen.length) return current;
  return onScreen.some((r) => r.key === current) ? current : onScreen[0].key;
}

// ── The designer's three tabs ────────────────────────────────────────────────
//
// Poster · Trick cards · Print. The third one exists because exporting was DUPLICATED: the poster
// tab carried Print/PDF/PNG/JPG and the cards tab carried its own PDF/PNG/"PDF (all)"/"All sheets",
// two surfaces with different capabilities, plus a "Front and back" dialog stacked on top of the
// designer as a modal-on-modal. One tab holds all of it, and nothing about printing lives anywhere
// else.

export type PosterTab = 'poster' | 'cards' | 'print';

/** The tabs, in order, always all three.
 *
 *  A function rather than a constant because the question it answers is one somebody WILL ask again
 *  — "should we hide the cards tab when the event has no trick list?" — and the answer has to be
 *  enforceable rather than remembered. It is no: hiding it is how a host never finds out the
 *  feature exists, and the trick list is the distinctive half of this product. The empty tab
 *  explains itself and offers to open the trick-list editor; see `cardsTabState`. */
export function posterTabs(): { key: PosterTab; label: string; emoji: string }[] {
  return [
    { key: 'poster', label: 'Poster', emoji: '🖼️' },
    { key: 'cards', label: 'Trick cards', emoji: '🃏' },
    { key: 'print', label: 'Print', emoji: '🖨️' },
  ];
}

/** What the trick-cards tab has to say for itself.
 *
 *  Three states, and the difference between the last two matters: "there is no trick list" is an
 *  offer to make one, "every card is switched off" is a setting the host can flip back, and
 *  answering the second with the first would tell someone to build a list they already have. */
export type CardsTabState = 'none' | 'all-off' | 'ready';
export function cardsTabState(o: { setCount: number; printableCount: number }): CardsTabState {
  if (o.setCount <= 0) return 'none';
  if (o.printableCount <= 0) return 'all-off';
  return 'ready';
}

/** Does the Print tab have anything to offer yet?
 *
 *  The SAME rule the poster's export row already ran on — posterExportsReady — not a second gate
 *  bolted beside it. Two things changed when printing moved into a tab of its own:
 *
 *   · It now covers the CARD exports too, which were never gated at all. They are printed from the
 *     same finished design, so holding one back and not the other was an oversight rather than a
 *     decision.
 *   · Either flow can satisfy it. A host who walked the cards flow to its end, or who asked the
 *     cards tab for every control, has finished designing just as much as one who did it on the
 *     poster side — and gating them on a flow they never opened would strand them.
 *
 *  The tab itself is never hidden or disabled. Not ready means it says which step they are on and
 *  offers the way out, for the same reason the empty cards tab explains itself. */
export function printReady(o: {
  hasSavedDesign: boolean;
  posterGuided: boolean;
  posterSeenLast: boolean;
  cardsGuided: boolean;
  cardsSeenLast: boolean;
}): boolean {
  const { hasSavedDesign } = o;
  return posterExportsReady({ hasSavedDesign, guided: o.posterGuided, seenLastStep: o.posterSeenLast })
    || posterExportsReady({ hasSavedDesign, guided: o.cardsGuided, seenLastStep: o.cardsSeenLast });
}

/** Which "reset layout" button the header shows, if any.
 *
 *  ONE button, never two. The poster and the cards each have their own arrangement and their own
 *  reset, and putting both in the header would add two controls to a bar that is already tight at
 *  400px — so the header carries the one belonging to the tab you are looking at.
 *
 *  Nothing on the Print tab has a layout to reset, so it gets neither; a reset offered there would
 *  quietly act on a tab the host cannot see. Nor does a cards tab with no trick list — there is no
 *  card, so there is nothing that has been arranged.
 *
 *  Full-screen arranging KEEPS it, unlike Start again: that mode exists to drag elements around,
 *  which makes putting them back the one control it most obviously wants, and the header there is
 *  down to undo/redo/Done so there is room for it. */
export type ResetTarget = 'poster' | 'cards' | null;
export function resetTargetFor(view: PosterTab, fsEdit = false, hasCards = true): ResetTarget {
  if (fsEdit) return 'poster';        // the full-screen stage is the poster's alone
  if (view === 'cards') return hasCards ? 'cards' : null;
  if (view === 'print') return null;
  return 'poster';
}

/** Can the step strip carry you from `from` to `to`?
 *
 *  The strip was `on:click={() => (pStep = i + 1)}` with no guard at all, so it would drop a
 *  first-time host onto step 5 of a flow they had answered one question of — the steps read as a
 *  progress indicator, so a forward jump reads as "skip ahead", and what they actually skipped was
 *  every default they were about to be asked to change.
 *
 *  Two gates, both borrowed from the event-creation wizard:
 *   · `maxReached` — the furthest step reached. Anything up to it has been seen and can be jumped
 *     back to (and forward to again, which is the point: going back to check a colour must not cost
 *     three presses of Next to undo).
 *   · `canAdvance` — whatever the CURRENT step still needs. It gates the strip exactly as it gates
 *     the Next button, so the strip can never be the way around a requirement.
 *
 *  A refusal is never silent in the component: the caller takes the host to whatever is blocking
 *  them, which is what the event wizard does with its one required field. */
export function canJumpToStep(o: {
  to: number;
  from: number;
  maxReached: number;
  last: number;
  canAdvance: boolean;
}): boolean {
  if (o.to < 1 || o.to > o.last) return false;
  if (o.to > o.maxReached) return false;
  if (o.to > o.from && !o.canAdvance) return false;
  return true;
}

// ── Reading a stored design back ────────────────────────────────────────────────
//
// The designer's `restore()` is a VALIDATING reader: the blob is stored server-side and a bad entry
// reaches ctx.font or drawDecorAt as NaN, which paints nothing and reads as the element having
// silently vanished. So every field is checked rather than trusted.
//
// It also has to be exhaustive, and that is the half that went wrong. `colour` exists on
// PosterTextItem, in the serialised cfg, in undo/redo and in the renderer — everywhere except the
// reader. A host who coloured a custom line saw it colour correctly, saw it survive undo, saw it
// save... and found it black again the next time they opened the designer. Nothing failed; the
// field was simply not copied back.
//
// Extracted here rather than left inline because "the reader forgot a field" is not a bug anyone
// spots by reading, and inside a 3700-line component there was nowhere to assert it. Now there is.

/** A hex colour the canvas will actually accept.
 *
 *  `#rrggbb` only, and strictly. The value ends up in `ctx.fillStyle`, which SILENTLY ignores
 *  anything it cannot parse and keeps the previous colour — so a junk value does not throw, it
 *  paints the line in whatever colour happened to be set last, which looks like a rendering bug
 *  somewhere else entirely. */
const HEX6 = /^#[0-9a-f]{6}$/i;

/** One stored text item, validated, or null if there is nothing usable in it. */
export function readTextItem(raw: unknown): PosterTextItem | null {
  const t = raw as Partial<PosterTextItem> | null | undefined;
  if (!t || typeof t.text !== 'string') return null;
  const num = (v: unknown, lo: number, hi: number, d: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
  return {
    text: t.text.slice(0, 80),
    x: num(t.x, 0, 1, 0.5),
    y: num(t.y, 0, 1, 0.7),
    size: num(t.size, 14, 120, 30),
    // Spread CONDITIONALLY, not `colour: t.colour ?? undefined`. The two are not the same thing
    // once this is serialised: `?? undefined` writes the key with an undefined value, which
    // JSON.stringify drops from the blob but which is present on the object — and the object is
    // what undo/redo compares and what the renderer reads. Absent has to mean absent, because
    // absent is what "inherit the poster's ink" is spelled as. A key that is sometimes there and
    // sometimes not would also make two identical designs compare as different and push a
    // phantom undo step.
    ...(typeof t.colour === 'string' && HEX6.test(t.colour.trim()) ? { colour: t.colour.trim() } : {}),
    // Conditional for exactly the same reason, and it matters more here: upright is the default and
    // is spelled ABSENT, so writing `rot: 0` onto every restored line would make a poster that has
    // never been rotated serialise differently from the one that was saved.
    ...(typeof t.rot === 'number' && Number.isFinite(t.rot) && t.rot !== 0
      ? { rot: Math.min(Math.PI, Math.max(-Math.PI, t.rot)) } : {}),
  };
}

/** Every usable stored text item. Bad entries are dropped rather than failing the whole restore —
 *  losing one line beats refusing to open a host's poster over a stray entry. */
export function readTextItems(raw: unknown): PosterTextItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => { const t = readTextItem(r); return t ? [t] : []; });
}

// ── When a design is worth saving ──────────────────────────────────────────────
//
// `persist()` is wired to a reactive statement that fires once on mount, and it writes the WHOLE
// cfg — layout included. That is how an unedited poster became a saved design: open a gallery
// preset, close it on step 1 without touching anything, and 800ms later the full cfg was written
// to the event. `isSavedDesign()` keys off `layout` being present, so on reopening, the designer
// read that write as finished work and unlocked every export on a poster still carrying the
// preset's words. The export gate held for 800 milliseconds.
//
// The rule is the obvious one, once written down: a design is worth saving if the host has actually
// designed something. The first real `pushUndo` is what "actually" means — every edit in the
// designer routes through it, including the coalesced burst a keystroke opens, and nothing else
// does.

/** Should the designer write this design to the event?
 *
 *  `hasSavedDesign` keeps the OTHER direction safe: reopening a finished poster must keep saving
 *  from the first moment, because the first thing such a host does may be an undo, and an undo that
 *  does not persist is a change that reappears on reload. */
export function shouldPersistDesign(o: { hasSavedDesign: boolean; edited: boolean }): boolean {
  return o.hasSavedDesign || o.edited;
}

// ── Leaving the designer for the trick-list editor, and coming back ────────────
//
// MissionsModal paints at z-index 80 and the designer's backdrop at 300, so the designer cannot sit
// behind it — it closes, and the parent reopens it afterwards. Reopening used to drop the seed
// ("use whatever is saved"), on the stated grounds that the designer auto-saves so nothing is lost.
// That is true of an EDITED design and false of an untouched one: shouldPersistDesign() deliberately
// writes nothing until the host's first real edit, so a gallery preset carried in as a seed exists
// nowhere but in the seed. The host picked a design, opened the empty trick-cards tab, pressed
// "Set up a trick list", and came back to the design they had before — or to none at all.
//
// It cannot simply be kept either: once a save HAS landed, the event holds the newer copy and
// putting the seed back would show the preset again with the host's edits gone.

/** What the designer should reopen with after the trick-list editor.
 *
 *  `persisted` is the designer's own answer to shouldPersistDesign() at the moment it closed: true
 *  means the event now has this design (or is about to, via the flush on destroy) and IT is the
 *  newer copy; false means the seed is the only copy there is. */
export function seedAfterMissions<T>(o: { seed: T | null; persisted: boolean }): T | null {
  return o.persisted ? null : o.seed;
}

// ── The selected element's own controls ──────────────────────────────────────
//
// Tapping an element used to open its text box on the spot, which is intrusive: selecting a thing
// to nudge it threw a keyboard over the poster. So a tap now SELECTS, and the element carries its
// own little cluster of controls — a pencil to open the editor, a bin, and a cross to let go of it.
//
// Two rules in here rather than in the component, for the usual reason: both are tables that grow
// an element, get one entry wrong, and strand the host who picked that element.

/** What the bin on a selected element does.
 *
 *  Three verbs, because "get rid of it" means three different things depending on what the element
 *  actually IS:
 *
 *  · 'delete'     — something the host ADDED (a line they typed, a motif they placed). It can be
 *                   un-added, and nothing else in the design depends on it existing.
 *  · 'clear'      — a FIXTURE: a slot that is part of what a poster is, carrying a stored position,
 *                   size and colour, of which only the words are the host's. Clearing empties the
 *                   words and leaves the rest exactly where it was, so re-typing brings the design
 *                   back instead of starting that element over. The colour is deliberately kept —
 *                   see VISIBLE_COLOR_ROWS, which hides a swatch for an element that is off and
 *                   never resets the value behind it.
 *  · 'toggle-off' — an element governed by a visibility switch that already exists in the panel.
 *                   The bin is a second way to reach that same switch, from the element itself.
 */
export type BinAction = 'delete' | 'clear' | 'toggle-off';

/** The poster's elements. `null` means this element gets NO bin, which is the load-bearing case:
 *  a control that is present but means something surprising on one element is worse than one that
 *  is simply absent where it does not apply.
 *
 *  · 'title' — the poster's ONE required field. The flow will not advance past step 1 without it
 *    (pCanAdvance) and the renderer falls back to 'Our Event' when it is blank, so a bin here would
 *    look like it had done nothing while quietly blocking the way forward.
 *  · 'qr' — the code IS how a guest joins, and nothing in this designer can remove it. The only
 *    switch anywhere near it (`qrPanel`) governs the WHITE CARD BEHIND the code rather than the
 *    code itself, and that switch is force-restored whenever the paper's symbol contrast is too low
 *    to carry a bare code — so a bin wired to it would be a control that visibly does nothing on
 *    every design over a photograph.
 */
export function binActionFor(key: string): BinAction | null {
  // Keyed by prefix, like every other route through the poster surface.
  if (key.startsWith('text:')) return 'delete';     // the host typed it
  if (key.startsWith('decor:')) return 'delete';    // the host placed it
  switch (key) {
    case 'message': case 'steps': case 'names': return 'clear';
    // `showBrand` — "Show the Snapdini mark". A plain toggle, on by default, not gated behind any
    // entitlement: the mark that is NOT optional is the chip punched into the middle of the code,
    // and that one is not an element on this stage at all. So the bin here is honest.
    case 'brand': return 'toggle-off';
    // `showFooterUrl` — "Show the link along the bottom".
    case 'footer': return 'toggle-off';
    case 'title': case 'qr': return null;
    default: return null;
  }
}

/** The trick card's two. Its own set, because a card is a different object with different rules.
 *
 *  · 'title' — clears `cardTitle`, which FALLS BACK to the poster's headline (cardHeading). So the
 *    card keeps a title either way, and the bin means "stop overriding the poster's".
 *  · 'qr' — one block covering the code and the line beside it, governed by two switches
 *    (`cardShowQr`, `cardShowLink`). The element is labelled "QR / join" and reads as one thing, so
 *    the bin turns the block off rather than half of it.
 */
export function cardBinActionFor(key: string): BinAction | null {
  switch (key) {
    case 'title': return 'clear';
    case 'qr': return 'toggle-off';
    default: return null;
  }
}

/** What a press on `key` is allowed to do while `held` is selected.
 *
 *  · 'take'  — nothing is selected, or this IS the selected element: select it, move it, resize it.
 *  · 'pinch' — something ELSE is selected. Exclusive selection means the press may not take the
 *    selection over and may not move `key`. It must still be allowed to become a two-finger pinch
 *    of the HELD element, though: the stage is a 316px thumbnail almost entirely covered by other
 *    elements' boxes, so "put a finger somewhere and pinch" has nowhere else to land.
 */
export type PressRole = 'take' | 'pinch';
export function pressRole(held: string | null, key: string): PressRole {
  return !held || held === key ? 'take' : 'pinch';
}

/** Which layer Escape peels off, innermost first.
 *
 *  The designer had no Escape at all, then grew one with the order written as a ladder of early
 *  returns — which is fine until a layer is added in the middle, which is exactly what a selected
 *  element is. One press must never take more than one layer: closing the whole designer from
 *  inside the full-screen arrange stage would throw away the panel and the work behind it in one
 *  keystroke.
 *
 *  The order:
 *   1. 'bin'        — an armed bin on one element. The most transient thing on screen, and the one
 *                     an Escape is most likely to be aimed at.
 *   2. 'restyle'    — "Start again", armed.
 *   3. 'reset'      — "Reset layout", armed.
 *   4. 'editor'     — the inline text box. (The textarea's own keydown usually swallows Escape
 *                     before it reaches the window; this is what makes the ladder right anyway.)
 *   5. 'selection'  — a selected element. It is a layer because it is now the ONLY thing the ✕ and
 *                     the Escape key release: a stage tap no longer deselects.
 *   6. 'fullscreen' — leave ⛶ Arrange. Outside the selection, because a selection lives ON that
 *                     stage: escaping the stage while still holding an element skips a layer.
 *   7. 'close'      — the designer itself.
 */
export type EscapeLayer = 'bin' | 'restyle' | 'reset' | 'editor' | 'selection' | 'fullscreen' | 'close';
export function escapeLayer(o: {
  binArmed?: boolean; restyleArmed?: boolean; resetArmed?: boolean;
  editing?: boolean; selected?: boolean; fullScreen?: boolean;
}): EscapeLayer {
  if (o.binArmed) return 'bin';
  if (o.restyleArmed) return 'restyle';
  if (o.resetArmed) return 'reset';
  if (o.editing) return 'editor';
  if (o.selected) return 'selection';
  if (o.fullScreen) return 'fullscreen';
  return 'close';
}

// ── Turning an element ────────────────────────────────────────────────────────
//
// The placed decorations have rotated since they were added — `rot`, in radians, a slider and an
// "↺ Upright" reset. This is that same vocabulary extended to the text, and the rules about WHICH
// elements get it and WHERE a dragged angle lands, in the one file where they can be tested.

/** The poster fixtures a host may turn.
 *
 *  Absent from it, and each for its own reason:
 *
 *  · **`qr`.** Not a design decision — a scanner finds a code's own orientation before it decodes
 *    it, so turning one buys the host nothing at all, while the join code or the URL printed in the
 *    panel's lower strip would come out sideways on the wall. It would also put the keep-out rect
 *    the placed motifs are clipped against (qrImageRect) on a diagonal, so a straight answer to
 *    "is this pixel on the code" would become an approximate one. Refused outright rather than
 *    limited to 90° steps: quarter turns have the same two problems and no upside either.
 *  · **`brand`.** The 🎩 Snapdini imprint, which is ours rather than the host's — it already has no
 *    resize grip and is locked to its own line (lockY), and a credit line askew on someone's
 *    wedding sign reads as a fault in the product, not as a design.
 *
 *  Everything else the host wrote — the title, the message, the how-to line, the name lockup, the
 *  footer URL, their own added lines and their own placed motifs — turns. */
export const ROTATABLE_ELEMENTS = ['title', 'message', 'steps', 'names', 'footer'] as const;

/** May this element be turned? Takes the same key space the drag surface does, so a host's own
 *  line (`text:2`) and a placed motif (`decor:0`) answer without needing a table of their own. */
export function canRotate(key: string): boolean {
  if (key.startsWith('decor:') || key.startsWith('text:')) return true;
  return (ROTATABLE_ELEMENTS as readonly string[]).includes(key);
}

/** How far apart the angles a drag settles onto are, and how close is close enough to land on one.
 *
 *  15° because the angles anybody actually wants — upright, a slight tilt, 45°, sideways, upside
 *  down — are all multiples of it, and 5° of tolerance because that is roughly one finger-width of
 *  travel at the radius a poster element is grabbed from. */
export const ROT_SNAP_STEP = 15, ROT_SNAP_WITHIN = 5;

/** Where a dragged rotation actually lands, in degrees, given the raw angle the pointer describes.
 *
 *  Snapped to the nearest 15° when it is within 5° of one and left free — to the whole degree —
 *  everywhere else. That is the same bargain the alignment guides already strike on the move drag:
 *  the angles people mean are easy to hit, and there is no threshold to fight your way out of,
 *  because every frame recomputes from the raw pointer rather than from the last snapped value.
 *
 *  Upright is a snap like any other, so a host can drag back to straight without needing the reset;
 *  the reset exists for the other case, where the element is under their finger. */
export function snapAngle(deg: number): number {
  // One name for one angle: a half turn is −180, never +180, so two identical designs cannot
  // serialise differently and push a phantom undo step.
  const wrapped = ((((deg + 180) % 360) + 360) % 360) - 180;
  const step = Math.round(wrapped / ROT_SNAP_STEP) * ROT_SNAP_STEP;
  const landed = Math.abs(step - wrapped) <= ROT_SNAP_WITHIN ? step : Math.round(wrapped);
  // `|| 0` folds −0 onto 0: Math.round(-3 / 15) is −0, and −0 and 0 are the same angle with two
  // names, which is the same phantom-undo trap as ±180 one line up.
  return (landed >= 180 ? -180 : landed) || 0;
}

// ── Cards on a sheet: which orientation is the host actually choosing? ────────
//
// The geometry was never wrong; the CONTROL's meaning was. One toggle set the SHEET's orientation
// and was labelled as though it set the card's — which it does at 4-up and at 1-up, and does the
// exact opposite of at 2-up:
//
//   | size      | landscape sheet | card you get | matched the toggle? |
//   | A6, 4-up  | 2 × 2           | landscape    | yes                 |
//   | A4, 1-up  | 1 × 1           | landscape    | yes                 |
//   | A5, 2-up  | 2 × 1           | PORTRAIT     | no — inverted       |
//
// Two A5s side by side on a landscape A4 are each portrait, necessarily: that is what half a
// landscape A4 IS. So one toggle meant "card orientation" for two sizes and its opposite for the
// third, and a host pressing Landscape at 2-up got portrait cards.
//
// The fix is to make the control mean the CARD, which is the thing being decided, and derive the
// sheet — "two landscape A5s" is the choice; "A4 landscape" is how it gets there. The STORED field
// is untouched and still holds the sheet: a host may already have printed from a saved design, and
// nothing about what comes out of the printer may change.

export type CardsPerSheet = 1 | 2 | 4;

/** One mapping, used in both directions, because a flip is its own inverse.
 *
 *  1-up and 4-up divide the sheet evenly on both axes, so the card keeps the paper's shape. 2-up
 *  halves ONE axis, so the card is the paper turned. */
const flipAt2 = (per: CardsPerSheet, v: boolean): boolean => (per === 2 ? !v : v);

/** The orientation of each CARD, given the sheet's. What the control now shows. */
export const cardLandscapeOn = (per: CardsPerSheet, sheetLandscape: boolean): boolean => flipAt2(per, sheetLandscape);

/** The orientation the SHEET has to be, for the host to get the card they asked for. What the
 *  control now writes, and what `@page { size: A4 … }` and the PDF still receive. */
export const sheetLandscapeFor = (per: CardsPerSheet, cardLandscape: boolean): boolean => flipAt2(per, cardLandscape);

/** How the sheet is divided. A4 halves and quarters exactly, so 1, 2 and 4 all tile it with nothing
 *  left over — which is why those are the three counts on offer and 3 is not. */
export function cardGrid(per: CardsPerSheet, sheetLandscape: boolean): { cols: number; rows: number } {
  if (per === 1) return { cols: 1, rows: 1 };
  if (per === 4) return { cols: 2, rows: 2 };
  // The split follows the paper: a portrait sheet halves across, a landscape one down the middle.
  return sheetLandscape ? { cols: 2, rows: 1 } : { cols: 1, rows: 2 };
}

/** What the chosen paper actually produces, said in CARD shapes rather than in paper sizes.
 *
 *  Takes the card's orientation, because that is now what the control above it means — and says
 *  where the scissors go, which is the one thing that changes with the sheet rather than the card. */
export function cardShapeNote(per: CardsPerSheet, cardLandscape: boolean): string {
  const o = cardLandscape ? 'landscape' : 'portrait';
  if (per === 1) return `One ${o} A4 card — the whole sheet.`;
  if (per === 4) return `Four ${o} A6 cards.`;
  // At 2-up the cut runs along the sheet's own long division: landscape cards stack, portrait ones
  // sit side by side.
  return `Two ${o} A5 cards, cut ${cardLandscape ? 'across the middle' : 'down the middle'}.`;
}

// ── One design, or one per card ──────────────────────────────────────────────
//
// There was only ever ONE trick-card design: four colours and one layout, shared by every card on
// every sheet, with the identifier as the only thing that differed. That is right for most hosts
// and stays the default — a set of table cards IS a matching set — so the toggle above this mostly
// makes the existing behaviour explicit, and what is new is the mode behind it.
//
// The shape is "absent means inherit", the same convention the poster's optional inks and a host
// line's colour already use, and it is what makes a saved design open unchanged: a blob written
// before any of this has no overrides and no toggle, so it reads as one design and every card
// resolves to the same object it always did.

/** One card's own look. `layout` is generic on purpose: it is the designer's Box map, and the rule
 *  being decided here is WHOSE look a card gets, not what a look is made of. */
export type CardLook<L> = { cTitle: string; cBody: string; cCode: string; cBg: string; layout: L };

/** Is this the card the others follow?
 *
 *  The FIRST card is the base design itself — it holds the scalars, it has no override entry and it
 *  cannot have one. That is what makes "↺ Same as Card A" mean *let go of your own look* rather
 *  than *copy A's values across*, which would look identical and then stop tracking. */
export const isBaseCard = (key: string | null, baseKey: string | null): boolean =>
  !key || !baseKey || key === baseKey;

/** The look a given card is actually PRINTED with.
 *
 *  Returns `base` ITSELF — the same object, not a copy — whenever the answer is "the shared one".
 *  That is the compatibility guarantee in one line: with `oneDesign` on, which is what every design
 *  saved before this carries, every card resolves to the identical values it always did, so every
 *  colour and every position downstream is computed from identical inputs. */
export function cardLookFor<L>(o: {
  oneDesign: boolean;
  base: CardLook<L>;
  sets: Readonly<Record<string, CardLook<L>>>;
  /** The card being resolved, or null when there are no trick lists at all. */
  key: string | null;
  /** The first card's key — the base. */
  baseKey: string | null;
}): CardLook<L> {
  if (o.oneDesign || isBaseCard(o.key, o.baseKey)) return o.base;
  return o.sets[o.key as string] ?? o.base;
}
