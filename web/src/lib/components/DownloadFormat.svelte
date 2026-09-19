<script lang="ts">
  // HOW to save, once WHAT has been settled. Deliberately not a toast: this is a fork in the road,
  // and the person has to pick a branch before anything downloads.
  //
  // Shared by the event gallery and a guest's own roll so the two cannot drift apart — they used to
  // be separate copies, and only one of them had ever been given the zip option at all.
  import { createEventDispatcher } from 'svelte';
  import { isIOS } from '$lib/saveImage';
  import { modalFocus } from '$lib/ui';

  export let count = 0;
  const dispatch = createEventDispatcher<{ pick: 'files' | 'zip'; close: void }>();
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dispatch('close'); };
</script>

<svelte:window on:keydown={onKey} />

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="chooser" on:click|self={() => dispatch('close')}
     role="dialog" aria-modal="true" aria-labelledby="chooser-title">
  <div class="chooser-card" use:modalFocus>
    <h3 id="chooser-title">Save {count} photo{count === 1 ? '' : 's'}</h3>
    <p class="chooser-sub">
      Browsers handle this differently — some save quietly, some ask about every file. Pick
      whichever works on yours.
    </p>
    <button class="chooser-opt" on:click={() => dispatch('pick', 'files')}>
      <span class="chooser-opt-t">📷 Save to this device</span>
      <span class="chooser-opt-d">
        {#if isIOS()}Goes into Photos, a batch at a time — tap Save on each{:else}Lands in your
        downloads and your gallery picks them up. {count} separate files.{/if}
      </span>
    </button>
    <button class="chooser-opt" on:click={() => dispatch('pick', 'zip')}>
      <span class="chooser-opt-t">🗜️ Download one zip</span>
      <span class="chooser-opt-d">A single file — quick, but you'll need an app to open it, and
        the photos won't land in your gallery.</span>
    </button>
    <button class="chooser-cancel" on:click={() => dispatch('close')}>Cancel</button>
  </div>
</div>

<style>
  .chooser {
    position: fixed; inset: 0; z-index: 60; display: flex; align-items: flex-end;
    justify-content: center; padding: 16px;
    background: color-mix(in srgb, #000 62%, transparent);
    backdrop-filter: blur(4px);
    /* It is a click-catching backdrop, not a control: no cursor or focus affordance. */
    cursor: default;
  }
  .chooser-card {
    width: 100%; max-width: 420px; background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 18px 16px 14px;
    display: flex; flex-direction: column; gap: 10px;
    /* Clear of the home bar on a phone, where the sheet sits against the bottom edge. */
    margin-bottom: env(safe-area-inset-bottom, 0);
    box-shadow: 0 -8px 40px rgb(0 0 0 / 0.5);
  }
  .chooser-card h3 { margin: 0; font-size: 1.05rem; }
  .chooser-sub { margin: 0 0 2px; color: var(--text-muted); font-size: 0.85rem; line-height: 1.4; }
  .chooser-opt {
    display: flex; flex-direction: column; gap: 3px; text-align: left; width: 100%;
    padding: 12px 14px; border-radius: var(--radius-sm); cursor: pointer;
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
    font: inherit;
  }
  .chooser-opt:hover { border-color: var(--accent); }
  .chooser-opt-t { font-weight: 600; font-size: 0.95rem; }
  .chooser-opt-d { color: var(--text-muted); font-size: 0.8rem; line-height: 1.35; }
  .chooser-cancel {
    background: none; border: 0; color: var(--text-muted); font: inherit; padding: 8px;
    cursor: pointer;
  }
  @media (min-width: 560px) { .chooser { align-items: center; } }
  @media (prefers-reduced-motion: no-preference) {
    .chooser-card { animation: chooser-in 0.18s ease-out; }
    @keyframes chooser-in { from { transform: translateY(12px); opacity: 0; } }
  }
</style>
