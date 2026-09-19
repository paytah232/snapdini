<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher, tick } from 'svelte';
  import { modalFocus } from '$lib/ui';
  import { dep } from '$lib/reactive';
  import Toggle from '$lib/components/Toggle.svelte';
  import { showToast, showHint } from '$lib/toast';
  import { savePoster, type EventTheme } from '$lib/events';
  import { DEFAULT_EVENT_THEME } from '$lib/theme';
  import { tickFor, cleanTick } from '$lib/challenges';
  import { decorFor, DECOR_KINDS, DECOR_POSITIONS,
           type DecorKind, type DecorPos, type DecorPlacement } from '$lib/cardDecor';
  // ONE implementation of every poster drawing primitive, shared with the design wizard's preset
  // thumbnails.
  import { exportWidthPx, pdfFormat, readPaperSize, PAPER_SIZES, DEFAULT_PAPER, effectiveDpi,
           type PaperSize } from '$lib/paper';
  import { drawPoster, PAGE_W, PAGE_H, type Box, type PosterElKey, DEFAULT_POSTER_LAYOUT, clonePosterLayout, readPosterLayout,
           measureTitleBlock, measureNames, measureTextItem, measureBodyBlock, measureFooterUrl, brandFont,
           qrPanelRect, rotatedRect, symbolContrast, panelOptional, contrastGrade,
           readableOn, INK_BODY, IMAGE_INK_BG,
           splitNames, type PosterTextItem } from '$lib/posterRender';
  // ...and ONE implementation of the trick card, for the same reason and one more: a renderer that
  // lives in a component cannot be bundled, so it cannot be run outside the app, so it cannot be
  // PROVED unchanged. See cardRender.ts.
  import { drawCard, drawSheet, cardBoxAt, cardPaintFor, titleGeom, joinGeom, sheetGeom,
           readCardSets, readCardLayout, cloneCardLayout, DEFAULT_CARD_LAYOUT,
           CARD_SCALE, CARD_PAD, CARD_QR_MAX, CARD_LABEL_PX, CARD_LABEL_MIN, CARD_LABEL_MAX,
           listGeom, type CardSet, type CardElKey, type CardLayout, type CardDesign, type CardRenderOpts,
           } from '$lib/cardRender';
  import { TYPE_SETS, DEFAULT_TYPE_SET, typeSet, warmAllPosterFonts, type TypeSetKey, type TitleFace } from '$lib/posterFonts';
  import { titleBracketFor } from '$lib/posterPresets';
  import { isSavedDesign, shouldPersistDesign, readTextItems, printReady, shouldDismissBackdrop, posterTabs, cardsTabState,
           resetTargetFor, canJumpToStep, inkSyncTargets, colorRowsForStep, aimedColorTarget,
           binActionFor, cardBinActionFor, pressRole, escapeLayer, canRotate, snapAngle,
           cardLandscapeOn, sheetLandscapeFor, cardShapeNote, CARD_COLOR_STEP, POSTER_COLOR_STEP, isBaseCard,
           type PosterTab, type PosterColorTarget, type BinAction, type CardsPerSheet } from '$lib/posterFlow';
  import EventImageEditor from './EventImageEditor.svelte';
  import PosterPalette from './PosterPalette.svelte';
  import PosterElControls from './PosterElControls.svelte';

  export let eventName: string;
  export let blurb = '';                   // event welcome blurb — used as the default poster message
  export let joinUrl: string;
  export let joinCode: string;             // the join code (8 chars)
  export let qrDataUrl: string;            // data: URL of the join QR
  export let themeImageUrl: string | null = null; // the event image (inherited by default)
  /** The untouched upload the event image was cut from, when there is one — what makes reframing
   *  it for the poster's shape possible rather than re-cropping an existing 3:4 crop. */
  export let themeOriginalUrl: string | null = null;
  export let theme: EventTheme | null = null;      // event palette — drives default poster colours until edited
  export let orgCode = '';                 // organizer code — to persist the design to the DB
  export let initialConfig: Record<string, any> | null = null; // saved design from the DB

  // Resolved palette: an event with no custom theme still gets Snapdini's default warm palette here,
  // so the poster always offers "Match theme" + theme-derived text colours (not a bare gold/white).
  const tc: EventTheme = theme && Object.keys(theme).length ? theme : DEFAULT_EVENT_THEME;

  // Relative luminance (0–255) of a #rrggbb colour — used to auto-pick readable text colours.
  const lum = (hex: string): number => {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim()); if (!m) return 0;
    const n = parseInt(m[1], 16); return 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
  };

  // Default poster colours follow the event palette AND adapt to the background: on a light plain
  // background, body text goes dark (and a too-pale title falls back to near-black); on a dark
  // background or a darkened image, text stays light. These apply until the organizer edits a
  // colour, which then "locks" the chosen colours in (colorsLocked) so they stop tracking.
  const themeDefaults = () => {
    const acc = tc.accent || '#f5c518';
    const lightBg = bgMode === 'plain' && lum(cBg) > 140;
    if (lightBg) return {
      cHeadline: lum(acc) < 150 ? acc : '#1a1a1a',
      cMessage: '#333333', cSteps: '#333333', cCode: '#111111', cFooter: '#666666',
    };
    return { cHeadline: acc, cMessage: '#ffffff', cSteps: '#ffffff', cCode: '#111111', cFooter: '#ffffff' };
  };
  let colorsLocked = false;

  // ── Guided customising ──────────────────────────────────────────────────────
  //
  // The gallery gets a host to a finished design; this gets them through changing it. Dropped
  // straight into the full editor they meet every control at once with no idea which matter — the
  // blank-canvas problem again, one level down.
  //
  // The steps follow the order the questions actually occur in: what it says, what the join details
  // look like, what it is decorated with, what colour it is, and only then free-form arranging. The
  // canvas is on screen throughout, so every answer is previewed as it is given rather than
  // discovered afterwards.
  //
  // Same escape as everywhere else: skipping to every control is offered on the first step, and a
  // host who knows the editor never has to walk it. Not a gate.
  let pGuided = true;
  let pStep = 1;
  // Five, not six. The sixth was "Place", which held no control of its own — see the note where its
  // block used to be, above the Background step.
  const P_LAST = 5;
  // ── When the export row appears ────────────────────────────────────────────
  // Print / PDF / PNG / JPG used to sit at the foot of the panel from the moment the designer
  // opened — on screen while the host was still on step 1 being asked what their sign says. The
  // rule itself is posterExportsReady() in $lib/posterFlow, where it can be tested; these are the
  // two pieces of session state it reads.
  //
  // Latched, never cleared: stepping back from the last step to fix a colour does not un-finish a
  // design, and a button that comes and goes reads as a fault.
  let pSeenLast = false;
  $: if (pStep >= P_LAST) pSeenLast = true;
  // Read ONCE, at construction. `initialConfig` is what the designer was OPENED with; the design is
  // then saved continuously, so asking this live would turn true one keystroke in — which is
  // precisely the half-finished poster the gate exists to hold back.
  //
  // And not merely "is it there": a gallery preset and "start from scratch" arrive down this same
  // prop, and neither is finished work. isSavedDesign() is what tells them apart.
  const hadSavedDesign = isSavedDesign(initialConfig);
  // The furthest step reached. The strip can carry you anywhere up to it, in either direction, and
  // nowhere past it — see canJumpToStep() in $lib/posterFlow for why a forward jump is not free.
  let pMax = 1;
  $: if (pStep > pMax) pMax = pStep;
  // The poster's one requirement. A sign with no title is not a sign, and the preset's words are
  // exactly what the first step exists to replace — so clearing it holds the flow where the Next
  // button already holds it, and the strip cannot be the way round that.
  $: pCanAdvance = pStep !== 1 || !!headline.trim();
  // Named for what a host is deciding, not for what the code calls it. "Type" and "Join details"
  // are our vocabulary; "What does it say?" is theirs — and the step strip is the only guide anyone
  // gets on a phone, where the preview and the controls cannot both be on screen.
  const P_TITLES = ['Words', 'Type', 'Join', 'Art', 'Paper'];
  const P_ASK = [
    'What does your sign say?',
    'How should the words look?',
    'How do guests join?',
    'Anything drawn on it?',
    // Was "Colour" / "What colours?", when this step also held a flat list of every text colour —
    // a second copy of the swatches that already sit on the fields themselves. The list is gone, so
    // the step is what remains of it: the background, and whether that colour prints or IS the card
    // stock. Asking "what colours?" on a step that no longer holds the word colours is how a host
    // ends up hunting for them.
    'What is it printed on?',
    // "Where does everything sit?" went with the Place step. Arranging is not a step any more: the
    // preview is on screen throughout, and an element carries its own controls the moment it is
    // selected, so the host arranges while they answer everything else rather than afterwards.
  ];
  // What the Print tab has in it. The SAME rule the poster's export row ran on, now covering the
  // card exports too (which had no gate at all) and satisfiable from either flow — printReady() in
  // $lib/posterFlow carries the reasoning.
  $: exportsReady = printReady({
    hasSavedDesign: hadSavedDesign,
    posterGuided: pGuided, posterSeenLast: pSeenLast,
    cardsGuided: cGuided, cardsSeenLast: cSeenLast,
  });
  // The cards get the same treatment, with their own steps — they are a different object with a
  // different job, and walking someone through "Type" again on a tab that inherits the poster's
  // pairing would be walking them through nothing.
  let cGuided = true;
  let cStep = 1;
  const C_LAST = 4;
  const C_TITLES = ['Words', 'List & colour', 'Layout', 'Art'];
  /** Where the card's own two colours live. One constant, because the step number is ALSO the key
   *  CARD_COLOR_STEP files them under — the swatch strip aims at whatever is on screen, so a step
   *  moved in one place and not the other aims at nothing. */
  const C_COLOUR_STEP = 2;
  // A step with nothing in it is a dead end you still have to press Next through. The List step only
  // has anything to decide once there is more than one set — with a single card there is no set to
  // choose between and no preview to flick through, so it says why and gets stepped over.
  // Nothing is skipped any more. The List step used to be empty on an event with one trick card —
  // no set to choose between — and got stepped over; the card's colours now live there too, and
  // those are a decision every event has. The machinery stays because the concept is still right
  // and cheap; it simply has nothing to skip.
  // Plain consts, not reactive: neither depends on anything that changes any more.
  const cStepSkipped = (_n: number) => false;
  const cStepWhy = (n: number) => C_ASK[n - 1];
  /** The next usable step in a direction, or null at the end. */
  function cNextStep(from: number, dir: 1 | -1): number | null {
    for (let n = from + dir; n >= 1 && n <= C_LAST; n += dir) if (!cStepSkipped(n)) return n;
    return null;
  }
  // If the cards disappear while the host is standing on that step, move them off it rather than
  // leaving them on a panel with nothing in it.
  $: if (cGuided && cStepSkipped(cStep)) cStep = cNextStep(cStep, 1) ?? cNextStep(cStep, -1) ?? 1;
  // Latched the same way the poster's is: finishing the cards flow is finishing a design too, and
  // the Print tab counts it. A step that gets skipped still counts as reached, or an event with one
  // card could never reach the end of its own flow.
  let cSeenLast = false;
  $: if (cStep >= C_LAST) cSeenLast = true;
  let cMax = 1;
  $: if (cStep > cMax) cMax = cStep;
  // The cards have no required answer — the card title falls back to the poster's headline, and
  // every other control has a default that prints. So the strip's only gate here is the high-water
  // mark, and that is deliberate rather than an oversight.
  const C_CAN_ADVANCE = true;
  const C_ASK = [
    'What goes at the top?',
    'Which tricks, how many cards, and what colours?',
    "What's on the card?",
    'Anything drawn on it?',
  ];

  // ── Arriving on a step ──────────────────────────────────────────────────────
  //
  // Both lifted from the event-creation wizard, which had already been through this: changing step
  // used to leave you exactly where you had scrolled to, so pressing Next at the bottom of a long
  // panel showed you the bottom of the next one, and a jump from the strip landed somewhere with
  // nothing to say it had moved at all.
  //
  // The strip is the anchor rather than the panel: it carries the step number and the question, so
  // putting it at the top of the scroller is what tells a host where they now are.
  async function scrollToStepTop() {
    await tick();
    const el = document.querySelector('.editor .psteps');
    if (!el) return;                 // "show me every control" has no strip and nothing to jump between
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  }

  let flashed: Element | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** Ring whatever a jump landed on, briefly.
   *
   *  Copied from the event wizard down to the property: `outline` and `outline-offset`, NOT
   *  `box-shadow`. A shadow is drawn on the border box, and every container in this panel has
   *  children sitting flush against its edge — they paint straight over an outer shadow, which is
   *  the bug that made the wizard's first version look like a rendering fault. An outline takes no
   *  space, so nothing reflows either.
   *
   *  Reduced motion still gets the ring; it is a colour change, not movement. It just does not
   *  animate away, so the timer below is what clears it in both cases. */
  function flashCard(el: Element) {
    clearTimeout(flashTimer);
    flashed?.classList.remove('pf-flash');
    el.classList.remove('pf-flash');
    // Re-adding a class the element still had does NOT restart a CSS animation — the browser has
    // not recomputed style in between, so it simply carries on from wherever it was, and a second
    // jump to the same place flashes nothing. Reading a layout property forces the recalculation
    // that makes the re-add count. Measured: without this the ring fired once and never again.
    void (el as HTMLElement).offsetWidth;
    el.classList.add('pf-flash');
    flashed = el;
    flashTimer = setTimeout(() => { el.classList.remove('pf-flash'); flashed = null; }, 1600);
  }

  /** Land on a step.
   *
   *  Always the top of the panel; the ring only on a JUMP. Walking with Next and Back is a place
   *  the host put themselves one step at a time, and ringing every arrival would make the marker
   *  mean nothing by the third press — the event wizard rings goToStep/goToSection and leaves
   *  nextStep/prevStep alone for the same reason. */
  async function arriveAtStep(jumped = false, ring?: string) {
    await scrollToStepTop();
    if (!jumped) return;
    /* A cog says "show me THIS element's settings", and a step holds several elements' worth. The
       ring landed on the step's question, which answers "where am I" but not "which of these is
       yours" — press the How-to line's cog and you are told, correctly and unhelpfully, that you
       are on the Words step. Given a group to point at, point at the group.
       `block: 'nearest'` because scrollToStepTop has just put the strip at the top: if the group is
       already on screen this does nothing, and if it is further down the panel it brings it in. */
    const group = (ring ? document.querySelector(`.editor ${ring}`) : null) as HTMLElement | null;
    if (group) { group.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); flashCard(group); return; }
    const ask = document.querySelector('.editor .p-ask');
    if (ask) flashCard(ask);
  }

  /** The poster strip. Never absorbs a press silently — a refusal takes the host to whatever is
   *  standing in the way, which on this flow is the one field that has to be filled in. */
  /* ── From the element to its controls ────────────────────────────────────────
     The cog on a selected element takes you to the step carrying that element's APPEARANCE — its
     colour, its switches, its motif. The pencil beside it keeps the words, so the two never lead
     to the same place for the same reason.

     POSTER_COLOR_STEP is the source of truth wherever an element has a colour, because that table
     already decides which step a colour dot is drawn on and it must not be restated here. The rest
     are the elements with no colour of their own: the QR and the mark live with the join switches,
     a motif lives on Art. */
  const posterElStep = (key: string): number | null => {
    if (key.startsWith('decor:')) return 4;                       // Art
    if (key.startsWith('text:')) return 1;                        // a host's own line, with the words
    if (key === 'qr' || key === 'brand') return 3;                // Join
    return POSTER_COLOR_STEP[key as PosterColorTarget] ?? null;
  };
  /** The card's two elements. Same idea, same table — see CARD_COLOR_STEP. */
  const cardElStep = (key: string): number | null =>
    key === 'title' ? CARD_COLOR_STEP.cardTitle : key === 'qr' ? CARD_COLOR_STEP.cardCode : null;

  /** Go there, then say where "there" is. The flash is the existing one the step strip uses when it
   *  sends you back to a field you have not filled in — one vocabulary for "look here", not two. */
  async function showElSettings(step: number | null, card: boolean, key = '') {
    if (step === null) return;
    // The group carrying this element's controls, when one is marked. Not every element has one —
    // a placed motif's controls are the motif panel itself — and arriveAtStep falls back to the
    // step's question for those rather than ringing nothing.
    const ring = key ? `[data-el-settings="${CSS.escape(key)}"]` : undefined;
    releaseSelection();          // the panel is the subject now; a held element behind it is clutter
    // goPStep/goCStep already land it: arriveAtStep(true) puts the step strip at the top of the
    // scroller and rings the question. Doing it a SECOND time here was the whole bug, twice over.
    //
    // flashCard clears the previous ring by design, so this one cancelled the useful one — and what
    // it ringed instead was `.editor`, the entire panel. An outline around everything reads as an
    // outline around nothing, which is why the jump appeared to highlight nothing at all.
    //
    // And .pf-flash carries `position: relative; z-index: 2`, because the ring is drawn outside the
    // box in space the next sibling owns. `.head` is z-index 1. So ringing the panel lifted the
    // whole scrolling column above the sticky header for the 1.6s the flash ran: the steps slid
    // under the header and went on painting straight through it.
    if (card) await goCStep(step, true, ring); else await goPStep(step, true, ring);
  }

  /** `force` is a cog press: a direct request for one element's settings, not a strip press.
   *
   *  The strip reads as progress, so a forward press on it means "skip ahead" and is rightly
   *  refused. A cog on an element means "show me THIS element's settings" — and the element is on
   *  the poster, in front of the host, right now. Refused, the cog did nothing whatsoever: no
   *  movement, no message, a control that eats the press. That is the case the strip's own contract
   *  already rules out ("a refusal is never silent in the component"), and it was silent only when
   *  the current step was SATISFIED — press the QR cog on step 1 of a fresh poster and the jump to
   *  step 3 failed the maxReached gate with nothing to say about it.
   *
   *  A forced jump records that the step has been reached, or the strip would disagree with where
   *  the host is now standing. What force does NOT do is get past an unfilled requirement: that
   *  branch returns first, and still lands them on the field that is blocking them. */
  async function goPStep(n: number, force = false, ring?: string) {
    if (n === pStep) return;
    if (!canJumpToStep({ to: n, from: pStep, maxReached: pMax, last: P_LAST, canAdvance: pCanAdvance })) {
      if (n > pStep && !pCanAdvance) {
        pStep = 1;
        await scrollToStepTop();
        const el = document.getElementById('p-headline') as HTMLInputElement | null;
        el?.focus();
        if (el) flashCard(el);
        return;
      }
      if (!force || n < 1 || n > P_LAST) return;
      pMax = Math.max(pMax, n);
    }
    pStep = n;
    void arriveAtStep(true, ring);
  }
  function pNext() {
    if (!pCanAdvance) { void goPStep(pStep + 1); return; }   // same refusal, same landing
    if (pStep < P_LAST) { pStep += 1; void arriveAtStep(); }
  }
  function pBack() { if (pStep > 1) { pStep -= 1; void arriveAtStep(); } }

  /** The cards strip. A skipped step is pressable and takes you to the nearest one that isn't,
   *  rather than being a dead button that eats the tap. */
  async function goCStep(n: number, force = false, ring?: string) {
    if (n === cStep) return;
    const target = cStepSkipped(n) ? (cNextStep(n, n > cStep ? 1 : -1) ?? cNextStep(n, n > cStep ? -1 : 1)) : n;
    if (target === null || target === cStep) return;
    if (!canJumpToStep({ to: target, from: cStep, maxReached: cMax, last: C_LAST, canAdvance: C_CAN_ADVANCE })) {
      if (!force || target < 1 || target > C_LAST) return;   // see goPStep for what force means
      cMax = Math.max(cMax, target);
    }
    cStep = target;
    void arriveAtStep(true, ring);
  }
  function cNav(dir: 1 | -1) {
    const n = cNextStep(cStep, dir);
    if (n === null) return;
    cStep = n;
    void arriveAtStep();
  }

  const dispatch = createEventDispatcher<{ close: void; restyle: void; missions: { persisted: boolean } }>();

  /** "Start again from a design…" — two-step, arm then confirm.
   *
   *  Same mechanic as the guest gallery's delete bin (Camera.svelte) and the review page's Reject:
   *  the first press arms and relabels the button "Sure?", the second commits, and a click ANYWHERE
   *  else disarms it (the svelte:window handler below; the button itself stops propagation so its
   *  own arming press does not immediately undo itself). Escape disarms too, as the innermost layer.
   *
   *  No timeout. A control that disarms itself while the host is still reading what it warns about
   *  is worse than one that waits — and there is nothing dangerous about a button that is merely
   *  armed, only about the second press.
   *
   *  It is armed rather than confirm()'d because this throws away real design work: every colour,
   *  every dragged element, both the poster and the trick cards. */
  let restyleArmed = false;

  /** "↺ Reset layout" / "↺ Reset card layout" — the same two-step, for the same reason.
   *
   *  These were plain one-press buttons buried in the Layout group, and both throw away every
   *  element the host dragged and sized. Start again destroys comparable work and has always asked
   *  twice; that inconsistency was the actual defect, not the placement.
   *
   *  ONE button, whichever the active tab owns — see resetTargetFor() in $lib/posterFlow. Disarms
   *  on a click anywhere else and on Escape, exactly as Start again does; disarms too if the tab
   *  changes under it, because an armed control that now points at a different layout is worse than
   *  one that forgot. */
  let resetArmed = false;
  $: resetTarget = resetTargetFor(view, fsEdit, sheets.length > 0);
  // Reads `view` on purpose: the tab changing is what disarms it, and the Print tab (which has no
  // reset at all) is only the loudest case of that.
  $: { dep(view); resetArmed = false; }
  function pressReset() {
    // Arming one confirm disarms the other. Both stop propagation, so the window handler never
    // sees these presses — and two armed buttons would put two warning strips in the same place.
    restyleArmed = false;
    if (!resetArmed) { resetArmed = true; return; }
    resetArmed = false;
    if (resetTarget === 'cards') resetCardLayout();
    else resetLayout();
  }

  const W = PAGE_W, H = PAGE_H;             // A4 portrait — the page space posterRender.ts draws in
  // The slice of paper a printer cannot reach. Consumer inkjets and lasers lose 3–5mm on every edge
  // (more at the bottom on some), and a print shop wants a margin for trimming, so 5mm is the floor
  // for "this will come out whole". W maps to 210mm, so this is that in design pixels.
  const SAFE_MM = 5;
  const PAGE_PAD = Math.round((W / 210) * SAFE_MM);
  let canvas: HTMLCanvasElement;
  let busy = true;
  let mounted = false;

  const slug = (eventName || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event';
  // The printed URL and the QR must be the SAME string, and until now they were not: the QR is
  // rendered by the server from its canonical BASE_URL, while this was derived on the client from
  // `location.origin` in the admin page. They agree on a normal deployment and disagree on any
  // other — behind a proxy, on a preview host, or anywhere BASE_URL is not what the browser is
  // looking at. A poster is a thing that gets PRINTED, so a mismatch between the code people scan
  // and the address people type is not a cosmetic bug; it is a hundred cards with a dead link.
  // `loadPosterQr()` already receives the server's own joinUrl beside the QR image and used to
  // throw it away. It now wins, and the prop is only the value shown until that lands.
  let printedUrl = joinUrl;
  $: cleanUrl = printedUrl.replace(/^https?:\/\//, '');

  // ── Editable state (auto-saved to localStorage per event) ──
  let headline = eventName || 'Our Event';
  // Typography. 'plain' is the default so every poster saved before this existed opens looking
  // exactly as its host left it — a design that silently restyles itself is a design you cannot trust.
  let typeSetKey: TypeSetKey = DEFAULT_TYPE_SET;
  let titleFace: TitleFace = 'display';
  /** Change the pairing, and bring the title face back to something the pairing can actually hold.
   *
   *  Not all pairings have a script face. Moving from one that does to one that does not used to
   *  leave `titleFace` on 'script', so the toggle went on showing Script as the chosen option for a
   *  pairing with no script in it — a control claiming a state that does not exist, over a title
   *  the renderer had quietly fallen back to the display face for.
   *
   *  Deliberately here and not in a `$:` block. A reactive statement that both reads and assigns
   *  `titleFace` is the shape that already cost this codebase a day on the upgrade panel's
   *  keep-photos control: Svelte's handling of a self-assigned dependency made a control work or
   *  not depending on which flush it landed in. One handler, one order, no race. */
  function chooseTypeSet(key: TypeSetKey) {
    typeSetKey = key;
    if (!typeSet(key).script) titleFace = 'display';
  }
  // The small-caps lines that bracket the headline. Empty by default: two more lines of text is a
  // choice, not something to impose on a host who only wanted a title.
  let headlineTop = '';
  let headlineBottom = '';
  // Whose event it is, set as a lockup at the foot. Blank by default — it is a real design element,
  // not a field to be nagged about, and an empty one draws nothing and collides with nothing.
  let names = '';
  // Our wordmark across the top of someone else's wedding sign. Default on, host's call — the chip
  // in the QR is the mark that actually matters and it is not optional.
  let showBrand = true;
  // The white card under the QR. On by default and it stays that way unless the paper can carry the
  // code on its own — see qrSafe below, which measures rather than guesses.
  let qrPanel = true;

  // ── Placed decorations ─────────────────────────────────────────────────────
  // Motifs the host positions themselves, any number of them, each with its own size and rotation.
  // Empty means the old single-motif-in-a-slot behaviour, which is what every saved design has.
  let decorItems: DecorPlacement[] = [];
  // The on-page footprint of a motif at scale 1. drawDecorAt sizes from `unit`, and the poster
  // passes unit 2, so a scale-1 motif is 2 × 24 × 2 across. The drag system speaks in pixels and
  // the placement speaks in scale; this is the one number that converts between them, kept here so
  // there is no second copy of it to drift.
  const DECOR_PX = 96;

  // ── Lines the host adds themselves ─────────────────────────────────────────
  // A list, not a single spare field: a poster that allows exactly one addition is a poster that
  // needs a second one the moment someone wants a table number AND a hashtag. They are dragged and
  // resized through the same surface as everything else, keyed `text:<index>`.
  let textItems: PosterTextItem[] = [];
  const textIdx = (k: string) => (k.startsWith('text:') ? Number(k.slice(5)) : -1);
  function patchText(i: number, patch: Partial<PosterTextItem>) {
    if (!textItems[i]) return;
    textItems = textItems.map((t, n) => (n === i ? { ...t, ...patch } : t));
  }
  /** Has any line been given a colour of its own? Gates the one way back to following the message
   *  ink — offered once, under the list, rather than as a fourth control on every row. */
  $: textColoursSet = textItems.some((t) => !!t.colour);
  const clearTextColours = () => { textItems = textItems.map(({ colour, ...rest }) => rest); };
  function addText() {
    pushUndo(JSON.stringify(cfg));
    // Stepped down the page so a second does not land exactly on the first and look like nothing
    // happened. Seeded with words rather than blank — an empty line draws nothing, which reads as
    // the button having failed.
    const n = textItems.length;
    textItems = [...textItems, { text: 'Your own line', x: 0.5, y: Math.min(0.78, 0.66 + 0.05 * n), size: 30 }];
    selectedKey = `text:${textItems.length - 1}`;
  }
  function removeText(i: number) {
    pushUndo(JSON.stringify(cfg));
    textItems = textItems.filter((_, n) => n !== i);
    selectedKey = null;
  }
  $: selectedText = selectedKey ? textIdx(selectedKey) : -1;
  const decorIdx = (k: string) => (k.startsWith('decor:') ? Number(k.slice(6)) : -1);
  const decorBox = (i: number): Box => {
    const it = decorItems[i];
    // `rot` travels with the box so the drag has the angle it is starting from without a second
    // accessor for it — the same reason the box carries `size` rather than the drag asking twice.
    return it ? { x: it.x, y: it.y, size: it.scale * DECOR_PX, rot: it.rot } : { x: 0.5, y: 0.5, size: DECOR_PX };
  };
  function patchDecor(i: number, patch: Partial<DecorPlacement>) {
    if (!decorItems[i]) return;
    decorItems = decorItems.map((d, n) => (n === i ? { ...d, ...patch } : d));
  }
  // The motif the PLACE tool will drop next — its own choice, nothing to do with the design's
  // decoration above.
  //
  // It used to read `decorKind`, which meant the only way to place a sprig was to switch the whole
  // design to sprigs first: choosing what to add destroyed the decoration you already had. Two
  // different questions were sharing one answer.
  let placeKind: DecorKind = 'botanical';
  // Only the motifs that HAVE a position. A border or a QR wrapper is defined by the edges of the
  // paper or by the code, so "drop one here" is not a thing either of them can mean.
  const PLACEABLE = DECOR_KINDS.filter((d) => d.positional);
  let logoUploading = false;
  /** Upload a host's own mark and drop it on the paper.
   *
   *  `?kind=logo` is the whole reason this is not the ordinary theme-image upload: that path
   *  re-encodes to JPEG, which flattens alpha to black, and a crest in a black box is not a crest.
   *  The server keeps the alpha and re-encodes to PNG — the metadata scrub is the re-encode, so
   *  nothing is given up by changing the format.
   *
   *  The aspect ratio is measured HERE, before the upload is placed, because the placement's hit box
   *  has to exist before the image has loaded on the next open — otherwise a wide wordmark is
   *  grabbable only as a square until its file arrives. */
  async function onLogoFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    logoUploading = true;
    try {
      const ar = await new Promise<number>((res) => {
        const url = URL.createObjectURL(file);
        const im = new Image();
        im.onload = () => { res(im.naturalWidth / im.naturalHeight || 1); URL.revokeObjectURL(url); };
        im.onerror = () => { res(1); URL.revokeObjectURL(url); };
        im.src = url;
      });
      const form = new FormData();
      form.append('headerImage', file, 'logo.png');
      const res = await fetch(`/api/events/${joinCode}/theme-image?kind=logo`,
        { method: 'POST', body: form, headers: { 'X-Organizer-Code': orgCode } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      // Placed a little below the title, where a crest usually wants to be, and selected so the
      // first thing the host sees is the handles to move it with.
      decorItems = [...decorItems, { kind: 'logo', url: data.url as string, ar, x: 0.5, y: 0.34, scale: 1, rot: 0 }];
      selectedKey = `decor:${decorItems.length - 1}`;
    } catch {
      showToast('Could not add that image', true);
    } finally {
      logoUploading = false;
    }
  }

  function addDecor() {
    pushUndo(JSON.stringify(cfg));
    const kind = placeKind;
    // Stepped down the page so a second and third do not land exactly on the first and look like
    // one motif that did not appear.
    const n = decorItems.length;
    decorItems = [...decorItems, { kind, x: 0.5 + (n % 2 ? 0.18 : -0.18) * Math.min(n, 3), y: 0.16 + 0.07 * n, scale: 1, rot: 0 }];
    selectedKey = `decor:${decorItems.length - 1}`;
  }
  function removeDecor(i: number) {
    pushUndo(JSON.stringify(cfg));
    decorItems = decorItems.filter((_, n) => n !== i);
    selectedKey = null;
  }
  $: selectedDecor = selectedKey ? decorIdx(selectedKey) : -1;
  /** Write a rotation onto a Box or a host's own line — and write NOTHING when it is zero.
   *
   *  Upright is spelled ABSENT, not `rot: 0`. The two render the same and do not SERIALISE the
   *  same, and cfg is what the history watcher compares and what persist() saves: a design turned
   *  and then put back upright has to come out the same bytes it went in as, or it shows up as an
   *  edit that changed nothing. readTextItem() already keeps exactly this rule for a line's colour,
   *  and says why at more length.
   *
   *  The placed decorations are deliberately NOT routed through here: DecorPlacement has carried a
   *  required `rot: number` since it was added, every stored motif already has one, and making it
   *  optional now would be changing a saved shape for tidiness. */
  const withRot = <T extends { rot?: number }>(o: T, rot: number): T => {
    const { rot: _was, ...rest } = o;
    return (rot ? { ...rest, rot } : rest) as T;
  };
  // A welcome blurb (if set) becomes the default poster message; still freely editable below.
  let message = blurb.trim() || "You're invited — scan to join the camera";
  let stepsText = '①  Scan to join     ②  Snap your roll     ③  Revealed when it ends';
  let bgMode: 'event' | 'custom' | 'plain' = themeImageUrl ? 'event' : 'plain';
  // Is the plain background INK, or is it the PAPER?
  //
  // Nobody floods a home printer with a full-bleed colour, and for anything that matters a host
  // orders card stock that is already the colour — often textured. With this off the colour stands
  // in for that stock: shown the whole time you are designing, so the ink is chosen against what it
  // will really sit on, and left off the thing that actually prints. Defaults ON, which is what the
  // poster has always done. Only offered for a plain colour — an image background IS the design.
  let printBg = true;
  // True only while rendering for an export; the preview never sets it. Preview and export share
  // one canvas, so this cannot be a flag read at paint time — it has to be a redraw either side.
  let renderingForPrint = false;
  // What the poster is being printed ON. Every A size is the same shape, so this changes nothing
  // about the design — only how many pixels it is rasterised to and what the printer is told.
  let paperSize: PaperSize = DEFAULT_PAPER;
  // What the chosen paper actually resolves to, after the canvas ceilings in lib/paper.ts. A6–A4
  // get the full 300; the big sheets are capped by what a browser will allocate, not by the design.
  $: paperDpi = effectiveDpi(paperSize, exportWidthPx(paperSize, PAGE_H / PAGE_W));
  /** The poster's own background image, as an uploaded `/uploads/…` path.
   *
   *  It used to be an object URL, and the config even said so: "custom blob can't persist across
   *  reloads", with a line that quietly demoted the host back to Plain colour on the way in. So an
   *  upload survived exactly as long as the tab did — the one thing a saved design is supposed to
   *  do. It goes through the same endpoint the event image does, so it is scrubbed of metadata and
   *  swept with the event like every other file. */
  let customBgUrl: string | null = null;
  let bgUploading = false;
  let editorSrc = '';                      // reframing an existing image rather than cropping a new one
  $: canReframeEvent = bgMode === 'event' && !!themeOriginalUrl;
  // "Match theme" uses the event's SURFACE colour (what the app modals use) rather than the very
  // dark page bg, so the poster reads like the rest of the themed UI.
  const matchBg = tc.surface || tc.bg || '#ffffff';
  // Plain-background colour. With no event image we default to Match theme so the poster is themed
  // out of the box; otherwise white is the neutral default behind the (image) background.
  let cBg = themeImageUrl ? '#ffffff' : matchBg;
  // The QR drawn on the poster: a clean white-background, high-error-correction code (fetched on
  // mount) so it stays scannable with the brand logo punched into its centre. Falls back to the
  // small in-app QR passed in until the print-quality one loads.
  let qrImg = qrDataUrl;
  let codeDisplay: 'url' | 'code' | 'none' = 'url';
  let showFooterUrl = true;
  // ── Free layout: every element is independently draggable + resizable, so the organizer can
  // place text off faces. x/y are the element CENTRE as a fraction of the poster (0–1); `size` is
  // px in the 1080-wide canvas space (font size for text; the QR square's width for `qr`). ──
  type ElKey = PosterElKey;
  // Default positions are spaced so nothing overlaps: brand at the very top, title + message above
  // the QR panel, the QR centred, then the how-to line and footer below it. (The QR's white panel
  // is ~675px tall at the default size, so its top sits ≈0.36 and bottom ≈0.81 of the page.)
  // Both of these moved to $lib/posterRender — the preset gallery lays a poster out without ever
  // opening this editor, so they belong with the drawing rather than with the editing.
  const DEFAULT_LAYOUT = DEFAULT_POSTER_LAYOUT;
  const cloneLayout = clonePosterLayout;
  let layout: Record<ElKey, Box> = cloneLayout(DEFAULT_LAYOUT);
  let { cHeadline, cMessage, cSteps, cCode, cFooter } = themeDefaults();
  // Three colours that FOLLOW the title rather than being welded to it. Blank means "the title's",
  // which is the default, what every saved design has, and what an untouched new one keeps — the
  // renderer's inkOf() does the falling back, so an absent value cannot mean anything else.
  let cHeadTop = '';
  let cHeadBottom = '';
  let cNames = '';
  /** Does a separator in the names build the stacked lockup? On, as it always has been. Off sets
   *  the line exactly as typed — "One & Two", one row — which is sometimes the whole point. */
  let stackNames = true;

  let palette: string[] = [];
  // Colour targets for the picker + the image-palette swatches. The card's four are in the SAME
  // union so the swatch strip works on whichever tab is open rather than only on the poster.
  // The poster's eight come from posterFlow, which is also where the step each one lives on is
  // recorded — one table, so a new colour cannot be added to the union and left with no home.
  type CTarget = PosterColorTarget | 'cardTitle' | 'cardBody' | 'cardCode' | 'cardBg';
  let activeTarget: CTarget = 'headline';
  /** Aim the image swatches at one control. ONE handler, built per key, rather than the same inline
   *  arrow written out beside all twelve colour inputs.
   *
   *  It runs on FOCUS, which is the half that was missing: onColorInput() below also aims, but only
   *  once a colour has actually been picked — so before this, tapping a dot and then a swatch put
   *  the swatch on whatever was aimed at last. Focus is the moment the host says "this one". */
  const aimAt = (key: CTarget) => () => { activeTarget = key; };
  let editorFile: File | null = null;

  // ── Trick cards: a second OUTPUT of the same design, not a second design ──
  // The printable trick card is how a shot list actually reaches a guest: A6, A5 or A4 cards to an
  // A4 sheet, one per place setting. It borrows the poster's title, colours, background and join
  // details so the two read as one printed set; what is card-specific is the shot list itself, the
  // card's own layout, its decoration, and an ink-saver option — four cards a sheet on a home
  // printer is a very different ink bill from one poster.
  // The renderer's own shape — one definition, so a set the component holds is a set it can draw.
  type MissionSet = CardSet;
  let view: PosterTab = 'poster';
  const TABS = posterTabs();
  let sheets: MissionSet[] = [];
  let eventType: string | null = null;
  // The same value that picks the tick glyph and the default motif also picks the EXAMPLE the two
  // small title lines suggest — one vocabulary for "what kind of event is this", not a third one.
  // A placeholder only: see the fields themselves, and titleBracketFor().
  $: titleBracket = titleBracketFor(eventType);
  // The tick glyph belongs to the trick list, not to the print panel: it is chosen in the trick-list
  // editor and arrives here on the admin payload, so the card simply prints what the list uses.
  // Offering a second picker here would let the printed card disagree with the app in a guest's hand.
  let savedTick: string | null = null;
  let sheetIdx = 0;
  let cardsDrawn = false;                  // first sheet rendered — until then the preview spins
  let cardCanvas: HTMLCanvasElement;
  // Blank means "follow the poster title". The default has to survive the modal opening before the
  // event's missions have loaded, and a host who never opens this tab should still get a sensible card.
  let cardTitle = '';
  let cardInkSaver = false;
  // 4 / 2 / 1 to an A4 sheet — A6 place cards, A5 halves, or one full-page card. A4 halves and
  // quarters exactly, so every option tiles the sheet with nothing wasted.
  let cardsPerSheet: CardsPerSheet = 4;
  /** SQUARE by default. Rounded was the default and it fights the two things these cards are for:
   *  a rounded card cannot be cut with a guillotine, and over a full-bleed event image the rounding
   *  leaves white paper showing in each corner — the picture stops short of the cut line and the
   *  card reads as a sticker on a page rather than as a card. Hosts who want rounding still have the
   *  toggle; designs already saved keep whatever they were saved with. */
  let cardRound = false;
  let cardCutLines = true;                 // dashed guides along the cuts; see CardRenderOpts.cutLines
  let cardIds = true;                      // print "Card A" / "Card B" — off = shuffle and hand out at random
  // Where the identifier sits relative to the title, and how big it is.
  //
  // It used to be welded above the title at a fixed 19px, which made it a permanent part of the
  // title lockup rather than the small piece of housekeeping it is — a host who wanted it out of
  // the way, or merely smaller, had nothing to reach for. It still travels WITH the title block
  // (one draggable thing, as on the poster); what it now has is a side and a size.
  //
  // The defaults reproduce the old card exactly, and a design saved before this has neither field.
  let cardLabelPos: 'above' | 'below' = 'above';
  let cardLabelSize = CARD_LABEL_PX;
  let cardSkip: string[] = [];             // set keys NOT to print; stored as exclusions so a NEW set is included by default
  /** Off for a NEW design, and only for a new one.
   *
   *  Most trick cards are wanted minimal — a list, a title and nothing else — and the guests who
   *  are going to scan anything have already scanned the main event sign on the way in. A code on
   *  every card was printing ink nobody used.
   *
   *  What it is NOT is a change to anybody's saved design: restore() reads this with `??` and the
   *  serialised cfg has always carried the field, so every design ever saved keeps the code it was
   *  designed with. Cards already printed with one still work — `?set=` is honoured ahead of
   *  everything else, and now actually reaches the join call (see joinEvent).
   *
   *  Turning it off is what makes "which card are you?" a question at all: without a code on the
   *  card, the app cannot know which one a guest is holding unless it asks. See the camera's card
   *  chooser and assignSetWithSource. */
  let cardShowQr = false;
  /** Off for a new design too, and for the same reason as the QR above — it is the other half of
   *  the same join block. Left on alone it printed "Scan to join" over a code with nothing to
   *  scan, which is the join block's heading describing a thing that is no longer on the card.
   *
   *  What is left is the minimal card: a title, the trick list, and the note beside it. Guests
   *  join off the main event sign, which is the case the whole card-chooser exists for. Both
   *  switches are one tap away, and no saved design is touched (restore() reads with `??`). */
  let cardShowLink = false;
  /** What the card prints beside its QR when `cardShowLink` is on.
   *
   *  It used to be the POSTER's `codeDisplay`, which meant a host who set the poster to show
   *  "Nothing (QR only)" got a card with the words "Scan to join" and then blank space under them —
   *  having ticked the card's own box asking for exactly the opposite. The card's checkbox now
   *  means what it says: tick it and something is printed.
   *
   *  The poster's choice is still honoured where it is an actual preference — a host who picked the
   *  CODE for the poster gets the code on the card too — but 'none' is a choice about the poster,
   *  not an instruction to print a heading over nothing. */
  let cardCodeMode: 'code' | 'url' = 'url';
  $: cardCodeMode = codeDisplay === 'code' ? 'code' : 'url';
  let cardCaption = 'Tick them off as you pull them off.';
  // Card colour overrides. Blank = follow the poster's colour (which is the whole point of the two
  // being one design); set = this card does its own thing.
  //
  // These four and `cardLayout` below are CARD A's design, and — while "one design" is on, which is
  // the default — every card's. See cardDesignFor() in $lib/cardRender, which is where a card's
  // look is resolved now.
  let cardCTitle = '', cardCBody = '', cardCCode = '', cardCBg = '';
  // Decoration: the line-art layer. Blank kind = "not chosen yet" → the event type picks one.
  let decorKind: DecorKind | '' = '';
  /** Which of the two Art groups opens first, decided ONCE from the background.
   *
   *  A poster on a plain colour wants our drawings, so Decoration leads and Place your own is a
   *  drawer. A poster on a picture does not — the picture IS the decoration, and a motif over it is
   *  usually the wrong answer — so the order inverts: the thing a host actually wants there is to
   *  put something of their own on top.
   *
   *  Set once, on the first render that knows the background, and then left alone: these are
   *  `bind:open`, so after that the host's own toggling wins. Recomputing them reactively would
   *  re-open a drawer they had just closed every time they touched the background. */
  let decorOpen = true;
  let placeOpen = false;
  let artGroupsSet = false;
  $: if (!artGroupsSet && mounted) {
    const picture = bgMode !== 'plain';
    decorOpen = !picture;
    placeOpen = picture;
    artGroupsSet = true;
  }
  let decorPos: DecorPos = 'top';
  let decorScale = 1;
  let decorColour = '';                    // blank = follow the card's title ink
  // The card's own free layout. Positions are fractions of the CARD (not the sheet), so a design
  // survives switching between 4-up, 2-up and 1-up; sizes are in A6 px and are multiplied by the
  // paper scale below, so a card on a bigger sheet grows rather than floating in white space.
  let cardLayout: CardLayout = cloneCardLayout(DEFAULT_CARD_LAYOUT);

  // ── One design, or one per card ────────────────────────────────────────────
  //
  // There was only ever ONE card design. The four colours above and `cardLayout` are scalars, and
  // the only thing that differed between the cards on a table was the identifier — cardLabelFor().
  // The Layout hint said so out loud: "The rest of the sheet follows this card."
  //
  // That is right for most hosts and stays the default: a matching set is what a set of table cards
  // IS. So the toggle mostly makes the existing behaviour EXPLICIT, and the new work is the mode
  // behind it — where Card B can carry its own colours and its own arrangement, for an event whose
  // tables are not meant to look alike.
  //
  // The shape is "absent means inherit", the same convention the poster's optional inks and the
  // host's line colours already use:
  //   · Card A IS the base design — the scalars above. There is no entry for it and there cannot be
  //     one, which is what makes "↺ Same as Card A" mean something rather than being a copy;
  //   · any other card with no entry follows Card A;
  //   · an entry is created the moment that card is edited, seeded from Card A.
  // So a design saved before this existed has no `cardSets` and no `cardOneDesign`, reads as one
  // design, and renders byte-identically. That is not an assertion — see PosterModal.cards.test.ts
  // and the Chromium hashes in DEVELOPMENT.md.
  let cardOneDesign = true;
  let cardSets: Record<string, CardDesign> = {};
  /** Card A's design — the one the scalars hold.
   *
   *  Takes its parts as ARGUMENTS rather than closing over them, so the reactive statement that
   *  builds `cardOpts` names every one of them syntactically. `$:` does not track state read inside
   *  a called function, and the base design is read by every draw on this tab. */
  const cardBaseOf = (cTitle: string, cBody: string, cCode: string, cBg: string, layout: CardLayout): CardDesign =>
    ({ cTitle, cBody, cCode, cBg, layout });
  const cardBase = (): CardDesign => cardBaseOf(cardCTitle, cardCBody, cardCCode, cardCBg, cardLayout);
  /** Is this the card the others follow? With no sets at all, everything is Card A. */
  const isBaseSet = (set: MissionSet | null): boolean => isBaseCard(set?.key ?? null, sheets[0]?.key ?? null);
  /** Does this card have a design of its own to let go of? Gates "↺ Same as Card A". */
  const cardHasOwn = (set: MissionSet | null): boolean => !!set && !isBaseSet(set) && !!cardSets[set.key];
  /** Change the card being edited — Card A's scalars, or that card's own entry, creating it from
   *  Card A the first time.
   *
   *  ONE writer, because every control on this tab has to agree about which card it is changing.
   *  The layout is cloned when an entry is materialised: two cards sharing one layout object would
   *  drag together. */
  function patchCardDesign(patch: Partial<CardDesign>) {
    const set = activeSheet;
    if (cardOneDesign || isBaseSet(set)) {
      if (patch.cTitle !== undefined) cardCTitle = patch.cTitle;
      if (patch.cBody !== undefined) cardCBody = patch.cBody;
      if (patch.cCode !== undefined) cardCCode = patch.cCode;
      if (patch.cBg !== undefined) cardCBg = patch.cBg;
      if (patch.layout) cardLayout = patch.layout;
      return;
    }
    const cur = cardSets[set!.key] ?? { ...cardBase(), layout: cloneCardLayout(cardLayout) };
    cardSets = { ...cardSets, [set!.key]: { ...cur, ...patch } };
  }
  /** Put this card back to following Card A — by DELETING its entry, not by copying Card A's values
   *  into it. Absent is what "follows" is spelled as, so a copy would look identical and then stop
   *  tracking the moment Card A changed. */
  function syncCardToBase() {
    const set = activeSheet;
    if (!cardHasOwn(set)) return;
    commitBurst();
    pushUndo(JSON.stringify(cfg));
    const { [set!.key]: _gone, ...rest } = cardSets;
    cardSets = rest;
    cardBounds = measureCardBounds();
    scheduleCardRedraw();
  }
  let cardStageEl: HTMLDivElement;
  let cardDragKey: CardElKey | null = null;
  let cardSelectedKey: CardElKey | null = null;

  // ── Persistence (auto-save on every change) ──
  // The server stores this as a bounded JSON blob, so it stays deliberately compact: drag values are
  // rounded (see roundBox) rather than carrying fifteen decimal places of pointer noise.
  $: cfg = { headline, headlineTop, headlineBottom, names, stackNames, showBrand, qrPanel, decorItems, textItems, typeSetKey, titleFace, message, stepsText, bgMode, cBg, customBgUrl, printBg, codeDisplay, showFooterUrl, layout, colorsLocked, cHeadline, cMessage, cSteps, cCode, cFooter, cHeadTop, cHeadBottom, cNames,
             cardTitle, cardInkSaver, cardsPerSheet, cardRound, cardCutLines, cardIds, cardSkip, cardShowQr, cardShowLink, cardCaption, paperSize,
             cardCTitle, cardCBody, cardCCode, cardCBg, cardLayout, cardOneDesign, cardSets, cardSheetLandscape, cardLabelPos, cardLabelSize, decorKind, decorPos, decorScale, decorColour };
  // Keep the default text colours readable as the background changes — until the organizer edits a
  // colour (colorsLocked). themeDefaults() reads bgMode/cBg/theme inside a call, which `$:` cannot
  // see, so dep() names them — see $lib/reactive for why a call and not `void x`.
  $: if (!colorsLocked) { dep(bgMode, cBg, theme); ({ cHeadline, cMessage, cSteps, cCode, cFooter } = themeDefaults()); }
  // What the poster's text is actually printed on — an image is always darkened to IMAGE_INK_BG.
  // Written out rather than calling bgSrc() so Svelte sees bgMode/customBgUrl as dependencies.
  $: posterBg = (bgMode === 'custom' ? customBgUrl : bgMode === 'event' ? themeImageUrl : null) ? IMAGE_INK_BG : (cBg || '#ffffff');
  // The colours the poster is DRAWN with. Whatever the host picked, nothing is allowed to vanish
  // into the background — including the join code, which sits on the QR panel's white, not on the
  // poster's background at all, and so used to disappear the moment a light ink was chosen.
  $: ink = {
    headline: readableOn(cHeadline, posterBg),
    message: readableOn(cMessage, posterBg),
    steps: readableOn(cSteps, posterBg),
    footer: readableOn(cFooter, posterBg, INK_BODY),   // the smallest type on the page
    // Against the PANEL when there is one, against the paper when there is not — the code does not
    // move, but what is behind it does, and a colour picked to read on white can vanish on kraft.
    code: readableOn(cCode, qrPanel ? '#ffffff' : posterBg, INK_BODY),
    // Optional by design: `undefined` is not "black", it is "whatever the title is", and the
    // renderer is the one place that resolves it (inkOf). Blank here — which is what a design saved
    // before any of this has — therefore reproduces the old output exactly.
    headlineTop: cHeadTop ? readableOn(cHeadTop, posterBg) : undefined,
    headlineBottom: cHeadBottom ? readableOn(cHeadBottom, posterBg) : undefined,
    names: cNames ? readableOn(cNames, posterBg) : undefined,
  };
  /** Which of the three are set AND differ from the title — the only ones with anything to sync. */
  $: inkOutOfSync = inkSyncTargets(cHeadline, { headTop: cHeadTop, headBottom: cHeadBottom, names: cNames });
  const syncInkToTitle = () => { cHeadTop = ''; cHeadBottom = ''; cNames = ''; };
  /** Does the typed line even have a separator to stack on? No separator, no choice to offer. */
  $: namesCanStack = !!splitNames(names.trim());
  // Ink lighter than the paper it sits on, with the colour left off the print.
  //
  // Ordinary CMYK can only ever DARKEN the stock — there is no white ink in a four-colour process,
  // so light type on dark card is not something a home printer or an ordinary digital press can do.
  // It is entirely possible with white toner, screen printing or foil, which sign shops and print
  // shops have; it just has to be ASKED for, and it costs more. So this is a heads-up, never a
  // block: the design is legitimate and the host may well know exactly where they are taking it.
  //
  // Only meaningful when the colour is standing in for paper. With the background printed, the
  // press lays the colour down itself and any ink on top of it works normally.
  $: lightOnStock = !printBg && bgMode === 'plain'
    && [ink.headline, ink.message, ink.steps, ink.footer].some((c) => lum(c) > lum(cBg) + 12);

  // ── Undo / redo ───────────────────────────────────────────────────────────
  // The editor writes straight to the live design and auto-saves, so a mis-drag or a colour picked
  // by accident is immediately real with nothing to step back to. cfg is already the complete
  // serialisable state, so snapshots are cheap and exact.
  //
  // Granularity is the point: a drag emits a change per frame, and typing one per keystroke, so
  // both are collapsed into ONE step — a drag snapshots at pointerdown, everything else coalesces
  // over a short idle window. Undoing then feels like undoing an action rather than a frame.
  const UNDO_LIMIT = 40;
  let undoStack: string[] = [];
  let redoStack: string[] = [];
  let prevCfg = '';
  let applyingHistory = false;
  let burstBefore: string | null = null;
  let burstTimer: ReturnType<typeof setTimeout> | undefined;

  /** Has the host actually designed anything in this session?
   *
   *  THE gate on persist(), and the reason the export lock used to last 800ms — see
   *  shouldPersistDesign() in $lib/posterFlow. Set here because pushUndo is where every real edit
   *  goes: the direct handlers call it, drags call it at pointerdown, and the coalescing watcher
   *  calls it 450ms into a burst of typing. Nothing else does, which is exactly what makes it the
   *  right signal — a reactive statement firing on mount is not an edit. */
  let designEdited = false;

  function pushUndo(snap: string) {
    if (!snap || snap === undoStack[undoStack.length - 1]) return;
    designEdited = true;
    undoStack = [...undoStack, snap].slice(-UNDO_LIMIT);
    redoStack = [];                       // a new edit forks history
  }
  /** Close the current coalescing window immediately — used at drag start so the drag is one step. */
  function commitBurst() {
    clearTimeout(burstTimer);
    if (burstBefore !== null) { pushUndo(burstBefore); burstBefore = null; }
  }
  function applyCfg(c: Record<string, any>) {
    headline = c.headline; message = c.message; stepsText = c.stepsText;
    headlineTop = c.headlineTop ?? ''; headlineBottom = c.headlineBottom ?? ''; names = c.names ?? '';
    stackNames = c.stackNames ?? true;
    showBrand = c.showBrand ?? true; qrPanel = c.qrPanel ?? true;
    decorItems = Array.isArray(c.decorItems) ? (c.decorItems as DecorPlacement[]).map((d) => ({ ...d })) : [];
    textItems = Array.isArray(c.textItems) ? (c.textItems as PosterTextItem[]).map((t) => ({ ...t })) : [];
    typeSetKey = c.typeSetKey ?? DEFAULT_TYPE_SET; titleFace = c.titleFace ?? 'display';
    if (!typeSet(typeSetKey).script) titleFace = 'display';
    bgMode = c.bgMode; cBg = c.cBg; customBgUrl = c.customBgUrl ?? null; codeDisplay = c.codeDisplay; showFooterUrl = c.showFooterUrl;
    printBg = c.printBg ?? true;   // absent in designs saved before the option existed
    layout = cloneLayout(c.layout);
    colorsLocked = c.colorsLocked;
    cHeadline = c.cHeadline; cMessage = c.cMessage; cSteps = c.cSteps; cCode = c.cCode; cFooter = c.cFooter;
    cHeadTop = c.cHeadTop ?? ''; cHeadBottom = c.cHeadBottom ?? ''; cNames = c.cNames ?? '';
    cardTitle = c.cardTitle; cardInkSaver = c.cardInkSaver;
    cardsPerSheet = c.cardsPerSheet; cardRound = c.cardRound; cardCutLines = c.cardCutLines; cardIds = c.cardIds; cardSkip = [...(c.cardSkip ?? [])];
    paperSize = c.paperSize;
    cardShowQr = c.cardShowQr; cardShowLink = c.cardShowLink; cardCaption = c.cardCaption;
    cardCTitle = c.cardCTitle; cardCBody = c.cardCBody; cardCCode = c.cardCCode; cardCBg = c.cardCBg;
    cardOneDesign = c.cardOneDesign ?? true;
    cardSets = readCardSets(c.cardSets);
    cardSheetLandscape = c.cardSheetLandscape ?? false;
    cardLayout = cloneCardLayout(c.cardLayout);
    cardLabelPos = c.cardLabelPos ?? 'above'; cardLabelSize = c.cardLabelSize ?? CARD_LABEL_PX;
    decorKind = c.decorKind; decorPos = c.decorPos; decorScale = c.decorScale; decorColour = c.decorColour;
  }
  /** Takes a DIRECTION, not the stacks themselves.
   *
   *  It used to take `undoStack`/`redoStack` as arguments, which bound them at CALL time — before
   *  commitBurst() ran. commitBurst() → pushUndo() reassigns undoStack and clears redoStack, so
   *  both were then overwritten by values computed from the stale arrays: type a character and
   *  press undo twice inside the 450ms burst window and it jumped two states back, dropped the
   *  states between, and left Redo walking to a branch abandoned two edits ago. The early
   *  `if (!from.length) return` compounded it by firing before the pending burst was committed,
   *  making the first undo after typing a silent no-op. Commit first, then read what is actually
   *  there. */
  async function step(dir: 'undo' | 'redo') {
    commitBurst();
    const from = dir === 'undo' ? undoStack : redoStack;
    if (!from.length) return;
    const snap = from[from.length - 1];
    const rest = from.slice(0, -1);
    const onto = [...(dir === 'undo' ? redoStack : undoStack), JSON.stringify(cfg)].slice(-UNDO_LIMIT);
    if (dir === 'undo') { undoStack = rest; redoStack = onto; }
    else                { redoStack = rest; undoStack = onto; }
    applyingHistory = true;
    applyCfg(JSON.parse(snap));
    await tick();
    bounds = measureBounds();
    scheduleRedraw();
    prevCfg = JSON.stringify(cfg);
    applyingHistory = false;
    persist();
  }
  const undo = () => step('undo');
  const redo = () => step('redo');

  // Watch the design and open a coalescing window on the first change of a burst.
  $: {
    const cur = JSON.stringify(cfg);
    if (!applyingHistory && prevCfg && cur !== prevCfg) {
      if (dragKey || cardDragKey) {
        // pointerdown already snapshotted; a drag must not add a step per frame
      } else {
        if (burstBefore === null) burstBefore = prevCfg;
        clearTimeout(burstTimer);
        burstTimer = setTimeout(() => { if (burstBefore !== null) { pushUndo(burstBefore); burstBefore = null; } }, 450);
      }
    }
    prevCfg = cur;
  }

  function onKeydown(e: KeyboardEvent) {
    // First, because it is the topmost thing on screen when it is open.
    if (e.key === 'Escape' && fsPage) { e.preventDefault(); e.stopPropagation(); fsPage = null; return; }
    // Escape peels ONE layer at a time, innermost first. The designer had no Escape at all, so the
    // only way out of any of this was finding the right ✕ — and a modal that traps focus and then
    // ignores Escape is a room with the handle on the outside.
    //
    // Order matters: closing the whole designer from inside the front-and-back preview would throw
    // away the panel and the work behind it in one keystroke.
    //
    // The order itself now lives in escapeLayer() in $lib/posterFlow, where it can be tested. It
    // was a ladder of early returns here, which is fine until a layer has to be added in the
    // MIDDLE — which is exactly what a selected element is, and there was nothing to stop the next
    // person slotting it in at the wrong rung.
    if (e.key === 'Escape') {
      switch (escapeLayer({
        binArmed: !!binArmed, restyleArmed, resetArmed,
        editing: editingKey !== null,
        // Either surface's selection: only one tab is on screen, but both hold a key.
        selected: selectedKey !== null || cardSelectedKey !== null,
        fullScreen: fsEdit,
      })) {
        case 'bin': binArmed = null; return;
        case 'restyle': restyleArmed = false; return;
        case 'reset': resetArmed = false; return;
        case 'editor': endEdit(); return;
        case 'selection': releaseSelection(); return;
        case 'fullscreen': fsEdit = false; return;
        default: dispatch('close'); return;
      }
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); void undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); void redo(); }
  }

  // Auto-save the design to the DB (debounced) so it persists across devices.
  //
  // It is driven by `$: if (mounted) { … persist(); }`, which fires ONCE on mount with no host edit
  // behind it — and wrote the whole cfg, layout and all, 800ms later. isSavedDesign() reads a
  // present `layout` as "this is finished work", so opening a gallery preset and closing it on step
  // 1 was enough to make the next open treat an untouched poster as a design and unlock every
  // export on it. The gate lasted 800 milliseconds. shouldPersistDesign() is the rule; `designEdited`
  // is the fact it needs.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  /** A save is armed and has not run yet. onDestroy needs to know, because clearing the timer
   *  without this would throw away the last edit of anyone who closes the designer promptly. */
  let savePending = false;
  /** Why the last save did not land, or null while everything is fine.
   *
   *  Both save paths used to end in `.catch(() => {})`. The autosave is debounced and fires again on
   *  the next edit, so a blip healed itself and nothing looked wrong — but a host who makes their
   *  last change and stops has no next edit. The design silently is not saved, the footer goes on
   *  promising "Changes save automatically", and they find out when they reopen the designer to an
   *  older poster. Swallowing the error is what turns a failed request into lost work.
   *
   *  The server's own message is kept where there is one: the 413 for an over-detailed design says
   *  precisely what to do about it, and "Could not save" instead of that is strictly worse. */
  let saveError: string | null = null;
  let saveRetrying = false;

  async function writeDesign(): Promise<void> {
    if (!orgCode) return;
    try {
      await savePoster(joinCode, orgCode, cfg);
      saveError = null;
    } catch (e) {
      saveError = e instanceof Error && e.message ? e.message : 'Could not save your design';
    }
  }

  /** Try the save again, now. The design in hand is what gets sent — not whatever failed earlier —
   *  so a host who edits after a failure retries the version they can see. */
  async function retrySave() {
    if (saveRetrying) return;
    saveRetrying = true;
    try { await writeDesign(); } finally { saveRetrying = false; }
  }

  function persist() {
    if (!orgCode) return;
    if (!shouldPersistDesign({ hasSavedDesign: hadSavedDesign, edited: designEdited })) return;
    clearTimeout(saveTimer);
    savePending = true;
    saveTimer = setTimeout(() => { savePending = false; void writeDesign(); }, 800);
  }
  /** Close the debounce window: run the pending save now, or drop the timer if there is none.
   *
   *  FLUSHED rather than cancelled, deliberately. The timer leaking past onDestroy is a real fault
   *  — it fires into a dead component and writes whatever cfg the closure captured — but simply
   *  clearing it would lose the last 800ms of work for every host who closes the designer right
   *  after an edit, which is most of them. */
  function flushPersist() {
    clearTimeout(saveTimer);
    saveTimer = undefined;
    if (!savePending) return;
    savePending = false;
    // On the way out there is nobody left to tell, so this one genuinely cannot report — but it goes
    // through the same writer, so it is the only place that swallows rather than every place.
    if (orgCode) void writeDesign();
  }
  function restore() {
    const c = initialConfig;
    if (!c) return;
    headline = (c.headline as string) ?? headline; message = (c.message as string) ?? message; stepsText = (c.stepsText as string) ?? stepsText;
    headlineTop = (c.headlineTop as string) ?? headlineTop; headlineBottom = (c.headlineBottom as string) ?? headlineBottom;
    names = (c.names as string) ?? names;
    stackNames = (c.stackNames as boolean) ?? stackNames;
    showBrand = (c.showBrand as boolean) ?? showBrand;
    qrPanel = (c.qrPanel as boolean) ?? qrPanel;
    // readTextItems() in $lib/posterFlow — moved out of here because this reader silently dropped
    // `colour` for as long as it has existed, and a 3700-line component is nowhere to notice a
    // field that is missing rather than wrong.
    if (Array.isArray(c.textItems)) textItems = readTextItems(c.textItems);
    // Validated element by element: this is a stored blob, and a bad entry here reaches drawDecorAt
    // as NaN coordinates, which paints nothing and looks like the motif silently vanishing.
    if (Array.isArray(c.decorItems)) {
      decorItems = (c.decorItems as unknown[]).flatMap((raw) => {
        const d = raw as Partial<DecorPlacement>;
        const num = (v: unknown, lo: number, hi: number, dflt: number) =>
          typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
        // A logo is not one of DECOR_KINDS — it is the host's own image, not a motif we draw — so it
        // is checked on its own terms: a same-origin uploads path, or it is dropped like any other
        // bad entry. Same rule as customBgUrl; an arbitrary URL is not going in an <img>.
        const isLogo = d.kind === 'logo';
        if (isLogo) {
          if (typeof d.url !== 'string' || !/^\/uploads\/[A-Za-z0-9._/-]+$/.test(d.url)) return [];
        } else if (!DECOR_KINDS.some((k) => k.key === d.kind && k.positional)) return [];
        return [{
          kind: d.kind as DecorKind,
          x: num(d.x, 0, 1, 0.5), y: num(d.y, 0, 1, 0.3),
          scale: num(d.scale, 0.4, 2.2, 1), rot: num(d.rot, -Math.PI, Math.PI, 0),
          colour: typeof d.colour === 'string' ? d.colour : undefined,
          ...(isLogo ? { url: d.url as string, ar: num(d.ar, 0.05, 20, 1) } : {}),
        }];
      });
    }
    // Validated rather than trusted: the blob is stored server-side and an unknown key here would
    // reach ctx.font as a family name that does not exist, which fails silently in Arial.
    if (TYPE_SETS.some((t) => t.key === c.typeSetKey)) typeSetKey = c.typeSetKey as TypeSetKey;
    if (c.titleFace === 'display' || c.titleFace === 'script') titleFace = c.titleFace;
    // A design saved before its pairing lost the script face — or hand-edited — must not reopen in
    // a state the pairing cannot hold. Validated like every other stored field on this path.
    if (!typeSet(typeSetKey).script) titleFace = 'display';
    bgMode = (c.bgMode as typeof bgMode) ?? bgMode; cBg = (c.cBg as string) ?? cBg; codeDisplay = (c.codeDisplay as typeof codeDisplay) ?? codeDisplay; showFooterUrl = (c.showFooterUrl as boolean) ?? showFooterUrl;
    // Same-origin uploads only, like every other stored image path. A design blob is host-written
    // and host-rendered, but "probably fine" is not a reason to put an arbitrary URL in an <img>.
    if (typeof c.customBgUrl === 'string' && /^\/uploads\/[A-Za-z0-9._/-]+$/.test(c.customBgUrl)) customBgUrl = c.customBgUrl;
    // VALIDATED, not spread. Every sibling reader here checks what it restores — readCardSets,
    // readTextItems, the decoration reader above — and this one used to copy the stored blob's
    // values straight onto the live layout. `{"footer":{"size":1e9}}` then hangs the tab inside
    // fitted(), and `{"qr":null}` throws in the `qrTooSmall` reactive block on every mount, which
    // locks the host out of their own design. readPosterLayout() is the same clamp readCardSets
    // has always used, and it guarantees all seven keys, which is what makes `layout.qr.size`
    // safe to read without a guard.
    if (c.layout) layout = readPosterLayout(c.layout);
    // Colours: only restore saved ones once the organizer locked them in by editing. Otherwise
    // keep the theme-derived defaults so the poster keeps tracking the event palette.
    if (c.colorsLocked) {
      colorsLocked = true;
      cHeadline = (c.cHeadline as string) ?? cHeadline; cMessage = (c.cMessage as string) ?? cMessage; cSteps = (c.cSteps as string) ?? cSteps;
      cCode = (c.cCode as string) ?? cCode; cFooter = (c.cFooter as string) ?? cFooter;
    }
    // Outside the colorsLocked gate, deliberately: these are not part of the palette that tracks
    // the event theme — they are exceptions TO it, and an exception a host set by hand has to
    // survive whether or not they also pinned the palette.
    cHeadTop = (c.cHeadTop as string) ?? cHeadTop;
    cHeadBottom = (c.cHeadBottom as string) ?? cHeadBottom;
    cNames = (c.cNames as string) ?? cNames;
    // Card settings are plain overrides — an absent one keeps meaning "follow the poster". Every
    // one of these is read with ?? so a design saved before the setting existed still opens.
    cardTitle = (c.cardTitle as string) ?? cardTitle;
    cardInkSaver = (c.cardInkSaver as boolean) ?? cardInkSaver;
    // Validated on the way in like every other stored field: this is a server-side blob, and an
    // unknown size would reach jsPDF and `@page` as a format neither understands.
    paperSize = readPaperSize(c.paperSize);
    const per = c.cardsPerSheet as number;
    if (per === 1 || per === 2 || per === 4) cardsPerSheet = per;
    cardRound = (c.cardRound as boolean) ?? cardRound; cardIds = (c.cardIds as boolean) ?? cardIds;
    cardCutLines = (c.cardCutLines as boolean) ?? cardCutLines;
    if (Array.isArray(c.cardSkip)) cardSkip = (c.cardSkip as string[]).filter((k) => typeof k === 'string');
    cardShowQr = (c.cardShowQr as boolean) ?? cardShowQr; cardShowLink = (c.cardShowLink as boolean) ?? cardShowLink;
    cardCaption = (c.cardCaption as string) ?? cardCaption;
    cardCTitle = (c.cardCTitle as string) ?? cardCTitle; cardCBody = (c.cardCBody as string) ?? cardCBody;
    cardCCode = (c.cardCCode as string) ?? cardCCode; cardCBg = (c.cardCBg as string) ?? cardCBg;
    // Absent in every design saved before per-card existed, and `?? true` is what makes those open
    // as the one matching set they were designed as. The overrides are validated rather than
    // trusted: this is a stored blob, and a bad entry reaches placeOnCard() as NaN, which draws the
    // title nowhere and reads as the card having lost its heading.
    cardOneDesign = (c.cardOneDesign as boolean) ?? cardOneDesign;
    cardSets = readCardSets(c.cardSets);
    cardSheetLandscape = (c.cardSheetLandscape as boolean) ?? cardSheetLandscape;
    if (c.cardLayout) cardLayout = readCardLayout(c.cardLayout);   // same reader the per-card overrides get
    if (c.cardLabelPos === 'above' || c.cardLabelPos === 'below') cardLabelPos = c.cardLabelPos;
    // Clamped rather than trusted — a stored blob reaching ctx.font as a negative or absurd size
    // draws nothing, which reads as the identifier having silently disappeared.
    if (typeof c.cardLabelSize === 'number' && Number.isFinite(c.cardLabelSize))
      cardLabelSize = Math.min(CARD_LABEL_MAX, Math.max(CARD_LABEL_MIN, c.cardLabelSize));
    // A saved decoration wins over the event-type default; blank still means "let the type decide".
    if (typeof c.decorKind === 'string' && DECOR_KINDS.some((d) => d.key === c.decorKind)) decorKind = c.decorKind as DecorKind;
    if (c.decorPos === 'top' || c.decorPos === 'corners' || c.decorPos === 'both') decorPos = c.decorPos;
    if (typeof c.decorScale === 'number' && c.decorScale > 0) decorScale = c.decorScale;
    decorColour = (c.decorColour as string) ?? decorColour;
    // No demotion any more — a custom background is a real uploaded file, so it is still there.
    // Only fall back if the design somehow names one it does not have.
    if (bgMode === 'custom' && !customBgUrl) bgMode = themeImageUrl ? 'event' : 'plain';
  }

  // ── Image cache (redraws don't re-decode → no flicker) ──
  const imgCache = new Map<string, Promise<HTMLImageElement>>();
  function loadImg(src: string): Promise<HTMLImageElement> {
    let p = imgCache.get(src);
    if (!p) { p = new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; }); imgCache.set(src, p); }
    return p;
  }

  /** Hand `fn` a canvas showing what will actually be printed, then put the preview back. */
  async function asPrinted(fn: () => void | Promise<void>): Promise<void> {
    const swap = !printBg && bgMode === 'plain';
    if (swap) { renderingForPrint = true; await draw(); }
    try { await fn(); }
    finally { if (swap) { renderingForPrint = false; void draw(); } }
  }
  const bgSrc = () => bgMode === 'custom' ? customBgUrl : bgMode === 'event' ? themeImageUrl : null;

  /** Everything drawPoster needs, in one place.
   *
   *  Factored out because the front-and-back preview renders the poster a SECOND time, at full page
   *  size on its own canvas — and a second copy of this list is a second poster that drifts from the
   *  first. One definition, two canvases. */
  const posterOpts = () => ({
      headline, headlineTop, headlineBottom, names, stackNames, showBrand, qrPanel, decorItems,
      // A line's own colour still has to be READABLE on the paper it lands on, the same pass every
      // other poster colour goes through. Left off when it has none, so the renderer's own fallback
      // to the message ink is what happens rather than a pre-resolved copy of it.
      textItems: textItems.map((t) => (t.colour ? { ...t, colour: readableOn(t.colour, posterBg) } : t)),
      typeSet: typeSetKey, titleFace,
      message, stepsText, cleanUrl, joinCode, codeDisplay, showFooterUrl, layout, ink,
      // The poster carries the same decoration the cards do. It did not before, which is why a
      // design preset could only ever change colours.
      //
      // `decorKind`, NOT `decorUsed`. decorUsed falls back to a motif chosen from the event type,
      // which is right for cards (they have always been decorated) and wrong here: every poster
      // ever saved has an empty decorKind, so using the fallback would put a decoration on all of
      // them retrospectively. Only an explicit choice draws.
      //
      // The colour is passed raw for the same reason — decorInk falls back to the CARD's title ink,
      // which is a different design. drawPoster falls back to the poster's own headline ink.
      decorKind, decorPos, decorScale, decorColour,
      qrSrc: qrImg, bgSrc: bgSrc(),
      // See printBg: with it off the colour is the PAPER, so it is drawn while designing and left off
      // what prints. The ink is deliberately NOT recomputed — it was chosen to read on that colour,
      // and the real stock is that colour, so the print matches the preview once it is on the card.
      plainBg: renderingForPrint ? '#ffffff' : (cBg || '#ffffff'),
      // Our cache, not the renderer's: a redraw must not re-decode the background or the preview
      // flickers mid-drag, and onBgCropped has to be able to evict a replaced blob URL.
      loadImage: loadImg,
    });

  // ── How big the preview canvas actually is ─────────────────────────────────
  // The page is 1080x1527 and the canvas used to be exactly that, whatever it was DISPLAYED at.
  // Inside the sheet that is 288-320 CSS px, so even a 2x screen gets a comfortably oversampled
  // poster and there was never anything wrong there. Full-screen (⛶ Arrange) is the case that
  // was short: measured at 587 CSS px on a 1280x1000 stage, which on a 2x display is 1174 device
  // pixels of screen showing 1080 pixels of poster, and it gets worse the bigger the screen. The
  // type, the QR and the line art were being upscaled at the one moment the host is looking closely
  // at where things sit.
  //
  // So the backing store follows the display: clientWidth x dpr, never below the page's own 1080
  // (the exports read this same canvas and must not lose resolution) and capped at twice it. The
  // cap is about cost, not fidelity — everything but the background photo is drawn from vectors and
  // fonts and is genuinely sharper at any size — but 2160x3054 is already a ~26MB buffer.
  const PREVIEW_MAX_W = PAGE_W * 2;
  /** The width the canvas was last actually painted at, so a resize that changes nothing costs
   *  nothing and a canvas resize cannot chase its own tail (the backing store sets the intrinsic
   *  ratio, and the CSS height is `auto`). */
  let drawnW = 0;
  function previewWidth(): number {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    // The WRAP's width, not the canvas's: the canvas is `width: 100%` of it, so asking the canvas
    // after we have just resized its backing store is asking it what we told it.
    const cssW = canvas?.parentElement?.clientWidth ?? 0;
    return Math.max(PAGE_W, Math.min(PREVIEW_MAX_W, Math.round(cssW * dpr)));
  }

  async function draw() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    const pw = previewWidth();
    drawnW = pw;
    canvas.width = pw; canvas.height = Math.round((pw / PAGE_W) * PAGE_H);
    // After the resize, which resets the transform. drawPoster paints in page space and never
    // touches the transform itself — that is exactly what lets the wizard's thumbnails scale the
    // same drawing down, and it is what lets this scale it up.
    const ps = pw / PAGE_W;
    ctx.setTransform(ps, 0, 0, ps, 0, 0);
    const { backgroundImage } = await drawPoster(ctx, posterOpts());
    // The two things the renderer deliberately does not do, because a wizard thumbnail must not do
    // them: sample the background for the swatch strip, and drop the "building poster" spinner.
    // Both still only happen on a successful paint — drawPoster rejecting leaves the spinner up.
    if (backgroundImage) extractPalette(backgroundImage);
    busy = false;
  }

  // ── Drag + resize the elements directly on the preview ──────────────────────
  let stageEl: HTMLDivElement;
  let dragKey: string | null = null;
  let selectedKey: string | null = null;   // tap-to-select → reveals that element's outline + controls
  /** Which element's bin is armed, or null. A KEY rather than a boolean, so selecting a different
   *  element disarms the one that was armed rather than leaving a second element's bin hot.
   *
   *  Armed-then-confirmed, like "Start again" and "Reset layout", and disarmed by the same two
   *  things: a click anywhere else (the svelte:window handler) and Escape. It differs from those
   *  two only in how it SAYS it is armed — they swap their label to "⚠ Sure?", and there is no room
   *  for a word in a 44px chip, so this one goes red instead. The owner asked for exactly that.
   *
   *  Undo is still underneath it: every bin pushes an undo step before it mutates anything, so a
   *  confirmed bin is one press of ⟲ away from coming back. The confirm is the primary guard and
   *  undo is the net, not the other way round. */
  let binArmed: string | null = null;
  // Selecting something else, letting go, or changing tab all take the arm with them — the same
  // three things that disarm the reset confirm, for the same reason: an armed control that now
  // points at a different element is worse than one that forgot. Every dependency is named
  // syntactically, because `$:` does not see state read inside a called function.
  $: { dep(selectedKey, cardSelectedKey, view); binArmed = null; }
  let fsEdit = false;                  // full-screen layout mode (bigger stage = easier dragging)
  // QR sizing limits, in 1080-wide canvas px. The poster is A4 (210mm wide) so px·0.194 ≈ mm.
  // Below the floor the code + centre logo stops scanning reliably; below the warn line we caution.
  const QR_MIN_PX = 170;               // ≈ 33mm printed on A4 — hard floor
  const QR_WARN_PX = 230;              // ≈ 45mm — warn below this
  $: qrTooSmall = layout.qr.size < QR_WARN_PX;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  // ── Touch feel ─────────────────────────────────────────────────────────────
  // The stage is a THUMBNAIL of the page. Measured: 316 CSS px wide on a 390px phone and 286 on a
  // 360px one, for a 1080px-wide design space — so ONE finger-pixel is 3.42 design pixels, 3.78 at
  // 360px. A move is still 1:1 on SCREEN (the element must stay under the finger, and that is not
  // negotiable), but everything DERIVED from that delta carries the multiplier:
  //   · the 2px of jitter in an ordinary tap used to shift an element 6.8–7.6 design px, i.e. the
  //     act of SELECTING something moved it;
  //   · a 20px flick of the resize grip changed `size` by 68–76 px, which for a text element
  //     (limits 16–170) is 44–49% of its entire range in one nudge.
  // Hence: a dead zone before a drag counts as a drag, and a gain on touch resizes. The mouse keeps
  // a 2px dead zone — under the browser's own click slop, so desktop drags feel exactly as before —
  // and full resize gain, because a mouse has the precision the multiplier assumes.
  const DEAD_TOUCH = 6, DEAD_MOUSE = 2;
  const TOUCH_RESIZE_GAIN = 0.45;
  // Alignment-snap threshold, in SCREEN pixels and converted per-surface at drag time. A constant
  // in design space cannot work — it would be worth 7px of finger travel on this 316px thumbnail
  // and a fraction of that on the full-screen ⛶ Arrange stage, so the same design would snap
  // differently depending only on how big the preview happened to be. 7 screen px measured out as
  // 24 design px at 390 and 26 at 360.
  const SNAP_PX = 7;
  $: elements = ([
    // Resizable like everything else. It never was, and there was no reason left for it: the
    // renderer has always drawn the mark at `layout.brand.size` (brandFont), the generic limits give
    // it the same 16–170px range as any other line, and `size` writes through the same path. All
    // that withheld it was this flag, so a host who wanted the logo smaller had no way to say so.
    // It keeps `lockY` — the mark still slides along its line rather than moving freely.
    { key: 'brand', label: 'Logo', show: showBrand, resizable: true, axis: 'x' },
    { key: 'title', label: 'Title', show: true, resizable: true, axis: 'xy' },
    { key: 'message', label: 'Message', show: !!message.trim(), resizable: true, axis: 'xy' },
    { key: 'steps', label: 'How-to', show: !!stepsText.trim(), resizable: true, axis: 'xy' },
    { key: 'qr', label: 'QR', show: true, resizable: true, axis: 'xy' },
    { key: 'names', label: 'Names', show: !!names.trim(), resizable: true, axis: 'xy' },
    { key: 'footer', label: 'Link', show: showFooterUrl, resizable: true, axis: 'xy' },
  ] as { key: ElKey; label: string; show: boolean; resizable: boolean; axis: 'x' | 'xy' }[]).filter((e) => e.show);

  // ── Live size outlines ─────────────────────────────────────────────────────
  // Measure each element's true rendered footprint (text wrapping + QR panel) so the preview can
  // draw a box showing exactly how big it will be — updated live as you drag the resize corner.
  type Rect = { x: number; y: number; w: number; h: number };
  let mctx: CanvasRenderingContext2D | null = null;
  function measureCtx(): CanvasRenderingContext2D | null {
    if (!mctx) mctx = document.createElement('canvas').getContext('2d');
    return mctx;
  }
  // Whether the bundled faces have actually arrived.
  //
  // ctx.font falls back to Arial WITHOUT ERROR (see posterFonts), so measuring before they land
  // reports Arial metrics for a poster that will be set in Jost — the same class of wrong answer
  // as the Helvetica guess these outlines used to make. onMount warms every face and flips this,
  // and it is named in the
  // `bounds` assignment below so the outlines are recomputed the moment it does.
  let fontsReady = false;
  // The message and the how-to line, asked for rather than guessed at.
  //
  // This used to measure them here, in Helvetica at the box's own size with no tracking and no
  // casing — while the renderer set them in the host's chosen BODY face, which is tracked (up to
  // 0.14em), usually upper-cased, scaled (0.90–1.06) and on its own line height (up to 1.45). So
  // the outline fitted the text in `plain` and nowhere else. Measured on the bundled faces: the
  // how-to outline came out 221px narrower than its own text in Editorial, and the message wrapped
  // to two lines here while the renderer drew three.
  //
  // The same reasoning as the title below, and the same fix: one owner of glyph geometry.
  /** A measured footprint, turned the way the element is actually drawn.
   *
   *  ONE line at the end of every bounds function, and it is rotatedRect() from the renderer rather
   *  than four corners worked out here. The renderer owns element geometry — see DEVELOPMENT.md,
   *  where the rule is written down after the third time this component kept its own guess and the
   *  how-to outline came out 221px narrower than its own text. A rotation derived here would be the
   *  fourth, and it would be worse: the outline would be visibly beside the words rather than
   *  merely the wrong width.
   *
   *  The anchor is the element's own centre in page px — exactly the point drawPoster turns about
   *  (see `rotated()`), which for the footer is NOT the middle of its rect. */
  // Takes the anchor structurally rather than as a `Box`: a host's own line and a placed motif
  // are anchored the same way and neither is one.
  const turned = (a: { x: number; y: number; rot?: number }, r: Rect): Rect =>
    rotatedRect(r, a.rot, a.x * W, a.y * H);
  function bodyBounds(ctx: CanvasRenderingContext2D, which: 'message' | 'steps', text: string, box: Box): Rect {
    const { w, h } = measureBodyBlock(ctx, { typeSet: typeSetKey }, which, text, box);
    return turned(box, { x: box.x * W - w / 2, y: box.y * H - h / 2, w, h });
  }
  // The title is the one element whose footprint the renderer alone knows how to work out — it can
  // be three rows in two faces at two sizes. Ask it, rather than keeping a second guess here.
  function titleBounds(ctx: CanvasRenderingContext2D, box: Box): Rect {
    const { w, h } = measureTitleBlock(ctx, { headline, headlineTop, headlineBottom, typeSet: typeSetKey, titleFace }, box);
    return turned(box, { x: box.x * W - w / 2, y: box.y * H - h / 2, w, h });
  }
  // Like the title, the lockup is several rows in two faces — and its hairlines stick out past the
  // joiner, so only the renderer knows how wide it really is.
  function namesBounds(ctx: CanvasRenderingContext2D, box: Box): Rect {
    // stackNames travels with it: an outline measured as a three-row lockup around a line drawn
    // as one row is a drag handle that does not sit on the thing it moves.
    const { w, h } = measureNames(ctx, { headline, headlineTop, headlineBottom, names, stackNames, typeSet: typeSetKey, titleFace }, box);
    return turned(box, { x: box.x * W - w / 2, y: box.y * H - h / 2, w, h });
  }
  function footerBounds(ctx: CanvasRenderingContext2D, box: Box): Rect {
    // The renderer's own number, not a second copy of it: the URL gives way to the mark when the
    // two share the footer line, it shrinks to fit, and a long one splits onto a second line at
    // 0.82 of the size. This used to re-derive all three of those here and got the last two wrong.
    //
    // Anchored at the top of the FIRST line, because that is where the URL's middle baseline puts
    // it; measureFooterUrl's height is measured from the same place.
    const { w, h } = measureFooterUrl(ctx, cleanUrl, layout, showBrand);
    return turned(box, { x: box.x * W - w / 2, y: box.y * H - box.size / 2, w, h });
  }
  // The renderer owns this geometry; asking it is what keeps the drag outline on the panel it is
  // supposed to be outlining.
  const qrBounds = (box: Box): Rect => qrPanelRect(box, codeDisplay);
  function brandBounds(ctx: CanvasRenderingContext2D): Rect {
    const w = brandFont(ctx, layout.brand.size), h = layout.brand.size * 1.2;
    return { x: layout.brand.x * W - w / 2, y: layout.brand.y * H - h / 2, w, h };
  }
  const ZERO_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };
  function measureBounds(): Record<ElKey, Rect> {
    const ctx = measureCtx();
    if (!ctx) return { brand: ZERO_RECT, title: ZERO_RECT, message: ZERO_RECT, steps: ZERO_RECT, qr: ZERO_RECT, footer: ZERO_RECT, names: ZERO_RECT };
    return {
      brand: brandBounds(ctx),
      title: titleBounds(ctx, layout.title),
      message: bodyBounds(ctx, 'message', message || ' ', layout.message),
      steps: bodyBounds(ctx, 'steps', stepsText || ' ', layout.steps),
      qr: qrBounds(layout.qr),
      names: namesBounds(ctx, layout.names),
      footer: footerBounds(ctx, layout.footer),
    };
  }
  // Recompute whenever anything that affects a footprint changes. Each dependency is named through
  // dep() so Svelte tracks them reliably — text content, the QR's code/URL toggle and footer
  // visibility all change an element's measured size.
  // `cleanUrl` among them: footerBounds() measures the printed URL, and loadPosterQr() swaps the
  // server's canonical one in after mount. Without it the footer DRAWS right but its hit rect keeps
  // the pre-swap width, so the grab area and the print disagree.
  let bounds: Record<ElKey, Rect> = measureBounds();
  $: bounds = (dep(layout, headline, headlineTop, headlineBottom, names, stackNames, showBrand, qrPanel, typeSetKey, titleFace, message, stepsText, codeDisplay, showFooterUrl, cleanUrl, mounted, fontsReady), measureBounds());
  // A motif's footprint is a square around its anchor — the drawings are roughly as tall as they are
  // wide, and an exact hull would need every motif to measure itself. A square is honest enough to
  // grab and to keep inside the print margin, which is all the rect is used for.
  $: textRects = (() => {
    dep(fontsReady);                       // Arial metrics until the faces land; see measureCtx.
    const ctx = measureCtx();
    if (!ctx) return {} as Record<string, Rect>;
    return Object.fromEntries(textItems.map((t, i) => {
      const { w, h } = measureTextItem(ctx, { typeSet: typeSetKey }, t);
      return [`text:${i}`, turned(t, { x: t.x * W - w / 2, y: t.y * H - h / 2, w, h })];
    })) as Record<string, Rect>;
  })();
  $: decorRects = Object.fromEntries(decorItems.map((it, i) => {
    // A logo is not square and must not be grabbed as though it were: a wordmark in a square box
    // has most of its handle over empty paper, and the bit you can actually see is a thin strip in
    // the middle. Same width rule as the renderer (0.22 of the short edge), height from its aspect.
    if (it.kind === 'logo') {
      const w = Math.min(W, H) * 0.22 * Math.max(0.4, Math.min(2.2, it.scale || 1));
      const h = w / (it.ar && it.ar > 0 ? it.ar : 1);
      return [`decor:${i}`, turned(it, { x: it.x * W - w / 2, y: it.y * H - h / 2, w, h })];
    }
    const side = Math.min(it.scale * DECOR_PX, Math.min(W, H) * 0.34);
    // Turned like everything else now. The motif has rotated since it was added and its box never
    // did, so a sprig at 45° was grabbed by a square sitting squarely beside it.
    return [`decor:${i}`, turned(it, { x: it.x * W - side / 2, y: it.y * H - side / 2, w: side, h: side })];
  })) as Record<string, Rect>;
  // Every footprint on the poster stage under one key space — what the drag surface has always
  // handed around, and now what the markup needs too: the inline editor and the control cluster can
  // both be anchored to a host's own line, not only to a fixture in `bounds`.
  //
  // A function AND a reactive value, deliberately. The drag reads it synchronously, several times
  // inside one pointermove and straight after reassigning `bounds`, where a `$:` value has not been
  // recomputed yet; the markup needs a tracked value it can re-render from. Same single expression
  // behind both, so they cannot disagree.
  const posterRects = (): Record<string, Rect> => ({ ...bounds, ...decorRects, ...textRects });
  $: allRects = (dep(bounds, decorRects, textRects), posterRects());

  // ── Can this paper carry the code without its panel? ──
  // Measured, not assumed. Symbol Contrast is Rmax − Rmin in reflectance, and grade C (40) is the
  // lowest a code is expected to read reliably in the wild — which is what this is: read once, in
  // bad light, by a stranger holding a phone at an angle.
  //
  // A photographic background is NOT measurable this way — the code could land on a bright sky or a
  // dark suit depending on where the host drags it — so the panel stays put over an image, full stop.
  $: qrOverImage = bgMode !== 'plain';
  $: qrSC = symbolContrast(posterBg);
  $: qrSafe = !qrOverImage && panelOptional(posterBg);
  // A design saved on one background and reopened on another must not silently ship an unreadable
  // code, so the panel comes back on its own rather than waiting to be noticed.
  $: if (!qrPanel && !qrSafe) qrPanel = true;

  // A draggable surface: the poster page, or one card on the sheet. Everything the drag needs that
  // differs between the two lives here, so there is ONE drag implementation rather than a card copy
  // of the poster's that drifts away from it.
  type Surface = {
    stage: () => HTMLElement | undefined;
    w: number; h: number;                              // the surface's design-space size
    /** Print-safe inset, in the same design space. Nothing may be dragged inside it. */
    pad?: number;
    rects: () => Record<string, Rect>;                 // measured footprints, in that same space
    box: (key: string) => Box;                         // the stored position/size being dragged
    limits: (key: string) => [number, number];         // size clamp for a resize
    lockY?: (key: string) => boolean;
    /** The mirror of lockY. The trick list says yes: it spans the full printable width, so there is
     *  no room either side for a sideways drag to move it into — only up and down mean anything. */
    lockX?: (key: string) => boolean;
    /** Can this element be dragged at all? Default yes. */
    movable?: (key: string) => boolean;
    /** Can this element be scaled at all? A pinch has no grip to hide behind, so it has to ask. */
    resizable?: (key: string) => boolean;
    /** ...and can it be turned? Absent means "nothing on this surface rotates", which is the card
     *  sheet's answer: every card on it is cut to a rectangle and printed in a grid. */
    rotatable?: (key: string) => boolean;
    move: (key: string, x: number, y: number) => void;
    size: (key: string, px: number) => void;
    /** In RADIANS, the same unit the stored `rot` is in. A surface with no rotation omits it. */
    rotate?: (key: string, rot: number) => void;
    remeasure: () => void;
    redraw: () => void;
    select: (key: string | null) => void;
    /** What is selected right now. A pinch has to know, because the gesture that starts it also
     *  changes it. */
    selected: () => string | null;
    dragging: (key: string | null) => void;
  };
  const selectedOn = (surf: Surface) => surf.selected();
  // Drag values are saved, and the saved design is a bounded blob: four decimals is well under a
  // printed pixel and keeps a dragged layout from bloating the record with pointer noise.
  // Set on pointerup when the gesture moved nothing. Read by the click that follows, and only by it.
  let tapped = false;
  /** What was selected BEFORE the gesture that just ended — also read only by the click that
   *  follows. It is what tells a FIRST tap on an element from a second one: selection happens at
   *  pointerdown, so by click time the element is selected either way, and without this every tap
   *  would look like a second press and open the editor — which is the behaviour we are removing. */
  let tapHeld: string | null = null;
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
  const r1 = (n: number) => Math.round(n * 10) / 10;

  // ── Alignment guides ───────────────────────────────────────────────────────
  // The line currently being honoured, as a fraction of the surface being dragged on (0–1), or null
  // for "this axis isn't snapping". Only ever ONE of each: PowerPoint shows the lines in play, not
  // every line it could have used, and on a 316px stage a fan of candidates is just noise.
  // Both stages read these; only one surface can be mid-drag, and pointerup clears them.
  let snapX: number | null = null;
  let snapY: number | null = null;
  const clearGuides = () => { snapX = null; snapY = null; };
  /**
   * The nearest alignment on one axis, or null. `raw` is the proposed CENTRE in design px, `half`
   * the element's half-extent on that axis, `lines` every candidate line from the other elements
   * (their leading edge, centre and trailing edge), `pageMid` the page's own midline.
   *
   * Returns the delta to ADD to `raw`, plus the line it landed on, so the caller can draw it.
   *
   * There is deliberately NO hysteresis: every frame recomputes from the raw pointer position, so
   * dragging on past the threshold simply stops matching and the element escapes under the finger.
   * A snap you have to fight your way out of is worse than no snap at all.
   */
  function snapAxis(raw: number, half: number, lines: number[], pageMid: number, thr: number): { d: number; line: number } | null {
    let best: { d: number; line: number } | null = null;
    const take = (line: number, ref: number) => {
      const d = line - ref;
      if (Math.abs(d) <= thr && (best === null || Math.abs(d) < Math.abs(best.d))) best = { d, line };
    };
    // Page midline pairs with our CENTRE only. An element's left edge sitting on the page's centre
    // line is a coincidence, not an alignment, and offering it would fight the centre-to-centre snap
    // that people actually want.
    take(pageMid, raw);
    for (const line of lines) {
      take(line, raw - half);   // our leading edge on theirs
      take(line, raw);          // centre to centre
      take(line, raw + half);   // our trailing edge on theirs
    }
    return best;
  }

  /* The last press that exclusive selection turned away, and when.
     A second press on the SAME element within the window is not someone fumbling — it is someone
     insisting, so it switches rather than refusing again. That is the whole "double-tap to swap"
     gesture, and it costs one timestamp. The hint toast that teaches it is fired from the pointer
     UP of a refused tap, never from the press itself: the first finger of a pinch routinely lands
     on some other element's box, and toasting there would fire on nearly every pinch. */
  let lastRefused: { key: string; at: number } | null = null;
  const REFUSE_SWITCH_MS = 900;

  /** A pinch that started on BLANK stage, not on an element.
   *
   *  The gesture core can only be entered from an element's own box, so a pinch had to begin inside
   *  the thing it was scaling. That is fine for a title and useless for anything small or awkwardly
   *  shaped — the trick list especially, where the region you are allowed to start in is not the
   *  region you are trying to resize. Everywhere else a pinch means "scale what I am working on",
   *  wherever the fingers land.
   *
   *  Runs only when something is already selected, so it scales the thing the host chose rather than
   *  guessing. It never moves or selects anything: `pinchOnly` holds the press to the same rules as
   *  a refused one, which is exactly what is wanted here — the press is not claiming an element,
   *  it is only carrying a second finger. */
  function startStagePinch(surf: Surface, e: PointerEvent) {
    if (e.pointerType !== 'touch') return;      // a mouse has no second finger
    /* BLANK stage only — the stage's children include the selected element's control cluster, and
       this handler sits on their way up.
       Element boxes stop propagation themselves, so they were never the problem; the cog, bin, ✕
       and pencil are plain buttons that do not, so every press on one started a pinch gesture over
       the top of it. dragOn calls preventDefault() at pointerdown, which suppresses the click that
       would have followed — so the cog stopped scrolling to its section — and the gesture then
       ended with no drag and no pinch, which is exactly the shape of a refused tap, so it also
       fired the double-tap hint on the way out.
       A canvas counts as blank: whether the paper is painted into the stage or sits behind it as a
       sibling, a press on the picture itself is a press on nothing in particular. */
    const t = e.target as Element | null;
    if (t !== surf.stage() && t?.tagName !== 'CANVAS') return;
    const sel = selectedOn(surf);
    // Only presses that hit no element box get here: dragOn stops propagation, so an element's own
    // handler has already claimed anything that landed on one.
    if (!sel || !(surf.resizable?.(sel) ?? true)) return;
    // One at a time. The second finger of a pinch lands on blank stage as well, and without this it
    // starts a second, redundant gesture — its own pointer capture, its own capture-phase listener —
    // over the top of the one already running the pinch.
    if ((surf === cardSurface ? cardDragKey : dragKey) !== null) return;
    dragOn(surf, sel, 'move', e, true);
  }

  function dragOn(surf: Surface, key: string, mode: 'move' | 'resize' | 'rotate', e: PointerEvent,
                  pinchOnly = false) {
    e.stopPropagation();
    const stage = surf.stage(); if (!stage) return;
    // What was selected BEFORE this gesture touched anything. Two things need it: the pinch (see
    // onDown) and exclusive selection, immediately below.
    const wasSelected = selectedOn(surf);
    // ── Exclusive selection ────────────────────────────────────────────────
    // While one element is selected, a press on ANOTHER one may not take it over — the only ways
    // out of a selection are that element's own ✕ and Escape. pressRole() in $lib/posterFlow holds
    // the rule and says why a refused press still has to RUN: it is the only place a two-finger
    // pinch of the held element can start from, on a stage almost entirely covered by other
    // elements' boxes. So the gesture proceeds, and simply never selects or moves what it landed on.
    // A stage pinch is never a claim on anything: same standing as a refused press, which is the
    // one path built to carry a pinch without taking or moving what it landed on.
    const role = pinchOnly ? 'pinch' : pressRole(wasSelected, key);
    if (role === 'take') lastRefused = null;
    // ── Undo: armed here, pushed at the first real mutation ────────────────
    // This used to push unconditionally at pointerdown. That was already wrong — a tap that merely
    // selected something added a no-op undo step and set `designEdited`, the flag that unlocks
    // persist() and every export on a poster nobody had edited — and the new model makes it wrong
    // on EVERY selection tap rather than only on the ones that opened the editor.
    //
    // The snapshot is still taken at pointerdown (cfg cannot change between here and the first
    // move without a mutation, and a mutation is what pushes it), so a whole drag is still exactly
    // one undo step. It is simply not recorded until something actually changes.
    const snap0 = JSON.stringify(cfg);
    let undoPushed = false;
    const armUndo = () => {
      if (undoPushed) return;
      undoPushed = true;
      commitBurst();                 // close any open typing burst first: it is the OLDER state
      pushUndo(snap0);
    };
    // `dragging` regardless of role: it is gesture state, not selection, and it is what puts
    // `touch-action: none` on the stage — which has to be in force BEFORE the second finger lands
    // or the browser claims the pinch as a page zoom (see .poster-stage.dragging).
    // The KEY the gesture is really about, which on a refused press is the held element, not the
    // one under the finger. Passing the pressed key lit that element up — `.el-box.active` — so
    // pressing around a selected element while pinching flashed boxes that could not be picked up:
    // a highlight promising something the press was never allowed to do. The stage still gets its
    // `dragging` state either way, which is what holds `touch-action: none` before finger two.
    /* ── Select first, THEN move ────────────────────────────────────────────
       A finger that lands on an element used to take it immediately: selected at pointerdown,
       `touch-action: none` applied in the same breath, and from then on the gesture could only be a
       drag. So a host scrolling the panel with a swipe that happened to start on the QR did not
       scroll — they moved the QR, and the page stayed put. The stage is most of the screen, and
       almost all of it is covered by something, so there was often nowhere safe to put the finger.
       On a touch screen the first press now only SELECTS, and it does that at the release rather
       than the press, so a swipe that started on an element is still a swipe: nothing is selected,
       nothing gets `touch-action: none`, and the browser scrolls it as it always would. Press again
       on the thing you just selected and it moves, which is the second half of what was asked for —
       "first click into an element, and then move".
       A mouse is left exactly as it was. There is no scroll to compete with, dragging straight off
       a click is the faster thing on a desktop, and nothing about this was ever a mouse problem.
       Grips are unaffected in both: a resize or rotate handle only exists on something already
       selected, so it is already past this gate. */
    const armed = wasSelected === key;
    // e.pointerType rather than the `touch` const below, which is not declared until after the
    // press has already had to decide whether to claim the gesture.
    const selectOnly = e.pointerType === 'touch' && mode === 'move' && role === 'take' && !armed;
    // preventDefault is what stops the press becoming a click/scroll candidate, so a select-only
    // press must not call it. It is NOT what blocks scrolling — `touch-action` alone does that, via
    // the `dragging` state below, which is exactly why that is skipped too.
    if (!selectOnly) {
      e.preventDefault();
      surf.dragging(role === 'take' ? key : wasSelected ?? key);
      if (role === 'take') surf.select(key);
    }
    /** Did a select-only press travel far enough to have been a scroll rather than a tap? */
    let movedFar = false;
    const rect = stage.getBoundingClientRect();
    // Rebased when the dead zone is crossed, so engaging a drag never jumps the element by the slop
    // that got it there — the element picks up exactly where the finger committed.
    let start = { x: e.clientX, y: e.clientY };
    const box0 = { ...surf.box(key) };
    // ── Where a rotate drag is measured from ───────────────────────────────
    // The element's own ANCHOR — the point drawPoster turns it about — in client coordinates, and
    // the angle the finger stood at when it grabbed the handle. Everything after is the difference
    // between those two, added to the angle it was already at, so the element does not jump to
    // wherever the handle happens to be at the moment it is touched.
    const anchor = { x: rect.left + box0.x * rect.width, y: rect.top + box0.y * rect.height };
    const angle0 = Math.atan2(e.clientY - anchor.y, e.clientX - anchor.x);
    const rot0 = box0.rot ?? 0;
    const touch = e.pointerType === 'touch';
    const deadZone = touch ? DEAD_TOUCH : DEAD_MOUSE;
    let live = false;
    // Live touch points, so a second finger can turn this into a pinch-resize. Keyed by pointerId
    // because a touch's coordinates only ever arrive on ITS OWN move events — there is no single
    // event carrying both fingers.
    const pts = new Map<number, { x: number; y: number }>([[e.pointerId, { x: e.clientX, y: e.clientY }]]);
    let pinch: { d0: number; size0: number } | null = null;
    // Which element the pinch is actually sizing. Usually the one under the first finger — but not
    // when something was already selected. See onDown.
    let pinchKey = key;
    (e.target as Element).setPointerCapture?.(e.pointerId);

    // A second finger ANYWHERE turns the gesture into a pinch — it does not have to land on the
    // element, which on a phone would mean pinching a 30px-tall strip of text. Capture phase,
    // because it may land on another element whose own handler stops the event.
    const onDown = (ev: PointerEvent) => {
      if (pinch || ev.pointerType !== 'touch') return;
      // Nothing is selected yet, so there is nothing a pinch could be about — and setting one up
      // would need `touch-action: none`, which this press deliberately did not take. Select first.
      if (selectOnly) return;
      // The element a pinch sizes is the SELECTED one, not whatever happened to be under the first
      // finger. Selecting a thing and then pinching it is the whole gesture — but the first finger
      // of that pinch lands somewhere on the page, hit-tests to whichever element box is under it,
      // and used to make that the target. So you would select the title, pinch, and watch the
      // message resize: it zoomed "other things I've touched" rather than the thing I chose.
      //
      // Only when the previous selection can actually be resized; otherwise fall back to the
      // element under the finger, which is the old behaviour and still the right one when nothing
      // was selected at all.
      if (wasSelected && wasSelected !== key && (surf.resizable?.(wasSelected) ?? true)) {
        pinchKey = wasSelected;
        surf.select(pinchKey); surf.dragging(pinchKey);
      } else if (role === 'pinch' && !pinchOnly) {
        // Something IS selected, but it cannot be scaled. Falling through here would pinch whatever
        // the first finger happened to land on — precisely the "it zoomed other things I've
        // touched" bug, and now also a breach of exclusive selection.
        //
        // Not for a stage pinch: there `key` IS the selected element (startStagePinch passes it),
        // so pinchKey is already right and there is nothing to fall through TO.
        return;
      }
      if (!(surf.resizable?.(pinchKey) ?? true)) return;
      if (pts.size >= 2) return;
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      const [a, c] = [...pts.values()];
      const d0 = Math.hypot(a.x - c.x, a.y - c.y);
      if (d0 < 1) { pts.delete(ev.pointerId); return; }   // two fingers on one spot: no scale to read
      // From the CURRENT size, not box0 — the first finger may already have resized it.
      pinch = { d0, size0: surf.box(pinchKey).size };
      /* Put back whatever the first finger dragged on its way here. Two fingers never land
         together: in the moment before the second arrives, the first has usually travelled past
         the dead zone and taken the element with it, so every pinch began by nudging the thing
         sideways. A pinch is a scale — it should leave the position exactly where it found it. */
      if (live && pinchKey === key && mode === 'move') surf.move(key, box0.x, box0.y);
      live = false;
      clearGuides();
      ev.preventDefault();
    };
    const onMove = (ev: PointerEvent) => {
      const p = pts.get(ev.pointerId);
      if (p) { p.x = ev.clientX; p.y = ev.clientY; }
      if (pinch) {
        if (pts.size < 2) return;
        const [a, c] = [...pts.values()];
        const d = Math.hypot(a.x - c.x, a.y - c.y);
        const [lo, hi] = surf.limits(pinchKey);
        // Multiplicative, so the element scales with the gap between the fingers exactly as a photo
        // would. limits() still has the last word — that is what keeps the QR above its
        // scannable floor no matter how hard someone pinches.
        armUndo();
        surf.size(pinchKey, r1(clamp(pinch.size0 * (d / pinch.d0), lo, hi)));
      } else {
        if (selectOnly) {
          // Watching only, so the release can tell a tap from a swipe. Moving nothing is the point.
          if (ev.pointerId === e.pointerId &&
              Math.hypot(ev.clientX - start.x, ev.clientY - start.y) >= deadZone) movedFar = true;
          return;
        }
        // A press that is not allowed to take the selection is not allowed to move anything
        // either. It stays alive only so a second finger can still turn it into a pinch above.
        if (role !== 'take') return;
        if (!(surf.movable?.(key) ?? true)) return;   // resize-only elements never translate
        if (ev.pointerId !== e.pointerId) return;   // a stray pointer not driving this gesture
        if (!live) {
          if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < deadZone) return;
          live = true; start = { x: ev.clientX, y: ev.clientY };
        }
        if (mode === 'move') {
          // Clamp by the element's HALF size so its whole footprint stays inside the surface — the
          // centre can't go closer to an edge than half the element's width/height.
          const b = surf.rects()[key];
          const hw = b ? Math.min(0.5, b.w / 2 / surf.w) : 0.02;
          const hh = b ? Math.min(0.5, b.h / 2 / surf.h) : 0.02;
          // Keep everything inside the printable area. The clamp used to be the element's own half
          // width, so its edge could sit flush against the paper's — measured at 0.0mm — and we print
          // with @page margin:0, which means a home printer simply cuts that off. Almost no consumer
          // printer reaches within 3–5mm of an edge.
          //
          // An element too large to fit between the margins is centred rather than clamped to an
          // inverted range, which would pin it to one side.
          const px = (surf.pad ?? 0) / surf.w, py = (surf.pad ?? 0) / surf.h;
          const loX = hw + px, hiX = 1 - hw - px;
          const loY = hh + py, hiY = 1 - hh - py;
          let rawX = box0.x + (ev.clientX - start.x) / rect.width;
          let rawY = box0.y + (ev.clientY - start.y) / rect.height;
          // ── Snap, THEN clamp. The print margin outranks the alignment: an element pinned to the
          //    safe area must not be dragged into it just because a guide line lives there.
          clearGuides();
          if (b) {
            const thrX = SNAP_PX * (surf.w / rect.width), thrY = SNAP_PX * (surf.h / rect.height);
            const linesX: number[] = [], linesY: number[] = [];
            const all = surf.rects();
            for (const k of Object.keys(all)) {
              if (k === key) continue;
              const r = all[k];
              if (!r || r.w <= 0 || r.h <= 0) continue;   // a hidden element has a zero rect
              linesX.push(r.x, r.x + r.w / 2, r.x + r.w);
              linesY.push(r.y, r.y + r.h / 2, r.y + r.h);
            }
            if (!surf.lockX?.(key)) {
              const sx = snapAxis(rawX * surf.w, b.w / 2, linesX, surf.w / 2, thrX);
              if (sx) { rawX += sx.d / surf.w; snapX = sx.line / surf.w; }
            }
            if (!surf.lockY?.(key)) {
              const sy = snapAxis(rawY * surf.h, b.h / 2, linesY, surf.h / 2, thrY);
              if (sy) { rawY += sy.d / surf.h; snapY = sy.line / surf.h; }
            }
          }
          const x = surf.lockX?.(key) ? box0.x : (loX > hiX ? 0.5 : clamp(rawX, loX, hiX));
          const y = surf.lockY?.(key) ? box0.y : (loY > hiY ? 0.5 : clamp(rawY, loY, hiY));
          // If the clamp had to move a snapped centre, the guide is now pointing at a line the
          // element is NOT on. Drop it rather than draw a lie.
          if (snapX !== null && Math.abs(x - rawX) > 1e-6) snapX = null;
          if (snapY !== null && Math.abs(y - rawY) > 1e-6) snapY = null;
          armUndo();
          surf.move(key, r4(x), r4(y));
        } else if (mode === 'rotate') {
          // No gain and no dead-zone rebase: an angle is already 1:1 with the finger, and the
          // further out you grab the handle the finer it gets — which is the gesture doing the job
          // the touch multiplier does for the resize grip.
          if (!surf.rotate) return;
          const a = Math.atan2(ev.clientY - anchor.y, ev.clientX - anchor.x);
          // Degrees only in here and at the control that shows it. What is stored is radians —
          // snapAngle() in $lib/posterFlow holds the 15°/5° bargain and says why.
          const rad = r4((snapAngle(((rot0 + (a - angle0)) * 180) / Math.PI) * Math.PI) / 180);
          // A snap that lands where the element already was is not an edit, and armUndo() below is
          // what sets `designEdited` — the flag that unlocks persist() and every export. A bare
          // selection tap used to set it, which is the bug this whole arm-then-push model exists to
          // stop; a rotate that rounds back onto its own angle must not reintroduce it.
          if (rad === (surf.box(key).rot ?? 0)) return;
          armUndo();
          surf.rotate(key, rad);
        } else {
          // Touch gets a gain: at 3.4 design px per finger px, an unscaled grip moved `size` by ~68px
          // in a 20px flick. Coarse scaling on a phone is what the pinch is for.
          const gain = touch ? TOUCH_RESIZE_GAIN : 1;
          const dpx = (((ev.clientX - start.x) * gain) / rect.width) * surf.w;
          const [lo, hi] = surf.limits(key);
          armUndo();
          surf.size(key, r1(clamp(box0.size + dpx, lo, hi)));
        }
      }
      // Update the outline + canvas immediately so they track the pointer with no lag.
      surf.remeasure();
      surf.redraw();
    };
    // Lifting ANY finger ends the whole gesture, pinch included. Falling back to a one-finger move
    // on the finger that happens to remain would move the element by wherever that finger was
    // sitting — a jump, right at the moment the user thought they had finished.
    const onUp = () => {
      // A gesture that never crossed the dead zone was a TAP, not a drag. The click that follows can
      // then mean something — see the inline editor.
      tapped = !live && !pinch;
      tapHeld = wasSelected;
      // The select-only press lands its selection HERE, and only if it stayed still. A swipe that
      // began on an element scrolled the panel; selecting the thing it set off from would be a
      // second, unasked-for result of one gesture.
      if (selectOnly && !movedFar) surf.select(key);
      /* A press that was turned away and STAYED A TAP — no drag, no second finger.
         Everything about switching happens here, at the release, and never at the press. Deciding
         at pointerdown broke pinching: the first finger of a pinch routinely lands on some other
         element's box, so the press after any refused tap was read as the second half of a
         double-tap and swapped the selection out from under the gesture — the thing being pinched
         changed instead of being scaled. By the release we know what the gesture actually was.
         The cost is that a switch cannot be dragged out of in one motion, which nobody asked for. */
      /* NOT for a stage pinch, which is refused-by-construction rather than refused by pressRole —
         and the second finger of one lands on blank stage too, starting its OWN gesture that the
         first has already claimed the pinch from. That gesture ends with no drag and no pinch of
         its own, which is character for character what a refused tap looks like here: finish a
         pinch, get told to double-tap to switch. There is nothing to switch TO — `key` is the
         element already selected — so the offer was meaningless as well as unwanted, and it was
         writing `lastRefused` about an element that had not been refused anything. */
      if (role === 'pinch' && !pinchOnly && !live && !pinch) {
        const again = lastRefused?.key === key && Date.now() - lastRefused.at < REFUSE_SWITCH_MS;
        lastRefused = again ? null : { key, at: Date.now() };
        if (again) surf.select(key);
        else showHint('Double-tap to switch to this one, or ✕ to clear the selection');
      }
      surf.dragging(null); clearGuides();
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      window.removeEventListener('pointerdown', onDown, true);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('pointerdown', onDown, true);
  }
  // A placed motif is a draggable thing on the same surface as the text, so it goes through the SAME
  // drag implementation rather than getting a second one — snapping, the print margin, the pinch and
  // the undo coalescing all come free, and none of them can drift away from how the text behaves.
  // The keys are `decor:<index>`; everything below routes on that prefix.
  const posterSurface: Surface = {
    pad: PAGE_PAD,
    stage: () => stageEl,
    w: W, h: H,
    rects: posterRects,
    box: (k) => {
      const d = decorIdx(k); if (d >= 0) return decorBox(d);
      const t = textIdx(k); if (t >= 0) { const it = textItems[t]; return it ? { x: it.x, y: it.y, size: it.size, rot: it.rot } : { x: 0.5, y: 0.7, size: 30 }; }
      return layout[k as ElKey];
    },
    // The QR floor is what keeps a code with our logo punched into its centre scannable. A motif's
    // range is its own scale clamp (0.4–2.2) expressed in pixels, so the renderer never has to
    // second-guess a size the designer allowed.
    limits: (k) => (decorIdx(k) >= 0 ? [0.4 * DECOR_PX, 2.2 * DECOR_PX] : textIdx(k) >= 0 ? [14, 120] : k === 'qr' ? [QR_MIN_PX, 760] : [16, 170]),
    lockY: (k) => k === 'brand',      // the brand mark slides left/right along its line only
    // No `resizable` override any more: every element on this surface can be resized, and the
    // callers already default to true. This used to exclude the brand mark so a pinch could not
    // give it by the back door what its missing grip withheld — now it HAS the grip, and a pinch
    // doing the same thing as the grip is the point rather than a loophole.
    move: (k, x, y) => {
      const i = decorIdx(k); if (i >= 0) { patchDecor(i, { x, y }); return; }
      const t = textIdx(k); if (t >= 0) { patchText(t, { x, y }); return; }
      layout = { ...layout, [k]: { ...layout[k as ElKey], x, y } };
    },
    size: (k, px) => {
      const i = decorIdx(k); if (i >= 0) { patchDecor(i, { scale: px / DECOR_PX }); return; }
      const t = textIdx(k); if (t >= 0) { patchText(t, { size: px }); return; }
      layout = { ...layout, [k]: { ...layout[k as ElKey], size: px } };
    },
    // canRotate() in $lib/posterFlow holds the list and the reasoning — chiefly why the QR is not
    // on it. Routed on the same key prefixes `move` and `size` are, so a motif, a host's own line
    // and a fixture all reach it without a second dispatch table.
    rotatable: canRotate,
    rotate: (k, rot) => {
      // The placed motifs' `rot` is required and has always been written, so it is set outright.
      const i = decorIdx(k); if (i >= 0) { patchDecor(i, { rot }); return; }
      // The other two are optional, and upright has to spell itself as absent — see withRot.
      const t = textIdx(k);
      if (t >= 0) { if (textItems[t]) textItems = textItems.map((x, n) => (n === t ? withRot(x, rot) : x)); return; }
      layout = { ...layout, [k]: withRot(layout[k as ElKey], rot) };
    },
    remeasure: () => { bounds = measureBounds(); },
    redraw: scheduleRedraw,
    select: (k) => (selectedKey = k),
    selected: () => selectedKey,
    dragging: (k) => (dragKey = k),
  };
  function startDrag(key: string, mode: 'move' | 'resize' | 'rotate', e: PointerEvent) { dragOn(posterSurface, key, mode, e); }

  // ── Edit it where it is ─────────────────────────────────────────────────────
  // On a phone the controls are BELOW the preview, so changing the title meant scrolling down to a
  // field, typing blind, and scrolling back up to see what happened — for every word. Tapping the
  // words themselves puts the caret where the host is already looking.
  //
  // Only the text elements: the QR is an image, the brand mark is fixed wording, and the footer is
  // the join URL, which is not the host's to write.
  type EditKey = 'title' | 'message' | 'steps' | 'names';
  type EditSpec = { label: string; get: () => string; set: (v: string) => void; max: number };
  const EDITABLE: Record<EditKey, EditSpec> = {
    title:   { label: 'Title',       get: () => headline,   set: (v) => (headline = v),   max: 60 },
    message: { label: 'Message',     get: () => message,    set: (v) => (message = v),    max: 80 },
    steps:   { label: 'How-to line', get: () => stepsText,  set: (v) => (stepsText = v),  max: 120 },
    names:   { label: 'Names',       get: () => names,      set: (v) => (names = v),      max: 60 },
  };
  /** The four FIXTURES with words in them — the ones that also have a `layout` entry, which is what
   *  the ghost outline needs (see ghostRect). Not the same question as "can this be typed into". */
  const isEditable = (k: string): k is EditKey => k in EDITABLE;
  /** The editor's spec for any element key, or null for one with no words of the host's in it.
   *
   *  The four fixtures above, PLUS the host's own lines — which had no inline editor at all and were
   *  only reachable from the list down in the panel. That asymmetry did not show while the editor
   *  opened on a tap (a custom line simply never opened one); it would show immediately now that
   *  selecting an element reveals a pencil, because the one element the host typed themselves would
   *  be the only one whose pencil was missing.
   *
   *  Still absent, deliberately: the footer (the join URL, which is not the host's to write), the
   *  mark (fixed wording) and the QR (an image). */
  function editSpecOf(key: string): EditSpec | null {
    if (isEditable(key)) return EDITABLE[key];
    const t = textIdx(key);
    if (t >= 0 && textItems[t]) return {
      label: 'Your line', get: () => textItems[t]?.text ?? '', set: (v) => patchText(t, { text: v }), max: 60,
    };
    return null;
  }
  // `string`, not EditKey: a host's own line is keyed `text:<i>`, which is not a member of any union.
  let editingKey: string | null = null;
  let editEl: HTMLTextAreaElement | undefined;

  /** Size the inline editor to its words: one row when there is one line, up to three when there
   *  is not.
   *
   *  It was a single-line <input>, which on a 60-character title scrolls what you just typed out of
   *  sight — in a box floating over the poster, where re-reading it is the whole reason the box is
   *  there. Capped at three rows because past that it covers the element it is editing. */
  const EDIT_MAX_H = 96;
  function grow(el: HTMLTextAreaElement) {
    const fit = () => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight, EDIT_MAX_H)}px`; };
    fit();
    el.addEventListener('input', fit);
    return { destroy() { el.removeEventListener('input', fit); } };
  }

  // ── Closing by the backdrop ────────────────────────────────────────────────
  // `on:click|self` on its own was closing the designer on gestures that STARTED inside it: select
  // text in the inline editor by dragging, release past the sheet's edge, and the click that lands
  // is targeted at the backdrop — so the whole designer closed and the edit went with it. Dragging
  // an element on the stage and releasing over the backdrop did the same.
  //
  // So a dismiss needs the press AND the click to be on the backdrop. The rule is
  // shouldDismissBackdrop() in $lib/posterFlow; these record which gesture is in flight.
  let downOnBack = false;
  // Captured at POINTERDOWN, not read at click: the editor's own on:blur fires on the press, so by
  // the time the click arrives `editingKey` is already null and the editor could not defend itself.
  let downWithEditor = false;
  function onBackPointerDown(e: PointerEvent) {
    downOnBack = e.target === e.currentTarget;
    downWithEditor = editingKey !== null;
  }
  function onBackClick(e: MouseEvent) {
    if (!shouldDismissBackdrop({
      downOnBackdrop: downOnBack,
      clickOnBackdrop: e.target === e.currentTarget,
      blockedByEditor: downWithEditor,
    })) return;
    dispatch('close');
  }

  /** Open the inline editor on an element.
   *
   *  Reached two ways, both of them a SECOND deliberate press rather than the first: the ✎ in the
   *  selected element's own control cluster, and a tap on an element that was ALREADY selected
   *  before the press (tapElement below). The first press only ever selects.
   *
   *  No pushUndo here. Opening an editor changes nothing; it used to snapshot on open, which put a
   *  no-op step on the stack every time somebody looked at a field. The typing that follows is
   *  coalesced into one step by the history watcher, which is what it is for. */
  async function openEditor(key: string) {
    if (!editSpecOf(key)) return;
    binArmed = null;                 // an armed bin and an open keyboard on one element is a trap
    editingKey = key;
    await tick();
    editEl?.focus(); editEl?.select();
  }
  /** A tap on an element.
   *
   *  It used to open the text box on the FIRST tap, which is the thing the owner asked us to stop:
   *  selecting a line to nudge it threw a keyboard over the poster. So the first press selects and
   *  reveals the cluster, and only a tap on something already held opens the editor.
   *
   *  `tapped` is unchanged and still doing its original job — after a drag, the click that arrives
   *  is the tail of the gesture that just moved the element, and opening a keyboard then would
   *  cover the thing they were positioning. `tapHeld` is the other half: what was selected BEFORE
   *  the press, which is the only way to tell a first tap from a second one (selection happens at
   *  pointerdown, so by the time this click runs the element is already selected either way). */
  function tapElement(key: string) {
    if (!tapped || tapHeld !== key) return;
    void openEditor(key);
  }
  function endEdit() { editingKey = null; }
  /** A quick double press finishes the edit.
   *
   *  ONLY on a coarse pointer. On a mouse, double-click inside a text field selects a word — that is
   *  the behaviour every text box on the machine has, and taking it away to mean "done" would break
   *  ordinary editing to add a shortcut nobody asked for there. On a touchscreen there is no word
   *  to select by double-tapping in practice, and a second tap is the natural "yes, finished".
   *
   *  The existing ways out stay: Enter, Escape, the ✓, and tapping away (blur). */
  const coarsePointer = () =>
    typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  /* Read once on mount, for the HINTS — which name a control the CSS hides on touch (see the
     media query on .el-rz). Telling a phone to drag a corner that is not on its screen is worse
     than saying nothing. Deliberately not reactive to a mid-session change: nobody swaps pointer
     type while a poster is open, and matchMedia in the markup would run during SSR. */
  let coarse = false;
  function endEditOnDoublePress(e: MouseEvent) {
    if (!coarsePointer()) return;
    e.preventDefault();
    endEdit();
  }

  /** Double-press the paper to let go of whatever is selected.
   *
   *  A SINGLE press deliberately does not — see releaseSelection's note. Dropping a selection on any
   *  stray tap is how a host loses the element they were lining up, and the stage is covered in
   *  things you press on purpose. A double press is unambiguous: nobody double-taps blank paper by
   *  accident, and it is the gesture people already reach for to mean "done".
   *
   *  Every pointer, not just touch. `endEditOnDoublePress` is coarse-only for a real reason — on a
   *  desktop a double-click inside a textarea selects a word, and stealing that would break ordinary
   *  editing. There is no such conflict out here on the paper, and this is the case that was
   *  reported on a desktop.
   *
   *  Only when the press is on the BACKGROUND. An element handles its own double-press, and the
   *  check is currentTarget === target rather than a class test so a new child cannot quietly opt
   *  itself in. */
  function releaseStageOnDoublePress(e: MouseEvent) {
    if (e.target !== e.currentTarget) return;
    if (!selectedKey && !editingKey) return;
    e.preventDefault();
    releaseSelection();
  }
  /** Let go of the selected element. With the stage no longer deselecting on a background press,
   *  this and Escape are the ONLY two ways out — see the cluster's ✕ and escapeLayer(). */
  function releaseSelection() {
    binArmed = null;
    endEdit();
    selectedKey = null;
    cardSelectedKey = null;
  }
  /** Narrow helpers for the markup, where a TypeScript cast is a syntax error.
   *  `textItems` is named syntactically: editSpecOf() reads it inside a called function, which `$:`
   *  cannot see. */
  $: editSpec = (dep(textItems), editingKey ? editSpecOf(editingKey) : null);
  const setEdit = (v: string) => { if (editingKey) editSpecOf(editingKey)?.set(v); };

  // ── The bin on the selected element ────────────────────────────────────────
  //
  // "Get rid of it" means three different things depending on what the element IS, and the table
  // that says which is binActionFor() / cardBinActionFor() in $lib/posterFlow — along with the
  // elements that get NO bin, and why. This is the half that performs it.
  //
  // Arm, then confirm, like "Start again" and "Reset layout": `binArmed` holds the key, and the
  // armed chip goes red rather than swapping to the word "Sure?", because there is no room for a
  // word in a 44px chip. Undo is underneath it either way — the snapshot below is pushed BEFORE
  // anything mutates, and cfg carries every field a binned element owns (its words, its position,
  // its size, its colour), so ⟲ restores it whole.
  //
  // Switching on the KEY rather than on the action: the action is what the control says it will do,
  // the key is what it does it to. Keeping them separate is what lets the two live in different
  // files; binReach() below and a test in PosterModal.select.test.ts pin them together so a key
  // cannot be added to one and forgotten in the other.
  function applyPosterBin(key: string) {
    const t = textIdx(key);
    if (t >= 0) { textItems = textItems.filter((_, n) => n !== t); return; }
    const d = decorIdx(key);
    if (d >= 0) { decorItems = decorItems.filter((_, n) => n !== d); return; }
    switch (key) {
      // Cleared, not removed: the slot keeps its position, size and colour, so re-typing the words
      // brings the design back rather than starting the element over. VISIBLE_COLOR_ROWS already
      // hides the swatch of an element that is off and deliberately never resets the value behind
      // it, which is the other half of the same promise.
      case 'message': message = ''; break;
      case 'steps': stepsText = ''; break;
      case 'names': names = ''; break;
      // Toggle-backed: the bin is a second way to reach a switch that is already in the panel.
      case 'brand': showBrand = false; break;
      case 'footer': showFooterUrl = false; break;
    }
  }
  function applyCardBin(key: string) {
    switch (key) {
      // Falls back to the poster's headline (cardHeading), so the card still has a title. The bin
      // here means "stop overriding the poster's", which is also why it cannot strand anyone.
      case 'title': cardTitle = ''; break;
      // ONE block covering the code and the line beside it, labelled "QR / join" and read as one
      // thing, so both of its switches go rather than half of them.
      case 'qr': cardShowQr = false; cardShowLink = false; break;
    }
  }
  function pressBin(key: string) {
    // Arming one confirm disarms the others — two armed controls would put two warnings on screen
    // at once, which is the reasoning the header's pair already runs on.
    restyleArmed = false; resetArmed = false;
    if (binArmed !== key) { binArmed = key; return; }
    binArmed = null;
    const cards = view === 'cards';
    if (!(cards ? cardBinActionFor(key) : binActionFor(key))) return;   // no bin is rendered; belt and braces
    commitBurst();
    pushUndo(JSON.stringify(cfg));
    if (cards) applyCardBin(key); else applyPosterBin(key);
    // The selection cannot stay on something that is no longer there. A cleared fixture drops out
    // of `elements`, so its outline and its cluster would be left hanging beside empty space —
    // which reads as a fault. removeText()/removeDecor() already did exactly this.
    releaseSelection();
  }
  /** Put an element back upright.
   *
   *  The reset half of the rotate handle, and the SAME reset the placed-motif panel has offered
   *  since motifs learned to turn — "🔄 Upright", one press, no confirm. It needs none: unlike the
   *  bin it destroys nothing but the angle, and it is a single ⟲ away either direction.
   *
   *  Pushes undo BEFORE it mutates, and only when there is a mutation to make. An element that is
   *  already upright has no chip, so this is unreachable then; the guard is belt and braces against
   *  a stale press marking a design edited and unlocking every export on it. */
  function putUpright(key: string) {
    if (!key || !canRotate(key) || !(posterSurface.box(key)?.rot)) return;
    commitBurst();
    pushUndo(JSON.stringify(cfg));
    posterSurface.rotate?.(key, 0);
    bounds = measureBounds();
    scheduleRedraw();
  }
  /** What the bin says it will do, for its label and its tooltip. The armed wording is the warning
   *  the header's buttons put in their own label; an icon has nowhere to put it but here. */
  function binLabel(action: BinAction, label: string, armed: boolean): string {
    const verb = action === 'delete' ? 'Delete' : action === 'clear' ? 'Clear' : 'Hide';
    return armed ? `Press again to ${verb.toLowerCase()} ${label}` : `${verb} ${label}`;
  }

  // ── The selected element's control cluster ─────────────────────────────────
  //
  // ONE of these per stage, worked out here and rendered once, because selection is now EXCLUSIVE:
  // there can only ever be a single cluster on a surface. Before exclusivity this markup would have
  // had to be repeated on all three element loops (the fixtures, the host's lines, the motifs) —
  // three copies of a control cluster is two chances for one of them to drift.
  //
  // Everything the markup needs is a number or a boolean by the time it gets there, including the
  // percentages, so the SAME component serves the poster stage and the card stage, which measure in
  // two different design spaces.
  type ElControls = {
    key: string; label: string;
    rightPct: number; topPct: number; bottomPct: number; below: boolean;
    canEdit: boolean; bin: BinAction | null;
    /** How far the element is turned, in radians. 0 for every card element and for anything the
     *  host has not turned — the cluster's reset only appears when there is something to reset. */
    rot: number;
  };
  // `canEdit` is passed IN rather than derived from the key here, and that is not fussiness: the
  // card's title element is also keyed 'title', which is a member of the POSTER's EDITABLE map. A
  // cluster that asked editSpecOf() itself would put a pencil on the card's title that typed into
  // the poster's headline.
  const clusterAt = (key: string, label: string, r: Rect, sw: number, sh: number, bin: BinAction | null, canEdit: boolean, rot = 0): ElControls => {
    const topPct = (r.y / sh) * 100, bottomPct = ((r.y + r.h) / sh) * 100;
    return {
      key, label, rightPct: ((r.x + r.w) / sw) * 100, topPct, bottomPct,
      // The cluster sits ABOVE the element by default. Near the top of the page there is no room
      // above and the sheet would clip it, which is the same problem — and the same threshold — that
      // `label-below` already solves for the element's name tab. Flipped only when there is
      // somewhere to flip TO, so a full-height element keeps it above rather than off the bottom.
      below: topPct < 10 && bottomPct < 84,
      canEdit, bin, rot,
    };
  };
  $: selectedEl = ((): ElControls | null => {
    // Every dependency named syntactically: `$:` does not track state read inside a called
    // function, and all four of these are read inside one.
    // `layout` among them: the cluster now reads an element's own rotation off it, and a `$:` that
    // does not name a dependency syntactically does not see it change.
    dep(allRects, textItems, decorItems, elements, layout);
    const k = selectedKey;
    if (!k) return null;
    const r = allRects[k];
    if (!r || r.w <= 0 || r.h <= 0) return null;
    const t = textIdx(k), d = decorIdx(k);
    // Gated on the element still BEING there, not merely on having a measurement. A cleared fixture
    // keeps a rect — bounds measures `message || ' '`, a single space — but drops out of
    // `elements`, and a cluster of controls around a blank line is the ghost we must not leave.
    let label: string;
    let rot = 0;
    if (t >= 0) { if (!textItems[t]) return null; label = 'Your line'; rot = textItems[t].rot ?? 0; }
    else if (d >= 0) {
      const it = decorItems[d];
      if (!it) return null;
      label = it.kind === 'logo' ? 'Image' : DECOR_KINDS.find((x) => x.key === it.kind)?.label ?? 'Decoration';
      rot = it.rot ?? 0;
    } else {
      const el = elements.find((x) => x.key === k);
      if (!el) return null;
      label = el.label;
      rot = layout[k as ElKey]?.rot ?? 0;
    }
    return clusterAt(k, label, r, W, H, binActionFor(k), !!editSpecOf(k), rot);
  })();
  $: cardSelectedElControls = ((): ElControls | null => {
    dep(cardRects, cardElements, cardGeomBox);
    const k = cardSelectedKey;
    if (!k) return null;
    const r = cardRects[k];
    if (!r || r.w <= 0 || r.h <= 0) return null;
    const el = cardElements.find((x) => x.key === k);
    if (!el) return null;
    // No pencil on the card: it has no inline editor at all, and its title is typed in the panel
    // where the fallback to the poster's headline can be explained.
    return clusterAt(k, el.label, r, cardGeomBox.cw, cardGeomBox.ch, cardBinActionFor(k), false);
  })();

  // ── Show me what this changes ───────────────────────────────────────────────
  // Hovering or focusing a control outlines the thing it affects. Most useful on the controls whose
  // effect is hard to predict: an empty field shows WHERE its words would land, so a host can see
  // that the Names line has a place waiting for it before deciding to fill it in.
  let hintKey: string | null = null;
  const hintOn = (k: string) => () => (hintKey = k);
  const hintOff = () => (hintKey = null);
  /** Where a hidden element WOULD sit, so an empty field can still be pointed at. */
  $: hintLabel = hintKey && isEditable(hintKey) ? EDITABLE[hintKey].label : '';
  $: ghostRect = (() => {
    if (!hintKey || !isEditable(hintKey)) return null;
    if (elements.some((e) => e.key === hintKey)) return null;   // it is drawn; the real outline shows
    const b = layout[hintKey as ElKey];
    if (!b) return null;
    const w = W * 0.55, h = Math.max(28, b.size * 1.4);
    return { x: b.x * W - w / 2, y: b.y * H - h / 2, w, h };
  })();
  function resetLayout() { layout = cloneLayout(DEFAULT_LAYOUT); bounds = measureBounds(); scheduleRedraw(); }

  // Coalesce redraws to one per animation frame so the preview tracks dragging smoothly.
  let rafId = 0;
  function scheduleRedraw() { if (rafId) return; rafId = requestAnimationFrame(() => { rafId = 0; draw().catch(() => {}); }); }
  $: if (mounted) { dep(cfg, customBgUrl); scheduleRedraw(); persist(); }
  // The backing store follows the CSS box (see previewWidth), and the CSS box changes when the
  // stage does — entering ⛶ Arrange, turning a phone sideways, dragging a window to a screen with
  // a different pixel ratio.
  //
  // NOT a reactive statement on `fsEdit`: that runs while the old layout is still in force, and
  // measured it left the canvas at 1080 after entering Arrange until the next window resize
  // happened to redraw it. A ResizeObserver fires once the box really IS its new size, which is
  // the only moment the measurement is worth taking.
  function resizeToStage() { if (mounted && previewWidth() !== drawnW) scheduleRedraw(); }

  // ── Palette from the background image ──
  let paletteFor = '';
  function extractPalette(img: HTMLImageElement) {
    if (paletteFor === img.src) return; paletteFor = img.src;
    try {
      const c = document.createElement('canvas'); c.width = 48; c.height = 48;
      const x = c.getContext('2d'); if (!x) return;
      x.drawImage(img, 0, 0, 48, 48);
      const data = x.getImageData(0, 0, 48, 48).data;
      const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2];
        const k = `${r >> 5}-${g >> 5}-${b >> 5}`;
        const e = buckets.get(k) ?? { n: 0, r: 0, g: 0, b: 0 };
        e.n++; e.r += r; e.g += g; e.b += b; buckets.set(k, e);
      }
      const hex = (n: number) => n.toString(16).padStart(2, '0');
      palette = [...buckets.values()].sort((a, b) => b.n - a.n).slice(0, 6)
        .map((e) => `#${hex(Math.round(e.r / e.n))}${hex(Math.round(e.g / e.n))}${hex(Math.round(e.b / e.n))}`);
    } catch { /* tainted */ }
  }
  function applySwatch(hex: string) {
    // A card target overrides only the card; it must not lock the poster's palette out of tracking
    // the event theme just because someone recoloured a card.
    // Through the one writer: with "one design" off, these colour the card being edited rather
    // than Card A. patchCardDesign() is where that is decided, once.
    if (activeTarget === 'cardTitle') { patchCardDesign({ cTitle: hex }); return; }
    if (activeTarget === 'cardBody') { patchCardDesign({ cBody: hex }); return; }
    if (activeTarget === 'cardCode') { patchCardDesign({ cCode: hex }); return; }
    if (activeTarget === 'cardBg') { patchCardDesign({ cBg: hex }); return; }
    // The three title-followers are exceptions to the palette, not members of it — same reasoning
    // as the card overrides above. Setting one must not stop the rest of the poster tracking the
    // event theme, and clearing one must put it straight back to following the title.
    if (activeTarget === 'headTop') { cHeadTop = hex; return; }
    if (activeTarget === 'headBottom') { cHeadBottom = hex; return; }
    if (activeTarget === 'names') { cNames = hex; return; }
    colorsLocked = true;   // editing any colour locks the palette (stops it tracking the theme)
    if (activeTarget === 'headline') cHeadline = hex; else if (activeTarget === 'message') cMessage = hex;
    else if (activeTarget === 'steps') cSteps = hex; else if (activeTarget === 'code') cCode = hex; else cFooter = hex;
  }
  function onColorInput(e: Event, key: CTarget) {
    activeTarget = key;
    applySwatch((e.target as HTMLInputElement).value);
  }

  // ── Custom background via the shared cropper ──
  function onBgFile(e: Event) { const i = e.target as HTMLInputElement; const f = i.files?.[0]; i.value = ''; if (f) { editorSrc = ''; editorFile = f; } }

  /** Reframe the EVENT image for the poster.
   *
   *  The event image is cropped 3:4 for the join screen and the poster is 1:√2, so "use the event
   *  image" was always a second, uncontrolled reframe of a crop the host had already framed for a
   *  different shape. Opening the ORIGINAL at the poster's own ratio is the fix, and what comes back
   *  is simply the poster's own background — one image path for the renderer to draw, no crop maths
   *  anywhere near the canvas, the print paths or the sheet cache. */
  function repositionPosterBg() {
    if (!themeOriginalUrl) return;
    editorFile = null;
    editorSrc = themeOriginalUrl;
  }

  async function onBgCropped(e: CustomEvent<{ blob: Blob; crop: string }>) {
    editorFile = null; editorSrc = '';
    bgUploading = true;
    try {
      const form = new FormData();
      form.append('headerImage', e.detail.blob, 'poster-bg.jpg');
      const res = await fetch(`/api/events/${joinCode}/theme-image?kind=crop`,
        { method: 'POST', body: form, headers: { 'X-Organizer-Code': orgCode } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');
      customBgUrl = data.url as string;
      imgCache.delete(customBgUrl);
      bgMode = 'custom';
    } catch {
      // Keep whatever background is already on the poster rather than blanking the design.
    } finally {
      bgUploading = false;
    }
  }

  // Fetch a print-quality, white-background, high-error-correction QR for the poster (the in-app QR
  // passed in is small + tinted). Falls back silently to that prop QR if the fetch fails.
  // One QR per set, cached.
  //
  // A card printed for Table B has to carry `?set=b`, or the guest who scans it gets whatever the
  // round-robin hands out and may be given Table A's list — the card in their hand disagreeing with
  // the app, which is exactly what printing several cards is meant to avoid. The server validates
  // the key against the event's own sets before it goes anywhere near a QR.
  const setQrCache = new Map<string, string>();
  async function qrForSet(key: string | null): Promise<string> {
    const k = key ?? '';
    const hit = setQrCache.get(k);
    if (hit) return hit;
    try {
      const q = `?print=1${k ? `&set=${encodeURIComponent(k)}` : ''}`;
      const r = await fetch(`/api/events/${encodeURIComponent(joinCode)}/qr${q}`, { credentials: 'same-origin' });
      const d = await r.json();
      if (d?.qrCode) { setQrCache.set(k, d.qrCode); return d.qrCode; }
    } catch { /* fall through to the plain QR — a card with the wrong set still joins the event */ }
    return qrImg;
  }

  async function loadPosterQr() {
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(joinCode)}/qr?print=1`, { credentials: 'same-origin' });
      const d = await r.json();
      // Take BOTH halves from the one response, so the picture and the words cannot drift apart.
      if (typeof d?.joinUrl === 'string' && d.joinUrl) printedUrl = d.joinUrl;
      if (d?.qrCode) { qrImg = d.qrCode; }
      if (d?.qrCode || d?.joinUrl) scheduleRedraw();
    } catch { /* keep the provided QR */ }
  }
  let stageRO: ResizeObserver | undefined;
  onMount(() => {
    coarse = coarsePointer();
    // Suppress the history watcher for the whole restore batch.
    //
    // Undo used to be live on a design nobody had edited: prevCfg was seeded during init with the
    // untouched DEFAULT cfg, restore() then rewrote layout, colours, type and decoration in one
    // batch, and the watcher read that as an edit — opening a burst whose "before" state was a
    // blank poster. One press of undo then applied that default AND persist()ed it over the host's
    // saved work. Five real events on production have saved designs.
    //
    // Re-seeding `prevCfg` right here does NOT fix it, and that was the first attempt: `cfg` is a
    // `$:` derivation, and Svelte runs onMount (a render callback) BEFORE re-deriving cfg from the
    // values restore() has just written — so that line captured the very default it meant to
    // exclude. Confirmed by compiling a component of the same shape.
    //
    // `applyingHistory` is the mechanism step() already uses for exactly this: the watcher skips
    // opening a burst while it is set, but still assigns `prevCfg = cur`. So once the restored cfg
    // has propagated the baseline is correct, and clearing the flag a tick later leaves undo empty.
    applyingHistory = true;
    restore();
    void tick().then(() => { applyingHistory = false; });
    mounted = true; loadPosterQr(); loadMissions();
    if (canvas?.parentElement && typeof ResizeObserver !== 'undefined') {
      stageRO = new ResizeObserver(resizeToStage);
      stageRO.observe(canvas.parentElement);
    }
    draw().catch(() => { busy = false; showToast('Could not build the poster', true); });
    // Pull every bundled face down once the designer is open, then redraw. drawPoster awaits the
    // set it needs anyway, so this is not correctness — it is so that flipping between pairings is
    // instant instead of showing a frame of the fallback stack on each first visit.
    // ...and it is also correctness for the OUTLINES: they are measured off a bare offscreen
    // canvas, which has no way to await a face. Flipping the flag re-runs the `bounds` statement
    // (and the host-added lines' rects) with the real metrics instead of Arial's.
    warmAllPosterFonts().then(() => { if (mounted) { fontsReady = true; draw().catch(() => {}); } });
  });
  // customBgUrl is an uploads path now, not an object URL — nothing to revoke.
  onDestroy(() => { flushPersist(); stageRO?.disconnect(); });

  // `kind` names what was exported — the poster and each set's card sheet land in the same
  // downloads folder, so "cards-b" has to be distinguishable from "poster" at a glance.
  function download(blob: Blob, ext: string, kind = 'poster') {
    const href = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = href; a.download = `${slug}-${kind}.${ext}`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(href);
  }
  /** The poster on ITS OWN canvas, at a width the paper decides — never the on-screen preview.
   *
   *  Every export used to read the preview canvas, which is sized from the STAGE (see
   *  previewWidth): between 1080 and 2160 device pixels depending on how wide the panel happened to
   *  be. So the sharpness of a printed poster was decided by the browser window — 131dpi on A4 in a
   *  narrow one, 261 in a wide one — with nothing on screen to say which you were about to get.
   *
   *  Rendering fresh makes every export identical whatever the window is doing, and lets the PAPER
   *  pick the resolution. The front-and-back preview already worked this way for exactly this
   *  reason; it was the real exports that did not. Everything but the background photo is drawn
   *  from vectors and fonts, so the extra pixels are genuinely sharper and not an upscale. */
  async function posterCanvasAt(widthPx: number): Promise<HTMLCanvasElement> {
    const c = document.createElement('canvas');
    c.width = widthPx;
    c.height = Math.round((widthPx / PAGE_W) * PAGE_H);
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no canvas context');
    // drawPoster paints in page space and never touches the transform — the same property the
    // wizard's thumbnails rely on to draw the identical poster small.
    const sc = widthPx / PAGE_W;
    ctx.setTransform(sc, 0, 0, sc, 0, 0);
    await drawPoster(ctx, posterOpts());
    return c;
  }
  const exportCanvas = () => posterCanvasAt(exportWidthPx(paperSize, PAGE_H / PAGE_W));

  async function blobFrom(type: string, q?: number): Promise<void> {
    const c = await exportCanvas();
    await new Promise<void>((res) =>
      c.toBlob((b) => { if (b) download(b, type === 'image/png' ? 'png' : 'jpg'); res(); }, type, q));
  }
  function exportPng() { void asPrinted(() => blobFrom('image/png')); }
  function exportJpg() { void asPrinted(() => blobFrom('image/jpeg', 0.92)); }
  async function exportPdf() {
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: pdfFormat(paperSize) });
      await asPrinted(async () => {
        const c = await exportCanvas();
        pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pdf.internal.pageSize.getWidth(), pdf.internal.pageSize.getHeight());
      });
      pdf.save(`${slug}-poster.pdf`);
    } catch { showToast('Could not build the PDF', true); }
  }
  /** Poster on the front, the trick list on the back — one job, two pages.
   *
   *  The owner asked for this from the start ("it's very possible to have the main poster on one
   *  side, and the list only on the other"), and it needs no new geometry: the poster and the card
   *  sheet already render themselves, and printSheets already knows how to put several images on
   *  separate pages and wait for every one to decode before calling print(). This is those three
   *  facts joined up.
   *
   *  Page 2 is the sheet for the set being previewed, not all of them. A double-sided job has to
   *  pair ONE back with ONE front — send four sets and the printer interleaves them against a
   *  single poster, which is four wrong pairings rather than four sheets.
   *
   *  The duplex instruction matters and is not ours to control: the browser's print dialog owns
   *  it. Flipping on the LONG edge is what keeps both sides upright on a portrait sheet; short-edge
   *  gives you a back that is upside down relative to the front. So we say so, rather than leaving
   *  someone to discover it after fifty sheets. */
  // ── Front & back, seen before it is printed ────────────────────────────────
  // printDoubleSided has existed for a while as one button in the export row that went straight to
  // the browser's print dialog. Nobody found it, and nobody who did could tell what they were about
  // to get: whether the back really matched the front, or which set was on it. A double-sided job is
  // the one print where you cannot check the result without wasting a sheet, so it gets a look first.
  let finishBusy = false;
  // Narrow enough that the two pages sit SIDE BY SIDE in the panel column rather than stacking —
  // the question this preview answers is "does the back match the front", and stacked they are two
  // pictures you compare from memory.
  const FIN_THUMB_W = 150;
  let fFront: HTMLCanvasElement | undefined;
  let fBack: HTMLCanvasElement | undefined;

  /** Copy a full-size render into a thumbnail, keeping its own proportions — the poster and a
   *  4-up A6 sheet are both A4, but a 1-up sheet is not, and a preview that forced them to one
   *  shape would be lying about the pairing it exists to confirm. */
  function paintInto(dst: HTMLCanvasElement | undefined, src: HTMLCanvasElement, cssW = 230) {
    if (!dst) return;
    const ctx = dst.getContext('2d'); if (!ctx) return;
    // Backing store at the DEVICE resolution, CSS box at the display size. It used to be a flat
    // 230px canvas stretched to whatever the layout gave it — on a 3× phone that is a 230px image
    // across ~700 device pixels, which is exactly the mush the owner saw. This preview exists to
    // answer "does the back really match the front", and it cannot answer that blurred.
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = Math.min(src.width, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round((w * src.height) / src.width));
    dst.width = w; dst.height = h;
    dst.style.width = `${cssW}px`; dst.style.height = 'auto';
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h);
    // High-quality downscale: the default is a cheap sampler that drops thin strokes entirely, and
    // this page is almost all thin strokes and small type.
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, w, h);
  }

  /** Build the two thumbnails the Print tab's "Front & back" section shows.
   *
   *  This used to be a dialog stacked on the designer — a modal on top of a modal, with its own
   *  backdrop, its own Escape layer and its own copy of three print buttons. It is a print step, so
   *  it lives on the Print tab; the only thing that changed here is that nothing opens. */
  async function buildFinishPreviews() {
    finishBusy = true;
    await tick();
    try {
      // The FRONT is rendered fresh at full page size rather than copied off the on-screen preview,
      // which is only ever as big as the stage it sits in — on a phone that is a few hundred pixels
      // and every downscale after it starts from that. asPrinted still runs so a paper-colour
      // background is swapped out first: this shows the sheet, not the screen.
      await asPrinted(async () => {
        const full = document.createElement('canvas');
        full.width = W; full.height = H;
        const fctx = full.getContext('2d');
        if (fctx) {
          await drawPoster(fctx, posterOpts());
          paintInto(fFront, full, FIN_THUMB_W);
          // Kept at FULL resolution so opening a page fills the screen sharply. The thumbnail is
          // ~340px wide; blowing that up is the one thing a "view it bigger" control must not do.
          fsFront = full.toDataURL('image/png');
        } else if (canvas) { paintInto(fFront, canvas, FIN_THUMB_W); fsFront = canvas.toDataURL('image/png'); }
      });
      if (activeSheet) {
        const sheet = await sheetCanvas(activeSheet);
        paintInto(fBack, sheet, FIN_THUMB_W);
        fsBack = sheet.toDataURL('image/png');
      }
    } catch { showToast('Could not build the preview', true); }
    finally { finishBusy = false; }
  }
  // Rebuilt when the tab is opened and whenever the design behind it changes — undo and redo live
  // in the header, so a poster CAN change while this is the tab on screen.
  //
  // Cleared on the way out rather than kept: the canvases are inside the tab's `{#if}`, so leaving
  // unmounts them and `bind:this` goes undefined. Without this, coming back would match the stored
  // signature, skip the repaint, and show two blank boxes.
  /** The two pages at full size, and which one is open.
   *
   *  The Print tab is the one screen where the live poster on the left is redundant: what matters
   *  here is the two PAGES that will come out of the printer, and they are already on screen as
   *  thumbnails. So the left pane goes, the thumbnails get the room, and either one opens full
   *  screen — which is the size at which you can actually check a QR panel or read the small print
   *  before spending forty sheets of card on it. */
  let fsFront = '';
  let fsBack = '';
  let fsPage: 'front' | 'back' | null = null;
  $: fsPageSrc = fsPage === 'front' ? fsFront : fsPage === 'back' ? fsBack : '';
  let finishSig = '';
  $: finishWant = mounted && view === 'print' && !finishBusy
    ? JSON.stringify([cfg, customBgUrl, activeSheet?.key ?? null]) : '';
  $: if (view !== 'print') finishSig = '';
  $: if (finishWant && finishWant !== finishSig) { finishSig = finishWant; void buildFinishPreviews(); }

  async function printDoubleSided() {
    const set = activeSheet;
    if (!set) { showToast('Add a trick list first — there is nothing for the back', true); return; }
    try {
      let front = '';
      await asPrinted(() => { front = canvas.toDataURL('image/png'); });
      const back = (await sheetCanvas(set)).toDataURL('image/png');
      const w = window.open('', '_blank');
      if (!w) { showToast('Allow pop-ups to print', true); return; }
      const pages = [front, back];
      w.document.write(
        '<style>@page{size:A4;margin:0}html,body{margin:0;padding:0}'
        + 'img{width:100%;height:auto;display:block}img+img{page-break-before:always}</style>'
        + `<script>let n=0;function k(){if(++n===${pages.length}){window.focus();window.print();}}<\/script>`
        + pages.map((u) => `<img src="${u}" onload="k()">`).join(''));
      w.document.close();
      showToast('Two pages — set your printer to double-sided, flip on the LONG edge');
    } catch { showToast('Could not build the double-sided print', true); }
  }

  function printPoster() { void asPrinted(printPosterNow); }
  async function printPosterNow() {
    const w = window.open('', '_blank');
    if (!w) { showToast('Allow pop-ups to print', true); return; }
    const url = (await exportCanvas()).toDataURL('image/png');
    // Three things this fixes, all of them the browser's defaults rather than our design:
    //   @page margin:0   — Chrome draws its own date/URL header and footer in the page margin, so
    //                      removing the margin is what removes them. It also stops the ~12mm inset.
    //   body margin:0    — otherwise the poster sits 8px in from the paper edge even at margin:0,
    //                      which is why a full-bleed background stopped short of the edge.
    //   display:block    — an inline image carries a text baseline under it, leaving a hairline
    //                      strip of white along the bottom.
    // The card sheets already print this way; the poster was the one still on defaults.
    w.document.write(
      `<style>@page{size:${paperSize};margin:0}html,body{margin:0;padding:0}`
      + 'img{width:100%;height:auto;display:block}</style>'
      + `<img src="${url}" onload="window.focus();window.print()">`,
    );
    w.document.close();
  }

  // ── Trick card sheets ───────────────────────────────────────────────────────
  // A4 halves into two A5 and quarters into four A6, so 1, 2 and 4 cards all tile one sheet with
  // nothing left over — which is why those are the three counts on offer and 3 is not. Everything
  // below is laid out in the poster's own 1080×1527 design space — so px·0.194 ≈ mm still holds —
  // and the canvas is scaled up by the transform on the way out.
  /** What the printer has to be told. A landscape sheet sent to a portrait page is letterboxed —
   *  printed at half size inside two white bands — and nothing on screen would have warned of it. */
  $: sheetOrientation = (cardSheetLandscape ? 'landscape' : 'portrait') as 'landscape' | 'portrait';
  // Which way up the SHEET goes — at EVERY card count, not just 2-up.
  //
  // It was gated to 2-up on the reasoning that only there does the shape change. That is true of the
  // CARD's proportions and beside the point: a host may simply want to print landscape, and a
  // landscape sheet is a legitimate choice at one, two or four to a page. Turning the paper turns
  // every card on it — four landscape A6, two portrait A5, one landscape A4.
  //
  // ── It stores the SHEET; the control means the CARD ────────────────────────
  // The stored field is deliberately left alone. A host may already have printed from a saved
  // design, and the sheet is what reaches `@page { size: A4 … }` and the PDF — so changing what is
  // written here would change what comes out of a printer for a design nobody touched. What changed
  // is the control above it: it now shows and sets the CARD's orientation, and the sheet is derived
  // from that. See cardLandscapeOn / sheetLandscapeFor in $lib/posterFlow for the table and why
  // 2-up is the one that inverts.
  let cardSheetLandscape = false;
  // How the sheet is divided, the paper scale that follows from it, and which way up it goes — one
  // value, worked out by the renderer, so the preview, the drag outlines and the printed sheet
  // cannot disagree about the size of a card. See sheetGeom() for why the scale follows the card's
  // HEIGHT rather than its area.
  $: cardSheet = sheetGeom(cardsPerSheet, cardSheetLandscape);
  $: sheetW = cardSheet.sheetW;
  $: sheetH = cardSheet.sheetH;
  /** What the host is actually choosing: the shape of the CARD in their hand. */
  $: cardLandscape = cardLandscapeOn(cardsPerSheet, cardSheetLandscape);
  /** Press Portrait or Landscape and get portrait or landscape CARDS, at every size. */
  const setCardLandscape = (want: boolean) => { cardSheetLandscape = sheetLandscapeFor(cardsPerSheet, want); };
  /** Changing how many go on a sheet KEEPS the card shape the host chose, by turning the paper
   *  under them where it has to.
   *
   *  In the click handler rather than in a reactive statement, and that is the whole point: a `$:`
   *  keyed on cardsPerSheet fires once on mount, which would rewrite the stored sheet orientation of
   *  every saved design the moment it was opened — and that design may already be printed. This only
   *  ever runs under a host's finger. */
  function setCardsPerSheet(n: CardsPerSheet) {
    if (n === cardsPerSheet) return;
    const want = cardLandscape;
    cardsPerSheet = n;
    cardSheetLandscape = sheetLandscapeFor(n, want);
  }
  /** What the chosen size and orientation actually produce, said in card shapes rather than in
   *  paper sizes — "two landscape A5s" is the thing being decided; "A4 landscape" is how it gets
   *  there. */
  $: cardShape = cardShapeNote(cardsPerSheet, cardLandscape);

  // Which sets actually go to the printer. Stored as EXCLUSIONS so a set added to the trick list
  // later is printed by default rather than silently left out of the stack.
  $: printSets = sheets.filter((s) => !cardSkip.includes(s.key));
  $: cardsState = cardsTabState({ setCount: sheets.length, printableCount: printSets.length });
  // The previewed sheet is an index into the INCLUDED sets, so excluding the one on screen moves the
  // preview to a neighbour instead of leaving it pointing past the end.
  $: previewIdx = Math.min(sheetIdx, Math.max(0, printSets.length - 1));
  $: activeSheet = printSets[previewIdx] ?? null;
  // Heading follows the design the host already made until they say otherwise.
  $: cardHeading = cardTitle.trim() || headline.trim() || eventName || 'Our Event';
  // The tick belongs to the trick list: the editor chose it, the app shows it, the card prints it.
  $: cardGlyph = cleanTick(savedTick) ?? tickFor(eventType);
  // Emoji sit outside the BMP and are painted in colour by the device's own font, so they ignore
  // the card's ink — the trade-off documented in challenges.ts. Surface it rather than let someone
  // discover it at the printer.
  $: tickIsEmoji = ([...cardGlyph][0]?.codePointAt(0) ?? 0) > 0xffff;
  // ── What one card is printed with ─────────────────────────────────────
  /** Everything the card renderer needs that is not the canvas, the set, or an image.
   *
   *  ONE object, built HERE where the state lives, rather than the renderer reaching back into the
   *  component for it — which is what it used to do, and why a draw site could print a whole sheet
   *  in whatever card was last previewed. Nothing in here is per-card: `base`, `overrides` and
   *  `baseKey` are the inputs to the rule that decides which card gets which look, and the renderer
   *  applies it per set.
   *
   *  Every dependency is named SYNTACTICALLY in this literal, which is the one place that now has
   *  to be true: `$:` cannot see state read inside a called function, and every reactive value
   *  below reads this one. cardBaseOf() takes its parts as arguments for exactly that reason. */
  let cardOpts: CardRenderOpts;
  $: cardOpts = {
    oneDesign: cardOneDesign,
    base: cardBaseOf(cardCTitle, cardCBody, cardCCode, cardCBg, cardLayout),
    overrides: cardSets, baseKey: sheets[0]?.key ?? null, setCount: sheets.length,
    typeSetKey, titleFace,
    posterInk: { headline: cHeadline, steps: cSteps, code: cCode },
    posterBg: cBg,
    // Written out rather than calling bgSrc(), so Svelte sees bgMode/customBgUrl as dependencies.
    posterBgSrc: bgMode === 'custom' ? customBgUrl : bgMode === 'event' ? themeImageUrl : null,
    heading: cardHeading, glyph: cardGlyph, inkSaver: cardInkSaver, round: cardRound, cutLines: cardCutLines, ids: cardIds,
    labelPos: cardLabelPos, labelSize: cardLabelSize,
    showQr: cardShowQr, showLink: cardShowLink, caption: cardCaption, codeMode: cardCodeMode,
    cardsPerSheet, sheetLandscape: cardSheetLandscape,
    joinCode, cleanUrl,
    decorKind: decorUsed, decorPos, decorScale, decorColour,
  };
  /** The card on screen, for the panel and for the preview — the same function drawSheet() applies
   *  to every OTHER card, applied here to the one whose controls are on screen. */
  $: cardActive = cardPaintFor(activeSheet, cardOpts);
  $: cardDesign = cardActive.design;
  $: cardBgHex = cardActive.bgHex;
  $: cardUseImage = cardActive.useImage;
  $: cardGround = cardActive.ground;
  $: cardDark = cardActive.dark;
  $: cardInk = cardActive.ink;
  $: cardTickInk = cardActive.tickInk;
  // The decoration: blank means "not chosen", so the event type picks one — a wedding card starts
  // with birds without the host doing anything, and can still be turned off.
  $: decorUsed = (decorKind || decorFor(eventType)) as DecorKind;
  $: decorInk = decorColour || cardInk.title;
  $: decorPositional = DECOR_KINDS.find((d) => d.key === decorUsed)?.positional ?? false;

  // The shot list lives on the event, not in the poster design, so the card sheet fetches it
  // itself — the organizer payload carries both the sets and the event type that picks the default
  // tick. Same raw-fetch idiom as loadPosterQr: a failure just means no cards on offer.
  async function loadMissions() {
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(joinCode)}/admin`,
        { credentials: 'same-origin', headers: orgCode ? { 'X-Organizer-Code': orgCode } : {} });
      const d = await r.json();
      eventType = typeof d?.eventType === 'string' ? d.eventType : null;
      savedTick = typeof d?.challengeTick === 'string' ? d.challengeTick : null;
      sheets = Array.isArray(d?.challengeSets)
        ? (d.challengeSets as MissionSet[]).filter((s) => !!s?.items?.length) : [];
      sheetIdx = Math.min(sheetIdx, Math.max(0, sheets.length - 1));
    } catch { /* no cards on offer */ }
  }

  // ── Card drag surface ───────────────────────────────────────────────────────
  // The overlay sits over the FIRST card on the sheet; every other card is a copy of it, so
  // arranging one arranges them all.
  let cardBounds: Record<string, Rect> = { title: ZERO_RECT, qr: ZERO_RECT };
  function measureCardBounds(): Record<string, Rect> {
    const ctx = measureCtx();
    if (!ctx) return { title: ZERO_RECT, qr: ZERO_RECT, list: ZERO_RECT };
    const g = cardBoxAt(0, 0, cardSheet);
    const t = titleGeom(ctx, g, activeSheet, cardOpts);
    const j = joinGeom(ctx, g, activeSheet, cardOpts);
    // The rule under the title is where the list starts measuring from, and drawCard computes it
    // the same way — 10u below the title block. Passing it in keeps listGeom free of the title's
    // internals while both callers still agree on where the list begins.
    const ruleY = t.rect.y + t.rect.h + 10 * g.u;
    const l = activeSheet?.items.length ? listGeom(ctx, g, activeSheet, cardOpts, t, j, ruleY) : null;
    return { title: t.rect, qr: j ? j.rect : ZERO_RECT, list: l ? l.rect : ZERO_RECT };
  }
  // Same dependency-by-reference idea as the poster's bounds, gathered into ONE tracked value:
  // everything that changes a card's footprint is named here, and the measurements below reference
  // it through dep() — see $lib/reactive for why a call and not `void x` or a bare comma operand,
  // each of which one half of the toolchain throws away.
  // It is `cardOpts` wholesale rather than a hand-picked list: every input the renderer measures
  // from is in there by construction, so a field added to the renderer cannot be forgotten here.
  // cardOneDesign and cardSets among them — which card is on screen decides which LAYOUT the
  // outlines are measured from. A colour change remeasures needlessly; measuring is two
  // measureText calls on a cached context, and the alternative is a list that goes stale.
  // fontsReady among them for the reason the poster's bounds names it: a card measured before the
  // faces land keeps Arial metrics, and its drag outlines then sit wrong until the next edit.
  $: cardMeasure = JSON.stringify([cardOpts, cardSheet, activeSheet?.key, mounted, fontsReady]);
  $: cardGeomBox = (dep(cardMeasure), cardBoxAt(0, 0, cardSheet));
  $: cardBounds = (dep(cardMeasure), measureCardBounds());
  const cardSurface: Surface = {
    // The card already clamps to this at DRAW time (placeOnCard); giving the drag the same number
    // means the outline you are moving and the thing that gets printed agree while you move it,
    // rather than the block snapping back after you let go.
    pad: CARD_PAD,
    stage: () => cardStageEl,
    // The stage covers one card, and a card Box's fractions are of the card — so the surface's
    // design space IS the card, whichever of the three sizes it currently is.
    get w() { return cardGeomBox.cw; },
    get h() { return cardGeomBox.ch; },
    rects: () => {
      // The measured rects are in SHEET space; the stage starts at the card's top-left.
      const g = cardGeomBox;
      const out: Record<string, Rect> = {};
      for (const k of Object.keys(cardBounds)) { const r = cardBounds[k]; out[k] = { x: r.x - g.x0, y: r.y - g.y0, w: r.w, h: r.h }; }
      return out;
    },
    box: (k) => cardDesign.layout[k as CardElKey],
    // The QR floor is the same hand-held one the card already used; sizes are in A6 px and scale up
    // with the paper, so the printed code never drops below it whatever the sheet layout.
    // The list is a row of TEXT, so its range is a text range — not the 14–90 a title gets, which
    // would let one trick fill the card. listGeom clamps again against what actually fits, so these
    // are the outer bounds of the ask rather than a promise.
    limits: (k) => (k === 'qr' ? [QR_MIN_PX, CARD_QR_MAX] : k === 'list' ? [11, 28] : [14, 90]),
    /* The list moves UP AND DOWN only. Its region is still whatever the title and the join block
       leave — listGeom clamps it to that at both ends, so a drag can carry it around inside the gap
       but never into either block. Sideways is locked because it would do nothing: the list spans
       the full printable width, so there is no room beside it to move into. */
    lockX: (k) => k === 'list',
    // Through the one writer, so a drag changes the card the host is looking at rather than always
    // Card A — patchCardDesign() is where "which card am I editing" is decided.
    move: (k, x, y) => patchCardLayout(k, { x, y }),
    size: (k, px) => patchCardLayout(k, { size: px }),
    remeasure: () => { cardBounds = measureCardBounds(); },
    redraw: () => scheduleCardRedraw(),
    select: (k) => (cardSelectedKey = k as CardElKey | null),
    selected: () => cardSelectedKey,
    dragging: (k) => (cardDragKey = k as CardElKey | null),
  };
  function startCardDrag(key: CardElKey, mode: 'move' | 'resize', e: PointerEvent) { dragOn(cardSurface, key, mode, e); }
  /** One element of the card being edited. */
  const patchCardLayout = (k: string, patch: Partial<Box>) => {
    const l = cardDesign.layout;
    patchCardDesign({ layout: { ...l, [k]: { ...l[k as CardElKey], ...patch } } });
  };
  function resetCardLayout() { patchCardDesign({ layout: cloneCardLayout(DEFAULT_CARD_LAYOUT) }); cardBounds = measureCardBounds(); scheduleCardRedraw(); }
  // The rects the overlay draws, in the stage's own coordinates. A reactive DECLARATION rather than
  // a call in the markup: the template has to re-run when the measurement changes, and a method on
  // a const object is not something Svelte can see changing.
  $: cardRects = (dep(cardBounds, cardGeomBox), cardSurface.rects());
  $: cardElements = ([
    { key: 'title', label: 'Title', show: true },
    { key: 'qr', label: 'QR / join', show: cardBounds.qr.w > 0 },
    // Only where there is a list to size. A card printed with no tricks on it has an element whose
    // outline covers half the card and whose grip does nothing.
    { key: 'list', label: 'Trick list', show: (cardBounds.list?.w ?? 0) > 0 },
  ] as { key: CardElKey; label: string; show: boolean }[]).filter((e) => e.show);

  // The editor previews ONE card, not the sheet it will be printed on. Four-up, a card was a
  // quarter of a 320px-wide thumbnail — far too small to judge a 12px trick line on a phone — and
  // the other three cards are identical copies of it, so they showed nothing the first one didn't.
  // PRINTING and every export are unaffected: they go through sheetCanvas()/drawSheet(), which
  // still tile the sheet 4/2/1-up with the cut guides. Only what the editor shows changed.
  /** Draw the previewed card OFF screen, then put it up in one go.
   *
   *  It used to draw straight into the visible canvas, and the first thing it did was set
   *  `canvas.width` — which wipes it — and fill paper white. The background image and the QR are
   *  both awaited AFTER that, so switching between cards showed a full-size blank white card for as
   *  long as those took: a hard white flash on every press, worst on the first view of each set,
   *  when nothing is cached.
   *
   *  Painting into a detached canvas and blitting at the end means the visible one is never in a
   *  half-drawn state — there is no frame between the old card and the new one. Cheaper than
   *  preloading too: nothing has to guess which set gets looked at next. */
  async function drawCards() {
    const set = activeSheet;                 // captured: an await below must not swap sheets mid-draw
    if (!cardCanvas || !set) return;
    const g = cardBoxAt(0, 0, cardSheet);
    const w = Math.round(g.cw * CARD_SCALE);
    const h = Math.round(g.ch * CARD_SCALE);
    const off = document.createElement('canvas');
    off.width = w; off.height = h;
    const ctx = off.getContext('2d'); if (!ctx) return;
    // drawCard() lays out in SHEET space — a gutter, then the card — so the card's own top-left is
    // shifted onto the canvas origin and the gutter is simply cropped off.
    ctx.setTransform(CARD_SCALE, 0, 0, CARD_SCALE, -g.x0 * CARD_SCALE, -g.y0 * CARD_SCALE);
    // Paper white behind it: the card clips its background to its rounded corners, and without this
    // those corners are transparent — holes showing the app's surface rather than a cut card.
    ctx.fillStyle = '#ffffff'; ctx.fillRect(g.x0, g.y0, g.cw, g.ch);
    let bg: HTMLImageElement | null = null;
    if (cardPaintFor(set, cardOpts).useImage) {
      const src = bgSrc();
      if (src) { try { bg = await loadImg(src); } catch { bg = null; } }
    }
    // The previewed set's own QR, for the same reason drawSheet uses it: a card carrying the wrong
    // set sends a guest to somebody else's trick list.
    const qr = await loadImg(await qrForSet(sheets.length > 1 ? set.key : null));
    drawCard(ctx, set, { ox: 0, oy: 0, sheet: cardSheet, qrImage: qr, bg }, cardOpts);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    // Another redraw may have started and finished while this one was awaiting; the last to arrive
    // is the one the host asked for, and re-checking the sheet here is what stops an older draw
    // painting over a newer one.
    if (activeSheet !== set || !cardCanvas) return;
    const vis = cardCanvas.getContext('2d');
    if (!vis) return;
    if (cardCanvas.width !== w || cardCanvas.height !== h) { cardCanvas.width = w; cardCanvas.height = h; }
    vis.clearRect(0, 0, w, h);
    vis.drawImage(off, 0, 0);
    cardsDrawn = true;
  }
  let cardRaf = 0;
  function scheduleCardRedraw() { if (cardRaf) return; cardRaf = requestAnimationFrame(() => { cardRaf = 0; drawCards().catch(() => {}); }); }
  // Everything a sheet is drawn from, in one value — and only while the cards tab is open, because
  // a 2× sheet is the expensive redraw of the two and the poster has its own loop. It has to be a
  // reactive DECLARATION that the redraw then reads in its condition: a signature VALUE changing is
  // what schedules the redraw, which cannot be lost the way a bare dependency reference can — see
  // $lib/reactive.
  $: cardSig = mounted && view === 'cards'
    ? JSON.stringify([cfg, customBgUrl, activeSheet, sheets.length, cardGlyph, cardInk, cardTickInk, cardBgHex, cardUseImage, decorUsed, decorInk]) : '';
  $: if (cardSig) scheduleCardRedraw();

  /** A sheet on its own canvas, so an export never depends on which one is being previewed. */
  async function sheetCanvas(set: MissionSet): Promise<HTMLCanvasElement> {
    const c = document.createElement('canvas');
    c.width = sheetW * CARD_SCALE; c.height = sheetH * CARD_SCALE;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no canvas context');
    // THIS set's QR, not the previewed one — printing the whole stack has to give every page its
    // own code, or every card in the house sends guests to the set that happened to be on screen.
    // Resolved here rather than in the renderer: it is an authenticated fetch.
    await drawSheet(ctx, set, { ...cardOpts, qrSrc: await qrForSet(sheets.length > 1 ? set.key : null), loadImage: loadImg });
    return c;
  }
  /** Print one sheet or the whole stack — a page per set, so a host can run off one table's cards
   *  on their own or take everything to the printer in one job. */
  async function printSheets(list: MissionSet[]) {
    if (!list.length) return;
    try {
      const pages: string[] = [];
      for (const s of list) pages.push((await sheetCanvas(s)).toDataURL('image/png'));
      const w = window.open('', '_blank');
      if (!w) { showToast('Allow pop-ups to print', true); return; }
      // Every page has to decode before print() fires, or a multi-page job comes out with blank
      // pages. The break goes BEFORE each image after the first, so there is no trailing blank.
      w.document.write(
        `<style>@page{size:A4 ${sheetOrientation};margin:0}body{margin:0}img{width:100%;display:block}img+img{page-break-before:always}</style>`
        + `<script>let n=0;function k(){if(++n===${pages.length}){window.focus();window.print();}}<\/script>`
        + pages.map((u) => `<img src="${u}" onload="k()">`).join(''));
      w.document.close();
    } catch { showToast('Could not build the cards', true); }
  }
  async function exportSheetPng() {
    const set = activeSheet; if (!set) return;
    // PNG rather than JPG: JPEG ringing around a 12px mission line is visible on paper.
    (await sheetCanvas(set)).toBlob((b) => b && download(b, 'png', `cards-${set.key}`), 'image/png');
  }
  async function exportSheetsPdf(list: MissionSet[]) {
    if (!list.length) return;
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: sheetOrientation, unit: 'pt', format: 'a4' });
      for (let i = 0; i < list.length; i++) {
        if (i) pdf.addPage();
        const c = await sheetCanvas(list[i]);
        pdf.addImage(c.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pdf.internal.pageSize.getWidth(), pdf.internal.pageSize.getHeight());
      }
      pdf.save(`${slug}-${list.length > 1 ? 'mission-cards' : `cards-${list[0].key}`}.pdf`);
    } catch { showToast('Could not build the PDF', true); }
  }
  // The label each colour answers to. It is no longer a list that gets RENDERED as a list — the
  // swatch sits on the field it colours — but the names still have to exist in one place, because
  // the image-swatch strip has to be able to say which control it is about to write to.
  type ColorRow = { key: CTarget; label: string; get: () => string };
  const COLOR_ROWS: { key: PosterColorTarget; label: string; get: () => string }[] = [
    { key: 'headline', label: 'Title', get: () => cHeadline },
    // Blank means "the title's", so the picker shows the colour the line is ACTUALLY printed in —
    // the same convention the card rows below use.
    { key: 'headTop', label: 'Small line above', get: () => cHeadTop || ink.headline },
    { key: 'headBottom', label: 'Small line below', get: () => cHeadBottom || ink.headline },
    { key: 'names', label: 'Names', get: () => cNames || ink.headline },
    { key: 'message', label: 'Message', get: () => cMessage },
    { key: 'steps', label: 'How-to', get: () => cSteps },
    { key: 'code', label: 'Code / URL', get: () => cCode },
    { key: 'footer', label: 'Footer URL', get: () => cFooter },
  ];
  // The card's own colour rows — the same control, the same swatch picker, the same activeTarget.
  // A blank override means "follow the poster", so the picker shows the colour the card is ACTUALLY
  // printed in (after the readable pass) and editing it pins that row to the card.
  $: CARD_COLOR_ROWS = (dep(cardDesign), [
    { key: 'cardTitle', label: 'Title', get: () => cardDesign.cTitle || cardInk.title },
    { key: 'cardBody', label: 'Trick list', get: () => cardDesign.cBody || cardInk.body },
    { key: 'cardCode', label: 'Code / link', get: () => cardDesign.cCode || cardInk.code },
    { key: 'cardBg', label: 'Card background', get: () => cardDesign.cBg || cardBgHex },
  ] as ColorRow[]);
  // ── Controls for things that are switched off ──────────────────────────────
  // A colour picker for an element that is not being printed is dead weight on a phone, so a row
  // is hidden while its element is off. The stored VALUE is deliberately left alone — nothing here
  // resets to a default — so switching the element back on brings the host's colour back exactly
  // as they left it. That is why this filters at the point of display rather than clearing state.
  $: VISIBLE_COLOR_ROWS = COLOR_ROWS.filter((r) =>
    r.key === 'headTop' ? !!headlineTop.trim()
    : r.key === 'headBottom' ? !!headlineBottom.trim()
    : r.key === 'names' ? !!names.trim()
    : r.key === 'message' ? !!message.trim()
    : r.key === 'steps' ? !!stepsText.trim()
    : r.key === 'code' ? codeDisplay !== 'none'
    : r.key === 'footer' ? showFooterUrl
    : true);
  // The same rule on the card. Its code/link row paints only the join block's code, which is drawn
  // just for cardShowLink and only when the design shows a code or a link at all; its background
  // row is overruled outright by ink-saver's forced white.
  $: VISIBLE_CARD_COLOR_ROWS = CARD_COLOR_ROWS.filter((r) =>
    r.key === 'cardCode' ? cardShowLink
    : r.key === 'cardBg' ? !cardInkSaver
    : true);
  // The rows whose control is ON SCREEN, which is not the same question as which are being printed.
  // In guided mode that is one step's worth — Words, or Join — and in "show all controls" every
  // step's block renders at once, so it is all of them. colorRowsForStep() holds the mapping.
  //
  // One list, three jobs: what the swatch strip is labelled with, what it writes to, and what the
  // re-point below is allowed to choose.
  let paletteRows: ColorRow[] = [];
  $: paletteRows = view === 'cards'
    ? colorRowsForStep(cGuided ? cStep : null, VISIBLE_CARD_COLOR_ROWS, CARD_COLOR_STEP)
    : colorRowsForStep(pGuided ? pStep : null, VISIBLE_COLOR_ROWS);
  /** The rows the Colour step still RENDERS as a list: the two with no field to sit beside.
   *
   *  Off the same table as everything else rather than a second hand-written pair — a colour moved
   *  onto a field and left in the list would be the duplicate swatch strip this whole pattern
   *  exists to remove. Not gated on the guided mode: in "show me every control" all five blocks
   *  render at once, so the fields carrying the other two dots are on screen too. */
  $: CARD_LIST_ROWS = colorRowsForStep(C_COLOUR_STEP, VISIBLE_CARD_COLOR_ROWS, CARD_COLOR_STEP);
  // The image swatches write to whichever row is active, so a row that is not on screen would
  // quietly swallow colours with nothing in front of the host changing. Point it at the first row
  // that IS — which also covers walking from Words to Join, and fixes the palette heading reading
  // blank on the poster tab after a card colour was touched.
  $: { const aim = aimedColorTarget(activeTarget, paletteRows); if (aim !== activeTarget) activeTarget = aim; }
  /** What the swatch strip says it is about to colour. Blank means nothing on this screen takes a
   *  colour at all (Join, with both the code and the footer URL switched off) — and the strip then
   *  does not render, rather than offering swatches with nowhere to go. */
  $: paletteLabel = paletteRows.find((r) => r.key === activeTarget)?.label ?? '';
  $: cardColoursSet = !!(cardDesign.cTitle || cardDesign.cBody || cardDesign.cCode || cardDesign.cBg);
  const clearCardColours = () => patchCardDesign({ cTitle: '', cBody: '', cCode: '', cBg: '' });
  const onDecorColour = (e: Event) => { decorColour = (e.target as HTMLInputElement).value; };
  /** A press on something that is not ready. Never silence — an aria-disabled control still takes
   *  the tap (that is the point of it), so it has to answer, and where there is somewhere that
   *  would fix it, go there. */
  function blocked(why: string, fix?: () => void) {
    showToast(why, true);
    fix?.();
  }
  // One line at the foot of every tab: where this tab's output is printed from, and the one thing
  // about the designer that is not visible on screen — that it saves as you go.
  //
  // It used to carry more, and the more was filler. "Guests scan it to join" told a host who was
  // designing a sign with a QR code on it what a QR code is for. "Cut along the dashed lines and
  // drop a card at each place setting" is already said, in more detail, by the panel two inches
  // above it. "Everything this design makes, in one place" described the tab the host had just
  // pressed. What is left is the same shape on every tab, which is also what stops the three
  // drifting apart again.
  //
  // The pointer to the Print tab stays, on purpose: printing USED to live on these two tabs, and a
  // host who is used to finding it there has to be told once. The autosave line stays because
  // nothing on screen says it.
  // "Changes save automatically" is a promise, and while it is broken the footer must not repeat it.
  $: footHint = saveError ? saveError : view === 'print'
    ? 'Changes save automatically.'
    : view === 'cards'
      ? (cardsState === 'none'
          ? 'A trick list prints as table cards, here. Changes save automatically.'
          : 'Print them from the Print tab. Changes save automatically.')
      : 'Print it, or download it, from the Print tab. Changes save automatically.';
  const toggleSet = (key: string) => {
    cardSkip = cardSkip.includes(key) ? cardSkip.filter((k) => k !== key) : [...cardSkip, key];
  };
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<!-- A click anywhere that is not one of the armed buttons backs out of that confirm. Both buttons
     stop propagation, so this only ever sees clicks that are NOT the second press. -->
<svelte:window on:keydown={onKeydown} on:click={() => { restyleArmed = false; resetArmed = false; binArmed = null; }}
               on:resize={resizeToStage} />

<div class="back" on:pointerdown={onBackPointerDown} on:click={onBackClick} role="dialog" aria-modal="true" aria-label="Event poster">
  <div class="sheet" class:fs={fsEdit} tabindex="-1" use:modalFocus>
    <div class="head"><span class="h-t">{fsEdit ? 'Arrange layout' : view === 'cards' ? 'Trick cards' : view === 'print' ? 'Print' : 'Event poster'}</span>
      <div class="head-actions">
        <!-- None of these belong on the Print tab. Undo, redo, Arrange, Reset layout and Start again
             all act on a DESIGN, and Print is not a design surface — it is the place you send a
             finished one to paper. Offering "Start again" beside a print button is offering to throw
             the thing away at the moment of using it, and an undo there has nothing to undo. -->
        {#if view !== 'print'}
        <!-- Full-screen arranging is the poster's; a card is arranged at its own size in the preview. -->
        <!-- Always visible, including mid-drag and in full screen. The existing pair sit inside the
             Arrange controls, which is exactly where you cannot see them while dragging on the
             preview — the one moment an undo is worth anything. -->
        <!-- aria-disabled, not disabled. A disabled button consumes no events at all, so the tap
             falls through to whatever is behind it — on a phone that is text, and the browser
             answers with its own Copy/Search menu over the app. undo()/redo() already return on an
             empty stack, so the press is simply a no-op. -->
        <button class="tog undo" on:click={undo} aria-disabled={!undoStack.length || undefined}
                aria-label="Undo" title="Undo the last change (Ctrl/⌘+Z)">↶</button>
        <button class="tog undo" on:click={redo} aria-disabled={!redoStack.length || undefined}
                aria-label="Redo" title="Redo (Ctrl/⌘+Shift+Z)">↷</button>
        <!-- The word drops below 520px along with Reset's, and for the same reason: with a third
             control in here the labels no longer all fit, and measured at 400px this was the one
             that could give it up — ⛶ is the standard glyph for it, it is reversible, and the
             aria-label and title both still say what it does. -->
        <!-- The gesture summary that the retired Place step used to carry as a paragraph. It is a
             `title` rather than a line in the panel because the controls now say it themselves: a
             selected element wears its name, a pencil, a bin, a ✕ and a ⤡ corner, and "drag it,
             pinch it" is what those are for. This is the reminder, not the teaching. -->
        {#if view === 'poster'}<button class="tog" on:click={() => (fsEdit = !fsEdit)} aria-label={fsEdit ? 'Exit full screen' : 'Full-screen layout'} title={fsEdit ? 'Exit full screen' : `Full-screen layout — drag to move, ${coarse ? 'pinch' : 'drag ⤡'} to resize`}>{fsEdit ? '✓' : '⛶'}<span class="tog-w">{' '}{fsEdit ? 'Done' : 'Arrange'}</span></button>{/if}
        <!-- Resetting the arrangement belongs with undo, redo and Start again: they are the controls
             that change the whole design at once, and this one throws away every element the host
             dragged and sized. It was a plain one-press button in the Layout group with no
             confirmation at all, beside a Start again that has always asked twice.
             ONE button, for the tab you are on — resetTargetFor() in $lib/posterFlow. -->
        {#if resetTarget}
          <button class="tog reset" class:armed={resetArmed}
                  on:click|stopPropagation={pressReset}
                  aria-label={resetArmed
                    ? 'Press again to reset the layout'
                    : resetTarget === 'cards' ? 'Reset card layout' : 'Reset layout'}
                  title={resetArmed
                    ? 'Press again to put every element back where it started'
                    : resetTarget === 'cards'
                      ? 'Put every element on the card back where it started'
                      : 'Put every element on the poster back where it started'}>
            <span class="ra-stack" aria-hidden="true">
              <!-- Two arrows in a cycle, not the single ↺: beside Undo and Redo, which are also
                   curved single arrows, one more of them read as a third undo rather than as
                   "put it all back". -->
              <span class="ra-l" class:off={resetArmed}>🔄<span class="tog-w">{' '}{resetTarget === 'cards' ? 'Reset card layout' : 'Reset layout'}</span></span>
              <span class="ra-l" class:off={!resetArmed}>⚠<span class="tog-w">{' '}Sure?</span></span>
            </span>
          </button>
        {/if}
        <!-- Starting again sits with undo and redo because it is the same family of control: the
             ones that change the whole design at once. It used to live at the foot of the panel,
             below the export row, which is the furthest point from the header it belongs to.
             Hidden while arranging full screen, where the header is only the stage's own chrome. -->
        {#if !fsEdit}
          <button class="tog restart" class:armed={restyleArmed}
                  on:click|stopPropagation={() => { resetArmed = false; if (restyleArmed) { restyleArmed = false; dispatch('restyle'); } else restyleArmed = true; }}
                  aria-label={restyleArmed ? 'Press again to replace this design' : 'Start again from a design'}
                  title={restyleArmed ? 'Press again to replace this design' : 'Pick a different design — replaces this one'}>
            <!-- Both labels always live in the box, stacked, with the inactive one hidden rather
                 than removed. The button then measures the same in either state, so it cannot jump
                 wider under the finger between the arming press and the confirming one. -->
            <span class="ra-stack" aria-hidden="true">
              <span class="ra-l" class:off={restyleArmed}>↺ Start again</span>
              <span class="ra-l" class:off={!restyleArmed}>⚠ Sure?</span>
            </span>
          </button>
        {/if}
        {/if}
      </div>
      <!-- OUTSIDE .head-actions on purpose. Below 560px the header wraps, and the close button has
           to stay on the first row beside the title — top-right is where a modal's ✕ lives, and
           finding it on a second row under the controls is worse than not seeing it. -->
      {#if !fsEdit}<button class="x" on:click={() => dispatch('close')} aria-label="Close">✕</button>{/if}

      <!-- The warning the header button has no room for, shown only while it is armed — which is
           the only moment it has anything to say. The armed button is already a filled danger
           control; this is what it is warning ABOUT.
           INSIDE the header and out of flow: as a block between the header and the tabs it pushed
           the entire designer down on arming and snapped it back on disarming, so the thing the
           host was about to press moved out from under the cursor. Absolutely positioned against
           the sticky header it takes no space at all, and the only thing it covers is the tab row —
           not the armed button, not the other header controls, not the close box.
           role="alert" so taking it out of the visual flow does not take it out of the
           accessibility tree. -->
      {#if restyleArmed && !fsEdit}
        <p class="armed-note" role="alert">
          Press again to replace this design. Your poster, trick cards and event colours are all
          redone, and this one is not kept.
        </p>
      {/if}
      <!-- The same treatment for the same reason: at 400px the header button is down to a single
           glyph, so what it is warning about has to be said somewhere with room for it. Only one of
           these can ever be on screen — arming either confirm disarms the other. -->
      {#if resetArmed}
        <p class="armed-note" role="alert">
          Press again to put every element on {resetTarget === 'cards' ? 'the card' : 'the poster'} back
          where it started. Your words, colours and artwork are kept.
        </p>
      {/if}
    </div>

    <!-- Two outputs of one design — the A4 poster for the room, A6 cards for the tables — and the
         one place either of them is printed from. Printing used to be duplicated: an export row at
         the foot of each tab, with different capabilities, plus a front-and-back dialog stacked on
         top of the designer. All three tabs are always here; see posterTabs(). -->
    {#if !fsEdit}
      <div class="tabs">
        {#each TABS as t (t.key)}
          <button class="tab" class:on={view === t.key} aria-pressed={view === t.key}
                  on:click={() => (view = t.key)}>{t.emoji} {t.label}</button>
        {/each}
      </div>
    {/if}

    <div class="poster-body" class:fs={fsEdit} class:printing={view === 'print'}>
    <div class="preview">
      {#if view === 'cards' ? (!!activeSheet && !cardsDrawn) : busy}<div class="spinner" aria-label={view === 'cards' ? 'Building cards' : 'Building poster'}></div>{/if}
      {#if view === 'cards' && !activeSheet}<p class="empty">{sheets.length ? 'No card is switched on to print.' : 'No trick list on this event yet.'}</p>{/if}
      <!-- Both previews stay mounted so switching tabs costs nothing and the poster keeps its
           measured drag bounds; the inactive one is just hidden. -->
      <div class="canvas-wrap" class:hidden={view !== 'cards' || !activeSheet || !cardsDrawn}>
        <canvas bind:this={cardCanvas}></canvas>
        <!-- The canvas IS one card, so the drag stage simply covers it. It used to be positioned
             over the first card of the sheet; the rects it lays out are still measured in SHEET
             space and offset by cardGeomBox, which is why that is still the surface's origin. -->
        <!-- svelte-ignore a11y-no-static-element-interactions a11y-click-events-have-key-events -->
        <div class="poster-stage card-stage" class:dragging={!!cardDragKey}
             class:holding={!!cardSelectedKey} bind:this={cardStageEl}
             on:pointerdown={(e) => startStagePinch(cardSurface, e)}>
          {#if cardDragKey && snapX !== null}<div class="snap-guide vert" style="left:{snapX * 100}%" aria-hidden="true"></div>{/if}
          {#if cardDragKey && snapY !== null}<div class="snap-guide horz" style="top:{snapY * 100}%" aria-hidden="true"></div>{/if}
          <!-- The same cluster the poster stage uses, in the card's own design space. The card has
               no inline editor, so no element here carries a pencil — its title is typed in the
               panel below, where the fallback to the poster's headline can be explained. -->
          {#if cardSelectedElControls && !cardDragKey}
            <PosterElControls
              label={cardSelectedElControls.label} rightPct={cardSelectedElControls.rightPct}
              topPct={cardSelectedElControls.topPct} bottomPct={cardSelectedElControls.bottomPct}
              below={cardSelectedElControls.below}
              binText={cardSelectedElControls.bin
                ? binLabel(cardSelectedElControls.bin, cardSelectedElControls.label, binArmed === cardSelectedElControls.key)
                : null}
              armed={binArmed === cardSelectedElControls.key}
              onBin={() => pressBin(cardSelectedElControls?.key ?? '')}
              onSettings={cardElStep(cardSelectedElControls.key) === null
                ? null
                : () => void showElSettings(cardElStep(cardSelectedElControls?.key ?? ''), true,
                                            cardSelectedElControls?.key ?? '')}
              onRelease={releaseSelection} />
          {/if}
          {#each cardElements as el (el.key)}
            {@const b = cardRects[el.key]}
            {#if b}
              <div class="el-box" class:active={cardDragKey === el.key} class:selected={cardSelectedKey === el.key} class:label-below={(b.y / cardGeomBox.ch) < 0.10}
                style="left:{(b.x / cardGeomBox.cw) * 100}%; top:{(b.y / cardGeomBox.ch) * 100}%; width:{(b.w / cardGeomBox.cw) * 100}%; height:{(b.h / cardGeomBox.ch) * 100}%"
                on:pointerdown={(e) => startCardDrag(el.key, 'move', e)} role="button" tabindex="-1" aria-label="Move {el.label}">
                <span class="el-name">{el.label}</span>
              </div>
              {#if cardSelectedKey === el.key}
                <span class="el-rz" class:active={cardDragKey === el.key}
                  style="left:{((b.x + b.w) / cardGeomBox.cw) * 100}%; top:{((b.y + b.h) / cardGeomBox.ch) * 100}%"
                  on:pointerdown={(e) => startCardDrag(el.key, 'resize', e)} aria-label="Resize {el.label}">⤡</span>
              {/if}
            {/if}
          {/each}
        </div>
      </div>
      <!-- The Print tab keeps the poster in view: it is what most of the buttons below it print,
           and a printing screen with nothing on it to print reads as the wrong screen. -->
      <div class="canvas-wrap" class:hidden={busy || view === 'cards'}>
        <canvas bind:this={canvas}></canvas>
        <!-- Tap an element to select it → its outline, its resize corner ⤡ and its own controls
             (✏️ 🗑️ ✕) appear. Drag anywhere on it to move; drag the corner or pinch to resize.
             While one element is held, tapping another does NOT move the selection — the ✕ and
             Escape are the two ways out. A press on empty stage used to deselect and no longer
             does: the controls a host is reaching for are mostly BELOW the preview, and a tap that
             clipped the stage on the way there would drop the selection they were about to use. -->
        <!-- svelte-ignore a11y-no-static-element-interactions a11y-click-events-have-key-events -->
        <div class="poster-stage" class:dragging={!!dragKey} class:holding={!!selectedKey}
             on:pointerdown={(e) => startStagePinch(posterSurface, e)} bind:this={stageEl}
             on:dblclick={releaseStageOnDoublePress}>
          <!-- The slice of paper a printer cannot reach. Drawn rather than merely enforced, because
               "why won't it go any further" is a worse experience than seeing the line it stops at.
               Purely decorative — it never takes a pointer. -->
          <!-- Two percentages, not one: in `inset` the vertical pair resolves against HEIGHT and the
               horizontal against WIDTH, so the same 5mm is a different percentage on each axis. -->
          <div class="safe-area" style="inset:{(PAGE_PAD / H) * 100}% {(PAGE_PAD / W) * 100}%" aria-hidden="true"></div>
          <!-- Alignment guides: only while a drag is actually snapping, and only the axis in play. -->
          {#if dragKey && snapX !== null}<div class="snap-guide vert" style="left:{snapX * 100}%" aria-hidden="true"></div>{/if}
          {#if dragKey && snapY !== null}<div class="snap-guide horz" style="top:{snapY * 100}%" aria-hidden="true"></div>{/if}
          {#if ghostRect}
            <!-- Where an empty line WOULD land. Without this, "Names" is a field with no visible
                 consequence — you cannot judge whether to fill it in if nothing shows you where it
                 goes. -->
            <div class="el-ghost" aria-hidden="true"
                 style="left:{(ghostRect.x / W) * 100}%; top:{(ghostRect.y / H) * 100}%; width:{(ghostRect.w / W) * 100}%; height:{(ghostRect.h / H) * 100}%">
              <span>{hintLabel} goes here</span>
            </div>
          {/if}
          <!-- The selected element's controls. Hidden while its editor is open — the editor already
               carries its own ✓ Done, the two would land on top of each other for an element near
               the top of the page, and one thing at a time is the point — and hidden while dragging,
               where three chips flying along under the finger are noise over the snap guides that
               actually matter. The name tab comes back for exactly that moment; see .el-name. -->
          {#if selectedEl && !editingKey && !dragKey}
            <PosterElControls
              label={selectedEl.label} rightPct={selectedEl.rightPct}
              topPct={selectedEl.topPct} bottomPct={selectedEl.bottomPct} below={selectedEl.below}
              canEdit={selectedEl.canEdit}
              binText={selectedEl.bin ? binLabel(selectedEl.bin, selectedEl.label, binArmed === selectedEl.key) : null}
              armed={binArmed === selectedEl.key}
              onEdit={() => void openEditor(selectedEl?.key ?? '')}
              onBin={() => pressBin(selectedEl?.key ?? '')}
              rotatedBy={selectedEl.rot}
              onUpright={() => putUpright(selectedEl?.key ?? '')}
              onSettings={posterElStep(selectedEl.key) === null
                ? null
                : () => void showElSettings(posterElStep(selectedEl?.key ?? ''), false,
                                            selectedEl?.key ?? '')}
              onRelease={releaseSelection} />
          {/if}
          <!-- allRects, not `bounds`: a host's own line can be edited in place now too, and those
               are measured in textRects rather than in the fixtures' table. -->
          {#if editingKey && editSpec && allRects[editingKey]}
            {@const eb = allRects[editingKey]}
            <!-- Anchored ON the element, so the words appear where the words are. Sized to the
                 element's own box rather than floated in a corner — the point is that you are
                 editing the thing you can see, not a field that happens to change it. -->
            <div class="el-edit" style="left:2%; top:{Math.min(88, Math.max(2, ((eb.y + eb.h) / H) * 100 + 1))}%; width:96%">
              <!-- A wrapping box rather than a single-line field, so a long title is readable
                   while it is being typed; `grow` keeps it at one row until the words need two.
                   Enter still commits rather than inserting a newline, which is why this is not
                   simply a textarea with default behaviour. -->
              <textarea bind:this={editEl} use:grow rows="1" maxlength={editSpec.max}
                     value={editSpec.get()}
                     placeholder={editSpec.label}
                     aria-label={editSpec.label}
                     on:input={(e) => setEdit(e.currentTarget.value)}
                     on:keydown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endEdit(); } }}
                     on:dblclick={endEditOnDoublePress}
                     on:blur={endEdit}></textarea>
              <button class="ee-done" on:click={endEdit} aria-label="Done">✓</button>
            </div>
          {/if}
          {#each elements as el (el.key)}
            {#if bounds[el.key]}
              {@const b = bounds[el.key]}
              <!-- The whole footprint is the move target; outline shows on hover or when selected. -->
              <!-- label-below: near the top of the stage there is no room above, and the sheet
                   clips anything that overflows it, so the label would simply vanish. -->
              <div class="el-box" class:active={dragKey === el.key} class:selected={selectedKey === el.key} class:warn={el.key === 'qr' && qrTooSmall} class:lock-x={el.axis === 'x'} class:label-below={(b.y / H) < 0.07} class:hinted={hintKey === el.key}
                style="left:{(b.x / W) * 100}%; top:{(b.y / H) * 100}%; width:{(b.w / W) * 100}%; height:{(b.h / H) * 100}%"
                on:pointerdown={(e) => startDrag(el.key, 'move', e)} on:click={() => tapElement(el.key)}
                role="button" tabindex="-1" aria-label="Move {el.label}">
                <span class="el-name">{el.label}{#if el.key === 'qr' && qrTooSmall}{' '}⚠{/if}</span>
              </div>
              {#if el.resizable && selectedKey === el.key}
                <span class="el-rz" class:active={dragKey === el.key}
                  style="left:{((b.x + b.w) / W) * 100}%; top:{((b.y + b.h) / H) * 100}%"
                  on:pointerdown={(e) => startDrag(el.key, 'resize', e)} aria-label="Resize {el.label}">⤡</span>
              {/if}
              <!-- Turning it. Top-LEFT, diagonally opposite the ⤡ corner so the two can never be
                   reached for by mistake, and away from the control cluster, which right-aligns to
                   the element's top-right. canRotate() says which elements have one. -->
              {#if canRotate(el.key) && selectedKey === el.key}
                <span class="el-rot" class:active={dragKey === el.key}
                  style="left:{(b.x / W) * 100}%; top:{(b.y / H) * 100}%"
                  on:pointerdown={(e) => startDrag(el.key, 'rotate', e)}
                  aria-label="Turn {el.label}" title="Drag to turn {el.label}">↻</span>
              {/if}
            {/if}
          {/each}

          <!-- Lines the host added. Same box, same grip, same drag code as everything else. -->
          {#each textItems as t, i (i)}
            {@const tb = textRects[`text:${i}`]}
            {#if tb}
              <div class="el-box" class:active={dragKey === `text:${i}`} class:selected={selectedKey === `text:${i}`}
                style="left:{(tb.x / W) * 100}%; top:{(tb.y / H) * 100}%; width:{(tb.w / W) * 100}%; height:{(tb.h / H) * 100}%"
                on:pointerdown={(e) => startDrag(`text:${i}`, 'move', e)}
                on:click={() => tapElement(`text:${i}`)} role="button" tabindex="-1"
                aria-label="Move your line">
                <span class="el-name">Your line</span>
              </div>
              {#if selectedKey === `text:${i}`}
                <span class="el-rz" class:active={dragKey === `text:${i}`}
                  style="left:{((tb.x + tb.w) / W) * 100}%; top:{((tb.y + tb.h) / H) * 100}%"
                  on:pointerdown={(e) => startDrag(`text:${i}`, 'resize', e)} aria-label="Resize your line">⤡</span>
                <span class="el-rot" class:active={dragKey === `text:${i}`}
                  style="left:{(tb.x / W) * 100}%; top:{(tb.y / H) * 100}%"
                  on:pointerdown={(e) => startDrag(`text:${i}`, 'rotate', e)}
                  aria-label="Turn your line" title="Drag to turn your line">↻</span>
              {/if}
            {/if}
          {/each}

          <!-- Placed motifs. Same box, same grip, same drag code as the text above — a host should
               not have to learn a second way to move a thing on the same page. -->
          {#each decorItems as it, i (i)}
            {@const b = decorRects[`decor:${i}`]}
            {#if b}
              <div class="el-box decor" class:active={dragKey === `decor:${i}`} class:selected={selectedKey === `decor:${i}`}
                style="left:{(b.x / W) * 100}%; top:{(b.y / H) * 100}%; width:{(b.w / W) * 100}%; height:{(b.h / H) * 100}%"
                on:pointerdown={(e) => startDrag(`decor:${i}`, 'move', e)} role="button" tabindex="-1"
                aria-label="Move {DECOR_KINDS.find((d) => d.key === it.kind)?.label ?? 'decoration'}">
                <span class="el-name">{DECOR_KINDS.find((d) => d.key === it.kind)?.label ?? 'Decoration'}</span>
              </div>
              {#if selectedKey === `decor:${i}`}
                <span class="el-rz" class:active={dragKey === `decor:${i}`}
                  style="left:{((b.x + b.w) / W) * 100}%; top:{((b.y + b.h) / H) * 100}%"
                  on:pointerdown={(e) => startDrag(`decor:${i}`, 'resize', e)} aria-label="Resize decoration">⤡</span>
                <!-- The motif has always had a slider in the panel below. The grip is the same
                     value reached the way everything else on this stage is reached. -->
                <span class="el-rot" class:active={dragKey === `decor:${i}`}
                  style="left:{(b.x / W) * 100}%; top:{(b.y / H) * 100}%"
                  on:pointerdown={(e) => startDrag(`decor:${i}`, 'rotate', e)}
                  aria-label="Turn decoration" title="Drag to turn this motif">↻</span>
              {/if}
            {/if}
          {/each}
        </div>
      </div>
    </div>

    <details class="editor" open>
      <summary>{view === 'print' ? '🖨️ Print & download' : view === 'cards' ? '✏️ Customise cards' : '✏️ Customise'}</summary>
      {#if view === 'cards'}
      <!-- Gated on the trick list EXISTING, not on a card being previewed: a host who switched every
           card off still needs the controls in front of them to switch one back on. -->
      {#if cardsState === 'none'}
        <!-- Explained and OFFERED, never switched on for them. A trick list changes what guests see
             on their own phones, and a default that alters somebody else's screen is not a default
             we get to make — so this tab can open the editor and nothing more.
             Not hidden either: a tab that disappears is how a host never learns the feature exists,
             and the trick list is the distinctive half of this product. -->
        <p class="p-ask">No trick list on this event yet.</p>
        <p class="layout-hint">
          A trick list is a handful of shots for your guests to pull off — each one ticks itself off
          in the app as it is taken, and it prints on cards for the tables.
        </p>
        <p class="layout-hint">
          It puts a list on your guests' own phones, so it stays off until you turn it on.
        </p>
        <div class="bg-row">
          <!-- The designer closes to make room for the trick-list editor, so it has to say
               whether the design it is leaving behind exists anywhere else: shouldPersistDesign()
               is false for an untouched gallery preset, which lives only in the seed the parent is
               holding. seedAfterMissions() is the other half. -->
          <button class="seg on"
                  on:click={() => dispatch('missions', { persisted: shouldPersistDesign({ hasSavedDesign: hadSavedDesign, edited: designEdited }) })}>Set up a trick list →</button>
          <button class="seg" on:click={() => (view = 'poster')}>Not now</button>
        </div>
        <p class="layout-hint" style="margin-top:8px">Your design is saved — the designer comes straight back.</p>
      {:else}
        <p class="layout-hint">Identical cards to an A4 sheet, cut along the dashed guides — one per place setting. The colours and join details follow your poster.</p>

        {#if cGuided}
          <div class="psteps" aria-label="Step {cStep} of {C_LAST}">
            {#each C_TITLES as t, i}
              {#if i + 1 <= cMax}
                <!-- aria-disabled on a skipped step rather than disabled: the press still lands, and
                     it carries you to the nearest step that HAS something in it. -->
                <button class="pstep" class:on={i + 1 === cStep} class:done={i + 1 < cStep && !cStepSkipped(i + 1)}
                        class:skipped={cStepSkipped(i + 1)} aria-disabled={cStepSkipped(i + 1) || undefined}
                        on:click={() => void goCStep(i + 1)} title={cStepWhy(i + 1)}>
                  <span class="ps-n">{cStepSkipped(i + 1) ? '–' : i + 1 < cStep ? '✓' : i + 1}</span><span class="ps-t">{t}</span>
                </button>
              {:else}
                <!-- Not yet reached, so not a control at all — the event wizard's own answer. A
                     button that refuses is worse than a marker that never claimed to be one. -->
                <span class="pstep locked" title="Not there yet">
                  <span class="ps-n">{i + 1}</span><span class="ps-t">{t}</span>
                </span>
              {/if}
            {/each}
          </div>
        {/if}

        {#if cGuided}<p class="p-ask">{C_ASK[cStep - 1]}</p>{/if}

        <!-- Which card the controls below are changing. It sits ABOVE the steps' own blocks rather
             than being repeated inside each of them, because with one design per card it is the
             frame every control on this tab is read through — "Title" means Card B's title until
             you say otherwise, and a picker that only appeared on some steps would leave the others
             silently editing whichever card was last chosen. With one design for every card there
             is nothing to choose, so it is not rendered at all. -->
        {#if !cardOneDesign && printSets.length > 1}
          <div class="fld"><span>Editing {activeSheet?.label || 'this card'}</span>
            <div class="bg-row">
              {#each printSets as s, i}
                <button class="seg" class:on={previewIdx === i} aria-pressed={previewIdx === i}
                        on:click={() => (sheetIdx = i)}>{s.label || `Card ${String.fromCharCode(65 + i)}`}</button>
              {/each}
            </div>
            <p class="layout-hint" style="margin-top:8px">
              {#if isBaseSet(activeSheet)}
                This is the card the others start from. Change it and every card that has not been
                given its own look follows.
              {:else if cardHasOwn(activeSheet)}
                This card has a look of its own.
              {:else}
                This card follows {sheets[0]?.label || 'Card A'}. Change anything below and it stops.
              {/if}
            </p>
            {#if cardHasOwn(activeSheet)}
              <div class="sync-row"><button class="mini-link" on:click={syncCardToBase}>↺ Same as {sheets[0]?.label || 'Card A'}</button></div>
            {/if}
          </div>
        {/if}

        {#if !cGuided || cStep === 1}
        <!-- The colour sits ON the field, like every colour on the poster tab. Two of the card's
             four can do this and two cannot — see CARD_COLOR_STEP for which and why. -->
        <label class="fld"><span>Card title</span>
          <span class="fc-row">
            <input bind:value={cardTitle} maxlength="60" placeholder={headline} />
            <!-- Blank means "follow the poster", so the swatch shows the colour the card is
                 ACTUALLY printed in (after the readable pass) rather than an empty control. -->
            <input class="fc-dot" type="color" value={cardDesign.cTitle || cardInk.title} on:focus={aimAt('cardTitle')}
                   on:input={(e) => onColorInput(e, 'cardTitle')}
                   aria-label="Card title colour" title={cardDesign.cTitle ? 'Its own colour' : "Printed in the poster's title colour"} />
          </span>
        </label>
        {#if cardDesign.cTitle}
          <div class="sync-row"><button class="mini-link" on:click={() => patchCardDesign({ cTitle: '' })}>↺ Follow the poster</button></div>
        {/if}

        <div class="fld"><span>Cards per sheet</span>
          <div class="bg-row">
            <button class="seg" class:on={cardsPerSheet === 4} on:click={() => setCardsPerSheet(4)}>4 · A6</button>
            <button class="seg" class:on={cardsPerSheet === 2} on:click={() => setCardsPerSheet(2)}>2 · A5</button>
            <button class="seg" class:on={cardsPerSheet === 1} on:click={() => setCardsPerSheet(1)}>1 · A4</button>
          </div>
          <p class="layout-hint" style="margin-top:8px">A4 halves and quarters exactly, so every size fills the sheet.</p>

          <!-- "Card shape", not "Paper". It used to set the SHEET and say nothing about it, which
               meant it gave landscape cards at 4-up and at 1-up and PORTRAIT ones at 2-up from the
               same press — one control with two opposite meanings. Two A5s side by side on a
               landscape A4 are each portrait, necessarily; so the card is what the host chooses and
               the paper is worked out from it. -->
          <div class="sub-h">Card shape</div>
          <div class="bg-row">
            <button class="seg" class:on={!cardLandscape} on:click={() => setCardLandscape(false)}>Portrait</button>
            <button class="seg" class:on={cardLandscape} on:click={() => setCardLandscape(true)}>Landscape</button>
          </div>
          <p class="layout-hint" style="margin-top:8px">
            {cardShape}
            {#if cardSheetLandscape} The sheet goes through the printer landscape — the PDF and the print dialog are already set to it.{/if}
          </p>
        </div>

        {/if}

        {#if !cGuided || cStep === 2}
        <div class="fld"><span>Trick list</span>
          <p class="layout-hint">Each card ticks with <b>{cardGlyph}</b> — chosen with the trick list itself, so the printed card and the app always agree. It prints in your event's colour; set <b>Trick list</b> below to override it.</p>
          {#if tickIsEmoji}<p class="warn-note">⚠ Emoji ticks are printed in colour by your device's own font, so they won't match the card's ink colour — an outline tick in the trick-list editor will.</p>{/if}
        </div>

        {#if sheets.length > 1}
          <!-- Sections, not one column. Folding the colours in here made this step several times
               longer than any other in the flow, which is its own kind of wrong: a guided step is a
               question, and a question you have to scroll is two questions wearing one number. Same
               shape as the Art step's two groups — the first open, the rest a press away. -->
          <details class="fld grp" open><summary>Which cards, and how they differ</summary>
          <!-- Only with more than one card. With a single one this was a box containing one tick you
               could only turn OFF — and turning it off is the one thing that stops the cards
               printing at all. A chooser with nothing to choose reads as an empty list. -->
          {#if sheets.length > 1}
            <div class="fld"><span>Print which cards</span>
              <div class="bg-row">
                {#each sheets as s, i}
                  <button class="seg" class:on={!cardSkip.includes(s.key)} on:click={() => toggleSet(s.key)}
                    aria-pressed={!cardSkip.includes(s.key)}>{cardSkip.includes(s.key) ? '☐' : '☑'} {s.label || `Card ${String.fromCharCode(65 + i)}`}</button>
                {/each}
              </div>
              {#if !printSets.length}<p class="warn-note">⚠ Every card is switched off — turn at least one back on to print.</p>{/if}
            </div>
          {/if}
          <!-- Default ON, which is today's behaviour and what most hosts want: a set of table cards
               IS a matching set, and the identifier is what tells one from another. So this mostly
               makes the existing behaviour explicit — and gives the host who wants their tables to
               look different somewhere to say so. Offered only with more than one card, because
               with one there is nothing for a second design to be different FROM. -->
          <div class="chk"><label for="p-card-one">One design for every card <span class="sub">(off = each card gets its own colours and arrangement)</span></label><Toggle id="p-card-one" bind:checked={cardOneDesign} /></div>
          {#if cardOneDesign && printSets.length > 1}
            <div class="fld"><span>Previewing ({previewIdx + 1} of {printSets.length})</span>
              <div class="bg-row">
                {#each printSets as s, i}
                  <button class="seg" class:on={previewIdx === i} on:click={() => (sheetIdx = i)}>{s.label || `Card ${String.fromCharCode(65 + i)}`}</button>
                {/each}
              </div>
              <p class="layout-hint" style="margin-top:8px">One sheet per card. Turn off the identifiers below and you can shuffle the lot together.</p>
            </div>
          {/if}
          <div class="chk"><label for="p-card-ids">Print the card identifier on every card <span class="sub">({sheets[0]?.label ?? 'Card A'}, …)</span></label><Toggle id="p-card-ids" bind:checked={cardIds} /></div>
          <!-- It is housekeeping, not a heading, and it used to be welded above the title at a fixed
               size — so a host who wanted it smaller, or out from over the title, had nothing to
               reach for. It still moves WITH the title block; what it has now is a side and a size
               that reaches well below the old one. -->
          {#if cardIds}
            <div class="fld"><span>The identifier</span>
              <div class="bg-row">
                <button class="seg" class:on={cardLabelPos === 'above'} aria-pressed={cardLabelPos === 'above'}
                        on:click={() => (cardLabelPos = 'above')}>Above the title</button>
                <button class="seg" class:on={cardLabelPos === 'below'} aria-pressed={cardLabelPos === 'below'}
                        on:click={() => (cardLabelPos = 'below')}>Below it</button>
              </div>
              <label class="c-row" style="margin-top:6px"><span>Size <b>{cardLabelSize}</b></span>
                <input type="range" min={CARD_LABEL_MIN} max={CARD_LABEL_MAX} step="1" bind:value={cardLabelSize} aria-label="Card identifier size" />
              </label>
            </div>
          {/if}
          </details>
        {/if}

        {#if !cGuided || cStep === C_COLOUR_STEP}
        <details class="fld grp" open={sheets.length <= 1}><summary>Colours</summary>
        <div class="colors">
          <div class="c-head">Card colours
            {#if cardColoursSet}<button class="mini-link" on:click={clearCardColours}>↺ Follow the poster</button>{/if}
          </div>
          {#each CARD_LIST_ROWS as r (r.key)}
            <label class="c-row"><span>{r.label}</span>
              <input type="color" value={r.get()} on:focus={aimAt(r.key)} on:input={(e) => onColorInput(e, r.key)} />
            </label>
          {/each}
          <!-- Two rows, not four, and this is the HYBRID the cards needed rather than a copy of the
               poster's answer. The title and the code/link now wear a dot on the field that puts
               them on the card, like every colour on the poster tab. The trick list's ink and the
               card's background have no field anywhere in the modal — the list comes from the
               event's trick list and the background is a colour and nothing else — so a dot for
               either would have to sit beside a control invented to hold it. They keep one of their
               own, here, which is what this step is for. CARD_COLOR_STEP is the table. -->
          <PosterPalette {palette} label={paletteLabel} pick={applySwatch} />
          <p class="layout-hint" style="margin-top:8px">Text stays readable whatever background you choose — a colour that would disappear is nudged until it doesn't.</p>
        </div>
        <!-- Open by default on a single-card event, where it is the only section on the step and a
             closed drawer would leave the page looking empty. -->
        </details>
        {/if}
        {/if}

        {#if !cGuided || cStep === 3}
        <div class="fld"><span>Layout</span>
          <p class="layout-hint">Tap the title or the QR block on the preview to pick it up — then drag to move it, {#if coarse}pinch to resize{:else}drag the <b>⤡</b> corner to resize{/if}, and <b>✕</b> to let go. It snaps to the card’s centre and to the other block; a pink line shows what it lined up with. {#if cardOneDesign}The rest of the sheet follows this card.{:else}This arranges <b>{activeSheet?.label || 'this card'}</b> only — the others keep their own.{/if} <b>↺</b> at the top puts everything back.</p>
          <div class="chk"><label for="p-card-qr">Show the QR code</label><Toggle id="p-card-qr" bind:checked={cardShowQr} /></div>
          <!-- The dot rides in the SWITCH row, between the label and the toggle — the same place
               the poster's footer-URL colour sits, and for the same reason: the colour of a line
               exists only while the line does. -->
          <div class="chk"><label for="p-card-link">Show the join link / code beside it</label>
            {#if cardShowLink}
              <input class="fc-dot" type="color" value={cardDesign.cCode || cardInk.code} on:focus={aimAt('cardCode')}
                     on:input={(e) => onColorInput(e, 'cardCode')}
                     aria-label="Card code / link colour" title={cardDesign.cCode ? 'Its own colour' : "Printed in the poster's code colour"} />
            {/if}
            <Toggle id="p-card-link" bind:checked={cardShowLink} /></div>
          {#if cardDesign.cCode && cardShowLink}
            <div class="sync-row"><button class="mini-link" on:click={() => patchCardDesign({ cCode: '' })}>↺ Follow the poster</button></div>
          {/if}
          <div class="chk"><label for="p-card-round">Rounded corners <span class="sub">(off = the card edge matches the cut line)</span></label><Toggle id="p-card-round" bind:checked={cardRound} /></div>
          <div class="chk"><label for="p-card-ink">Plain white cards <span class="sub">(saves ink — four to a sheet adds up)</span></label><Toggle id="p-card-ink" bind:checked={cardInkSaver} /></div>
        </div>

        <label class="fld"><span>Note beside the QR</span><input bind:value={cardCaption} maxlength="70" placeholder="(blank to hide)" /></label>
        <p class="layout-hint">One line under the join details, telling a guest what the card is for — without it they have a list and no idea it ticks off in the app.</p>

        {/if}

        {#if !cGuided || cStep === 4}
        <details class="fld grp" open><summary>Decoration</summary>
          <!-- Three separate decisions — WHICH drawing, WHERE it goes, HOW it looks — that used to
               run together as one column of button rows with nothing but 8px of margin to say where
               one ended and the next began. -->
          <div class="sub-h">Which one</div>
          <!-- chip-grid, not bg-row: fifteen labels of wildly different lengths. Same treatment on
               the poster tab, because the two tabs render the same set and a host should not meet
               two different layouts of one list. -->
          <div class="chip-grid">
            {#each DECOR_KINDS as d}
              <button class="seg" class:on={decorUsed === d.key} on:click={() => (decorKind = d.key)}>{d.label}</button>
            {/each}
          </div>
          {#if decorUsed !== 'none'}
            {#if decorPositional}
              <div class="sub-h">Where it sits</div>
              <div class="bg-row">
                {#each DECOR_POSITIONS as p}
                  <button class="seg" class:on={decorPos === p.key} on:click={() => (decorPos = p.key)}>{p.label}</button>
                {/each}
              </div>
            {/if}
            <div class="sub-h">Customise</div>
            <div class="bg-row">
              <label class="seg color"><input type="color" value={decorInk} on:input={onDecorColour} aria-label="Decoration colour" />Colour</label>
              {#if decorColour}<button class="seg" on:click={() => (decorColour = '')}>↺ Match ink</button>{/if}
            </div>
            <label class="c-row" style="margin-top:6px"><span>Size</span>
              <input type="range" min="0.6" max="1.8" step="0.1" bind:value={decorScale} aria-label="Decoration size" />
            </label>
          {/if}
          <p class="layout-hint" style="margin-top:6px">Line art in the card's own ink — it prints as cleanly as the text does. Your event type picks one to start with.</p>
        </details>

        {/if}


        {#if cGuided}
          <!-- The same row, the same classes, the same primary/secondary split as the poster tab
               above and the event wizard before it. The owner's standing complaint is surfaces that
               do not match each other, so these two are written to be the same thing twice.
               No blocked label and no aria-disabled here, and that is not an omission: the cards
               have nothing a host has to fill in — see C_CAN_ADVANCE, where the reasoning is. A
               button that said "do X to continue" with no X to do would be a dead end invented for
               the sake of symmetry. -->
          <div class="pnav">
            {#if cNextStep(cStep, -1) !== null}<button class="btn ghost" on:click={() => cNav(-1)}>← Back</button>{/if}
            {#if cNextStep(cStep, 1) !== null}
              <button class="btn primary grow" on:click={() => cNav(1)}>Next →</button>
            {:else}
              <button class="btn primary grow" on:click={() => (view = 'print')}>Next: print →</button>
            {/if}
          </div>
          {#if cStep === 1}
            <button class="mini-link" on:click={() => (cGuided = false)}>Skip — show me every control</button>
          {/if}
        {:else}
          <button class="mini-link" on:click={() => { cGuided = true; cStep = 1; }}>Walk me through it instead</button>
        {/if}
      {/if}

      {:else if view === 'print'}
      <!-- ── Print ──────────────────────────────────────────────────────────────
           Every way out of the designer, in one place. There used to be two: an export row at the
           foot of the poster tab (Print / PDF / PNG / JPG) and a different one at the foot of the
           cards tab (Print / PDF / PNG / "All sheets" / "PDF (all)"), so what you could produce
           depended on which tab you happened to be standing on. The double-sided preview was a
           third, stacked over the designer as its own dialog. -->
      {#if !exportsReady}
        <!-- The export gate the previous pass built, moved up a level rather than duplicated: the
             rule is still posterExportsReady, now read for both flows (printReady). The tab is
             never hidden and never a dead control — it says where you are and offers the way out. -->
        <p class="p-ask">Not quite yet.</p>
        <p class="layout-hint">
          Printing and downloads land here once the design is finished. You're on step {pStep} of
          {P_LAST}.
        </p>
        <div class="bg-row">
          <button class="seg on" on:click={() => (view = 'poster')}>← Back to the design</button>
          <button class="seg" on:click={() => { pGuided = false; view = 'poster'; }}>Skip — show me every control</button>
        </div>
      {:else}
        <p class="p-ask">What are you printing?</p>

        <div class="pgroup">
          <div class="pg-h">The poster</div>
          <!-- Every A size is the same shape, so this changes nothing about the design — it picks
               the paper and, with it, how many pixels the export is rendered at. The resolution is
               stated because it is the one thing a host cannot see until it is printed. -->
          <p class="layout-hint">
            One {paperSize} sheet, for the door or the welcome table — {paperDpi}&thinsp;dpi.
          </p>
          <div class="paper-row" role="group" aria-label="Paper size">
            {#each PAPER_SIZES as sz}
              <button class="seg" class:on={paperSize === sz} on:click={() => (paperSize = sz)}
                      aria-pressed={paperSize === sz}>{sz}</button>
            {/each}
          </div>
          <div class="print-acts">
            <button class="btn primary" on:click={() => busy ? blocked('Still drawing — try again in a moment') : printPoster()}
                    aria-disabled={busy || undefined}>🖨️ Print</button>
            <button class="btn ghost" on:click={() => busy ? blocked('Still drawing — try again in a moment') : exportPdf()}
                    aria-disabled={busy || undefined}>PDF</button>
            <button class="btn ghost" on:click={() => busy ? blocked('Still drawing — try again in a moment') : exportPng()}
                    aria-disabled={busy || undefined}>PNG</button>
            <button class="btn ghost" on:click={() => busy ? blocked('Still drawing — try again in a moment') : exportJpg()}
                    aria-disabled={busy || undefined}>JPG</button>
          </div>
        </div>

        <div class="pgroup">
          <div class="pg-h">Trick cards</div>
          {#if cardsState === 'none'}
            <!-- Same rule as the cards tab: offer, never switch on. -->
            <p class="layout-hint">This event has no trick list, so there is nothing to print here yet.</p>
            <div class="print-acts">
              <button class="btn ghost" on:click={() => (view = 'cards')}>What are trick cards? →</button>
            </div>
          {:else if cardsState === 'all-off'}
            <p class="layout-hint">Every card is switched off. Turn one back on and it prints from here.</p>
            <div class="print-acts">
              <!-- Every control, not step 2: the chooser only exists on a step the host may never
                   have reached, and a button that lands somewhere without the thing it promised is
                   worse than one that shows a longer panel. -->
              <button class="btn ghost" on:click={() => { view = 'cards'; cGuided = false; }}>Choose which cards →</button>
            </div>
          {:else}
            <p class="layout-hint">
              Identical cards to an A4 sheet — cut along the dashed guides, one per place setting.{' '}
              {#if printSets.length > 1}{printSets.length} different cards, a sheet each.{/if}
            </p>
            <div class="print-acts">
              <button class="btn primary" on:click={() => printSheets(activeSheet ? [activeSheet] : [])}>🖨️ Print{printSets.length > 1 ? ' this card' : ''}</button>
              <button class="btn ghost" on:click={() => exportSheetsPdf(activeSheet ? [activeSheet] : [])}>PDF</button>
              <button class="btn ghost" on:click={exportSheetPng}>PNG</button>
              {#if printSets.length > 1}
                <button class="btn ghost" on:click={() => printSheets(printSets)}>🖨️ All {printSets.length}</button>
                <button class="btn ghost" on:click={() => exportSheetsPdf(printSets)}>PDF (all {printSets.length})</button>
              {/if}
            </div>
            {#if printSets.length > 1}
              <p class="layout-hint" style="margin-top:8px">Printing one card prints the one you were previewing — {activeSheet?.label ?? 'the first'}.</p>
            {/if}
            <!-- The cut guides live HERE, on the tab whose preview shows them.
                 They were on the cards tab, whose preview is ONE card — and a guide is only ever
                 drawn between tiles on a sheet, so there the toggle changed nothing you could see
                 and read as broken. On this tab the Front & back pages below redraw with it.
                 Disabled rather than hidden at 1-up, with the reason on the label: a control that
                 vanishes leaves a host wondering whether they imagined it. -->
            <div class="chk" style="margin-top:10px">
              <label for="p-card-cuts">Cut guides
                <span class="sub">{cardsPerSheet === 1
                  ? 'One card fills the sheet — there is nothing to cut.'
                  : 'Dashed lines between the cards on the printed sheet. Off for a guillotine.'}</span>
              </label>
              <Toggle id="p-card-cuts" bind:checked={cardCutLines} disabled={cardsPerSheet === 1} />
            </div>
          {/if}
        </div>

        {#if activeSheet}
          <div class="pgroup">
            <div class="pg-h">Front &amp; back</div>
            <p class="layout-hint">The poster on the front, the trick list on the back — one sheet.</p>
            <div class="fin-pages">
              <figure>
                <button class="fin-page" on:click={() => (fsPage = 'front')} disabled={!fsFront}
                        aria-label="View the front page full screen"><canvas bind:this={fFront}></canvas></button>
                <figcaption>Front — the poster<span class="fin-zoom">⛶ tap to enlarge</span></figcaption>
              </figure>
              <figure>
                <button class="fin-page" on:click={() => (fsPage = 'back')} disabled={!fsBack}
                        aria-label="View the back page full screen"><canvas bind:this={fBack}></canvas></button>
                <figcaption>Back — {activeSheet?.label ?? 'trick list'}<span class="fin-zoom">⛶ tap to enlarge</span></figcaption>
              </figure>
            </div>
            {#if finishBusy}<p class="layout-hint" style="text-align:center">Building both sides…</p>{/if}
            <!-- The one thing that actually ruins a double-sided job, and it is the printer's
                 setting, not ours: short-edge flipping gives you a back that is upside down
                 relative to the front. Said before printing, not in a toast after fifty sheets. -->
            <p class="fin-note">
              Set your printer to <b>double-sided</b> and flip on the <b>long edge</b> — short edge
              prints the back upside down.
            </p>
            <div class="print-acts">
              <button class="btn primary" on:click={() => finishBusy ? blocked('Still building both sides — try again in a moment') : printDoubleSided()}
                      aria-disabled={finishBusy || undefined}>🖨️ Print both sides</button>
            </div>
          </div>
        {/if}
      {/if}

      {:else}
      {#if pGuided}
        <div class="psteps" aria-label="Step {pStep} of {P_LAST}">
          {#each P_TITLES as t, i}
            {#if i + 1 <= pMax}
              <button class="pstep" class:on={i + 1 === pStep} class:done={i + 1 < pStep}
                      class:blocked={i + 1 > pStep && !pCanAdvance}
                      on:click={() => void goPStep(i + 1)}
                      title={i + 1 > pStep && !pCanAdvance ? 'Give your sign a title first' : t}>
                <span class="ps-n">{i + 1 < pStep ? '✓' : i + 1}</span><span class="ps-t">{t}</span>
              </button>
            {:else}
              <span class="pstep locked" title="Not there yet">
                <span class="ps-n">{i + 1}</span><span class="ps-t">{t}</span>
              </span>
            {/if}
          {/each}
        </div>
      {/if}

      {#if pGuided}<p class="p-ask">{P_ASK[pStep - 1]}</p>{/if}
      <!-- Outside every step gate, deliberately. The QR is resized by dragging or pinching it on
           the preview, which a host can do from any step, so a warning about its size cannot live
           in one step — least of all in a step they can skip. This is the only unrecoverable
           failure in the product: fifty printed cards nobody can scan. -->
      {#if qrTooSmall}<p class="warn-note">⚠ The QR code is getting small — keep it larger so guests can scan it reliably (the brand logo in the centre needs room).</p>{/if}

      {#if !pGuided || pStep === 1}
      <!-- Pointing at a field outlines what it changes on the preview, and an EMPTY one shows where
           its words would land. pointerenter rather than mouseenter so a touch never triggers it:
           on a phone the hint would fire on the tap that focuses the field and then never clear. -->
      <!-- The colour sits ON the field it colours, and NOWHERE ELSE. It was once only on the
           Colours step, four screens away, as a row labelled "Title" — so the host had to hold a
           mapping in their head between a list of words and a list of colours. The dot was added
           here and that list was left where it was, which is worse: two controls for one setting,
           and in "show all controls" both on screen at the same time. The list is gone. The swatch
           IS the answer to "what colour is this line", and the question is never asked twice.
           Step 5 is now the card stock and nothing else; see POSTER_COLOR_STEP in posterFlow. -->
      <label class="fld fld-c" data-el-settings="title" on:pointerenter={hintOn('title')} on:pointerleave={hintOff} on:focusin={hintOn('title')} on:focusout={hintOff}><span>Title</span>
        <span class="fc-row">
          <input id="p-headline" bind:value={headline} maxlength="60" />
          <input class="fc-dot" type="color" value={ink.headline} on:focus={aimAt('headline')} on:input={(e) => onColorInput(e, 'headline')} aria-label="Title colour" title="Title colour" />
        </span>
      </label>
      <!-- Only when something has drifted. The small lines and the names follow this colour by
           default, so most of the time there is nothing here to say — and a permanent “sync” button
           on a panel this tight would be on screen at all times to say exactly that. -->
      {#if inkOutOfSync.length}
        <div class="sync-row">
          <button class="mini-link" on:click={syncInkToTitle}>↺ Sync text colour</button>
        </div>
      {/if}
      <label class="fld fld-c" data-el-settings="message" on:pointerenter={hintOn('message')} on:pointerleave={hintOff} on:focusin={hintOn('message')} on:focusout={hintOff}><span>Message</span>
        <span class="fc-row">
          <input bind:value={message} maxlength="80" placeholder="(blank to hide)" />
          <input class="fc-dot" type="color" value={ink.message} on:focus={aimAt('message')} on:input={(e) => onColorInput(e, 'message')} aria-label="Message colour" title="Message colour" />
        </span>
      </label>
      <label class="fld fld-c" data-el-settings="steps" on:pointerenter={hintOn('steps')} on:pointerleave={hintOff} on:focusin={hintOn('steps')} on:focusout={hintOff}><span>How-to line</span>
        <span class="fc-row">
          <input bind:value={stepsText} maxlength="120" placeholder="(blank to hide)" />
          <input class="fc-dot" type="color" value={ink.steps} on:focus={aimAt('steps')} on:input={(e) => onColorInput(e, 'steps')} aria-label="How-to colour" title="How-to colour" />
        </span>
      </label>
      <!-- "Small line above" said nothing about what it is above; these bracket the TITLE, and the
           label is the only thing that can say so.
           The examples are a matched pair that reads as one phrase wrapping the host's own title
           — "CAPTURE / Ana and Ben / IN LOVE" — and they follow the event type, because that phrase
           is a wedding line and would be odd on a conference sign. See titleBracketFor(). They stay
           PLACEHOLDERS: blank still draws nothing. -->
      <label class="fld fld-c" on:pointerenter={hintOn('title')} on:pointerleave={hintOff} on:focusin={hintOn('title')} on:focusout={hintOff}><span>Small line above the title</span>
        <span class="fc-row">
          <input bind:value={headlineTop} maxlength="40" placeholder="(blank to hide) e.g. {titleBracket.top}" />
          <!-- The small lines are PART of the title block, and they still take its colour by
               default — that is the design, and it stays the default. What changed is that it is no
               longer a weld: pick something here and only this line moves. -->
          <input class="fc-dot" type="color" value={cHeadTop || ink.headline} on:focus={aimAt('headTop')} on:input={(e) => onColorInput(e, 'headTop')}
                 aria-label="Small line colour" title={cHeadTop ? 'Its own colour' : "Drawn in the title's colour"} />
        </span>
      </label>
      {#if inkOutOfSync.includes('headTop')}
        <div class="sync-row"><button class="mini-link" on:click={() => (cHeadTop = '')}>↺ Sync to title colour</button></div>
      {/if}
      <label class="fld fld-c" on:pointerenter={hintOn('title')} on:pointerleave={hintOff} on:focusin={hintOn('title')} on:focusout={hintOff}><span>Small line below the title</span>
        <span class="fc-row">
          <input bind:value={headlineBottom} maxlength="40" placeholder="(blank to hide) e.g. {titleBracket.bottom}" />
          <input class="fc-dot" type="color" value={cHeadBottom || ink.headline} on:focus={aimAt('headBottom')} on:input={(e) => onColorInput(e, 'headBottom')}
                 aria-label="Small line colour" title={cHeadBottom ? 'Its own colour' : "Drawn in the title's colour"} />
        </span>
      </label>
      {#if inkOutOfSync.includes('headBottom')}
        <div class="sync-row"><button class="mini-link" on:click={() => (cHeadBottom = '')}>↺ Sync to title colour</button></div>
      {/if}
      <label class="fld fld-c" data-el-settings="names" on:pointerenter={hintOn('names')} on:pointerleave={hintOff} on:focusin={hintOn('names')} on:focusout={hintOff}><span>Names</span>
        <span class="fc-row">
          <input bind:value={names} maxlength="60" placeholder="(blank to hide) e.g. Rachel and Ross" />
          <!-- The lockup follows the title by default, because the two are one piece of
               typography. It is a default now rather than the only possibility. -->
          <input class="fc-dot" type="color" value={cNames || ink.headline} on:focus={aimAt('names')} on:input={(e) => onColorInput(e, 'names')}
                 aria-label="Names colour" title={cNames ? 'Its own colour' : "Drawn in the title's colour"} />
        </span>
      </label>
      {#if inkOutOfSync.includes('names')}
        <div class="sync-row"><button class="mini-link" on:click={() => (cNames = '')}>↺ Sync to title colour</button></div>
      {/if}
      <!-- Says what the host will SEE, in their words. It used to read "it sets as a lockup — the
           two names stacked, your own joiner in script between two hairlines", which is four pieces
           of trade jargon in one sentence (lockup, joiner, in script, hairlines) and describes the
           mechanism rather than the result. The lines the old copy named are visible on the poster;
           naming them cost a clause and told the host nothing they could act on.
           The last clause stays, because it is the actionable half: it tells a host with one name,
           or a name with "and" in it they do not want split, what they will get. -->
      <p class="layout-hint">Type it as you'd say it. Put <b>and</b>, <b>&amp;</b> or <b>+</b> in the middle and the names stack — one above the other, with the joining word small between them. No separator and it stays on one line.</p>
      <!-- Offered only when the typed line HAS a separator: with nothing to stack the switch would
           be a control for a thing that is not happening. -->
      {#if namesCanStack}
        <!-- "as a lockup" went the same way the hint's jargon did, and for the same reason. This
             switch and the hint above it answer DIFFERENT questions — the hint says what happens
             with no separator, this says what happens when there is one and you don't want it
             split — so both stay, neither repeats the other. -->
        <div class="chk"><label for="p-stack-names">Stack the names <span class="sub">(off prints the line exactly as you typed it)</span></label><Toggle id="p-stack-names" bind:checked={stackNames} /></div>
      {/if}

      <!-- The two things the retired flat list uniquely carried, rehomed rather than deleted with
           it: colours lifted out of the background image, and the one way back to the event's own
           palette. They belong wherever colours are being CHOSEN, and that is here — six of the
           eight swatches are on this step. The strip aims at whichever dot was last focused, which
           is what aimAt() is for; with none touched it aims at the title, the first row on screen.
           `colorsLocked` reads "↺ Use theme colours" and is offered only once something has
           actually been pinned — the same rule as the sync rows above it. -->
      <PosterPalette {palette} label={paletteLabel} pick={applySwatch} />
      {#if colorsLocked}
        <div class="sync-row"><button class="mini-link" on:click={() => (colorsLocked = false)}>↺ Use theme colours</button></div>
      {/if}

      <!-- Anything the poster does not have a field for: a table number, a hashtag, "bar closes at
           11". Dragged and sized on the preview like everything else. -->
      <div class="fld"><span>Your own lines</span>
        <div class="bg-row">
          <button class="seg" on:click={addText}>＋ Add a line</button>
        </div>
        <!-- The colour lives on each ROW, not up here. One swatch above an empty list is a control
             for nothing — there is no line for it to colour until one has been added — and once
             there were several it looked like several choices while behaving like one. -->
        {#if textItems.length}
          <ul class="dlist">
            {#each textItems as t, i (i)}
              <li class:on={selectedKey === `text:${i}`}>
                <input class="d-in" value={t.text} maxlength="80" placeholder="Your words"
                       aria-label="Your line {i + 1}"
                       on:focus={() => (selectedKey = `text:${i}`)}
                       on:input={(e) => patchText(i, { text: e.currentTarget.value })} />
                <!-- Shows the colour the line is ACTUALLY drawn in: its own if it has one, the
                     message ink if it has not. Same convention as the card overrides. -->
                <input class="d-col" type="color" value={t.colour || ink.message}
                       aria-label="Colour of your line {i + 1}"
                       title={t.colour ? 'Its own colour' : "Drawn in the message's colour"}
                       on:focus={() => (selectedKey = `text:${i}`)}
                       on:input={(e) => patchText(i, { colour: e.currentTarget.value })} />
                <button class="d-x" on:click={() => removeText(i)} aria-label="Remove this line" title="Remove">🗑️</button>
              </li>
            {/each}
          </ul>
          {#if textColoursSet}
            <div class="sync-row"><button class="mini-link" on:click={clearTextColours}>↺ Match the message colour</button></div>
          {/if}
          <p class="layout-hint" style="margin-top:6px">Tap a line on the preview to pick it up — then drag to move it, {#if coarse}pinch to resize{:else}drag its <b>⤡</b> corner to resize{/if}, <b>✏️</b> to change the words and <b>✕</b> to let go.</p>
        {/if}
      </div>
      <!-- Deleted, not moved: "A title set as two parts — small tracked caps over a big word — is
           what makes a printed sign read as designed rather than as typed."
           It sat here, at the foot of the Words step under the list of the host's own lines, while
           the controls it described (the small lines above and below the title) are ~140 lines
           further up — so it read as a note about the wrong thing. And it had nothing to instruct:
           both fields are already labelled "Small line above/below the title" with their own
           placeholders. What was left was jargon ("small tracked caps") explaining why a designer
           likes an effect, which is the pattern this panel's copy rule exists to stop. -->

      {/if}

      {#if !pGuided || pStep === 2}
      <div class="fld"><span>Typeface pairing</span>
        <div class="tset-row">
          {#each TYPE_SETS as t}
            <button class="tset" class:on={typeSetKey === t.key} on:click={() => chooseTypeSet(t.key)}>
              <span class="tset-n" style="font-family:{t.script ? t.script.family : t.display.family}">Aa</span>
              <span class="tset-l">{t.label}</span>
              <span class="tset-note">{t.note}</span>
            </button>
          {/each}
        </div>
      </div>
      <div class="fld"><span>Set the title in</span>
        <div class="bg-row">
          <button class="seg" class:on={titleFace === 'display'} on:click={() => (titleFace = 'display')}>Structure</button>
          <!-- aria-disabled rather than disabled, and the press answers instead of vanishing: a
               pairing without a script face is a reason to change the pairing above, so say that. -->
          <button class="seg" class:on={titleFace === 'script'}
                  on:click={() => typeSet(typeSetKey).script
                    ? (titleFace = 'script')
                    : blocked('This pairing has no script face — pick another pairing above')}
                  aria-disabled={!typeSet(typeSetKey).script || undefined}
                  title={typeSet(typeSetKey).script ? '' : 'This pairing has no script face'}>Script</button>
        </div>
        <p class="layout-hint" style="margin-top:6px">The faces are bundled with Snapdini, so what you see here is what prints.</p>
      </div>
      {/if}

      {#if !pGuided || pStep === 3}
      <!-- The join colours live HERE, beside the switches that put them on the page, and nowhere
           else. They are the two of the eight that are not word colours, so they were the two the
           Words step could not take when the flat "Text colours" list was retired — see
           POSTER_COLOR_STEP in posterFlow. Same dot, same handler, same `onColorInput` as every
           other colour in the modal; a second idiom for "pick a colour" is how the duplication
           started. Each dot appears only while its element is being printed, which is exactly the
           rule the old list's row filter used. -->
      <div class="fld"><span>Show under QR</span>
        <span class="fc-row">
          <select bind:value={codeDisplay}>
            <option value="url">Join link</option>
            <option value="code">Join code</option>
            <option value="none">Nothing (QR only)</option>
          </select>
          {#if codeDisplay !== 'none'}
            <input class="fc-dot" type="color" value={ink.code} on:focus={aimAt('code')} on:input={(e) => onColorInput(e, 'code')}
                   aria-label="Colour of the code under the QR" title="Colour of the code under the QR" />
          {/if}
        </span>
      </div>
      <!-- The dot sits inside the switch's own row, between the label and the toggle: the colour of
           a line that is switched off is not a setting, so it comes and goes with the line itself.
           Not `disabled` and not greyed — it is simply not there until there is something to
           colour. -->
      <!-- "along the bottom" was wrong the moment anybody dragged it. `footer` is an ElKey with its
           own box and its own measured bounds, so the host can put the address anywhere on the
           sign; the foot of the page is only where it starts. The label names the THING now. -->
      <div class="chk" data-el-settings="footer"><label for="p-footer-url">Show the web address</label>
        {#if showFooterUrl}
          <input class="fc-dot" type="color" value={ink.footer} on:focus={aimAt('footer')} on:input={(e) => onColorInput(e, 'footer')}
                 aria-label="Footer link colour" title="Footer link colour" />
        {/if}
        <Toggle id="p-footer-url" bind:checked={showFooterUrl} /></div>
      <!-- Guided only, and that is the whole point of the gate: in "show all controls" every step's
           block renders at once, so the copy on the Words step is already on this screen. One strip
           per screen. It renders nothing at all when neither join line is being printed. -->
      {#if pGuided}<PosterPalette {palette} label={paletteLabel} pick={applySwatch} />{/if}
      <div class="chk" data-el-settings="brand"><label for="p-brand">Show the Snapdini mark</label><Toggle id="p-brand" bind:checked={showBrand} /></div>
      <!-- Shown, not hidden: a control that vanishes on a dark background reads as a bug, and the
           note under it explains why it is fixed. But NOT as a disabled switch — a disabled input
           takes no taps, so the press falls through to the label behind it and a phone answers with
           its own text-selection menu. Read-only text cannot do that, and it says the same thing. -->
      {#if qrSafe}
        <div class="chk"><label for="p-qr-panel">White card behind the QR</label><Toggle id="p-qr-panel" bind:checked={qrPanel} /></div>
      {:else}
        <div class="chk off"><span class="ro-lab">White card behind the QR<span class="sub">Always on at this contrast — see below.</span></span></div>
      {/if}
      {#if qrOverImage}
        <p class="layout-hint">Over a photo the card stays — the code could land on anything from a bright sky to a dark suit, and that cannot be measured in advance.</p>
      {:else if !qrSafe}
        <p class="layout-hint qr-warn">This paper is too dark to drop the card: contrast measures {Math.round(qrSC)}% (grade {contrastGrade(qrSC)}), and a code needs 40% to scan reliably. Lighten the background and the option unlocks.</p>
      {:else if !qrPanel}
        <p class="layout-hint">Sitting on the paper — contrast measures {Math.round(qrSC)}%, grade {contrastGrade(qrSC)}. Print one and scan it before you print fifty.</p>
      {/if}
      {/if}

      {#if !pGuided || pStep === 4}
      <!-- Decoration on the POSTER tab. It only ever existed on the cards tab, because until today
           the poster renderer ignored decoration entirely — so a design could carry a motif the
           poster drew and the poster's own controls could not change. -->
      <details class="fld grp" bind:open={decorOpen}><summary>Decoration</summary>
        <!-- Same three headings as the cards tab, and the same reason: which drawing, where it sits,
             and how it looks are three decisions, not one long column of buttons. -->
        <div class="sub-h">Which one</div>
        <div class="chip-grid">
          {#each DECOR_KINDS as d}
            <!-- `decorKind || 'none'`, because on the POSTER an empty key IS none: the config
                 deliberately stores the raw value rather than the event-type fallback the cards tab
                 uses (see the comment at the cfg), since every poster saved before decoration
                 existed carries an empty one and the fallback would put a motif on all of them.
                 Empty and 'none' therefore mean the same thing and must LOOK the same — they did
                 not, so a fresh design showed a row of chips with nothing lit at all, including the
                 one that was actually in force. -->
            <button class="seg" class:on={(decorKind || 'none') === d.key} on:click={() => (decorKind = d.key)}>{d.label}</button>
          {/each}
        </div>
        {#if decorKind && decorKind !== 'none'}
          {#if DECOR_KINDS.find((d) => d.key === decorKind)?.positional}
            <div class="sub-h">Where it sits</div>
            <div class="bg-row">
              {#each DECOR_POSITIONS as pp}
                <button class="seg" class:on={decorPos === pp.key} on:click={() => (decorPos = pp.key)}>{pp.label}</button>
              {/each}
            </div>
          {/if}
          <div class="sub-h">Customise</div>
          <div class="bg-row">
            <label class="seg color"><input type="color" value={decorColour || ink.headline} on:input={onDecorColour} aria-label="Decoration colour" />Colour</label>
            {#if decorColour}<button class="seg" on:click={() => (decorColour = '')}>↺ Match ink</button>{/if}
          </div>
          <label class="c-row" style="margin-top:6px"><span>Size</span>
            <input type="range" min="0.6" max="1.8" step="0.1" bind:value={decorScale} aria-label="Decoration size" />
          </label>
        {/if}
        <p class="layout-hint" style="margin-top:6px">Line art in your own ink — it prints as cleanly as the text. Leave it off for the plainest, cheapest print.</p>
      </details>

      <!-- Placing motifs by hand. Its OWN picker: choosing what to place must not change the
           decoration the design is already using. -->
      <!-- Closed by default: it is the advanced half of this step, and open it pushed the controls
           that most hosts actually want below the fold on a phone. -->
      <details class="fld grp" bind:open={placeOpen}><summary>Place your own{#if decorItems.length}{' '}<span class="grp-n">{decorItems.length}</span>{/if}</summary>
        <p class="layout-hint">Drop individual motifs wherever you like. These sit <b>on top of</b> the decoration above, not instead of it — to remove that one, set it to <b>None</b>.</p>
        <div class="sub-h">Motif to place</div>
        <div class="chip-grid">
          {#each PLACEABLE as d}
            <button class="seg" class:on={placeKind === d.key} on:click={() => (placeKind = d.key)}>{d.label}</button>
          {/each}
        </div>
        <div class="bg-row" style="margin-top:8px">
          <button class="seg" on:click={addDecor}>＋ Add {DECOR_KINDS.find((d) => d.key === placeKind)?.label ?? 'motif'}</button>
          <!-- Beside the motifs, because it is the same act: putting a mark on the paper. It is the
               host's OWN mark rather than one of ours, which is why it arrives by upload and not
               from the row above. -->
          <label class="seg file">{logoUploading ? 'Adding…' : '＋ Add image'}
            <input type="file" accept="image/png,image/svg+xml,image/webp,image/*" on:change={onLogoFile} hidden />
          </label>
        </div>
        <p class="sub" style="margin:6px 0 0">Any picture you like — a crest, a monogram, a drawing.
          A <b>transparent PNG</b> sits on the poster with no box around it; anything else works, but
          a white background will show as a white rectangle.</p>

        {#if decorItems.length}
          <!-- A list, because a motif dragged behind the QR or off to a corner is otherwise
               unreachable — you cannot select what you cannot find, and you certainly cannot
               delete it. Every placed piece has a row here for as long as it exists. -->
          <div class="sub-h">Placed ({decorItems.length})</div>
          <ul class="dlist">
            {#each decorItems as it, i (i)}
              <li class:on={selectedKey === `decor:${i}`}>
                <button class="d-pick" on:click={() => (selectedKey = `decor:${i}`)}>
                  <span class="d-n">{it.kind === 'logo' ? 'Image' : DECOR_KINDS.find((d) => d.key === it.kind)?.label ?? it.kind}</span>
                  <span class="d-m">{Math.round(it.scale * 100)}%{#if it.rot}{' '}· {Math.round((it.rot * 180) / Math.PI)}°{/if}</span>
                </button>
                <button class="d-x" on:click={() => removeDecor(i)} aria-label="Remove this one" title="Remove">🗑️</button>
              </li>
            {/each}
          </ul>
          {#if selectedDecor >= 0 && decorItems[selectedDecor]}
            <label class="c-row" style="margin-top:8px"><span>Rotate</span>
              <input type="range" min="-180" max="180" step="5"
                     value={Math.round((decorItems[selectedDecor].rot * 180) / Math.PI)}
                     on:input={(e) => patchDecor(selectedDecor, { rot: (Number(e.currentTarget.value) * Math.PI) / 180 })}
                     aria-label="Rotate decoration" />
            </label>
            <div class="bg-row" style="margin-top:6px">
              <!-- Same glyph as the element cluster's upright and the header's Reset layout: three
                   controls, one promise — put it back where it started. -->
              <button class="seg" on:click={() => patchDecor(selectedDecor, { rot: 0 })}>🔄 Upright</button>
            </div>
          {:else}
            <p class="layout-hint" style="margin-top:6px">Pick one above, or tap it on the preview, to rotate it. Drag to move, {#if coarse}pinch to resize{:else}drag its <b>⤡</b> corner to resize{/if}, <b>✕</b> to let go.</p>
          {/if}
          <div class="bg-row" style="margin-top:8px">
            <button class="seg" on:click={() => { pushUndo(JSON.stringify(cfg)); decorItems = []; selectedKey = null; }}>Remove all</button>
          </div>
        {/if}
      </details>
      {/if}

      <!-- ── The "Place" step is gone ────────────────────────────────────────
           It was a step with no control of its own. What it held was: a paragraph describing how to
           drag, pinch and snap; the QR-too-small warning; and one ⛶ Full-screen arrange button that
           is ALREADY in the header on this tab, which makes it a duplicate setting inside the same
           wizard.
           The paragraph is what the per-element controls replaced. Selecting an element now puts its
           name, a pencil, a bin and a ✕ on the element itself, next to the resize corner — direct
           manipulation teaches itself where it happens, which a paragraph three steps away never
           did. The short version of it now lives on the header's ⛶ Arrange button's own title.
           The warning was the one thing here worth keeping, and it was in the worst possible place:
           buried in a skippable step, warning about something the host changed two steps earlier. It
           is a warning, not a step's content, so it has moved to the top of the panel and shows
           WHENEVER it is true, on every step and in "show all controls". A host who prints a sign
           nobody can scan cannot fix it afterwards. -->
      {#if !pGuided || pStep === 5}
      <div class="fld"><span>Background</span>
        <div class="bg-row">
          {#if themeImageUrl}<button class="seg" class:on={bgMode === 'event'} on:click={() => (bgMode = 'event')}>Event image</button>{/if}
          <button class="seg" class:on={bgMode === 'plain'} on:click={() => (bgMode = 'plain')}>Plain colour</button>
          {#if customBgUrl}<button class="seg" class:on={bgMode === 'custom'} on:click={() => (bgMode = 'custom')}>Upload</button>{/if}
          <label class="seg file">{bgUploading ? 'Uploading…' : customBgUrl ? 'Replace…' : 'Upload…'}<input type="file" accept="image/*" on:change={onBgFile} hidden /></label>
          <!-- Only on the event image, and only when there is an original to re-cut. The poster is
               1:√2 and the event image was framed 3:4, so this is where a host says which part of
               their picture the POSTER should show. -->
          {#if canReframeEvent}<button class="seg" on:click={repositionPosterBg}>Reposition…</button>{/if}
        </div>
        {#if bgMode === 'plain'}
          <div class="bg-row" style="margin-top:8px">
            <label class="seg color"><input type="color" bind:value={cBg} aria-label="Background colour" />Colour</label>
            <button class="seg" class:on={cBg.toLowerCase() === '#ffffff'} on:click={() => (cBg = '#ffffff')}>White</button>
            <button class="seg" class:on={cBg.toLowerCase() === matchBg.toLowerCase()} on:click={() => (cBg = matchBg)}>Match theme</button>
          </div>
          <!-- Offered only for a plain colour: an image background IS the design, so there is
               nothing sensible to mean by not printing it. -->
          <div class="chk" style="margin-top:8px">
            <label for="p-print-bg">Print this colour
              <span class="sub">Off: the colour is your card stock — shown here while you design, left off what prints.</span>
            </label>
            <Toggle id="p-print-bg" bind:checked={printBg} />
          </div>
          {#if lightOnStock}
            <p class="stock-note">
              Your text is lighter than the card. That needs a printer that can lay down white —
              white toner, screen printing or foil. A sign or print shop can; a home printer can’t.
            </p>
          {/if}
        {/if}
      </div>

      <!-- The flat "Text colours" list was HERE, and it is gone. Eight rows, six of which were a
           second control for a colour that already had a swatch on its own field one step away —
           and in "show all controls" the two copies rendered side by side. What it uniquely carried
           moved rather than being dropped: the image swatches and "↺ Use theme colours" are on the
           Words step, `code` and `footer` have dots beside their own switches on Join. This step is
           the card stock, which is the only colour decision it was ever really about. -->
      {/if}

      {#if pGuided}
        <!-- `.btn`, not `.seg`, and it is the same decision the event wizard already made. `.seg` is
             the segmented-control style used by the option rows all over this panel, so Next read as
             one choice among several rather than as the way forward, and Back read as its equal. The
             way on is the primary action; going back is secondary. -->
        <div class="pnav">
          {#if pStep > 1}<button class="btn ghost" on:click={pBack}>← Back</button>{/if}
          {#if pStep < P_LAST}
            <!-- aria-disabled, so the press still lands and still says what is missing. pNext hands a
                 refusal to goPStep, which puts the host on step 1 with the title field focused and
                 ringed — the one mechanism, not a second one.
                 And the BUTTON says what is missing now. It was only ever said in the step strip's
                 `title` tooltip, which does not exist on a phone, and the phone is where this flow
                 lives. Same wording shape as the wizard's "Name your event to continue". -->
            <button class="btn primary grow" on:click={pNext} aria-disabled={!pCanAdvance || undefined}>
              {pCanAdvance ? 'Next →' : 'Give your sign a title to continue'}
            </button>
          {:else if cardsState === 'none'}
            <button class="btn primary grow" on:click={() => { view = 'print'; pGuided = false; }}>Next: print →</button>
          {:else}
            <!-- The poster is half the job: the cards carry the same design and the host has just
                 chosen all of it. Ending on "Show all controls" sent them back into the panel they
                 had just finished, and the cards tab was left to be noticed. -->
            <button class="btn primary grow" on:click={() => { view = 'cards'; pGuided = false; }}>Next: trick cards →</button>
          {/if}
        </div>
        {#if pStep === 1}
          <button class="mini-link" on:click={() => (pGuided = false)}>Skip — show me every control</button>
        {/if}
      {:else}
        <button class="mini-link" on:click={() => { pGuided = true; pStep = 1; }}>Walk me through it instead</button>
      {/if}
      {/if}
    </details>
    </div>

    <!-- One line, and no export row: printing has a tab of its own, so a second copy of it down
         here is exactly the duplication that tab exists to remove. -->
    <p class="hint" class:warn={!!saveError}>
      {footHint}
      {#if saveError}
        <button class="retry" on:click={retrySave} disabled={saveRetrying}>{saveRetrying ? 'Saving…' : 'Try again'}</button>
      {/if}
    </p>
  </div>
</div>

<!-- BOTH, not just `editorFile`. Reposition… opens the editor on an already-uploaded original by
     setting `editorSrc`, and the guard only tested the other one — so the button set state that
     nothing rendered and pressing it did nothing at all, silently. -->
<!-- A page at the size it prints. Its own overlay rather than the Arrange full-screen, which is an
     EDITING surface — here nothing is draggable and the only two actions are look, and close. -->
{#if fsPage && fsPageSrc}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="page-fs" on:click={() => (fsPage = null)} role="dialog" aria-modal="true"
       aria-label={fsPage === 'front' ? 'Front page' : 'Back page'}>
    <img src={fsPageSrc} alt="" />
    <button class="page-fs-x" on:click|stopPropagation={() => (fsPage = null)} aria-label="Close">✕</button>
  </div>
{/if}

{#if editorFile || editorSrc}
  <EventImageEditor file={editorFile} src={editorSrc} overlay="none" aspectW={1080} aspectH={1527}
    confirmLabel={editorSrc ? 'Use for the poster' : 'Use image'}
    on:confirm={onBgCropped} on:cancel={() => { editorFile = null; editorSrc = ''; }} />
{/if}

<style>
  .back { position: fixed; inset: 0; z-index: 300; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; padding: 20px; }
  .sheet { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); width: 100%; max-width: 420px; max-height: 94dvh; display: flex; flex-direction: column; overflow: auto; }
  /* column-gap, not gap: the narrow-screen rule below sets its own row-gap, and a shorthand here
     would fight it. 16px so Start again is not shoulder-to-shoulder with the close box — the two
     are unrelated actions and one of them replaces the design. */
  /* z-index ABOVE everything the scroller can put under it. At 1 it lost to half the panel: the
     element controls on a selected item (.el-edit, 5), its resize and drag handles (3), the tab
     overflow menu (3), the snap guides (2) and the jump ring (.pf-flash, 2) all out-ranked it, so
     anything selected went on painting straight through the header as it scrolled underneath. The
     header is the one thing here that must always win, so it is numbered like it. */
  .head { display: flex; align-items: center; justify-content: space-between; column-gap: 16px; padding: 14px 16px; border-bottom: 1px solid var(--border); font-weight: 800; position: sticky; top: 0; background: var(--surface); z-index: 20; }
  .poster-body { display: block; }
  /* On wider screens: preview on the left, scrollable controls on the right (no cramped stack). */
  @media (min-width: 720px) {
    .sheet { max-width: 800px; }
    .poster-body { display: flex; align-items: flex-start; }
    .poster-body .preview { flex: 0 0 320px; position: sticky; top: 52px; }
    .poster-body .editor { flex: 1; max-height: 70dvh; overflow: auto; border-left: 1px solid var(--border); }
  }
  /* …and on a real desktop, a preview you can actually work ON.
     The sheet was capped at 800px whatever the screen, which left the paper 288px wide — and the
     in-place element controls are a fixed pixel size, so on a page that small the cluster for a
     title was nearly as tall as the title and landed on top of whatever sat above it. That is the
     "edit icons in strange places" report, and it is a sizing problem, not a placement one: the
     same controls on the ⛶ Arrange stage (552px) sit perfectly.
     Height is the real constraint, not width. The poster is 1:√2, so its height is its width ×1.414
     and a column chosen on width alone runs off the bottom of the sheet on a laptop. The basis is
     whichever is smaller — a hard ceiling, or the width that keeps the paper inside 74dvh. */
  @media (min-width: 1100px) {
    .sheet { max-width: 1120px; }
    .poster-body .preview { flex: 0 0 min(500px, calc(74dvh / 1.414)); }
    /* The column alone is not enough: .canvas-wrap carries its own 320px ceiling, which is what was
       actually holding the paper small. Released to fill whatever the column gives it — the column
       is where the sizing decision lives, in one place, height cap and all. */
    .poster-body:not(.fs) .canvas-wrap { max-width: 100%; }
  }
  @media (min-width: 1400px) {
    .sheet { max-width: 1340px; }
    .poster-body .preview { flex: 0 0 min(640px, calc(78dvh / 1.414)); }
  }
  .x { background: none; border: none; color: var(--text-muted); font-size: 1rem; cursor: pointer; flex: none; }
  /* This used to read "the title gives way, not the buttons" — one row, ellipsis on the title. That
     was a choice between two bad options because a third was never considered: on a narrow screen
     the header gets a SECOND ROW, and then nothing has to give way at all. The truncation was not
     subtle either; with undo, redo, Arrange, Reset layout and Start again in here, "Event poster"
     was down to a few characters. The ellipsis rules stay as a backstop for a title longer than a
     row, but on a phone they no longer fire. */
  /* The TITLE takes the slack, which is what puts the controls on the right.
     `.head` is space-between across three children — title, actions, ✕ — and with the title sized to
     its text the free space landed BETWEEN the title and the actions, parking the buttons in the
     middle of the header with a gap either side. Giving the title the growth pushes the group over
     to sit beside the close button, where a header's controls belong. */
  .h-t { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .head-actions { display: flex; align-items: center; gap: 6px; flex: none; flex-wrap: wrap; }
  @media (max-width: 560px) {
    .head { flex-wrap: wrap; row-gap: 10px; }
    /* Row 1: title (taking the slack) + ✕. Row 2: every control, at full width. `order` rather than
       DOM order so the markup still reads title → controls → close. */
    .h-t { order: 0; flex: 1 1 auto; }
    .x   { order: 1; }
    .head-actions { order: 2; flex: 1 0 100%; justify-content: flex-start; }
  }
  .tog { background: transparent; border: 1px solid var(--border); color: var(--text); border-radius: 7px; padding: 5px 10px; font: inherit; font-size: 0.78rem; font-weight: 700; cursor: pointer; }
  .tog:hover { border-color: var(--accent); }
  /* Two-step, arm then confirm — the same mechanic it had at the foot of the panel, which is
     deliberate: it destroys every colour and every dragged element on both the poster and the
     cards. In a header this small a relabel alone is easy to press straight past, so the armed
     state is a FILLED danger button as well as different words. */
  .tog.restart { flex: none; }
  .tog.restart:hover { border-color: var(--danger, #e0483d); }
  .tog.restart.armed,
  .tog.restart.armed:hover { background: var(--danger, #e0483d); border-color: var(--danger, #e0483d); color: #fff; }
  /* Both labels stacked in one cell, the inactive one hidden rather than removed, so the button is
     the same width armed or not and never moves out from under the finger between the two presses. */
  /* Same two-step and the same stacked labels as Start again. At 400px the header is full — undo,
     redo, Arrange, Start again and the close box already spend every pixel the title can give up —
     so below 520px the words drop and it is the glyph alone. Both states are then one glyph wide,
     which is what keeps the button from moving out from under the finger between the two presses;
     what it is warning about moves to the note under the header, which has room for it. */
  .tog.reset { flex: none; }
  .tog.reset:hover { border-color: var(--danger, #e0483d); }
  .tog.reset.armed,
  .tog.reset.armed:hover { background: var(--danger, #e0483d); border-color: var(--danger, #e0483d); color: #fff; }
  /* Measured at 400px: the sheet is 360px wide and the header has 330px inside its padding. With
     every word present the controls need 397px, so they would wrap — the one thing this bar must
     not do. Without the words it is 278px, and the title gets the rest back. */
  @media (max-width: 520px) { .tog-w { display: none; } }
  .ra-stack { display: grid; }
  .ra-stack > .ra-l { grid-area: 1 / 1; white-space: nowrap; }
  .ra-stack > .ra-l.off { visibility: hidden; }
  .warn-note { font-size: 0.74rem; color: #ff8a8a; margin: 6px 0 8px; line-height: 1.4; }
  /* Poster / mission-cards switch — two outputs of the same design. */
  .tabs { display: flex; gap: 6px; padding: 10px 16px; border-bottom: 1px solid var(--border); }
  /* Three tabs at 400px: the sheet is 360px wide and "🃏 Trick cards" is the long one. Tighter
     padding and a size down keeps all three on one line rather than wrapping the middle one. */
  @media (max-width: 460px) {
    .tabs { gap: 4px; padding: 10px 10px; }
    .tab { padding: 8px 4px; font-size: 0.74rem; }
  }
  .tab { flex: 1; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: transparent;
    color: var(--text); font: inherit; font-size: 0.8rem; font-weight: 700; cursor: pointer; }
  .tab.on { background: var(--accent-fill); color: var(--accent-ink, #111); border-color: var(--accent); }
  .empty { font-size: 0.8rem; color: var(--text-muted); text-align: center; margin: 0; }

  /* Full-screen layout mode — a big stage so dragging/placing elements is easy. */
  .sheet.fs { max-width: none; width: 100vw; height: 100dvh; max-height: 100dvh; border-radius: 0; overflow: hidden; }
  .poster-body.fs { display: flex; flex: 1; align-items: center; justify-content: center; overflow: hidden; min-height: 0; }
  .poster-body.fs .editor { display: none; }
  .poster-body.fs .preview { flex: 1; position: static; padding: 16px; background: var(--surface-2); }
  .poster-body.fs .canvas-wrap { max-width: min(94vw, calc((100dvh - 170px) * 0.7073)); }
  .sheet.fs .hint { display: none; }
  /* On the PRINT tab the live poster on the left is redundant — the two page thumbnails beside the
     buttons are the thing being checked, and they are the thing that prints. Hiding it also gives
     the pages the whole width, which is what makes them worth looking at. */
  .poster-body.printing .preview { display: none; }
  .preview { padding: 16px; display: flex; align-items: center; justify-content: center; min-height: 200px; background: var(--surface-2); }
  .canvas-wrap { position: relative; display: block; width: 100%; max-width: 320px; line-height: 0; }
  .canvas-wrap.hidden { display: none; }
  canvas { width: 100%; height: auto; border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,0.4); display: block; }
  .poster-stage { position: absolute; inset: 0; }
  /* Only WHILE dragging, never at rest. The stage is a transparent overlay covering the whole
     preview, so a permanent touch-action:none would stop a finger scrolling the modal by swiping
     over the poster. It has to be set before the SECOND finger lands, though — touch-action is what
     stops the browser treating a pinch as a page zoom, and preventDefault() on pointerdown does not
     (pointer events leave scrolling/zooming to touch-action alone). A drag is already in progress
     by then, so the class is on in time. */
  .poster-stage.dragging { touch-action: none; }
  /* ...and while an element is HELD, which is the same reasoning one step earlier. A pinch that
     starts on blank stage has no drag in progress to have set the class already, and touch-action
     cannot be applied in reaction to the second finger — by then the browser has decided the
     gesture is a page zoom. The note above says a PERMANENT touch-action:none would cost the host
     the ability to scroll the modal by swiping over the poster; this is not permanent. It lasts
     exactly as long as a selection, which is deliberate, visible, and left with the ✕ or Escape. */
  .poster-stage.holding { touch-action: none; }
  .hint.warn { color: var(--danger, #e5484d); font-weight: 600; }
  .retry { margin-left: 8px; padding: 3px 9px; border-radius: 6px; cursor: pointer;
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
    font: inherit; font-size: 0.72rem; font-weight: 700; }
  .retry:hover { border-color: var(--accent); }
  .retry:disabled { opacity: 0.6; cursor: default; }
  .sub { color: var(--text-muted); font-size: 0.72rem; }
  /* The element's footprint IS the move handle — drag anywhere on it. The outline only appears on
     hover or while active, so it doesn't clutter the preview; its true size shows when resizing. */
  /* A heads-up, not a warning: nothing here is wrong, it just needs the right press. Styled as a
     note rather than an error for exactly that reason. */
  .stock-note {
    margin: 8px 0 0; padding: 8px 10px; border-radius: 8px; font-size: .74rem; line-height: 1.45;
    color: var(--text-muted); background: color-mix(in srgb, var(--accent) 9%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 26%, transparent);
  }
  .safe-area {
    position: absolute; pointer-events: none; z-index: 0;
    border: 1px dashed rgba(255, 255, 255, .28); border-radius: 2px;
  }
  /* Alignment guides. Deliberately SOLID and magenta: the dashed white line on this same stage
     already means "print-safe area", and two dashed lines meaning two different things is a puzzle
     rather than a hint. The dark outer shadow is what keeps a 1px line visible on both a white
     poster and a photo background. z-index sits above the element outlines but below the resize
     grip, so the grip you are holding is never hidden by the line it just landed on. */
  .snap-guide { position: absolute; pointer-events: none; z-index: 2; background: #ff3ea5;
    box-shadow: 0 0 0 1px rgba(0, 0, 0, .38); }
  .snap-guide.vert { top: 0; bottom: 0; width: 1px; margin-left: -0.5px; }
  .snap-guide.horz { left: 0; right: 0; height: 1px; margin-top: -0.5px; }
  /* `pan-y` until it is SELECTED, and only then `none`.
     It was `none` permanently, which is the CSS half of the same bug the press handler had: a swipe
     that began on an element could not scroll the modal, because touch-action had already told the
     browser this box does not scroll. Fixing dragOn stopped the swipe from moving the element, but
     nothing then moved at all — the finger just dragged over a dead box. touch-action is the only
     thing that decides this; preventDefault cannot give scrolling back once it has been refused.
     pan-y rather than auto: vertical scrolling is the gesture being honoured here, and leaving
     pinch-zoom on would let the browser zoom the whole page inside a modal.
     Selected, the element is armed for dragging, and a drag needs the browser to keep its hands
     off — which is the same bargain .poster-stage.holding makes for the stage around it. */
  .el-box { position: absolute; box-sizing: border-box; border: 1px dashed transparent; border-radius: 5px;
    pointer-events: auto; cursor: move; touch-action: pan-y; user-select: none; -webkit-user-select: none; z-index: 1; }
  .el-box.selected { touch-action: none; }
  .el-box.lock-x { cursor: ew-resize; }
  .el-box:hover { border-color: rgba(255,255,255,0.5); }
  .el-box.active, .el-box.selected { border-color: var(--accent); border-style: solid; background: rgba(245,197,24,0.12); }
  .el-box.warn { border-color: #ff5b5b; border-style: solid; }
  /* Label sits as a tab just ABOVE the top-left corner — outside the footprint so it never covers
     content — and only appears on hover / while active. */
  .el-name { position: absolute; bottom: 100%; left: 0; margin-bottom: 3px;
    /* see .label-below */
    background: rgba(17,17,17,0.82); color: #fff; font-size: 0.55rem; font-weight: 700; letter-spacing: 0.02em;
    padding: 1px 6px; border-radius: 5px; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 0.12s; line-height: 1.25; }
  .el-box.label-below .el-name { bottom: auto; top: 100%; margin-bottom: 0; margin-top: 3px; }
  .el-box:hover .el-name, .el-box.active .el-name { opacity: 1; pointer-events: auto; }
  /* While selected, the control cluster carries the element's name at the other end of it — so this
     tab would be the same word twice, a few pixels apart. Only on a hover that is NOT a drag: the
     cluster is hidden during a drag, and the name is worth having then. */
  .el-box.selected:not(.active) .el-name { opacity: 0; }
  /* Resize grip sits at the bottom-right corner, just touching the outline without covering content. */
  .el-rz { position: absolute; transform: translate(-2px, -2px); display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; color: #111; background: rgba(255,255,255,0.92); border: 1px solid var(--accent); border-radius: 6px;
    cursor: nwse-resize; font-size: 0.72rem; touch-action: none; line-height: 1; z-index: 3; }
  .el-rz.active { background: var(--accent-fill); }
  /* Gone on a touch screen, where pinching the element does the same job with no 20px target to
     hit — and where the grip sits under the very finger that would be dragging it. The ROTATE
     handle stays: there is no two-finger rotate, so it is the only way to turn anything on a
     phone. */
  @media (pointer: coarse) { .el-rz { display: none; } }
  /* The turn grip. Same chip as the resize corner so the pair read as one set of handles, anchored
     to the element's TOP-LEFT — diagonally opposite ⤡, and clear of the control cluster, which
     right-aligns to the top-right.
     It sits just INSIDE the corner rather than hanging outside it, unlike ⤡. The sheet clips what
     overflows it (the same fact that gives .el-name its `label-below` flip), and the top-left is the
     corner an element gets pushed into: a grip hanging up and to the left of a title near the top of
     the page would be cut off by the sheet's own edge, which is a handle you cannot reach. */
  .el-rot { position: absolute; transform: translate(2px, 2px);
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; color: #111; background: rgba(255,255,255,0.92); border: 1px solid var(--accent); border-radius: 6px;
    cursor: grab; font-size: 0.78rem; touch-action: none; line-height: 1; z-index: 3; }
  /* 44px of target around a 22px chip. The handle cannot GROW to 44 — it would swallow the element
     it is attached to on a 316px phone preview, and sit on top of the ⤡ on a small one — so the hit
     area is expanded instead, which is the same 44px under a thumb and the same 22px on screen. */
  .el-rot::after { content: ''; position: absolute; inset: -11px; }
  .el-rot.active { background: var(--accent-fill); cursor: grabbing; }
  .spinner { width: 30px; height: 30px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .editor { padding: 6px 16px 0; }
  .editor summary { cursor: pointer; font-size: 0.85rem; font-weight: 700; padding: 4px 0; }
  .fld { display: block; margin-top: 10px; font-size: 0.78rem; color: var(--text-muted); }
  /* ── A control's NAME is a heading; its explanation is not ──
     Same rule app.css states globally for .tf-label / .t-label, applied here because Svelte scopes
     styles to their own component and a global rule cannot beat `.fld.svelte-x > span.svelte-x`.
     Without it the name ("Background") and the sentence under it (.layout-hint) were both muted,
     within 0.04rem of each other in size and the same weight — so a column of them read as one run
     of prose and you could not skim for the thing you came to change. */
  .fld > span { display: block; margin-bottom: 4px; font-size: 0.82rem; font-weight: 700; color: var(--text); }
  .fld input, .fld select { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font: inherit; font-size: 0.85rem; box-sizing: border-box; background: var(--surface); color: var(--text); }
  /* ── A field and the colour its words print in, on ONE line ──
     `.fc-row` and `.fc-dot` were in the markup with no rules anywhere, so `.fld > span` caught the
     row (it IS a span) and made it a block, and both children inherited `.fld input { width: 100% }`
     — giving a full-width text box with a full-width ~8px colour bar stacked underneath it. Hence
     the `> span.fc-row` here: it has to out-specify that `.fld > span` rule, which repeats Svelte's
     scoping class and cannot be beaten from anywhere else.
     align-items: stretch is what makes the swatch exactly as tall as the field beside it rather
     than a number picked to look about right; min-height keeps the pair a comfortable target. */
  /* font-weight back to normal on the ROW, because it is a container and not a name: `.fld input`
     carries `font: inherit`, and the shorthand takes the weight it inherits — so a bold row would
     be typed into in bold. */
  .fld > span.fc-row { display: flex; align-items: stretch; gap: 8px; margin-bottom: 0; min-height: 40px; font-weight: 400; color: var(--text-muted); }
  /* `select` too: the join step's "Show under QR" now carries the code's colour dot beside it, and
     without this it keeps `.fld select { width: 100% }` and shoves the dot off the row. */
  .fc-row > input:not(.fc-dot), .fc-row > select { flex: 1 1 auto; width: auto; min-width: 0; }
  /* `> input.fc-dot`, not `.fc-dot`: a bare class loses to `.fld input` (one class + one element
     beats one class), and losing means inheriting `width: 100%` — which in a flex row with
     `flex: none` is a 445px colour bar squeezing the text field down to 22px. Measured; the first
     attempt at this rule shipped exactly that. */
  /* `.chk >` carries the same weight for the same reason: the footer URL's dot sits in its SWITCH
     row, between the label and the toggle, because the colour of a line exists only while the line
     does. A selector list rather than a second copy of the rules — one dot, one look. */
  .fc-row > input.fc-dot, .chk > input.fc-dot {
    flex: none; width: 46px; height: auto; padding: 0; cursor: pointer;
    background: var(--surface); border: 1px solid var(--border); border-radius: 8px;
  }
  /* In a switch row there is no text field to match the height of, so it takes the switch's. */
  .chk > input.fc-dot { height: 26px; }
  .fc-row > input.fc-dot:hover, .chk > input.fc-dot:hover { border-color: var(--accent); }
  /* Without these the native control keeps its own thick inset border and the colour shows as a
     thin strip in the middle of the box rather than as the box. */
  .fc-row > input.fc-dot::-webkit-color-swatch-wrapper, .chk > input.fc-dot::-webkit-color-swatch-wrapper { padding: 3px; }
  .fc-row > input.fc-dot::-webkit-color-swatch, .chk > input.fc-dot::-webkit-color-swatch { border: none; border-radius: 5px; }
  .fc-row > input.fc-dot::-moz-color-swatch, .chk > input.fc-dot::-moz-color-swatch { border: none; border-radius: 5px; }
  /* A switch row is a label that WILL wrap at 360px plus a 46px switch, so two things matter:
     · align-items:flex-start pins the switch to the label's FIRST line instead of floating it
       halfway down a three-line label;
     · the label is ONE flex item (flex:1, min-width:0). It used to be two — the bare text node and
       the <span class="sub"> became separate flex children, which is what sat a sub-note BESIDE
       its label, each wrapping in its own column, rather than under it. */
  .chk { display: flex; align-items: flex-start; gap: 10px; margin-top: 10px; font-size: 0.82rem; line-height: 1.35; }
  /* The same heading rule, and the same reason: "Print this colour" over "Off: the colour is your
     card stock…" is a NAME and a SENTENCE, and they were set identically. */
  .chk > label, .chk > .ro-lab { flex: 1; min-width: 0; font-weight: 700; color: var(--text); }
  .chk > label { cursor: pointer; }
  /* Read-only, because a disabled switch takes no taps — see the QR card row. */
  .chk > .ro-lab { display: block; }
  .chk.off > .ro-lab { opacity: 0.6; }
  .chk .sub { display: block; margin-top: 2px; font-size: 0.74rem; font-weight: 400; color: var(--text-muted); line-height: 1.45; }
  .bg-row { display: flex; gap: 6px; flex-wrap: wrap; }
  /* ── Even chips, the event wizard's treatment ─────────────────────────────
     The decoration and motif TYPE rows were `.bg-row` — a wrapping flex row — so fifteen labels
     ranging from "None" to "Camera (round the QR)" came out ragged, with a different number of
     buttons on every line and no two the same width. The event wizard settled this for its event
     types: an auto-fit grid gives every chip an equal share of the row and wraps itself.
     Same 130px floor as the wizard, and it is the longest LABEL that picks it rather than taste:
     at a 104px floor a phone gets three columns and "Camera (round the QR)" breaks over three
     lines, which grid then charges to all fifteen cells. At 130px a phone gets two columns of about
     150px, which that label fits on one line, and the wide layout gets three. Nothing clips either
     way — the chips wrap, and grid makes every cell as tall as the tallest, which is the whole
     reason a two-line label no longer shunts its row.
     NOT applied to the three-item "Where it sits" row (Top / Corners / Both): three short words in
     a flex row are already even, and in a two-column grid the third would sit alone beside a gap. */
  .chip-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 6px; }
  .chip-grid .seg { display: flex; align-items: center; justify-content: center; text-align: center; }
  .seg { padding: 7px 11px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text); cursor: pointer; font-size: 0.8rem; }
  .seg.on { background: var(--accent-fill); color: var(--accent-ink, #111); border-color: var(--accent); font-weight: 700; }
  .seg.file { display: inline-flex; align-items: center; }
  .seg.color { display: inline-flex; align-items: center; gap: 7px; }
  .seg.color input[type="color"] { width: 22px; height: 22px; padding: 0; border: none; background: none; cursor: pointer; }
  .layout-hint { font-size: 0.74rem; color: var(--text-muted); margin: 0 0 8px; line-height: 1.45; }
  .colors { margin-top: 14px; }
  .c-head { font-size: 0.82rem; font-weight: 700; color: var(--text); margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .mini-link { background: none; border: none; color: var(--accent); font-size: 0.7rem; font-weight: 700; cursor: pointer; padding: 0; }
  /* A quiet line under the control it belongs to, never beside it: these appear and disappear as a
     colour drifts in and out of sync, and something that comes and goes inside a row would shuffle
     the row's width every time it did. */
  .sync-row { margin-top: 4px; }
  /* `.dlist li > input.d-col`, not a bare `.d-col`: one class loses to `.fld input` (one class plus
     one element), and losing means inheriting its `width: 100%` — which in a flex row is the
     full-width colour bar that shipped once already. See the .fc-dot note above. */
  /* ...and it has to carry the row's height itself. The row is `align-items: stretch` and the text
     field beside it takes its 44px from the shared `.d-pick, .d-in, .d-x` rule — but a native
     `input[type="color"]` brings its own intrinsic box from the UA stylesheet, which won over the
     stretch and left the swatch visibly shorter than the field it sits against.
     `align-self: stretch` with `height: auto` is what asks for the row's height; `min-height: 44px`
     is the floor, and it is THE SAME 44px the field uses rather than a number picked to match what
     the field currently measures — so the two cannot drift apart when `.d-in`'s padding or type
     size changes. Both, because the stretch is what keeps them equal if the row ever grows taller
     than 44px and the floor is what makes it right if the stretch is overruled again. */
  .dlist li > input.d-col {
    flex: none; width: 34px; min-width: 34px; padding: 2px; cursor: pointer;
    align-self: stretch; height: auto; min-height: 44px;
    border: 1px solid var(--border); border-radius: 8px; background: var(--surface);
  }
  .dlist li > input.d-col:hover { border-color: var(--accent); }
  .dlist li > input.d-col::-webkit-color-swatch-wrapper { padding: 3px; }
  .dlist li > input.d-col::-webkit-color-swatch { border: none; border-radius: 5px; }
  .dlist li > input.d-col::-moz-color-swatch { border: none; border-radius: 5px; }
  .c-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 0; font-size: 0.82rem; }
  .c-row input[type="color"] { width: 42px; height: 28px; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: none; cursor: pointer; }
  .c-row input[type="range"] { width: 55%; accent-color: var(--accent); cursor: pointer; }
  .hint { text-align: center; font-size: 0.78rem; color: var(--text-muted); padding: 12px 16px 0; }
  .btn { font-weight: 700; border-radius: var(--radius-sm); padding: 10px 16px; font-size: 0.85rem; border: 1px solid transparent; cursor: pointer; font-family: inherit; }
  .btn.primary { background: var(--accent-fill); color: var(--accent-ink, #111); }
  .btn.ghost { background: transparent; border-color: var(--border); color: var(--text); }
  /* `[aria-disabled]`, not `:disabled` — every one of these still takes its press and answers it.
     A truly disabled button consumes no events, so on a phone the tap reaches the text underneath
     and the browser throws its own Copy/Search menu over the app. */
  .btn[aria-disabled='true'] { opacity: 0.5; }
  /* Deliberately NOT in .actions. Those are the outputs; this destroys the input, so it sits below a
     rule, smaller, and is the only danger-coloured control in the sheet. */


  /* Armed inverts rather than recolours — the same flip the review page's Reject uses. The hue is
     the constant, so it reads as "this one is live now", not as a different button appearing. */
  /* What the armed button is warning about — there is no room for it in the header, and it is the
     half that explains the consequence. Shown only while armed, which is the only moment it has
     anything to say, and coloured as the button is so the two read as one state. */
  /* Out of flow, hung off the bottom edge of the sticky header. `position: sticky` is a positioned
     value, so the header is already the containing block for this — no extra wrapper — and it
     carries z-index: 1, which puts everything inside it above the tab row it overlays.
     The ground has to be OPAQUE for the same reason: color-mix against `transparent` was fine when
     this sat in its own strip and would show the tabs straight through it here. Mixed against
     --surface instead, so it works in both themes without a second rule. */
  .armed-note {
    position: absolute; top: 100%; left: 0; right: 0; z-index: 3;
    margin: 0; padding: 9px 16px; font-size: 0.74rem; font-weight: 400; line-height: 1.45;
    color: var(--danger, #e0483d);
    background: color-mix(in srgb, var(--danger, #e0483d) 10%, var(--surface));
    border-bottom: 1px solid color-mix(in srgb, var(--danger, #e0483d) 40%, var(--surface));
    /* Says it is floating above the page rather than part of it — without this an opaque strip in
       the tabs' place reads as the tabs having been replaced. */
    box-shadow: 0 8px 18px rgb(0 0 0 / 0.3);
  }
  /* Typeface pairings read as SAMPLES, not as words — the whole point is what they look like, so
     each chip shows its own script (or display) face at a size you can actually judge. */
  .tset-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(132px, 1fr)); gap: 6px; }
  .tset {
    display: grid; grid-template-rows: auto auto auto; gap: 1px; text-align: left;
    padding: 8px 10px; border: 1px solid var(--border); border-radius: 10px;
    background: var(--surface-2); color: var(--text); cursor: pointer; font: inherit; min-width: 0;
  }
  .tset.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .tset-n { font-size: 1.5rem; line-height: 1.1; }
  .tset-l { font-weight: 700; font-size: 0.8rem; }
  .tset-note { font-size: 0.68rem; color: var(--text-muted); line-height: 1.25; }

  /* ── Guided customising ──────────────────────────────────────────────────── */
  /* The strip is clickable, not just an indicator: a host who has been through once should be able
     to jump straight back to Colours without pressing Next three times. */
  .psteps { display: flex; gap: 4px; margin: 0 0 12px; }
  .pstep {
    flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 3px;
    border: 0; border-top: 2px solid var(--border); background: none; cursor: pointer;
    padding: 7px 2px 0; color: var(--text-muted); font: inherit; font-size: 0.68rem;
  }
  .pstep.on, .pstep.done { border-top-color: var(--accent); }
  /* A step with nothing to decide. Greyed and unpressable, but still SHOWN — removing it would
     renumber the others under the host mid-flow, and the title says why it is out. */
  .pstep.skipped { opacity: .4; }
  .pstep.skipped .ps-n { border-style: dashed; }
  /* Reachable, but the current step still wants something. Pressing it says so and takes you to
     the field — it is not a dead control, it is a signposted one. */
  .pstep.blocked { opacity: .55; }
  /* Not reached yet, so not a control at all: a <span>, the event wizard's own answer. A button
     that refuses is worse than a marker that never claimed to be pressable. */
  .pstep.locked { opacity: .4; cursor: default; }
  .pstep.locked .ps-n { border-style: dotted; }
  .pstep.on { color: var(--text); font-weight: 700; }
  .ps-n {
    width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; font-size: 0.64rem; font-weight: 700;
    background: var(--surface-2); border: 1px solid var(--border);
  }
  .pstep.on .ps-n { background: var(--accent-fill); color: var(--accent-ink, #111); border-color: var(--accent); }
  .pstep.done .ps-n { color: var(--accent); border-color: var(--accent); }
  /* Labels go first when there is no room — the numbers and the track still say where you are. */
  @media (max-width: 520px) { .ps-t { display: none; } }

  /* :global because the class is put on a DOM node by hand, and Svelte's scoper only rewrites
     selectors it can see used in this component's markup.
     `outline`, not `box-shadow`, and with an offset: every group in this panel holds controls flush
     against its own edge, and those children paint straight over a parent's outer shadow — the bug
     the event wizard hit first. An outline takes no space, so nothing reflows; position/z-index
     because the ring is drawn OUTSIDE the box, in space the next sibling owns. */
  /* NOT called `.jump-flash`, which is what the event wizard calls its own copy. Both are
     `:global`, so both would match the same node and the later stylesheet would win the
     `animation` — pointing it at a keyframes name scoped to a component whose CSS this route may
     not even have loaded. Measured: the ring silently did not paint. A global class needs a name
     nobody else owns. */
  :global(.pf-flash) {
    position: relative;
    z-index: 2;
    border-radius: var(--radius-sm);
    animation: pfflash 1.6s ease-out;
  }
  @keyframes pfflash {
    0%, 55% { outline: 2px solid var(--accent); outline-offset: 4px; }
    100%    { outline: 2px solid transparent;   outline-offset: 4px; }
  }
  /* Reduced motion keeps the ring — it is a colour change, not movement — and the timer still
     takes it away. */
  @media (prefers-reduced-motion: reduce) {
    :global(.pf-flash) { animation: none; outline: 2px solid var(--accent); outline-offset: 4px; }
  }

  /* The event wizard's .wiz-nav, down to the flex bases: a flex item defaults to min-width:auto, so
     Next collapsed to its own min-content beside a Back that had taken the rest of the row.
     ORDER MATTERS, and it was wrong here. `.pnav .grow` and `.pnav > .seg` are both (0,2,0), so the
     later rule won and Next was handed `flex: 1 1 0` — an equal share, not twice the share. The
     documented fix was in the file and dead. `.grow` goes last. */
  .pnav { display: flex; gap: 8px; margin-top: 12px; }
  .pnav > .btn { flex: 1 1 0; min-width: 0; }
  .pnav > .grow { flex: 2 1 0; }
  /* ── Front & back, and the Print tab's groups ─────────────────────────────
     This was a dialog over the designer with its own backdrop, its own Escape layer and its own
     copy of three print buttons. It is a print step, so it is a section of the Print tab, and what
     is left of its CSS is the two page thumbnails and the printer warning. */
  /* A named block of the Print tab. Each one is a thing you can produce — the poster, the cards,
     both sides of one sheet — with its own name, its own sentence and its own buttons. */
  .pgroup { margin-top: 14px; }
  .pgroup + .pgroup { padding-top: 12px; border-top: 1px solid var(--border); }
  .pg-h { font-size: 0.82rem; font-weight: 700; color: var(--text); margin-bottom: 4px; }
  .paper-row { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 10px; }
  .paper-row .seg { flex: 1 1 auto; min-width: 52px; }
  .print-acts { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
  .fin-page { display: block; padding: 0; border: 0; background: none; cursor: zoom-in; line-height: 0; }
  .fin-page:disabled { cursor: default; }
  .fin-zoom { display: block; font-size: 0.68rem; opacity: 0.75; }
  .page-fs { position: fixed; inset: 0; z-index: 400; background: rgba(0,0,0,0.92);
    display: flex; align-items: center; justify-content: center; padding: 16px; cursor: zoom-out; }
  .page-fs img { max-width: 100%; max-height: 100%; width: auto; height: auto;
    box-shadow: 0 10px 40px rgba(0,0,0,0.6); background: #fff; }
  .page-fs-x { position: absolute; top: 12px; right: 14px; width: 40px; height: 40px; border-radius: 50%;
    background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.25); color: #fff;
    font-size: 1rem; cursor: pointer; }
  .fin-pages { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
  .fin-pages figure { margin: 0; flex: 0 1 auto; }
  .fin-pages canvas { display: block; width: auto; max-width: 100%; height: auto; border: 1px solid var(--border);
                      border-radius: 4px; background: #fff; }
  .fin-pages figcaption { padding-top: 5px; font-size: 0.72rem; color: var(--text-muted); text-align: center; }
  .fin-note { margin: 12px 0 10px; font-size: 0.76rem; line-height: 1.45; color: var(--text-muted); }
  .qr-warn { color: var(--danger, #e0483d); }
  /* What a control is about to change. Deliberately louder than the ordinary hover outline — the
     point is to be findable across the whole preview at a glance, not to be tasteful. */
  .el-box.hinted { border-color: var(--accent); box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 45%, transparent); }
  /* Where an empty line would go. Dashed and unpressable: it is not there yet. */
  .el-ghost {
    position: absolute; display: flex; align-items: center; justify-content: center;
    border: 1px dashed var(--accent); border-radius: 6px; pointer-events: none;
    background: color-mix(in srgb, var(--accent) 10%, transparent);
  }
  .el-ghost span {
    font-size: 0.62rem; font-weight: 700; letter-spacing: .03em; color: var(--accent);
    background: var(--surface); padding: 1px 6px; border-radius: 999px; white-space: nowrap;
  }
  /* The inline editor. Under the element rather than over it, so the thing being edited stays
     visible while it is edited — covering it would defeat the entire point. */
  .el-edit { position: absolute; display: flex; gap: 6px; z-index: 5; }
  /* A wrapping box, not a single-line field: a 60-character title in a field this wide scrolls
     itself out of sight exactly when you are trying to read what you typed. `grow` holds it at one
     row — the same 44px it has always been — until the words actually need a second.
     16px exactly: iOS Safari zooms the whole page in on any focused input smaller than that, which
     on a poster preview throws away the view the host was working in. So the box gets tighter
     through padding and line-height, never through type size. */
  .el-edit textarea {
    flex: 1 1 auto; min-width: 0; min-height: 44px; padding: 6px 9px; font: inherit; font-size: 16px;
    line-height: 1.25; resize: none; overflow: hidden; display: block;
    color: var(--text); background: var(--surface); border: 2px solid var(--accent); border-radius: 9px;
  }
  .ee-done {
    flex: none; width: 44px; min-height: 44px; cursor: pointer; font-size: 1rem;
    color: var(--accent-ink, #111); background: var(--accent-fill); border: 0; border-radius: 9px;
  }
  /* A control group that folds. The summary keeps `.fld`'s label look so a collapsed group still
     reads as the same kind of thing as an open one, with a chevron of our own rather than the
     browser's triangle, which differs on every platform. */
  .fld.grp { margin-top: 12px; }
  .fld.grp > summary {
    display: flex; align-items: center; gap: 7px; cursor: pointer; list-style: none;
    margin-bottom: 4px; min-height: 34px; user-select: none;
  }
  .fld.grp > summary::-webkit-details-marker { display: none; }
  .fld.grp > summary::before { content: '▸'; flex: none; width: .8em; text-align: center; }
  .fld.grp[open] > summary::before { content: '▾'; }
  .fld.grp > summary:hover { color: var(--text); }
  /* How many are in there, so a collapsed group never hides work silently. */
  .grp-n {
    padding: 0 6px; border-radius: 999px; background: var(--accent-fill); color: var(--accent-ink, #111);
    font-size: 0.64rem; font-weight: 700;
  }

  /* The question this step is asking, in the host's words. It is the first thing in the panel, and
     on a phone it is often the only thing visible above the fold — so it has to carry the step on
     its own rather than lean on a preview the reader has scrolled past. */
  .p-ask { margin: 0 0 12px; font-size: 0.95rem; font-weight: 700; line-height: 1.3; }

  /* A small heading INSIDE a control group. The groups had grown to hold several unrelated
     decisions each — a motif, then a position, then a colour — with nothing but spacing to say
     where one ended and the next began. */
  .sub-h {
    margin: 10px 0 5px; font-size: 0.68rem; font-weight: 700; letter-spacing: .06em;
    text-transform: uppercase; color: var(--text-muted);
  }
  /* The placed-motif list. Each row is a target you press to select plus its own bin — a motif
     dragged behind the QR is otherwise unreachable, and you cannot delete what you cannot find. */
  .dlist { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .dlist li { display: flex; align-items: stretch; gap: 4px; }
  /* The same button language as `.seg`, which is what every other control in this panel uses —
     transparent ground, 1px border, 8px radius, 0.8rem. These were invented with their own fill and
     radius and read as though they had come from a different app. */
  .d-pick, .d-in, .d-x {
    border: 1px solid var(--border); border-radius: 8px; background: transparent;
    color: var(--text); font: inherit; font-size: 0.8rem; cursor: pointer; min-height: 44px;
  }
  .d-pick {
    flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px;
    text-align: left; padding: 7px 11px;
  }
  /* Selected shows as an accent OUTLINE, not `.seg.on`'s accent fill: a filled row in a list of
     rows reads as the list having one permanent highlight rather than one current selection. */
  .dlist li.on .d-pick, .dlist li.on .d-in { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
  .d-n { font-size: 0.8rem; font-weight: 600; }
  .d-m { font-size: 0.68rem; color: var(--text-muted); font-variant-numeric: tabular-nums; margin-left: auto; }
  /* The text rows edit in place — the list IS the editor, so there is no separate field to hunt for
     and no question about which row you are changing. */
  .d-in { flex: 1 1 auto; min-width: 0; padding: 7px 11px; cursor: text; }
  .d-in:focus { outline: none; border-color: var(--accent); }
  /* Its own size, not the text field's. The glyph inherited the 0.8rem set for the input beside it
     and was drawn as a monochrome outline besides — U+1F5D1 is text-presentation by default, so the
     markup carries the U+FE0F that asks for the colour emoji. Muted through opacity rather than
     `--text-muted`, so it is visible at rest instead of grey until you find it; the 44px box is
     untouched, because this is about the icon, not the target. */
  .d-x { flex: none; width: 44px; font-size: 1.15rem; line-height: 1; opacity: 0.75; }
  .d-x:hover { opacity: 1; color: var(--danger, #e0483d); border-color: var(--danger, #e0483d); }
  /* A motif's box is dashed rather than solid: it is a handle around a drawing, not the drawing's
     own edge, and a solid box reads as though the motif is a rectangle. */
  .el-box.decor { border-style: dashed; }
  /* Narrower than the labelled toggles beside them — they are a pair of glyphs, and at the same
     width they crowded the Arrange button off a 360px header. */
  .tog.undo { min-width: 34px; padding-left: 6px; padding-right: 6px; font-size: 1rem; }
  .tog.undo[aria-disabled='true'] { opacity: 0.35; }
</style>
