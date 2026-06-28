<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { getConfig, getMe, api } from '$lib/api';
  import { createEvent, joinEvent } from '$lib/events';
  import { saveSession } from '$lib/session';
  import { showToast } from '$lib/toast';
  import Logo from '$lib/components/Logo.svelte';
  import type { AppOptions, BillingConfig, BillingQuote } from '$lib/types';
  import { postJson } from '$lib/api';
  import SearchableSelect from '$lib/components/SearchableSelect.svelte';
  import HelpTip from '$lib/components/HelpTip.svelte';

  let tab: 'create' | 'join' = 'create';

  // ── Config-driven options (single source — never hard-coded). ──
  let options: AppOptions | null = null;

  // ── Billing (only surfaced when billingEnabled; self-host shows none of this). ──
  let billing: BillingConfig | null = null;
  let maxGuests = 10;
  let videoSeconds = 0;
  let framePackOn = false;   // billing on: $5 pack unlocks ALL shapes (free on ≤10-guest events)
  let quote: BillingQuote | null = null;

  // Every configured shape value (for the "unlock all" frame pack).
  $: allAspectValues = (options?.aspectRatios ?? []).map((a) => a.value);
  // The aspect ratios this config requests: pack on → all shapes, else 1:1 (hosted);
  // self-host keeps the free per-shape picker.
  function requestedAspects(): string[] {
    if (billing?.billingEnabled) return framePackOn ? allAspectValues : ['1:1'];
    return Object.keys(selectedAspects).filter((k) => selectedAspects[k]);
  }

  // Race guard: only the newest in-flight quote is allowed to win (rapid changes otherwise let
  // a slow earlier response overwrite a fresh one).
  let quoteSeq = 0;
  async function refreshQuote() {
    if (!billing?.billingEnabled) return;
    const seq = ++quoteSeq;
    try {
      const q = await postJson<BillingQuote>('/api/billing/quote', { maxGuests, maxPhotos, aspectRatios: requestedAspects(), videoSeconds, durationHours, retentionDays });
      if (seq === quoteSeq) quote = q;
    } catch { /* leave previous quote */ }
  }
  // Live pricing — a primitive signature of every priced input. Svelte re-runs the block below
  // whenever the signature *value* changes, which is far more reliable than `void`-referencing
  // each variable, and it fires on EVERY selection (guests, video, shots, frames, duration, retention).
  $: quoteSig = billing?.billingEnabled
    ? JSON.stringify([maxGuests, videoSeconds, maxPhotos, framePackOn, durationHours, retentionDays, requestedAspects()])
    : '';
  $: if (quoteSig) refreshQuote();
  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
  // Extra-shots add-on cost for a given shot count (mirrors the server tiers).
  const shotsAddon = (shots: number) => {
    const t = (billing?.shotsTiers ?? []).find((x) => shots <= x.maxShots);
    return t ? t.amountCents : 0;
  };
  // Base event-pass price for a guest count (0 = free), mirrors the server guest tiers.
  const guestBase = (g: number) => {
    if (g <= (billing?.freeAllGuests ?? 10)) return 0;
    const tiers = billing?.paidTiers ?? [];
    const t = tiers.find((x) => g <= x.maxGuests);
    return t ? t.amountCents : (tiers[tiers.length - 1]?.amountCents ?? 0);
  };
  const guestLabel = (n: number, txt: string) => {
    if (!billing?.billingEnabled) return txt;
    const c = guestBase(n);
    return c === 0 ? `${txt} — free` : `${txt} — ${money(c)}`;
  };
  // Video add-on price for a given clip length (mirrors server VIDEO_ADDONS).
  const videoBase = (seconds: number) => {
    const a = (billing?.videoAddons ?? []).find((v) => v.seconds === seconds);
    return a ? a.amountCents : 0;
  };
  // Features (video / extra shots / frame pack) are free on ≤freeAllGuests events.
  const featuresFreeAt = (guests: number) => guests <= (billing?.freeAllGuests ?? 10);
  // Dropdown labels take `guests` as an EXPLICIT argument — a template expression only re-runs
  // when its arguments change, not when a variable it closes over changes. Passing maxGuests in
  // is what makes the labels flip free↔priced the instant the guest tier changes.
  const videoLabel = (seconds: number, guests: number) => {
    if (!billing?.billingEnabled) return `${seconds}s clips`;
    const c = videoBase(seconds);
    if (!c) return `${seconds}s clips`;
    return featuresFreeAt(guests) ? `${seconds}s clips — free (normally +${money(c)})` : `${seconds}s clips — +${money(c)}`;
  };
  // Suffix for the shots dropdown — '' when included free at this guest count.
  const shotsSuffix = (shots: number, guests: number) => {
    if (!billing?.billingEnabled || shots <= (billing.shotsFree ?? 12)) return '';
    const c = shotsAddon(shots);
    if (!c) return '';
    return featuresFreeAt(guests) ? ` — free (normally +${money(c)})` : ` — +${money(c)}`;
  };
  // Duration add-on for a given length in hours (mirrors server tiers).
  const durationAddon = (hours: number) => {
    const t = (billing?.durationTiers ?? []).find((x) => hours <= x.maxHours);
    return t ? t.amountCents : 0;
  };
  // Photo-retention choices (built from the server tiers) + their add-on cost.
  $: retentionChoices = (billing?.retentionTiers ?? []).map((t) => {
    const label = t.maxDays <= 7 ? '1 week' : t.maxDays <= 31 ? '1 month' : t.maxDays <= 92 ? '3 months' : '1 year';
    return { days: t.maxDays, amountCents: t.amountCents, label };
  });

  // ── Create form state ──
  let name = '';
  let slug = '';
  let slugFeedback: { text: string; cls: 'ok' | 'err' | 'muted' } | null = null;
  let slugCheckTimer: ReturnType<typeof setTimeout> | undefined;

  let startDate = '';
  let startTime = '';
  let durationHours: number | string = '';
  let maxPhotos: number | string = '';
  let retentionDays = 7;
  let timezone = '';
  let blurb = '';
  let allowDownloads = true;
  let noFlash = false;
  let revealMode = 'at_end';   // default: hide until the event ends (overridden by config on load)
  let revealDelayHours: number | string = 0;
  let moderationEnabled = false;
  let selectedAspects: Record<string, boolean> = {};

  let timezones: string[] = [];
  let creating = false;
  let loggedIn = false;   // show a "My events" shortcut for signed-in hosts

  // ── Join form state ──
  let joinName = '';
  let joinCode = '';
  let joining = false;

  const pad = (n: number) => String(n).padStart(2, '0');

  onMount(async () => {
    try { loggedIn = !!(await getMe()).user; } catch { /* anon */ }
    // Default the start to midnight at the beginning of the following day — events are almost
    // always planned ahead, and this avoids accidentally starting one mid-creation.
    const tm = new Date();
    tm.setDate(tm.getDate() + 1);
    tm.setHours(0, 0, 0, 0);
    startDate = `${tm.getFullYear()}-${pad(tm.getMonth() + 1)}-${pad(tm.getDate())}`;
    startTime = '00:00';

    // Timezone list + detected default.
    try {
      timezones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
    } catch {
      timezones = [];
    }
    if (!timezones.length) timezones = ['UTC'];
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

    // Pre-fill join code from ?code= and switch to the join tab.
    const codeParam =
      typeof location !== 'undefined' ? new URLSearchParams(location.search).get('code') : null;
    if (codeParam) {
      joinCode = codeParam.toUpperCase().replace(/[^A-Z0-9]/g, '');
      tab = 'join';
    }

    // Build all dropdowns + reveal cards + aspect checkboxes from config.
    try {
      const cfg = await getConfig();
      options = cfg.options;
      billing = cfg.billing;
      const def = options.defaults;
      durationHours = def.durationHours;
      maxPhotos = def.maxPhotos;
      revealMode = def.revealMode || 'at_end';
      revealDelayHours = options.revealDelays[0]?.value ?? 0;
      // 1:1 checked by default; everything else off.
      for (const a of options.aspectRatios) selectedAspects[a.value] = a.value === '1:1';
      selectedAspects = selectedAspects;
    } catch {
      /* offline — leave form unbuilt */
    }
  });

  // ── Slug helpers ──
  function slugify(str: string, allowTrailingHyphen = false): string {
    let s = str.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    if (!allowTrailingHyphen) s = s.replace(/^-+|-+$/g, '');
    return s.slice(0, 50);
  }

  // The custom URL is OPTONAL and never auto-derived from the name — an event left without one
  // uses its automatic join link, so we don't silently consume nice /e/ slugs nobody asked for.
  function onSlugInput() {
    slug = slugify(slug, true);
    validateSlug();
  }

  function validateSlug() {
    clearTimeout(slugCheckTimer);
    const val = slug;
    if (!val) {
      slugFeedback = null;
      return;
    }
    if (val.length < 2) {
      slugFeedback = { text: 'Too short — at least 2 characters', cls: 'err' };
      return;
    }
    slugFeedback = { text: 'Checking…', cls: 'muted' };
    slugCheckTimer = setTimeout(async () => {
      try {
        const data = await api<{ available: boolean; slug: string }>(
          '/api/events/check-slug/' + encodeURIComponent(val)
        );
        slugFeedback = data.available
          ? { text: `✓ Available — URL will be /e/${data.slug}`, cls: 'ok' }
          : { text: '✗ Already taken — try a different name', cls: 'err' };
      } catch {
        slugFeedback = null;
      }
    }, 500);
  }

  // ── Create ──
  async function submitCreate() {
    if (creating) return;

    // Creating requires a signed-in, verified account.
    let user; let meFailed = false;
    try {
      ({ user } = await getMe());
    } catch {
      meFailed = true;   // transient — don't bounce to /login; ask to retry
    }
    if (meFailed) {
      showToast('Network hiccup — please try again', true);
      return;
    }
    if (!user) {
      showToast('Please sign in', true);
      goto('/login');
      return;
    }
    if (!user.emailVerified) {
      showToast('Verify your email first', true);
      return;
    }

    if (!name.trim()) {
      showToast('Enter an event name', true);
      return;
    }

    const aspectRatios = requestedAspects();
    const startsAt = startDate
      ? new Date(`${startDate}T${startTime || '00:00'}`).getTime()
      : Date.now();

    creating = true;
    try {
      const data = await createEvent({
        name: name.trim(),
        blurb: blurb.trim() || undefined,
        durationHours,
        maxPhotos,
        revealMode,
        slug: slug.trim() || undefined,
        startsAt,
        startDate,
        startTime,
        allowDownloads,
        noFlash,
        revealDelayHours: parseInt(String(revealDelayHours), 10) || 0,
        moderationEnabled,
        timezone,
        aspectRatios,
        maxGuests,
        videoSeconds,
        retentionDays
      });

      // Paid tiers (billing on) → straight to Stripe Checkout; the event is created
      // unpaid/inactive and the webhook flips it to paid on success.
      if (billing?.billingEnabled && quote?.requiresPayment) {
        const { url } = await postJson<{ url: string }>('/api/billing/checkout', {
          joinCode: data.joinCode,
          organizerCode: data.organizerCode,
        });
        window.location.href = url;
        return;
      }

      // Free event → straight to the manager dashboard, which shows a welcome modal
      // (QR + share link) on ?created=1. The organizer code travels in the hash.
      goto(`/admin/${data.joinCode}?created=1#${encodeURIComponent(data.organizerCode)}`);
      return;
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to create event', true);
    } finally {
      creating = false;
    }
  }

  // ── Manage existing event (organizer login) ──
  function goManage() {
    const c = joinCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (c.length < 2) { showToast('Enter your event code first', true); return; }
    goto(`/admin/${c}`);
  }

  // ── Join ──
  async function submitJoin() {
    if (joining) return;
    const n = joinName.trim();
    const c = joinCode.trim().toUpperCase();
    if (!n) {
      showToast('Enter your name', true);
      return;
    }
    if (c.length < 2) {
      showToast('Enter the event code', true);
      return;
    }
    joining = true;
    try {
      const data = await joinEvent(c, n);
      saveSession(data.joinCode || c, data.sessionToken);
      goto(`/join/${data.joinCode || c}`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Failed to join', true);
      joining = false;
    }
  }

  function onJoinCodeInput() {
    joinCode = joinCode.toUpperCase().replace(/[^A-Z0-9]/g, '');
  }
</script>

<svelte:head><title>Create or join — Snapdini</title></svelte:head>

<div class="page">
  <div class="top">
    <a class="brand" href={loggedIn ? '/dashboard' : '/'}><Logo /></a>
    {#if loggedIn}<a class="myevents" href="/dashboard">← My events</a>{/if}
  </div>

  <div class="tabs">
    <button class="tab" class:active={tab === 'create'} on:click={() => (tab = 'create')}>
      Create Event
    </button>
    <button class="tab" class:active={tab === 'join'} on:click={() => (tab = 'join')}>
      Join Event
    </button>
  </div>

  {#if tab === 'create'}
    <!-- 1 ── The essentials: name + (when billing's on) who's coming, video & live price. -->
    <div class="card">
      <div class="card-title">Your event</div>

      <div class="field">
        <label for="event-name">Event name</label>
        <input
          id="event-name"
          type="text"
          maxlength="80"
          placeholder="e.g. Lisa's Birthday 🎂"
          bind:value={name}
        />
      </div>

      <div class="field">
        <label for="event-blurb">Welcome blurb <span class="hint">(optional — shown under the title on the join screen)</span></label>
        <textarea id="event-blurb" maxlength="280" rows="2" placeholder="e.g. Snap away — every photo's a surprise until the big reveal!" bind:value={blurb}></textarea>
      </div>

      {#if billing?.billingEnabled}
        <p class="field-hint" style="margin:0 0 12px">Events for up to {billing.freeAllGuests} guests are <b>free with every feature</b> (shots, frame sizes, video). Bigger events are a one-off pass. <b>Longer events &amp; photo retention are paid add-ons on any size.</b></p>
        <div class="field-row">
          <div class="field">
            <label for="max-guests">Expected guests</label>
            <select id="max-guests" bind:value={maxGuests}>
              <option value={10}>{guestLabel(10, 'Up to 10')}</option>
              <option value={25}>{guestLabel(25, 'Up to 25')}</option>
              <option value={60}>{guestLabel(60, 'Up to 60')}</option>
              <option value={150}>{guestLabel(150, 'Up to 150')}</option>
              <option value={400}>{guestLabel(400, 'Up to 400')}</option>
            </select>
          </div>
          <div class="field">
            <label for="video-secs">Video clips</label>
            <select id="video-secs" bind:value={videoSeconds}>
              <option value={0}>Off</option>
              {#each billing.videoAddons as v}<option value={v.seconds}>{videoLabel(v.seconds, maxGuests)}</option>{/each}
            </select>
          </div>
        </div>
        {#if quote}
          <div class="quote">
            <div class="quote-price">
              {#if quote.requiresPayment}
                <span class="amount">{money(quote.amountCents)}</span><span class="per">one-off</span>
              {:else}
                <span class="amount free">Free</span>
              {/if}
            </div>
            <div class="quote-detail">
              {#if quote.tier === 'custom'}Over {billing.paidTiers[billing.paidTiers.length - 1].maxGuests} guests — contact us for a custom plan.
              {:else}
                <!-- Every selected feature shows a line. When it's free at this guest count we show
                     its would-be price struck through in green, so the cost is still clear and the
                     line simply "un-strikes" to a real charge the moment the event goes over 10. -->
                <ul class="quote-lines">
                  <li><span>Event pass · up to {quote.maxGuests} guests</span>{#if quote.baseCents}<span>{money(quote.baseCents)}</span>{:else}<span class="incl">Free</span>{/if}</li>
                  {#if quote.maxPhotos > billing.shotsFree}<li><span>Extra shots · {quote.maxPhotos}/guest</span>{#if quote.shotsCents}<span>{money(quote.shotsCents)}</span>{:else}<span class="was">{money(shotsAddon(quote.maxPhotos))}</span>{/if}</li>{/if}
                  {#if quote.framePack}<li><span>Frame-sizes pack</span>{#if quote.frameCents}<span>{money(quote.frameCents)}</span>{:else}<span class="was">{money(billing.framePackCents)}</span>{/if}</li>{/if}
                  {#if quote.videoSeconds > 0}<li><span>Video clips · {quote.videoSeconds}s</span>{#if quote.videoCents}<span>{money(quote.videoCents)}</span>{:else}<span class="was">{money(videoBase(quote.videoSeconds))}</span>{/if}</li>{/if}
                  {#if quote.durationCents}<li><span>Extended event · {Math.round(quote.durationHours / 24)} days</span><span>{money(quote.durationCents)}</span></li>{/if}
                  {#if quote.retentionCents}<li><span>Photo retention · {quote.retentionDays} days</span><span>{money(quote.retentionCents)}</span></li>{/if}
                </ul>
                {#if !quote.requiresPayment}<p class="quote-allfree">Everything's free at this guest count — only longer events &amp; photo retention are ever charged.</p>{/if}
              {/if}
            </div>
            {#each quote.notes as n}<div class="quote-note">⚠ {n}</div>{/each}
          </div>
        {/if}
      {/if}
    </div>

    <!-- 2 ── When it runs. -->
    <div class="card">
      <div class="card-title">When</div>
      <div class="field-row">
        <div class="field">
          <label for="start-date">Start date</label>
          <input id="start-date" type="date" min={startDate} bind:value={startDate} />
        </div>
        <div class="field">
          <label for="start-time">Start time</label>
          <input id="start-time" type="time" bind:value={startTime} />
        </div>
      </div>
      <div class="field">
        <label for="duration">Duration</label>
        <select id="duration" bind:value={durationHours}>
          {#each options?.durations ?? [] as d}
            <option value={d.value}>{d.label}{#if billing?.billingEnabled && Number(d.value) > (billing.durationFreeHours ?? 24) && durationAddon(Number(d.value)) > 0} (+{money(durationAddon(Number(d.value)))}){/if}</option>
          {/each}
        </select>
        {#if billing?.billingEnabled}<p class="field-hint">Up to {Math.round((billing.durationFreeHours ?? 48) / 24)} days is free · longer is a paid add-on.</p>{/if}
      </div>
    </div>

    <!-- 3 ── Everything else, tucked away. Sensible defaults mean most hosts never open this. -->
    <details class="more">
      <summary>Advanced settings <span class="sum-hint">custom URL, shots, shapes, reveal…</span></summary>

      <div class="card">
        <div class="field">
          <label for="event-slug">Custom URL <span class="hint">(optional)</span></label>
          <div class="slug-row">
            <span class="slug-prefix">/e/</span>
            <input
              id="event-slug"
              class="slug-input"
              type="text"
              maxlength="50"
              placeholder="lisas-birthday"
              bind:value={slug}
              on:input={onSlugInput}
            />
          </div>
          {#if slugFeedback}
            <div class="slug-feedback {slugFeedback.cls}">{slugFeedback.text}</div>
          {/if}
        </div>

        <div class="field">
          <label for="max-photos">Shots per person</label>
          <select id="max-photos" bind:value={maxPhotos}>
            {#each options?.shotsPerPerson ?? [] as s}
              <option value={s.value}>{s.label}{shotsSuffix(Number(s.value), maxGuests)}</option>
            {/each}
          </select>
          {#if billing?.billingEnabled}<p class="field-hint">First {billing.shotsFree} free · extra shots are an add-on on paid events (free on ≤{billing.freeAllGuests}-guest events).</p>{/if}
        </div>

        <div class="field">
          <label for="retention">Keep photos for</label>
          <select id="retention" bind:value={retentionDays}>
            {#each retentionChoices as r}
              <option value={r.days}>{r.label}{#if billing?.billingEnabled && r.amountCents > 0} (+{money(r.amountCents)}){/if}</option>
            {/each}
          </select>
          {#if billing?.billingEnabled}<p class="field-hint">Photos are kept {billing.retentionFreeDays} days after the event ends for free · longer is an add-on on paid events.</p>{/if}
        </div>

        <div class="field">
          <label for="timezone">Timezone <span class="hint">(type to search)</span></label>
          <SearchableSelect id="timezone" options={timezones} bind:value={timezone} placeholder="e.g. Australia/Brisbane" />
        </div>

        <div class="field">
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label>Photo shapes <span class="hint">(guests pick from what you allow)</span></label>
          {#if billing?.billingEnabled}
            <label class="pack-toggle">
              <input type="checkbox" bind:checked={framePackOn} />
              <span>Unlock all frame sizes
                {#if featuresFreeAt(maxGuests)}<span class="pack-tag free">free</span> <s class="was">+{money(billing.framePackCents)}</s>{:else}<span class="pack-tag">+{money(billing.framePackCents)}</span>{/if}</span>
              <HelpTip text={`Square (1:1) is always free. The pack unlocks every shape (${allAspectValues.filter((v) => v !== '1:1').join(', ')}) for guests — and it's free on ≤${billing.freeAllGuests}-guest events.`} />
            </label>
          {:else}
            <div class="aspect-options">
              {#each options?.aspectRatios ?? [] as a}
                <label class="aspect-opt">
                  <input type="checkbox" bind:checked={selectedAspects[a.value]} />
                  {a.label}
                </label>
              {/each}
            </div>
          {/if}
        </div>

        <div class="field toggle-field">
          <span class="tf-label">
            <label for="allow-downloads">Allow downloads</label>
            <button type="button" class="help-tip" aria-label="What does allow downloads do?">?
              <span class="tip">When on, guests can save individual photos from the shared gallery and download the whole event as a zip. Turn it off to make the gallery view-only — people can still see the photos, just not download them.</span>
            </button>
          </span>
          <label class="toggle">
            <input id="allow-downloads" type="checkbox" bind:checked={allowDownloads} />
            <span class="toggle-track"></span>
          </label>
        </div>

        <div class="field toggle-field">
          <span class="tf-label">
            <label for="no-flash">No flash</label>
            <button type="button" class="help-tip" aria-label="What does no flash do?">?
              <span class="tip">Stops guests' phones firing the bright rear camera flash — handy for ceremonies, dark venues or anywhere a flash would be disruptive. The gentle front-camera selfie flash still works.</span>
            </button>
          </span>
          <label class="toggle">
            <input id="no-flash" type="checkbox" bind:checked={noFlash} />
            <span class="toggle-track"></span>
          </label>
        </div>
      </div>

      <div class="card">
        <div class="card-title">Reveal mode</div>
        <div class="reveal-options">
          {#each options?.revealModes ?? [] as m}
            <button
              type="button"
              class="reveal-opt"
              class:selected={revealMode === m.value}
              on:click={() => (revealMode = m.value)}
            >
              <span class="opt-icon">{m.icon || ''}</span>
              {m.label}
              <br /><small>{m.desc || ''}</small>
            </button>
          {/each}
        </div>

        {#if revealMode === 'at_end'}
          <div class="field" style="margin-top:14px">
            <label for="reveal-delay">Reveal delay after the event ends</label>
            <select id="reveal-delay" bind:value={revealDelayHours}>
              {#each options?.revealDelays ?? [] as r}
                <option value={r.value}>{r.label}</option>
              {/each}
            </select>
          </div>
        {/if}

        {#if revealMode !== 'instant'}
          <div class="field toggle-field" style="margin-top:14px">
            <label for="moderation">
              Moderate photos <span class="hint">(you approve each before it shows)</span>
            </label>
            <label class="toggle">
              <input id="moderation" type="checkbox" bind:checked={moderationEnabled} />
              <span class="toggle-track"></span>
            </label>
          </div>
        {/if}
      </div>
    </details>

    <button class="btn primary" on:click={submitCreate} disabled={creating}>
      {creating ? 'Creating…' : quote?.requiresPayment ? `Create event · ${money(quote.amountCents)}` : 'Create event'}
    </button>
    <p class="foot-note">You'll get a QR code + join code to share with guests</p>
  {:else}
    <div class="card">
      <div class="card-title">Join an event</div>
      <div class="field">
        <label for="join-name">Your name</label>
        <input id="join-name" type="text" maxlength="40" placeholder="e.g. Alex" bind:value={joinName} />
      </div>
      <div class="field">
        <label for="join-code">Event code</label>
        <input
          id="join-code"
          class="code-input"
          type="text"
          maxlength="8"
          placeholder="XXXXXXXX"
          bind:value={joinCode}
          on:input={onJoinCodeInput}
        />
      </div>
      <button class="btn primary" on:click={submitJoin} disabled={joining}>
        {joining ? 'Joining…' : 'Join event'}
      </button>
    </div>
    <p class="foot-note">Ask the host for the 8-character code or scan their QR code</p>
    <p class="foot-note">Organising this event? <button type="button" class="link-btn" on:click={goManage}>Manage it →</button></p>
  {/if}
</div>

<style>
  .page {
    max-width: 520px;
    margin: 0 auto;
    padding: 24px 18px 64px;
  }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 22px; }
  .myevents { font-size: 0.82rem; color: var(--accent); text-decoration: none; font-weight: 700; white-space: nowrap; }
  .myevents:hover { text-decoration: underline; }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 9px;
    font-weight: 800;
    text-decoration: none;
  }

  /* Tabs */
  .tabs {
    display: flex;
    gap: 6px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 5px;
    margin-bottom: 18px;
  }
  .tab {
    flex: 1;
    padding: 11px;
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-weight: 700;
    font-size: 0.9rem;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-family: var(--font);
  }
  .tab.active {
    background: var(--accent);
    color: var(--accent-ink, #111);
  }

  /* Cards */
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    margin-bottom: 16px;
  }
  .card-title {
    font-weight: 800;
    font-size: 1.05rem;
    margin-bottom: 16px;
  }

  /* Fields */
  .field {
    margin-bottom: 16px;
  }
  .field:last-child {
    margin-bottom: 0;
  }
  .field-row {
    display: flex;
    gap: 12px;
  }
  .field-row .field {
    flex: 1;
  }
  label {
    display: block;
    font-size: 0.8rem;
    color: var(--text-muted);
    margin-bottom: 6px;
  }
  .hint {
    color: var(--text-muted);
    font-size: 0.75em;
  }
  input,
  select,
  textarea {
    width: 100%;
    padding: 11px 13px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.95rem;
    font-family: var(--font);
  }
  textarea {
    resize: vertical;
    min-height: 56px;
    line-height: 1.45;
  }
  textarea::placeholder { color: var(--text-muted); }
  input:focus,
  select:focus,
  textarea:focus {
    outline: 2px solid var(--accent);
    border-color: transparent;
  }

  /* Slug input */
  .slug-row {
    display: flex;
    align-items: stretch;
  }
  .slug-prefix {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-right: none;
    border-radius: var(--radius-sm) 0 0 var(--radius-sm);
    padding: 11px 10px;
    font-size: 0.78rem;
    color: var(--text-muted);
    white-space: nowrap;
    display: flex;
    align-items: center;
  }
  .slug-input {
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
    font-family: var(--font-mono);
    font-size: 0.9rem;
  }
  .slug-feedback {
    font-size: 0.75rem;
    margin-top: 5px;
    min-height: 1em;
  }
  .slug-feedback.ok {
    color: var(--success);
  }
  .slug-feedback.err {
    color: var(--danger);
  }
  .slug-feedback.muted {
    color: var(--text-muted);
  }

  /* Toggle */
  .toggle-field {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .toggle-field label:first-child {
    margin-bottom: 0;
  }
  .tf-label { display: flex; align-items: center; gap: 7px; }
  .tf-label label { margin-bottom: 0; }
  .help-tip {
    position: relative; flex: none; width: 18px; height: 18px; border-radius: 50%;
    border: 1px solid var(--border); background: transparent; color: var(--text-muted);
    font-size: 0.72rem; font-weight: 700; cursor: help; padding: 0;
    display: inline-flex; align-items: center; justify-content: center;
  }
  .help-tip .tip {
    position: absolute; bottom: 135%; left: 0; width: 230px;
    background: var(--surface-2, #1b1b1b); color: var(--text); border: 1px solid var(--border);
    border-radius: 8px; padding: 9px 11px; font-size: 0.75rem; font-weight: 400; line-height: 1.45;
    text-align: left; opacity: 0; pointer-events: none; transition: opacity .15s ease; z-index: 30;
    box-shadow: 0 8px 24px rgba(0,0,0,.3);
  }
  .help-tip:hover .tip, .help-tip:focus .tip { opacity: 1; }
  .toggle {
    position: relative;
    display: inline-block;
    width: 46px;
    height: 26px;
    flex-shrink: 0;
  }
  .toggle input {
    position: absolute;
    opacity: 0;
    width: 0;
    height: 0;
  }
  .toggle-track {
    position: absolute;
    inset: 0;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    transition: background 0.15s;
  }
  .toggle-track::before {
    content: '';
    position: absolute;
    width: 18px;
    height: 18px;
    left: 3px;
    top: 3px;
    background: var(--text-muted);
    border-radius: 50%;
    transition: transform 0.15s, background 0.15s;
  }
  .toggle input:checked + .toggle-track {
    background: var(--accent);
    border-color: var(--accent);
  }
  .toggle input:checked + .toggle-track::before {
    transform: translateX(20px);
    background: #111;
  }

  /* Aspect ratio checkboxes */
  .aspect-options {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .aspect-opt {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 0;
    padding: 8px 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
    color: var(--text);
    cursor: pointer;
  }
  .aspect-opt input {
    width: auto;
    padding: 0;
    accent-color: var(--accent);
  }
  .pro-tag, .pack-tag {
    background: var(--accent);
    color: var(--accent-ink, #111);
    font-size: 0.62rem;
    font-weight: 800;
    padding: 1px 5px;
    border-radius: 4px;
    text-transform: uppercase;
    margin-left: 4px;
  }
  .field-hint { font-size: 0.76rem; color: var(--text-muted); margin: 6px 0 0; }
  .pack-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 600; }
  .pack-toggle input { width: 18px; height: 18px; }

  /* Reveal mode cards */
  .reveal-options {
    display: grid;
    gap: 10px;
  }
  .reveal-opt {
    display: block;
    width: 100%;
    text-align: left;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 14px;
    color: var(--text);
    font-family: var(--font);
    font-size: 0.92rem;
    font-weight: 700;
    cursor: pointer;
  }
  .reveal-opt.selected {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--surface));
  }
  .reveal-opt .opt-icon {
    font-size: 1.2rem;
    margin-right: 6px;
  }
  .reveal-opt small {
    display: inline-block;
    margin-top: 4px;
    color: var(--text-muted);
    font-weight: 400;
    font-size: 0.78rem;
  }

  /* Code input */
  .code-input {
    text-transform: uppercase;
    letter-spacing: 0.2em;
    font-size: 1.3rem;
    text-align: center;
    font-family: var(--font-mono);
  }

  /* Buttons */
  .btn {
    display: inline-block;
    width: 100%;
    padding: 13px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font-weight: 700;
    font-size: 0.95rem;
    cursor: pointer;
    font-family: var(--font);
    text-align: center;
    text-decoration: none;
  }
  .btn.primary {
    background: var(--accent);
    color: var(--accent-ink, #111);
  }
  .btn.secondary {
    background: var(--surface-2);
    color: var(--text);
    border-color: var(--border);
  }
  .btn:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .btn.block {
    display: block;
  }
  .foot-note {
    color: var(--text-muted);
    text-align: center;
    font-size: 0.8rem;
    margin-top: 8px;
  }
  .link-btn {
    background: none; border: none; padding: 0; cursor: pointer;
    color: var(--accent); font-weight: 700; font-family: var(--font);
    font-size: inherit; text-decoration: underline;
  }
  .quote { margin-top: 14px; padding: 14px; border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--accent) 10%, var(--surface)); border: 1px solid var(--border); }
  .quote-price { display: flex; align-items: baseline; gap: 8px; }
  .quote-price .amount { font-size: 1.7rem; font-weight: 850; }
  .quote-price .amount.free { color: var(--success); }
  .quote-price .per { font-size: 0.75rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .quote-detail { font-size: 0.85rem; color: var(--text-muted); margin-top: 4px; }
  .quote-lines { list-style: none; margin: 4px 0 0; padding: 0; }
  .quote-lines li { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; }
  .quote-lines .incl { color: var(--success); font-weight: 700; }
  /* Free-at-this-tier price: struck through, green — "you'd pay this, but it's free right now". */
  .was { color: var(--success); font-weight: 700; text-decoration: line-through; }
  .pack-tag.free { background: var(--success); }
  .quote-allfree { font-size: 0.78rem; color: var(--text-muted); margin: 8px 0 0; }
  .quote-note { font-size: 0.78rem; color: var(--accent-dark); margin-top: 6px; }

  /* Collapsible advanced settings */
  .more {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    margin-bottom: 16px;
    overflow: hidden;
  }
  .more > summary {
    list-style: none;
    cursor: pointer;
    padding: 16px 20px;
    font-weight: 800;
    font-size: 1.05rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .more > summary::-webkit-details-marker { display: none; }
  .more > summary .sum-hint { font-size: 0.75rem; font-weight: 500; color: var(--text-muted); }
  .more > summary::after { content: '▾'; color: var(--text-muted); transition: transform 0.15s; }
  .more[open] > summary::after { transform: rotate(180deg); }
  .more .card { border: none; border-top: 1px solid var(--border); border-radius: 0; margin: 0; }
</style>
