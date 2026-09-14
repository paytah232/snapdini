<script lang="ts">
  import { postJson } from '$lib/api';
  import { showToast } from '$lib/toast';
  import type { BillingConfig, BillingQuote, AppOptions } from '$lib/types';
  import { retentionIncludedDays, retentionLabel } from '$lib/featureUpsell';
  import { retentionFloorFor, upgradeRetentionFor } from '$lib/upgradePlan';

  export let code: string;
  export let orgCode: string;
  export let billing: BillingConfig;
  export let options: AppOptions | null = null;
  // current entitlement
  export let guestCap: number;
  export let maxPhotos: number;
  export let videoSeconds: number;
  export let retentionDays: number;
  export let amountPaidCents: number;
  export let aspectRatios: string[] = ['1:1'];
  export let durationHours: number;       // current event length
  // True when the event's settings form has unsaved edits. The quote here is computed from the
  // SAVED event, so we block upgrading until the organizer saves — otherwise the price could miss
  // an unsaved change (e.g. a just-ticked frame size).
  export let blocked = false;

  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const allAspects = () => (options?.aspectRatios ?? []).map((a) => a.value);
  const hasAllShapes = allAspects().filter((v) => v !== '1:1').every((v) => aspectRatios.includes(v));

  // OWNS the pack, which is not the same question as "has every shape". Pricing charges the pack
  // for ANY non-square shape (billing.ts hasNonSquare), while hasAllShapes asks for ALL of them —
  // so a host holding just 4:5 was shown an UNTICKED "Unlock all frame sizes" box and, underneath
  // it, a $5 line for the pack. It read as a charge for something they had declined. Same rule as
  // the admin page's framePackOwned, deliberately.
  $: framePackOwned = aspectRatios.some((a) => a !== '1:1');

  // Lines whose value the host has NOT raised in this panel: they are already on the event. The
  // features are free below the paid tier and chargeable above it, so an upgrade re-prices things
  // that were gifted — which is correct, and looked like a mistake because nothing said so.
  $: ownedShots    = !!quote && quote.maxPhotos <= maxPhotos;
  $: ownedVideo    = !!quote && quote.videoSeconds > 0 && quote.videoSeconds <= videoSeconds;
  $: ownedDuration = !!quote && quote.durationHours <= durationHours;
  $: ownedRetention = !!quote && quote.retentionDays <= retentionDays;
  $: anyOwnedCharged = !!quote && (
    (ownedShots && !!quote.shotsCents) || (framePackOwned && !!quote.frameCents) ||
    (ownedVideo && !!quote.videoCents) || (ownedDuration && !!quote.durationCents) ||
    (ownedRetention && !!quote.retentionCents));

  // Base add-on prices, mirroring the server tiers.
  //
  // These labels were lifted from the event-creation form, where the base price IS the price — you
  // are buying from nothing. On an UPGRADE panel it is the wrong number twice over: the option the
  // event is already on printed "+$5" for something already paid for, and a bigger option printed
  // its full price when only the step up is charged. The panel's own footer says "you only pay the
  // difference", and the dropdowns were contradicting it.
  //
  // So every price here is a DELTA from what the event already has on that dimension (see `extra`),
  // and the current value carries no price at all.
  const shotsAddon = (shots: number) => (billing.shotsTiers ?? []).find((x) => shots <= x.maxShots)?.amountCents ?? 0;
  const videoBase = (seconds: number) => (billing.videoAddons ?? []).find((v) => v.seconds === seconds)?.amountCents ?? 0;
  const durationAddon = (hours: number) => (billing.durationTiers ?? []).find((x) => hours <= x.maxHours)?.amountCents ?? 0;
  const retAddon = (days: number) => (billing.retentionTiers ?? []).find((x) => days <= x.maxDays)?.amountCents ?? 0;
  const featuresFreeAt = (guests: number) => guests <= billing.freeAllGuests;
  /** What stepping from `have` to `want` adds, never below zero.
   *
   *  An approximation of one dimension, not the quote — changing the guest tier can make a paid
   *  add-on free, and only the server prices the whole basket. That is exactly why the running
   *  total below is the authority and these labels are a guide: it is computed from the server's
   *  own quote, and it is the number the host is charged. */
  const extra = (cost: (n: number) => number, want: number, have: number) => Math.max(0, cost(want) - cost(have));
  // `guests` is an explicit arg so these labels re-run when the guest tier changes (a template
  // expression only re-evaluates when its arguments change, not a closed-over variable).
  const shotsLabel = (n: number, guests: number) => {
    if (n === maxPhotos) return `${n} — current`;
    if (n <= (billing.shotsFree ?? 12)) return `${n}`;
    const c = extra(shotsAddon, n, maxPhotos);
    if (!c) return `${n} — no extra charge`;
    return featuresFreeAt(guests) ? `${n} — free (normally +${money(c)})` : `${n} — +${money(c)}`;
  };
  const videoLabel = (n: number, guests: number) => {
    const name = n ? `${n}s clips` : 'No video';
    if (n === videoSeconds) return `${name} — current`;
    const c = extra(videoBase, n, videoSeconds);
    if (!c) return n ? `${name} — no extra charge` : name;
    return featuresFreeAt(guests) ? `${name} — free (normally +${money(c)})` : `${name} — +${money(c)}`;
  };
  // Retention does NOT follow the guest-tier "everything free under 10" rule — it is the opposite.
  // A free event PAYS for anything past a week; a paid event gets a month INCLUDED. This label used
  // featuresFreeAt() and so printed the price exactly backwards: "free" on the event that is
  // charged $3, "+$3" on the event that already includes it.
  //
  // The allowance itself is the wizard's, not a second copy: a local re-statement of a rule that
  // already runs backwards to everything around it is how it got printed inside out the first time.
  const retIncludedFor = (guests: number) => retentionIncludedDays(billing, guests);
  const retCostFor = (days: number, guests: number) => (days <= retIncludedFor(guests) ? 0 : retAddon(days));
  const retLabelPriced = (days: number, guests: number) => {
    const base = retentionLabel(days);
    if (days === retentionDays) return `${base} — current`;
    // Both sides priced at the SELECTED guest tier, because that tier is what decides how much is
    // included — pricing the current value at the old tier would show a charge for something the
    // upgrade has just made free.
    const c = Math.max(0, retCostFor(days, guests) - retCostFor(retentionDays, guests));
    if (!c) return days <= retIncludedFor(guests) && retAddon(days) ? `${base} — included` : base;
    return `${base} — +${money(c)}`;
  };
  // Duration is charged identically on every tier — the guest count buys features, not hours — so
  // there is no "free on this tier" case to print here either.
  const durLabelPriced = (h: number, _guests: number) => {
    const base = durLabel(h);
    if (h === durationHours) return `${base} — current`;
    const c = extra(durationAddon, h, durationHours);
    if (!c) return base;
    return `${base} — +${money(c)}`;
  };

  /** The choices at or above what the event already has — and ALWAYS including that current value.
   *
   *  Filtering alone is not enough, and the difference is a dropdown that renders blank. A stored
   *  value that is not itself a tier survives the filter nowhere, so the `<select>` is bound to a
   *  number no `<option>` carries and the browser shows nothing selected. Both are real: a 15-second
   *  video (a demo default) and a 31-day keep ("a month") are neither of them tier values.
   *
   *  The guest dropdown already did this — it unioned `guestCap` in, with a comment about legacy
   *  events. The other four filtered without unioning, which is the same bug the comment describes,
   *  left in four places. This is that fix, once. */
  const atOrAbove = (values: number[], current: number): number[] =>
    Array.from(new Set([current, ...values])).filter((n) => n >= current).sort((a, b) => a - b);

  const guestChoices = atOrAbove([billing.freeAllGuests, ...billing.paidTiers.map((t) => t.maxGuests)], guestCap)
    .map((n) => ({ maxGuests: n }));
  const shotChoices = atOrAbove((options?.shotsPerPerson ?? []).map((s) => Number(s.value)), maxPhotos);
  const videoChoices = atOrAbove([0, ...billing.videoAddons.map((v) => v.seconds)], videoSeconds);
  // Reactive to the SELECTED guest tier: stepping up to a paid tier includes a month, so a week is
  // no longer on offer and the selection moves up to what is now included rather than silently
  // keeping the free event's 7 days.
  $: retentionFloor = retentionFloorFor(billing, retentionDays, uGuests);
  // Numbers, like the others — only maxDays was ever read out of the tier objects.
  $: retentionChoices = atOrAbove(billing.retentionTiers.map((t) => t.maxDays), retentionFloor);
  // Duration is a paid add-on, so it belongs here too — offer lengths ≥ the current event length.
  const durationChoices = atOrAbove((options?.durations ?? []).map((d) => Number(d.value)), durationHours);
  const durLabel = (h: number) => (options?.durations ?? []).find((d) => Number(d.value) === h)?.label ?? `${h}h`;

  // selections (default to current)
  let uGuests = guestCap, uShots = maxPhotos, uVideo = videoSeconds, uRet = retentionDays, uFrames = hasAllShapes, uDuration = durationHours;
  /** Has the host actually picked a keep-length here? Until they have, the number in the control
   *  belongs to the guest tier they are looking at, and has to be free to go back down with it. */
  let uRetTouched = false;
  // The selection follows the tier back DOWN again, which the panel used not to do. This was
  // `if (uRet < retentionFloor) uRet = retentionFloor`, a one-way ratchet: the Guests dropdown
  // only lists tiers at or above this event's, but the SELECTION moves freely inside that list, so
  // a host who opened the paid tier and changed their mind was left holding its included month —
  // and a month on a free event is a $3 add-on nobody asked for. See upgradeRetentionFor(): the
  // tier's number is the tier's to take back, the host's is not.
  //
  // Down here rather than beside retentionFloor above because `$: x = …` on a variable declared
  // later is a use-before-declaration in TypeScript.
  $: uRet = upgradeRetentionFor(billing, uRet, retentionDays, uGuests, uRetTouched);
  let quote: BillingQuote | null = null;
  let busy = false;

  function reqAspects(): string[] {
    return uFrames ? allAspects() : aspectRatios;
  }
  async function refresh() {
    try {
      quote = await postJson<BillingQuote>('/api/billing/quote', {
        maxGuests: uGuests, maxPhotos: uShots, videoSeconds: uVideo, retentionDays: uRet, durationHours: uDuration, aspectRatios: reqAspects(),
      });
    } catch { /* keep */ }
  }
  // Signature-based re-quote (a primitive whose value changes) — reliably fires on every change.
  $: quoteSig = JSON.stringify([uGuests, uShots, uVideo, uRet, uFrames, uDuration]);
  $: if (quoteSig) refresh();
  // Total + delta use amountCents (full price incl. paid add-ons), matching the server exactly.
  $: diff = quote ? Math.max(0, quote.amountCents - amountPaidCents) : 0;
  $: changed = uGuests !== guestCap || uShots !== maxPhotos || uVideo !== videoSeconds || uRet !== retentionDays || uDuration !== durationHours || (uFrames && !hasAllShapes);

  async function upgrade() {
    busy = true;
    try {
      const r = await postJson<{ url?: string; applied?: boolean }>('/api/billing/upgrade', {
        joinCode: code, organizerCode: orgCode,
        maxGuests: uGuests, maxPhotos: uShots, videoSeconds: uVideo, retentionDays: uRet, durationHours: uDuration, aspectRatios: reqAspects(),
      });
      if (r.url) { location.href = r.url; return; }
      showToast('Upgrade applied! 🎉'); setTimeout(() => location.reload(), 800);
    } catch (e) { showToast(e instanceof Error ? e.message : 'Upgrade failed', true); busy = false; }
  }

  // Absolute base price for a guest tier (unambiguous; shots/video are tier-dependent so the
  // live "Upgrade for +$X" total below is the source of truth for those).
  const guestPrice = (n: number) => {
    if (n <= billing.freeAllGuests) return 0;
    const t = billing.paidTiers.find((x) => x.maxGuests >= n);
    return t ? t.amountCents : (billing.paidTiers[billing.paidTiers.length - 1]?.amountCents ?? 0);
  };
  // The guest tier is a REPLACEMENT price, not an add-on — a bigger tier costs its own amount and
  // the smaller one stops applying — so this printed the whole new tier price ("$15") where every
  // other dropdown printed a step. Same rule as the rest now: the tier you are on says so, and the
  // ones above say what the step costs.
  const guestLabel = (n: number) => {
    if (n === guestCap) return `Up to ${n} — current`;
    const c = Math.max(0, guestPrice(n) - guestPrice(guestCap));
    if (!c) return `Up to ${n}` + (guestPrice(n) ? '' : ' — free');
    return `Up to ${n} — +${money(c)}`;
  };
  $: newTotal = quote ? (quote.tier === 'paid' || quote.amountCents > 0 ? quote.amountCents : 0) : 0;

  // Anything left to offer above the current plan?
  const canOfferMore = guestChoices.length > 1 || shotChoices.length > 1 || videoChoices.length > 1 || retentionChoices.length > 1 || durationChoices.length > 1 || !hasAllShapes;
</script>

{#if billing.billingEnabled && canOfferMore}
  <div class="card">
    <div class="card-title">⬆️ Upgrade this event</div>
    <p class="cur">Now: up to <b>{guestCap}</b> guests · <b>{maxPhotos}</b> shots · {videoSeconds ? `${videoSeconds}s video` : 'no video'} · {retentionDays}-day keep{#if amountPaidCents}{' '}· paid {money(amountPaidCents)}{/if}</p>

    <div class="grid">
      {#if guestChoices.length > 1}
        <label class="u"><span>Guests</span>
          <select bind:value={uGuests}>{#each guestChoices as g}<option value={g.maxGuests}>{guestLabel(g.maxGuests)}</option>{/each}</select>
        </label>
      {/if}
      {#if shotChoices.length > 1}
        <label class="u"><span>Shots / guest</span>
          <select bind:value={uShots}>{#each shotChoices as n}<option value={n}>{shotsLabel(n, uGuests)}</option>{/each}</select>
        </label>
      {/if}
      {#if videoChoices.length > 1}
        <label class="u"><span>Video</span>
          <select bind:value={uVideo}>{#each videoChoices as n}<option value={n}>{videoLabel(n, uGuests)}</option>{/each}</select>
        </label>
      {/if}
      {#if retentionChoices.length > 1}
        <label class="u"><span>Keep photos</span>
          <select bind:value={uRet} on:change={() => (uRetTouched = true)}>{#each retentionChoices as d}<option value={d}>{retLabelPriced(d, uGuests)}</option>{/each}</select>
        </label>
      {/if}
      {#if durationChoices.length > 1}
        <label class="u"><span>Event length</span>
          <select bind:value={uDuration}>{#each durationChoices as h}<option value={h}>{durLabelPriced(h, uGuests)}</option>{/each}</select>
        </label>
      {/if}
    </div>
    {#if framePackOwned}
      <!-- Already on the event, so this is a statement rather than a question. It was previously
           hidden entirely when hasAllShapes, which left the $5 line below it with no explanation
           and no control anywhere near it. -->
      <!-- The space that joins these two sentences lives INSIDE the block, on the same line as the
           opening tag. Svelte trims a block whose content starts on the next line, which is how
           this rendered as "on your event.They are included". -->
      <p class="chk owned-note">Frame sizes are already on your event.{#if !featuresFreeAt(uGuests)}{' '}They
        are included free below {billing.freeAllGuests + 1} guests and charged above it.{/if}</p>
    {:else if !hasAllShapes}
      <label class="chk"><input type="checkbox" bind:checked={uFrames} />
        Unlock all frame sizes (frame pack){#if featuresFreeAt(uGuests)}{' '}<span class="was">{money(billing.framePackCents)}</span>{:else} <span class="addon">+{money(billing.framePackCents)}</span>{/if}
      </label>
    {/if}

    <!-- Same priced line-item breakdown as the create form, reflecting the selected plan. -->
    {#if quote}
      <div class="quote">
        <div class="quote-price">
          {#if newTotal > 0}
            <span class="amount">{money(newTotal)}</span><span class="per">total</span>
          {:else}
            <span class="amount free">Free</span>
          {/if}
        </div>
        <ul class="quote-lines">
          <li><span>Event pass · up to {quote.maxGuests} guests</span>{#if quote.baseCents}<span>{money(quote.baseCents)}</span>{:else}<span class="incl">Free</span>{/if}</li>
          {#if quote.maxPhotos > billing.shotsFree}<li class:owned={ownedShots}><span>Extra shots · {quote.maxPhotos}/guest{#if ownedShots}<em class="yours">already yours</em>{/if}</span>{#if quote.shotsCents}<span>{money(quote.shotsCents)}</span>{:else}<span class="was">{money(shotsAddon(quote.maxPhotos))}</span>{/if}</li>{/if}
          {#if quote.framePack}<li class:owned={framePackOwned}><span>Frame-sizes pack{#if framePackOwned}<em class="yours">already yours</em>{/if}</span>{#if quote.frameCents}<span>{money(quote.frameCents)}</span>{:else}<span class="was">{money(billing.framePackCents)}</span>{/if}</li>{/if}
          {#if quote.videoSeconds > 0}<li class:owned={ownedVideo}><span>Video clips · {quote.videoSeconds}s{#if ownedVideo}<em class="yours">already yours</em>{/if}</span>{#if quote.videoCents}<span>{money(quote.videoCents)}</span>{:else}<span class="was">{money(videoBase(quote.videoSeconds))}</span>{/if}</li>{/if}
          {#if quote.durationCents}<li class:owned={ownedDuration}><span>Extended event · {Math.round(quote.durationHours / 24)} days{#if ownedDuration}<em class="yours">already yours</em>{/if}</span><span>{money(quote.durationCents)}</span></li>{/if}
          {#if quote.retentionCents}<li class:owned={ownedRetention}><span>Photo retention · {quote.retentionDays} days{#if ownedRetention}<em class="yours">already yours</em>{/if}</span><span>{money(quote.retentionCents)}</span></li>{/if}
        </ul>
        {#if anyOwnedCharged}
          <!-- The whole point of the marks. Without this the breakdown reads as a list of things
               being added, when most of it is a list of things being RE-PRICED. -->
          <p class="owned-foot">“Already yours” means it is on your event now. Everything is
            included free for up to {billing.freeAllGuests} guests — above that it is charged, which
            is why these appear.</p>
        {/if}
      </div>
    {/if}

    <div class="foot">
      {#if amountPaidCents}<p class="newtotal">Already paid <b>{money(amountPaidCents)}</b> on this event.</p>{/if}
      {#if blocked}
        <button class="btn primary full" disabled>Save your settings first</button>
        <p class="hint warn">You've got unsaved changes in <b>Event settings</b> above — save them so the upgrade price is accurate.</p>
      {:else if changed && diff > 0}
        <button class="btn primary full" on:click={upgrade} disabled={busy}>{busy ? 'Starting…' : `Upgrade for +${money(diff)}`}</button>
      {:else if changed}
        <button class="btn primary full" on:click={upgrade} disabled={busy}>{busy ? 'Applying…' : 'Apply upgrade (already covered — no extra charge)'}</button>
      {:else}
        <p class="hint">Pick a bigger option above to upgrade — you only pay the difference.</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; }
  .card-title { font-weight: 800; font-size: 0.95rem; margin-bottom: 8px; }
  .cur { font-size: 0.8rem; color: var(--text-muted); margin-bottom: 14px; }
  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; }
  .u { display: block; font-size: 0.76rem; color: var(--text-muted); }
  .u > span { display: block; margin-bottom: 4px; }
  .u select { width: 100%; padding: 9px 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font: inherit; font-size: 0.88rem; }
  .chk { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 0.82rem; }
  .foot { margin-top: 14px; }
  .full { width: 100%; }
  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 11px 18px; font-size: 0.9rem; border: 1px solid transparent; cursor: pointer; font: inherit; text-align: center; }
  .primary { background: var(--accent); color: var(--accent-ink, #111); }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .hint { font-size: 0.78rem; color: var(--text-muted); margin: 0; }
  .hint.warn { margin-top: 8px; color: var(--accent); }
  .newtotal { font-size: 0.82rem; color: var(--text-muted); margin: 0 0 8px; text-align: center; }
  .was { color: var(--success); font-weight: 700; text-decoration: line-through; }
  .addon { color: var(--text-muted); font-weight: 700; }
  .quote { margin-top: 14px; padding: 14px; border-radius: var(--radius-sm); background: var(--surface-2); border: 1px solid var(--border); }
  .quote-price { display: flex; align-items: baseline; gap: 8px; }
  .quote-price .amount { font-size: 1.7rem; font-weight: 850; }
  .quote-price .amount.free { color: var(--success); }
  .quote-price .per { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .quote-lines { list-style: none; margin: 8px 0 0; padding: 0; font-size: 0.85rem; color: var(--text-muted); }
  .quote-lines li { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; }
  .quote-lines .incl { color: var(--success); font-weight: 700; }
  .quote-lines .yours {
    font-style: normal; font-size: 0.72rem; font-weight: 600; margin-left: 6px;
    padding: 1px 6px; border-radius: 999px;
    background: var(--surface-2); color: var(--text-muted); white-space: nowrap;
  }
  .owned-foot { margin: 8px 0 0; font-size: 0.75rem; line-height: 1.45; color: var(--text-muted); }
  .owned-note { color: var(--text-muted); }
</style>
