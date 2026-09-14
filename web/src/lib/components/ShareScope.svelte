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

  const dispatch = createEventDispatcher<{ pick: 'all' | 'favourites' | 'select'; close: void }>();
  const verb = () => (action === 'share' ? 'Share' : 'Download');
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dispatch('close'); };
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="back" on:click|self={() => dispatch('close')} role="dialog" aria-modal="true" aria-label="{verb()} what?">
  <div class="card" use:modalFocus>
    <h2>{verb()} what?</h2>

    <button class="opt" on:click={() => dispatch('pick', 'all')}>
      <span class="o-i" aria-hidden="true">🖼</span>
      <span class="o-t">
        <b>The whole gallery</b>
        <small>Everything approved{contents}. Anything you rejected stays out.</small>
      </span>
    </button>

    <button class="opt" on:click={() => dispatch('pick', 'favourites')} disabled={!favouriteCount}>
      <span class="o-i" aria-hidden="true">★</span>
      <span class="o-t">
        <b>Favourites only</b>
        <!-- The link is a QUERY, not a snapshot — the server resolves shares.kind='favourites' when
             someone opens it. Worth saying out loud: a host who does not know that will assume they
             have to re-share every time they star something, and will make five links instead. -->
        <small>{favouriteCount
          ? `The ${favouriteCount} you starred. The link keeps up on its own — star or unstar later and whoever has it sees the change.`
          : 'Star some photos first and this becomes an option.'}</small>
      </span>
    </button>

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
  .opt:hover:not(:disabled) { border-color: var(--accent); }
  .opt:disabled { opacity: .5; cursor: default; }
  .o-i { font-size: 1.15rem; line-height: 1.3; flex: none; }
  .o-t { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .o-t small { color: var(--text-muted); font-size: .76rem; line-height: 1.35; }
  .cancel { width: 100%; margin-top: 4px; padding: 10px; min-height: 44px; cursor: pointer;
            background: none; border: 0; color: var(--text-muted); font: inherit; }
</style>
