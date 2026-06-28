<script lang="ts">
  import { postJson } from '$lib/api';
  import { showToast } from '$lib/toast';
  import type { BillingConfig, BillingQuote, AppOptions } from '$lib/types';

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

  // Base add-on prices (mirror the server tiers) — used to label the dropdown options with
  // their price, exactly like the event-creation form.
  const shotsAddon = (shots: number) => (billing.shotsTiers ?? []).find((x) => shots <= x.maxShots)?.amountCents ?? 0;
  const videoBase = (seconds: number) => (billing.videoAddons ?? []).find((v) => v.seconds === seconds)?.amountCents ?? 0;
  const durationAddon = (hours: number) => (billing.durationTiers ?? []).find((x) => hours <= x.maxHours)?.amountCents ?? 0;
  const retAddon = (days: number) => (billing.retentionTiers ?? []).find((x) => days <= x.maxDays)?.amountCents ?? 0;
  const featuresFreeAt = (guests: number) => guests <= billing.freeAllGuests;
  // `guests` is an explicit arg so these labels re-run when the guest tier changes (a template
  // expression only re-evaluates when its arguments change, not a closed-over variable).
  const shotsLabel = (n: number, guests: number) => {
    if (n <= (billing.shotsFree ?? 12)) return `${n}`;
    const c = shotsAddon(n);
    if (!c) return `${n}`;
    return featuresFreeAt(guests) ? `${n} — free (normally +${money(c)})` : `${n} — +${money(c)}`;
  };
  const videoLabel = (n: number, guests: number) => {
    if (!n) return 'No video';
    const c = videoBase(n);
    if (!c) return `${n}s clips`;
    return featuresFreeAt(guests) ? `${n}s clips — free (normally +${money(c)})` : `${n}s clips — +${money(c)}`;
  };
  const retLabelPriced = (days: number, guests: number) => {
    const c = retAddon(days);
    const base = retLabel(days);
    if (!c) return base;
    return featuresFreeAt(guests) ? `${base} — free (normally +${money(c)})` : `${base} — +${money(c)}`;
  };
  const durLabelPriced = (h: number, guests: number) => {
    const c = durationAddon(h);
    const base = durLabel(h);
    if (!c) return base;
    return featuresFreeAt(guests) ? `${base} — free (normally +${money(c)})` : `${base} — +${money(c)}`;
  };

  // choices ≥ current — tier caps plus the event's own cap (so it's always selectable, even
  // for legacy events created before the dropdown matched the tiers).
  const guestCaps = Array.from(new Set([guestCap, billing.freeAllGuests, ...billing.paidTiers.map((t) => t.maxGuests)]))
    .filter((n) => n >= guestCap).sort((a, b) => a - b);
  const guestChoices = guestCaps.map((n) => ({ maxGuests: n }));
  const shotChoices = (options?.shotsPerPerson ?? []).map((s) => Number(s.value)).filter((n) => n >= maxPhotos);
  const videoChoices = [0, ...billing.videoAddons.map((v) => v.seconds)].filter((n) => n >= videoSeconds);
  const retentionChoices = billing.retentionTiers.filter((t) => t.maxDays >= retentionDays);
  const retLabel = (d: number) => d <= 7 ? '1 week' : d <= 31 ? '1 month' : d <= 92 ? '3 months' : '1 year';
  // Duration is a paid add-on, so it belongs here too — offer lengths ≥ the current event length.
  const durationChoices = (options?.durations ?? []).map((d) => Number(d.value)).filter((n) => n >= durationHours);
  const durLabel = (h: number) => (options?.durations ?? []).find((d) => Number(d.value) === h)?.label ?? `${h}h`;

  // selections (default to current)
  let uGuests = guestCap, uShots = maxPhotos, uVideo = videoSeconds, uRet = retentionDays, uFrames = hasAllShapes, uDuration = durationHours;
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
  const guestLabel = (n: number) => `Up to ${n}` + (guestPrice(n) ? ` — ${money(guestPrice(n))}` : ' — free');
  $: newTotal = quote ? (quote.tier === 'paid' || quote.amountCents > 0 ? quote.amountCents : 0) : 0;

  // Anything left to offer above the current plan?
  const canOfferMore = guestChoices.length > 1 || shotChoices.length > 1 || videoChoices.length > 1 || retentionChoices.length > 1 || durationChoices.length > 1 || !hasAllShapes;
</script>

{#if billing.billingEnabled && canOfferMore}
  <div class="card">
    <div class="card-title">⬆️ Upgrade this event</div>
    <p class="cur">Now: up to <b>{guestCap}</b> guests · <b>{maxPhotos}</b> shots · {videoSeconds ? `${videoSeconds}s video` : 'no video'} · {retentionDays}-day keep{#if amountPaidCents}  · paid {money(amountPaidCents)}{/if}</p>

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
          <select bind:value={uRet}>{#each retentionChoices as t}<option value={t.maxDays}>{retLabelPriced(t.maxDays, uGuests)}</option>{/each}</select>
        </label>
      {/if}
      {#if durationChoices.length > 1}
        <label class="u"><span>Event length</span>
          <select bind:value={uDuration}>{#each durationChoices as h}<option value={h}>{durLabelPriced(h, uGuests)}</option>{/each}</select>
        </label>
      {/if}
    </div>
    {#if !hasAllShapes}
      <label class="chk"><input type="checkbox" bind:checked={uFrames} />
        Unlock all frame sizes (frame pack){#if featuresFreeAt(uGuests)} <span class="was">{money(billing.framePackCents)}</span>{:else} <span class="addon">+{money(billing.framePackCents)}</span>{/if}
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
          {#if quote.maxPhotos > billing.shotsFree}<li><span>Extra shots · {quote.maxPhotos}/guest</span>{#if quote.shotsCents}<span>{money(quote.shotsCents)}</span>{:else}<span class="was">{money(shotsAddon(quote.maxPhotos))}</span>{/if}</li>{/if}
          {#if quote.framePack}<li><span>Frame-sizes pack</span>{#if quote.frameCents}<span>{money(quote.frameCents)}</span>{:else}<span class="was">{money(billing.framePackCents)}</span>{/if}</li>{/if}
          {#if quote.videoSeconds > 0}<li><span>Video clips · {quote.videoSeconds}s</span>{#if quote.videoCents}<span>{money(quote.videoCents)}</span>{:else}<span class="was">{money(videoBase(quote.videoSeconds))}</span>{/if}</li>{/if}
          {#if quote.durationCents}<li><span>Extended event · {Math.round(quote.durationHours / 24)} days</span><span>{money(quote.durationCents)}</span></li>{/if}
          {#if quote.retentionCents}<li><span>Photo retention · {quote.retentionDays} days</span><span>{money(quote.retentionCents)}</span></li>{/if}
        </ul>
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
</style>
