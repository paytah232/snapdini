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
  /** This device already has this one. Lives here rather than in each grid's own tile slot so the
   *  mark is identical everywhere a photo is shown — the whole reason this component exists.
   *
   *  On what it claims, and what it deliberately does not, see lib/saved.ts. Short version: the
   *  bytes reached the browser. No web API can confirm a file on disk, so the wording is "saved to
   *  this device" and never "verified". */
  export let saved = false;
  /** Show a download control on the tile. Off by default, so the review grid — where a host is
   *  approving, not collecting — is unchanged. */
  export let canDownload = false;
  /** Mid-save, so the control can say so rather than looking ignored on a slow connection. */
  export let saving = false;
  /** The shape every tile in this grid is drawn at, from tileAspect(). Needed here so a photo can
   *  tell whether the tile is going to cut it up — the card cannot see its own CSS variable. */
  export let tileAr = 1;

  const dispatch = createEventDispatcher<{ open: MouseEvent; caption: Photo; download: void }>();

  // Landscape photos in a square grid.
  //
  // `object-fit: cover` is right when a photo is roughly the tile's shape: it fills the tile and
  // trims a sliver. It is wrong when the shapes disagree sharply — a 16:9 shot in a square tile is
  // scaled to the tile's height, so a THIRD of the frame is cut off the sides, and with the phone
  // held sideways that third is usually the point of the picture.
  //
  // So past a threshold the photo is fitted whole and the gap behind it is filled with a blurred,
  // darkened copy of itself. The grid keeps its rigid shape — which is what makes it scannable —
  // and nothing is lost from the image.
  //
  // 1.35 rather than any mismatch at all: 4:3 in a square trims a little and looks better filled
  // than letterboxed. This only trips where cover would genuinely be destroying the frame.
  const MISMATCH = 1.35;
  $: ar = photo.width && photo.height ? photo.width / photo.height : null;
  $: letterbox = ar !== null && tileAr > 0 && (ar / tileAr > MISMATCH || tileAr / ar > MISMATCH);
  $: tileSrc = photo.thumbUrl ?? photo.url;
</script>

<div class="pcell-wrap" class:selected>
  <!-- The tile is its own positioned box. Overlays anchor to the PHOTO, not to the whole card —
       a `bottom: 6px` badge anchored to the card would land in the middle of the caption. -->
  <div class="ptile">
    <button class="pcell" aria-label={tileLabel || undefined} on:click={(e) => dispatch('open', e)}>
      {#if letterbox}
        <!-- A blurred copy of the same picture, filling the tile behind the fitted one. aria-hidden
             and never the fallback target: if the real image fails to load this one is decoration
             for nothing, and it shares a src so it costs no extra request. -->
        <img class="pblur" src={tileSrc} alt="" aria-hidden="true" loading="lazy" />
      {/if}
      {#if photo.mediaType === 'video'}
        <!-- The aspect ratio lives on the BUTTON, never on the <img>: hidePoster hides a missing
             poster outright, and a tile sized by its own image collapses to a hairline when it
             does. Which is exactly what the share and review grids used to do. -->
        <img class:fitted={letterbox} src={photo.thumbUrl} alt="" loading="lazy" on:error={hidePoster} />
        <span class="play" aria-hidden="true">▶</span>
      {:else}
        <img class:fitted={letterbox} src={tileSrc} alt="" loading="lazy" on:error={(e) => imgFallback(e, photo.url)} />
      {/if}
    </button>
    <!-- Overlays are SIBLINGS of the tile, never children: a <button> inside a <button> is invalid
         HTML and behaves unpredictably on touch. -->
    <slot name="tile" />
    {#if canDownload}
      <!-- Styled as the admin's QR download is: a dark rounded square with an arrow, sitting ON the
           thing it saves. The state used to live in the foot as green "⬇ saved" text — which is a
           status line, not a control, so there was nothing on a card to actually press. One control
           now carries both: press it to save, and it shows that it has been.
           Always visible rather than hover-only: half the people in a gallery are on a phone, where
           a control that only appears on hover simply does not exist. -->
      <button class="dl-corner" class:done={saved} disabled={saving}
              on:click|stopPropagation={() => dispatch('download')}
              title={saved ? 'Already saved to this device — tap to save again' : 'Save to your device'}
              aria-label={saved ? 'Saved — save again' : 'Save to your device'}>{saving ? '…' : '⬇'}</button>
    {/if}
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
    {#if saved && !canDownload}
      <!-- In the foot, not on the picture. It sat in the tile's top-right, which is also where the
           select checkbox goes — so it had to hide itself in select mode, and select mode is
           precisely when "have I already got this one?" is the question being asked. Down here
           nothing ever covers it.
           A download arrow rather than a tick: a tick is generic approval, and this says one
           specific thing — this file has been sent to your device. -->
      <span class="saved" title="Already saved to this device">⬇ saved</span>
    {/if}
    {#if photo.shotSideways}
      <!-- In the small print rather than over the picture. It is a note about how the shot was
           taken, which matters to whoever is choosing photos for a print or a slideshow, and
           matters to nobody who is just looking — so it sits where the other such notes sit. -->
      <span class="psideways" title="The phone was held sideways for this shot">↻ shot sideways</span>
    {/if}
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
    /* Two across on a phone, said outright rather than left to arithmetic. `minmax(150px, 1fr)`
       alone decided the column count by whatever width survived the ancestors' padding, and on a
       360px phone — which is most Android — the gallery's `main` takes 16px a side and this grid
       another 10px, leaving 308px. Two columns want 149px each. One pixel under the minimum, so it
       fell back to ONE card per row at 308×341px: a poster, not a grid. A layout should not hinge
       on a magic number colliding with someone else's padding. */
    display: grid; grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px; padding: 10px; align-items: stretch;
    /* Every card the same height, sized to the TALLEST CARD THAT EXISTS — not to the tallest one
       that could exist.
       This used to reserve a fixed floor: two clamped caption lines plus a trick line, on every
       card, the moment any card in the grid had words. So one short caption like "Nice" cost every
       card 34px of empty space and grew the grid from 225px to 259px, which is the blank space
       under a card with nothing to say.
       `grid-auto-rows: 1fr` in a grid whose own height is content-sized resolves every row to the
       largest row's max-content, and `align-items: stretch` then fills each card to it. So the
       cards stay uniform — the thing that made the grid look tidy — while the reserve shrinks to
       whatever is really there, and a grid with nothing under any photo reserves nothing at all.
       No JS, no measuring, and no `has-meta` class to keep in sync with the content. */
    grid-auto-rows: 1fr;
  }
  /* Past phone width, go back to fitting as many as the space allows. 560px is where three 150px
     cards plus their gaps and the page's padding genuinely fit, so the first extra column appears
     because there is room for it, not because a threshold was crossed. */
  @media (min-width: 560px) {
    :global(.pgrid) { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
  }

  /* Every card in a row is the same height, and its action row sits on the same line as its
     neighbours'.
     The caption is already clamped to two lines, but the number of small notes under a photo varies
     on its own — a mission, "shot sideways", "saved", a clip duration — so two cards side by side
     still came out different heights, and the approve/reject buttons sat at different levels. Worse,
     the row's height changed as captions were added, so the whole grid shifted under the pointer.
     height:100% makes the card fill its grid cell, and the meta block absorbs the slack so the
     furniture below it is bottom-aligned across the row. */
  .pcell-wrap {
    position: relative; display: flex; flex-direction: column; line-height: normal; height: 100%;
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
  /* Fitted whole, sitting over its own blurred fill. See `letterbox` above for when and why. */
  .pcell img.fitted { object-fit: contain; position: relative; z-index: 1; }
  .pblur {
    position: absolute; inset: 0;
    /* Scaled up because a blur samples past the edges and would otherwise leave them washed out. */
    transform: scale(1.15); filter: blur(16px) brightness(0.5);
    /* Decoration only — the fitted image above it is the one anything can interact with. */
    pointer-events: none;
  }
  .play { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 1.5rem; text-shadow: 0 1px 4px #000; pointer-events: none; }

  .pmeta { display: flex; flex-direction: column; gap: 3px; padding: 7px 9px 9px; min-width: 0; flex: 1 1 auto; }
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
  /* Green rather than the brand gold: gold is what this app uses for "chosen by the host" (the
     highlight star), and a second gold mark would read as another kind of endorsement rather than
     a note to yourself. */
  .saved { font-size: 0.68rem; font-weight: 600; color: var(--success); white-space: nowrap; }
  /* Matches .qr-dl on the admin page — same size, same corner, same dark plate — because it is the
     same idea and a host meets both. */
  .dl-corner {
    position: absolute; right: 6px; bottom: 6px;
    width: 40px; height: 40px; border-radius: 8px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.95rem; line-height: 1;
    background: rgba(0,0,0,0.78); color: #fff; border: 1px solid rgba(255,255,255,0.35);
  }
  .dl-corner:hover { background: #000; }
  .dl-corner:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .dl-corner:disabled { opacity: .7; cursor: default; }
  /* Done reads as done without becoming a tick: the arrow stays, the plate goes green. The arrow is
     what says "download"; a tick would only say "something succeeded". */
  .dl-corner.done { background: var(--success); color: #06240f; border-color: var(--success); }
  /* Muted, not coloured: this is a fact about the photo, not a problem with it. */
  .psideways { font-size: 0.68rem; color: var(--text-muted); white-space: nowrap; }
</style>
