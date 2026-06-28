<script lang="ts">
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';
  import { modalFocus } from '$lib/ui';

  export let file: File;                 // the picked image
  export let qrDataUrl = '';             // join QR (data: URL) for the live preview overlay
  export let eventName = '';
  export let overlay: 'join' | 'none' = 'join';  // 'none' = plain crop (e.g. poster background)
  export let aspectW = 3;                // crop aspect (3:4 portrait by default)
  export let aspectH = 4;

  const dispatch = createEventDispatcher<{ confirm: Blob; cancel: void }>();

  const FRAME_W = 300, FRAME_H = Math.round(300 * aspectH / aspectW);
  const OUT_W = 1080, OUT_H = Math.round(1080 * aspectH / aspectW);  // exported resolution

  let img: HTMLImageElement;
  let srcUrl = '';
  let iw = 0, ih = 0;
  let baseScale = 1, zoom = 1;
  let tx = 0, ty = 0;                     // image top-left within the frame
  let loaded = false;

  $: s = baseScale * zoom;
  $: dispW = iw * s;
  $: dispH = ih * s;

  function clamp() {
    tx = Math.min(0, Math.max(FRAME_W - dispW, tx));
    ty = Math.min(0, Math.max(FRAME_H - dispH, ty));
  }
  // Re-clamp when zoom changes.
  $: if (loaded) { void zoom; clamp(); }

  function onLoad() {
    iw = img.naturalWidth; ih = img.naturalHeight;
    baseScale = Math.max(FRAME_W / iw, FRAME_H / ih);   // cover
    zoom = 1;
    tx = (FRAME_W - iw * baseScale) / 2;
    ty = (FRAME_H - ih * baseScale) / 2;
    loaded = true;
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
    ctx.drawImage(img, tx * k, ty * k, dispW * k, dispH * k);
    canvas.toBlob((b) => { if (b) dispatch('confirm', b); }, 'image/jpeg', 0.9);
  }

  onMount(() => { srcUrl = URL.createObjectURL(file); });
  onDestroy(() => { if (srcUrl) URL.revokeObjectURL(srcUrl); });
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="back" on:click|self={() => dispatch('cancel')} role="dialog" aria-modal="true" aria-label="Position event image">
  <div class="sheet" tabindex="-1" use:modalFocus>
    <div class="head">
      <span>Position your event image</span>
      <button class="x" on:click={() => dispatch('cancel')} aria-label="Close">✕</button>
    </div>

    <p class="hint">Drag to reposition, zoom to frame it. The preview shows how guests see the join screen.</p>

    <!-- Cropper frame doubles as the live join-screen preview (QR + name overlaid). -->
    <div class="stage">
      <div
        class="frame"
        style="width:{FRAME_W}px;height:{FRAME_H}px"
        on:pointerdown={down} on:pointermove={move} on:pointerup={up} on:pointerleave={up}
      >
        <img
          bind:this={img} src={srcUrl} alt="" on:load={onLoad} draggable="false"
          style="transform:translate({tx}px,{ty}px) scale({s}); transform-origin:0 0; width:{iw}px; height:{ih}px;"
        />
        <!-- join-screen overlay (preview only; not part of the saved image) -->
        {#if overlay === 'join'}
          <div class="overlay">
            <div class="ov-name">{eventName || 'Your event'}</div>
            <div class="ov-qr">
              {#if qrDataUrl}<img class="qr" src={qrDataUrl} alt="" draggable="false" />{:else}<div class="qr ph"></div>{/if}
              <span>Scan to join</span>
            </div>
          </div>
        {/if}
      </div>
    </div>

    <div class="zoom">
      <span>➖</span>
      <input type="range" min="1" max="3" step="0.01" bind:value={zoom} aria-label="Zoom" />
      <span>➕</span>
    </div>

    <div class="actions">
      <button class="btn ghost" on:click={() => dispatch('cancel')}>Cancel</button>
      <button class="btn primary" on:click={confirm} disabled={!loaded}>Use image</button>
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
  .overlay { position: absolute; inset: 0; pointer-events: none; display: flex; flex-direction: column;
    align-items: center; justify-content: space-between; padding: 18px 14px;
    background: linear-gradient(to bottom, rgba(0,0,0,.45), rgba(0,0,0,.1) 40%, rgba(0,0,0,.55)); }
  .ov-name { color: #fff; font-weight: 800; font-size: 1.05rem; text-align: center; text-shadow: 0 2px 8px rgba(0,0,0,.6); }
  .ov-qr { display: flex; flex-direction: column; align-items: center; gap: 6px; }
  .ov-qr .qr { width: 96px; height: 96px; border-radius: 10px; background: #fff; padding: 6px; }
  .ov-qr .qr.ph { background: rgba(255,255,255,.85); }
  .ov-qr span { color: #fff; font-size: 0.78rem; font-weight: 600; text-shadow: 0 2px 6px rgba(0,0,0,.7); }
  .zoom { display: flex; align-items: center; gap: 10px; padding: 4px 22px 8px; }
  .zoom input { flex: 1; }
  .zoom span { font-size: 0.8rem; }
  .actions { display: flex; gap: 10px; padding: 12px 16px 16px; }
  .actions .btn { flex: 1; font-weight: 700; border-radius: var(--radius-sm); padding: 11px 16px;
    border: 1px solid transparent; cursor: pointer; font: inherit; }
  .btn.primary { background: var(--accent); color: var(--accent-ink, #111); }
  .btn.ghost { background: transparent; border-color: var(--border); color: var(--text); }
  .btn:disabled { opacity: .5; cursor: default; }
</style>
