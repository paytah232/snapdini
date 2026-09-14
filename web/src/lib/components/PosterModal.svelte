<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher, tick } from 'svelte';
  import { modalFocus } from '$lib/ui';
  import Toggle from '$lib/components/Toggle.svelte';
  import { showToast } from '$lib/toast';
  import { savePoster, type EventTheme } from '$lib/events';
  import { DEFAULT_EVENT_THEME } from '$lib/theme';
  import { tickFor, cleanTick } from '$lib/challenges';
  import { drawDecor, decorFor, cameraMargin, CAMERA_TOP, DECOR_KINDS, DECOR_POSITIONS,
           type DecorKind, type DecorPos, type DecorPlacement } from '$lib/cardDecor';
  // ONE implementation of every poster drawing primitive, shared with the design wizard's preset
  // thumbnails. The card/sheet code below is a second coordinate space and stays here, but it
  // borrows the same primitives rather than keeping a copy that could drift.
  import { drawPoster, drawBrandChip, drawCover, drawUrl, fitText, roundRect, wrapToLines,
           PAGE, PAGE_W, PAGE_H, type Box, type Space, type PosterElKey, DEFAULT_POSTER_LAYOUT, clonePosterLayout,
           measureTitleBlock, measureNames, measureTextItem, qrPanelRect, symbolContrast, panelOptional, contrastGrade,
           type PosterTextItem } from '$lib/posterRender';
  import { TYPE_SETS, DEFAULT_TYPE_SET, typeSet, titleFaceOf, applyFace, castFor, clearTracking,
           ensurePosterFonts, warmAllPosterFonts, type TypeSetKey, type TitleFace } from '$lib/posterFonts';
  import EventImageEditor from './EventImageEditor.svelte';

  export let eventName: string;
  export let blurb = '';                   // event welcome blurb — used as the default poster message
  export let joinUrl: string;
  export let joinCode: string;             // the join code (8 chars)
  export let qrDataUrl: string;            // data: URL of the join QR
  export let themeImageUrl: string | null = null; // the event image (inherited by default)
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

  // ── Readable ink ───────────────────────────────────────────────────────────
  // ONE rule, used by both outputs. The poster and the card both let a host pick a background and
  // pick text colours, and nothing stopped the two colliding: white text on a white background is
  // an empty poster, and the near-black join code vanished on a dark card. Rather than overriding
  // the host's choice with flat black or white, a colour that would disappear is walked along its
  // OWN lightness until it clears a readable contrast — a gold title on white becomes a darker
  // gold, not black, so the design still looks like the one they chose.
  const rgbOf = (hex: string): [number, number, number] => {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex || '').trim());
    const n = m ? parseInt(m[1], 16) : 0;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  // WCAG relative luminance (0–1) — the gamma-corrected one, not the flat 0.299/0.587/0.114 above,
  // because it is what the contrast ratio is defined against.
  const relLum = (hex: string): number => {
    const [r, g, b] = rgbOf(hex).map((v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a: string, b: string): number => {
    const x = relLum(a), y = relLum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };
  const toHex = (r: number, g: number, b: number): string =>
    '#' + [r, g, b].map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  /** Blend a colour toward black or white by `t` (0–1) — keeps the hue, moves the lightness. */
  const shade = (hex: string, t: number, toWhite: boolean): string => {
    const [r, g, b] = rgbOf(hex), e = toWhite ? 255 : 0;
    return toHex(r + (e - r) * t, g + (e - g) * t, b + (e - b) * t);
  };
  /**
   * `hex` made readable on `bg`. Returns the colour untouched when it already reads; otherwise the
   * nearest version of itself that clears `min` contrast, darkening on a light background and
   * lightening on a dark one.
   *
   * `min` is per role, not one number: 3.0 is WCAG's bar for large display type (a poster headline,
   * a card title) and 4.5 the bar for body text — and a trick list read in the hand at 21px is body
   * text, so holding it to the headline's bar would leave it printing pale grey.
   */
  const INK_LARGE = 3.0, INK_BODY = 4.5;
  function readableOn(hex: string, bg: string, min = INK_LARGE): string {
    if (!/^#?[0-9a-f]{6}$/i.test((hex || '').trim())) return hex;
    if (contrast(hex, bg) >= min) return hex;
    const toWhite = relLum(bg) < 0.22;              // dark ground → lighten the ink, and vice versa
    // A grey — or a cream, or an off-black — has no hue worth preserving, so "the nearest version of
    // itself" is not worth having: white text on a white card would land on the palest grey that
    // scrapes past the bar. Go to ink. A properly coloured choice (gold, coral, teal) is far above
    // this threshold and keeps its hue.
    const [r, g, b] = rgbOf(hex);
    if (Math.max(r, g, b) - Math.min(r, g, b) < 40) return toWhite ? '#f5f5f5' : '#1a1a1a';
    for (let t = 0.08; t <= 1.0001; t += 0.08) {
      const c = shade(hex, t, toWhite);
      if (contrast(c, bg) >= min) return c;
    }
    return toWhite ? '#ffffff' : '#111111';         // fully blended and still short: go all the way
  }
  // What a text colour is actually sitting on. An image background is painted then darkened by 55%
  // black, so whatever the photo is, the ink lands on something dark — matching what the eye sees
  // and what the old cardDark flag assumed.
  const IMAGE_INK_BG = '#2b2b2b';
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
  const P_LAST = 6;
  // Named for what a host is deciding, not for what the code calls it. "Type" and "Join details"
  // are our vocabulary; "What does it say?" is theirs — and the step strip is the only guide anyone
  // gets on a phone, where the preview and the controls cannot both be on screen.
  const P_TITLES = ['Words', 'Type', 'Join', 'Art', 'Colour', 'Place'];
  const P_ASK = [
    'What does your sign say?',
    'How should the words look?',
    'How do guests join?',
    'Anything drawn on it?',
    'What colours?',
    'Where does everything sit?',
  ];
  // The cards get the same treatment, with their own steps — they are a different object with a
  // different job, and walking someone through "Type" again on a tab that inherits the poster's
  // pairing would be walking them through nothing.
  let cGuided = true;
  let cStep = 1;
  const C_LAST = 5;
  const C_TITLES = ['Words', 'List', 'Layout', 'Art', 'Colour'];
  // A step with nothing in it is a dead end you still have to press Next through. The List step only
  // has anything to decide once there is more than one set — with a single card there is no set to
  // choose between and no preview to flick through, so it says why and gets stepped over.
  $: cStepSkipped = (n: number) => n === 2 && sheets.length <= 1;
  $: cStepWhy = (n: number) =>
    cStepSkipped(n) ? 'Nothing to choose here — this event has one trick card, so there are no sets to pick between' : C_ASK[n - 1];
  /** The next usable step in a direction, or null at the end. */
  function cNextStep(from: number, dir: 1 | -1): number | null {
    for (let n = from + dir; n >= 1 && n <= C_LAST; n += dir) if (!cStepSkipped(n)) return n;
    return null;
  }
  // If the sets disappear while the host is standing on that step, move them off it rather than
  // leaving them on a panel with nothing in it.
  $: if (cGuided && cStepSkipped(cStep)) cStep = cNextStep(cStep, 1) ?? cNextStep(cStep, -1) ?? 1;
  const C_ASK = [
    'What goes at the top?',
    'Which tricks, and how many cards?',
    "What's on the card?",
    'Anything drawn on it?',
    'What colours?',
  ];

  const dispatch = createEventDispatcher<{ close: void }>();

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
  const cleanUrl = joinUrl.replace(/^https?:\/\//, '');

  // ── Editable state (auto-saved to localStorage per event) ──
  let headline = eventName || 'Our Event';
  // Typography. 'plain' is the default so every poster saved before this existed opens looking
  // exactly as its host left it — a design that silently restyles itself is a design you cannot trust.
  let typeSetKey: TypeSetKey = DEFAULT_TYPE_SET;
  let titleFace: TitleFace = 'display';
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
    return it ? { x: it.x, y: it.y, size: it.scale * DECOR_PX } : { x: 0.5, y: 0.5, size: DECOR_PX };
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
  let customBgUrl: string | null = null;
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

  let palette: string[] = [];
  // Colour targets for the picker + the image-palette swatches. The card's four are in the SAME
  // union so the swatch strip works on whichever tab is open rather than only on the poster.
  type CTarget = 'headline' | 'message' | 'steps' | 'code' | 'footer' | 'cardTitle' | 'cardBody' | 'cardCode' | 'cardBg';
  let activeTarget: CTarget = 'headline';
  let editorFile: File | null = null;

  // ── Trick cards: a second OUTPUT of the same design, not a second design ──
  // The printable trick card is how a shot list actually reaches a guest: A6, A5 or A4 cards to an
  // A4 sheet, one per place setting. It borrows the poster's title, colours, background and join
  // details so the two read as one printed set; what is card-specific is the shot list itself, the
  // card's own layout, its decoration, and an ink-saver option — four cards a sheet on a home
  // printer is a very different ink bill from one poster.
  type MissionSet = { key: string; label: string; items: { id: string; text: string }[] };
  let view: 'poster' | 'cards' = 'poster';
  let sheets: MissionSet[] = [];
  let eventType: string | null = null;
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
  let cardsPerSheet: 1 | 2 | 4 = 4;
  let cardRound = true;                    // square corners let the card edge match the cut line exactly
  let cardIds = true;                      // print "Card A" / "Card B" — off = shuffle and hand out at random
  let cardSkip: string[] = [];             // set keys NOT to print; stored as exclusions so a NEW set is included by default
  let cardShowQr = true;
  let cardShowLink = true;
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
  let cardCTitle = '', cardCBody = '', cardCCode = '', cardCBg = '';
  // Decoration: the line-art layer. Blank kind = "not chosen yet" → the event type picks one.
  let decorKind: DecorKind | '' = '';
  let decorPos: DecorPos = 'top';
  let decorScale = 1;
  let decorColour = '';                    // blank = follow the card's title ink
  // The card's own free layout. Positions are fractions of the CARD (not the sheet), so a design
  // survives switching between 4-up, 2-up and 1-up; sizes are in A6 px and are multiplied by the
  // paper scale below, so a card on a bigger sheet grows rather than floating in white space.
  type CardElKey = 'title' | 'qr';
  const DEFAULT_CARD_LAYOUT: Record<CardElKey, Box> = {
    title: { x: 0.5, y: 0.17, size: 34 },
    qr:    { x: 0.5, y: 0.82, size: 200 },
  };
  const cloneCardLayout = (l: Record<CardElKey, Box>): Record<CardElKey, Box> =>
    ({ title: { ...l.title }, qr: { ...l.qr } });
  let cardLayout: Record<CardElKey, Box> = cloneCardLayout(DEFAULT_CARD_LAYOUT);
  let cardStageEl: HTMLDivElement;
  let cardDragKey: CardElKey | null = null;
  let cardSelectedKey: CardElKey | null = null;

  // ── Persistence (auto-save on every change) ──
  // The server stores this as a bounded JSON blob, so it stays deliberately compact: drag values are
  // rounded (see roundBox) rather than carrying fifteen decimal places of pointer noise.
  $: cfg = { headline, headlineTop, headlineBottom, names, showBrand, qrPanel, decorItems, textItems, typeSetKey, titleFace, message, stepsText, bgMode, cBg, printBg, codeDisplay, showFooterUrl, layout, colorsLocked, cHeadline, cMessage, cSteps, cCode, cFooter,
             cardTitle, cardInkSaver, cardsPerSheet, cardRound, cardIds, cardSkip, cardShowQr, cardShowLink, cardCaption,
             cardCTitle, cardCBody, cardCCode, cardCBg, cardLayout, cardSheetLandscape, decorKind, decorPos, decorScale, decorColour };
  // Keep the default text colours readable as the background changes — until the organizer edits a
  // colour (colorsLocked). The void refs make Svelte re-run this when bgMode/cBg/theme change.
  $: if (!colorsLocked) { void bgMode; void cBg; void theme; ({ cHeadline, cMessage, cSteps, cCode, cFooter } = themeDefaults()); }
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
  };
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

  function pushUndo(snap: string) {
    if (!snap || snap === undoStack[undoStack.length - 1]) return;
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
    showBrand = c.showBrand ?? true; qrPanel = c.qrPanel ?? true;
    decorItems = Array.isArray(c.decorItems) ? (c.decorItems as DecorPlacement[]).map((d) => ({ ...d })) : [];
    textItems = Array.isArray(c.textItems) ? (c.textItems as PosterTextItem[]).map((t) => ({ ...t })) : [];
    typeSetKey = c.typeSetKey ?? DEFAULT_TYPE_SET; titleFace = c.titleFace ?? 'display';
    bgMode = c.bgMode; cBg = c.cBg; codeDisplay = c.codeDisplay; showFooterUrl = c.showFooterUrl;
    printBg = c.printBg ?? true;   // absent in designs saved before the option existed
    layout = cloneLayout(c.layout);
    colorsLocked = c.colorsLocked;
    cHeadline = c.cHeadline; cMessage = c.cMessage; cSteps = c.cSteps; cCode = c.cCode; cFooter = c.cFooter;
    cardTitle = c.cardTitle; cardInkSaver = c.cardInkSaver;
    cardsPerSheet = c.cardsPerSheet; cardRound = c.cardRound; cardIds = c.cardIds; cardSkip = [...(c.cardSkip ?? [])];
    cardShowQr = c.cardShowQr; cardShowLink = c.cardShowLink; cardCaption = c.cardCaption;
    cardCTitle = c.cardCTitle; cardCBody = c.cardCBody; cardCCode = c.cardCCode; cardCBg = c.cardCBg;
    cardSheetLandscape = c.cardSheetLandscape ?? false;
    cardLayout = cloneCardLayout(c.cardLayout);
    decorKind = c.decorKind; decorPos = c.decorPos; decorScale = c.decorScale; decorColour = c.decorColour;
  }
  async function step(from: string[], to: string[], setFrom: (v: string[]) => void, setTo: (v: string[]) => void) {
    if (!from.length) return;
    commitBurst();
    const snap = from[from.length - 1];
    setFrom(from.slice(0, -1));
    setTo([...to, JSON.stringify(cfg)].slice(-UNDO_LIMIT));
    applyingHistory = true;
    applyCfg(JSON.parse(snap));
    await tick();
    bounds = measureBounds();
    scheduleRedraw();
    prevCfg = JSON.stringify(cfg);
    applyingHistory = false;
    persist();
  }
  const undo = () => step(undoStack, redoStack, (v) => (undoStack = v), (v) => (redoStack = v));
  const redo = () => step(redoStack, undoStack, (v) => (redoStack = v), (v) => (undoStack = v));

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
    // Escape peels ONE layer at a time, innermost first. The designer had no Escape at all, so the
    // only way out of any of this was finding the right ✕ — and a modal that traps focus and then
    // ignores Escape is a room with the handle on the outside.
    //
    // Order matters: closing the whole designer from inside the front-and-back preview would throw
    // away the panel and the work behind it in one keystroke.
    if (e.key === 'Escape') {
      if (finishOpen) { finishOpen = false; return; }
      if (fsEdit) { fsEdit = false; return; }
      dispatch('close');
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); void undo(); }
    else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); void redo(); }
  }

  // Auto-save the design to the DB (debounced) so it persists across devices.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  function persist() {
    if (!orgCode) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => { savePoster(joinCode, orgCode, cfg).catch(() => {}); }, 800);
  }
  function restore() {
    const c = initialConfig;
    if (!c) return;
    headline = (c.headline as string) ?? headline; message = (c.message as string) ?? message; stepsText = (c.stepsText as string) ?? stepsText;
    headlineTop = (c.headlineTop as string) ?? headlineTop; headlineBottom = (c.headlineBottom as string) ?? headlineBottom;
    names = (c.names as string) ?? names;
    showBrand = (c.showBrand as boolean) ?? showBrand;
    qrPanel = (c.qrPanel as boolean) ?? qrPanel;
    if (Array.isArray(c.textItems)) {
      textItems = (c.textItems as unknown[]).flatMap((raw) => {
        const t = raw as Partial<PosterTextItem>;
        if (typeof t.text !== 'string') return [];
        const num = (v: unknown, lo: number, hi: number, d: number) =>
          typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d;
        return [{ text: t.text.slice(0, 80), x: num(t.x, 0, 1, 0.5), y: num(t.y, 0, 1, 0.7), size: num(t.size, 14, 120, 30) }];
      });
    }
    // Validated element by element: this is a stored blob, and a bad entry here reaches drawDecorAt
    // as NaN coordinates, which paints nothing and looks like the motif silently vanishing.
    if (Array.isArray(c.decorItems)) {
      decorItems = (c.decorItems as unknown[]).flatMap((raw) => {
        const d = raw as Partial<DecorPlacement>;
        if (!DECOR_KINDS.some((k) => k.key === d.kind && k.positional)) return [];
        const num = (v: unknown, lo: number, hi: number, dflt: number) =>
          typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt;
        return [{
          kind: d.kind as DecorKind,
          x: num(d.x, 0, 1, 0.5), y: num(d.y, 0, 1, 0.3),
          scale: num(d.scale, 0.4, 2.2, 1), rot: num(d.rot, -Math.PI, Math.PI, 0),
          colour: typeof d.colour === 'string' ? d.colour : undefined,
        }];
      });
    }
    // Validated rather than trusted: the blob is stored server-side and an unknown key here would
    // reach ctx.font as a family name that does not exist, which fails silently in Arial.
    if (TYPE_SETS.some((t) => t.key === c.typeSetKey)) typeSetKey = c.typeSetKey as TypeSetKey;
    if (c.titleFace === 'display' || c.titleFace === 'script') titleFace = c.titleFace;
    bgMode = (c.bgMode as typeof bgMode) ?? bgMode; cBg = (c.cBg as string) ?? cBg; codeDisplay = (c.codeDisplay as typeof codeDisplay) ?? codeDisplay; showFooterUrl = (c.showFooterUrl as boolean) ?? showFooterUrl;
    if (c.layout) layout = { ...cloneLayout(DEFAULT_LAYOUT), ...(c.layout as Record<ElKey, Box>) };
    // Colours: only restore saved ones once the organizer locked them in by editing. Otherwise
    // keep the theme-derived defaults so the poster keeps tracking the event palette.
    if (c.colorsLocked) {
      colorsLocked = true;
      cHeadline = (c.cHeadline as string) ?? cHeadline; cMessage = (c.cMessage as string) ?? cMessage; cSteps = (c.cSteps as string) ?? cSteps;
      cCode = (c.cCode as string) ?? cCode; cFooter = (c.cFooter as string) ?? cFooter;
    }
    // Card settings are plain overrides — an absent one keeps meaning "follow the poster". Every
    // one of these is read with ?? so a design saved before the setting existed still opens.
    cardTitle = (c.cardTitle as string) ?? cardTitle;
    cardInkSaver = (c.cardInkSaver as boolean) ?? cardInkSaver;
    const per = c.cardsPerSheet as number;
    if (per === 1 || per === 2 || per === 4) cardsPerSheet = per;
    cardRound = (c.cardRound as boolean) ?? cardRound; cardIds = (c.cardIds as boolean) ?? cardIds;
    if (Array.isArray(c.cardSkip)) cardSkip = (c.cardSkip as string[]).filter((k) => typeof k === 'string');
    cardShowQr = (c.cardShowQr as boolean) ?? cardShowQr; cardShowLink = (c.cardShowLink as boolean) ?? cardShowLink;
    cardCaption = (c.cardCaption as string) ?? cardCaption;
    cardCTitle = (c.cardCTitle as string) ?? cardCTitle; cardCBody = (c.cardCBody as string) ?? cardCBody;
    cardCCode = (c.cardCCode as string) ?? cardCCode; cardCBg = (c.cardCBg as string) ?? cardCBg;
    cardSheetLandscape = (c.cardSheetLandscape as boolean) ?? cardSheetLandscape;
    if (c.cardLayout) cardLayout = { ...cloneCardLayout(DEFAULT_CARD_LAYOUT), ...(c.cardLayout as Record<CardElKey, Box>) };
    // A saved decoration wins over the event-type default; blank still means "let the type decide".
    if (typeof c.decorKind === 'string' && DECOR_KINDS.some((d) => d.key === c.decorKind)) decorKind = c.decorKind as DecorKind;
    if (c.decorPos === 'top' || c.decorPos === 'corners' || c.decorPos === 'both') decorPos = c.decorPos;
    if (typeof c.decorScale === 'number' && c.decorScale > 0) decorScale = c.decorScale;
    decorColour = (c.decorColour as string) ?? decorColour;
    if (bgMode === 'custom') bgMode = themeImageUrl ? 'event' : 'plain'; // custom blob can't persist across reloads
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
      headline, headlineTop, headlineBottom, names, showBrand, qrPanel, decorItems, textItems, typeSet: typeSetKey, titleFace,
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

  async function draw() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    canvas.width = W; canvas.height = H;
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
  let selectedKey: string | null = null;   // click-to-select → reveals that element's outline + grip
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
    { key: 'brand', label: 'Logo', show: showBrand, resizable: false, axis: 'x' },
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
  function textBounds(ctx: CanvasRenderingContext2D, text: string, weight: number, box: Box, maxW: number, sp: Space = PAGE, sizePx = box.size): Rect {
    ctx.font = `${weight} ${sizePx}px "Helvetica Neue", Arial, sans-serif`;
    const lines = wrapToLines(ctx, text, maxW);
    const lh = sizePx * 1.18, h = Math.max(lines.length, 1) * lh;
    let w = 0; for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
    return { x: sp.ox + box.x * sp.w - w / 2, y: sp.oy + box.y * sp.h - h / 2, w, h };
  }
  // The title is the one element whose footprint the renderer alone knows how to work out — it can
  // be three rows in two faces at two sizes. Ask it, rather than keeping a second guess here.
  function titleBounds(ctx: CanvasRenderingContext2D, box: Box): Rect {
    const { w, h } = measureTitleBlock(ctx, { headline, headlineTop, headlineBottom, typeSet: typeSetKey, titleFace }, box);
    return { x: box.x * W - w / 2, y: box.y * H - h / 2, w, h };
  }
  // Like the title, the lockup is several rows in two faces — and its hairlines stick out past the
  // joiner, so only the renderer knows how wide it really is.
  function namesBounds(ctx: CanvasRenderingContext2D, box: Box): Rect {
    const { w, h } = measureNames(ctx, { headline, headlineTop, headlineBottom, names, typeSet: typeSetKey, titleFace }, box);
    return { x: box.x * W - w / 2, y: box.y * H - h / 2, w, h };
  }
  function footerBounds(ctx: CanvasRenderingContext2D, box: Box): Rect {
    const maxW = W - 120;
    ctx.font = `400 ${box.size}px ui-monospace, Menlo, Consolas, monospace`;
    const full = ctx.measureText(cleanUrl).width;
    if (full <= maxW) return { x: box.x * W - full / 2, y: box.y * H - box.size / 2, w: full, h: box.size };
    const i = cleanUrl.indexOf('/');
    const domain = i === -1 ? cleanUrl : cleanUrl.slice(0, i), path = i === -1 ? '' : cleanUrl.slice(i);
    const w = Math.min(maxW, Math.max(ctx.measureText(domain).width, ctx.measureText(path).width));
    const h = path ? box.size * 1.25 + box.size * 0.82 : box.size;
    return { x: box.x * W - w / 2, y: box.y * H - box.size / 2, w, h };
  }
  // The renderer owns this geometry; asking it is what keeps the drag outline on the panel it is
  // supposed to be outlining.
  const qrBounds = (box: Box): Rect => qrPanelRect(box, codeDisplay);
  function brandBounds(ctx: CanvasRenderingContext2D): Rect {
    ctx.font = `600 ${layout.brand.size}px "Helvetica Neue", Arial, sans-serif`;
    const w = ctx.measureText('🎩 Snapdini').width, h = layout.brand.size * 1.2;
    return { x: layout.brand.x * W - w / 2, y: layout.brand.y * H - h / 2, w, h };
  }
  const ZERO_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };
  function measureBounds(): Record<ElKey, Rect> {
    const ctx = measureCtx();
    if (!ctx) return { brand: ZERO_RECT, title: ZERO_RECT, message: ZERO_RECT, steps: ZERO_RECT, qr: ZERO_RECT, footer: ZERO_RECT, names: ZERO_RECT };
    return {
      brand: brandBounds(ctx),
      title: titleBounds(ctx, layout.title),
      message: textBounds(ctx, message || ' ', 400, layout.message, W - 200),
      steps: textBounds(ctx, stepsText || ' ', 500, layout.steps, W - 120),
      qr: qrBounds(layout.qr),
      names: namesBounds(ctx, layout.names),
      footer: footerBounds(ctx, layout.footer),
    };
  }
  // Recompute whenever anything that affects a footprint changes. Each dependency is referenced in
  // the assignment expression itself (comma operator) so Svelte tracks them reliably — text content,
  // the QR's code/URL toggle and footer visibility all change an element's measured size.
  let bounds: Record<ElKey, Rect> = measureBounds();
  $: bounds = (layout, headline, headlineTop, headlineBottom, names, showBrand, qrPanel, typeSetKey, titleFace, message, stepsText, codeDisplay, showFooterUrl, mounted, measureBounds());
  // A motif's footprint is a square around its anchor — the drawings are roughly as tall as they are
  // wide, and an exact hull would need every motif to measure itself. A square is honest enough to
  // grab and to keep inside the print margin, which is all the rect is used for.
  $: textRects = (() => {
    const ctx = measureCtx();
    if (!ctx) return {} as Record<string, Rect>;
    return Object.fromEntries(textItems.map((t, i) => {
      const { w, h } = measureTextItem(ctx, { typeSet: typeSetKey }, t);
      return [`text:${i}`, { x: t.x * W - w / 2, y: t.y * H - h / 2, w, h }];
    })) as Record<string, Rect>;
  })();
  $: decorRects = Object.fromEntries(decorItems.map((it, i) => {
    const side = Math.min(it.scale * DECOR_PX, Math.min(W, H) * 0.34);
    return [`decor:${i}`, { x: it.x * W - side / 2, y: it.y * H - side / 2, w: side, h: side }];
  })) as Record<string, Rect>;

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
    /** Can this element be scaled at all? A pinch has no grip to hide behind, so it has to ask. */
    resizable?: (key: string) => boolean;
    move: (key: string, x: number, y: number) => void;
    size: (key: string, px: number) => void;
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

  function dragOn(surf: Surface, key: string, mode: 'move' | 'resize', e: PointerEvent) {
    // Before anything moves, so the whole drag undoes as one action.
    commitBurst();
    pushUndo(JSON.stringify(cfg));
    e.preventDefault(); e.stopPropagation();
    const stage = surf.stage(); if (!stage) return;
    // What was selected BEFORE this gesture touched anything. A pinch needs it: see onDown.
    const wasSelected = selectedOn(surf);
    surf.dragging(key); surf.select(key);
    const rect = stage.getBoundingClientRect();
    // Rebased when the dead zone is crossed, so engaging a drag never jumps the element by the slop
    // that got it there — the element picks up exactly where the finger committed.
    let start = { x: e.clientX, y: e.clientY };
    const box0 = { ...surf.box(key) };
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
      }
      if (!(surf.resizable?.(pinchKey) ?? true)) return;
      if (pts.size >= 2) return;
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      const [a, c] = [...pts.values()];
      const d0 = Math.hypot(a.x - c.x, a.y - c.y);
      if (d0 < 1) { pts.delete(ev.pointerId); return; }   // two fingers on one spot: no scale to read
      // From the CURRENT size, not box0 — the first finger may already have resized it.
      pinch = { d0, size0: surf.box(pinchKey).size };
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
        surf.size(pinchKey, r1(clamp(pinch.size0 * (d / pinch.d0), lo, hi)));
      } else {
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
            const sx = snapAxis(rawX * surf.w, b.w / 2, linesX, surf.w / 2, thrX);
            if (sx) { rawX += sx.d / surf.w; snapX = sx.line / surf.w; }
            if (!surf.lockY?.(key)) {
              const sy = snapAxis(rawY * surf.h, b.h / 2, linesY, surf.h / 2, thrY);
              if (sy) { rawY += sy.d / surf.h; snapY = sy.line / surf.h; }
            }
          }
          const x = loX > hiX ? 0.5 : clamp(rawX, loX, hiX);
          const y = surf.lockY?.(key) ? box0.y : (loY > hiY ? 0.5 : clamp(rawY, loY, hiY));
          // If the clamp had to move a snapped centre, the guide is now pointing at a line the
          // element is NOT on. Drop it rather than draw a lie.
          if (snapX !== null && Math.abs(x - rawX) > 1e-6) snapX = null;
          if (snapY !== null && Math.abs(y - rawY) > 1e-6) snapY = null;
          surf.move(key, r4(x), r4(y));
        } else {
          // Touch gets a gain: at 3.4 design px per finger px, an unscaled grip moved `size` by ~68px
          // in a 20px flick. Coarse scaling on a phone is what the pinch is for.
          const gain = touch ? TOUCH_RESIZE_GAIN : 1;
          const dpx = (((ev.clientX - start.x) * gain) / rect.width) * surf.w;
          const [lo, hi] = surf.limits(key);
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
    rects: () => ({ ...bounds, ...decorRects, ...textRects }),
    box: (k) => {
      const d = decorIdx(k); if (d >= 0) return decorBox(d);
      const t = textIdx(k); if (t >= 0) { const it = textItems[t]; return it ? { x: it.x, y: it.y, size: it.size } : { x: 0.5, y: 0.7, size: 30 }; }
      return layout[k as ElKey];
    },
    // The QR floor is what keeps a code with our logo punched into its centre scannable. A motif's
    // range is its own scale clamp (0.4–2.2) expressed in pixels, so the renderer never has to
    // second-guess a size the designer allowed.
    limits: (k) => (decorIdx(k) >= 0 ? [0.4 * DECOR_PX, 2.2 * DECOR_PX] : textIdx(k) >= 0 ? [14, 120] : k === 'qr' ? [QR_MIN_PX, 760] : [16, 170]),
    lockY: (k) => k === 'brand',      // the brand mark slides left/right along the top only
    // The brand mark has no resize grip, so a pinch must not give it one by the back door.
    resizable: (k) => k !== 'brand',
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
    remeasure: () => { bounds = measureBounds(); },
    redraw: scheduleRedraw,
    select: (k) => (selectedKey = k),
    selected: () => selectedKey,
    dragging: (k) => (dragKey = k),
  };
  function startDrag(key: string, mode: 'move' | 'resize', e: PointerEvent) { dragOn(posterSurface, key, mode, e); }

  // ── Edit it where it is ─────────────────────────────────────────────────────
  // On a phone the controls are BELOW the preview, so changing the title meant scrolling down to a
  // field, typing blind, and scrolling back up to see what happened — for every word. Tapping the
  // words themselves puts the caret where the host is already looking.
  //
  // Only the text elements: the QR is an image, the brand mark is fixed wording, and the footer is
  // the join URL, which is not the host's to write.
  type EditKey = 'title' | 'message' | 'steps' | 'names';
  const EDITABLE: Record<EditKey, { label: string; get: () => string; set: (v: string) => void; max: number }> = {
    title:   { label: 'Title',       get: () => headline,   set: (v) => (headline = v),   max: 60 },
    message: { label: 'Message',     get: () => message,    set: (v) => (message = v),    max: 80 },
    steps:   { label: 'How-to line', get: () => stepsText,  set: (v) => (stepsText = v),  max: 120 },
    names:   { label: 'Names',       get: () => names,      set: (v) => (names = v),      max: 60 },
  };
  const isEditable = (k: string): k is EditKey => k in EDITABLE;
  let editingKey: EditKey | null = null;
  let editEl: HTMLInputElement | undefined;

  async function tapElement(key: string) {
    // Only a tap opens it. After a drag the click is the tail of the gesture that just moved the
    // element, and opening a keyboard then would cover the thing they were positioning.
    if (!tapped || !isEditable(key)) return;
    pushUndo(JSON.stringify(cfg));
    editingKey = key;
    await tick();
    editEl?.focus(); editEl?.select();
  }
  function endEdit() { editingKey = null; }
  /** Narrow helpers for the markup, where a TypeScript cast is a syntax error. */
  $: editSpec = editingKey ? EDITABLE[editingKey] : null;
  const setEdit = (v: string) => { if (editingKey) EDITABLE[editingKey].set(v); };

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
  $: if (mounted) { void cfg; void customBgUrl; scheduleRedraw(); persist(); }

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
    if (activeTarget === 'cardTitle') { cardCTitle = hex; return; }
    if (activeTarget === 'cardBody') { cardCBody = hex; return; }
    if (activeTarget === 'cardCode') { cardCCode = hex; return; }
    if (activeTarget === 'cardBg') { cardCBg = hex; return; }
    colorsLocked = true;   // editing any colour locks the palette (stops it tracking the theme)
    if (activeTarget === 'headline') cHeadline = hex; else if (activeTarget === 'message') cMessage = hex;
    else if (activeTarget === 'steps') cSteps = hex; else if (activeTarget === 'code') cCode = hex; else cFooter = hex;
  }
  function onColorInput(e: Event, key: CTarget) {
    activeTarget = key;
    applySwatch((e.target as HTMLInputElement).value);
  }

  // ── Custom background via the shared cropper ──
  function onBgFile(e: Event) { const i = e.target as HTMLInputElement; const f = i.files?.[0]; i.value = ''; if (f) editorFile = f; }
  function onBgCropped(e: CustomEvent<Blob>) {
    if (customBgUrl) URL.revokeObjectURL(customBgUrl);
    customBgUrl = URL.createObjectURL(e.detail); imgCache.delete(customBgUrl);
    bgMode = 'custom'; editorFile = null;
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
      if (d?.qrCode) { qrImg = d.qrCode; scheduleRedraw(); }
    } catch { /* keep the provided QR */ }
  }
  onMount(() => {
    restore(); mounted = true; loadPosterQr(); loadMissions();
    draw().catch(() => { busy = false; showToast('Could not build the poster', true); });
    // Pull every bundled face down once the designer is open, then redraw. drawPoster awaits the
    // set it needs anyway, so this is not correctness — it is so that flipping between pairings is
    // instant instead of showing a frame of the fallback stack on each first visit.
    warmAllPosterFonts().then(() => { if (mounted) { bounds = measureBounds(); draw().catch(() => {}); } });
  });
  onDestroy(() => { if (customBgUrl) URL.revokeObjectURL(customBgUrl); });

  // `kind` names what was exported — the poster and each set's card sheet land in the same
  // downloads folder, so "cards-b" has to be distinguishable from "poster" at a glance.
  function download(blob: Blob, ext: string, kind = 'poster') {
    const href = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = href; a.download = `${slug}-${kind}.${ext}`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(href);
  }
  const blobFrom = (type: string, q?: number) =>
    new Promise<void>((res) => canvas.toBlob((b) => { if (b) download(b, type === 'image/png' ? 'png' : 'jpg'); res(); }, type, q));
  function exportPng() { void asPrinted(() => blobFrom('image/png')); }
  function exportJpg() { void asPrinted(() => blobFrom('image/jpeg', 0.92)); }
  async function exportPdf() {
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
      await asPrinted(() => {
        pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pdf.internal.pageSize.getWidth(), pdf.internal.pageSize.getHeight());
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
  let finishOpen = false;
  let finishBusy = false;
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

  async function openFinish() {
    finishOpen = true; finishBusy = true;
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
        if (fctx) { await drawPoster(fctx, posterOpts()); paintInto(fFront, full); }
        else if (canvas) paintInto(fFront, canvas);
      });
      if (activeSheet) paintInto(fBack, await sheetCanvas(activeSheet));
    } catch { showToast('Could not build the preview', true); }
    finally { finishBusy = false; }
  }

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
      finishOpen = false;
      showToast('Two pages — set your printer to double-sided, flip on the LONG edge');
    } catch { showToast('Could not build the double-sided print', true); }
  }

  function printPoster() { void asPrinted(printPosterNow); }
  function printPosterNow() {
    const url = canvas.toDataURL('image/png'); const w = window.open('', '_blank');
    if (!w) { showToast('Allow pop-ups to print', true); return; }
    // Three things this fixes, all of them the browser's defaults rather than our design:
    //   @page margin:0   — Chrome draws its own date/URL header and footer in the page margin, so
    //                      removing the margin is what removes them. It also stops the ~12mm inset.
    //   body margin:0    — otherwise the poster sits 8px in from the paper edge even at margin:0,
    //                      which is why a full-bleed background stopped short of the edge.
    //   display:block    — an inline image carries a text baseline under it, leaving a hairline
    //                      strip of white along the bottom.
    // The card sheets already print this way; the poster was the one still on defaults.
    w.document.write(
      '<style>@page{size:A4;margin:0}html,body{margin:0;padding:0}'
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
  const CARD_SCALE = 2;                // 2× A4 out: at 1× a 12px mission line prints mushy
  /** What the printer has to be told. A landscape sheet sent to a portrait page is letterboxed —
   *  printed at half size inside two white bands — and nothing on screen would have warned of it. */
  $: sheetOrientation = (cardSheetLandscape ? 'landscape' : 'portrait') as 'landscape' | 'portrait';
  const CARD_GAP = 10;                 // gutter inside the cut line, so scissors have somewhere to go
  const CARD_PAD = 34;                 // ≈6.6mm of quiet space inside the card's edge
  // The card's QR. QR_MIN_PX (≈33mm) is the floor that keeps a code with our logo punched into its
  // centre scannable, and this clears it at ≈39mm. QR_WARN_PX (≈45mm) is deliberately NOT applied
  // here: that line sizes a code to be read across a room, and a card is held in the hand.
  const CARD_QR_PX = 200;
  const CARD_QR_MAX = 420;
  // The cards carry the poster's pairing. They were hardcoded to Helvetica in thirteen places, so
  // choosing a typeface restyled the poster and left the cards it prints alongside it unchanged —
  // one design, two voices, on the same table.
  //
  // The BODY face only, for the list and the join details: a trick list is read at arm's length in
  // low light, and the display face's tracking and casing are wrong for a column of short lines.
  // The title takes the full face, because that is the one thing on the card doing the design's job.
  let CARD_FAMILY = '"Helvetica Neue", Arial, sans-serif';
  $: cardTypeSet = typeSet(typeSetKey);
  $: CARD_FAMILY = cardTypeSet.body.family;
  $: cardTitleFace = titleFaceOf(cardTypeSet, titleFace);
  const CARD_MONO = 'ui-monospace, Menlo, Consolas, monospace';

  // How the sheet is divided, and the paper scale that follows from it. Every measurement below is
  // multiplied by `cardUnit`, so a design keeps its proportions when the host changes how many cards
  // go on a sheet.
  //
  // The scale follows the card's HEIGHT, not its area: a quarter-sheet A6 and a half-sheet A5 are
  // both half an A4 tall, so the vertical space — the only thing a list down a card competes for —
  // is identical, and only the full-page card is twice as tall. Scaling A5 by area instead would
  // make its QR half again as tall for no gain and squeeze the trick list into the gap; this way the
  // extra width of a half-sheet card goes where it is actually useful, into longer lines.
  // Which way up the SHEET goes — at EVERY card count, not just 2-up.
  //
  // It was gated to 2-up on the reasoning that only there does the shape change. That is true of the
  // CARD's proportions and beside the point: a host may simply want to print landscape, and a
  // landscape sheet is a legitimate choice at one, two or four to a page. Turning the paper turns
  // every card on it — four landscape A6, two portrait A5, one landscape A4.
  let cardSheetLandscape = false;
  $: sheetW = cardSheetLandscape ? H : W;
  $: sheetH = cardSheetLandscape ? W : H;
  // The split follows the paper: a portrait sheet halves across, a landscape one halves down the
  // middle, and both fill it exactly either way.
  $: cardCols = cardsPerSheet === 4 ? 2 : (cardsPerSheet === 2 && cardSheetLandscape ? 2 : 1);
  $: cardRows = cardsPerSheet === 1 ? 1 : (cardsPerSheet === 2 && cardSheetLandscape ? 1 : 2);
  $: slotW = sheetW / cardCols;
  $: slotH = sheetH / cardRows;
  $: cardUnit = cardsPerSheet === 1 ? 2 : 1;
  /** What the chosen paper actually produces, said in card shapes rather than in paper sizes —
   *  "two landscape A5s" is the thing being decided; "A4 landscape" is how it gets there. */
  $: cardShapeNote =
    cardsPerSheet === 1
      ? (cardSheetLandscape ? 'One landscape A4 card — the whole sheet.' : 'One portrait A4 card — the whole sheet.')
      : cardsPerSheet === 2
        ? (cardSheetLandscape ? 'Two portrait A5 cards, cut down the middle.' : 'Two landscape A5 cards, cut across the middle.')
        : (cardSheetLandscape ? 'Four landscape A6 cards.' : 'Four portrait A6 cards.');

  // Which sets actually go to the printer. Stored as EXCLUSIONS so a set added to the trick list
  // later is printed by default rather than silently left out of the stack.
  $: printSets = sheets.filter((s) => !cardSkip.includes(s.key));
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
  // What the card is actually printed on. A card colour of its own beats the poster's image: asking
  // for a colour is asking for a plain card.
  $: cardBgHex = cardInkSaver ? '#ffffff' : (cardCBg || cBg || '#ffffff');
  $: cardUseImage = !cardInkSaver && !cardCBg
    && !!(bgMode === 'custom' ? customBgUrl : bgMode === 'event' ? themeImageUrl : null);
  $: cardGround = cardUseImage ? IMAGE_INK_BG : cardBgHex;
  $: cardDark = relLum(cardGround) < 0.22;
  // The card inherits the poster's colours unless the host overrode one here — and either way every
  // colour goes through readableOn against the card's own ground, because a colour that is right on
  // the poster is not necessarily right on a card the host has since made white.
  $: cardInk = {
    title: readableOn(cardCTitle || cHeadline, cardGround),
    body:  readableOn(cardCBody || cSteps, cardGround, INK_BODY),
    code:  readableOn(cardCCode || cCode, cardGround, INK_BODY),
    muted: cardDark ? 'rgba(255,255,255,0.72)' : '#6b6b6b',
    rule:  cardDark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.16)',
  };
  // ── The tick's ink ─────────────────────────────────────────────────────────
  // The tick is the one piece of event branding sitting inside the body text, so it follows the
  // design's accent-bearing ink — the card's title override, else the poster title, which itself
  // defaults to (and tracks) the event accent — instead of printing as flat body ink. A host who
  // has set the trick-list colour has said what that whole column should be, so that override
  // still wins over the theme. readableOn at the BODY bar rather than the large-type one, because
  // the tick is set at the trick line's own size and read in the hand: a pale accent on a white
  // card is walked down until it is legible rather than printed as a ghost.
  $: cardTickInk = cardCBody
    ? cardInk.body
    : readableOn(cardCTitle || cHeadline, cardGround, INK_BODY);
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

  // ── Card geometry ───────────────────────────────────────────────────────────
  // One source of truth for where things sit on a card: the drawing code and the drag outlines both
  // read it, so an outline can never claim a size the printed card disagrees with.
  type CardBox = { x0: number; y0: number; cw: number; ch: number; u: number; pad: number; innerW: number; sp: Space };
  /** The card occupying the slot whose top-left is (ox, oy). */
  function cardBoxAt(ox: number, oy: number): CardBox {
    const u = cardUnit, gap = CARD_GAP * u, pad = CARD_PAD * u;
    const x0 = ox + gap, y0 = oy + gap, cw = slotW - gap * 2, ch = slotH - gap * 2;
    return { x0, y0, cw, ch, u, pad, innerW: cw - pad * 2, sp: { w: cw, h: ch, ox: x0, oy: y0 } };
  }
  /** Put a block's CENTRE on the card, keeping its whole footprint inside the card's quiet margin.
   *
   *  A Box is a fraction of the card, but the thing it positions is sized in paper-scaled px — so
   *  the same fraction that sits an A6 card's QR neatly above its bottom margin hangs an A5 card's
   *  larger QR over the edge. Clamping here rather than at the defaults means it holds for a dragged
   *  position too, and the drag outline follows because it measures the same rects. */
  function placeOnCard(g: CardBox, box: Box, w: number, h: number): { x: number; y: number } {
    const lox = g.pad + w / 2, hix = g.cw - g.pad - w / 2;
    const loy = g.pad + h / 2, hiy = g.ch - g.pad - h / 2;
    return {
      x: g.sp.ox + (lox <= hix ? clamp(box.x * g.cw, lox, hix) : g.cw / 2),
      y: g.sp.oy + (loy <= hiy ? clamp(box.y * g.ch, loy, hiy) : g.ch / 2),
    };
  }
  /** The card identifier printed above the title — suppressed entirely when the host turns it off,
   *  and pointless when there is only one set to confuse it with. */
  const cardLabelFor = (set: MissionSet | null): string =>
    cardIds && sheets.length > 1 && set ? set.label.toUpperCase() : '';

  // `px` and `lh` are the size the face ACTUALLY draws at and its own line height — a script sets
  // much smaller than a sans for the same requested px, so measuring at one and drawing at the other
  // is how a title ends up overlapping the rule under it.
  type TitleGeom = { rect: Rect; size: number; px: number; lh: number; lines: string[]; labelSize: number; label: string };
  function titleGeom(ctx: CanvasRenderingContext2D, g: CardBox, set: MissionSet | null): TitleGeom {
    const size = cardLayout.title.size * g.u, labelSize = 19 * g.u, label = cardLabelFor(set);
    const px = applyFace(ctx, cardTitleFace, size);
    const lh = px * cardTitleFace.lineHeight;
    // Two lines at most: past that there is no card left for the tricks.
    const lines = wrapToLines(ctx, castFor(cardTitleFace, cardHeading), g.innerW).slice(0, 2);
    let w = 0;
    for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
    clearTracking(ctx);
    if (label) { ctx.font = `700 ${labelSize}px ${CARD_FAMILY}`; w = Math.max(w, ctx.measureText(label).width); }
    w = Math.min(w, g.innerW);
    const h = lines.length * lh + (label ? labelSize * 1.5 : 0);
    const c = placeOnCard(g, cardLayout.title, w, h);
    return { rect: { x: c.x - w / 2, y: c.y - h / 2, w, h }, size, px, lh, lines, labelSize, label };
  }

  // The join block — QR, "Scan to join" + the code/link, and the caption — moves and resizes as ONE
  // thing, because a QR that drifts away from the link beside it is two orphans rather than a block.
  type JoinGeom = { rect: Rect; qr: Rect | null; tx: number; tw: number; ts: number; capLines: string[] } | null;
  function joinGeom(ctx: CanvasRenderingContext2D, g: CardBox): JoinGeom {
    const qrPx = cardShowQr ? cardLayout.qr.size * g.u : 0;
    // Resizing the block scales its text with the QR, but only so far: the point of the block is the
    // code, and the caption beside it should not end up shouting over the trick list.
    const ts = clamp(cardLayout.qr.size / CARD_QR_PX, 0.7, 1.6) * g.u;
    // The camera motif wraps a body round the QR, so the text beside it has to start outside that
    // body rather than on top of it. The desired margin is used rather than the fitted one because
    // the fitted one depends on where this block ends up, which is what we are working out.
    const camGap = decorUsed === 'camera' && qrPx ? Math.max(13 * g.u, qrPx * 0.16) * Math.min(decorScale, 1.25) : 0;
    const gap = 24 * g.u + camGap;
    const showCode = cardShowLink;
    const caption = cardCaption.trim();
    const maxTextW = g.innerW - (qrPx ? qrPx + gap : 0);
    let tw = 0, th = 0;
    let capLines: string[] = [];
    if (cardShowLink) { ctx.font = `700 ${20 * ts}px ${CARD_FAMILY}`; tw = Math.max(tw, ctx.measureText('Scan to join').width); th += 30 * ts; }
    if (showCode) {
      if (cardCodeMode === 'code') { ctx.font = `800 ${34 * ts}px ${CARD_MONO}`; tw = Math.max(tw, ctx.measureText(joinCode).width); th += 48 * ts; }
      else { ctx.font = `700 ${21 * ts}px ${CARD_FAMILY}`; tw = Math.max(tw, ctx.measureText(cleanUrl).width); th += 58 * ts; }
    }
    if (caption) {
      ctx.font = `400 ${18 * ts}px ${CARD_FAMILY}`;
      capLines = wrapToLines(ctx, caption, Math.max(60, maxTextW));
      for (const ln of capLines) tw = Math.max(tw, ctx.measureText(ln).width);
      th += capLines.length * 23 * ts;
    }
    tw = Math.min(tw, Math.max(0, maxTextW));
    // Everything off is a card with no join block at all — a pure shot list, which is a legitimate
    // thing to print when the QR is already on the poster on the wall.
    if (!qrPx && !tw) return null;
    const w = Math.min(g.innerW, (qrPx ? qrPx + (tw ? gap : 0) : 0) + tw);
    const h = Math.max(qrPx, th + 8 * ts);
    const c = placeOnCard(g, cardLayout.qr, w, h);
    const x = c.x - w / 2, y = c.y - h / 2;
    return {
      rect: { x, y, w, h },
      qr: qrPx ? { x, y: y + (h - qrPx) / 2, w: qrPx, h: qrPx } : null,
      tx: x + (qrPx ? qrPx + gap : 0), tw, ts, capLines,
    };
  }

  /** One card, top-left of its SLOT at (ox, oy). Every card on a sheet is identical — they go to
   *  different people. */
  function drawCard(ctx: CanvasRenderingContext2D, ox: number, oy: number, set: MissionSet, qrImage: HTMLImageElement, bg: HTMLImageElement | null) {
    const g = cardBoxAt(ox, oy);
    const { x0, y0, cw, ch, u, pad, innerW } = g;
    // Square corners are an option because a rounded card cannot be cut with a guillotine: the edge
    // no longer matches the cut line, so a host trimming a stack has to round every corner by hand.
    const r = cardRound ? 22 * u : 0;
    // Background inside the card's own edge. An image is covered into EACH card rather than across
    // the sheet, so the cards look the same instead of showing different crops of one photo.
    ctx.save();
    roundRect(ctx, x0, y0, cw, ch, r); ctx.clip();
    if (bg) { ctx.translate(x0, y0); drawCover(ctx, bg, cw, ch); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, cw, ch); }
    else { ctx.fillStyle = cardBgHex; ctx.fillRect(x0, y0, cw, ch); }
    ctx.restore();
    roundRect(ctx, x0, y0, cw, ch, r); ctx.strokeStyle = cardInk.rule; ctx.lineWidth = 1.5 * u; ctx.stroke();

    const t = titleGeom(ctx, g, set);
    const j = joinGeom(ctx, g);

    // Decoration first, so the card's own text always sits on top of the line art rather than
    // fighting it. The camera motif needs the QR square, which is why the geometry comes first.
    drawDecor(ctx, {
      kind: decorUsed, pos: decorPos, scale: decorScale, colour: decorInk, unit: u,
      card: { x: x0, y: y0, w: cw, h: ch }, qr: j?.qr ?? null,
    });

    // ── Title block (free position) ──
    let ty = t.rect.y;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const tcx = t.rect.x + t.rect.w / 2;
    if (t.label) {
      ctx.fillStyle = cardInk.muted; ctx.font = `700 ${t.labelSize}px ${CARD_FAMILY}`;
      ctx.fillText(t.label, tcx, ty); ty += t.labelSize * 1.5;
    }
    ctx.fillStyle = cardInk.title;
    applyFace(ctx, cardTitleFace, t.size);
    for (const ln of t.lines) { ctx.fillText(ln, tcx, ty); ty += t.lh; }
    clearTracking(ctx);
    const ruleY = t.rect.y + t.rect.h + 10 * u;
    ctx.fillStyle = cardInk.rule; ctx.fillRect(x0 + pad, ruleY, innerW, 1.5 * u);

    // ── Trick list: takes whatever the title and the join block leave, and sizes itself to fill it
    // — a 5-trick card breathes, a 20-trick one packs in without spilling. ──
    const L = x0 + pad;
    let top = ruleY + 20 * u, bottom = y0 + ch - pad;
    if (j) {
      // The camera motif draws a body reaching ABOVE the QR, so the list has to stop that much
      // higher — otherwise the body is drawn straight through the last line of the list.
      const decorTop = decorUsed === 'camera' && j.qr
        ? cameraMargin(j.qr, { x: x0, y: y0, w: cw, h: ch }, u, decorScale) * CAMERA_TOP : 0;
      // Normally the join block is below the title and caps the list; a host who drags it above the
      // title instead gets the list below BOTH rather than printed through the QR.
      if (j.rect.y >= t.rect.y + t.rect.h) bottom = Math.min(bottom, j.rect.y - 20 * u - decorTop);
      else top = Math.max(top, j.rect.y + j.rect.h + 20 * u);
    }
    if (bottom - top < 60 * u) bottom = top + 60 * u;
    const n = set.items.length;
    // The cap only bites on a short list: it stops five tricks being squeezed into the top third of
    // the card, while leaving a generous row you can actually put a pen through.
    const rowH = clamp((bottom - top) / Math.max(n, 1), 17 * u, 56 * u);
    // ONE font size for every row — fitting each row on its own leaves the list visually ragged.
    // Take the largest that suits the row height AND keeps the longest trick on a single line.
    // Text width scales linearly with font size for a given string, so the widest is measured once
    // at a reference size; the tick column is 1.5em and the gap after it 0.5em, hence innerW − 2em.
    ctx.font = `400 100px ${CARD_FAMILY}`;
    const perPx = Math.max(...set.items.map((it) => ctx.measureText(it.text).width), 1) / 100;
    const fs = Math.max(11 * u, Math.min(Math.round(rowH * 0.56), 21 * u, Math.floor(innerW / (perPx + 2))));
    let ry = top + Math.max(0, (bottom - top - rowH * n) / 2);
    ctx.textBaseline = 'middle';
    for (let i = 0; i < n; i++) {
      const cy = ry + rowH / 2;
      ctx.font = `400 ${fs}px ${CARD_FAMILY}`;
      // The tick carries the event's accent (cardTickInk); the trick text stays plain body ink, so
      // the list still reads as a list. An emoji tick is painted in colour by the device's own font
      // and ignores the fill entirely — see tickIsEmoji, which warns the host up front rather than
      // letting them discover it at the printer.
      ctx.fillStyle = cardTickInk;
      ctx.textAlign = 'center'; ctx.fillText(cardGlyph, L + fs * 0.75, cy);
      ctx.fillStyle = cardInk.body;
      ctx.textAlign = 'left'; ctx.fillText(set.items[i].text, L + fs * 2, cy);
      // A dashed rule between rows, like the on-page card this stands in for.
      if (i < n - 1) {
        ctx.save(); ctx.setLineDash([4 * u, 5 * u]); ctx.strokeStyle = cardInk.rule; ctx.lineWidth = 1 * u;
        ctx.beginPath(); ctx.moveTo(L, ry + rowH); ctx.lineTo(L + innerW, ry + rowH); ctx.stroke(); ctx.restore();
      }
      ry += rowH;
    }

    // ── Join block (free position): QR on the left, details beside it. The white panel guarantees
    // the code stays black-on-white whatever the card sits on, and matches the poster's QR panel. ──
    if (!j) return;
    if (j.qr) {
      const q = j.qr, m = 9 * u;
      ctx.fillStyle = '#ffffff'; roundRect(ctx, q.x - m, q.y - m, q.w + m * 2, q.h + m * 2, 14 * u); ctx.fill();
      ctx.imageSmoothingEnabled = false; ctx.drawImage(qrImage, q.x, q.y, q.w, q.h); ctx.imageSmoothingEnabled = true;
      drawBrandChip(ctx, q.x + q.w / 2, q.y + q.h / 2, q.w * 0.20);
    }
    if (!j.tw) return;
    const ts = j.ts;
    let jy = j.rect.y + 4 * ts;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    if (cardShowLink) {
      ctx.fillStyle = cardInk.muted; ctx.font = `700 ${20 * ts}px ${CARD_FAMILY}`;
      ctx.fillText('Scan to join', j.tx, jy); jy += 30 * ts;
      ctx.fillStyle = cardInk.code;
      if (cardCodeMode === 'code') { fitText(ctx, joinCode, j.tx, jy, j.tw, 800, 34 * ts, CARD_MONO); jy += 48 * ts; }
      else { drawUrl(ctx, cleanUrl, j.tx, jy, j.tw, 700, 21 * ts, CARD_FAMILY, 26 * ts); jy += 58 * ts; }
    }
    // What the card is FOR. Without this a guest has a list and no idea it is tickable in the app.
    ctx.fillStyle = cardInk.muted; ctx.font = `400 ${18 * ts}px ${CARD_FAMILY}`;
    for (const ln of j.capLines) { ctx.fillText(ln, j.tx, jy); jy += 23 * ts; }
  }

  /** Paint one set's sheet at CARD_SCALE, however many cards the host wants on it. */
  async function drawSheet(ctx: CanvasRenderingContext2D, set: MissionSet) {
    // Same reason drawPoster awaits it: ctx.font falls back to Arial silently, and a card sheet is
    // exported straight to a printer. The poster's own await does not cover this path.
    await ensurePosterFonts(typeSetKey);
    ctx.setTransform(CARD_SCALE, 0, 0, CARD_SCALE, 0, 0);
    // The sheet is paper: white, always. Each card paints its own background inside its cut line,
    // so an ink-saver sheet leaves the gutters unprinted (and a JPG/PDF export never goes black
    // where the canvas would otherwise be transparent).
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    let bg: HTMLImageElement | null = null;
    if (cardUseImage) {
      const src = bgSrc();
      if (src) { try { bg = await loadImg(src); } catch { bg = null; } }
    }
    // THIS set's QR, not the previewed one — printing the whole stack has to give every page its own
    // code, or every card in the house sends guests to the set that happened to be on screen.
    const qr = await loadImg(await qrForSet(sheets.length > 1 ? set.key : null));
    for (let i = 0; i < cardsPerSheet; i++) drawCard(ctx, (i % cardCols) * slotW, Math.floor(i / cardCols) * slotH, set, qr, bg);
    // Cut guides along the tile boundaries — and only there. A full-page card has nothing to cut, so
    // it gets no guide rather than a decorative line through the paper. Always dark: they are drawn
    // on the white sheet, not on a card.
    if (cardsPerSheet > 1) {
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([9, 9]);
      ctx.beginPath();
      if (cardCols > 1) { ctx.moveTo(slotW, 0); ctx.lineTo(slotW, H); }
      ctx.moveTo(0, slotH); ctx.lineTo(W, slotH);
      ctx.stroke();
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  // ── Card drag surface ───────────────────────────────────────────────────────
  // The overlay sits over the FIRST card on the sheet; every other card is a copy of it, so
  // arranging one arranges them all.
  let cardBounds: Record<string, Rect> = { title: ZERO_RECT, qr: ZERO_RECT };
  function measureCardBounds(): Record<string, Rect> {
    const ctx = measureCtx();
    if (!ctx) return { title: ZERO_RECT, qr: ZERO_RECT };
    const g = cardBoxAt(0, 0);
    const t = titleGeom(ctx, g, activeSheet);
    const j = joinGeom(ctx, g);
    return { title: t.rect, qr: j ? j.rect : ZERO_RECT };
  }
  // Same dependency-by-reference idea as the poster's bounds, gathered into ONE tracked value:
  // everything that changes a card's footprint is named here, and the measurements below reference
  // it. `void` rather than a bare comma operand because TypeScript rightly objects to a discarded
  // expression that does nothing — this one exists purely to be a dependency.
  $: cardMeasure = JSON.stringify([cardLayout, cardHeading, cardUnit, slotW, slotH, cardIds, cardShowQr,
                                   cardShowLink, cardCaption, codeDisplay, activeSheet?.key, sheets.length,
                                   decorUsed, decorScale, mounted]);
  $: cardGeomBox = (void cardMeasure, cardBoxAt(0, 0));
  $: cardBounds = (void cardMeasure, measureCardBounds());
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
    box: (k) => cardLayout[k as CardElKey],
    // The QR floor is the same hand-held one the card already used; sizes are in A6 px and scale up
    // with the paper, so the printed code never drops below it whatever the sheet layout.
    limits: (k) => (k === 'qr' ? [QR_MIN_PX, CARD_QR_MAX] : [14, 90]),
    move: (k, x, y) => { cardLayout = { ...cardLayout, [k]: { ...cardLayout[k as CardElKey], x, y } }; },
    size: (k, px) => { cardLayout = { ...cardLayout, [k]: { ...cardLayout[k as CardElKey], size: px } }; },
    remeasure: () => { cardBounds = measureCardBounds(); },
    redraw: () => scheduleCardRedraw(),
    select: (k) => (cardSelectedKey = k as CardElKey | null),
    selected: () => cardSelectedKey,
    dragging: (k) => (cardDragKey = k as CardElKey | null),
  };
  function startCardDrag(key: CardElKey, mode: 'move' | 'resize', e: PointerEvent) { dragOn(cardSurface, key, mode, e); }
  function resetCardLayout() { cardLayout = cloneCardLayout(DEFAULT_CARD_LAYOUT); cardBounds = measureCardBounds(); scheduleCardRedraw(); }
  // The rects the overlay draws, in the stage's own coordinates. A reactive DECLARATION rather than
  // a call in the markup: the template has to re-run when the measurement changes, and a method on
  // a const object is not something Svelte can see changing.
  $: cardRects = (void cardBounds, void cardGeomBox, cardSurface.rects());
  $: cardElements = ([
    { key: 'title', label: 'Title', show: true },
    { key: 'qr', label: 'QR / join', show: cardBounds.qr.w > 0 },
  ] as { key: CardElKey; label: string; show: boolean }[]).filter((e) => e.show);

  // The editor previews ONE card, not the sheet it will be printed on. Four-up, a card was a
  // quarter of a 320px-wide thumbnail — far too small to judge a 12px trick line on a phone — and
  // the other three cards are identical copies of it, so they showed nothing the first one didn't.
  // PRINTING and every export are unaffected: they go through sheetCanvas()/drawSheet(), which
  // still tile the sheet 4/2/1-up with the cut guides. Only what the editor shows changed.
  async function drawCards() {
    const set = activeSheet;                 // captured: an await below must not swap sheets mid-draw
    if (!cardCanvas || !set) return;
    const ctx = cardCanvas.getContext('2d'); if (!ctx) return;
    const g = cardBoxAt(0, 0);
    cardCanvas.width = Math.round(g.cw * CARD_SCALE);
    cardCanvas.height = Math.round(g.ch * CARD_SCALE);
    // drawCard() lays out in SHEET space — a gutter, then the card — so the card's own top-left is
    // shifted onto the canvas origin and the gutter is simply cropped off.
    ctx.setTransform(CARD_SCALE, 0, 0, CARD_SCALE, -g.x0 * CARD_SCALE, -g.y0 * CARD_SCALE);
    // Paper white behind it: the card clips its background to its rounded corners, and without this
    // those corners are transparent — holes showing the app's surface rather than a cut card.
    ctx.fillStyle = '#ffffff'; ctx.fillRect(g.x0, g.y0, g.cw, g.ch);
    let bg: HTMLImageElement | null = null;
    if (cardUseImage) {
      const src = bgSrc();
      if (src) { try { bg = await loadImg(src); } catch { bg = null; } }
    }
    // The previewed set's own QR, for the same reason drawSheet uses it: a card carrying the wrong
    // set sends a guest to somebody else's trick list.
    const qr = await loadImg(await qrForSet(sheets.length > 1 ? set.key : null));
    drawCard(ctx, 0, 0, set, qr, bg);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    cardsDrawn = true;
  }
  let cardRaf = 0;
  function scheduleCardRedraw() { if (cardRaf) return; cardRaf = requestAnimationFrame(() => { cardRaf = 0; drawCards().catch(() => {}); }); }
  // Everything a sheet is drawn from, in one value — and only while the cards tab is open, because
  // a 2× sheet is the expensive redraw of the two and the poster has its own loop. It has to be a
  // reactive DECLARATION that the redraw then reads in its condition: a bare `void x` reference
  // inside a reactive block does not register plain state like the selected sheet as a dependency,
  // and the preview would go stale the moment a host switched sheets.
  $: cardSig = mounted && view === 'cards'
    ? JSON.stringify([cfg, customBgUrl, activeSheet, sheets.length, cardGlyph, cardInk, cardTickInk, cardBgHex, cardUseImage, decorUsed, decorInk]) : '';
  $: if (cardSig) scheduleCardRedraw();

  /** A sheet on its own canvas, so an export never depends on which one is being previewed. */
  async function sheetCanvas(set: MissionSet): Promise<HTMLCanvasElement> {
    const c = document.createElement('canvas');
    c.width = sheetW * CARD_SCALE; c.height = sheetH * CARD_SCALE;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('no canvas context');
    await drawSheet(ctx, set);
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
  const COLOR_ROWS: { key: CTarget; label: string; get: () => string }[] = [
    { key: 'headline', label: 'Title', get: () => cHeadline },
    { key: 'message', label: 'Message', get: () => cMessage },
    { key: 'steps', label: 'How-to', get: () => cSteps },
    { key: 'code', label: 'Code / URL', get: () => cCode },
    { key: 'footer', label: 'Footer URL', get: () => cFooter },
  ];
  // The card's own colour rows — the same control, the same swatch picker, the same activeTarget.
  // A blank override means "follow the poster", so the picker shows the colour the card is ACTUALLY
  // printed in (after the readable pass) and editing it pins that row to the card.
  $: CARD_COLOR_ROWS = ([
    { key: 'cardTitle', label: 'Title', get: () => cardCTitle || cardInk.title },
    { key: 'cardBody', label: 'Trick list', get: () => cardCBody || cardInk.body },
    { key: 'cardCode', label: 'Code / link', get: () => cardCCode || cardInk.code },
    { key: 'cardBg', label: 'Card background', get: () => cardCBg || cardBgHex },
  ] as { key: CTarget; label: string; get: () => string }[]);
  // ── Controls for things that are switched off ──────────────────────────────
  // A colour picker for an element that is not being printed is dead weight on a phone, so a row
  // is hidden while its element is off. The stored VALUE is deliberately left alone — nothing here
  // resets to a default — so switching the element back on brings the host's colour back exactly
  // as they left it. That is why this filters at the point of display rather than clearing state.
  $: VISIBLE_COLOR_ROWS = COLOR_ROWS.filter((r) =>
    r.key === 'message' ? !!message.trim()
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
  // The image swatches write to whichever row is active, so a row that has just been hidden would
  // quietly swallow colours with nothing on screen changing. Point it at the first row still
  // showing on this tab — which also fixes the palette heading reading blank on the poster tab
  // after a card colour was touched.
  $: { const rows = view === 'cards' ? VISIBLE_CARD_COLOR_ROWS : VISIBLE_COLOR_ROWS;
       if (rows.length && !rows.some((r) => r.key === activeTarget)) activeTarget = rows[0].key; }
  $: cardColoursSet = !!(cardCTitle || cardCBody || cardCCode || cardCBg);
  const clearCardColours = () => { cardCTitle = ''; cardCBody = ''; cardCCode = ''; cardCBg = ''; };
  const onDecorColour = (e: Event) => { decorColour = (e.target as HTMLInputElement).value; };
  const toggleSet = (key: string) => {
    cardSkip = cardSkip.includes(key) ? cardSkip.filter((k) => k !== key) : [...cardSkip, key];
  };
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<svelte:window on:keydown={onKeydown} />

<div class="back" on:click|self={() => dispatch('close')} role="dialog" aria-modal="true" aria-label="Event poster">
  <div class="sheet" class:fs={fsEdit} tabindex="-1" use:modalFocus>
    <div class="head"><span>{fsEdit ? 'Arrange layout' : view === 'cards' ? 'Trick cards' : 'Event poster'}</span>
      <div class="head-actions">
        <!-- Full-screen arranging is the poster's; a card is arranged at its own size in the preview. -->
        <!-- Always visible, including mid-drag and in full screen. The existing pair sit inside the
             Arrange controls, which is exactly where you cannot see them while dragging on the
             preview — the one moment an undo is worth anything. -->
        <button class="tog undo" on:click={undo} disabled={!undoStack.length}
                aria-label="Undo" title="Undo the last change (Ctrl/⌘+Z)">↶</button>
        <button class="tog undo" on:click={redo} disabled={!redoStack.length}
                aria-label="Redo" title="Redo (Ctrl/⌘+Shift+Z)">↷</button>
        {#if view === 'poster'}<button class="tog" on:click={() => (fsEdit = !fsEdit)} aria-label={fsEdit ? 'Exit full screen' : 'Full-screen layout'} title={fsEdit ? 'Exit full screen' : 'Full-screen layout — easier to arrange'}>{fsEdit ? '✓ Done' : '⛶ Arrange'}</button>{/if}
        {#if !fsEdit}<button class="x" on:click={() => dispatch('close')} aria-label="Close">✕</button>{/if}
      </div></div>

    <!-- Two outputs of one design: the A4 poster for the room, and A6 cards for the tables. -->
    {#if !fsEdit}
      <div class="tabs">
        <button class="tab" class:on={view === 'poster'} aria-pressed={view === 'poster'} on:click={() => (view = 'poster')}>🖼 Poster</button>
        <button class="tab" class:on={view === 'cards'} aria-pressed={view === 'cards'} on:click={() => (view = 'cards')}>🃏 Trick cards</button>
      </div>
    {/if}

    <div class="poster-body" class:fs={fsEdit}>
    <div class="preview">
      {#if view === 'poster' ? busy : (!!activeSheet && !cardsDrawn)}<div class="spinner" aria-label={view === 'cards' ? 'Building cards' : 'Building poster'}></div>{/if}
      {#if view === 'cards' && !activeSheet}<p class="empty">{sheets.length ? 'No set is switched on to print.' : 'No trick list on this event yet.'}</p>{/if}
      <!-- Both previews stay mounted so switching tabs costs nothing and the poster keeps its
           measured drag bounds; the inactive one is just hidden. -->
      <div class="canvas-wrap" class:hidden={view !== 'cards' || !activeSheet || !cardsDrawn}>
        <canvas bind:this={cardCanvas}></canvas>
        <!-- The canvas IS one card, so the drag stage simply covers it. It used to be positioned
             over the first card of the sheet; the rects it lays out are still measured in SHEET
             space and offset by cardGeomBox, which is why that is still the surface's origin. -->
        <!-- svelte-ignore a11y-no-static-element-interactions a11y-click-events-have-key-events -->
        <div class="poster-stage card-stage" class:dragging={!!cardDragKey} bind:this={cardStageEl}
          on:pointerdown|self={() => (cardSelectedKey = null)}>
          {#if cardDragKey && snapX !== null}<div class="snap-guide vert" style="left:{snapX * 100}%" aria-hidden="true"></div>{/if}
          {#if cardDragKey && snapY !== null}<div class="snap-guide horz" style="top:{snapY * 100}%" aria-hidden="true"></div>{/if}
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
      <div class="canvas-wrap" class:hidden={busy || view !== 'poster'}>
        <canvas bind:this={canvas}></canvas>
        <!-- Click an element to select it → its outline + resize corner ⤡ appear. Drag anywhere on
             it to move; drag the corner to resize. Click empty space to deselect. -->
        <!-- svelte-ignore a11y-no-static-element-interactions a11y-click-events-have-key-events -->
        <div class="poster-stage" class:dragging={!!dragKey} bind:this={stageEl} on:pointerdown|self={() => (selectedKey = null)}>
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
          {#if editingKey && editSpec && bounds[editingKey]}
            {@const eb = bounds[editingKey]}
            <!-- Anchored ON the element, so the words appear where the words are. Sized to the
                 element's own box rather than floated in a corner — the point is that you are
                 editing the thing you can see, not a field that happens to change it. -->
            <div class="el-edit" style="left:2%; top:{Math.min(88, Math.max(2, ((eb.y + eb.h) / H) * 100 + 1))}%; width:96%">
              <input bind:this={editEl} type="text" maxlength={editSpec.max}
                     value={editSpec.get()}
                     placeholder={editSpec.label}
                     aria-label={editSpec.label}
                     on:input={(e) => setEdit(e.currentTarget.value)}
                     on:keydown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); endEdit(); } }}
                     on:blur={endEdit} />
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
                <span class="el-name">{el.label}{#if el.key === 'qr' && qrTooSmall} ⚠{/if}</span>
              </div>
              {#if el.resizable && selectedKey === el.key}
                <span class="el-rz" class:active={dragKey === el.key}
                  style="left:{((b.x + b.w) / W) * 100}%; top:{((b.y + b.h) / H) * 100}%"
                  on:pointerdown={(e) => startDrag(el.key, 'resize', e)} aria-label="Resize {el.label}">⤡</span>
              {/if}
            {/if}
          {/each}

          <!-- Lines the host added. Same box, same grip, same drag code as everything else. -->
          {#each textItems as t, i (i)}
            {@const tb = textRects[`text:${i}`]}
            {#if tb}
              <div class="el-box" class:active={dragKey === `text:${i}`} class:selected={selectedKey === `text:${i}`}
                style="left:{(tb.x / W) * 100}%; top:{(tb.y / H) * 100}%; width:{(tb.w / W) * 100}%; height:{(tb.h / H) * 100}%"
                on:pointerdown={(e) => startDrag(`text:${i}`, 'move', e)} role="button" tabindex="-1"
                aria-label="Move your line">
                <span class="el-name">Your line</span>
              </div>
              {#if selectedKey === `text:${i}`}
                <span class="el-rz" class:active={dragKey === `text:${i}`}
                  style="left:{((tb.x + tb.w) / W) * 100}%; top:{((tb.y + tb.h) / H) * 100}%"
                  on:pointerdown={(e) => startDrag(`text:${i}`, 'resize', e)} aria-label="Resize your line">⤡</span>
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
              {/if}
            {/if}
          {/each}
        </div>
      </div>
    </div>

    <details class="editor" open>
      <summary>✏️ Customise {view === 'cards' ? 'cards' : ''}</summary>
      {#if view === 'cards'}
      <!-- Gated on the trick list EXISTING, not on a sheet being previewed: a host who switched every
           set off still needs the controls in front of them to switch one back on. -->
      {#if !sheets.length}
        <p class="layout-hint">This event has no trick list yet. Set one up and the printable table cards appear here.</p>
      {:else}
        <p class="layout-hint">Identical cards to an A4 sheet — print, cut along the dashed guides, one per place setting. The colours, background and join details follow the poster you designed.</p>

        {#if cGuided}
          <div class="psteps" aria-label="Step {cStep} of {C_LAST}">
            {#each C_TITLES as t, i}
              <button class="pstep" class:on={i + 1 === cStep} class:done={i + 1 < cStep && !cStepSkipped(i + 1)}
                      class:skipped={cStepSkipped(i + 1)} disabled={cStepSkipped(i + 1)}
                      on:click={() => (cStep = i + 1)} title={cStepWhy(i + 1)}>
                <span class="ps-n">{cStepSkipped(i + 1) ? '–' : i + 1 < cStep ? '✓' : i + 1}</span><span class="ps-t">{t}</span>
              </button>
            {/each}
          </div>
        {/if}

        {#if cGuided}<p class="p-ask">{C_ASK[cStep - 1]}</p>{/if}

        {#if !cGuided || cStep === 1}
        <label class="fld"><span>Card title</span><input bind:value={cardTitle} maxlength="60" placeholder={headline} /></label>

        <div class="fld"><span>Cards per sheet</span>
          <div class="bg-row">
            <button class="seg" class:on={cardsPerSheet === 4} on:click={() => (cardsPerSheet = 4)}>4 · A6</button>
            <button class="seg" class:on={cardsPerSheet === 2} on:click={() => (cardsPerSheet = 2)}>2 · A5</button>
            <button class="seg" class:on={cardsPerSheet === 1} on:click={() => (cardsPerSheet = 1)}>1 · A4</button>
          </div>
          <p class="layout-hint" style="margin-top:8px">A4 halves and quarters exactly, so every option fills the sheet. Bigger cards carry the same design at a bigger size — handy for a long trick list or a table sign. The preview shows a single card; the full sheet, with its cut guides, is what prints.</p>
          <div class="sub-h">Paper</div>
          <div class="bg-row">
            <button class="seg" class:on={!cardSheetLandscape} on:click={() => (cardSheetLandscape = false)}>Portrait</button>
            <button class="seg" class:on={cardSheetLandscape} on:click={() => (cardSheetLandscape = true)}>Landscape</button>
          </div>
          <p class="layout-hint" style="margin-top:8px">
            {cardShapeNote}
            {#if cardSheetLandscape} The PDF and the print dialog are already set to landscape.{/if}
          </p>
        </div>

        {/if}

        {#if !cGuided || cStep === 2}
        <div class="fld"><span>Trick list</span>
          <p class="layout-hint">Each card ticks with <b>{cardGlyph}</b> — chosen with the trick list itself, so the printed card and the app always agree. It prints in your event's colour; set <b>Trick list</b> below to override it.</p>
          {#if tickIsEmoji}<p class="warn-note">⚠ Emoji ticks are printed in colour by your device's own font, so they won't match the card's ink colour — an outline tick in the trick-list editor will.</p>{/if}
        </div>

        {#if sheets.length > 1}
          <!-- Only with more than one set. With a single set this was a box containing one tick you
               could only turn OFF — and turning it off is the one thing that stops the cards
               printing at all. A chooser with nothing to choose reads as an empty list. -->
          {#if sheets.length > 1}
            <div class="fld"><span>Print which sets</span>
              <div class="bg-row">
                {#each sheets as s, i}
                  <button class="seg" class:on={!cardSkip.includes(s.key)} on:click={() => toggleSet(s.key)}
                    aria-pressed={!cardSkip.includes(s.key)}>{cardSkip.includes(s.key) ? '☐' : '☑'} {s.label || `Card ${String.fromCharCode(65 + i)}`}</button>
                {/each}
              </div>
              {#if !printSets.length}<p class="warn-note">⚠ Every set is switched off — turn at least one back on to print.</p>{/if}
            </div>
          {/if}
          {#if printSets.length > 1}
            <div class="fld"><span>Previewing ({previewIdx + 1} of {printSets.length})</span>
              <div class="bg-row">
                {#each printSets as s, i}
                  <button class="seg" class:on={previewIdx === i} on:click={() => (sheetIdx = i)}>{s.label || `Card ${String.fromCharCode(65 + i)}`}</button>
                {/each}
              </div>
              <p class="layout-hint" style="margin-top:8px">One sheet per set. Print the sheet you're looking at, or all {printSets.length} at once — or turn off the card identifiers below, shuffle and hand them out at random.</p>
            </div>
          {/if}
          <div class="chk"><label for="p-card-ids">Print the card identifier on every card <span class="sub">({sheets[0]?.label ?? 'Card A'}, …)</span></label><Toggle id="p-card-ids" bind:checked={cardIds} /></div>
        {/if}

        {/if}

        {#if !cGuided || cStep === 3}
        <div class="fld"><span>Layout</span>
          <p class="layout-hint">Drag the title or the QR block on the preview to move it; drag the <b>⤡</b> corner to resize, or pinch it with two fingers. It snaps to the card’s centre and to the other block — a pink line shows what it lined up with. You are arranging the first card — the rest of the sheet follows it.</p>
          <div class="bg-row">
            <button class="seg" on:click={resetCardLayout}>↺ Reset card layout</button>
          </div>
          <div class="chk"><label for="p-card-qr">Show the QR code</label><Toggle id="p-card-qr" bind:checked={cardShowQr} /></div>
          <div class="chk"><label for="p-card-link">Show the join link / code beside it</label><Toggle id="p-card-link" bind:checked={cardShowLink} /></div>
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
          <div class="bg-row">
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

        {#if !cGuided || cStep === C_LAST}
        <div class="colors">
          <div class="c-head">Card colours
            {#if cardColoursSet}<button class="mini-link" on:click={clearCardColours}>↺ Follow the poster</button>{/if}
          </div>
          {#each VISIBLE_CARD_COLOR_ROWS as r (r.key)}
            <label class="c-row"><span>{r.label}</span>
              <input type="color" value={r.get()} on:focus={() => (activeTarget = r.key)} on:input={(e) => onColorInput(e, r.key)} />
            </label>
          {/each}
          {#if palette.length}
            <div class="pal">
              <span class="pal-h">From your image → {VISIBLE_CARD_COLOR_ROWS.find((x) => x.key === activeTarget)?.label ?? 'pick a row above'}:</span>
              <div class="swatches">{#each palette as p}<button class="sw" style="background:{p}" title={p} aria-label={`Use ${p}`} on:click={() => applySwatch(p)}></button>{/each}</div>
            </div>
          {/if}
          <p class="layout-hint" style="margin-top:8px">Text stays readable whatever background you choose — a colour that would disappear is nudged until it doesn't.</p>
        </div>
        {/if}

        {#if cGuided}
          <div class="pnav">
            {#if cNextStep(cStep, -1) !== null}<button class="seg" on:click={() => (cStep = cNextStep(cStep, -1) ?? cStep)}>← Back</button>{/if}
            {#if cNextStep(cStep, 1) !== null}
              <button class="seg grow" on:click={() => (cStep = cNextStep(cStep, 1) ?? cStep)}>Next →</button>
            {:else}
              <button class="seg grow" on:click={openFinish}>See it front &amp; back →</button>
            {/if}
          </div>
          {#if cStep === 1}
            <button class="mini-link" on:click={() => (cGuided = false)}>Skip — show me every control</button>
          {/if}
        {:else}
          <button class="mini-link" on:click={() => { cGuided = true; cStep = 1; }}>Walk me through it instead</button>
        {/if}
      {/if}
      {:else}
      {#if pGuided}
        <div class="psteps" aria-label="Step {pStep} of {P_LAST}">
          {#each P_TITLES as t, i}
            <button class="pstep" class:on={i + 1 === pStep} class:done={i + 1 < pStep}
                    on:click={() => (pStep = i + 1)} title={t}>
              <span class="ps-n">{i + 1 < pStep ? '✓' : i + 1}</span><span class="ps-t">{t}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if pGuided}<p class="p-ask">{P_ASK[pStep - 1]}</p>{/if}

      {#if !pGuided || pStep === 1}
      <!-- Pointing at a field outlines what it changes on the preview, and an EMPTY one shows where
           its words would land. pointerenter rather than mouseenter so a touch never triggers it:
           on a phone the hint would fire on the tap that focuses the field and then never clear. -->
      <!-- The colour sits ON the field it colours. It was only on the Colours step, four screens
           away, as a row labelled "Title" — so the host had to hold a mapping in their head between
           a list of words and a list of colours. Here the swatch IS the answer to "what colour is
           this line", and the question never has to be asked. The Colours step still exists for the
           background and for the swatch palette pulled out of an image. -->
      <label class="fld fld-c" on:pointerenter={hintOn('title')} on:pointerleave={hintOff} on:focusin={hintOn('title')} on:focusout={hintOff}><span>Title</span>
        <span class="fc-row">
          <input bind:value={headline} maxlength="60" />
          <input class="fc-dot" type="color" value={ink.headline} on:input={(e) => onColorInput(e, 'headline')} aria-label="Title colour" title="Title colour" />
        </span>
      </label>
      <label class="fld fld-c" on:pointerenter={hintOn('message')} on:pointerleave={hintOff} on:focusin={hintOn('message')} on:focusout={hintOff}><span>Message</span>
        <span class="fc-row">
          <input bind:value={message} maxlength="80" placeholder="(blank to hide)" />
          <input class="fc-dot" type="color" value={ink.message} on:input={(e) => onColorInput(e, 'message')} aria-label="Message colour" title="Message colour" />
        </span>
      </label>
      <label class="fld fld-c" on:pointerenter={hintOn('steps')} on:pointerleave={hintOff} on:focusin={hintOn('steps')} on:focusout={hintOff}><span>How-to line</span>
        <span class="fc-row">
          <input bind:value={stepsText} maxlength="120" placeholder="(blank to hide)" />
          <input class="fc-dot" type="color" value={ink.steps} on:input={(e) => onColorInput(e, 'steps')} aria-label="How-to colour" title="How-to colour" />
        </span>
      </label>
      <label class="fld"><span>Small line above</span><input bind:value={headlineTop} maxlength="40" placeholder="(blank to hide) e.g. CAPTURE THE" /></label>
      <label class="fld"><span>Small line below</span><input bind:value={headlineBottom} maxlength="40" placeholder="(blank to hide) e.g. THE LOVE" /></label>
      <label class="fld fld-c" on:pointerenter={hintOn('names')} on:pointerleave={hintOff} on:focusin={hintOn('names')} on:focusout={hintOff}><span>Names</span>
        <span class="fc-row">
          <input bind:value={names} maxlength="60" placeholder="(blank to hide) e.g. Rachel and Ross" />
          <!-- The lockup is drawn in the headline ink, so this is the same colour as the title —
               one control would be two places to change one thing, so it points at the same value. -->
          <input class="fc-dot" type="color" value={ink.headline} on:input={(e) => onColorInput(e, 'headline')} aria-label="Names colour" title="Drawn in the title's colour" />
        </span>
      </label>
      <p class="layout-hint">Type it as you'd say it. Put <b>and</b>, <b>&amp;</b> or <b>+</b> in the middle and it sets as a lockup — the two names stacked, your own joiner in script between two hairlines. No separator and it's simply one line.</p>

      <!-- Anything the poster does not have a field for: a table number, a hashtag, "bar closes at
           11". Dragged and sized on the preview like everything else. -->
      <div class="fld"><span>Your own lines</span>
        <div class="bg-row">
          <button class="seg" on:click={addText}>＋ Add a line</button>
        </div>
        {#if textItems.length}
          <ul class="dlist">
            {#each textItems as t, i (i)}
              <li class:on={selectedKey === `text:${i}`}>
                <input class="d-in" value={t.text} maxlength="80" placeholder="Your words"
                       aria-label="Your line {i + 1}"
                       on:focus={() => (selectedKey = `text:${i}`)}
                       on:input={(e) => patchText(i, { text: e.currentTarget.value })} />
                <button class="d-x" on:click={() => removeText(i)} aria-label="Remove this line" title="Remove">🗑</button>
              </li>
            {/each}
          </ul>
          <p class="layout-hint" style="margin-top:6px">Drag each one on the preview to place it, or drag its ⤡ corner to size it. Tapping it on the preview edits it too.</p>
        {/if}
      </div>
      <p class="layout-hint">A title set as two parts — small tracked caps over a big word — is what makes a printed sign read as designed rather than as typed.</p>

      {/if}

      {#if !pGuided || pStep === 2}
      <div class="fld"><span>Typeface pairing</span>
        <div class="tset-row">
          {#each TYPE_SETS as t}
            <button class="tset" class:on={typeSetKey === t.key} on:click={() => (typeSetKey = t.key)}>
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
          <button class="seg" class:on={titleFace === 'script'} on:click={() => (titleFace = 'script')}
                  disabled={!typeSet(typeSetKey).script}
                  title={typeSet(typeSetKey).script ? '' : 'This pairing has no script face'}>Script</button>
        </div>
        <p class="layout-hint" style="margin-top:6px">The faces print with the poster — they are bundled with Snapdini, not fetched, so what you see here is what comes out of the printer.</p>
      </div>
      {/if}

      {#if !pGuided || pStep === 3}
      <div class="fld"><span>Show under QR</span>
        <select bind:value={codeDisplay}>
          <option value="url">Join link</option>
          <option value="code">Join code</option>
          <option value="none">Nothing (QR only)</option>
        </select>
      </div>
      <div class="chk"><label for="p-footer-url">Show the link along the bottom</label><Toggle id="p-footer-url" bind:checked={showFooterUrl} /></div>
      <div class="chk"><label for="p-brand">Show the Snapdini mark at the top</label><Toggle id="p-brand" bind:checked={showBrand} /></div>
      <!-- Disabled, not hidden: the note under it explains why, and a control that vanishes on a
           dark background reads as a bug. The switch dims itself; the label says the rest. -->
      <div class="chk" class:off={!qrSafe}><label for="p-qr-panel">White card behind the QR</label><Toggle id="p-qr-panel" bind:checked={qrPanel} disabled={!qrSafe} /></div>
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
      <details class="fld grp" open><summary>Decoration</summary>
        <!-- Same three headings as the cards tab, and the same reason: which drawing, where it sits,
             and how it looks are three decisions, not one long column of buttons. -->
        <div class="sub-h">Which one</div>
        <div class="bg-row">
          {#each DECOR_KINDS as d}
            <button class="seg" class:on={decorKind === d.key} on:click={() => (decorKind = d.key)}>{d.label}</button>
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
      <details class="fld grp"><summary>Place your own{#if decorItems.length}{' '}<span class="grp-n">{decorItems.length}</span>{/if}</summary>
        <p class="layout-hint">Drop individual motifs wherever you like. These sit <b>on top of</b> the decoration above, not instead of it — to remove that one, set it to <b>None</b>.</p>
        <div class="sub-h">Motif to place</div>
        <div class="bg-row">
          {#each PLACEABLE as d}
            <button class="seg" class:on={placeKind === d.key} on:click={() => (placeKind = d.key)}>{d.label}</button>
          {/each}
        </div>
        <div class="bg-row" style="margin-top:8px">
          <button class="seg" on:click={addDecor}>＋ Add {DECOR_KINDS.find((d) => d.key === placeKind)?.label ?? 'motif'}</button>
        </div>

        {#if decorItems.length}
          <!-- A list, because a motif dragged behind the QR or off to a corner is otherwise
               unreachable — you cannot select what you cannot find, and you certainly cannot
               delete it. Every placed piece has a row here for as long as it exists. -->
          <div class="sub-h">Placed ({decorItems.length})</div>
          <ul class="dlist">
            {#each decorItems as it, i (i)}
              <li class:on={selectedKey === `decor:${i}`}>
                <button class="d-pick" on:click={() => (selectedKey = `decor:${i}`)}>
                  <span class="d-n">{DECOR_KINDS.find((d) => d.key === it.kind)?.label ?? it.kind}</span>
                  <span class="d-m">{Math.round(it.scale * 100)}%{#if it.rot}{' '}· {Math.round((it.rot * 180) / Math.PI)}°{/if}</span>
                </button>
                <button class="d-x" on:click={() => removeDecor(i)} aria-label="Remove this one" title="Remove">🗑</button>
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
              <button class="seg" on:click={() => patchDecor(selectedDecor, { rot: 0 })}>↺ Upright</button>
            </div>
          {:else}
            <p class="layout-hint" style="margin-top:6px">Pick one above, or tap it on the preview, to rotate it. Drag to move, pinch to resize.</p>
          {/if}
          <div class="bg-row" style="margin-top:8px">
            <button class="seg" on:click={() => { pushUndo(JSON.stringify(cfg)); decorItems = []; selectedKey = null; }}>Remove all</button>
          </div>
        {/if}
      </details>
      {/if}

      {#if !pGuided || pStep === P_LAST}

      <div class="fld"><span>Layout</span>
        <p class="layout-hint">Drag any element to move it; drag the <b>⤡</b> corner to resize — or pinch it with two fingers. Elements snap to the page centre and to each other; a pink line shows what lined up, and dragging on past it breaks the snap. Place text off faces.</p>
        {#if qrTooSmall}<p class="warn-note">⚠ The QR code is getting small — keep it larger so guests can scan it reliably (the brand logo in the centre needs room).</p>{/if}
        <div class="bg-row">
          <button class="seg" on:click={() => (fsEdit = true)}>⛶ Full-screen arrange</button>
          <button class="seg" on:click={resetLayout}>↺ Reset layout</button>
        </div>
      </div>

      {/if}

      {#if !pGuided || pStep === 5}
      <div class="fld"><span>Background</span>
        <div class="bg-row">
          {#if themeImageUrl}<button class="seg" class:on={bgMode === 'event'} on:click={() => (bgMode = 'event')}>Event image</button>{/if}
          <button class="seg" class:on={bgMode === 'plain'} on:click={() => (bgMode = 'plain')}>Plain colour</button>
          {#if customBgUrl}<button class="seg" class:on={bgMode === 'custom'} on:click={() => (bgMode = 'custom')}>Upload</button>{/if}
          <label class="seg file">{customBgUrl ? 'Replace…' : 'Upload…'}<input type="file" accept="image/*" on:change={onBgFile} hidden /></label>
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

      <div class="colors">
        <div class="c-head">Text colours
          {#if colorsLocked}<button class="mini-link" on:click={() => (colorsLocked = false)}>↺ Use theme colours</button>{/if}
        </div>
        {#each VISIBLE_COLOR_ROWS as r (r.key)}
          <label class="c-row"><span>{r.label}</span>
            <input type="color" value={r.get()} on:focus={() => (activeTarget = r.key)} on:input={(e) => onColorInput(e, r.key)} />
          </label>
        {/each}
        {#if palette.length}
          <div class="pal">
            <span class="pal-h">From your image → {VISIBLE_COLOR_ROWS.find((x) => x.key === activeTarget)?.label ?? 'pick a row above'}:</span>
            <div class="swatches">{#each palette as p}<button class="sw" style="background:{p}" title={p} aria-label={`Use ${p}`} on:click={() => applySwatch(p)}></button>{/each}</div>
          </div>
        {/if}
      </div>
      {/if}

      {#if pGuided}
        <div class="pnav">
          {#if pStep > 1}<button class="seg" on:click={() => (pStep -= 1)}>← Back</button>{/if}
          {#if pStep < P_LAST}
            <button class="seg grow" on:click={() => (pStep += 1)}>Next →</button>
          {:else}
            <!-- The poster is half the job: the cards carry the same design and the host has just
                 chosen all of it. Ending on "Show all controls" sent them back into the panel they
                 had just finished, and the cards tab was left to be noticed. -->
            {#if activeSheet}
              <button class="seg grow" on:click={() => { view = 'cards'; pGuided = false; }}>Next: trick cards →</button>
              <button class="seg grow" on:click={openFinish}>See it front &amp; back →</button>
            {:else}
              <button class="seg grow" on:click={() => { view = 'cards'; pGuided = false; }}>Next: trick cards →</button>
            {/if}
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

    {#if view === 'cards'}
      <p class="hint">Cut along the dashed lines and drop a card at each place setting — guests scan, shoot, and tick them off as they go. Changes save automatically.</p>
      <div class="actions">
        <button class="btn primary" on:click={() => printSheets(activeSheet ? [activeSheet] : [])} disabled={!cardsDrawn || !activeSheet}>🖨 Print{printSets.length > 1 ? ' this sheet' : ''}</button>
        <button class="btn ghost" on:click={() => exportSheetsPdf(activeSheet ? [activeSheet] : [])} disabled={!cardsDrawn || !activeSheet}>PDF</button>
        <button class="btn ghost" on:click={exportSheetPng} disabled={!cardsDrawn || !activeSheet}>PNG</button>
        {#if printSets.length > 1}
          <button class="btn ghost" on:click={() => printSheets(printSets)} disabled={!cardsDrawn}>🖨 All {printSets.length} sheets</button>
          <button class="btn ghost" on:click={() => exportSheetsPdf(printSets)} disabled={!cardsDrawn}>PDF (all)</button>
        {/if}
      </div>
    {:else}
      <p class="hint">Print it, drop it on the tables, or send the link out in advance — guests scan to join. Changes save automatically.</p>
      <div class="actions">
        <button class="btn primary" on:click={printPoster} disabled={busy}>🖨 Print</button>
        <!-- Only when there is something to put on the back. With no trick list this is a button
             that can only ever apologise. -->
        {#if activeSheet}
          <button class="btn ghost" on:click={openFinish} disabled={busy}
                  title="Poster on the front, trick list on the back — see both first">🖨 Front &amp; back…</button>
        {/if}
        <button class="btn ghost" on:click={exportPdf} disabled={busy}>PDF</button>
        <button class="btn ghost" on:click={exportPng} disabled={busy}>PNG</button>
        <button class="btn ghost" on:click={exportJpg} disabled={busy}>JPG</button>
      </div>
    {/if}
  </div>
</div>

{#if editorFile}
  <EventImageEditor file={editorFile} overlay="none" aspectW={1080} aspectH={1527}
    on:confirm={onBgCropped} on:cancel={() => (editorFile = null)} />
{/if}

{#if finishOpen}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="fin" on:click|self={() => (finishOpen = false)} role="dialog" aria-modal="true" aria-label="Front and back">
    <div class="fin-card" use:modalFocus>
      <div class="fin-head">
        <span>Front &amp; back</span>
        <button class="fin-x" on:click={() => (finishOpen = false)} aria-label="Close">✕</button>
      </div>
      <div class="fin-pages">
        <figure><canvas bind:this={fFront}></canvas><figcaption>Front — the poster</figcaption></figure>
        <figure><canvas bind:this={fBack}></canvas><figcaption>Back — {activeSheet?.label ?? 'trick list'}</figcaption></figure>
      </div>
      {#if finishBusy}<p class="hint">Building both sides…</p>{/if}
      <!-- The one thing that actually ruins a double-sided job, and it is the printer's setting, not
           ours: short-edge flipping gives you a back that is upside down relative to the front. Said
           here, before printing, rather than in a toast after fifty sheets. -->
      <p class="fin-note">
        Two pages. Set your printer to <b>double-sided</b> and flip on the <b>long edge</b> — short
        edge prints the back upside down.
      </p>
      <div class="fin-acts">
        <button class="btn primary grow" on:click={printDoubleSided} disabled={finishBusy || !activeSheet}>🖨 Print both sides</button>
        <button class="btn ghost" on:click={() => { finishOpen = false; printPoster(); }} disabled={finishBusy}>Poster only</button>
        <button class="btn ghost" on:click={() => { finishOpen = false; view = 'cards'; }}>Cards only</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .back { position: fixed; inset: 0; z-index: 300; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; padding: 20px; }
  .sheet { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); width: 100%; max-width: 420px; max-height: 94dvh; display: flex; flex-direction: column; overflow: auto; }
  .head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--border); font-weight: 800; position: sticky; top: 0; background: var(--surface); z-index: 1; }
  .poster-body { display: block; }
  /* On wider screens: preview on the left, scrollable controls on the right (no cramped stack). */
  @media (min-width: 720px) {
    .sheet { max-width: 800px; }
    .poster-body { display: flex; align-items: flex-start; }
    .poster-body .preview { flex: 0 0 320px; position: sticky; top: 52px; }
    .poster-body .editor { flex: 1; max-height: 70dvh; overflow: auto; border-left: 1px solid var(--border); }
  }
  .x { background: none; border: none; color: var(--text-muted); font-size: 1rem; cursor: pointer; }
  .head-actions { display: flex; align-items: center; gap: 8px; }
  .tog { background: transparent; border: 1px solid var(--border); color: var(--text); border-radius: 7px; padding: 5px 10px; font: inherit; font-size: 0.78rem; font-weight: 700; cursor: pointer; }
  .tog:hover { border-color: var(--accent); }
  .warn-note { font-size: 0.74rem; color: #ff8a8a; margin: 6px 0 8px; line-height: 1.4; }
  /* Poster / mission-cards switch — two outputs of the same design. */
  .tabs { display: flex; gap: 6px; padding: 10px 16px; border-bottom: 1px solid var(--border); }
  .tab { flex: 1; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: transparent;
    color: var(--text); font: inherit; font-size: 0.8rem; font-weight: 700; cursor: pointer; }
  .tab.on { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); }
  .empty { font-size: 0.8rem; color: var(--text-muted); text-align: center; margin: 0; }

  /* Full-screen layout mode — a big stage so dragging/placing elements is easy. */
  .sheet.fs { max-width: none; width: 100vw; height: 100dvh; max-height: 100dvh; border-radius: 0; overflow: hidden; }
  .poster-body.fs { display: flex; flex: 1; align-items: center; justify-content: center; overflow: hidden; min-height: 0; }
  .poster-body.fs .editor { display: none; }
  .poster-body.fs .preview { flex: 1; position: static; padding: 16px; background: var(--surface-2); }
  .poster-body.fs .canvas-wrap { max-width: min(94vw, calc((100dvh - 170px) * 0.7073)); }
  .sheet.fs .hint { display: none; }
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
  .el-box { position: absolute; box-sizing: border-box; border: 1px dashed transparent; border-radius: 5px;
    pointer-events: auto; cursor: move; touch-action: none; user-select: none; -webkit-user-select: none; z-index: 1; }
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
  /* Resize grip sits at the bottom-right corner, just touching the outline without covering content. */
  .el-rz { position: absolute; transform: translate(-2px, -2px); display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; color: #111; background: rgba(255,255,255,0.92); border: 1px solid var(--accent); border-radius: 6px;
    cursor: nwse-resize; font-size: 0.72rem; touch-action: none; line-height: 1; z-index: 3; }
  .el-rz.active { background: var(--accent); }
  .spinner { width: 30px; height: 30px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .editor { padding: 6px 16px 0; }
  .editor summary { cursor: pointer; font-size: 0.85rem; font-weight: 700; padding: 4px 0; }
  .fld { display: block; margin-top: 10px; font-size: 0.78rem; color: var(--text-muted); }
  .fld > span { display: block; margin-bottom: 4px; }
  .fld input, .fld select { width: 100%; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; font: inherit; font-size: 0.85rem; box-sizing: border-box; background: var(--surface); color: var(--text); }
  /* A switch row is a label that WILL wrap at 360px plus a 46px switch, so two things matter:
     · align-items:flex-start pins the switch to the label's FIRST line instead of floating it
       halfway down a three-line label;
     · the label is ONE flex item (flex:1, min-width:0). It used to be two — the bare text node and
       the <span class="sub"> became separate flex children, which is what sat a sub-note BESIDE
       its label, each wrapping in its own column, rather than under it. */
  .chk { display: flex; align-items: flex-start; gap: 10px; margin-top: 10px; font-size: 0.82rem; line-height: 1.35; }
  .chk > label { flex: 1; min-width: 0; cursor: pointer; }
  .chk.off > label { opacity: 0.5; cursor: not-allowed; }
  .chk .sub { display: block; margin-top: 2px; }
  .bg-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .seg { padding: 7px 11px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text); cursor: pointer; font-size: 0.8rem; }
  .seg.on { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); font-weight: 700; }
  .seg.file { display: inline-flex; align-items: center; }
  .seg.color { display: inline-flex; align-items: center; gap: 7px; }
  .seg.color input[type="color"] { width: 22px; height: 22px; padding: 0; border: none; background: none; cursor: pointer; }
  .layout-hint { font-size: 0.74rem; color: var(--text-muted); margin: 0 0 8px; line-height: 1.45; }
  .colors { margin-top: 14px; }
  .c-head { font-size: 0.78rem; color: var(--text-muted); margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .mini-link { background: none; border: none; color: var(--accent); font-size: 0.7rem; font-weight: 700; cursor: pointer; padding: 0; }
  .c-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 0; font-size: 0.82rem; }
  .c-row input[type="color"] { width: 42px; height: 28px; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: none; cursor: pointer; }
  .c-row input[type="range"] { width: 55%; accent-color: var(--accent); cursor: pointer; }
  .pal { margin-top: 10px; }
  .pal-h { font-size: 0.74rem; color: var(--text-muted); }
  .swatches { display: flex; gap: 6px; margin-top: 6px; flex-wrap: wrap; }
  .sw { width: 30px; height: 30px; border-radius: 7px; border: 1px solid var(--border); cursor: pointer; }
  .hint { text-align: center; font-size: 0.78rem; color: var(--text-muted); padding: 12px 16px 0; }
  .actions { display: flex; gap: 8px; padding: 14px 16px; flex-wrap: wrap; justify-content: center; }
  .btn { font-weight: 700; border-radius: var(--radius-sm); padding: 10px 16px; font-size: 0.85rem; border: 1px solid transparent; cursor: pointer; font: inherit; }
  .btn.primary { background: var(--accent); color: var(--accent-ink, #111); }
  .btn.ghost { background: transparent; border-color: var(--border); color: var(--text); }
  .btn:disabled { opacity: 0.5; cursor: default; }
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
  .pstep.skipped { opacity: .4; cursor: default; }
  .pstep.skipped .ps-n { border-style: dashed; }
  .pstep.on { color: var(--text); font-weight: 700; }
  .ps-n {
    width: 18px; height: 18px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; font-size: 0.64rem; font-weight: 700;
    background: var(--surface-2); border: 1px solid var(--border);
  }
  .pstep.on .ps-n { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); }
  .pstep.done .ps-n { color: var(--accent); border-color: var(--accent); }
  /* Labels go first when there is no room — the numbers and the track still say where you are. */
  @media (max-width: 520px) { .ps-t { display: none; } }

  .pnav { display: flex; gap: 8px; margin-top: 12px; }
  .pnav .grow { flex: 2 1 0; }
  .pnav > .seg { flex: 1 1 0; min-width: 0; justify-content: center; }
  /* ── Front & back ────────────────────────────────────────────────────────── */
  /* Above .back (z-index 300), which is the designer's own backdrop. At 120 this panel opened
     faithfully every time and was painted underneath it — indistinguishable from a dead button. */
  .fin { position: fixed; inset: 0; z-index: 400; display: flex; align-items: center; justify-content: center;
         background: rgba(0,0,0,0.6); padding: 16px; }
  .fin-card { width: min(560px, 100%); max-height: 90vh; overflow: auto; padding: 14px;
              background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  .fin-head { display: flex; align-items: center; justify-content: space-between; font-weight: 800; margin-bottom: 10px; }
  .fin-x { width: 44px; height: 44px; margin: -10px -10px -10px 0; background: none; border: 0;
           color: var(--text-muted); font-size: 1rem; cursor: pointer; }
  /* Side by side where there is room, stacked on a phone — and the pages keep their own proportions
     so a 1-up A4 card sheet does not get squeezed into the poster's shape. */
  .fin-pages { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; }
  .fin-pages figure { margin: 0; flex: 0 1 auto; }
  .fin-pages canvas { display: block; max-width: 100%; height: auto; border: 1px solid var(--border);
                      border-radius: 4px; background: #fff; }
  .fin-pages figcaption { padding-top: 5px; font-size: 0.72rem; color: var(--text-muted); text-align: center; }
  .fin-note { margin: 12px 0 10px; font-size: 0.76rem; line-height: 1.45; color: var(--text-muted); }
  .fin-acts { display: flex; flex-wrap: wrap; gap: 8px; }
  .fin-acts .grow { flex: 2 1 160px; }
  .fin-acts .btn { flex: 1 1 110px; }
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
  .el-edit input {
    flex: 1 1 auto; min-width: 0; min-height: 44px; padding: 8px 10px; font: inherit; font-size: 16px;
    color: var(--text); background: var(--surface); border: 2px solid var(--accent); border-radius: 9px;
  }
  /* 16px exactly: iOS Safari zooms the whole page in on any focused input smaller than that, which
     on a poster preview throws away the view the host was working in. */
  .ee-done {
    flex: none; width: 44px; min-height: 44px; cursor: pointer; font-size: 1rem;
    color: var(--accent-ink, #111); background: var(--accent); border: 0; border-radius: 9px;
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
    padding: 0 6px; border-radius: 999px; background: var(--accent); color: var(--accent-ink, #111);
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
  .d-x { flex: none; width: 44px; color: var(--text-muted); }
  .d-x:hover { color: var(--danger, #e0483d); border-color: var(--danger, #e0483d); }
  /* A motif's box is dashed rather than solid: it is a handle around a drawing, not the drawing's
     own edge, and a solid box reads as though the motif is a rectangle. */
  .el-box.decor { border-style: dashed; }
  /* Narrower than the labelled toggles beside them — they are a pair of glyphs, and at the same
     width they crowded the Arrange button off a 360px header. */
  .tog.undo { min-width: 34px; padding-left: 6px; padding-right: 6px; font-size: 1rem; }
  .tog.undo:disabled { opacity: 0.35; cursor: default; }
</style>
