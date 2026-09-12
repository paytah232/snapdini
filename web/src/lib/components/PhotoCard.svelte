<script lang="ts">
  // ONE card for every grid of photos in the product: the guest's own roll, the event gallery, a
  // share link and the host's review screen. They had drifted into four designs — four grids, four
  // caption treatments, three of them with the words laid over the bottom of the picture, where a
  // caption of any length fights the photo and then runs off it.
  //
  // The shape is fixed here and nowhere else: image on top, then a foot carrying (optionally) the
  // shot number, the caption, the trick it was shot for, and a line of small print. Anything a
  // single surface needs on top of that — a delete bin, a select checkbox, approve/reject — comes
  // in through a slot, because moderation, selection and deletion are not this component's business.
  import { createEventDispatcher } from 'svelte';
  import { imgFallback, hidePoster } from '$lib/ui';
  import type { Photo } from '$lib/events';

  export let photo: Photo;
  /** Shot number for the foot. null (the default) leaves it off — only a guest's own roll counts. */
  export let shotNumber: number | null = null;
  /** What the foot does with the caption. 'edit' makes it a button and asks the surface to open its
   *  own editor; 'static' prints the same words; 'none' drops the caption area altogether. */
  export let captionMode: 'none' | 'static' | 'edit' = 'static';
  /** The prompt shown in 'edit' mode when nobody has written a caption yet. */
  export let addCaptionLabel = '💬 Add a caption';
  /** One line of small print under the caption — usually who shot it and when. */
  export let meta = '';
  /** Multi-select highlight. Drawn on the card, not the tile, so the whole card reads as picked. */
  export let selected = false;
  /** aria-label for the tile button. Empty = none, which is right on a guest's own roll where
   *  every tile is "your photo" and the label would just be noise. */
  export let tileLabel = '';

  const dispatch = createEventDispatcher<{ open: MouseEvent; caption: Photo }>();
</script>

<div class="pcell-wrap" class:selected>
  <!-- The tile is its own positioned box. Overlays anchor to the PHOTO, not to the whole card —
       a `bottom: 6px` badge anchored to the card would land in the middle of the caption. -->
  <div class="ptile">
    <button class="pcell" aria-label={tileLabel || undefined} on:click={(e) => dispatch('open', e)}>
      {#if photo.mediaType === 'video'}
        <!-- The aspect ratio lives on the BUTTON, never on the <img>: hidePoster hides a missing
             poster outright, and a tile sized by its own image collapses to a hairline when it
             does. Which is exactly what the share and review grids used to do. -->
        <img src={photo.thumbUrl} alt="" loading="lazy" on:error={hidePoster} />
        <span class="play" aria-hidden="true">▶</span>
      {:else}
        <img src={photo.thumbUrl ?? photo.url} alt="" loading="lazy" on:error={(e) => imgFallback(e, photo.url)} />
      {/if}
    </button>
    <!-- Overlays are SIBLINGS of the tile, never children: a <button> inside a <button> is invalid
         HTML and behaves unpredictably on touch. -->
    <slot name="tile" />
  </div>

  <!-- ── Card foot: number, caption, the trick it was for, small print ──────── -->
  <div class="pmeta">
    {#if shotNumber !== null}<span class="pno">#{shotNumber}</span>{/if}
    {#if captionMode === 'edit'}
      <!-- The whole line is the edit target rather than a pencil someone has to aim at on a phone.
           stopPropagation because several surfaces hang a "click anywhere else" handler off the
           window (disarming a two-step Reject, closing a menu) and opening the editor is not
           "somewhere else". -->
      <button class="capstrip edit" class:blank={!photo.caption} on:click|stopPropagation={() => dispatch('caption', photo)}
              title={photo.caption ? 'Edit this caption' : 'Write a caption'}
              aria-label={photo.caption ? `Edit caption: ${photo.caption}` : 'Write a caption for this photo'}>
        {#if photo.caption}
          <span class="captext">{photo.caption}</span>
        {:else}
          <span class="capadd">{addCaptionLabel}</span>
        {/if}
        {#if photo.challenge}<span class="capmission">🎩 {photo.challenge}</span>{/if}
      </button>
    {:else if captionMode === 'static'}
      <!-- Rendered even with nothing in it. The caption area is the one part of the foot that
           varies card to card, so it is what reserves the room (see its min-height below) — and it
           can only do that if every card in the grid has one. Empty, it is zero high; it costs a
           grid where nothing has words one 3px flex gap. -->
      <span class="capstrip">
        {#if photo.caption}<span class="captext">{photo.caption}</span>{/if}
        {#if photo.challenge}<span class="capmission">🎩 {photo.challenge}</span>{/if}
      </span>
    {/if}
    {#if meta}<span class="pwho">{meta}</span>{/if}
    <slot name="foot" />
  </div>
  <!-- Full-width furniture below the foot (the host's approve/reject row), outside .pmeta so it
       doesn't inherit the foot's text padding. -->
  <slot />
</div>

<style>
  /* The grid these cards live in. Global, for two reasons: a card cannot style its own parent, and
     one definition in one file is the entire point of this component. Two-up on a phone rather
     than three — a 140px tile cannot hold a sentence. `align-items: stretch` is a backstop: the
     caption reserve below is what actually levels the cards, but if anything ever does grow a card
     the rest of its row follows rather than one card sticking out. */
  :global(.pgrid) {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 10px; padding: 10px; align-items: stretch;
  }
  /* Every card the same height. The foot is what varies — a caption, a trick, both, neither — so
     it reserves the room rather than letting each card find its own size, which made the grid look
     ragged. Reserved only when something in THIS grid actually has words under it; with none there
     is nothing to line up and the space would just be empty. */
  :global(.pgrid.has-meta) .pmeta { min-height: 64px; }
  /* …and the reserve that actually does the levelling sits on the CAPTION AREA, not on the foot.
     A floor on .pmeta gets the common cases (caption only, trick only) but a card carrying BOTH
     needs a further ~15px and stood proud of its neighbours by exactly that. Two clamped caption
     lines plus one clamped trick line is the tallest the area can ever be, so reserving that makes
     every foot in the grid identical — the other lines (number, shooter, file stats) are already
     on every card. It has to be here rather than left to the grid row, because `align-items:
     stretch` only levels cards that share a ROW and the odd one out is usually on the next line
     down. Written as the same numbers the clamped lines use so the two cannot drift apart. */
  :global(.pgrid.has-meta) .capstrip { min-height: calc(.76rem * 1.35 * 2 + 2px + .64rem * 1.3); }

  .pcell-wrap {
    position: relative; display: flex; flex-direction: column; line-height: normal;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 14px; overflow: hidden;
  }
  .pcell-wrap.selected { outline: 3px solid var(--accent); outline-offset: -3px; }
  .ptile { position: relative; }
  /* ONE shape for every tile in the grid, from the event's frame setting (--tile-ar on the grid)
     rather than from each file. Per-photo shapes were faithful to the data and wrong to the
     product: a clip is recorded straight off the sensor and never cropped (only photos go through
     cropRect), so a roll shot "1:1" showed square photos beside full-frame video. */
  .pcell {
    position: relative; display: block; width: 100%; aspect-ratio: var(--tile-ar, 1);
    border: none; padding: 0; cursor: pointer; background: var(--surface-2);
  }
  .pcell img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .play { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 1.5rem; text-shadow: 0 1px 4px #000; pointer-events: none; }

  .pmeta { display: flex; flex-direction: column; gap: 3px; padding: 7px 9px 9px; min-width: 0; }
  .pno { font-size: .66rem; font-weight: 700; color: var(--text-muted); letter-spacing: .03em; }
  .capstrip { display: flex; flex-direction: column; gap: 2px; width: 100%; min-width: 0;
    padding: 0; border: none; background: none; color: var(--text); font: inherit;
    text-align: left; }
  .capstrip.edit { cursor: pointer; }
  /* Two lines, then ellipsis: a long caption must not make one card twice the height of its
     neighbours. The full text is in the lightbox and in the editor. */
  .captext { font-size: .76rem; line-height: 1.35; color: var(--text);
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; overflow-wrap: anywhere; }
  .capstrip.blank .capadd { font-size: .72rem; color: var(--text-muted); }
  /* Demoted, never dropped: beside a caption the trick is attribution, not the headline — a
     captioned trick shot that lost its mission line would lose what it was FOR. */
  .capmission { font-size: .64rem; line-height: 1.3; color: var(--text-muted);
    display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical;
    overflow: hidden; overflow-wrap: anywhere; }
  .pwho { font-size: .66rem; line-height: 1.3; color: var(--text-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
