<script lang="ts">
  // Shown to GUESTS at the bottom of a gallery. Guests are the only warm audience the product has —
  // they have just watched it work at someone else's event.
  //
  // Deliberately leads with the FREE tier rather than a discount: the barrier is not price, it is
  // that a guest has no idea this is something they can run themselves. They never signed up for
  // anything, so nothing has told them.
  import { referralLink } from '$lib/referral';
  import { track } from '$lib/analytics';
  export let sourceJoinCode: string;
  export let freeGuests = 10;
  /** Surface 3: the reveal moment. When the gallery has only just unlocked, the guest is at the
   *  emotional peak of the whole product, so the same card earns a warmer lead-in and more weight.
   *  Same component rather than a second one — two near-identical cards would drift apart. */
  export let emphasis = false;
  /** Renders the footer rail below the card's own copy. The guest-feedback ask lives there, so it
   *  shares one card instead of stacking a second one under it. Off unless something fills it. */
  export let footer = false;
</script>

<aside class="syo" class:emphasis>
  <div class="syo-copy">
    <strong>{emphasis ? 'Want this at yours?' : 'Liked this?'}</strong>
    <span>Run one for your own event — free for up to {freeGuests} guests.</span>
  </div>
  <!-- referral_clicks currently reads 0 across every event; this records the click at the source
       so a zero can be told apart from a card nobody ever reaches. -->
  <a class="syo-cta" href={referralLink(sourceJoinCode)}
     on:click={() => track('referral_card_click', { emphasis }, sourceJoinCode)}>Start your own</a>
  {#if footer}
    <div class="syo-foot"><slot name="foot" /></div>
  {/if}
</aside>

<style>
  /* max-width alone does nothing below 720px, so on every phone these ran edge-to-edge while the
     photo cards beside them sat 10px in (.pgrid's padding) — the panels read as full-bleed bands
     rather than cards. `min(720px, 100% - 20px)` keeps the centred 720px cap where there is room
     and gives the same 10px gutter where there is not, with no media query. 20px because these are
     SIBLINGS of .pgrid, so half its padding each side puts their edges on the cards' edges. */
  .syo {
    display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap;
    /* 14px top, matching .optin and .full-gallery above it rather than the 34px this carried.
       Adjacent margins collapse to the LARGER, so a 34px top against their 14px bottom produced one
       gap two and a half times every other gap in the stack — which reads as a missing card, not as
       breathing space. Nothing justified the odd value; the cards above and below are the same kind
       of thing and now sit the same distance apart. */
    max-width: min(720px, 100% - 20px); margin: 14px auto 8px; padding: 16px 18px;
    border: 1px solid var(--border); border-radius: 14px; background: var(--surface);
  }
  .syo-copy { display: flex; flex-direction: column; gap: 2px; font-size: .92rem; }
  .syo-copy span { color: var(--text-muted); font-size: .85rem; }
  .syo-cta {
    background: var(--accent-fill); color: var(--accent-ink, #111); text-decoration: none;
    font-weight: 700; font-size: .88rem; padding: 9px 16px; border-radius: 10px; white-space: nowrap;
  }
  .syo-cta:hover { filter: brightness(1.06); }
  /* Full-width rail under the copy/CTA row — .syo wraps, so flex-basis:100% forces its own line. */
  .syo-foot {
    flex-basis: 100%; margin-top: 4px; padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  .syo.emphasis { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
</style>
