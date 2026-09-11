<script lang="ts">
  // The card a host prints for the tables, standing in for itself on the marketing pages.
  //
  // The list is pulled from the pack for the event type rather than written here, so the wedding
  // page shows wedding missions and the baby-shower page shows baby-shower ones. That is the
  // point: the landing pages are meant to differ from each other, and a single shared example
  // list would be the thin duplicate content usecases.ts exists to avoid.
  import { packFor, tickFor } from '$lib/challenges';

  /** A pack key from challenges.ts: 'wedding', 'baby-shower', 'christmas', … */
  export let eventType: string;

  // Six fills the card without turning it into a wall. No picking or shuffling: the pack's
  // curated order is already best-first — it IS the list a host is offered by default — so the
  // top of it is the honest thing to put on a marketing page.
  const SHOWN = 6;

  $: pack = packFor(eventType);
  $: items = pack.challenges.slice(0, SHOWN);
  $: tick = tickFor(eventType);
</script>

<div class="mission-card">
  <div class="head">{pack.label} · table card</div>
  <ul>
    {#each items as c (c.id)}
      <li><span class="tick" aria-hidden="true">{tick}</span>{c.text}</li>
    {/each}
  </ul>
</div>

<style>
  .mission-card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 20px 24px; }
  .head { font-family: var(--font-mono); font-size: .68rem; letter-spacing: .14em; text-transform: uppercase;
    color: var(--text-muted); font-weight: 700; }
  ul { list-style: none; margin: 10px 0 0; padding: 0; }
  /* Dashed rules between the rows, like the printed card this is standing in for. */
  li { display: flex; align-items: baseline; gap: 12px; padding: 10px 0; font-size: .95rem;
    border-bottom: 1px dashed var(--border); }
  li:last-child { border-bottom: 0; padding-bottom: 0; }
  /* Outline ticks take the accent; an emoji tick is drawn in colour by the device font and
     ignores this, which is the documented trade-off in challenges.ts. */
  .tick { flex: none; width: 1.25em; text-align: center; color: var(--accent); font-size: 1rem; }
</style>
