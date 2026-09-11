<script lang="ts">
  // A short burst of falling confetti, for the moment a guest completes a mission.
  //
  // Canvas rather than DOM nodes: a hundred absolutely-positioned divs animating at once on a
  // mid-range phone competes with the live camera preview for the main thread, and the camera is
  // the thing that must not stutter. One canvas, one rAF loop, torn down the moment it finishes.
  //
  // Draws over everything and listens to nothing — pointer-events: none — so a guest can carry on
  // shooting through it.
  import { onDestroy } from 'svelte';

  /** Palette. Defaults are the brand-ish spread; the camera passes the event's own accent so the
   *  confetti matches the theme the host chose. */
  export let colors: string[] = ['#f2c14e', '#e8825a', '#7fb3a3', '#d8637a', '#f4e4c1'];

  type Bit = { x: number; y: number; vx: number; vy: number; size: number; rot: number; vr: number; c: string; flip: number };

  let canvas: HTMLCanvasElement | null = null;
  let raf = 0;
  let bits: Bit[] = [];
  let running = false;
  let ends = 0;

  // Honouring this is not optional: a full-screen particle burst is exactly what someone with
  // vestibular sensitivity has turned it off for. They still get the toast and the tick.
  const reduced = () =>
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  const DURATION = 1800;

  /** Fire a burst. Safe to call again mid-flight — it tops up rather than restarting, so two quick
   *  completions look like one celebration instead of a stutter. */
  export function burst(count = 90): void {
    if (reduced()) return;
    const w = window.innerWidth, h = window.innerHeight;
    for (let i = 0; i < count; i++) {
      bits.push({
        x: Math.random() * w,
        // Start above the fold at staggered heights so they arrive as a shower, not a wall.
        y: -20 - Math.random() * h * 0.5,
        vx: (Math.random() - 0.5) * 1.4,
        vy: 2.2 + Math.random() * 2.8,
        size: 6 + Math.random() * 6,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.22,
        c: colors[(Math.random() * colors.length) | 0],
        flip: 0.04 + Math.random() * 0.06,
      });
    }
    ends = Date.now() + DURATION;
    if (!running) { running = true; raf = requestAnimationFrame(tick); }
  }

  function tick() {
    if (!canvas) { stop(); return; }
    const ctx = canvas.getContext('2d');
    if (!ctx) { stop(); return; }
    const dpr = Math.min(window.devicePixelRatio || 1, 2);   // cap: 3x on a big phone is wasted fill
    const w = window.innerWidth, h = window.innerHeight;
    if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    for (const b of bits) {
      b.x += b.vx; b.y += b.vy; b.rot += b.vr;
      b.vy = Math.min(b.vy + 0.02, 7);            // gentle gravity, terminal so nothing rockets
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      // Squashing the height by a rotating factor reads as a paper rectangle tumbling edge-on,
      // which is what sells it as confetti rather than falling dots.
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.size / 2, -b.size / 4, b.size, b.size * Math.abs(Math.cos(b.rot * b.flip * 10)) * 0.5 + 1);
      ctx.restore();
    }
    bits = bits.filter((b) => b.y < h + 40);
    if (!bits.length && Date.now() > ends) { stop(); return; }
    raf = requestAnimationFrame(tick);
  }

  function stop() {
    cancelAnimationFrame(raf);
    running = false;
    bits = [];
    const ctx = canvas?.getContext('2d');
    if (ctx && canvas) ctx.clearRect(0, 0, canvas.width, canvas.height);
  }

  onDestroy(stop);
</script>

<canvas bind:this={canvas} class="confetti" class:on={running} aria-hidden="true"></canvas>

<style>
  .confetti {
    position: fixed;
    inset: 0;
    width: 100%;
    height: 100%;
    pointer-events: none;   /* a guest must be able to keep shooting straight through it */
    z-index: 9000;          /* over the camera chrome, under nothing that matters */
    opacity: 0;
  }
  .confetti.on { opacity: 1; }
</style>
