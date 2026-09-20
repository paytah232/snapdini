<script lang="ts">
  import { createEventDispatcher } from 'svelte';

  /* ONE SLOT, TWO FACES.
   *
   * The first version of this was three separate buttons: ↻ Rotate on its own, and then Save and
   * Cancel appearing beside it the moment a turn was pending. Pressing rotate therefore ADDED two
   * controls to the row, which pushed Download, Share and Reject somewhere else in the same moment
   * the host was reaching for one of them. The thing you are about to press must not move because
   * of the thing you just pressed — the same rule the armed-delete buttons on this codebase already
   * follow by keeping both labels in the box and hiding one (.steady on the review page, .cmt-x in
   * the lightbox).
   *
   * So: one slot, sized by the WIDER of its two faces, swapping what is inside it. At rest it is
   * [↺][↻ Rotate]; with a turn pending it is [↺][↻][✓][✕] in exactly the same footprint. Both faces
   * stay in the layout at all times — that IS the mechanism — and whichever is not in use is taken
   * out of the accessibility tree and the tab order as well as being hidden.
   *
   * Turn LEFT is offered AT REST and not only once something is pending, which looks like a detail
   * and is the entire point of adding it: anticlockwise used to be three presses of ↻, and a
   * left arrow that only appears after you have already gone the wrong way would still be three.
   * From rest, either direction is one press.
   *
   * Which face is showing is derived from `pending` and nothing else. No "is the control open"
   * state, anywhere: a stateless face cannot get stuck open on a photograph the host has paged
   * away from, and it keeps the invariant the route depends on — with nothing pending there is no
   * Save to press, so a full circle can never be posted.
   *
   * Shared rather than written twice: the review screen and the lightbox offer the identical
   * control over the identical feature, and two copies of a fiddly control is two chances to get it
   * wrong. Only the skin differs (a page button row against a floating pill bar over a photo), so
   * that rides along as a variant.
   */

  /** Degrees clockwise turned on screen and not yet written; 0 when nothing is pending. Owned by
   *  the parent, because the parent is the one that knows WHICH photo the turn belongs to — see
   *  the `turnFor`/`turnPhotoId` guards at both call sites. */
  export let pending = 0;
  /** A write is in flight. Every segment goes inert and Save shows a turning mark in the same box
   *  the tick occupied, so the slot cannot resize at the exact moment somebody is watching it.
   *
   *  Why a moving mark and not three dots: a photo is a sharp rotate and a re-encode of one small
   *  thumbnail, near enough instant. A CLIP is a remux of the original AND of every derived copy —
   *  the playback proxy, the shape crop, the full-resolution download — and on a long 4K clip that
   *  is hundreds of megabytes read and written several times over the network. Seconds, sometimes
   *  tens of them. A static ellipsis sitting there for half a minute reads as a hang, and a hang is
   *  when somebody presses the button again. */
  export let busy = false;
  /** Which bar this is standing in: 'row' is the review page's action row (that page's own ghost
   *  button look), 'bar' is the lightbox's floating pill bar over the photo. */
  export let variant: 'row' | 'bar' = 'row';

  /* No stopPropagation on any of these, deliberately. Both parents have a window click handler
   * whose job is to back out of something armed — a "Sure?" reject on the review page, a primed
   * comment bin in the lightbox — and pressing rotate IS a press somewhere else. */
  const dispatch = createEventDispatcher<{ turn: number; save: void; cancel: void }>();

  $: idle = pending === 0;
</script>

<div class="rot {variant}" class:pending={!idle}>
  <!-- The resting face. Both directions, because arriving at "a quarter turn anticlockwise" is
       exactly as common as arriving at "a quarter turn clockwise" — a phone held either way up
       stores the same crooked file. The clockwise one keeps the label it has always had, and the
       name it has always had, because pressing it still does the one thing it always did. -->
  <div class="rot-seg rest" role="group" aria-label="Rotate this photo"
       aria-hidden={idle ? undefined : true}>
    <button class="seg fixed" type="button" on:click={() => dispatch('turn', -90)}
            disabled={busy} tabindex={idle ? undefined : -1}
            title="Turn left" aria-label="Turn left">↺</button>
    <button class="seg wide" type="button" on:click={() => dispatch('turn', 90)}
            disabled={busy} tabindex={idle ? undefined : -1}
            title="Rotate a quarter turn clockwise"
            aria-label="Rotate this photo a quarter turn clockwise">
      <span class="rot-g" aria-hidden="true">↻</span><span>Rotate</span>
    </button>
  </div>

  <!-- The working face. Icon-only, so four segments fit the width two did — which is why each one
       carries a real aria-label rather than leaning on its glyph to be a name. -->
  <div class="rot-seg work" role="group" aria-label="Rotate this photo"
       aria-hidden={idle ? true : undefined}>
    <button class="seg" type="button" on:click={() => dispatch('turn', -90)}
            disabled={busy} tabindex={idle ? -1 : undefined}
            title="Turn left" aria-label="Turn left">↺</button>
    <button class="seg" type="button" on:click={() => dispatch('turn', 90)}
            disabled={busy} tabindex={idle ? -1 : undefined}
            title="Turn right" aria-label="Turn right">↻</button>
    <!-- The one that commits, so the one that looks like it — the accent fill both pages give
         their primary button. -->
    <button class="seg go" type="button" on:click={() => dispatch('save')}
            disabled={busy} tabindex={idle ? -1 : undefined} aria-busy={busy ? true : undefined}
            title={busy ? 'Saving this rotation…' : 'Save this rotation'}
            aria-label="Save this rotation"
            >{#if busy}<span class="spin" aria-hidden="true"></span>{:else}✓{/if}</button>
    <button class="seg" type="button" on:click={() => dispatch('cancel')}
            disabled={busy} tabindex={idle ? -1 : undefined}
            title="Discard this rotation" aria-label="Discard this rotation">✕</button>
  </div>
</div>

<style>
  /* Both faces in the SAME grid cell: the box is as wide and as tall as the wider and taller of
     them, and stays that size whichever is showing. Nothing around it can move, because from the
     outside nothing about it changed. */
  /* Sized in em and laid out inline, so it occupies the same box the tick did — the slot's width
     is fixed by the wider FACE, but a segment that changed size inside it would still shuffle its
     neighbours within the group. Drawn rather than an emoji: a glyph would be whatever the device
     has for it, at whatever optical size, which is the whole reason the icons here are drawn. */
  .spin { display: inline-block; width: 1em; height: 1em; border-radius: 50%;
    border: 2px solid currentColor; border-top-color: transparent;
    vertical-align: -0.125em; animation: rotspin 0.7s linear infinite; }
  @keyframes rotspin { to { transform: rotate(360deg); } }
  /* Slowed rather than stopped. A still spinner is indistinguishable from a frozen page, which is
     the one message this must never send — reduced motion is a request for less movement, not for
     a worse answer to "is it still going?". */
  @media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } }

  .rot { display: inline-grid; align-items: stretch; justify-items: stretch; }
  .rot > * { grid-area: 1 / 1; }
  /* Hidden, without giving its space back. `visibility` rather than `display: none` — hiding is the
     point, collapsing is the bug. A visibility-hidden control is already unfocusable and already
     out of the accessibility tree; the aria-hidden and tabindex in the markup say the same thing
     again, so a stylesheet that failed to arrive leaves an inert control rather than an invisible,
     tabbable one. */
  .rot > [aria-hidden='true'] { visibility: hidden; }

  .rot-seg { display: flex; align-items: stretch; }
  /* Equal segments on the working face, and never narrower than a fingertip can find. flex-basis 0
     so the four share the slot evenly however wide the row makes it. */
  .seg { flex: 1 1 0; min-width: 34px; display: inline-flex; align-items: center;
    justify-content: center; gap: 7px; font: inherit; line-height: 1; cursor: pointer; }
  /* At rest the word takes the room and the arrow takes what it needs: two equal halves would give
     a bare ↺ as much width as the labelled control, which reads as two buttons rather than as one
     control with a second direction on it. */
  .rest .fixed { flex: 0 0 auto; }
  .rest .wide { flex: 1 1 auto; }
  /* Joined, not spaced: one chip reads as one decision. The overlap stops the shared edges doubling
     into a 2px rule. */
  .seg + .seg { margin-left: -1px; }
  /* A gap, not a space in the markup: this is a flex container, so a whitespace-only run between
     the glyph and the word generates no flex item and collapses to nothing. */
  .rot-g { font-size: 1rem; line-height: 1; }
  .seg:disabled { opacity: 0.6; cursor: default; }

  /* ── 'row': the review page's action row ────────────────────────────────────────────────────
     Matches .btn.ghost.sm / .btn.primary.sm on that page. Written out here rather than inherited
     because Svelte scopes a component's styles to that component — the page's .btn rules cannot
     reach inside this one, and there is deliberately no global .btn (see app.css). */
  .rot.row .seg { min-height: 40px; padding: 0 6px; font-size: 1rem; font-weight: 700;
    border: 1px solid var(--border); background: transparent; color: var(--text);
    border-radius: 0; }
  .rot.row .wide { font-size: 0.82rem; padding: 0 12px; }
  .rot.row .seg:first-child { border-radius: var(--radius-sm) 0 0 var(--radius-sm); }
  .rot.row .seg:last-child { border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
  .rot.row .go { background: var(--accent-fill); color: var(--accent-ink, #111);
    border-color: transparent; }
  /* One flex item of the row, sized by the row — the same `flex: 1` the .grow buttons beside it
     take, so the slot's width comes from how many controls the row holds and not from what happens
     to be inside this one. */
  .rot.row { flex: 1 1 0; }
  /* The review page puts two buttons per line on a phone (`.srow > .btn`), and this has to be one
     of them — a fifth item that sized itself would break the two-up rhythm. The breakpoint is
     repeated from that page on purpose: a control has to fit the row it was put in. */
  @media (max-width: 560px) {
    .rot.row { flex: 1 1 calc(50% - 10px); }
  }

  /* ── 'bar': the lightbox's floating pill bar ────────────────────────────────────────────────
     Matches .lb-btn, including the 44px minimum — it is a control on a phone. */
  .rot.bar .seg { min-height: 44px; padding: 0 8px; font-size: 1rem;
    border: 1px solid rgba(255, 255, 255, 0.28); background: rgba(0, 0, 0, 0.5); color: #fff;
    border-radius: 0;
    -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
    /* .lb-bar is pointer-events:none so the picture stays clickable through the gaps in it;
       anything pressable inside has to opt back in by name, exactly as .lb-btn does. */
    pointer-events: auto; }
  .rot.bar .wide { font-size: 0.82rem; padding: 0 14px; }
  .rot.bar .seg:first-child { border-radius: 999px 0 0 999px; padding-left: 12px; }
  .rot.bar .seg:last-child { border-radius: 0 999px 999px 0; padding-right: 12px; }
  .rot.bar .go { background: var(--accent-fill); color: var(--accent-ink, #111);
    border-color: transparent; }
  .rot.bar .seg:hover:not(:disabled) { border-color: rgba(255, 255, 255, 0.5); }
  /* On a phone the lightbox bar stacks its actions into full-width rows (see .lb-acts there), and
     this stretches with them rather than sitting as a short pill on a line of its own. */
  @media (max-width: 560px) {
    .rot.bar { flex: 1 1 auto; }
  }
</style>
