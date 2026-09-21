<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { page } from '$app/stores';
  import { goto, replaceState } from '$app/navigation';
  import { track } from '$lib/analytics';
  import { dep } from '$lib/reactive';
  import { getConfig, getMe, api, ApiError } from '$lib/api';
  import { firePurchase, fireLead, purchaseTracked, leadTracked } from '$lib/adtracking';
  import {
    getAdmin, getEvent, saveSettings, setReveal, toggleLock, deleteEvent,
    setHighlights, saveTheme, emailLink, linkSends, setAllowDownloads,
    getPhotosByOrganizer, listCohosts, inviteCohost, removeCohost,
    listShares, deleteShare, deleteParticipant,
    type AdminEvent, type Photo, type EventTheme, type CohostList, type ShareLink, type LinkSend,
    setParticipantCard, sendGuestPhotos, saveGalleryLink, REVEAL_CUSTOM, REVEAL_TICK_MS,
    ceilToRevealTick, zonedWallTimeToMs, msToZonedWallTime, revealMomentLabel, revealInstantRefusal,
    listGuests, addGuest, updateGuest, removeGuest, previewGuestImport, commitGuestImport, sendInvites,
    type GuestListPayload, type ImportPreview, type GuestField } from '$lib/events';
  import { GUEST_DELIVERY_DEFAULT, GUEST_DELIVERY_OPTIONS, guestReleaseAt, releaseDateKnown,
           reminderCanFire, reminderFiresAt, revealInstant, scheduledSendIssue, scopeFor,
           type GuestDelivery, type GuestSendScope } from '$lib/guestDelivery';
  import type { AppOptions, BillingConfig } from '$lib/types';
  import UpgradePanel from '$lib/components/UpgradePanel.svelte';
  import SiteAdminLink from '$lib/components/SiteAdminLink.svelte';
  import AdminBanner from '$lib/components/AdminBanner.svelte';
  import AdminActionLog from '$lib/components/AdminActionLog.svelte';
  import { ownershipOf, isGuarded, isLocked, readTookControl, writeTookControl,
           TAKE_CONTROL_CONFIRM, LOCKED_REFUSAL } from '$lib/adminGuard';
  import SiteNav from '$lib/components/SiteNav.svelte';
  import { readView, writeView } from '$lib/rememberedView';
  import HelpTip from '$lib/components/HelpTip.svelte';
  import Toggle from '$lib/components/Toggle.svelte';
  import TimeField from '$lib/components/TimeField.svelte';
  import ShareModal from '$lib/components/ShareModal.svelte';
  import ShareLinkRow from '$lib/components/ShareLinkRow.svelte';
  import GuestList from '$lib/components/GuestList.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import { applyEventTheme, isLightBg, THEME_PRESETS, THEME_PRESET_LABELS } from '$lib/theme';
  import { getAdminCode, saveAdminCode } from '$lib/session';
  import { showToast, showSuccess } from '$lib/toast';
  import { imgFallback } from '$lib/ui';
  import { reviewEmptyState } from '$lib/reviewEmpty';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import PosterModal from '$lib/components/PosterModal.svelte';
  import DownloadIcon from '$lib/components/DownloadIcon.svelte';
  import PosterWizard from '$lib/components/PosterWizard.svelte';
  import Loading from '$lib/components/Loading.svelte';
  import { modalFocus } from '$lib/ui';
  import MissionsModal from '$lib/components/MissionsModal.svelte';
  import { seedAfterMissions } from '$lib/posterFlow';
  import EventImageEditor from '$lib/components/EventImageEditor.svelte';
  import PaletteModal from '$lib/components/PaletteModal.svelte';
  import { normalizeStoredColor, type CustomPalette } from '$lib/palette';
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
  /** The public view of this event, used ONLY by the organizer-code wall to give advice that fits.
   *  Carries no secret — the join flow already makes an event's name and existence public. */
  let wallEvent: Awaited<ReturnType<typeof getEvent>> | null = null;
  let viewerIsAdmin = false;    // site admin drilled in via support-override → offer "back to site admin"

  // ── A site admin standing in somebody else's event ─────────────────────────
  //
  // ACCIDENT PREVENTION, NOT ACCESS CONTROL. The operator is a trusted site admin and the server
  // accepts every one of these writes from him with or without what follows; $lib/adminGuard says
  // so at length and nothing here should be mistaken for a boundary. The problem it solves is that
  // this screen is IDENTICAL whether he is in his own event or in a customer's wedding, and the
  // guest switches, downloads and face matching all save on the change event — so a stray tap
  // changes a live event with no confirm and no undo. You cannot accidentally autosave what you
  // cannot click.
  //
  // `youManage` is the signal, and it is NOT on the admin payload — GET /:code/admin never returns
  // it. It is on the PUBLIC event, which this page already fetches unconditionally for the
  // organizer-code wall (`wallEvent`), so the guard rides along on a request that was happening
  // anyway rather than adding one.
  $: ownership = ownershipOf(wallEvent?.youManage);
  $: adminGuarded = isGuarded(viewerIsAdmin, ownership);
  /** Kept in the session, per tab per event, so it survives a reload and the 30-second refresh but
   *  not the day. Read at init rather than in onMount so the first paint is already right — a
   *  manager that renders live and then greys out is a manager somebody has already clicked. */
  let tookControl = readTookControl(code);
  $: locked = isLocked(viewerIsAdmin, ownership, tookControl);
  /** The red bar's rendered height, bound out of AdminBanner. Feeds `--admin-bar-h`, which is what
   *  lets the section bar pin underneath it rather than behind it. */
  let adminBarH = 0;
  /** Open by default: the log exists to be read BEFORE anything is touched, and one that starts
   *  collapsed is one that gets opened after the fact. Collapsible because on a long support
   *  session it is a list you have already read. */
  /* Closed. It was opened by default on the reasoning that "did I do this?" is worth answering
   *  before touching anything — which is true, and still leaves it as the first thing on the screen
   *  every single visit, most of them about something else. A log that is always open is a log that
   *  is scrolled past, which is the same as one that is never read. One press when it is wanted. */
  let adminLogOpen = false;

  function takeControl() {
    if (!adminGuarded || tookControl) return;
    // A confirm, because this is the one moment the operator should have to notice. Everything
    // after it is ordinary editing, and re-asking per control is how a prompt becomes something you
    // dismiss without reading.
    if (!confirm(TAKE_CONTROL_CONFIRM)) return;
    tookControl = true;
    writeTookControl(code, true);
    // Deliberately NOT tracked through analytics(). `EventName` is a closed union of PRODUCT events
    // and this is an operations one — the record that matters is the server's action log, which is
    // written by the writes themselves and cannot be dropped by an ad blocker.
  }
  function releaseControl() {
    tookControl = false;
    writeTookControl(code, false);
  }
  /** The refusal, said out loud.
   *
   *  Every writing control on this page is also `disabled`, so this should be unreachable from a
   *  mouse — it is here for the paths a disabled attribute does not cover: a keyboard Enter on a
   *  control that was enabled when focus landed, a handler reached from a component's own event,
   *  and the next control somebody adds and forgets to gate. Returning true means "stop".
   *
   *  It toasts rather than returning silently for the reason GuestList's blockedPress exists: a
   *  press that does nothing is indistinguishable from a broken page. */
  function refuseWhenLocked(): boolean {
    if (!locked) return false;
    showToast(LOCKED_REFUSAL, true);
    return true;
  }

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
  // ── Which part of the admin page you are in ────────────────────────────────
  // This page had grown to ten cards in one column: every host scrolled past nine things to reach
  // the one they came for, and the length itself made it read as complicated. So the cards are
  // grouped and the page opens on a menu of them — the same shape the setup wizard uses, for the
  // same reason.
  //
  // null is the menu. Kept in memory rather than the URL on purpose: the hash here already carries
  // the ORGANIZER CODE (see the review link), so putting a section there would either fight it or
  // put a section name next to a secret in the address bar.
  type Section = 'controls' | 'share' | 'guests' | 'settings' | 'theme' | 'tricks' | 'photos' | 'upgrade';
  /** The palette row, split the way the palettes themselves already split.
   *
   *  Sixteen swatches in one wrapping row was a wall: the light ones were only findable by being
   *  paler than their neighbours, and which half a swatch belonged to was something the host had to
   *  work out from its colour. Two labelled columns say it instead.
   *
   *  Which column a palette lands in is asked of `isLightBg` — the SAME function applyEventTheme
   *  uses to decide whether the event wears light or dark chrome. Not a hand-kept list: a list
   *  would be a second place to update, and the day the two disagreed the card would file a palette
   *  under "Dark" and then render the event light. Add a palette to THEME_PRESETS and it sorts
   *  itself. */
  const PRESET_COLUMNS = [
    { label: 'Dark', keys: Object.keys(THEME_PRESETS).filter((k) => !isLightBg(THEME_PRESETS[k].bg)) },
    { label: 'Light', keys: Object.keys(THEME_PRESETS).filter((k) => isLightBg(THEME_PRESETS[k].bg)) },
  ];

  const SECTIONS = ['controls', 'share', 'guests', 'settings', 'theme', 'tricks', 'photos'] as const;
  // Kept across a refresh, per tab and per event — see lib/rememberedView. A host who reloads while
  // fiddling with the theme should land back on the theme, not at the top of the menu having lost
  // their place. Read at init rather than in onMount so the first paint is already the right
  // section and the menu does not flash past on the way to it.
  let section: Section | null = readView<Section>(`admin:${$page.params.code ?? ''}`, SECTIONS);
  $: writeView(`admin:${$page.params.code ?? ''}`, section);
  // Named here rather than in the markup so the tile and the bar you land on cannot disagree about
  // what the place you just opened is called — and, since the tiles are recognised by their icon at
  // least as much as by their name, the ICON is here for the same reason. A host taps a picture and
  // lands on a bar that only carries words, and has to re-read to be sure they arrived where they
  // meant to. Two fields, one entry, so the picture comes with them.
  //
  // U+FE0F on 🎛️ and ⚙️ is load-bearing — both default to TEXT presentation and render as a
  // monochrome glyph (or tofu) on desktop without it. See emojiPresentation.test.ts.
  const SECTION_META: Record<Section, { icon: string; title: string }> = {
    controls: { icon: '🎛️', title: 'Controls' },
    share: { icon: '🔗', title: 'Share & invite' },
    guests: { icon: '👥', title: 'Guests' },
    settings: { icon: '⚙️', title: 'Event settings' },
    theme: { icon: '🎨', title: 'Theme' },
    tricks: { icon: '🎯', title: 'Trick list' },
    photos: { icon: '⭐', title: 'Photos' },
    // U+FE0F on ⬆️ for the same reason as the two above: it defaults to TEXT presentation.
    upgrade: { icon: '⬆️', title: 'Upgrade this event' },
  };

  /** Bound out of UpgradePanel: does it actually have anything to offer? It renders nothing at all
   *  when the event is already at the top of every ladder, and only the panel can answer that. */
  let upgradeOffers = false;

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
    // Never offered to a site admin inside a customer's event: it is an unprompted modal whose
    // primary button opens an editor that auto-saves, which is the exact accident this page is
    // being guarded against. `locked` and not `adminGuarded`, so an operator who has deliberately
    // taken control still gets it.
    //
    // Computed here rather than read off the reactive `locked`: this is the one check on the page
    // that is not driven by a press, it runs from inside boot, and a reactive statement that has
    // not been flushed yet would answer for the state boot STARTED in.
    if (isLocked(viewerIsAdmin, ownershipOf(wallEvent?.youManage), tookControl)) return;
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
    if (run && refuseWhenLocked()) return;
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
    // The designer AUTO-SAVES, so there is no version of it that is safe to open read-only. The
    // lock is on the door rather than inside the room: nothing has to be plumbed through
    // PosterModal, PosterWizard, MissionsModal, PaletteModal or EventImageEditor, and none of them
    // can be reached while the page is locked.
    if (refuseWhenLocked()) return;
    track('poster_opened', undefined, code);
    posterSeed = null;
    if (ev?.posterConfig) { posterOpen = true; return; }
    wizardOpen = true;
  }
  /** "Start again from a design…" — raised by the designer itself, behind its own two-step confirm,
   *  so by the time it reaches here the host has pressed twice and meant it. The designer closes and
   *  the gallery opens in its place: one screen at a time, and no half-dead editor behind the picker
   *  holding a design that is about to be replaced.
   *
   *  `loadEvent()` on the way through for the same reason `on:close` does it — the designer
   *  auto-saves, so the event we hold is a version behind, and `hasDesign` below is read off it. */
  /** Raised by the poster designer's empty trick-cards tab — an OFFER it makes, and nothing more.
   *  The trick list is opt-in because it changes what guests see on their own phones, so the
   *  designer can open this editor and can never switch anything on by itself.
   *
   *  The designer CLOSES rather than sitting behind it: MissionsModal paints at z-index 80 and the
   *  designer's backdrop at 300, so stacked it would open faithfully and be invisible. The design
   *  auto-saves, so nothing is lost, and it reopens on the way back with the new list loaded —
   *  which is what loadEvent() in between is for.
   */
  let posterAfterMissions = false;
  /** Whether the design the designer closed on had been written to the event. See
   *  seedAfterMissions() — an untouched gallery preset is saved nowhere but `posterSeed`. */
  let posterMissionsPersisted = false;
  function editMissionsFromPoster(e: CustomEvent<{ persisted: boolean }>) {
    if (refuseWhenLocked()) return;
    posterOpen = false;
    posterAfterMissions = true;
    posterMissionsPersisted = !!e.detail?.persisted;
    missionsOpen = true;
  }
  async function closeMissions() {
    missionsOpen = false;
    if (!posterAfterMissions) return;
    posterAfterMissions = false;
    const seed = posterSeed;
    await loadEvent();
    // NOT unconditionally null. `loadEvent()` is what brings the new trick list back, and on an
    // edited design it also brings the design itself — but nothing persists an untouched gallery
    // preset, so dropping the seed there reopened the designer on the OLD design and the host's
    // pick was gone. seedAfterMissions() carries the reasoning.
    posterSeed = seedAfterMissions({ seed, persisted: posterMissionsPersisted });
    posterOpen = true;
  }

  function restylePoster() {
    if (refuseWhenLocked()) return;
    track('poster_restyle', undefined, code);
    posterOpen = false;
    posterSeed = null;
    wizardOpen = true;
    void loadEvent();
  }
  async function pickPreset(p: { key: string; cfg: Record<string, unknown>; theme: EventTheme; themePreset?: string }) {
    // Writes the event's THEME as well as opening the designer — the single biggest visible change
    // a stray press on this page can make to a live event.
    if (refuseWhenLocked()) { wizardOpen = false; return; }
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
  $: { dep(partQuery); partLimit = PART_PAGE; }   // a new search starts from the top
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
  // The server's own refusal, run as the host edits — the twin of the wizard's `revealIssue`. This
  // form had NO lower bound at all: no `min` on the date, nothing on the time, and a reveal in the
  // past opens the gallery while the event is still running. `sEndsAt` is the end read in the
  // EVENT's zone (see above), which is the only version worth comparing against.
  //
  // No upper bound here, deliberately: `AdminEvent` carries no retention instant, and inventing one
  // would refuse a reveal the server would have accepted. The server checks that bound on every
  // save regardless; this is the half that catches the host BEFORE they save, and the two bounds it
  // can check — already passed, and before the event ends — are the two that leak photographs.
  $: sRevealIssue = (sWantsCustomReveal && sActualRevealAt !== null && ev)
    ? revealInstantRefusal(sActualRevealAt,
        { expiresAt: sEndsAt, purgeAt: Number.MAX_SAFE_INTEGER }, Date.now())
    : null;
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
    if (refuseWhenLocked()) return;
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
  let sHearts = true;                      // guest hearts; on unless the host turns them off
  let sComments = false;                   // guest comments; OFF unless the host opts in
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
    baselineSig !== JSON.stringify([sName, sBlurb, sDate, sTime, sReveal, sDelay, sRevealDate, sRevealTime, sModeration, sNoFlash, sHearts, sComments, sTimezone, sSlug, [...sAspects].sort(),
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
  let editorFile: File | null = null;     // a newly picked image being cropped
  /** Reopening the editor on the image the event ALREADY has — the whole point of keeping the
   *  original. `editorFile` and `editorSrc` are mutually exclusive: one is a fresh pick, the other
   *  is a reframe of what is already there. */
  let editorSrc = '';
  let pendingOriginal: File | null = null;   // the untouched upload, sent alongside the crop
  let imageOriginalUrl: string | null = null;
  let imageCrop = '';
  $: editorOpen = !!editorFile || !!editorSrc;
  /** Can this event be reframed in place? Only once it has an original to reframe FROM — an event
   *  whose image was uploaded before this existed has a crop and nothing to re-cut, and offering
   *  the button there would open an editor on a picture that is already cropped and quietly crop it
   *  again. Those hosts get "Change image…", which is what they have always had. */
  $: canReposition = !!headerPreview && !!imageOriginalUrl;
  let savingTheme = false;

  let refreshTimer: ReturnType<typeof setInterval> | undefined;


  // ── Helpers ────────────────────────────────────────────────────────────────
  const pad = (n: number) => String(n).padStart(2, '0');
  const fmtTime = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // One parser, in $lib/palette, because the colour picker needs the same one and two copies of
  // "what counts as a colour" is two sets of edge cases. Same answers as the hand-rolled version
  // this replaces, including passing an exotic-but-valid stored value (an 8-digit hex set through
  // the API) straight through rather than flattening it to black.
  const normalizeHex = (val?: string): string => normalizeStoredColor(val);

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
  /** The reveal setting in the words the host chose it by, for the override notice. Named rather
   *  than described ("your reveal setting") so there is no doubt which switch is being overruled. */
  $: revealModeLabel = ev
    ? ev.revealMode === 'at_end' ? 'reveal when the event ends'
      : ev.revealMode === 'manual' ? 'reveal manually'
      : 'instant'
    : '';

  $: revealSublabel = ev
    ? ev.revealHidden
      // Checked BEFORE the mode, because the override beats the mode. Reading the mode first is what
      // produced "Instant — photos visible as taken" on an event whose guests could see nothing.
      ? 'Hidden by you — guests see an empty gallery'
      : ev.isRevealed
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
    // Outside the try, because it is read in the finally — and everything below is scoped to the
    // try block, so reading `sp` down there is a ReferenceError that lands as an unhandled
    // rejection nobody sees.
    let wantUpgrade = false;
    try {
    const sp = new URLSearchParams(location.search);
    wantUpgrade = sp.get('upgrade') === '1';
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
    if (orgCode) authInput = orgCode;
    // The PUBLIC event, fetched regardless of whether we hold a code: it is what lets the wall name
    // the event and tell "log in as the owner" apart from "there is no account on this one". Never
    // blocks boot — a wall with generic wording is a smaller failure than a page that will not load.
    void getEvent(code).then((ev0) => { wallEvent = ev0; }).catch(() => { /* generic wording it is */ });
    // Ask even with NO code. requireOrganizer has always authorised an owner or accepted co-host by
    // IDENTITY off the session cookie — but this page only ever asked when it already held a code,
    // so a signed-in host opening their own event's manage URL was shown the organizer-code wall
    // for an event the server would have let them straight into.
    {
      // Keep trying, on our own. The watchdog used to do nothing but put a "Try again" button on
      // screen and wait to be clicked — which is the page asking the host to perform a retry it
      // could have performed itself, while their event sat there working perfectly.
      for (;;) {
        bootAttempt++;
        const r = await tryLoad(!orgCode);
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
      // Coming back from a read-only page of the setup walkthrough, which is where a host is sent
      // when they want the part of their event that is bought rather than set.
      //
      // In the finally, AFTER booting is cleared, because until then the whole page is the word
      // "Loading…" — the target does not exist to be scrolled to, and getElementById quietly
      // answers null. Sitting above this, it did nothing at all.
      // `?upgrade=1` from the setup walkthrough now OPENS the section rather than hunting for an
      // anchor down the page — the panel is not on the page at all until it does. (It stays a query
      // parameter rather than a #hash because this page reads its organizer code out of the hash;
      // any other hash would be read as a credential and hand the host the code wall.)
      if (wantUpgrade) {
        section = 'upgrade';
        await tick();
        window.scrollTo({ top: 0, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
      }
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
  /** `quiet` suppresses the denial toast for the speculative attempt made with no code at all — a
   *  visitor who simply opened this URL is not being told off, they are being shown the wall. */
  async function tryLoad(quiet = false): Promise<LoadResult> {
    try {
      await withTimeout(loadEvent(), 10_000, 'Your event');
      authed = true;
      // Never cache an empty string: resolveOrgCode reads this back, and '' would look like a
      // stored answer while being none.
      if (orgCode) saveAdminCode(code, orgCode);
      void loadCohosts();
      void loadShares();
      void loadSends();
      void loadGuests();
      maybeOfferPoster();
      return 'ok';
    } catch (e) {
      if (worthRetrying(e)) return 'unreachable';     // keep the code; the caller decides when to stop
      authed = false;
      orgCode = '';
      if (!quiet) showToast(e instanceof Error ? e.message : 'Access denied', true);
      return 'denied';
    }
  }

  async function authenticate() {
    const input = authInput.trim();
    if (!input) { showToast('Enter your organiser code', true); return; }
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

  /** The start date, time and zone exactly as hydrateFromEvent() left them. */
  let hydratedStart: { date: string; time: string; tz: string } | null = null;
  /** Did the host leave the start alone?
   *
   *  This exists because "did the start move" was being asked of an EPOCH the form recomputed
   *  from scratch on every save, and the recompute was not symmetric with the load:
   *
   *    load:  msToZonedWallTime(e.startsAt, e.timezone || 'UTC')
   *    save:  zonedWallTimeToMs(sDate, sTime, e.timezone || <the BROWSER's zone>)
   *
   *  For the 59 of 74 events with no stored timezone those two disagree by the host's whole UTC
   *  offset — ten hours from Brisbane. So the server was told the start had moved ten hours,
   *  refused with "this event has already started and guests have joined, so the start time is
   *  locked", and rejected the entire save: the name, the blurb, the toggles, all of it. The host
   *  had not gone near the date field, and the fields on screen kept showing the edits until a
   *  reload threw them away.
   *
   *  Comparing the FIELDS rather than a derived instant is what makes this honest. They are the
   *  only thing the host actually touched, they need no timezone to interpret, and an unchanged
   *  form now sends no start at all — so the server has nothing to reject and every other setting
   *  saves. It also fixes the whole class, not just the null-timezone case. */
  $: startFieldsUntouched = !!hydratedStart
    && sDate === hydratedStart.date && sTime === hydratedStart.time && sTimezone === hydratedStart.tz;

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
    sHearts = e.heartsEnabled !== false;
    sComments = e.commentsEnabled === true;
    sTimezone = e.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    // WHAT THE START FIELDS SAID WHEN THEY WERE FILLED IN, so a save can tell whether the host
    // actually touched them. Without this the form recomputed an epoch on every save and handed
    // it to the server as if it were an edit — see startFieldsUntouched below.
    hydratedStart = { date: sDate, time: sTime, tz: sTimezone };
    sSlug = e.slug || '';
    sAspects = new Set(e.aspectRatios && e.aspectRatios.length ? e.aspectRatios : ['1:1']);
    galleryHearts = ev?.galleryHeartsEnabled !== false;
    galleryComments = ev?.galleryCommentsEnabled === true;
    // Snapshot the saved settings so we can detect unsaved edits (gates the Upgrade panel).
    baselineSig = JSON.stringify([sName, sBlurb, sDate, sTime, sReveal, sDelay, sRevealDate, sRevealTime, sModeration, sNoFlash, sHearts, sComments, sTimezone, sSlug, [...sAspects].sort(),
       sGuestDelivery, sGuestSendScope, sGuestSendDate, sGuestSendTime, sGuestMailThanks, sGuestMailReminder, sGuestMailLive]);

    // theme editor
    theme = e.theme || {};
    tFont = theme.font || '';
    selectedPreset = theme.preset || '';
    tCustomCss = theme.customCss || '';
    headerImageUrl = theme.headerImage || null;
    imageOriginalUrl = theme.imageOriginal || null;
    imageCrop = theme.imageCrop || '';
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
  /* HIDING TAKES THREE DELIBERATE ACTS. Revealing takes one.
   *
   *  The asymmetry is the point. Revealing is what a host came here to do and what their guests are
   *  waiting for; hiding takes a live gallery away from everyone at once, and it used to happen on a
   *  single tap with no confirmation of any kind — a host did exactly that mid-wedding and spent the
   *  evening thinking the product was broken.
   *
   *  So: arm ("Sure?"), then a dialog that names the consequence, and only then the write. The armed
   *  state disarms itself after a few seconds, because a button left sitting on "Sure?" is a trap
   *  for the next person who glances at the screen — the same reasoning as the review page's reject.
   */
  /* Taking the host TO the fix, not merely near it.
   *
   *  Switching the section alone leaves them at the top of a card they have to read through, on a
   *  screen where "Reveal photos" is one row among several that all look alike. Somebody who has
   *  just been told their gallery is dark should not then have to go hunting; the pill is only worth
   *  having if pressing it ends with the control under their eyes.
   *
   *  Three steps, and the order matters: switch the section, WAIT for it to render (the row does not
   *  exist until then, so scrolling first scrolls to nothing), then scroll and mark it.
   *
   *  The mark is time-limited rather than sticky. It answers "which line did it mean?" and then gets
   *  out of the way — a highlight that stays becomes part of the furniture and stops being read. */
  let revealRowEl: HTMLElement | undefined;
  let revealFlash = false;
  let revealFlashTimer: ReturnType<typeof setTimeout> | undefined;

  async function goToReveal() {
    section = 'controls';
    await tick();
    revealRowEl?.scrollIntoView({
      // Smooth unless the reader has asked for less movement, in which case jumping straight there
      // is the same answer delivered without the motion.
      behavior: typeof matchMedia === 'function'
        && matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'center',
    });
    revealFlash = true;
    if (revealFlashTimer) clearTimeout(revealFlashTimer);
    revealFlashTimer = setTimeout(() => (revealFlash = false), 2800);
  }

  /* ONE arming mechanism, shared by every button that takes something away from guests mid-event.
   *
   *  Two of them now, hiding the photos and locking the event, and a third copy of this state is
   *  where the two behaviours would start to drift apart. Only one can be armed at a time, which is
   *  also the honest model: arming a second is a decision to abandon the first.
   */
  type Armable = 'hide' | 'lock';
  let armedAction: Armable | null = null;
  let armedTimer: ReturnType<typeof setTimeout> | undefined;

  function disarmAll() {
    armedAction = null;
    if (armedTimer) { clearTimeout(armedTimer); armedTimer = undefined; }
  }

  /** Arm on the first press, run on the second. Returns true when the caller should go ahead.
   *
   *  Disarms itself after five seconds, because a button left sitting on "Sure?" is a trap for the
   *  next person who glances at the screen. */
  function armOrRun(kind: Armable): boolean {
    if (armedAction !== kind) {
      armedAction = kind;
      if (armedTimer) clearTimeout(armedTimer);
      armedTimer = setTimeout(disarmAll, 5000);
      return false;
    }
    disarmAll();
    return true;
  }

  function requestReveal() {
    if (refuseWhenLocked()) return;
    if (!ev || actionBusy) return;
    // Revealing is NOT armed. Making the safe direction as hard as the dangerous one teaches people
    // to click through both without reading, which is how the dangerous one gets clicked.
    if (!ev.isRevealed) { void doReveal(); return; }
    if (armOrRun('hide')) void doReveal();
  }

  function requestLock() {
    if (refuseWhenLocked()) return;
    if (!ev || actionBusy) return;
    // Unlocking gives capability back, so it goes straight through. Locking stops every guest
    // taking photos at once, which is the same shape of harm as hiding, and gets the same two steps.
    if (ev.isLocked) { void doLock(); return; }
    if (armOrRun('lock')) void doLock();
  }

  async function doReveal() {
    if (refuseWhenLocked()) return;
    if (!ev || actionBusy) return;
    const isRevealed = ev.isRevealed;
    // BOTH directions ask, and hiding asks harder — it used to ask only when revealing.
    //
    // That was backwards. Revealing is the expected, awaited thing; hiding takes a live gallery
    // away from every guest at once, and it fired on a single press with no confirmation at all and
    // only a toast afterwards. A host did exactly that mid-wedding and spent the evening believing
    // the gallery was broken, because nothing on this screen said otherwise.
    //
    // The wording names the consequence rather than the setting: "Hide photos?" restates the button,
    // and the thing worth knowing is that the guests lose the gallery until it is turned back on.
    const ask = isRevealed
      ? 'Hide all photos from guests?\n\nThe gallery will look empty to everyone until you reveal them again. Nothing is deleted.'
      : 'Reveal all photos to participants now?';
    if (!confirm(ask)) return;
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

    // Put the switch back before refusing: a Toggle is bound to its own checkbox, so by the time
    // this handler runs the thing has already moved on screen even though nothing was saved.
    if (locked) { input.checked = !checked; showToast(LOCKED_REFUSAL, true); return; }

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
    // Captured BEFORE the await, the way setGuestFlag above does it. A DOM event's currentTarget is
    // null once dispatch has finished, so reading it in the catch threw a TypeError instead of
    // reverting — and because that throw happened inside the catch, the error toast on the next
    // line never ran either. A failed save left the switch showing ON and said nothing at all.
    const input = e.currentTarget as HTMLInputElement;
    const checked = input.checked;
    // As in setGuestFlag: revert the visible switch first, then say why.
    if (locked) { input.checked = !checked; showToast(LOCKED_REFUSAL, true); return; }
    try {
      await setAllowDownloads(code, orgCode, checked);
      showToast(checked ? 'Downloads enabled' : 'Downloads disabled');
      if (ev) ev = { ...ev, allowDownloads: checked };
    } catch (err) {
      input.checked = !checked;
      showToast(err instanceof Error ? err.message : 'Failed', true);
    }
  }

  async function doLock() {
    if (refuseWhenLocked()) return;
    if (!ev || actionBusy) return;
    const locking = !ev.isLocked;
    // Same shape as the hide dialog: what it DOES to the guests, and what it does not do to their
    // photos. A host locking mid-event is usually trying to stop new shots rather than to hide the
    // ones already taken, and it is worth saying that those are safe.
    if (locking && !confirm('Lock this event?\n\nGuests will not be able to take any more photos. Everything already taken stays exactly where it is, and the gallery is unaffected.')) return;
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
    if (refuseWhenLocked()) return;
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
    if (refuseWhenLocked()) return;
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
    if (refuseWhenLocked()) return;
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
      if (!r.ok) {
        refundTurnstile?.reset();
        // Use the server's own words. Ours said only "Could not send your request", which on the
        // one form where the words are a paying host asking for their money back is the same dead
        // end twice over: the bot check's refusal names the address to unblock, and this threw it
        // away. Fall back to ours only when there is nothing there to use.
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(d.error || 'Could not send your request');
      }
      refundDone = true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Failed — please email support@snapdini.com', true);
    } finally { refundBusy = false; }
  }

  // ── Settings ─────────────────────────────────────────────────────────────
  function toggleAspect(value: string) {
    if (refuseWhenLocked()) return;
    if (value !== '1:1' && !canAllShapes) {
      // Say why. Silently ignoring the click is what made this feel broken: the box appeared to
      // tick, the save succeeded, and the shape was gone on reload with nothing explaining it.
      shapeNotice = billingKnown
        ? 'Extra frame shapes need the frame pack — add it in the Upgrade card, then pick your shapes.'
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
    if (refuseWhenLocked()) return;
    if (sWantsCustomReveal && sActualRevealAt === null) {
      showToast('Pick the date and time for the reveal', true);
      return;
    }
    if (sRevealIssue) { showToast(sRevealIssue, true); return; }
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
      // Omitted entirely when the host did not touch the start fields. Sending a recomputed epoch
      // for an unedited form is what made an ordinary settings save look like a reschedule.
      const startsAt = (startFieldsUntouched || !sDate)
        ? undefined
        : (zonedWallTimeToMs(sDate, sTime || '00:00', sTimezone || 'UTC') ?? new Date(`${sDate}T${sTime || '00:00'}`).getTime());
      const saved = await saveSettings(code, orgCode, {
        name: sName,
        blurb: sBlurb.trim(),
        // All three together or none: the server falls back to parsing startDate/startTime when
        // there is no epoch, so leaving those behind would recreate the same phantom reschedule
        // through the other door.
        ...(startFieldsUntouched ? {} : { startsAt, startDate: sDate, startTime: sTime }),
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
        heartsEnabled: sHearts,
        commentsEnabled: sComments,
        ratingMode: 'favourite',
        timezone: sTimezone,
        slug: sSlug.trim(),
        aspectRatios: [...sAspects]
      });
      // The server saves everything else even when it will not honour the shapes, so say which
      // happened rather than a blanket "saved".
      if (saved?.startRefused) {
        // EVERYTHING ELSE SAVED. This used to be a rejection — one locked field threw away the
        // whole payload, and the form kept showing edits it had not stored until a reload took
        // them back. Now the start alone is refused, so the host is told which part did not take
        // rather than being left to guess which of twenty fields the error was about.
        shapeNotice = `Saved — but the start time was not changed. ${saved.startRefused}`;
        showToast('Saved, except the start time', true);
        // Put the date fields back to the truth. Leaving the refused value on screen is the other
        // half of the original complaint: an edit that looks applied until something reloads.
        if (ev) {
          const z = msToZonedWallTime(saved.startsAt ?? ev.startsAt, sTimezone || 'UTC');
          if (z) { sDate = z.date; sTime = z.time; }
          hydratedStart = { date: sDate, time: sTime, tz: sTimezone };
        }
      } else if (saved?.aspectsRefused) {
        shapeNotice = 'Saved — but the extra frame shapes need the frame pack, so they were not applied.';
        showToast('Settings saved, except the frame shapes', true);
      } else if (saved?.revealAtClamped || saved?.guestSendAtClamped) {
        // A time the host typed that the server had to move — it cannot fall outside the event.
        // Said out loud, because the alternative is the form quietly showing a different time from
        // the one they entered, which is how a host learns to distrust the whole page.
        shapeNotice = saved.revealAtClamped
          ? 'Saved — your reveal time was outside the event, so it was moved to when the event ends.'
          : 'Saved — your send time was outside the event, so it was moved to when the event ends.';
        showToast('Saved, with one time adjusted', true);
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
  /** Whose event this is, for the site-admin banner — "you are in someone else's event" is a
   *  warning; "you are in Sarah's event" is information. Taken from the co-host card, which is the
   *  only thing on this page that knows the owner at all (the admin payload carries no owner) and
   *  which is loaded anyway. Empty when that request has not landed, and the banner says less
   *  rather than guessing. */
  $: ownerName = cohostData?.owner ? (cohostData.owner.name || cohostData.owner.email) : '';
  // Collapsed by default: see the note on .part-head. Not persisted — a host who opened it once was
  // looking for one guest, not changing how the page works from then on.
  let partsOpen = false;
  let cohostOpen = false;
  // Collapsed by default, and deliberately not remembered: revealing a long-lived secret should be
  // a decision each time, not a state the page keeps for you.
  let adminCodeOpen = false;
  /** Revealed only on request, and re-hidden whenever the panel is closed — so the code is never
   *  still on screen from a previous visit to this card. */
  let codeShown = false;
  $: if (!adminCodeOpen) codeShown = false;
  /** A fixed run of dots, NOT derived from the real code: deriving the length from the secret would
   *  leak its length into the DOM, which is a small thing to give away for nothing. */
  const CODE_MASK = '•'.repeat(32);
  let cohostEmail = '';
  let cohostBusy = false;
  async function loadCohosts() {
    try { cohostData = await listCohosts(code, orgCode); } catch { /* leave as-is */ }
  }
  async function addCohost() {
    if (refuseWhenLocked()) return;
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
    if (refuseWhenLocked()) return;
    try { await removeCohost(code, orgCode, id); await loadCohosts(); showSuccess('Co-host removed'); }
    catch (e) { showToast(e instanceof Error ? e.message : 'Could not remove', true); }
  }

  // ── Guest list & invites ─────────────────────────────────────────────────────
  // All six handlers share one shape: the server answers every mutation with the WHOLE list, and
  // we assign it. No local patching of a row after a successful call — the server is what decides
  // whether an address is now suppressed or a duplicate was collapsed, and a locally-patched row
  // is exactly how a screen ends up disagreeing with the database it is reporting on.
  let guestData: GuestListPayload | null = null;
  let guestBusy = false;
  let importPreview: ImportPreview | null = null;
  let importText = '';

  async function loadGuests() {
    try { guestData = await listGuests(code, orgCode); } catch { /* leave the card as it was */ }
  }

  /** Every guest mutation, wrapped once: busy flag, the server's own error words, and the fresh
   *  list on the way out. */
  async function guestAction<T extends GuestListPayload>(run: () => Promise<T>, onOk?: (r: T) => void) {
    // Every guest-list mutation is funnelled through here by design (see the note above), which
    // makes it the one place the lock has to hold for all six of them.
    if (refuseWhenLocked()) return;
    guestBusy = true;
    try {
      const r = await run();
      guestData = r;
      onOk?.(r);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'That did not work', true);
    } finally { guestBusy = false; }
  }

  const onGuestAdd = (e: CustomEvent<{ name: string; email: string; notes: string }>) =>
    guestAction(() => addGuest(code, orgCode, e.detail), () => showSuccess('Added to the guest list'));

  const onGuestUpdate = (e: CustomEvent<{ id: string; name: string; email: string; notes: string }>) =>
    guestAction(() => updateGuest(code, orgCode, e.detail.id, e.detail), () => showSuccess('Guest updated'));

  function onGuestRemove(e: CustomEvent<{ id: string }>) {
    const g = guestData?.guests.find((x) => x.id === e.detail.id);
    if (!confirm(`Remove ${g?.name || g?.email || 'this guest'} from the list?`)) return;
    // Any invite already sent to them keeps its row on the server — a bounce the host still needs
    // to act on must not disappear along with the typo that caused it.
    guestAction(() => removeGuest(code, orgCode, e.detail.id));
  }

  async function onGuestPreview(e: CustomEvent<{ text: string; mapping?: GuestField[] }>) {
    // A preview writes nothing, but it is the first half of an import and letting it run would put
    // a "Import 40 guests" button in front of a locked page.
    if (refuseWhenLocked()) return;
    guestBusy = true;
    importText = e.detail.text;
    try {
      importPreview = await previewGuestImport(code, orgCode, e.detail.text, e.detail.mapping);
    } catch (err) {
      importPreview = null;
      showToast(err instanceof Error ? err.message : 'Could not read that', true);
    } finally { guestBusy = false; }
  }

  function onGuestImport(e: CustomEvent<{ text: string; mapping: GuestField[] }>) {
    // The same text and mapping that produced the preview go back to the server, which re-runs the
    // identical computation over them. What the host approved is therefore what happens — no
    // server-side draft to drift out of step with what is on their screen.
    guestAction(
      () => commitGuestImport(code, orgCode, e.detail.text, e.detail.mapping),
      (r) => {
        importPreview = null;
        importText = '';
        showSuccess(`Imported ${r.imported} guest${r.imported === 1 ? '' : 's'}`
          + (r.skipped ? ` — ${r.skipped} row${r.skipped === 1 ? '' : 's'} skipped` : ''));
      },
    );
  }

  function onGuestSend(e: CustomEvent<{ guestIds?: string[] }>) {
    guestAction(
      () => sendInvites(code, orgCode, e.detail.guestIds),
      (r) => {
        // The skipped list is reported FIRST and as a warning, not folded into a success count.
        // "Sent 19" when 20 were asked for reads as success; the one that did not go is the whole
        // reason this feature records anything at all.
        // What was not even ATTEMPTED comes first, because it is the only one of these the host has
        // to act on: press Send again. A "send to everyone" press mails only people who have never
        // had an invite, so the next press reaches exactly these and no one twice.
        if (r.notSent)
          showToast(`Sent ${r.sent} — ${r.notSent} still to go (${r.perSend} per send). Press Send invites again.`, true);
        else if (r.skipped.length)
          showToast(`Sent ${r.sent} — ${r.skipped.length} blocked (bounced or reported as spam before)`, true);
        else if (r.failed)
          showToast(`Sent ${r.sent}, ${r.failed} failed to send`, true);
        // Nothing sent and nothing left: everyone on the list already has one. Said plainly, because
        // "Invites sent to 0 guests" reads as a failure when it is the finished state.
        else if (!r.sent)
          showToast('Everyone on your list has already been invited');
        else
          showSuccess(`Invite${r.sent === 1 ? '' : 's'} sent to ${r.sent} guest${r.sent === 1 ? '' : 's'}`);
      },
    );
  }

  // ── Shared links ─────────────────────────────────────────────────────────────
  let sharesList: ShareLink[] = [];
  let editShare: ShareLink | null = null;   // opens the share modal to rename / change the URL
  /** The gallery link's own two switches. Kept beside the other link settings rather than in Event
   *  settings, because that is where a host goes to decide what a LINK does. */
  let galleryLinkEdit = false;
  let galleryHearts = true;
  let galleryComments = false;
  let galleryLinkBusy = false;
  async function applyGalleryLink() {
    if (refuseWhenLocked()) return;
    galleryLinkBusy = true;
    try {
      await saveGalleryLink(code, orgCode, { galleryHeartsEnabled: galleryHearts, galleryCommentsEnabled: galleryComments });
      if (ev) { ev.galleryHeartsEnabled = galleryHearts; ev.galleryCommentsEnabled = galleryComments; }
      galleryLinkEdit = false;
      showSuccess('Saved');
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not save', true); }
    finally { galleryLinkBusy = false; }
  }
  async function loadShares() { try { sharesList = (await listShares(code, orgCode)).shares; } catch { /* leave */ } }
  async function copyShare(url: string) { try { await navigator.clipboard.writeText(url); showToast('Link copied'); } catch { showToast(url, false); } }
  async function dropShare(sh: ShareLink) {
    if (refuseWhenLocked()) return;
    // Asked, because it cannot be undone and it takes more with it than the URL. A link that was
    // open to reactions owns the people who reacted through it — their name lives on the link, not
    // on the event — so deleting the link deletes their hearts and words too. Better said here than
    // discovered afterwards.
    const extra = (sh.heartsEnabled || sh.commentsEnabled)
      ? '\n\nThis link let people react, so any hearts and comments left through it go with it. Your guests\u2019 own hearts and comments are not affected.'
      : '';
    if (!confirm(`Delete \u201c${sh.label}\u201d? Anyone holding it gets a "not found" page.${extra}`)) return;
    try { await deleteShare(code, orgCode, sh.id); await loadShares(); showSuccess('Share link deleted'); }
    catch (e) { showToast(e instanceof Error ? e.message : 'Could not delete', true); }
  }
  const shareKindText = (k: string, n: number | null) => k === 'favourites' ? 'Favourites' : k === 'selected' ? `${n ?? ''} selected` : 'Whole gallery';

  // ── Participants ─────────────────────────────────────────────────────────────
  // Which row is mid-save, so its select cannot be spun twice before the first answer lands.
  let cardBusy: string | null = null;
  async function moveCard(p: { id: string; name: string }, set: string) {
    // Reloads the event on the way out, which puts the <select> back where it was — so refusing
    // here also undoes the option the browser has already shown as chosen.
    if (locked) { showToast(LOCKED_REFUSAL, true); void loadEvent(); return; }
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
    if (refuseWhenLocked()) return;
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
    if (refuseWhenLocked()) return;
    sendingFrom = shareId;
    try {
      const r = await emailLink(code, orgCode, emails, shareId);
      // Report what actually happened rather than what was asked for: a partial failure used to
      // report full success, because the old toast counted the addresses submitted.
      if (r.errors && !r.sent) showToast(`Could not send to ${r.errors} address${r.errors !== 1 ? 'es' : ''}`, true);
      else if (r.errors) showToast(`Sent to ${r.sent} — ${r.errors} failed`, true);
      // Never attempted, because the list was longer than one press. Said out loud: the old toast
      // reported `Sent to 200 addresses!` for 250 pasted addresses and the fifty vanished. Sending
      // again is safe — the ledger stops anyone being mailed the same link twice.
      else if (r.notSent) showToast(`Sent to ${r.sent} — ${r.notSent} still to go (${r.perSend} per send). Send again to finish.`, true);
      else showToast(`Sent to ${r.sent} address${r.sent !== 1 ? 'es' : ''}!`);
      await loadSends();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Send failed', true);
    } finally {
      sendingFrom = undefined;
    }
  }

  // ── Theme editor ─── changes apply live to the page AND auto-save; no preview/save buttons.
  let paletteOpen = false;

  /** The picker handed back eight colours. Treated exactly like a preset, minus the preset NAME:
   *  an empty `selectedPreset` is what has always meant "these colours are the host's own", so the
   *  custom swatch lights up and none of the named ones do, with no new state to keep in step. */
  async function onPaletteApply(e: CustomEvent<CustomPalette>) {
    if (refuseWhenLocked()) { paletteOpen = false; return; }
    theme = { ...theme, ...e.detail };
    selectedPreset = '';
    syncColorInputs();
    paletteOpen = false;
    await persistTheme();
    showSuccess('Your colours are live');
  }

  /** Are the event's colours the host's OWN? An empty `selectedPreset` has always meant "not one of
   *  the named palettes", but on an event that has no theme at all it means "nothing chosen yet" —
   *  and the custom swatch was showing a tick for it, claiming a choice nobody had made. A palette
   *  is custom only when there are colours AND no preset names them. */
  $: hasCustomPalette = !selectedPreset && !!theme.bg;

  async function applyPreset(key: string) {
    if (refuseWhenLocked()) return;
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
    if (refuseWhenLocked()) return;
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
    // A drop is not a click, so `disabled` on the label cannot stop it — a dragged file would open
    // the cropper and the cropper's Confirm uploads.
    if (refuseWhenLocked()) return;
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) editorFile = file;   // drag-drop opens the same editor
  }
  async function onImageConfirm(e: CustomEvent<{ blob: Blob; crop: string }>) {
    if (refuseWhenLocked()) { editorFile = null; editorSrc = ''; return; }
    pendingHeaderBlob = e.detail.blob;
    imageCrop = e.detail.crop;
    // A fresh pick carries its original up with it; a reframe already has one stored and must not
    // replace it — re-uploading the same picture on every nudge would leave a trail of dead files.
    pendingOriginal = editorFile;
    if (headerPreview && headerPreview.startsWith('blob:')) URL.revokeObjectURL(headerPreview);
    headerPreview = URL.createObjectURL(e.detail.blob);
    editorFile = null;
    editorSrc = '';
    await persistTheme();      // upload + save the new image immediately
  }

  /** Open the editor on the ORIGINAL, parked where the last crop was taken. */
  function repositionImage() {
    if (refuseWhenLocked()) return;
    if (!imageOriginalUrl) return;
    editorFile = null;
    editorSrc = imageOriginalUrl;
  }

  async function clearHeaderImage() {
    if (refuseWhenLocked()) return;
    pendingHeaderBlob = null;
    pendingOriginal = null;
    headerImageUrl = null;
    imageOriginalUrl = null;
    imageCrop = '';
    headerPreview = null;
    await persistTheme();      // persist the removal immediately
  }

  /** One POST, used for both files the event image now needs. `kind` only tells the server which
   *  encoder to use; the auth, the size cap and the metadata scrub are the same either way. */
  async function uploadThemeImage(body: Blob, kind: 'original' | 'crop'): Promise<string> {
    const form = new FormData();
    form.append('headerImage', body, kind === 'original' ? 'original.jpg' : 'event-image.jpg');
    const res = await fetch(`/api/events/${code}/theme-image?kind=${kind}`, {
      method: 'POST', body: form, headers: { 'X-Organizer-Code': orgCode }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    return data.url as string;
  }

  // Uploads any pending image, then saves the current palette. Called on every change.
  async function persistTheme() {
    // The backstop for the theme card. Every entry point above refuses on its own; this is what
    // catches the next one somebody adds.
    if (refuseWhenLocked()) return;
    savingTheme = true;
    try {
      // The original goes up FIRST and only when there is a new one: if this throws, the event is
      // left with the image it already had rather than a crop whose original never arrived.
      if (pendingOriginal) {
        imageOriginalUrl = await uploadThemeImage(pendingOriginal, 'original');
        pendingOriginal = null;
      }
      if (pendingHeaderBlob) {
        headerImageUrl = await uploadThemeImage(pendingHeaderBlob, 'crop');
        pendingHeaderBlob = null;
      }
      const next: EventTheme = {
        bg: cBg, surface: cSurface, accent: cAccent,
        text: cText, surface2: cSurface2, border: cBorder,
        // Carried through rather than dropped. These two have no colour input of their own, so they
        // were never read back into the c* variables and every save quietly discarded them — a
        // palette's muted text and darker accent came from THEME_PRESETS, survived until the next
        // theme change, and then fell back to the app chrome's grey. Undefined stays undefined, so
        // an event that never had them still saves none.
        textMuted: theme.textMuted, accentDark: theme.accentDark,
        // No explicit mode — appearance is derived from the palette's background (see applyEventTheme).
        preset: selectedPreset || undefined,
        customCss: tCustomCss || undefined,
        headerImage: headerImageUrl || undefined,
        // Only meaningful together with the image, and cleared with it.
        imageOriginal: headerImageUrl ? imageOriginalUrl || undefined : undefined,
        imageCrop: headerImageUrl ? imageCrop || undefined : undefined
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
<!-- The mark goes HOME, not to the dashboard: "← My events" is already in this same bar, so
     sending the logo there too spends both routes out of here on the same destination and leaves no
     way back to the site. -->
<SiteNav admin>
  {#if viewerIsAdmin}<SiteAdminLink />{/if}
  {#if viewerLoggedIn}<a class="nav-link" href="/dashboard">← My events</a>{/if}
</SiteNav>

{#if booting}
  {#if bootStalled}
    <div class="state">
      <p>Still trying to reach the server…</p>
      <p class="hint" style="margin:6px 0 14px">
        Your event is safe and nothing you have done is lost — this page just cannot get an answer
        yet. It keeps trying on its own{#if bootAttempt > 1}{' '}(attempt {bootAttempt}){/if}, so you can
        leave it open.
      </p>
      <button class="btn primary" on:click={() => location.reload()}>Reload now</button>
    </div>
  {:else}
    <Loading />
  {/if}
{:else if !authed}
  <!-- ── Auth wall ──
       It used to be a bare box saying "Paste your organizer code" — for a code that is never
       emailed and appears in exactly two places: the link you land on after creating the event,
       and your dashboard. Somebody who did not have it was given no way to get one, which is the
       dead end DEVELOPMENT.md forbids: say what is blocking AND take them to it.
       So the route out is chosen from what we can actually know about THIS event. -->
  <div class="auth">
    <div class="card">
      <h2>{wallEvent?.name ? `Manage “${wallEvent.name}”` : 'Manage this event'}</h2>

      {#if wallEvent?.hasOwner && !viewerLoggedIn}
        <!-- The common case, and the one with a real answer. -->
        <p class="auth-lead">This event was made with an account. Log in as its owner and you are
          straight in — no code needed. If it is not your account, the owner can send you an
          organiser code or a manage link from <b>Share &amp; invite → Co-hosts → Organiser code</b>.</p>
        <a class="btn primary full" href={`/login?next=${encodeURIComponent(`/admin/${code}`)}`}>Log in</a>
        <p class="auth-alt">Not your account? You can still use the organiser code below.</p>
      {:else if wallEvent?.hasOwner && viewerLoggedIn}
        <p class="auth-lead">You are signed in, but this event belongs to a different account.
          Best: ask the owner to add you as a <b>co-host</b> — you would then manage it with this
          login and never need a code. Otherwise they can send you an organiser code from
          <b>Share &amp; invite → Co-hosts → Organiser code</b>.</p>
        <a class="btn ghost full" href={`/login?next=${encodeURIComponent(`/admin/${code}`)}`}>Log in as someone else</a>
      {:else if wallEvent && !wallEvent.hasOwner}
        <!-- No account on the event at all: the code is genuinely the only key. Say so, rather than
             implying a recovery that does not exist. -->
        <!-- Only demo events reach this: real ones are always made by a signed-in account. -->
        <p class="auth-lead">This event has no account behind it, so the <b>organiser code</b> is the
          only key. It is remembered in the browser it was created in — try opening the manage link
          on that device.</p>
      {:else}
        <p class="auth-lead">The <b>organiser code</b> is this event's private key — it lets you
          manage it without logging in. The owner can find theirs under
          <b>Share &amp; invite → Co-hosts → Organiser code</b>.</p>
      {/if}

      <div class="field">
        <label for="org-code">Organiser code</label>
        <input id="org-code" class="mono" type="text" bind:value={authInput}
          placeholder="Paste your organiser code"
          on:keydown={(e) => e.key === 'Enter' && authenticate()} />
      </div>
      <button class="btn {wallEvent?.hasOwner && !viewerLoggedIn ? 'ghost' : 'primary'} full"
              on:click={authenticate} disabled={authBusy}>
        {authBusy ? 'Checking…' : 'Use the code'}
      </button>
    </div>
  </div>
{:else if ev}
  <!-- ── Dashboard ── -->
  <!-- `--admin-bar-h` is the red bar's measured height, and it exists so the section bar below can
       pin directly under it instead of behind it. Only set when the bar is actually there, so a
       host's page is byte-for-byte what it always was. -->
  <div class="wrap" style={adminGuarded ? `--admin-bar-h:${adminBarH}px` : ''}>
    {#if adminGuarded}
      <!-- The whole point of this bar.
           The console is not where the mistake happens — it has its own layout and nobody is ever
           confused about being in it. THIS screen is the danger: it is pixel-for-pixel the page a
           host sees of their own event, and several of its switches save the instant they move. So
           the bar is sticky, because a warning that scrolls away is a warning you stop seeing about
           four seconds after you arrive. -->
      <AdminBanner sticky bind:height={adminBarH}>
        <span>🎩 SITE ADMIN</span>
        {#if ownership === 'theirs'}
          <span class="ab-who">{ownerName ? `${ownerName}’s event` : 'someone else’s event'} — not yours</span>
        {:else}
          <!-- Honest about not knowing yet, rather than accusing the operator of being in a
               customer's event when the ownership check has not come back. The page is held
               read-only either way; see $lib/adminGuard for why that is the safe direction. -->
          <span class="ab-who">checking whose event this is…</span>
        {/if}
        <span class="ab-chip" class:live={!locked}>{locked ? 'READ-ONLY' : 'EDITING'}</span>
        <svelte:fragment slot="actions">
          {#if locked}
            <button class="ab-btn strong" on:click={takeControl}>Take control</button>
          {:else}
            <button class="ab-btn" on:click={releaseControl}>Hand it back</button>
          {/if}
          <!-- A second way to the console, on top of the pill in the nav. Not an oversight: this is
               the bar that just told you where you are, and the useful next move for somebody who
               has realised they are in the wrong event is one press away from the sentence that
               told them so. -->
          <a class="exit" href="/siteadmin">← Console</a>
        </svelte:fragment>
      </AdminBanner>
    {/if}
    <!-- Event header -->
    <div class="ev-head">
      <div>
        <h1>{ev.name}</h1>
        <div class="ev-sub">
          {#if statusBadge}<span class="badge {statusBadge.cls}">{statusBadge.label}</span>{/if}
          <!-- Beside the status, because "Live" on its own is a half-truth while the gallery is
               dark, and this is the one place a host looks to know how their event is doing.
               A link rather than a label: the fix is two sections away and the point of saying it
               here is to reach it. -->
          {#if ev.revealHidden}
            <button class="badge b-hidden" on:click={goToReveal}
                    title="You hid the photos. Guests see an empty gallery until you reveal them again — nothing is deleted.">
              🙈 Photos hidden
            </button>
          {/if}
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

    {#if section === null}
      <!-- One tap per destination, and every tile says what is inside it rather than only naming
           itself: "Controls" alone does not tell a host where the reveal switch lives. -->
      <div class="hub">
        <button class="hub-tile" on:click={() => (section = 'controls')}>
          <span class="hub-i" aria-hidden="true">{SECTION_META.controls.icon}</span>
          <span class="hub-t">Controls</span>
          <span class="hub-d">Reveal photos, lock the event, downloads</span>
        </button>
        <button class="hub-tile" on:click={() => (section = 'share')}>
          <span class="hub-i" aria-hidden="true">{SECTION_META.share.icon}</span>
          <span class="hub-t">Share &amp; invite</span>
          <span class="hub-d">QR code, join link, co-hosts</span>
        </button>
        <button class="hub-tile" on:click={openPoster} disabled={!qrCode || locked}>
          <span class="hub-i" aria-hidden="true">🎩</span>
          <span class="hub-t">Poster</span>
          <span class="hub-d">{ev?.posterConfig ? 'Open your saved design' : 'Design the poster guests scan'}</span>
        </button>
        <button class="hub-tile" on:click={() => (section = 'photos')}>
          <span class="hub-i" aria-hidden="true">{SECTION_META.photos.icon}</span>
          <span class="hub-t">Photos</span>
          <span class="hub-d">Review, favourite, and share what you pick</span>
          {#if sModeration && pendingPhotos.length}
            <span class="hub-badge">{pendingPhotos.length} pending</span>
          {/if}
        </button>
        <button class="hub-tile" on:click={() => (section = 'guests')}>
          <span class="hub-i" aria-hidden="true">{SECTION_META.guests.icon}</span>
          <span class="hub-t">Guests</span>
          <span class="hub-d">Invite by email, see who has joined</span>
        </button>
        <button class="hub-tile" on:click={() => (section = 'settings')}>
          <span class="hub-i" aria-hidden="true">{SECTION_META.settings.icon}</span>
          <span class="hub-t">Event settings</span>
          <span class="hub-d">Name, dates, shots per guest</span>
        </button>
        <button class="hub-tile" on:click={() => (section = 'theme')}>
          <span class="hub-i" aria-hidden="true">{SECTION_META.theme.icon}</span>
          <span class="hub-t">Theme</span>
          <span class="hub-d">Palette and the look guests see</span>
        </button>
        <button class="hub-tile" on:click={() => (section = 'tricks')}>
          <span class="hub-i" aria-hidden="true">{SECTION_META.tricks.icon}</span>
          <span class="hub-t">Trick list</span>
          <span class="hub-d">Optional photo challenges for guests</span>
        </button>
        {#if billing?.billingEnabled}
          <!-- Last, and double width, because it is the one tile that is not part of running the
               event. It used to sit open at the bottom of every visit whether or not the host had
               come to buy anything — a permanent shop front under the controls. Now it is a door
               like the rest, and the host decides when to walk through it. -->
          <button class="hub-tile wide" on:click={() => (section = 'upgrade')}>
            <span class="hub-i" aria-hidden="true">{SECTION_META.upgrade.icon}</span>
            <span class="hub-t">{SECTION_META.upgrade.title}</span>
            <span class="hub-d">More guests, more shots, longer video, keep the photos for longer</span>
          </button>
        {/if}
      </div>

      {#if adminGuarded}
        <!-- LAST on the hub, under the upgrade tile.
             It started at the top, on the reasoning that "did I do this?" is worth answering before
             touching anything. True, and it still meant a site admin opened this page to change one
             setting and was met first by a record of the last time they changed one. The question is
             worth answering when you ask it, not on every visit.
             So it takes the position the upgrade tile already argued for: below the things you came
             to do, because it is not one of them.
             Hub only. Inside a section the sticky section bar owns the top of the screen and this
             would wedge itself between that bar and the panel it names. One press back to reach it.
             `collapsible={false}` because THIS is the disclosure — the component would otherwise add
             a second one inside it and cost two presses to see a list. -->
        <div class="card admin-log-card">
          <button class="part-head" aria-expanded={adminLogOpen} on:click={() => (adminLogOpen = !adminLogOpen)}>
            <span class="chev" class:open={adminLogOpen}>›</span>
            <span class="card-title part-title">Admin changes to this event</span>
            <span class="part-hint">{adminLogOpen ? 'hide' : 'show'}</span>
          </button>
          {#if adminLogOpen}
            <AdminActionLog eventId={ev.id} showEvent={false} collapsible={false} limit={2} />
          {/if}
        </div>
      {/if}
    {:else}
      <!-- STICKY, not fixed. The feedback button a few hundred lines down carries the lesson: a
           fixed control on a phone sits on top of whatever full-width button you have just
           scrolled to, and the thing you reached for is the thing you cannot press. Sticky keeps
           its own row in the flow, so it is always in reach and never covers anything. -->
      <div class="sec-bar">
        <button class="sec-back" on:click={() => (section = null)}>← All settings</button>
        <span class="sec-i" aria-hidden="true">{SECTION_META[section].icon}</span>
        <span class="sec-now">{SECTION_META[section].title}</span>
      </div>
    {/if}

    <!-- Invite -->
    <div class="card" class:sec-hide={section !== 'share'}>
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
            <button class="qr-dl" on:click={downloadQr} title="Save this QR as a PNG" aria-label="Save QR code as an image"><DownloadIcon /></button>
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
      <button class="btn primary sm full" on:click={openPoster} disabled={!qrCode || locked}>
        {ev?.posterConfig ? '🎩 Manage poster' : '🎩 Create poster'}
      </button>
      <!-- "Start again from a design…" used to sit here as a second button. It now lives INSIDE the
           designer, behind a two-step confirm — see PosterModal's on:restyle. Starting again throws
           away the host's design work, and a one-tap control for that has no business sitting on the
           page you land on: it belongs next to the thing it destroys, where you can see what you are
           about to lose. -->
      </div>
      <!-- The gallery-only link and "email the gallery link" used to sit here, under the join QR.
           They are the opposite of an invite: you send them afterwards, to people who only want to
           see the photos. Both now live in Shared links, which is the after-the-event card. -->
    </div>

    <!-- Guest list: the other half of "Share & invite", and the reason it sits directly under it.
         The QR and the join link are for handing the event to people you are standing next to;
         this is for the ones you are not. It is also the only place in the product that can answer
         "did that actually arrive?" — which is the part a host cannot do from their own inbox. -->
    {#if guestData}
      <div class="card" class:sec-hide={section !== 'guests'}>
        <div class="card-title">Guest list</div>
        <GuestList
          data={guestData}
          busy={guestBusy}
          readOnly={locked}
          bind:preview={importPreview}
          bind:importText
          on:add={onGuestAdd}
          on:update={onGuestUpdate}
          on:remove={onGuestRemove}
          on:preview={onGuestPreview}
          on:import={onGuestImport}
          on:send={onGuestSend}
        />
      </div>
    {/if}

    <!-- Controls -->
    <div class="card" class:sec-hide={section !== 'controls'}>
      <div class="card-title">Controls</div>

      <div class="toggle-row" class:flash={revealFlash} bind:this={revealRowEl}>
        <div>
          <div class="t-label">Reveal photos</div>
          <div class="t-sub">{revealSublabel}</div>
        </div>
        <button class="btn primary sm" class:armed={armedAction === 'hide'} on:click|stopPropagation={requestReveal}
                disabled={actionBusy || locked}>{ev.isRevealed ? (armedAction === 'hide' ? 'Sure?' : 'Hide photos') : 'Reveal all now'}</button>
      </div>
      <!-- Said in full, in the one place the host can act on it.
           The sub-label above is one line inside a row and easy to read past; this is the sentence
           that answers the question a hidden host actually has, which is not "are they hidden" but
           "why isn't my reveal setting working, and what do I press". An instant event with this
           override on will never reveal on its own, and nothing previously said so anywhere. -->
      {#if ev.revealHidden}
        <div class="reveal-override" role="status">
          <strong>Event settings overridden.</strong>
          This event's reveal setting ({revealModeLabel}) is not being applied. Photos stay hidden
          from guests until you press <strong>Reveal all now</strong> above. Nothing is deleted, and
          guests keep taking photos as normal.
        </div>
      {/if}
      <div class="divider"></div>

      <div class="toggle-row">
        <div>
          <label class="t-label" for="c-downloads">Allow downloads</label>
          <div class="t-sub">Participants can download photos</div>
        </div>
        <Toggle id="c-downloads" checked={ev.allowDownloads !== false} on:change={onAllowDownloads} disabled={locked} />
      </div>
      <div class="divider"></div>

        <div class="toggle-row">
          <div>
            <label class="t-label" for="c-buy-shots">Guests can buy more shots</label>
            <div class="t-sub">A guest who runs out can top up their own roll for A$3. You're not charged.</div>
          </div>
          <Toggle id="c-buy-shots" checked={guestBuyOn} disabled={locked}
                  on:change={(e) => setGuestFlag('guestMayBuyShots', e)} />
        </div>
        <div class="divider"></div>

        <div class="toggle-row">
          <div>
            <!-- "more" on its own said nothing — more of what? It is shots, and the ask is a
                 signal rather than an automatic grant, so the copy has to say both. -->
            <label class="t-label" for="c-ask-shots">Guests can ask you for more shots</label>
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
          <Toggle id="c-ask-shots" checked={guestAskOn} disabled={locked}
                  on:change={(e) => setGuestFlag('guestMayRequest', e)} />
        </div>
        <div class="divider"></div>

        {#if faceAvailable}
        <div class="toggle-row">
          <div>
            <label class="t-label" for="c-face">Let guests find photos of themselves</label>
            <div class="t-sub">
              A guest can upload a selfie to find the photos they appear in. Only guests who opt in are
              recognised, and their face data is deleted the moment they withdraw. Off unless you turn it on.
            </div>
          </div>
          <Toggle id="c-face" checked={faceOn} disabled={locked} on:change={(e) => setGuestFlag('faceMatchingEnabled', e)} />
        </div>
        <div class="divider"></div>
        {/if}

      <div class="toggle-row">
        <div>
          <div class="t-label">Lock event</div>
          <div class="t-sub">Prevent new photos and joins</div>
        </div>
        <button class="btn ghost sm" class:armed={armedAction === 'lock'} on:click|stopPropagation={requestLock}
                disabled={actionBusy || locked}>{ev.isLocked ? 'Unlock' : (armedAction === 'lock' ? 'Sure?' : 'Lock')}</button>
      </div>
      <div class="divider"></div>

      {#if canOfferReschedule}
        <!-- Offered BEFORE the refund: the event is still usable, so moving it beats cancelling. -->
        <div class="toggle-row">
          <div>
            <div class="t-label">Move to a new date</div>
            <div class="t-sub">
              No guests joined{#if ev.rescheduleUntil}{' '}— move it any time before {new Date(ev.rescheduleUntil).toLocaleDateString()}{/if}
            </div>
          </div>
          {#if !showResched}<button class="btn sm" on:click={() => { showResched = true; }} disabled={locked}>Reschedule</button>{/if}
        </div>
        {#if showResched}
          <div class="refund-box">
            <p class="refund-hint">Everything you paid for carries over.</p>
            <div class="row2">
              <div class="field"><label for="r-date">New start date</label><input id="r-date" type="date" bind:value={rDate} min={reschedMinDate} max={reschedMaxDate} disabled={locked} /></div>
              <div class="field"><label for="r-time">New start time</label><TimeField id="r-time" bind:value={rTime} disabled={locked} /></div>
            </div>
            <div class="refund-actions">
              <button class="btn ghost sm" on:click={() => (showResched = false)} disabled={reschedBusy}>Never mind</button>
              <button class="btn sm" on:click={doReschedule} disabled={reschedBusy || locked}>{reschedBusy ? 'Moving…' : 'Move event'}</button>
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
          {#if !showRefund}<button class="btn ghost sm" on:click={() => (showRefund = true)} disabled={locked}>Request refund</button>{/if}
        </div>
        {#if showRefund}
          <div class="refund-box">
            {#if refundDone}
              <p class="refund-ok">✓ Request sent — we'll be in touch by email shortly.</p>
            {:else}
              <p class="refund-hint">Tell us briefly why (optional). If your event hasn't started yet, you're eligible for a full refund.</p>
              <textarea bind:value={refundReason} rows="3" placeholder="e.g. our plans changed / booked by mistake" disabled={locked}></textarea>
              <div class="refund-actions">
                <button class="btn ghost sm" on:click={() => (showRefund = false)} disabled={refundBusy}>Never mind</button>
                <button class="btn danger sm" on:click={requestRefund} disabled={refundBusy || locked}>{refundBusy ? 'Sending…' : 'Send refund request'}</button>
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
          <button class="btn danger sm" on:click={doDelete} disabled={locked}>Delete</button>
        </div>
      {:else}
        <!-- Free event: nothing to refund — cancelling simply removes it. -->
        <div class="toggle-row">
          <div>
            <div class="t-label">Cancel event</div>
            <div class="t-sub">Permanently remove this event and all its photos</div>
          </div>
          <button class="btn danger sm" on:click={doDelete} disabled={locked}>Cancel event</button>
        </div>
      {/if}
    </div>

    <!-- Event settings -->
    <div class="card" class:sec-hide={section !== 'settings'}>
      <div class="card-title">Event settings</div>
      <!-- The same settings, asked the way they were asked when the event was made.
           This card is correct and dense and explains nothing: it is a list of controls for
           somebody who already knows what each one does. The wizard on /app is the only place the
           product ever says what moderation is FOR, or what the guest email actually contains, and
           until now that explanation was reachable exactly once, before the event existed.
           The sub-line has to be honest about the limit, because the first thing a host will try it
           for is a bigger guest list. -->
      <!-- The code is NOT in the href. It used to be, and that put a long-lived secret into the page
           markup — readable in devtools, in a saved page, by an extension, and over a shoulder on a
           screen-share — for no gain: the wizard resolves it from localStorage, which this browser
           already has (saveAdminCode). Handed over on the click instead, in the fragment, where it
           never touches the server or an access log. -->
      <!-- Locked too: it leaves for the setup wizard, which is a full editor for this same event
           and has no guardrail of its own. A door out of a read-only page into a writable copy of
           it is the same accident with an extra click in front of it. -->
      <button class="btn ghost sm rerun" disabled={locked}
              on:click={() => goto(`/app?edit=${code}#${encodeURIComponent(orgCode)}`)}>
        ↺ Walk me through the setup again
      </button>
      <p class="hint rerun-why">The same questions with their explanations, your answers already
        filled in. Guest numbers and event length change in the Upgrade card, not there.</p>
      <div class="field">
        <label for="s-name">Event name</label>
        <input id="s-name" type="text" maxlength="80" bind:value={sName} disabled={locked} />
      </div>
      <div class="field">
        <label for="s-blurb">Welcome blurb <span class="hint">(shown under the title on the join screen)</span></label>
        <textarea id="s-blurb" maxlength="280" rows="2" bind:value={sBlurb} disabled={locked}></textarea>
      </div>
      <div class="field-row">
        <div class="field"><label for="s-date">Start date</label><input id="s-date" type="date" bind:value={sDate} max={reschedMaxDate} disabled={startFieldsLocked || locked} /></div>
        <!-- The same 15-minute grid the reveal uses. An event ends at start + duration and a reveal
             is checked on that tick, so minutes finer than it were never actually honoured. -->
        <div class="field"><label for="s-time">Start time</label><TimeField id="s-time" bind:value={sTime} disabled={startFieldsLocked || locked} /></div>
      </div>
      {#if startFieldsLocked}
        <p class="hint" style="margin:-4px 0 10px">
          {ev?.canReschedule ? 'Already started — use “Move to a new date”.' : 'Locked — guests have joined.'}
        </p>
      {/if}
      <div class="field">
        <label for="s-tz">Timezone <span class="muted">(type to search)</span></label>
        <input id="s-tz" list="tz-datalist" autocomplete="off" placeholder="e.g. Australia/Brisbane" bind:value={sTimezone} disabled={locked} />
        <datalist id="tz-datalist">
          {#each timezones as z}<option value={z}></option>{/each}
        </datalist>
      </div>
      <div class="field">
        <label for="s-slug">Custom URL <span class="hint">(optional — your event's /e/ link)</span></label>
        <input id="s-slug" type="text" maxlength="50" placeholder="e.g. lisas-birthday (blank = default link)" bind:value={sSlug} on:input={onEventSlugInput} disabled={locked} />
      </div>
      <div class="field">
        <!-- svelte-ignore a11y-label-has-associated-control -->
        <label>Photo shapes{#if !canAllShapes}<HelpTip text="Extra shapes need the frame pack — add it in the Upgrade card. Square (1:1) is always free." />{/if}</label>
        <div class="aspect-options">
          {#each options?.aspectRatios ?? [] as a}
            <label class="aspect-opt" class:locked={a.value !== '1:1' && !canAllShapes}>
              <!-- Not `disabled` for the ENTITLEMENT case: a disabled input swallows the click, so
                   the guest of an unentitled event got no tick AND no reason. It stays clickable and
                   refuses out loud instead. click fires before change, so preventDefault stops both.
                   The site-admin lock IS `disabled`, and deliberately so — that one is not an upsell
                   the host should be able to press through, it is a control that must not move. -->
              <input type="checkbox" checked={sAspects.has(a.value)} disabled={locked}
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
          <select id="s-reveal" bind:value={sReveal} disabled={locked}>
            {#each options?.revealModes ?? [] as m}<option value={m.value}>{m.label}</option>{/each}
          </select>
        </div>
      </div>
      {#if sReveal === 'at_end'}
        <div class="field">
          <label for="s-delay">Reveal delay after the event ends</label>
          <select id="s-delay" bind:value={sDelay} on:change={onSDelayChange} disabled={locked}>
            {#each options?.revealDelays ?? [] as d}<option value={d.value}>{d.label}</option>{/each}
            <option value={REVEAL_CUSTOM}>Pick an exact date &amp; time…</option>
          </select>
        </div>
        {#if sWantsCustomReveal}
          <div class="field-row reveal-custom">
            <div class="field">
              <label for="s-reveal-date">Reveal date</label>
              <input id="s-reveal-date" type="date" bind:value={sRevealDate} disabled={locked} />
            </div>
            <div class="field">
              <label for="s-reveal-time">Reveal time</label>
              <!-- Stepped by the tick so a phone's wheel only offers moments that can be honoured. -->
              <TimeField id="s-reveal-time" bind:value={sRevealTime} snap="up" disabled={locked} />
            </div>
          </div>
          <p class="hint reveal-note">
            {#if sActualRevealAt === null}
              Pick the date and time — it's read in the event's timezone{sTimezone ? ` (${sTimezone})` : ''}.
            {:else if sRevealIssue}
              <span class="bad">{sRevealIssue}</span>
            {:else}
              Photos appear from <b>{revealMomentLabel(sActualRevealAt, sTimezone)}</b>.
              {#if sRevealMoved}
                Reveals are checked every {REVEAL_TICK_MS / 60000} minutes, so yours moves to the next check.
              {/if}
            {/if}
          </p>
        {/if}
      {/if}
      <!-- Offered whatever the reveal mode is. It used to be hidden under 'instant', which is
           backwards: instant reveal is precisely when a gate is most wanted, because without one
           every shot goes straight to the gallery the moment it is taken. Moderation IS the window
           an instant event otherwise has none of. -->
      <div class="toggle-row">
        <div>
          <label class="t-label" for="s-moderation">Moderate photos</label>
          <div class="t-sub">
            Approve each photo before it appears in the gallery{sReveal === 'instant'
              ? ' — with instant reveal this is the only thing standing between a shot and the gallery.'
              : ''}
          </div>
        </div>
        <Toggle id="s-moderation" bind:checked={sModeration} disabled={locked} />
      </div>
      <div class="toggle-row">
        <div>
          <label class="t-label" for="s-no-flash">No flash</label>
          <div class="t-sub">Disable the camera flash for guests (handy in dark venues to avoid harsh shots)</div>
        </div>
        <Toggle id="s-no-flash" bind:checked={sNoFlash} disabled={locked} />
      </div>
      <div class="toggle-row">
        <div>
          <label class="t-label" for="s-hearts">Guest hearts</label>
          <!-- Says what turning it OFF does to what already exists, because that is the question a
               host actually has. Nothing is deleted: the rows stay and the counts come back. -->
          <div class="t-sub">Let guests heart each other's photos, and see how many hearts each one has.
            Turning this off hides them — no hearts are deleted, and they reappear if you turn it back on.</div>
        </div>
        <Toggle id="s-hearts" bind:checked={sHearts} disabled={locked} />
      </div>
      <div class="toggle-row">
        <div>
          <label class="t-label" for="s-comments">Guest comments</label>
          <!-- OFF by default, and the copy says who can remove one, because that is the question a
               host weighs before switching this on: it puts other people's words on their gallery. -->
          <div class="t-sub">Let guests leave a short message on each other's photos. Off by default.
            You can delete any comment; a guest can delete their own.</div>
        </div>
        <Toggle id="s-comments" bind:checked={sComments} disabled={locked} />
      </div>
      <div class="divider gd-div"></div>

      <!-- Getting the photos to the guests. The switches that decide WHAT a send does come first;
           the one button that actually sends is last, under them, where it reads as the consequence
           of the settings above rather than as a control of its own. -->
      <div class="field">
        <label for="s-guest-delivery">How should your guests get the photos?</label>
        <select id="s-guest-delivery" bind:value={sGuestDelivery} on:change={onSGuestDeliveryChange} disabled={locked}>
          {#each GUEST_DELIVERY_OPTIONS as o}<option value={o.value}>{o.label}</option>{/each}
        </select>
        <p class="hint gd-desc">{sGuestDeliveryDesc}</p>
      </div>

      {#if sGuestDelivery === 'scheduled' || sGuestDelivery === 'manual'}
        <!-- Only on the two options that do not already say it — on the other two the words the
             host chose ARE the answer, and asking twice lets the two disagree. -->
        <div class="field">
          <label for="s-guest-scope">Which photos do they get?</label>
          <select id="s-guest-scope" bind:value={sGuestSendScope} disabled={locked}>
            <option value="all">Everything</option>
            <option value="favourites">Just my favourites</option>
          </select>
        </div>
      {/if}

      {#if sGuestDelivery === 'scheduled'}
        <div class="field-row reveal-custom">
          <div class="field">
            <label for="s-guest-send-date">Send date</label>
            <input id="s-guest-send-date" type="date" bind:value={sGuestSendDate} disabled={locked} />
          </div>
          <div class="field">
            <label for="s-guest-send-time">Send time</label>
            <!-- The same 15-minute grid as the reveal — a send is checked on that tick, so finer
                 minutes are precision we could not honour. -->
            <TimeField id="s-guest-send-time" bind:value={sGuestSendTime} snap="up" disabled={locked} />
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
          <label class="t-label" for="s-mail-thanks">Add a thank-you and the release date</label>
          <div class="t-sub">
            Guests who asked for their photos will get them either way — this adds a thank-you and
            tells them when the full gallery opens.{#if !sGuestThanksDated}{' '}No
              release moment is fixed yet, so right now it would be the thank-you on its own.{/if}
          </div>
        </div>
        <Toggle id="s-mail-thanks" bind:checked={sGuestMailThanks} disabled={locked} />
      </div>

      {#if sGuestReminderOffered}
        <div class="toggle-row">
          <div>
            <label class="t-label" for="s-mail-reminder">Remind them the day before</label>
            <div class="t-sub">Goes out 24 hours before the gallery opens — {sGuestReminderLabel}.</div>
          </div>
          <Toggle id="s-mail-reminder" bind:checked={sGuestMailReminder} disabled={locked} />
        </div>
      {:else}
        <!-- Said, not silently missing: a switch that is simply absent reads as a bug to a host who
             has seen it on another event. -->
        <p class="hint gd-off">No day-before reminder — {sGuestReminderWhyNot}</p>
      {/if}

      <div class="toggle-row">
        <div>
          <label class="t-label" for="s-mail-live">Tell them the photos are live</label>
          <div class="t-sub">
            {#if sGuestReleaseLabel}
              Goes out with the link to the gallery the moment the photos are released — {sGuestReleaseLabel}.
            {:else}
              Goes out with the link to the gallery, the moment your photos are released.
            {/if}
          </div>
        </div>
        <Toggle id="s-mail-live" bind:checked={sGuestMailLive} disabled={locked} />
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
        <button class="btn ghost sm full gd-send" on:click={sendGuestsNow} disabled={guestSendBusy || !ev.emailEnabled || locked}>
          {guestSendBusy ? 'Sending…' : guestsAlreadySent ? '📨 Send it again now' : '📨 Send the gallery link to guests now'}
        </button>
        <p class="hint gd-foot">
          {#if !ev.emailEnabled}
            Email isn't switched on for this event, so nothing can be sent from here.
          {:else}
            Sends your saved setting — {savedSendScope === 'favourites' ? 'just your favourites' : 'the whole gallery'}
            — to every guest who asked for their photos.{#if settingsDirty}{' '}Save your settings first if you have just changed that.{/if}
          {/if}
        </p>
        {#if guestSendNote}
          <p class="gd-note" class:bad={!guestSendNote.ok}>{guestSendNote.text}</p>
        {/if}
      </div>

      <button class="btn primary mt" on:click={saveSettingsForm} disabled={savingSettings || locked}>
        {savingSettings ? 'Saving…' : 'Save settings'}
      </button>
    </div>

    <!-- Theme -->
    <div class="card" class:sec-hide={section !== 'theme'}>
      <div class="card-title">Theme</div>
      <div class="field">
        <div class="label-mono">PALETTE</div>
        <p class="hint" style="margin:0 0 10px">The palette sets the colours <em>and</em> the light/dark look — there is no separate appearance switch.</p>
        <!-- One loop, two columns: the swatch is written once, and the grouping is data. -->
        <div class="preset-cols">
          {#each PRESET_COLUMNS as col}
            <div class="preset-col">
              <div class="preset-col-h">{col.label}</div>
              <div class="presets">
                {#each col.keys as key}
                  <button class="preset" class:selected={selectedPreset === key} disabled={locked} title={THEME_PRESET_LABELS[key] ?? key} on:click={() => applyPreset(key)}
                    style="background:{THEME_PRESETS[key].bg};border-color:{selectedPreset === key ? 'var(--accent)' : THEME_PRESETS[key].accent}">
                    <span style="color:{THEME_PRESETS[key].text}">{THEME_PRESET_LABELS[key] ?? key}</span>
                    {#if selectedPreset === key}<span class="preset-check">✓</span>{/if}
                  </button>
                {/each}
              </div>
            </div>
          {/each}
        </div>
        <!-- Its own group rather than trailing the light column: a custom palette is neither, and
             tacking it onto one of them says it is. -->
        <div class="preset-col custom-col">
          <div class="preset-col-h">Your own</div>
          <div class="presets">
          <!-- Permanent, and a way IN rather than a read-out.
               It used to be rendered only while the palette matched none of the presets, so the one
               entry that could have invited a host to their own colours instead appeared unbidden,
               said "custom", and vanished again the moment they picked a named palette. And since
               every poster design now names a built-in palette, that state had stopped arising at
               all: the chip had become a thing nobody could see and nobody could reach.
               Two states. IDLE — no custom colours — is an invitation: dashed edge, muted label, a
               + where the tick goes. IN USE paints the event's actual colours like every other
               swatch in the row and carries the same tick, because it IS the selected palette. -->
          <button class="preset custom-chip" class:selected={hasCustomPalette} class:idle={!hasCustomPalette} disabled={locked}
            title={hasCustomPalette ? 'Your own colours — open to edit them' : 'Build a palette from a colour of your own'}
            on:click={() => (paletteOpen = true)}
            style={hasCustomPalette ? `background:${theme.bg};border-color:${theme.accent || 'var(--accent)'}` : ''}>
            <span style={hasCustomPalette ? `color:${theme.text || 'var(--text)'}` : ''}>custom</span>
            <span class="preset-check" class:add={!hasCustomPalette}>{hasCustomPalette ? '✓' : '+'}</span>
          </button>
          </div>
        </div>
      </div>

      <div class="field">
        <label for="t-header">Event image <span class="hint">(behind the join screen, and your poster if you want it)</span></label>
        <div class="row gap center">
          <!-- svelte-ignore a11y-no-static-element-interactions -->
          <!-- The file input carries `disabled`, and the LABEL follows it: a click on a <label>
               whose control is disabled activates nothing, so the picker cannot open. The class is
               only there to say so on screen — the refusal is the disabled input, not the styling.
               A drop is a separate path and is stopped in onHeaderDrop. -->
          <label class="upload-btn grow" class:drag={headerDragOver} class:ctl-locked={locked}
            on:dragover|preventDefault={() => (headerDragOver = true)}
            on:dragleave={() => (headerDragOver = false)}
            on:drop={onHeaderDrop}>
            {headerDragOver ? '⤓ Drop image to upload' : headerPreview ? '🖼️ Change image…' : '🖼️ Upload or drag an image…'}
            <input id="t-header" type="file" accept="image/*" on:change={onHeaderFile} disabled={locked} hidden />
          </label>
          {#if canReposition}<button class="btn ghost sm" on:click={repositionImage} disabled={locked}>Reposition…</button>{/if}
          {#if headerPreview}<button class="btn ghost sm" on:click={clearHeaderImage} disabled={locked}>Clear</button>{/if}
        </div>
        {#if headerPreview}
          <img class="header-thumb" src={headerPreview} alt="Event preview" />
        {/if}
      </div>

      <p class="hint" style="margin:4px 0 0">{savingTheme ? 'Saving…' : 'Changes apply and save automatically.'}</p>
    </div>

    <div class="card" class:sec-hide={section !== 'tricks'}>
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
      <button class="btn primary" on:click={() => (missionsOpen = true)} disabled={locked}>
        {ev.challengeSets?.length ? 'Edit the trick list' : 'Set up a trick list'}
      </button>
    </div>


    <!-- Review & curate (dedicated view) — only once there's something to review -->
    {#if allPhotos.length || pendingPhotos.length}
      <!-- The whole card used to be the <a>, which left nowhere to put a disclosure: a <details>
           inside a link is invalid, and tapping its summary would navigate instead of opening. The
           link is now the top row, so the "why" can sit under it without swallowing the tap. -->
      <div class="card review-card" class:sec-hide={section !== 'photos'}>
        <!-- Same reasoning as the setup button above: no secret in the markup. The review screen's
             own resolveOrgCode reads localStorage, so this navigates plainly. -->
        <a class="review-link" href="/admin/{code}/review">
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
            <!-- WHY you would curate, which is this section's job. What happens to the links
                 afterwards is said on the Shared links card directly below, where the links and
                 their Delete buttons actually are. -->
            <p class="hint">
              Favourite the ones worth keeping, then create a <strong>share link</strong> for just those
              — favourites only, or a hand-picked set. Make as many as you like: one for the family,
              one for work, one for the group chat.
            </p>

          </div>
        </details>
      </div>
    {:else}
      <!-- The Photos section used to render NOTHING at all before the first photo — the card above
           is gated on there being something to review, and nothing stood in for it. So a host who
           had just bought an event and pressed Photos got an empty panel that neither explained
           itself nor said what to do next, which is the same fault the review screen had.
           Same rule, same words: reviewEmptyState() is shared with /review so the two surfaces
           cannot drift into saying different things about the same event. Only the ACTION differs,
           because the useful next step is different here — on /review "get your QR" means go back
           to Manage; on Manage it means open Share & invite, which is one press away. -->
      {@const empty = reviewEmptyState(ev && {
        isExpired: ev.isExpired,
        isUpcoming: ev.isUpcoming,
        participantCount: ev.participantCount,
        startsAtLabel: new Date(ev.startsAt).toLocaleString([], {
          timeZone: ev.timezone || undefined, dateStyle: 'medium', timeStyle: 'short',
        }),
      })}
      <div class="card ph-empty" class:sec-hide={section !== 'photos'}>
        <div class="phe-i" aria-hidden="true">{empty.icon}</div>
        <h2 class="phe-t">{empty.title}</h2>
        <p class="phe-b">{empty.body}</p>
        {#if empty.action?.kind === 'link'}
          <button class="btn primary" on:click={() => (section = 'share')}>Get your QR and join link →</button>
        {:else if empty.action?.kind === 'refresh'}
          <button class="btn ghost" on:click={refresh}>{empty.action.label}</button>
        {/if}
      </div>
    {/if}

    <!-- Directly under Review & curate — and now in the same SECTION as it, which is what that
         sentence always meant. It sat in Share & invite, so the section menu had split the two
         halves of one job across two tiles and this comment went on describing an adjacency that
         no longer existed.
         The grouping was by the word "share" rather than by the work: Share & invite is about
         getting people IN, before the event — QR, join link, co-hosts. This card is about getting
         photos OUT, after it. Different jobs at different times, and this half belongs beside the
         curation that feeds it. -->
    <!-- Shared links: the standing gallery link, plus every public link you've created (those are
         made from Review & Curate → Share). Everything here is about sharing the RESULT. -->
    <div class="card" class:sec-hide={section !== 'photos'}>
      <div class="card-title">Shared links</div>
      <!-- Not one of the rows below it: those are links the host made and can delete, this one
           simply always exists. Dashed and tagged so it never reads as a created share. -->
      <div class="standing">
        <!-- `canEmail` carries the lock. Emailing a link is a write as far as a customer's guests
             are concerned: it puts a message in their inbox and it cannot be taken back. Withdrawing
             the control is exactly how this row already handles "email is off on this event", so
             there is nothing new to teach it. -->
        <ShareLinkRow
          url={galleryUrl}
          title="🖼️ Gallery-only link"
          subtitle={`Send it after the event to people who just want to see the photos${
            galleryHearts || galleryComments ? ' — they can react without joining' : ''}`}
          shareId={null}
          canEmail={!!ev.emailEnabled && !locked}
          {sends}
          busy={sendingFrom === null}
          on:copy={(e) => copy(e.detail.url, 'Gallery link copied!')}
          on:send={(e) => sendLink(e.detail.emails, e.detail.shareId)}
        >
          <span slot="tag" class="cohost-tag standing-tag">Always on</span>
          <!-- Its OWN pair, editable here like every other link's. The event's guest switches govern
               the people who scanned the QR; these govern whoever is holding this link, which is a
               different audience and deserves a different answer. -->
          <svelte:fragment slot="pills">
            <span class="rx-pills">
              <span class="rx" class:on={galleryHearts}>♥ Hearts {galleryHearts ? 'on' : 'off'}</span>
              <span class="rx" class:on={galleryComments}>💬 Comments {galleryComments ? 'on' : 'off'}</span>
            </span>
          </svelte:fragment>
          <svelte:fragment slot="extra">
            <button class="btn ghost sm" on:click={() => (galleryLinkEdit = true)} disabled={locked}>Edit</button>
          </svelte:fragment>
        </ShareLinkRow>
      </div>
      <div class="divider shares-div"></div>
      <!-- Said HERE, beside the Delete buttons it is about. It used to live on the Review & curate
           card two sections away, where a host could read it and had nothing to act on. -->
      {#if sharesList.length}
        <p class="hint" style="margin:0 0 10px">Each link is separate — delete one and the others
          keep working, including the gallery link above.</p>
      {/if}
      {#if sharesList.length}
        <div class="cohost-list">
          {#each sharesList as s (s.id)}
            <ShareLinkRow
              url={s.url}
              title={s.label}
              subtitle={`${shareKindText(s.kind, s.count)} · /s/${s.slug || s.id}`}
              shareId={s.id}
              canEmail={!!ev.emailEnabled && !locked}
              {sends}
              busy={sendingFrom === s.id}
              on:copy={(e) => copyShare(e.detail.url)}
              on:send={(e) => sendLink(e.detail.emails, e.detail.shareId)}
            >
              <!-- Both states shown, never just the on ones: "no pill" would be indistinguishable
                   from an older link the server did not report on, and the question a host actually
                   has is "can people comment on this one", which needs a No as much as a Yes. -->
              <svelte:fragment slot="pills">
                <span class="rx-pills">
                  <span class="rx" class:on={s.heartsEnabled}>♥ Hearts {s.heartsEnabled ? 'on' : 'off'}</span>
                  <span class="rx" class:on={s.commentsEnabled}>💬 Comments {s.commentsEnabled ? 'on' : 'off'}</span>
                </span>
              </svelte:fragment>
              <svelte:fragment slot="extra">
                <button class="btn ghost sm" on:click={() => (editShare = s)} disabled={locked}>Edit</button>
                <button class="btn ghost sm" on:click={() => dropShare(s)} aria-label="Delete share" disabled={locked}>Delete</button>
              </svelte:fragment>
            </ShareLinkRow>
          {/each}
        </div>
      {:else}
        <p class="hint" style="margin:0">No shared links yet. Create one from <b>Review &amp; Curate → 📤 Share</b> — you can rename it or change its link here any time.</p>
      {/if}
    </div>

    <!-- Co-hosts: invite people to manage this event with you -->
    <div class="card" class:sec-hide={section !== 'share'}>
      <!-- The action lives in the header, where an action on a card belongs, and opens the field
           directly beneath itself — so the thing you revealed appears where you were looking rather
           than below a list you have to scroll past. -->
      <div class="card-head">
        <div class="card-title">Co-hosts</div>
        <button class="btn ghost sm" class:on={cohostOpen} aria-expanded={cohostOpen} disabled={locked}
                on:click={() => (cohostOpen = !cohostOpen)}>✉️ Invite</button>
      </div>
      <p class="hint" style="margin:0 0 12px">Invite people to help manage this event — they get the same access as you. They can add or remove other co-hosts, but the event owner can never be removed.</p>
      {#if cohostOpen}
        <div class="cohost-add">
          <!-- svelte-ignore a11y-autofocus -->
          <input type="email" autofocus placeholder="co-host@email.com" bind:value={cohostEmail} disabled={locked} on:keydown={(e) => e.key === 'Enter' && addCohost()} />
          <button class="btn primary sm" on:click={addCohost} disabled={cohostBusy || !cohostEmail.trim() || locked}>{cohostBusy ? 'Inviting…' : 'Invite'}</button>
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
              <button class="btn ghost sm" on:click={() => dropCohost(c.id)} aria-label="Remove co-host" disabled={locked}>Remove</button>
            </div>
          </div>
        {/each}
        {#if cohostData && !cohostData.cohosts.length}
          <p class="hint" style="margin:0">No co-hosts yet.</p>
        {/if}
      </div>

      <!-- The organiser code, where somebody looking to delegate will actually look.
           It is minted when the event is made, dropped into one URL, and never shown again — so an
           owner who wanted to hand access to a partner or a photographer had nothing to send, and
           the code wall could only tell them to go and find a link they no longer had.
           Behind a disclosure because it is a long-lived secret, not a setting. Owner only: a
           co-host manages by identity and this key would outlive their removal. -->
      {#if ev.organizerCode}
        <div class="divider"></div>
        <button class="part-head" aria-expanded={adminCodeOpen} on:click={() => (adminCodeOpen = !adminCodeOpen)}>
          <span class="chev" class:open={adminCodeOpen}>›</span>
          <span class="card-title part-title">Organiser code</span>
          <span class="part-hint">{adminCodeOpen ? 'hide' : 'show'}</span>
        </button>
        {#if adminCodeOpen}
          <p class="hint" style="margin:0 0 10px">
            Lets someone manage this event <b>without an account</b> — useful for a partner or your
            photographer. A co-host invite is better where you can use one: it is tied to a person
            and you can take it back. This cannot be revoked, and anyone who has it can do anything
            you can, so treat it like a password.
          </p>
          <!-- MASKED, not merely blurred. The placeholder is a run of dots of the same length — the
               real code is NOT in the markup until Reveal is pressed, so it cannot be read out of
               the DOM, lifted by an extension, or caught by a screen-share or a screenshot of an
               opened panel. A CSS blur alone would look private while the value sat in the page in
               plain text. The blur is on top of that, to say "hidden" rather than "loading". -->
          <div class="linkbox">
            <span class="link mono" class:masked={!codeShown}>{codeShown ? (ev?.organizerCode ?? '') : CODE_MASK}</span>
            <button class="eye" on:click={() => (codeShown = !codeShown)}
                    aria-pressed={codeShown}
                    title={codeShown ? 'Hide the code' : 'Reveal the code'}
                    aria-label={codeShown ? 'Hide the organiser code' : 'Reveal the organiser code'}>
              {codeShown ? '🙈' : '👁️'}
            </button>
          </div>
          <div class="actions" style="margin-top:8px">
            <!-- Inert until revealed, so a mis-tap on a panel somebody opened to read the warning
                 cannot put the key on their clipboard. -->
            <button class="btn ghost sm" disabled={!codeShown}
                    on:click={() => copy(ev?.organizerCode ?? '', 'Organiser code copied')}>🔑 Copy code</button>
            <!-- The link is the thing you actually send: it carries the code in the fragment, so it
                 opens the dashboard straight away rather than asking them to paste anything. Built
                 on click, never rendered — an href would put the secret in the markup, which is the
                 whole thing this panel is avoiding. -->
            <button class="btn ghost sm" disabled={!codeShown}
                    on:click={() => copy(`${location.origin}/admin/${code}#${encodeURIComponent(ev?.organizerCode ?? '')}`, 'Manage link copied')}>
              🔗 Copy manage link
            </button>
          </div>
          {#if !codeShown}
            <p class="hint" style="margin:8px 0 0">Press the eye to reveal it.</p>
          {/if}
        {/if}
      {/if}

    </div>

    <!-- Slideshow now lives in Review & Curate (🎬) — linked from the card above. -->

    <!-- Participants -->
    <div class="card" class:sec-hide={section !== 'guests'}>
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
                  {#if p.tricksDone}<span class="p-tricks">🃏 {p.tricksDone} trick{p.tricksDone === 1 ? '' : 's'}</span> · {/if}
                  joined {fmtTime(p.joinedAt)}
                </div>
              </div>
              <!-- Only when there is more than one card: with a single card there is nothing to move
                   a guest TO, and with no trick list there are no cards at all. -->
              {#if cards.length > 1}
                <label class="p-card">
                  <span class="p-card-l">Card</span>
                  <select aria-label="Trick card for {p.name}" disabled={cardBusy === p.id || locked}
                          value={p.challengeSet ?? cards[0].key}
                          on:change={(e) => moveCard(p, e.currentTarget.value)}>
                    {#each cards as c (c.key)}<option value={c.key}>{c.label}</option>{/each}
                  </select>
                </label>
              {/if}
              <button class="btn ghost sm p-del" on:click={() => removeParticipant(p)} title="Remove this participant" disabled={locked}>Remove</button>
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

    <!-- Below every section on purpose. This panel always shows, and it used to sit in the
         middle of the card stack — so choosing a section put its content above the panel,
         below it, or (for Share & invite, whose cards sat on both sides) in two pieces with
         the upsell wedged between them. The thing you asked to see now always comes first. -->
    <!-- Upgrades (top up to a bigger config; only the difference is charged) -->
    <!-- An id, so the read-only pages of the setup walkthrough can point AT the thing rather than
         at the top of a long page and a hunt. Not a plain #upgrade link from there: this page
         reads its organizer code out of the hash (resolveOrgCode), so any other hash on the URL
         would be read as a credential and hand the host the code wall instead. ?upgrade=1 carries
         it and the hash stays the code.
         A marker rather than an id on the panel itself, because the panel renders nothing at all
         when there is nothing left to sell — and an anchor that disappears is an anchor that lands
         the host somewhere else without saying so. -->
    {#if section === 'upgrade' && locked}
      <!-- The upgrade panel is not disabled here, it is WITHDRAWN. Its buttons start a Stripe
           checkout against the customer's event, and `blocked` — the one switch it has — says "save
           your settings first", which would be a lie and the wrong instruction. A panel that cannot
           explain itself correctly is better not drawn. -->
      <div class="card">
        <div class="card-title">{SECTION_META.upgrade.icon} {SECTION_META.upgrade.title}</div>
        <p class="muted small" style="margin:0">Hidden while this event is read-only — upgrading
          starts a payment against the owner's account. Take control in the bar above if you really
          mean to buy something on their behalf.</p>
      </div>
    {:else if section === 'upgrade' && billing && ev}
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
          bind:offersAvailable={upgradeOffers}
        />
      {/key}
      {#if !upgradeOffers}
        <!-- The panel draws nothing when there is nothing left to sell, and a section that renders
             as a blank page reads as broken rather than as good news. -->
        <div class="card">
          <div class="card-title">{SECTION_META.upgrade.icon} {SECTION_META.upgrade.title}</div>
          <p class="muted small" style="margin:0">This event already has the lot — every guest slot,
            shot, second of video and day of keeping we sell. Nothing left to add.</p>
        </div>
      {/if}
    {/if}

    {#if ev.purged}
      <div class="card"><div class="muted small">Photos were removed at the end of this event's retention period. Your event details and stats are kept for your records.</div></div>
    {/if}
  </div>
{/if}

{#if galleryLinkEdit}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="back" on:click|self={() => (galleryLinkEdit = false)} role="dialog" aria-modal="true" aria-label="Gallery link settings">
    <div class="sheet">
      <div class="head"><span>🖼️ Gallery-only link</span>
        <button class="x" on:click={() => (galleryLinkEdit = false)} aria-label="Close">✕</button></div>
      <p class="hint" style="margin:0 0 12px">This link's address never changes and it can't be deleted —
        it is the event's own. What you can set is what the people holding it may do.</p>
      <div class="toggle-row">
        <div>
          <label class="t-label" for="gl-hearts">Hearts</label>
          <div class="t-sub">Anyone with the link can love a photo. They are never asked for a name —
            nothing shows who hearted what.</div>
        </div>
        <Toggle id="gl-hearts" bind:checked={galleryHearts} disabled={locked} />
      </div>
      <div class="toggle-row">
        <div>
          <label class="t-label" for="gl-comments">Comments</label>
          <div class="t-sub">They give a name the first time they write. You can delete any of them
            from <b>Review → Captions &amp; comments</b>.</div>
        </div>
        <Toggle id="gl-comments" bind:checked={galleryComments} disabled={locked} />
      </div>
      <p class="hint" style="margin:12px 0 0">Separate from <b>Guest hearts</b> and <b>Guest comments</b>
        in Event settings — those are for people who joined and are shooting.</p>
      <button class="btn primary" style="margin-top:14px" on:click={applyGalleryLink} disabled={galleryLinkBusy || locked}>
        {galleryLinkBusy ? 'Saving…' : 'Save'}
      </button>
    </div>
  </div>
{/if}

{#if editShare}
  <!-- `readOnly` as well as the disabled Edit button that opens it. Two callers put this dialog on
       screen now, and a guard that lives in whichever caller happens to exist today is a guard that
       is one new call site away from being gone. It is refused inside the dialog, where the write
       is. -->
  <ShareModal {code} {orgCode} share={editShare} readOnly={locked}
    sentCount={sends.filter((x) => x.shareId === editShare?.id && x.ok).length}
    on:changed={loadShares} on:close={() => (editShare = null)} />
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
    themeOriginalUrl={ev.theme?.imageOriginal ?? null}
    orgCode={orgCode}
    initialConfig={posterSeed ?? ev.posterConfig}
    on:restyle={restylePoster}
    on:missions={(e) => editMissionsFromPoster(e)}
    on:close={() => { posterOpen = false; posterSeed = null; void loadEvent(); }}
  />
{/if}

<svelte:window on:keydown={onWindowKey} on:click={disarmAll} />

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
    onClose={() => void closeMissions()}
    onSaved={(sets) => { missionsRetry = null; if (ev) ev.challengeSets = sets; }}
    onSaveFailed={(sets) => { missionsRetry = sets; missionsOpen = true; }}
  />
{/if}


{#if paletteOpen}
  <PaletteModal {theme} eventName={ev?.name ?? sName} on:apply={onPaletteApply} on:close={() => (paletteOpen = false)} />
{/if}

{#if editorOpen}
  <EventImageEditor
    file={editorFile}
    src={editorSrc}
    initialCrop={editorSrc ? imageCrop : ''}
    confirmLabel={editorSrc ? 'Save position' : 'Use image'}
    eventName={ev?.name ?? ''}
    on:confirm={onImageConfirm}
    on:cancel={() => { editorFile = null; editorSrc = ''; }}
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
        <!-- No trailing arrow. It shares a row with "Start managing", both at flex: 1, so each
             gets about half a 420px card — and the arrow was the character that tipped the label
             onto a second line. The arrow was decoration; the words are the instruction. -->
        <button class="btn primary grow" on:click={() => { welcome = null; answerPosterAsk(true); }}>🎩 Make the poster</button>
      </div>
    </div>
  </div>
{/if}

{#if !booting}
  <button class="fb-fab" type="button" on:click={() => (showFeedback = true)}>💬 Feedback</button>
{/if}
{#if showFeedback}<FeedbackModal context={`Manage (${$page.params.code})`} eventCode={$page.params.code} on:close={() => (showFeedback = false)} />{/if}

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

  @media (max-width: 460px) {
    /* "My events" keeps its words: it is the one people actually press. (The site-admin pill
       drops its own label at this width — see SiteAdminLink.) */
    .nav-link { padding: 7px 11px; font-size: 0.8rem; }
    .topnav { gap: 8px; padding: 0 12px; }
  }
  /* Same treatment as the dashboard's header buttons (`.btn.ghost` there): a bordered pill, not
     bare text that only grows a background on hover. These two bars sit one click apart and the
     same control was reading as a link in one and a button in the other. Values match the
     dashboard's .btn exactly (10px 18px / 0.9rem / --radius-sm) rather than approximately.
     Restyled here rather than swapped to `class="btn ghost"` so the ≤460px shrink above — which
     exists because this row once ran past the viewport and dragged the page wider — keeps working. */
  .nav-link { color: var(--text); text-decoration: none; font-weight: 700; font-size: 0.9rem;
    white-space: nowrap; padding: 10px 18px; border-radius: var(--radius-sm);
    border: 1px solid var(--border); background: transparent; }
  .nav-link:hover { border-color: var(--accent); }
  /* Reads as a warning rather than a status: the other badges describe where the event is in its
     life, this one describes something the host did and can undo. Same shape so it sits with them.

     The brand accent, and deliberately NOT the site-admin red. That red means "you are operating an
     event that is not yours" and lives in exactly one component on purpose — a test enforces there
     is only one of it. Borrowing it here would put an operator-mode colour in front of an ordinary
     host, which says something untrue about what they are looking at. */
  .badge.b-hidden { background: var(--accent-fill); color: var(--accent-ink, #111); border: 0;
    cursor: pointer; font: inherit; font-size: inherit; font-weight: inherit; line-height: inherit; }
  .badge.b-hidden:hover { background: var(--accent-dark); color: #fff; }
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,0.85); z-index: 120;
    display: flex; align-items: center; justify-content: center; padding: 16px; }
  .welcome-card { width: 100%; max-width: 420px; max-height: 90dvh; overflow-y: auto; text-align: center; }
  .welcome-emoji { font-size: 2.6rem; line-height: 1; }
  .welcome-title { margin: 10px 0 6px; font-size: 1.25rem; }
  .welcome-sub { color: var(--text-muted); font-size: 0.88rem; margin: 0 0 16px; }
  .welcome-qr { width: 180px; height: 180px; border-radius: 10px; background: #fff; }
  /* The stack below the blurb is QR -> event code -> join link -> two buttons: four separate
     things a host is meant to act on, and every one of them had zero vertical margin, so they ran
     together as a single slab with no telling where one ended and the next began.
     Scoped to .welcome-card rather than fixing .copybox itself, because that class is shared with
     the Share & invite section, which lays its own copies out in a grid with its own spacing. */
  .welcome-card .welcome-qr { margin: 4px 0 18px; }
  .welcome-card .code-label { margin-bottom: 8px; }
  .welcome-card .copybox + .copybox { margin-top: 10px; }
  .welcome-card .row.gap { margin-top: 20px; }
  .welcome-card .grow { flex: 1; }
  .brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 800; text-decoration: none;
    color: var(--text); }

  .state { text-align: center; padding: 60px 16px; color: var(--text-muted); }

  .auth { max-width: 420px; margin: 0 auto; padding: 48px 16px; }
  .auth h2 { font-size: 1.2rem; margin-bottom: 16px; }
  .full { width: 100%; }
  .mono { font-family: var(--font-mono); font-size: 0.8rem; }

  .wrap { max-width: 720px; margin: 0 auto; padding: 12px 16px 80px; display: flex; flex-direction: column; gap: 16px; }

  /* Buttons */
  /* inline-FLEX with a set line-height and a minimum height, so every button in a row comes out the
     same regardless of what it is made of: a <button> takes `line-height: normal` from the UA while
     an <a> inherits the page's, and an emoji raises the line box above a plain letter. Without this
     a single row of actions mixed three heights — Edit at 31px beside "🔗 Copy" at 31.8px beside a
     link at 33px — which reads as carelessness rather than as anything deliberate.
     It has to live HERE as well as in ShareLinkRow: buttons passed into that component's slots are
     the caller's markup, so they carry the admin page's styles, not the row's. */
  .btn { display: inline-flex; align-items: center; justify-content: center; line-height: 1.2;
    font-weight: 700; border-radius: var(--radius-sm); padding: 10px 18px; font-size: 0.9rem;
    border: 1px solid transparent; cursor: pointer; text-decoration: none; font-family: inherit;
    text-align: center; min-height: 40px; }
  .btn.sm { padding: 7px 14px; font-size: 0.82rem; border-radius: var(--radius-sm); min-height: 32px; }
  .primary { background: var(--accent-fill); color: var(--accent-ink, #111); }
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
  /* The Photos section with nothing in it yet. Centred and narrow, like the review screen's — the
     two are the same message on two surfaces and should read as one thing. */
  .ph-empty { text-align: center; padding: 34px 18px; }
  .phe-i { font-size: 2.4rem; line-height: 1; margin-bottom: 10px; }
  .phe-t { margin: 0 0 8px; font-size: 1.02rem; font-weight: 800; }
  .phe-b { margin: 0 auto 18px; max-width: 420px; font-size: 0.86rem; line-height: 1.5; color: var(--text-muted); }

  /* The section menu. display:none rather than {#if} on purpose: GuestList and the participants
     table hold loaded data and their own open/closed state, and unmounting them on every hop back
     to the menu would refetch and forget it. Nothing here is secret — the page is already behind
     the organizer code — so keeping it in the DOM costs nothing but a little markup. */
  .sec-hide { display: none; }
  .hub { display: grid; gap: 10px; grid-template-columns: repeat(auto-fill, minmax(158px, 1fr)); }
  /* The whole row, whatever the row happens to be. `1 / -1` rather than a fixed `span 4`: the hub
     is auto-fill, so its column count changes with the window, and a fixed span that is wider than
     the grid gets clamped (fine) while one that is narrower leaves a hole beside the last tile
     (not fine). Full-row is four columns where there are four, and one on a phone, with no media
     query and nothing to keep in sync. */
  .hub-tile.wide { grid-column: 1 / -1; }
  .hub-tile {
    position: relative; display: flex; flex-direction: column; gap: 4px; align-items: flex-start;
    text-align: left; min-height: 104px; padding: 14px; font: inherit; cursor: pointer;
    color: var(--text); text-decoration: none;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
  }
  .hub-tile:hover:not(:disabled) { border-color: var(--accent); }
  .hub-tile:disabled { opacity: .55; cursor: default; }
  .hub-i { font-size: 1.45rem; line-height: 1; }
  .hub-t { font-weight: 700; font-size: 0.95rem; }
  .hub-d { color: var(--text-muted); font-size: 0.76rem; line-height: 1.35; }
  /* Sits at the bottom of the tile rather than beside the title, so a tile with a badge is the same
     shape as one without and the grid does not step out of line. */
  .hub-badge { margin-top: auto; align-self: flex-start; padding: 2px 8px; border-radius: 999px;
    font-size: 0.68rem; font-weight: 700; background: var(--accent-fill); color: var(--accent-ink, #111); }
  /* Full-bleed within .wrap (which pads 16px each side), so the bar reads as a bar rather than a
     floating strip with the page showing through beside it. */
  /* `--admin-bar-h` is 0px for everybody except a site admin inside somebody else's event, where it
     is the red bar's MEASURED height (AdminBanner binds it out; it wraps to two rows on a phone and
     at long customer names, so a constant would be wrong at exactly the widths that matter). The
     two bars then pin flush against each other and no page content shows between them. */
  .sec-bar { position: sticky; top: calc(var(--nav-h, 62px) + var(--admin-bar-h, 0px)); z-index: 20; display: flex; align-items: center; gap: 10px;
    margin: 0 -16px; padding: 10px 16px;
    background: var(--bg); border-bottom: 1px solid var(--border); }
  .sec-back { display: inline-flex; align-items: center; gap: 6px; flex: none;
    padding: 9px 15px; min-height: 40px; border-radius: 999px; cursor: pointer;
    background: var(--surface); border: 1px solid var(--border); color: var(--text);
    font: inherit; font-size: .85rem; font-weight: 600; }
  .sec-back:hover { border-color: var(--accent); }
  /* flex:none so the title, not the icon, is what gets ellipsised on a narrow phone. */
  .sec-i { flex: none; font-size: 1.05rem; line-height: 1; }
  .sec-now { font-weight: 700; font-size: .98rem; min-width: 0; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap; }
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
  /* Reaction state on a share link. Off is the quiet default and on is the one that carries the
     accent, because on is the state with a consequence. */
  /* ── Things you PRESS, not things you read ────────────────────────────────────
     A tap on any of these used to take a text selection with it on a phone, which pops the OS
     lookup/copy bubble over the page — the masked organiser code was the worst of them, because
     pressing the reveal selected the mask and offered to look up a row of bullets. `user-select`
     alone is not enough on iOS: the callout is a separate switch, and the tap highlight is a
     third. The copy box has its own copy button, and a pill is a label, so nothing here loses a
     selection anyone wanted. The code itself stays selectable once REVEALED (see .link.masked),
     which is the one place a host may genuinely want to drag over the text. */
  .copybox, .rx, .eye, .link.masked {
    -webkit-touch-callout: none;
    -webkit-user-select: none;
    user-select: none;
    -webkit-tap-highlight-color: transparent;
  }
  .rx-pills { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
  .rx { font-size: 0.66rem; font-weight: 700; line-height: 1; padding: 4px 8px; border-radius: 999px;
    border: 1px solid var(--border); color: var(--text-muted); background: transparent;
    white-space: nowrap; }
  .rx.on { border-color: var(--accent); color: var(--accent); }
  /* Says where these two came from, because unlike every row below it this one cannot be edited
     here — and a pill you cannot change is a puzzle without the sentence. */
  /* The gallery-link dialog. Written here rather than reached for: Svelte scopes styles to their
     own component, and ShareModal's identical-looking `.back`/`.sheet` have never applied outside
     it — see the note in app.css about exactly this trap. */
  .back { position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 80;
    display: flex; align-items: center; justify-content: center; padding: 16px; }
  .sheet { width: 100%; max-width: 460px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 16px; padding: 20px; }
  .sheet .head { display: flex; align-items: center; justify-content: space-between;
    font-weight: 800; margin-bottom: 12px; }
  .sheet .x { background: none; border: 0; color: var(--text-muted); font-size: 1rem; cursor: pointer;
    padding: 4px 6px; line-height: 1; }
  .sheet .x:hover { color: var(--text); }
  .sheet .btn.primary { width: 100%; }
  .hint { font-size: 0.78rem; color: var(--text-muted); }
  /* Outline and a tint rather than a colour change on the row itself: the row contains a primary
     button whose own colour carries meaning, and washing the whole thing in accent would fight it.
     Padded and pulled back by the same amount so marking the row does not move it — a highlight
     that shifts the layout under a thumb already reaching for the button is its own small bug. */
  .toggle-row.flash {
    outline: 2px solid var(--accent); outline-offset: 4px; border-radius: var(--radius-sm, 8px);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    animation: revealflash 2.8s ease-out both;
  }
  @keyframes revealflash { 0%, 62% { opacity: 1; } 100% { opacity: 1; outline-color: transparent;
    background: transparent; } }
  /* The mark still lands, it simply does not fade — a reader who asked for less movement still needs
     to know which line was meant. */
  @media (prefers-reduced-motion: reduce) { .toggle-row.flash { animation: none; } }
  /* The armed state has to LOOK different, not just say something different — a host who is mid-tap
     is reading the shape of the button, not its label. */
  .btn.armed { background: var(--danger); color: #fff; }
  /* Louder than a .hint and quieter than an error: nothing is broken and nothing is lost, but the
     host has switched off a setting they probably think is still running. The accent rail is the
     same device the refund snapshot uses in the support email, for the same reason — it marks a
     block as "read this one". */
  .reveal-override { margin: 10px 0 0; padding: 10px 12px; border-radius: 0 8px 8px 0;
    border-left: 3px solid var(--accent); background: var(--surface-2);
    font-size: 0.82rem; line-height: 1.5; color: var(--text); }
  /* Had no rule at all, so it inherited full-strength --text and shouted next to every other piece
     of supporting copy on the page. It is an aside under the primary action, and should read like
     one — same size and weight as .hint, with the link carrying the emphasis instead. */
  /* Written here, not borrowed: ShareModal has a `.linkbox` that looks like this, and Svelte scopes
     it to that component — so the class alone would have styled nothing at all. */
  .linkbox { display: flex; align-items: center; gap: 6px; padding: 9px 11px;
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .linkbox .link { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: .82rem; color: var(--text); }
  .linkbox .mono { font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); }
  /* The blur is belt and braces — what is under it is a row of dots, not the code. It exists so the
     field reads as deliberately hidden rather than empty or still loading. */
  .link.masked { filter: blur(4px); user-select: none; letter-spacing: .08em; }
  .eye { flex: none; background: none; border: 0; cursor: pointer; font-size: .95rem; line-height: 1;
    padding: 4px 6px; opacity: .75; }
  .eye:hover { opacity: 1; }
  .auth-lead { font-size: .88rem; line-height: 1.5; color: var(--text); margin: 0 0 14px; }
  .auth-alt { margin: 14px 0 0; font-size: 0.78rem; line-height: 1.5; color: var(--text-muted); text-align: center; }
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
  .cohost-tag { font-size: 0.7rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 5px; background: var(--accent-fill); color: var(--accent-ink, #111); }
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
  /* Shaped like the Hearts/Comments pills beside it, because that is what it is — a third mark
     describing the same link. It was inheriting the co-host tag's metrics: a different size,
     weight, radius and letter-case, so three pills in a row read as three unrelated things. The
     border stays DASHED, which is the one difference that carries meaning: this one is a statement
     about the link rather than a setting you can change. The co-host list keeps the tag as it was. */
  .cohost-tag.standing-tag {
    background: transparent; color: var(--text-muted); border: 1px dashed var(--border);
    font-size: 0.66rem; font-weight: 700; line-height: 1; padding: 4px 8px;
    border-radius: 999px; text-transform: none; letter-spacing: 0; white-space: nowrap;
  }
  .shares-div { margin: 14px 0 12px; }
  .mt { margin-top: 12px; }
  .mb { margin-bottom: 12px; }
  .row { display: flex; }
  .row.gap { gap: 8px; }
  .row.center { align-items: center; }
  .label-mono { font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono); margin-bottom: 8px; }

  /* Event header */
  .ev-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .ev-head h1 { unicode-bidi: plaintext; font-size: 1.4rem; font-weight: 800; }
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
  /* The one save control that stays a dark plate ON the thing it saves, because the thing it
     saves is a white QR code and there is nowhere else on it to stand. Everywhere a photo is
     offered the plate has moved off the picture and into the card (see PhotoCard.svelte); the
     ARROW is the same drawn icon at the same size in both places, which is the part a host
     recognises. 44px, the product's touch-target floor. */
  /* The PAINTED square is 32px; the TOUCHABLE one is still 44px.
     It used to be 44px painted, which put a large dark plate over the corner of the QR the host is
     trying to look at. Shrinking the button itself would have taken the tap target under this
     product's 44px floor — the note above is explicit about that — so the box and the target are
     now separate things: a 32px visual square, with `::after` reaching 6px past every edge to make
     the hit area 44px again. The arrow inside is unchanged, which is the part a host recognises. */
  .qr-dl {
    position: absolute; right: 12px; bottom: 12px;
    width: 32px; height: 32px; border-radius: 8px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    line-height: 1;
    background: rgba(0,0,0,0.78); color: #fff; border: 1px solid rgba(255,255,255,0.35);
  }
  /* Invisible, and deliberately not a padding change: padding would grow the painted background
     back to where it started. pointer-events stay on the button, so the reach is a hit area only. */
  .qr-dl::after { content: ''; position: absolute; inset: -6px; border-radius: 12px; }
  .qr-dl:hover { background: #000; }
  .qr-dl:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }


  /* Toggle rows */
  .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 8px 0; }
  /* A row that explains itself needs more air than one that does not. Guest hearts and Guest
     comments sit next to each other and each carries two lines of description, so at 6px the
     second row's title landed almost against the first row's last line and the pair read as one
     block of text with two switches in it. Keyed off the description actually being there rather
     than a hand-applied class, so any row that grows one gets the same treatment. */
  .toggle-row:has(.t-sub) { padding: 13px 0; }
  .toggle-row:has(.t-sub) + .toggle-row:has(.t-sub) { border-top: 1px solid var(--border); }
  /* Block, because half of these rows now label a Toggle and a <label> is inline by default —
     which would sit the title on the same line as the sub-text under it. */
  .t-label { display: block; font-weight: 700; font-size: 0.9rem; }
  label.t-label { cursor: pointer; }
  .t-sub { font-size: 0.75rem; color: var(--text-muted); margin-top: 2px; }
  .divider { height: 1px; background: var(--border); margin: 4px 0; }

  /* Fields */
  .field { margin-bottom: 12px; }
  /* 700 and full text colour, matching the wizard — at 600 and inherited colour these still read
     as the same voice as the hint underneath. */
  .field > label { display: block; font-size: 0.8rem; font-weight: 700; color: var(--text); margin-bottom: 6px; }
  .field-row { display: flex; gap: 12px; }
  .field-row .field { flex: 1; }
  input[type='text'], input[type='date'], input[type='email'], input[list],
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
  .pro-tag { font-size: 0.6rem; background: var(--accent-fill); color: var(--accent-ink, #111); padding: 1px 5px; border-radius: 4px; font-weight: 700; }
  .aspect-opt.locked { opacity: 0.5; cursor: not-allowed; }
  .aspect-opt.locked input { cursor: not-allowed; }
  .aspect-opt.locked { position: relative; }

  /* Theme presets. Two columns that collapse to one on a phone — 240px is four swatches plus
     their gaps, so neither column ever ends on a single orphan. */
  .preset-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 16px; }
  .preset-col-h { margin: 0 0 7px; font-size: 0.66rem; font-weight: 800; letter-spacing: 0.07em;
    text-transform: uppercase; color: var(--text-muted); }
  .custom-col { margin-top: 14px; }
  .presets { display: flex; flex-wrap: wrap; gap: 8px; }
  .preset { position: relative; width: 64px; height: 48px; border-radius: var(--radius-sm); border: 2px solid; cursor: pointer;
    display: flex; align-items: center; justify-content: center; transition: transform .1s, box-shadow .1s; }
  .preset span { font-size: 0.72rem; font-weight: 700; text-transform: capitalize; }
  .custom-chip { background: var(--surface-2); border-color: var(--border); color: var(--text); position: relative; }
  .custom-chip.idle { border-style: dashed; color: var(--text-muted); }
  .custom-chip.idle:hover { border-color: var(--accent); color: var(--text); }
  /* The badge in its invitation state. --surface-2 behind it, not --accent-fill: a filled gold
     badge is the tick's job, and a + wearing it would read as already chosen. */
  .preset-check.add { background: var(--surface-2); color: var(--text-muted);
    border: 1px solid var(--border); font-size: 0.72rem; }
  .preset.selected { transform: scale(1.06); box-shadow: 0 0 0 2px var(--surface), 0 0 0 4px var(--accent); }
  .preset-check { position: absolute; top: -7px; right: -7px; width: 18px; height: 18px; border-radius: 50%;
    background: var(--accent-fill); color: var(--accent-ink, #111); font-size: 0.62rem; font-weight: 800;
    display: flex; align-items: center; justify-content: center; }
  /* styled file-upload button (replaces the default browser control) */
  .upload-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; cursor: pointer;
    padding: 10px 14px; border: 1px dashed var(--border); border-radius: var(--radius-sm);
    background: var(--surface-2); color: var(--text); font-size: 0.85rem; font-weight: 600; text-align: center; }
  .upload-btn:hover { border-color: var(--accent); }
  .upload-btn.drag { border-color: var(--accent); border-style: solid; background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  /* The REFUSAL is `disabled` on the file input this label wraps — a label whose control is disabled
     activates nothing, so the picker never opens. This only says so, matching the greying the
     disabled input/select/textarea rule above gives every other locked control on the page. */
  .upload-btn.ctl-locked { opacity: .55; cursor: not-allowed; border-color: var(--border); }
  .upload-btn.ctl-locked:hover { border-color: var(--border); }
  /* The admin log sits above every section rather than inside one, so it gets the plain card and
     the page's own disclosure header — nothing of its own to keep in step. */
  .admin-log-card { padding-bottom: 14px; }
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
  .avatar { width: 38px; height: 38px; border-radius: 50%; background: var(--accent-fill); color: var(--accent-ink, #111);
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

  /* The way back into the guided setup. Full width so it reads as a second route through this
     whole card rather than as a control belonging to the field beneath it. */
  .rerun { display: block; width: 100%; text-align: center; margin-bottom: 6px; }
  .rerun-why { margin: 0 0 16px; line-height: 1.45; }
  /* A scroll target with no box. .wrap is a flex column with a 16px gap, so an empty child would
     otherwise open a 32px hole between two cards; the negative margin gives that gap back. */
</style>
