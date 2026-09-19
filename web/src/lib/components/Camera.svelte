<script lang="ts">
  import Toggle from '$lib/components/Toggle.svelte';
  import { onMount, onDestroy, tick } from 'svelte';
  import { lensName, lensFacing } from '$lib/lensName';
  import { tileAspect } from '$lib/ui';
  import { aspectValue, cropRect, shapeDelivered } from '$lib/frameShape';
  import { demoLinks } from '$lib/demo';
  import { inAppBrowserName } from '$lib/inAppBrowser';
  import { setParticipantEmail, setPhotoOptIn } from '$lib/events';
  import { planOptIn, optInMessage } from '$lib/photoOptIn';
  import { saveMany, isIOS, savePhotoByUrl, type SaveManyProgress } from '$lib/saveImage';
  import { savedSet, markSaved } from '$lib/saved';
  import StarIcon from '$lib/components/StarIcon.svelte';
  import { watchTilt, glyphRotation, captureOrientation, requestTiltPermission } from '$lib/deviceTilt';
  import { goto, replaceState } from '$app/navigation';
  // Aliased: this component already has a `track` for the MediaStreamTrack.
  import { track as trackEvent } from '$lib/analytics';
  import { fade } from 'svelte/transition';
  import { getEvent, getMe, joinEvent, chooseCard, getPhotosBySession, savePhotoCaption, CAPTION_MAX, clampCaption, captionLength, captionRemaining,
           type PublicEvent, type Photo, setHeart, getHearts,
  } from '$lib/events';
  import { getSession, saveSession, clearSession, rememberEvent, forgetEventAt } from '$lib/session';
  // isIOS is aliased: saveImage exports one too, and the two answer different questions — that one
  // is about download behaviour, this one about whether an install prompt can exist at all.
  import { initInstall, canInstall, promptInstall, isStandalone, isIOS as isIOSInstall,
           askedAlready, markAsked } from '$lib/pwa';
  import { getConfig } from '$lib/api';
  import { applyEventTheme } from '$lib/theme';
  import { showToast, hideToast } from '$lib/toast';
  import { reportClientError } from '$lib/report';
  import { putCapture, delCapture, listCaptures, saveProgress, getProgress } from '$lib/captureStore';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import PhotoCard from '$lib/components/PhotoCard.svelte';
  import DownloadIcon from '$lib/components/DownloadIcon.svelte';
  import StartYourOwn from '$lib/components/StartYourOwn.svelte';
  import ShareScope from '$lib/components/ShareScope.svelte';
  import DownloadFormat from '$lib/components/DownloadFormat.svelte';
  import { zipHref, downloadFilename } from '$lib/download';
  import GuestFeedback from '$lib/components/GuestFeedback.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import Confetti from './Confetti.svelte';
  import FeedbackModal from '$lib/components/FeedbackModal.svelte';

  export let identifier: string; // joinCode or slug

  type Screen = 'loading' | 'join' | 'upcoming' | 'camera' | 'gallery';
  let screen: Screen = 'loading';

  let ev: PublicEvent | null = null;
  let sessionToken: string | null = null;
  // What the server says is left. It only ever counts photos that have actually UPLOADED.
  let serverRemaining = 0;
  // Queued-but-not-yet-uploaded shots are RESERVED. Deriving the display from
  // (server - in flight) is what stops a burst of captures being forgotten the moment anything
  // re-reads /me — which is how a 12-shot roll could be spammed past 12.
  $: pendingUploads = queue.filter((q) => q.status === 'pending' || q.status === 'uploading').length;
  $: photosRemaining = Math.max(0, serverRemaining - pendingUploads);

  // Demo showcase: link into the host + gallery views. Shared with the gallery's own nav through
  // demoLinks(), so the two surfaces cannot drift on where the links point or on how the organizer
  // code is found. The ORDER inside it is the fix that matters here: the event payload first,
  // localStorage only as a fallback for a cached older response. The stash was written by whichever
  // device started the demo, and the ordinary path is starting it on a laptop and scanning the QR
  // with a PHONE — which has never seen that key, and so was offered no host view at all. The host
  // view is half of what the demo is selling.
  $: demoNav = demoLinks(ev?.joinCode, ev?.isDemo ? ev.organizerCode : undefined);
  $: demoHostHref = ev?.isDemo ? demoNav.host : '';
  $: demoGalleryHref = ev ? demoNav.gallery : '';
  let joinName = '';
  let joinEmail = '';
  let joinWantsPhotos = false;
  let joining = false;
  let fatal = '';

  // camera state
  let videoEl: HTMLVideoElement;
  let stream: MediaStream | null = null;
  let facing: 'environment' | 'user' = 'environment';
  let cameras: { id: string; label: string; facing: 'user' | 'environment' | '' }[] = [];   // available video inputs (for the picker)
  // Why the last EXACT lens request failed. A phone lists lenses it cannot always open, and
  // without the reason "it doesn't work" is all anyone — guest or operator — ever learns.
  let lastLensError = '';
  let deviceId: string | null = null;                   // specific chosen camera (multi-camera systems)
  let videoMaxSecs = 0;
  // Set from /me. The guest UI must offer only what the server will actually accept — the host
  // controls buying and asking independently.
  let canBuyShots = false;
  let canAskHost = false;
  // Face matching: host switch + this guest's own enrolment state, both from /me.
  // Face matching itself lives on the shared gallery (/gallery/<code>), not here — searching your
  // own roll for yourself makes no sense. This flag only decides whether to point guests at it.
  let faceMatching = false;
  let askedHost = false;
  let buying = false;
  $: outOfShots = photosRemaining <= 0 && screen === 'camera';
  /** The "ask the host / buy more" card, when it is on screen. Where a press on the spent
   *  shutter sends the guest. */
  let oosPanelEl: HTMLDivElement | undefined;
  // Fires once when the roll is actually spent, which is the closest thing to "the guest finished".
  let rollReported = false;
  $: if (outOfShots && !rollReported && ownCount > 0) { rollReported = true; trackEvent('roll_completed', { shots: ownCount }, ev?.joinCode); }
  let videoHardMaxSecs = 600;   // server's absolute ceiling; the event's own limit is a price tier
  // A guest gets a brief chance to take back a shot they have just fluffed — a thumb over the lens,
  // a blink. Short on purpose: the window is what stops "delete and reshoot" becoming an unlimited
  // roll. Mirrors PHOTO_DELETE_WINDOW_SECONDS on the server; the server is the authority.
  // Read from the server rather than restated here. It was a hardcoded 60_000 under a comment
  // saying "the server is the authority", which is exactly the shape of thing that goes quietly
  // wrong the day an operator sets PHOTO_DELETE_WINDOW_SECONDS: the bin would keep offering itself
  // for a minute on a server that stopped accepting the delete after thirty seconds.
  let undoWindowMs = 30_000;   // matches the server default until /api/config answers
  let nowTick = Date.now();
  let undoTimer: ReturnType<typeof setInterval> | undefined;
  // Eligibility is per PHOTO, from its own takenAt — take three shots quickly and any of the three
  // can be the bad one, so a single "last shot" control would delete the wrong frame.
  // Two-step delete: the first tap arms it, the second commits. Once armed, the control STAYS
  // even if the window lapses mid-decision — the guest decided in time, and yanking the button
  // out from under a half-made choice is worse than a few seconds of grace.
  let confirmingDeleteId: string | null = null;
  const canDelete = (p: Photo, now: number) => !!p.isOwn && now - Number(p.takenAt) < undoWindowMs;
  const secsLeft = (p: Photo, now: number) => Math.ceil((Number(p.takenAt) + undoWindowMs - now) / 1000);
  let videoMode = false;
  let recording = false;
  let recSecs = 0;
  let recTimer: ReturnType<typeof setInterval> | undefined;
  let mediaRecorder: MediaRecorder | null = null;
  let chunks: BlobPart[] = [];

  let settingsOpen = false;
  let showFeedback = false;
  let torchSupported = false;    // hardware torch (back camera, Android Chrome)
  let torchOn = false;           // what the LAMP is doing, read back from the track — not our intent
  let torchRefused = false;      // proven, on this device, not to work at all
  let torchToldOnce = false;
  /* ── What the flash button remembers ──────────────────────────────────────────
     ONE preference per CAPTURE TYPE, and none at all per lens.

     It used to be the other way around, as two separate flags: `flashArmed` drove the hardware
     torch and existed only on the back camera, `screenFlash` drove a white screen fill and existed
     only on the front one. So the setting was keyed on which way the camera pointed — arm the
     flash, flip to the selfie camera, and it was off again; flip back and it had been reset.

     Front and back are the same decision made with different hardware, so they share a flag and
     the MECHANISM is chosen at capture time (torch where there is one, screen fill on the selfie
     camera). Photo and video are genuinely different decisions — a pulse for a still against a
     lamp left on for a whole clip, which is a real drain and a real thing to point at people — so
     those get one flag each. */
  let flashPhoto = false;
  let flashVideo = false;
  /** The armed state of whichever capture type is on screen. Derived — never assign to it; call
   *  setFlash so the value lands in the flag that is actually remembered. */
  $: flashArmed = videoMode ? flashVideo : flashPhoto;
  /* Can the flash actually fire in the combination on screen? A lamp if this camera has one;
     otherwise the screen itself, which lights a selfie STILL but is no use for a selfie CLIP —
     filling the screen for the length of a take would white out the preview they are filming
     against. Kept as a derived value because both the button and the capture path need it. */
  $: flashUsable = !ev?.noFlash && (torchSupported || (facing === 'user' && !videoMode));
  $: flashTitle = flashUsable
    ? 'Flash'
    : videoMode
      ? 'No flash when filming on the selfie camera'
      : 'No flash on this camera';
  let fillActive = false;
  // Every phone camera blinks the screen when the shutter fires, and without it there was almost
  // nothing to say a photo had been taken — the roll counter drops and a thumbnail appears behind a
  // button you are not looking at. A brief blackout is the one piece of feedback people already
  // know how to read. Timed off rather than animation-ended so an interrupted animation cannot
  // leave the viewfinder covered.
  let blinking = false;
  let blinkTimer: ReturnType<typeof setTimeout> | undefined;
  /** Counted, not just flagged.
   *
   *  The blink is a CSS keyframe animation on an element that exists only while `blinking` is true.
   *  Setting `blinking = true` when it is ALREADY true is a no-op as far as Svelte is concerned —
   *  the node is never re-created, so the keyframes never replay, and with `forwards` fill the
   *  element is sitting at opacity 0 by then. Two shots inside the 180ms window therefore produced
   *  one blink, which at any steady shooting rate reads as "it only works every second time".
   *
   *  Bumping a counter that the markup keys on forces a genuinely new element each time, so the
   *  animation restarts from the top however fast the shutter is pressed. */
  let blinkSeq = 0;
  function shutterBlink() {
    clearTimeout(blinkTimer);
    blinkSeq++;
    blinking = true;
    blinkTimer = setTimeout(() => (blinking = false), 180);
  }
  // Remembered per device, like the shape and the video quality. A composition aid you turned on is
  // a way of working, not a per-visit whim — and a guest who finds it gone after a refresh assumes
  // the button did not work rather than that it was deliberately forgotten.
  let gridOn = false;
  let brightness = 1;            // preview/photo brightness (CSS filter), 1 = normal
  let track: MediaStreamTrack | null = null;
  let focusRing: { x: number; y: number } | null = null;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  let cameraError = '';          // a technical failure (no camera, driver, etc)
  // Recorded once per visit: a retry after a denial is the same person, not a second data point.
  let permissionReported = false;
  let cameraDenied = false;      // the guest declined — different screen, different tone
  // Set when the CAMERA is fine but the microphone was refused. Tracked separately because the two
  // are separate permissions and conflating them produced a screen that could not be dismissed.
  let micDenied = false;
  /** The DOMException name behind it, so the note can say WHICH problem this is rather than
   *  guessing. Empty when we never got one. */
  let micReason = '';
  // WHY the mic failed, which decides whether retrying can possibly work.
  //
  // 'blocked' is the case that matters and the one that looks like a broken app: once a browser has
  // remembered a "block" for a site, getUserMedia rejects instantly and never prompts again, so a
  // "Try again" button is pressed, nothing appears, and the app looks broken. It is not — the
  // browser has stopped asking, and only site settings can undo it. Saying so beats a dead button.
  let micState: 'unknown' | 'prompt' | 'blocked' | 'missing' = 'unknown';

  // Lift toasts clear of the camera's own bottom furniture: the shutter sits ~116px up and the
  // photo/video toggle ~138px, so a message at the default 28px lands squarely on both. Set on the
  // document rather than this component because the toast is position:fixed and rendered outside
  // this subtree, so a variable set here would never reach it.
  const TOAST_LIFT = '156px';
  // …and higher still while the camera-check panel is up, which sits at 190px and is tall enough to
  // overlap a message lifted to 156. Measured rather than guessed at: the panel's height changes
  // with what it is saying (asking, testing, or listing three results), so a second constant would
  // be right for one of those three and wrong for the others.
  let benchEl: HTMLElement | undefined;
  let benchH = 0;
  $: if (benchEl && (benchPrompt || benchRunning || benchResult)) benchH = benchEl.offsetHeight;
  $: toastLift = (benchPrompt || benchRunning || benchResult) && benchH
    ? `${190 + benchH + 12}px`
    : TOAST_LIFT;
  $: if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--toast-bottom', screen === 'camera' ? toastLift : '');
  }

  async function diagnoseMic() {
    micState = 'unknown';
    try {
      // A device with no audio input at all is not a permission problem, and telling someone to
      // check their settings when they have no microphone is the wrong advice.
      const devs = await navigator.mediaDevices.enumerateDevices();
      if (devs.length && !devs.some((d) => d.kind === 'audioinput')) { micState = 'missing'; return; }
    } catch { /* enumeration unsupported — fall through to the permission check */ }
    try {
      // Not supported by Safari, which is why 'unknown' stays a valid answer rather than an error.
      const st = await navigator.permissions?.query?.({ name: 'microphone' as PermissionName });
      if (st?.state === 'denied') micState = 'blocked';
      else if (st?.state) micState = 'prompt';
    } catch { /* leave it unknown and offer the retry — it may well prompt */ }
  }
  let cameraStarting = false;    // true while the stream is (re)acquiring — shows a spinner
  let cameraPaused = false;      // user explicitly turned the camera off (manual privacy/battery)
  let focusSupported = false;     // true only if the device exposes tap-to-focus controls

  // aspect
  let allowedAspects: string[] = ['1:1'];
  let aspect = '1:1';
  // Is the CAMERA handing the recorder frames already cropped to `aspect` right now? Set only from
  // what the camera returned (applyRecordShape), never from what it was asked for. It is what
  // re-enables the viewfinder's framing in video, and framing to a crop that is not happening is
  // precisely the bug that took the framing away to begin with.
  let videoShapeLive = false;
  // Whether the lens currently attached will crop at all. Tracks reality rather than latching:
  // a phone's lenses do not all have the same capture pipeline, so a refusal by one is not a
  // verdict on the next. False puts the control away in video — shapes are a photo setting again
  // there, exactly as before, because a control that cannot do what it says is worse than none.
  let videoShapeSupported = true;
  let videoShapeToldOnce = false;   // said once per visit, not once per tap

  // upload queue
  interface QueueItem { id: string; blob: Blob; mediaType: 'photo' | 'video'; source: 'capture' | 'upload'; ext: string; status: 'pending' | 'uploading' | 'done' | 'error'; error?: string; progress?: number; size: number; durationSecs?: number; w?: number; h?: number; retries?: number; uploadId?: string; challengeId?: string; doneChunks?: number[]; captureOrientation?: 'portrait' | 'landscape'; captureShape?: string; }
  const MAX_UPLOAD_RETRIES = 5;   // auto-retry a failing upload this many times (with backoff) before asking the user
  // ── Photo missions ─────────────────────────────────────────────────────────
  //
  // The host's shot list, and which of them this guest has already captured. Both come from the
  // join / me responses rather than the public event, because a guest is handed ONE card of
  // possibly several and must never be shown somebody else's.
  //
  // `armed` is the mission the next shot counts towards. Nothing is armed by default: a guest who
  // ignores the list entirely still just takes photos, which is the point of a disposable camera.
  let missions: { id: string; text: string }[] = [];
  let missionsDone: string[] = [];
  /** Ticks WE made, before the server had seen the upload.
   *
   *  The list is fetched every time it is opened, and a guest opens it straight after pulling a
   *  trick off — often within the same second, while the photo is still going up. The reply is then
   *  from before the photo landed, and replacing our list with it unticked a trick they had just
   *  watched complete, with the confetti barely finished. It stayed unticked for as long as the
   *  list was open, because nothing re-fetches while it is.
   *
   *  So a server answer may only ADD to what we know, never take away one of these. They are
   *  dropped when the trick stops being offered (a host moving the guest to another card) or when
   *  the upload turns out to be impossible (untickMission). */
  let missionsDoneLocal: string[] = [];

  /** Fold a server answer in without losing a tick it has not caught up on yet. */
  function applyServerDone(done: unknown) {
    const fromServer = Array.isArray(done) ? (done as string[]) : [];
    // Local ticks survive only while their trick is still on the card being held.
    const offered = new Set(missions.map((m) => m.id));
    missionsDoneLocal = missionsDoneLocal.filter((id) => offered.has(id));
    missionsDone = [...new Set([...fromServer, ...missionsDoneLocal])];
  }
  let armed: string | null = null;
  let missionsOpen = false;
  // The host's chosen mark. Falls back to a plain circle rather than guessing from the event type:
  // the guest payload does not carry the type, and a wrong glyph is worse than a neutral one.
  let missionTick = '\u25CB';
  let confetti: { burst: (n?: number) => void } | undefined;

  // ── Which card is this guest actually holding? ─────────────────────────────
  //
  // Several cards exist so a host can hand out different lists. A printed card's QR names its own
  // set and settles it; most cards are printed WITHOUT one, and those guests joined off the main
  // event sign — so the round-robin hands them a card, and the card on the table in front of them
  // may well be a different one.
  //
  // So the server leaves that question open (setPending) and we ask it here, behind the trick-list
  // pill: the moment they want the list is exactly the moment the wrong one matters. Nobody else is
  // asked — not a guest who scanned a card, not a single-card event, and not anyone who joined
  // before any of this existed.
  let cardPending = false;
  let cardChoices: import('$lib/events').CardChoice[] = [];
  let cardsHaveQr = false;
  let cardAsking = false;
  /** The card they have tapped but not yet confirmed. The choice cannot be taken back, so it is
   *  worth one deliberate second — and the warning has to be on screen WHEN they decide, not in a
   *  line of small print above a row of buttons. */
  let cardConfirming: import('$lib/events').CardChoice | null = null;
  let cardSaving = false;

  /** Fold the server's answer about the card in. Called everywhere the missions are. */
  function applyCardStatus(r: import('$lib/events').GuestCardStatus) {
    cardPending = !!r.setPending;
    cardChoices = Array.isArray(r.setChoices) ? r.setChoices : [];
    cardsHaveQr = !!r.cardsHaveQr;
    // Answered — by us, on another device, or by the host moving them. Either way the question is
    // gone and so is anything asking it.
    if (!cardPending) { cardAsking = false; cardConfirming = null; }
  }

  async function pickCard(key: string | null) {
    if (cardSaving || !sessionToken) return;
    cardSaving = true;
    try {
      const r = await chooseCard(sessionToken, key);
      if (Array.isArray(r.challenges)) missions = r.challenges;
      applyServerDone(r.challengesDone);
      applyCardStatus(r);
      cardAsking = false; cardConfirming = null;
      // Straight on to what they came for. The list is the point; the question was in the way.
      missionsOpen = true;
      trackEvent(key ? 'trick_card_chosen' : 'trick_card_none', undefined, ev?.joinCode);
    } catch (e) {
      // 409 means somebody already answered this — two taps on a bad connection is the ordinary
      // way to get here. Their card is settled either way, so take the question away rather than
      // telling them off.
      cardPending = false; cardAsking = false; cardConfirming = null;
      missionsOpen = true;
      void refreshMissions();
      const msg = (e as { message?: string })?.message;
      if (msg && !/already/i.test(msg)) showToast(msg, true);
    } finally { cardSaving = false; }
  }

  /** The trick-list pill. One question stands between some guests and their list. */
  function openTrickList() {
    if (cardPending && cardChoices.length > 1) { cardAsking = true; cardConfirming = null; return; }
    missionsOpen = true;
    void refreshMissions();
    trackEvent('mission_list_opened', undefined, ev?.joinCode);
  }
  $: missionsLeft = missions.filter((m) => !missionsDone.includes(m.id));
  $: armedText = missions.find((m) => m.id === armed)?.text ?? '';
  const isDone = (id: string) => missionsDone.includes(id);
  function armMission(id: string) {
    // Tapping the armed one again disarms it, so there is always a way back to just shooting.
    armed = armed === id ? null : id;
    missionsOpen = false;
  }

  let queue: QueueItem[] = [];
  let uploading = false;
  let capturing = false;          // one capture at a time (guards rapid double-taps)
  const iosDevice = isIOS();      // decided once: the control it hides must not flicker
  // Which app's embedded browser this is, if any. Decided once — the UA does not change.
  const inAppName = inAppBrowserName();
  let myEmail: string | null = null;      // from /me; null when they joined without one
  let emailDraft = '';
  let emailBusy = false;
  let emailNoteDismissed = false;
  // The warning only matters once there is something to LOSE. Before the first shot, switching
  // browsers costs nothing, and a notice about it is noise on a screen they have just arrived at.
  $: switchRisk = !!inAppName && !emailNoteDismissed && (serverRemaining < (ev?.maxPhotos ?? 0) || ownCount > 0);
  async function attachEmail() {
    if (!sessionToken || emailBusy) return;
    const v = emailDraft.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) { showToast("That email doesn't look right", true); return; }
    emailBusy = true;
    try {
      const r = await setParticipantEmail(sessionToken, v);
      myEmail = r.email;
      showToast('Saved — use that address when you reopen and your photos come with you');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save that', true);
    } finally { emailBusy = false; }
  }

  // "Email me the photos when the event ends". Seeded from /me and from the join reply so a guest
  // who reopens the link is never asked again for something they already asked for.
  let wantsPhotos = false;
  let optInAsking = false;        // the inline address field is open
  let optInBusy = false;
  let optInDraft = '';
  let optInHeadline = '';         // what the last answer said; '' until they act this session
  let optInNote = '';
  // Falls back to a line built from the address on file, because wantsPhotos can arrive from /me
  // with no answer of our own to quote — without this the opted-in card renders a bare tick.
  $: optInLine = optInHeadline || optInMessage({ wantsPhotos: true, email: myEmail }).headline;

  async function requestPhotoOptIn() {
    if (!sessionToken || optInBusy) return;
    const plan = planOptIn({ hasEmail: !!myEmail, asking: optInAsking, draft: optInDraft });
    // One tap and no dialog whenever we already know where to send — asking again for an address
    // we are holding is the thing that makes people close the page.
    if (plan.kind === 'ask') { optInAsking = true; return; }
    if (plan.kind === 'badEmail') { showToast("That email doesn't look right", true); return; }
    optInBusy = true;
    try {
      const r = await setPhotoOptIn(sessionToken, true, plan.email);
      wantsPhotos = r.wantsPhotos;
      // Only when it was actually stored. A collision leaves the address on nobody's row, and
      // pretending otherwise would have the switch-browsers note promise a recovery that cannot
      // work — that address reopens the OTHER guest's roll, not this one.
      if (r.email) myEmail = r.email;
      ({ headline: optInHeadline, note: optInNote } = optInMessage(r, plan.email));
      optInAsking = false;
      optInDraft = '';
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save that', true);
    } finally { optInBusy = false; }
  }

  async function undoPhotoOptIn() {
    if (!sessionToken || optInBusy) return;
    optInBusy = true;
    try {
      const r = await setPhotoOptIn(sessionToken, false);
      wantsPhotos = r.wantsPhotos;
      optInHeadline = '';
      optInNote = '';
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not change that', true);
    } finally { optInBusy = false; }
  }
  let saveToDevice = false;       // also save a copy of each capture to the user's device
  let saveNote = false;           // transient "saving copies" hint (auto-hides)
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  function toggleSaveToDevice() {
    saveToDevice = !saveToDevice;
    if (saveToDevice) { saveNote = true; setTimeout(() => (saveNote = false), 1000); }
  }
  let drawerOpen = false;

  // gallery
  let galleryPhotos: Photo[] = [];
  let galleryRevealed = true;
  // Gallery filter — when the host reveals everyone's shots, default to the guest's own ('mine')
  // but let them switch to All / Others. Photos already arrive newest-first from the server.
  // 'me' = photos face matching says this guest appears in; only offered once they have enrolled.
  // This screen is the guest's OWN roll and nothing else. Browsing everyone's photos is what the
  // shared gallery is for, and having both was two half-galleries instead of one of each.
  // othersCount survives because it answers "is there anything over there worth linking to".
  //
  // Both counts now come from the SERVER, and have to: the roll asks for `own=true`, so the array
  // it holds is this guest's shots and nothing else. Deriving "how many of everyone else's are
  // there" by subtraction from an own-only array gives 0 every time — which would have quietly
  // removed the link to the shared gallery for every guest. Same reasoning for ownCount: it is an
  // answer about the event, not about the page's current array (which ?highlightsOnly can shrink).
  let ownCount = 0;
  let othersCount = 0;
  /** Take the counts off a photos response, falling back to counting the rows for an older API. */
  function applyCounts(r: { ownCount?: number; othersCount?: number; photos?: Photo[] }) {
    ownCount = r.ownCount ?? (r.photos ?? []).filter((p) => p.isOwn).length;
    othersCount = r.othersCount ?? 0;
  }
  // Still filtered here, and deliberately: the server sending only this guest's shots is an
  // optimisation, and the rule that this screen is their own roll is not something to leave resting
  // on a query parameter.
  $: shownPhotos = galleryPhotos.filter((p) => p.isOwn);
  let revealMsg = '';
  let lbOpen = false;
  let lbIndex = 0;
  let allowDownloads = true;

  $: pendingCount = queue.filter((q) => q.status !== 'done').length;
  $: hasUploadError = queue.some((q) => q.status === 'error');
  // The Queue button used to linger after everything had uploaded, badge-less and doing nothing —
  // it stayed as long as the queue ARRAY was non-empty, and completed items are never removed from
  // it. Show it only while something is still in flight or has failed and needs a retry.
  $: queueNeedsAttention = queue.some((q) => q.status !== 'done');
  // Compact stats for the queue rows.
  const fmtSize = (b: number) => b <= 0 ? '' : b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / (1024 * 1024)).toFixed(1)} MB`;
  const fmtDur = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
  const qmeta = (it: QueueItem) => {
    const bits: string[] = [];
    if (it.mediaType === 'video' && it.durationSecs) bits.push(fmtDur(it.durationSecs));
    if (it.mediaType === 'photo' && it.w && it.h) bits.push(`${it.w}×${it.h}`);
    if (it.size) bits.push(fmtSize(it.size));
    return bits.join(' · ');
  };

  // Friendly names for the enabled photo shapes, shown as chips on the join screen.
  const ASPECT_LABELS: Record<string, string> = {
    full: 'Full frame', '9:16': 'Portrait', '4:5': 'Tall', '3:4': 'Classic', '1:1': 'Square',
  };
  $: shapeLabels = (allowedAspects || []).map((a) => ASPECT_LABELS[a] || a);
  // Square is the implied default — only call out shapes when there's more than just 1:1.
  $: showShapes = (allowedAspects || []).some((a) => a !== '1:1');
  $: hasEventInfo = showShapes || videoMaxSecs > 0;

  /** Named, so onDestroy can actually remove it. Inline it was unremovable: Camera is destroyed
   *  and recreated on every route move, so listeners accumulated and ALL of them fired on a
   *  bfcache restore, each racing restoreIfSessionExists(). That is precisely the "second
   *  participant, fresh roll, top-up stranded on the old row" failure the comment below says this
   *  listener exists to prevent — the guard was creating the bug it was written to stop. */
  const onPageShow = (e: Event) => {
    if ((e as PageTransitionEvent).persisted) void restoreIfSessionExists();
  };

  onMount(async () => {
    // Before anything else: Chrome fires beforeinstallprompt once, early, and a listener attached
    // after it has fired never hears it — the offer would then be impossible for that visit.
    initInstall();
    installedAlready = isStandalone();
    iosInstall = isIOSInstall();
    try {
      orientMq = window.matchMedia('(orientation: landscape)');
      orientMq.addEventListener('change', () => { readOrientation(); readTilt(); });
      readOrientation();
      stopTilt = watchTilt(readTilt);
    } catch { /* no matchMedia: the notice simply never shows */ }
    try {
      ev = await getEvent(identifier);
      // The way back for the installed app, refreshed every time the event opens — not only on the
      // join that created the session, or a guest who joined last week would never be remembered.
      if (typeof location !== 'undefined') rememberEvent(ev.joinCode, location.pathname);
    } catch {
      // An event that is over and purged must not become a trap: the launcher would keep opening
      // this same dead page, and the app would look permanently broken with no way to type a new
      // code. Drop the pointer so the next launch offers the way in instead.
      if (typeof location !== 'undefined') forgetEventAt(location.pathname);
      fatal = 'Event not found';
      return;
    }
    // Video length is now a per-event entitlement (falls back to the global setting when
    // billing is off — the server resolves which to send).
    videoMaxSecs = ev.videoSeconds ?? 0;
    // The server ceiling, not the event tier — see the upload handler for why they differ.
    try {
      const cfg = await getConfig();
      videoHardMaxSecs = cfg.videoHardMaxSeconds ?? 600;
      if (cfg.photoDeleteWindowSeconds) undoWindowMs = cfg.photoDeleteWindowSeconds * 1000;
    } catch { /* keep the defaults */ }
    // Apply the event's theme straight away so the JOIN screen (button, colours) is themed too —
    // applyEventTheme is contrast-guarded and falls back to the warm default for no-theme events.
    applyEventTheme(ev.theme);
    allowedAspects = ev.aspectRatios?.length ? ev.aspectRatios : ['1:1'];
    // The guest's own choice, if they have one and this event still offers it. It used to reset to
    // the event's first shape on every load, so picking Full and then refreshing — or just coming
    // back to the camera later in the night — silently put them back on 1:1 and they shot the next
    // few square without noticing.
    //
    // Validated against allowedAspects rather than trusted: the shapes on offer are the host's
    // setting, and a preference carried in from another event (or from before this host changed
    // theirs) may no longer be one of them. Anything not on offer falls back to the first.
    aspect = allowedAspects.includes(savedAspect()) ? savedAspect() : allowedAspects[0];
    document.title = `${ev.name} — Snapdini`;

    if (ev.isUpcoming) { screen = 'upcoming'; return; }

    // The event is over and the gallery is open: the camera is dead weight from here, and the
    // gallery is both what the guest came back for and where "find the photos I'm in" lives.
    //
    // Three deliberate limits. Only once REVEALED — before that the in-app gallery is the only
    // place a guest can still see their own shots, and the shared one would just show them a wall.
    // Only when nothing is still waiting to upload, or the redirect would strand captures that
    // survived in IndexedDB. And replaceState, so Back out of the gallery does not land on this
    // page and bounce straight back in. Mid-session expiry is left alone on purpose — nobody
    // should be yanked out of the camera while they are using it.
    if (ev.isExpired && ev.isRevealed) {
      const waiting = await listCaptures(ev.joinCode).catch(() => []);
      if (!waiting.length) { await goto(`/gallery/${ev.joinCode}`, { replaceState: true }); return; }
    }

    const token = getSession(ev.joinCode);
    if (token) {
      try {
        const me = await getMe(token);
        // Returning from Stripe, the guest lands on /join/<code>?topup=1. /me already reflects the
        // purchase because the webhook credited the participant, so there is nothing to poll — confirm
        // it and strip the flag so a refresh does not re-announce it.
        const topupReturn = typeof window !== 'undefined'
          && new URLSearchParams(window.location.search).get('topup') === '1';
        if (topupReturn) {
          // If the address came from the payment, the guest never typed it here — tell them which
          // one their photos are now tied to, since that is what they will need on another device.
          const boundEmail = me.emailFromPayment ? me.participant?.email : null;
          showToast(boundEmail
            ? `Thanks — more shots added. Your photos are linked to ${boundEmail}`
            : 'Thanks — more shots added to your roll');
          // SvelteKit's replaceState, not the raw History API — a raw call desyncs the router
          // and the next Back leaves the URL and the page disagreeing.
          replaceState(window.location.pathname, {});
        }
        sessionToken = token;
        serverRemaining = me.photosRemaining;
        canBuyShots = !!me.canBuyShots;
        canAskHost = !!me.canAskHost;
        faceMatching = !!me.faceMatching;
        feedbackDone = !!me.feedbackGiven;
        wantsPhotos = !!me.wantsPhotos;
        allowDownloads = me.allowDownloads;
        myEmail = me.participant?.email ?? null;
        missions = Array.isArray(me.challenges) ? me.challenges : [];
        applyServerDone(me.challengesDone);
        applyCardStatus(me);
        if (me.challengeTick) missionTick = me.challengeTick;
        await enterCamera();
        return;
      } catch {
        clearSession(ev.joinCode);
      }
    }
    screen = 'join';
    document.addEventListener('visibilitychange', onVisibility);
    // pagehide also fires on navigation away / back-forward-cache, where visibilitychange/onDestroy
    // can be skipped — make sure the camera is always released when the page is left.
    window.addEventListener('pagehide', stopCamera);
    // Back-forward cache: pressing Back restores this page from memory WITHOUT re-running onMount,
    // so a guest who had been on the join screen sees the name form again and can join a SECOND
    // time — a new participant, a fresh roll, and any top-up they bought stranded on the old row.
    // pageshow is the only event that fires in that case.
    window.addEventListener('pageshow', onPageShow);
    // Refresh the camera list if one is plugged in/out mid-session (hot-plug).
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshCameras);
  });

  // When the tab is backgrounded, release the camera entirely so it isn't left running in the
  // background draining the battery (and the "camera in use" indicator clears). Stop any
  // in-progress recording first so the clip is saved. Re-open it when the user returns to the camera.
  // Re-read the trick list from the server.
  //
  // It was fetched once, at join, and never again — so a host who edited the list mid-event left
  // every guest holding the old one. The count went wrong too: progress was returned for tricks no
  // longer on the card, so a guest who had done one of three saw "1/6" after a replacement, where
  // that 1 was none of the 6. The server now scopes progress to the card being held; this is the
  // other half, which is noticing that the card changed at all.
  //
  // Quiet on failure: a guest whose signal dropped should keep the list they have rather than watch
  // it empty itself. The next attempt will pick the change up.
  // Save the whole roll. On iOS this is the only route into Photos that does not mean tapping every
  // photo: several files go into one share, which offers "Save N Images". Chunked, because every
  // file has to be in memory to be shared and a full roll at once is a dead tab.
  $: myShotCount = galleryPhotos.filter((p) => p.isOwn).length;
  // What this device already has, so the roll can say which shots are already yours to keep.
  // Per-browser; see lib/saved.ts for exactly what the tick claims.
  let saved: Set<string> = new Set();
  // Loaded when the event arrives, not on mount: the marks are keyed by join code and `ev` is
  // fetched. Guarded on the code so re-assigning `ev` (a refresh, a poll) does not re-read on
  // every tick.
  // ── Landscape ────────────────────────────────────────────────────────────────
  //
  // The camera UI is built portrait: turn the phone and the controls scatter, the viewfinder
  // letterboxes and the trick list runs off the bottom. What we CANNOT do is stop it — locking the
  // orientation needs screen.orientation.lock(), which browsers only honour in fullscreen or an
  // installed PWA, and a plain tab is neither. (The manifest asks for portrait, which covers the
  // installed case and nothing else.)
  //
  // So: say so, once, and let them carry on. The photos are unaffected — capture reads the video
  // track, not the page layout — and saying that plainly is the point of the notice. A blocking
  // "rotate your device" wall would be a lie about a thing that still works.
  //
  // Guarded on a coarse pointer because a desktop is permanently "landscape" and must never see it.
  let isLandscape = false;
  let landscapeDismissed = false;
  let orientMq: MediaQueryList | null = null;
  // The Samsung-camera trick: when the PHONE turns but the page does not — rotation lock on — the
  // layout stays exactly where it is and only the glyphs spin, so nothing moves under the thumb but
  // everything reads upright. Zero whenever the page has turned by itself, because then it is
  // already upright and rotating would tip it back over. See lib/deviceTilt.ts.
  //
  // Icons only, never text blocks or the viewfinder: a rotated paragraph in a portrait column is
  // unreadable in a different way, and the viewfinder must keep showing the frame as it will be
  // captured.
  let glyphRot = 0;
  let stopTilt: (() => void) | null = null;
  function readTilt() { glyphRot = glyphRotation(); }
  // Both notices are absolutely positioned at the same spot, so exactly one may be up. Landscape
  // wins: it explains what the guest is looking at right now.
  $: landscapeNote = isLandscape && !landscapeDismissed;
  // Where the banner ENDS, published to CSS so the control rail can sit below it rather than under
  // it. Measured rather than assumed: the text wraps to one line or two depending on the width, and
  // a guessed offset is wrong on half of phones.
  //
  // The bottom edge, not the height — offsetTop included. Publishing height alone silently lost the
  // banner's own top offset (8px, or more on a phone with a display cutout, since it clears the
  // safe area). Measured clearance was 4px instead of the 12 the rule asks for, and on a notched
  // phone that offset grows while the rail's top does not — which closes the gap and puts the
  // banner back on top of the icons. That is the bug we just fixed, latent again.
  // The brightness pill sits directly under the icon row, with the same gap above it that the row
  // itself has — so it is anchored to the topbar's BOTTOM EDGE rather than a hard-coded offset.
  // .topbar is `padding: 16px 20px`, so its height already is icons + one padding above + one
  // below; landing the pill's top edge on it spends that lower padding as the gap. Measured because
  // the row's height is not ours to predict: the counter, the mission chip and the demo nav all
  // change it, and a guessed 70px was both wrong and silently wrong.
  let topbarEl: HTMLElement | undefined;
  let topbarH = 0;
  let topbarRO: ResizeObserver | null = null;
  function measureTopbar() { if (topbarEl) topbarH = topbarEl.offsetHeight; }
  $: if (topbarEl && !topbarRO && typeof ResizeObserver !== 'undefined') {
    topbarRO = new ResizeObserver(measureTopbar);
    topbarRO.observe(topbarEl);
  }

  let noteEl: HTMLElement | undefined;
  let noteBottom = 0;
  let noteRO: ResizeObserver | null = null;

  const measureNote = () => {
    if (noteEl) noteBottom = noteEl.offsetTop + noteEl.offsetHeight;
  };

  // Watched rather than measured once. A reactive statement only re-runs when the values it
  // MENTIONS change, so `$: noteBottom = noteEl.offsetTop + noteEl.offsetHeight` re-measures when
  // the banner appears and never again — and the banner can change size after that without Svelte
  // having any reason to notice. A web font finishing its load is the obvious way: the text
  // re-flows from two lines to one, the banner shrinks, and the rail is left sitting 20px too far
  // down with a gap under the banner. A ResizeObserver watches the thing itself, so the answer
  // cannot go stale however the size came to change.
  $: if (noteEl && landscapeNote) {
    measureNote();
    if (!noteRO && typeof ResizeObserver !== 'undefined') {
      noteRO = new ResizeObserver(measureNote);
      noteRO.observe(noteEl);
    }
  }
  $: if (!landscapeNote && noteRO) { noteRO.disconnect(); noteRO = null; }
  $: noteVar = landscapeNote && noteBottom ? `${noteBottom}px` : '52px';
  function readOrientation() {
    try { isLandscape = !!orientMq?.matches && window.matchMedia('(pointer: coarse)').matches; }
    catch { isLandscape = false; }
  }

  let savedFor = '';
  $: if (ev && ev.joinCode !== savedFor) { savedFor = ev.joinCode; saved = savedSet(ev.joinCode); }

  let bulkSaving = false;
  let bulkProgress = '';
  let bulkDone = '';
  // ── Downloading your own roll ───────────────────────────────────────────────
  // The same two questions the event gallery asks, in the same order, through the same components:
  // WHAT (all of them / only the ones this device has not got / hand-picked), then HOW (separate
  // files or one zip).
  //
  // This was a single "Save all" that answered both questions silently — always everything, always
  // files. So a guest who had already saved half their roll had no way to ask for just the rest,
  // and the zip existed on every screen except the one most guests actually see.
  // ── Hearts on your own roll ─────────────────────────────────────────────────
  // The same control the event gallery draws, from the same component. The point here is the other
  // direction: this is where you find out that the shot YOU took picked up eleven hearts.
  let heartCounts: Record<string, number> = {};
  let heartMine = new Set<string>();

  async function loadHearts() {
    if (!ev?.heartsEnabled || !ev?.joinCode) return;
    try {
      const r = await getHearts(ev.joinCode, sessionToken ?? undefined);
      heartCounts = r.hearts;
      heartMine = new Set(r.mine);
    } catch { /* counts are decoration; never break the roll over them */ }
  }

  async function toggleHeart(p: Photo, want: boolean) {
    if (!sessionToken) return;
    // Only the DELTA is optimistic. The server's own total replaces it on reply — guessing the
    // total is what drifts when two people press at once.
    const before = heartCounts[p.id] ?? 0;
    heartCounts = { ...heartCounts, [p.id]: Math.max(0, before + (want ? 1 : -1)) };
    const mine = new Set(heartMine);
    want ? mine.add(p.id) : mine.delete(p.id);
    heartMine = mine;
    try {
      const r = await setHeart(p.id, sessionToken, want);
      heartCounts = { ...heartCounts, [p.id]: r.hearts };
    } catch {
      heartCounts = { ...heartCounts, [p.id]: before };
      const undo = new Set(heartMine);
      want ? undo.delete(p.id) : undo.add(p.id);
      heartMine = undo;
      showToast('Could not save that', true);
    }
  }

  let selecting = false;
  let selectedIds = new Set<string>();
  let dlScopeOpen = false;
  let choosing: { list: Photo[]; ids?: string[] } | null = null;

  $: mineAll = galleryPhotos.filter((p) => p.isOwn);
  $: mineNew = mineAll.filter((p) => !saved.has(p.id));

  function toggleSelecting() { selecting = !selecting; selectedIds = new Set(); }

  function onRollTap(p: Photo, i: number) {
    if (!selecting) { lbIndex = i; lbOpen = true; return; }
    const next = new Set(selectedIds);
    next.has(p.id) ? next.delete(p.id) : next.add(p.id);
    selectedIds = next;
  }

  function beginDownload() {
    if (!allowDownloads) { showToast('Downloads are off for this event', true); return; }
    if (selecting) {
      const list = mineAll.filter((p) => selectedIds.has(p.id));
      if (!list.length) { showToast('Tap the shots you want first'); return; }
      offerDownload(list, list.map((q) => q.id));
      return;
    }
    // Ask WHAT whenever there is more than one shot. An earlier version skipped the sheet when
    // "all" and "only the new ones" named the same photos — but "pick them myself" is always a
    // different answer, so with a fully-saved roll the download just started with no way to narrow
    // it. One photo is the only case with nothing to decide.
    if (mineAll.length <= 1) { offerDownload(mineAll); return; }
    dlScopeOpen = true;
  }

  function pickDownloadScope(scope: 'all' | 'favourites' | 'select' | 'new') {
    dlScopeOpen = false;
    if (scope === 'select') {
      if (!selecting) toggleSelecting();
      showToast('Tap the shots you want, then Download');
      return;
    }
    // A subset has to travel as explicit ids, or the server hands back the whole event and quietly
    // undoes the choice. 'favourites' is the host's axis and is not offered here.
    if (scope === 'new') { offerDownload(mineNew, mineNew.map((q) => q.id)); return; }
    offerDownload(mineAll);
  }

  function offerDownload(list: Photo[], ids?: string[]) {
    if (!list.length) return;
    choosing = { list, ids };
  }

  function startZip(ids?: string[]) {
    choosing = null;
    if (!ev) return;
    if (selecting) toggleSelecting();
    showToast('Preparing your download…');
    // The token is what makes an own-roll zip possible before the reveal; after it the server does
    // not need it, and passing it anyway keeps one code path instead of two.
    location.href = zipHref(ev.joinCode, ids, sessionToken ?? undefined);
  }
  function chooseZip() { startZip(choosing?.ids); }
  function chooseFiles() {
    const list = choosing?.list ?? [];
    choosing = null;
    void saveAsFiles(list);
  }

  // One photo, from its own card — the same control the event gallery puts there, from the same
  // component. One at a time on purpose: this is a per-card control, and two in flight would leave
  // the second's outcome landing on a card the guest has already scrolled past.
  let savingOne: string | null = null;
  async function saveOne(p: Photo) {
    if (savingOne) return;
    savingOne = p.id;
    try {
      const out = await savePhotoByUrl(p.url, downloadFilename(p));
      // Only an outcome that actually reached the device marks the card. A cancelled share is the
      // guest's decision and says nothing; a failure must not claim they have it.
      if ((out === 'shared' || out === 'downloaded') && ev) saved = markSaved(ev.joinCode, [p.id]);
      else if (out === 'failed') showToast('Could not save that one', true);
    } finally { savingOne = null; }
  }

  async function saveAsFiles(list: Photo[]) {
    if (!list.length || bulkSaving) return;
    bulkSaving = true; bulkProgress = `0/${list.length}`;
    try {
      const items = list.map((q) => ({ id: q.id, url: q.url, filename: downloadFilename(q) }));
      const r = await saveMany(items, (pr: SaveManyProgress) => (bulkProgress = `${pr.done}/${pr.total}`));
      if (r.savedIds.length && ev) saved = markSaved(ev.joinCode, r.savedIds);
      if (r.cancelled) { showToast(r.saved ? `Stopped — ${r.saved} downloaded` : 'Stopped'); bulkDone = ''; }
      else {
        showToast(`${r.saved} photo${r.saved === 1 ? '' : 's'} downloaded`);
        // Saving is slow and batched, and a toast has gone by the time the last batch lands. The
        // button says so itself for a few seconds, so "did that finish?" has an answer on screen.
        bulkDone = `✓ Downloaded ${r.saved}`;
        setTimeout(() => (bulkDone = ''), 4000);
      }
      // The selection has been spent — leaving it on invites a second, accidental download of the
      // same photos.
      if (selecting) toggleSelecting();
    } catch { showToast('Could not save those', true); }
    finally { bulkSaving = false; bulkProgress = ''; }
  }

  async function refreshMissions() {
    if (!sessionToken) return;
    try {
      const me = await getMe(sessionToken);
      if (Array.isArray(me.challenges)) missions = me.challenges;
      // Merged, not assigned — see missionsDoneLocal. `missions` is set first, because the merge
      // uses it to decide which local ticks are still on offer.
      applyServerDone(me.challengesDone);
      applyCardStatus(me);
      if (me.challengeTick) missionTick = me.challengeTick;
    } catch { /* keep what we have */ }
  }

  /** Is the camera actually still running?
   *
   *  `stream` being non-null is not the same thing. Hand off to the phone's own camera app — which
   *  is what "use my own camera" does — and the OS takes the hardware; our tracks end but the
   *  MediaStream object survives, so a `!stream` check says everything is fine while the viewfinder
   *  is black. Recording then produced a black clip, and the frame-rate warning fired on top of it
   *  offering 720p, because a dead track reports no frames. One dead check, three symptoms. */
  function streamIsLive(): boolean {
    const t = stream?.getVideoTracks?.()[0];
    return !!t && t.readyState === 'live';
  }

  /** Bring the camera back if it died while something else had it. */
  function resumeIfDead() {
    if (screen !== 'camera' || cameraError || cameraPaused || cameraStarting) return;
    if (!streamIsLive()) startCamera();
  }

  function onVisibility() {
    if (document.hidden) {
      if (recording) toggleRecord();   // saves the clip; iOS would otherwise corrupt it
      if (screen === 'camera') stopCamera();
    } else {
      resumeIfDead();   // liveness, not merely "is there a stream object"

      // Returning to the app is exactly when a host's edit has most likely happened behind you.
      if (screen === 'camera') void refreshMissions();
    }
  }

  // Manual camera power. A reliable fallback to backgrounding (some desktops don't fire
  // visibilitychange on minimise) and a clear privacy/battery control.
  function toggleCameraPower() {
    if (cameraPaused) {
      cameraPaused = false;
      startCamera();          // resume
    } else {
      stopCamera();
      cameraPaused = true;    // pause
    }
  }

  onDestroy(() => {
    // Leave the rest of the app's toasts where they belong.
    if (typeof document !== 'undefined') document.documentElement.style.removeProperty('--toast-bottom');
    clearInterval(undoTimer);
    clearTimeout(lensHintTimer);
    try { orientMq?.removeEventListener('change', readOrientation); } catch { /* ignore */ }
    stopTilt?.();
    noteRO?.disconnect();
    topbarRO?.disconnect();
    // onDestroy also runs during SSR, where `document` is undefined — guard it.
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    if (typeof navigator !== 'undefined') navigator.mediaDevices?.removeEventListener?.('devicechange', refreshCameras);
    if (typeof window !== 'undefined') { window.removeEventListener('online', autoRetry); window.removeEventListener('pagehide', stopCamera); window.removeEventListener('pageshow', onPageShow); }
    if (retryTimer) clearInterval(retryTimer);
    nativeWake?.();   // a pending 'they came back' listener outlives the component otherwise
    stopCamera();
  });

  async function doJoin() {
    if (!joinName.trim()) { showToast('Enter your name', true); return; }
    // Asking to be emailed the photos and leaving no address is a promise we cannot keep: the
    // switch went on, the join succeeded, and nothing was ever sent. The address is still optional
    // for everybody else — this is required only because THEY asked for it.
    // `!myEmail` matters: a returning guest whose address we already hold must not be made to type
    // it again just because the box is ticked and the field is blank. We only need SOMEWHERE to
    // send them — not this particular field filled in.
    if (joinWantsPhotos && !joinEmail.trim() && !myEmail) {
      showToast('Add your email so we know where to send your photos', true);
      document.getElementById('join-email')?.focus();
      return;
    }
    if (joinEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(joinEmail)) { showToast("That email doesn't look right", true); return; }
    // Asked HERE, and nowhere else, because iOS only grants it from inside a user gesture — and
    // this tap is already the one that leads to the camera prompt, so the two land together as one
    // short run rather than surprising someone later. Not awaited before the join proceeds: a
    // guest who declines still gets their camera, they just lose the upright icons and the
    // "shot sideways" note. Android shows nothing at all.
    void requestTiltPermission().then((ok) => { if (ok) { stopTilt?.(); stopTilt = watchTilt(readTilt); } });
    joining = true;
    try {
      // Last line of defence: if this browser already holds a session for the event, use it instead
      // of creating a second participant. Cheap, and it closes any path bfcache handling misses.
      // The tick has to survive this path too: a guest whose browser still holds a session never
      // reaches the join call below, and without this their opt-in is silently dropped by the one
      // branch nobody tests — the second time they open the link.
      if (await restoreIfSessionExists()) {
        if (joinWantsPhotos && sessionToken) {
          if (myEmail || joinEmail.trim()) void optInFromJoin(sessionToken);
          else optInAsking = true;
        }
        return;
      }
      // The set named by a printed card's QR (`?set=b`), straight off the address bar. The server
      // has always honoured it and the QR endpoint has always printed it; nothing in between ever
      // carried it, so every guest who scanned a card was quietly handed whatever the round-robin
      // said next. Read here rather than from $page so the /app route's join works the same way.
      // The server validates it against the event's own sets, so a stale or edited link cannot put
      // a guest on a card that does not exist.
      const printedSet = (() => {
        try { return new URLSearchParams(window.location.search).get('set') || undefined; }
        catch { return undefined; }
      })();
      const r = await joinEvent(identifier, joinName.trim(), joinEmail.trim() || undefined, printedSet);
      sessionToken = r.sessionToken;
      serverRemaining = r.photosRemaining;
      canBuyShots = !!r.canBuyShots;
      canAskHost = !!r.canAskHost;
      faceMatching = !!r.faceMatching;
      feedbackDone = !!r.feedbackGiven;
      wantsPhotos = !!r.wantsPhotos;
      missions = Array.isArray(r.challenges) ? r.challenges : [];
      applyServerDone(r.challengesDone);
      applyCardStatus(r);
      if (r.challengeTick) missionTick = r.challengeTick;
      saveSession(r.joinCode, r.sessionToken);
      trackEvent('joined', undefined, r.joinCode);
      // Not awaited: the camera must open at the speed it always has, and a failed opt-in is
      // recoverable from the roll. Ticking the box with no address is not thrown away either
      // — it opens the ask in their roll rather than nagging on a screen they are leaving.
      if (joinWantsPhotos) {
        if (joinEmail.trim()) void optInFromJoin(r.sessionToken);
        else optInAsking = true;
      }
      if (r.recovered) showToast(`Welcome back! You've ${photosRemaining} shot${photosRemaining === 1 ? '' : 's'} left.`);
      await enterCamera();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not join', true);
    } finally {
      joining = false;
    }
  }

  // The join screen's tick, applied once the roll exists. Silent on failure by design: this is a
  // nice-to-have riding on the back of joining, and a toast about it would land on top of the
  // camera permission prompt.
  async function optInFromJoin(token: string) {
    // Sent WITH the address rather than relying on the row already holding it: on the recovery
    // path above, joinEvent never ran, so an address typed on this screen exists nowhere else.
    const typed = joinEmail.trim();
    try {
      const r = await setPhotoOptIn(token, true, typed || undefined);
      wantsPhotos = r.wantsPhotos;
      if (r.email) myEmail = r.email;
      ({ headline: optInHeadline, note: optInNote } = optInMessage(r, typed));
    } catch { /* the roll carries the same button */ }
  }

  async function enterCamera() {
    screen = 'camera';
    applyEventTheme(ev?.theme);
    if (ev?.isExpired || ev?.isLocked) { showToast(ev.isLocked ? 'Event is locked' : 'Event has ended'); }
    // …and never restore it on iOS: the control is not shown there, so a value left over from
    // before would keep writing to Files invisibly with nothing on screen to turn it off.
    if (ev && !iosDevice) { try { saveToDevice = localStorage.getItem('savedev_' + ev.joinCode) === '1'; } catch { /* ignore */ } }
    try { const q = localStorage.getItem('snap_vidq'); if (q === 'high' || q === 'standard' || q === 'smooth' || q === 'phone') videoQuality = q; } catch { /* ignore */ }
    try { gridOn = localStorage.getItem('snap_grid') === '1'; } catch { /* ignore */ }
    await startCamera();
    restoreQueue();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', autoRetry);
      retryTimer = setInterval(autoRetry, 15000);
    }
  }
  $: if (ev && typeof localStorage !== 'undefined') { try { localStorage.setItem('savedev_' + ev.joinCode, saveToDevice ? '1' : '0'); } catch { /* ignore */ } }

  // Attach a stream for the given constraints and wire up the preview/track.
  /**
   * Take stereo when the microphone actually has it, rather than assuming either way.
   *
   * `channelCount: { ideal: 2 }` in the original request is a preference the browser is free to
   * ignore, and Chrome on Android answers it with mono on every device tried — even ones whose own
   * camera app records stereo, because that app uses the platform's camera audio path and this is
   * the WebRTC one. But "the browser did not volunteer it" is not the same claim as "the device
   * cannot do it", and the track itself can be asked: getCapabilities reports the real range.
   *
   * So if the hardware says it has two channels and we were handed one, ask again explicitly. A
   * refusal costs nothing — applyConstraints rejects, the track keeps the mono it already had, and
   * the clip records exactly as it would have. Which is why this is worth attempting and why
   * `exact: 2` must never go in the ORIGINAL request: there, a refusal fails the whole
   * getUserMedia call and the clip records with no sound at all.
   *
   * MEASURED, so nobody has to go round this again: on a current Android phone whose own camera app
   * records 256k STEREO, getCapabilities() on the getUserMedia track reports no second channel at
   * all — not stereo refused, stereo absent. The upgrade below never even fires there, which is the
   * correct outcome and the reason it is written as a capability check rather than a forced retry.
   * There is no constraint that produces stereo on that path; the way to a stereo clip is the
   * phone's own camera app, which the video-quality setting already offers.
   */
  async function preferStereo() {
    const t = stream?.getAudioTracks?.()[0];
    if (!t?.getCapabilities || !t.applyConstraints) return;
    try {
      const max = (t.getCapabilities() as MediaTrackCapabilities).channelCount?.max ?? 1;
      if (max < 2 || (t.getSettings?.().channelCount ?? 1) >= 2) return;
      await t.applyConstraints({ channelCount: { exact: 2 } });
    } catch { /* mono it is — the track is untouched and still recording */ }
  }

  async function attachCamera(constraints: MediaStreamConstraints) {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (constraints.audio) await preferStereo();
    if (videoEl) { videoEl.srcObject = stream; await videoEl.play().catch(() => {}); }
    track = stream.getVideoTracks()[0] || null;
    // Pin the exact camera we landed on. Without this, re-acquiring for a quality/mode change
    // selects only by facingMode + resolution, so a multi-lens phone can swap to a different
    // physical lens (e.g. 4K→main, 720p→ultra-wide). Pinning keeps the same camera across changes.
    const settings = track?.getSettings?.() ?? {};
    const liveId = settings.deviceId;
    if (liveId) deviceId = liveId;
    // Keep `facing` honest. It used to change ONLY inside flip(), so picking a lens from the menu
    // left it describing where the guest used to be — and the next flip toggled it to the side they
    // were already on, reloading the same camera. Prefer what the track reports; fall back to the
    // device label, because iOS Safari (and fake devices) often omit facingMode entirely.
    const reported = (settings as MediaTrackSettings & { facingMode?: string }).facingMode;
    if (reported === 'user' || reported === 'environment') facing = reported;
    else if (track?.label) {
      if (/front|user|selfie|face/i.test(track.label)) facing = 'user';
      else if (/back|rear|environment|world/i.test(track.label)) facing = 'environment';
    }
    // WHICH LENS IS THE "NORMAL" ONE — the 1x wide, not the ultra-wide and not the telephoto.
    //
    // Nothing names a lens's role: getCapabilities() reports zoom and resolution, never focal
    // length, and on Android the label is usually "camera2 0, facing back", which says nothing at
    // all (see $lib/lensName for why we do not guess from names). But there is an answer that needs
    // no heuristic and works everywhere: a getUserMedia call that asks for facingMode and does NOT
    // name a device is answered with the PLATFORM'S OWN DEFAULT for that side, and that default is
    // the main lens. So we do not infer which one is normal — we ask, once, and remember what came
    // back. Only recorded when we did not name a device, or we would just be recording our own
    // previous choice.
    const askedForDevice = !!(constraints.video as MediaTrackConstraints | undefined)?.deviceId;
    if (!askedForDevice && liveId && (facing === 'user' || facing === 'environment')
        && normalLens[facing] !== liveId) {
      normalLens = { ...normalLens, [facing]: liveId };
      try { localStorage.setItem(NORMAL_LENS, JSON.stringify(normalLens)); } catch { /* private mode */ }
    }
    // Knowing which lens is standard is only half of it — flip still has to LAND there. Without a
    // favourite, flip names no device and the browser is free to answer with whichever lens it
    // likes, which is how a phone with three rear cameras gives you a different one each time.
    // So the standard lens becomes the favourite the first time we identify it.
    //
    // ONLY when the side has no answer recorded at all. Un-starring writes '' rather than deleting
    // the key precisely so that it reads as "this guest chose none" and not "not asked yet" — a
    // preference we re-applied over the top of their choice would be worse than never having one.
    if (liveId && (facing === 'user' || facing === 'environment')
        && lensFavs[facing] === undefined && normalLens[facing] === liveId) {
      lensFavs = { ...lensFavs, [facing]: liveId };
      try { localStorage.setItem(LENS_FAVS, JSON.stringify(lensFavs)); } catch { /* private mode */ }
    }
    // Tap-to-focus only works where the device exposes focus controls (some Android
    // Chrome); iOS Safari never does. Detect it so we don't show a fake focus ring.
    const caps = (track?.getCapabilities?.() ?? {}) as Record<string, unknown>;
    focusSupported = 'pointsOfInterest' in caps || 'focusMode' in caps;
    // Hardware torch (back camera). Two sources, because one of them lies.
    //
    // getCapabilities() is the documented answer, and it is what Chrome and Brave give. The
    // DuckDuckGo browser on Android strips `torch` out of it — capability dictionaries are a
    // fingerprinting surface, so it hardens them — and trusting that alone hid the flash button
    // entirely on a device whose lamp may well work. getSupportedConstraints() is the second
    // opinion: it says what the ENGINE understands rather than what this camera reports.
    //
    // Either one is enough to offer the control; whether it actually works is settled on first use
    // by setTorch(), which verifies and withdraws the button if the lamp never comes on. Offering
    // it and finding out beats never offering it.
    //
    // Gated on the back camera now that a global signal can vote yes: front cameras have no lamp,
    // and without this the selfie view would show both the torch button and the screen-flash one.
    let engineKnowsTorch = false;
    // Cast: `torch` is non-standard, so it is absent from MediaTrackSupportedConstraints — which is
    // exactly why it has to be read defensively rather than trusted.
    try {
      const sc = navigator.mediaDevices?.getSupportedConstraints?.() as { torch?: boolean } | undefined;
      engineKnowsTorch = !!sc?.torch;
    } catch { /* ignore */ }
    torchSupported = !torchRefused && facing === 'environment' && (('torch' in caps && !!caps.torch) || engineKnowsTorch);
    torchOn = false;   // a fresh stream always starts with the torch physically off
    cameraError = ''; cameraDenied = false;
    // Clear the microphone verdict only when we actually GOT a microphone. Clearing it on every
    // successful attach wiped what askForMic() had just learned — the camera comes up fine without
    // audio, so the note about the missing mic was erased a moment after being set, and the guest
    // recorded silent clips with nothing on screen to say why.
    if (stream.getAudioTracks().length > 0) { micDenied = false; micReason = ''; }
    // The grant side of the ratio. Denials already reach client_errors; without this the denial
    // count has no denominator and cannot tell you whether permission is a real problem.
    if (!permissionReported) { permissionReported = true; trackEvent('camera_permission_granted', undefined, ev?.joinCode); }
    matchRecBitrate();   // size the recorder to whatever the camera actually gave us
    applyViewfinderAspect();
    // A fresh track carries no constraints of its own, so every re-acquire — a flip, a lens pick, a
    // quality change, each leg of the capability check — has to ask for the shape again, and verify
    // the answer again. Cheap: the call itself measures ~1ms.
    await applyRecordShape();
  }

  // Photos: request the camera's max (soft `ideal` hints — a 4K/1080p sensor returns its best).
  // Video: phone browsers can't encode 4K/8K via MediaRecorder in real time (the frame rate
  // collapses), so we request a sane ceiling per the chosen quality. 'Standard' (1080p30) is the
  // reliable default; bump to High or drop to Smooth from the camera settings.
  const RES_PHOTO = { width: { ideal: 7680 }, height: { ideal: 4320 } };

  /* What the microphone is asked for — and, more to the point, what it is asked NOT to do.
   *
   * `audio: true` does not mean "record the sound in the room". It opts into the browser's VOICE
   * CALL chain: echo cancellation, noise suppression and automatic gain, three filters written to
   * make one person talking into a handset intelligible to someone on the other end of a phone
   * line. Every assumption behind them is wrong here. Music is not noise to be removed, but noise
   * suppression cannot tell the difference and takes it out in swirling chunks; echo cancellation
   * hunts for anything resembling playback, which at a party is the speakers; and auto gain rides
   * the level up in the quiet bits and slams it down on every cheer, so the room appears to breathe.
   * The result is thin, watery, pumping sound on top of a perfectly good picture.
   *
   * Turning all three off is what "record what it actually sounds like" means. The trade is real
   * and deliberate: with no gain riding, a quiet voice stays quiet and a loud room stays loud. That
   * is the right trade for a camera at an event — the sound people want back is the room.
   *
   * Stereo and 48k are ideals, not demands, so a phone that only offers mono simply gives mono
   * rather than failing the whole request — which is what happens in practice; see preferStereo for
   * what was measured and why there is nothing further to try here. */
  const AUDIO_HQ: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    channelCount: { ideal: 2 },
    sampleRate: { ideal: 48000 },
  };
  // 'phone' is not a resolution — it means "don't record in the browser at all, hand me to the
  // phone's own camera app". Persisted like the others, so choosing it once makes it the mode.
  type VidQuality = 'high' | 'standard' | 'smooth' | 'phone';
  const VQ_RES: Record<Exclude<VidQuality, 'phone'>, { w: number; h: number }> = {
    high:     { w: 3840, h: 2160 },   // 4K — only on capable devices
    standard: { w: 1920, h: 1080 },   // 1080p — the default
    smooth:   { w: 1280, h: 720 },    // 720p — for older / struggling devices
  };
  // Default 1080p — the reliable choice for smooth in-browser recording on phones (4K via
  // MediaRecorder drops frames / overheats on most devices). 4K stays a deliberate opt-in.
  let videoQuality: VidQuality = 'standard';
  let recBitrate = 10_000_000;
  let lowFpsWarned = false;                // one stutter warning per session unless quality changes
  let pendingQuality: VidQuality | null = null;  // auto-downgrade to apply after the current clip
  // Set when recording is struggling. Surfaces the phone-camera fallback ON the camera screen —
  // it already existed, but only inside the settings sheet, which is not where someone fighting a
  // choppy clip is going to look.
  let videoStruggling = false;
  // One-off video capability check, so a guest is told what their phone can actually do rather
  // than discovering it halfway through a clip they cannot re-shoot.
  let benchRunning = false;
  let benchStep: VidQuality | null = null;
  let benchResult: { results: Record<string, number>; best: VidQuality;
                     mic: { channels: number; max: number } | null } | null = null;

  /** What the live microphone track reports — measured, not assumed. Null when there is no mic. */
  function micReport(): { channels: number; max: number } | null {
    const t = stream?.getAudioTracks?.()[0];
    if (!t) return null;
    let max = 0;
    try { max = (t.getCapabilities?.() as MediaTrackCapabilities | undefined)?.channelCount?.max ?? 0; }
    catch { /* not every browser implements it */ }
    return { channels: t.getSettings?.().channelCount ?? 0, max };
  }
  let benchPrompt = false;
  let benchStored = false;
  // Measured PER EVENT, not per device. localStorage is already per device, so a new phone gets a
  // fresh measurement for free — what that misses is the same phone performing differently on the
  // night: hot, on battery saver, three apps deep. Events are rare enough that a few seconds at
  // the start of each one is not a nag, and it is the only way the reading reflects the conditions
  // the video will actually be shot in.
  const benchKey = (joinCode: string) => `snap_vidbench_${joinCode}`;
  // Keep localStorage from growing an entry per event forever.
  const BENCH_PRUNE_MS = 90 * 24 * 3600 * 1000;
  // Set when the guest says "no thanks" — never prompt on this device again. They can still run the
  // check on demand from camera settings, which is where someone who changes their mind will look.
  const BENCH_NEVER = 'snap_vidbench_never';
  function pruneBenchmarks() {
    try {
      // The old global key from when this was once-per-device. The chosen quality already persists
      // separately in snap_vidq, so nothing is lost by dropping it.
      localStorage.removeItem('snap_vidbench');
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith('snap_vidbench_')) continue;
        const at = Number(JSON.parse(localStorage.getItem(k) || '{}')?.at || 0);
        if (!at || Date.now() - at > BENCH_PRUNE_MS) localStorage.removeItem(k);
      }
    } catch { /* ignore */ }
  }
  // Guest feedback lives in GuestFeedback.svelte, shared with the gallery page. The flag is seeded
  // from /me so answering on either surface stops the ask on both.
  let feedbackDone = false;
  let feedbackOpen = false;   // the spent-roll toast opens the shared panel

  // ONE bar, used for both the recommendation and the warning. They were different numbers (24 and
  // 30) and could contradict each other: a phone measuring 29fps at 4K got "we've set you to 4K"
  // and "4K isn't smooth" on the same panel. 24 is the film standard and the honest floor for
  // something that still reads as video; phone cameras commonly report 29.97, so 29 is fine.
  const SMOOTH_FPS = 24;
  const fpsLabel = (n: number) => (n >= 28 ? 'Smooth' : n >= SMOOTH_FPS ? 'Good' : 'Choppy');

  // Match the recorder to the stream the camera actually negotiated (≈0.1 bits/pixel/frame),
  // so the file tracks the native resolution + frame rate instead of a guessed constant.
  function matchRecBitrate() {
    const s = (track?.getSettings?.() ?? {}) as { width?: number; height?: number; frameRate?: number };
    const w = s.width || 1920, h = s.height || 1080, fps = s.frameRate || 30;
    recBitrate = Math.min(40_000_000, Math.max(2_000_000, Math.round(w * h * fps * 0.1)));
  }

  /* The last frame that was on screen, held there while the stream is swapped.

     Releasing a camera blanks the <video> instantly, and acquiring the next one takes long enough
     to read as a fault rather than a transition — the picture drops to black, a spinner appears
     over nothing, and on a flip or a quality change it happens for no reason the guest can see.
     Holding the frame they were already looking at turns that into a still: the subject stays put,
     dimmed, and the spinner reads as "working on it" instead of "something went wrong". */
  let freezeEl: HTMLCanvasElement | undefined;
  let frozen = false;
  let frozenMirrored = false;

  function freezePreview() {
    const v = videoEl;
    // readyState < HAVE_CURRENT_DATA means there is no frame to take — first open, or a camera that
    // never came up. Nothing to hold, so don't pretend: fall through to the existing black.
    if (!v || !freezeEl || v.readyState < 2 || !v.videoWidth) { frozen = false; return; }
    try {
      freezeEl.width = v.videoWidth;
      freezeEl.height = v.videoHeight;
      freezeEl.getContext('2d')?.drawImage(v, 0, 0);
      // The mirror is captured WITH the frame, not read live: a flip changes `facing` before the new
      // stream arrives, and a held selfie frame re-mirrored mid-swap flips the picture sideways
      // while it is standing still — the one moment it is most obvious.
      frozenMirrored = facing === 'user';
      frozen = true;
    } catch { frozen = false; }
  }

  async function startCamera() {
    if (recFlush) await recFlush;   // never yank the tracks out from under a recorder still flushing
    freezePreview();                // take the frame BEFORE the tracks go and the <video> blanks
    stopCamera();
    cameraStarting = true;   // show a spinner while the camera (re)acquires — the brief black flash now reads as "working"
    // Only grab the mic in video mode (avoids an unnecessary mic prompt while taking photos).
    const audio = videoMaxSecs !== 0 && videoMode ? AUDIO_HQ : false;
    // 'phone' never records in-browser, so it never asks for a resolution.
    const q = VQ_RES[videoQuality === 'phone' ? 'standard' : videoQuality];
    const res = videoMode
      ? { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: 30 } }
      : RES_PHOTO;
    try {
      // A specific camera was chosen (multi-camera systems); else pick by front/back facing.
      const video: MediaTrackConstraints = deviceId
        ? { deviceId: { exact: deviceId }, ...res }
        : { facingMode: { ideal: facing }, ...res };
      await attachCamera({ video, audio });
    } catch (err1) {
      // Give the CHOSEN lens a second chance before abandoning it. The first attempt asked for a
      // specific camera AND a resolution; a secondary lens (ultra-wide, telephoto) routinely tops
      // out well below the main sensor, and some Android stacks answer that pairing with an
      // OverconstrainedError rather than just handing back a smaller frame. Retrying the same lens
      // with no resolution ask is the difference between "the wide angle doesn't work" and it
      // simply working at whatever size it has.
      if (deviceId) {
        try {
          await attachCamera({ video: { deviceId: { exact: deviceId } }, audio });
          cameraStarting = false;
          void refreshCameras();
          return;
        } catch (err1b) {
          // Keep the more informative of the two for the report below.
          lastLensError = err1b instanceof Error ? err1b.name : (err1 instanceof Error ? err1.name : '');
        }
      } else {
        lastLensError = err1 instanceof Error ? err1.name : '';
      }
      // The requested camera/facing may not exist (missing selfie cam, unplugged webcam, incognito).
      // Drop the specific pick and the resolution, but KEEP THE LENS: a bare `video: true` drops the
      // facing too, so a failed video-mode switch used to hand the guest their front camera back.
      // Changing which way the camera points because a permission check failed is never what they
      // asked for, and on a phone it is the most jarring thing the app can do.
      deviceId = null;
      const anyLens: MediaTrackConstraints = { facingMode: { ideal: facing } };
      let noAudioError: unknown = null;   // the error from an attempt that did NOT ask for the mic
      try {
        await attachCamera({ video: anyLens, audio });
      } catch (err2) {
        // If we asked for the microphone, we have not yet learned WHICH half failed — the request
        // above changed the video constraints and asked for audio. Try the same video with no audio
        // at all. This runs for ANY failure, not just a denial: the common real-world case is a
        // microphone that is permitted but unavailable (NotReadableError — another tab or app has
        // it), and gating this on NotAllowedError sent exactly those guests a message about
        // permissions they had already granted.
        if (audio) {
          stopCamera();                                       // let the hardware go before re-asking
          await new Promise((r) => setTimeout(r, 250));       // …and give the OS a beat to release it
          try {
            await attachCamera({ video: anyLens, audio: false });
            // Video without audio works, so the microphone really is the blocker. Say WHY, because
            // "allow the microphone" is useless advice to someone who already has.
            const name = err2 instanceof DOMException ? err2.name : '';
            micDenied = true;
            micReason = name;
            // STAY in video mode. Forcing photos here meant a guest whose microphone we could not
            // get was refused video entirely — they could not record at all, silent or otherwise,
            // and had no way to find out whether the mic was really the problem. MediaRecorder is
            // perfectly happy with a stream that has no audio track: a silent clip beats no clip,
            // and the note below says plainly that it will be silent.
            cameraStarting = false;
            cameraDenied = false; cameraError = '';
            // No toast: the note that appears at the top says all of this and stays put. Saying it
            // twice, in two places, with one of them vanishing, reads as two different problems.
            // Report what the PERMISSIONS API says alongside the exception. NotAllowedError alone
            // cannot distinguish "the site is blocked" from "the browser app has no mic permission
            // from the OS" — and on Android those are different screens to go and fix.
            void diagnoseMic().then(() =>
              reportClientError(`camera: microphone unavailable for video (${name || 'unknown'}; permission=${micState})`,
                                'camera-denied', ev?.joinCode));
            return;
          } catch (err3) {
            // Keep THIS error to judge by. It is the only attempt that did not ask for a microphone,
            // so it is the only one that can honestly say anything about the camera.
            noAudioError = err3;
          }
        }
        // NOTE: a failed MODE SWITCH does not strand the guest — the audio-free retry above IS the
        // revert to photo, and it returns on success. Reaching here means even a plain camera
        // request failed, so there is nothing working left to fall back to.
        stopCamera();   // make sure no half-open stream remains (shutter stays disabled on error)
        cameraStarting = false;
        // Judge by the audio-free attempt when we made one. Deciding "the camera was denied" from a
        // request that also asked for the MICROPHONE is how a mic refusal produced a full-screen
        // "We need your camera" panel, with an Allow button, for a camera the guest had already
        // granted and was using a second earlier.
        const judged = noAudioError ?? err2;
        const denied = judged instanceof DOMException && (judged.name === 'NotAllowedError' || judged.name === 'SecurityError');
        const missing = judged instanceof DOMException && judged.name === 'NotFoundError';
        const busy = judged instanceof DOMException && (judged.name === 'NotReadableError' || judged.name === 'AbortError');
        // A denial is a CHOICE, not a fault. The old copy read as a settings problem and never said
        // why we need the camera or what we cannot reach — which is the actual worry.
        cameraDenied = denied;
        cameraError = denied ? ''
          : missing ? 'No camera found on this device.'
          : busy ? 'Your camera is busy — another app or tab may be using it.'
          : "Couldn't start the camera.";
        // Genuine faults stay 'camera'; a declined permission gets its own context so it does not sit
        // in the operator's open-issues digest looking like a bug.
        reportClientError(`camera: ${judged instanceof Error ? judged.name + ' ' + judged.message : 'failed'}`,
          denied ? 'camera-denied' : 'camera', ev?.joinCode);
        if (denied && !permissionReported) { permissionReported = true; trackEvent('camera_permission_denied', undefined, ev?.joinCode); }
        // The camera did not come back, so the last known torch answer is no longer about anything.
        // stopCamera() deliberately leaves it alone (see the note there) precisely so a re-acquire
        // does not flicker the flash button — which means THIS is the path that has to clear it, or
        // a failed start leaves a flash control that looks live and does nothing.
        torchSupported = false;
        return;
      }
    }
    cameraStarting = false;
    void refreshCameras();   // labels are only readable once permission is granted (i.e. now)
  }

  // List the available video inputs. Only meaningful after a stream has been granted (labels are
  // empty otherwise). Drives the camera picker, which only shows when there's more than one.
  async function refreshCameras() {
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const vids = devs.filter((d) => d.kind === 'videoinput');
      cameras = vids.map((d, i) => ({ id: d.deviceId, label: lensName(d.label, i, vids.length), facing: lensFacing(d.label) }));
      // Track the live camera so the picker reflects reality (e.g. after a facing flip).
      const live = track?.getSettings?.().deviceId;
      if (live) deviceId = live;
    } catch { /* enumeration unsupported — picker just won't appear */ }
  }

  async function pickCamera(id: string) {
    if (recording || id === deviceId) return;
    const wanted = id;
    const wantedLabel = cameras.find((c) => c.id === wanted)?.label || 'That camera';
    deviceId = id;   // session-only — we always start from the reliable default each visit
    await startCamera();
    // A phone lists every lens it has, including ones it cannot actually open on demand — an
    // ultra-wide already in use, a duplicate entry, one that cannot meet the requested resolution.
    // startCamera() falls back to any working lens when the exact pick fails, and refreshCameras()
    // then snaps this dropdown back to whatever we really got. That is the right behaviour and the
    // worst possible silence: the guest taps a camera, the list jumps back, and it reads as broken.
    // Say what happened instead.
    const live = track?.getSettings?.().deviceId;
    if (live && live !== wanted) {
      const gotLabel = cameras.find((c) => c.id === live)?.label || 'the previous camera';
      showToast(lastLensError === 'NotReadableError' || lastLensError === 'AbortError'
        ? `${wantedLabel} is busy — staying on ${gotLabel}.`
        : lastLensError === 'OverconstrainedError'
        ? `${wantedLabel} can’t do this mode — staying on ${gotLabel}.`
        : `${wantedLabel} isn’t available right now — staying on ${gotLabel}.`);
      reportClientError(`camera: lens unavailable (${wantedLabel}: ${lastLensError || 'unknown'})`, 'camera', ev?.joinCode);
    }
  }

  /** Everything except the recorder. Split out so a stop that is still flushing can defer it.
   *  `only` releases a stream we have ALREADY moved on from: if the camera has since re-acquired,
   *  stop just those old tracks and leave the live one alone — a deferred release must never reach
   *  forward and kill the stream that replaced it. */
  function releaseStream(only?: MediaStream) {
    if (only && only !== stream) { only.getTracks().forEach((t) => t.stop()); return; }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    // Detach the stream from the <video> too — some browsers keep the "camera in use" indicator
    // lit while a stream is still bound to a live element, even after its tracks are stopped.
    if (videoEl) { try { videoEl.pause(); } catch { /* */ } videoEl.srcObject = null; }
    track = null;
    focusSupported = false;
    /* torchSupported is deliberately NOT cleared here. Stopping the track does not change whether
       this camera HAS a lamp — only attachCamera can answer that, and it answers definitively the
       moment the new stream arrives. Clearing it meant every mode switch ran
       supported -> false -> supported, and the flash button visibly flicked to its struck-through
       "no flash here" state and back for the length of a getUserMedia call. With flash on for both
       photo and video there is now no transition to see at all, which is the honest rendering: the
       answer never actually changed. The error paths below clear it, so a camera that fails to come
       back cannot leave a live-looking button behind. */
    torchOn = false;          // stopping the track kills the lamp, so our record of it must follow
  }

  // Settles once the recorder has finished flushing; null when nothing is in flight. This exists
  // because `recording` CANNOT answer "is it safe to stop the tracks yet" — see stopRecorder.
  let recFlush: Promise<void> | null = null;

  /** Stop the recorder and hand back a promise that settles once it has actually flushed. */
  function stopRecorder(): Promise<void> {
    const mr = mediaRecorder;
    if (!mr || mr.state === 'inactive') return recFlush ?? Promise.resolve();
    recFlush = new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (done) return; done = true; recFlush = null; resolve(); };
      mr.addEventListener('stop', finish, { once: true });
      setTimeout(finish, 2000);   // the camera light must not stay on if that event never arrives
      try { mr.stop(); } catch { finish(); }
    });
    return recFlush;
  }

  function stopCamera() {
    // MediaRecorder.stop() is ASYNCHRONOUS. It flushes whatever the encoders still hold and only
    // THEN fires dataavailable and stop. This used to stop the recorder and kill the tracks in the
    // very next statement, which cut that flush off mid-way — and because an audio encoder buffers
    // in larger chunks than a video one, the part that went missing was the AUDIO tail.
    //
    // That is exactly the shape the bug had in the wild: video complete, audio short, both streams
    // starting at 0.000. Measured on real uploads, audio came up 165ms, 248ms and once 1410ms
    // shorter than its own video. Intermittent because it depends on how much the encoders happened
    // to be holding when the tracks died.
    // NOTE the guard is the flush promise, NOT `recording`. MediaRecorder.stop() sets state to
    // inactive SYNCHRONOUSLY and flushes afterwards, and toggleRecord clears `recording` on the
    // line after it stops — so both of those read "not recording" while the tail is still in the
    // encoder. Gating on either one is what let the tracks die mid-flush.
    if (mediaRecorder && mediaRecorder.state !== 'inactive') { recording = false; clearInterval(recTimer); stopRecorder(); }
    if (recFlush) { const old = stream ?? undefined; recFlush.then(() => releaseStream(old)); return; }
    releaseStream();
  }

  // Quick front/back toggle. Clears any specific device pick so it follows facing again.
  function flip() {
    if (recording) return;
    facing = facing === 'environment' ? 'user' : 'environment';
    // Land on the favourite for the side we are heading to, when there is one and it still exists
    // (a favourite saved on another phone names a lens this one has never heard of). Otherwise let
    // facingMode choose, which is the behaviour everyone else gets.
    const fav = lensFavs[facing];
    deviceId = fav && cameras.some((c) => c.id === fav) ? fav : null;
    startCamera();
  }

  // Press-and-hold the flip button to jump straight to the lens picker. The hold must SUPPRESS the
  // tap that follows it, or the guest gets the picker and a flip they did not ask for.
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let heldOpen = false;
  const HOLD_MS = 450;
  function holdStart() {
    if (recording) return;
    heldOpen = false;
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => {
      if (cameras.length > 1) { heldOpen = true; lensSheet = true; }
    }, HOLD_MS);
  }
  function holdEnd() { clearTimeout(holdTimer); }
  function flipTap() { if (heldOpen) { heldOpen = false; return; } flip(); }
  // Said once per device, and only to someone who has more than one lens. A tour on join would delay
  // the camera for everybody to teach a gesture most guests will never want; a single line at the
  // moment it is true costs nothing and is ignorable.
  const LENS_HINT = 'snap_lenshint';
  let lensHintTimer: ReturnType<typeof setTimeout> | undefined;
  $: if (screen === 'camera' && cameras.length > 1 && !lensHintTimer && typeof localStorage !== 'undefined') {
    try {
      if (!localStorage.getItem(LENS_HINT)) {
        // Deliberately delayed, and the "said it" flag is NOT written until it actually shows.
        // showToast is a single slot with no queue (lib/toast.ts), so a tip fired the instant the
        // camera appears is simply replaced by whatever the join flow says next — while the old
        // code had already recorded the tip as delivered. It was therefore spent, once per device,
        // on a toast nobody ever saw. 3.5s clears the 2.6s a toast lives for, and costs nothing:
        // the flip button carries a permanent dot (.round.has-more) for anyone looking sooner.
        lensHintTimer = setTimeout(() => {
          if (screen !== 'camera') return;
          showToast('Tip: hold the flip button to pick a lens');
          try { localStorage.setItem(LENS_HINT, '1'); } catch { /* ignore */ }
        }, 3500);
      }
    } catch { /* ignore */ }
  }

  // A favourite lens per DIRECTION. A phone with three rear lenses flips to whichever one the
  // browser feels like; someone who prefers the ultra-wide for the look of it had to open the
  // picker every single time. One favourite per side, so flip stays a single tap and lands where
  // they want it. Kept on the device — it is about this phone's lenses, not about any event.
  // The lens the platform hands back when we ask for a side and name no device — i.e. the normal
  // one. Kept per side, per device, because it is a fact about this phone's hardware.
  const NORMAL_LENS = 'snap_lensnormal';
  let normalLens: { user?: string; environment?: string } = {};
  try { normalLens = JSON.parse(localStorage.getItem(NORMAL_LENS) || '{}') || {}; } catch { normalLens = {}; }
  /** True for the lens this phone treats as standard on that side. */
  const isNormalLens = (c: { id: string; facing: string }) =>
    !!c.facing && normalLens[c.facing as 'user' | 'environment'] === c.id;

  const LENS_FAVS = 'snap_lensfav';
  let lensFavs: { user?: string; environment?: string } = {};
  try { lensFavs = JSON.parse(localStorage.getItem(LENS_FAVS) || '{}') || {}; } catch { lensFavs = {}; }
  // Only worth offering where there is a choice: one lens on a side has nothing to be preferred over.
  $: sideCounts = cameras.reduce((a, c) => { if (c.facing) a[c.facing] = (a[c.facing] || 0) + 1; return a; },
                                 {} as Record<string, number>);
  const canFavourite = (c: { facing: string }) => !!c.facing && (sideCounts[c.facing] || 0) > 1;
  // Reactive so the star repaints when a favourite changes — and it narrows `facing` away from '',
  // which is not a side and so can never have a favourite.
  $: isFav = (c: { id: string; facing: 'user' | 'environment' | '' }) =>
    !!c.facing && lensFavs[c.facing] === c.id;
  function toggleFav(c: { id: string; facing: 'user' | 'environment' | '' }) {
    if (!c.facing) return;
    // '' is "this guest wants no favourite on this side", which is a different answer from the key
    // being absent ("we have not worked one out yet"). Both are falsy, so flip treats them the same
    // and falls back to facingMode; only the auto-pick in attachCamera tells them apart.
    lensFavs = { ...lensFavs, [c.facing]: isFav(c) ? '' : c.id };
    try { localStorage.setItem(LENS_FAVS, JSON.stringify(lensFavs)); } catch { /* ignore */ }
  }

  // Holding opens a sheet with ONLY the lenses on it. Sending the guest into the full settings menu
  // to pick a camera is the long way round — the point of the gesture is that it is the short one.
  let lensSheet = false;
  async function chooseLens(id: string) { lensSheet = false; await pickCamera(id); }

  /** What the track says the lamp is doing, or null when it does not report a torch setting at all.
   *
   *  The null case matters: a browser can drive the torch perfectly well and still not list it in
   *  getSettings(). Treating a missing key as "off" would let us declare a working flash broken. */
  function readTorch(): boolean | null {
    try {
      const st = track?.getSettings?.() as { torch?: boolean } | undefined;
      return st && 'torch' in st ? !!st.torch : null;
    } catch { return null; }
  }

  // Said once, and only after the lamp has actually failed to light. Greys the button out too (via
  // torchSupported → flashUsable): a control that provably does nothing should not look live.
  function noteTorchRefused() {
    torchRefused = true;
    torchSupported = false;
    setFlash(false);
    if (torchToldOnce) return;
    torchToldOnce = true;
    showToast('This browser won’t let us use the flash.');
    reportClientError('camera: torch refused by browser', 'camera', ev?.joinCode);
  }

  /** The ⚡ button. Arms the flash for the next shot — and, mid-recording, drives the lamp there
   *  and then.
   *
   *  It used to only ever set the flag, so pressing it during a take did visibly nothing: the lamp
   *  was driven once at the start of the clip and once at the end, and the button in between was a
   *  control with no wire behind it. applyConstraints works on a live track and the recorder reads
   *  the same track regardless, so there is no reason it cannot follow along. */
  /** Remember the flash choice against the capture type in front of the guest. */
  function setFlash(on: boolean) {
    if (videoMode) flashVideo = on; else flashPhoto = on;
  }

  function toggleFlash() {
    // Read the new value from a local, not from flashArmed: that is a reactive derivation and does
    // not update until Svelte flushes, so driving the lamp off it here would use the OLD state.
    const on = !flashArmed;
    setFlash(on);
    if (recording && torchSupported && !ev?.noFlash) void setTorch(on);
  }

  // Drive the hardware torch on/off. Used as a flash pulse for photos and a continuous light for
  // video.
  //
  // This used to be one applyConstraints call with a bare catch, which failed in three ways at
  // once: it never checked whether the lamp obeyed, it only knew one of the two constraint
  // spellings, and when the lamp stayed ON there was no way back — a guest reported turning the
  // flash on in Brave and being unable to turn it off, with the app still showing it as off. The
  // lamp only died when they navigated away, which is the clue: releasing the track releases it.
  async function setTorch(on: boolean) {
    if (!track || !torchSupported) return;
    // `advanced` is the documented spelling and what Chrome wants; the plain form is what some
    // engines accept. Advanced constraints are also best-effort by definition, so a browser may
    // accept the call and do nothing — hence the read-back rather than trusting a resolved promise.
    for (const c of [{ advanced: [{ torch: on }] }, { torch: on }] as unknown as MediaTrackConstraints[]) {
      try { await track.applyConstraints(c); } catch { continue; }
      const got = readTorch();
      if (got === null || got === on) { torchOn = on; return; }
    }
    if (on) { noteTorchRefused(); return; }
    // Turning it OFF is the case we cannot simply give up on: a lamp stuck on drains the battery
    // and is alarming to be holding. Re-acquiring the stream physically releases it — the same
    // thing that happens on navigating away, which is how the guest eventually got theirs off.
    //
    // NOT while recording, though: startCamera() replaces the track the MediaRecorder is reading,
    // which would end the clip. A lamp that stays lit for the rest of a ten-second take is a far
    // smaller problem than losing the take, and the stop path turns it off a moment later anyway.
    if (recording) { torchOn = readTorch() !== false; return; }
    await startCamera();
    torchOn = readTorch() === true;
  }

  // Photo ↔ Video. Re-acquires the stream so each mode runs at its own resolution
  // (max-res stills vs smooth 1080p30 recording) and only grabs the mic for video.
  /** Ask for the MICROPHONE on its own, and do it inside the tap that wants it.
   *
   *  A browser only shows a permission prompt while the user gesture is still live. Camera
   *  acquisition is a CHAIN — exact lens, then any lens, then no audio — with awaits and a settle
   *  timer between attempts, so by the time a request that wants audio actually runs, the gesture
   *  has expired and Chrome answers NotAllowedError WITHOUT PROMPTING. The guest is then told to
   *  allow a microphone they were never asked about, and resetting site permissions does not help,
   *  because there is still no prompt to answer.
   *
   *  So: a bare audio request, cheap, first, and the only thing on screen when the prompt appears —
   *  which also means the question makes sense when it does. The track is stopped straight away; we
   *  are after the GRANT, and the real stream is acquired separately.
   *
   *  Must be called directly from a user gesture (a tap), and before any await that could outlive
   *  it. That is the whole point of it. */
  async function askForMic(): Promise<boolean> {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      micDenied = false; micReason = '';
      return true;
    } catch (e) {
      // Genuinely refused, or no microphone. Not fatal — video still records, silently — but it
      // does have to be SAID, or the guest gets a silent clip and no idea why. This is the only
      // place that learns it now that the prompt happens here rather than inside the camera chain.
      micReason = e instanceof DOMException ? e.name : '';
      // Work out WHICH problem this is before showing anything. diagnoseMic() resets micState to
      // 'unknown' on its way to an answer, so setting micDenied first meant the note appeared with
      // generic wording, then rewrote itself once the permission query came back — a box that
      // changes its mind twice while you are reading it. It is a fast local query; wait for it.
      await diagnoseMic();
      micDenied = true;
      return false;
    }
  }

  async function setMode(v: boolean) {
    if (recording || v === videoMode) return;
    // First time on video for this device: offer the capability check before they shoot anything
    // they cannot re-take. Measured once per event — see benchKey.
    // Ask for the MICROPHONE first, on its own, right here inside the tap.
    //
    // A browser only shows a permission prompt while the user gesture is still live. The camera
    // acquisition below is a chain — exact lens, then any lens, then no audio — with awaits and a
    // settle timer between the attempts, so by the time a request that wants audio actually runs,
    // the gesture has expired and Chrome answers NotAllowedError WITHOUT PROMPTING. The guest is
    // then told to allow a microphone they were never asked about, and resetting site permissions
    // does not help because there is still no prompt to answer.
    //
    // A bare audio request is cheap, happens in the gesture, and is the only thing on screen when
    // the prompt appears — so the question makes sense. We stop the track immediately; the grant is
    // what we are after, and the real stream is acquired below.
    // Flip the UI FIRST, then do the slow part.
    //
    // videoMode was set after the microphone request, so photo→video sat unhighlighted for as long
    // as the permission check took while video→photo — which asks for nothing — was instant. The
    // switch felt broken in one direction only, which is the tell.
    //
    // Optimistic is safe here: every failure path below already keeps video mode on and explains
    // itself, because a silent clip beats no clip. Nothing downstream needs the microphone answer
    // before the pill can move.
    videoMode = v;
    if (v && videoMaxSecs !== 0 && videoQuality !== 'phone') await askForMic();
    // Going back to photos puts the note away. It is about clips being silent, which is not a thing
    // that is true of a photo — leaving it up makes it read as a fault with the camera itself. It
    // comes back on the next switch to video, because by then it is true again.
    if (!v) { micDenied = false; }
    // A trick is a PHOTO prompt, so going into video puts the whole feature away: nothing armed,
    // no open list. The server is what actually enforces this — finalizeUpload drops the challenge
    // on any video upload, so a clip is kept but ticks nothing — and the camera hiding the option
    // is only the courtesy of not offering something that cannot count.
    // The reason it is photo-only at all: the feature runs on the roll being FINITE, so spending
    // one of a fixed number of shots on a trick is a real decision. A clip is a different currency
    // (seconds, usually paid) and one ten-second clip plausibly holds several tricks at once,
    // which would make ticking any one of them arbitrary.
    if (v) { armed = null; missionsOpen = false; }
    // Into video, assume nothing: applyRecordShape sets this from what the camera actually returns
    // once the stream is up. Starting from false means the viewfinder cannot frame to a shape that
    // has not been proven yet — including in 'phone' quality, which returns below without ever
    // acquiring a stream because the recording happens in an app we do not control at all.
    if (v) videoShapeLive = false;
    applyViewfinderAspect();   // the framing differs by mode; do not make them wait for a re-attach
    // Phone mode used to launch the native camera the instant you entered video mode. Entering a
    // mode is not the same as starting a recording — the guest is still choosing a shape, checking
    // the trick list, or pointing the thing — so it now behaves like every other quality: you get a
    // viewfinder, and the record button is what hands over. (toggleRecord does the handing over.)
    await startCamera();
    // Offer the capability check only once video is actually RUNNING. It used to be raised before
    // the switch was attempted, so a switch that failed and fell back to photos left a "check my
    // camera" panel on screen — still runnable, in photo mode, about a mode the guest is not in.
    // Once per EVENT: a skip counts as answered, so nobody is asked twice at the same party.
    if (v && videoMode) {
      try {
        pruneBenchmarks();
        // "No thanks" is a decision about this DEVICE, not about this party. Keeping it per-event
        // meant anyone who joins a second event — or who is trying the demo repeatedly — gets asked
        // again every time, which is how a helpful offer turns into something in the way.
        const never = localStorage.getItem(BENCH_NEVER) === '1';
        const raw = ev ? localStorage.getItem(benchKey(ev.joinCode)) : null;
        benchStored = !!raw;
        if (!raw && !never) benchPrompt = true;
      } catch { /* ignore */ }
    }
  }

  // Video quality is a per-device preference; lowering it helps weaker phones record smoothly.
  async function setVideoQuality(q: string) {
    if (q !== 'high' && q !== 'standard' && q !== 'smooth' && q !== 'phone') return;
    if (recording || q === videoQuality) return;
    videoQuality = q;
    lowFpsWarned = false;   // let a fresh warning fire if the new quality still struggles
    try { localStorage.setItem('snap_vidq', q); } catch { /* ignore */ }
    // PHONE mode has no resolution of ours to re-acquire — the recording happens in an app we do
    // not control. Note what this deliberately does NOT do: launch that app. Choosing an option in
    // a settings menu set the camera going immediately, which is a setting behaving like a button.
    // The two buttons that mean "start now" — the record button, and "Use phone camera" on the
    // capability prompt — call openNativeVideo themselves.
    // Nothing of ours to re-acquire for 'phone' — but if the preview is already dead (they just
    // backed out of the camera app) then leaving it that way makes a settings change look broken.
    if (q === 'phone') { resumeIfDead(); return; }
    if (videoMode) await startCamera();   // re-acquire at the new resolution
  }

  // Brightness is a CSS filter on the preview (and baked into photo capture).
  $: if (videoEl) videoEl.style.filter = brightness === 1 ? '' : `brightness(${brightness})`;
  // A camera that failed has no "playing" event coming, so the held frame would sit there for good,
  // looking like a live preview behind an error nobody can dismiss.
  $: if (cameraError) frozen = false;

  // Tap-to-focus: best-effort. Where the device exposes focus/exposure points of
  // interest we apply them; everywhere we show a focus ring for feedback.
  async function tapFocus(e: MouseEvent) {
    const host = e.currentTarget as HTMLElement;
    const rect = host.getBoundingClientRect();
    // Mirrored preview means the tap's x is mirrored too: without this, tapping someone's left
    // cheek focuses on their right. The ring itself is drawn in SCREEN space, so it is unaffected.
    const rawNx = (e.clientX - rect.left) / rect.width;
    const nx = facing === 'user' ? 1 - rawNx : rawNx;
    const ny = (e.clientY - rect.top) / rect.height;
    focusRing = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => (focusRing = null), 850);

    if (!track) return;
    const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>;
    const advanced: Record<string, unknown> = {};
    const focusModes = caps.focusMode as string[] | undefined;
    if (focusModes?.includes('single-shot')) advanced.focusMode = 'single-shot';
    else if (focusModes?.includes('continuous')) advanced.focusMode = 'continuous';
    if ('pointsOfInterest' in caps) advanced.pointsOfInterest = [{ x: nx, y: ny }];
    if (Object.keys(advanced).length) {
      try { await track.applyConstraints({ advanced: [advanced as MediaTrackConstraintSet] }); } catch { /* unsupported */ }
    }
  }

  // ── Brightness: drag a finger left/right across the viewfinder ──
  // A small HUD (level + reset) shows while dragging and lingers ~1.8s after release.
  // A tap (no real movement) falls through to tap-to-focus.
  let brightnessHud = false;
  // tracking: pointer is down; horizontal: we've committed to a horizontal brightness drag.
  // bSweeping: the drag has committed to the brightness axis. Not "horizontal" — which axis that
  // is depends on which way up the phone is being held; see onGesturePointerMove.
  let bTracking = false, bSweeping = false, bAbandoned = false;
  let bStartX = 0, bStartY = 0, bStartBright = 1;
  let bHudTimer: ReturnType<typeof setTimeout>;
  const BRIGHT_MIN = 0.5, BRIGHT_MAX = 1.6;

  function showHud() { clearTimeout(bHudTimer); brightnessHud = true; }
  function hideHudSoon() { clearTimeout(bHudTimer); bHudTimer = setTimeout(() => (brightnessHud = false), 1800); }

  function onGesturePointerDown(e: PointerEvent) {
    if (cameraError) return;
    bTracking = true; bSweeping = false; bAbandoned = false;
    bStartX = e.clientX; bStartY = e.clientY; bStartBright = brightness;
    // Don't capture yet — a vertical swipe must stay with the browser (pull-to-refresh / scroll).
  }
  function onGesturePointerMove(e: PointerEvent) {
    if (!bTracking || bAbandoned) return;
    const rawX = e.clientX - bStartX, rawY = e.clientY - bStartY;

    // Brightness follows the HAND, not the document.
    //
    // It is a sideways sweep — across the picture, the way a native camera does exposure. That is a
    // page-X drag only while the page is the same way up as the person. Hold a phone sideways with
    // its rotation locked and the page does not turn, so the person's sideways is the page's
    // VERTICAL: sweeping across the picture produced no brightness change at all, and the direction
    // that did work ran up and down, which is the "feels vertical" of it. Worse, the sweep they
    // meant was being read as a vertical drag and handed back to the browser as a scroll.
    //
    // The RELATIVE rotation, not the phone's absolute one. Turn a phone with auto-rotate on and the
    // whole browser turns with it — page-sideways and person-sideways stay the same thing, and
    // swapping the axes there would break the case that already worked. Only a phone turned inside
    // a page that did NOT turn needs the swap, and glyphRot is exactly that quantity: it is zero
    // whenever the layout has already followed the device. (It is also why the glyphs only
    // counter-rotate in that same case.)
    const rel = glyphRot;
    const along  = rel === -90 ? -rawY : rel === 90 ? rawY : rawX;   // the brightness axis
    const across = rel === 0 ? rawY : rawX;                          // the scroll axis, left to the browser

    const el = e.currentTarget as HTMLElement;
    // Sensitivity must not depend on which way up the phone is. Dividing by the element's WIDTH
    // meant that turning the phone — where the width goes from about 390 to 844 — more than halved
    // how much a given sweep did, so the control did not feel different, it felt dead. The short
    // edge is the same number in either orientation, so the gesture is too.
    const vw = el.clientWidth || window.innerWidth;
    const vh = el.clientHeight || window.innerHeight;
    const extent = Math.min(vw, vh) || 360;

    if (!bSweeping) {
      // Decide direction once past a small threshold. Across → hand it back to the browser.
      if (Math.abs(across) > 8 && Math.abs(across) >= Math.abs(along)) { bAbandoned = true; return; }
      if (Math.abs(along) > 8 && Math.abs(along) > Math.abs(across)) {
        bSweeping = true;
        try { el.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      } else return;
    }
    const next = bStartBright + (along / extent) * 1.5;
    brightness = Math.round(Math.min(BRIGHT_MAX, Math.max(BRIGHT_MIN, next)) * 100) / 100;
    showHud();
  }
  function onGesturePointerUp(e: PointerEvent) {
    if (!bTracking) return;
    const wasSweeping = bSweeping, abandoned = bAbandoned;
    bTracking = false; bSweeping = false; bAbandoned = false;
    if (wasSweeping) { hideHudSoon(); return; }
    if (!abandoned && focusSupported) tapFocus(e as unknown as MouseEvent);   // a tap → focus
  }
  function resetBrightness() { brightness = 1; showHud(); hideHudSoon(); }

  function toggleFullscreen() {
    const el = document.getElementById('cam-root');
    if (document.fullscreenElement) document.exitFullscreen();
    else el?.requestFullscreen?.().catch(() => {});
  }

  /** Pin the app upright, for real, where the platform allows it.
   *
   *  screen.orientation.lock() is refused outright in an ordinary browser tab — a page cannot
   *  decide which way up the phone is held. It IS allowed once the document is fullscreen, which
   *  this camera can be, so "keep it upright" is a genuine capability here rather than a request we
   *  pass on to the guest. (The manifest asks for portrait too, which covers the installed-app case
   *  and nothing else.)
   *
   *  iOS Safari has never shipped the API at all, so there the offer is simply not made — see
   *  canLockPortrait. Offering a button that cannot work is worse than offering nothing. */
  let goingFullscreen = false;
  /** Offer it only where it can be done. iOS Safari will not take an arbitrary element fullscreen —
   *  only a <video> — so there the button is simply absent, which is better than one that does
   *  nothing when pressed. */
  const canGoFullscreen = () => typeof document !== 'undefined'
    && typeof document.documentElement.requestFullscreen === 'function';

  /** Wait for fullscreen to actually BE fullscreen.
   *
   *  requestFullscreen() resolves when the request is accepted, which is not the same moment the
   *  document is fullscreen — and orientation.lock() refuses outright unless it already is. Calling
   *  one straight after the other therefore loses the race on a real phone: the screen goes
   *  fullscreen and the lock throws, which is exactly what it did. Wait for the event instead, with
   *  a timeout so a browser that never fires it cannot hang the button. */
  function fullscreenSettled(): Promise<void> {
    if (document.fullscreenElement) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { document.removeEventListener('fullscreenchange', done); clearTimeout(t); resolve(); };
      const t = setTimeout(done, 700);
      document.addEventListener('fullscreenchange', done);
    });
  }

  /** Go fullscreen, and try to pin the rotation while we are there.
   *
   *  The button used to say it would lock the phone to portrait, and on a real Android it went
   *  fullscreen and then the lock threw — so it delivered something useful while announcing a
   *  failure. The two are not equally reliable: fullscreen works, and screen.orientation.lock() is
   *  refused by plenty of phones even from inside fullscreen (notably any phone whose OWN rotation
   *  lock is already on). So the button promises the part that works, and the lock is attempted
   *  quietly as a bonus. Nothing is said if it does not happen, because nothing was claimed. */
  async function goFullscreen() {
    goingFullscreen = true;
    try {
      const el = document.getElementById('cam-root');
      if (!document.fullscreenElement) {
        await el?.requestFullscreen?.();
        await fullscreenSettled();
      }
      if (!document.fullscreenElement) throw new Error('refused');
      landscapeDismissed = true;
      // Opportunistic, and deliberately not awaited into the failure path above.
      try {
        await (window.screen?.orientation as unknown as { lock?: (o: string) => Promise<void> } | undefined)
          ?.lock?.('portrait');
      } catch { /* most phones refuse; fullscreen was the point */ }
    } catch {
      showToast('Your browser wouldn’t go fullscreen — turning the phone upright is the other fix.', true);
    } finally { goingFullscreen = false; }
  }

  /** The shape the viewfinder is actually FRAMED to, as a CSS aspect-ratio, or '' when it is showing
   *  the whole sensor frame.
   *
   *  One source of truth, because two things are sized from it: the video element, and the
   *  rule-of-thirds grid. The grid used to be pinned to the viewfinder's full box while the video sat
   *  letterboxed inside it — so with any shape selected the thirds were thirds of the SCREEN, not of
   *  the picture, which is both useless for composing and visibly out of square with the frame.
   *
   *  Deliberately reads videoShapeLive rather than the requested shape: in video mode the crop only
   *  exists where the camera agreed to it, and drawing a framed grid over an unframed picture would
   *  be the same lie applyViewfinderAspect exists to avoid.
   *
   *  A PLAIN FUNCTION, with the reactive value derived from it — not the other way round. The
   *  reactive statement alone was not enough: setAspect() assigns `aspect` and then calls
   *  applyViewfinderAspect() in the same synchronous block, and Svelte has not recomputed anything
   *  by then. So the video was sized from the PREVIOUS shape while the grid, being bound in the
   *  markup, had already moved to the new one — changing the shape appeared to resize the grid and
   *  leave the picture alone. The function gives the imperative caller today's answer; the reactive
   *  line keeps the markup in step. */
  function toggleGrid() {
    gridOn = !gridOn;
    try { localStorage.setItem('snap_grid', gridOn ? '1' : '0'); } catch { /* the choice just will not stick */ }
  }

  const framedFor = (a: string): string =>
    a !== 'full' && (!videoMode || videoShapeLive) ? a.replace(':', ' / ') : '';
  $: framedAspect = framedFor(aspect);

  function applyViewfinderAspect() {
    if (!videoEl) return;
    const s = videoEl.style;
    // Always fill the screen width. 'full' fills the whole viewport; fixed ratios
    // are pinned to full width and centre-cropped vertically (taller ratios overflow
    // and are clipped by the viewfinder, shorter ones letterbox) — matching capture.
    //
    // VIDEO IS FRAMED ONLY ONCE THE CROP IS REAL. A photo is always cropped (cropRect, at the
    // shutter). A clip is cropped by the CAMERA, and only where the browser honours the aspectRatio
    // constraint — applyRecordShape asks, reads back what turned up, and sets videoShapeLive from
    // that. Where it did not take, this stays unframed and shows the frame that will actually be
    // recorded, which is what a guest lining a shot up is entitled to. The framing is drawn from
    // the verified fact and never from the request: promising a crop nothing performs is the bug
    // this whole mechanism exists to keep buried.
    s.objectFit = 'cover';
    s.width = '100%';
    s.maxWidth = '100%';
    s.maxHeight = '';
    const framed = framedFor(aspect);   // computed now, not last tick — see framedFor
    if (!framed) { s.aspectRatio = ''; s.height = '100%'; }
    else { s.aspectRatio = framed; s.height = 'auto'; }
  }

  /** Make the CAMERA deliver the chosen shape, so a clip is genuinely cropped to it.
   *
   *  Photos are cropped into a canvas at capture. A clip cannot be: MediaRecorder records whatever
   *  the track hands it, frame for frame. So crop the TRACK instead — `aspectRatio` is a real
   *  constraint, and where a browser honours it the frames arrive already centre-cropped, with no
   *  canvas in the path, no second encoder on a phone that is already struggling to run one, and no
   *  re-encode of the original on the server. Measured on Chromium against a live track: the call
   *  returns in ~1ms, a 1920×1080 stream becomes 1080×1080, the recorded FILE comes out 1080×1080,
   *  and the preview frame rate does not move. The crop is a true centre crop, verified against a
   *  bar pattern — the outer bars are gone, not squeezed in.
   *
   *  Nothing here is taken on trust. We ask, then read `getSettings()` back, because a browser may
   *  honour the constraint, refuse it outright, or accept it and quietly do nothing — and on a
   *  phone there is no way to know in advance which. Only a ratio that actually arrived turns the
   *  framing on.
   *
   *  Deliberately NOT folded into the getUserMedia constraints in startCamera(): an
   *  OverconstrainedError there drops into the retry chain and costs the guest their chosen lens,
   *  and on the last rung their facing. Applied to a live track, a refusal is caught right here and
   *  changes nothing about the stream they are already looking through.
   *
   *  The constraint set is rebuilt IN FULL every time, because applyConstraints REPLACES a track's
   *  constraints rather than merging into them: leave the resolution ceiling or the frame rate out
   *  and they go with it. That same replacement is what clears a previous crop back off for 'Full'.
   */
  async function applyRecordShape(): Promise<void> {
    // A photo has its own crop and wants the sensor's biggest frame, so this is a video-mode affair
    // only. Recording is excluded because resizing a track mid-clip is a resolution change the
    // recorder never agreed to.
    if (!videoMode || recording || !track) { videoShapeLive = false; return; }
    const target = aspectValue(aspect);
    const q = VQ_RES[videoQuality === 'phone' ? 'standard' : videoQuality];
    const base: MediaTrackConstraints = { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: 30 } };
    // 'Full' is not a shape to ask for, it is the absence of one — apply the bare set so any crop
    // left on the track by a previous choice comes off again.
    if (target === null) {
      try { await track.applyConstraints(base); } catch { /* it keeps what it has, which is uncropped either way */ }
      videoShapeLive = false;
      matchRecBitrate(); applyViewfinderAspect();
      return;
    }
    // `exact` first: it is the only form a browser must either honour or refuse, so a success is
    // worth something. `ideal` second, for stacks that reject exact but will still crop when asked
    // nicely — and whose "success" therefore has to be checked rather than believed.
    for (const aspectRatio of [{ exact: target }, { ideal: target }]) {
      try { await track.applyConstraints({ ...base, aspectRatio }); } catch { continue; }
      const got = track.getSettings?.() ?? {};
      if (shapeDelivered(got.width, got.height, target)) {
        videoShapeLive = true;
        videoShapeSupported = true;
        matchRecBitrate();       // a different-sized frame: the bitrate was sized for the old one
        applyViewfinderAspect();
        return;
      }
    }
    // The camera will not do it. Put the track back to a plain frame so that what is recorded and
    // what is shown are at least the same thing, and stop offering a control that cannot deliver.
    try { await track.applyConstraints(base); } catch { /* ignore */ }
    videoShapeLive = false;
    noteShapeRefused();
    matchRecBitrate();
    applyViewfinderAspect();
  }

  // Said once, and only to a guest who asked for something we could not give them. The report is
  // also the only way we ever learn whether real phones honour the constraint: a headless browser's
  // fake camera says nothing about a Samsung, and this is the field evidence that would.
  function noteShapeRefused() {
    videoShapeSupported = false;
    if (videoShapeToldOnce) return;
    videoShapeToldOnce = true;
    showToast('This camera records full frame — clips won’t be cropped to a shape.');
    reportClientError(`camera: aspectRatio not honoured for video (${aspect})`, 'camera', ev?.joinCode);
  }

  // A sheet, not a cycle. With five shapes enabled — which every demo has — reaching Square from
  // Full meant four taps and a guess at what came next, each one re-cutting the camera track. The
  // shapes are a short, known list, so show them and let the guest pick the one they want.
  let shapeSheet = false;
  async function pickAspect(a: string) {
    shapeSheet = false;
    if (a === aspect) return;
    await setAspect(a);
  }
  /** The shape this guest last chose, device-wide like the video quality. '' when they never have. */
  function savedAspect(): string {
    try { return localStorage.getItem('snap_aspect') || ''; } catch { return ''; }
  }

  async function setAspect(a: string) {
    aspect = a;
    try { localStorage.setItem('snap_aspect', a); } catch { /* the choice just will not stick */ }
    // A photo crops in the canvas, so the new framing is true the instant it is picked. In video the
    // camera has to agree first — drop the framing until applyRecordShape has read the answer back,
    // rather than flicking to the new shape and possibly away from it again.
    if (videoMode) videoShapeLive = false;
    applyViewfinderAspect();
    await applyRecordShape();
  }

  /** The shutter, pressed with nothing left on the roll.
   *
   *  It is `aria-disabled`, not `disabled`, so this is reached — and that is the point. A disabled
   *  button consumes NOTHING: the tap falls through to the viewfinder behind it, and on a phone the
   *  browser reads that as the start of a text selection and throws its own Copy/Search menu over
   *  the app. On the most-pressed control in the product, the answer to "why did nothing happen"
   *  was a system context menu.
   *
   *  So it answers, and answers with the way out rather than with a complaint: where there is an
   *  "ask the host / buy more" panel on screen, focus goes to it — the person is taken to what is
   *  blocking them, which is the rule in docs/DEVELOPMENT.md. Where there is not, they are at least
   *  told, which is strictly more than a dead tap. */
  function announceNoShots() {
    const cta = oosPanelEl?.querySelector('button') as HTMLButtonElement | null;
    if (cta) {
      showToast("That's your roll — here's how to get more.");
      oosPanelEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      cta.focus();
    } else {
      showToast("That's your roll — no shots left.", true);
    }
  }

  async function capturePhoto() {
    // Guard: one capture at a time, and ONLY when the camera is truly live (a real frame is
    // decoded). Without the readiness check a failed camera (e.g. incognito) could still "take" a
    // blank shot and burn a snap — discard instead.
    //
    // The two states the BUTTON advertises are answered out loud; the rest stay silent, because
    // they are either transient (a double tap mid-capture) or already on screen (cameraError is
    // rendered as a panel).
    if (photosRemaining <= 0) { announceNoShots(); return; }
    if (capturing || cameraError || !stream || !videoEl || !videoEl.videoWidth) return;
    capturing = true;
    // Hardware flash: pulse the torch on and give auto-exposure a moment to settle before the shot.
    // The preference is one thing; how to light the shot is another. A lamp if this camera has
    // one, otherwise the screen itself on the selfie camera — which is the only light a front
    // camera has ever had.
    const wantFlash = flashArmed && !ev?.noFlash;
    const useTorch = wantFlash && torchSupported;
    const useFill = wantFlash && !torchSupported && facing === 'user';
    try {
      if (useTorch) { await setTorch(true); await new Promise((r) => setTimeout(r, 260)); }
      if (useFill) { fillActive = true; await new Promise((r) => setTimeout(r, 320)); }
      const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
      const { sx, sy, sw, sh } = cropRect(vw, vh, aspectValue(aspect));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(sw); canvas.height = Math.round(sh);
      const ctx = canvas.getContext('2d')!;
      if (brightness !== 1) ctx.filter = `brightness(${brightness})`;
      if (facing === 'user') { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
      ctx.drawImage(videoEl, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      fillActive = false;
      shutterBlink();   // the frame is grabbed: this is the moment the photo exists
      // Maximum quality — capture at native resolution with JPEG quality 1.0 (no perceptible
      // compression). We don't downscale; big files are fine per product direction.
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 1.0));
      if (blob) enqueue(blob, 'photo', 'jpg', 'capture', { w: canvas.width, h: canvas.height });
    } finally {
      // Keyed on the lamp, not on our intent: if the guest disarmed the flash mid-shot, `useFlash`
      // is already false and the lamp would have been left burning.
      if (torchOn) setTorch(false);
      capturing = false;
    }
  }

  // One deferred start at most. Without it, an impatient double-press while the previous clip is
  // still flushing would queue two starts and the second would fight the first.
  let startPending = false;

  async function toggleRecord() {
    // aria-disabled on the button, so this is reached while the camera is broken. Say so rather
    // than swallowing the press — the error panel may be scrolled out of view.
    if (cameraError) { showToast(cameraError, true); return; }
    // "Use my own camera" has to mean it everywhere, not just on the switch into video mode.
    // setMode() honoured it; this did not — so the setting persisted, the settings sheet said
    // "my own camera", and pressing record quietly recorded in the browser anyway. Which is the
    // one thing the guest had just chosen not to do, and they chose it because in-browser
    // recording was stuttering on their phone.
    if (!recording && videoQuality === 'phone') { openNativeVideo(); return; }
    if (!stream) return;
    if (!recording) {
      // A NEW RECORDER MUST NOT BE BUILT WHILE THE PREVIOUS ONE IS STILL FLUSHING. Both would sit
      // on the same audio track, and starting a second encoder on it makes the first one's buffered
      // tail unreachable — it is simply dropped. The video survives because it has already been
      // handed over frame by frame, so what lands is a complete picture with the last second of
      // sound missing, and no gap anywhere to show where it went.
      //
      // This is why the clips that lost audio were the ones stopped and restarted quickly: the
      // faster the restart, the more of the tail was still in the encoder when it got taken away.
      // Waiting costs a few tens of milliseconds and only ever after a just-finished clip.
      if (recFlush) {
        if (startPending) return;
        startPending = true;
        try { await recFlush; } finally { startPending = false; }
        if (recording || !stream) return;   // the world may have moved while we waited
      }
      // Codec order matters more than any quality setting here, and it was backwards. VP8 was
      // preferred first, which is the one format phones cannot decode in hardware — a 4K VP8 clip
      // is decoded on the CPU and stutters on playback even though the recording is perfect (it
      // plays fine on a laptop, which is what makes it look like a recording fault). Worse, Safari
      // will not reliably play VP8/WebM at all, so iPhone guests could be unable to watch a clip
      // that recorded without error.
      //
      // H.264 in MP4 has a hardware decoder on essentially every phone made in the last decade and
      // plays everywhere including iOS. VP9 is the next best — hardware decode on most modern
      // Android. VP8 stays last, as the fallback it should always have been.
      const types = [
        'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
        'video/mp4;codecs=avc1',
        'video/mp4',
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm',
        '',
      ];
      const mime = types.find((m) => m === '' || MediaRecorder.isTypeSupported(m));
      chunks = [];
      // Bitrate matched to the live stream (matchRecBitrate); crisp without overwhelming the encoder.
      // 192k AAC, up from 128k. The picture is given a bitrate matched to what the sensor is actually
    // producing (matchRecBitrate, up to 40Mbit); spending another 64kbit on the sound is nothing
    // beside that, and 128k is where stereo music starts to audibly smear.
    const recOpts: MediaRecorderOptions = { videoBitsPerSecond: recBitrate, audioBitsPerSecond: 192_000 };
      if (mime) recOpts.mimeType = mime;
      mediaRecorder = new MediaRecorder(stream, recOpts);
      mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      mediaRecorder.onstop = () => {
        const secs = recSecs;
        const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || 'video/webm' });
        const ext = (mediaRecorder?.mimeType || '').includes('mp4') ? 'mp4' : 'webm';
        enqueue(blob, 'video', ext, 'capture', { durationSecs: secs });
      };
      mediaRecorder.start();
      if (flashArmed && torchSupported && !ev?.noFlash) setTorch(true);   // continuous light for the clip
      recording = true; recSecs = 0;
      startFpsMonitor();
      recTimer = setInterval(() => {
        recSecs++;
        if (videoMaxSecs > 0 && recSecs >= videoMaxSecs) toggleRecord();
      }, 1000);
    } else {
      stopRecorder();   // tracked, so the quality re-acquire below waits for the flush
      if (torchOn) setTorch(false);
      stopFpsMonitor();
      recording = false; clearInterval(recTimer);
      // A FRESH STREAM PER CLIP WAS TRIED HERE AND MADE IT WORSE. Do not put it back.
      //
      // Clips record with their sound ahead of their picture, and the audio track ends short by
      // exactly the amount it is out. The obvious reading is that the camera is the slow one, so
      // this re-acquired the stream after every clip to hand the next one fresh tracks. Six clips
      // recorded that way came out -0.026, -0.175, -0.820, -0.853, -0.918 and -0.997 — five of six
      // bad, against two of five before the change.
      //
      // It is the MICROPHONE that is slow, not the camera. The mic takes up to a second to deliver
      // its first sample, the muxer rebases the audio track to zero regardless, and everything it
      // recorded lands that far early. So a just-acquired stream is the WORST thing to record on,
      // not the best, and the clips that used to come out clean were the ones where the stream had
      // been alive long enough for the mic to warm up. Re-acquiring guaranteed a cold one every
      // time. The lead is bounded — it clusters at ~1s, which is the wake-up, not drift.
      //
      // The correction lives at ingest instead (audioLeadFrom in app/src/server/images.ts), where
      // it costs the guest nothing. Leave the stream alone.
      if (pendingQuality) { const q = pendingQuality; pendingQuality = null; setVideoQuality(q); }
      processQueue();   // recording is over — let the queue move again
    }
  }

  // Low-frame-rate detection: count frames actually presented (requestVideoFrameCallback) over the
  // first ~2.5s of recording. If it's well under the target, suggest dropping the video quality.
  let fpsHandle = 0, fpsFrames = 0, fpsStart = 0;
  let fpsCheckTimer: ReturnType<typeof setTimeout>;
  type RVFCVideo = HTMLVideoElement & {
    requestVideoFrameCallback?: (cb: () => void) => number;
    cancelVideoFrameCallback?: (h: number) => void;
  };
  function startFpsMonitor() {
    const v = videoEl as RVFCVideo | null;
    if (!v?.requestVideoFrameCallback) return;   // unsupported (older browsers) → skip silently
    fpsFrames = 0; fpsStart = performance.now();
    const tick = () => { fpsFrames++; fpsHandle = v.requestVideoFrameCallback!(tick); };
    fpsHandle = v.requestVideoFrameCallback(tick);
    fpsCheckTimer = setTimeout(checkFps, 2500);
  }
  function checkFps() {
    const secs = (performance.now() - fpsStart) / 1000;
    const fps = secs > 0 ? fpsFrames / secs : 60;
    if (fps < 20 && videoQuality === 'smooth') {
      // Nothing left to downgrade to. Previously this said nothing, leaving the guest with a bad
      // clip and no idea there was another way to do it.
      videoStruggling = true;
      if (!lowFpsWarned) {
        lowFpsWarned = true;
        showToast('Your phone is struggling to record here — try shooting with its own camera app instead.', true);
      }
    } else if (fps < 20 && !lowFpsWarned && videoQuality !== 'smooth') {
      lowFpsWarned = true;
      // Auto-downgrade one step; applied after this clip finishes (re-acquiring mid-record would cut it).
      pendingQuality = videoQuality === 'high' ? 'standard' : 'smooth';
      videoStruggling = true;
      showToast(`Recording looks choppy — dropping to ${pendingQuality === 'standard' ? '1080p' : '720p'}. You can also shoot with your phone's own camera.`, true);
    }
  }
  function stopFpsMonitor() {
    const v = videoEl as RVFCVideo | null;
    if (fpsHandle && v?.cancelVideoFrameCallback) v.cancelVideoFrameCallback(fpsHandle);
    fpsHandle = 0; clearTimeout(fpsCheckTimer);
  }

  // `source` decides which video-length rule the SERVER applies. In-app capture auto-stops at the
  // event's limit, so it is held to it strictly; a clip picked from the camera roll was shot outside
  // the app (often deliberately, for 4K the browser cannot manage) and cannot be re-trimmed, so the
  // server keeps it even when it runs over. Defaults to 'capture' — the strict side.
  /* ── Offering the home-screen install ──────────────────────────────────────
     Offered the MOMENT Chrome hands us a prompt to fire, not after some number of shots.
     Installing is only worth anything for the event still to come, so every shot taken before the
     offer is benefit the guest never gets — and a counter cannot know when the offer is even
     possible. Chrome decides that, by firing beforeinstallprompt once the install criteria and its
     own engagement heuristic are met; until then there is nothing to show, and after it there is no
     reason to wait. So the trigger is that event, and the only question left is whether the guest
     is in a position to see it.

     Chrome's own banner is suppressed by initInstall(), so this is the only prompt they get.
     Tracked per event (see pwa.ts) — a different event is a fair second ask, the same one is not. */
  let installOffer = false;
  let installHelp = false;     // iOS: the Share-menu instructions, since there is no button to press
  // Read once on mount rather than reactively: neither answer changes while the camera is open, and
  // both touch APIs that do not exist during SSR.
  let installedAlready = false;
  let iosInstall = false;

  function maybeOfferInstall() {
    if (installOffer || isStandalone()) return;
    if (!$canInstall) return;          // iOS, or Chrome has not handed us a prompt to defer yet
    // Only when it can actually be READ. Showing it marks the event asked, and the offer is final
    // for that event — so a strip that appears behind the settings sheet, under the spinner, or
    // mid-clip is not a missed impression, it is the guest's one chance spent without them ever
    // seeing it.
    if (screen !== 'camera' || cameraStarting || recording || settingsOpen) return;
    const code = ev?.joinCode;
    if (!code || askedAlready(code)) return;
    markAsked(code);
    installOffer = true;
  }

  // Re-evaluated whenever any of these change, so a prompt that arrives while the guest is in the
  // gallery, mid-recording or under the settings sheet is held and offered the moment they are back
  // on the camera, rather than being dropped because it turned up at an awkward time.
  $: if ($canInstall && ev && screen === 'camera' && !cameraStarting && !recording && !settingsOpen) {
    maybeOfferInstall();
  }

  async function doInstall() {
    installOffer = false;
    const r = await promptInstall();
    if (r === 'accepted') showToast('Snapdini added to your home screen');
  }

  function enqueue(blob: Blob, mediaType: 'photo' | 'video', ext: string, source: 'capture' | 'upload' = 'capture', extra?: { durationSecs?: number; w?: number; h?: number }) {
    // Read at the moment of the shot and carried on the item, never read again at upload time: a
    // queued capture can sit in IndexedDB across a reload and go up hours later, by which point the
    // phone's current orientation says nothing about how this was framed. 'unknown' is not sent —
    // absent and unknown are the same claim, and the server stores NULL for both.
    const shotAs = source === 'capture' ? captureOrientation() : 'unknown';
    // The shape ASKED for, recorded whether or not the camera obliged. A photo is cropped here in
    // the canvas and always arrives correct, so it has nothing to record; a clip is cropped by the
    // camera, which on iOS and Firefox simply declines — and then this is the only surviving trace
    // that the guest chose a shape at all, and the only thing that lets the server finish the job.
    const shotShape = mediaType === 'video' && source === 'capture' ? aspect : undefined;
    // Whatever was armed at the moment of the shot, not at the moment of upload: a guest may well
    // arm the next mission while this one is still going up.
    const challengeId = armed ?? undefined;
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    queue = [...queue, { id, blob, mediaType, source, ext, status: 'pending', size: blob.size, challengeId,
                         captureOrientation: shotAs === 'unknown' ? undefined : shotAs,
                         captureShape: shotShape, ...extra }];
    trackEvent('photo_captured', { kind: mediaType, source }, ev?.joinCode);
    // Persist to IndexedDB immediately so the capture survives an outage / reload / closed tab.
    if (sessionToken && ev) putCapture({ id, joinCode: ev.joinCode, sessionToken, blob, mediaType, source, ext, createdAt: Date.now() }).catch(() => {});
    if (saveToDevice) saveToDeviceCopy(blob, ext);
    // Celebrate NOW, not when the upload lands. By this line the shot is in the queue and on its way
    // into IndexedDB, so the trick really is pulled off — the guest is holding a finished thing.
    // Waiting on the network made that feel like the app was lagging behind them, worst exactly
    // where connections are worst: a hall full of people on one tower. If the upload turns out to be
    // impossible, untickMission() takes it back rather than leaving a tick that is a lie.
    if (challengeId && !missionsDone.includes(challengeId)) {
      missionsDone = [...missionsDone, challengeId];
      missionsDoneLocal = [...missionsDoneLocal, challengeId];
      confetti?.burst();
      const left = missions.filter((m) => !missionsDone.includes(m.id)).length;
      showToast(left ? `Nice one — ${left} to go` : 'That’s the whole act. Well done.');
      trackEvent('mission_captured', { left }, ev?.joinCode);
    }
    // Disarm either way: the next shot should be an ordinary one unless they say otherwise.
    if (challengeId && armed === challengeId) armed = null;
    processQueue();
  }

  // A photo that can never reach the server must not keep its tick: progress is derived from the
  // photos table, so the next reload would silently disagree with what the guest is looking at.
  function untickMission(challengeId: string | undefined) {
    if (!challengeId || !missionsDone.includes(challengeId)) return;
    missionsDone = missionsDone.filter((m) => m !== challengeId);
    // Both, or the next refresh would put it straight back.
    missionsDoneLocal = missionsDoneLocal.filter((m) => m !== challengeId);
  }

  function saveToDeviceCopy(blob: Blob, ext: string) {
    try {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `snapdini-${Date.now()}.${ext}`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch { /* download blocked — ignore */ }
  }

  let nativeVideoInput: HTMLInputElement;

  /** Open the phone's own camera app — after giving it back the hardware.
   *
   *  Android Chrome refuses the capture intent with "you can't use the camera while you're in a
   *  call" when the page still holds camera and mic. There is no call: the objection is to OUR
   *  getUserMedia, and the phone cannot tell the difference. So hand the devices back first.
   *
   *  Releasing is safe because the way back is already covered from both directions —
   *  nativeVideoPicked fires resumeIfDead whether or not they filmed anything, and
   *  visibilitychange catches the browsers that suspend us during the handoff.
   *
   *  stopCamera() is used rather than releaseStream() so an in-flight recording still gets to
   *  flush its audio tail; in that case it releases on the flush, a moment after the picker is
   *  already up, which is still well before they start filming. */
  /** Disarms the pending "they came back" listeners; null when none are armed. */
  let nativeWake: (() => void) | null = null;

  /** Bring the viewfinder back when they return from the phone's camera app.
   *
   *  `change` fires ONLY when they actually filmed something. Back out of the camera app and the
   *  input says nothing whatsoever — so, now that we hand the hardware over on the way in, a
   *  cancelled capture left the guest holding a black viewfinder with nothing to say it needed a
   *  nudge. The only way back was to go and change a setting.
   *
   *  Three signals, because no one of them fires everywhere: `cancel` is the modern, exact one;
   *  `visibilitychange` (wired in onMount) catches the phones that suspend us during the handoff;
   *  window focus catches whatever does neither. resumeIfDead is idempotent and acts only when the
   *  stream is genuinely gone, so arriving here three times costs nothing. */
  function armNativeRecovery() {
    nativeWake?.();   // never leave a previous arming attached
    const wake = () => {
      nativeWake = null;
      window.removeEventListener('focus', wake);
      nativeVideoInput?.removeEventListener('cancel', wake);
      // A beat first: the camera app has to actually let go of the devices before we ask for them.
      setTimeout(resumeIfDead, 300);
    };
    nativeWake = () => {
      nativeWake = null;
      window.removeEventListener('focus', wake);
      nativeVideoInput?.removeEventListener('cancel', wake);
    };
    window.addEventListener('focus', wake);
    nativeVideoInput?.addEventListener('cancel', wake);
  }

  function openNativeVideo() {
    stopCamera();
    armNativeRecovery();
    nativeVideoInput?.click();   // must stay in the same synchronous gesture or the click is ignored
  }

  // Read a video file's duration (seconds) via a throwaway <video> element. 0 if unreadable.
  function readVideoDuration(file: File): Promise<number> {
    return new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      const done = (d: number) => { try { URL.revokeObjectURL(v.src); } catch { /* */ } resolve(isFinite(d) && d > 0 ? d : 0); };
      v.onloadedmetadata = () => done(v.duration);
      v.onerror = () => done(0);
      try { v.src = URL.createObjectURL(file); } catch { resolve(0); }
    });
  }

  // Native-camera fallback: the guest shoots with their phone's own camera app, then we upload the
  // file through the same queue (chunked if large). Enforces the event's length limit BEFORE upload
  // (the server enforces it too). Still counts as one shot.
  async function nativeVideoPicked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';   // allow re-picking the same file
    // Whatever else happens below — even if they backed out without filming — the phone's camera
    // app has had the hardware, so take it back. Not every browser fires visibilitychange for that
    // handoff, which is why this does not rely on it.
    setTimeout(resumeIfDead, 300);
    if (!file) return;
    if (photosRemaining <= 0) { showToast('No shots left on your roll', true); return; }
    const dur = await readVideoDuration(file);
    // Only the server's absolute ceiling is a hard stop. The event's own limit is a price tier, and
    // the server keeps over-length clips (a guest filming the speeches cannot re-trim them at 1am),
    // so blocking here would refuse an upload the server would happily have accepted — which is
    // exactly what the old `+1s` check did, while the server allowed `+3s`.
    if (videoHardMaxSecs > 0 && dur > videoHardMaxSecs) {
      showToast(`That clip is ${Math.round(dur / 60)} min — the most we can take is ${Math.round(videoHardMaxSecs / 60)} min. Trim it and try again.`, true);
      return;
    }
    // Deliberately SILENT when a camera-roll clip runs over the event's limit. The event info
    // already states "clips up to Ns", which is the nudge to match it; announcing that we keep
    // longer ones anyway would just teach people the limit is optional. It is allowed quietly —
    // the guest keeps their moment, and the limit keeps its meaning.
    const ext = (file.name.split('.').pop() || 'mp4').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 4) || 'mp4';
    enqueue(file, 'video', ext, 'upload', dur ? { durationSecs: Math.round(dur) } : undefined);
    showToast('Uploading your video…');
  }

  // Restore any captures still queued in IndexedDB (from a previous session / outage).
  async function restoreQueue() {
    if (!ev) return;
    try {
      const stored = await listCaptures(ev.joinCode);
      const have = new Set(queue.map((q) => q.id));
      const fresh = stored.filter((s) => !have.has(s.id));
      // Pull each capture's chunk-resume state so a big upload continues where it left off.
      const restored = await Promise.all(fresh.map(async (s) => {
        const p = await getProgress(s.id).catch(() => null);
        return { id: s.id, blob: s.blob, mediaType: s.mediaType, source: s.source ?? 'capture', ext: s.ext, status: 'pending' as const, size: s.blob?.size ?? 0,
          uploadId: p?.uploadId, doneChunks: p?.doneChunks };
      }));
      if (restored.length) {
        queue = [...restored, ...queue];
        showToast(`${restored.length} saved photo${restored.length > 1 ? 's' : ''} still uploading…`);
        processQueue();
      }
    } catch { /* ignore */ }
  }

  // Auto-retry failed items when the connection / server come back.
  function autoRetry() {
    let changed = false;
    for (const it of queue) if (it.status === 'error') { it.status = 'pending'; it.error = undefined; changed = true; }
    if (changed) { queue = queue; processQueue(); }
  }

  // Anything larger than one chunk is uploaded in small ~5MB parts. Small parts mean a flaky
  // connection only ever loses a few MB (not the whole file) on failure, each part stays well under
  // Cloudflare's ~100MB body cap, and — with the resume state persisted per part — a suspended or
  // reloaded tab continues from the last landed part instead of restarting. Photos (< one chunk)
  // still upload in a single request.
  const CHUNK_SIZE = 5 * 1024 * 1024;
  const CHUNK_RETRIES = 4;   // per-part retries (with backoff) before the item's overall retry kicks in
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  // Single-shot upload (XHR so we get a live progress %). Resolves the server's { photosRemaining }.
  function uploadSingle(item: QueueItem): Promise<{ photosRemaining: number; photoId?: string }> {
    return new Promise((resolve, reject) => {
      const form = new FormData();
      form.append('photo', item.blob, `media.${item.ext}`);
      form.append('sessionToken', sessionToken!);
      form.append('source', item.source);
      if (item.challengeId) form.append('challengeId', item.challengeId);
      if (item.captureOrientation) form.append('captureOrientation', item.captureOrientation);
      if (item.captureShape) form.append('captureShape', item.captureShape);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/photos');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) { item.progress = Math.round((e.loaded / e.total) * 100); queue = queue; } };
      xhr.onload = () => {
        let d: { photosRemaining: number; error?: string } | null = null;
        try { d = JSON.parse(xhr.responseText); } catch { /* non-JSON */ }
        if (xhr.status >= 200 && xhr.status < 300 && d) resolve(d);
        else reject(new Error(d?.error || `Upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.ontimeout = () => reject(new Error('Upload timed out'));
      xhr.send(form);
    });
  }

  // Chunked upload: slice the blob into ~CHUNK_SIZE parts, POST each to /chunk, then /complete to
  // reassemble server-side. Each landed part is recorded (uploadId + doneChunks persisted to
  // IndexedDB) so a suspended/reloaded tab RESUMES from the last part rather than restarting; the
  // server keeps parts for hours and chunk writes are idempotent, so resends are safe. Parts also
  // retry individually with backoff before failing the item.
  async function uploadChunked(item: QueueItem): Promise<{ photosRemaining: number; photoId?: string }> {
    const blob = item.blob;
    const total = Math.ceil(blob.size / CHUNK_SIZE);
    // Reuse a persisted upload id when resuming; otherwise mint a fresh one and record it.
    let uploadId = item.uploadId;
    if (!uploadId) {
      uploadId = ((typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID() : (String(item.size) + Math.random().toString(36).slice(2))).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
      item.uploadId = uploadId;
      item.doneChunks = [];
    }
    const done = new Set<number>(item.doneChunks || []);
    const persist = () => { item.doneChunks = [...done]; saveProgress({ id: item.id, uploadId: uploadId!, doneChunks: item.doneChunks }).catch(() => {}); };
    const setProgress = (frac: number) => { item.progress = Math.min(99, Math.round(((done.size + frac) / total) * 100)); queue = queue; };
    setProgress(0);
    const sendChunk = (index: number) => new Promise<void>((resolve, reject) => {
      const start = index * CHUNK_SIZE;
      const form = new FormData();
      form.append('chunk', blob.slice(start, Math.min(blob.size, start + CHUNK_SIZE)), 'part');
      form.append('sessionToken', sessionToken!);
      form.append('uploadId', uploadId!);
      form.append('index', String(index));
      form.append('total', String(total));
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/photos/chunk');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) setProgress(e.loaded / e.total); };
      xhr.onload = () => { (xhr.status >= 200 && xhr.status < 300) ? resolve() : reject(new Error(`Chunk ${index} failed (${xhr.status})`)); };
      xhr.onerror = () => reject(new Error('Network error'));
      xhr.send(form);
    });
    const sendWithRetry = async (index: number) => {
      for (let attempt = 0; ; attempt++) {
        try { await sendChunk(index); return; }
        catch (e) { if (attempt >= CHUNK_RETRIES) throw e; await sleep(Math.min(8000, 500 * 2 ** attempt)); }
      }
    };
    for (let i = 0; i < total; i++) {
      if (done.has(i)) continue;   // already landed in a previous session — skip
      await sendWithRetry(i);
      done.add(i);
      persist();
      setProgress(0);
    }
    const complete = () => fetch('/api/photos/complete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ sessionToken, uploadId, total, ext: item.ext, mediaType: item.mediaType, source: item.source, challengeId: item.challengeId, captureOrientation: item.captureOrientation, captureShape: item.captureShape }),
    });
    let res = await complete();
    if (res.status === 409) {   // server missing some parts → resend them, then retry complete
      const body = await res.json().catch(() => ({ missing: [] as number[] }));
      for (const i of (body.missing || [])) { await sendWithRetry(i); done.add(i); persist(); }
      res = await complete();
    }
    const d = await res.json().catch(() => null);
    if (!res.ok || !d) throw new Error((d && d.error) || `Upload failed (${res.status})`);
    item.progress = 100; queue = queue;
    return d as { photosRemaining: number; photoId?: string };
  }

  // One-off capability check, run the first time a guest switches to video. It measures the

  // PREVIEW frame rate at each resolution rather than guessing from the user agent — the same

  // requestVideoFrameCallback counting the live stutter detector uses, just done deliberately

  // and before anything is recorded. Result is cached per device so it never runs twice.

  async function measureFps(ms = 1400): Promise<number> {

    const v = videoEl as RVFCVideo | null;

    if (!v?.requestVideoFrameCallback) return 60;   // can't measure — assume capable

    let frames = 0; const t0 = performance.now(); let h = 0;

    const tick = () => { frames++; h = v.requestVideoFrameCallback!(tick); };

    h = v.requestVideoFrameCallback(tick);

    await new Promise((r) => setTimeout(r, ms));

    if (h && v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(h);

    const secs = (performance.now() - t0) / 1000;

    return secs > 0 ? frames / secs : 60;

  }


  async function runVideoBenchmark() {

    if (benchRunning || recording) return;

    benchRunning = true; benchResult = null;

    const startedAt = videoQuality;

    const results: Record<string, number> = {};

    try {

      for (const q of ['high', 'standard', 'smooth'] as VidQuality[]) {   // 'phone' is not measurable

        benchStep = q;

        videoQuality = q;

        await startCamera();                 // re-acquires the stream at this resolution

        await new Promise((r) => setTimeout(r, 600));   // let it settle before counting

        results[q] = Math.round(await measureFps());

      }

      // Recommend the highest resolution that held up. 24fps is the floor for something that

      // still looks like video rather than a slideshow.

      const best = (['high', 'standard', 'smooth'] as VidQuality[]).find((q) => results[q] >= SMOOTH_FPS) || 'smooth';

      benchResult = { results, best, mic: micReport() };

      videoQuality = best;

      try { if (ev) localStorage.setItem(benchKey(ev.joinCode), JSON.stringify({ results, best, at: Date.now() })); } catch { /* ignore */ }

      try { localStorage.setItem('snap_vidq', best); } catch { /* ignore */ }

      await startCamera();

    } catch {

      videoQuality = startedAt; await startCamera();

    }

    benchStep = null; benchRunning = false;

  }


  async function processQueue() {
    if (uploading) return;
    // uploads pause while recording. A chunked multi-megabyte upload competes with the hardware
    // encoder for CPU, memory bandwidth and the network radio, which is why the same phone can
    // record 4K perfectly one moment and stutter badly the next — it depends entirely on whether
    // a previous capture happened to still be going up. Recording wins; the queue resumes after.
    if (recording) return;
    const item = queue.find((q) => q.status === 'pending');
    if (!item) return;
    uploading = true; item.status = 'uploading'; item.progress = 0; queue = queue;
    try {
      const data = (item.blob.size > CHUNK_SIZE || item.uploadId) ? await uploadChunked(item) : await uploadSingle(item);
      item.status = 'done'; item.progress = 100;
      nowTick = Date.now();   // a fresh shot is deletable, so wake the window ticker
      void refreshGalleryIfOpen();   // show it straight away if they are watching the gallery
      // Never let the count flicker UP: the per-upload server value lags behind the local
      // optimistic count during a burst, so only ever take the lower of the two.
      // Authoritative: this already accounts for every uploaded photo including this one.
      serverRemaining = data.photosRemaining;
      // A mission just landed. Tick it locally rather than refetching — the server derives progress
      // from the photos table, so a reload agrees with this; doing it here just avoids a round trip
      // before the guest sees their own list update.
      // Normally already ticked at the shutter (see enqueue). This only catches a capture restored
      // from the offline queue in a later session, where there was no shutter moment to celebrate —
      // so it ticks quietly rather than firing confetti at someone who is not looking.
      if (item.challengeId && !missionsDone.includes(item.challengeId)) {
        missionsDone = [...missionsDone, item.challengeId];
        missionsDoneLocal = [...missionsDoneLocal, item.challengeId];
      }
      if (item.challengeId && armed === item.challengeId) armed = null;
      delCapture(item.id).catch(() => {});   // uploaded → drop from the offline queue
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : 'Upload failed';
      // "No shots remaining" is a settled answer, not a transient failure. Retrying it five times
      // with backoff spams the server and makes the guest watch the same refusal repeatedly before
      // being told anything useful. Stop at once, correct the count, and point at whatever the host
      // has actually allowed.
      if (/no shots remaining/i.test(errMsg)) {
        serverRemaining = 0;
        queue = queue.filter((q) => q.id !== item.id);   // it can never succeed
        untickMission(item.challengeId);                 // …so its tick would be a lie
        delCapture(item.id).catch(() => {});
        uploading = false;
        showToast(canBuyShots || canAskHost
          ? "That's your roll — ask the host or top up below"
          : "That's your roll — no shots left");
        processQueue();
        return;
      }
      item.retries = (item.retries || 0) + 1;
      reportClientError(errMsg, 'upload', ev?.joinCode);
      if (item.retries <= MAX_UPLOAD_RETRIES) {
        // Auto-retry with a short backoff — the guest doesn't need to reopen the queue.
        item.status = 'pending'; item.error = undefined;
        queue = queue; uploading = false;
        const secs = Math.min(15, Math.ceil(1.5 * item.retries));
        showToast(`Upload didn't go through — trying again in ${secs}s…`);
        setTimeout(() => processQueue(), secs * 1000);
        return;
      }
      // Gave up after several tries — keep the photo and let them retry manually from the queue.
      item.status = 'error'; item.error = errMsg;
      // Take the tick back: the photo is kept and can be retried by hand, and a successful retry
      // ticks it again above — but until then the server has no record of it and a reload would
      // show it unticked. Better to agree with the truth than to flatter the guest.
      untickMission(item.challengeId);
      // NOTE: there was a `photosRemaining = photosRemaining + 1` here. It was dead — photosRemaining
      // is a reactive declaration over pendingUploads, so `queue = queue` below recomputed straight
      // over it — and it would have been wrong if it had landed: moving this item to 'error' already
      // drops it out of pendingUploads, so the shot comes back on its own and the bump double-counted.
      showToast('Still can’t upload — your photo is saved; open the queue to retry when you’re back online', true);
    }
    queue = queue; uploading = false;
    processQueue();
  }

  // Re-queue a failed upload (manual retry from the queue drawer).
  function retryItem(item: QueueItem) {
    if (item.status !== 'error') return;
    item.status = 'pending'; item.error = undefined; item.retries = 0;   // fresh round of auto-retries
    queue = queue;
    processQueue();
  }

  // An upload that finishes while the guest is looking at the gallery used to leave them staring at
  // a grid that silently lacked the shot they just took — it only appeared if they navigated away
  // and back. Refresh in place instead. No-op unless the gallery is the visible screen, so it costs
  // nothing during a burst of captures on the camera screen.
  // Imperative on purpose: a reactive block that both READ nowTick (via anyDeletable) and WROTE it
  // is a dependency cycle, which Svelte rejects. Callers start it after photos change; it stops
  // itself once nothing is inside its window, so the bins vanish rather than offering a delete the
  // server would refuse.
  function ensureDeleteTicker() {
    if (undoTimer) return;
    nowTick = Date.now();
    if (!galleryPhotos.some((p) => canDelete(p, nowTick))) return;
    undoTimer = setInterval(() => {
      nowTick = Date.now();
      if (!galleryPhotos.some((p) => canDelete(p, nowTick))) { clearInterval(undoTimer); undoTimer = undefined; }
    }, 1000);
  }

  // ── Captions ────────────────────────────────────────────────────────────
  // A guest may write a line under their own shot and change it later. Deliberately NOT part of the
  // shutter flow: the camera stays a camera, and this lives in the roll where a guest is already
  // looking back at what they took. The editor is a small modal because the roll is a 3-across grid
  // — a tile is ~110px wide on a phone, which is not somewhere you can type.
  let captionFor: Photo | null = null;
  let captionDraft = '';
  // Enforced here as well as via maxlength — see clampCaption() for why the attribute alone is
  // not enough on a phone. Reactive so it holds however the value arrives: typing, paste, or IME.
  $: if (captionLength(captionDraft) > CAPTION_MAX) captionDraft = clampCaption(captionDraft);
  let captionBusy = false;

  function openCaption(p: Photo) {
    hideToast();   // a previous "Caption saved" is not about the edit being started now
    captionFor = p;
    captionDraft = p.caption ?? '';
  }

  async function saveCaption() {
    if (!captionFor || !sessionToken || captionBusy) return;
    const id = captionFor.id;
    captionBusy = true;
    try {
      const r = await savePhotoCaption(id, captionDraft, { sessionToken });
      // Store what the SERVER kept, not the draft: it collapses whitespace and cuts at CAPTION_MAX,
      // so echoing the draft would show the guest a caption the gallery is not going to show.
      galleryPhotos = galleryPhotos.map((q) => (q.id === id ? { ...q, caption: r.caption } : q));
      captionFor = null;
      showToast(r.caption ? 'Caption saved' : 'Caption removed');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save that caption', true);
    } finally { captionBusy = false; }
  }

  async function deletePhoto(id: string) {
    if (!sessionToken) return;
    confirmingDeleteId = null;
    try {
      const r = await fetch(`/api/photos/${id}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ sessionToken }),
      });
      if (!r.ok) { showToast('That one is part of the roll now', true); return; }
      const d = await r.json().catch(() => null);
      if (typeof d?.photosRemaining === 'number') serverRemaining = d.photosRemaining;
      // Mission progress is derived from the photos table, so deleting a trick shot un-ticks its
      // trick — and the client cannot work out WHICH one, because a gallery row carries the
      // mission's text (`challenge`), not its id. The server re-derives the list for us on the
      // delete; take it wholesale, exactly as the join/refresh paths do. Without this the trick
      // list kept a tick the server had already dropped until the guest reloaded the page.
      // Wholesale, NOT merged — the one case where the server has to be able to take a tick away.
      // A local tick is there precisely because the server had not caught up; here it has, and it
      // is telling us the trick is undone. Pruning the local list too, or the next refresh would
      // hand the tick straight back.
      if (Array.isArray(d?.challengesDone)) {
        const done = d.challengesDone as string[];
        missionsDoneLocal = missionsDoneLocal.filter((id) => done.includes(id));
        missionsDone = done;
      }
      galleryPhotos = galleryPhotos.filter((p) => p.id !== id);
      showToast('Deleted — that shot is back on your roll');
    } catch { showToast('Could not delete that one — try again', true); }
  }

  async function buyMoreShots() {
    if (!sessionToken || buying) return;
    buying = true;
    try {
      const r = await fetch('/api/billing/guest-upgrade', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ sessionToken }),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok || !d?.url) { showToast(d?.error || 'Could not start checkout', true); buying = false; return; }
      window.location.href = d.url;    // Stripe; we come back to /join/<code>?topup=1
    } catch { showToast('Could not start checkout', true); buying = false; }
  }

  async function askHostForMore() {
    if (!sessionToken || askedHost) return;
    askedHost = true;                  // optimistic: the ask is recorded once per guest anyway
    try {
      await fetch('/api/billing/guest-request-more', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ sessionToken }),
      });
      showToast('Asked the host — they will see it on their dashboard');
    } catch { showToast('Could not send that just now', true); askedHost = false; }
  }

  async function refreshGalleryIfOpen() {
    if (screen !== 'gallery' || !sessionToken) return;
    try {
      const r = await getPhotosBySession(identifier, sessionToken, false, true);
      galleryRevealed = r.revealed;
      allowDownloads = r.allowDownloads ?? true;
      galleryPhotos = r.photos || [];
      void loadHearts();   // counts are live and per-viewer; the roll payload cannot carry them
      applyCounts(r);
      ensureDeleteTicker();
    } catch { /* a failed refresh must never disturb a gallery that is already rendered */ }
  }

  // If this browser already holds a session for this event, put them straight back in it rather

  // than offering the join form again. Used on bfcache restore and as a guard before joining.

  async function restoreIfSessionExists(): Promise<boolean> {

    if (!ev) return false;

    const token = getSession(ev.joinCode);

    if (!token) return false;

    try {

      const me = await getMe(token);

      sessionToken = token;

      serverRemaining = me.photosRemaining;

      canBuyShots = !!me.canBuyShots; canAskHost = !!me.canAskHost;

      faceMatching = !!me.faceMatching;

      if (screen === 'join' || screen === 'loading') { screen = 'camera'; startCamera(); }

      return true;

    } catch {

      clearSession(ev.joinCode);   // stale token — let them join properly

      return false;

    }

  }


  async function openGallery() {
    screen = 'gallery';
    trackEvent('guest_gallery_opened', undefined, ev?.joinCode);
    stopCamera();   // free the camera while browsing the gallery — saves battery, drops the "in use" indicator
    applyEventTheme(ev?.theme);
    try {
      // own=true: this screen shows the guest their own shots, so ask for exactly those. It used
      // to fetch the whole revealed event and discard about three quarters of it client-side.
      const r = await getPhotosBySession(identifier, sessionToken!, false, true);
      galleryRevealed = r.revealed;
      allowDownloads = r.allowDownloads ?? true;
      // Own photos come back even before reveal; everyone else's stay hidden.
      galleryPhotos = r.photos || [];
      void loadHearts();   // counts are live and per-viewer; the roll payload cannot carry them
      applyCounts(r);
      ensureDeleteTicker();
      if (!r.revealed) {
        revealMsg = r.revealMode === 'manual' ? 'The host will reveal everyone’s photos soon.'
          : r.revealMode === 'at_end' ? 'Everyone’s photos unlock when the event ends.'
          : 'Photos are hidden right now.';
      }
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not load gallery', true); }
  }

  function backToCamera() { screen = 'camera'; startCamera(); }
</script>

<!-- A tap anywhere else backs out of an armed delete. The bin itself stops propagation, so
     this only ever sees taps that are NOT the confirm button. -->
<svelte:window on:click={() => (confirmingDeleteId = null)} />

{#if fatal}
  <div class="center"><div class="msg"><span class="big">😕</span><h2>{fatal}</h2><a class="btn ghost" href="/">← Home</a></div></div>
{:else if screen === 'loading'}
  <div class="center"><div class="spinner"></div></div>
{:else if screen === 'upcoming'}
  <div class="center"><div class="msg"><span class="big">⏰</span><h2>{ev?.name}</h2>
    <p>This event hasn't started yet.</p>
    <p class="muted">Opens {ev ? new Date(ev.startsAt).toLocaleString([], { timeZone: ev.timezone || undefined }) : ''}</p></div></div>
{:else if screen === 'join'}
  <div class="center" class:hasbg={ev?.theme?.headerImage}>
    {#if ev?.theme?.headerImage}
      <div class="join-bg">
        <div class="join-bg-blur" style="background-image:url('{ev.theme.headerImage}')"></div>
        <img class="join-bg-img" src={ev.theme.headerImage} alt="" />
      </div>
    {/if}
    <div class="join" class:card={ev?.theme?.headerImage}>
      <!-- Deliberately NOT a link, unlike the mark in the site header. This one wears the host's
           own accent and is their event's branding, not our chrome — a guest who just scanned a QR
           should not be one tap from leaving the event they were invited to. -->
      <div class="join-logo"><Logo color={ev?.theme?.accent ?? ''} /></div>
      <h1>{ev?.name}</h1>
      {#if ev?.blurb}<p class="blurb">{ev.blurb}</p>{/if}
      {#if ev}
        <div class="roll-note">📸 Limited roll — you get <b>{ev.maxPhotos}</b> snap{ev.maxPhotos === 1 ? '' : 's'}. Make them count!</div>
        {#if hasEventInfo}
          <details class="evinfo">
            <summary>Event info</summary>
            <div class="evinfo-body">
              {#if showShapes}<div class="ei-row"><span class="ei-k">Photo shapes</span><span class="chips">{#each shapeLabels as s}<span class="chip">{s}</span>{/each}</span></div>{/if}
              {#if videoMaxSecs > 0}<div class="ei-row"><span class="ei-k">Video</span><span class="chip vid">🎬 clips up to {videoMaxSecs}s</span></div>{/if}
              <div class="ei-row"><span class="ei-k">Reveal</span><span>{ev.revealMode === 'at_end' ? 'When the event ends' : 'Live as you shoot'}</span></div>
              <!-- How many, never which. The tricks are the surprise, and this screen is public. -->
              {#if (ev.challengeCount ?? 0) > 0}
                <div class="ei-row"><span class="ei-k">Trick list</span><span class="chip trick">🃏 {ev.challengeCount} to pull off</span></div>
              {/if}
            </div>
          </details>
        {/if}
      {/if}
      <label for="join-name">Your name</label>
      <input id="join-name" bind:value={joinName} maxlength="40" placeholder="e.g. Alex" autocomplete="name" />
      <!-- The word changes with the switch below. A field labelled "optional" that then refuses the
           form is the kind of small dishonesty people remember. -->
      <label for="join-email">Email {#if joinWantsPhotos && !myEmail}<span class="req">(needed for your photos)</span>{:else}<span class="muted">(optional)</span>{/if}</label>
      <input id="join-email" bind:value={joinEmail} type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" />
      <p class="join-hint">Add your email to get your photos afterwards and pick up where you left off.</p>
      <!-- Beside the address rather than after the button, because it is a statement ABOUT the
           address. Switching it ON is the one thing that makes the address required — and the label
           above changes to say so, rather than letting somebody submit an opt-in we could never
           honour. Everything else here is still optional and still does not block the join. -->
      <div class="join-optin">
        <label for="join-wants">Email me the photos when the event ends</label>
        <Toggle id="join-wants" bind:checked={joinWantsPhotos} />
      </div>
      <p class="join-hint" class:needs={joinWantsPhotos && !joinEmail.trim() && !myEmail}>{joinWantsPhotos && !joinEmail.trim() && !myEmail
        ? 'Pop your email in above so we know where to send them.'
        : 'You can opt in later — there’s a button with your photos.'}</p>
      <button class="btn primary" on:click={doJoin} disabled={joining}>{joining ? 'Joining…' : 'Join & open camera'}</button>
      {#if ev?.joinCode}<a class="manage-link" href={`/admin/${ev.joinCode}`}>Organising this event? Manage it →</a>{/if}
    </div>
  </div>
{:else if screen === 'camera'}
  <!-- always in the DOM while the camera screen is up. It used to live inside the settings
       sheet, which is conditionally rendered — so with the sheet closed the binding was
       undefined and every "use my own camera" button silently did nothing. Three separate
       call sites depended on it. -->
  <input bind:this={nativeVideoInput} type="file" accept="video/*" capture="environment"
         on:change={nativeVideoPicked} style="display:none" />
  <!-- The counter-rotation is published as a variable rather than applied here: rotating this
       element would rotate the viewfinder and the layout with it, which is the thing we are
       specifically not doing. Individual glyphs opt in. -->
  <div id="cam-root" class="cam" style="--glyph-rot: {glyphRot}deg; --note-bottom: {noteVar}; --topbar-h: {topbarH ? `${topbarH}px` : `72px`}">
    <div class="viewfinder">
      <!-- svelte-ignore a11y-media-has-caption -->
      <!-- Mirrored on the front camera, because that is what a phone does and what people expect
           when they look at themselves. It was not mirrored at all, while CAPTURE mirrors for
           'user' facing — so the preview and the photo you got back disagreed, which is the
           "it's flipped again" feeling. Now what you see is what is saved. -->
      <video bind:this={videoEl} class:mirrored={facing === 'user'} autoplay playsinline muted
             on:playing={() => (frozen = false)}></video>
      <!-- Under the spinner, over the blanked <video>. aria-hidden: it is the same picture the
           guest was already looking at, so announcing it would be narrating a pause.

           ALWAYS RENDERED, shown with a class. Behind {#if frozen} the canvas does not exist until
           after the frame has been taken — and the frame is taken by drawing INTO it, so it could
           never be shown at all. The element has to be there first. -->
      <canvas class="freeze" class:on={frozen} class:mirrored={frozenMirrored}
              bind:this={freezeEl} aria-hidden="true"></canvas>
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="gesture-layer" class:tilted={glyphRot !== 0}
        on:pointerdown={onGesturePointerDown}
        on:pointermove={onGesturePointerMove}
        on:pointerup={onGesturePointerUp}
        on:pointercancel={onGesturePointerUp}></div>
      {#if focusRing}<div class="focus-ring" style="left:{focusRing.x}px;top:{focusRing.y}px"></div>{/if}
      {#if brightnessHud}
        <div class="bright-hud" class:tilted={glyphRot !== 0}
             class:cw={glyphRot === 90} class:ccw={glyphRot === -90}
             transition:fade={{ duration: 150 }}>
          <span aria-hidden="true">☀️</span>
          <div class="bright-bar"><div class="bright-fill" style="width:{((brightness - BRIGHT_MIN) / (BRIGHT_MAX - BRIGHT_MIN)) * 100}%"></div></div>
          <span class="bright-val">{Math.round(brightness * 100)}%</span>
          <button class="ctrl tiny" on:click={resetBrightness} disabled={brightness === 1} title="Reset brightness" aria-label="Reset brightness">↺</button>
        </div>
      {/if}
      <!-- The home-screen offer. A strip at the bottom, not a modal: a guest is holding a camera
           and the one thing this must never do is stand between them and the next shot. Dismissing
           it is final for this event (markAsked ran when it appeared), so it cannot come back and
           nag mid-party. -->
      {#if installOffer}
        <div class="install-offer" role="status">
          <span class="io-txt">Add Snapdini to your home screen? It opens like an app — same camera, no address bar.</span>
          <button class="io-yes" on:click={doInstall}>Add</button>
          <button class="io-no" on:click={() => (installOffer = false)} aria-label="No thanks">✕</button>
        </div>
      {/if}
      {#if fillActive}<div class="fill"></div>{/if}
      {#if blinking}{#key blinkSeq}<div class="blink" aria-hidden="true"></div>{/key}{/if}
      <Confetti bind:this={confetti} colors={ev?.theme?.accent ? [ev.theme.accent, '#f4e4c1', '#e8825a', '#7fb3a3'] : undefined} />
      <div class="topbar" bind:this={topbarEl}>
        {#if ev?.isDemo}
          <div class="demo-nav">
            <!-- Order is the tour, not the escape: a visitor should see what the host and the
                 gallery look like before they are offered the way out. "Home" was ambiguous — it
                 read as "my dashboard" as easily as "leave" — so the exit says what it does. -->
            {#if demoHostHref}<a class="home-btn" href={demoHostHref} aria-label="See the host's view of this demo">🎛️ Host view</a>{/if}
            <!-- Event gallery USED to be a third button here, and three of them crowded the trick
                 list and the shot counter that share this row — a bar sized for one control on
                 every other event. It has moved to the guest's roll, where "see everyone's photos"
                 already lives and where somebody looking at their own shots is actually thinking
                 about the rest of them. See `.full-gallery` below. -->
            <a class="home-btn quiet" href="/" aria-label="Leave the demo and go back to the Snapdini home page">✕ Exit demo</a>
          </div>
        {:else}
          <div class="evname"><Logo word={false} color={ev?.theme?.accent ?? ''} /> {ev?.name}</div>
          <!-- Only for the account that actually owns or co-hosts THIS event (youManage, checked
               server-side against the event's owner). A host walking their own party is still a
               guest here — their shots belong to whoever they joined as — but they should not have
               to find their way back to their own dashboard through the address bar.
               No organizer code in the link: the admin page authorises a signed-in host off the
               session cookie, so there is no credential to put in a URL. -->
          {#if ev?.youManage && ev?.joinCode}
            <a class="home-btn host-btn" href="/admin/{ev.joinCode}"
               aria-label="Open your host dashboard for this event">🎛️ Host view</a>
          {/if}
        {/if}
        <!-- The trick list and the counter are ONE group, pinned to the right together.
             As three separate children of a space-between row they were spread across the full
             width, which is invisible on a 390px phone — everything is cramped anyway — and obvious
             at 844px, where the trick pill drifted into the middle of the picture, miles from the
             counter it belongs beside. -->
        <div class="topright">
        {#if missions.length && !videoMode}
          <!-- One small pill is the whole affordance. The camera screen has to stay a camera: a
               permanent list would compete with the viewfinder, so the list lives behind this. -->
          <!-- The count alone read as decoration — nobody could tell it was tappable, let alone
               what it opened. A two-word caption under it names the thing and invites the tap. -->
          <!-- Gone entirely in video mode, because a trick is a photo prompt (see setMode). No
               note explaining the absence: it comes straight back on the switch to Photo, and a
               notice about something that is not on screen is just noise. -->
          <div class="mwrap">
            <button class="mbadge" class:alldone={!missionsLeft.length}
                    on:click={openTrickList}
                    aria-label="Trick list, {missionsDone.length} of {missions.length} pulled off">
              {missionsDone.length}/{missions.length}
            </button>
            <span class="mcap">{!missionsLeft.length ? 'all done' : 'trick list'}</span>
          </div>
        {/if}
        <div class="counter" class:low={photosRemaining <= 5}>{photosRemaining}<small>left</small></div>
        </div>
      </div>
      <!-- A sibling of the in-app-browser note below, never nested inside it: it lived in that
           block's body while that block was gated on `!landscapeNote`, so it could only render on
           the condition that it was not showing. Which is to say, never. -->
      {#if landscapeNote}
        <div class="landnote" bind:this={noteEl}>
          <div class="sw-t">
            <p class="sw-h">↻ Snapdini works best upright</p>
            <!-- "screen", not "viewfinder": this is read by someone at a party, and it is the word
                 they would use. And it offers the thing that actually works — see goFullscreen. -->
            <p class="sw-s">Turn off auto-rotate, or use your phone's rotation lock, to keep it
              that way. Staying sideways is fine too — fullscreen helps, and your photos come out
              right either way.</p>
            {#if canGoFullscreen()}
              <button class="sw-act" on:click={goFullscreen} disabled={goingFullscreen}>
                {goingFullscreen ? 'Opening…' : '⛶ Go fullscreen'}
              </button>
            {/if}
          </div>
          <button class="switchnote-x" on:click={() => (landscapeDismissed = true)} aria-label="Dismiss">✕</button>
        </div>
      {/if}
      {#if switchRisk && !landscapeNote}
        <!-- The trap this closes, reproduced by the product owner: a roll lives in the session token
             in THIS browser's storage. We tell people to open the link in their real browser,
             because an in-app browser forgets camera permission between uses — and following that
             advice starts them again as a second guest, with the photos they already took stranded
             on an identity they can no longer reach.
             An email is the only thing that crosses, because the join route already recovers by it.
             So the email leads here, rather than being the footnote it is on the join screen. -->
        <div class="switchnote">
          <div class="sw-t">
            {#if myEmail}
              <p class="sw-h">Opening in your browser? Use <b>{myEmail}</b></p>
              <p class="sw-s">{inAppName}’s browser keeps asking for the camera. Your real browser
                asks once — just enter the same email there and your {ownCount || 'existing'}
                shot{ownCount === 1 ? '' : 's'} come with you.</p>
            {:else}
              <p class="sw-h">Add your email before you switch browsers</p>
              <p class="sw-s">You joined without one, so opening this link anywhere else would start
                you again as a new guest — and the shots you have already taken would stay behind.</p>
              <div class="sw-row">
                <input type="email" inputmode="email" autocomplete="email" bind:value={emailDraft}
                       placeholder="you@example.com" aria-label="Your email, so your photos move with you" />
                <button class="btn primary sm" on:click={attachEmail} disabled={emailBusy}>
                  {emailBusy ? 'Saving…' : 'Save'}
                </button>
              </div>
            {/if}
          </div>
          <button class="switchnote-x" on:click={() => (emailNoteDismissed = true)} aria-label="Dismiss">✕</button>
        </div>
      {/if}
      {#if micDenied}
        <!-- A headline, the consequence, then the steps — instead of one paragraph of prose that
             nobody reads standing in a room full of people. The fix is behind a summary because it
             is long, browser-specific, and only wanted by someone who has decided to go and do it. -->
        <div class="micnote">
          <div class="micnote-t">
            <p class="micnote-h">
              {#if micState === 'missing'}No microphone on this device
              {:else if micReason === 'NotReadableError' || micReason === 'AbortError' || micReason === 'TrackStartError'}Your microphone is busy
              {:else if micState === 'blocked'}Your browser is blocking the microphone
              {:else}Couldn’t reach your microphone{/if}
            </p>
            <p class="micnote-s">Video still works — your clips will be silent.</p>
            {#if micState === 'blocked'}
              <details class="micnote-d">
                <summary>How to allow it</summary>
                <ol>
                  <li>Tap the icon to the <b>left of the web address</b>.</li>
                  <li>Open <b>Permissions</b> → <b>Microphone</b> → <b>Allow</b>.</li>
                  <li>Reload the page.</li>
                  <li><b>On Android</b>, also check Settings → Apps → your browser → Microphone. A site can be allowed while the browser itself is not.</li>
                </ol>
              </details>
            {:else if micReason === 'NotReadableError' || micReason === 'AbortError' || micReason === 'TrackStartError'}
              <details class="micnote-d">
                <summary>How to free it up</summary>
                <ol>
                  <li>Close any other app using the mic — a call, a voice note, a recorder.</li>
                  <li>Close other browser tabs on this site or a meeting page.</li>
                  <li>Then tap <b>Try again</b>.</li>
                </ol>
              </details>
            {/if}
          </div>
          <!-- Offered only when a retry can actually produce a prompt. A button that cannot work is
               worse than no button: it is the thing that makes the app look broken. -->
          {#if micState !== 'missing'}
            <!-- Two different buttons, because the two situations need different things.
                 BLOCKED means the browser will not prompt however politely we ask — asking again
                 does nothing, which is what made this button look broken. A browser also only
                 notices a permission you changed in its settings when the page RELOADS, so after
                 someone follows the steps above, reloading is the thing that actually helps.
                 Otherwise the mic can still be asked for, so ask — inside this tap (see
                 askForMic), since re-running the camera chain alone can never raise a prompt. -->
            {#if micState === 'blocked'}
              <button class="micnote-a" on:click={() => location.reload()}>Reload</button>
            {:else}
              <button class="micnote-a" on:click={async () => { if (await askForMic()) { videoMode = true; await startCamera(); } }}>Try again</button>
            {/if}
          {/if}
          <button class="micnote-x" on:click={() => (micDenied = false)} aria-label="Dismiss">✕</button>
        </div>
      {/if}
      {#if armed}
        <!-- Shown only while a mission is armed, so there is never any doubt what the next shot
             counts towards — and an obvious way out of it. -->
        <div class="armed">
          <span class="armed-label">Pulling off</span>
          <span class="armed-text">{armedText}</span>
          <button class="armed-x" on:click={() => (armed = null)} aria-label="Stop shooting for this trick">✕</button>
        </div>
      {/if}
      <div class="rail">
        <!-- Present whenever the event allows a flash at all, and greyed out with a slash through
             it where nothing can light (a selfie clip; a camera with no lamp). It used to be
             withdrawn instead, which meant the whole rail shuffled up every time the guest flipped
             the camera — and a control that moves is harder to hit than one that is merely off.
             The preference survives either way: flip back and the flash is still armed. -->
        {#if !ev?.noFlash}
          <button class="ctrl" on:click={toggleFlash} class:active={flashArmed && flashUsable}
                  class:noflash={!flashUsable} disabled={!flashUsable}
                  title={flashTitle} aria-label={flashTitle}>⚡</button>
        {/if}
        <!-- Offered in BOTH modes now that a clip really is cropped to it: the camera delivers the
             shape (applyRecordShape) instead of the recorder being handed a wide frame. It is put
             away only on a camera that has actually refused — there a shape is a photo setting
             again, and a control that cannot do what it says is worse than no control. Disabled
             while recording because resizing the track mid-clip is a resolution change the recorder
             never agreed to. -->
        {#if allowedAspects.length > 1 && (!videoMode || videoShapeSupported)}<button class="ctrl" on:click={() => (shapeSheet = true)} disabled={recording} title={videoMode ? 'Clip shape' : 'Photo shape'} aria-label="Choose {videoMode ? 'clip' : 'photo'} shape (currently {ASPECT_LABELS[aspect] || aspect})">{aspect === 'full' ? 'Full' : aspect}</button>{/if}
        <button class="ctrl" on:click={() => (settingsOpen = !settingsOpen)} class:active={settingsOpen} title="Settings" aria-label="Camera settings">
          <!-- Drawn rather than typed: the ⚙ character is rendered by whatever font the device has
               and frequently is not recognisably a cog, which is the one icon users navigate by. -->
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="3.2"/>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
          </svg>
        </button>
        <button class="ctrl" on:click={toggleCameraPower} class:active={cameraPaused} title={cameraPaused ? 'Turn camera on' : 'Turn camera off'} aria-label={cameraPaused ? 'Turn camera on' : 'Turn camera off'} aria-pressed={cameraPaused}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="3.5"/>{#if !cameraPaused}<line x1="2" y1="2" x2="22" y2="22"/>{/if}</svg>
        </button>
        <button class="ctrl" on:click={toggleFullscreen} title="Fullscreen" aria-label="Fullscreen">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
      </div>
      <!-- !videoMode as well as the flag: setMode already closes the sheet on the way in, but the
           list must not be reachable from video by any route, and a guard on the render is the
           one place that covers all of them. -->
      <!-- "Which card are you?" — asked once, behind the trick-list pill, and only of a guest the
           server left the question open for. Never in video mode, for the same reason the list is
           not: a trick is a photo prompt, and the guard belongs on the render so no route can slip
           past it. -->
      {#if cardAsking && !videoMode}
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions a11y-no-noninteractive-element-interactions -->
        <div class="settings-back" on:click|self={() => (cardAsking = false)} role="dialog" aria-modal="true" aria-label="Which trick card have you got?">
          <div class="settings-modal">
            <div class="sm-head">
              <span>Which card have you got?</span>
              <button class="ctrl tiny" on:click={() => (cardAsking = false)} aria-label="Close">✕</button>
            </div>

            {#if cardConfirming}
              <p class="m-lede">
                <b>{cardConfirming.label}</b>{' '}— is that the one in front of you?
              </p>
              <p class="cc-warn">You can’t change it afterwards, so have a quick look first.</p>
              <ul class="cc-preview">
                {#each cardConfirming.preview as t}<li>{t}</li>{/each}
                {#if cardConfirming.count > cardConfirming.preview.length}
                  <li class="cc-more">+{cardConfirming.count - cardConfirming.preview.length} more</li>
                {/if}
              </ul>
              <div class="cc-actions">
                <button class="cc-back" on:click={() => (cardConfirming = null)} disabled={cardSaving}>Back</button>
                <button class="cc-yes" on:click={() => pickCard(cardConfirming?.key ?? null)} disabled={cardSaving}>
                  {cardSaving ? 'One moment…' : 'Yes, that’s mine'}
                </button>
              </div>
            {:else}
              <p class="m-lede">
                Your tricks depend on which card you’re sitting at. Tap the one in front of you.
              </p>
              {#if cardsHaveQr}
                <!-- Better advice than a guess, and only ever shown when the host's cards actually
                     print a code of their own. -->
                <p class="cc-qr">📷️ Your card has its own code — scanning that one always gets it right.</p>
              {/if}
              <ul class="m-list">
                {#each cardChoices as c (c.key)}
                  <li class="m-item">
                    <button class="m-btn cc-btn" on:click={() => (cardConfirming = c)}>
                      <span class="cc-lab">{c.label}</span>
                      <span class="cc-hint">
                        {c.preview.join(' · ')}{#if c.count > c.preview.length}{' '}· +{c.count - c.preview.length} more{/if}
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
              <!-- The option that keeps the cards evenly spread. Without it everyone who joined off
                   the main sign taps the first button, and the even coverage several cards exist
                   for is gone — so a guess is not asked of someone who never had a card. -->
              <button class="cc-none" on:click={() => pickCard(null)} disabled={cardSaving}>
                I haven’t got a card — pick one for me
              </button>
            {/if}
          </div>
        </div>
      {/if}
      {#if missionsOpen && !videoMode}
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions a11y-no-noninteractive-element-interactions -->
        <div class="settings-back" on:click|self={() => (missionsOpen = false)} role="dialog" aria-modal="true" aria-label="Trick list">
          <div class="settings-modal">
            <div class="sm-head">
              <span>Tricks up your sleeve</span>
              <button class="ctrl tiny" on:click={() => (missionsOpen = false)} aria-label="Close">✕</button>
            </div>
            <p class="m-lede">
              {#if !missionsLeft.length}
                Every one of them, pulled off. Nothing left to do but enjoy the party.
              {:else}
                Pick one, then shoot it. One chance each, so make it count.
                Ignore the lot if you’d rather just take photos.
              {/if}
            </p>
            <div class="m-prog"><div class="m-prog-fill" style="width:{(missionsDone.length / missions.length) * 100}%"></div></div>
            <ul class="m-list">
              {#each missions as m (m.id)}
                <li class="m-item" class:done={isDone(m.id)} class:armed={armed === m.id}>
                  <button class="m-btn" on:click={() => armMission(m.id)} disabled={isDone(m.id)}>
                    <!-- The host's own mark, so a digital-only list still looks like the card it
                         would have printed. A done one becomes a tick regardless — the point of that
                         row is that it is finished. -->
                    <span class="m-tick" aria-hidden="true">{isDone(m.id) ? '✓' : armed === m.id ? '◉' : missionTick}</span>
                    <span class="m-text">{m.text}</span>
                    <!-- "Snap", not "Shoot" — it is the word the whole product is named after, and
                         the one a guest is already thinking in. Styled as a pill because a bare
                         uppercase word at 60% opacity reads as a status, not as the thing to tap. -->
                    {#if !isDone(m.id)}<span class="m-go">{armed === m.id ? 'Armed' : 'Snap'}</span>{/if}
                  </button>
                </li>
              {/each}
            </ul>
          </div>
        </div>
      {/if}
      {#if settingsOpen}
        <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions a11y-no-noninteractive-element-interactions -->
        <div class="settings-back" on:click|self={() => (settingsOpen = false)} role="dialog" aria-modal="true" aria-label="Camera settings">
          <div class="settings-modal">
            <div class="sm-head">
              <span>Camera settings</span>
              <button class="sm-x" on:click={() => (settingsOpen = false)} aria-label="Close settings">✕</button>
            </div>

            <div class="sm-row">
              <span class="sm-labelwrap">
                <span class="sm-label">Grid</span>
                <span class="sm-desc">Rule-of-thirds lines to help you frame the shot.</span>
              </span>
              <button class="ctrl" on:click={toggleGrid} class:active={gridOn} aria-pressed={gridOn} title="Grid">⊞</button>
            </div>

            <div class="sm-row">
              <span class="sm-labelwrap">
                <span class="sm-label">Save a copy to my device</span>
                <span class="sm-desc">Also download each shot to your phone as you take it.</span>
              </span>
              <!-- Not offered on iOS at all. There is no API that writes to the camera roll, so
                   every copy landed in Files — duplicates of photos the app already has, in a place
                   nobody looks for a picture. Explaining that was still explaining a control that
                   does nothing anyone wants; "Save all" in the gallery is the route that works, and
                   one honest path beats two of which one is a dead end. -->
              {#if !iosDevice}
                <button class="ctrl" on:click={toggleSaveToDevice} class:active={saveToDevice} aria-pressed={saveToDevice} title="Also save a copy to my device" aria-label="Save copies to my device">💾</button>
              {/if}
            </div>

            {#if cameras.length > 1}
              <div class="sm-row col">
                <span class="sm-labelwrap">
                  <span class="sm-label">Camera</span>
                  <span class="sm-desc">Switch between the cameras on this device.{#if recording}{' '}Stop recording to change.{/if}</span>
                </span>
                <select class="sm-select" aria-label="Choose camera" value={deviceId ?? ''} disabled={recording} on:change={(e) => pickCamera(e.currentTarget.value)}>
                  {#each cameras as c}<option value={c.id}>{c.label}</option>{/each}
                </select>
              </div>
            {/if}

            {#if videoMaxSecs !== 0}
              <div class="sm-row col">
                <span class="sm-labelwrap">
                  <span class="sm-label">Video quality</span>
                  <span class="sm-desc">Higher looks better; lower this if recording stutters.</span>
                </span>
                <select class="sm-select" aria-label="Video quality" value={videoQuality} on:change={(e) => setVideoQuality(e.currentTarget.value)}>
                  <option value="standard">Standard — 1080p (default)</option>
                  <option value="high">High — 4K (larger, may stutter)</option>
                  <option value="smooth">Smooth — 720p (older phones)</option>
                    <option value="phone">My phone's camera — best quality, opens your camera app</option>
                </select>
                <!-- The benchmark used to exist ONLY as a one-time prompt keyed on a localStorage
                     flag, so once it had been run or skipped there was no way back to it on any
                     event, ever. It measures the device, so re-running is the useful thing. -->
                <button class="sm-link" on:click={() => { settingsOpen = false; benchResult = null; try { localStorage.removeItem(BENCH_NEVER); } catch { /* ignore */ } void runVideoBenchmark(); }}>
                  {benchStored ? 'Re-check my camera' : 'Check my camera'}
                </button>
              </div>
              <div class="sm-row col">
                <span class="sm-labelwrap">
                  <span class="sm-label">Trouble recording here?</span>
                  <span class="sm-desc">Shoot with your phone’s own camera app instead, then upload it. Counts as one shot; keep it under {videoMaxSecs}s.</span>
                </span>
                <button class="sm-select" type="button" on:click={openNativeVideo}>🎥 Record with phone camera</button>
              </div>
            {/if}

            {#if saveNote}<div class="sm-note">Now also saving a copy of each shot to your device.</div>{/if}

            <!-- The quiet route in. Somebody who opens Settings is exactly the person who might want
                 this, and offering it here costs nobody else a thing — unlike a banner. Shown even
                 when we have no prompt to fire, because on iOS there never is one and the Share-menu
                 instructions are the only way. Hidden once it is already installed. -->
            {#if !installedAlready}
              <!-- Title, description, control — the same shape as every other row in this sheet, and
                   all inside ONE `.col` row. Every .sm-row draws a divider along its bottom edge, so
                   anything placed after the row lands on the far side of that line and reads as
                   belonging to whatever comes next — which is how this description ended up under
                   "Report a problem". One row, one divider, the whole entry above it. -->
              <div class="sm-row col">
                <span class="sm-labelwrap">
                  <span class="sm-label">Snapdini app</span>
                  <span class="sm-desc">Opens like an app, with no address bar. It still works if your signal drops, and it keeps nothing from your phone — it is the same camera, in its own window.</span>
                </span>
                <button class="sm-select" type="button"
                        on:click={() => (iosInstall ? (installHelp = !installHelp) : void doInstall())}>
                  📲 Add to home screen
                </button>
                {#if installHelp}
                  <div class="sm-note tight">
                    On iPhone: tap <b>Share</b> at the bottom of Safari, then <b>Add to Home Screen</b>.
                  </div>
                {/if}
              </div>
            {/if}

            <div class="sm-row">
              <button class="sm-select" type="button" on:click={() => { settingsOpen = false; showFeedback = true; }}>💬 Report a problem / feedback</button>
            </div>
          </div>
        </div>
      {/if}
      <!-- Sized from framedAspect, exactly as the video above it is, so the thirds land on the
           picture rather than on the page. -->
      {#if gridOn}
        <div class="grid" style={framedAspect ? `aspect-ratio:${framedAspect};height:auto` : 'height:100%'}>
          <span></span><span></span><span></span><span></span>
        </div>
      {/if}
      {#if recording}<div class="rec">● {Math.floor(recSecs / 60)}:{String(recSecs % 60).padStart(2, '0')}{#if videoMaxSecs > 0}{' '}/ {Math.floor(videoMaxSecs / 60)}:{String(videoMaxSecs % 60).padStart(2, '0')}{/if}</div>{/if}
      {#if cameraStarting && !cameraError}
        <div class="cam-loading" transition:fade={{ duration: 120 }}>
          <div class="cam-spinner" aria-label="Starting camera"></div>
        </div>
      {/if}
      {#if cameraDenied}
        <!-- People decline because they do not know what they are granting. Say what it is for and,
             more importantly, what we cannot reach — that is the actual worry. -->
        <div class="cam-error cam-denied">
          <span class="big" aria-hidden="true">📷</span>
          <p class="cd-lead">We need your camera to take photos for this event.</p>
          <ul class="cd-list">
            <li>We <b>can't</b> see your photo library or camera roll.</li>
            <li>We <b>can't</b> save anything to your device.</li>
            <li>We only ever receive the shots you actually take here.</li>
          </ul>
          <button class="btn primary" on:click={startCamera}>Allow camera</button>
          <!-- Two different problems wear the same error. A camera already held by something else
               is not a permission at all, and a guest who has definitely granted access is left
               going round the settings again looking for a switch that is already on — so say the
               other cause first, because it is the one they can fix in a second. -->
          <p class="cd-hint">
            <b>Already open somewhere else?</b> A camera can only be used by one thing at a time —
            close any other tab, video call or camera app, then tap above.
          </p>
          <p class="cd-hint">
            If nothing happens at all, your browser is remembering an earlier “don't allow”. On
            iPhone tap <b>aA</b> in the address bar → <b>Website Settings</b> → <b>Camera</b> →
            <b>Allow</b>. On Android tap the icon to the left of the address → <b>Permissions</b>.
            Then tap above again.
          </p>
        </div>
      {:else if cameraError}
        <div class="cam-error">
          <span class="big" aria-hidden="true">🎥</span>
          <p>{cameraError}</p>
          <button class="btn primary" on:click={startCamera}>Retry</button>
        </div>
      {:else if cameraPaused}
        <div class="cam-error">
          <span class="big" aria-hidden="true">
            <svg width="46" height="46" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="3.5"/></svg>
          </span>
          <p>Camera is off.</p>
          <!-- Why this button is worth pressing, said here rather than on the button itself, where
               it would be a wall of text on a control nobody has decided to use yet.
               It is a real thing and not a nicety: we release the camera on the way out, but a
               browser that keeps a tab alive in the background can hold the hardware open anyway,
               and a live camera is about the most expensive thing a phone can be quietly doing. -->
          <p class="off-why">Worth doing before you put your phone away. We let go of the camera
            when you leave, but plenty of browsers hang onto it anyway — and a camera left running
            is the quickest way to flatten a battery. Off is off, so you can snap all night.</p>
          <button class="btn primary" on:click={toggleCameraPower}>Turn camera on</button>
        </div>
      {/if}
    </div>

    {#if videoMaxSecs !== 0}
      <div class="modes">
        <button class:on={!videoMode} on:click={() => setMode(false)} disabled={recording}>Photo</button>
        <button class:on={videoMode} on:click={() => setMode(true)} disabled={recording}>Video</button>
      </div>
    {/if}

    <div class="bottombar">
      <button class="round" on:click={openGallery} title="Gallery" aria-label="Gallery{pendingCount ? ` (${pendingCount} uploading)` : ''}">🖼️{#if pendingCount}<span class="badge" class:error={hasUploadError}>{pendingCount}</span>{/if}</button>
      {#if videoMode}
        <button class="shutter video" class:recording on:click={toggleRecord}
                aria-disabled={!!cameraError || undefined}
                aria-label={recording ? 'Stop recording' : 'Record'}><span class="core"></span></button>
      {:else}
        <!-- aria-disabled, NOT disabled. See announceNoShots(): a disabled button absorbs the
             tap and the phone raises its own Copy/Search menu over the app, on the control people
             press more than any other. Same muted look, same announcement to a screen reader, and
             the press is answered. -->
        <button class="shutter photo" on:click={capturePhoto}
                aria-disabled={photosRemaining <= 0 || !!cameraError || undefined}
                aria-label="Take photo"><span class="core"></span></button>
      {/if}
      <!-- Hidden, not just disabled, while recording: the stream cannot be swapped mid-clip, so a
           greyed-out button is only there to be tried and to look broken. -->
      {#if !recording}
        <!-- Tap flips; press and hold opens the lens picker. The picker otherwise lives only in
             settings, which is a long way to go on a phone with four lenses. -->
        <button class="round" class:has-more={cameras.length > 1} on:click={flipTap}
                on:pointerdown={holdStart} on:pointerup={holdEnd} on:pointercancel={holdEnd}
                on:pointerleave={holdEnd} on:contextmenu|preventDefault
                title="Flip camera (hold to choose a lens)"
                aria-label="Flip camera. Press and hold to choose a specific lens.">🔄</button>
      {:else}
        <span class="round-spacer" aria-hidden="true"></span>
      {/if}
    </div>
    <!-- Nothing about upgrades exists until the roll is actually spent: no upsell furniture during
         the event. Each path shows only if the host allows it, so a guest is never offered a button
         the server would refuse. Asking comes first — the host buying for everyone is better value
         than one guest buying for themselves. -->
    <!-- The phone-camera fallback already existed, but only inside the settings sheet. Someone
         whose clip just stuttered is not going to go looking for it, so put it in front of them
         at the moment it becomes relevant. -->
    {#if shapeSheet}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions a11y-no-noninteractive-element-interactions -->
      <div class="lens-back" on:click|self={() => (shapeSheet = false)} role="dialog" aria-modal="true" aria-label="Choose a shape">
        <div class="lens-sheet">
          <div class="lens-head">{videoMode ? 'Clip shape' : 'Photo shape'}</div>
          {#each allowedAspects as a}
            <button class="lens-opt" class:on={a === aspect} on:click={() => pickAspect(a)}>
              <span class="lens-name">{ASPECT_LABELS[a] || a}{#if a !== 'full'}<span class="lens-sub"> · {a}</span>{/if}</span>
              {#if a === aspect}<span class="lens-now" aria-label="Currently chosen">●</span>{/if}
            </button>
          {/each}
          <button class="lens-cancel" on:click={() => (shapeSheet = false)}>Cancel</button>
        </div>
      </div>
    {/if}
    {#if lensSheet}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions a11y-no-noninteractive-element-interactions -->
      <div class="lens-back" on:click|self={() => (lensSheet = false)} role="dialog" aria-modal="true" aria-label="Choose a lens">
        <div class="lens-sheet">
          <div class="lens-head">Choose a lens</div>
          {#each cameras as c}
            <div class="lens-row">
              <button class="lens-opt" class:on={c.id === deviceId} on:click={() => chooseLens(c.id)}>
                <span class="lens-name">{c.label}</span>
                <!-- Named for the guest who wandered onto the ultra-wide and wants back. Not a guess
                     from the label: it is the lens this phone hands back when we ask for the side
                     and name no device at all. -->
                {#if isNormalLens(c)}<span class="lens-std">standard</span>{/if}
                <!-- Always present, only sometimes visible. Rendered conditionally, its arrival and
                     departure moved the `standard` pill sideways as the live lens changed — so a
                     label that describes the HARDWARE appeared to jump about in response to a
                     choice. visibility:hidden keeps the slot and keeps it out of the a11y tree. -->
                <span class="lens-now" class:shown={c.id === deviceId}
                      aria-label={c.id === deviceId ? 'Currently in use' : undefined}>●</span>
              </button>
              {#if canFavourite(c)}
                <button class="lens-fav" class:on={isFav(c)}
                        on:click|stopPropagation={() => toggleFav(c)}
                        aria-pressed={isFav(c)}
                        title={isFav(c) ? 'Flip lands here for this side' : 'Make this the lens flip goes to'}
                        aria-label={isFav(c) ? `${c.label} is where flip lands` : `Make ${c.label} where flip lands`}>
                  <StarIcon filled={isFav(c)} size={16} />
                </button>
              {/if}
            </div>
          {/each}
          <button class="lens-cancel" on:click={() => (lensSheet = false)}>Cancel</button>
        </div>
      </div>
    {/if}
    {#if benchPrompt || benchRunning || benchResult}
      <div class="bench-panel" bind:this={benchEl}>
        {#if benchRunning}
          <div class="bench-title">Checking your camera…</div>
          <div class="bench-sub">Testing {benchStep === 'high' ? '4K' : benchStep === 'standard' ? '1080p' : '720p'}</div>
        {:else if benchResult}
          <div class="bench-title">Your phone handles</div>
          <ul class="bench-list">
            <li><b>4K</b><span>{benchResult.results.high} fps · {fpsLabel(benchResult.results.high)}</span></li>
            <li><b>1080p</b><span>{benchResult.results.standard} fps · {fpsLabel(benchResult.results.standard)}</span></li>
            <li><b>720p</b><span>{benchResult.results.smooth} fps · {fpsLabel(benchResult.results.smooth)}</span></li>
            {#if benchResult.mic}
              <!-- Phrased as what it MEANS, not as a spec: "Mono" on its own is a fact a guest can
                   do nothing with, and it reads as a fault. Browsers record mono on nearly every
                   phone; the camera app is the way to stereo, and that button is already here. -->
              <li><b>Sound</b><span>
                {benchResult.mic.channels >= 2 ? 'Stereo' : 'Mono — your camera app records stereo'}
              </span></li>
            {/if}
          </ul>
          <div class="bench-sub">
            We've set you to <b>{benchResult.best === 'high' ? '4K' : benchResult.best === 'standard' ? '1080p' : '720p'}</b>.
            Change it any time in settings.
          </div>
          <!-- If 4K did not hold 30fps, the honest answer is that this phone records better in its OWN
               camera app than in a browser. Say so and hand them the button, rather than letting them
               find out on a clip they cannot re-shoot. -->
          {#if benchResult.best !== 'high'}
            <div class="bench-native">
              <span>4K didn't hold up in the browser on this phone — your own camera app will do better if you want it.</span>
              {#if !showShapes}
                <!-- The phone's camera will not honour the event's frame shape, so ask nicely. -->
                <span class="bench-note">This event is square, so try to frame it that way — your camera app won't do it for you.</span>
              {/if}
              {#if videoMaxSecs > 0}
                <span class="bench-note">Keep it to about {videoMaxSecs}s — that's this event's limit.</span>
              {/if}
              <button class="btn ghost sm" on:click={() => { benchResult = null; benchPrompt = false; void setVideoQuality('phone'); openNativeVideo(); }}>
                🎥 Shoot with my own camera
              </button>
            </div>
          {/if}
          <button class="btn primary sm" on:click={() => { benchResult = null; benchPrompt = false; }}>Got it</button>
        {:else}
          <div class="bench-title">Check what your phone can record?</div>
          <div class="bench-sub">A few seconds. Phones vary a lot, and it's better to find out now than halfway through a clip.</div>
          <div class="bench-actions">
            <button class="btn ghost sm" on:click={() => { benchPrompt = false; try { if (ev) localStorage.setItem(benchKey(ev.joinCode), JSON.stringify({ skipped: true, at: Date.now() })); localStorage.setItem(BENCH_NEVER, '1'); } catch { /* ignore */ } }}>Skip — don’t ask again</button>
            <button class="btn primary sm" on:click={() => { benchPrompt = false; void runVideoBenchmark(); }}>Check my camera</button>
          </div>
        {/if}
      </div>
    {/if}
    {#if videoStruggling && videoMode && !recording}
      <div class="vid-fallback">
        <span>Choppy? Your phone's own camera will do better.</span>
      {#if !showShapes}<span class="bench-note">This event is square — try to frame it that way.</span>{/if}
      {#if videoMaxSecs > 0}<span class="bench-note">Keep it to about {videoMaxSecs}s.</span>{/if}
        <button class="btn primary sm" on:click={() => { void setVideoQuality('phone'); openNativeVideo(); }}>🎥 Use phone camera</button>
      </div>
    {/if}
    {#if outOfShots && (canAskHost || canBuyShots)}
      <!-- Bound so a press on the spent shutter can take the guest here — see announceNoShots().
           Focus goes to the first BUTTON inside rather than to the panel, because the panel is a
           div and the thing worth reaching is the way forward, not the heading above it. -->
      <div class="oos-panel" bind:this={oosPanelEl}>
        <div class="oos-title">That's your roll</div>
        <div class="oos-actions">
          {#if canAskHost}
            <button class="btn soft sm" on:click={askHostForMore} disabled={askedHost}>
              {askedHost ? '✓ Host asked' : 'Ask the host for more'}
            </button>
          {/if}
          {#if canBuyShots}
            <button class="btn primary sm" on:click={buyMoreShots} disabled={buying}>
              {buying ? 'Opening…' : 'Get 12 more'}
            </button>
          {/if}
        </div>
        <!-- The moment a guest finishes is the moment they have an opinion. The panel itself is
             the shared component; this card only supplies the trigger. -->
        {#if sessionToken && !feedbackDone}
          <div class="oos-fb">
            {#if !feedbackOpen}
              <button class="fb-trigger" on:click={() => { feedbackOpen = true; trackEvent('guest_feedback_opened', undefined, ev?.joinCode); }}>💬 Leave feedback</button>
            {/if}
            <GuestFeedback sessionToken={sessionToken ?? ''} showCta={false} bind:open={feedbackOpen} bind:done={feedbackDone} />
          </div>
        {/if}
      </div>
    {/if}
  </div>
{:else if screen === 'gallery'}
  <div class="gallery">
    <header>
      <h2><Logo word={false} color={ev?.theme?.accent ?? ''} /> {ev?.name}</h2>
      <div class="gallery-actions">
        {#if queueNeedsAttention}
          <button class="btn ghost sm queue-btn" on:click={() => (drawerOpen = true)} aria-label="Upload queue{pendingCount ? ` (${pendingCount} uploading)` : ''}">
            ⬆ Queue{#if pendingCount}<span class="qbadge" class:error={hasUploadError}>{pendingCount}</span>{/if}
          </button>
        {/if}
        <!-- The whole roll in one go. On iPhone this is the only route into Photos short of tapping
             every photo — several files go into one share, which offers "Save N Images". Offered
             only when the host has allowed downloads, and only when there is more than one to save
             (for a single shot the button on the photo itself is the shorter path). -->
        {#if allowDownloads && myShotCount > 1}
          {#if selecting}
            <button class="btn ghost sm" on:click={toggleSelecting}>Cancel</button>
          {/if}
          <button class="btn ghost sm" on:click={beginDownload} disabled={bulkSaving}
                  aria-label={selecting
                    ? `Download the ${selectedIds.size} shot${selectedIds.size === 1 ? '' : 's'} you picked`
                    : 'Download your photos'}>
            {#if bulkSaving}Saving {bulkProgress}…
            {:else if bulkDone}{bulkDone}
            {:else if selecting}<DownloadIcon /> Download {selectedIds.size || ''}
            {:else}<DownloadIcon /> Download{/if}
          </button>
        {/if}
        <button class="btn ghost sm" on:click={backToCamera}>📷 Camera</button>
      </div>
    </header>
    {#if !galleryRevealed}
      <div class="notice">
        <span aria-hidden="true">🔒</span>
        <span>{revealMsg}{#if galleryPhotos.length}{' '}Only you can see your own shots until then.{/if}</span>
      </div>
    {/if}
    {#if shownPhotos.length}
      <!-- --tile-ar is the EVENT's shape, not the guest's current one. The shape control changes
           what the NEXT photo is cropped to; it is not a statement about how the roll should be
           drawn. Letting it redraw the grid meant the same photos were square in the gallery and
           9:16 in the roll on any event with more than one shape enabled — which is every demo. -->
      <div class="pgrid"
           style={`--tile-ar:${tileAspect(allowedAspects)}`}>
        {#each shownPhotos as p, i}
          <!-- The card itself is PhotoCard; the only thing this roll adds is the delete bin, which
               goes in the tile slot because the bin belongs ON the photo. Own photos only for the
               editable caption — this roll holds nothing else, but the guard is the rule, not the
               filter that happens to be upstream of it. -->
          <PhotoCard photo={p} shotNumber={shownPhotos.length - i} saved={saved.has(p.id)}
                     tileAr={tileAspect(allowedAspects)}
                     captionMode={p.isOwn ? 'edit' : 'static'}
                     selectable={selecting} selected={selectedIds.has(p.id)}
                     canDownload={allowDownloads && !selecting}
                     saving={savingOne === p.id}
                     hearts={ev?.heartsEnabled ? (heartCounts[p.id] ?? 0) : undefined}
                     showHeartCount={false}
                     hearted={heartMine.has(p.id)}
                     canHeart={!!sessionToken && !selecting}
                     on:heart={(e) => toggleHeart(p, e.detail)}
                     on:open={() => onRollTap(p, i)}
                     on:download={() => saveOne(p)}
                     on:caption={() => openCaption(p)}>
            <svelte:fragment slot="tile">
              {#if canDelete(p, nowTick) || confirmingDeleteId === p.id}
                <button class="pcell-bin" class:confirm={confirmingDeleteId === p.id}
                        on:click|stopPropagation={() => (confirmingDeleteId === p.id ? deletePhoto(p.id) : (confirmingDeleteId = p.id))}
                        title={confirmingDeleteId === p.id ? 'Tap again to delete' : `Delete this shot — ${secsLeft(p, nowTick)}s left`}
                        aria-label={confirmingDeleteId === p.id ? 'Tap again to confirm deleting this shot' : `Delete this shot, ${secsLeft(p, nowTick)} seconds left`}>
                  {#if confirmingDeleteId === p.id}
                    Sure?
                  {:else}
                    🗑️<span class="bin-secs">{secsLeft(p, nowTick)}</span>
                  {/if}
                </button>
              {/if}
            </svelte:fragment>
          </PhotoCard>
        {/each}
      </div>
    {:else}
      <div class="empty">
        <span class="big">{galleryRevealed ? '📷' : '🔒'}</span>
        <p class="muted">You haven’t taken any photos yet.</p>
      </div>
    {/if}
    <!-- Below the roll on purpose: this is the "what next", read after a guest has looked at their
         own shots. Gated on the gallery actually being OPEN — instant reveal, or a host who
         revealed early — and on somebody else having shot something, because a link to a gallery
         holding only your own photos is a round trip to nowhere. Once an event ENDS revealed the
         load-time redirect gets there first, so this is the during-the-event route. -->
    <!-- `othersCount > 0` is the rule for a real event: a link to a gallery holding only your own
         photos is a round trip to nowhere. A DEMO is the exception, and deliberately — it is seeded
         with photos and the whole point is the tour, so a visitor who has shot nothing yet still
         needs somewhere to see what a gallery looks like. This is where the demo's third top-bar
         button went. -->
    {#if ev?.joinCode && galleryRevealed && (othersCount > 0 || ev?.isDemo)}
      <a class="full-gallery" href={ev?.isDemo ? demoGalleryHref : `/gallery/${ev.joinCode}`}>
        🖼️ See everyone's photos{#if faceMatching}{' '}— and find the ones you're in{/if} →
      </a>
    {/if}
    <!-- The real entry point, and deliberately not on the camera screen: nothing new goes near the
         shutter. Here a guest is already looking at their own shots, which is the moment they think
         about keeping them — and it is the only way back for someone who skipped the address on the
         join screen, so it registers one as well as setting the flag. -->
    {#if sessionToken}
      <div class="optin">
        {#if wantsPhotos}
          <p class="optin-h">✓ {optInLine}</p>
          {#if optInNote}<p class="optin-note">{optInNote}</p>{/if}
          <button class="optin-undo" on:click={undoPhotoOptIn} disabled={optInBusy}>
            {optInBusy ? 'Changing…' : 'Actually, no thanks'}
          </button>
        {:else if optInAsking}
          <p class="optin-h">Where should we send them?</p>
          <div class="optin-row">
            <input type="email" inputmode="email" autocomplete="email" bind:value={optInDraft}
                   placeholder="you@example.com"
                   aria-label="Your email, so we can send your photos when the event ends" />
            <button class="btn primary sm" on:click={requestPhotoOptIn} disabled={optInBusy}>
              {optInBusy ? 'Saving…' : 'Send them'}
            </button>
          </div>
          <button class="optin-undo" on:click={() => { optInAsking = false; optInDraft = ''; }}>Not now</button>
        {:else}
          <button class="optin-cta" on:click={requestPhotoOptIn} disabled={optInBusy}>
            📬 {optInBusy ? 'One sec…' : 'Want your shots when the event ends?'}
          </button>
        {/if}
      </div>
    {/if}
    <!-- The same offer, in the gallery: this is where a guest lands after a failed upload, and
         telling them they are out of shots without showing the way forward is a dead end. -->
    {#if photosRemaining <= 0 && (canAskHost || canBuyShots)}
      <div class="oos-panel oos-inline">
        <div class="oos-title">That's your roll</div>
        <div class="oos-actions">
          {#if canAskHost}
            <button class="btn soft sm" on:click={askHostForMore} disabled={askedHost}>
              {askedHost ? '✓ Host asked' : 'Ask the host for more'}
            </button>
          {/if}
          {#if canBuyShots}
            <button class="btn primary sm" on:click={buyMoreShots} disabled={buying}>
              {buying ? 'Opening…' : 'Get 12 more'}
            </button>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Referral surface 2: a guest lands here when their roll is spent, which is the moment they
         have just finished using the product. Emphasised only then, not on a casual gallery peek. -->
    {#if ev?.joinCode}
      <!-- Feedback rides INSIDE this card rather than as a second one beside it. Two stacked cards
           at the foot of a gallery read as clutter, and the ask is secondary to the referral. -->
      <StartYourOwn sourceJoinCode={ev.joinCode} emphasis={photosRemaining === 0 && ownCount > 0}
                    footer={!!sessionToken && !feedbackDone}>
        <svelte:fragment slot="foot">
          <GuestFeedback sessionToken={sessionToken ?? ''} bind:done={feedbackDone} />
        </svelte:fragment>
      </StartYourOwn>
    {/if}
  </div>
  <!-- After the reveal this roll can show OTHER people's photos too (Mine / All / Others), so
       saving follows the host's download setting rather than "it is in my gallery". -->
  {#if dlScopeOpen}
    <ShareScope action="download" voice="guest" subject="roll" canFavourite={false} canSelect={true}
                approvedCount={mineAll.length} newCount={mineNew.length}
                videoCount={mineAll.filter((q) => q.mediaType === 'video').length}
                on:pick={(e) => pickDownloadScope(e.detail)} on:close={() => (dlScopeOpen = false)} />
  {/if}
  {#if choosing}
    <DownloadFormat count={choosing.list.length}
                    on:pick={(e) => (e.detail === 'zip' ? chooseZip() : chooseFiles())}
                    on:close={() => (choosing = null)} />
  {/if}
  {#if lbOpen}<Lightbox photos={shownPhotos} index={lbIndex} captionMode="own"
              on:saved={(e) => { if (ev) saved = markSaved(ev.joinCode, [e.detail]); }}
                        allowSave={allowDownloads}
                        on:caption={(e) => openCaption(e.detail)}
                        on:photochange={hideToast}
                        on:close={() => { hideToast(); lbOpen = false; }} />{/if}
  {#if captionFor}
    <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions a11y-no-noninteractive-element-interactions -->
    <div class="capback" on:click|self={() => (captionFor = null)} role="dialog" aria-modal="true" aria-label="Caption this photo">
      <div class="capmodal">
        <div class="capm-head">
          <span>Your caption</span>
          <button class="sm-x" on:click={() => (captionFor = null)} aria-label="Close">✕</button>
        </div>
        {#if captionFor.challenge}
          <!-- The trick stays visible while they type: a caption sits ALONGSIDE the mission, and
               seeing it here is what stops someone retyping the trick as their caption. -->
          <div class="capm-mission">🃏 {captionFor.challenge}</div>
        {/if}
        <!-- svelte-ignore a11y-autofocus -->
        <textarea class="capm-text" rows="2" bind:value={captionDraft} autofocus
                  placeholder="Describe the scene…"></textarea>
        <div class="capm-row">
          <span class="capm-left">{captionRemaining(captionDraft)}</span>
          {#if captionFor.caption}
            <!-- Clearing IS saving nothing — same call, empty text. The button exists because
                 "delete the box out and press Save" is not a thing anyone guesses. -->
            <button class="btn ghost sm" on:click={() => { captionDraft = ''; void saveCaption(); }} disabled={captionBusy}>Remove</button>
          {/if}
          <button class="btn primary sm" on:click={saveCaption} disabled={captionBusy}>{captionBusy ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  {/if}
{/if}

{#if showFeedback}<FeedbackModal context="Camera ({ev?.joinCode ?? ''})" on:close={() => (showFeedback = false)} />{/if}

<!-- Upload queue — shared across the camera and gallery screens; opened on demand. -->
{#if drawerOpen}
  <div class="drawer">
    <div class="drawer-head"><span>Upload queue</span><button class="btn ghost sm" on:click={() => { queue = queue.filter((q) => q.status !== 'done'); drawerOpen = false; }}>Done</button></div>
    {#each queue as item}
      <div class="qitem">
        <span class="qthumb">{item.mediaType === 'video' ? '🎥' : '🖼️'}</span>
        <span class="qcol">
          <span class="qname">{item.mediaType === 'video' ? 'Video' : 'Photo'}</span>
          {#if qmeta(item)}<span class="qmeta">{qmeta(item)}</span>{/if}
        </span>
        <span class="qstatus {item.status}">{item.status === 'error' ? item.error : item.status === 'uploading' ? `${item.progress ?? 0}%` : item.status}</span>
        {#if item.status === 'error'}<button class="btn ghost sm" on:click={() => retryItem(item)}>Retry</button>{/if}
      </div>
    {/each}
    {#if !queue.length}<p class="qempty">Nothing in the queue.</p>{/if}
  </div>
{/if}

<style>
  .center { position: fixed; inset: 0; display: flex; align-items: safe center; justify-content: center; padding: 24px; background: var(--bg); overflow-y: auto; }
  .msg { text-align: center; } .big { font-size: 56px; display: block; margin-bottom: 12px; }
  .muted { color: var(--text-muted); }
  .spinner { width: 32px; height: 32px; border: 3px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 12px 18px; border: 1px solid transparent; cursor: pointer; text-decoration: none; font-size: 0.95rem; }
  .btn.primary { background: var(--accent-fill); color: var(--accent-ink, #111); width: 100%; }
  .btn.ghost { border-color: var(--border); color: var(--text); background: transparent; }
  /* Between ghost and primary. A ghost button on the out-of-shots card reads as a line of text
     rather than as something to press — and that card is a DARK overlay in both themes, so in the
     light theme a --text label on it is nearly invisible. A light wash of the accent gives it a
     button's shape without letting it compete with the solid primary beside it; the wash is the
     same one .roll-note already uses on the join screen for the same job. */
  .btn.soft { border-color: var(--accent); color: var(--text);
    background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .btn.sm { padding: 7px 12px; font-size: 0.82rem; }

  /* Event image as the sign-in backdrop, with the join form in a readable card.
     FIXED, not absolute. `.center` scrolls (overflow-y:auto), and an absolutely positioned backdrop
     scrolls with it — so the moment the card grew taller than the screen (a blurb, a long name, the
     event-info block) the image slid up and off, and the bottom of the join form sat on bare --bg.
     Measured on a 390x640 screen: after scrolling to the button, the bottom 95px had no backdrop at
     all. Fixed to the viewport it cannot go anywhere, however long the card gets. */
  .join-bg { position: fixed; inset: 0; z-index: 0; overflow: hidden; }
  .join-bg-blur { position: absolute; inset: -24px; background-size: cover; background-position: center; filter: blur(26px) brightness(0.5); }
  /* COVER on a portrait screen, which is every phone, and every phone is how a guest arrives — they
     scanned a QR code. The host frames the image in a 3:4 cropper that promises "how guests see the
     join screen", and `contain` broke that promise: a 3:4 crop letterboxed into a ~9:19.5 phone is a
     shallow band of photo across the middle with darkened blur above and below, which is what "it
     doesn't align well" looks like.
     Wide screens keep `contain`, which is what it was for — a portrait crop cropped AGAIN to fill a
     landscape monitor loses the top and bottom of the host's framing, and there the blurred fill
     beside it reads as deliberate rather than as a gap. */
  .join-bg-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  @media (min-aspect-ratio: 1/1) { .join-bg-img { object-fit: contain; } }
  .center.hasbg::after { content: ''; position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 1; }
  .join { width: 100%; max-width: 340px; text-align: center; position: relative; z-index: 2; }
  .join.card { background: rgba(20,16,10,0.62); backdrop-filter: blur(6px); border: 1px solid rgba(255,255,255,0.12);
    border-radius: var(--radius); padding: 26px 22px; }
  .join.card :is(h1, label, .muted) { color: #fff; }
  .join.card .muted { opacity: 0.8; }
  .join h1 { margin: 8px 0 4px; }
  .join .blurb { margin: 2px 0 10px; color: var(--text); font-size: 0.95rem; line-height: 1.45; white-space: pre-wrap; }
  .join-logo { display: flex; justify-content: center; margin-bottom: 6px; font-size: 1.4rem; }
  .roll-note { margin: 4px 0 8px; padding: 9px 12px; border: 1px solid var(--accent); border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--text); font-size: 0.88rem; line-height: 1.35; }
  .join.card .roll-note { color: #fff; }
  /* Collapsible event info — closed by default so the join screen fits one mobile screen. */
  .evinfo { text-align: left; margin: 0 0 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .evinfo summary { cursor: pointer; padding: 8px 12px; font-size: 0.82rem; font-weight: 700; color: var(--text-muted); }
  .join.card .evinfo { border-color: rgba(255,255,255,0.2); }
  .join.card .evinfo summary { color: #fff; }
  .evinfo-body { padding: 2px 12px 10px; display: flex; flex-direction: column; gap: 7px; }
  .ei-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 0.8rem; color: var(--text-muted); }
  .join.card .ei-row { color: rgba(255,255,255,0.85); }
  .ei-k { font-weight: 700; }
  .ei-row .chips { display: flex; flex-wrap: wrap; gap: 5px; justify-content: flex-end; }
  .chip { font-size: 0.72rem; font-weight: 700; padding: 3px 8px; border-radius: 999px;
    background: var(--surface-2); border: 1px solid var(--border); color: var(--text); }
  .join.card .chip { background: rgba(255,255,255,0.14); border-color: rgba(255,255,255,0.2); color: #fff; }
  .join label { display: block; text-align: left; font-size: 0.8rem; color: var(--text-muted); margin: 14px 0 5px; }
  .join input { width: 100%; padding: 12px 14px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); -webkit-text-fill-color: var(--text); font-size: 1rem; }
  .join-hint { text-align: left; font-size: 0.74rem; color: var(--text-muted); margin: 7px 2px 4px; line-height: 1.4; }
  /* Not red, and not an error: nothing has gone wrong yet. It is the one line on the form that has
     become an instruction, so it stops being grey and nothing more. */
  .join-hint.needs { color: var(--text); font-weight: 600; }
  .req { color: var(--accent); font-weight: 600; }
  .join .btn { margin-top: 20px; }
  .manage-link { display: inline-block; margin-top: 16px; font-size: 0.78rem; color: var(--text-muted); text-decoration: none; }
  .manage-link:hover { color: var(--accent); text-decoration: underline; }

  .cam { --round-size: 52px; position: fixed; inset: 0; background: #000; overflow: hidden; z-index: 10;
    /* Where the Photo/Video pill sits, and how tall it is. Anything stacked ABOVE the pill measures
       from these rather than carrying its own copy of the number — the install strip was written
       with a separate 132px, the pill's top edge is at 139px, and it spent the whole time sitting
       7px into it. The height is the pill's own rules added up: 2x3px container padding, 2x5px
       button padding, and one 0.78rem line — which is why .modes button pins its line-height
       instead of inheriting, so a phone's font scaling moves this with it rather than past it. */
    --modes-bottom: 108px;
    --modes-h: calc(16px + 0.78rem * 1.2);
    /* The first clear line above the pill. Everything that stacks there uses THIS, so two things
       cannot end up with different ideas of where the pill stops — which is the bug this whole
       group of variables exists to stop happening again. */
    --above-modes: calc(var(--modes-bottom) + var(--modes-h) + 12px); }
  /* The viewfinder fills the whole screen; controls overlay it (native-camera style), so
     'full' aspect is truly edge-to-edge and fixed ratios sit behind the floating controls. */
  .viewfinder { position: absolute; inset: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .mirrored { transform: scaleX(-1); }
  /* Same box and same fit as the <video> it stands in for, so the frame does not jump as it takes
     over. Dimmed, because a still that looks live is worse than a black screen — the guest waits
     for a picture that is already there. */
  .freeze { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: none;
    z-index: 1; filter: brightness(0.55); }
  .freeze.on { display: block; }
  .fill { position: absolute; inset: 0; background: #fff; z-index: 5; }
  /* The shutter blink: black in, quick fade out, never in the way of a tap. Kept under the control
     rail's z-index so the shutter button itself stays visible through it — the blink is about the
     viewfinder, not the whole app. */
  .blink { position: absolute; inset: 0; background: #000; z-index: 6; pointer-events: none;
    animation: blinkout 180ms ease-out forwards; }
  @keyframes blinkout { 0% { opacity: 1; } 55% { opacity: .92; } 100% { opacity: 0; } }
  /* Photosensitivity: a hard full-screen flash is exactly the thing to avoid. Keep the confirmation
     but make it a gentle dim rather than a blackout. */
  @media (prefers-reduced-motion: reduce) {
    .blink { animation: none; background: rgba(0,0,0,.35); opacity: 0; transition: opacity 160ms linear; }
  }
  .cam-error { position: absolute; inset: 0; z-index: 12; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 14px; text-align: center; padding: 32px; background: rgba(0,0,0,0.85); color: #fff; }
  /* Quieter than the "Camera is off" line above it: that is the state, this is the reasoning, and
     the reasoning should not shout as loudly as the fact. Held near 34em so it does not run to
     full width on a phone in landscape, where the line would otherwise be unreadably long. */
  .off-why { margin: -4px 0 0; max-width: 34em; font-size: 0.82rem; line-height: 1.5; opacity: 0.78; }
  /* z-index 3: above the video + gesture layer, but below the controls (z 6) — so the black
     mask covers only the camera image while the top bar, counter and menus stay visible. */
  .cam-loading { position: absolute; inset: 0; z-index: 3; display: flex; align-items: center; justify-content: center; background: #000; }
  .cam-spinner { width: 38px; height: 38px; border: 3px solid rgba(255,255,255,0.25); border-top-color: #fff; border-radius: 50%; animation: camspin 0.8s linear infinite; }
  @keyframes camspin { to { transform: rotate(360deg); } }
  .cam-error .big { font-size: 48px; }
  .cam-error p { max-width: 30ch; line-height: 1.4; }
  .cam-error .btn { width: auto; min-width: 150px; }
  /* The denial screen carries more than one line, so it needs room the generic error state does not. */
  .cam-denied { gap: 12px; padding: 24px 22px; }
  .cd-lead { font-size: 1.02rem; font-weight: 600; max-width: 26ch; }
  .cd-list { list-style: none; margin: 0; padding: 0; max-width: 30ch; text-align: left;
    display: flex; flex-direction: column; gap: 6px; font-size: .88rem; line-height: 1.45; opacity: .92; }
  .cd-list li::before { content: '✓ '; opacity: .65; }
  .cd-hint { font-size: .78rem; opacity: .72; max-width: 32ch; line-height: 1.5; margin-top: 2px; }
  /* Full-stage gesture layer: drag left/right to set brightness, tap to focus. Sits above the
     video but below the controls (z 6). touch-action:none stops the browser hijacking the swipe. */
  .gesture-layer { position: absolute; inset: 0; z-index: 2; background: transparent; touch-action: pan-y; -webkit-tap-highlight-color: transparent; }
  /* THE REASON THE BRIGHTNESS SWEEP DID NOTHING WHEN THE PHONE WAS TURNED WITH ROTATION LOCKED.
     `touch-action` decides who gets a gesture before any JS runs. `pan-y` hands VERTICAL dragging
     to the browser for scrolling and lets horizontal ones through — right while the page and the
     person agree on which way is sideways. Turn the phone inside a locked layout and the person's
     sideways becomes the page's VERTICAL, so the sweep the brightness control wants is exactly the
     one the browser was taking. The axis arithmetic in onGesturePointerMove was already correct and
     never got the chance to run, because the pointer events stopped arriving.
     Swapped, not removed: the browser still needs an axis to scroll on, and with the phone turned
     that axis is the page's horizontal. */
  .gesture-layer.tilted { touch-action: pan-x; }
  /* Centred, but never wide enough to reach the control rail on the right.
     At its natural ~262px it clears the rail on a 390px phone by 10px and OVERLAPS it by 5px on a
     360px one, which is a very common Android width — so the collision depended on the handset.
     Reserving the rail's column (14px offset + 40px button, plus room to breathe) makes it a
     property of the layout instead of a coincidence of screen size. The bar below shrinks to suit,
     which costs nothing: it is a relative level, not a measurement anybody reads off in pixels. */
  /* Counter-rotated like the glyphs, and for the same reason: with rotation LOCKED the page never
     turns, so a pill that runs left-to-right on the page runs top-to-bottom for the person holding
     the phone sideways — a brightness bar that reads as a vertical column, with a horizontal sweep
     driving it. Everything else in this overlay already turns (see .rot/.counter/.mwrap); the HUD
     was simply missed.
     Turned, it goes to the page edge that is the PERSON's top — after rotate(90deg) the pill's own
     up points along the page's +x, so the page's RIGHT edge is up there, and the mirror for -90.
     That puts it where portrait puts it from the only point of view that matters: the top of what
     you are looking at, centred.

     The inset off that edge is the icon row's own height, not a token 14px. At 14px the pill landed
     in the icons; the row is the thing it has to clear, so the row's height is the measurement that
     actually answers the question, and it follows the row if that ever changes.

     Placed by its CENTRE, because rotation happens about the centre: anchoring the upright box's
     edge would leave the turned pill about half its own WIDTH (~100px, and it changes with the
     label) from where it was asked to be. translate(50%) puts the centre on the page edge, the
     inset brings it in, and the final translateY — applied in the already-rotated frame — backs it
     off by half the pill's HEIGHT, which is what sticks out sideways once it is turned. Never needs
     either dimension as a number. */
  .bright-hud.tilted { top: 50%; bottom: auto; }
  .bright-hud.tilted.cw  { left: auto; right: 0;
    transform: translate(calc(50% - var(--hud-top)), -50%) rotate(90deg) translateY(50%); }
  .bright-hud.tilted.ccw { right: auto; left: 0;
    transform: translate(calc(-50% + var(--hud-top)), -50%) rotate(-90deg) translateY(50%); }
  .bright-hud { --hud-top: var(--topbar-h, 72px);
    position: absolute; top: var(--hud-top); left: 50%; transform: translateX(-50%); z-index: 5;
    transition: transform 0.2s ease;
    max-width: calc(100% - 140px);
    display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 999px;
    background: rgba(0,0,0,0.6); color: #fff; backdrop-filter: blur(4px); }
  .bright-hud > span:first-child { font-size: 1rem; }
  /* Shrinkable, so the cap above takes it out of the bar rather than out of the readout or the
     reset button — a number cut in half is unreadable, a shorter bar is just a shorter bar. */
  .bright-bar { width: 120px; min-width: 44px; flex: 0 1 120px; height: 5px; border-radius: 3px; background: rgba(255,255,255,0.25); overflow: hidden; }
  .bright-fill { height: 100%; background: var(--accent-fill); }
  .bright-val { font-family: var(--font-mono); font-size: 0.72rem; min-width: 38px; text-align: right; flex: none; }
  .focus-ring { position: absolute; z-index: 4; width: 76px; height: 76px; margin: -38px 0 0 -38px; border: 2px solid #fff;
    border-radius: 50%; box-shadow: 0 0 0 1px rgba(0,0,0,.3); pointer-events: none; animation: focuspulse 0.85s ease-out forwards; }
  @keyframes focuspulse { 0% { transform: scale(1.4); opacity: 0; } 25% { transform: scale(1); opacity: 1; } 100% { transform: scale(0.9); opacity: 0; } }
  /* Deliberately NOT inset for a notch. Tried it, reverted it: growing the top padding pushed the
     counter and the trick badge down into the control rail, which is pinned at top:64px and does
     not move with them. Clearing a cutout would mean moving the rail too, and the rail's position
     is load-bearing for the landscape layout — a lot of moving parts to dodge a hole whose position
     the browser will not tell us anyway (see the note below on what the insets actually give you). */
  /* center, not flex-start. The row holds things of different heights — a one-line event name, a
     trick pill, and a counter with a caption stacked under it — and aligning them to their TOPS
     left the short ones riding high above the tall one instead of reading as one row. */
  .topbar { position: absolute; top: 0; left: 0; right: 0; z-index: 6; padding: 16px 20px; display: flex; justify-content: space-between; align-items: center; gap: 14px; background: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent); pointer-events: none; }
  .evname { unicode-bidi: plaintext; display: inline-flex; align-items: center; gap: 7px; font-family: var(--font-mono); font-size: 0.85rem; color: #fff; }
  .demo-nav { display: flex; gap: 6px; flex-wrap: wrap; }
  /* Beside the event name rather than in place of it: a host still needs to see which event they
     are standing in. */
  .host-btn { flex: none; margin-left: 8px; }
  /* Demo-only escape hatch back to the marketing site. pointer-events:auto re-enables
     clicks inside the otherwise click-through topbar.
     This and .mbadge are two writings of ONE idea — a tappable pill on the dark viewfinder overlay
     — and they sat side by side in the same topbar having drifted apart, one bordered and one not,
     which read as the demo pills being flat rather than as a deliberate difference. Keep the border,
     the radius and the blur in step between them until they are properly made one thing. */
  .home-btn { pointer-events: auto; display: inline-flex; align-items: center; gap: 6px;
    background: rgba(0,0,0,0.5); color: #fff; text-decoration: none; font-weight: 700; font-size: 0.8rem;
    padding: 8px 14px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, .28);
    backdrop-filter: blur(4px); }
  .pcell-bin {
    position: absolute; top: 6px; right: 6px; min-width: 30px; height: 26px; padding: 0 7px;
    display: inline-flex; align-items: center; justify-content: center; gap: 3px;
    font-size: .74rem; line-height: 1; border-radius: 999px; cursor: pointer;
    background: rgba(0,0,0,.6); color: #fff; border: 1px solid rgba(255,255,255,.4);
    backdrop-filter: blur(3px);
  }
  .pcell-bin:active { transform: scale(.94); }
  .pcell-bin.confirm {
    background: #c0392b; border-color: #e6795f; font-weight: 700; letter-spacing: .01em;
    min-width: 52px;
  }
  .bin-secs { font-variant-numeric: tabular-nums; opacity: .75; }
  /* align-SELF, not just align-items: this pins the group to the top of the bar so its position
     never depends on how tall the thing beside it is. The demo nav carries two pills, and below
     ~380px they wrap to a second row — which doubled the bar's height and, under the row's
     align-items:center, pushed the trick list and the shot counter 16px down the screen. The
     counter is a fixed point a guest glances at; it does not move because the demo grew a button. */
  .topright { display: flex; align-items: flex-start; align-self: flex-start; gap: 14px; }
  /* Centred, not right-aligned. The word sits under a number that changes width as the roll runs
     down — 24, then 9, then 3 — and aligning their right edges left it visibly off-centre under
     every count but the widest one. */
  .counter { font-family: var(--font-mono); font-size: 1.5rem; font-weight: bold; color: #fff; text-align: center; line-height: 1; }
  .counter.low { color: var(--danger); } .counter small { display: block; font-size: 0.6rem; opacity: 0.7; text-transform: uppercase; }
  .rail { position: absolute; top: 64px; right: 14px; display: flex; flex-direction: column; gap: 10px; z-index: 6; }
  /* ── Turning with the phone ──────────────────────────────────────────────────
     Glyphs turn, the layout does not — what a native camera app does when you rotate the phone
     with rotation lock on. --glyph-rot is 0 unless the PHONE is sideways while the PAGE is not, so
     on every ordinary device this is a no-op rotation of zero degrees.

     What can and cannot simply be turned, because a transform does NOT reflow anything:
     - A round control turns freely. Its box is square and its outline is a circle, so nothing about
       the layout notices and only the character inside appears to move.
     - A compact block (the shot counter, the trick count) turns in place. Its box stays put and the
       visual is close enough to square that it does not reach its neighbours.
     - A WIDE control cannot, and does not try. Turn a 140px-wide pill and the layout still reserves
       140px of width while the visual now stands 140px TALL from the same centre — which is how the
       Photo/Video switch would end up sitting across the shutter. It stays put instead; see .modes.
       A native camera leaves its mode strip alone too. */
  .rot { display: inline-block; transform: rotate(var(--glyph-rot, 0deg)); transition: transform 0.2s ease; }
  @media (prefers-reduced-motion: reduce) { .rot { transition: none; } }

  /* Compact enough to turn where they stand. */
  .counter, .mwrap { transform: rotate(var(--glyph-rot, 0deg)); transition: transform 0.2s ease; }
  @media (prefers-reduced-motion: reduce) { .counter, .mwrap { transition: none; } }
  /* The count and its caption are stacked, so turning the pair together lays them out side by side
     and upright — the label stays with the thing it labels instead of being turned apart from it. */

  .ctrl { width: 40px; height: 40px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.25); background: rgba(0,0,0,0.45); color: #fff; font-size: 0.95rem; cursor: pointer; display: flex; align-items: center; justify-content: center;
          transform: rotate(var(--glyph-rot, 0deg)); transition: transform 0.2s ease; }
  @media (prefers-reduced-motion: reduce) { .ctrl { transition: none; } }
  .ctrl.active { border-color: var(--accent); background: rgba(245,197,24,0.25); }
  .ctrl.tiny { width: 34px; height: 34px; font-size: 0.85rem; flex: none; }
  .ctrl:disabled { opacity: 0.35; cursor: default; }
  /* Struck through rather than removed — see the flash button in the rail. The line is drawn
     rather than swapped in as a different glyph so it lands identically whatever the emoji font
     does with ⚡, and it counter-rotates with the glyph so it stays across the icon when the phone
     is turned sideways. It leans top-left to bottom-right: the other way round runs PARALLEL to the
     bolt and reads as a second bolt rather than a strike, and it would lean against the disabled
     camera glyph sitting directly under it in the same rail. */
  .ctrl.noflash { position: relative; }
  .ctrl.noflash::after {
    content: ''; position: absolute; left: 50%; top: 50%; width: 26px; height: 2px;
    background: currentColor; border-radius: 1px; box-shadow: 0 0 2px rgba(0,0,0,.8);
    transform: translate(-50%, -50%) rotate(45deg); pointer-events: none;
  }

  /* Settings as a centred modal (covers the whole camera stage). */
  .settings-back { position: absolute; inset: 0; z-index: 20; background: rgba(0,0,0,0.55);
    display: flex; align-items: center; justify-content: center; padding: 20px; }
  .settings-modal { width: 100%; max-width: 320px; max-height: 90%; overflow: auto;
    background: rgba(20,20,20,0.96); border: 1px solid rgba(255,255,255,0.15); border-radius: 16px;
    padding: 6px 16px 16px; color: #fff; box-shadow: 0 16px 50px rgba(0,0,0,0.6); }
  .sm-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 0 10px;
    border-bottom: 1px solid rgba(255,255,255,0.12); font-weight: 800; font-size: 0.95rem; margin-bottom: 6px; }
  .sm-x { background: none; border: none; color: rgba(255,255,255,0.7); font-size: 1rem; cursor: pointer; padding: 4px; }
  .sm-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 11px 0;
    border-bottom: 1px solid rgba(255,255,255,0.07); }
  .sm-row.col { flex-direction: column; align-items: stretch; gap: 8px; }
  .sm-row:last-child { border-bottom: none; }
  .sm-labelwrap { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
  .sm-label { font-size: 0.85rem; }
  .sm-desc { font-size: 0.7rem; color: rgba(255,255,255,0.55); line-height: 1.3; }
  .sm-row.col .sm-labelwrap { flex: none; }
  /* Above the shutter, clear of it: the bottom of this screen is the one place a thumb is
     guaranteed to be, and a bar under the thumb is a bar that gets dismissed by accident. */
  .install-offer {
    position: absolute; left: 12px; right: 12px; z-index: 7;
    bottom: var(--above-modes);
    display: flex; align-items: center; gap: 10px;
    padding: 10px 12px; border-radius: 14px;
    background: rgba(0,0,0,0.78); color: #fff; backdrop-filter: blur(6px);
    border: 1px solid rgba(255,255,255,0.22); font-size: 0.8rem; line-height: 1.35;
  }
  .io-txt { flex: 1; min-width: 0; }
  .install-offer button { font: inherit; font-weight: 700; cursor: pointer; border-radius: 999px; flex: none; }
  .io-yes { padding: 7px 14px; border: 0; background: var(--accent-fill, #f5c518); color: var(--accent-ink, #111); }
  .io-no { padding: 7px 8px; border: 0; background: none; color: rgba(255,255,255,.7); }
  .sm-select { width: 100%; background: rgba(0,0,0,0.5); color: #fff; border: 1px solid rgba(255,255,255,0.3);
    border-radius: 8px; padding: 9px 10px; font: inherit; font-size: 0.85rem;
    transition: background 0.12s ease, border-color 0.12s ease, transform 0.08s ease; }
  /* app.css turns the OS tap highlight off for the whole site, which leaves a press with NO
     feedback at all unless something replaces it — on a dark sheet, a tap that does nothing visible
     reads as a tap that missed. Brighter fill and border, plus the same slight squash .pcell-bin
     uses, so the two press the same way. */
  .sm-select:active { background: rgba(255,255,255,0.16); border-color: rgba(255,255,255,0.55); transform: scale(0.985); }
  .ctrl:active { background: rgba(255,255,255,0.22); border-color: rgba(255,255,255,0.5); }
  @media (prefers-reduced-motion: reduce) { .sm-select { transition: none; } .sm-select:active { transform: none; } }
  .sm-note { font-size: 0.74rem; color: rgba(255,255,255,0.75); padding-top: 12px; }
  /* Inside a `.col` row the 8px gap already separates it from the control above, so the note's own
     12px top padding would double the space and break the pairing it is there to make. */
  .sm-note.tight { padding-top: 0; }
  /* Full width and vertically centred — the same box the video gets from the flex viewfinder, so
     the two stay in register at every shape. */
  .grid { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); pointer-events: none; } .grid span { position: absolute; background: rgba(255,255,255,0.2); }
  .grid span:nth-child(1) { left: 33.3%; top: 0; bottom: 0; width: 1px; } .grid span:nth-child(2) { left: 66.6%; top: 0; bottom: 0; width: 1px; }
  .grid span:nth-child(3) { top: 33.3%; left: 0; right: 0; height: 1px; } .grid span:nth-child(4) { top: 66.6%; left: 0; right: 0; height: 1px; }
  /* Clear of the topbar — at top:16px a long event name sat straight over the timer. */
  .rec { position: absolute; top: 64px; left: 50%; transform: translateX(-50%); z-index: 7; color: #fff; background: rgba(0,0,0,0.5); padding: 4px 12px; border-radius: 999px; font-family: var(--font-mono); }
  /* Keeps the shutter row from reflowing when the flip button is hidden mid-recording. It has to be
     EXACTLY the size of .round or it does the opposite of its job: at 44px against a 52px button it
     was 8px short, so starting a clip nudged the shutter sideways — the one control you are aiming
     at, moving at the moment you press it. Both read the same variable now so they cannot drift
     apart again. */
  .round-spacer { display: inline-block; width: var(--round-size); height: var(--round-size); }
  /* Deliberately does NOT turn or move with the phone. It is the widest control on the screen and
     sits directly above the shutter, so turning it in place would stand it on end through the
     shutter, and moving it aside is worse still — the thing you reach for stops being where you
     left it. A native camera leaves its mode strip exactly where it is for the same reason; only
     the round glyphs turn. */
  .modes { position: absolute; bottom: var(--modes-bottom); left: 50%; transform: translateX(-50%); display: flex; background: rgba(0,0,0,0.5); border-radius: 999px; padding: 3px; z-index: 10; }
  .modes button { padding: 5px 14px; line-height: 1.2; border-radius: 999px; border: none; background: transparent; color: rgba(255,255,255,0.6); font-size: 0.78rem; font-weight: 600; cursor: pointer; -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; user-select: none; outline: none; }
  .modes button.on { background: #fff; color: #111; }
  .bottombar { position: absolute; left: 0; right: 0; bottom: 0; z-index: 8; padding: 20px;
    background: linear-gradient(transparent, rgba(0,0,0,0.65)); display: flex; align-items: center; justify-content: space-between; }

  /* ── Landscape: odd, but it has to WORK ──────────────────────────────────────
     We tell people the camera is built upright and offer fullscreen, and some of them will shoot
     sideways anyway. Warning someone is not the same as leaving them a broken screen.

     The whole problem is that landscape has no height. A phone is about 390px tall that way, and
     the vertical rail needs 6 icons x 40px + 5 gaps = 290px starting 64px down, so it ends at 354 —
     while the bottom bar starts at 298. Those 56px of overlap were the flip button sitting on top
     of settings, and the fullscreen icon falling off the bottom entirely.

     There is no shortage of WIDTH: the same phone is 844px across. So the rail runs that way,
     where all six fit in one row with room to spare and nothing is near the bottom bar.

     THIS BLOCK MUST STAY BELOW THE BASE RULES IT OVERRIDES. A media query adds no specificity, so
     an equal-specificity rule later in the file simply wins — which is what happened: sitting
     higher up, the .rail override applied and the .bottombar and .modes ones silently did nothing,
     measuring as 20px and 108px in a browser that was matching the query perfectly.

     Scoped to phones: a tablet in landscape has the height for the normal layout, hence max-height,
     and pointer:coarse keeps it away from a narrow desktop window entirely. */
  @media (orientation: landscape) and (pointer: coarse) and (max-height: 560px) {
    .rail {
      left: 14px;                  /* room to wrap into, should a sixth icon ever not fit */
      /* row-REVERSE, so the first control keeps the corner. In portrait the rail is a column
         running down from the top-right, so the flash is the one in the corner and that is where
         the hand goes looking for it. Plain `row` packed right put the LAST icon in the corner and
         threw the flash to the far side of the screen — the list read as inverted, because from the
         anchor outwards it was. Reversed, the order off the corner is identical in both layouts. */
      flex-direction: row-reverse;
      justify-content: flex-start; /* main-start of row-reverse IS the right edge */
      flex-wrap: wrap;
      gap: 8px;
      /* Clear of the banner, which takes ~80px of a 390px viewport and sits ABOVE this (z 11 vs 6).
         Without this the banner did not merely cover the icons, it took their taps:
         elementFromPoint at each button's centre returned the banner rather than the control.
         --note-bottom is the banner's measured BOTTOM EDGE, published by the banner itself: its
         text wraps at some widths and not others, and it clears the safe area by a margin that
         depends on the phone. Falls back to the normal offset when no banner is up. */
      top: calc(var(--note-bottom, 52px) + 12px);
    }
    /* Give the picture back some of the height the bar spends on padding. The buttons keep their
       size — they are what people are aiming at. */
    .bottombar { padding: 10px 14px; }
    /* Keep the pills the same distance off the shutter as they are in portrait.
       The pills are positioned from the bottom of the screen, and the shutter's top edge is
       (its own height + the bar's padding) up from there, so:

           gap = bottom - shutter_height - bar_padding

       Portrait is 108 - 76 - 20 = 12px. Halving the padding above pushed the shutter's top edge
       10px DOWN without moving the pills, which opened that to 22px — the same 10px, showing up as
       a gap instead of as bar height. Taking 10 off `bottom` puts it back: 98 - 76 - 10 = 12px.
       (And note the earlier attempt at 84px went the wrong way entirely: a smaller `bottom` is
       LOWER, which is what put the pills on top of the shutter.) */
    .cam { --modes-bottom: 98px; }
    /* The spent-roll card grows UPWARDS from a fixed bottom, and sideways there is nothing above it
       to grow into: 390px of screen, the bottom bar owns the last ~96, and a card starting 190px up
       has 200px left for a title, two buttons, and a feedback form that can open underneath them.
       It ran off the top of the screen — not clipped at an edge where it would look wrong, but
       scrolled out of a viewport that does not scroll, so the way forward was simply gone.
       Dropping it to the first clear line above the mode pills gives back ~50px, the extra width
       buys back a wrapped line or two, and the cap means the feedback form can only ever make it
       scroll. Note it does NOT go lower than that: the pills are still live on a spent roll, and a
       card laid across them would trade a card you cannot reach for controls you cannot press. */
    .oos-panel {
      bottom: var(--above-modes);    /* clear of the pill, not across it */
      width: min(420px, 78vw);
      max-height: calc(100dvh - var(--above-modes) - var(--note-bottom, 52px) - 16px);
      overflow-y: auto;
    }
    /* Sideways the rail runs ACROSS the top right, straight through where this sits, so the width
       cap cannot save it — there is nothing to the side any more. It goes below the rail instead,
       off the same measured banner edge, where the gap between the rail and the mode pills is wide
       open. */
    .bright-hud { --hud-top: max(var(--topbar-h, 72px), calc(var(--note-bottom, 52px) + 8px));
      max-width: calc(100% - 32px); }
  }

  /* The WHOLE control turns, not the character inside it.
     Rotating just the glyph left everything hung off the button behind: the hold-for-more "…" kept
     its corner and spun on the spot, so the flip control came apart into two pieces pointing
     different ways. A circular button can turn as a unit — its outline is identical at any angle —
     and then the glyph and everything positioned against it keep their arrangement and turn
     together, which is the point. */
  .round { width: var(--round-size); height: var(--round-size); border-radius: 50%; border: none; background: rgba(255,255,255,0.15); color: #fff; font-size: 1.3rem; cursor: pointer; position: relative;
    transform: rotate(var(--glyph-rot, 0deg)); transition: transform 0.2s ease; }
  @media (prefers-reduced-motion: reduce) { .round { transition: none; } }
  .badge { position: absolute; top: -4px; right: -4px; background: var(--accent-fill); color: var(--accent-ink, #111); border-radius: 999px; min-width: 18px; height: 18px; font-size: 0.65rem; font-weight: bold; display: flex; align-items: center; justify-content: center; padding: 0 4px; }
  .badge.error { background: #c0392b; color: #fff; }
  /* A hold-for-more marker, the same idea as the dot iOS puts on a control that has a long press.
     Only drawn when there IS more than one lens: advertising a gesture that does nothing is worse
     than not advertising it. */
  .round.has-more::after {
    /* An ellipsis, not a single dot or a word. "…" is the long-standing convention for "there is
       more behind this", and it is the only thing that fits: the rail is 52px buttons on a 320px
       phone, so "tap or hold" either shrinks to unreadable or pushes the rail off the screen. The
       one-time tip spells the gesture out in words once; this is the reminder afterwards. */
    /* In its own little disc, sitting on the button's corner like a badge. Bare, the ellipsis was
       three pale dots floating over whatever the camera happened to be pointing at, and it read as
       a rendering artefact as easily as a control. A filled circle is unambiguously a THING, and it
       carries its own contrast instead of relying on a text shadow to survive a bright viewfinder. */
    content: '\22EE'; position: absolute; right: -2px; bottom: -2px;
    /* No rotation of its own: it is positioned against a button that now turns as a unit, so it is
       carried round already. Turning it again would spin it on the spot inside a control that had
       itself moved — the two rotations cancelling into the wrong place. */
    width: 18px; height: 18px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    /* Lighter than it was, still clearly darker than the flip button's own disc
       (rgba(255,255,255,.15)) — it is a marker ON that control, so reading as the same weight would
       make it look like a second button rather than a badge. Vertical dots, because a horizontal
       ellipsis says "truncated text" and a vertical one says "more options" — the convention every
       phone already uses. */
    background: rgba(0,0,0,.42); border: 1px solid rgba(255,255,255,.55);
    font-size: .76rem; line-height: 1; color: rgba(255,255,255,.92); pointer-events: none;
  }
  .lens-back { position: absolute; inset: 0; z-index: 12; display: flex; align-items: flex-end;
    justify-content: center; padding: 0 12px 96px; pointer-events: auto; background: rgba(0,0,0,.34); }
  .lens-sheet { width: min(340px, 92vw); display: flex; flex-direction: column; gap: 6px; padding: 12px;
    border-radius: 16px; color: #fff; background: rgba(0,0,0,.86); border: 1px solid rgba(255,255,255,.22);
    backdrop-filter: blur(6px); }
  .lens-head { font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; opacity: .72; padding: 2px 6px 6px; }
  .lens-row { display: flex; align-items: stretch; gap: 6px; }
  .lens-row .lens-opt { flex: 1; min-width: 0; }
  /* Flex-centred, because what is in it is no longer TEXT. A button centres its inline content for
     free, which is why a ★ character sat dead centre here with no rule at all; StarIcon is a block
     SVG, and a block child ignores that centring and parks at the top left. Every other icon button
     in the product (.ic in SlideshowPanel, .fav-corner in review) already says this outright. */
  .lens-fav { flex: none; width: 44px; display: flex; align-items: center; justify-content: center;
    border-radius: 11px; border: 1px solid rgba(255,255,255,.16);
    background: rgba(255,255,255,.06); color: rgba(255,255,255,.55); font-size: 1rem; cursor: pointer; }
  .lens-fav.on { color: #f0b429; border-color: rgba(240,180,41,.6); background: rgba(240,180,41,.12); }
  .lens-opt { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%;
    padding: 12px 14px; border-radius: 11px; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.06);
    color: #fff; font: inherit; font-size: .92rem; cursor: pointer; text-align: left; }
  .lens-opt.on { border-color: rgba(240,180,41,.75); background: rgba(240,180,41,.14); }
  .lens-now { flex: none; width: 12px; text-align: center; color: #f0b429; font-size: .7rem;
    visibility: hidden; }
  .lens-now.shown { visibility: visible; }
  .lens-std { flex: none; font-size: .62rem; letter-spacing: .05em; text-transform: uppercase;
    color: var(--text-muted); border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px; }
  .lens-sub { opacity: .55; font-size: .82em; }
  .lens-cancel { margin-top: 4px; padding: 11px 14px; border-radius: 11px; border: 1px solid rgba(255,255,255,.16);
    background: transparent; color: #fff; font: inherit; font-size: .9rem; cursor: pointer; }
  .bench-panel {
    position: absolute; left: 50%; bottom: 190px; transform: translateX(-50%); z-index: 8;
    pointer-events: auto; display: flex; flex-direction: column; align-items: center; gap: 10px;
    padding: 16px 20px; border-radius: 16px; width: min(340px, 88vw); text-align: center; color: #fff;
    background: rgba(0,0,0,.78); border: 1px solid rgba(255,255,255,.22); backdrop-filter: blur(6px);
  }
  .bench-title { font-size: .95rem; font-weight: 700; }
  .bench-sub { font-size: .82rem; opacity: .82; line-height: 1.45; }
  .bench-native {
    display: flex; flex-direction: column; gap: 8px; align-items: center; text-align: center;
    padding: 11px 12px; border-radius: 11px; font-size: .82rem; line-height: 1.45;
    background: rgba(240,180,41,.12); border: 1px solid rgba(240,180,41,.4);
  }
  .bench-note { font-size: .76rem; opacity: .85; }
  .bench-actions { display: flex; gap: 8px; }
  .bench-list { list-style: none; margin: 2px 0; padding: 0; width: 100%;
    display: flex; flex-direction: column; gap: 4px; font-size: .86rem; }
  .bench-list li { display: flex; justify-content: space-between; padding: 4px 8px;
    background: rgba(255,255,255,.08); border-radius: 7px; }
  .bench-list span { font-variant-numeric: tabular-nums; opacity: .8; }
  .vid-fallback {
    position: absolute; left: 50%; bottom: 190px; transform: translateX(-50%); z-index: 7;
    pointer-events: auto; display: flex; flex-direction: column; align-items: center; gap: 9px;
    padding: 14px 18px; border-radius: 16px; width: min(340px, 88vw); text-align: center;
    background: rgba(0,0,0,.72); border: 1px solid rgba(255,255,255,.22); backdrop-filter: blur(6px);
    color: #fff; font-size: .86rem; line-height: 1.4;
  }
  /* Ordinary page content in the roll, never an overlay — see .oos-panel.oos-inline for what
     happens when a card in here inherits the gallery's own min-height. */
  /* max-width alone does nothing below 720px, so on every phone these ran edge-to-edge while the
     photo cards beside them sat 10px in (.pgrid's padding) — the panels read as full-bleed bands
     rather than cards. `min(720px, 100% - 20px)` keeps the centred 720px cap where there is room
     and gives the same 10px gutter where there is not, with no media query. 20px because these are
     SIBLINGS of .pgrid, so half its padding each side puts their edges on the cards' edges. */
  /* ONE card shape for the two "what next" panels under the roll. They are the same object — a
     full-width panel holding one line of offer — and each drew itself separately, which is how the
     opt-in ended up with an accent-bordered button sitting inside an already-bordered card. */
  .optin, .full-gallery {
    max-width: min(720px, 100% - 20px); margin: 0 auto 14px; padding: 12px 16px;
    border: 1px solid var(--border); border-radius: 12px; background: var(--surface);
    color: var(--text); text-decoration: none; font-size: .88rem; font-weight: 600;
  }
  .optin { display: flex; flex-direction: column; gap: 8px; }
  /* Only while it is actually a button. Once the guest has answered, the card is a statement and
     lighting it up on hover would promise a press that does nothing. */
  .optin:has(.optin-cta):hover, .full-gallery:hover { border-color: var(--accent); }
  .optin-h { margin: 0; font-size: .88rem; font-weight: 600; color: var(--text); line-height: 1.4; }
  .optin-note { margin: 0; font-size: .78rem; color: var(--text-muted); line-height: 1.45; }
  /* 44px everywhere: this is read one-handed, in the dark, at a party. */
  /* The CARD is the control. No border and no background of its own: the panel around it already
     draws both, and a second one inside the first is the "border button" look. */
  .optin-cta {
    min-height: 44px; padding: 0; width: 100%; cursor: pointer;
    border: 0; background: transparent;
    color: var(--text); font: inherit; font-size: .88rem; font-weight: 600; text-align: center;
  }
  .optin-cta:disabled { opacity: .6; }
  /* Wraps rather than shrinks: at 360px a side-by-side field and button leave the field too narrow
     to see what you typed, which is the one thing you need to check before tapping send. */
  .optin-row { display: flex; flex-wrap: wrap; gap: 8px; }
  .optin-row input {
    flex: 1 1 180px; min-width: 0; min-height: 44px; padding: 10px 12px; font: inherit; font-size: 1rem;
    border: 1px solid var(--border); border-radius: 10px; background: var(--surface-2);
    color: var(--text); -webkit-text-fill-color: var(--text);
  }
  .optin-row .btn { min-height: 44px; flex: 0 0 auto; }
  .optin-undo {
    align-self: flex-start; min-height: 44px; padding: 4px 2px; background: none; border: none;
    cursor: pointer; color: var(--text-muted); font-size: .82rem; text-decoration: underline;
  }
  /* Qualified with .join to outrank `.join label` and `.join input` above — those are written for
     the stacked name/email fields, and unqualified they flatten this row back to a block label with
     a full-width checkbox, which renders as a grey stripe across the card. */
  .join .join-optin {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    min-height: 44px; margin: 12px 0 0;
    text-align: left; font-size: .84rem; color: var(--text); line-height: 1.35;
  }
  /* The label carries the tap target now — a switch is small, and this is the one thing on the join
     screen a guest is being asked to decide. */
  .join .join-optin label { cursor: pointer; margin: 0; }
  /* max-width alone does nothing below 720px, so on every phone these ran edge-to-edge while the
     photo cards beside them sat 10px in (.pgrid's padding) — the panels read as full-bleed bands
     rather than cards. `min(720px, 100% - 20px)` keeps the centred 720px cap where there is room
     and gives the same 10px gutter where there is not, with no media query. 20px because these are
     SIBLINGS of .pgrid, so half its padding each side puts their edges on the cards' edges. */
  .full-gallery { display: block; text-align: center; }
  .oos-fb { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border, #3a3630); }
  .sm-link {
    background: none; border: none; cursor: pointer; padding: 6px 0 0; text-align: left;
    color: var(--accent, #f0b429); font-size: .82rem; text-decoration: underline;
  }
  .fb-trigger {
    background: none; border: none; cursor: pointer; font-size: .85rem; padding: 2px 4px;
    color: var(--text-muted, #a39b8c); text-decoration: underline;
  }
  .oos-panel {
    /* Clears the shutter rather than sitting over it: the controls row is ~110px tall and the
       button overhangs it, so this starts well above the whole cluster. */
    position: absolute; left: 50%; bottom: 190px; transform: translateX(-50%); z-index: 7;
    /* .topbar-style ancestors are pointer-events:none over a gesture layer that eats taps. */
    pointer-events: auto; display: flex; flex-direction: column; align-items: center; gap: 11px;
    padding: 16px 20px; border-radius: 16px; width: min(340px, 88vw);
    background: rgba(0,0,0,.72); border: 1px solid rgba(255,255,255,.22); backdrop-filter: blur(6px);
    box-shadow: 0 8px 28px rgba(0,0,0,.4);
  }
  /* In the gallery it is ordinary page content, not an overlay. Named oos-inline, NOT .gallery —
     that class belongs to the gallery screen itself and carries min-height:100dvh, which made this
     card expand to fill the viewport. */
  .oos-panel.oos-inline {
    position: static; transform: none; margin: 14px auto; background: var(--surface-2, #1e1b14);
    border-color: var(--border, #3a3630); box-shadow: none; backdrop-filter: none;
  }
  .oos-panel.oos-inline .oos-title { color: var(--text, #f2ece0); }
  /* Same split as the title above: over the viewfinder the card is dark whatever the theme, so
     its label is white; in the gallery it is ordinary page content and follows the theme. */
  .oos-panel .btn.soft { color: #fff; }
  .oos-panel.oos-inline .btn.soft { color: var(--text, #f2ece0); }
  .oos-title { color: #fff; font-size: .9rem; font-weight: 600; }
  .oos-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
  .shutter { width: 76px; height: 76px; border-radius: 50%; border: 4px solid #fff; background: transparent;
    cursor: pointer; padding: 0; display: flex; align-items: center; justify-content: center; -webkit-tap-highlight-color: transparent; }
  /* `[aria-disabled]`, not `:disabled` — the shutter still takes its press and answers it (see
     announceNoShots), so the styling that says "not now" has to key off the ARIA state instead. */
  .shutter[aria-disabled='true'] { opacity: 0.4; }
  .shutter .core { transition: width 0.18s ease, height 0.18s ease, border-radius 0.18s ease, background 0.18s ease; }
  /* Photo: solid white circle. */
  .shutter.photo .core { width: 60px; height: 60px; border-radius: 50%; background: #fff; }
  .shutter.photo:active:not([aria-disabled='true']) .core { width: 54px; height: 54px; }
  /* Video idle: white ring with a red dot. Recording: morphs to a white rounded square
     (the red ring around it signals "recording" and stays visually distinct from idle). */
  .shutter.video .core { width: 30px; height: 30px; border-radius: 50%; background: var(--danger); }
  .shutter.video.recording { border-color: var(--danger); }
  .shutter.video.recording .core { width: 26px; height: 26px; border-radius: 7px; background: #fff; }
  .drawer { position: fixed; bottom: 0; left: 0; right: 0; background: var(--surface); border-top: 1px solid var(--border); border-radius: var(--radius) var(--radius) 0 0; z-index: 200; max-height: 60dvh; overflow-y: auto; padding: 0 16px 24px; }
  .drawer-head { display: flex; justify-content: space-between; align-items: center; padding: 14px 4px; color: var(--text); -webkit-text-fill-color: var(--text); font-weight: 700; }
  .qitem { display: flex; align-items: center; gap: 12px; padding: 10px 4px; border-top: 1px solid var(--border); }
  .qcol { flex: 1; display: flex; flex-direction: column; gap: 1px; min-width: 0; }
  .qname { color: var(--text); -webkit-text-fill-color: var(--text); font-size: 0.85rem; }
  .qmeta { font-size: 0.68rem; color: var(--text-muted); font-family: var(--font-mono); }
  .qstatus { font-size: 0.75rem; color: var(--text-muted); } .qstatus.done { color: var(--success); } .qstatus.error { color: var(--danger); } .qstatus.uploading { color: var(--accent); }

  .gallery { min-height: 100dvh; background: var(--bg); }
  .gallery header { display: flex; align-items: center; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
  .gallery h2 { flex: 1; font-size: 1rem; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* stretch + a shared min-height, because these three buttons hold different things — a text
     label, an SVG icon, a badge — and each was sizing to its own content, so three controls that
     do the same kind of job came out three different heights. */
  .gallery-actions { display: flex; align-items: stretch; gap: 8px; }
  .gallery-actions .btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    min-height: 36px; line-height: 1;
  }
  .queue-btn { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .qbadge { background: var(--accent-fill); color: var(--accent-ink, #111); font-size: 0.68rem; font-weight: 800; min-width: 17px; height: 17px; border-radius: 9px; padding: 0 4px; display: inline-flex; align-items: center; justify-content: center; }
  .qbadge.error { background: var(--danger); color: #fff; }
  .qempty { color: var(--text-muted); font-size: 0.85rem; padding: 14px 4px; }
  .notice { display: flex; align-items: center; gap: 10px; margin: 12px; padding: 12px 14px;
    background: color-mix(in srgb, var(--accent) 14%, var(--surface)); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text); font-size: 0.85rem; }
  .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 64px 24px; text-align: center; }
  /* The roll is a CARD grid — photo on top, number and caption underneath in flow — and the card
     itself now lives in PhotoCard.svelte, shared with the gallery, shares and host review. What
     stays here is only what this screen adds: the delete bin. */
  .capback { position: fixed; inset: 0; z-index: 320; background: rgba(0,0,0,0.6);
    display: flex; align-items: center; justify-content: center; padding: 20px; }
  .capmodal { width: 100%; max-width: 340px; background: rgba(20,20,20,0.97);
    border: 1px solid rgba(255,255,255,0.15); border-radius: 16px; padding: 6px 16px 16px;
    color: #fff; box-shadow: 0 16px 50px rgba(0,0,0,0.6); }
  .capm-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 0 10px;
    border-bottom: 1px solid rgba(255,255,255,0.12); font-weight: 800; font-size: 0.95rem; }
  .capm-mission { font-size: .75rem; opacity: .75; padding: 8px 0 0; }
  .capm-text { width: 100%; box-sizing: border-box; margin-top: 10px; resize: none;
    background: rgba(255,255,255,0.06); color: #fff; border: 1px solid rgba(255,255,255,0.18);
    border-radius: 10px; padding: 9px 10px; font: inherit; font-size: 0.9rem; }
  .capm-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
  .capm-left { flex: 1; font-size: .72rem; opacity: .55; font-variant-numeric: tabular-nums; }

  /* ── Photo missions ─────────────────────────────────────────────────────── */
  /* The pill sits beside the shot counter and borrows its shape, so the topbar still reads as one
     row of two small facts rather than as a new piece of furniture. */
  .mbadge {
    /* The topbar is pointer-events:none so taps fall through to the viewfinder; anything meant to
       be tappable in there has to opt back in, the same way .home-btn does. */
    pointer-events: auto;
    display: inline-flex; align-items: center; gap: 5px;
    padding: 5px 10px; border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, .28);
    background: rgba(0, 0, 0, .42);
    color: #fff; font: inherit; font-size: .8rem; font-variant-numeric: tabular-nums;
    cursor: pointer; -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
  }
  .mbadge:hover { border-color: rgba(255, 255, 255, .5); }
  .mbadge.alldone { border-color: rgba(127, 179, 163, .75); color: #cdeade; }

  .armed {
    /* Anchored between the left edge and the control rail rather than centred: the rail is 40px at
       right:14px starting at top:64px, so a centred strip runs underneath it on a narrow phone and
       buries its own cancel button. Left-anchored with the rail's gutter reserved, it can never
       collide at any width. */
    position: absolute; left: 12px; right: 66px; max-width: 460px;
    top: 58px; z-index: 6;
    /* The strip is a LABEL, not a surface. It sits above the gesture layer, so while it was
       tappable it swallowed any brightness drag that began under it — arming a trick quietly took
       a band across the viewfinder out of service. Same trick as .topbar: the container lets
       pointers through and the one thing in here that IS a control opts back in. */
    pointer-events: none;
    display: flex; align-items: center; gap: 8px;
    padding: 6px 8px 6px 12px; border-radius: 999px;
    background: rgba(0, 0, 0, .55); border: 1px solid rgba(255, 255, 255, .22);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    color: #fff; font-size: .82rem;
  }
  .armed-label { opacity: .62; flex: none; font-size: .74rem; text-transform: uppercase; letter-spacing: .06em; }
  /* The mission itself can be 48 characters, so it has to be allowed to shrink rather than push the
     cancel button off the strip. */
  .armed-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
  /* …the cancel button being that one control. */
  .armed-x {
    pointer-events: auto;
    flex: none; width: 22px; height: 22px; border-radius: 50%; cursor: pointer;
    border: none; background: rgba(255, 255, 255, .16); color: #fff; font-size: .72rem; line-height: 1;
  }
  .armed-x:hover { background: rgba(255, 255, 255, .28); }

  .m-lede { margin: 0 0 12px; font-size: .86rem; line-height: 1.45; color: var(--text-muted, #b9b9b9); }
  .m-prog { height: 4px; border-radius: 999px; background: rgba(255, 255, 255, .14); overflow: hidden; margin-bottom: 12px; }
  .m-prog-fill { height: 100%; background: #7fb3a3; transition: width .35s ease; }
  .m-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
  .m-btn {
    width: 100%; display: flex; align-items: center; gap: 10px; text-align: left;
    padding: 11px 12px; border-radius: 11px; cursor: pointer; font: inherit; font-size: .9rem;
    border: 1px solid rgba(255, 255, 255, .16); background: rgba(255, 255, 255, .05); color: inherit;
  }
  .m-btn:hover:not(:disabled) { background: rgba(255, 255, 255, .1); }
  .m-item.armed .m-btn { border-color: #7fb3a3; background: rgba(127, 179, 163, .14); }
  /* Done stays legible rather than greyed to nothing — it is a record of what they did. */
  .m-item.done .m-btn { opacity: .55; cursor: default; }
  .m-item.done .m-text { text-decoration: line-through; }
  .m-tick { flex: none; width: 1.1em; text-align: center; }
  .m-text { flex: 1; min-width: 0; }
  /* The row is the button, so this is a label — but it has to LOOK like the thing you press, or the
     row reads as a list item with a status on the end of it. A pill says "tap"; 60% opacity said
     "for information". */
  .m-go { flex: none; font-size: .68rem; text-transform: uppercase; letter-spacing: .06em;
    padding: 4px 10px; border-radius: 999px; border: 1px solid rgba(255, 255, 255, .3);
    background: rgba(255, 255, 255, .1); color: #fff; }
  .m-item.armed .m-go { color: #0f1a16; background: #7fb3a3; border-color: #7fb3a3; font-weight: 700; }

  /* The card chooser. It borrows .m-list/.m-btn because it IS the same list of tappable rows one
     screen earlier — two different row styles for the same gesture would read as two features. */
  .cc-btn { flex-direction: column; align-items: flex-start; gap: 3px; }
  .cc-lab { font-weight: 700; }
  .cc-hint { font-size: .78rem; line-height: 1.4; opacity: .75; }
  .cc-qr { margin: 0 0 12px; padding: 9px 11px; border-radius: 10px; font-size: .8rem; line-height: 1.45;
    border: 1px solid rgba(245, 197, 24, .45); background: rgba(245, 197, 24, .12); }
  .cc-warn { margin: 0 0 10px; font-size: .8rem; line-height: 1.45;
    padding: 9px 11px; border-radius: 10px;
    border: 1px solid rgba(245, 197, 24, .45); background: rgba(245, 197, 24, .12); }
  .cc-preview { list-style: none; margin: 0 0 14px; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
  .cc-preview li { font-size: .76rem; padding: 4px 9px; border-radius: 999px;
    border: 1px solid rgba(255, 255, 255, .18); background: rgba(255, 255, 255, .06); }
  .cc-preview .cc-more { opacity: .7; }
  .cc-actions { display: flex; gap: 8px; }
  /* `font: inherit` AFTER the size would wipe it — it comes first, deliberately. */
  .cc-back, .cc-yes, .cc-none {
    font: inherit; cursor: pointer; border-radius: 11px; padding: 11px 14px; font-size: .9rem;
  }
  .cc-back { flex: none; border: 1px solid rgba(255, 255, 255, .22); background: transparent; color: inherit; }
  .cc-yes { flex: 1; border: 1px solid #7fb3a3; background: #7fb3a3; color: #0f1a16; font-weight: 700; }
  .cc-yes:disabled, .cc-back:disabled, .cc-none:disabled { opacity: .6; cursor: default; }
  /* Quieter than the cards themselves: it is the honest answer for some guests, not the easy way
     out of the question. */
  .cc-none { width: 100%; margin-top: 10px; border: 1px dashed rgba(255, 255, 255, .24);
    background: transparent; color: inherit; opacity: .85; font-size: .84rem; }

  @media (prefers-reduced-motion: reduce) {
    .m-prog-fill { transition: none; }
  }
  /* Stacked so the caption sits under the pill without widening the topbar row. */
  /* Centred on each other, not right-aligned. The caption is wider than the count it labels, so
     aligning their right edges left it hanging off to one side — which only looked acceptable while
     the pill still carried a glyph padding it out. A label belongs under the middle of its control. */
  .mwrap { display: flex; flex-direction: column; align-items: center; gap: 3px; pointer-events: none; }
  .mcap { font-size: .62rem; text-transform: uppercase; letter-spacing: .08em; color: rgba(255,255,255,.72);
    text-shadow: 0 1px 3px rgba(0,0,0,.6); text-align: center; white-space: nowrap; }
  /* The exit is the one thing here that is not part of the tour, so it recedes. No second, dimmer
     border needed for that: opacity applies to the border as much as to the fill, so it already
     comes back the same amount everything else here does. */
  .home-btn.quiet { background: rgba(0,0,0,.32); font-weight: 600; opacity: .82; }
  .home-btn.quiet:hover { opacity: 1; }
  /* Sits where the armed strip does, and clears the control rail the same way. */
  .sw-act {
    margin-top: 8px; padding: 6px 12px; border-radius: 999px; cursor: pointer;
    border: 1px solid var(--accent); background: rgba(245,197,24,0.18); color: #fff;
    font: inherit; font-size: 0.78rem; font-weight: 600;
  }
  .sw-act:disabled { opacity: 0.6; cursor: default; }
  .switchnote, .landnote {
    position: absolute; left: 12px; right: 12px; max-width: 460px; top: 104px; z-index: 8;
    display: flex; align-items: flex-start; gap: 8px;
    padding: 10px 10px 11px 13px; border-radius: 12px;
    background: rgba(0, 0, 0, .8); border: 1px solid rgba(240, 180, 41, .6);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    color: #fff; font-size: .78rem; pointer-events: auto;
  }
  /* The landscape notice is a BANNER, not a floating card, and the two differences both matter.
     It only ever renders in landscape (see landscapeNote), so this needs no media query.

     Stacking: the shared rule above puts these at z-index 8, which is under the mode pills (10) and
     level with the bottom bar — so in landscape, where the viewport is short, the shutter and the
     pills drew straight over the top of it. It goes above the controls instead (11), while staying
     under the settings sheet (20), the lens picker and the camera-error screen (12), which are all
     things a guest has deliberately opened and must not have a banner sitting on.

     Position: pinned to the top edge, full width, deliberately covering the title and the trick
     list. Those are the least urgent things on screen at the moment the UI has gone sideways, and
     the alternative is overlapping the controls, which are the most urgent. */
  .landnote {
    /* Clear of the top edge, and of a notch, which in landscape is on the side. Flush to the edge
       with only its bottom corners rounded, it read as a panel sliding off the top of the screen
       rather than a banner sitting on it — all four corners visible is what makes it look placed. */
    top: max(8px, env(safe-area-inset-top, 0px));
    left: max(8px, env(safe-area-inset-left, 0px));
    right: max(8px, env(safe-area-inset-right, 0px));
    max-width: none;
    z-index: 11;
    /* Tighter than the floating card: a landscape viewport is short, and every row this takes is a
       row of picture. */
    padding: 8px 10px 9px 13px;
    align-items: center;
  }
  /* Sits inside the banner rather than under it, so the whole thing stays one line tall. */
  .landnote .sw-act { margin-top: 0; margin-left: 10px; flex: none; }
  .landnote .sw-t { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 10px; }

  .sw-t { flex: 1; min-width: 0; }
  .sw-h { margin: 0; font-weight: 700; font-size: .84rem; }
  .sw-s { margin: 3px 0 0; opacity: .85; line-height: 1.45; }
  .sw-row { display: flex; gap: 6px; margin-top: 8px; }
  .sw-row input { flex: 1; min-width: 0; font: inherit; font-size: .82rem; padding: 7px 9px;
    border-radius: 8px; border: 1px solid rgba(255,255,255,.28); background: rgba(255,255,255,.08); color: #fff; }
  .switchnote-x { flex: none; width: 22px; height: 22px; border-radius: 50%; border: none;
    background: rgba(255,255,255,.16); color: #fff; font-size: .7rem; line-height: 1; cursor: pointer; }
  .micnote {
    /* Clear of the topbar rather than level with it: at 58px this sat straight over the trick-list
       pill and its caption. The pill is the thing a guest is mid-way through using when a mic note
       appears, so the note is the one that moves. */
    position: absolute; left: 12px; right: 66px; max-width: 460px; top: 104px; z-index: 7;
    display: flex; align-items: flex-start; gap: 8px;
    padding: 8px 8px 9px 12px; border-radius: 12px;
    background: rgba(0, 0, 0, .68); border: 1px solid rgba(245, 197, 24, .5);
    -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
    color: #fff; font-size: .78rem; pointer-events: auto;
  }
  .micnote-t { flex: 1; min-width: 0; line-height: 1.45; }
  .micnote-h { margin: 0; font-weight: 700; font-size: .82rem; }
  .micnote-s { margin: 2px 0 0; opacity: .82; }
  .micnote-d { margin-top: 6px; }
  .micnote-d summary { cursor: pointer; font-size: .74rem; opacity: .9; text-decoration: underline; }
  .micnote-d ol { margin: 6px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
  .micnote-d li { line-height: 1.45; }
  .micnote-a { flex: none; border: 1px solid rgba(255,255,255,.3); background: rgba(255,255,255,.12);
    color: #fff; border-radius: 8px; padding: 4px 9px; font: inherit; font-size: .74rem; cursor: pointer; }
  .micnote-x { flex: none; width: 22px; height: 22px; border-radius: 50%; border: none;
    background: rgba(255,255,255,.16); color: #fff; font-size: .7rem; line-height: 1; cursor: pointer; }
</style>
