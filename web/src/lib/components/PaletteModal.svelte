<!--
  The custom-palette picker.

  WHY IT EXISTS. The Theme card offered nine palettes and a "custom" chip that appeared only while a
  custom palette happened to be in use, then vanished the moment you picked a named one. So the one
  entry that could have been an invitation was instead a read-out, and a host who wanted their own
  colours had no way in at all — the only route to custom was a poster design that carried colours
  of its own, and since every poster preset now names a built-in palette, there is no longer any
  route at all. This turns the read-out into the door.

  WHAT IT IS NOT. It is not four colour inputs. A host asked to fill in "surface-2" is being handed
  our variable names and our problem; almost nobody can pick six colours that work together, and the
  ones who can already have a hex code in mind. So the flow is: pick the ONE colour you care about,
  choose what to set it against, look at it on a real screen. The individual colours are still there
  underneath, behind a disclosure, for the host who does have that hex code.

  IT DOES NOT APPLY AS YOU GO, and that is deliberate — the rest of the Theme card does. This modal
  is drawn in the PAGE's colours, so live-applying would repaint the modal itself: choose something
  illegible and the warning telling you so would be the first thing to become unreadable. The
  preview carries the palette instead, and Cancel really cancels.
-->
<script lang="ts">
  import { createEventDispatcher, tick } from 'svelte';
  import { accentInk } from '$lib/theme';
  import { shouldDismissBackdrop } from '$lib/posterFlow';
  import {
    HARMONIES, TWEAKABLE, buildPalette, baseFromTheme, paletteFromTheme, paletteReport, toHex6,
    type CustomPalette, type HarmonyKey, type PaletteMode
  } from '$lib/palette';
  import type { EventTheme } from '$lib/events';
  import { isLightBg } from '$lib/theme';

  /** The theme as saved. Opened on an event with no custom colours, this is simply a palette the
   *  host has not changed yet — never an empty editor. */
  export let theme: EventTheme | null = null;
  /** Shown in the preview so a host sees their own event, not a placeholder. */
  export let eventName = 'Your event';

  const dispatch = createEventDispatcher<{ close: void; apply: CustomPalette }>();

  // The palette being edited. Seeded from the saved theme VERBATIM (see paletteFromTheme): opening
  // this and pressing Use changes nothing, which is what makes it safe to open out of curiosity.
  let p: CustomPalette = paletteFromTheme(theme);
  let base = baseFromTheme(theme);
  let harmony: HarmonyKey = 'mono';
  /** Dark or light, seeded from the palette this was opened ON.
   *
   *  Defaulting to 'dark' was the bug: a host who picked `blush`, liked it, and opened this to
   *  adjust it was handed a dark palette back and no way to ask for anything else — the modal
   *  overruling a choice they had already made one tap earlier. The app is still dark-first (the
   *  default for an event with no palette yet is dark, because DEFAULT_EVENT_THEME is), but which
   *  way up THIS event is, is already known, so it is what we open on. */
  let mode: PaletteMode = isLightBg(theme?.bg) ? 'light' : 'dark';
  /** Whether what is on screen CAME from the generator. A saved palette may have been hand-tuned,
   *  so no harmony is shown as chosen until the host picks one — claiming otherwise would be the
   *  card telling them something about their own event that we made up. */
  let generated = false;
  /** Set when the host presses the blocked action, so the reason appears where they are looking. */
  let shoutAt: 'text' | null = null;
  let tweakOpen = false;
  let sheetEl: HTMLDivElement | undefined;
  let checksEl: HTMLDivElement | undefined;

  $: report = paletteReport(p);
  // The moment the palette is legible again, stop shouting. A warning that has to be dismissed by
  // hand outlives the problem and then reads as a second, mysterious failure.
  $: if (!report.blocked) shoutAt = null;
  $: ink = accentInk(p.accent) ?? '#111';

  function regenerate(key: HarmonyKey = harmony) {
    const next = buildPalette(base, key, mode);
    if (!next) return;             // unparseable base: keep what is on screen rather than blanking it
    harmony = key;
    generated = true;
    p = next;
  }

  /** Flipping dark/light rebuilds immediately rather than waiting for a harmony to be picked again.
   *  The switch is only meaningful as a thing you can SEE, and the preview below is the whole point
   *  of this card — a control that changes nothing until you press something else reads as broken. */
  function setMode(m: PaletteMode) {
    if (m === mode) return;
    mode = m;
    regenerate();
  }

  function onBase(e: Event) {
    base = (e.currentTarget as HTMLInputElement).value;
    regenerate();
  }

  function setColor(key: keyof CustomPalette, value: string) {
    p = { ...p, [key]: value };
    // Hand-edited, so it is no longer the harmony's output and the chip should stop claiming it is.
    generated = false;
  }

  /** The blocked primary. `aria-disabled`, never `disabled`: a disabled button consumes no events,
   *  the tap falls through to the text behind it, and a phone answers by throwing its own
   *  Copy/Search menu over the modal. So it stays pressable and takes the host to the thing that is
   *  stopping them — open the colours, focus the text swatch, put the reason in an alert. */
  async function use() {
    if (report.blocked) {
      shoutAt = 'text';
      tweakOpen = true;
      await tick();
      checksEl?.scrollIntoView({ block: 'nearest' });
      sheetEl?.querySelector<HTMLInputElement>('#pal-c-text')?.focus();
      return;
    }
    dispatch('apply', p);
  }

  // Escape closes, and this modal has exactly one layer to peel: the disclosure below is an inline
  // section rather than something stacked over anything, so collapsing it on Escape would be a
  // keystroke that appears to do nothing. Anything opened ON TOP of this (the OS colour picker) is
  // the browser's own and takes Escape before we ever see it.
  function onKeydown(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    e.stopPropagation();
    dispatch('close');
  }

  // A dismiss needs the press AND the click on the backdrop — same rule as the poster designer, and
  // for the same reason: dragging a colour slider and releasing past the sheet's edge lands a click
  // targeted at the backdrop, and losing the whole palette to that is unforgivable.
  let downOnBack = false;
  const onBackPointerDown = (e: PointerEvent) => (downOnBack = e.target === e.currentTarget);
  function onBackClick(e: MouseEvent) {
    if (!shouldDismissBackdrop({ downOnBackdrop: downOnBack, clickOnBackdrop: e.target === e.currentTarget })) return;
    dispatch('close');
  }

  const swatches = (q: CustomPalette) => [q.bg, q.surface, q.accent];
  /** Ratios are shown to one decimal: the second one has never changed anybody's mind. */
  const ratioText = (r: number | null) => (r === null ? '—' : `${r.toFixed(1)}:1`);
</script>

<svelte:window on:keydown={onKeydown} />

<!-- Backdrop dismiss is a pointer gesture with no keyboard equivalent to add: Escape already
     closes this, which is the keyboard answer to the same question. Same suppression, same
     reason, as the poster designer. -->
<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="back" on:pointerdown={onBackPointerDown} on:click={onBackClick} role="dialog" aria-modal="true" aria-label="Custom palette">
  <div class="sheet" bind:this={sheetEl}>
    <div class="head">
      <span>Your own colours</span>
      <button class="x" on:click={() => dispatch('close')} aria-label="Close">✕</button>
    </div>

    <p class="lead">
      Pick the one colour your event is built around — the flowers, the invitations, the team strip.
      We'll build the rest around it.
    </p>

    <div class="field">
      <label class="lbl" for="pal-c-base">Your colour</label>
      <div class="baserow">
        <input class="cin big" id="pal-c-base" type="color" value={toHex6(base)} on:input={onBase} />
        <div class="basetxt">
          <code>{toHex6(base)}</code>
          <span class="hint">This becomes the accent — buttons, links and highlights.</span>
        </div>
      </div>
    </div>

    <div class="field">
      <span class="lbl">What to set it against</span>
      <p class="hint">Dark or light, then how far round the colour wheel the background sits.</p>
      <div class="modes">
        <button class="mode" class:on={mode === 'dark'} aria-pressed={mode === 'dark'} on:click={() => setMode('dark')}>
          <span class="mswatch dark"></span>Dark
        </button>
        <button class="mode" class:on={mode === 'light'} aria-pressed={mode === 'light'} on:click={() => setMode('light')}>
          <span class="mswatch light"></span>Light
        </button>
      </div>
      <div class="harms">
        {#each HARMONIES as h}
          {@const preview = buildPalette(base, h.key, mode)}
          <button class="harm" class:on={generated && harmony === h.key} on:click={() => regenerate(h.key)}>
            <span class="dots">
              {#each (preview ? swatches(preview) : []) as c}<span class="dot" style="background:{c}"></span>{/each}
            </span>
            <span class="hname">{h.label}</span>
            <span class="hblurb">{h.blurb}</span>
          </button>
        {/each}
      </div>
    </div>

    <div class="field">
      <span class="lbl">What your guests will see</span>
      <!-- Real chrome, not colour squares: the join card, its hint text, the chips, the button and
           the shot counter, in the same shapes and sizes the guest screen uses. A grid of swatches
           tells you the colours are different; this tells you whether the event looks like anything. -->
      <div class="pv" class:hasimg={!!theme?.headerImage} style="--bg:{p.bg};--surface:{p.surface};--surface-2:{p.surface2};--border:{p.border};--text:{p.text};--text-muted:{p.textMuted};--accent:{p.accent};--accent-dark:{p.accentDark};--accent-fill:{p.accent};--accent-ink:{ink}">
        <!-- The event's own image, if it has one, treated exactly as the join screen treats it:
             covering the space, under the same 50% scrim, with the card on top. Without it this
             card was previewing a screen the guest never gets — a flat colour behind the join form
             for an event whose join form sits on a photo. Colours read completely differently over
             a picture, which is the one thing this preview exists to show. -->
        {#if theme?.headerImage}<div class="pv-img" style="background-image:url('{theme.headerImage}')"></div>{/if}
        <div class="pv-card">
          <div class="pv-logo">📸</div>
          <div class="pv-h1">{eventName || 'Your event'}</div>
          <div class="pv-blurb">Ten shots each. No filters, no do-overs.</div>
          <div class="pv-chips"><span class="pv-chip">square</span><span class="pv-chip">🎬 15s clips</span></div>
          <div class="pv-lbl">Your name</div>
          <div class="pv-input">Alex</div>
          <div class="pv-btn">Join &amp; open camera</div>
          <div class="pv-hint">Add your email to get your photos afterwards.</div>
        </div>
        <div class="pv-roll">
          <span class="pv-tile"></span><span class="pv-tile"></span><span class="pv-tile"></span>
          <span class="pv-count">7<small>left</small></span>
        </div>
      </div>
    </div>

    <div class="field" bind:this={checksEl}>
      <span class="lbl">Can your guests read it?</span>
      <div class="checks">
        {#each report.checks as c}
          <div class="chk {c.level}" class:shout={shoutAt === c.key} role={c.level === 'fail' ? 'alert' : undefined}>
            <span class="chk-i" aria-hidden="true">{c.level === 'good' ? '✓' : c.level === 'warn' ? '⚠️' : '✕'}</span>
            <span class="chk-b">
              <span class="chk-h">{c.label} <span class="chk-r">{ratioText(c.ratio)}</span></span>
              <span class="chk-n">{c.note}</span>
            </span>
          </div>
        {/each}
      </div>
    </div>

    <details class="tweak" bind:open={tweakOpen}>
      <summary>Adjust the colours yourself</summary>
      <div class="tweak-body">
        {#each TWEAKABLE as t}
          <div class="trow">
            <label class="tlbl" for="pal-c-{t.key}">{t.label}</label>
            <code class="thex">{toHex6(p[t.key])}</code>
            <input class="cin" id="pal-c-{t.key}" type="color" value={toHex6(p[t.key])}
              on:input={(e) => setColor(t.key, e.currentTarget.value)} />
          </div>
        {/each}
        <p class="hint">
          The card shades and the border move with the background when you pick a colour above; change
          them here and they stay where you put them.
        </p>
      </div>
    </details>

    <div class="foot">
      <button class="btn ghost" on:click={() => dispatch('close')}>Cancel</button>
      <button class="btn primary" class:blocked={report.blocked} aria-disabled={report.blocked} on:click={use}>
        Use these colours
      </button>
    </div>
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; z-index: 80; background: rgba(0,0,0,.55); display: flex;
    align-items: flex-start; justify-content: center; padding: 20px 12px; overflow: auto;
    -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
  .sheet { width: 100%; max-width: 480px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 16px; padding: 16px; }
  .head { display: flex; justify-content: space-between; align-items: center; font-weight: 800; }
  .x { border: none; background: none; color: var(--text-muted); font-size: .95rem; cursor: pointer;
    min-width: 44px; min-height: 44px; }
  .lead { margin: 2px 0 14px; font-size: .86rem; color: var(--text-muted); line-height: 1.45; }
  .field { margin-bottom: 16px; }
  .lbl { display: block; font-size: .7rem; text-transform: uppercase; letter-spacing: .06em;
    font-weight: 800; color: var(--text-muted); margin-bottom: 6px; }
  .hint { display: block; font-size: .78rem; color: var(--text-muted); line-height: 1.45; margin: 0 0 8px; }

  /* The colour inputs. A native swatch is 44px+ tall so it is a real touch target, and the browser
     draws the picker — no script, which the CSP on these pages would not have loaded anyway. */
  .cin { -webkit-appearance: none; appearance: none; border: 1px solid var(--border);
    border-radius: var(--radius-sm); background: var(--surface-2); padding: 3px;
    width: 54px; height: 44px; cursor: pointer; flex: none; }
  .cin::-webkit-color-swatch-wrapper { padding: 0; }
  .cin::-webkit-color-swatch { border: none; border-radius: 5px; }
  .cin::-moz-color-swatch { border: none; border-radius: 5px; }
  .cin.big { width: 72px; height: 56px; }
  .baserow { display: flex; gap: 12px; align-items: center; }
  .basetxt { min-width: 0; }
  .basetxt code { display: block; font-family: var(--font-mono); font-size: .86rem; font-weight: 700; }
  .basetxt .hint { margin: 2px 0 0; }

  /* Two across at phone width, four when there is room. minmax(0,…) rather than a pixel floor:
     at 400px a 150px minimum would silently drop to one column and the row would read as a list. */
  /* The dark/light pair. Deliberately smaller than the harmony cards below it: this is one binary
     choice and those are four, and giving them the same weight made the card read as eight options. */
  .modes { display: flex; gap: 8px; margin: 0 0 10px; }
  .mode { display: flex; align-items: center; gap: 7px; padding: 7px 12px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: var(--surface-2); color: var(--text-muted);
    font: inherit; font-size: 0.82rem; cursor: pointer; }
  .mode.on { border-color: var(--accent); color: var(--text); }
  .mswatch { width: 14px; height: 14px; border-radius: 4px; border: 1px solid var(--border); }
  .mswatch.dark { background: #141414; }
  .mswatch.light { background: #f5f5f0; }
  .harms { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .harm { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; text-align: left;
    padding: 9px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface-2); color: var(--text); cursor: pointer; font: inherit; min-height: 44px; }
  .harm:hover { border-color: var(--accent); }
  /* --accent for the ring because it is a BORDER; the tinted ground is a fill, so it is mixed from
     --accent-fill — in light mode those are two different yellows on purpose. */
  .harm.on { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent);
    background: color-mix(in srgb, var(--accent-fill) 14%, var(--surface-2)); }
  .dots { display: flex; gap: 3px; margin-bottom: 2px; }
  .dot { width: 13px; height: 13px; border-radius: 50%; border: 1px solid rgba(128,128,128,.35); }
  .hname { font-size: .82rem; font-weight: 700; }
  .hblurb { font-size: .7rem; color: var(--text-muted); line-height: 1.3; }

  /* The preview. Everything inside paints from the event variables set on .pv, so this is the
     cascade the guest gets rather than a drawing of it. */
  .pv { position: relative; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden;
    background: var(--bg); padding: 14px 12px; }
  .pv-img { position: absolute; inset: 0; background-size: cover; background-position: center; }
  /* The join screen's scrim, at the same 50%. */
  .pv.hasimg::after { content: ''; position: absolute; inset: 0; background: rgba(0,0,0,0.5); }
  /* Above both layers. The card is the only thing in here that is positioned, so it is the only
     thing that needs saying. */
  .pv.hasimg .pv-card { position: relative; z-index: 1; }
  .pv-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px 13px; text-align: center; }
  .pv-logo { font-size: 1.1rem; }
  .pv-h1 { color: var(--text); font-size: 1.05rem; font-weight: 800; margin: 4px 0 3px; }
  .pv-blurb { color: var(--text); font-size: .8rem; line-height: 1.4; }
  .pv-chips { display: flex; gap: 5px; justify-content: center; margin: 8px 0 2px; }
  .pv-chip { font-size: .66rem; font-weight: 700; padding: 3px 8px; border-radius: 999px;
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text); }
  .pv-lbl { text-align: left; font-size: .7rem; color: var(--text-muted); margin: 10px 0 4px; }
  .pv-input { text-align: left; padding: 8px 10px; background: var(--surface-2);
    border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font-size: .82rem; }
  .pv-btn { margin-top: 12px; padding: 10px 14px; border-radius: var(--radius-sm);
    background: var(--accent-fill); color: var(--accent-ink); font-weight: 700; font-size: .84rem; }
  .pv-hint { text-align: left; font-size: .68rem; color: var(--text-muted); margin-top: 7px; line-height: 1.4; }
  .pv-roll { display: flex; align-items: center; gap: 6px; margin-top: 12px; }
  .pv-tile { width: 34px; height: 34px; border-radius: 6px; background: var(--surface-2); border: 1px solid var(--border); }
  .pv-count { margin-left: auto; font-family: var(--font-mono); font-size: 1.1rem; font-weight: 700;
    color: var(--accent); line-height: 1; text-align: center; }
  .pv-count small { display: block; font-size: .5rem; text-transform: uppercase; color: var(--text-muted); }

  .checks { display: flex; flex-direction: column; gap: 6px; }
  .chk { display: flex; gap: 8px; align-items: flex-start; padding: 8px 10px;
    border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
  .chk-i { flex: none; font-size: .82rem; line-height: 1.4; }
  .chk-b { min-width: 0; }
  .chk-h { display: block; font-size: .8rem; font-weight: 700; }
  .chk-r { font-family: var(--font-mono); font-weight: 600; color: var(--text-muted); }
  .chk-n { display: block; font-size: .74rem; color: var(--text-muted); line-height: 1.4; }
  .chk.good .chk-i { color: var(--success); }
  .chk.warn { border-color: color-mix(in srgb, var(--accent) 55%, var(--border)); }
  .chk.fail { border-color: var(--danger); background: color-mix(in srgb, var(--danger) 10%, var(--surface-2)); }
  .chk.fail .chk-i { color: var(--danger); }
  .chk.fail .chk-n { color: var(--text); }
  .chk.shout { box-shadow: 0 0 0 2px var(--danger); }

  .tweak { border: 1px solid var(--border); border-radius: var(--radius-sm); margin-bottom: 16px; }
  .tweak summary { cursor: pointer; padding: 11px 12px; font-size: .82rem; font-weight: 700; color: var(--text-muted); }
  .tweak-body { padding: 0 12px 12px; display: flex; flex-direction: column; gap: 8px; }
  .trow { display: flex; align-items: center; gap: 10px; }
  .tlbl { font-size: .82rem; font-weight: 600; flex: 1; min-width: 0; }
  .thex { font-family: var(--font-mono); font-size: .76rem; color: var(--text-muted); }

  .foot { display: flex; gap: 8px; justify-content: flex-end; }
  .btn { font-weight: 700; border-radius: var(--radius-sm); padding: 11px 15px; font-size: .86rem;
    border: 1px solid transparent; cursor: pointer; text-align: center; min-height: 44px; }
  .btn.primary { background: var(--accent-fill); color: var(--accent-ink, #111); }
  .btn.ghost { background: transparent; color: var(--text); border-color: var(--border); }
  /* Looks disabled, is not: see use(). */
  .btn.primary.blocked { opacity: .5; }

  @media (max-width: 380px) {
    .harms { grid-template-columns: minmax(0, 1fr); }
  }
</style>
