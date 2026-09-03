<script lang="ts">
  // Shown to GUESTS at the bottom of a gallery. Guests are the only warm audience the product has —
  // they have just watched it work at someone else's event.
  //
  // Deliberately leads with the FREE tier rather than a discount: the barrier is not price, it is
  // that a guest has no idea this is something they can run themselves. They never signed up for
  // anything, so nothing has told them.
  import { referralLink } from '$lib/referral';
  export let sourceJoinCode: string;
  export let freeGuests = 10;
  /** Surface 3: the reveal moment. When the gallery has only just unlocked, the guest is at the
   *  emotional peak of the whole product, so the same card earns a warmer lead-in and more weight.
   *  Same component rather than a second one — two near-identical cards would drift apart. */
  export let emphasis = false;
</script>

<aside class="syo" class:emphasis>
  <div class="syo-copy">
    <strong>{emphasis ? 'Want this at yours?' : 'Liked this?'}</strong>
    <span>Run one for your own event — free for up to {freeGuests} guests.</span>
  </div>
  <a class="syo-cta" href={referralLink(sourceJoinCode)}>Start your own</a>
</aside>

<style>
  .syo {
    display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
    max-width: 720px; margin: 34px auto 8px; padding: 16px 18px;
    border: 1px solid var(--border); border-radius: 14px; background: var(--surface);
  }
  .syo-copy { display: flex; flex-direction: column; gap: 2px; font-size: .92rem; }
  .syo-copy span { color: var(--text-muted); font-size: .85rem; }
  .syo-cta {
    background: var(--accent); color: var(--accent-ink, #111); text-decoration: none;
    font-weight: 700; font-size: .88rem; padding: 9px 16px; border-radius: 10px; white-space: nowrap;
  }
  .syo-cta:hover { filter: brightness(1.06); }
  .syo.emphasis { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
</style>
