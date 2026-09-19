<script lang="ts">
  import { postJson } from '$lib/api';
  import { showToast } from '$lib/toast';
  import type { BillingConfig, BillingQuote, AppOptions } from '$lib/types';
  import { retentionIncludedDays, retentionLabel, videoAddonCents } from '$lib/featureUpsell';
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
  // These drive the "already yours" marks AND the quieter treatment of the lines that carry them.
  //
  // They used to need a paragraph underneath explaining that a marked line was being re-priced
  // rather than re-charged. It is gone: the breakdown now subtracts what the event already has, at
  // today's prices, right below the list — so the point is demonstrated by the arithmetic instead
  // of asserted in prose, and the changed lines carry a "was" that says what is actually moving.
  //
  // The event pass was the one line that could never say "already yours", so the biggest number in
  // the breakdown looked like a fresh charge even when the host had not touched the guest tier.
  $: ownedGuests   = !!quote && quote.maxGuests <= guestCap;
  $: ownedShots    = !!quote && quote.maxPhotos <= maxPhotos;
  $: ownedVideo    = !!quote && quote.videoSeconds > 0 && quote.videoSeconds <= videoSeconds;
  $: ownedDuration = !!quote && quote.durationHours <= durationHours;
  $: ownedRetention = !!quote && quote.retentionDays <= retentionDays;

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
  // LIST price of a clip length, ignoring the guest tier. Only for the "normally +$x" aside on a
  // free event, where nothing is charged and the figure is there to show what is being given away.
  const videoBase = (seconds: number) => (billing.videoAddons ?? []).find((v) => v.seconds === seconds)?.amountCents ?? 0;
  /* What video ACTUALLY costs on an event of this size.
     Video is the one add-on that scales with the guest count — a clip is guests x seconds of
     storage — so the server multiplies it by the tier's videoMul. This panel priced it flat, which
     is how the guest dropdown came to understate its own step: gd's 10s clips cost $3 at 60 guests
     and $5 at 400, so "Up to 400 — +$44.00" was charged $46.00. videoAddonCents is the shared
     arithmetic (same rounding as videoCentsFor on the server), not a second copy of the rule. */
  const videoCostAt = (seconds: number, guests: number) =>
    featuresFreeAt(guests) ? 0 : videoAddonCents(billing, seconds, guests);
  /* ── What this event ALREADY pays, line by line, at the tier it already has ──────────────
     The same figures the quote credits back as "already on your event". Every price on this panel
     is measured from them, which is what stops two lines claiming the same money.

     Three features are free below the paid threshold and chargeable above it — video, extra shots
     and the frame pack — so moving up a tier starts charging for things the event already has.
     That money has to appear SOMEWHERE: hidden, the rows stopped adding up to the button, which is
     exactly what a host checking the arithmetic notices first. Each line now shows its own
     increase, so the guest row can stay the price of the pass alone. */
  $: ownedVideoCents = videoCostAt(videoSeconds, guestCap);
  const shotsCostAt = (n: number, guests: number) =>
    featuresFreeAt(guests) || n <= (billing.shotsFree ?? 12) ? 0 : shotsAddon(n);
  $: ownedShotsCents = shotsCostAt(maxPhotos, guestCap);
  const frameCostAt = (guests: number) => (featuresFreeAt(guests) ? 0 : billing.framePackCents);
  /* Only for a pack the event already HOLDS. One it has not bought yet is priced by the checkbox
     beside it, at whatever the selected tier charges. */
  $: frameUplift = framePackOwned ? Math.max(0, frameCostAt(uGuests) - frameCostAt(guestCap)) : 0;

  /* A line the event ALREADY has whose price has gone up because the guest tier did.
     "Already yours" is true of the thing and false of the money, so a line that says it while
     carrying a charge reads as a contradiction — and it was being dimmed and un-bolded at the same
     time, which hid the one line the host most needs to see. These lines are marked as changes:
     full weight, and a note saying what actually moved. */
  $: videoRepriced  = ownedVideo && !!quote && quote.videoCents > ownedVideoCents;
  $: shotsRepriced  = ownedShots && !!quote && quote.shotsCents > ownedShotsCents;
  $: framesRepriced = framePackOwned && frameUplift > 0;
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
    const c = Math.max(0, shotsCostAt(n, guests) - ownedShotsCents);
    // The roll they already have can start costing money on a bigger tier — see the note above.
    if (n === maxPhotos) return c ? `${n} — +${money(c)}` : `${n} — current`;
    if (n <= (billing.shotsFree ?? 12)) return `${n}`;
    if (featuresFreeAt(guests)) {
      const list = extra(shotsAddon, n, maxPhotos);
      return list ? `${n} — free (normally +${money(list)})` : `${n} — no extra charge`;
    }
    if (!c) return `${n} — no extra charge`;
    return `${n} — +${money(c)}`;
  };
  const videoLabel = (n: number, guests: number) => {
    const name = n ? `${n}s clips` : 'No video';
    // Measured from what is already owned, exactly like the line it becomes in the breakdown.
    const c = Math.max(0, videoCostAt(n, guests) - ownedVideoCents);
    if (n === videoSeconds) {
      // The length they ALREADY have can still cost more on a bigger tier, because video is the one
      // add-on that scales with the guest count. That belongs here, on the video line, and it is
      // the only honest place for it: folded into the guest step instead — which is what this panel
      // did — the pass appeared to cost more than it does and the two lines stopped adding up.
      // Just the price. It said "current · +$2.00 at this size", which is three ideas where the
      // list everywhere else carries one: the row is already the selected one, so "current" is
      // said twice, and what the money is for belongs in the breakdown, not in a <select>.
      return c ? `${name} — +${money(c)}` : `${name} — current`;
    }
    // Free tier: nothing is charged, so the aside quotes the LIST price — the tier-scaled number
    // would be a figure this event is not being charged and would not be charged if it stayed put.
    if (featuresFreeAt(guests)) {
      const list = extra(videoBase, n, videoSeconds);
      return list ? `${name} — free (normally +${money(list)})` : n ? `${name} — no extra charge` : name;
    }
    if (!c) return n ? `${name} — no extra charge` : name;
    return `${name} — +${money(c)}`;
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
    if (days === retentionDays) {
      const up = Math.max(0, retCostFor(days, guests) - retCostFor(days, guestCap));
      const down = Math.max(0, retCostFor(days, guestCap) - retCostFor(days, guests));
      if (up) return `${base} — +${money(up)}`;
      // The one line that can get CHEAPER on a bigger tier, because a paid pass includes a month.
      if (down) return `${base} — −${money(down)}`;
      return `${base} — current`;
    }
    // Both sides priced at the SELECTED guest tier, because that tier is what decides how much is
    // included — pricing the current value at the old tier would show a charge for something the
    // upgrade has just made free.
    const c = Math.max(0, retCostFor(days, guests) - retCostFor(retentionDays, guests));
    if (!c) return days <= retIncludedFor(guests) && retAddon(days) ? `${base} — included` : base;
    return `${base} — +${money(c)}`;
  };
  /** Retention runs the OTHER way to the rest: a paid tier includes a month, so moving up can stop
   *  a charge the event is paying today. Shown as the saving it is, on the row it belongs to, so
   *  the arithmetic still ties out. */
  $: retSaving = Math.max(0, retCostFor(retentionDays, guestCap) - retCostFor(retentionDays, uGuests));
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
  /** The keep-photos control's ONE handler — deliberately not `bind:value` plus `on:change`.
   *
   *  Two listeners on the same change event meant the flush could run the `$: uRet = …` rule below
   *  while `uRetTouched` was still false; untouched, that rule hands back the TIER's number rather
   *  than the host's, so the first pick after a fresh load was silently reverted and only the second
   *  one stuck. Order matters and is now explicit: touched first, then the value. */
  function chooseRetention(e: Event) {
    uRetTouched = true;
    uRet = Number((e.currentTarget as HTMLSelectElement).value);
  }
  let quote: BillingQuote | null = null;
  let busy = false;

  function reqAspects(): string[] {
    return uFrames ? allAspects() : aspectRatios;
  }
  async function refresh() {
    try {
      quote = await postJson<BillingQuote>('/api/billing/quote', {
        maxGuests: uGuests, maxPhotos: uShots, videoSeconds: uVideo, retentionDays: uRet, durationHours: uDuration, aspectRatios: reqAspects(),
        // What the event already holds, so the server can price it at TODAY'S prices and the panel
        // can show the same difference the upgrade will charge.
        current: { maxGuests: guestCap, maxPhotos, videoSeconds, retentionDays, durationHours, aspectRatios },
      });
    } catch { /* keep */ }
  }
  // Signature-based re-quote (a primitive whose value changes) — reliably fires on every change.
  $: quoteSig = JSON.stringify([uGuests, uShots, uVideo, uRet, uFrames, uDuration]);
  $: if (quoteSig) refresh();
  // The delta between two CONFIGURATIONS, both priced today — the same sum /api/billing/upgrade
  // does from the event row. It used to be `amountCents - amountPaidCents`, which measured today's
  // price against a payment taken at some past moment, so any price change we made turned into a
  // charge for every event already sold at the old price.
  $: covered = quote?.coveredCents ?? 0;
  $: diff = quote ? Math.max(0, quote.amountCents - covered) : 0;
  /** Whether the breakdown needs to show its own subtraction. Nothing already covered means the new
   *  total IS what you pay, and spelling out "minus $0" is noise. */
  $: showsCredit = !!quote && covered > 0;
  $: changed = uGuests !== guestCap || uShots !== maxPhotos || uVideo !== videoSeconds || uRet !== retentionDays || uDuration !== durationHours || (uFrames && !hasAllShapes);
  /** The breakdown is an ANSWER to "why that number", so it waits until there is a number to explain.
   *
   *  It used to render from the moment the panel mounted, on an event nobody had touched yet — a
   *  priced list of everything the host already owns, sitting under a heading that offers to sell
   *  them more. Read cold it looks like an invoice, which is exactly the reading that made an
   *  "already yours" line feel like a second charge. Everything it says at rest is already said,
   *  more briefly, by the "Now:" line above — including what has been paid.
   *
   *  So: only once a selection has actually moved (`changed`) AND that move costs something
   *  (`diff > 0`). A change that is already covered charges nothing and needs no itemisation; the
   *  button says so on its own. */
  $: showBreakdown = !!quote && changed && diff > 0;

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
  /* The PASS, and nothing but the pass — the same figure its own line carries in the breakdown.
     It briefly also carried the video re-price that a bigger tier brings with it, which made this
     line agree with the total but disagree with everything else: on a free event moving to 400
     guests with 30s clips, this said +$73 while the breakdown said $59 for the pass and $14 for the
     video. One number cannot be both the pass and the whole bill. The re-price now shows on the
     video row, so every row is its own line and the rows add up to what the button charges. */
  const guestLabel = (n: number) => {
    if (n === guestCap) return `Up to ${n} — current`;
    const c = Math.max(0, guestPrice(n) - guestPrice(guestCap));
    if (!c) return `Up to ${n}` + (guestPrice(n) ? '' : ' — free');
    return `Up to ${n} — +${money(c)}`;
  };
  $: newTotal = quote ? (quote.tier === 'paid' || quote.amountCents > 0 ? quote.amountCents : 0) : 0;

  // Anything left to offer above the current plan?
  const canOfferMore = guestChoices.length > 1 || shotChoices.length > 1 || videoChoices.length > 1 || retentionChoices.length > 1 || durationChoices.length > 1 || !hasAllShapes;
  /** Bound OUT, so the page hosting this can tell the difference between "nothing to sell" and a
   *  section that failed to draw. Only this component can answer it — the ladders it compares are
   *  built here. */
  export let offersAvailable = false;
  $: offersAvailable = billing.billingEnabled && canOfferMore;
</script>

{#if billing.billingEnabled && canOfferMore}
  <div class="card">
    <div class="card-title">⬆️ Upgrade this event</div>
    <!-- Every VALUE is bold and every label is not. Two of the five used to be bold and the rest
         plain, which reads as emphasis — as though guests and shots mattered and the keep length
         did not — rather than as the one consistent shape it is: a list of what this event has. -->
    <p class="cur">Now: up to <b>{guestCap}</b> guests · <b>{maxPhotos}</b> shots ·
      {#if videoSeconds}<b>{videoSeconds}s</b> video{:else}<b>no</b> video{/if} ·
      <b>{retentionLabel(retentionDays)}</b> keep{#if amountPaidCents}{' '}· <b>{money(amountPaidCents)}</b> paid{/if}</p>

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
          <!-- ONE handler, not `bind:value` plus `on:change`. Two listeners on the same event meant
               the flush could run `$: uRet = upgradeRetentionFor(…)` while `uRetTouched` was still
               false — and untouched, that rule hands back the tier's own number, so the host's FIRST
               pick was silently reverted and only their second one stuck. Setting both here, in
               order, in one place, removes the race rather than papering over it. -->
          <select value={uRet} on:change={chooseRetention}>{#each retentionChoices as d}<option value={d}>{retLabelPriced(d, uGuests)}</option>{/each}</select>
        </label>
      {/if}
      {#if durationChoices.length > 1}
        <label class="u"><span>Event length</span>
          <select bind:value={uDuration}>{#each durationChoices as h}<option value={h}>{durLabelPriced(h, uGuests)}</option>{/each}</select>
        </label>
      {/if}
    </div>
    <!-- Shown ONLY when it is explaining something. This note exists because the breakdown below can
         charge for a frame pack the event already owns, and hiding it outright once left that line
         with no explanation and no control near it — the reason the block is here at all.
         But its explanatory half is already gated on !featuresFreeAt: at a tier where the pack costs
         nothing there is no charged line to account for, and what is left is a bare "you already
         have this" on a panel whose entire job is offering things you do not. So the gate moves up
         to the whole note, and the case it was added for still reads exactly as before. -->
    {#if framePackOwned && !featuresFreeAt(uGuests)}
      <!-- The space that joins these two sentences lives INSIDE the block, on the same line as the
           opening tag. Svelte trims a block whose content starts on the next line, which is how
           this rendered as "on your event.They are included". -->
      <!-- The tail is one unbroken line on purpose: a newline inside the block renders as a space,
           which is how this printed "+$5.00 ." with the full stop adrift. -->
      <p class="chk owned-note">Frame sizes are already on your event. They
        are included free below {billing.freeAllGuests + 1} guests and charged above
        it{#if frameUplift}{' '}— <span class="addon">+{money(frameUplift)}</span>{/if}.</p>
    {:else if !framePackOwned && !hasAllShapes}
      <label class="chk"><input type="checkbox" bind:checked={uFrames} />
        Unlock all frame sizes (frame pack){#if featuresFreeAt(uGuests)}{' '}<span class="was">{money(billing.framePackCents)}</span>{:else}{' '}<span class="addon">+{money(billing.framePackCents)}</span>{/if}
      </label>
    {/if}

    <!-- Same priced line-item breakdown as the create form, reflecting the selected plan. -->
    {#if showBreakdown && quote}
      <div class="quote">
        <!-- "new total", not "total". This number is the WHOLE event re-priced, not the amount due —
             the amount due is on the button, and the two differ by whatever has already been paid.
             Labelled "total" with a paid event underneath it, a host read the big number as the
             bill and then every "already yours" line as being charged to them a second time. -->
        <div class="quote-price">
          {#if newTotal > 0}
            <span class="amount">{money(newTotal)}</span><span class="per">{showsCredit ? 'new total' : 'total'}</span>
          {:else}
            <span class="amount free">Free</span>
          {/if}
        </div>
        <ul class="quote-lines">
          <li class:owned={ownedGuests}><span>Event pass · up to {quote.maxGuests} guests{#if ownedGuests}<em class="yours">already yours</em>{:else}<em class="prev">was {guestCap}</em>{/if}</span>{#if quote.baseCents}<span>{money(quote.baseCents)}</span>{:else}<span class="incl">Free</span>{/if}</li>
          {#if quote.maxPhotos > billing.shotsFree}<li class:owned={ownedShots && !shotsRepriced}><span>Extra shots · {quote.maxPhotos}/guest{#if shotsRepriced}<em class="prev">now charged at {quote.maxGuests} guests</em>{:else if ownedShots}<em class="yours">already yours</em>{:else}<em class="prev">was {maxPhotos}</em>{/if}</span>{#if quote.shotsCents}<span>{money(quote.shotsCents)}</span>{:else}<span class="was">{money(shotsAddon(quote.maxPhotos))}</span>{/if}</li>{/if}
          {#if quote.framePack}<li class:owned={framePackOwned && !framesRepriced}><span>Frame-sizes pack{#if framesRepriced}<em class="prev">now charged at {quote.maxGuests} guests</em>{:else if framePackOwned}<em class="yours">already yours</em>{:else}<em class="prev">new</em>{/if}</span>{#if quote.frameCents}<span>{money(quote.frameCents)}</span>{:else}<span class="was">{money(billing.framePackCents)}</span>{/if}</li>{/if}
          {#if quote.videoSeconds > 0}<li class:owned={ownedVideo && !videoRepriced}><span>Video clips · {quote.videoSeconds}s{#if videoRepriced}<em class="prev">now charged at {quote.maxGuests} guests</em>{:else if ownedVideo}<em class="yours">already yours</em>{:else}<em class="prev">was {videoSeconds ? `${videoSeconds}s` : 'none'}</em>{/if}</span>{#if quote.videoCents}<span>{money(quote.videoCents)}</span>{:else}<span class="was">{money(videoBase(quote.videoSeconds))}</span>{/if}</li>{/if}
          {#if quote.durationCents}<li class:owned={ownedDuration}><span>Extended event · {Math.round(quote.durationHours / 24)} days{#if ownedDuration}<em class="yours">already yours</em>{:else}<em class="prev">was {Math.round(durationHours / 24)} days</em>{/if}</span><span>{money(quote.durationCents)}</span></li>{/if}
          {#if quote.retentionCents}<li class:owned={ownedRetention}><span>Photo retention · {retentionLabel(quote.retentionDays)}{#if ownedRetention}<em class="yours">already yours</em>{:else}<em class="prev">was {retentionLabel(retentionDays)}</em>{/if}</span><span>{money(quote.retentionCents)}</span></li>{/if}
        </ul>
        <!-- THE SUBTRACTION, shown rather than left to be done in the reader's head.
             The list above prices the whole event, so on a paid event its lines sum to more than is
             owed — which is exactly what made a priced "already yours" line look like a second
             charge. Ending the list with what has been paid and what is left makes each line's
             price mean something again: it is part of the new total, not part of the bill. -->
        {#if showsCredit}
          <ul class="quote-lines sum">
            <!-- What the event already has, at today's prices — NOT the money taken in the past.
                 Those differ whenever a price has moved since, and billing against the payment is
                 what made a price change retroactive. -->
            <li><span>Already on your event</span><span>−{money(covered)}</span></li>
            <li class="due"><span>You pay now</span><span>{money(diff)}</span></li>
          </ul>
        {/if}
      </div>
    {/if}

    <div class="foot">
      <!-- The "Already paid" line that used to sit here is gone. It was the third place on this
           card to state one fact: the "Now:" line says it always, and the subtraction above says it
           whenever the breakdown is up. Three statements of the same number is how they drift. -->
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
  /* auto-fit, not a fixed 2, because the CONTENT is what decides whether two fit. Each option
     carries its own price — "30 days — free (normally +$3)", "35 — current" — and a hard two-column
     grid on a phone left about 180px per select, which truncates the part that says what the choice
     COSTS. A native select shows the chosen option's text and nothing else, so there is no second
     place for that to be read: if it does not fit, it is gone. One column below ~440px keeps it. */
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
  .u { display: block; font-size: 0.76rem; color: var(--text-muted); }
  .u > span { display: block; margin-bottom: 4px; }
  .u select { width: 100%; min-width: 0; padding: 9px 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font: inherit; font-size: 0.88rem; }
  .chk { display: flex; align-items: center; gap: 8px; margin-top: 12px; font-size: 0.82rem; }
  .foot { margin-top: 14px; }
  .full { width: 100%; }
  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 11px 18px; font-size: 0.9rem; border: 1px solid transparent; cursor: pointer; font-family: inherit; text-align: center; }
  .primary { background: var(--accent-fill); color: var(--accent-ink, #111); }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .hint { font-size: 0.78rem; color: var(--text-muted); margin: 0; }
  .hint.warn { margin-top: 8px; color: var(--accent); }
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
  /* THE LINE YOU ARE ACTUALLY BUYING, told apart from the ones you already have.
     `class:owned` was being set on five of these six lines and nothing styled it, so a breakdown of
     six items at one weight and one colour made the host hunt for which of them the upgrade was
     even about. The changing lines are the subject: they get the full text colour and the weight.
     The owned ones stay where they were and step back — they are context, not the offer. */
  .quote-lines li:not(.owned):not(.due) { color: var(--text); font-weight: 700; }
  .quote-lines li.owned { opacity: 0.72; }
  /* "was 36" beside the new number. The single most useful thing on the line: the price alone says
     what it costs and nothing at all about what changed.
     NOT `.was` — that class already exists in this component for the struck-through original price
     on the frame-pack label, and styling it here turned that strikethrough into an accent pill. */
  .quote-lines .prev {
    font-style: normal; font-size: 0.72rem; font-weight: 600; margin-left: 6px;
    padding: 1px 6px; border-radius: 999px; white-space: nowrap;
    background: var(--accent-fill); color: var(--accent-ink, #111);
  }
  .quote-lines .yours {
    font-style: normal; font-size: 0.72rem; font-weight: 600; margin-left: 6px;
    padding: 1px 6px; border-radius: 999px;
    background: var(--surface-2); color: var(--text-muted); white-space: nowrap;
  }
  /* Set off from the itemised list above it: these two are arithmetic ON that list, not more of it. */
  .quote-lines.sum { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--border); }
  .quote-lines.sum .due { font-weight: 800; }
  /* A paragraph, not a control row. It borrows .chk for the type size and spacing, but .chk is a
     FLEX container — which turned the inline price into a flex item: blockified, carrying the row's
     8px gap, so "+$5.00" broke onto a line of its own in the middle of the sentence. */
  .owned-note { color: var(--text-muted); display: block; }
</style>
