<script lang="ts">
  // WHAT to share, asked once, instead of inferred from where you happened to be standing.
  //
  // The Share button used to mean whatever the current tab meant: on All it shared the gallery, on
  // Favourites it shared the favourites, and in Select mode a different button shared the selection.
  // Three behaviours, one word, and the only way to know which you were about to get was to notice
  // which tab was underlined. Now the question is the question.
  //
  // The same three scopes the SERVER already understands — shares.kind is 'all' | 'favourites' |
  // 'selected' — so this asks for exactly what can be created, no more and no less.
  import { modalFocus } from '$lib/ui';
  import { showToast } from '$lib/toast';
  import { createEventDispatcher } from 'svelte';

  /** What the verb is. The scopes are identical for sharing and downloading; only the wording and
   *  the thing that happens at the end differ, so one component does both. */
  export let action: 'share' | 'download' = 'share';
  export let approvedCount = 0;
  export let favouriteCount = 0;
  /** How many of `approvedCount` are clips. "92 photos" for 71 photos and 21 videos is a number the
   *  host will later find disagrees with the slideshow's, and neither will look wrong on its own. */
  export let videoCount = 0;
  $: photoCount = Math.max(0, approvedCount - videoCount);
  $: contents =
    !approvedCount ? ''
    : !videoCount ? ` — ${approvedCount} photo${approvedCount === 1 ? '' : 's'}`
    : ` — ${photoCount} photo${photoCount === 1 ? '' : 's'} and ${videoCount} clip${videoCount === 1 ? '' : 's'}`;
  /** Hidden when there is nothing to hand-pick from — a chooser offering an empty option is a
   *  chooser that has to apologise. */
  export let canSelect = true;
  /** Whose photos these are. The scopes are the same either way; only the nouns change, and calling
   *  a guest's own dozen shots "the whole gallery" reads as the wrong photos entirely. */
  export let subject: 'gallery' | 'roll' = 'gallery';
  /** Favourites are the HOST's stars, so a guest looking at their own roll has no such axis. */
  export let canFavourite = true;
  /** GUEST favourites — how many have at least one ♥ — and how many the two sets come to together,
   *  counted once. Two separate counts because the union is not the sum: a photo the host starred
   *  and guests hearted is one photo, and a sheet that offered "12 + 9 = 21" for 15 files would be
   *  wrong on screen before the download even started. Both default to 0, which is also what the
   *  caller passes when hearts are switched off for the event — there is then no such axis, and no
   *  row, without this component having to know what a feature flag is. */
  export let heartedCount = 0;
  export let bothCount = 0;
  /** How many have never been saved on THIS DEVICE (see lib/saved.ts). Downloading a gallery you
   *  have mostly already got means re-fetching, re-prompting and re-deduplicating dozens of photos
   *  to reach the few new ones — so when some are new and some are not, that is worth its own row.
   *  Zero hides it, which covers both "all new" and "nothing new": in neither case is it a choice. */
  export let newCount = 0;
  $: offerNew = action === 'download' && newCount > 0 && newCount < approvedCount;

  /** WHO is reading. The host and a guest see the same photos through different words: approving,
   *  rejecting and starring are the host's private workflow, and a guest being told that "anything
   *  you rejected stays out" is being shown a control panel they do not have. What the host calls
   *  their favourites, a guest knows as the event's highlights. */
  export let voice: 'host' | 'guest' = 'host';

  $: favTitle = voice === 'guest' ? 'Highlights only' : 'Favourites only';
  $: favText =
    voice === 'guest'
      ? (favouriteCount
          ? `The ${favouriteCount} the host picked out as the highlights.`
          : 'The host has not picked any highlights yet.')
      : favouriteCount
        // The "keeps up on its own" line is about a LINK the recipient opens later. A download is a
        // file, taken once, and cannot keep up with anything — so it is not said here.
        ? (action === 'share'
            ? `The ${favouriteCount} you starred. The link keeps up on its own — star or unstar later and whoever has it sees the change.`
            : `The ${favouriteCount} you starred.`)
        : 'Star some photos first and this becomes an option.';

  /** Hearts are a DOWNLOAD-only axis. A share is a link the server re-resolves every time it is
   *  opened, and shares.kind is 'all' | 'favourites' | 'selected' — there is no query for "the
   *  hearted ones", so offering it under Share would promise a link that cannot exist. */
  $: heartsAxis = action === 'download' && heartedCount > 0;
  /** Hidden when every photo is hearted, because then this row and "the whole gallery" hand back
   *  the same files; and hidden when the union is the size of BOTH inputs, which is proof the two
   *  sets contain each other and the host's row above already says it. An option whose answer is
   *  another visible option's answer is a tap that teaches nothing — but note it is these ROWS that
   *  come and go, never the sheet: "pick them myself" is always a different answer. */
  $: offerHearts = heartsAxis && heartedCount < approvedCount
    && !(canFavourite && bothCount === heartedCount && bothCount === favouriteCount);
  /** Only when the union is genuinely bigger than each half — otherwise one of the two rows above
   *  already IS the union — and smaller than the gallery, or "the whole gallery" already is. */
  $: offerBoth = heartsAxis && canFavourite
    && bothCount > heartedCount && bothCount > favouriteCount && bothCount < approvedCount;

  // The host stars and the guests heart: two different people's favourites, so they get two
  // different nouns. To a guest the host's stars are the event's highlights (see favTitle), which
  // leaves "hearts" free to mean only the thing a guest themselves pressed.
  $: heartsTitle = voice === 'guest' ? 'What everyone loved' : 'What your guests loved';
  $: bothTitle = voice === 'guest' ? 'Highlights and hearts' : 'Stars and hearts';
  $: bothText =
    voice === 'guest'
      ? `The host's ${favouriteCount} highlights and the ${heartedCount} with a ♥ — ${bothCount} in all.`
      : `The ${favouriteCount} you starred and the ${heartedCount} your guests hearted — ${bothCount} in all, counted once.`;

  /** Two events for one question, and the reason is the type rather than the UI. `pick`'s detail is
   *  a string union that three callers narrow: Camera.svelte and the review screen both hand
   *  `e.detail` straight to a handler declared for the original four scopes, so widening `pick`
   *  turns both into compile errors over rows neither of them can ever show (neither passes a heart
   *  count). The hearts scopes therefore ride an event those two simply do not listen for. */
  const dispatch = createEventDispatcher<{
    pick: 'all' | 'favourites' | 'select' | 'new';
    pickHearts: 'hearts' | 'both';
    close: void;
  }>();
  const verb = () => (action === 'share' ? 'Share' : 'Download');

  /** Favourites, pressed with nothing starred.
   *
   *  The row already carries its own instruction — "Star some photos first and this becomes an
   *  option" — and `disabled` made the row holding that sentence unselectable and its press a dead
   *  tap that falls through to the backdrop. A control that states a condition and then does
   *  nothing when you read it is the exact case docs/DEVELOPMENT.md names.
   *
   *  So it is aria-disabled and it answers. There is nothing in this modal to move focus TO — the
   *  thing blocking them is in the gallery behind it — so the answer is to say where to go. */
  function pickFavourites() {
    if (!favouriteCount) {
      showToast(voice === 'guest'
        ? 'No highlights yet — the host picks those out.'
        : `Nothing starred yet — star a photo with ★, then ${verb().toLowerCase()} the favourites.`);
      return;
    }
    dispatch('pick', 'favourites');
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dispatch('close'); };
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="back" on:click|self={() => dispatch('close')} role="dialog" aria-modal="true" aria-label="{verb()} what?">
  <div class="card" use:modalFocus>
    <h2>{verb()} what?</h2>

    <button class="opt" on:click={() => dispatch('pick', 'all')}>
      <span class="o-i" aria-hidden="true">🖼️</span>
      <span class="o-t">
        {#if subject === 'roll'}
          <b>All of my shots</b>
          <small>Everything you have taken{contents}.</small>
        {:else if voice === 'guest'}
          <b>The whole gallery</b>
          <small>Every photo in it{contents}.</small>
        {:else}
          <b>The whole gallery</b>
          <small>Everything approved{contents}. Anything you rejected stays out.</small>
        {/if}
      </span>
    </button>

    <!-- "Saved on this device" is the honest phrasing and the literal truth: the record is in this
         browser's storage, so a guest on their laptop is correctly told nothing is saved yet. -->
    {#if offerNew}
      <button class="opt" on:click={() => dispatch('pick', 'new')}>
        <span class="o-i" aria-hidden="true">✨</span>
        <span class="o-t">
          <b>Only the ones I don't have</b>
          <small>The {newCount} you have not saved on this device yet. The other {approvedCount - newCount} you already have.</small>
        </span>
      </button>
    {/if}

    <!-- aria-disabled, not disabled — see pickFavourites(). -->
    {#if canFavourite}
    <button class="opt" on:click={pickFavourites} aria-disabled={!favouriteCount || undefined}>
      <span class="o-i" aria-hidden="true">★</span>
      <span class="o-t">
        <b>{favTitle}</b>
        <!-- For a SHARE the link is a QUERY, not a snapshot — the server resolves
             shares.kind='favourites' when someone opens it. Worth saying out loud: a host who does
             not know that will assume they have to re-share every time they star something, and
             will make five links instead. See favText. -->
        <small>{favText}</small>
      </span>
    </button>
    {/if}

    <!-- Guest favourites. Hidden rather than aria-disabled when nothing is hearted, which is the
         opposite of the row above and deliberately so: "star some photos first" is an instruction
         the host can act on, while neither a host nor a guest can make other people's hearts
         appear from inside this sheet. -->
    {#if offerHearts}
      <button class="opt" on:click={() => dispatch('pickHearts', 'hearts')}>
        <span class="o-i" aria-hidden="true">❤️</span>
        <span class="o-t">
          <b>{heartsTitle}</b>
          <!-- Order is a promise this sheet can only keep for single files — a zip is named and
               ordered by the server. Said plainly so it is not read as a guarantee about the zip. -->
          <small>The {heartedCount} with at least one ♥, most-hearted first.</small>
        </span>
      </button>
    {/if}

    {#if offerBoth}
      <button class="opt" on:click={() => dispatch('pickHearts', 'both')}>
        <span class="o-i" aria-hidden="true">★❤️</span>
        <span class="o-t">
          <b>{bothTitle}</b>
          <small>{bothText}</small>
        </span>
      </button>
    {/if}

    {#if canSelect}
      <button class="opt" on:click={() => dispatch('pick', 'select')}>
        <span class="o-i" aria-hidden="true">☑</span>
        <span class="o-t">
          <b>Pick them myself</b>
          <small>Choose photos one by one, then {action} just those.</small>
        </span>
      </button>
    {/if}

    <button class="cancel" on:click={() => dispatch('close')}>Cancel</button>
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; z-index: 130; display: flex; align-items: center; justify-content: center;
          background: rgba(0,0,0,0.62); padding: 16px; }
  .card { width: min(420px, 100%); max-height: 90vh; overflow: auto; padding: 16px;
          background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
  h2 { margin: 0 0 12px; font-size: 1.05rem; }
  /* Each option is a row you press, not a radio you then have to confirm — there is no second step
     for the first two, so a confirm button would be a click that does nothing. */
  .opt {
    display: flex; align-items: flex-start; gap: 10px; width: 100%; margin-bottom: 8px;
    padding: 11px 12px; text-align: left; cursor: pointer; font: inherit; color: var(--text);
    background: var(--surface-2); border: 1px solid var(--border); border-radius: 12px;
    min-height: 44px;
  }
  .opt:hover:not([aria-disabled='true']) { border-color: var(--accent); }
  /* `[aria-disabled]`, not `:disabled` — the row still takes its press and answers it. */
  .opt[aria-disabled='true'] { opacity: .5; cursor: default; }
  .o-i { font-size: 1.15rem; line-height: 1.3; flex: none; }
  .o-t { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .o-t small { color: var(--text-muted); font-size: .76rem; line-height: 1.35; }
  .cancel { width: 100%; margin-top: 4px; padding: 10px; min-height: 44px; cursor: pointer;
            background: none; border: 0; color: var(--text-muted); font: inherit; }
</style>
