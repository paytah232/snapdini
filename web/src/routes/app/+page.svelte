<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
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

  // ── …and the same path walked a second time ────────────────────────────────
  //
  // This page is also the only place the product ever EXPLAINS itself — what moderation does, what
  // a reveal delay is for, what the guest email actually says. Once the event exists that whole
  // explanation is gone, and all the host has is the admin page's settings card: correct, dense,
  // and silent. So `?edit=<joinCode>#<organizerCode>` re-opens THIS wizard over an existing event
  // rather than a second screen being written that would drift from it within a month.
  //
  // Everything below is additive and behind this flag. Creating an event is the thing this page is
  // for, and nothing about it changes when the flag is off.
  let editing = false;
  let editCode = '';
  let editOrg = '';
  let editEvent: AdminEvent | null = null;
  let editLoading = false;
  let editError = '';
  let saving = false;
  /** Was the start already fixed when we loaded? Decided up front — see the note on loadForEdit. */
  let startFixed = false;
  /** The event as it was, labelled the way the last step shows it, for the change list. */
  let editBefore: Record<string, string> = {};
  /** Where to send a host who wants the part of this they cannot change here. */
  $: upgradeHref = `/admin/${encodeURIComponent(editCode)}?upgrade=1#${encodeURIComponent(editOrg)}`;
  $: adminHref = `/admin/${encodeURIComponent(editCode)}#${encodeURIComponent(editOrg)}`;
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
  // It lives in $lib/eventEdit now so the create/edit difference is something a test can state.
  // `paid` and `editing` are PARAMETERS, not read from scope. Svelte tracks what a reactive
  // statement mentions directly, not what a function it calls happens to read — so
  // `$: subCount = subsFor(step)` only ever recomputed when `step` changed, and billing arrives
  // from /api/config after first paint. The count stayed at its pre-billing value and step 1
  // silently lost its guests-and-price page.
  $: subCount = subsFor(step, !!billing?.billingEnabled, editing);
  let sub = 1;
  // billing arrives from /api/config after first paint; a host standing on a page that just stopped
  // existing must not be stranded there.
  $: if (sub > subCount) sub = subCount;

  /**
   * Put the top of the new page in view.
   *
   * Every one of these controls lives at the BOTTOM of the card, and swapping the card does not move
   * the scroll position — so pressing Next left you looking at the middle of the next question, or
   * at blank space below a shorter one, and you had to scroll up to find out what you had been
   * asked. The strip is the target rather than the document top: it carries which step you are on,
   * and the card's heading sits directly beneath it.
   *
   * After a tick, because the new card has to exist before it can be scrolled to.
   */
  /**
   * The running total, kept in view once the real one has scrolled away.
   *
   * The total sits above the step strip, which is fine on a laptop and useless on a phone: it is
   * off the top of the screen for the whole of every step, so the one number that changes as you
   * pick things is the one number you cannot see. A pill appears only while the real total is out
   * of view, so on a short step — or any desktop — nothing is doubled up.
   */
  let totalEl: HTMLElement | null = null;
  let totalOut = false;
  function watchTotal(node: HTMLElement) {
    totalEl = node;
    if (typeof IntersectionObserver !== 'function') return;   // no observer, no pill: it is an extra, not the source
    // rootMargin, not a bare threshold: with threshold 0 a two-pixel sliver of the total still
    // counts as visible, so the pill held off while the number was unreadable. Pulling the top edge
    // in by 30px means "effectively gone" rather than "gone to the last pixel".
    const io = new IntersectionObserver(([e]) => { totalOut = !e.isIntersecting; },
                                        { threshold: 0, rootMargin: '-30px 0px 0px 0px' });
    io.observe(node);
    return { destroy() { io.disconnect(); totalOut = false; } };
  }
  function backToTotal() {
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    totalEl?.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  }

  /** Breathing room above a jumped-to card, so it does not sit flush against the viewport edge. */
  const SCROLL_PAD = 16;

  let flashed: Element | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** Mark the card we just jumped to, briefly. Reduced-motion still gets the ring (it is a
   *  colour change, not movement) — it just does not animate away. */
  function flashCard(card: Element) {
    clearTimeout(flashTimer);
    flashed?.classList.remove('jump-flash');
    card.classList.add('jump-flash');
    flashed = card;
    flashTimer = setTimeout(() => { card.classList.remove('jump-flash'); flashed = null; }, 1600);
  }

  async function scrollToStepTop() {
    await tick();
    const el = document.querySelector('.steps');
    if (!el) return;   // "show me everything at once" has no strip and nothing to jump between
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: still ? 'auto' : 'smooth', block: 'start' });
  }

  function nextStep() {
    if (!canAdvance) {
      // Take them to the one thing standing in the way, rather than absorbing the press silently.
      const el = document.getElementById('event-name') as HTMLInputElement | null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el?.focus();
      return;
    }
    markMailSeen();
    if (sub < subCount) { sub += 1; void scrollToStepTop(); return; }
    if (step < LAST_STEP) { step += 1; sub = 1; void scrollToStepTop(); }
  }
  function prevStep() {
    markMailSeen();
    if (sub > 1) { sub -= 1; void scrollToStepTop(); return; }
    if (step > 1) { step -= 1; sub = subsFor(step, !!billing?.billingEnabled, editing); void scrollToStepTop(); }
  }
  /** The furthest step reached. Anything up to it has been filled in and can be jumped to. */
  let maxStep = 1;
  $: if (step > maxStep) maxStep = step;

  /**
   * Jump to any step already reached, in either direction.
   *
   * It used to travel backwards only, on the reasoning that a step ahead had not been filled in —
   * true of a step nobody has visited, and false of one you have just walked back from. Going back
   * to check the name and then having to press Next three times to return is a tax on looking.
   *
   * Forward still obeys the one real gate: the name. Clear it on step 1 and the strip cannot carry
   * you past it any more than the button can.
   */
  /** Jump to a specific page WITHIN a step — what the summary's rows do.
   *  goToStep() always lands on sub 1, which is right for the step strip (you are picking a
   *  step) and wrong for the summary (you are picking a line, and the line for "Guests" lives
   *  on 1 of 3). Same guards: never past what has been unlocked, never forward off an
   *  incomplete page. */
  async function goToSection(n: number, s = 1, anchor?: string) {
    if (n < 1 || n > maxStep) return;
    if (n > step && !canAdvance) return;
    markMailSeen();
    step = n;
    sub = s;
    if (!anchor) {
      // No anchor still gets a flash. Guests reached this branch and was the one row that jumped
      // without confirming where it had landed — a difference the host has no way to explain.
      // Flash whatever card the step opens with, so a row added later cannot quietly lose it.
      await scrollToStepTop();
      const first = document.querySelector('.wrap .card');
      if (first) flashCard(first);
      return;
    }
    // Landing on the top of the right page still leaves the host hunting for the row they
    // pressed — on step 3 that can be four cards down. Scroll to the setting itself instead,
    // and NOT to the top as well: two smooth scrolls issued in the same frame fight, and the
    // one that wins is a coin toss.
    await tick();
    // One frame for the browser to lay the new step out: tick() only gets it into the DOM, and
    // scrollHeight read in the same frame can still be the previous (shorter) page.
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const el = document.getElementById(anchor);
    if (!el) { void scrollToStepTop(); return; }
    // Aim the whole CARD at the top rather than the heading: the card opens with its
    // illustration, so putting the heading flush at the top would cut the drawing off above the
    // fold and read as a rendering fault.
    const card = el.closest('.fx-item, .card') ?? el;
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const y = card.getBoundingClientRect().top + window.scrollY - SCROLL_PAD;
    window.scrollTo({ top: Math.max(0, y), behavior: still ? 'auto' : 'smooth' });
    // The LAST card on a step can never reach the top — the page runs out of scroll first (on
    // step 3 the retention card is 426px short of it, and no amount of scrolling fixes that
    // without padding the page with dead space). So say where you landed instead of relying on
    // position alone: a brief ring on the card the host actually asked for. Cheap, and it also
    // covers the cards that DO reach the top, where the eye still has to find them.
    flashCard(card);
  }

  function goToStep(n: number) {
    if (n < 1 || n > maxStep || n === step) return;
    if (n > step && !canAdvance) return;
    markMailSeen();
    step = n;
    sub = 1;
    void scrollToStepTop();
  }

  import Toggle from '$lib/components/Toggle.svelte';
  import TimeField from '$lib/components/TimeField.svelte';
  import { getConfig, getMe, api } from '$lib/api';
  import { track } from '$lib/analytics';
  import { createEvent, joinEvent, getAdmin, saveSettings, REVEAL_CUSTOM, REVEAL_TICK_MS,
           ceilToRevealTick, zonedWallTimeToMs, msToZonedWallTime, revealMomentLabel, revealInstantRefusal,
           type AdminEvent } from '$lib/events';
  import { subsFor, startLocked, prefillFromEvent, editSettingsBody, editChanges,
           editIdentifier, slugVerdict } from '$lib/eventEdit';
  import { GUEST_DELIVERY_DEFAULT, GUEST_DELIVERY_OPTIONS, GUEST_DELIVERY_AT_CREATION, guestReleaseAt, releaseDateKnown,
           reminderCanFire, reminderFiresAt, revealInstant, scheduledSendIssue, scopeFor,
           isManualDelivery,
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
  import { shotWindowStart } from '$lib/shotWindow';
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

  /** The shots ladder, shown three rungs at a time.
   *
   *  All six (12 … 72) as one row of chips made the big numbers look like ordinary choices sitting
   *  there waiting to be picked, when what they actually are is a deliberate step up — and the row
   *  only gets longer as the ladder does. Three at a time with "go bigger" / "go smaller" keeps the
   *  question small, starts everyone at the included 12, and makes reaching 72 something a host
   *  does on purpose.
   *
   *  The window follows the SELECTION rather than the other way round: whatever is chosen is always
   *  on screen, so stepping the window can never hide the answer the host has already given. */
  const SHOT_WINDOW = 3;
  let shotWin = 0;
  /** Opened ONCE, on whatever is already chosen — see shotWindowStart. After that the two step
   *  buttons own the window, or pressing them does nothing. */
  let shotWinOpened = false;
  $: shotLadder = (options?.shotsPerPerson ?? []).map((sp) => ({ ...sp, n: Number(sp.value) }));
  $: if (!shotWinOpened && shotLadder.length) {
    shotWin = shotWindowStart(shotLadder.length, shotLadder.findIndex((sp) => sp.n === Number(maxPhotos)), 0, SHOT_WINDOW);
    shotWinOpened = true;
  }
  const stepShots = (by: number) => { shotWin = shotWindowStart(shotLadder.length, -1, shotWin + by, SHOT_WINDOW); };
  $: shotView = shotLadder.slice(shotWin, shotWin + SHOT_WINDOW);
  $: canShotsBigger = shotWin + SHOT_WINDOW < shotLadder.length;
  $: canShotsSmaller = shotWin > 0;
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
    // The PITCH is computed, not fixed at 6.5, and that is the whole repair. 6.5 fitted four rows
    // in a 78×40 box, which was every ladder this drawing had ever been asked to show — and then the
    // ladder grew to 120, which is ten rows. The grid ran off the bottom of its own viewBox, `top`
    // went negative, and the states were still correct on dots nobody could see. Whatever the top
    // rung becomes, the grid now fits: the smaller of what the width allows and what the height
    // does, so the dots stay round and stay inside.
    const pitch = Math.min(78 / perRow, 40 / rows);
    const r = pitch * 0.4;
    // Centred both ways — a short ladder must not sit in the top-left corner of the box.
    const left = (78 - Math.min(most, perRow) * pitch) / 2 + pitch / 2;
    const top = (40 - rows * pitch) / 2 + pitch / 2;
    return Array.from({ length: most }, (_, i) => ({
      cx: (i % perRow) * pitch + left,
      cy: Math.floor(i / perRow) * pitch + top,
      r,
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
  /** Lit = a shape guests can actually choose on this event. `packOn`, `sel` and `edit` are all
   *  arguments so the tiles relight the moment any of them changes.
   *
   *  An edit reads the event's OWN shape list rather than the pack switch: a promo, or an upgrade
   *  that bought some shapes and not others, leaves an event entitled to a set that "pack on/off"
   *  cannot describe — and this drawing is the only place the host can see which. */
  const shapeLit = (value: string, packOn: boolean, sel: Record<string, boolean>, edit: boolean) =>
    edit ? !!sel[value] : (billing?.billingEnabled ? (packOn || value === '1:1') : !!sel[value]);

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
  /** Several LISTS instead of one, so guests are not all hunting the same five shots. Off for the
   *  same reason seedMissions is: it changes what a guest is handed. (They become separate printed
   *  cards later, on the poster step — but the wizard does not say "card" this early, because the
   *  host has not met one yet.) */
  let trickVariety = false;
  /** How many lists "change it up" makes. Three is enough for a room to feel different without
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
  // The same refusal the server applies, run as the host types. Without it the wizard cheerfully
  // accepted a reveal in the PAST — which opens the gallery while the party is still going, on a
  // product whose whole promise is that it does not. Checked against `guestEndsAt`, the end read in
  // the EVENT's zone: `eventEndsAt` above goes through the browser's clock, so a host in Sydney
  // booking a Perth event is two hours out, which is exactly the size of mistake that matters here.
  $: revealIssue = (wantsCustomReveal && actualRevealAt !== null)
    ? revealInstantRefusal(actualRevealAt,
        { expiresAt: guestEndsAt, purgeAt: guestEndsAt + (Number(retentionDays) || 7) * 86_400_000 },
        Date.now())
    : null;
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
  $: guestLiveAutomatic = !isManualDelivery(guestDelivery);
  $: guestReminderOffered = reminderCanFire(guestEndsAt, guestReleaseMs);
  // Both optional rows on the email page are HIDDEN when they do not apply, rather than shown
  // disabled. What that costs is the one thing a disabled row was doing: telling you it exists. So
  // the page remembers what it offered when you last left it, and says so when that changes.
  //
  // Everything that can change it — the event's length (step 2), the reveal (4a), the delivery mode
  // and send time (4b) — sits BEFORE the email page, and goToStep only travels backwards, so a host
  // always walks forward through it again after a change. Nothing has to drag them back; the row
  // just has to announce itself when they arrive.
  let mailSeen: { reminder: boolean; live: boolean } | null = null;
  const onMailPage = () => step === 4 && sub === 3;
  /** Called on the way OUT, not in: on the way in, "what was here last time" is still the question. */
  function markMailSeen() { if (onMailPage()) mailSeen = { reminder: guestReminderOffered, live: guestLiveAutomatic }; }
  $: mailNewReminder = !!mailSeen && guestReminderOffered && !mailSeen.reminder;
  $: mailHasNew      = mailNewReminder;
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
  // Hearts on, comments off — the schema's defaults, and the reasoning is in migration 0057/0060:
  // a heart only ADDS to a screen, while a comment puts one guest's words on another's gallery.
  let heartsEnabled = true;
  let commentsEnabled = false;
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
    maxGuests, videoSeconds, framePackOn, allowDownloads, noFlash, heartsEnabled, commentsEnabled, revealMode,
    revealDelayHours, revealDate, revealTime, moderationEnabled, eventType, seedMissions, trickVariety,
    guestDelivery, guestSendScope, guestSendDate, guestSendTime,
    guestMailThanks, guestMailReminder, guestMailLive,
  });
  /**
   * The draft, but never while editing.
   *
   * A create draft and an edit are the same set of field names over two completely different
   * events, so they must not touch each other in either direction: a half-finished create must not
   * leak its guest tier into somebody's live event, and an edit must not be restored over a later
   * create as though it were an abandoned attempt. Edit mode never reads the draft (see onMount)
   * and this is the other half — it never writes one.
   */
  function persistDraft() {
    if (editing) return;
    saveDraft(DRAFT_FIELDS());
  }
  function restoreDraft() {
    const d = readDraft();
    if (!d) return false;
    ({ name, slug, startDate, startTime, durationHours, maxPhotos, retentionDays, retentionTouched, timezone,
       maxGuests, videoSeconds, framePackOn, allowDownloads, noFlash, heartsEnabled, commentsEnabled, revealMode,
       revealDelayHours, revealDate, revealTime, moderationEnabled, eventType, seedMissions, trickVariety,
       guestDelivery, guestSendScope, guestSendDate, guestSendTime,
       guestMailThanks, guestMailReminder, guestMailLive } = { ...DRAFT_FIELDS(), ...d });
    return true;
  }
  /** Signed out: keep what they typed, then send them to sign in and come straight back. */
  function goSignIn(path: '/login' | '/signup') {
    persistDraft();
    goto(`${path}?next=/app`);
  }

  // ── Join form state ──
  let joinName = '';
  let joinCode = '';
  let joining = false;

  const pad = (n: number) => String(n).padStart(2, '0');

  onMount(async () => {
    // It is a route, so the mode is in the URL. The organizer code travels in the HASH, matching
    // the /admin/[code]#organizerCode convention the rest of the product already uses — it is a
    // bearer credential and a hash is the one part of a URL that never reaches the server logs.
    const qs = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
    const editParam = qs?.get('edit') || '';
    if (editParam) {
      // A join code OR a custom slug — /admin/[code] resolves both, so this link carries whichever
      // the host's own URL had. See editIdentifier(): uppercasing and stripping punctuation is right
      // for a code and turns a slug into a 404.
      editCode = editIdentifier(editParam);
      try { editOrg = decodeURIComponent((location.hash || '').slice(1)); }
      catch { editOrg = (location.hash || '').slice(1); }
      editing = !!editCode && !!editOrg;
      if (editCode && !editOrg) editError = 'This link is missing your organiser code — open your event page and try the button there again.';
    }

    try { loggedIn = !!(await getMe()).user; } catch { /* anon */ }
    // Coming back from sign-in: put their event back the way they left it. Never while editing —
    // a half-finished create is about a different event entirely.
    if (!editing && restoreDraft()) draftRestored = true;
    const tm = new Date();
    todayStr = `${tm.getFullYear()}-${pad(tm.getMonth() + 1)}-${pad(tm.getDate())}`;   // today = earliest allowed
    if (!editing) {
      // Default the start to midnight at the beginning of the following day — events are almost
      // always planned ahead, and this avoids accidentally starting one mid-creation. An edit has
      // a real start already, and moving it to tomorrow before the event has even loaded would be
      // a reschedule the host never asked for.
      tm.setDate(tm.getDate() + 1);
      tm.setHours(0, 0, 0, 0);
      startDate = `${tm.getFullYear()}-${pad(tm.getMonth() + 1)}-${pad(tm.getDate())}`;
      startTime = '00:00';
    }

    // Timezone list + detected default.
    try {
      timezones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
    } catch {
      timezones = [];
    }
    if (!timezones.length) timezones = ['UTC'];
    deviceTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    if (!editing) timezone = deviceTz;   // an edit gets the event's own zone, below

    // Pre-fill join code from ?code= and switch to the join tab. Not while editing: the two would
    // fight over the same screen, and ?edit is unambiguous about which one the host asked for.
    const codeParam = editing ? null : (qs?.get('code') ?? null);
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

    // AFTER the config, never before: the block above assigns the defaults for duration, shots,
    // reveal mode and the shape ticks, so loading the event first would have every one of the
    // host's own answers overwritten a moment later by a default.
    if (editing) await loadForEdit();
  });

  // Both timers on this page outlive it otherwise, and both then act on a component that is gone:
  // the slug check assigns `slugFeedback` (and holds a fetch open) up to 250ms plus a round trip
  // after the host has navigated away, and the jump flash reaches into a card element that is no
  // longer in the document to take a class off it. Neither has anything to flush — they are
  // feedback, not work — so unlike the poster designer's save these are simply cancelled.
  onDestroy(() => {
    clearTimeout(slugCheckTimer);
    clearTimeout(flashTimer);
  });

  /**
   * Put a real event into the form.
   *
   * The organizer code in the hash is the whole of the authentication here — the same credential
   * the admin page runs on — so there is no sign-in branch and no getMe() gate. Someone without it
   * gets the server's 401, which is the correct answer.
   */
  async function loadForEdit() {
    editLoading = true;
    editError = '';
    try {
      const ev = await getAdmin(editCode, editOrg);
      editEvent = ev;
      // The same field list DRAFT_FIELDS enumerates, plus the blurb — which the draft has never
      // carried (a separate, pre-existing gap) and which an edit plainly has to.
      ({ name, blurb, slug, timezone, startDate, startTime, durationHours, maxPhotos, retentionDays,
         maxGuests, videoSeconds, framePackOn, allowDownloads, noFlash, heartsEnabled, commentsEnabled, revealMode,
         revealDelayHours, revealDate, revealTime, moderationEnabled, eventType,
         guestDelivery, guestSendScope, guestSendDate, guestSendTime,
         guestMailThanks, guestMailReminder, guestMailLive } = prefillFromEvent(ev));
      // The host picked this length and paid for it; nothing here may quietly move it back to a
      // tier default. (retentionFor() leaves a "touched" value alone.)
      retentionTouched = true;
      for (const a of options?.aspectRatios ?? []) selectedAspects[a.value] = ev.aspectRatios.includes(a.value);
      selectedAspects = selectedAspects;
      // Decided HERE, once, from what the server has already told us — not discovered on save. An
      // event that has started and been used cannot be moved, and walking a host through choosing
      // a new date and then answering them with a 409 four screens later is the exact failure this
      // whole mode is meant to avoid.
      startFixed = startLocked(ev);
      // A tick, because every label below is a `$:` derivation of what was just assigned and none
      // of them has recomputed yet. Captured before the tick, "what it was" would be a snapshot of
      // the empty form and every single row would read as a change.
      await tick();
      editBefore = editSummaryRows();
      if (slug) slugFeedback = slugVerdict(slug, { available: false }, slug);
    } catch (e) {
      editError = e instanceof Error ? e.message : 'Could not open that event';
    } finally {
      editLoading = false;
    }
  }

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
    // An event's OWN URL comes back from check-slug as unavailable — it is taken, by them. Without
    // this the one field that was already correct is the one field marked as an error.
    if (editing && editEvent?.slug && val === editEvent.slug) {
      clearTimeout(slugCheckTimer);
      slugFeedback = slugVerdict(val, { available: false }, editEvent.slug);
      return;
    }
    // Whatever is on screen describes a shorter version of this name — most often the "Too short"
    // from one or two characters ago — so it goes now rather than sitting there contradicting the
    // box while the next answer is fetched.
    slugFeedback = null;
    // "Checking…" used to be set HERE, on every keystroke, and the timer below was 500ms and reset
    // on every keystroke too. So from the second character onward the field said it was checking
    // while nothing was happening, and the answer only landed half a second after you stopped
    // typing — which reads as a very slow check. The request itself takes about five milliseconds.
    //
    // Now the word appears only when a request is actually in flight, and the wait before firing is
    // short enough to feel like a response rather than a delay.
    slugCheckTimer = setTimeout(async () => {
      slugFeedback = { text: 'Checking…', cls: 'muted' };
      try {
        const data = await api<{ available: boolean; slug?: string; reason?: string }>(
          '/api/events/check-slug/' + encodeURIComponent(val)
        );
        // The answer is about `val`, which may no longer be what is in the box: on a slow
        // connection two checks can be in flight and the older one can land last, leaving a verdict
        // about a name the host has already changed.
        if (val !== slug) return;
        // A short reserved list exists now, and "✗ Already taken — try a different name" sent a
        // host off inventing variations of a word nobody has. slugVerdict says which it is.
        slugFeedback = slugVerdict(val, data, editing ? editEvent?.slug : null);
      } catch {
        if (val === slug) slugFeedback = null;
      }
    }, 250);
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
    if (revealIssue) { showToast(revealIssue, true); return; }
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
        heartsEnabled,
        commentsEnabled,
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

  // ── Save (edit mode) ───────────────────────────────────────────────────────

  const onOff = (b: boolean) => (b ? 'On' : 'Off');

  /**
   * The event as a set of labelled lines, for the last step's change list.
   *
   * Only the EDITABLE half of the wizard appears here. A summary that listed the guest tier or the
   * event's length would be listing rows that can never differ, which is a list that teaches a
   * reader to stop reading it.
   */
  function editSummaryRows(): Record<string, string> {
    const rows: Record<string, string> = {
      'Event name': name.trim(),
      // Now that it saves, it has to be on the change list — the last step asks "are you sure",
      // and a field the wizard can change but does not report is the same lie in the other
      // direction. '—' rather than "Not set": every other optional row on this list reads that way.
      'Kind of event': EVENT_TYPES.find((t) => t.key === eventType)?.label ?? '—',
      'Welcome blurb': blurb.trim() || '—',
      'Timezone': timezone || '—',
      'Custom URL': slug.trim() ? `/e/${slug.trim()}` : '—',
      'Photos appear': (options?.revealModes ?? []).find((m) => m.value === revealMode)?.label ?? revealMode,
      'Allow downloads': onOff(allowDownloads),
      'No flash': onOff(noFlash),
      'Guest hearts': onOff(heartsEnabled),
      'Guest comments': onOff(commentsEnabled),
      'Guests get their copy': GUEST_DELIVERY_OPTIONS.find((o) => o.value === guestDelivery)?.label ?? guestDelivery,
      'Thank-you email': onOff(guestMailThanks),
    };
    // Omitted rather than shown as "—" when they do not apply: a row that cannot be set is not a
    // row whose value is nothing, and the difference matters on a list whose whole job is to say
    // what changed.
    if (!startFixed) rows['Starts'] = startPreview || `${startDate} ${startTime}`;
    if (revealMode !== 'instant') rows['Moderate photos'] = onOff(moderationEnabled);
    if (guestRevealLabel) rows['Gallery opens'] = guestRevealLabel;
    if (guestDelivery === 'scheduled' && guestSendLabel) rows['Sent to guests'] = guestSendLabel;
    if (guestReminderOffered) rows['Day-before reminder'] = onOff(guestMailReminder);
    return rows;
  }
  // A primitive signature of everything the summary reads, exactly as the live quote above does it.
  // Svelte tracks what a reactive statement MENTIONS, not what a function it calls happens to read —
  // so `$: editAfter = editSummaryRows()` recomputed only when `editing` or `editEvent` changed, and
  // the last step listed no changes at all no matter what the host altered. Same bug that once
  // deleted a wizard sub-page; the fix there was a parameter, and here it is a signature, because
  // eighteen positional arguments would be a worse thing to keep in step.
  $: editSig = JSON.stringify([
    name, blurb, timezone, slug, eventType, revealMode, revealDelayHours, revealDate, revealTime,
    allowDownloads, noFlash, heartsEnabled, commentsEnabled, moderationEnabled, guestDelivery, guestMailThanks, guestMailReminder,
    guestReminderOffered, startDate, startTime, startFixed, startPreview,
    guestRevealLabel, guestSendLabel, options?.revealModes?.length ?? 0,
  ]);
  $: editAfter = editing && editEvent && editSig ? editSummaryRows() : {};
  $: editDiff = editing ? editChanges(editBefore, editAfter) : [];

  async function submitEdit() {
    if (saving || !editEvent) return;
    if (!name.trim()) { showToast('Enter an event name', true); return; }
    // The same three guards submitCreate uses, and for the same reason: by the time Save is pressed
    // the control in question is several screens back, and a toast about a field you cannot see is
    // not an answer.
    if (wantsCustomReveal && actualRevealAt === null) {
      showToast('Pick the date and time for the reveal', true); return;
    }
    if (revealIssue) { showToast(revealIssue, true); return; }
    if (guestSendIssue === 'missing') {
      showToast('Pick the date and time to send your guests the photos', true); return;
    }
    if (guestSendIssue === 'before-reveal') {
      showToast('Your send time is before the photos are revealed — pick a later one', true); return;
    }
    // Resolved in the EVENT's zone, and rounded onto the same tick a reveal is checked on — the
    // same two rules creating one follows, because a save that read the browser's zone would move
    // a Perth event every time a host in Sydney opened it.
    const startsAt = startDate
      ? ceilToRevealTick(
          zonedWallTimeToMs(startDate, startTime || '00:00', timezone || 'UTC')
            ?? new Date(`${startDate}T${startTime || '00:00'}`).getTime())
      : null;
    saving = true;
    try {
      await saveSettings(editCode, editOrg, editSettingsBody({
        name, blurb, slug, timezone,
        startsAt, startDate, startTime,
        originalStartsAt: editEvent.startsAt, startLocked: startFixed,
        revealMode, revealDelayHours, wantsCustomReveal, revealDate, revealTime,
        moderationEnabled, allowDownloads, noFlash, heartsEnabled, commentsEnabled,
        // null included, and sent every time: the chips toggle off as well as on, so leaving the
        // key out would make "actually, none of these fit" the one change that could not be saved.
        eventType,
        guestDelivery, guestSendScope, guestSendAt,
        guestMailThanks, guestMailReminder, guestReminderOffered,
        // The value the event already holds, NOT the derived one. editSettingsBody() forces it on
        // for the automatic modes, where it is the mechanism, and leaves a manual mode's alone —
        // which is the host's own choice, made on the admin page's switch, and not this wizard's to
        // reset. prefillFromEvent() is where this arrived from.
        guestMailLive,
      }));
      showToast('Saved');
      goto(adminHref);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Save failed', true);
      saving = false;   // NOT in a finally: the success path navigates away, and re-enabling the
                        // button under a page that is leaving invites a second save of the same thing.
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

<svelte:head><title>{editing ? 'Your event setup — Snapdini' : 'Create or join — Snapdini'}</title></svelte:head>

<main class="page">
  <!-- The tabs below are the visual heading, so this names the page for a screen reader without
       putting a title on a design that does not have one. -->
  <h1 class="sr-only">{editing ? 'Walk through your event setup' : 'Create or join an event'}</h1>
  <div class="top">
    <!-- Home, like the mark on every other page. It used to go to /dashboard when signed in, which
         made it the one logo in the product that did something different — and pointless here,
         since "← My events" is the next element along and goes exactly there. -->
    <a class="brand" href="/"><Logo /></a>
    {#if editing}
      <a class="myevents" href={adminHref}>← Back to my event</a>
    {:else if loggedIn}
      <a class="myevents" href="/dashboard">← My events</a>
    {/if}
  </div>

  {#if editing}
    <!-- No Create/Join tabs: neither is what this page is doing, and a "Create Event" tab sitting
         above a form full of an existing event's details is an invitation to make a second one by
         accident. -->
    <div class="edit-banner">
      <div class="eb-t">Your setup, step by step</div>
      <p class="eb-s">
        {#if editEvent}The same questions you answered for <b>{editEvent.name}</b>, with your answers
          filled in. Change what you like — nothing is saved until the last step.
        {:else}Opening your event…{/if}
      </p>
    </div>
    {#if editError}
      <div class="card edit-err">
        <p class="ee-t">We couldn't open that event.</p>
        <p class="ee-s">{editError}</p>
        <a class="btn ghost" href={adminHref}>← Back to my event</a>
      </div>
    {/if}
  {:else}
    <div class="tabs">
      <button class="tab" class:active={tab === 'create'} on:click={() => (tab = 'create')}>
        Create Event
      </button>
      <button class="tab" class:active={tab === 'join'} on:click={() => (tab = 'join')}>
        Join Event
      </button>
    </div>
  {/if}

  {#if editing && (editLoading || !editEvent)}
    {#if !editError}<p class="edit-loading">Loading your event…</p>{/if}
  {:else if tab === 'create'}
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
      <!-- No running total on an edit. Nothing on these pages can add a penny to the event, so a
           price that never moves would be a number asking to be worried about. -->
      {#if quote && !editing}
        <div class="wiz-total" use:watchTotal>
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
          {#if i + 1 <= maxStep && i + 1 !== step}
            <button class="stepdot visited" class:done={i + 1 < step} type="button"
                    aria-label={`Go to step ${i + 1}, ${t}`}
                    on:click={() => goToStep(i + 1)}>
              <span class="sd-n">{i + 1 < step ? '✓' : i + 1}</span>
              <span class="sd-t">{t}</span>
            </button>
          {:else}
            <div class="stepdot" class:on={i + 1 === step} class:visited={i + 1 <= maxStep}
                 aria-current={i + 1 === step ? 'step' : undefined}>
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
        <!-- The SAME chips when editing. This was read-only text, on the reasoning that the type
             is "written by the same endpoint" as the trick list and changing it would regenerate a
             list the host had edited. Only half of that was true, and the wrong half: PUT
             /challenges does write both columns at once and cannot be asked for the type alone —
             but nothing derives the list from the type (the packs are front-end, seeding is a
             one-shot client action at creation), so the type on its own is a plain column and
             PUT /settings now writes it. See eventEdit.ts's EDIT_ELSEWHERE.
             The read-only line also could not answer the one host who most needed it: with no type
             ever chosen it rendered the words "Not set", in the weight and colour of a heading,
             with nowhere to go. There was nothing to protect and no way forward. -->
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
          {#if editing}
            It decides the photo ideas we suggest and the look of the printed cards. Changing it
            leaves your trick list exactly as it is —
            <a href={adminHref}>add, edit or print those on your event page</a>.
          {:else}
            We'll suit the photo ideas and the printed cards to it. Skip it if none of them fit —
            your event works exactly the same either way, and you can say later.
          {/if}
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
      {#if editing}
        <!-- The switch here is a one-shot seed that runs at creation. Your event is past that: the
             list exists (or does not), the host may have rewritten every line of it, and a "build
             me a list" toggle would overwrite that with a generated one. So this says what the
             list IS and points at the editor that can actually change it. -->
        <div class="field">
          <p class="ro-label">Trick list</p>
          <p class="ro-line">
            {#if editEvent?.challengeSets?.length}
              <b>{editEvent.challengeSets.length} list{editEvent.challengeSets.length === 1 ? '' : 's'}</b>,
              {editEvent.challengeSets[0].items.length} shots each
            {:else}<span class="ro-none">None yet</span>{/if}
          </p>
          <p class="field-hint">
            A few shots not to miss that guests tick off in their camera.
            <a href={adminHref}>Add, edit or print them on your event page</a> — that editor can
            change individual shots, which this page never could.
          </p>
        </div>
      {:else}
      <div class="field">
        <div class="toggle-field" class:locked={!eventType}>
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

      {#if eventType && seedMissions}
        <!-- Only once the list exists: a control for varying something that is switched off is a
             question about nothing. -->
        <div class="field">
          <div class="toggle-field">
            <span class="tf-label"><label for="trick-variety">Change it up</label></span>
            <Toggle id="trick-variety" bind:checked={trickVariety} />
          </div>
          <!-- "lists", not "cards". The event-type page above does mention "the printed cards", so
               the word is not brand new — the trouble is that it is AMBIGUOUS right here. The
               control one line up is called *Trick list*, so "3 different cards" makes a reader
               stop and work out whether it means three trick lists or three poster designs. It
               means lists, so it says lists; the printing is a later step's business. -->
          <p class="field-hint">
            Make {VARIETY_SETS} different lists instead of one, so guests aren't all hunting the same
            shots. The must-haves stay on every list. Add, edit or remove any of them later.
          </p>
        </div>
      {/if}
      {/if}

      <!-- It changes what a guest's phone DOES, which is this page's subject and not "Other
           settings" two steps away. -->
      <div class="field toggle-field">
        <span class="tf-label">
          <label for="no-flash">No flash</label>
          <HelpTip text={`Stops guests' phones firing the bright rear camera flash — handy for ceremonies, dark venues or anywhere a flash would be disruptive. The gentle front-camera selfie flash still works.`} />
        </span>
        <Toggle id="no-flash" bind:checked={noFlash} />
      </div>

      <div class="field">
        <label for="event-blurb">Welcome blurb <span class="hint">(optional — shown on the join screen)</span></label>
        <textarea id="event-blurb" maxlength="280" rows="2" placeholder="e.g. Snap away — every photo's a surprise until the big reveal!" bind:value={blurb}></textarea>
      </div>
    </div>
    {/if}

    <!-- 1c ── How big it is, and therefore what it costs. -->
    {#if !guided || sub === 3}
    <div class="card" id="guests-card">
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
      {#if startFixed}
        <!-- Said HERE, up front, not discovered on save. The server answers a moved start with a
             409, and the alternative to this block is walking a host through picking a new date and
             refusing it four screens later.
             Plain markup rather than disabled inputs: a disabled control consumes no taps, so on a
             phone the tap falls through to the text behind it and the browser throws up its own
             selection menu over the page. -->
        <p class="ro-label">Starts</p>
        <p class="ro-line"><b>{startPreview || `${startDate} ${startTime}`}</b></p>
        <p class="field-hint ro-why">
          Locked. Your event has started and guests have joined, so moving it now would move it
          under them. Everything else on these pages can still be changed.
        </p>
      {:else}
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
      {/if}
        <!-- The timezone picker lives in Advanced settings, which meant this card never said what
             these times MEAN. A host setting 7pm had no way to know the event was stored in another
             zone until the day it ran. -->
        <p class="tz-line">
          Times are in
          <button type="button" class="tz-name" on:click={openTimezone}
                  title="Change the event's timezone">{timezone || '…'}</button>{#if startPreview}{' '}— starts {startPreview}{/if}
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
      {#if editing}
        <!-- Shown, not hidden. Length is a paid entitlement and Settings deliberately preserves it
             across a reschedule — so offering the dropdown here would take an answer and drop it.
             Taking the question away instead would remove the sentence that explains what the
             length even is, which is most of why a host opened this. -->
        <p class="ro-label">How long it runs</p>
        <p class="ro-line">
          <b>{(options?.durations ?? []).find((d) => Number(d.value) === Number(durationHours))?.label ?? `${durationHours}h`}</b>
          <span class="ro-tag">included in your event</span>
        </p>
        <p class="field-hint">
          The window guests can take photos in. Moving the start above keeps this length, so the
          event ends the same number of hours later.{#if billing?.billingEnabled}{' '}<a href={upgradeHref}>Make it longer in Upgrades →</a>{/if}
        </p>
      {:else}
      <div class="field">
        <label for="duration">Duration</label>
        <select id="duration" bind:value={durationHours}>
          {#each options?.durations ?? [] as d}
            <option value={d.value}>{d.label}{#if billing?.billingEnabled && Number(d.value) > (billing.durationFreeHours ?? 24) && durationAddon(Number(d.value)) > 0}{' '}(+{money(durationAddon(Number(d.value)))}){/if}</option>
          {/each}
        </select>
        {#if billing?.billingEnabled}<p class="field-hint">Up to {Math.round((billing.durationFreeHours ?? 48) / 24)} days is free · longer is a paid add-on.</p>{/if}
      </div>
      {/if}
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

      {#if editing}
        <!-- The whole of this step is bought, so on an edit it becomes a reading page: what this
             event has, and what each one actually does. Nothing here submits anything. -->
        <p class="fx-intro">This is what your event includes, and what each one does. These are the
          parts you paid for, so they change in Upgrades rather than here —
          <a href={upgradeHref}>open Upgrades →</a></p>
      {:else if billing?.billingEnabled && freeAtSize(Number(maxGuests))}
        <!-- The gift, counted up, on the page where it is being given. It was previously visible
             only as a struck-through number in a quote breakdown two steps away. -->
        <p class="fx-gift">Your event is {billing.freeAllGuests} guests or fewer, so <b>all of this is
          yours, free</b>. The usual price is beside each one — that's what you're not paying.</p>
      {:else}
        <p class="fx-intro">None of this is switched on. Add whatever suits the day — your event
          works beautifully without any of it.</p>
      {/if}

      {#if editing && billing?.billingEnabled}
        <!-- Step 1's guests-and-price page is dropped on an edit — it is the tier and the live
             quote, which is a page about buying, on a thing already bought. The NUMBER is still
             worth knowing, so it moves here with the rest of the entitlements. -->
        <section class="fx-item">
          <div class="fx-head">
            <div class="fx-say">
              <h2 class="fx-name">How many guests</h2>
              <p class="fx-copy">How many people can join and take photos. Everyone gets their own
                shot allowance; the gallery is shared.</p>
            </div>
          </div>
          <p class="ro-line"><b>Up to {maxGuests} guests</b><span class="ro-tag">included in your event</span></p>
          <p class="field-hint"><a href={upgradeHref}>Room for more in Upgrades →</a></p>
        </section>
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
              <h2 class="fx-name" id="fx-video">Video clips</h2>
              <p class="fx-copy">Some moments won't hold still — the speech, the first dance, the dog
                getting the sausage. Guests get a record button beside the shutter, and the clips land
                in the gallery with the photos.</p>
            </div>
          </div>
          {#if editing}
            <p class="ro-line">
              {#if videoSeconds > 0}<b>{videoSeconds}-second clips</b><span class="ro-tag">included in your event</span>
              {:else}<b>Off</b><span class="ro-tag">photos only</span>{/if}
            </p>
            <p class="field-hint"><a href={upgradeHref}>{videoSeconds > 0 ? 'Longer clips in Upgrades →' : 'Add video in Upgrades →'}</a></p>
          {:else}
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
          {/if}
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
                        cx={d.cx} cy={d.cy} r={d.r} />
              {/each}
            </svg>
          </div>
          <div class="fx-say">
            <h2 class="fx-name" id="fx-shots">Shots each</h2>
            <p class="fx-copy">Everyone gets {billing?.shotsFree ?? 12} to start with. That's plenty
              over dinner and gone by the second song — give them more and they'll keep going all
              night.</p>
          </div>
        </div>
        {#if editing}
          <p class="ro-line"><b>{maxPhotos} each</b><span class="ro-tag">included in your event</span></p>
          <p class="field-hint"><a href={upgradeHref}>Give everyone more in Upgrades →</a></p>
        {:else}
        <div class="fx-choices" role="group" aria-label="Shots per guest">
          <!-- ALWAYS rendered, disabled at the ends rather than removed. A step is not a choice — it
               moves the window and picks nothing — and dropping it at the bottom of the ladder left
               four cards where there are otherwise five, so the row changed width as you moved
               through it and the rungs never sat in the same place twice. -->
          <button type="button" class="fx-chip step" on:click={() => stepShots(-1)} disabled={!canShotsSmaller}
                  aria-label="Show smaller options"><span class="fc-t">←</span><span class="fc-p">go smaller</span></button>
          {#each shotView as sp (sp.value)}
            {@const p = shotsPrice(billing, sp.n, Number(maxGuests))}
            {@const tag = priceTag(p, money)}
            <button type="button" class="fx-chip" class:on={Number(maxPhotos) === sp.n}
                    aria-pressed={Number(maxPhotos) === sp.n}
                    aria-label={billing?.billingEnabled ? `${sp.label} shots each, ${priceAria(p, money)}` : `${sp.label} shots each`}
                    on:click={() => (maxPhotos = sp.value)}>
              <span class="fc-t">{sp.label}</span>
              {#if billing?.billingEnabled}<span class="fc-p" class:was={tag.cls === 'was'} class:add={tag.cls === 'add'}
                      class:incl={tag.cls === 'incl'}>{tag.text}</span>{/if}
            </button>
          {/each}
          <button type="button" class="fx-chip step" on:click={() => stepShots(1)} disabled={!canShotsBigger}
                  aria-label="Show bigger options"><span class="fc-t">→</span><span class="fc-p">go bigger</span></button>
        </div>
        {/if}
      </section>

      <section class="fx-item">
        <div class="fx-head">
          <div class="fx-say">
            <h2 class="fx-name" id="fx-shapes">Frame shapes</h2>
            <p class="fx-copy">Square is what every event gets. Open the rest and guests choose the
              shape that suits the photo — tall for a person, wide for the room.</p>
          </div>
        </div>
        <!-- Not in the small art slot with the others: these are the real proportions at a shared
             height, so the WIDTHS are the comparison, and squeezing them into 78px would throw away
             the only thing they are here to show. -->
        <div class="shapes">
          {#each options?.aspectRatios ?? [] as a}
            <span class="shape-cell" class:lit={shapeLit(a.value, framePackOn, selectedAspects, editing)}
                  title={a.value === 'full' ? 'Full — no crop, whatever the phone gives' : a.label}>
              <span class="shape" class:lit={shapeLit(a.value, framePackOn, selectedAspects, editing)}
                    class:open={a.value === 'full'} style={shapeStyle(a.value)}></span>
              <span class="shape-n">{shapeName(a.label)}</span>
            </span>
          {/each}
        </div>
        {#if editing}
          <!-- The drawing above is already the read-only answer: the shapes this event has are lit
               and the rest are not. All this line has to add is a name for the set and the way to
               change it. -->
          <p class="ro-line">
            <b>{editEvent && editEvent.aspectRatios.length > 1 ? `${editEvent.aspectRatios.length} shapes` : 'Square only'}</b>
            <span class="ro-tag">included in your event</span>
          </p>
          {#if billing?.billingEnabled}
            <p class="field-hint"><a href={upgradeHref}>{framePackOn ? 'Manage shapes in Upgrades →' : 'Open the rest in Upgrades →'}</a></p>
          {/if}
        {:else if billing?.billingEnabled}
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

      {#if editing || retentionOptions.length}
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
              <h2 class="fx-name" id="fx-retention">Keep them longer</h2>
              <p class="fx-copy">
                {#if editing}
                  After the event ends your photos stay up for a while, and then they are gone for
                  good — there is no copy anywhere else. This is that window.
                {:else if billing?.billingEnabled}
                  Photos stay up for <b>{retentionLabel(retentionIncluded)}</b> after the event ends,
                  then they're gone for good. Give people longer if they'll be slow getting round to
                  it — and they always are.
                {:else}
                  How long the photos stay up after the event ends.
                {/if}
              </p>
            </div>
          </div>
          {#if editing}
            <p class="ro-line"><b>{retentionLabel(retentionDays)} after it ends</b><span class="ro-tag">included in your event</span></p>
            {#if billing?.billingEnabled}
              <p class="field-hint"><a href={upgradeHref}>Keep them longer in Upgrades →</a></p>
            {/if}
          {:else}
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
          {/if}
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
            {:else if revealIssue}
              <!-- The cheerful version used to print "Photos appear from ‹a date last week›" with no
                   hint that it was impossible. Say what is wrong, in the server's own words. -->
              <span class="bad">{revealIssue}</span>
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
            <!-- Not "as a zip": the gallery asks each guest how they want them, and a phone gets
                 individual files because a zip there needs an extractor (see saveImage.ts). Naming
                 one of the two answers in the HOST's switch describes something half their guests
                 will not see — and the format is not what this decision is about anyway. -->
            <p class="fx-copy">Guests can save single photos, or take the whole gallery at once. Turn
              it off and the gallery is look-only — everyone still sees the photos.</p>
          </div>
        </div>
      </section>

      <!-- Beside downloads because it is the same question in a different direction: what guests may
           do with each OTHER's photos. Two settings on one card rather than two cards, because a
           host weighs them together — and the pair is the whole of "can the gallery talk back". -->
      <section class="fx-item">
        <div class="fx-head">
          <div class="fx-art" aria-hidden="true">
            <svg class="fx-svg" viewBox="0 0 78 40">
              <path class="s-fillstroke" d="M22 32C22 32 8 24 8 15.5A7.5 7.5 0 0 1 22 11a7.5 7.5 0 0 1 14 4.5C36 24 22 32 22 32Z" />
              <rect class="s-line" x="46" y="8" width="24" height="17" rx="4" />
              <path class="s-line" d="M52 31l4-6" />
              <path class="s-line" d="M52 14h12M52 19h8" />
            </svg>
          </div>
          <div class="fx-say">
            <div class="fx-titlerow">
              <h2 class="fx-name"><label for="hearts-enabled">Guest hearts</label></h2>
              <Toggle id="hearts-enabled" bind:checked={heartsEnabled} />
            </div>
            <p class="fx-copy">Guests can heart each other's shots, and everyone sees how many each
              one has — including the person who took it.</p>

            <div class="fx-titlerow">
              <h2 class="fx-name"><label for="comments-enabled">Guest comments</label></h2>
              <Toggle id="comments-enabled" bind:checked={commentsEnabled} />
            </div>
            <!-- Says who can remove one, because that is the question a host weighs before turning
                 this on: it puts other people's words on their gallery. -->
            <p class="fx-copy">A short message on a photo, signed with the guest's name. Off unless
              you turn it on. You can delete any comment; a guest can delete their own.</p>
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
        <!-- Only the two a host can answer before the event. The other two ask about photographs
             nobody has taken yet — see GUEST_DELIVERY_AT_CREATION — and both live on the event page. -->
        {#each GUEST_DELIVERY_OPTIONS.filter((o) => GUEST_DELIVERY_AT_CREATION.includes(o.value)) as o}
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
      {#if moderationEnabled}
        <!-- The option above says "Nothing for you to do", which stops being true the moment
             moderation is on: guestSeesPhoto() only counts APPROVED shots, so an unapproved gallery
             is an empty one. And the sweep does not wait — on an empty scope it claims the event,
             emails the host and leaves the sending to them, permanently. A host who chose the
             hands-off option is owed that before the night, not after it. -->
        <p class="field-hint gd-moderated">
          <b>Moderate photos is on</b>, so guests only ever see shots you have approved. Approve some
          before the gallery opens. If none are approved by then, we email you rather than send your
          guests an empty page — and the link is yours to send after that.
        </p>
      {/if}

      <p class="field-hint gd-later">Two more options — send only your favourites, or schedule an
        exact time — are on your event page once the photos are in.</p>

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
      <!-- No row for the gallery link. It is not a choice — it IS the delivery chosen on the last
           page, and a permanently-on switch you cannot move is a row that wastes a reader's
           attention to tell them something they already decided. It is named here in a sentence
           instead, and guest_mail_live is still derived from the delivery mode on submit. -->
      <p class="lead-note mail-lead">These are extra emails, on top of the gallery link you've already
        set up. Only guests who asked for their photos get them.</p>

      <div class="mail-opt">
        <div class="field toggle-field">
          <span class="tf-label"><label for="g-thanks">Thank-you &amp; release date</label></span>
          <Toggle id="g-thanks" bind:checked={guestMailThanks} />
        </div>
        <!-- Not "email guests when the event ends": that would be a lie when this is off. The email
             is the guest's own doing — they asked for their photos — and this only decides what
             else it carries. -->
        <p class="field-hint">
          {#if guestThanksDated}Sent when your event ends, with the date their gallery opens.
          {:else}Sent when your event ends. There's no opening date to include — your gallery opens
            at that same moment.{/if}
        </p>
      </div>

      {#if guestReminderOffered}
        <div class="mail-opt" class:fresh={mailNewReminder}>
          <div class="field toggle-field">
            <span class="tf-label"><label for="g-reminder">Day-before reminder</label>{#if mailNewReminder}<span class="fresh-pill">new</span>{/if}</span>
            <Toggle id="g-reminder" bind:checked={guestMailReminder} />
          </div>
          <p class="field-hint">Sent {guestReminderLabel} — the day before their gallery opens.</p>
        </div>
      {/if}

    </div>
    {/if}

    {/if}

    <!-- Last step already shows the itemised quote, so the pill would be repeating what is on
         screen. Everywhere else it is the only copy of the number in view. -->
    {#if guided && quote && totalOut && step !== LAST_STEP && !editing}
      <button type="button" class="total-pill" on:click={backToTotal}
              aria-label="Running total, {quote.requiresPayment ? money(quote.amountCents) : 'free'} — scroll back to it">
        <span class="tp-l">Total</span>
        <span class="tp-v" class:free={!quote.requiresPayment}>{quote.requiresPayment ? money(quote.amountCents) : 'Free'}</span>
      </button>
    {/if}

    {#if !guided || step === LAST_STEP}
    {#if editing}
      <!-- The create wizard ends on a price. An edit has no price, so it ends on a list: the
           question a host has at this point is not "what does this cost" but "what am I about to
           do to an event that is already out there on a printed card". -->
      <div class="card">
        <div class="card-title">What you're changing</div>
        {#if editDiff.length === 0}
          <p class="ec-none">Nothing — everything is exactly as it was. That's a perfectly good
            outcome; you came to read, not to change.</p>
        {:else}
          <ul class="ec-list">
            {#each editDiff as c}
              <li class="ec-row">
                <span class="ec-l">{c.label}</span>
                <span class="ec-v"><s>{c.was}</s> → <b>{c.now}</b></span>
              </li>
            {/each}
          </ul>
        {/if}
        {#if startFixed}
          <p class="field-hint ec-foot">Your start time is locked and is not part of this save.</p>
        {/if}
        <p class="field-hint ec-foot">Guest numbers, length, video, shapes, shots and how long
          photos are kept aren't changed here — <a href={upgradeHref}>those live in Upgrades</a>.</p>
      </div>
      <button class="btn primary" on:click={submitEdit} disabled={saving}>
        {saving ? 'Saving…' : 'Save changes'}
      </button>
      <!-- A way out that is not a save. Most people who open this are here to read, and the only
           button on the page being one that writes to their live event is a poor reward for it. -->
      <a class="btn ghost signin-alt" href={adminHref}>← Back without saving</a>
      <p class="foot-note">Saving takes you back to your event page.</p>
    {:else}
    {#if guided && quote}
      <!-- The itemised quote, repeated here so the last thing before "Create" is what it costs and
           why. Rendered from the same `quote` object as step 1 — nothing is recomputed. -->
      <div class="card">
        <div class="card-title">What you're creating</div>
        <!-- Every row is a button back to the page that set it, and carries its own share of the
             price. Two reasons. A summary whose lines cannot be acted on makes a host who spots a
             wrong number walk the whole wizard again to reach it. And a single Total answers "how
             much" but never "why that much" — the per-line cost is what lets someone see that the
             extra shots, not the guest count, is what moved the number. The money comes from the
             same `quote` object as the itemised panel on step 1; nothing is recomputed here.
             Free lines follow that panel's idiom too: an included feature shows its would-be price
             struck through, so the line un-strikes into a real charge the moment the event grows
             past the free tier, instead of silently appearing. -->
        <div class="sum-rows">
          <button type="button" class="sum-row" on:click={() => goToSection(1, 1, 'event-name')}
                  aria-label="Event name — go back and change it">
            <span>Event</span><b>{name.trim() || 'Untitled'}</b><span class="sum-cost"></span>
          </button>
          <button type="button" class="sum-row" on:click={() => goToSection(1, 3, 'guests-card')}
                  aria-label="Guest count — go back and change it">
            <span>Guests</span><b>up to {quote.maxGuests}</b>
            <span class="sum-cost">{#if quote.baseCents}{money(quote.baseCents)}{:else}<span class="incl">Free</span>{/if}</span>
          </button>
          <button type="button" class="sum-row" on:click={() => goToSection(3, 1, 'fx-shots')}
                  aria-label="Shots per guest — go back and change it">
            <span>Shots each</span><b>{quote.maxPhotos}</b>
            <span class="sum-cost">{#if quote.shotsCents}{money(quote.shotsCents)}{:else if billing && quote.maxPhotos > billing.shotsFree}<span class="was">{money(shotsAddon(quote.maxPhotos))}</span>{:else}<span class="incl">Free</span>{/if}</span>
          </button>
          {#if quote.videoSeconds > 0}
            <button type="button" class="sum-row" on:click={() => goToSection(3, 1, 'fx-video')}
                    aria-label="Video clips — go back and change it">
              <span>Video</span><b>{quote.videoSeconds}s clips</b>
              <span class="sum-cost">{#if quote.videoCents}{money(quote.videoCents)}{:else}<span class="was">{money(videoBase(quote.videoSeconds))}</span>{/if}</span>
            </button>
          {/if}
          {#if quote.framePack}
            <button type="button" class="sum-row" on:click={() => goToSection(3, 1, 'fx-shapes')}
                    aria-label="Photo shapes — go back and change it">
              <span>Shapes</span><b>all shapes</b>
              <span class="sum-cost">{#if quote.frameCents}{money(quote.frameCents)}{:else if billing}<span class="was">{money(billing.framePackCents)}</span>{:else}<span class="incl">Free</span>{/if}</span>
            </button>
          {/if}
          <button type="button" class="sum-row" on:click={() => goToSection(2, 1, 'duration')}
                  aria-label="How long it runs — go back and change it">
            <span>Runs for</span><b>{(options?.durations ?? []).find((d) => Number(d.value) === durationHours)?.label ?? `${durationHours}h`}</b>
            <span class="sum-cost">{#if quote.durationCents}{money(quote.durationCents)}{:else}<span class="incl">Free</span>{/if}</span>
          </button>
          <!-- The one line on this summary that is a deadline rather than a setting: after it the
               photos are deleted, and a host who never opened the disclosure it used to live in had
               no idea the clock existed. -->
          <button type="button" class="sum-row" on:click={() => goToSection(3, 1, 'fx-retention')}
                  aria-label="How long photos are kept — go back and change it">
            <span>Photos kept</span><b>{retentionLabel(quote.retentionDays)} after it ends</b>
            <span class="sum-cost">{#if quote.retentionCents}{money(quote.retentionCents)}{:else}<span class="incl">Free</span>{/if}</span>
          </button>
          <div class="sum-row total"><span>Total</span><b class:free={!quote.requiresPayment}>{quote.requiresPayment ? money(quote.amountCents) : 'Free'}</b><span class="sum-cost"></span></div>
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
    background: var(--accent-fill);
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
  /* A field's label NAMES the control; the hint under it explains it. They were the same weight and
     the same colour, 0.64px apart, so "Event name" read as another line of explanation rather than
     as the heading of one. Weight and colour carry it — resizing every label in the form would be a
     much bigger change than the complaint. */
  /* Both idioms, HERE rather than only in app.css: a component's own <style> is emitted after the
     global sheet, so at equal specificity the muted `label` rule above wins and a global fix lands
     for weight but silently loses on colour — which is how the toggles ended up bold-but-grey
     beside a bright "Welcome blurb" in the same card. */
  .field > label,
  .tf-label > label {
    font-weight: 700;
    color: var(--text);
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
  /* A row that was not here last time the host looked. The page hides what does not apply, so an
     appearance is a real change and worth pointing at once. */
  /* The trick list needs an event type before it can do anything, so pressing it does nothing and
     it should not offer a hand. */
  .locked .tf-label > label { cursor: default; }

  .fresh-pill {
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.58rem; letter-spacing: 0.1em; text-transform: uppercase;
    color: #111; background: var(--accent-fill); padding: 3px 7px; border-radius: 999px; margin-left: 8px;
  }
  .mail-opt.fresh { border-left: 2px solid var(--accent); padding-left: 12px; margin-left: -14px; }

  .mail-lead {
    margin-bottom: 0;
    padding-bottom: 14px;
    border-bottom: 1px solid var(--border);
  }
  .mail-lead + .mail-opt { margin-top: 14px; }

  /* Which of step 1's pages this is. The strip above counts the five steps and cannot show this,
     and three presses of Next against a dot that never moves reads as a stuck button. */
  /* The strip's finished steps are real buttons now, so they need the button reset the div never
     needed — and a cursor that says they can be pressed. */
  /* Neutralise ONLY what a <button> brings that a <div> does not — and nothing .stepdot already
     declares. `button.stepdot` is (0,1,1) against .stepdot's (0,1,0), so it wins every collision:
     a blanket `border: 0` took the track segment away from every finished step, and `font: inherit`
     overrode the 0.75rem so the label jumped to body size the moment its number became a tick.
     Browser defaults lose to author rules whatever the specificity, so .stepdot's own border-top,
     font-size, padding-top, colour and alignment need no help here. */
  button.stepdot {
    font-family: inherit;
    /* A <button> takes `line-height: normal` from the browser while a <div> inherits the page's, so
       without this the finished steps sat 4px shorter than the ones beside them. */
    line-height: inherit;
    background: none;
    border-right: 0; border-bottom: 0; border-left: 0;
    padding-right: 0; padding-bottom: 0; padding-left: 0;
    cursor: pointer;
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
  .btn.ghost { background: transparent; color: var(--text); border-color: var(--border); }
  .btn.primary {
    background: var(--accent-fill);
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
    /* So scrollIntoView does not put the strip flush against the top edge. */
    scroll-margin-top: 14px;
    display: flex; align-items: flex-start; gap: 4px; margin: 0 0 14px;
  }
  .stepdot {
    flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 4px;
    /* The rule between dots is the dot's own top border, so the track cannot fall out of step with
       the markers the way a separately-positioned line does. */
    border-top: 2px solid var(--border); padding-top: 8px;
    color: var(--text-muted); font-size: 0.75rem; text-align: center;
  }
  /* Filled as far as you have BEEN, not as far as you are — walking back to step 1 should not make
     the progress you already made disappear. */
  .stepdot.on, .stepdot.visited { border-top-color: var(--accent); }
  .stepdot.on { color: var(--text); font-weight: 700; }
  .sd-n {
    width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center;
    justify-content: center; font-size: 0.75rem; font-weight: 700;
    background: var(--surface-2); border: 1px solid var(--border);
  }
  /* ORDER MATTERS, and it is the whole bug this fixes. The step you are ON is also a step you have
     VISITED, so it carries both classes — and these two selectors have identical specificity, which
     leaves the later one holding the pen. With `.visited` written last it repainted the number in
     the accent, on a disc already filled with the accent: yellow on yellow, so the current step
     read as a bare dot with no number in it at all. The other two wizards never showed this because
     their `on` and `done` states are mutually exclusive.
     `.on` goes last so the step you are standing on keeps its dark ink. */
  .stepdot.visited .sd-n { color: var(--accent); border-color: var(--accent); }
  .stepdot.on .sd-n { background: var(--accent-fill); color: var(--accent-ink, #111); border-color: var(--accent); }
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

  .total-pill {
    position: fixed;
    right: 14px;
    /* Clear of the home indicator on a phone, and of the Next button, which is in the page flow. */
    bottom: calc(14px + env(safe-area-inset-bottom, 0px));
    z-index: 30;
    display: flex; align-items: baseline; gap: 8px;
    padding: 9px 15px;
    font: inherit;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: 999px;
    box-shadow: 0 6px 22px rgba(0, 0, 0, 0.45);
    cursor: pointer;
  }
  .total-pill:hover { border-color: var(--accent); }
  .total-pill:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .tp-l { font-size: 0.72rem; color: var(--text-muted); }
  .tp-v { font-size: 0.95rem; font-weight: 800; color: var(--accent); }
  .tp-v.free { color: var(--success, #51cf66); }

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
  .fx-titlerow { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
  .fx-titlerow .fx-name { margin-bottom: 0; }
  /* A SECOND switch in the same card needs to look like a second question.
     Guest hearts and Guest comments share one card and one art slot, and each is a title row with
     two lines of copy under it. Stacked with nothing between them the second title started right
     off the back of the first one's last line, so the pair read as one setting with two switches
     rather than two settings. Keyed off "a title row that follows copy", so any card that grows a
     second toggle gets the same separation without being told. */
  .fx-copy + .fx-titlerow { margin-top: 20px; padding-top: 18px; border-top: 1px solid var(--border); }
  /* One feature to a card here, so nothing above to rule off against. */
  .card > .fx-item:only-of-type { border-top: 0; padding: 0; }
  .fx-item .fx-copy { margin-top: 5px; }
  .fx-item .fx-name label { cursor: pointer; }

  /* One line under a page's title saying what this page is FOR — the thing that stops "when do the
     photos appear" and "how do guests get them" reading as two settings for the same job. */
  /* A consequence of a choice made on the previous page, so it earns a little more weight than the
     hints around it without becoming a warning — nothing is wrong, there is just something to do. */
  .gd-moderated {
    margin-top: 14px;
    padding: 10px 12px;
    border-left: 2px solid var(--accent);
    background: var(--surface-2);
    border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  }
  .gd-moderated b { color: var(--text); }

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
  /* A step, not an option. Dashed and muted so it never reads as one of the numbers — and it can
     never take the .on treatment, because it selects nothing. */
  .fx-chip.step { border-style: dashed; color: var(--text-muted); }
  .fx-chip.step:hover:not(:disabled) { color: var(--text); }
  /* At the end of the ladder it stays in place and stops responding, so the row keeps its shape. */
  .fx-chip.step:disabled { opacity: 0.35; cursor: default; }
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

  .sum-rows { display: flex; flex-direction: column; gap: 2px; }
  /* Three tracks, not space-between: the prices must line up in a column of their own, or the
     eye cannot add them up. tabular-nums so the digits themselves line up too. */
  .sum-row { display: grid; grid-template-columns: minmax(5.5rem, auto) 1fr auto;
    align-items: baseline; gap: 12px; font-size: 0.85rem; text-align: left; width: 100%; }
  .sum-row span { color: var(--text-muted); }
  .sum-row b { min-width: 0; overflow-wrap: anywhere; }
  .sum-cost { font-variant-numeric: tabular-nums; white-space: nowrap; }
  /* Most rows are buttons back to the page that set them. Neutralise only what a <button> adds —
     the same lesson as the step strip, where a blanket reset killed the accent track and shrank
     every dot. `font: inherit` is NOT used: placed after a font-size it wipes it (it was doing
     exactly that in 7 files until today). */
  button.sum-row { background: none; border: 0; border-radius: 6px;
    font-family: inherit; color: inherit; cursor: pointer;
    padding: 5px 6px; margin: 0 -6px; }
  button.sum-row:hover { background: var(--surface-2); }
  button.sum-row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
  /* Non-interactive rows keep the same box so nothing shifts between them and the buttons. */
  .sum-row.total { padding: 8px 6px 0; margin: 4px -6px 0;
    border-top: 1px solid var(--border); font-size: 1rem; }
  .sum-row.total b { color: var(--accent); }
  /* Free is green everywhere else in this wizard (.quote-lines .incl, .tp-v.free, .wt-v.free,
     .fc-p.incl) and gold means "this costs money". The summary was the one place that said it in
     plain grey, which read as a different kind of answer. `.incl` exists already but is scoped to
     .quote-lines, so it needed saying here too. */
  .sum-cost .incl { color: var(--success); font-weight: 700; }
  /* :global because the class is added to a DOM node by hand, and Svelte's scoper only rewrites
     selectors it can see used in this component's markup.
     `outline`, not `box-shadow`, and offset: .fx-item has no horizontal padding, so a ring drawn
     on the border box runs flush along the option buttons inside it and reads as cut into them.
     An outline takes no space (so nothing reflows) and outline-offset lifts it clear of them.
     position/z-index because the ring is drawn OUTSIDE the box, in space the next sibling owns —
     and a later sibling with a background paints straight over it. That is what was clipping it. */
  :global(.jump-flash) {
    position: relative;
    z-index: 2;
    border-radius: var(--radius);
    animation: jumpflash 1.6s ease-out;
  }
  /* `-global-` on the KEYFRAMES, not just the class. Svelte scopes keyframe NAMES to the component
     that declares them, so `:global(.jump-flash)` was handing every other component a rule whose
     `animation: jumpflash` resolved to a scoped name that does not exist there — the class applied,
     the ring never painted, and nothing errored. The poster designer hit exactly this and had to
     work around it with a class of its own. Global rule, global keyframes, or neither. */
  @keyframes -global-jumpflash {
    0%, 55% { outline: 2px solid var(--accent); outline-offset: 4px; }
    100%    { outline: 2px solid transparent;   outline-offset: 4px; }
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.jump-flash) { animation: none; outline: 2px solid var(--accent); outline-offset: 4px; }
  }
  .sum-row.total b.free { color: var(--success); }

  /* ── Edit mode ─────────────────────────────────────────────────────────────
     A read-only answer, used everywhere a paid entitlement is shown instead of offered.
     Deliberately NOT a disabled control: a disabled button consumes no taps, so the press falls
     through to the text behind and a phone reads that as the start of a text selection, throwing
     its own Copy/Search menu over the page. Plain text cannot do that. */
  .ro-label { font-size: 0.8rem; font-weight: 700; margin: 0 0 4px; }
  .ro-line {
    display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px;
    margin: 0; font-size: 0.95rem; color: var(--text);
  }
  .ro-line b { font-weight: 800; }
  /* An absence is not a value. Rendered as a <b> it took the weight and the full --text colour of
     a real answer, so "None yet" read as a section title announcing nothing — which is exactly how
     the event-kind field's old "Not set" looked, and the complaint that started this. Subordinate
     to its own .ro-label, not dominant over it. Scoped to this class rather than applied to
     .ro-line, because every other read-only line on this page carries a real answer (a start time,
     a guest count, a retention window) that a host should be able to read at a glance. */
  .ro-line .ro-none { font-weight: 600; color: var(--text-muted); }
  .ro-tag {
    font-size: 0.7rem; font-weight: 700; letter-spacing: 0.02em; text-transform: uppercase;
    color: var(--text-muted); background: var(--surface-2); border-radius: 999px; padding: 2px 8px;
  }
  .ro-why { margin-top: 8px; }

  .edit-banner { margin: 0 0 18px; }
  .eb-t { font-size: 1.1rem; font-weight: 800; }
  .eb-s { margin: 4px 0 0; font-size: 0.82rem; line-height: 1.5; color: var(--text-muted); }
  .edit-loading { font-size: 0.85rem; color: var(--text-muted); }
  .edit-err .ee-t { margin: 0; font-weight: 800; }
  .edit-err .ee-s { margin: 6px 0 14px; font-size: 0.82rem; color: var(--text-muted); }

  .ec-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
  /* Wraps to two lines rather than sitting in two columns: "was → now" is a sentence, and at
     400px a right-aligned value column leaves the label with three words per line. */
  .ec-row { display: flex; flex-direction: column; gap: 2px; font-size: 0.85rem; }
  .ec-l { color: var(--text-muted); font-size: 0.76rem; font-weight: 700; }
  .ec-v s { color: var(--text-muted); }
  .ec-v b { color: var(--accent); }
  .ec-none { margin: 0; font-size: 0.85rem; line-height: 1.5; color: var(--text-muted); }
  .ec-foot { border-top: 1px solid var(--border); margin-top: 14px; padding-top: 10px; }
  .ec-foot + .ec-foot { border-top: 0; margin-top: 6px; padding-top: 0; }
</style>
