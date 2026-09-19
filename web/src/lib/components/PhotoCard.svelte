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
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { imgFallback, hidePoster } from '$lib/ui';
  import DownloadIcon from '$lib/components/DownloadIcon.svelte';
  import HeartIcon from '$lib/components/HeartIcon.svelte';
  import { compactCount } from '$lib/counts';
  import StarIcon from '$lib/components/StarIcon.svelte';
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
  /** Show a download control on the card. Off by default, so the review grid — where a host is
   *  approving, not collecting — is unchanged. */
  export let canDownload = false;
  /** Hearts, when the host has them on. `hearts` absent means the feature is off for this event —
   *  absent rather than zero, so an empty heart is never drawn where hearting is not possible. */
  export let hearts: number | undefined = undefined;
  export let hearted = false;
  /** Whether the NUMBER is shown beside the heart. Off in a guest's own roll: a count there is a
   *  score on your own photographs, which is not what the roll is for — you still get to heart, you
   *  just are not being told how you are doing. The event gallery, where the count is about the
   *  room rather than about you, shows it. */
  export let showHeartCount = true;
  /** What a double tap on the picture does.
   *
   *  'heart' is the guest gesture. 'favourite' is the host's equivalent on the review grid, where
   *  the heart is the ROOM's count and read-only — a host does not get a vote in it — and ★ is the
   *  host's own mark. Same gesture, same muscle memory, the mark that belongs to whoever is
   *  looking. 'none' turns it off entirely, which also removes the single-tap delay below. */
  export let doubleTap: 'heart' | 'favourite' | 'none' = 'heart';
  /** Drawn filled when the host has marked it — the bloom and the corner star read from this. */
  export let favourite = false;
  /** Whether THIS viewer may press it. A stranger on a shared gallery link can see the counts and
   *  cannot vote: hearts belong to the people who were there. */
  export let canHeart = false;
  /** How many comments the photo carries. Absent when the host has comments off. A COUNT only —
   *  the thread itself lives in the lightbox, because a grid tile has nowhere to put one. */
  export let comments: number | undefined = undefined;
  /** Mid-save, so the control can say so rather than looking ignored on a slow connection. */
  export let saving = false;
  /** This grid is in select mode, so the WHOLE card picks the photo — the foot included.
   *
   *  The tile button was the only hit area, which is wrong twice over: the caption and the name
   *  under a photo are a third of the card's height and look exactly as pressable as the picture,
   *  and a photo being considered for a highlight is precisely one you are reading the caption of.
   *  The foot forwards the same `open` event the tile does, so a surface needs no second handler:
   *  its existing "if selecting, toggle; else open the lightbox" branch already covers it. */
  export let selectable = false;
  /** The shape every tile in this grid is drawn at, from tileAspect(). Needed here so a photo can
   *  tell whether the tile is going to cut it up — the card cannot see its own CSS variable. */
  export let tileAr = 1;

  const dispatch = createEventDispatcher<{ open: MouseEvent; caption: Photo; download: void; heart: boolean; favourite: void }>();

  // The foot's share of the card-wide hit area. Guarded rather than conditionally bound, so there
  // is one code path: a foot that is not selectable simply does nothing when pressed.
  //
  // Everything interactive that can sit in the foot already stops propagation on its own click —
  // the caption strip does, the download plate does — so a control inside this region still does
  // its own job and nothing else.
  function footPress(e: MouseEvent) {
    if (!selectable) return;
    // A `disabled` button consumes no events AT ALL, so a press on the save plate while it is
    // mid-save lands here instead — and "pick this photo" is not what that press meant. Anything
    // button- or link-shaped in the foot speaks for itself (the caption strip and the save plate
    // also stop propagation; this is the backstop, and it covers whatever a surface puts in the
    // `foot` slot later without having to remember the modifier).
    if ((e.target as Element | null)?.closest?.('button, a')) return;
    dispatch('open', e);
  }

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

  /** Double-tap to heart — the gesture every photo app has, which this one did not have at all.
   *
   *  It has to live on the tile rather than beside the heart, because the gesture IS "tap the
   *  picture twice". The single tap still opens the photo, so the two have to be told apart: a
   *  second press inside DOUBLE_MS cancels the pending open and hearts instead. A timer rather than
   *  the `dblclick` event alone, because dblclick fires AFTER the first click has already been
   *  delivered — which would open the lightbox and then heart behind it.
   *
   *  Only ever ADDS a heart. A double-tap that could also remove one turns a mistimed tap into
   *  silently undoing something, and the heart itself is right there for taking it back. */
  const DOUBLE_MS = 280;
  let openTimer: ReturnType<typeof setTimeout> | undefined;
  /** Whether the gesture is actually available here. Hearting needs somebody entitled to heart;
   *  favouriting is the caller's call and is only ever set where it means something. */
  $: dtLive = doubleTap === 'favourite' ? 'favourite'
    : doubleTap === 'heart' && canHeart && hearts !== undefined ? 'heart' : 'none';
  function onCellClick(e: MouseEvent) {
    // No gesture, no delay: a screen where double tap does nothing should open on the first tap
    // with nothing in the way.
    if (dtLive === 'none') { dispatch('open', e); return; }
    clearTimeout(openTimer);
    openTimer = setTimeout(() => dispatch('open', e), DOUBLE_MS);
  }
  function onCellDouble() {
    clearTimeout(openTimer);
    // Only ever ADDS. A mistimed second tap must not silently undo a mark; the control itself —
    // the heart, or the corner star — is right there for taking it back on purpose.
    if (dtLive === 'heart' && !hearted) { bloom = 'heart'; dispatch('heart', true); }
    else if (dtLive === 'favourite' && !favourite) { bloom = 'favourite'; dispatch('favourite'); }
    else return;
    setTimeout(() => (bloom = null), 600);
  }
  /** The bloom, and which mark it draws. Feedback is the whole reason the gesture feels like
   *  anything at all. */
  let bloom: 'heart' | 'favourite' | null = null;
  onDestroy(() => clearTimeout(openTimer));
</script>

<div class="pcell-wrap" class:selected>
  <!-- The tile is its own positioned box. Overlays anchor to the PHOTO, not to the whole card —
       a `bottom: 6px` badge anchored to the card would land in the middle of the caption. -->
  <div class="ptile">
    <!-- Every tile image is decoding="async". A grid is the one place in the product that can hold
         ninety images at once, and a synchronous decode of each blocks the main thread as it
         scrolls past — the jank people describe as "the gallery is heavy". The lightbox and the
         marketing page already asked for this; the grid, which needs it most, did not. -->
    <button class="pcell" aria-label={tileLabel || undefined} on:click={onCellClick} on:dblclick|preventDefault={onCellDouble}>
      {#if letterbox}
        <!-- A blurred copy of the same picture, filling the tile behind the fitted one. aria-hidden
             and never the fallback target: if the real image fails to load this one is decoration
             for nothing, and it shares a src so it costs no extra request. -->
        <img class="pblur" src={tileSrc} alt="" aria-hidden="true" loading="lazy" decoding="async" />
      {/if}
      {#if photo.mediaType === 'video'}
        <!-- The aspect ratio lives on the BUTTON, never on the <img>: hidePoster hides a missing
             poster outright, and a tile sized by its own image collapses to a hairline when it
             does. Which is exactly what the share and review grids used to do. -->
        <img class:fitted={letterbox} src={photo.thumbUrl} alt="" loading="lazy" decoding="async" on:error={hidePoster} />
        <span class="play" aria-hidden="true">▶</span>
      {:else}
        <img class:fitted={letterbox} src={tileSrc} alt="" loading="lazy" decoding="async" on:error={(e) => imgFallback(e, photo.url)} />
      {/if}
    </button>
    <!-- The tick lives HERE, not in each gallery's tile slot, because both galleries need exactly
         the same one and both were drawing their own — which is how the guest's roll ended up with
         a select mode that highlighted the card and never showed a checkbox. The card already knows
         `selectable` and `selected`; nothing about the tick was ever the caller's business. -->
    {#if selectable}
      <span class="check" class:on={selected} aria-hidden="true">{selected ? '✓' : ''}</span>
    {/if}
    {#if bloom}
      <span class="bloom" class:star={bloom === 'favourite'} aria-hidden="true">
        {#if bloom === 'heart'}<HeartIcon filled size={84} />{:else}<StarIcon filled size={84} />{/if}
      </span>
    {/if}
    <!-- Top-LEFT, opposite the select tick, so the two can never be mistaken for one another and
         neither has to hide while the other is on screen. stopPropagation because the tile behind
         it opens the photo, and pressing a heart is not asking to look closer. -->
    {#if hearts !== undefined}
      {#if canHeart}
        <!-- Still a <button> — it is pressed, it reports its state, it takes a keyboard — but with
             no chrome of its own. The pill it used to wear made it read as a control bolted onto
             the corner of the picture; the heart alone reads as part of it. The drop shadow is what
             keeps it legible over a pale photo now that there is no plate behind it. -->
        <button class="heart" class:on={hearted} on:click|stopPropagation={() => dispatch('heart', !hearted)}
                aria-pressed={hearted}
                aria-label={hearted ? `Remove your heart${hearts ? ` — ${hearts} so far` : ''}` : `Heart this${hearts ? ` — ${hearts} so far` : ''}`}>
          <HeartIcon filled={hearted} size={20} />
          {#if hearts && showHeartCount}<span class="hn">{compactCount(hearts)}</span>{/if}
        </button>
      {:else if hearts && showHeartCount}
        <!-- Read-only: somebody who was not at the event still gets to see what the room loved. -->
        <span class="heart flat on" aria-label={`${hearts} hearts`}><HeartIcon filled size={20} /><span class="hn">{compactCount(hearts)}</span></span>
      {/if}
    {/if}
    <!-- Overlays are SIBLINGS of the tile, never children: a <button> inside a <button> is invalid
         HTML and behaves unpredictably on touch. -->
    <slot name="tile" />
  </div>

  <!-- ── Card foot: number, caption, the trick it was for, small print, and the save plate ──────
       A row, not a column: the words go in a stack on the left and the download plate sits at the
       bottom of the right-hand edge. It used to sit ON the photo, bottom-right — over the one part
       of a card anybody is looking at, and over the bottom-right corner specifically, which on a
       portrait shot in a square tile is usually somebody's face.
       `align-items: flex-end` puts it level with the last line of small print rather than needing a
       height of its own, so no card gains a fixed reserve: with `canDownload` off this row has one
       child and behaves exactly as the old column did, and with it on every card in the grid gains
       the same 44px control, which is what keeps `grid-auto-rows: 1fr` honest. -->
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions -->
  <div class="pmeta" class:pickable={selectable} on:click={footPress}>
    <div class="pmeta-text">
      {#if shotNumber !== null}<span class="pno">#{shotNumber}</span>{/if}
      {#if captionMode === 'edit'}
        <!-- The whole line is the edit target rather than a pencil someone has to aim at on a phone.
             stopPropagation because several surfaces hang a "click anywhere else" handler off the
             window (disarming a two-step Reject, closing a menu) and opening the editor is not
             "somewhere else" — and, since the foot itself now picks the photo in select mode, nor is
             it "select this card". -->
        <button class="capstrip edit" class:blank={!photo.caption} on:click|stopPropagation={() => dispatch('caption', photo)}
                title={photo.caption ? 'Edit this caption' : 'Write a caption'}
                aria-label={photo.caption ? `Edit caption: ${photo.caption}` : 'Write a caption for this photo'}>
          {#if photo.caption}
            <span class="captext">{photo.caption}</span>
          {:else}
            <span class="capadd">{addCaptionLabel}</span>
          {/if}
          {#if photo.challenge}<span class="capmission">🃏 {photo.challenge}</span>{/if}
        </button>
      {:else if captionMode === 'static'}
        <!-- Rendered even with nothing in it. The caption area is the one part of the foot that
             varies card to card, so it is what reserves the room (see its min-height below) — and it
             can only do that if every card in the grid has one. Empty, it is zero high; it costs a
             grid where nothing has words one 3px flex gap. -->
        <span class="capstrip">
          {#if photo.caption}<span class="captext">{photo.caption}</span>{/if}
          {#if photo.challenge}<span class="capmission">🃏 {photo.challenge}</span>{/if}
        </span>
      {/if}
      {#if meta}<span class="pwho">{meta}</span>{/if}
      {#if saved && !canDownload}
        <!-- In the foot, not on the picture. It sat in the tile's top-right, which is also where the
             select checkbox goes — so it had to hide itself in select mode, and select mode is
             precisely when "have I already got this one?" is the question being asked. Down here
             nothing ever covers it.
             A download arrow rather than a tick: a tick is generic approval, and this says one
             specific thing — this file has been sent to your device. The SAME arrow the control
             draws, from DownloadIcon — but at 13px, matching the 0.68rem it sits in. This is the one
             deviation from "one icon, one size": that rule is about controls, and a 20px arrow in a
             line of small print is not consistency. -->
        <span class="saved" title="Already downloaded to this device"><DownloadIcon size={13} /> Downloaded</span>
      {/if}
      {#if comments}
        <!-- In the foot with the other small print, not on the picture: it is a fact about the
             photo, and the tile's corners are already spoken for by the heart and the select tick. -->
        <span class="ccount" title="{comments} comment{comments === 1 ? '' : 's'}">💬 {comments}</span>
      {/if}
      {#if photo.shotSideways}
        <!-- In the small print rather than over the picture. It is a note about how the shot was
             taken, which matters to whoever is choosing photos for a print or a slideshow, and
             matters to nobody who is just looking — so it sits where the other such notes sit. -->
        <span class="psideways" title="The phone was held sideways for this shot">↻ shot sideways</span>
      {/if}
      <slot name="foot" />
    </div>
    {#if canDownload}
      <!-- One control for both jobs: press it to save, and it shows that it has been. The state
           used to be green "⬇ saved" text in the foot — a status line, not a control, so there was
           nothing on a card to actually press.
           Always visible rather than hover-only: half the people in a gallery are on a phone, where
           a control that only appears on hover simply does not exist.
           stopPropagation so pressing it in select mode saves the photo instead of picking it. -->
      <button class="dl-corner" class:done={saved} disabled={saving}
              on:click|stopPropagation={() => dispatch('download')}
              title={saved ? 'Already downloaded to this device — tap to download again' : 'Download to your device'}
              aria-label={saved ? 'Downloaded — download again' : 'Download to your device'}
        >{#if saving}…{:else}<DownloadIcon />{/if}</button>
    {/if}
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
    /* `--tile-cols` / `--tile-min` are the card-size preference (lib/tileSize.ts), set by the page
       on this element. Both carry the old hard-coded values as their fallback, so a grid that sets
       neither is exactly the grid this was before the control existed. */
    display: grid; grid-template-columns: repeat(var(--tile-cols, 2), minmax(0, 1fr));
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
    :global(.pgrid) { grid-template-columns: repeat(auto-fill, minmax(var(--tile-min, 150px), 1fr)); }
  }

  /* Every card in a row is the same height, and its action row sits on the same line as its
     neighbours'.
     The caption is already clamped to two lines, but the number of small notes under a photo varies
     on its own — a mission, "shot sideways", "saved", a clip duration — so two cards side by side
     still came out different heights, and the approve/reject buttons sat at different levels. Worse,
     the row's height changed as captions were added, so the whole grid shifted under the pointer.
     height:100% makes the card fill its grid cell, and the meta block absorbs the slack so the
     furniture below it is bottom-aligned across the row. */
  /* The one red the heart is, wherever it is drawn — the corner mark and the double-tap bloom are
     the same mark and must never drift apart. A shade off the old #ff375f: that one is fully
     saturated and reads hot against a photograph, where this sits down just enough to look like
     ink rather than a light. */
  .pcell-wrap { --heart-red: #ec2f55; }
  .pcell-wrap {
    position: relative; display: flex; flex-direction: column; line-height: normal; height: 100%;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 14px; overflow: hidden;
    /* The card is a closed stacking context, so nothing inside it can paint outside it. Without
       this, `position: relative; z-index: auto` makes the card a positioned box that is NOT a
       stacking context, and any descendant with a positive z-index is sorted into the nearest real
       one — the document root. The letterboxed photo did exactly that (see .pcell img.fitted), so
       it painted after the whole card had been drawn, over the select ring, over the tile overlays
       and over anything else the card had put on top of it. `isolation: isolate` is the one-line
       way to say "z-indexes in here are relative to this card". */
    isolation: isolate;
  }
  /* The select ring, painted ABOVE the photo.
     A ring on a card with no padding has to beat its own contents, and the picture starts at the
     card's top edge, so three of the ring's four sides lie ON the image. It was an `outline` with a
     -3px offset — the right instinct (an outer box-shadow loses to children when there is no
     padding to sit in, which is why the outline was chosen over one) but it relied on outlines
     being painted after descendants, which CSS 2.1 E.2 leaves to the implementation, and it lost to
     the letterboxed photo's z-index outright.
     A pseudo-element with a positive z-index inside the isolated context above needs none of that
     goodwill: a positive-z-index descendant painting over its z-auto siblings is the least
     ambiguous rule in CSS painting, and every engine sorts it the same way.
     13px, not 14: `inset: 0` is the padding box, one 1px border inside the card's 14px corner. */
  .pcell-wrap.selected::after {
    content: ''; position: absolute; inset: 0; z-index: 4; pointer-events: none;
    border: 3px solid var(--accent); border-radius: 13px;
  }
  .ptile { position: relative; }
  /* z-index above the selected outline (4) so the tick is never painted under it. */
  .check { position: absolute; top: 6px; right: 6px; z-index: 5; width: 22px; height: 22px;
    border-radius: 50%; display: flex; align-items: center; justify-content: center;
    font-size: 0.8rem; font-weight: 800; pointer-events: none;
    background: rgba(0,0,0,.45); color: #fff; border: 2px solid #fff; }
  .check.on { background: var(--accent-fill); color: var(--accent-ink, #111); border-color: var(--accent); }
  /* Mirror of .check, on the other corner. Sized from the same 22px so a card with both reads as a
     pair rather than two unrelated badges. */
  /* Still no plate — no border, no pill, no edge for the eye to read as a button. What sits behind
     it is a soft wash that fades out before it reaches anything: enough to hold a white number
     against a bright sky, invisible against a dark one. The drop shadow alone was not enough, and
     a chip would put the control back on top of the photo instead of in it.
     The gradient is on the element's own background with generous padding, so it has no shape of
     its own to notice. */
  /* FLUSH into the corner, with no rounding and no offset of its own.
     It had both: a 2px inset and a `16px 0 60% 0` radius, which cut a rounded notch out of the
     top-left of the wash. The photo showing through that notch, lit by the wash around it, is the
     grey corner — a shape, not a colour. `.pcell-wrap` already clips the whole card at 14px, so a
     square wash pinned at 0,0 gets the card's own corner for free and has no edge to read.
     The gradient's origin moves to that same corner, so the darkest point IS the corner and every
     step outward is one even fade. */
  .heart { position: absolute; top: 0; left: 0; z-index: 5; display: flex; align-items: center; gap: 5px;
    padding: 9px 16px 13px 9px; border: 0; border-radius: 0; cursor: pointer;
    background: radial-gradient(ellipse 135% 135% at 0% 0%,
      rgba(0,0,0,0.58) 0%, rgba(0,0,0,0.34) 46%, rgba(0,0,0,0) 74%);
    color: #fff; filter: drop-shadow(0 1px 2px rgba(0,0,0,0.55)); }
  .heart.flat { cursor: default; }
  .heart.on { color: var(--heart-red); }
  .heart .hn { font-size: 0.78rem; font-weight: 800; font-variant-numeric: tabular-nums;
    text-shadow: 0 1px 3px rgba(0,0,0,0.9); }
  /* The double-tap bloom: one beat, then gone. Never interactive — the gesture is already done. */
  .bloom { position: absolute; inset: 0; z-index: 6; display: flex; align-items: center; justify-content: center;
    pointer-events: none; color: var(--heart-red); font-size: 76px; line-height: 1;
    filter: drop-shadow(0 2px 10px rgba(0,0,0,0.5)); animation: bloom 600ms ease-out forwards; }
  .bloom.star { color: var(--accent); }
  @keyframes bloom {
    0%   { opacity: 0; transform: scale(0.5); }
    30%  { opacity: 1; transform: scale(1.06); }
    55%  { opacity: 1; transform: scale(0.98); }
    100% { opacity: 0; transform: scale(1.1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .bloom { animation: none; opacity: 0; }
  }
  .ccount { font-size: .66rem; line-height: 1.3; color: var(--text-muted); font-variant-numeric: tabular-nums; }
  /* ONE shape for every tile in the grid, from the event's frame setting (--tile-ar on the grid)
     rather than from each file. Per-photo shapes were faithful to the data and wrong to the
     product: a clip is recorded straight off the sensor and never cropped (only photos go through
     cropRect), so a roll shot "1:1" showed square photos beside full-frame video. */
  .pcell {
    position: relative; display: block; width: 100%; aspect-ratio: var(--tile-ar, 1);
    border: none; padding: 0; cursor: pointer; background: var(--surface-2);
  }
  .pcell img { width: 100%; height: 100%; object-fit: cover; display: block; }
  /* Fitted whole, sitting over its own blurred fill. See `letterbox` above for when and why.
     `position: relative` with NO z-index, deliberately. Both this and .pblur are positioned, so
     both paint in the same step and TREE ORDER decides — the blur is written first in the markup,
     so the photo lands on top of it, which is all that was ever wanted. The `z-index: 1` that used
     to be here bought the same result and then escaped the card with it (see .pcell-wrap), so a
     letterboxed photo painted over the select ring, over the download plate and over the tile's own
     select tick and play triangle. Tree order costs nothing and stays inside the card. */
  .pcell img.fitted { object-fit: contain; position: relative; }
  .pblur {
    position: absolute; inset: 0;
    /* Scaled up because a blur samples past the edges and would otherwise leave them washed out. */
    transform: scale(1.15); filter: blur(16px) brightness(0.5);
    /* Decoration only — the fitted image above it is the one anything can interact with. */
    pointer-events: none;
  }
  .play { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 1.5rem; text-shadow: 0 1px 4px #000; pointer-events: none; }

  /* A ROW: the words on the left, the save plate bottom-right. flex-end rather than a height, so
     the foot is still as tall as whatever is really in it — the caption reserve collapsing to
     nothing on a grid with no captions is the whole point of `grid-auto-rows: 1fr` upstairs, and a
     row with one child lays out identically to the column this used to be. */
  .pmeta { display: flex; align-items: flex-end; gap: 8px; padding: 7px 9px 9px; min-width: 0; flex: 1 1 auto; }
  /* The old .pmeta, one level in. `align-self: stretch` so the text still starts at the top of the
     foot and the block still absorbs the card's slack; `min-width: 0` so a long caption ellipses
     instead of pushing the plate off the card. */
  .pmeta-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1 1 auto; align-self: stretch; }
  /* In select mode the foot is part of the card's hit area. Both properties are why: app.css's
     note at the top of the file — a tapped region that is also selectable text raises the phone's
     Copy/Look Up menu under a finger and flashes the UA's grey rectangle, which reads as the app
     glitching. That list matches control SHAPES (button, [role=button], .tab, .seg, .toggle); this
     is a region of a card that is only sometimes a control, so it says so locally. */
  .pmeta.pickable {
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    -webkit-user-select: none;
    user-select: none;
  }
  .pno { font-size: .66rem; font-weight: 700; color: var(--text-muted); letter-spacing: .03em; }
  .capstrip { display: flex; flex-direction: column; gap: 2px; width: 100%; min-width: 0;
    padding: 0; border: none; background: none; color: var(--text); font: inherit;
    text-align: left; }
  .capstrip.edit { cursor: pointer; }
  /* Two lines, then ellipsis: a long caption must not make one card twice the height of its
     neighbours. The full text is in the lightbox and in the editor. */
  /* Text a GUEST OR HOST wrote, so its direction is theirs and not the page's. `plaintext` is the
     CSS form of dir="auto": the browser reads the first strong character and lays the line out
     accordingly. Without it, a right-to-left name or caption is rendered in a left-to-right
     paragraph, which does not merely look wrong — it REORDERS the line, throwing trailing
     punctuation, times and counts to the wrong end. We have real accounts in Persian, so this is
     not hypothetical. Alignment is deliberately left alone: in a column of mostly-Latin names,
     flipping a few rows to the right edge is harder to read than leaving them where the eye is. */
  .captext { unicode-bidi: plaintext; font-size: .76rem; line-height: 1.35; color: var(--text);
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical;
    overflow: hidden; overflow-wrap: anywhere; }
  .capstrip.blank .capadd { font-size: .72rem; color: var(--text-muted); }
  /* Demoted, never dropped: beside a caption the trick is attribution, not the headline — a
     captioned trick shot that lost its mission line would lose what it was FOR. */
  .capmission { unicode-bidi: plaintext; font-size: .64rem; line-height: 1.3; color: var(--text-muted);
    display: -webkit-box; -webkit-line-clamp: 1; line-clamp: 1; -webkit-box-orient: vertical;
    overflow: hidden; overflow-wrap: anywhere; }
  .pwho { unicode-bidi: plaintext; font-size: .66rem; line-height: 1.3; color: var(--text-muted);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* Green rather than the brand gold: gold is what this app uses for "chosen by the host" (the
     highlight star), and a second gold mark would read as another kind of endorsement rather than
     a note to yourself. */
  .saved { font-size: 0.68rem; font-weight: 600; color: var(--success); white-space: nowrap; }
  /* The save plate, at the bottom-right of the CARD — not on the photo. In normal flow now, so it
     needs no offsets: it is the second child of a flex-end row, which is what puts it in the corner.
     44px because Camera.svelte's touch-target note applies to every control in this product and
     this one gets pressed one-handed, in the dark, at a party. That is also the whole 44px: the
     arrow inside grew from a ~15px glyph to a 20px drawn icon WITHOUT the hit area shrinking.
     Tokens, not the dark plate it used to wear: on a photo, black-on-the-image was right (and is
     still right for .qr-dl, which sits on a white QR code). On the card's own --surface-2 foot a
     black square is a hole, and in light mode a loud one. A bordered ghost is what every other
     quiet control in this app looks like, and it follows both themes for free. */
  /* 34px of BOX, 44px of TARGET. The square was 44 to meet the minimum tap size, which made it the
     tallest thing in the foot — so it set the height of the whole strip under every photo and left
     a band of dead space there. The ::after extends the hit area back out to 44 without drawing
     anything, so the control shrinks and the thumb does not. The ICON is untouched. */
  .dl-corner {
    position: relative;
    flex: none; width: 34px; height: 34px; border-radius: 9px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.95rem; line-height: 1;
    background: transparent; color: var(--text); border: 1px solid var(--border);
  }
  .dl-corner::after { content: ''; position: absolute; inset: -5px; }
  .dl-corner:hover { border-color: var(--accent); color: var(--accent); }
  .dl-corner:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .dl-corner:disabled { opacity: .7; cursor: default; }
  /* Done reads as done without becoming a tick: the arrow stays, the plate goes green. The arrow is
     what says "download"; a tick would only say "something succeeded". The icon strokes in
     currentColor, so it inherits the dark ink below without a second rule. */
  /* Tint the ARROW, not the square. Filling the whole tile green made the saved state the loudest
     thing on a card whose subject is the photo — and the icon takes `stroke="currentColor"`, so the
     colour lands on the mark itself with nothing else to change. */
  .dl-corner.done { color: var(--success); }
  /* Muted, not coloured: this is a fact about the photo, not a problem with it. */
  .psideways { font-size: 0.68rem; color: var(--text-muted); white-space: nowrap; }
</style>
