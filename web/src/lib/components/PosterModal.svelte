<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher, tick } from 'svelte';
  import { modalFocus } from '$lib/ui';
  import { showToast } from '$lib/toast';
  import { savePoster, type EventTheme } from '$lib/events';
  import { DEFAULT_EVENT_THEME } from '$lib/theme';
  import { TICKS_OUTLINE, TICKS_EMOJI, tickFor, cleanTick } from '$lib/challenges';
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
  type CTarget = 'headline' | 'message' | 'steps' | 'code' | 'footer';
  let activeTarget: CTarget = 'headline';
  let editorFile: File | null = null;

  // ── Mission cards: a second OUTPUT of the same design, not a second design ──
  // The printable mission card is how a shot list actually reaches a guest: four A6 cards to an A4
  // sheet, one per place setting. It borrows the poster's title, colours, background and join
  // details so the two read as one printed set; what is card-specific is the shot list itself, the
  // tick glyph beside each row, and an ink-saver option — four cards a sheet on a home printer is a
  // very different ink bill from one poster.
  type MissionSet = { key: string; label: string; items: { id: string; text: string }[] };
  let view: 'poster' | 'cards' = 'poster';
  let sheets: MissionSet[] = [];
  let eventType: string | null = null;
  let sheetIdx = 0;
  let cardsDrawn = false;                  // first sheet rendered — until then the preview spins
  let cardCanvas: HTMLCanvasElement;
  // Blank means "follow the poster title" / "follow the event type". Both defaults have to survive
  // the modal opening before the event's missions have loaded, and a host who never opens this tab
  // should still get a sensible card.
  let cardTitle = '';
  let cardTick = '';
  let cardInkSaver = false;

  // ── Persistence (auto-save on every change) ──
  $: cfg = { headline, message, stepsText, bgMode, cBg, codeDisplay, showFooterUrl, layout, colorsLocked, cHeadline, cMessage, cSteps, cCode, cFooter, cardTitle, cardTick, cardInkSaver };
  // Keep the default text colours readable as the background changes — until the organizer edits a
  // colour (colorsLocked). The void refs make Svelte re-run this when bgMode/cBg/theme change.
  $: if (!colorsLocked) { void bgMode; void cBg; void theme; ({ cHeadline, cMessage, cSteps, cCode, cFooter } = themeDefaults()); }
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
    cardTitle = c.cardTitle; cardTick = c.cardTick; cardInkSaver = c.cardInkSaver;
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
      if (dragKey) {
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
    // Card settings are plain overrides — an absent one keeps meaning "follow the poster".
    cardTitle = (c.cardTitle as string) ?? cardTitle; cardTick = (c.cardTick as string) ?? cardTick;
    cardInkSaver = (c.cardInkSaver as boolean) ?? cardInkSaver;
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
    ctx.fillStyle = cHeadline; ctx.font = `600 ${layout.brand.size}px "Helvetica Neue", Arial, sans-serif`;
    ctx.fillText('🎩 Snapdini', layout.brand.x * W, layout.brand.y * H + layout.brand.size * 0.34);

    // Everything else is drawn at its free layout position (the organizer drags/resizes these).
    const qr = await loadImg(qrImg);
    drawQrPanel(ctx, layout.qr, qr);
    drawTextBox(ctx, headline || 'Our Event', 800, cHeadline, layout.title, W - 140);
    if (message.trim()) drawTextBox(ctx, message, 400, cMessage, layout.message, W - 200);
    if (stepsText.trim()) drawTextBox(ctx, stepsText, 500, cSteps, layout.steps, W - 120);
    if (showFooterUrl) {
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = cFooter;
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
  // Centred (horizontally + vertically) wrapped text block at the box's centre.
  function drawTextBox(ctx: CanvasRenderingContext2D, text: string, weight: number, color: string, box: Box, maxW: number) {
    const family = '"Helvetica Neue", Arial, sans-serif';
    ctx.font = `${weight} ${box.size}px ${family}`; ctx.fillStyle = color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const lines = wrapToLines(ctx, text, maxW); const lh = box.size * 1.18;
    let y = box.y * H - ((lines.length - 1) * lh) / 2;
    for (const ln of lines) { ctx.fillText(ln, box.x * W, y); y += lh; }
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
      ctx.fillStyle = cCode; ctx.font = '800 58px ui-monospace, Menlo, Consolas, monospace'; ctx.fillText(joinCode, ccx, qy + qSize + 116);
    } else if (codeDisplay === 'url') {
      ctx.fillStyle = cCode; drawUrl(ctx, cleanUrl, ccx, qy + qSize + 86, panelW - 70, 700, 36, '"Helvetica Neue", Arial, sans-serif', 44);
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
  function textBounds(ctx: CanvasRenderingContext2D, text: string, weight: number, box: Box, maxW: number): Rect {
    ctx.font = `${weight} ${box.size}px "Helvetica Neue", Arial, sans-serif`;
    const lines = wrapToLines(ctx, text, maxW);
    const lh = box.size * 1.18, h = Math.max(lines.length, 1) * lh;
    let w = 0; for (const ln of lines) w = Math.max(w, ctx.measureText(ln).width);
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

  function startDrag(key: ElKey, mode: 'move' | 'resize', e: PointerEvent) {
    // Before anything moves, so the whole drag undoes as one action.
    commitBurst();
    pushUndo(JSON.stringify(cfg));
    e.preventDefault(); e.stopPropagation();
    dragKey = key;
    selectedKey = key;
    const rect = stageEl.getBoundingClientRect();
    const start = { x: e.clientX, y: e.clientY }, box = { ...layout[key] };
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const onMove = (ev: PointerEvent) => {
      if (mode === 'move') {
        // Clamp by the element's HALF size so its whole footprint stays inside the poster — the
        // centre can't go closer to an edge than half the element's width/height.
        const b = bounds[key];
        const hw = b ? Math.min(0.5, b.w / 2 / W) : 0.02;
        const hh = b ? Math.min(0.5, b.h / 2 / H) : 0.02;
        const x = clamp(box.x + (ev.clientX - start.x) / rect.width, hw, 1 - hw);
        // The brand mark slides left/right along the top only — its Y is fixed.
        const y = key === 'brand' ? box.y : clamp(box.y + (ev.clientY - start.y) / rect.height, hh, 1 - hh);
        layout = { ...layout, [key]: { ...layout[key], x, y } };
      } else {
        const dpx = ((ev.clientX - start.x) / rect.width) * W;
        const [lo, hi] = key === 'qr' ? [QR_MIN_PX, 760] : [16, 170];
        layout = { ...layout, [key]: { ...layout[key], size: clamp(box.size + dpx, lo, hi) } };
      }
      // Update the outline + canvas immediately so they track the pointer with no lag.
      bounds = measureBounds();
      scheduleRedraw();
    };
    const onUp = () => { dragKey = null; window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp); };
    window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp);
  }
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
    w.document.write(`<img src="${url}" style="width:100%" onload="window.focus();window.print()">`); w.document.close();
  }

  // ── Mission card sheets ─────────────────────────────────────────────────────
  // A4 is exactly 2×2 A6, so four cards tile one sheet with nothing left over. Everything below is
  // laid out in the poster's own 1080×1527 design space — so px·0.194 ≈ mm still holds — and the
  // canvas is scaled up by the transform on the way out.
  const CARD_SCALE = 2;                // 2× A4 out: at 1× a 12px mission line prints mushy
  const CW = W / 2, CH = H / 2;        // one A6 card in design space
  const CARD_GAP = 10;                 // gutter inside the cut line, so scissors have somewhere to go
  const CARD_PAD = 34;                 // ≈6.6mm of quiet space inside the card's edge
  // The card's QR. QR_MIN_PX (≈33mm) is the floor that keeps a code with our logo punched into its
  // centre scannable, and this clears it at ≈39mm. QR_WARN_PX (≈45mm) is deliberately NOT applied
  // here: that line sizes a code to be read across a room, and a card is held in the hand.
  const CARD_QR_PX = 200;
  const CARD_FAMILY = '"Helvetica Neue", Arial, sans-serif';
  const CARD_MONO = 'ui-monospace, Menlo, Consolas, monospace';

  $: activeSheet = sheets[sheetIdx] ?? sheets[0] ?? null;
  // Heading and tick follow the design the host already made until they say otherwise.
  $: cardHeading = cardTitle.trim() || headline.trim() || eventName || 'Our Event';
  $: cardGlyph = cleanTick(cardTick) ?? tickFor(eventType);
  // Emoji sit outside the BMP and are painted in colour by the device's own font, so they ignore
  // the card's ink — the trade-off documented in challenges.ts. Surface it rather than let someone
  // discover it at the printer.
  $: tickIsEmoji = ([...cardGlyph][0]?.codePointAt(0) ?? 0) > 0xffff;
  // Is the card dark? Mirrors what drawCard actually paints: the poster's (darkened) image when
  // there is one, otherwise the poster's plain colour — unless ink-saver forces white paper.
  $: cardDark = !cardInkSaver && (!!(bgMode !== 'plain' && bgSrc()) || lum(cBg) <= 140);
  // Swap a colour for a readable version of itself on the given background. The poster's own
  // colours are correct for the poster, not necessarily for the card: its near-black join code is
  // invisible on a dark card, its white mission line invisible on an ink-saver one.
  const readableOn = (hex: string, dark: boolean): string =>
    dark ? (lum(hex) < 110 ? '#ffffff' : hex) : (lum(hex) > 170 ? '#1a1a1a' : hex);
  $: cardInk = {
    title: readableOn(cHeadline, cardDark),
    body:  readableOn(cSteps, cardDark),
    code:  readableOn(cCode, cardDark),
    muted: cardDark ? 'rgba(255,255,255,0.72)' : '#6b6b6b',
    rule:  cardDark ? 'rgba(255,255,255,0.30)' : 'rgba(0,0,0,0.16)',
  };

  // The shot list lives on the event, not in the poster design, so the card sheet fetches it
  // itself — the organizer payload carries both the sets and the event type that picks the default
  // tick. Same raw-fetch idiom as loadPosterQr: a failure just means no cards on offer.
  async function loadMissions() {
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(joinCode)}/admin`,
        { credentials: 'same-origin', headers: orgCode ? { 'X-Organizer-Code': orgCode } : {} });
      const d = await r.json();
      eventType = typeof d?.eventType === 'string' ? d.eventType : null;
      sheets = Array.isArray(d?.challengeSets)
        ? (d.challengeSets as MissionSet[]).filter((s) => !!s?.items?.length) : [];
      sheetIdx = Math.min(sheetIdx, Math.max(0, sheets.length - 1));
    } catch { /* no cards on offer */ }
  }

  /** One card, top-left at (ox, oy). All four on a sheet are identical — they go to four people. */
  function drawCard(ctx: CanvasRenderingContext2D, ox: number, oy: number, set: MissionSet, qr: HTMLImageElement, bg: HTMLImageElement | null) {
    const x0 = ox + CARD_GAP, y0 = oy + CARD_GAP, cw = CW - CARD_GAP * 2, ch = CH - CARD_GAP * 2;
    // Background inside the card's own rounded edge. An image is covered into EACH card rather than
    // across the sheet, so the four cards look the same instead of showing four different crops.
    ctx.save();
    roundRect(ctx, x0, y0, cw, ch, 22); ctx.clip();
    if (bg) { ctx.translate(x0, y0); drawCover(ctx, bg, cw, ch); ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, cw, ch); }
    else { ctx.fillStyle = cardInkSaver ? '#ffffff' : (cBg || '#ffffff'); ctx.fillRect(x0, y0, cw, ch); }
    ctx.restore();
    roundRect(ctx, x0, y0, cw, ch, 22); ctx.strokeStyle = cardInk.rule; ctx.lineWidth = 1.5; ctx.stroke();

    const L = x0 + CARD_PAD, innerW = cw - CARD_PAD * 2;
    let y = y0 + CARD_PAD;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';

    // Which sheet this is — only when there is more than one, because that is the only time two
    // cards on a table can be confused. "Set A" on its own is noise.
    if (sheets.length > 1) {
      ctx.fillStyle = cardInk.muted;
      fitText(ctx, set.label.toUpperCase(), L, y, innerW, 700, 19, CARD_FAMILY);
      y += 28;
    }
    // Title, two lines at most: past that there is no card left for the missions.
    ctx.fillStyle = cardInk.title; ctx.font = `800 34px ${CARD_FAMILY}`;
    for (const ln of wrapToLines(ctx, cardHeading, innerW).slice(0, 2)) {
      fitText(ctx, ln, L, y, innerW, 800, 34, CARD_FAMILY); y += 41;
    }
    y += 10;
    ctx.fillStyle = cardInk.rule; ctx.fillRect(L, y, innerW, 1.5);

    // The QR block is anchored to the bottom; the mission list takes everything left and sizes
    // itself to fill it — a 5-mission card breathes, a 20-mission one packs in without spilling.
    const qrTop = y0 + ch - CARD_PAD - CARD_QR_PX;
    const top = y + 20, bottom = qrTop - 20, n = set.items.length;
    // The cap only bites on a short list: it stops five missions being squeezed into the top third
    // of the card, while leaving a generous row you can actually put a pen through.
    const rowH = clamp((bottom - top) / Math.max(n, 1), 17, 56);
    // ONE font size for every row — fitting each row on its own leaves the list visually ragged.
    // Take the largest that suits the row height AND keeps the longest mission on a single line.
    // Text width scales linearly with font size for a given string, so the widest is measured once
    // at a reference size; the tick column is 1.5em and the gap after it 0.5em, hence innerW − 2em.
    ctx.font = `400 100px ${CARD_FAMILY}`;
    const perPx = Math.max(...set.items.map((it) => ctx.measureText(it.text).width), 1) / 100;
    const fs = Math.max(11, Math.min(Math.round(rowH * 0.56), 21, Math.floor(innerW / (perPx + 2))));
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
        ctx.save(); ctx.setLineDash([4, 5]); ctx.strokeStyle = cardInk.rule; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(L, ry + rowH); ctx.lineTo(L + innerW, ry + rowH); ctx.stroke(); ctx.restore();
      }
      ry += rowH;
    }

    // Join block: QR on the left, details beside it, so the mission list keeps the card's height.
    // The white panel guarantees the code stays black-on-white whatever the card sits on, and
    // matches the poster's QR panel.
    ctx.fillStyle = '#ffffff'; roundRect(ctx, L - 9, qrTop - 9, CARD_QR_PX + 18, CARD_QR_PX + 18, 14); ctx.fill();
    ctx.imageSmoothingEnabled = false; ctx.drawImage(qr, L, qrTop, CARD_QR_PX, CARD_QR_PX); ctx.imageSmoothingEnabled = true;
    drawBrandChip(ctx, L + CARD_QR_PX / 2, qrTop + CARD_QR_PX / 2, CARD_QR_PX * 0.20);

    const tx = L + CARD_QR_PX + 24, tw = L + innerW - tx;
    let ty = qrTop + 4;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillStyle = cardInk.muted; ctx.font = `700 20px ${CARD_FAMILY}`;
    ctx.fillText('Scan to join', tx, ty); ty += 30;
    ctx.fillStyle = cardInk.code;
    if (codeDisplay === 'code') { fitText(ctx, joinCode, tx, ty, tw, 800, 34, CARD_MONO); ty += 48; }
    else if (codeDisplay === 'url') { drawUrl(ctx, cleanUrl, tx, ty, tw, 700, 21, CARD_FAMILY, 26); ty += 58; }
    // What the card is FOR. Without this a guest has a list and no idea it is tickable in the app.
    ctx.fillStyle = cardInk.muted; ctx.font = `400 18px ${CARD_FAMILY}`;
    for (const ln of wrapToLines(ctx, 'Tick them off as you pull them off.', tw)) { ctx.fillText(ln, tx, ty); ty += 23; }
  }

  /** Paint one set's 4-up sheet at CARD_SCALE. */
  async function drawSheet(ctx: CanvasRenderingContext2D, set: MissionSet) {
    ctx.setTransform(CARD_SCALE, 0, 0, CARD_SCALE, 0, 0);
    // The sheet is paper: white, always. Each card paints its own background inside its cut line,
    // so an ink-saver sheet leaves the gutters unprinted (and a JPG/PDF export never goes black
    // where the canvas would otherwise be transparent).
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
    let bg: HTMLImageElement | null = null;
    const src = cardInkSaver ? null : bgSrc();
    if (src) { try { bg = await loadImg(src); } catch { bg = null; } }
    // The sheet's own QR, so each printed card points at its own set.
    const qr = await loadImg(await qrForSet(sheets.length > 1 ? (activeSheet?.key ?? null) : null));
    for (let i = 0; i < 4; i++) drawCard(ctx, (i % 2) * CW, Math.floor(i / 2) * CH, set, qr, bg);
    // Cut guides: the four cards tile A4 exactly, so one cross through the gutters is all a pair of
    // scissors needs. Always dark — they are drawn on the white sheet, not on a card.
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)'; ctx.lineWidth = 1; ctx.setLineDash([9, 9]);
    ctx.beginPath(); ctx.moveTo(CW, 0); ctx.lineTo(CW, H); ctx.moveTo(0, CH); ctx.lineTo(W, CH); ctx.stroke();
    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

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
    ? JSON.stringify([cfg, customBgUrl, activeSheet, cardGlyph, cardInk]) : '';
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
  // A host's own tick is one character (cleanTick counts code points, so an emoji counts as one).
  // Anything else is silently refused and the field snaps back — a validation error for a typo in a
  // one-character field would be more noise than help.
  function onTickInput(e: Event) {
    const el = e.target as HTMLInputElement;
    const v = cleanTick(el.value);
    if (v) cardTick = v; else el.value = cardGlyph;
  }

  const COLOR_ROWS: { key: CTarget; label: string; get: () => string }[] = [
    { key: 'headline', label: 'Title', get: () => cHeadline },
    { key: 'message', label: 'Message', get: () => cMessage },
    { key: 'steps', label: 'How-to', get: () => cSteps },
    { key: 'code', label: 'Code / URL', get: () => cCode },
    { key: 'footer', label: 'Footer URL', get: () => cFooter },
  ];
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<svelte:window on:keydown={onKeydown} />

<div class="back" on:click|self={() => dispatch('close')} role="dialog" aria-modal="true" aria-label="Event poster">
  <div class="sheet" class:fs={fsEdit} tabindex="-1" use:modalFocus>
    <div class="head"><span>{fsEdit ? 'Arrange layout' : view === 'cards' ? 'Trick cards' : 'Event poster'}</span>
      <div class="head-actions">
        <!-- Arranging is the poster's own free layout; the card sheet is a fixed 4-up grid. -->
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
      {#if view === 'cards' && !activeSheet}<p class="empty">No trick list on this event yet.</p>{/if}
      <!-- Both previews stay mounted so switching tabs costs nothing and the poster keeps its
           measured drag bounds; the inactive one is just hidden. -->
      <div class="canvas-wrap" class:hidden={view !== 'cards' || !activeSheet || !cardsDrawn}>
        <canvas bind:this={cardCanvas}></canvas>
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
      {#if !activeSheet}
        <p class="layout-hint">This event has no trick list yet. Set one up and the printable table cards appear here.</p>
      {:else}
        <p class="layout-hint">Four identical A6 cards to an A4 sheet — print, cut along the dashed guides, one per place setting. The colours, background and join details follow the poster you designed.</p>
        <label class="fld"><span>Card title</span><input bind:value={cardTitle} maxlength="60" placeholder={headline} /></label>

        {#if sheets.length > 1}
          <div class="fld"><span>Sheet ({sheetIdx + 1} of {sheets.length})</span>
            <div class="bg-row">
              {#each sheets as s, i}
                <button class="seg" class:on={sheetIdx === i} on:click={() => (sheetIdx = i)}>{s.label}</button>
              {/each}
            </div>
            <p class="layout-hint" style="margin-top:8px">One sheet per set, each printed with its own name on every card so the tables don't get mixed up. Print the sheet you're looking at, or all {sheets.length} at once.</p>
          </div>
        {/if}

        <div class="fld"><span>Tick box</span>
          <div class="bg-row">
            {#each TICKS_OUTLINE as t}
              <button class="seg glyph" class:on={cardGlyph === t} on:click={() => (cardTick = t)} aria-label="Use {t}">{t}</button>
            {/each}
          </div>
          <div class="bg-row" style="margin-top:6px">
            {#each TICKS_EMOJI as t}
              <button class="seg glyph" class:on={cardGlyph === t} on:click={() => (cardTick = t)} aria-label="Use {t}">{t}</button>
            {/each}
          </div>
          <div class="bg-row" style="margin-top:6px">
            <!-- maxlength 2 because an emoji is two UTF-16 units; cleanTick still allows exactly one character. -->
            <label class="seg own">Your own<input maxlength="2" value={cardGlyph} on:input={onTickInput} aria-label="Your own tick character" /></label>
            {#if cardTick}<button class="seg" on:click={() => (cardTick = '')}>↺ Match event</button>{/if}
          </div>
          {#if tickIsEmoji}<p class="warn-note">⚠ Emoji ticks are printed in colour by your device's own font, so they won't match the card's ink colour — the outline ticks above will.</p>{/if}
        </div>

        <label class="chk"><input type="checkbox" bind:checked={cardInkSaver} /> Plain white cards (saves ink — four to a sheet adds up)</label>
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
        <button class="btn primary" on:click={() => printSheets(activeSheet ? [activeSheet] : [])} disabled={!cardsDrawn}>🖨 Print{sheets.length > 1 ? ' this sheet' : ''}</button>
        <button class="btn ghost" on:click={() => exportSheetsPdf(activeSheet ? [activeSheet] : [])} disabled={!cardsDrawn}>PDF</button>
        <button class="btn ghost" on:click={exportSheetPng} disabled={!cardsDrawn}>PNG</button>
        {#if sheets.length > 1}
          <button class="btn ghost" on:click={() => printSheets(sheets)} disabled={!cardsDrawn}>🖨 All {sheets.length} sheets</button>
          <button class="btn ghost" on:click={() => exportSheetsPdf(sheets)} disabled={!cardsDrawn}>PDF (all)</button>
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
  /* A tick glyph needs a square button: the glyphs differ wildly in width and would otherwise give
     a ragged row of buttons. */
  .seg.glyph { min-width: 38px; padding: 7px 6px; text-align: center; font-size: 1rem; line-height: 1.1; }
  .seg.own { display: inline-flex; align-items: center; gap: 7px; }
  .seg.own input { width: 34px; padding: 2px 4px; border: 1px solid var(--border); border-radius: 5px;
    background: var(--surface); color: var(--text); font: inherit; font-size: 0.95rem; text-align: center; }
  .layout-hint { font-size: 0.74rem; color: var(--text-muted); margin: 0 0 8px; line-height: 1.45; }
  .colors { margin-top: 14px; }
  .c-head { font-size: 0.78rem; color: var(--text-muted); margin-bottom: 6px; display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .mini-link { background: none; border: none; color: var(--accent); font-size: 0.7rem; font-weight: 700; cursor: pointer; padding: 0; }
  .c-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 4px 0; font-size: 0.82rem; }
  .c-row input[type="color"] { width: 42px; height: 28px; padding: 0; border: 1px solid var(--border); border-radius: 6px; background: none; cursor: pointer; }
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
