<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { goto } from '$app/navigation';
  import { saveDraft, readDraft, clearDraft } from '$lib/eventDraft';

  // ── The guided path ────────────────────────────────────────────────────────
  //
  // One decision at a time, in the order a host actually makes them. Not a new form: every field,
  // binding, validation, slug check, live price and the create call below are the SAME ones the
  // full form uses — this only controls which of them is on screen. Two presentations, one source
  // of truth, so they cannot drift apart.
  //
  // And not a gate. "See everything at once" is on the first step, because a host creating their
  // fourth event does not want to be walked anywhere, and the moment a wizard cannot be escaped it
  // stops being help. That is the same lesson the poster gallery learned: a starting point, never
  // a toll booth.
  let guided = true;
  let step = 1;
  const LAST_STEP = 5;
  // "Your guests" is its own step rather than another row inside Advanced settings. It is a
  // decision about what happens AFTER the event — who gets the photos and what they are told —
  // and folding it in with custom URLs and frame shapes is how it would never be read.
  // Step 3 is named for what it gives rather than for what it holds. It used to be "The details",
  // which is a filing cabinet, and everything the product actually sells was inside it behind a
  // disclosure marked "Advanced settings" — a label that reads as "not for you" to exactly the host
  // who would have enjoyed the thing.
  const STEP_TITLES = ['Your event', 'When it runs', 'Make it yours', 'Your guests', 'Ready'];

  // Step 1 is the only one that can be incomplete in a way that matters — everything else has a
  // working default. Blocking "Next" on an empty name beats creating "Untitled".
  $: canAdvance = !(step === 1 && sub === 1) || !!name.trim();
  // Two of the five steps ask more than one thing, and both used to ask it all on one screen. They
  // are paged instead, behind the same Next button, so the strip above still counts five steps and
  // nobody has to learn a second kind of progress.
  //
  // A plain function rather than only a reactive value, because going BACKWARDS needs the count of
  // the step being entered, and a `$:` has not recomputed at the moment the assignment runs.
  //
  // `paid` is a PARAMETER, not read from scope. Svelte tracks what a reactive statement mentions
  // directly, not what a function it calls happens to read — so `$: subCount = subsFor(step)` only
  // ever recomputed when `step` changed, and billing arrives from /api/config after first paint.
  // The count stayed at its pre-billing value and step 1 silently lost its guests-and-price page.
  const subsFor = (st: number, paid: boolean): number =>
    st === 1 ? (paid ? 3 : 2)   // without billing there is no guest/price page to show
    : st === 4 ? 3
    : 1;
  $: subCount = subsFor(step, !!billing?.billingEnabled);
  let sub = 1;
  // billing arrives from /api/config after first paint; a host standing on a page that just stopped
  // existing must not be stranded there.
  $: if (sub > subCount) sub = subCount;

  function nextStep() {
    if (!canAdvance) {
      // Take them to the one thing standing in the way, rather than absorbing the press silently.
      const el = document.getElementById('event-name') as HTMLInputElement | null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.focus();
      return;
    }
    if (sub < subCount) { sub += 1; return; }
    if (step < LAST_STEP) { step += 1; sub = 1; }
  }
  function prevStep() {
    if (sub > 1) { sub -= 1; return; }
    if (step > 1) { step -= 1; sub = subsFor(step, !!billing?.billingEnabled); }
  }
  /** Jump straight back to a finished step from the strip. Backwards only — a step ahead of this
   *  one has not been filled in, and Next is where its checks live. */
  function goToStep(n: number) {
    if (n >= step || n < 1) return;
    step = n;
    sub = 1;
  }

  import Toggle from '$lib/components/Toggle.svelte';
  import TimeField from '$lib/components/TimeField.svelte';
  import { getConfig, getMe, api } from '$lib/api';
  import { track } from '$lib/analytics';
  import { createEvent, joinEvent, REVEAL_CUSTOM, REVEAL_TICK_MS,
           ceilToRevealTick, zonedWallTimeToMs, msToZonedWallTime, revealMomentLabel } from '$lib/events';
  import { GUEST_DELIVERY_DEFAULT, GUEST_DELIVERY_OPTIONS, guestReleaseAt, releaseDateKnown,
           reminderCanFire, reminderFiresAt, revealInstant, scheduledSendIssue, scopeFor,
           type GuestDelivery, type GuestSendScope } from '$lib/guestDelivery';
  import { EVENT_TYPES, DEFAULT_COUNT, packFor, pickChallenges, tickFor, varySets } from '$lib/challenges';
  import { saveSession } from '$lib/session';
  import { showToast } from '$lib/toast';
  import Logo from '$lib/components/Logo.svelte';
  import type { AppOptions, BillingConfig, BillingQuote } from '$lib/types';
  import { postJson } from '$lib/api';
  import SearchableSelect from '$lib/components/SearchableSelect.svelte';
  import { aspectValue } from '$lib/frameShape';
  import { durationAddonCents, featuresFreeAt, framePackPrice, guestBaseCents, priceAria,
           priceTag, retentionChoices, retentionIncludedDays, retentionLabel, retentionPrice,
           retentionFor,
           shotsAddonCents, shotsPrice, videoAddonCents, videoPrice } from '$lib/featureUpsell';
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
  // Thin bindings over $lib/featureUpsell. The rules themselves used to live here, in a component
  // no test can import, which is how a feature waiver and a retention allowance that run in
  // OPPOSITE directions were both being maintained by eye. `billing` is closed over here and passed
  // in there — the module has no business knowing about this component's state.
  //
  // Every one of these takes `guests` as an EXPLICIT argument for the same reason the moment labels
  // further down take `tz`: a template expression re-runs when its arguments change, not when a
  // variable it closes over changes. Passing maxGuests in is what makes every price on the features
  // step flip gifted↔charged the instant the guest tier moves.
  const freeAtSize = (guests: number) => featuresFreeAt(billing, guests);
  const shotsAddon = (shots: number) => shotsAddonCents(billing, shots);
  const videoBase = (seconds: number) => videoAddonCents(billing, seconds);
  const durationAddon = (hours: number) => durationAddonCents(billing, hours);
  const guestLabel = (n: number, txt: string) => {
    if (!billing?.billingEnabled) return txt;
    const c = guestBaseCents(billing, n);
    return c === 0 ? `${txt} — free` : `${txt} — ${money(c)}`;
  };
  $: retentionIncluded = retentionIncludedDays(billing, Number(maxGuests));
  $: retentionOptions = retentionChoices(billing, Number(maxGuests));

  // ── The drawings on the features step ─────────────────────────────────────
  //
  // Drawn in SVG and CSS boxes rather than fetched as images. This step is read on a phone, often
  // on venue wifi, and four <img> tags here would be four more things to fail — leaving four blank
  // holes exactly where the explanation was supposed to be. They also take every colour from the
  // theme variables, so one set of markup answers light and dark instead of two sets of files.

  /** The shot allowance drawn out, one dot per shot: the included ones in grey, the ones the host
   *  has added in gold, and the rest of what is on offer left as faint outlines.
   *
   *  The whole grid is always drawn, not just the chosen count. Drawing only the count meant the
   *  default sat on screen as a single row of twelve small dots, which reads as a dotted rule and
   *  not as a quantity — there was nothing for it to be a quantity OF. Against the full grid the
   *  same twelve are visibly a quarter of what the evening could have. */
  $: shotDots = (() => {
    const perRow = 12;
    const offered = (options?.shotsPerPerson ?? []).map((s) => Number(s.value));
    const most = Math.max(...offered, Number(maxPhotos) || 0, 1);
    const chosen = Math.max(Number(maxPhotos) || 0, 0);
    const included = billing?.shotsFree ?? 12;
    const rows = Math.max(Math.ceil(most / perRow), 1);
    const top = (40 - rows * 6.5) / 2 + 3.25;
    return Array.from({ length: most }, (_, i) => ({
      cx: (i % perRow) * 6.5 + 3.25,
      cy: Math.floor(i / perRow) * 6.5 + top,
      state: i >= chosen ? 'spare' : i >= included ? 'extra' : 'base',
    }));
  })();

  /** A frame tile at the shape's REAL proportions, from the same ratio the camera crops to. This
   *  drawing is information rather than decoration: nobody can picture "4:5", and everybody can see
   *  a box. 'full' has no ratio at all (it is the absence of a crop), so it borrows a phone's own
   *  3:4 and is drawn dashed instead of pretending to be a fifth shape. */
  const shapeStyle = (value: string) => `aspect-ratio: ${aspectValue(value) ?? 0.75}`;
  /** "Tall · 9:16" → "Tall". The ratio is already on screen as the box itself. */
  const shapeName = (label: string) => label.split('·')[0].trim();
  /** Lit = a shape guests can actually choose on this event. `packOn` and `sel` are arguments so
   *  the tiles relight the moment either changes. */
  const shapeLit = (value: string, packOn: boolean, sel: Record<string, boolean>) =>
    (billing?.billingEnabled ? (packOn || value === '1:1') : !!sel[value]);

  $: framePrice = framePackPrice(billing, Number(maxGuests));
  $: frameTag = priceTag(framePrice, money);

  // ── Create form state ──
  let name = '';
  // Nothing chosen is a real answer, not a missing one. Every event made before this question
  // existed has no type, and one made by skipping it has to BE that event — so this stays null and
  // is left out of the create body entirely rather than sent as an empty string.
  let eventType: string | null = null;
  // Only ever on screen once a type is chosen. Not reset when the type changes: a host who took the
  // list off did not ask for it back because they moved from Wedding to Engagement.
  // OFF. It changes what a guest sees — a list of shots to hunt for appears in their camera — and
  // a default that alters somebody else's screen is not a default we get to make. The host opts in.
  let seedMissions = false;
  /** Several cards instead of one, so guests are not all hunting the same five shots. Off for the
   *  same reason seedMissions is: it changes what a guest is handed. */
  let trickVariety = false;
  /** How many cards "change it up" makes. Three is enough for a room to feel different without
   *  making the host's print job a chore — and varySets guarantees the must-haves are on all of
   *  them, so nobody's cake goes unphotographed because of which table got which card. */
  const VARIETY_SETS = 3;
  let slug = '';
  let slugFeedback: { text: string; cls: 'ok' | 'err' | 'muted' } | null = null;
  let slugCheckTimer: ReturnType<typeof setTimeout> | undefined;

  let startDate = '';
  let todayStr = '';   // earliest selectable date (today) — the input's min
  let startTime = '';
  let durationHours: number | string = '';
  let maxPhotos: number | string = '';
  let retentionDays = 7;
  // Two real shots from the pack this event type would actually get, so the example is the thing
  // itself rather than a description of it. Deterministic: pickChallenges with no mood and no
  // shuffle returns the pack in order, so the words do not reshuffle under a host reading them.
  $: trickExamples = eventType
    ? pickChallenges(packFor(eventType), { count: 2, allowVideo: false }).map((c) => c.text)
    : [];

  /** Has the host actually picked a retention length? Until they have, the number on screen belongs
   *  to the tier, not to them, and must be free to go back down when the tier does. */
  let retentionTouched = false;
  // Below the declaration, not beside retentionIncluded above, because `$: x = …` on a variable
  // declared later is a use-before-declaration in TypeScript.
  // Retention follows the tier until the host says otherwise — see retentionFor(). A bare
  // "raise it to the allowance" ratchet lived here and could not be undone: free → paid → free left
  // the paid tier's month selected on a tier that CHARGES for it.
  $: retentionDays = retentionFor(retentionDays, retentionIncluded, retentionTouched);
  let timezone = '';
  // Held separately from `timezone` so a drift between the two can be shown. A silent mismatch
  // means the event starts at the wrong time and nobody finds out until the day.
  let deviceTz = '';
  // Dismissal is remembered against the zone it was shown FOR, so waving it away once does not
  // hide a genuinely different mismatch later in the same session.
  let tzDismissedFor = '';
  $: tzMismatch = !!deviceTz && !!timezone && deviceTz !== timezone && tzDismissedFor !== timezone;
  /** Just the city — "Australia/Brisbane" inside a button is mostly prefix. */
  const tzShort = (z: string) => (z || '').split('/').pop()?.replace(/_/g, ' ') || z;
  // The picker lives inside the collapsed disclosure on step 3, so "Change" has to get to that
  // step, open the panel and take the host there.
  //
  /** Is the timezone picker showing on the "When" step? */
  let tzOpen = false;
  // It used to live in step 3's collapsed "Other settings", so this button had to carry the host
  // THERE — `if (guided) step = 3` — to reach it. That was a one-way trip: the step strip then
  // marked step 2 finished, and Next carried on to step 4, so somebody who only wanted to check
  // what their times meant was quietly moved two steps past the form they were filling in.
  //
  // A control belongs on the page whose words refer to it. It opens here now and nothing moves.
  async function openTimezone() {
    tzOpen = true;
    await tick();
    const el = document.querySelector('#timezone');
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    (el?.querySelector('input') as HTMLInputElement | null)?.focus();
  }
  // The start rendered the way GUESTS will see it — in the event's zone, not the browser's.
  $: startPreview = (() => {
    if (!startDate || !startTime || !timezone) return '';
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium', timeStyle: 'short', timeZone: timezone, timeZoneName: 'short',
      }).format(new Date(`${startDate}T${startTime}`));
    } catch { return ''; }
  })();
  $: wantsCustomReveal = revealMode === 'at_end' && String(revealDelayHours) === REVEAL_CUSTOM;
  // Where the event ends, so "custom" can open on a sensible moment instead of an empty box.
  $: eventEndsAt = (startDate ? new Date(`${startDate}T${startTime || '00:00'}`).getTime() : Date.now())
    + (Number(durationHours) || 24) * 3_600_000;
  /** The instant the host has currently typed, and the instant they will actually get. */
  $: chosenRevealAt = (wantsCustomReveal && revealDate && revealTime && timezone)
    ? zonedWallTimeToMs(revealDate, revealTime, timezone) : null;
  $: actualRevealAt = chosenRevealAt === null ? null : ceilToRevealTick(chosenRevealAt);
  $: revealMoved = actualRevealAt !== null && actualRevealAt !== chosenRevealAt;

  // ── Guest delivery ────────────────────────────────────────────────────────
  //
  // The event's end as an INSTANT, read in the event's own zone. `eventEndsAt` above reads the
  // start through the browser's clock, which is near enough to seed a date picker and nowhere near
  // enough to decide whether a 24-hour gap exists: a host in Sydney setting up a Perth event is two
  // hours out, and the reminder toggle would then appear or vanish for a reason that is not theirs.
  $: guestEndsAt = (startDate
    ? (zonedWallTimeToMs(startDate, startTime || '00:00', timezone || 'UTC')
        ?? new Date(`${startDate}T${startTime || '00:00'}`).getTime())
    : Date.now()) + (Number(durationHours) || 24) * 3_600_000;
  $: guestRevealAt = revealInstant({
    revealMode, endsAt: guestEndsAt,
    customAt: wantsCustomReveal ? actualRevealAt : null,
    delayHours: wantsCustomReveal ? 0 : (parseInt(String(revealDelayHours), 10) || 0),
  });
  $: guestChosenSendAt = (guestDelivery === 'scheduled' && guestSendDate && guestSendTime && timezone)
    ? zonedWallTimeToMs(guestSendDate, guestSendTime, timezone) : null;
  $: guestSendAt = guestChosenSendAt === null ? null : ceilToRevealTick(guestChosenSendAt);
  $: guestSendMoved = guestSendAt !== null && guestSendAt !== guestChosenSendAt;
  $: guestSendIssue = guestDelivery === 'scheduled' ? scheduledSendIssue(guestSendAt, guestRevealAt) : null;
  $: guestReleaseMs = guestReleaseAt(guestDelivery, guestRevealAt, guestSendAt);
  // "Photos are live" was never a third, separate decision — it is the MECHANISM of the two
  // automatic delivery modes. sweepLive is gated on events.guest_mail_live, and guestLinkAt names a
  // moment only for all_on_reveal and scheduled. So on those two, switching it off silently
  // cancelled the delivery the host had just chosen — "Everything, as soon as photos are revealed"
  // and then nothing ever sent — and on the two manual modes it did nothing at all, because the
  // host presses the button themselves. It has no honest off state, so it is shown locked, saying
  // which of the two it is.
  $: guestDeliveryLabel = (GUEST_DELIVERY_OPTIONS.find((o) => o.value === guestDelivery)?.label ?? '').toLowerCase();
  $: guestLiveAutomatic = guestDelivery === 'all_on_reveal' || guestDelivery === 'scheduled';
  $: guestReminderOffered = reminderCanFire(guestEndsAt, guestReleaseMs);
  $: guestThanksDated = releaseDateKnown(guestEndsAt, guestReleaseMs);
  // Labels rather than raw instants in the markup: revealMomentLabel takes a number, and every one
  // of these can legitimately be null (a manual reveal, a half-typed date), so the null is answered
  // once here instead of with a fallback epoch at each call site.
  //
  // `tz` is an EXPLICIT argument for the same reason the price labels above take `guests`: a
  // reactive statement re-runs when its arguments change, not when a variable the helper closes
  // over changes — so with the zone captured instead of passed, changing the event's timezone would
  // leave every one of these moments reading in the old one.
  const moment = (ms: number | null, tz: string) => (ms === null ? '' : revealMomentLabel(ms, tz));
  $: guestRevealLabel = moment(guestRevealAt, timezone);
  $: guestSendLabel = moment(guestSendAt, timezone);
  $: guestReleaseLabel = moment(guestReleaseMs, timezone);
  $: guestReminderLabel = moment(reminderFiresAt(guestEndsAt, guestReleaseMs), timezone);
  $: guestReminderWhyNot = guestReleaseMs === null
    ? "you haven't fixed a moment for the photos to go out, so there's nothing to count back from."
    : 'your photos go out less than a day after the event ends, so there is no day before to send it on.';

  // Seed the picker from the end of the event the first time it is opened. A date box that starts
  // blank makes the host do arithmetic the page already knows the answer to; one that starts a year
  // ago (the browser's idea of an empty date) is worse.
  function onRevealDelayChange() {
    // Reads the bound value, NOT the `wantsCustomReveal` derived from it: reactive statements are
    // recomputed on the next flush, so inside a change handler that flag is still describing the
    // option the host just moved away from — and the picker would open empty every time.
    if (String(revealDelayHours) !== REVEAL_CUSTOM || revealDate) return;
    const w = msToZonedWallTime(ceilToRevealTick(eventEndsAt), timezone || 'UTC');
    if (w) { revealDate = w.date; revealTime = w.time; }
  }

  /** Seed the send picker from the reveal the first time "At a time I choose" is opened.
   *
   *  Same reason the reveal picker seeds itself: an empty date box asks the host to do arithmetic
   *  the page has already done, and the browser's idea of an empty date is a year ago. The reveal
   *  is the earliest legal answer, so it is also the one that needs no correcting. */
  function onGuestDeliveryPick(v: GuestDelivery) {
    guestDelivery = v;
    if (v !== 'scheduled' || guestSendDate) return;
    const w = msToZonedWallTime(ceilToRevealTick(guestRevealAt ?? guestEndsAt), timezone || 'UTC');
    if (w) { guestSendDate = w.date; guestSendTime = w.time; }
  }

  let blurb = '';
  let allowDownloads = true;
  let noFlash = false;
  let revealMode = 'at_end';   // default: hide until the event ends (overridden by config on load)
  let revealDelayHours: number | string = 0;
  // Only meaningful when the delay control is on REVEAL_CUSTOM. Wall-clock strings, never an epoch:
  // they mean what they say in the EVENT's timezone, and the server is what turns them into an
  // instant. Sending an epoch computed here would quietly mean "in whatever zone this phone is in".
  let revealDate = '';
  let revealTime = '';
  let moderationEnabled = false;
  // ── How the guests get the photos ──
  // Every default here is the behaviour an event already has, so an untouched wizard creates the
  // same event it always did.
  let guestDelivery: GuestDelivery = GUEST_DELIVERY_DEFAULT;
  let guestSendScope: GuestSendScope = 'all';
  // Wall-clock strings for the same reason the reveal uses them: they mean what they say in the
  // EVENT's zone, and an epoch computed here would quietly mean "in whatever zone this phone is in".
  let guestSendDate = '';
  let guestSendTime = '';
  let guestMailThanks = true;
  let guestMailReminder = false;
  let guestMailLive = true;
  let selectedAspects: Record<string, boolean> = {};

  let timezones: string[] = [];
  let creating = false;
  let loggedIn = false;
  let draftRestored = false;   // show a "My events" shortcut for signed-in hosts

  // Creating an event REQUIRES an account (the server answers 401), but the form was fully usable
  // signed out — so a host could configure everything and lose the lot to a "Not signed in" toast.
  // The form stays open, because filling it in is what makes someone want an account; what changes
  // is that the draft survives the trip through sign-in.
  //
  // localStorage, NOT sessionStorage. sessionStorage was the wrong call: signing up sends you to
  // "check your email", and the verification link opens a NEW TAB — where sessionStorage does not
  // exist. The draft has to outlive the tab that created it, so it is stamped and expires instead.
  const DRAFT_FIELDS = () => ({
    name, slug, startDate, startTime, durationHours, maxPhotos, retentionDays, retentionTouched, timezone,
    maxGuests, videoSeconds, framePackOn, allowDownloads, noFlash, revealMode,
    revealDelayHours, revealDate, revealTime, moderationEnabled, eventType, seedMissions, trickVariety,
    guestDelivery, guestSendScope, guestSendDate, guestSendTime,
    guestMailThanks, guestMailReminder, guestMailLive,
  });
  function restoreDraft() {
    const d = readDraft();
    if (!d) return false;
    ({ name, slug, startDate, startTime, durationHours, maxPhotos, retentionDays, retentionTouched, timezone,
       maxGuests, videoSeconds, framePackOn, allowDownloads, noFlash, revealMode,
       revealDelayHours, revealDate, revealTime, moderationEnabled, eventType, seedMissions, trickVariety,
       guestDelivery, guestSendScope, guestSendDate, guestSendTime,
       guestMailThanks, guestMailReminder, guestMailLive } = { ...DRAFT_FIELDS(), ...d });
    return true;
  }
  /** Signed out: keep what they typed, then send them to sign in and come straight back. */
  function goSignIn(path: '/login' | '/signup') {
    saveDraft(DRAFT_FIELDS());
    goto(`${path}?next=/app`);
  }

  // ── Join form state ──
  let joinName = '';
  let joinCode = '';
  let joining = false;

  const pad = (n: number) => String(n).padStart(2, '0');

  onMount(async () => {
    try { loggedIn = !!(await getMe()).user; } catch { /* anon */ }
    // Coming back from sign-in: put their event back the way they left it.
    if (restoreDraft()) draftRestored = true;
    // Default the start to midnight at the beginning of the following day — events are almost
    // always planned ahead, and this avoids accidentally starting one mid-creation.
    const tm = new Date();
    todayStr = `${tm.getFullYear()}-${pad(tm.getMonth() + 1)}-${pad(tm.getDate())}`;   // today = earliest allowed
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
    deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    timezone = deviceTz;

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

  /**
   * Hand the host the trick list they would have got by opening the editor and saving what it
   * offered: one card, the pack's first five, that type's default mark.
   *
   * Deliberately fire-and-forget. The event already exists by the time this runs and IT is the
   * thing that matters — a list that never seeded is two taps to rebuild from the admin page,
   * whereas awaiting this would put another round trip between the host and their event, and a
   * rejection would land in submitCreate's catch and tell them the event failed when it plainly
   * did not.
   *
   * keepalive is what makes it survive the paid path: that branch sets window.location to Stripe a
   * moment later, and an ordinary fetch is cancelled on unload — so the PAYING host would be the
   * one who never got a list.
   */
  function seedMissionList(code: string, organizerCode: string, type: string): void {
    try {
      // allowVideo mirrors the editor's own per-event gate rather than assuming, so this is the
      // same list the editor would have produced for this event rather than a near-miss.
      const pack = packFor(type);
      const opts = { count: DEFAULT_COUNT, allowVideo: videoSeconds > 0 };
      // varySets is the admin editor's own helper, not a second implementation: every card shares a
      // core of the pack's must-haves and only the remainder varies, so coverage of the moments a
      // host would actually regret missing does not come down to which table got which card.
      const sets = trickVariety
        ? varySets(pack, { ...opts, sets: VARIETY_SETS })
            .map((st) => ({ ...st, items: st.items.map((c) => ({ id: c.id, text: c.text })) }))
        : [{ key: 'a', label: 'Card A',
             items: pickChallenges(pack, opts).map((c) => ({ id: c.id, text: c.text })) }];
      void fetch(`/api/events/${encodeURIComponent(code)}/challenges`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-organizer-code': organizerCode },
        credentials: 'same-origin',
        keepalive: true,
        body: JSON.stringify({
          eventType: type,
          tick: tickFor(type),
          challenges: { sets },
        }),
      }).catch(() => { /* their list, not their event — the admin page rebuilds it in two taps */ });
    } catch { /* as above: nothing here may reach the host as a failed creation */ }
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
    // Caught here rather than at the server's 400: the reveal control can be several steps back by
    // now, and "Pick the date and time" beside the box beats a toast about a field you cannot see.
    if (wantsCustomReveal && actualRevealAt === null) {
      showToast('Pick the date and time for the reveal', true);
      return;
    }
    // Same reasoning, one step further on: a send time is several taps back by the time Create is
    // pressed, and a scheduled send that lands before the reveal would email every guest a link to
    // a gallery that is still shut.
    if (guestSendIssue === 'missing') {
      showToast('Pick the date and time to send your guests the photos', true);
      return;
    }
    if (guestSendIssue === 'before-reveal') {
      showToast('Your send time is before the photos are revealed — pick a later one', true);
      return;
    }

    const aspectRatios = requestedAspects();
    // Rounded onto the same tick the reveal runs on, so "starts 7:15, ends 11:15, reveals 11:15"
    // holds exactly rather than drifting by the minutes nobody can act on.
    // Resolved in the EVENT's timezone, not the browser's. Creating a Perth event from Sydney used
    // to book it two hours early, because `new Date('…T20:00')` means 20:00 wherever the browser is
    // — and the server then formats it back in the event zone, so the host was shown a start time
    // they had never typed. Falls back to the browser's reading only if the zone is unusable.
    const startsAt = startDate
      ? ceilToRevealTick(
          zonedWallTimeToMs(startDate, startTime || '00:00', timezone || 'UTC')
            ?? new Date(`${startDate}T${startTime || '00:00'}`).getTime(),
        )
      : Date.now();

    creating = true;
    try {
      track('event_create_started');
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
        // 'custom' on purpose — the server reads it as "the date and time below", and any number
        // here would be indistinguishable from an hour preset.
        revealDelayHours: wantsCustomReveal ? REVEAL_CUSTOM : parseInt(String(revealDelayHours), 10) || 0,
        ...(wantsCustomReveal ? { revealDate, revealTime } : {}),
        moderationEnabled,
        guestDelivery,
        // Derived, never the raw chip: two of the four options ARE a scope, so sending whatever the
        // host last picked alongside them would store a scope that contradicts the words on screen.
        guestSendScope: scopeFor(guestDelivery, guestSendScope),
        ...(guestDelivery === 'scheduled' ? { guestSendAt } : {}),
        guestMailThanks,
        // Never sent as on when the gap cannot carry it: the host was not shown the switch, so they
        // did not choose it, and a setting nobody chose must not be stored as theirs.
        guestMailReminder: guestReminderOffered && guestMailReminder,
        // Derived, not the raw toggle: the control is locked to the delivery mode, so storing
        // anything else would let the sweep and the screen disagree about the same event.
        guestMailLive: guestLiveAutomatic,
        timezone,
        aspectRatios,
        maxGuests,
        videoSeconds,
        retentionDays,
        // Omitted, not nulled, when the host skipped the question — an unanswered question should
        // not appear in the request at all.
        ...(eventType ? { eventType } : {}),
      });

      // The event exists now, so the draft has done its job — cleared here rather than when it was
      // read, so two tabs can never race each other for it. This covers both branches below: a
      // paid event is already created (just unpaid) before we leave for Stripe.
      clearDraft();

      // Before the branch below, not after: the paid path leaves for Stripe on its next line and
      // never returns to this function.
      if (eventType && seedMissions) seedMissionList(data.joinCode, data.organizerCode, eventType);

      // Paid tiers (billing on) → straight to Stripe Checkout; the event is created
      // unpaid/inactive and the webhook flips it to paid on success.
      if (billing?.billingEnabled && quote?.requiresPayment) {
        // Recorded BEFORE leaving for Stripe. The gap between this and checkout_returned{paid:true}
        // is checkout abandonment, which nothing currently measures.
        track('checkout_started', { cents: quote?.amountCents ?? 0, guests: maxGuests ?? 0 }, data.joinCode);
        const { url } = await postJson<{ url: string }>('/api/billing/checkout', {
          joinCode: data.joinCode,
          organizerCode: data.organizerCode,
        });
        window.location.href = url;
        return;
      }

      // Free event → straight to the manager dashboard, which shows a welcome modal
      // (QR + share link) on ?created=1. The organizer code travels in the hash.
      track('event_created', { paid: false }, data.joinCode);
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

<main class="page">
  <!-- The tabs below are the visual heading, so this names the page for a screen reader without
       putting a title on a design that does not have one. -->
  <h1 class="sr-only">Create or join an event</h1>
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
    {#if guided}
      <!-- Where you are, and how much is left. A bare "Next" with no sense of length is what makes
           a wizard feel like an interrogation. -->
      <!-- The running total, on every step.
           It used to live inside step 1 with the guest tier, which was fine as one long form and
           wrong the moment the form became steps: duration is a PAID add-on chosen on step 2, so a
           host could add money to their event and watch nothing happen. A price that only appears
           on the page where you happened to start is not a price, it is a surprise later. -->
      <!-- Shown on a free event too, not only once there is something to charge. A total that
           appears the moment you cost something and is silent otherwise teaches the host that the
           row means "bad news"; a standing "Free" is the same promise kept, and it is the only
           place the gift is ever counted up. -->
      {#if quote}
        <div class="wiz-total">
          <span class="wt-l">Running total</span>
          {#if quote.requiresPayment}
            <span class="wt-v">{money(quote.amountCents)}</span>
            <span class="wt-n">one-off · full breakdown on the last step</span>
          {:else}
            <span class="wt-v free">Free</span>
            <span class="wt-n">nothing to pay — everything you've picked is included</span>
          {/if}
        </div>
      {/if}

      <div class="steps" aria-label="Step {step} of {LAST_STEP}">
        {#each STEP_TITLES as t, i}
          <!-- A finished step is a button; the current one and anything ahead of it are not.
               Going back to check something you have already answered should not cost four taps on
               Back, but a step nobody has filled in has no checks behind it yet — Next is where
               those live, so the strip only ever travels backwards.

               Two branches rather than one <svelte:element>: a div carrying a click handler is a
               control that no keyboard or screen reader can reach, and the honest fix is to not
               make it a control at all when it is not one. -->
          {#if i + 1 < step}
            <button class="stepdot done" type="button"
                    aria-label={`Back to step ${i + 1}, ${t}`}
                    on:click={() => goToStep(i + 1)}>
              <span class="sd-n">✓</span>
              <span class="sd-t">{t}</span>
            </button>
          {:else}
            <div class="stepdot" class:on={i + 1 === step} aria-current={i + 1 === step ? 'step' : undefined}>
              <span class="sd-n">{i + 1}</span>
              <span class="sd-t">{t}</span>
            </div>
          {/if}
        {/each}
      </div>
    {/if}

    <!-- 1 ── The essentials: name + (when billing's on) who's coming, video & live price. -->
    {#if !guided || step === 1}

    <!-- 1a ── What the event IS. -->
    {#if !guided || sub === 1}
    <div class="card">
      <div class="card-title">Your event{#if guided}<span class="sub-of">1 of {subCount}</span>{/if}</div>

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

      <!-- Directly under the name, because this is the answer the rest of the event is built from:
           the mark on the printed card, the tricks we offer and the card's decoration all key off
           it, and until now nothing ever set it, so every new event silently got the generic
           fallback. Chips rather than a dropdown — a list you can see is a choice, a list you have
           to open is a form field. -->
      <div class="field">
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label id="event-type-label">What kind of event is it? <span class="hint">(optional)</span></label>
        <div class="type-options" role="group" aria-labelledby="event-type-label">
          {#each EVENT_TYPES as t}
            <button
              type="button"
              class="type-opt"
              class:selected={eventType === t.key}
              aria-pressed={eventType === t.key}
              on:click={() => (eventType = eventType === t.key ? null : t.key)}
            >{t.label}</button>
          {/each}
        </div>
        <p class="field-hint">
          We'll suit the photo ideas and the printed cards to it. Skip it if none of them fit —
          your event works exactly the same either way, and you can say later.
        </p>
      </div>
    </div>
    {/if}

    <!-- 1b ── What a GUEST ends up looking at. Both of these change their screen, not yours, which
         is why they are a page of their own rather than a footnote under the name: a host should
         have to look at them and decide, and the shot list in particular is off until they do. -->
    {#if !guided || sub === 2}
    <div class="card">
      <div class="card-title">What your guests see{#if guided}<span class="sub-of">2 of {subCount}</span>{/if}</div>

      <!-- "Trick list" is what it is called on the event page, in the guest's camera and in the
           guide. The wizard used to switch on an unnamed "list of shots to hunt for", so a host
           turned something on here and then went looking for it under a different name.

           One row, always shown, rather than a branch: without an event type there is nothing to
           build a list FROM, so the switch dims (Toggle handles that itself) and the line beneath
           says why. A control that is simply absent reads as a bug. -->
      <div class="field">
        <div class="toggle-field">
          <span class="tf-label"><label for="seed-missions">Trick list</label></span>
          <Toggle id="seed-missions" bind:checked={seedMissions} disabled={!eventType} />
        </div>
        <p class="field-hint">
          {#if eventType}
            <!-- No {#if} around the examples: Svelte trims whitespace at a block boundary, so the
                 space before the dash was eaten and it rendered "not to miss— “…". Every pack ships
                 more than two shots, and this branch only runs with a type chosen, so there is
                 nothing to guard against. -->
            A few shots not to miss — “{trickExamples[0]}”, “{trickExamples[1]}” — that guests tick
            off in their camera. Edit or print it later.
          {:else}
            Pick a kind of event on the previous page and we'll suggest shots to match.
          {/if}
        </p>
      </div>

      <!-- It changes what a guest's phone DOES, which is this page's subject and not "Other
           settings" two steps away. -->
      <div class="field toggle-field">
        <span class="tf-label">
          <label for="no-flash">No flash</label>
          <HelpTip text={`Stops guests' phones firing the bright rear camera flash — handy for ceremonies, dark venues or anywhere a flash would be disruptive. The gentle front-camera selfie flash still works.`} />
        </span>
        <Toggle id="no-flash" bind:checked={noFlash} />
      </div>

      {#if eventType && seedMissions}
        <!-- Only once the list exists: a control for varying something that is switched off is a
             question about nothing. -->
        <div class="field">
          <div class="toggle-field">
            <span class="tf-label"><label for="trick-variety">Change it up</label></span>
            <Toggle id="trick-variety" bind:checked={trickVariety} />
          </div>
          <p class="field-hint">
            Make {VARIETY_SETS} different cards instead of one, so guests aren't all hunting the same
            shots. The must-haves stay on every card. Add, edit or remove any of them later.
          </p>
        </div>
      {/if}

      <div class="field">
        <label for="event-blurb">Welcome blurb <span class="hint">(optional — shown on the join screen)</span></label>
        <textarea id="event-blurb" maxlength="280" rows="2" placeholder="e.g. Snap away — every photo's a surprise until the big reveal!" bind:value={blurb}></textarea>
      </div>
    </div>
    {/if}

    <!-- 1c ── How big it is, and therefore what it costs. -->
    {#if !guided || sub === 3}
    <div class="card">
      <div class="card-title">How many guests?{#if guided}<span class="sub-of">3 of {subCount}</span>{/if}</div>

      {#if billing?.billingEnabled}
        <p class="field-hint" style="margin:0 0 12px">Events for up to {billing.freeAllGuests} guests are <b>free, with every feature</b>. Bigger events are a one-off pass. <b>Longer events, and keeping the photos longer, are paid on any size.</b></p>
        <!-- Video used to sit beside this box. It is a thing the day GETS, not a property of the
             guest list, and pairing it with the tier made it read as one more number to set before
             you are allowed to continue. It has its own card on step 3 now, with the rest. -->
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
    {/if}

    {#if draftRestored}
      <div class="draft-back">✓ Welcome back — your event details are just as you left them.</div>
    {/if}

    {/if}

    <!-- 2 ── When it runs. -->
    {#if !guided || step === 2}
    <div class="card">
      <div class="card-title">When</div>
      <div class="field-row">
        <div class="field">
          <label for="start-date">Start date</label>
          <input id="start-date" type="date" min={todayStr} bind:value={startDate} />
        </div>
        <div class="field">
          <label for="start-time">Start time</label>
          <!-- Same grid as the reveal, and for the same reason: the event's END is start + duration,
               and a reveal is checked on a 15-minute tick — so a 7:07 start quietly becomes a 7:15
               reveal anyway. Offering minutes we cannot honour is offering precision we do not have. -->
          <TimeField id="start-time" bind:value={startTime} />
        </div>
      </div>
        <!-- The timezone picker lives in Advanced settings, which meant this card never said what
             these times MEAN. A host setting 7pm had no way to know the event was stored in another
             zone until the day it ran. -->
        <p class="tz-line">
          Times are in
          <button type="button" class="tz-name" on:click={openTimezone}
                  title="Change the event's timezone">{timezone || '…'}</button>{#if startPreview} — starts {startPreview}{/if}
        </p>
        {#if tzOpen || !guided}
          <div class="field tz-field">
            <label for="timezone">Timezone <span class="hint">(type to search)</span></label>
            <SearchableSelect id="timezone" options={timezones} bind:value={timezone} placeholder="e.g. Australia/Brisbane" />
          </div>
        {/if}
        {#if tzMismatch}
          <div class="tz-warn">
            <p class="tz-msg">Your device is in <b>{deviceTz}</b> but this event is set to <b>{timezone}</b>.</p>
            <span class="tz-acts">
              <button type="button" class="tz-fix" on:click={() => (timezone = deviceTz)} title="Use {deviceTz}">Use {tzShort(deviceTz)}</button>
              <!-- Deliberate is a valid answer: a host in one country running an event in another
                   should be able to clear this rather than look at it for the rest of the form. -->
              <button type="button" class="tz-dismiss" on:click={() => (tzDismissedFor = timezone)}
                      aria-label="Keep {timezone} and dismiss this warning"
                        title="Keep {timezone}">Keep {tzShort(timezone)}</button>
            </span>
          </div>
        {/if}
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

    {/if}

    <!-- 3 ── What the event actually does on the day.
         These four were fields inside a collapsed panel called "Advanced settings" — which is where
         you put a thing you would rather nobody found — and they are the entire paid product. They
         get the step now, described by what the guests will experience and drawn, because a host
         cannot picture "4:5" and can see a box instantly.
         Nothing here is switched on: a host who taps Next without reading gets exactly the same
         free event they got before. What stayed behind the disclosure below is what is genuinely
         advanced and is not being sold to anyone. -->
    {#if !guided || step === 3}
    <div class="card">
      <div class="card-title">Make it yours</div>

      {#if billing?.billingEnabled && freeAtSize(Number(maxGuests))}
        <!-- The gift, counted up, on the page where it is being given. It was previously visible
             only as a struck-through number in a quote breakdown two steps away. -->
        <p class="fx-gift">Your event is {billing.freeAllGuests} guests or fewer, so <b>all of this is
          yours, free</b>. The usual price is beside each one — that's what you're not paying.</p>
      {:else}
        <p class="fx-intro">None of this is switched on. Add whatever suits the day — your event
          works beautifully without any of it.</p>
      {/if}

      {#if billing?.billingEnabled}
        <section class="fx-item">
          <div class="fx-head">
            <div class="fx-art" aria-hidden="true">
              <!-- A still, then the same scene as a clip: ghost frames behind and a play mark on
                   the front one. The arrow is what makes it a comparison rather than two icons. -->
              <svg class="fx-svg" viewBox="0 0 78 40">
                <rect class="s-line" x="1" y="6" width="27" height="27" rx="4" />
                <circle class="s-line" cx="14.5" cy="17" r="4" />
                <path class="s-line" d="M7.5 28.5c1.6-4 12.4-4 14 0" />
                <path class="s-line" d="M32 20h8m-3-3 3 3-3 3" />
                <rect class="s-ghost" x="55" y="3" width="22" height="22" rx="4" />
                <rect class="s-fill" x="48" y="8" width="26" height="26" rx="4" />
                <path class="s-play" d="M57 14.5v13l11-6.5z" />
              </svg>
            </div>
            <div class="fx-say">
              <h2 class="fx-name">Video clips</h2>
              <p class="fx-copy">Some moments won't hold still — the speech, the first dance, the dog
                getting the sausage. Guests get a record button beside the shutter, and the clips land
                in the gallery with the photos.</p>
            </div>
          </div>
          <div class="fx-choices" role="group" aria-label="Video clip length">
            <button type="button" class="fx-chip" class:on={videoSeconds === 0}
                    aria-pressed={videoSeconds === 0} on:click={() => (videoSeconds = 0)}>
              <span class="fc-t">Off</span><span class="fc-p">photos only</span>
            </button>
            {#each billing.videoAddons as v}
              {@const p = videoPrice(billing, v.seconds, Number(maxGuests))}
              {@const tag = priceTag(p, money)}
              <button type="button" class="fx-chip" class:on={videoSeconds === v.seconds}
                      aria-pressed={videoSeconds === v.seconds}
                      aria-label="{v.seconds} second clips, {priceAria(p, money)}"
                      on:click={() => (videoSeconds = v.seconds)}>
                <span class="fc-t">{v.seconds}s</span><span class="fc-p" class:was={tag.cls === 'was'} class:add={tag.cls === 'add'}
                      class:incl={tag.cls === 'incl'}>{tag.text}</span>
              </button>
            {/each}
          </div>
        </section>
      {/if}

      <section class="fx-item">
        <div class="fx-head">
          <div class="fx-art" aria-hidden="true">
            <!-- One dot per shot, the included ones hollow and the added ones filled. It grows as
                 the host picks, so the size of the difference is the thing on screen. -->
            <svg class="fx-svg" viewBox="0 0 78 40">
              {#each shotDots as d}
                <circle class="s-dot" class:extra={d.state === 'extra'} class:spare={d.state === 'spare'}
                        cx={d.cx} cy={d.cy} r="2.6" />
              {/each}
            </svg>
          </div>
          <div class="fx-say">
            <h2 class="fx-name">Shots each</h2>
            <p class="fx-copy">Everyone gets {billing?.shotsFree ?? 12} to start with. That's plenty
              over dinner and gone by the second song — give them more and they'll keep going all
              night.</p>
          </div>
        </div>
        <div class="fx-choices" role="group" aria-label="Shots per guest">
          {#each options?.shotsPerPerson ?? [] as sp}
            {@const p = shotsPrice(billing, Number(sp.value), Number(maxGuests))}
            {@const tag = priceTag(p, money)}
            <button type="button" class="fx-chip" class:on={Number(maxPhotos) === Number(sp.value)}
                    aria-pressed={Number(maxPhotos) === Number(sp.value)}
                    aria-label={billing?.billingEnabled ? `${sp.label} shots each, ${priceAria(p, money)}` : `${sp.label} shots each`}
                    on:click={() => (maxPhotos = sp.value)}>
              <span class="fc-t">{sp.label}</span>
              {#if billing?.billingEnabled}<span class="fc-p" class:was={tag.cls === 'was'} class:add={tag.cls === 'add'}
                      class:incl={tag.cls === 'incl'}>{tag.text}</span>{/if}
            </button>
          {/each}
        </div>
      </section>

      <section class="fx-item">
        <div class="fx-head">
          <div class="fx-say">
            <h2 class="fx-name">Frame shapes</h2>
            <p class="fx-copy">Square is what every event gets. Open the rest and guests choose the
              shape that suits the photo — tall for a person, wide for the room.</p>
          </div>
        </div>
        <!-- Not in the small art slot with the others: these are the real proportions at a shared
             height, so the WIDTHS are the comparison, and squeezing them into 78px would throw away
             the only thing they are here to show. -->
        <div class="shapes">
          {#each options?.aspectRatios ?? [] as a}
            <span class="shape-cell" class:lit={shapeLit(a.value, framePackOn, selectedAspects)}
                  title={a.value === 'full' ? 'Full — no crop, whatever the phone gives' : a.label}>
              <span class="shape" class:lit={shapeLit(a.value, framePackOn, selectedAspects)}
                    class:open={a.value === 'full'} style={shapeStyle(a.value)}></span>
              <span class="shape-n">{shapeName(a.label)}</span>
            </span>
          {/each}
        </div>
        {#if billing?.billingEnabled}
          <div class="fx-choices" role="group" aria-label="Photo shapes">
            <button type="button" class="fx-chip" class:on={!framePackOn} aria-pressed={!framePackOn}
                    on:click={() => (framePackOn = false)}>
              <span class="fc-t">Square only</span><span class="fc-p incl">free</span>
            </button>
            <button type="button" class="fx-chip" class:on={framePackOn} aria-pressed={framePackOn}
                    aria-label="Every shape, {priceAria(framePrice, money)}"
                    on:click={() => (framePackOn = true)}>
              <span class="fc-t">Every shape</span><span class="fc-p" class:was={frameTag.cls === 'was'} class:add={frameTag.cls === 'add'}
                    class:incl={frameTag.cls === 'incl'}>{frameTag.text}</span>
            </button>
          </div>
        {:else}
          <!-- Self-host has no payment rail, so there is no pack to sell: the host picks the shapes
               they want, one by one, exactly as they always have. -->
          <div class="aspect-options">
            {#each options?.aspectRatios ?? [] as a}
              <label class="aspect-opt">
                <input type="checkbox" bind:checked={selectedAspects[a.value]} />
                {a.label}
              </label>
            {/each}
          </div>
        {/if}
      </section>

      {#if retentionOptions.length}
        <section class="fx-item">
          <div class="fx-head">
            <div class="fx-art" aria-hidden="true">
              <!-- The photo stays put while time runs on past it: a dashed track and marks that
                   get smaller as they go. Drawn this way rather than as receding frames, which,
                   being outlines with nothing filled, read as two boxes crossing rather than as
                   one behind another. -->
              <svg class="fx-svg" viewBox="0 0 78 40">
                <rect class="s-fill" x="2" y="4" width="32" height="32" rx="5" />
                <circle class="s-line" cx="18" cy="20" r="8.5" />
                <path class="s-line" d="M18 14.5V20l4 2.5" />
                <path class="s-track" d="M39 20h36" />
                <circle class="s-tick" cx="44" cy="20" r="2.8" />
                <circle class="s-tick" cx="57" cy="20" r="2.2" />
                <circle class="s-tick" cx="69" cy="20" r="1.6" />
              </svg>
            </div>
            <div class="fx-say">
              <h2 class="fx-name">Keep them longer</h2>
              <p class="fx-copy">
                {#if billing?.billingEnabled}
                  Photos stay up for <b>{retentionLabel(retentionIncluded)}</b> after the event ends,
                  then they're gone for good. Give people longer if they'll be slow getting round to
                  it — and they always are.
                {:else}
                  How long the photos stay up after the event ends.
                {/if}
              </p>
            </div>
          </div>
          <div class="fx-choices" role="group" aria-label="How long photos are kept">
            {#each retentionOptions as r}
              {@const tag = priceTag(retentionPrice(r), money, r.included ? 'included' : 'free')}
              <button type="button" class="fx-chip" class:on={retentionDays === r.days}
                      aria-pressed={retentionDays === r.days}
                      aria-label={billing?.billingEnabled ? `Keep photos ${r.label}, ${priceAria(retentionPrice(r), money, r.included ? 'included' : 'free')}` : `Keep photos ${r.label}`}
                      on:click={() => { retentionDays = r.days; retentionTouched = true; }}>
                <span class="fc-t">{r.label}</span>
                {#if billing?.billingEnabled}<span class="fc-p" class:was={tag.cls === 'was'} class:add={tag.cls === 'add'}
                      class:incl={tag.cls === 'incl'}>{tag.text}</span>{/if}
              </button>
            {/each}
          </div>
        </section>
      {/if}
    </div>

    <!-- Genuinely advanced, and nothing in here is for sale: a URL slug, a zone name, when the
         photos appear. Collapsed on both paths now — the step is no longer empty without it, which
         was the only reason it was ever forced open. -->
    <details class="more">
      <summary>Other settings <span class="sum-hint">custom URL</span></summary>

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

      </div>

    </details>

    {/if}

    <!-- 4 ── When the photos appear, how the guests get them, and what they are told.
         Reveal used to live two steps back, inside a COLLAPSED "Other settings" dropdown, which
         got it wrong twice over: it is not a custom setting — it decides whether anybody sees
         anything — and the card below ("Everything, as soon as photos are revealed") is written in
         terms of a choice the host could not see from here. Cause and effect now sit together, in
         that order. Moderation rides with it because it is the same decision: who sees what, when. -->
    {#if !guided || step === 4}

    <!-- 4a ── THE GALLERY: when it unlocks, and what is allowed into it. -->
    {#if !guided || sub === 1}
    <div class="card">
      <div class="card-title">When can people see the photos?{#if guided}<span class="sub-of">1 of 3</span>{/if}</div>
      <!-- These two pages were one screen, and a host reading them back to back could not tell why
           they were being asked twice. They are two different things and the lead line on each now
           says which: this page is the GALLERY — the page itself, and who may look at it. The next
           one is the EMAIL we send guests, which can only ever happen after this. -->
      <p class="lead-note">The gallery is where every photo ends up. This decides when it opens, and
        whether you check each shot on the way in.</p>
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
          <select id="reveal-delay" bind:value={revealDelayHours} on:change={onRevealDelayChange}>
            {#each options?.revealDelays ?? [] as r}
              <option value={r.value}>{r.label}</option>
            {/each}
            <option value={REVEAL_CUSTOM}>Pick an exact date &amp; time…</option>
          </select>
        </div>

        {#if wantsCustomReveal}
          <div class="field-row reveal-custom">
            <div class="field">
              <label for="reveal-date">Reveal date</label>
              <input id="reveal-date" type="date" min={todayStr} bind:value={revealDate} />
            </div>
            <div class="field">
              <label for="reveal-time">Reveal time</label>
              <!-- Stepped by the tick, so the wheel on a phone only offers moments that can
                   actually be honoured and the rounding below almost never has to say anything. -->
              <TimeField id="reveal-time" bind:value={revealTime} snap="up" />
            </div>
          </div>
          <p class="hint reveal-note">
            {#if actualRevealAt === null}
              Pick the date and time — it's read in the event's timezone{timezone ? ` (${timezone})` : ''}.
            {:else}
              Photos appear from <b>{revealMomentLabel(actualRevealAt, timezone)}</b>.
              {#if revealMoved}
                Reveals are checked every {REVEAL_TICK_MS / 60000} minutes, so yours moves to the next check.
              {/if}
            {/if}
          </p>
        {/if}
      {/if}

    </div>

    {#if revealMode !== 'instant'}
      <!-- Given the feature-card treatment from step 3, because it is that kind of decision and as
           a bare switch under the reveal options it read as a footnote to them. It is not one: it
           decides whether a photo a guest takes is ever seen by anybody, which makes it the most
           consequential control on this page. -->
      <div class="card">
        <section class="fx-item">
          <div class="fx-head">
            <div class="fx-art" aria-hidden="true">
              <!-- A shot waiting (dashed, unresolved), then the same shot approved — the same
                   before/after grammar as the video card's still-then-clip on step 3. -->
              <svg class="fx-svg" viewBox="0 0 78 40">
                <rect class="s-track" x="1" y="7" width="25" height="25" rx="4" />
                <circle class="s-track" cx="13.5" cy="17" r="3.5" />
                <path class="s-track" d="M6 27.5c1.5-3.5 11.5-3.5 13 0" />
                <path class="s-line" d="M31 20h8m-3-3 3 3-3 3" />
                <rect class="s-fill" x="46" y="7" width="25" height="25" rx="4" />
                <path class="s-check" d="M52.5 19.5l4.5 4.5 8-9" />
              </svg>
            </div>
            <div class="fx-say">
              <!-- Switch on the TITLE row, not as a third column of .fx-head. As a column it took
                   46px out of the text for the card's whole height, and at 420px the sentence
                   wrapped to six lines beside an otherwise empty switch. -->
              <div class="fx-titlerow">
                <h2 class="fx-name"><label for="moderation">Moderate photos</label></h2>
                <Toggle id="moderation" bind:checked={moderationEnabled} />
              </div>
              <p class="fx-copy">Nothing a guest takes reaches the gallery until you have said yes to
                it. Worth it for a work do or anything public; most private events never need it.</p>
            </div>
          </div>
        </section>
      </div>
    {/if}

    <!-- Downloads sits with moderation because it answers the same question the page asks: what can
         people DO with these photos. It was in step 3's collapsed "Other settings", two steps from
         the card about who may see them. -->
    <div class="card">
      <section class="fx-item">
        <div class="fx-head">
          <div class="fx-art" aria-hidden="true">
            <!-- A photo with an arrow leaving it. -->
            <svg class="fx-svg" viewBox="0 0 78 40">
              <rect class="s-line" x="8" y="4" width="30" height="30" rx="4" />
              <circle class="s-line" cx="19" cy="15" r="3.5" />
              <path class="s-line" d="M12 29c2-5 16-5 18 0" />
              <path class="s-fillstroke" d="M55 8v17" />
              <path class="s-fillstroke" d="M48.5 18.5 55 25l6.5-6.5" />
              <path class="s-line" d="M45 31h20" />
            </svg>
          </div>
          <div class="fx-say">
            <div class="fx-titlerow">
              <h2 class="fx-name"><label for="allow-downloads">Allow downloads</label></h2>
              <Toggle id="allow-downloads" bind:checked={allowDownloads} />
            </div>
            <p class="fx-copy">Guests can save single photos and grab the whole event as a zip. Turn
              it off and the gallery is look-only — everyone still sees the photos.</p>
          </div>
        </div>
      </section>
    </div>
    {/if}

    <!-- 4b ── THE EMAIL: a copy sent to each guest who asked for one. -->
    {#if !guided || sub === 2}
    <div class="card">
      <div class="card-title" id="guest-delivery-q">How do your guests get their copy?{#if guided}<span class="sub-of">2 of 3</span>{/if}</div>
      <!-- Names the previous page's answer, which is what stops the two reading as rival settings
           for the same thing. Saying the rest out loud — that nothing here opens the gallery any
           sooner — was belt and braces for a worry the sentence above already settles. -->
      <p class="lead-note">
        {#if guestRevealLabel}Your gallery opens <b>{guestRevealLabel}</b>. This is the email that
        goes to guests who asked for their photos.
        {:else}This is the email that goes to guests who asked for their photos.{/if}
      </p>
      <!-- The same card shape as Reveal mode: the host has already made one choice that looks
           exactly like this, so this is a decision they recognise rather than a fourth widget. -->
      <div class="reveal-options" role="group" aria-labelledby="guest-delivery-q">
        {#each GUEST_DELIVERY_OPTIONS as o}
          <button
            type="button"
            class="reveal-opt"
            class:selected={guestDelivery === o.value}
            aria-pressed={guestDelivery === o.value}
            on:click={() => onGuestDeliveryPick(o.value)}
          >
            {o.label}
            <br /><small>{o.desc}</small>
          </button>
        {/each}
      </div>

      {#if guestDelivery === 'scheduled' || guestDelivery === 'manual'}
        <!-- Only on the two options that do not already say it. On the other two the words the host
             picked ARE the answer, and asking again would let the two disagree. -->
        <div class="field" style="margin-top:14px">
          <!-- svelte-ignore a11y-label-has-associated-control -->
          <label id="guest-scope-label">Which photos do they get?</label>
          <div class="type-options" role="group" aria-labelledby="guest-scope-label">
            <button type="button" class="type-opt" class:selected={guestSendScope === 'all'}
                    aria-pressed={guestSendScope === 'all'}
                    on:click={() => (guestSendScope = 'all')}>Everything</button>
            <button type="button" class="type-opt" class:selected={guestSendScope === 'favourites'}
                    aria-pressed={guestSendScope === 'favourites'}
                    on:click={() => (guestSendScope = 'favourites')}>Just my favourites</button>
          </div>
        </div>
      {/if}

      {#if guestDelivery === 'scheduled'}
        <div class="field-row reveal-custom">
          <div class="field">
            <label for="guest-send-date">Send date</label>
            <input id="guest-send-date" type="date" min={todayStr} bind:value={guestSendDate} />
          </div>
          <div class="field">
            <label for="guest-send-time">Send time</label>
            <!-- The same 15-minute grid as the reveal: a send is checked on that tick, so finer
                 minutes are precision we could not honour. -->
            <TimeField id="guest-send-time" bind:value={guestSendTime} snap="up" />
          </div>
        </div>
        <p class="hint reveal-note">
          {#if guestSendIssue === 'missing'}
            Pick the date and time — it's read in the event's timezone{timezone ? ` (${timezone})` : ''}.
          {:else if guestSendIssue === 'before-reveal'}
            That's before your photos are revealed ({guestRevealLabel}) — your guests would get a link
            to a gallery that is still shut. Pick that moment or later.
          {:else}
            Your guests get the photos from <b>{guestSendLabel}</b>.
            {#if guestSendMoved}
              Sends are checked every {REVEAL_TICK_MS / 60000} minutes, so yours moves to the next check.
            {/if}
          {/if}
        </p>
      {/if}
    </div>

    <!-- Collapsed, because three toggles with a paragraph each is more than this step can carry
         above the fold — and none of them CHANGES what a guest receives. A guest who asked for
         their photos gets them whatever is set here; these only decide what else the message
         carries. The summary states the count so a host can see it is set without opening it. -->
    {/if}

    <!-- 4c ── The three emails. A page, not a disclosure: these decide what lands in a guest's
         inbox, which is not a detail to be tucked away, and a summary counting "2 of 3 on" was
         counting a switch that this event cannot even use. -->
    {#if !guided || sub === 3}
    <div class="card">
      <div class="card-title">What we email your guests{#if guided}<span class="sub-of">3 of 3</span>{/if}</div>
      <p class="lead-note mail-lead">Only guests who asked for their photos are ever emailed, and
        they get them whatever you choose here. All changeable later.</p>

      <div class="mail-opt">
        <div class="field toggle-field">
          <span class="tf-label"><label class="mail-name" for="g-thanks">Thank-you &amp; release date</label></span>
          <Toggle id="g-thanks" bind:checked={guestMailThanks} />
        </div>
        <!-- Not "email guests when the event ends": that would be a lie when this is off. The email
             is the guest's own doing — they asked for their photos — and this only decides what
             else it carries. -->
        <p class="field-hint">Goes out when the event ends.{#if !guestThanksDated}{' '}No release moment
          is fixed yet, so it would be the thank-you on its own.{/if}</p>
      </div>

      <!-- Always here, never replaced by a sentence. A control that vanishes on one event and
           appears on another reads as a bug; off and unavailable, with the reason under it, reads
           as the answer to a question the host was about to ask. -->
      <div class="mail-opt" class:unavailable={!guestReminderOffered}>
        <div class="field toggle-field">
          <span class="tf-label"><label class="mail-name" for="g-reminder">Day-before reminder</label></span>
          <Toggle id="g-reminder" bind:checked={guestMailReminder} disabled={!guestReminderOffered} />
        </div>
        <p class="field-hint">
          {#if guestReminderOffered}Goes out 24 hours before the gallery opens — {guestReminderLabel}.
          {:else}Not available — {guestReminderWhyNot}{/if}
        </p>
      </div>

      <div class="mail-opt" class:unavailable={!guestLiveAutomatic}>
        <div class="field toggle-field">
          <span class="tf-label"><label class="mail-name" for="g-live">The gallery link</label></span>
          <Toggle id="g-live" checked={guestLiveAutomatic} disabled />
        </div>
        <p class="field-hint">
          {#if guestLiveAutomatic}This is how “{guestDeliveryLabel}” actually reaches
            them{#if guestReleaseLabel}{' '}— {guestReleaseLabel}{/if}. It is the delivery you chose
            on the last page, so it is not a separate switch.
          {:else}You send this one yourself, from your event page, whenever you are ready.{/if}
        </p>
      </div>
    </div>
    {/if}

    {/if}

    {#if !guided || step === LAST_STEP}
    {#if guided && quote}
      <!-- The itemised quote, repeated here so the last thing before "Create" is what it costs and
           why. Rendered from the same `quote` object as step 1 — nothing is recomputed. -->
      <div class="card">
        <div class="card-title">What you're creating</div>
        <div class="sum-rows">
          <div class="sum-row"><span>Event</span><b>{name.trim() || 'Untitled'}</b></div>
          <div class="sum-row"><span>Guests</span><b>up to {quote.maxGuests}</b></div>
          <div class="sum-row"><span>Shots each</span><b>{quote.maxPhotos}</b></div>
          {#if quote.videoSeconds > 0}<div class="sum-row"><span>Video</span><b>{quote.videoSeconds}s clips</b></div>{/if}
          {#if quote.framePack}<div class="sum-row"><span>Shapes</span><b>all shapes</b></div>{/if}
          <div class="sum-row"><span>Runs for</span><b>{(options?.durations ?? []).find((d) => Number(d.value) === durationHours)?.label ?? `${durationHours}h`}</b></div>
          <!-- The one line on this summary that is a deadline rather than a setting: after it the
               photos are deleted, and a host who never opened the disclosure it used to live in had
               no idea the clock existed. -->
          <div class="sum-row"><span>Photos kept</span><b>{retentionLabel(quote.retentionDays)} after it ends</b></div>
          <div class="sum-row total"><span>Total</span><b>{quote.requiresPayment ? money(quote.amountCents) : 'Free'}</b></div>
        </div>
      </div>
    {/if}
    {#if loggedIn}
      <button class="btn primary" on:click={submitCreate} disabled={creating}>
        {creating ? 'Creating…' : quote?.requiresPayment ? `Create event · ${money(quote.amountCents)}` : 'Create event'}
      </button>
      <p class="foot-note">You'll get a QR code + join code to share with guests</p>
    {:else}
      <!-- The server requires an account here (it answers 401), so the plain button could only ever
           fail — after the host had filled in the whole form. Ask for the account at the point it
           is actually needed, and keep the draft so nothing is lost. -->
      <button class="btn primary" on:click={() => goSignIn('/signup')}>Create my account &amp; event</button>
      <button class="btn ghost signin-alt" on:click={() => goSignIn('/login')}>I already have an account</button>
      <p class="foot-note">Your event details are kept — you'll come straight back here to finish.</p>
    {/if}
    {/if}

    {#if guided}
      <div class="wiz-nav">
        {#if step > 1 || sub > 1}
          <button class="btn ghost" on:click={prevStep}>← Back</button>
        {/if}
        {#if step < LAST_STEP}
          <!-- aria-disabled, NOT disabled. A disabled button swallows nothing and consumes nothing:
               the tap falls through it to whatever is behind, and on a phone the browser reads that
               as the start of a text selection and throws up its own Copy/Search menu over the app.
               It is also a control that says "Name your event to continue" and then does nothing
               when you do exactly what it says. Pressing it now takes you to the field. -->
          <button class="btn primary grow" on:click={nextStep} aria-disabled={!canAdvance || undefined}>
            {step === 1 && sub === 1 && !name.trim() ? 'Name your event to continue' : 'Next →'}
          </button>
        {/if}
      </div>
      {#if step === 1}
        <!-- The escape, on the first step where it is useful, not buried at the end. -->
        <button class="btn ghost wiz-all" on:click={() => (guided = false)}>Show me everything at once</button>
      {/if}
    {:else}
      <button class="btn ghost wiz-all" on:click={() => { guided = true; step = 1; }}>Walk me through it instead</button>
    {/if}
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
</main>

<style>
  /* The zone name IS the control — a separate "Change" link was one more thing to read. */
  .tz-name { padding: 0; border: 0; background: none; cursor: pointer; color: var(--accent);
    font: inherit; font-weight: 700; text-decoration: underline; text-underline-offset: 2px; }
  .tz-name:hover { filter: brightness(1.15); }
  .signin-alt { margin-top: 8px; }
  .draft-back { margin: 0 0 14px; padding: 10px 12px; border-radius: 10px; font-size: .84rem;
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 40%, transparent); }
  .tz-field { margin-top: 10px; }
  .tz-line { margin: 2px 0 10px; font-size: .82rem; color: var(--text-muted); }
  .tz-warn { margin: 0 0 12px; padding: 9px 12px; border-radius: 10px; font-size: .82rem;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent); }
  .tz-msg { margin: 0 0 9px; }
  /* Their own row, so both actions sit on one line instead of trailing the sentence and wrapping. */
  .tz-acts { display: flex; gap: 8px; flex-wrap: wrap; align-items: stretch; }
  /* Both are real buttons sharing one shape. The secondary is quieter through weight and text
     colour — giving it no background just made it read as a line of text beside a button. */
  .tz-fix, .tz-dismiss {
    padding: 5px 11px; border-radius: 8px; cursor: pointer; font: inherit; font-size: .78rem;
    border: 1px solid var(--border); background: var(--surface); color: var(--text); line-height: 1.35;
  }
  .tz-fix { font-weight: 700; }
  .tz-dismiss { color: var(--text-muted); }
  .tz-fix:hover, .tz-dismiss:hover { border-color: var(--accent); color: var(--text); }

  /* Named for a screen reader without changing the design — the tabs are the visible heading. */
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden;
    clip: rect(0 0 0 0); white-space: nowrap; border: 0; }

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
  /* The note explains the two inputs above it, and it used to be pulled INTO them: the row's first
     .field still carried the standard 16px bottom margin while the second (a :last-child) carried
     none, so the row's box ended lower than the time input, and a -4px top margin on the note then
     dragged it back up. Measured result: 16px under the dropdown, 10px under the time input — the
     explanation sat tighter to its control than the controls sat to each other. The row owns its
     own spacing now and the note keeps the section's 16px rhythm. */
  .reveal-custom > .field {
    margin-bottom: 0;
  }
  .reveal-note {
    margin: 16px 0 0;
    line-height: 1.5;
  }
  /* Date and time pickers are the two controls a host is most likely to be poking at one-handed on
     a phone, and iOS in particular shrinks them below a comfortable tap. */
  .reveal-custom input {
    min-height: 44px;
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
  /* A ring on a TEXT field after you click it is useful — it says where your typing will go.
     On a checkbox it is not: the box already shows its own state, so the ring is just a yellow
     outline stuck there until you click elsewhere, which reads as something being wrong.
     So boxes and radios get :focus-visible, which fires for keyboard navigation and not for a
     mouse click; everything you type into keeps the plain :focus ring. */
  input:not([type='checkbox']):focus,
  select:focus,
  textarea:focus {
    outline: 2px solid var(--accent);
    border-color: transparent;
  }
  input[type='checkbox']:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
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
  /* Event-type chips. The box is .aspect-opt's and the chosen state is .reveal-opt's, so this is a
     choice the host has already seen the shape of twice rather than a third visual language.
     min-height is the tap target, not the look: nine of these wrap to four rows on a 360px phone,
     which is where most of this form is filled in, and a wrapped row of 34px chips is a mis-tap. */
  /* A grid, not a wrapping flex row — the same move, for the same reason, as .fx-choices below.
     Flexed, nine chips of nine different widths made every row end somewhere different and the last
     one stretch to fill what was left, so "Christmas / holiday party" ended up a full-width banner
     under two half-width neighbours. Equal columns say the choices are equal, which they are, and a
     lone chip on the last row stays one column wide instead of growing into a recommendation
     nobody made. */
  .type-options {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(130px, 1fr));
    gap: 8px;
  }
  .type-opt {
    /* Centred and stretched: with equal columns the labels have to sit consistently, and grid makes
       every cell the height of the tallest so a two-line label no longer shunts its row. */
    display: flex;
    align-items: center;
    justify-content: center;
    text-align: center;
    min-height: 44px;
    padding: 8px 12px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-family: var(--font);
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
  }
  .type-opt:hover { border-color: var(--accent); }
  .type-opt.selected {
    border-color: var(--accent);
    background: color-mix(in srgb, var(--accent) 12%, var(--surface));
    font-weight: 700;
  }

  .field-hint { font-size: 0.76rem; color: var(--text-muted); margin: 6px 0 0; }
  /* One email switch and the line that says when it fires, as a single block. The rows are the
     page's existing .toggle-field; this only groups each with its own explanation so the gaps
     read as three items rather than six. */
  .mail-opt { margin-bottom: 14px; }
  .mail-opt:last-of-type { margin-bottom: 0; }
  .mail-opt .toggle-field { margin-bottom: 0; }
  /* The reminder when it cannot be offered. Same size as the hints it sits among, indented to the
     left edge of the rows so it reads as that row's absence rather than as a footnote. */
  /* The switch's name, told apart from the sentence under it. As a plain label it sat at the same
     weight as its own explanation, so a column of these read as prose with switches in it. */
  /* The page's own words, ruled off from the switches. Without the line the lead read as a caption
     on the first toggle rather than as a statement about all of them. */
  .mail-lead {
    margin-bottom: 0;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
  }
  .mail-lead + .mail-opt { margin-top: 14px; }
  .mail-name { font-weight: 700; font-size: 0.92rem; color: var(--text); }
  /* Off and out of reach, but still legible — it is explaining itself, not greyed into nothing. */
  .mail-opt.unavailable .mail-name { color: var(--text-muted); }
  .mail-off { margin: 0 0 14px; }

  /* Which of step 1's pages this is. The strip above counts the five steps and cannot show this,
     and three presses of Next against a dot that never moves reads as a stuck button. */
  /* The strip's finished steps are real buttons now, so they need the button reset the div never
     needed — and a cursor that says they can be pressed. */
  button.stepdot {
    font: inherit; color: inherit; background: none; border: 0; padding: 0;
    cursor: pointer; text-align: inherit;
  }
  button.stepdot:hover .sd-t { color: var(--text); }
  button.stepdot:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 6px; }

  .sub-of {
    float: right; font-size: 0.72rem; font-weight: 600; color: var(--text-muted);
    letter-spacing: 0.02em; padding-top: 4px;
  }

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
  .btn[aria-disabled='true'] {
    opacity: 0.5;
    /* Not `cursor: not-allowed` — it IS allowed, it just goes somewhere else. */
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
    /* At 360px the title and its hint fought over one row and both wrapped — "Other" over
       "settings" beside two lines of hint. Wrapping sends the hint to its own row instead. */
    flex-wrap: wrap;
  }
  .more > summary::-webkit-details-marker { display: none; }
  .more > summary .sum-hint { font-size: 0.75rem; font-weight: 500; color: var(--text-muted); }
  /* Ordered last so it drops below the title and the marker rather than between them. */
  @media (max-width: 460px) {
    .more > summary .sum-hint { order: 3; flex-basis: 100%; margin-top: 4px; }
  }
  .more > summary::after { content: '▾'; color: var(--text-muted); transition: transform 0.15s; }
  .more[open] > summary::after { transform: rotate(180deg); }
  .more .card { border: none; border-top: 1px solid var(--border); border-radius: 0; margin: 0; }
  /* ── The guided path ─────────────────────────────────────────────────────── */
  .steps {
    display: flex; align-items: flex-start; gap: 4px; margin: 0 0 14px;
  }
  .stepdot {
    flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px;
    /* The rule between dots is the dot's own top border, so the track cannot fall out of step with
       the markers the way a separately-positioned line does. */
    border-top: 2px solid var(--border); padding-top: 8px;
    color: var(--text-muted); font-size: 0.75rem; text-align: center;
  }
  .stepdot.on, .stepdot.done { border-top-color: var(--accent); }
  .stepdot.on { color: var(--text); font-weight: 700; }
  .sd-n {
    width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; font-size: 0.75rem; font-weight: 700;
    background: var(--surface-2); border: 1px solid var(--border);
  }
  .stepdot.on .sd-n { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); }
  .stepdot.done .sd-n { color: var(--accent); border-color: var(--accent); }
  /* The labels are the first thing to go when there is no room — the numbers and the track still
     say where you are, and four words squeezed to two characters each say nothing. */
  @media (max-width: 460px) { .sd-t { display: none; } }

  /* The primary action has to be the big one, and it was not: `.btn { width: 100% }` gave Back a
     flex-basis of 100% while `.grow { flex: 1 }` gave Next a basis of ZERO, so Next collapsed to
     min-content — 61px, with "Next →" wrapping onto two lines — beside a 285px Back button. Exactly
     inverted, and width-independent, so it looked identical at 1280px and the desktop pass missed
     it entirely.
     Both get an explicit basis here, and Next takes twice the share. */
  .wiz-nav { display: flex; gap: 8px; margin-top: 14px; }
  .wiz-nav > .btn { width: auto; flex: 1 1 0; min-width: 0; }
  .wiz-nav > .grow { flex: 2 1 0; }
  .wiz-all { width: 100%; margin-top: 10px; font-size: 0.8rem; }
  /* A flex item defaults to min-width:auto, so these never shrank below their content — and
     Chromium's <input type=date> has a min-content of ~167px. The row therefore demanded 319px
     forever, which at 360px pushed the Start time box 16px THROUGH the card's right border and set
     the whole app's minimum width to ~358px. min-width:0 lets them shrink; wrapping gives them
     somewhere to go when they cannot shrink further. */
  .field-row { flex-wrap: wrap; }
  .field-row > .field { min-width: 0; flex: 1 1 140px; }

  .wiz-total {
    display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
    margin: 0 0 12px; padding: 10px 12px; border-radius: var(--radius-sm);
    background: var(--surface-2); border: 1px solid var(--border);
  }
  .wt-l { font-size: 0.8rem; color: var(--text-muted); }
  .wt-v { font-size: 1.15rem; font-weight: 800; color: var(--accent); margin-left: auto; }
  .wt-v.free { color: var(--success); }
  .wt-n { flex-basis: 100%; font-size: 0.75rem; color: var(--text-muted); }

  /* ── The features step ───────────────────────────────────────────────────
     Every drawing below is inline SVG or a CSS box. This step is read on a phone, often on venue
     wifi, and four <img> tags here would be four more things to fail — leaving four blank holes
     exactly where the explanation was meant to be. Colours all come from the theme variables, so
     one set of markup answers light and dark rather than two sets of files. */
  .fx-intro { margin: 0 0 18px; font-size: 0.82rem; line-height: 1.5; color: var(--text-muted); }
  .fx-gift {
    margin: 0 0 18px; padding: 10px 12px; border-radius: var(--radius-sm);
    font-size: 0.82rem; line-height: 1.5; color: var(--text);
    background: color-mix(in srgb, var(--success) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--success) 40%, transparent);
  }
  /* A rule between features, not a box around each: four bordered cards inside a bordered card is
     three nested frames deep, and at 360px there is no room to spend on frames. */
  .fx-item { padding: 18px 0; border-top: 1px solid var(--border); }
  .fx-item:first-of-type { padding-top: 0; border-top: 0; }
  .fx-item:last-of-type { padding-bottom: 0; }
  .fx-head { display: flex; gap: 12px; align-items: flex-start; }
  /* A fixed basis, not a share of the row: the art is a drawing at a known size, and a flexible
     slot would render it at a different scale in every card. */
  .fx-art { flex: 0 0 78px; color: var(--text-muted); }
  .fx-svg { display: block; width: 78px; height: 40px; }
  .fx-say { flex: 1 1 0; min-width: 0; }
  /* Name left, control right, with the description free to use the full width underneath. */
  .fx-titlerow { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .fx-titlerow .fx-name { margin-bottom: 0; }
  /* One feature to a card here, so nothing above to rule off against. */
  .card > .fx-item:only-of-type { border-top: 0; padding: 0; }
  .fx-item .fx-copy { margin-top: 5px; }
  .fx-item .fx-name label { cursor: pointer; }

  /* One line under a page's title saying what this page is FOR — the thing that stops "when do the
     photos appear" and "how do guests get them" reading as two settings for the same job. */
  .lead-note {
    margin: 0 0 16px;
    font-size: 0.82rem;
    line-height: 1.5;
    color: var(--text-muted);
  }
  .fx-name { margin: 0 0 5px; font-size: 0.95rem; font-weight: 800; color: var(--text); }
  .fx-copy { margin: 0; font-size: 0.8rem; line-height: 1.5; color: var(--text-muted); }

  /* A grid rather than a wrapping flex row. Flexed, the chips that landed on the last row grew to
     fill it: at 360px "1 year" ended up a full-width banner beside a half-width "6 months", which
     reads as a recommendation nobody made. Equal columns say the choices are equal, which they are. */
  .fx-choices {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(72px, 1fr));
    gap: 8px; margin-top: 12px;
  }
  /* 44px is the tap target, and it is not decorative here: five of these wrap to two rows on a
     360px phone, which is where most of this form is filled in, and a wrapped row of short chips is
     exactly where a mis-tap costs someone money. */
  .fx-chip {
    min-height: 44px;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
    padding: 6px 10px; background: var(--bg); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text); font-family: var(--font);
    font-size: 0.85rem; font-weight: 700; cursor: pointer; line-height: 1.15;
  }
  .fx-chip:hover { border-color: var(--accent); }
  .fx-chip.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, var(--surface)); }
  .fc-t { text-align: center; }
  /* The label may wrap inside a narrow column; the price may not. A price broken across two lines
     is a different number for the half-second before you read the second half. */
  .fc-p { font-size: 0.66rem; font-weight: 600; color: var(--text-muted); white-space: nowrap; }
  .fc-p.add { color: var(--accent-dark); }
  .fc-p.incl { color: var(--success); }
  /* Struck green is this page's existing "you would pay this, and you are not" — the same mark the
     quote breakdown uses, so the chip and the receipt can never say different things about the same
     gift. The words are spoken separately for a screen reader (priceAria), which reads a line
     through a price as nothing at all. */
  .fc-p.was { color: var(--success); text-decoration: line-through; }

  /* The shapes, at their real proportions and a shared height, so the widths are the comparison.
     This is the one drawing on the page that is information rather than decoration. */
  .shapes { display: flex; align-items: flex-end; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  .shape-cell { display: flex; flex-direction: column; align-items: center; gap: 5px; }
  /* 56px, not 46: the whole point is the spread between 9:16 and 1:1, and at 46px that spread is
     14px — a difference you have to look for. The tallest row of these still fits inside a 360px
     card with room to spare. The border is mixed from the muted text colour rather than --border,
     which in light mode is a near-white hairline on white and made the locked shapes invisible. */
  .shape {
    display: block; height: 56px; max-width: 100%; border-radius: 4px;
    border: 1.5px solid color-mix(in srgb, var(--text-muted) 45%, transparent);
    background: var(--surface-2);
  }
  .shape.lit { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 22%, transparent); }
  /* 'full' is the ABSENCE of a crop rather than a fifth ratio, so it is drawn dashed: a solid box
     the same size as Classic would claim a fixed shape the camera never promised. */
  .shape.open { border-style: dashed; }
  .shape-n { font-size: 0.66rem; color: var(--text-muted); }
  .shape-cell.lit .shape-n { color: var(--text); font-weight: 700; }

  /* Shared ink for the inline drawings. currentColor rather than a fixed grey, so the whole set
     follows .fx-art's colour and inverts with the theme on its own. */
  .s-line { fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .s-ghost { fill: none; stroke: currentColor; stroke-width: 1.4; opacity: 0.45; }
  .s-fill { fill: color-mix(in srgb, var(--accent) 18%, transparent); stroke: var(--accent); stroke-width: 1.6; }
  .s-play { fill: var(--accent); }
  .s-fillstroke { fill: none; stroke: var(--accent); stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  .s-check { fill: none; stroke: var(--accent); stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  .s-track { fill: none; stroke: currentColor; stroke-width: 1.3; stroke-dasharray: 2 3; opacity: 0.5; }
  .s-tick { fill: currentColor; opacity: 0.6; }
  .s-dot { fill: currentColor; opacity: 0.55; }
  .s-dot.extra { fill: var(--accent); opacity: 1; }
  /* A ring, not a disc: an unclaimed shot has to read as an empty slot rather than as a dimmer
     version of one the host already has. */
  .s-dot.spare { fill: none; stroke: currentColor; stroke-width: 1.2; opacity: 0.38; }

  .sum-rows { display: flex; flex-direction: column; gap: 6px; }
  .sum-row { display: flex; justify-content: space-between; gap: 12px; font-size: 0.85rem; }
  .sum-row span { color: var(--text-muted); }
  .sum-row.total { border-top: 1px solid var(--border); margin-top: 4px; padding-top: 8px; font-size: 1rem; }
  .sum-row.total b { color: var(--accent); }
</style>
