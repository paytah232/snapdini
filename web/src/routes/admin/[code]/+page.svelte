<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { goto, replaceState } from '$app/navigation';
  import { track } from '$lib/analytics';
  import { getConfig, getMe, api, ApiError } from '$lib/api';
  import { firePurchase, fireLead, purchaseTracked, leadTracked } from '$lib/adtracking';
  import {
    getAdmin, saveSettings, setReveal, toggleLock, deleteEvent,
    setHighlights, saveTheme, emailLink, linkSends, setAllowDownloads,
    getPhotosByOrganizer, listCohosts, inviteCohost, removeCohost,
    listShares, deleteShare, deleteParticipant,
    type AdminEvent, type Photo, type EventTheme, type CohostList, type ShareLink, type LinkSend,
    setParticipantCard, sendGuestPhotos, REVEAL_CUSTOM, REVEAL_TICK_MS,
    ceilToRevealTick, zonedWallTimeToMs, msToZonedWallTime, revealMomentLabel } from '$lib/events';
  import { GUEST_DELIVERY_DEFAULT, GUEST_DELIVERY_OPTIONS, guestReleaseAt, releaseDateKnown,
           reminderCanFire, reminderFiresAt, revealInstant, scheduledSendIssue, scopeFor,
           type GuestDelivery, type GuestSendScope } from '$lib/guestDelivery';
  import type { AppOptions, BillingConfig } from '$lib/types';
  import UpgradePanel from '$lib/components/UpgradePanel.svelte';
  import HelpTip from '$lib/components/HelpTip.svelte';
  import ShareModal from '$lib/components/ShareModal.svelte';
  import ShareLinkRow from '$lib/components/ShareLinkRow.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import { applyEventTheme, THEME_PRESETS } from '$lib/theme';
  import { getAdminCode, saveAdminCode } from '$lib/session';
  import { showToast, showSuccess } from '$lib/toast';
  import { imgFallback } from '$lib/ui';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import PosterModal from '$lib/components/PosterModal.svelte';
  import PosterWizard from '$lib/components/PosterWizard.svelte';
  import Loading from '$lib/components/Loading.svelte';
  import { modalFocus } from '$lib/ui';
  import MissionsModal from '$lib/components/MissionsModal.svelte';
  import EventImageEditor from '$lib/components/EventImageEditor.svelte';
  import FeedbackModal from '$lib/components/FeedbackModal.svelte';
  import Turnstile from '$lib/components/Turnstile.svelte';

  const code = $page.params.code ?? '';

  // ── State ──────────────────────────────────────────────────────────────────
  let orgCode = '';
  let authInput = '';
  let authed = false;
  let booting = true;
  // "Loading…" with no end is the worst state a page can settle into: nothing is wrong on screen,
  // so there is nothing to act on, and the host waits. booting only clears AFTER every await in
  // onMount, so one hung request — a dead connection, a slow venue wifi, a request that started
  // while the server was restarting — leaves this spinner up forever.
  //
  // The watchdog does not fix the request. It ends the silence, which is the actual defect, and
  // offers the one thing that reliably works.
  let bootStalled = false;
  let bootWatchdog: ReturnType<typeof setTimeout> | undefined;
  let bootAttempt = 0;
  let gone = false;                 // set on destroy, so the retry loop stops when the page does

  /** Give a promise a deadline.
   *
   *  Every await in boot was unbounded. A fetch that connects and then never answers — a container
   *  still waking, a tunnel that dropped the response — leaves the await pending FOREVER, so
   *  `booting` never clears and the page sits on "Loading…" with nothing wrong that anyone can see.
   *  That is the hang. The underlying request is left to its fate: an abandoned fetch costs
   *  nothing, and what matters is that boot has stopped waiting on it. */
  const withTimeout = <T,>(p: Promise<T>, ms: number, what: string): Promise<T> =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new ApiError(`${what} took too long`, 408)), ms))]);

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  /** Is this worth trying again, or is it an answer?
   *
   *  status 0 is the api helper's "offline / dropped connection"; 408 is our own timeout above;
   *  5xx is the server having a moment. A 401/403/404 is the server telling us something true, and
   *  retrying it just means asking the same question until the host gives up. */
  const worthRetrying = (e: unknown) =>
    e instanceof ApiError && (e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500);
  let authBusy = false;
  let welcome: { title: string; sub: string } | null = null;  // post-create / post-payment celebration modal
  let showFeedback = false;
  let viewerLoggedIn = false;   // for the top return bar
  let viewerIsAdmin = false;    // site admin drilled in via support-override → offer "back to site admin"

  let ev: AdminEvent | null = null;
  let missionsOpen = false;
  // The trick-list editor closes the moment Save is pressed and finishes the write behind itself.
  // If that write fails it hands the host’s drafts back here, and this holds them so the editor can
  // reopen on THEIR list rather than on the last one the server actually stored.
  let missionsRetry: { key: string; label: string; items: { id: string; text: string }[] }[] | null = null;
  let options: AppOptions | null = null;
  let billing: BillingConfig | null = null;
  let shapeNotice = '';
  let qrCode = '';
  let timezones: string[] = ['UTC'];

  let allPhotos: Photo[] = [];   // approved photos — gates the Review & Curate link card
  let pendingPhotos: Photo[] = []; // status === 'pending'
  let posterOpen = false;
  // The picker, and what it chose. `posterSeed` is handed to the designer as its initialConfig, so a
  // preset travels through the SAME restore path a saved design does — there is no second way for a
  // design to get into the editor.
  // Offered once per event, on the first visit to this page, and never again.
  //
  // The poster is the whole point of the product for a host — it is the thing guests scan — and it
  // is currently buried in a card halfway down a long page. `poster_opened` fired ONCE in ninety
  // days of production while the feature sat there. So it gets asked for, once, at the moment the
  // event exists and there is nothing else to do with it yet.
  //
  // Once, and remembered per event per device: an offer that reappears every visit is not an offer,
  // it is a nag, and the host who said no has a card to do it from whenever they change their mind.
  let posterAsk = false;
  const posterAskKey = () => `snap_poster_ask_${code}`;
  function maybeOfferPoster() {
    // Never on top of the post-create celebration — that modal already owns the screen, and two
    // dialogs stacked on the first second of a new event is a worse welcome than none.
    if (welcome || ev?.posterConfig) return;
    try { if (localStorage.getItem(posterAskKey()) === '1') return; } catch { return; }
    posterAsk = true;
  }
  // The poster offer is the FIRST thing a new host sees, and it was the one dialog on this page with
  // no keyboard way out — the backdrop dismissed it, Escape did nothing. A modal that traps focus
  // and then ignores Escape is worse than one that does neither.
  function onWindowKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    // "Not now" and Escape mean the same thing, including remembering the answer — otherwise it
    // reappears on the next visit and the host has to dismiss it twice.
    if (posterAsk) answerPosterAsk(false);
  }
  function answerPosterAsk(run: boolean) {
    posterAsk = false;
    try { localStorage.setItem(posterAskKey(), '1'); } catch { /* it will ask once more; harmless */ }
    if (run) { track('poster_opened', undefined, code); wizardOpen = true; }
  }

  let wizardOpen = false;
  // null = "no seed, use whatever is saved". An EMPTY OBJECT is different and deliberate: it means
  // start from scratch, and it has to be distinguishable from null or `posterSeed ?? posterConfig`
  // falls straight through to the saved design — so "Start from scratch" reopened the very design
  // the host was trying to get away from, while the tile promised a blank poster.
  let posterSeed: Record<string, unknown> | null = null;

  /** The poster button. A host with no design yet gets the gallery; one who already has a design
   *  goes straight back to it, because "Manage poster" must not throw away their work to show them
   *  a menu. Starting over is offered from inside the designer instead. */
  function openPoster() {
    track('poster_opened', undefined, code);
    posterSeed = null;
    if (ev?.posterConfig) { posterOpen = true; return; }
    wizardOpen = true;
  }
  async function pickPreset(p: { key: string; cfg: Record<string, unknown>; theme: EventTheme; themePreset?: string }) {
    track('poster_preset_picked', { preset: p.key }, code);
    wizardOpen = false;
    posterSeed = p.cfg;
    posterOpen = true;
    // A design is not just the paper. The same choice themes the guest-facing app — the join
    // screen, the camera chrome, the gallery — so a host picks a look ONCE and the whole event
    // carries it, rather than picking a poster and then hunting for the Theme card to make the app
    // match it.
    //
    // Applied live and saved, not queued behind the designer: the host is about to be looking at
    // the poster, and the app behind it should already have changed.
    //
    // Announced, because silently repainting someone's event is not a favour — and the Theme card
    // is named so they know where to undo it.
    try {
      // preset comes along with the colours. Without it the Theme card highlighted nothing after a
      // design was applied, so a host who had just watched their event change colour was looking at
      // a palette row with no selection — which reads as "it didn't take".
      theme = { ...theme, ...p.theme, preset: p.themePreset };
      selectedPreset = p.themePreset || '';
      applyEventTheme(theme);
      syncColorInputs();
      await saveTheme(code, orgCode, theme);
      showToast('Design applied — your event’s colours match it too. Change them under Theme.');
    } catch { /* the poster still opens; the theme just did not take */ }
  }
  // Participants list: searchable and capped, because a big event puts every guest in this card.
  const PART_PAGE = 25;
  let partQuery = '';
  let partLimit = PART_PAGE;
  // Derived from AdminEvent rather than re-typed by hand. The cast that used to be here spelled the
  // shape out a second time, so a field added to AdminEvent.participants was invisible on this page
  // until someone remembered to add it in both places — which is exactly what happened to
  // tricksDone. Indexing the real type means it cannot drift again.
  $: partAll = (ev?.participants ?? []) as AdminEvent['participants'];
  // The trick cards, narrowed once. Reassignment is only offered when there is more than one card —
  // with a single card there is nowhere to move a guest TO, and with no trick list there are none.
  $: cards = ev?.challengeSets ?? [];
  $: partTotal = partAll.length;
  $: partFiltered = partQuery.trim()
    ? partAll.filter((p) => `${p.name ?? ''} ${p.email ?? ''}`.toLowerCase().includes(partQuery.trim().toLowerCase()))
    : partAll;
  $: { void partQuery; partLimit = PART_PAGE; }   // a new search starts from the top
  $: partShown = partFiltered.slice(0, partLimit);

  // settings form
  let sName = '';
  let sBlurb = '';
  let sDate = '';
  let sTime = '';
  let sReveal = 'instant';
  let sDelay: number | string = 0;
  // The wall-clock reveal, when the host has chosen an exact moment instead of a delay. Strings,
  // not an epoch: they mean what they say in the EVENT's timezone, which the server resolves — a
  // host editing a Perth event from Sydney must not have their phone's zone applied to them.
  let sRevealDate = '';
  let sRevealTime = '';

  // ── How the guests get the photos ──
  // Defaults match an event that has never been asked the question, so a pre-guest-delivery event
  // hydrates to exactly the behaviour it already has.
  let sGuestDelivery: GuestDelivery = GUEST_DELIVERY_DEFAULT;
  let sGuestSendScope: GuestSendScope = 'all';
  let sGuestSendDate = '';
  let sGuestSendTime = '';
  let sGuestMailThanks = true;
  let sGuestMailReminder = false;
  let sGuestMailLive = true;
  let guestSendBusy = false;
  // What the last manual send actually did, kept on the page rather than shown as a toast: "it went
  // to eleven people" is the answer to a question the host will ask again in ten seconds, and a
  // toast has gone by then.
  let guestSendNote: { text: string; ok: boolean } | null = null;

  $: sWantsCustomReveal = sReveal === 'at_end' && String(sDelay) === REVEAL_CUSTOM;
  $: sChosenRevealAt = (sWantsCustomReveal && sRevealDate && sRevealTime && sTimezone)
    ? zonedWallTimeToMs(sRevealDate, sRevealTime, sTimezone) : null;
  $: sActualRevealAt = sChosenRevealAt === null ? null : ceilToRevealTick(sChosenRevealAt);
  $: sRevealMoved = sActualRevealAt !== null && sActualRevealAt !== sChosenRevealAt;

  // The end the host is editing TOWARDS, not the one already stored. Duration is not editable here,
  // so moving the start moves the end with it — and the 24-hour reminder gate has to answer for
  // what Save is about to write rather than for what is on the server.
  $: sEndsAt = (() => {
    if (!ev) return 0;
    const start = sDate ? (zonedWallTimeToMs(sDate, sTime || '00:00', sTimezone || 'UTC') ?? ev.startsAt) : ev.startsAt;
    return start + (ev.expiresAt - ev.startsAt);
  })();
  $: sGuestRevealAt = revealInstant({
    revealMode: sReveal, endsAt: sEndsAt,
    customAt: sWantsCustomReveal ? sActualRevealAt : null,
    delayHours: sWantsCustomReveal ? 0 : (parseInt(String(sDelay), 10) || 0),
  });
  $: sGuestChosenSendAt = (sGuestDelivery === 'scheduled' && sGuestSendDate && sGuestSendTime && sTimezone)
    ? zonedWallTimeToMs(sGuestSendDate, sGuestSendTime, sTimezone) : null;
  $: sGuestSendAt = sGuestChosenSendAt === null ? null : ceilToRevealTick(sGuestChosenSendAt);
  $: sGuestSendMoved = sGuestSendAt !== null && sGuestSendAt !== sGuestChosenSendAt;
  $: sGuestSendIssue = sGuestDelivery === 'scheduled' ? scheduledSendIssue(sGuestSendAt, sGuestRevealAt) : null;
  $: sGuestReleaseAt = guestReleaseAt(sGuestDelivery, sGuestRevealAt, sGuestSendAt);
  $: sGuestReminderOffered = reminderCanFire(sEndsAt, sGuestReleaseAt);
  $: sGuestThanksDated = releaseDateKnown(sEndsAt, sGuestReleaseAt);
  // Answered once here because revealMomentLabel takes a number and every one of these can be null
  // — a manual reveal, a half-typed date — and a fallback epoch at each call site would print 1970.
  //
  // The zone is an EXPLICIT argument, not captured: a reactive statement re-runs when its arguments
  // change, not when something the helper closes over does, so a captured zone would leave every
  // moment below reading in the previous one after the host edits the Timezone field.
  const sMoment = (ms: number | null, tz: string) => (ms === null ? '' : revealMomentLabel(ms, tz));
  $: sGuestRevealLabel = sMoment(sGuestRevealAt, sTimezone);
  $: sGuestSendLabel = sMoment(sGuestSendAt, sTimezone);
  $: sGuestReleaseLabel = sMoment(sGuestReleaseAt, sTimezone);
  $: sGuestReminderLabel = sMoment(reminderFiresAt(sEndsAt, sGuestReleaseAt), sTimezone);
  $: sGuestReminderWhyNot = sGuestReleaseAt === null
    ? "you haven't fixed a moment for the photos to go out, so there's nothing to count back from."
    : 'your photos go out less than a day after the event ends, so there is no day before to send it on.';
  // The SAVED setting, not the form's. "Send now" acts on the event as it stands on the server, and
  // quoting an unsaved chip back at the host would promise a scope the send will not use.
  $: savedSendScope = scopeFor(ev?.guestDelivery ?? GUEST_DELIVERY_DEFAULT, ev?.guestSendScope ?? 'all');
  $: guestsAlreadySent = ev?.guestsSentAt ?? null;

  $: sGuestDeliveryDesc = GUEST_DELIVERY_OPTIONS.find((o) => o.value === sGuestDelivery)?.desc ?? '';

  /** Seed the send picker from the reveal the first time "At a time I choose" is chosen — see the
   *  same seeding on the reveal control for why a blank date box is the wrong starting point.
   *
   *  Reads the bound value, never a flag derived from it: a reactive statement is recomputed on the
   *  next flush, so inside a change handler it still describes the option just moved away from. */
  function onSGuestDeliveryChange() {
    if (sGuestDelivery !== 'scheduled' || sGuestSendDate) return;
    const w = msToZonedWallTime(ceilToRevealTick(sGuestRevealAt ?? sEndsAt), sTimezone || 'UTC');
    if (w) { sGuestSendDate = w.date; sGuestSendTime = w.time; }
  }

  /** Send the gallery link to the opted-in guests now.
   *
   *  Reports what came back rather than what was asked for — the same lesson as sendLink() above,
   *  where a partial failure used to read as full success. A send that reached nobody is a refusal
   *  and is shown as one: a host told "sent!" who then hears from nobody assumes we lost the mail. */
  async function sendGuestsNow() {
    if (guestSendBusy || !ev) return;
    const what = savedSendScope === 'favourites' ? 'your favourites' : 'the whole gallery';
    if (!confirm(`Email ${what} to every guest who asked for their photos?`)) return;
    guestSendBusy = true;
    guestSendNote = null;
    try {
      const r = await sendGuestPhotos(code, orgCode, savedSendScope);
      guestSendNote = r.sent > 0
        ? { ok: true, text: `Sent to ${r.sent} guest${r.sent === 1 ? '' : 's'}`
              + (r.skipped ? ` · ${r.skipped} had nothing to send` : '') + '.' }
        : { ok: false, text: r.reason || 'Nothing was sent — no guest has asked for their photos yet.' };
      await refresh();
    } catch (e) {
      guestSendNote = { ok: false, text: e instanceof Error ? e.message : 'Could not send' };
    } finally {
      guestSendBusy = false;
    }
  }

  // Open the picker on the end of the event rather than on nothing — see the same seeding in the
  // create wizard.
  function onSDelayChange() {
    // The bound value, not the flag derived from it — see the same handler in the create wizard for
    // why a reactive statement is still one step behind in here.
    if (String(sDelay) !== REVEAL_CUSTOM || sRevealDate || !ev) return;
    const w = msToZonedWallTime(ceilToRevealTick(ev.expiresAt), sTimezone || 'UTC');
    if (w) { sRevealDate = w.date; sRevealTime = w.time; }
  }
  let sModeration = false;
  let sNoFlash = false;
  let sTimezone = '';
  let sSlug = '';
  let sAspects = new Set<string>();
  let actionBusy = false;   // guards reveal/lock/delete against double-submit
  let savingSettings = false;
  let baselineSig = '';     // settings signature at load — compared against to detect unsaved edits
  // Once an event has started, its start time is locked (can't reschedule).
  // Settings keeps the start fields editable only while the event is still upcoming. Once it has
  // started, moving it is handled solely by the "Move to a new date" action, so there is one
  // obvious path instead of two competing ones.
  $: startFieldsLocked = !!ev && Date.now() >= ev.startsAt;
  // Live-clean the custom URL as it's typed (server slugifies + validates on save).
  function onEventSlugInput() { sSlug = sSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 50); }
  // Unsaved settings edits. The Upgrade panel quotes off the SAVED event (e.g. its frame sizes), so
  // an unticked-but-unsaved shape would under-quote — we block upgrading until settings are saved.
  $: settingsDirty = baselineSig !== '' &&
    baselineSig !== JSON.stringify([sName, sBlurb, sDate, sTime, sReveal, sDelay, sRevealDate, sRevealTime, sModeration, sNoFlash, sTimezone, sSlug, [...sAspects].sort(),
       sGuestDelivery, sGuestSendScope, sGuestSendDate, sGuestSendTime, sGuestMailThanks, sGuestMailReminder, sGuestMailLive]);

  // theme editor
  let theme: EventTheme = {};
  let tFont = '';
  let selectedPreset = '';
  let tCustomCss = '';
  // Default to the real dark-theme palette (not black) so an unconfigured event's
  // editor reflects the actual theme and never saves an all-black, invisible palette.
  let cBg = '#0f0f0f', cSurface = '#1a1a1a', cAccent = '#f5c518',
      cText = '#f0ece6', cSurface2 = '#242424', cBorder = '#2e2e2e';
  let headerImageUrl: string | null = null;
  let pendingHeaderBlob: Blob | null = null;
  let headerPreview: string | null = null;
  let editorFile: File | null = null;     // image being cropped/positioned in the editor
  let savingTheme = false;

  let refreshTimer: ReturnType<typeof setInterval> | undefined;


  // ── Helpers ────────────────────────────────────────────────────────────────
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  function normalizeHex(val?: string): string {
    if (!val) return '#000000';
    if (val.startsWith('#')) return val.length === 4
      ? '#' + [...val.slice(1)].map((c) => c + c).join('')
      : val;
    const m = val.match(/(\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return '#000000';
    return '#' + [m[1], m[2], m[3]].map((n) => parseInt(n).toString(16).padStart(2, '0')).join('');
  }

  // Resolve organizer code: URL hash → ?code= → localStorage.
  function resolveOrgCode(): string {
    const hash = (location.hash || '').slice(1);
    if (hash) {
      try { return decodeURIComponent(hash); } catch { return hash; }
    }
    const q = $page.url.searchParams.get('code');
    if (q) return q;
    return getAdminCode(code);
  }

  // ── Status badge ─────────────────────────────────────────────────────────
  $: statusBadge = (() => {
    if (!ev) return null;
    const expired = ev.expiresAt && Date.now() > ev.expiresAt;
    if (ev.isLocked) return { label: '🔒 Locked', cls: 'b-lock' };
    if (expired) return { label: 'Ended', cls: 'b-end' };
    if (ev.isUpcoming) return { label: '⏰ Upcoming', cls: 'b-soon' };
    return { label: '● Live', cls: 'b-live' };
  })();

  $: isExpired = !!(ev && ev.expiresAt && Date.now() > ev.expiresAt);
  $: joinUrl = ev ? `${location.origin}${ev.slug ? `/e/${ev.slug}` : `/join/${code}`}` : '';
  $: galleryUrl = ev ? `${location.origin}/gallery/${ev.slug || code}` : '';
  $: shotsLeft = ev ? Math.max(0, ev.maxPhotos * (ev.participantCount || 0) - (ev.photoCount || 0)) : 0;
  $: revealSublabel = ev
    ? ev.isRevealed
      ? 'Photos are visible to participants'
      : ev.revealMode === 'at_end'
        ? (ev.revealAt ? `Auto-reveals ${revealMomentLabel(ev.revealAt, ev.timezone)}` : 'Auto-reveals when event ends')
        : ev.revealMode === 'manual'
          ? 'Manual — reveal when ready'
          : 'Instant — photos visible as taken'
    : '';

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  onMount(async () => {
    // FIRST, before anything that can await. It used to be set after the Stripe conversion lookup,
    // which is an unbounded await on the one path that reaches it — so the single case this page
    // most needed a watchdog for was the one case the watchdog had not started yet.
    bootWatchdog = setTimeout(() => { if (booting) bootStalled = true; }, 12_000);
    try {
    const sp = new URLSearchParams(location.search);
    // Celebrate a fresh create / successful payment / upgrade with a modal (QR + share link).
    const paidReturn = sp.get('paid') === '1';
    const upgradedReturn = sp.get('upgraded') === '1';
    const createdReturn = sp.get('created') === '1';
    if (createdReturn) welcome = { title: 'Your event is live! 🎉', sub: 'Share the link or QR below with your guests. Customise the theme, reveal mode and more right here whenever you like.' };
    else if (paidReturn) welcome = { title: 'Payment received — your event is active! 🎉', sub: 'Share the link or QR below with your guests. Everything you paid for is unlocked.' };
    else if (upgradedReturn) welcome = { title: 'Upgrade applied! 🎉', sub: 'Your event now includes the extra capacity. Nothing else to do — carry on.' };
    // ── Marketing conversions ──
    // Deliberately NOT run here, where they used to be. Every one of these talks to a third party,
    // and any one of them throwing took the whole page with it: before the boot was wrapped in
    // try/finally that stranded the host on "Loading…" forever, and after it, on the organizer-code
    // wall — having just paid us. The host's own event has nothing to do with an ad platform, so it
    // loads first and these run afterwards, each inside its own guard. See fireConversions().
    const sessionId = sp.get('session_id');
    // Strip the marker so a refresh doesn't re-show it (keep the #organizer hash).
    // SvelteKit's replaceState. A raw history call leaves the router's bookkeeping stale, and the
    // symptom shows up somewhere else entirely: Back from another page changed the URL to this one
    // without ever rendering it.
    // The other half of checkout_started: what actually came back from Stripe.
    if (sp.has('paid') || sp.has('upgraded')) track('checkout_returned', { paid: true, kind: sp.has('upgraded') ? 'upgrade' : 'new' }, code);
    // The URL tidy-up used to happen HERE, and it is why a host who had just paid us landed on the
    // organizer-code wall. replaceState() at this point runs mid-hydration, before the router is
    // ready, and SvelteKit throws out of it ("Cannot read properties of undefined") — taking the
    // rest of boot with it. Every marker did it: ?created, ?paid and ?upgraded alike.
    //
    // It is also the least important thing this function does. So it waits until the event is on
    // screen, and it is guarded — see tidyUrl().
    // Resolve identity first (and independently) so the Site-admin / My-events bar appears
    // promptly even if config is slow — and on every event, not just the viewer's own.
    // Both of these are already best-effort — but "best effort" only holds if they can also give
    // up. Unbounded, either one alone could hold the whole page on "Loading…".
    try { const me = await withTimeout(getMe(), 6_000, 'Sign-in check'); viewerLoggedIn = !!me.user; viewerIsAdmin = !!me.user?.isAdmin; } catch { /* anon organizer */ }
    try {
      const _cfg = await withTimeout(getConfig(), 6_000, 'Settings'); options = _cfg.options; billing = _cfg.billing;
    } catch {
      /* offline; dropdowns will be empty */
    }
    try {
      timezones = Intl.supportedValuesOf('timeZone');
    } catch {
      timezones = ['UTC'];
    }
    if (!timezones.length) timezones = ['UTC'];

    orgCode = resolveOrgCode();
    if (orgCode) {
      authInput = orgCode;
      // Keep trying, on our own. The watchdog used to do nothing but put a "Try again" button on
      // screen and wait to be clicked — which is the page asking the host to perform a retry it
      // could have performed itself, while their event sat there working perfectly.
      for (;;) {
        bootAttempt++;
        const r = await tryLoad();
        if (r !== 'unreachable' || gone) break;
        bootStalled = true;                              // say so, but keep going
        await sleep(Math.min(1_000 * 2 ** (bootAttempt - 1), 15_000));
        if (gone) break;
      }
      // Once authenticated the organizer code is cached in localStorage (saveAdminCode), so we
      // can scrub it (and any ?paid/#hash) from the address bar — no more long code on screen.
      // The organizer code is a bearer credential, so it does not stay in the address bar — but
      // via SvelteKit, for the same reason as above.
      tidyUrl();
    }
      // The page is up. NOW the ad platforms can be told, and nothing they do can reach the host.
      fireConversions(createdReturn, paidReturn, upgradedReturn, sessionId);
    } finally {
      // Whatever happened above — a throw, a rejected promise nobody caught — the page stops
      // saying "Loading…". A stuck spinner is the worst failure this page has, because it is the
      // one the host cannot tell apart from slow.
      booting = false;
      clearTimeout(bootWatchdog);
    }
    refreshTimer = setInterval(refresh, 30_000);
  });

  /** Strip the return markers and the organizer code from the address bar.
   *
   *  Cosmetic, and deliberately last: the organizer code is a bearer credential and should not sit
   *  in the URL, but a tidy URL is worth nothing next to the page actually loading. Via SvelteKit's
   *  replaceState rather than history.replaceState — a raw history call leaves the router's
   *  bookkeeping stale, and the symptom turns up somewhere else entirely (Back from another page
   *  changed the URL to this one without ever rendering it).
   *
   *  Only once authenticated: an unauthenticated visitor still needs whatever is in the URL when
   *  they hit reload. */
  function tidyUrl() {
    if (!authed) return;
    try { replaceState(location.pathname, {}); } catch { /* an untidy URL is not worth a broken page */ }
  }

  /** Tell the ad platforms, in a way that cannot reach the page.
   *
   *  Each call is guarded on its own rather than sharing one try: these are separate reports to
   *  separate third parties, and one failing is no reason to skip the others. */
  function fireConversions(created: boolean, paid: boolean, upgraded: boolean, sessionId: string | null) {
    // Fires for every new event (free ?created or paid ?paid), NOT for upgrades. Keyed by the join
    // code so a revisit doesn't double-count. No-op unless a platform is configured.
    try {
      if ((created || paid) && leadTracked($page.data, 'create')) fireLead($page.data, 'create', $page.params.code);
    } catch { /* an ad platform is not worth a broken page */ }

    // The real amount charged, looked up via the Stripe session so promos are reflected. The lookup
    // exists only to feed the conversion, so purchaseTracked() gates it — no platform configured ⇒
    // no extra request at all.
    try {
      if (!((paid || upgraded) && sessionId && purchaseTracked($page.data))) return;
      void (async () => {
        try {
          const s = await withTimeout(
            api<{ paid: boolean; amountTotalCents: number; currency: string; transactionId: string }>(
              '/api/billing/session/' + encodeURIComponent(sessionId),
            ), 8_000, 'Payment lookup');
          if (s?.paid) {
            firePurchase($page.data, { amountTotalCents: s.amountTotalCents, currency: s.currency, transactionId: s.transactionId });
          }
        } catch { /* conversion is best-effort */ }
      })();
    } catch { /* as above */ }
  }

  onDestroy(() => { gone = true; clearInterval(refreshTimer); clearTimeout(bootWatchdog); });

  /** 'unreachable' is deliberately NOT a failure to authenticate.
   *
   *  This used to treat every error the same: a dropped connection cleared the organizer code and
   *  toasted "Access denied", so a network blip on a perfectly good code dumped the host at the
   *  login wall being told they had no access. The code was fine; the wifi wasn't. */
  type LoadResult = 'ok' | 'denied' | 'unreachable';
  async function tryLoad(): Promise<LoadResult> {
    try {
      await withTimeout(loadEvent(), 10_000, 'Your event');
      authed = true;
      saveAdminCode(code, orgCode);
      void loadCohosts();
      void loadShares();
      void loadSends();
      maybeOfferPoster();
      return 'ok';
    } catch (e) {
      if (worthRetrying(e)) return 'unreachable';     // keep the code; the caller decides when to stop
      authed = false;
      orgCode = '';
      showToast(e instanceof Error ? e.message : 'Access denied', true);
      return 'denied';
    }
  }

  async function authenticate() {
    const input = authInput.trim();
    if (!input) { showToast('Enter your organizer code', true); return; }
    authBusy = true;
    orgCode = input;
    await tryLoad();
    authBusy = false;
  }

  // ── Load ─────────────────────────────────────────────────────────────────
  async function loadEvent() {
    ev = await getAdmin(code, orgCode);
    document.title = `${ev.name} — Admin — Snapdini`;
    hydrateFromEvent(ev);
    fetchQr();
    await loadPhotos();
  }

  function fetchQr() {
    fetch(`/api/events/${code}/qr`)
      .then((r) => r.json())
      .then((d) => { qrCode = d.qrCode; })
      .catch(() => {});
  }

  function hydrateFromEvent(e: AdminEvent) {
    // settings form
    // Read in the EVENT's timezone, not the browser's.
    //
    // These two lines used to be `new Date(startsAt).getHours()` — the browser's wall clock. So a
    // host in Sydney opening a Perth event was shown 22:00 for a party that starts at 20:00 there,
    // and pressing Save without touching anything wrote that 22:00 back as Perth time, moving the
    // event two hours. Reading and writing in the same zone is what closes that: the stored instant
    // never changes, and the label it is shown under becomes the true one.
    const zoned = msToZonedWallTime(e.startsAt, e.timezone || 'UTC');
    sName = e.name || '';
    sBlurb = e.blurb || '';
    sDate = zoned?.date ?? '';
    sTime = zoned?.time ?? '';
    sReveal = e.revealMode || 'instant';
    // An event carrying an absolute reveal loads the control onto "custom" and the wall time back
    // IN THE EVENT'S ZONE. Reading it in the browser's would show the host a time they never typed
    // the moment they opened this page from anywhere but the venue.
    if (e.revealMode === 'at_end' && e.revealAt) {
      sDelay = REVEAL_CUSTOM;
      const w = msToZonedWallTime(e.revealAt, e.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
      sRevealDate = w?.date ?? '';
      sRevealTime = w?.time ?? '';
    } else {
      sDelay = e.revealDelayHours || 0;
      sRevealDate = '';
      sRevealTime = '';
    }
    sGuestDelivery = e.guestDelivery ?? GUEST_DELIVERY_DEFAULT;
    sGuestSendScope = e.guestSendScope ?? 'all';
    if (e.guestSendAt) {
      // In the EVENT's zone, for the same reason the reveal is: a host editing a Perth event from
      // Sydney must not be shown a send time they never typed.
      const g = msToZonedWallTime(e.guestSendAt, e.timezone || 'UTC');
      sGuestSendDate = g?.date ?? '';
      sGuestSendTime = g?.time ?? '';
    } else {
      sGuestSendDate = '';
      sGuestSendTime = '';
    }
    // `!== false` / `=== true`, not `!!`: these arrive absent from an API that does not serve them
    // yet, and absent has to mean the column default rather than off.
    sGuestMailThanks = e.guestMailThanks !== false;
    sGuestMailReminder = e.guestMailReminder === true;
    sGuestMailLive = e.guestMailLive !== false;
    sModeration = !!e.moderationEnabled;
    sNoFlash = !!e.noFlash;
    sTimezone = e.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    sSlug = e.slug || '';
    sAspects = new Set(e.aspectRatios && e.aspectRatios.length ? e.aspectRatios : ['1:1']);
    // Snapshot the saved settings so we can detect unsaved edits (gates the Upgrade panel).
    baselineSig = JSON.stringify([sName, sBlurb, sDate, sTime, sReveal, sDelay, sRevealDate, sRevealTime, sModeration, sNoFlash, sTimezone, sSlug, [...sAspects].sort(),
       sGuestDelivery, sGuestSendScope, sGuestSendDate, sGuestSendTime, sGuestMailThanks, sGuestMailReminder, sGuestMailLive]);

    // theme editor
    theme = e.theme || {};
    tFont = theme.font || '';
    selectedPreset = theme.preset || '';
    tCustomCss = theme.customCss || '';
    headerImageUrl = theme.headerImage || null;
    if (headerPreview && headerPreview.startsWith('blob:')) URL.revokeObjectURL(headerPreview); // avoid leaking on auto-refresh
    headerPreview = headerImageUrl;
    pendingHeaderBlob = null;
    syncColorInputs();
    // Always apply (applyEventTheme falls back to the warm default for no-theme events) — this also
    // clears any theme left over from a previously-viewed event.
    applyEventTheme((e.theme && Object.keys(e.theme).length ? e.theme : null) as EventTheme | null);
  }

  function syncColorInputs() {
    if (theme.bg) cBg = normalizeHex(theme.bg);
    if (theme.surface) cSurface = normalizeHex(theme.surface);
    if (theme.accent) cAccent = normalizeHex(theme.accent);
    if (theme.text) cText = normalizeHex(theme.text);
    if (theme.surface2) cSurface2 = normalizeHex(theme.surface2);
    if (theme.border) cBorder = normalizeHex(theme.border);
  }

  async function loadPhotos() {
    try {
      const data = await getPhotosByOrganizer(code, orgCode);
      const all = data.photos || [];
      pendingPhotos = all.filter((p) => p.status === 'pending');
      allPhotos = all.filter((p) => p.status === 'approved');
    } catch {
      showToast('Could not load photos', true);
    }
  }

  async function refresh() {
    if (!authed) return;
    try {
      ev = await getAdmin(code, orgCode);
      // Do NOT re-fill the Settings form while the host is editing it.
      //
      // This poll runs every 30 seconds, and hydrateFromEvent() overwrites every s* field and
      // resets the baseline it is compared against. So anything typed into Event settings and not
      // saved within half a minute vanished mid-sentence — name, blurb, reveal time, timezone —
      // with no error and nothing to undo, and the form then claimed to be clean. Typing a blurb
      // is easily a thirty-second job.
      //
      // The rest of the page still refreshes: photo counts, participants, the QR, everything the
      // poll exists for. Only the form the host has their hands on is left alone, and it resumes
      // tracking the server the moment they save or discard.
      if (!settingsDirty) hydrateFromEvent(ev);
      fetchQr();
      await loadPhotos();
    } catch {
      /* transient; keep last good state */
    }
  }

  // ── Controls ───────────────────────────────────────────────────────────────
  async function doReveal() {
    if (!ev || actionBusy) return;
    const isRevealed = ev.isRevealed;
    if (!isRevealed && !confirm('Reveal all photos to participants now?')) return;
    actionBusy = true;
    try {
      await setReveal(code, orgCode, !isRevealed);
      showToast(isRevealed ? 'Photos hidden' : 'Photos revealed! 🎉');
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed', true);
    } finally {
      actionBusy = false;
    }
  }

  // One handler for the guest-permission switches, through the normal settings PUT — which only

  // writes keys that are present, so flipping one cannot disturb the other.

  // Derived here rather than inline: a TS type assertion containing braces inside a template

  // expression breaks Svelte's parser. Default ON when the field is absent (older payloads).

  $: guestBuyOn = (ev as unknown as { guestMayBuyShots?: boolean } | null)?.guestMayBuyShots !== false;

  $: guestAskOn = (ev as unknown as { guestMayRequest?: boolean } | null)?.guestMayRequest !== false;
  // The server has always counted these; nothing rendered it, so guests could ask into a void.
  $: guestRequests = Number((ev as unknown as { upgradeRequests?: number } | null)?.upgradeRequests ?? 0);
  // Face matching defaults OFF and stays off unless a host deliberately turns it on.
  $: faceOn = (ev as unknown as { faceMatchingEnabled?: boolean } | null)?.faceMatchingEnabled === true;
  // With no MACHINE_LEARNING_URL on the server there is nothing behind this switch, so the host is
  // not offered it at all — a toggle that silently does nothing is worse than an absent one.
  $: faceAvailable = (ev as unknown as { faceMatchingAvailable?: boolean } | null)?.faceMatchingAvailable === true;


  async function setGuestFlag(key: 'guestMayBuyShots' | 'guestMayRequest' | 'faceMatchingEnabled', e: Event) {

    const input = e.currentTarget as HTMLInputElement;

    const checked = input.checked;

    try {

      const r = await fetch(`/api/events/${code}/settings`, {

        method: 'PUT',

        headers: { 'Content-Type': 'application/json', 'X-Organizer-Code': orgCode },

        body: JSON.stringify({ [key]: checked }),

      });

      if (!r.ok) throw new Error((await r.json().catch(() => null))?.error || 'Failed');

      if (ev) ev = { ...ev, [key]: checked } as typeof ev;

      showToast(checked ? 'Turned on' : 'Turned off');

    } catch (err) {

      input.checked = !checked;

      showToast(err instanceof Error ? err.message : 'Failed', true);

    }

  }


  async function onAllowDownloads(e: Event) {
    const checked = (e.currentTarget as HTMLInputElement).checked;
    try {
      await setAllowDownloads(code, orgCode, checked);
      showToast(checked ? 'Downloads enabled' : 'Downloads disabled');
      if (ev) ev = { ...ev, allowDownloads: checked };
    } catch (err) {
      (e.currentTarget as HTMLInputElement).checked = !checked;
      showToast(err instanceof Error ? err.message : 'Failed', true);
    }
  }

  async function doLock() {
    if (!ev || actionBusy) return;
    const locking = !ev.isLocked;
    if (locking && !confirm("Lock this event? Participants won't be able to take new photos.")) return;
    actionBusy = true;
    try {
      await toggleLock(code, orgCode);
      showToast(locking ? 'Event locked' : 'Event unlocked');
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed', true);
    } finally {
      actionBusy = false;
    }
  }

  async function doDelete() {
    if (!confirm('Delete this event and ALL photos permanently?\n\nThis cannot be undone.')) return;
    if (!confirm('Last chance — are you absolutely sure?')) return;
    try {
      await deleteEvent(code, orgCode);
      showToast('Event deleted');
      setTimeout(() => goto('/'), 1000);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed', true);
    }
  }

  // ── Move to a new date ───────────────────────────────────────────────────
  // Sits beside the refund option deliberately. An organizer whose event lapsed unused goes looking
  // for "cancel/refund", not for a date field buried in Settings — and rescheduling keeps the sale,
  // so it should be the first thing offered.
  let showResched = false;
  let rDate = '';
  let rTime = '';
  let reschedBusy = false;
  // Bound the picker to what the server will actually accept, so an invalid date can't be chosen.
  // Dates must be local YYYY-MM-DD — toISOString() would shift by the UTC offset and could offer or
  // withhold a day at the boundary.
  const localDay = (ms: number) => {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };
  $: reschedMinDate = localDay(Date.now());
  $: reschedMaxDate = ev?.rescheduleUntil ? localDay(ev.rescheduleUntil) : undefined;
  $: canOfferReschedule = !!ev && ev.canReschedule === true && Date.now() >= ev.startsAt;

  async function doReschedule() {
    if (reschedBusy || !ev) return;
    if (!rDate) { showToast('Pick a new date first', true); return; }
    reschedBusy = true;
    try {
      // Rescheduling is the same rule: the new start is a wall time in the event's own zone.
      const startsAt = zonedWallTimeToMs(rDate, rTime || '00:00', ev?.timezone || 'UTC')
        ?? new Date(`${rDate}T${rTime || '00:00'}`).getTime();
      await api(`/api/events/${ev.joinCode}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-organizer-code': orgCode },
        body: JSON.stringify({ startsAt, startDate: rDate, startTime: rTime || '00:00' }),
      });
      showSuccess('Event moved — your guests can join from the new date.');
      showResched = false;
      await refresh();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not move the event', true);
    } finally { reschedBusy = false; }
  }

  // ── Cancel / request a refund ────────────────────────────────────────────
  // Opens a support request (kind='refund'); we never move money automatically. The server freezes
  // an eligibility snapshot (requested-before-start ⇒ full refund) from the event's start time.
  let showRefund = false;
  let refundReason = '';
  let refundToken = '';
  let refundTurnstile: Turnstile;
  let refundBusy = false;
  let refundDone = false;
  async function requestRefund() {
    if (refundBusy) return;
    refundBusy = true;
    try {
      const fd = new FormData();
      fd.append('kind', 'refund');
      fd.append('eventCode', code);
      fd.append('context', `Manage portal · ${ev?.name ?? ''}`);
      fd.append('message', refundReason.trim() || 'The organizer requested to cancel this event and receive a refund.');
      // /api/contact is bot-checked. Without this the request died on the bot check — so an
      // organizer asking to cancel a PAID event was told "Bot check failed" and their words went
      // nowhere at all, which is the worst possible moment to swallow a message.
      fd.append('cf-turnstile-response', refundToken);
      const r = await fetch('/api/contact', { method: 'POST', body: fd, credentials: 'same-origin' });
      if (!r.ok) { refundTurnstile?.reset(); throw new Error('Could not send your request'); }
      refundDone = true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed — please email support@snapdini.com', true);
    } finally { refundBusy = false; }
  }

  // ── Settings ─────────────────────────────────────────────────────────────
  function toggleAspect(value: string) {
    if (value !== '1:1' && !canAllShapes) {
      // Say why. Silently ignoring the click is what made this feel broken: the box appeared to
      // tick, the save succeeded, and the shape was gone on reload with nothing explaining it.
      shapeNotice = billingKnown
        ? 'Extra frame shapes need the frame pack — add it in Upgrade below, then pick your shapes.'
        : 'Just checking what this event includes…';
      return;
    }
    shapeNotice = '';
    const next = new Set(sAspects);
    if (next.has(value)) next.delete(value); else next.add(value);
    sAspects = next;
  }
  // Entitlement: extra (non-square) shapes are free on small/free events, otherwise they need the
  // paid frame pack. If the event already has any non-square shape, the pack is owned.
  $: framePackOwned = (ev?.aspectRatios ?? []).some((a) => a !== '1:1');
  // Fail CLOSED on unknown. This read `!billing?.billingEnabled`, which is true while the billing
  // config is still loading (and forever if that fetch fails) — so the Pro shapes were tickable,
  // the save returned "Settings saved", and the server quietly put them back. Only treat billing
  // as off once we have actually been told it is off.
  $: billingKnown = billing !== null;
  $: canAllShapes = billingKnown
    && (billing?.billingEnabled === false
        || (!!ev && ev.guestCap <= (billing?.freeAllGuests ?? 10))
        || framePackOwned);

  async function saveSettingsForm() {
    if (sWantsCustomReveal && sActualRevealAt === null) {
      showToast('Pick the date and time for the reveal', true);
      return;
    }
    if (sGuestSendIssue === 'missing') {
      showToast('Pick the date and time to send your guests the photos', true);
      return;
    }
    if (sGuestSendIssue === 'before-reveal') {
      showToast('Your send time is before the photos are revealed — pick a later one', true);
      return;
    }
    savingSettings = true;
    try {
      // Written in the event's zone too, so what the host typed means what they think it means
      // wherever they happen to be sitting.
      const startsAt = sDate
        ? (zonedWallTimeToMs(sDate, sTime || '00:00', sTimezone || 'UTC') ?? new Date(`${sDate}T${sTime || '00:00'}`).getTime())
        : undefined;
      const saved = await saveSettings(code, orgCode, {
        name: sName,
        blurb: sBlurb.trim(),
        startsAt,
        startDate: sDate,
        startTime: sTime,
        revealMode: sReveal,
        // 'custom' tells the server to read the two fields below instead of an hour count.
        revealDelayHours: sWantsCustomReveal ? REVEAL_CUSTOM : parseInt(String(sDelay), 10) || 0,
        ...(sWantsCustomReveal ? { revealDate: sRevealDate, revealTime: sRevealTime } : {}),
        moderationEnabled: sModeration,
        guestDelivery: sGuestDelivery,
        // Derived rather than the raw chip — two of the four options ARE a scope, and a stored
        // scope that contradicts the option on screen would make the send disagree with the words
        // the host chose it by.
        guestSendScope: scopeFor(sGuestDelivery, sGuestSendScope),
        ...(sGuestDelivery === 'scheduled' ? { guestSendAt: sGuestSendAt } : {}),
        guestMailThanks: sGuestMailThanks,
        // Written off when the gap cannot carry it: the switch was not on screen, so it is not a
        // choice the host made, and leaving a stored true behind would arm an email that can only
        // ever fire before the event it is meant to follow.
        guestMailReminder: sGuestReminderOffered && sGuestMailReminder,
        guestMailLive: sGuestMailLive,
        noFlash: sNoFlash,
        ratingMode: 'favourite',
        timezone: sTimezone,
        slug: sSlug.trim(),
        aspectRatios: [...sAspects]
      });
      // The server saves everything else even when it will not honour the shapes, so say which
      // happened rather than a blanket "saved".
      if (saved?.aspectsRefused) {
        shapeNotice = 'Saved — but the extra frame shapes need the frame pack, so they were not applied.';
        showToast('Settings saved, except the frame shapes', true);
      } else {
        shapeNotice = '';
        showSuccess('Settings saved');
      }
      await loadEvent();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Save failed', true);
    } finally {
      savingSettings = false;
    }
  }

  // ── Co-hosts ─────────────────────────────────────────────────────────────────
  let cohostData: CohostList | null = null;
  // Collapsed by default: see the note on .part-head. Not persisted — a host who opened it once was
  // looking for one guest, not changing how the page works from then on.
  let partsOpen = false;
  let cohostOpen = false;
  let cohostEmail = '';
  let cohostBusy = false;
  async function loadCohosts() {
    try { cohostData = await listCohosts(code, orgCode); } catch { /* leave as-is */ }
  }
  async function addCohost() {
    const em = cohostEmail.trim();
    if (!em) return;
    cohostBusy = true;
    try {
      await inviteCohost(code, orgCode, em);
      cohostEmail = '';
      showSuccess('Invitation sent — use “Copy link” on their row to share it directly too');
      await loadCohosts();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not invite', true);
    } finally { cohostBusy = false; }
  }
  async function dropCohost(id: string) {
    try { await removeCohost(code, orgCode, id); await loadCohosts(); showSuccess('Co-host removed'); }
    catch (e) { showToast(e instanceof Error ? e.message : 'Could not remove', true); }
  }

  // ── Shared links ─────────────────────────────────────────────────────────────
  let sharesList: ShareLink[] = [];
  let editShare: ShareLink | null = null;   // opens the share modal to rename / change the URL
  async function loadShares() { try { sharesList = (await listShares(code, orgCode)).shares; } catch { /* leave */ } }
  async function copyShare(url: string) { try { await navigator.clipboard.writeText(url); showToast('Link copied'); } catch { showToast(url, false); } }
  async function dropShare(id: string) {
    try { await deleteShare(code, orgCode, id); await loadShares(); showSuccess('Share link deleted'); }
    catch (e) { showToast(e instanceof Error ? e.message : 'Could not delete', true); }
  }
  const shareKindText = (k: string, n: number | null) => k === 'favourites' ? 'Favourites' : k === 'selected' ? `${n ?? ''} selected` : 'Whole gallery';

  // ── Participants ─────────────────────────────────────────────────────────────
  // Which row is mid-save, so its select cannot be spun twice before the first answer lands.
  let cardBusy: string | null = null;
  async function moveCard(p: { id: string; name: string }, set: string) {
    cardBusy = p.id;
    try {
      const r = await setParticipantCard(code, orgCode, p.id, set);
      await loadEvent();   // re-read rather than patch locally: the server is what decides
      showSuccess(`${p.name} is now on ${r.label} — ${r.tricks} trick${r.tricks === 1 ? '' : 's'}`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not move them', true);
      await loadEvent();   // put the select back to what is actually stored
    } finally { cardBusy = null; }
  }

  async function removeParticipant(p: { id: string; name: string; photosTaken: number }) {
    const n = p.photosTaken || 0;
    const warn = n > 0
      ? `Remove ${p.name}? This also permanently deletes their ${n} photo${n === 1 ? '' : 's'} — this can't be undone.`
      : `Remove ${p.name} from this event?`;
    if (!confirm(warn)) return;
    try {
      const r = await deleteParticipant(code, orgCode, p.id);
      await loadEvent();
      showSuccess(r.removedPhotos ? `Removed — ${r.removedPhotos} photo${r.removedPhotos === 1 ? '' : 's'} deleted` : 'Participant removed');
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not remove', true); }
  }

  // ── Invite ─────────────────────────────────────────────────────────────────
  function copy(text: string, msg: string) {
    navigator.clipboard.writeText(text).then(() => showToast(msg));
  }

  // Download a print-ready QR (high-res, plain black-on-white) for people making their own poster.
  async function downloadQr() {
    try {
      const res = await fetch(`/api/events/${code}/qr?print=1`);
      const d = await res.json();
      if (!d.qrCode) throw new Error('No QR');
      const a = document.createElement('a');
      a.href = d.qrCode;
      a.download = `snapdini-qr-${ev?.slug || code}.png`;
      document.body.appendChild(a); a.click(); a.remove();
    } catch {
      showToast('Could not export the QR', true);
    }
  }

  // Native share sheet (email / SMS / Messenger / etc. on mobile). Shares the join link
  // — opening it shows the event image + QR behind it. Includes the QR image where supported.
  async function shareInvite() {
    // Share the LINK (not the QR image) — opening it shows the event page with the QR + event
    // image, and the link previews nicely (OG tags). Sharing a bare QR image isn't useful.
    // Keep the link ONLY in `url` — putting it in `text` too makes share targets render it twice
    // (and some split text/url into two separate messages).
    const data: ShareData = {
      title: `${ev?.name ?? 'My event'} — Snapdini`,
      text: 'Join my event on Snapdini and add your photos!',
      url: joinUrl,
    };
    try {
      if (typeof navigator !== 'undefined' && navigator.share) { await navigator.share(data); return; }
      copy(joinUrl, 'Join link copied — paste it anywhere!');
    } catch (e) {
      if ((e as Error)?.name !== 'AbortError') copy(joinUrl, 'Join link copied!');
    }
  }

  // Every link's sends in one list, filtered per row by shareId. One request for the card rather
  // than one per link: a host with a dozen shares would otherwise fire a dozen requests to render
  // a section they may never open.
  let sends: LinkSend[] = [];
  async function loadSends() {
    if (!ev?.emailEnabled) return;
    try { sends = (await linkSends(code, orgCode)).sends; } catch { /* the links still work */ }
  }

  // Which row is mid-send. A plain boolean would have greyed out every Send button on the card
  // while one of them worked.
  let sendingFrom: string | null | undefined = undefined;
  async function sendLink(emails: string[], shareId: string | null) {
    sendingFrom = shareId;
    try {
      const r = await emailLink(code, orgCode, emails, shareId);
      // Report what actually happened rather than what was asked for: a partial failure used to
      // report full success, because the old toast counted the addresses submitted.
      if (r.errors && !r.sent) showToast(`Could not send to ${r.errors} address${r.errors !== 1 ? 'es' : ''}`, true);
      else if (r.errors) showToast(`Sent to ${r.sent} — ${r.errors} failed`, true);
      else showToast(`Sent to ${r.sent} address${r.sent !== 1 ? 'es' : ''}!`);
      await loadSends();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Send failed', true);
    } finally {
      sendingFrom = undefined;
    }
  }

  // ── Theme editor ─── changes apply live to the page AND auto-save; no preview/save buttons.
  async function applyPreset(key: string) {
    const preset = THEME_PRESETS[key];
    theme = { ...theme, ...preset };
    selectedPreset = key;
    syncColorInputs();
    applyEventTheme({
      bg: cBg, surface: cSurface, surface2: cSurface2,
      border: cBorder, text: cText, accent: cAccent,
      customCss: tCustomCss
    });
    await persistTheme();
  }

  function onHeaderFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';                 // allow re-picking the same file
    if (!file) return;
    editorFile = file;                // open the crop/preview editor
  }
  let headerDragOver = false;
  function onHeaderDrop(e: DragEvent) {
    e.preventDefault();
    headerDragOver = false;
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) editorFile = file;   // drag-drop opens the same editor
  }
  async function onImageConfirm(e: CustomEvent<Blob>) {
    pendingHeaderBlob = e.detail;
    if (headerPreview && headerPreview.startsWith('blob:')) URL.revokeObjectURL(headerPreview);
    headerPreview = URL.createObjectURL(e.detail);
    editorFile = null;
    await persistTheme();      // upload + save the new image immediately
  }

  async function clearHeaderImage() {
    pendingHeaderBlob = null;
    headerImageUrl = null;
    headerPreview = null;
    await persistTheme();      // persist the removal immediately
  }

  // Uploads any pending image, then saves the current palette. Called on every change.
  async function persistTheme() {
    savingTheme = true;
    try {
      if (pendingHeaderBlob) {
        const form = new FormData();
        form.append('headerImage', pendingHeaderBlob, 'event-image.jpg');
        const res = await fetch(`/api/events/${code}/theme-image`, {
          method: 'POST',
          body: form,
          headers: { 'X-Organizer-Code': orgCode }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        headerImageUrl = data.url;
        pendingHeaderBlob = null;
      }
      const next: EventTheme = {
        bg: cBg, surface: cSurface, accent: cAccent,
        text: cText, surface2: cSurface2, border: cBorder,
        // No explicit mode — appearance is derived from the palette's background (see applyEventTheme).
        preset: selectedPreset || undefined,
        customCss: tCustomCss || undefined,
        headerImage: headerImageUrl || undefined
      };
      await saveTheme(code, orgCode, next);
      theme = next;
      applyEventTheme(next);     // reflect the saved theme immediately
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Save failed', true);
    } finally {
      savingTheme = false;
    }
  }
</script>

<svelte:head><title>Admin — Snapdini</title></svelte:head>

<!-- Single fixed-height nav bar (consistent across pages): brand left, context links right. -->
<header class="topnav">
  <!-- Home, not the dashboard: "← My events" is already in this same bar, so sending the logo there
       too spends both routes out of here on the same destination and leaves no way back to the site. -->
  <a class="brand" href="/"><Logo /> <small>ADMIN</small></a>
  <nav class="topnav-right">
    {#if viewerIsAdmin}<a class="nav-link site-admin" href="/siteadmin" title="Back to the platform console">🎩 Site admin</a>{/if}
    {#if viewerLoggedIn}<a class="nav-link" href="/dashboard">← My events</a>{/if}
  </nav>
</header>

{#if booting}
  {#if bootStalled}
    <div class="state">
      <p>Still trying to reach the server…</p>
      <p class="hint" style="margin:6px 0 14px">
        Your event is safe and nothing you have done is lost — this page just cannot get an answer
        yet. It keeps trying on its own{#if bootAttempt > 1} (attempt {bootAttempt}){/if}, so you can
        leave it open.
      </p>
      <button class="btn primary" on:click={() => location.reload()}>Reload now</button>
    </div>
  {:else}
    <Loading />
  {/if}
{:else if !authed}
  <!-- ── Auth wall ── -->
  <div class="auth">
    <div class="card">
      <h2>Organizer Login</h2>
      <div class="field">
        <label for="org-code">Organizer Code</label>
        <input id="org-code" class="mono" type="text" bind:value={authInput}
          placeholder="Paste your organizer code"
          on:keydown={(e) => e.key === 'Enter' && authenticate()} />
      </div>
      <button class="btn primary full" on:click={authenticate} disabled={authBusy}>
        {authBusy ? 'Checking…' : 'Access Admin Panel'}
      </button>
      <p class="auth-alt">Made this event with an account? <a href="/login">Log in</a> to manage it from your dashboard.</p>
    </div>
  </div>
{:else if ev}
  <!-- ── Dashboard ── -->
  <div class="wrap">
    <!-- Event header -->
    <div class="ev-head">
      <div>
        <h1>{ev.name}</h1>
        <div class="ev-sub">
          {#if statusBadge}<span class="badge {statusBadge.cls}">{statusBadge.label}</span>{/if}
          {#if ev.expiresAt}
            <span class="muted">{isExpired ? 'Ended ' : 'Ends '}{new Date(ev.expiresAt).toLocaleString()}</span>
          {/if}
        </div>
        {#if ev.startsAt && ev.isUpcoming}
          <div class="opens">⏰ Opens {new Date(ev.startsAt).toLocaleString()}</div>
        {/if}
      </div>
      <a class="btn ghost sm" href={joinUrl}>📷 Camera</a>
    </div>

    <!-- Stats -->
    <div class="stat-grid">
      <div class="stat"><b>{ev.participantCount || 0}</b><span>Participants</span></div>
      <div class="stat"><b>{ev.photoCount || 0}</b><span>Photos Taken</span></div>
      <div class="stat"><b>{shotsLeft}</b><span>Shots Remaining</span></div>
      <div class="stat"><b>{ev.maxPhotos}</b><span>Max per Person</span></div>
    </div>

    <!-- Invite -->
    <div class="card">
      <div class="card-title">Share &amp; invite</div>
      <div class="qr-block">
        {#if qrCode}
          <!-- The download sits ON the code rather than in a button below it, because that is where
               someone looks for it. Safe to overlay: the QR is generated at error-correction level
               H, which carries about 30% redundancy — the same headroom that lets other people put
               a logo in the middle of one. This covers a fraction of that.
               Always visible, never hover-only: half the hosts doing this are on a phone, where
               there is no hover and a control that only appears on one would simply not exist. -->
          <div class="qr-wrap">
            <img class="qr" src={qrCode} alt="QR code" />
            <button class="qr-dl" on:click={downloadQr} title="Save this QR as a PNG" aria-label="Save QR code as an image">⬇</button>
          </div>
        {/if}
        <div class="cb-group">
        <div class="code-label">EVENT CODE — guests type this to join</div>
        <!-- Two things a host hands out, given one shape: a small card you press, with the value
             large and what pressing it does written small underneath, inside the card.
             Both used to be plain text with a separate copy button somewhere below — so each thing
             appeared twice, once to read and once to act on, and a standalone "Copy code" bar sat
             between the two values reading as though it belonged to whichever you looked at second. -->
        <button class="copybox" on:click={() => copy(code, 'Event code copied!')}>
          <span class="cb-value cb-code">{code}</span>
          <span class="cb-hint">⧉ copy code</span>
        </button>
        </div>
        <button class="copybox" on:click={() => copy(joinUrl, 'Join link copied!')}>
          <span class="cb-value cb-url">{joinUrl}</span>
          <span class="cb-hint">⧉ copy link</span>
        </button>
        <button class="btn primary sm full invite-go" on:click={shareInvite}>📤 Share invite</button>
      <!-- "Create" is wrong once one exists — the button reopens a saved design, it does not start
           a new one, and the label was the only thing telling you whether you had saved anything. -->
      <button class="btn primary sm full" on:click={openPoster} disabled={!qrCode}>
        {ev?.posterConfig ? '🎩 Manage poster' : '🎩 Create poster'}
      </button>
      {#if ev?.posterConfig}
        <!-- Only once a design exists. Before that the button above already opens the gallery, so
             this would be a second route to the same screen; after that the button goes straight
             back to their work — which is right, "Manage poster" must not throw the work away to
             show a menu — and this is how the gallery stays reachable. -->
        <button class="btn ghost sm full" on:click={() => { wizardOpen = true; track('poster_restyle', undefined, code); }} disabled={!qrCode}>
          Start again from a design…
        </button>
      {/if}
      </div>
      <!-- The gallery-only link and "email the gallery link" used to sit here, under the join QR.
           They are the opposite of an invite: you send them afterwards, to people who only want to
           see the photos. Both now live in Shared links, which is the after-the-event card. -->
    </div>

    <!-- Controls -->
    <div class="card">
      <div class="card-title">Controls</div>

      <div class="toggle-row">
        <div>
          <div class="t-label">Reveal photos</div>
          <div class="t-sub">{revealSublabel}</div>
        </div>
        <button class="btn primary sm" on:click={doReveal} disabled={actionBusy}>{ev.isRevealed ? 'Hide photos' : 'Reveal all now'}</button>
      </div>
      <div class="divider"></div>

      <div class="toggle-row">
        <div>
          <div class="t-label">Allow downloads</div>
          <div class="t-sub">Participants can download photos</div>
        </div>
        <label class="switch">
          <input type="checkbox" checked={ev.allowDownloads !== false} on:change={onAllowDownloads} />
          <span class="track"></span>
        </label>
      </div>
      <div class="divider"></div>

        <div class="toggle-row">
          <div>
            <div class="t-label">Guests can buy more shots</div>
            <div class="t-sub">A guest who runs out can top up their own roll for A$3. You're not charged.</div>
          </div>
          <label class="switch">
            <input type="checkbox" checked={guestBuyOn}
                   on:change={(e) => setGuestFlag('guestMayBuyShots', e)} />
            <span class="track"></span>
          </label>
        </div>
        <div class="divider"></div>

        <div class="toggle-row">
          <div>
            <!-- "more" on its own said nothing — more of what? It is shots, and the ask is a
                 signal rather than an automatic grant, so the copy has to say both. -->
            <div class="t-label">Guests can ask you for more shots</div>
            <div class="t-sub">
              A guest who runs out can send you a request — it costs them nothing and grants nothing
              on its own.
              {#if guestRequests > 0}
                <strong class="req-flag">{guestRequests} {guestRequests === 1 ? 'guest has' : 'guests have'} asked so far.</strong>
              {/if}
              <!-- What to DO about a request is a different decision from whether to accept them at
                   all, and it is only wanted once one has arrived — so it waits to be asked for. -->
              <details class="disc sub-disc">
                <summary>What happens when they ask</summary>
                <div class="disc-body">
                  <p class="hint">
                    You'll see how many have asked, and you decide by raising
                    <b>Shots per guest</b> in Settings, which lifts the roll for everyone.
                  </p>
                </div>
              </details>
            </div>
          </div>
          <label class="switch">
            <input type="checkbox" checked={guestAskOn}
                   on:change={(e) => setGuestFlag('guestMayRequest', e)} />
            <span class="track"></span>
          </label>
        </div>
        <div class="divider"></div>

        {#if faceAvailable}
        <div class="toggle-row">
          <div>
            <div class="t-label">Let guests find photos of themselves</div>
            <div class="t-sub">
              A guest can upload a selfie to find the photos they appear in. Only guests who opt in are
              recognised, and their face data is deleted the moment they withdraw. Off unless you turn it on.
            </div>
          </div>
          <label class="switch">
            <input type="checkbox" checked={faceOn} on:change={(e) => setGuestFlag('faceMatchingEnabled', e)} />
            <span class="track"></span>
          </label>
        </div>
        <div class="divider"></div>
        {/if}

      <div class="toggle-row">
        <div>
          <div class="t-label">Lock event</div>
          <div class="t-sub">Prevent new photos and joins</div>
        </div>
        <button class="btn ghost sm" on:click={doLock} disabled={actionBusy}>{ev.isLocked ? 'Unlock' : 'Lock'}</button>
      </div>
      <div class="divider"></div>

      {#if canOfferReschedule}
        <!-- Offered BEFORE the refund: the event is still usable, so moving it beats cancelling. -->
        <div class="toggle-row">
          <div>
            <div class="t-label">Move to a new date</div>
            <div class="t-sub">
              No guests joined{#if ev.rescheduleUntil} — move it any time before {new Date(ev.rescheduleUntil).toLocaleDateString()}{/if}
            </div>
          </div>
          {#if !showResched}<button class="btn sm" on:click={() => { showResched = true; }}>Reschedule</button>{/if}
        </div>
        {#if showResched}
          <div class="refund-box">
            <p class="refund-hint">Everything you paid for carries over.</p>
            <div class="row2">
              <div class="field"><label for="r-date">New start date</label><input id="r-date" type="date" bind:value={rDate} min={reschedMinDate} max={reschedMaxDate} /></div>
              <div class="field"><label for="r-time">New start time</label><input id="r-time" type="time" step={REVEAL_TICK_MS / 1000} bind:value={rTime} /></div>
            </div>
            <div class="refund-actions">
              <button class="btn ghost sm" on:click={() => (showResched = false)} disabled={reschedBusy}>Never mind</button>
              <button class="btn sm" on:click={doReschedule} disabled={reschedBusy}>{reschedBusy ? 'Moving…' : 'Move event'}</button>
            </div>
          </div>
        {/if}
        <div class="divider"></div>
      {/if}

      {#if ev.amountPaidCents > 0}
        <!-- Paid event: offer a refund request (money to return), plus a separate hard delete. -->
        <div class="toggle-row">
          <div>
            <div class="t-label">Cancel event &amp; request a refund</div>
            <div class="t-sub">Plans changed? Cancel before the event starts for a full refund</div>
          </div>
          {#if !showRefund}<button class="btn ghost sm" on:click={() => (showRefund = true)}>Request refund</button>{/if}
        </div>
        {#if showRefund}
          <div class="refund-box">
            {#if refundDone}
              <p class="refund-ok">✓ Request sent — we'll be in touch by email shortly.</p>
            {:else}
              <p class="refund-hint">Tell us briefly why (optional). If your event hasn't started yet, you're eligible for a full refund.</p>
              <textarea bind:value={refundReason} rows="3" placeholder="e.g. our plans changed / booked by mistake"></textarea>
              <div class="refund-actions">
                <button class="btn ghost sm" on:click={() => (showRefund = false)} disabled={refundBusy}>Never mind</button>
                <button class="btn danger sm" on:click={requestRefund} disabled={refundBusy}>{refundBusy ? 'Sending…' : 'Send refund request'}</button>
                <Turnstile bind:token={refundToken} bind:this={refundTurnstile} action="contact" />
              </div>
            {/if}
          </div>
        {/if}
        <div class="divider"></div>

        <div class="toggle-row">
          <div>
            <div class="t-label">Delete event</div>
            <div class="t-sub">Permanently remove all data</div>
          </div>
          <button class="btn danger sm" on:click={doDelete}>Delete</button>
        </div>
      {:else}
        <!-- Free event: nothing to refund — cancelling simply removes it. -->
        <div class="toggle-row">
          <div>
            <div class="t-label">Cancel event</div>
            <div class="t-sub">Permanently remove this event and all its photos</div>
          </div>
          <button class="btn danger sm" on:click={doDelete}>Cancel event</button>
        </div>
      {/if}
    </div>

    <!-- Event settings -->
    <div class="card">
      <div class="card-title">Event settings</div>
      <div class="field">
        <label for="s-name">Event name</label>
        <input id="s-name" type="text" maxlength="80" bind:value={sName} />
      </div>
      <div class="field">
        <label for="s-blurb">Welcome blurb <span class="hint">(shown under the title on the join screen)</span></label>
        <textarea id="s-blurb" maxlength="280" rows="2" bind:value={sBlurb}></textarea>
      </div>
      <div class="field-row">
        <div class="field"><label for="s-date">Start date</label><input id="s-date" type="date" bind:value={sDate} max={reschedMaxDate} disabled={startFieldsLocked} /></div>
        <!-- The same 15-minute grid the reveal uses. An event ends at start + duration and a reveal
             is checked on that tick, so minutes finer than it were never actually honoured. -->
        <div class="field"><label for="s-time">Start time</label><input id="s-time" type="time" step={REVEAL_TICK_MS / 1000} bind:value={sTime} disabled={startFieldsLocked} /></div>
      </div>
      {#if startFieldsLocked}
        <p class="hint" style="margin:-4px 0 10px">
          {ev?.canReschedule ? 'Already started — use “Move to a new date”.' : 'Locked — guests have joined.'}
        </p>
      {/if}
      <div class="field">
        <label for="s-tz">Timezone <span class="muted">(type to search)</span></label>
        <input id="s-tz" list="tz-datalist" autocomplete="off" placeholder="e.g. Australia/Brisbane" bind:value={sTimezone} />
        <datalist id="tz-datalist">
          {#each timezones as z}<option value={z}></option>{/each}
        </datalist>
      </div>
      <div class="field">
        <label for="s-slug">Custom URL <span class="hint">(optional — your event's /e/ link)</span></label>
        <input id="s-slug" type="text" maxlength="50" placeholder="e.g. lisas-birthday (blank = default link)" bind:value={sSlug} on:input={onEventSlugInput} />
      </div>
      <div class="field">
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label>Photo shapes{#if !canAllShapes}<HelpTip text="Extra shapes need the frame pack — add it in the Upgrade section below. Square (1:1) is always free." />{/if}</label>
        <div class="aspect-options">
          {#each options?.aspectRatios ?? [] as a}
            <label class="aspect-opt" class:locked={a.value !== '1:1' && !canAllShapes}>
              <!-- Not `disabled`: a disabled input swallows the click, so the guest of an
                   unentitled event got no tick AND no reason. It stays clickable and refuses out
                   loud instead. click fires before change, so preventDefault stops both. -->
              <input type="checkbox" checked={sAspects.has(a.value)}
                     aria-disabled={a.value !== '1:1' && !canAllShapes}
                     on:click={(e) => { if (a.value !== '1:1' && !canAllShapes) { e.preventDefault(); toggleAspect(a.value); } }}
                     on:change={() => toggleAspect(a.value)} />
              {a.label}{#if a.pro}<span class="pro-tag">Pro</span>{/if}
            </label>
          {/each}
        </div>
        {#if shapeNotice}
          <p class="shape-notice">{shapeNotice}</p>
        {/if}
      </div>
      <div class="field-row">
        <div class="field">
          <label for="s-reveal">Reveal mode</label>
          <select id="s-reveal" bind:value={sReveal}>
            {#each options?.revealModes ?? [] as m}<option value={m.value}>{m.label}</option>{/each}
          </select>
        </div>
      </div>
      {#if sReveal === 'at_end'}
        <div class="field">
          <label for="s-delay">Reveal delay after the event ends</label>
          <select id="s-delay" bind:value={sDelay} on:change={onSDelayChange}>
            {#each options?.revealDelays ?? [] as d}<option value={d.value}>{d.label}</option>{/each}
            <option value={REVEAL_CUSTOM}>Pick an exact date &amp; time…</option>
          </select>
        </div>
        {#if sWantsCustomReveal}
          <div class="field-row reveal-custom">
            <div class="field">
              <label for="s-reveal-date">Reveal date</label>
              <input id="s-reveal-date" type="date" bind:value={sRevealDate} />
            </div>
            <div class="field">
              <label for="s-reveal-time">Reveal time</label>
              <!-- Stepped by the tick so a phone's wheel only offers moments that can be honoured. -->
              <input id="s-reveal-time" type="time" step={REVEAL_TICK_MS / 1000} bind:value={sRevealTime} />
            </div>
          </div>
          <p class="hint reveal-note">
            {#if sActualRevealAt === null}
              Pick the date and time — it's read in the event's timezone{sTimezone ? ` (${sTimezone})` : ''}.
            {:else}
              Photos appear from <b>{revealMomentLabel(sActualRevealAt, sTimezone)}</b>.
              {#if sRevealMoved}
                Reveals are checked every {REVEAL_TICK_MS / 60000} minutes, so yours moves to the next check.
              {/if}
            {/if}
          </p>
        {/if}
      {/if}
      {#if sReveal !== 'instant'}
        <div class="toggle-row">
          <div>
            <div class="t-label">Moderate photos</div>
            <div class="t-sub">Approve each photo before it appears in the gallery</div>
          </div>
          <label class="switch">
            <input type="checkbox" bind:checked={sModeration} />
            <span class="track"></span>
          </label>
        </div>
      {/if}
      <div class="toggle-row">
        <div>
          <div class="t-label">No flash</div>
          <div class="t-sub">Disable the camera flash for guests (handy in dark venues to avoid harsh shots)</div>
        </div>
        <label class="switch">
          <input type="checkbox" bind:checked={sNoFlash} />
          <span class="track"></span>
        </label>
      </div>
      <div class="divider gd-div"></div>

      <!-- Getting the photos to the guests. The switches that decide WHAT a send does come first;
           the one button that actually sends is last, under them, where it reads as the consequence
           of the settings above rather than as a control of its own. -->
      <div class="field">
        <label for="s-guest-delivery">How should your guests get the photos?</label>
        <select id="s-guest-delivery" bind:value={sGuestDelivery} on:change={onSGuestDeliveryChange}>
          {#each GUEST_DELIVERY_OPTIONS as o}<option value={o.value}>{o.label}</option>{/each}
        </select>
        <p class="hint gd-desc">{sGuestDeliveryDesc}</p>
      </div>

      {#if sGuestDelivery === 'scheduled' || sGuestDelivery === 'manual'}
        <!-- Only on the two options that do not already say it — on the other two the words the
             host chose ARE the answer, and asking twice lets the two disagree. -->
        <div class="field">
          <label for="s-guest-scope">Which photos do they get?</label>
          <select id="s-guest-scope" bind:value={sGuestSendScope}>
            <option value="all">Everything</option>
            <option value="favourites">Just my favourites</option>
          </select>
        </div>
      {/if}

      {#if sGuestDelivery === 'scheduled'}
        <div class="field-row reveal-custom">
          <div class="field">
            <label for="s-guest-send-date">Send date</label>
            <input id="s-guest-send-date" type="date" bind:value={sGuestSendDate} />
          </div>
          <div class="field">
            <label for="s-guest-send-time">Send time</label>
            <!-- The same 15-minute grid as the reveal — a send is checked on that tick, so finer
                 minutes are precision we could not honour. -->
            <input id="s-guest-send-time" type="time" step={REVEAL_TICK_MS / 1000} bind:value={sGuestSendTime} />
          </div>
        </div>
        <p class="hint reveal-note">
          {#if sGuestSendIssue === 'missing'}
            Pick the date and time — it's read in the event's timezone{sTimezone ? ` (${sTimezone})` : ''}.
          {:else if sGuestSendIssue === 'before-reveal'}
            That's before your photos are revealed ({sGuestRevealLabel}) — your guests would get a
            link to a gallery that is still shut. Pick that moment or later.
          {:else}
            Your guests get the photos from <b>{sGuestSendLabel}</b>.
            {#if sGuestSendMoved}
              Sends are checked every {REVEAL_TICK_MS / 60000} minutes, so yours moves to the next check.
            {/if}
          {/if}
        </p>
      {/if}

      <div class="toggle-row">
        <div>
          <!-- Not "email guests when the event ends": that would be a lie when this is off. The
               email is the guest's own doing — they asked for their photos — and this only decides
               what else it carries. -->
          <div class="t-label">Add a thank-you and the release date</div>
          <div class="t-sub">
            Guests who asked for their photos will get them either way — this adds a thank-you and
            tells them when the full gallery opens.{#if !sGuestThanksDated}
              No release moment is fixed yet, so right now it would be the thank-you on its own.{/if}
          </div>
        </div>
        <label class="switch">
          <input type="checkbox" bind:checked={sGuestMailThanks} />
          <span class="track"></span>
        </label>
      </div>

      {#if sGuestReminderOffered}
        <div class="toggle-row">
          <div>
            <div class="t-label">Remind them the day before</div>
            <div class="t-sub">Goes out 24 hours before the gallery opens — {sGuestReminderLabel}.</div>
          </div>
          <label class="switch">
            <input type="checkbox" bind:checked={sGuestMailReminder} />
            <span class="track"></span>
          </label>
        </div>
      {:else}
        <!-- Said, not silently missing: a switch that is simply absent reads as a bug to a host who
             has seen it on another event. -->
        <p class="hint gd-off">No day-before reminder — {sGuestReminderWhyNot}</p>
      {/if}

      <div class="toggle-row">
        <div>
          <div class="t-label">Tell them the photos are live</div>
          <div class="t-sub">
            {#if sGuestReleaseLabel}
              Goes out with the link to the gallery the moment the photos are released — {sGuestReleaseLabel}.
            {:else}
              Goes out with the link to the gallery, the moment your photos are released.
            {/if}
          </div>
        </div>
        <label class="switch">
          <input type="checkbox" bind:checked={sGuestMailLive} />
          <span class="track"></span>
        </label>
      </div>

      <div class="gd-now">
        <div class="gd-state">
          {#if ev.guestOptInCount !== undefined}
            <div><b>{ev.guestOptInCount}</b> guest{ev.guestOptInCount === 1 ? '' : 's'} asked for their photos</div>
          {/if}
          {#if guestsAlreadySent}
            <!-- Without this a host has no way to tell a send that worked from one that never ran,
                 and the obvious next move is to send the whole thing again. -->
            <!-- In the EVENT's zone with its name attached, the same way every other moment in
                 this feature is written — a host checking from another city must not be shown a
                 send time that disagrees with the schedule they set. -->
            <div class="gd-sent">✓ Sent to your guests on {sMoment(guestsAlreadySent, ev.timezone || sTimezone)}</div>
          {/if}
        </div>
        <!-- ghost, not primary: Save settings is this card's primary action, and two filled
             buttons would leave the one that emails every guest competing with it. -->
        <button class="btn ghost sm full gd-send" on:click={sendGuestsNow} disabled={guestSendBusy || !ev.emailEnabled}>
          {guestSendBusy ? 'Sending…' : guestsAlreadySent ? '📨 Send it again now' : '📨 Send the gallery link to guests now'}
        </button>
        <p class="hint gd-foot">
          {#if !ev.emailEnabled}
            Email isn't switched on for this event, so nothing can be sent from here.
          {:else}
            Sends your saved setting — {savedSendScope === 'favourites' ? 'just your favourites' : 'the whole gallery'}
            — to every guest who asked for their photos.{#if settingsDirty} Save your settings first if you have just changed that.{/if}
          {/if}
        </p>
        {#if guestSendNote}
          <p class="gd-note" class:bad={!guestSendNote.ok}>{guestSendNote.text}</p>
        {/if}
      </div>

      <button class="btn primary mt" on:click={saveSettingsForm} disabled={savingSettings}>
        {savingSettings ? 'Saving…' : 'Save settings'}
      </button>
    </div>

    <!-- Theme -->
    <div class="card">
      <div class="card-title">Theme</div>
      <div class="field">
        <div class="label-mono">PALETTE</div>
        <p class="hint" style="margin:0 0 8px">The palette sets the colours <em>and</em> light/dark look — no separate appearance switch.</p>
        <div class="presets">
          {#each Object.keys(THEME_PRESETS) as key}
            <!-- A "Custom" chip sits at the end of this row (below) for the case where the palette
                 is deliberately not one of these — an empty row otherwise reads as broken. -->
            <button class="preset" class:selected={selectedPreset === key} title={key} on:click={() => applyPreset(key)}
              style="background:{THEME_PRESETS[key].bg};border-color:{selectedPreset === key ? 'var(--accent)' : THEME_PRESETS[key].accent}">
              <span style="color:{THEME_PRESETS[key].text}">{key}</span>
              {#if selectedPreset === key}<span class="preset-check">✓</span>{/if}
            </button>
          {/each}
          <!-- Shown only when the palette matches none of them, which is a real state rather than a
               fault: a poster design may carry colours tuned to its paper, and two of them do. It is
               not clickable — "custom" is something you arrive at by editing, not something you
               pick. -->
          {#if !selectedPreset}
            <div class="preset custom-chip" title="These colours aren't one of the presets">
              <span>custom</span><span class="preset-check">✓</span>
            </div>
          {/if}
        </div>
      </div>

      <div class="field">
        <label for="t-header">Event image <span class="hint">(shown behind the join screen + QR)</span></label>
        <div class="row gap center">
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <label class="upload-btn grow" class:drag={headerDragOver}
            on:dragover|preventDefault={() => (headerDragOver = true)}
            on:dragleave={() => (headerDragOver = false)}
            on:drop={onHeaderDrop}>
            {headerDragOver ? '⤓ Drop image to upload' : headerPreview ? '🖼 Change image…' : '🖼 Upload or drag an image…'}
            <input id="t-header" type="file" accept="image/*" on:change={onHeaderFile} hidden />
          </label>
          {#if headerPreview}<button class="btn ghost sm" on:click={clearHeaderImage}>Clear</button>{/if}
        </div>
        {#if headerPreview}
          <img class="header-thumb" src={headerPreview} alt="Event preview" />
        {/if}
      </div>

      <p class="hint" style="margin:4px 0 0">{savingTheme ? 'Saving…' : 'Changes apply and save automatically.'}</p>
    </div>

    <div class="card">
      <div class="card-title">Trick list</div>
      <!-- One line of pitch and the current state; the case FOR a list is three more sentences
           that a host who already has one never needs to read again. Same reasoning as the join
           screen's "Event info" panel: it is on the page, it is just not in the way. -->
      <p class="hint" style="margin:0 0 10px">
        <strong>Guests shoot more, and they shoot what you'd have missed.</strong>
      </p>
      {#if ev.challengeSets?.length}
        <div class="mset-list">
          {#each ev.challengeSets as s}
            <div class="mset">
              <span class="mset-name">{s.label}</span>
              <span class="mset-n">{s.items.length} trick{s.items.length === 1 ? '' : 's'}</span>
            </div>
          {/each}
        </div>
        <p class="hint" style="margin:8px 0 10px">
          {ev.challengeSets.length > 1
            ? 'Guests are spread evenly across the cards, so different tables hunt for different things.'
            : 'Every guest gets this card.'}
        </p>
      {/if}
      {#if !ev.challengeSets?.length}
        <!-- Said plainly rather than left implied: a host should never wonder whether their guests
             are being shown a list they have not read. It stays off until they choose it, and it
             needs printed cards to work properly, so switching it on for them would leave a
             half-finished version of the feature on someone's wedding. -->
        <p class="hint" style="margin:0 0 10px">
          <strong>Off at the moment.</strong> Your guests just take photos.
        </p>
      {/if}
      <details class="disc">
        <summary>Why a trick list works, and what your guests see</summary>
        <div class="disc-body">
          <p class="hint">
            Left alone, people photograph the obvious — the couple, the cake, whoever's loudest. A
            list gets you the table you never sat at, someone's gran on the dance floor, and the
            quiet moment in the corner. It also gives the guest who knows one person in the room a
            reason to talk to someone else.
          </p>
          <p class="hint">
            Every photo comes back labelled with the trick it was for, so the gallery reads as a
            story instead of a pile. A few tricks print on cards for the tables, and guests tick
            them off in the camera as they shoot.
          </p>
          {#if ev.challengeSets?.length}
            <p class="hint">
              Print them from <strong>Create poster</strong>. Guests can still ignore the list and
              just take photos.
            </p>
          {:else}
            <p class="hint">
              They won't see a list unless you set one up, and you can turn it off again at any
              time.
            </p>
          {/if}
        </div>
      </details>
      <button class="btn primary" on:click={() => (missionsOpen = true)}>
        {ev.challengeSets?.length ? 'Edit the trick list' : 'Set up a trick list'}
      </button>
    </div>


    <!-- Upgrades (top up to a bigger config; only the difference is charged) -->
    {#if billing && ev}
      <!-- Remount the panel when the SAVED entitlement changes (e.g. after Save settings) so its
           baseline + quote recompute and reflect what was just added (frame shapes, etc.). -->
      {#key `${ev.guestCap}|${ev.maxPhotos}|${ev.videoSeconds}|${ev.retentionDays}|${ev.amountPaidCents}|${(ev.aspectRatios ?? []).join(',')}|${ev.expiresAt - ev.startsAt}`}
        <UpgradePanel
          {code} {orgCode} {billing} {options}
          guestCap={ev.guestCap} maxPhotos={ev.maxPhotos} videoSeconds={ev.videoSeconds}
          retentionDays={ev.retentionDays} amountPaidCents={ev.amountPaidCents}
          aspectRatios={ev.aspectRatios}
          durationHours={Math.max(1, Math.round((ev.expiresAt - ev.startsAt) / 3600000))}
          blocked={settingsDirty}
        />
      {/key}
    {/if}

    <!-- Review & curate (dedicated view) — only once there's something to review -->
    {#if allPhotos.length || pendingPhotos.length}
      <!-- The whole card used to be the <a>, which left nowhere to put a disclosure: a <details>
           inside a link is invalid, and tapping its summary would navigate instead of opening. The
           link is now the top row, so the "why" can sit under it without swallowing the tap. -->
      <div class="card review-card">
        <a class="review-link" href="/admin/{code}/review#{orgCode}">
          <div class="review-icon">⭐</div>
          <div class="review-text">
            <div class="card-title">Review &amp; curate photos</div>
            <p class="hint">
              {#if sModeration && pendingPhotos.length}<strong class="pending-flag">{pendingPhotos.length} pending approval</strong> · {/if}
              {sModeration ? 'Approve, reject, favourite and rate' : 'Favourite, rate and reject'} — in a focused full-screen view.
            </p>
          </div>
          <div class="review-arrow">→</div>
        </a>
        <!-- Hosts assume the gallery link is all-or-nothing and hand out the lot. Curation plus
             share links means it never has to be, and this card is where they would find out — so
             the correction is the summary itself, and only the mechanics wait behind it. -->
        <details class="disc review-disc">
          <summary>You don't have to share everything — how share links work</summary>
          <div class="disc-body">
            <p class="hint">
              Star the ones worth keeping, then create a <strong>share link</strong> for just those
              — favourites only, or a hand-picked set. Make as many as you like: one for the family,
              one for work, one for the group chat. Each link is separate, so you can revoke one
              without touching the others.
            </p>
          </div>
        </details>
      </div>
    {/if}

    <!-- Directly under Review & curate, because that is the order the host works in: curate
         the photos, then decide who gets to see which of them. It used to sit below Co-hosts,
         which put an unrelated card between the two halves of one job. -->
    <!-- Shared links: the standing gallery link, plus every public link you've created (those are
         made from Review & Curate → Share). Everything here is about sharing the RESULT. -->
    <div class="card">
      <div class="card-title">Shared links</div>
      <!-- Not one of the rows below it: those are links the host made and can delete, this one
           simply always exists. Dashed and tagged so it never reads as a created share. -->
      <div class="standing">
        <ShareLinkRow
          url={galleryUrl}
          title="🖼 Gallery-only link"
          subtitle="Send it after the event to people who just want to see the photos"
          shareId={null}
          canEmail={!!ev.emailEnabled}
          {sends}
          busy={sendingFrom === null}
          on:copy={(e) => copy(e.detail.url, 'Gallery link copied!')}
          on:send={(e) => sendLink(e.detail.emails, e.detail.shareId)}
        >
          <span slot="tag" class="cohost-tag standing-tag">Always on</span>
        </ShareLinkRow>
      </div>
      <div class="divider shares-div"></div>
      {#if sharesList.length}
        <div class="cohost-list">
          {#each sharesList as s (s.id)}
            <ShareLinkRow
              url={s.url}
              title={s.label}
              subtitle={`${shareKindText(s.kind, s.count)} · /s/${s.slug || s.id}`}
              shareId={s.id}
              canEmail={!!ev.emailEnabled}
              {sends}
              busy={sendingFrom === s.id}
              on:copy={(e) => copyShare(e.detail.url)}
              on:send={(e) => sendLink(e.detail.emails, e.detail.shareId)}
            >
              <svelte:fragment slot="extra">
                <button class="btn ghost sm" on:click={() => (editShare = s)}>Edit</button>
                <button class="btn ghost sm" on:click={() => dropShare(s.id)} aria-label="Delete share">Delete</button>
              </svelte:fragment>
            </ShareLinkRow>
          {/each}
        </div>
      {:else}
        <p class="hint" style="margin:0">No shared links yet. Create one from <b>Review &amp; Curate → 📤 Share</b> — you can rename it or change its link here any time.</p>
      {/if}
    </div>

    <!-- Co-hosts: invite people to manage this event with you -->
    <div class="card">
      <!-- The action lives in the header, where an action on a card belongs, and opens the field
           directly beneath itself — so the thing you revealed appears where you were looking rather
           than below a list you have to scroll past. -->
      <div class="card-head">
        <div class="card-title">Co-hosts</div>
        <button class="btn ghost sm" class:on={cohostOpen} aria-expanded={cohostOpen}
                on:click={() => (cohostOpen = !cohostOpen)}>✉️ Invite</button>
      </div>
      <p class="hint" style="margin:0 0 12px">Invite people to help manage this event — they get the same access as you. They can add or remove other co-hosts, but the event owner can never be removed.</p>
      {#if cohostOpen}
        <div class="cohost-add">
          <!-- svelte-ignore a11y-autofocus -->
          <input type="email" autofocus placeholder="co-host@email.com" bind:value={cohostEmail} on:keydown={(e) => e.key === 'Enter' && addCohost()} />
          <button class="btn primary sm" on:click={addCohost} disabled={cohostBusy || !cohostEmail.trim()}>{cohostBusy ? 'Inviting…' : 'Invite'}</button>
        </div>
      {/if}
      <div class="cohost-list">
        {#if cohostData?.owner}
          <div class="cohost-row">
            <div class="cohost-who"><span class="cohost-email">{cohostData.owner.name}</span><span class="cohost-sub">{cohostData.owner.email}</span></div>
            <span class="cohost-tag owner">Owner</span>
          </div>
        {/if}
        {#each cohostData?.cohosts ?? [] as c (c.id)}
          <div class="cohost-row">
            <div class="cohost-who"><span class="cohost-email">{c.email}</span><span class="cohost-sub">{c.accepted ? 'Co-host' : 'Invited — not accepted yet'}</span></div>
            <div class="cohost-acts">
              {#if !c.accepted && c.inviteUrl}<button class="btn ghost sm" on:click={() => copy(c.inviteUrl ?? '', 'Invite link copied')} title="Copy the accept link to share directly">🔗 Copy link</button>{/if}
              <span class="cohost-tag" class:pending={!c.accepted}>{c.accepted ? 'Co-host' : 'Pending'}</span>
              <button class="btn ghost sm" on:click={() => dropCohost(c.id)} aria-label="Remove co-host">Remove</button>
            </div>
          </div>
        {/each}
        {#if cohostData && !cohostData.cohosts.length}
          <p class="hint" style="margin:0">No co-hosts yet.</p>
        {/if}
      </div>

    </div>

    <!-- Slideshow now lives in Review & Curate (🎬) — linked from the card above. -->

    <!-- Participants -->
    <div class="card">
      <!-- A summary until asked. The list is the longest thing on this page — 150 guests is 150 rows
           of name, email, shot count and a card selector — and most visits to the admin page are not
           about any individual guest. The headline number answers the usual question on its own;
           everything else waits behind the disclosure. -->
      <button class="part-head" aria-expanded={partsOpen} on:click={() => (partsOpen = !partsOpen)}>
        <span class="chev" class:open={partsOpen}>›</span>
        <span class="card-title part-title">Participants</span>
        {#if partTotal}<span class="p-count">{partTotal}</span>{/if}
        <span class="part-hint">{partsOpen ? 'hide' : 'show'}</span>
      </button>
      {#if partsOpen}
      {#if ev.participants && ev.participants.length}
        <!-- A 150-guest event rendered 150 rows into this card. Search plus a page at a time keeps
             it a card rather than a wall, and search is what you actually want at that size. -->
        {#if partTotal > PART_PAGE}
          <!-- Left open rather than hidden behind an icon: it only renders at all once there are
               more guests than fit on a page, which is precisely when you need it. Making it one
               more tap away would add friction exactly at the size it exists to rescue. -->
          <div class="p-search">
            <span class="p-search-i" aria-hidden="true">🔍</span>
            <input placeholder="Search guests — name or email…" bind:value={partQuery} aria-label="Search guests" />
            {#if partQuery}
              <button class="p-search-x" on:click={() => (partQuery = '')} aria-label="Clear search">✕</button>
            {/if}
          </div>
        {/if}
        <div class="participant-list">
          {#each partShown as p (p.id)}
            <div class="participant-row">
              <div class="avatar">{(p.name?.[0] || '?').toUpperCase()}</div>
              <div class="p-info">
                <div class="p-name">{p.name}</div>
                <!-- Only what this guest actually HAS. A row that spells out "no email" and
                     "no photos" is mostly a list of absences — and at 150 guests it is a wall of
                     them, with the few rows that do carry something lost in the middle. -->
                {#if p.email}<div class="p-email">{p.email}</div>{/if}
                <div class="p-meta">
                  {#if p.photosTaken}
                    <!-- Straight to just this guest's photos, rather than hunting through the lot.
                         A new tab, because this is a side trip: you are working down a list of
                         guests, and following one of these in place loses your place in it —
                         including the search you typed and how far you had paged. -->
                    <a class="p-shots" href="/admin/{code}/review?who={p.id}#{orgCode}"
                       target="_blank" rel="noopener">{p.photosTaken} photo{p.photosTaken === 1 ? '' : 's'} ↗</a> ·
                  {/if}
                  {#if p.tricksDone}<span class="p-tricks">🎩 {p.tricksDone} trick{p.tricksDone === 1 ? '' : 's'}</span> · {/if}
                  joined {fmtTime(p.joinedAt)}
                </div>
              </div>
              <!-- Only when there is more than one card: with a single card there is nothing to move
                   a guest TO, and with no trick list there are no cards at all. -->
              {#if cards.length > 1}
                <label class="p-card">
                  <span class="p-card-l">Card</span>
                  <select aria-label="Trick card for {p.name}" disabled={cardBusy === p.id}
                          value={p.challengeSet ?? cards[0].key}
                          on:change={(e) => moveCard(p, e.currentTarget.value)}>
                    {#each cards as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
                  </select>
                </label>
              {/if}
              <button class="btn ghost sm p-del" on:click={() => removeParticipant(p)} title="Remove this participant">Remove</button>
            </div>
          {/each}
          {#if !partShown.length}
            <div class="muted small">No guests match “{partQuery}”.</div>
          {/if}
        </div>
        {#if partFiltered.length > partShown.length}
          <div class="row gap mt">
            <button class="btn ghost sm grow" on:click={() => (partLimit += PART_PAGE)}>
              Show more — {partShown.length} of {partFiltered.length}
            </button>
            <!-- Paging 25 at a time is six taps on a 150-guest event when what you wanted was the
                 whole list — to scroll it, or to search a browser page for a name. -->
            <button class="btn ghost sm grow" on:click={() => (partLimit = partFiltered.length)}>
              Show all {partFiltered.length}
            </button>
          </div>
        {/if}
      {:else}
        <div class="muted small">No participants yet</div>
      {/if}
      {/if}
    </div>

    {#if ev.purged}
      <div class="card"><div class="muted small">Photos were removed at the end of this event's retention period. Your event details and stats are kept for your records.</div></div>
    {/if}
  </div>
{/if}

{#if editShare}
  <ShareModal {code} {orgCode} share={editShare} on:changed={loadShares} on:close={() => (editShare = null)} />
{/if}

{#if posterOpen && ev}
  <PosterModal
    eventName={ev.name}
    blurb={ev.blurb ?? ''}
    theme={ev.theme}
    joinUrl={joinUrl}
    joinCode={code}
    qrDataUrl={qrCode}
    themeImageUrl={ev.theme?.headerImage ?? null}
    orgCode={orgCode}
    initialConfig={posterSeed ?? ev.posterConfig}
    on:close={() => { posterOpen = false; posterSeed = null; void loadEvent(); }}
  />
{/if}

<svelte:window on:keydown={onWindowKey} />

{#if posterAsk && ev}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="modal" on:click|self={() => answerPosterAsk(false)} role="dialog" aria-modal="true" aria-label="Design your poster">
    <div class="card welcome-card" use:modalFocus>
      <div class="welcome-emoji">🎩</div>
      <h2 class="welcome-title">Make the poster?</h2>
      <p class="welcome-sub">
        Guests join by scanning it, so it is the one thing worth getting right. Pick a design and
        we'll fill in your event's name, code and QR — then change anything you like.
        {#if (ev.challengeSets?.length ?? 0) > 0}It does your trick cards too.{/if}
      </p>
      <div class="row gap">
        <button class="btn ghost grow" on:click={() => answerPosterAsk(false)}>Not now</button>
        <button class="btn primary grow" on:click={() => answerPosterAsk(true)}>Design it →</button>
      </div>
      <p class="hint" style="margin:10px 0 0">You can start this any time from <b>Share &amp; invite</b>.</p>
    </div>
  </div>
{/if}

{#if wizardOpen && ev}
  <PosterWizard
    eventName={ev.name}
    blurb={ev.blurb ?? ''}
    joinUrl={joinUrl}
    joinCode={code}
    qrDataUrl={qrCode}
    hasDesign={!!ev.posterConfig}
    eventType={ev.eventType ?? null}
    on:pick={(e) => void pickPreset(e.detail)}
    on:scratch={() => { track('poster_scratch_picked', undefined, code); wizardOpen = false; posterSeed = {}; posterOpen = true; }}
    on:close={() => (wizardOpen = false)}
  />
{/if}

{#if missionsOpen && ev}
  <MissionsModal
    joinCode={code}
    orgCode={orgCode}
    eventType={ev.eventType ?? null}
    savedSets={missionsRetry ?? ev.challengeSets ?? []}
    savedTick={ev.challengeTick ?? null}
    maxPhotos={ev.maxPhotos}
    videoSeconds={ev.videoSeconds ?? 0}
    onClose={() => (missionsOpen = false)}
    onSaved={(sets) => { missionsRetry = null; if (ev) ev.challengeSets = sets; }}
    onSaveFailed={(sets) => { missionsRetry = sets; missionsOpen = true; }}
  />
{/if}


{#if editorFile}
  <EventImageEditor
    file={editorFile}
    qrDataUrl={qrCode}
    eventName={ev?.name ?? ''}
    on:confirm={onImageConfirm}
    on:cancel={() => (editorFile = null)}
  />
{/if}

{#if welcome && ev}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="modal" on:click|self={() => (welcome = null)} role="dialog" aria-modal="true" aria-label="Event ready">
    <div class="card welcome-card">
      <div class="welcome-emoji">🎉</div>
      <h2 class="welcome-title">{welcome.title}</h2>
      <p class="welcome-sub">{welcome.sub}</p>
      {#if qrCode}<img class="welcome-qr" src={qrCode} alt="Join QR code" />{/if}
      <div class="code-label">EVENT CODE — guests type this to join</div>
      <!-- The same two copy cards as the invite section. This modal had the identical doubling-up:
           the link printed as text AND a "Copy share link" button below it. One control each. -->
      <button class="copybox" on:click={() => copy(code, 'Event code copied!')}>
        <span class="cb-value cb-code">{code}</span>
        <span class="cb-hint">⧉ copy code</span>
      </button>
      <button class="copybox" on:click={() => copy(joinUrl, 'Join link copied!')}>
        <span class="cb-value cb-url">{joinUrl}</span>
        <span class="cb-hint">⧉ copy link</span>
      </button>
      <div class="row gap">
        <!-- Straight into the poster from the celebration, because that IS the next thing to do
             with a brand-new event. Dismissing to the page instead leaves the host looking at
             sixteen cards with no idea which one matters. -->
        <button class="btn ghost grow" on:click={() => (welcome = null)}>Start managing</button>
        <button class="btn primary grow" on:click={() => { welcome = null; answerPosterAsk(true); }}>🎩 Make the poster →</button>
      </div>
    </div>
  </div>
{/if}

{#if !booting}
  <button class="fb-fab" type="button" on:click={() => (showFeedback = true)}>💬 Feedback</button>
{/if}
{#if showFeedback}<FeedbackModal context={`Manage (${$page.params.code})`} on:close={() => (showFeedback = false)} />{/if}

<style>
  /* On a phone this does not float at all.
     Fixed at the bottom-right, it sat on top of every full-width primary button the host scrolled
     to the bottom of the screen — elementFromPoint returned the FAB, not the button, over as much
     as 1900px² of it. Scrolling a control into view and tapping it is the most common gesture there
     is on a phone, so the button you had just reached was the one you could not press.
     Reserving trailing page padding did NOT fix it: that only protects the true end of the
     document, and the collision happens at every scroll position before it. This was my first fix
     and it was the wrong diagnosis.
     A floating button needs a gutter to float in, and a narrow screen has none — the content column
     IS the width. So below 720px it goes into the flow at the end of the page, where it can cover
     nothing. Above that there is real margin beside the column and it floats as before. */
  @media (max-width: 720px) {
    /* In the flow, but NOT a full-width button.
       Floating, it covered content on a phone where the column is the width. Full-width at the end
       of the page it stopped covering anything and started competing: a bar the size of every real
       action on the page, for the least important thing on it. So it keeps its place at the foot and
       gives back the row — right-aligned, quiet, sized to its own words. */
    .fb-fab {
      position: static; width: auto; margin: 14px 0 4px auto;
      box-shadow: none; font-size: .76rem; padding: 6px 12px; opacity: .8;
    }
    .fb-fab:active { opacity: 1; }
  }
  .fb-fab { position: fixed; right: 14px; bottom: 14px; z-index: 90; padding: 8px 14px; border-radius: 999px;
    display: inline-flex; align-items: center; gap: 6px;
    border: 1px solid var(--border); background: var(--surface); color: var(--text-muted); font: inherit;
    font-size: .82rem; cursor: pointer; box-shadow: 0 6px 18px rgba(0,0,0,.18); }
  .fb-fab:hover { color: var(--text); border-color: var(--accent); }

  /* Fixed-height nav bar, consistent across pages. */
  .topnav { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    height: 56px; padding: 0 16px; border-bottom: 1px solid var(--border); }
  .topnav-right { display: flex; align-items: center; gap: 10px; }
  .nav-link { color: var(--text); text-decoration: none; font-weight: 700; font-size: 0.84rem;
    white-space: nowrap; padding: 6px 10px; border-radius: 8px; }
  .nav-link:hover { background: var(--surface-2); }
  .nav-link.site-admin { background: #7a1f2b; color: #fff; }
  .nav-link.site-admin:hover { background: #93202f; }
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 120;
    display: flex; align-items: center; justify-content: center; padding: 16px; }
  .welcome-card { width: 100%; max-width: 420px; max-height: 90dvh; overflow-y: auto; text-align: center; }
  .welcome-emoji { font-size: 2.6rem; line-height: 1; }
  .welcome-title { margin: 10px 0 6px; font-size: 1.25rem; }
  .welcome-sub { color: var(--text-muted); font-size: 0.88rem; margin: 0 0 16px; }
  .welcome-qr { width: 180px; height: 180px; border-radius: 10px; background: #fff; }
  .welcome-card .grow { flex: 1; }
  .brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 800; text-decoration: none;
    color: var(--text); }
  .brand small { font-size: 0.6em; color: var(--text-muted); font-weight: 700; }

  .state { text-align: center; padding: 60px 16px; color: var(--text-muted); }

  .auth { max-width: 420px; margin: 0 auto; padding: 48px 16px; }
  .auth h2 { font-size: 1.2rem; margin-bottom: 16px; }
  .full { width: 100%; }
  .mono { font-family: var(--font-mono); font-size: 0.8rem; }

  .wrap { max-width: 720px; margin: 0 auto; padding: 12px 16px 80px; display: flex; flex-direction: column; gap: 16px; }

  /* Buttons */
  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 10px 18px; font-size: 0.9rem;
    border: 1px solid transparent; cursor: pointer; text-decoration: none; font: inherit; text-align: center; }
  .btn.sm { padding: 7px 14px; font-size: 0.82rem; border-radius: var(--radius-sm); }
  .primary { background: var(--accent); color: var(--accent-ink, #111); }
  .ghost { border-color: var(--border); color: var(--text); background: transparent; }
  .ghost:hover { border-color: var(--accent); }
  .danger { background: var(--danger); color: #fff; }
  .refund-box { padding: 12px 0 4px; }
  .refund-hint { color: var(--text-muted); font-size: .86rem; margin: 0 0 10px; }
  .refund-ok { color: var(--accent); font-size: .9rem; margin: 0; }
  .refund-box textarea { width: 100%; box-sizing: border-box; background: var(--bg, #100f0d); color: var(--text);
    border: 1px solid var(--border); border-radius: 9px; padding: 9px 11px; font: inherit; resize: vertical; }
  .refund-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
  .btn:disabled { opacity: 0.6; cursor: default; }
  /* Inputs had no disabled styling at all, so a locked field was indistinguishable from an editable
     one. Grey the control and show a not-allowed cursor so the state is obvious at a glance. */
  input:disabled, select:disabled, textarea:disabled {
    opacity: .55; cursor: not-allowed; background: var(--surface-2, rgba(127,127,127,.12));
    color: var(--text-muted); border-color: var(--border);
  }
  .field:has(input:disabled) label { opacity: .6; }
  .grow { flex: 1; }

  /* Cards */
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; }
  .card-title { font-weight: 800; font-size: 0.95rem; margin-bottom: 14px; }
  .card-title.nomb { margin-bottom: 0; }

  /* The card is the container now and the link is its top row, so the accent-on-hover moves up to
     the card — but only when the LINK is hovered, not when the disclosure under it is. */
  .review-card { transition: border-color 0.15s; }
  .review-card:has(.review-link:hover) { border-color: var(--accent); }
  .review-link { display: flex; align-items: center; gap: 14px; text-decoration: none; color: var(--text); }
  .review-link .card-title { margin-bottom: 4px; }
  .review-icon { font-size: 1.5rem; line-height: 1; }
  .review-text { flex: 1; min-width: 0; }
  .review-text .hint { margin: 0; }
  .review-arrow { font-size: 1.3rem; color: var(--text-muted); flex: none; }
  /* The hint above has margin:0 (see .review-text .hint), so this margin IS the entire gap between
     the paragraph and the disclosure's border. 12px read as attached to the link card; 20px was
     still tight. */


  /* Progressive disclosure. The key point stays on the page and the long-form reasoning is one tap
     away — same idiom (and the same native <details>) as the join screen's "Event info" panel. The
     native marker is suppressed for a chevron of our own so it reads the same in every browser. */
  .disc { border: 1px solid var(--border); border-radius: var(--radius-sm); margin: 0 0 12px; }
  .disc > summary { display: flex; align-items: center; gap: 8px; list-style: none; cursor: pointer;
    padding: 9px 12px; font-size: 0.78rem; font-weight: 700; color: var(--text-muted); }
  .disc > summary::-webkit-details-marker { display: none; }
  .disc > summary::before { content: '▸'; flex: none; display: inline-block; width: .8em; text-align: center; }
  .disc[open] > summary::before { content: '▾'; }
  .disc > summary:hover { color: var(--text); }
  .disc-body { padding: 0 12px 11px; display: flex; flex-direction: column; gap: 8px; }
  .disc-body .hint { margin: 0; line-height: 1.5; }
  /* AFTER `.disc`, not before it.
     This has been "fixed" three times and kept coming back, because `.disc { margin: 0 0 12px }` is
     declared further down the file at the SAME specificity — so source order won and the gap was
     always zero, whatever number was written here. Moved below its base rule, and written as
     margin-top alone so it overrides one property instead of fighting the whole shorthand. */
  .review-disc { margin-top: 22px; }
  /* Nested inside a toggle row's sub-text. The bordered box that suits a card-level disclosure is
     heavier than the two lines it hides, so this one borrows the camera's mic-note idiom instead:
     an underlined summary and nothing else. Same control, a quarter of the furniture. */
  .sub-disc { margin: 6px 0 0; border: none; }
  .sub-disc > summary { padding: 0; gap: 5px; font-size: inherit; font-weight: 600; text-decoration: underline; }
  .sub-disc .disc-body { padding: 6px 0 0; }
  .pending-flag { color: var(--accent); }

  .muted { color: var(--text-muted); }
  .small { font-size: 0.85rem; }
  .hint { font-size: 0.78rem; color: var(--text-muted); }
  .reveal-note { margin: -4px 0 12px; line-height: 1.5; }
  /* The two controls a host is most likely to poke at one-handed on a phone; iOS shrinks a bare
     date/time input below a comfortable tap. */
  .reveal-custom input { min-height: 44px; }
  /* A flex item defaults to min-width:auto and Chromium's <input type=date> has a min-content of
     ~167px, so this pair demanded ~346px plus the card's 36px of padding — 382px inside a 360px
     phone, which put the second box through the card's right edge. Scoped to this row rather than
     to every .field-row on the page, so nothing else shifts. */
  .field-row.reveal-custom { flex-wrap: wrap; }
  .field-row.reveal-custom > .field { min-width: 0; flex: 1 1 140px; }
  .cohost-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
  .cohost-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .cohost-who { display: flex; flex-direction: column; min-width: 0; }
  .cohost-email { font-weight: 600; font-size: 0.86rem; overflow-wrap: anywhere; }
  /* Truncates instead of painting outside its box. With overflow visible a long address ran clean
     under the OWNER pill — 34px of overlap at 360px, and real addresses are routinely that long. */
  .cohost-sub { font-size: 0.78rem; color: var(--text-muted);
    min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cohost-who { flex: 1 1 auto; }
  .cohost-acts { display: flex; align-items: center; gap: 8px; flex: none; }
  .cohost-tag { font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 5px; background: var(--accent); color: var(--accent-ink, #111); }
  .cohost-tag.owner { background: transparent; color: var(--text-muted); border: 1px solid var(--border); }
  .cohost-tag.pending { background: transparent; color: var(--text-muted); border: 1px dashed var(--border); }
  /* 12px below, matching the hint above it — the field is revealed BETWEEN two blocks and had
     spacing on neither side, so it opened flush against the first row of the list. */
  .cohost-add { display: flex; gap: 8px; margin-bottom: 12px; }
  .cohost-add input { flex: 1; padding: 9px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font: inherit; font-size: 0.88rem; }
  /* The standing gallery link. Dashed rather than solid so it never reads as one of the created
     shares below it, and allowed to wrap — its sub-line is a sentence, not an email address, so on
     a 360px phone the buttons drop to their own line instead of crushing it. */
  /* The standing gallery link is a ShareLinkRow like any other, so the dashed frame that marks it
     as "not one you created" lives on the wrapper rather than on the row itself. */
  .standing {
    border: 1px dashed var(--border); border-radius: var(--radius-sm); padding: 2px 12px;
  }
  .cohost-tag.standing-tag { background: transparent; color: var(--text-muted); border: 1px dashed var(--border); }
  .shares-div { margin: 14px 0 12px; }
  .mt { margin-top: 12px; }
  .mb { margin-bottom: 12px; }
  .row { display: flex; }
  .row.gap { gap: 8px; }
  .row.center { align-items: center; }
  .label-mono { font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono); margin-bottom: 8px; }

  /* Event header */
  .ev-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .ev-head h1 { font-size: 1.4rem; font-weight: 800; }
  .ev-sub { font-size: 0.8rem; color: var(--text-muted); margin-top: 6px; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .opens { font-size: 0.78rem; color: var(--accent); margin-top: 4px; }

  .badge { font-size: 0.7rem; font-weight: 700; padding: 2px 8px; border-radius: 20px; white-space: nowrap; }
  .b-live { background: #1a2e1a; color: #9bffb0; }
  .b-lock { background: #3a2e15; color: var(--accent); }
  .b-soon { background: #15263a; color: #7db8ff; }
  .b-end { background: #2a2a2a; color: #999; }

  /* Stats */
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 12px 8px; text-align: center; }
  .stat b { display: block; font-size: 1.3rem; }
  .stat span { font-size: 0.75rem; color: var(--text-muted); }

  /* Invite */
  /* ONE rhythm for this whole card. Every gap in here used to come from a different place — the
     label's own margin-top, the copybox's margin, .invite-go, .mt, .mt-sm — which measured out as
     12 / 6 / 6 / 16 / 12 / 6 down the card. Six numbers, no idea behind any of them.
     Now the stack owns the spacing and the children own none of it, so there is one number to
     change and nothing can drift out of step with anything else. */
  .qr-block { display: flex; flex-direction: column; align-items: center; gap: 10px; text-align: center; }
  /* A label belongs to the thing it names, so it sits closer to its box than the box does to its
     neighbours. That is the one place tighter spacing says something. */
  .cb-group { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 100%; }
  .qr { width: 180px; height: 180px; border-radius: var(--radius-sm); background: #fff; }
  .code-label { font-size: 0.72rem; color: var(--text-muted); font-family: var(--font-mono); letter-spacing: .04em; text-transform: uppercase; }
  /* One shape for both the code and the link. */
  /* Same disclosure shape as the email box on a shared link, so the two read as one idea. */
  .disclose {
    display: flex; align-items: center; gap: 6px; width: 100%;
    background: none; border: 0; padding: 7px 0; cursor: pointer;
    color: var(--text-muted); font: inherit; font-size: 0.82rem; text-align: left;
  }
  .disclose:hover { color: var(--text); }
  .chev { display: inline-block; transition: transform 0.15s ease; }
  .chev.open { transform: rotate(90deg); }
  @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }

  /* The whole header is the control, so the number and the word are both targets rather than a
     chevron you have to aim at. */
  .part-head {
    display: flex; align-items: center; gap: 8px; width: 100%;
    background: none; border: 0; padding: 0; cursor: pointer; color: var(--text); font: inherit;
  }
  .part-title { margin: 0; }
  /* Title left, its action right. */
  .card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .card-head .card-title { margin: 0; }
  .part-hint { margin-left: auto; font-size: 0.78rem; color: var(--text-muted); }
  .part-head:hover .part-hint { color: var(--text); }

  /* No exception. An 8px "deliberate break" on top of the stack's 10px gap still measures as one
     odd gap in a column of even ones — the grouping it was meant to signal is already carried by
     the buttons looking like buttons. */
  .invite-go { margin-top: 0; }
  .mt-sm { margin-top: 6px; }

  .copybox {
    display: flex; flex-direction: column; align-items: center; gap: 3px;
    width: 100%; max-width: 300px; margin: 0 auto;
    padding: 8px 12px; border-radius: var(--radius-sm); cursor: pointer;
    background: var(--surface-2); border: 1px solid var(--border); font: inherit;
  }
  .copybox:hover { border-color: var(--accent); }
  .copybox:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .cb-value { max-width: 100%; min-width: 0; }
  .cb-code { font-family: var(--font-mono); font-weight: 800; font-size: 1.5rem; letter-spacing: 0.14em; color: var(--accent); }
  .cb-url { font-size: 0.78rem; color: var(--text-muted); word-break: break-all; }
  /* What pressing it does, said quietly and inside the card, so the card is the whole control. */
  .cb-hint { font-size: 0.75rem; color: var(--text-muted); letter-spacing: .04em; }
  /* The QR and its download, as one object. */
  .qr-wrap { position: relative; display: inline-block; line-height: 0; }
  .qr-dl {
    position: absolute; right: 6px; bottom: 6px;
    width: 40px; height: 40px; border-radius: 8px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    font-size: 0.9rem; line-height: 1;
    background: rgba(0,0,0,0.78); color: #fff; border: 1px solid rgba(255,255,255,0.35);
  }
  .qr-dl:hover { background: #000; }
  .qr-dl:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }


  /* Toggle rows */
  .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 6px 0; }
  .t-label { font-weight: 700; font-size: 0.9rem; }
  .t-sub { font-size: 0.75rem; color: var(--text-muted); margin-top: 2px; }
  .divider { height: 1px; background: var(--border); margin: 4px 0; }

  /* Switch */
  .switch { position: relative; display: inline-block; width: 44px; height: 26px; flex-shrink: 0; }
  .switch input { position: absolute; opacity: 0; width: 0; height: 0; }
  .track { position: absolute; inset: 0; background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 20px; transition: background 0.15s; }
  .track::before { content: ''; position: absolute; left: 3px; top: 3px; width: 18px; height: 18px;
    background: var(--text-muted); border-radius: 50%; transition: transform 0.15s, background 0.15s; }
  .switch input:checked + .track { background: var(--accent); border-color: var(--accent); }
  .switch input:checked + .track::before { transform: translateX(18px); background: #111; }

  /* Fields */
  .field { margin-bottom: 12px; }
  .field > label { display: block; font-size: 0.8rem; font-weight: 600; margin-bottom: 6px; }
  .field-row { display: flex; gap: 12px; }
  .field-row .field { flex: 1; }
  input[type='text'], input[type='date'], input[type='time'], input[type='email'], input[list],
  select, textarea {
    width: 100%; padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text); font: inherit; font-size: 0.9rem;
  }
  input[type='file'] { padding: 8px; background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text); font: inherit; }

  .req-flag { display: block; margin-top: 4px; color: var(--accent, #f0b429); }
  .aspect-options { display: flex; flex-wrap: wrap; gap: 8px; }
  .shape-notice { margin: 8px 0 0; font-size: .82rem; color: var(--accent, #f0b429); }
  /* Guest delivery. Borrows the card's existing field / toggle-row / hint shapes; only the spacing
     and the two states below are new. */
  .gd-div { margin: 14px 0; }
  .gd-desc { display: block; margin: 6px 0 0; }
  /* The reminder when it cannot be offered — sits in the run of toggle rows it would have been
     part of, so it reads as that row's absence rather than as a footnote. */
  .gd-off { display: block; margin: 8px 0 10px; }
  .gd-now { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--border); }
  .gd-state { font-size: 0.82rem; margin-bottom: 8px; }
  .gd-sent { color: var(--text-muted); }
  /* .btn.sm is ~31px tall, which is fine for the tidy-up buttons beside a row and not fine for the
     one control on this page that emails every guest at once, tapped one-handed on a phone. */
  .gd-send { min-height: 44px; }
  .gd-foot { display: block; margin: 8px 0 0; }
  /* What the send actually did, kept on the page: the answer to "did that work" is asked again ten
     seconds later, by which time a toast is gone. */
  .gd-note { margin: 8px 0 0; font-size: 0.84rem; font-weight: 700; color: var(--accent); }
  .gd-note.bad { color: var(--danger); }
  .aspect-opt { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; font-size: 0.82rem;
    border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); cursor: pointer; }
  .pro-tag { font-size: 0.6rem; background: var(--accent); color: var(--accent-ink, #111); padding: 1px 5px; border-radius: 4px; font-weight: 700; }
  .aspect-opt.locked { opacity: 0.5; cursor: not-allowed; }
  .aspect-opt.locked input { cursor: not-allowed; }
  .aspect-opt.locked { position: relative; }

  /* Theme presets */
  .presets { display: flex; flex-wrap: wrap; gap: 8px; }
  .preset { position: relative; width: 64px; height: 48px; border-radius: var(--radius-sm); border: 2px solid; cursor: pointer;
    display: flex; align-items: center; justify-content: center; transition: transform .1s, box-shadow .1s; }
  .preset span { font-size: 0.72rem; font-weight: 700; text-transform: capitalize; }
  .custom-chip {
    background: var(--surface-2); border-color: var(--accent); color: var(--text-muted);
    cursor: default; position: relative;
  }
  .preset.selected { transform: scale(1.06); box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--accent); }
  .preset-check { position: absolute; top: -7px; right: -7px; width: 18px; height: 18px; border-radius: 50%;
    background: var(--accent); color: var(--accent-ink, #111); font-size: 0.62rem; font-weight: 800;
    display: flex; align-items: center; justify-content: center; }
  /* styled file-upload button (replaces the default browser control) */
  .upload-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer;
    padding: 10px 14px; border: 1px dashed var(--border); border-radius: var(--radius-sm);
    background: var(--surface-2); color: var(--text); font-size: 0.85rem; font-weight: 600; text-align: center; }
  .upload-btn:hover { border-color: var(--accent); }
  .upload-btn.drag { border-color: var(--accent); border-style: solid; background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  /* event-image preview — portrait, like the join background (no more thin bar) */
  .header-thumb { display: block; width: 150px; aspect-ratio: 3/4; object-fit: cover;
    border-radius: var(--radius-sm); margin-top: 10px; box-shadow: 0 4px 14px rgba(0,0,0,.3); }

  /* Participants */
  .participant-list { display: flex; flex-direction: column; gap: 10px; }
  .p-card { display: flex; align-items: center; gap: 6px; flex: none; }
  .p-card-l { font-size: .7rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); }
  .p-card select { font: inherit; font-size: .8rem; padding: 5px 7px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--bg); color: var(--text); max-width: 130px; }
  .p-count { font-weight: 600; opacity: .6; font-size: .85em; }
  /* A proper field, not a bare thin input: the icon sits inside it and the border belongs to the
     wrapper, so the whole thing reads as one control at a comfortable height. */
  .p-search {
    display: flex; align-items: center; gap: 8px; width: 100%; margin: 0 0 12px;
    padding: 0 10px; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface-2);
  }
  .p-search:focus-within { border-color: var(--accent); }
  .p-search-i { flex: none; font-size: 0.85rem; opacity: 0.65; }
  .p-search input {
    flex: 1; min-width: 0; padding: 9px 0; border: 0; background: none; color: var(--text);
    font: inherit; font-size: 0.85rem; outline: none;
  }
  .p-search-x {
    flex: none; border: 0; background: none; cursor: pointer; padding: 4px;
    color: var(--text-muted); font-size: 0.8rem; line-height: 1;
  }
  .p-search-x:hover { color: var(--text); }
  /* Tricks read as an achievement, so they carry the accent the trick list uses elsewhere. */
  .p-tricks { color: var(--accent); }
  /* 12px tall was the whole link box. Padding gives a thumb something to land on without moving
     anything — it sits in a line of small print that already has room around it. */
  .p-shots { color: var(--accent); text-decoration: none; font-weight: 600;
    display: inline-block; padding: 6px 2px; margin: -6px 0; }
  .p-shots:hover { text-decoration: underline; }
  .participant-row { display: flex; gap: 12px; align-items: center; }
  .participant-row .p-info { flex: 1; min-width: 0; }
  .p-del { flex: none; }
  .avatar { width: 38px; height: 38px; border-radius: 50%; background: var(--accent); color: var(--accent-ink, #111);
    display: flex; align-items: center; justify-content: center; font-weight: 800; flex-shrink: 0; }
  .p-name { font-weight: 700; font-size: 0.9rem; }
  .p-email { font-size: 0.78rem; color: var(--text); }
  .p-meta { font-size: 0.78rem; color: var(--text-muted); }
  /* Same fix as .cohost-sub, applied before it bites rather than after: this overflows its box by
     11px at 360 and clears the Remove button by 1.2px. One longer address and it collides. */
  .p-email { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  @media (max-width: 480px) {
    .stat-grid { grid-template-columns: repeat(2, 1fr); }
  }
  .mset-list { display: flex; flex-direction: column; gap: 6px; }
  .mset { display: flex; justify-content: space-between; align-items: center; gap: 10px;
    padding: 8px 11px; border-radius: 9px; border: 1px solid var(--border); background: var(--bg); }
  .mset-name { font-weight: 700; font-size: .87rem; }
  .mset-n { font-size: .78rem; color: var(--text-muted); font-variant-numeric: tabular-nums; }
</style>
