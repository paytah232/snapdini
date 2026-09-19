<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { modalFocus } from '$lib/ui';
  import { dep } from '$lib/reactive';

  /** A newly picked file, OR nothing — see `src`. */
  export let file: File | null = null;
  /** An already-uploaded image to reopen, same-origin (`/uploads/…`).
   *
   *  This is what makes "move it a bit" possible at all. The editor used to take a File and hand
   *  back a cropped canvas, and the file it was cut from was thrown away — so the only way to
   *  nudge a picture was to find the original again and start over. Now the original is kept and
   *  passed back in here. Same-origin, so the canvas stays untainted and toBlob still works. */
  export let src = '';
  export let eventName = '';
  export let overlay: 'join' | 'none' = 'join';  // 'none' = plain crop (e.g. poster background)
  export let aspectW = 3;                // crop aspect (3:4 portrait by default)
  export let aspectH = 4;
  /** Where the last cut was taken, as "sx,sy,sw,sh" in the source image's own 0–1 coordinates.
   *  Empty means "never cropped" and the frame opens centred, as it always did. */
  export let initialCrop = '';
  /** Wording for the primary button — "Use image" on a first upload, "Save position" on a reframe. */
  export let confirmLabel = 'Use image';

  const dispatch = createEventDispatcher<{ confirm: { blob: Blob; crop: string }; cancel: void }>();

  const FRAME_W = 300, FRAME_H = Math.round(300 * aspectH / aspectW);
  const OUT_W = 1080, OUT_H = Math.round(1080 * aspectH / aspectW);  // exported resolution
  /** How far the picture may be pulled BACK from filling the frame.
   *
   *  It used to be 1 — "fills the frame" was the smallest the image could be, and `clamp()` enforced
   *  it by refusing to let an edge come inside. So a host with a wide photo of a whole room could
   *  only ever choose which third of it survived; the answer "show all of it, smaller" was not on
   *  offer. It is their picture, so it is their call. Below 1 the image floats inside the frame and
   *  the gap fills with a blurred, scaled-up copy of the same picture — the treatment the join
   *  screen already uses on wide screens, so this is not a new look, just a reachable one. */
  const MIN_ZOOM = 0.3;
  /** Blur radius for that fill, in FRAME pixels — scaled up with everything else on export. */
  const FILL_BLUR = 14;

  let img: HTMLImageElement;
  let srcUrl = '';
  let iw = 0, ih = 0;
  let baseScale = 1, zoom = 1;
  let tx = 0, ty = 0;                     // image top-left within the frame
  let loaded = false;

  $: s = baseScale * zoom;
  $: dispW = iw * s;
  $: dispH = ih * s;

  /** Keep the picture somewhere sensible, in whichever direction it is bounded.
   *
   *  Bigger than the frame: an edge may not come inside it, so there is never a gap on a side the
   *  host meant to be full. Smaller: it may not leave the frame, so it can be placed anywhere
   *  inside but never dragged out of sight. The old single expression only expressed the first,
   *  and produced a min above its own max the moment the image was smaller — which is why zooming
   *  out could not work even if the slider had allowed it. */
  const within = (v: number, a: number, b: number) => Math.min(Math.max(v, Math.min(a, b)), Math.max(a, b));
  function clamp() {
    tx = within(tx, 0, FRAME_W - dispW);
    ty = within(ty, 0, FRAME_H - dispH);
  }
  /** Is any of the frame NOT covered by the picture? Then the blurred fill is doing work, and the
   *  host should be seeing it while they choose — not discovering it afterwards. */
  $: showFill = loaded && (dispW < FRAME_W - 0.5 || dispH < FRAME_H - 0.5
    || tx > 0.5 || ty > 0.5 || tx + dispW < FRAME_W - 0.5 || ty + dispH < FRAME_H - 0.5);
  /** Zoom about the CENTRE of the frame, not its top-left corner.
   *
   *  tx/ty are the image's top-left, so scaling without compensating moves whatever the host had
   *  centred off toward the corner — pull the slider back and the picture walks up and to the left
   *  instead of shrinking in place. Holding the frame's midpoint fixed is what every map and photo
   *  editor does, and it is the difference between the slider feeling like zoom and feeling like
   *  zoom-plus-a-shove. */
  let lastS = 0;
  $: if (loaded) {
    dep(zoom);
    const ns = baseScale * zoom;
    if (lastS && ns !== lastS) {
      const f = ns / lastS;
      tx = FRAME_W / 2 - (FRAME_W / 2 - tx) * f;
      ty = FRAME_H / 2 - (FRAME_H / 2 - ty) * f;
    }
    lastS = ns;
    clamp();
  }

  function onLoad() {
    iw = img.naturalWidth; ih = img.naturalHeight;
    baseScale = Math.max(FRAME_W / iw, FRAME_H / ih);   // cover
    lastS = 0;                               // seeded below, once the starting scale is known
    const restored = applyCrop(initialCrop);
    if (!restored) {
      zoom = 1;
      tx = (FRAME_W - iw * baseScale) / 2;
      ty = (FRAME_H - ih * baseScale) / 2;
    }
    lastS = baseScale * zoom;
    loaded = true;
  }

  /** Put the frame back where it was. The inverse of cropRect() below, and the two have to stay
   *  inverses — a reopen that lands anywhere but exactly where the host left it is worse than not
   *  offering the reopen, because it silently changes a picture they were happy with. */
  function applyCrop(raw: string): boolean {
    const n = raw.split(',').map(Number);
    if (n.length !== 4 || !n.every(Number.isFinite) || n[2] <= 0) return false;
    const [sx, sy, sw] = n;
    const scale = FRAME_W / (sw * iw);
    if (!Number.isFinite(scale) || scale <= 0) return false;
    zoom = scale / baseScale;
    tx = -sx * iw * scale;
    ty = -sy * ih * scale;
    clamp();
    return true;
  }

  /** The part of the SOURCE image the frame is showing, in its own 0–1 coordinates.
   *  Resolution-independent on purpose: it has to survive the image being re-encoded, and it has to
   *  mean the same thing to a 1080px export and to a 300px preview. */
  function cropRect(): string {
    const sc = baseScale * zoom;
    return [(-tx / sc) / iw, (-ty / sc) / ih, (FRAME_W / sc) / iw, (FRAME_H / sc) / ih]
      .map((v) => v.toFixed(5)).join(',');
  }

  // ── Drag to pan ──
  let dragging = false, lastX = 0, lastY = 0;
  function down(e: PointerEvent) {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function move(e: PointerEvent) {
    if (!dragging) return;
    tx += e.clientX - lastX; ty += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    clamp();
  }
  function up() { dragging = false; }

  function confirm() {
    const canvas = document.createElement('canvas');
    canvas.width = OUT_W; canvas.height = OUT_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const k = OUT_W / FRAME_W;            // frame → output scale
    // The fill goes down FIRST, and it is baked into the file rather than left to each surface.
    // headerImage is a flat JPEG read by the gallery hero, the OG card and the slideshow as well as
    // the join screen; a crop with gaps would be black in every one of them, because JPEG has no
    // transparency to fall back on. A blurred cover of the same picture is what the join screen
    // would have drawn anyway, so the file simply carries it.
    const cover = Math.max(OUT_W / iw, OUT_H / ih);
    ctx.filter = `blur(${FILL_BLUR * k}px)`;
    // Drawn oversized so the blur's soft edge falls outside the canvas instead of fading to nothing
    // at the border — the same reason the join screen's blur layer sits at inset:-24px.
    const bleed = FILL_BLUR * k * 3;
    ctx.drawImage(img, (OUT_W - iw * cover) / 2 - bleed, (OUT_H - ih * cover) / 2 - bleed,
      iw * cover + bleed * 2, ih * cover + bleed * 2);
    ctx.filter = 'none';
    ctx.drawImage(img, tx * k, ty * k, dispW * k, dispH * k);
    const crop = cropRect();
    canvas.toBlob((b) => { if (b) dispatch('confirm', { blob: b, crop }); }, 'image/jpeg', 0.9);
  }

  // A picked file gets an object URL; an already-uploaded original is used as-is. Only the object
  // URL is ours to revoke.
  let objectUrl = '';
  onMount(() => {
    if (file) { objectUrl = URL.createObjectURL(file); srcUrl = objectUrl; }
    else srcUrl = src;
  });
  onDestroy(() => { if (objectUrl) URL.revokeObjectURL(objectUrl); });
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="back" on:click|self={() => dispatch('cancel')} role="dialog" aria-modal="true" aria-label="Position event image">
  <div class="sheet" tabindex="-1" use:modalFocus>
    <div class="head">
      <span>Position your event image</span>
      <button class="x" on:click={() => dispatch('cancel')} aria-label="Close">✕</button>
    </div>

    <p class="hint">Drag to reposition, zoom to frame it — pull it right back and the gap fills with a
      blurred copy. {overlay === 'join' ? 'The card is where the join form sits, so keep faces clear of it.' : 'This is the shape your poster background is cut to.'}</p>
    <!-- Said HERE because here is where a host is thinking about framing. The poster is a different
         shape (1:√2 against this 3:4) and gets its own crop of the same picture — but that crop is
         set in the poster designer, where the layout, the type and the QR panel are all on screen.
         Framing a poster background without the poster in front of you is guessing, which is why it
         is not a second cropper bolted onto this one. -->
    {#if overlay === 'join'}
      <p class="hint sub">Your poster frames this picture separately — set that in the poster designer.</p>
    {/if}

    <!-- Cropper frame doubles as the live join-screen preview (QR + name overlaid). -->
    <div class="stage">
      <div
        class="frame"
        style="width:{FRAME_W}px;height:{FRAME_H}px"
        on:pointerdown={down} on:pointermove={move} on:pointerup={up} on:pointerleave={up}
      >
        <!-- The same fill the export bakes in, so the frame is showing the actual result rather
             than a picture floating on nothing. aria-hidden and sharing the src, so it costs no
             second request. -->
        {#if showFill}<img class="fill" src={srcUrl} alt="" aria-hidden="true" draggable="false" />{/if}
        <img
          bind:this={img} src={srcUrl} alt="" on:load={onLoad} draggable="false"
          style="transform:translate({tx}px,{ty}px) scale({s}); transform-origin:0 0; width:{iw}px; height:{ih}px;"
        />
        <!-- The join screen's own furniture, at a quarter size — preview only, never saved.
             It used to draw a QR code and "Scan to join", which is what the POSTER looks like; the
             join screen has no QR on it at all. A preview captioned "how guests see the join screen"
             has to show the thing it names, or the framing a host settles on is framing for a layout
             that does not exist. -->
        {#if overlay === 'join'}
          <div class="overlay">
            <div class="ov-card">
              <div class="ov-logo"></div>
              <div class="ov-name">{eventName || 'Your event'}</div>
              <div class="ov-pill"></div>
              <div class="ov-field"></div>
              <div class="ov-field"></div>
              <div class="ov-btn">Join &amp; open camera</div>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <div class="zoom">
      <span>➖</span>
      <input type="range" min={MIN_ZOOM} max="3" step="0.01" bind:value={zoom} aria-label="Zoom" />
      <span>➕</span>
    </div>

    <div class="actions">
      <button class="btn ghost" on:click={() => dispatch('cancel')}>Cancel</button>
      <button class="btn primary" on:click={confirm} disabled={!loaded}>{confirmLabel}</button>
    </div>
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; z-index: 300; background: rgba(0,0,0,0.8);
    display: flex; align-items: center; justify-content: center; padding: 20px; }
  .sheet { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    width: 100%; max-width: 380px; max-height: 94dvh; display: flex; flex-direction: column; overflow: auto; }
  .head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px;
    border-bottom: 1px solid var(--border); font-weight: 800; }
  .x { background: none; border: none; color: var(--text-muted); font-size: 1rem; cursor: pointer; }
  .hint { text-align: center; font-size: 0.78rem; color: var(--text-muted); padding: 12px 16px 4px; }
  .stage { display: flex; justify-content: center; padding: 12px 16px; }
  .frame { position: relative; overflow: hidden; border-radius: 14px; background: #111;
    touch-action: none; cursor: grab; box-shadow: 0 10px 30px rgba(0,0,0,.4); user-select: none; }
  .frame:active { cursor: grabbing; }
  .frame > img { position: absolute; top: 0; left: 0; max-width: none; }
  .frame > img.fill { inset: -18px; top: -18px; left: -18px; width: calc(100% + 36px); height: calc(100% + 36px);
    object-fit: cover; filter: blur(14px); transform: none; }
  /* The join screen in miniature: the same 50% scrim the real one lays over the image, and the
     same translucent card in the same place. What the host is really choosing here is what stays
     VISIBLE around that card, so the card has to be in the preview at the size it actually is. */
  .overlay { position: absolute; inset: 0; pointer-events: none; display: flex;
    align-items: center; justify-content: center; padding: 14px;
    background: rgba(0,0,0,0.5); }
  .ov-card { width: 100%; max-width: 208px; display: flex; flex-direction: column; align-items: center; gap: 6px;
    padding: 14px 12px; border-radius: 10px;
    background: rgba(20,16,10,0.62); border: 1px solid rgba(255,255,255,0.12); }
  .ov-logo { width: 22px; height: 22px; border-radius: 6px; background: rgba(255,255,255,0.75); }
  .ov-name { color: #fff; font-weight: 800; font-size: 0.95rem; text-align: center; line-height: 1.15;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ov-pill { width: 86%; height: 13px; border-radius: 7px; background: rgba(255,255,255,0.18); }
  .ov-field { width: 100%; height: 17px; border-radius: 6px; background: rgba(255,255,255,0.82); }
  .ov-btn { width: 100%; margin-top: 2px; padding: 6px 0; border-radius: 7px; text-align: center;
    background: var(--accent-fill, #f5c518); color: var(--accent-ink, #111);
    font-size: 0.66rem; font-weight: 800; }
  .hint.sub { margin-top: -6px; opacity: 0.8; }
  .zoom { display: flex; align-items: center; gap: 10px; padding: 4px 22px 8px; }
  .zoom input { flex: 1; }
  .zoom span { font-size: 0.8rem; }
  .actions { display: flex; gap: 10px; padding: 12px 16px 16px; }
  /* `font: inherit` FIRST. It is a shorthand and resets font-weight, so sitting after the 700 it
     wiped it — these two buttons rendered at normal weight while every other .btn is bold. */
  .actions .btn { flex: 1; font: inherit; font-weight: 700; border-radius: var(--radius-sm);
    padding: 11px 16px; border: 1px solid transparent; cursor: pointer; }
  .btn.primary { background: var(--accent-fill); color: var(--accent-ink, #111); }
  .btn.ghost { background: transparent; border-color: var(--border); color: var(--text); }
  .btn:disabled { opacity: .5; cursor: default; }
</style>
