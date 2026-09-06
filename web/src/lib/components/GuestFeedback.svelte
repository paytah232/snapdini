<script lang="ts">
  // "How was it as a guest?" — asked in the two places a guest actually finishes: the spent-roll
  // card in the camera, and the shared gallery after the event.
  //
  // One component rather than one per surface. The ask is small enough that two copies would look
  // identical on the day they were written and drift apart by the second change.
  //
  // It is deliberately skippable: "No thanks" is a real answer that the server records, so nobody
  // gets asked twice, and a rating on its own is enough — demanding a written comment loses the
  // rating too.
  import { showToast } from '$lib/toast';

  export let sessionToken: string;
  /** Bound out so a parent can drop its own wrapper once there is nothing left to show. */
  export let done = false;

  /** Bindable so a host surface (the spent-roll toast) can open the panel from its own button. */
  export let open = false;
  /** Off when the parent supplies its own trigger, so the two do not both render a button. */
  export let showCta = true;
  let rating = 0;
  let comment = '';
  let busy = false;

  async function send(dismissed = false) {
    if (!sessionToken || busy) return;
    busy = true;
    try {
      await fetch('/api/participants/feedback', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
        body: JSON.stringify(dismissed ? { sessionToken, dismissed: true }
                                       : { sessionToken, rating: rating || undefined, comment: comment || undefined }),
      });
      if (!dismissed) showToast('Thanks — that helps a lot');
      done = true;
      open = false;
    } catch { showToast('Could not send that just now', true); }
    busy = false;
  }
</script>

{#if sessionToken && !done}
  {#if open}
    <div class="fb-panel">
      <div class="fb-title">How was it?</div>
      <div class="fb-stars">
        {#each [1, 2, 3, 4, 5] as n}
          <button class="fb-star" class:on={rating >= n} on:click={() => (rating = n)}
                  aria-label={`${n} out of 5`}>★</button>
        {/each}
      </div>
      <textarea class="fb-text" rows="2" maxlength="2000" bind:value={comment}
                placeholder="Anything you'd change? (optional)"></textarea>
      <div class="fb-actions">
        <button class="fb-link" on:click={() => send(true)}>No thanks</button>
        <button class="fb-send" disabled={busy || (!rating && !comment.trim())}
                on:click={() => send()}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
    </div>
  {:else if showCta}
    <div class="fb-cta-row">
      <button class="fb-cta" on:click={() => (open = true)}>💬 Leave feedback</button>
    </div>
  {/if}
{/if}

<style>
  .fb-cta-row { display: flex; justify-content: center; }
  .fb-cta, .fb-link {
    background: none; border: none; cursor: pointer; font-size: .85rem;
    color: var(--text-muted, #a39b8c); text-decoration: underline; padding: 2px 4px;
  }
  .fb-cta:hover, .fb-link:hover { color: var(--text, #f2ece0); }
  .fb-panel { display: flex; flex-direction: column; gap: 9px; }
  .fb-title { font-size: .95rem; font-weight: 600; }
  .fb-stars { display: flex; gap: 4px; }
  .fb-star {
    background: none; border: none; cursor: pointer; font-size: 1.5rem; line-height: 1;
    color: var(--border, #3a3630); padding: 0;
  }
  .fb-star.on { color: var(--accent, #f0b429); }
  .fb-text {
    width: 100%; resize: vertical; border-radius: 9px; padding: 8px 10px; font: inherit;
    background: var(--bg, #12100b); color: var(--text, #f2ece0); border: 1px solid var(--border, #3a3630);
  }
  .fb-actions { display: flex; align-items: center; justify-content: flex-end; gap: 10px; }
  .fb-send {
    background: var(--accent, #f0b429); color: var(--accent-ink, #111); border: none; cursor: pointer;
    font-weight: 700; font-size: .85rem; padding: 7px 14px; border-radius: 9px;
  }
  .fb-send:disabled { opacity: .5; cursor: default; }
</style>
