<script lang="ts">
  // The one thing every page shows before it has anything to show.
  //
  // Six pages each had their own bare "Loading…" — which says the page is not broken, but says it in
  // the same still, wordy way whether it has been half a second or half a minute. A mark that moves
  // is the difference between "working" and "stuck", and it is the only difference a person can see
  // without being told. One component so the answer is the same everywhere, and so the next page to
  // need it does not invent a seventh.
  //
  // The top hat, because it is our mark and it is already punched into the middle of every QR the
  // host prints — the same object turning up in both places is worth more than a generic ring.
  export let label = 'Loading…';
  /** Small enough to sit inside a card or a table, rather than filling the page. */
  export let compact = false;
</script>

<div class="wrap" class:compact role="status" aria-live="polite">
  <div class="mark" aria-hidden="true">🎩</div>
  {#if label}<p class="lbl">{label}</p>{/if}
</div>

<style>
  .wrap { display: flex; flex-direction: column; align-items: center; justify-content: center;
          gap: 10px; padding: 48px 16px; text-align: center; }
  .wrap.compact { padding: 18px 12px; gap: 6px; }
  .mark { font-size: 2rem; line-height: 1; animation: spin 1.5s linear infinite; }
  .wrap.compact .mark { font-size: 1.25rem; }
  .lbl { margin: 0; color: var(--text-muted); font-size: 0.88rem; }
  @keyframes spin { to { transform: rotate(360deg); } }
  /* Someone who gets motion sick from a spinner still needs to be told the page is working, so the
     reduced-motion version pulses rather than simply standing still. */
  @media (prefers-reduced-motion: reduce) {
    .mark { animation: fade 1.6s ease-in-out infinite; }
    @keyframes fade { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  }
</style>
