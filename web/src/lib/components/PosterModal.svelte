<script lang="ts">
  import { onMount, onDestroy, createEventDispatcher } from 'svelte';
  import { modalFocus } from '$lib/ui';
  import { showToast } from '$lib/toast';
  import { savePoster, type EventTheme } from '$lib/events';
  import { DEFAULT_EVENT_THEME } from '$lib/theme';
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

  // ── Persistence (auto-save on every change) ──
  $: cfg = { headline, message, stepsText, bgMode, cBg, codeDisplay, showFooterUrl, layout, colorsLocked, cHeadline, cMessage, cSteps, cCode, cFooter };
  // Keep the default text colours readable as the background changes — until the organizer edits a
  // colour (colorsLocked). The void refs make Svelte re-run this when bgMode/cBg/theme change.
  $: if (!colorsLocked) { void bgMode; void cBg; void theme; ({ cHeadline, cMessage, cSteps, cCode, cFooter } = themeDefaults()); }
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
  async function loadPosterQr() {
    try {
      const r = await fetch(`/api/events/${encodeURIComponent(joinCode)}/qr?print=1`, { credentials: 'same-origin' });
      const d = await r.json();
      if (d?.qrCode) { qrImg = d.qrCode; scheduleRedraw(); }
    } catch { /* keep the provided QR */ }
  }
  onMount(() => { restore(); mounted = true; loadPosterQr(); draw().catch(() => { busy = false; showToast('Could not build the poster', true); }); });
  onDestroy(() => { if (customBgUrl) URL.revokeObjectURL(customBgUrl); });

  function download(blob: Blob, ext: string) {
    const href = URL.createObjectURL(blob); const a = document.createElement('a');
    a.href = href; a.download = `${slug}-poster.${ext}`; document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(href);
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

  const COLOR_ROWS: { key: CTarget; label: string; get: () => string }[] = [
    { key: 'headline', label: 'Title', get: () => cHeadline },
    { key: 'message', label: 'Message', get: () => cMessage },
    { key: 'steps', label: 'How-to', get: () => cSteps },
    { key: 'code', label: 'Code / URL', get: () => cCode },
    { key: 'footer', label: 'Footer URL', get: () => cFooter },
  ];
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="back" on:click|self={() => dispatch('close')} role="dialog" aria-modal="true" aria-label="Event poster">
  <div class="sheet" class:fs={fsEdit} tabindex="-1" use:modalFocus>
    <div class="head"><span>{fsEdit ? 'Arrange layout' : 'Event poster'}</span>
      <div class="head-actions">
        <button class="tog" on:click={() => (fsEdit = !fsEdit)} aria-label={fsEdit ? 'Exit full screen' : 'Full-screen layout'} title={fsEdit ? 'Exit full screen' : 'Full-screen layout — easier to arrange'}>{fsEdit ? '✓ Done' : '⛶ Arrange'}</button>
        {#if !fsEdit}<button class="x" on:click={() => dispatch('close')} aria-label="Close">✕</button>{/if}
      </div></div>

    <div class="poster-body" class:fs={fsEdit}>
    <div class="preview">
      {#if busy}<div class="spinner" aria-label="Building poster"></div>{/if}
      <div class="canvas-wrap" class:hidden={busy}>
        <canvas bind:this={canvas}></canvas>
        <!-- Click an element to select it → its outline + resize corner ⤡ appear. Drag anywhere on
             it to move; drag the corner to resize. Click empty space to deselect. -->
        <!-- svelte-ignore a11y-no-static-element-interactions a11y-click-events-have-key-events -->
        <div class="poster-stage" bind:this={stageEl} on:pointerdown|self={() => (selectedKey = null)}>
          {#each elements as el (el.key)}
            {#if bounds[el.key]}
              {@const b = bounds[el.key]}
              <!-- The whole footprint is the move target; outline shows on hover or when selected. -->
              <div class="el-box" class:active={dragKey === el.key} class:selected={selectedKey === el.key} class:warn={el.key === 'qr' && qrTooSmall} class:lock-x={el.axis === 'x'}
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
      <summary>✏️ Customise</summary>
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
    </details>
    </div>

    <p class="hint">Print it, drop it on the tables, or send the link out in advance — guests scan to join. Changes save automatically.</p>
    <div class="actions">
      <button class="btn primary" on:click={printPoster} disabled={busy}>🖨 Print</button>
      <button class="btn ghost" on:click={exportPdf} disabled={busy}>PDF</button>
      <button class="btn ghost" on:click={exportPng} disabled={busy}>PNG</button>
      <button class="btn ghost" on:click={exportJpg} disabled={busy}>JPG</button>
    </div>
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
    background: rgba(17,17,17,0.82); color: #fff; font-size: 0.55rem; font-weight: 700; letter-spacing: 0.02em;
    padding: 1px 6px; border-radius: 5px; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 0.12s; line-height: 1.25; }
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
