<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher, tick } from 'svelte';
  import { modalFocus } from '$lib/ui';
  import { showToast } from '$lib/toast';
  import { savePoster, type EventTheme } from '$lib/events';
  import { DEFAULT_EVENT_THEME } from '$lib/theme';
  import { tickFor, cleanTick } from '$lib/challenges';
  import { drawDecor, decorFor, cameraMargin, CAMERA_TOP, DECOR_KINDS, DECOR_POSITIONS, type DecorKind, type DecorPos } from '$lib/cardDecor';
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

  const dispatch = createEventDispatcher<{ close: void }>();

  const W = 1080, H = 1527;                 // A4 portrait
  let canvas: HTMLCanvasElement;
  let busy = true;
  let mounted = false;

  const slug = (eventName || 'event').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'event';
  const cleanUrl = joinUrl.replace(/^https?:\/\//, '');

  // ── Editable state (auto-saved to localStorage per event) ──
  let headline = eventName || 'Our Event';
  // A welcome blurb (if set) becomes the default poster message; still freely editable below.
  let message = blurb.trim() || "You're invited — scan to join the camera";
  let stepsText = '①  Scan to join     ②  Snap your roll     ③  Revealed when it ends';
  let bgMode: 'event' | 'custom' | 'plain' = themeImageUrl ? 'event' : 'plain';
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
  type ElKey = 'brand' | 'title' | 'message' | 'steps' | 'qr' | 'footer';
  type Box = { x: number; y: number; size: number };
  // Default positions are spaced so nothing overlaps: brand at the very top, title + message above
  // the QR panel, the QR centred, then the how-to line and footer below it. (The QR's white panel
  // is ~675px tall at the default size, so its top sits ≈0.36 and bottom ≈0.81 of the page.)
  const DEFAULT_LAYOUT: Record<ElKey, Box> = {
    brand:   { x: 0.5, y: 0.07,  size: 34 },   // the 🎩 Snapdini mark — slides left/right along the top only
    title:   { x: 0.5, y: 0.20,  size: 72 },
    message: { x: 0.5, y: 0.295, size: 32 },
    qr:      { x: 0.5, y: 0.585, size: 480 },
    steps:   { x: 0.5, y: 0.88,  size: 30 },
    footer:  { x: 0.5, y: 0.96,  size: 26 },
  };
  const cloneLayout = (l: Record<ElKey, Box>): Record<ElKey, Box> =>
    ({ brand: { ...l.brand }, title: { ...l.title }, message: { ...l.message }, steps: { ...l.steps }, qr: { ...l.qr }, footer: { ...l.footer } });
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
  $: cfg = { headline, message, stepsText, bgMode, cBg, codeDisplay, showFooterUrl, layout, colorsLocked, cHeadline, cMessage, cSteps, cCode, cFooter,
             cardTitle, cardInkSaver, cardsPerSheet, cardRound, cardIds, cardSkip, cardShowQr, cardShowLink, cardCaption,
             cardCTitle, cardCBody, cardCCode, cardCBg, cardLayout, decorKind, decorPos, decorScale, decorColour };
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
    code: readableOn(cCode, '#ffffff', INK_BODY),
  };
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
    bgMode = c.bgMode; cBg = c.cBg; codeDisplay = c.codeDisplay; showFooterUrl = c.showFooterUrl;
    layout = cloneLayout(c.layout);
    colorsLocked = c.colorsLocked;
    cHeadline = c.cHeadline; cMessage = c.cMessage; cSteps = c.cSteps; cCode = c.cCode; cFooter = c.cFooter;
    cardTitle = c.cardTitle; cardInkSaver = c.cardInkSaver;
    cardsPerSheet = c.cardsPerSheet; cardRound = c.cardRound; cardIds = c.cardIds; cardSkip = [...(c.cardSkip ?? [])];
    cardShowQr = c.cardShowQr; cardShowLink = c.cardShowLink; cardCaption = c.cardCaption;
    cardCTitle = c.cardCTitle; cardCBody = c.cardCBody; cardCCode = c.cardCCode; cardCBg = c.cardCBg;
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
  function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function drawCover(ctx: CanvasRenderingContext2D, img: HTMLImageElement, w: number, h: number) {
    const s = Math.max(w / img.width, h / img.height); const dw = img.width * s, dh = img.height * s;
    ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
  }
  // Draw a single line, shrinking the font until it fits maxW — keeps long join URLs from
  // spilling past the QR panel / page edge (no clean place to wrap a URL).
  function fitText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, weight: number, sizePx: number, family: string): void {
    let size = sizePx;
    ctx.font = `${weight} ${size}px ${family}`;
    while (size > 14 && ctx.measureText(text).width > maxW) { size -= 2; ctx.font = `${weight} ${size}px ${family}`; }
    ctx.fillText(text, x, y);
  }
  // Draw a URL, splitting a long one onto two lines — domain on top, the /path below — rather
  // than shrinking it to nothing. Each line still fits-to-width as a safety net.
  function drawUrl(ctx: CanvasRenderingContext2D, url: string, x: number, y: number, maxW: number, weight: number, sizePx: number, family: string, lineH: number): void {
    ctx.font = `${weight} ${sizePx}px ${family}`;
    if (ctx.measureText(url).width <= maxW) { ctx.fillText(url, x, y); return; }
    const i = url.indexOf('/');
    const domain = i === -1 ? url : url.slice(0, i);
    const path = i === -1 ? '' : url.slice(i);
    fitText(ctx, domain, x, y, maxW, weight, sizePx, family);
    if (path) fitText(ctx, path, x, y + lineH, maxW, weight, Math.round(sizePx * 0.82), family);
  }
  // Plain background = a solid colour (default white; the organizer can recolour it or match the theme).
  function paintPlain(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = cBg || '#ffffff'; ctx.fillRect(0, 0, W, H);
  }
  // The Snapdini brand mark punched into the centre of the QR: a white safety ring (so the QR stays
  // readable), the gold chip, and a black top-hat — matching the <Logo> component. Safe because the
  // poster QR is generated at high error-correction (≈30% recoverable).
  function drawBrandChip(ctx: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
    const ring = size * 1.16;
    ctx.fillStyle = '#ffffff'; roundRect(ctx, cx - ring / 2, cy - ring / 2, ring, ring, ring * 0.26); ctx.fill();
    ctx.fillStyle = '#f5c518'; roundRect(ctx, cx - size / 2, cy - size / 2, size, size, size * 0.24); ctx.fill();
    ctx.fillStyle = '#111111';
    const cw = size * 0.36, ch = size * 0.40, top = cy - size * 0.17;
    roundRect(ctx, cx - cw / 2, top, cw, ch, size * 0.04); ctx.fill();                       // hat crown
    const bw = size * 0.64, bh = size * 0.11;
    roundRect(ctx, cx - bw / 2, top + ch - bh * 0.35, bw, bh, bh * 0.5); ctx.fill();          // hat brim
  }
  const bgSrc = () => bgMode === 'custom' ? customBgUrl : bgMode === 'event' ? themeImageUrl : null;

  async function draw() {
    if (!canvas) return;
    const ctx = canvas.getContext('2d'); if (!ctx) return;
    canvas.width = W; canvas.height = H;
    const src = bgSrc();
    if (src) {
      try { const bg = await loadImg(src); drawCover(ctx, bg, W, H); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H); extractPalette(bg); }
      catch { paintPlain(ctx); }
    } else paintPlain(ctx);

    // Brand badge along the top — slides left/right (fixed height, never resized).
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = ink.headline; ctx.font = `600 ${layout.brand.size}px "Helvetica Neue", Arial, sans-serif`;
    ctx.fillText('🎩 Snapdini', layout.brand.x * W, layout.brand.y * H + layout.brand.size * 0.34);

    // Everything else is drawn at its free layout position (the organizer drags/resizes these).
    const qr = await loadImg(qrImg);
    drawQrPanel(ctx, layout.qr, qr);
    drawTextBox(ctx, headline || 'Our Event', 800, ink.headline, layout.title, W - 140);
    if (message.trim()) drawTextBox(ctx, message, 400, ink.message, layout.message, W - 200);
    if (stepsText.trim()) drawTextBox(ctx, stepsText, 500, ink.steps, layout.steps, W - 120);
    if (showFooterUrl) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = ink.footer;
      drawUrl(ctx, cleanUrl, layout.footer.x * W, layout.footer.y * H, W - 120, 400, layout.footer.size, 'ui-monospace, Menlo, Consolas, monospace', layout.footer.size * 1.25);
    }
    busy = false;
  }

  // Wrap text to maxW at the current font, returning the lines.
  function wrapToLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
    const words = text.split(/\s+/); const lines: string[] = []; let line = '';
    for (const w of words) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
    if (line) lines.push(line); return lines;
  }
  // The coordinate space a Box's x/y fractions are measured against. The poster is the whole page;
  // a card is a rect inside the sheet — same helpers, same drag code, two spaces.
  type Space = { w: number; h: number; ox: number; oy: number };
  const PAGE: Space = { w: W, h: H, ox: 0, oy: 0 };
  // Centred (horizontally + vertically) wrapped text block at the box's centre.
  function drawTextBox(ctx: CanvasRenderingContext2D, text: string, weight: number, color: string, box: Box, maxW: number, sp: Space = PAGE, sizePx = box.size) {
    const family = '"Helvetica Neue", Arial, sans-serif';
    ctx.font = `${weight} ${sizePx}px ${family}`; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lines = wrapToLines(ctx, text, maxW); const lh = sizePx * 1.18;
    let y = sp.oy + box.y * sp.h - ((lines.length - 1) * lh) / 2;
    for (const ln of lines) { ctx.fillText(ln, sp.ox + box.x * sp.w, y); y += lh; }
  }
  // White QR panel (QR + centre brand chip + optional code/URL), centred on its box.
  function drawQrPanel(ctx: CanvasRenderingContext2D, box: Box, qr: HTMLImageElement) {
    const qSize = box.size, panelW = qSize + 90, panelH = qSize + (codeDisplay !== 'none' ? 195 : 90);
    const px = box.x * W - panelW / 2, py = box.y * H - panelH / 2;
    ctx.fillStyle = '#ffffff'; roundRect(ctx, px, py, panelW, panelH, 36); ctx.fill();
    const qx = px + (panelW - qSize) / 2, qy = py + 45, ccx = px + panelW / 2;
    ctx.imageSmoothingEnabled = false; ctx.drawImage(qr, qx, qy, qSize, qSize); ctx.imageSmoothingEnabled = true;
    drawBrandChip(ctx, qx + qSize / 2, qy + qSize / 2, qSize * 0.20);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    if (codeDisplay === 'code') {
      ctx.fillStyle = '#555'; ctx.font = '400 26px "Helvetica Neue", Arial, sans-serif'; ctx.fillText('Join code', ccx, qy + qSize + 52);
      ctx.fillStyle = ink.code; ctx.font = '800 58px ui-monospace, Menlo, Consolas, monospace'; ctx.fillText(joinCode, ccx, qy + qSize + 116);
    } else if (codeDisplay === 'url') {
      ctx.fillStyle = ink.code; drawUrl(ctx, cleanUrl, ccx, qy + qSize + 86, panelW - 70, 700, 36, '"Helvetica Neue", Arial, sans-serif', 44);
    }
  }

  // ── Drag + resize the elements directly on the preview ──────────────────────
  let stageEl: HTMLDivElement;
  let dragKey: ElKey | null = null;
  let selectedKey: ElKey | null = null;   // click-to-select → reveals that element's outline + grip
  let fsEdit = false;                  // full-screen layout mode (bigger stage = easier dragging)
  // QR sizing limits, in 1080-wide canvas px. The poster is A4 (210mm wide) so px·0.194 ≈ mm.
  // Below the floor the code + centre logo stops scanning reliably; below the warn line we caution.
  const QR_MIN_PX = 170;               // ≈ 33mm printed on A4 — hard floor
  const QR_WARN_PX = 230;              // ≈ 45mm — warn below this
  $: qrTooSmall = layout.qr.size < QR_WARN_PX;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  $: elements = ([
    { key: 'brand', label: 'Logo', show: true, resizable: false, axis: 'x' },
    { key: 'title', label: 'Title', show: true, resizable: true, axis: 'xy' },
    { key: 'message', label: 'Message', show: !!message.trim(), resizable: true, axis: 'xy' },
    { key: 'steps', label: 'How-to', show: !!stepsText.trim(), resizable: true, axis: 'xy' },
    { key: 'qr', label: 'QR', show: true, resizable: true, axis: 'xy' },
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
  function qrBounds(box: Box): Rect {
    const panelW = box.size + 90, panelH = box.size + (codeDisplay !== 'none' ? 195 : 90);
    return { x: box.x * W - panelW / 2, y: box.y * H - panelH / 2, w: panelW, h: panelH };
  }
  function brandBounds(ctx: CanvasRenderingContext2D): Rect {
    ctx.font = `600 ${layout.brand.size}px "Helvetica Neue", Arial, sans-serif`;
    const w = ctx.measureText('🎩 Snapdini').width, h = layout.brand.size * 1.2;
    return { x: layout.brand.x * W - w / 2, y: layout.brand.y * H - h / 2, w, h };
  }
  const ZERO_RECT: Rect = { x: 0, y: 0, w: 0, h: 0 };
  function measureBounds(): Record<ElKey, Rect> {
    const ctx = measureCtx();
    if (!ctx) return { brand: ZERO_RECT, title: ZERO_RECT, message: ZERO_RECT, steps: ZERO_RECT, qr: ZERO_RECT, footer: ZERO_RECT };
    return {
      brand: brandBounds(ctx),
      title: textBounds(ctx, headline || 'Our Event', 800, layout.title, W - 140),
      message: textBounds(ctx, message || ' ', 400, layout.message, W - 200),
      steps: textBounds(ctx, stepsText || ' ', 500, layout.steps, W - 120),
      qr: qrBounds(layout.qr),
      footer: footerBounds(ctx, layout.footer),
    };
  }
  // Recompute whenever anything that affects a footprint changes. Each dependency is referenced in
  // the assignment expression itself (comma operator) so Svelte tracks them reliably — text content,
  // the QR's code/URL toggle and footer visibility all change an element's measured size.
  let bounds: Record<ElKey, Rect> = measureBounds();
  $: bounds = (layout, headline, message, stepsText, codeDisplay, showFooterUrl, mounted, measureBounds());

  // A draggable surface: the poster page, or one card on the sheet. Everything the drag needs that
  // differs between the two lives here, so there is ONE drag implementation rather than a card copy
  // of the poster's that drifts away from it.
  type Surface = {
    stage: () => HTMLElement | undefined;
    w: number; h: number;                              // the surface's design-space size
    rects: () => Record<string, Rect>;                 // measured footprints, in that same space
    box: (key: string) => Box;                         // the stored position/size being dragged
    limits: (key: string) => [number, number];         // size clamp for a resize
    lockY?: (key: string) => boolean;
    move: (key: string, x: number, y: number) => void;
    size: (key: string, px: number) => void;
    remeasure: () => void;
    redraw: () => void;
    select: (key: string | null) => void;
    dragging: (key: string | null) => void;
  };
  // Drag values are saved, and the saved design is a bounded blob: four decimals is well under a
  // printed pixel and keeps a dragged layout from bloating the record with pointer noise.
  const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
  const r1 = (n: number) => Math.round(n * 10) / 10;

  function dragOn(surf: Surface, key: string, mode: 'move' | 'resize', e: PointerEvent) {
    // Before anything moves, so the whole drag undoes as one action.
    commitBurst();
    pushUndo(JSON.stringify(cfg));
    e.preventDefault(); e.stopPropagation();
    const stage = surf.stage(); if (!stage) return;
    surf.dragging(key); surf.select(key);
    const rect = stage.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY };
    const box0 = { ...surf.box(key) };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      if (mode === 'move') {
        // Clamp by the element's HALF size so its whole footprint stays inside the surface — the
        // centre can't go closer to an edge than half the element's width/height.
        const b = surf.rects()[key];
        const hw = b ? Math.min(0.5, b.w / 2 / surf.w) : 0.02;
        const hh = b ? Math.min(0.5, b.h / 2 / surf.h) : 0.02;
        const x = clamp(box0.x + (ev.clientX - start.x) / rect.width, hw, 1 - hw);
        const y = surf.lockY?.(key) ? box0.y : clamp(box0.y + (ev.clientY - start.y) / rect.height, hh, 1 - hh);
        surf.move(key, r4(x), r4(y));
      } else {
        const dpx = ((ev.clientX - start.x) / rect.width) * surf.w;
        const [lo, hi] = surf.limits(key);
        surf.size(key, r1(clamp(box0.size + dpx, lo, hi)));
      }
      // Update the outline + canvas immediately so they track the pointer with no lag.
      surf.remeasure();
      surf.redraw();
    };
    const onUp = () => { surf.dragging(null); window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  }
  const posterSurface: Surface = {
    stage: () => stageEl,
    w: W, h: H,
    rects: () => bounds,
    box: (k) => layout[k as ElKey],
    // The QR floor is what keeps a code with our logo punched into its centre scannable.
    limits: (k) => (k === 'qr' ? [QR_MIN_PX, 760] : [16, 170]),
    lockY: (k) => k === 'brand',      // the brand mark slides left/right along the top only
    move: (k, x, y) => { layout = { ...layout, [k]: { ...layout[k as ElKey], x, y } }; },
    size: (k, px) => { layout = { ...layout, [k]: { ...layout[k as ElKey], size: px } }; },
    remeasure: () => { bounds = measureBounds(); },
    redraw: scheduleRedraw,
    select: (k) => (selectedKey = k as ElKey | null),
    dragging: (k) => (dragKey = k as ElKey | null),
  };
  function startDrag(key: ElKey, mode: 'move' | 'resize', e: PointerEvent) { dragOn(posterSurface, key, mode, e); }
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
  onMount(() => { restore(); mounted = true; loadPosterQr(); loadMissions(); draw().catch(() => { busy = false; showToast('Could not build the poster', true); }); });
  onDestroy(() => { if (customBgUrl) URL.revokeObjectURL(customBgUrl); });

  // `kind` names what was exported — the poster and each set's card sheet land in the same
  // downloads folder, so "cards-b" has to be distinguishable from "poster" at a glance.
  function download(blob: Blob, ext: string, kind = 'poster') {
    const href = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = href; a.download = `${slug}-${kind}.${ext}`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(href);
  }
  function exportPng() { canvas.toBlob((b) => b && download(b, 'png'), 'image/png'); }
  function exportJpg() { canvas.toBlob((b) => b && download(b, 'jpg'), 'image/jpeg', 0.92); }
  async function exportPdf() {
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, pdf.internal.pageSize.getWidth(), pdf.internal.pageSize.getHeight());
      pdf.save(`${slug}-poster.pdf`);
    } catch { showToast('Could not build the PDF', true); }
  }
  function printPoster() {
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
  const CARD_GAP = 10;                 // gutter inside the cut line, so scissors have somewhere to go
  const CARD_PAD = 34;                 // ≈6.6mm of quiet space inside the card's edge
  // The card's QR. QR_MIN_PX (≈33mm) is the floor that keeps a code with our logo punched into its
  // centre scannable, and this clears it at ≈39mm. QR_WARN_PX (≈45mm) is deliberately NOT applied
  // here: that line sizes a code to be read across a room, and a card is held in the hand.
  const CARD_QR_PX = 200;
  const CARD_QR_MAX = 420;
  const CARD_FAMILY = '"Helvetica Neue", Arial, sans-serif';
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
  $: cardCols = cardsPerSheet === 4 ? 2 : 1;
  $: cardRows = cardsPerSheet === 1 ? 1 : 2;
  $: slotW = W / cardCols;
  $: slotH = H / cardRows;
  $: cardUnit = cardsPerSheet === 1 ? 2 : 1;

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

  type TitleGeom = { rect: Rect; size: number; lines: string[]; labelSize: number; label: string };
  function titleGeom(ctx: CanvasRenderingContext2D, g: CardBox, set: MissionSet | null): TitleGeom {
    const size = cardLayout.title.size * g.u, labelSize = 19 * g.u, label = cardLabelFor(set);
    ctx.font = `800 ${size}px ${CARD_FAMILY}`;
    // Two lines at most: past that there is no card left for the tricks.
    const lines = wrapToLines(ctx, cardHeading, g.innerW).slice(0, 2);
    let w = 0;
    for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
    if (label) { ctx.font = `700 ${labelSize}px ${CARD_FAMILY}`; w = Math.max(w, ctx.measureText(label).width); }
    w = Math.min(w, g.innerW);
    const h = lines.length * size * 1.2 + (label ? labelSize * 1.5 : 0);
    const c = placeOnCard(g, cardLayout.title, w, h);
    return { rect: { x: c.x - w / 2, y: c.y - h / 2, w, h }, size, lines, labelSize, label };
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
    const showCode = cardShowLink && codeDisplay !== 'none';
    const caption = cardCaption.trim();
    const maxTextW = g.innerW - (qrPx ? qrPx + gap : 0);
    let tw = 0, th = 0;
    let capLines: string[] = [];
    if (cardShowLink) { ctx.font = `700 ${20 * ts}px ${CARD_FAMILY}`; tw = Math.max(tw, ctx.measureText('Scan to join').width); th += 30 * ts; }
    if (showCode) {
      if (codeDisplay === 'code') { ctx.font = `800 ${34 * ts}px ${CARD_MONO}`; tw = Math.max(tw, ctx.measureText(joinCode).width); th += 48 * ts; }
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
    ctx.fillStyle = cardInk.title; ctx.font = `800 ${t.size}px ${CARD_FAMILY}`;
    for (const ln of t.lines) { ctx.fillText(ln, tcx, ty); ty += t.size * 1.2; }
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
      // The tick is drawn in the card's ink; an emoji one is painted in colour by the device font
      // and ignores this (see tickIsEmoji).
      ctx.fillStyle = cardInk.body; ctx.font = `400 ${fs}px ${CARD_FAMILY}`;
      ctx.textAlign = 'center'; ctx.fillText(cardGlyph, L + fs * 0.75, cy);
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
      if (codeDisplay === 'code') { fitText(ctx, joinCode, j.tx, jy, j.tw, 800, 34 * ts, CARD_MONO); jy += 48 * ts; }
      else if (codeDisplay === 'url') { drawUrl(ctx, cleanUrl, j.tx, jy, j.tw, 700, 21 * ts, CARD_FAMILY, 26 * ts); jy += 58 * ts; }
    }
    // What the card is FOR. Without this a guest has a list and no idea it is tickable in the app.
    ctx.fillStyle = cardInk.muted; ctx.font = `400 ${18 * ts}px ${CARD_FAMILY}`;
    for (const ln of j.capLines) { ctx.fillText(ln, j.tx, jy); jy += 23 * ts; }
  }

  /** Paint one set's sheet at CARD_SCALE, however many cards the host wants on it. */
  async function drawSheet(ctx: CanvasRenderingContext2D, set: MissionSet) {
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

  async function drawCards() {
    if (!cardCanvas || !activeSheet) return;
    const ctx = cardCanvas.getContext('2d'); if (!ctx) return;
    cardCanvas.width = W * CARD_SCALE; cardCanvas.height = H * CARD_SCALE;
    await drawSheet(ctx, activeSheet);
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
    ? JSON.stringify([cfg, customBgUrl, activeSheet, sheets.length, cardGlyph, cardInk, cardBgHex, cardUseImage, decorUsed, decorInk]) : '';
  $: if (cardSig) scheduleCardRedraw();

  /** A sheet on its own canvas, so an export never depends on which one is being previewed. */
  async function sheetCanvas(set: MissionSet): Promise<HTMLCanvasElement> {
    const c = document.createElement('canvas');
    c.width = W * CARD_SCALE; c.height = H * CARD_SCALE;
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
        '<style>@page{size:A4;margin:0}body{margin:0}img{width:100%;display:block}img+img{page-break-before:always}</style>'
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
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
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
        <!-- The overlay covers the FIRST card only: every card on the sheet is the same design, so
             arranging one arranges them all — and a handle per card would be four handles fighting
             over the same value. -->
        <!-- svelte-ignore a11y-no-static-element-interactions a11y-click-events-have-key-events -->
        <div class="poster-stage card-stage" bind:this={cardStageEl}
          style="left:{(cardGeomBox.x0 / W) * 100}%; top:{(cardGeomBox.y0 / H) * 100}%; width:{(cardGeomBox.cw / W) * 100}%; height:{(cardGeomBox.ch / H) * 100}%"
          on:pointerdown|self={() => (cardSelectedKey = null)}>
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
        <div class="poster-stage" bind:this={stageEl} on:pointerdown|self={() => (selectedKey = null)}>
          {#each elements as el (el.key)}
            {#if bounds[el.key]}
              {@const b = bounds[el.key]}
              <!-- The whole footprint is the move target; outline shows on hover or when selected. -->
              <!-- label-below: near the top of the stage there is no room above, and the sheet
                   clips anything that overflows it, so the label would simply vanish. -->
              <div class="el-box" class:active={dragKey === el.key} class:selected={selectedKey === el.key} class:warn={el.key === 'qr' && qrTooSmall} class:lock-x={el.axis === 'x'} class:label-below={(b.y / H) < 0.07}
                style="left:{(b.x / W) * 100}%; top:{(b.y / H) * 100}%; width:{(b.w / W) * 100}%; height:{(b.h / H) * 100}%"
                on:pointerdown={(e) => startDrag(el.key, 'move', e)} role="button" tabindex="-1" aria-label="Move {el.label}">
                <span class="el-name">{el.label}{#if el.key === 'qr' && qrTooSmall} ⚠{/if}</span>
              </div>
              {#if el.resizable && selectedKey === el.key}
                <span class="el-rz" class:active={dragKey === el.key}
                  style="left:{((b.x + b.w) / W) * 100}%; top:{((b.y + b.h) / H) * 100}%"
                  on:pointerdown={(e) => startDrag(el.key, 'resize', e)} aria-label="Resize {el.label}">⤡</span>
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
        <label class="fld"><span>Card title</span><input bind:value={cardTitle} maxlength="60" placeholder={headline} /></label>

        <div class="fld"><span>Cards per sheet</span>
          <div class="bg-row">
            <button class="seg" class:on={cardsPerSheet === 4} on:click={() => (cardsPerSheet = 4)}>4 · A6</button>
            <button class="seg" class:on={cardsPerSheet === 2} on:click={() => (cardsPerSheet = 2)}>2 · A5</button>
            <button class="seg" class:on={cardsPerSheet === 1} on:click={() => (cardsPerSheet = 1)}>1 · A4</button>
          </div>
          <p class="layout-hint" style="margin-top:8px">A4 halves and quarters exactly, so every option fills the sheet. Bigger cards carry the same design at a bigger size — handy for a long trick list or a table sign.</p>
        </div>

        <div class="fld"><span>Trick list</span>
          <p class="layout-hint">Each card ticks with <b>{cardGlyph}</b> — chosen with the trick list itself, so the printed card and the app always agree.</p>
          {#if tickIsEmoji}<p class="warn-note">⚠ Emoji ticks are printed in colour by your device's own font, so they won't match the card's ink colour — an outline tick in the trick-list editor will.</p>{/if}
        </div>

        {#if sheets.length > 1}
          <div class="fld"><span>Print which sets</span>
            <div class="bg-row">
              {#each sheets as s}
                <button class="seg" class:on={!cardSkip.includes(s.key)} on:click={() => toggleSet(s.key)}
                  aria-pressed={!cardSkip.includes(s.key)}>{cardSkip.includes(s.key) ? '☐' : '☑'} {s.label}</button>
              {/each}
            </div>
            {#if !printSets.length}<p class="warn-note">⚠ Every set is switched off — turn at least one back on to print.</p>{/if}
          </div>
          {#if printSets.length > 1}
            <div class="fld"><span>Previewing ({previewIdx + 1} of {printSets.length})</span>
              <div class="bg-row">
                {#each printSets as s, i}
                  <button class="seg" class:on={previewIdx === i} on:click={() => (sheetIdx = i)}>{s.label}</button>
                {/each}
              </div>
              <p class="layout-hint" style="margin-top:8px">One sheet per set. Print the sheet you're looking at, or all {printSets.length} at once — or turn off the card identifiers below, shuffle and hand them out at random.</p>
            </div>
          {/if}
          <label class="chk"><input type="checkbox" bind:checked={cardIds} /> Print the card identifier ({sheets[0]?.label ?? 'Card A'}, …) on every card</label>
        {/if}

        <div class="fld"><span>Layout</span>
          <p class="layout-hint">Drag the title or the QR block on the preview to move it; drag the <b>⤡</b> corner to resize. You are arranging the first card — the rest of the sheet follows it.</p>
          <div class="bg-row">
            <button class="seg" on:click={resetCardLayout}>↺ Reset card layout</button>
            <button class="seg" on:click={undo} disabled={!undoStack.length} title="Undo the last change (Ctrl/⌘+Z)">↶ Undo</button>
            <button class="seg" on:click={redo} disabled={!redoStack.length} title="Redo (Ctrl/⌘+Shift+Z)">↷ Redo</button>
          </div>
          <label class="chk"><input type="checkbox" bind:checked={cardShowQr} /> Show the QR code</label>
          <label class="chk"><input type="checkbox" bind:checked={cardShowLink} /> Show the join link / code beside it</label>
          <label class="chk"><input type="checkbox" bind:checked={cardRound} /> Rounded corners <span class="sub">(off = the card edge matches the cut line)</span></label>
          <label class="chk"><input type="checkbox" bind:checked={cardInkSaver} /> Plain white cards (saves ink — four to a sheet adds up)</label>
        </div>

        <label class="fld"><span>Caption under the link</span><input bind:value={cardCaption} maxlength="70" placeholder="(blank to hide)" /></label>

        <div class="fld"><span>Decoration</span>
          <div class="bg-row">
            {#each DECOR_KINDS as d}
              <button class="seg" class:on={decorUsed === d.key} on:click={() => (decorKind = d.key)}>{d.label}</button>
            {/each}
          </div>
          {#if decorUsed !== 'none'}
            {#if decorPositional}
              <div class="bg-row" style="margin-top:8px">
                {#each DECOR_POSITIONS as p}
                  <button class="seg" class:on={decorPos === p.key} on:click={() => (decorPos = p.key)}>{p.label}</button>
                {/each}
              </div>
            {/if}
            <div class="bg-row" style="margin-top:8px">
              <label class="seg color"><input type="color" value={decorInk} on:input={onDecorColour} aria-label="Decoration colour" />Colour</label>
              {#if decorColour}<button class="seg" on:click={() => (decorColour = '')}>↺ Match ink</button>{/if}
            </div>
            <label class="c-row" style="margin-top:6px"><span>Size</span>
              <input type="range" min="0.6" max="1.8" step="0.1" bind:value={decorScale} aria-label="Decoration size" />
            </label>
          {/if}
          <p class="layout-hint" style="margin-top:6px">Line art in the card's own ink — it prints as cleanly as the text does. Your event type picks one to start with.</p>
        </div>

        <div class="colors">
          <div class="c-head">Card colours
            {#if cardColoursSet}<button class="mini-link" on:click={clearCardColours}>↺ Follow the poster</button>{/if}
          </div>
          {#each CARD_COLOR_ROWS as r}
            <label class="c-row"><span>{r.label}</span>
              <input type="color" value={r.get()} on:focus={() => (activeTarget = r.key)} on:input={(e) => onColorInput(e, r.key)} />
            </label>
          {/each}
          {#if palette.length}
            <div class="pal">
              <span class="pal-h">From your image → {CARD_COLOR_ROWS.find((x) => x.key === activeTarget)?.label ?? 'pick a row above'}:</span>
              <div class="swatches">{#each palette as p}<button class="sw" style="background:{p}" title={p} aria-label={`Use ${p}`} on:click={() => applySwatch(p)}></button>{/each}</div>
            </div>
          {/if}
          <p class="layout-hint" style="margin-top:8px">Text stays readable whatever background you choose — a colour that would disappear is nudged until it doesn't.</p>
        </div>
      {/if}
      {:else}
      <label class="fld"><span>Title</span><input bind:value={headline} maxlength="60" /></label>
      <label class="fld"><span>Message</span><input bind:value={message} maxlength="80" placeholder="(blank to hide)" /></label>
      <label class="fld"><span>How-to line</span><input bind:value={stepsText} maxlength="120" placeholder="(blank to hide)" /></label>

      <div class="fld"><span>Show under QR</span>
        <select bind:value={codeDisplay}>
          <option value="url">Join link</option>
          <option value="code">Join code</option>
          <option value="none">Nothing (QR only)</option>
        </select>
      </div>
      <label class="chk"><input type="checkbox" bind:checked={showFooterUrl} /> Show the link along the bottom</label>

      <div class="fld"><span>Layout</span>
        <p class="layout-hint">Drag any element to move it; drag the <b>⤡</b> corner to resize — the outline shows its true size. Place text off faces.</p>
        {#if qrTooSmall}<p class="warn-note">⚠ The QR code is getting small — keep it larger so guests can scan it reliably (the brand logo in the centre needs room).</p>{/if}
        <div class="bg-row">
          <button class="seg" on:click={() => (fsEdit = true)}>⛶ Full-screen arrange</button>
          <button class="seg" on:click={resetLayout}>↺ Reset layout</button>
        </div>
        <!-- Undo covers everything in the design, not just the layout — Reset layout only puts the
             boxes back. Ctrl/⌘+Z works too. -->
        <div class="bg-row">
          <button class="seg" on:click={undo} disabled={!undoStack.length}
                  title="Undo the last change (Ctrl/⌘+Z)">↶ Undo</button>
          <button class="seg" on:click={redo} disabled={!redoStack.length}
                  title="Redo (Ctrl/⌘+Shift+Z)">↷ Redo</button>
        </div>
      </div>

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
        {/if}
      </div>

      <div class="colors">
        <div class="c-head">Text colours
          {#if colorsLocked}<button class="mini-link" on:click={() => (colorsLocked = false)}>↺ Use theme colours</button>{/if}
        </div>
        {#each COLOR_ROWS as r}
          <label class="c-row"><span>{r.label}</span>
            <input type="color" value={r.get()} on:focus={() => (activeTarget = r.key)} on:input={(e) => onColorInput(e, r.key)} />
          </label>
        {/each}
        {#if palette.length}
          <div class="pal">
            <span class="pal-h">From your image → {COLOR_ROWS.find((x) => x.key === activeTarget)?.label}:</span>
            <div class="swatches">{#each palette as p}<button class="sw" style="background:{p}" title={p} aria-label={`Use ${p}`} on:click={() => applySwatch(p)}></button>{/each}</div>
          </div>
        {/if}
      </div>
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
  /* The card stage is one card inside the sheet, so it is positioned rather than inset:0. */
  .card-stage { inset: auto; }
  .sub { color: var(--text-muted); font-size: 0.72rem; }
  /* The element's footprint IS the move handle — drag anywhere on it. The outline only appears on
     hover or while active, so it doesn't clutter the preview; its true size shows when resizing. */
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
  .chk { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 0.82rem; }
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
</style>
