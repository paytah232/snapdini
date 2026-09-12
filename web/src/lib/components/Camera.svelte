<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { lensName, lensFacing } from '$lib/lensName';
  import { tileAspect } from '$lib/ui';
  import { goto, replaceState } from '$app/navigation';
  // Aliased: this component already has a `track` for the MediaStreamTrack.
  import { track as trackEvent } from '$lib/analytics';
  import { fade } from 'svelte/transition';
  import { getEvent, getMe, joinEvent, getPhotosBySession, savePhotoCaption, CAPTION_MAX, clampCaption, captionLength, captionRemaining,
           type PublicEvent, type Photo } from '$lib/events';
  import { getSession, saveSession, clearSession } from '$lib/session';
  import { getConfig } from '$lib/api';
  import { applyEventTheme } from '$lib/theme';
  import { showToast, hideToast } from '$lib/toast';
  import { reportClientError } from '$lib/report';
  import { putCapture, delCapture, listCaptures, saveProgress, getProgress } from '$lib/captureStore';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import PhotoCard from '$lib/components/PhotoCard.svelte';
  import StartYourOwn from '$lib/components/StartYourOwn.svelte';
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

  // Demo showcase: link into the host + gallery views (organizer code stashed at demo start).
  let demoOrg = '';
  $: if (ev?.isDemo && typeof localStorage !== 'undefined') demoOrg = localStorage.getItem('demo_org_' + ev.joinCode) || '';
  $: demoHostHref = demoOrg && ev ? `/admin/${ev.joinCode}#${encodeURIComponent(demoOrg)}` : '';
  $: demoGalleryHref = ev ? `/gallery/${ev.joinCode}` : '';
  let joinName = '';
  let joinEmail = '';
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
  // Fires once when the roll is actually spent, which is the closest thing to "the guest finished".
  let rollReported = false;
  $: if (outOfShots && !rollReported && ownCount > 0) { rollReported = true; trackEvent('roll_completed', { shots: ownCount }, ev?.joinCode); }
  let videoHardMaxSecs = 600;   // server's absolute ceiling; the event's own limit is a price tier
  // A guest gets a brief chance to take back a shot they have just fluffed — a thumb over the lens,
  // a blink. Short on purpose: the window is what stops "delete and reshoot" becoming an unlimited
  // roll. Mirrors PHOTO_DELETE_WINDOW_SECONDS on the server; the server is the authority.
  const undoWindowMs = 60_000;
  let nowTick = Date.now();
  let undoTimer: ReturnType<typeof setInterval> | undefined;
  // Eligibility is per PHOTO, from its own takenAt — take three shots quickly and any of the three
  // can be the bad one, so a single "last shot" control would delete the wrong frame.
  // Two-step delete: the first tap arms it, the second commits. Once armed, the control STAYS
  // even if the 60s window lapses mid-decision — the guest decided in time, and yanking the button
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
  let screenFlash = false;       // selfie screen-flash
  let torchSupported = false;    // hardware torch (back camera, Android Chrome)
  let flashArmed = false;        // when armed, the torch fires for the shot (and lights video)
  let fillActive = false;
  // Every phone camera blinks the screen when the shutter fires, and without it there was almost
  // nothing to say a photo had been taken — the roll counter drops and a thumbnail appears behind a
  // button you are not looking at. A brief blackout is the one piece of feedback people already
  // know how to read. Timed off rather than animation-ended so an interrupted animation cannot
  // leave the viewfinder covered.
  let blinking = false;
  let blinkTimer: ReturnType<typeof setTimeout> | undefined;
  function shutterBlink() {
    clearTimeout(blinkTimer);
    blinking = true;
    blinkTimer = setTimeout(() => (blinking = false), 180);
  }
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
  $: if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--toast-bottom', screen === 'camera' ? TOAST_LIFT : '');
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

  // upload queue
  interface QueueItem { id: string; blob: Blob; mediaType: 'photo' | 'video'; source: 'capture' | 'upload'; ext: string; status: 'pending' | 'uploading' | 'done' | 'error'; error?: string; progress?: number; size: number; durationSecs?: number; w?: number; h?: number; retries?: number; uploadId?: string; challengeId?: string; doneChunks?: number[]; }
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
  let armed: string | null = null;
  let missionsOpen = false;
  // The host's chosen mark. Falls back to a plain circle rather than guessing from the event type:
  // the guest payload does not carry the type, and a wrong glyph is worse than a neutral one.
  let missionTick = '\u25CB';
  let confetti: { burst: (n?: number) => void } | undefined;
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
  $: ownCount = galleryPhotos.filter((p) => p.isOwn).length;
  $: othersCount = galleryPhotos.length - ownCount;
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

  onMount(async () => {
    try {
      ev = await getEvent(identifier);
    } catch {
      fatal = 'Event not found';
      return;
    }
    // Video length is now a per-event entitlement (falls back to the global setting when
    // billing is off — the server resolves which to send).
    videoMaxSecs = ev.videoSeconds ?? 0;
    // The server ceiling, not the event tier — see the upload handler for why they differ.
    try { videoHardMaxSecs = (await getConfig()).videoHardMaxSeconds ?? 600; } catch { /* keep the default */ }
    // Apply the event's theme straight away so the JOIN screen (button, colours) is themed too —
    // applyEventTheme is contrast-guarded and falls back to the warm default for no-theme events.
    applyEventTheme(ev.theme);
    allowedAspects = ev.aspectRatios?.length ? ev.aspectRatios : ['1:1'];
    aspect = allowedAspects[0];
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
        allowDownloads = me.allowDownloads;
        missions = Array.isArray(me.challenges) ? me.challenges : [];
        missionsDone = Array.isArray(me.challengesDone) ? me.challengesDone : [];
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
    window.addEventListener('pageshow', (e) => { if ((e as PageTransitionEvent).persisted) void restoreIfSessionExists(); });
    // Refresh the camera list if one is plugged in/out mid-session (hot-plug).
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshCameras);
  });

  // When the tab is backgrounded, release the camera entirely so it isn't left running in the
  // background draining the battery (and the "camera in use" indicator clears). Stop any
  // in-progress recording first so the clip is saved. Re-open it when the user returns to the camera.
  function onVisibility() {
    if (document.hidden) {
      if (recording) toggleRecord();   // saves the clip; iOS would otherwise corrupt it
      if (screen === 'camera') stopCamera();
    } else if (screen === 'camera' && !stream && !cameraError && !cameraPaused) {
      startCamera();   // auto-resume on return — unless the user manually turned the camera off
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
    // onDestroy also runs during SSR, where `document` is undefined — guard it.
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    if (typeof navigator !== 'undefined') navigator.mediaDevices?.removeEventListener?.('devicechange', refreshCameras);
    if (typeof window !== 'undefined') { window.removeEventListener('online', autoRetry); window.removeEventListener('pagehide', stopCamera); }
    if (retryTimer) clearInterval(retryTimer);
    stopCamera();
  });

  async function doJoin() {
    if (!joinName.trim()) { showToast('Enter your name', true); return; }
    if (joinEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(joinEmail)) { showToast("That email doesn't look right", true); return; }
    joining = true;
    try {
      // Last line of defence: if this browser already holds a session for the event, use it instead
      // of creating a second participant. Cheap, and it closes any path bfcache handling misses.
      if (await restoreIfSessionExists()) return;
      const r = await joinEvent(identifier, joinName.trim(), joinEmail.trim() || undefined);
      sessionToken = r.sessionToken;
      serverRemaining = r.photosRemaining;
      canBuyShots = !!r.canBuyShots;
      canAskHost = !!r.canAskHost;
      faceMatching = !!r.faceMatching;
      feedbackDone = !!r.feedbackGiven;
      missions = Array.isArray(r.challenges) ? r.challenges : [];
      missionsDone = Array.isArray(r.challengesDone) ? r.challengesDone : [];
      if (r.challengeTick) missionTick = r.challengeTick;
      saveSession(r.joinCode, r.sessionToken);
      trackEvent('joined', undefined, r.joinCode);
      if (r.recovered) showToast(`Welcome back! You've ${photosRemaining} shot${photosRemaining === 1 ? '' : 's'} left.`);
      await enterCamera();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not join', true);
    } finally {
      joining = false;
    }
  }

  async function enterCamera() {
    screen = 'camera';
    applyEventTheme(ev?.theme);
    if (ev?.isExpired || ev?.isLocked) { showToast(ev.isLocked ? 'Event is locked' : 'Event has ended'); }
    if (ev) { try { saveToDevice = localStorage.getItem('savedev_' + ev.joinCode) === '1'; } catch { /* ignore */ } }
    try { const q = localStorage.getItem('snap_vidq'); if (q === 'high' || q === 'standard' || q === 'smooth' || q === 'phone') videoQuality = q; } catch { /* ignore */ }
    await startCamera();
    restoreQueue();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', autoRetry);
      retryTimer = setInterval(autoRetry, 15000);
    }
  }
  $: if (ev && typeof localStorage !== 'undefined') { try { localStorage.setItem('savedev_' + ev.joinCode, saveToDevice ? '1' : '0'); } catch { /* ignore */ } }

  // Attach a stream for the given constraints and wire up the preview/track.
  async function attachCamera(constraints: MediaStreamConstraints) {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
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
    // Tap-to-focus only works where the device exposes focus controls (some Android
    // Chrome); iOS Safari never does. Detect it so we don't show a fake focus ring.
    const caps = (track?.getCapabilities?.() ?? {}) as Record<string, unknown>;
    focusSupported = 'pointsOfInterest' in caps || 'focusMode' in caps;
    // Hardware torch (back camera on Android Chrome). iOS Safari never exposes it.
    torchSupported = 'torch' in caps && !!caps.torch;   // a fresh stream always starts with the torch physically off
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
  }

  // Photos: request the camera's max (soft `ideal` hints — a 4K/1080p sensor returns its best).
  // Video: phone browsers can't encode 4K/8K via MediaRecorder in real time (the frame rate
  // collapses), so we request a sane ceiling per the chosen quality. 'Standard' (1080p30) is the
  // reliable default; bump to High or drop to Smooth from the camera settings.
  const RES_PHOTO = { width: { ideal: 7680 }, height: { ideal: 4320 } };
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
  let benchResult: { results: Record<string, number>; best: VidQuality } | null = null;
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

  async function startCamera() {
    stopCamera();
    cameraStarting = true;   // show a spinner while the camera (re)acquires — the brief black flash now reads as "working"
    // Only grab the mic in video mode (avoids an unnecessary mic prompt while taking photos).
    const audio = videoMaxSecs !== 0 && videoMode;
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

  function stopCamera() {
    // Tear down any in-progress recording first so flipping/leaving can't strand the recorder.
    if (recording) { try { mediaRecorder?.stop(); } catch { /* ignore */ } recording = false; clearInterval(recTimer); }
    if (stream) { stream.getTracks().forEach((t) => t.stop()); stream = null; }
    // Detach the stream from the <video> too — some browsers keep the "camera in use" indicator
    // lit while a stream is still bound to a live element, even after its tracks are stopped.
    if (videoEl) { try { videoEl.pause(); } catch { /* */ } videoEl.srcObject = null; }
    track = null;
    focusSupported = false;
    torchSupported = false;   // (the hardware torch turns off with the track; flashArmed stays as the user's choice)
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
  $: if (screen === 'camera' && cameras.length > 1 && typeof localStorage !== 'undefined') {
    try {
      if (!localStorage.getItem(LENS_HINT)) {
        localStorage.setItem(LENS_HINT, '1');
        showToast('Tip: hold the flip button to pick a lens');
      }
    } catch { /* ignore */ }
  }

  // A favourite lens per DIRECTION. A phone with three rear lenses flips to whichever one the
  // browser feels like; someone who prefers the ultra-wide for the look of it had to open the
  // picker every single time. One favourite per side, so flip stays a single tap and lands where
  // they want it. Kept on the device — it is about this phone's lenses, not about any event.
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
    lensFavs = { ...lensFavs, [c.facing]: isFav(c) ? undefined : c.id };
    try { localStorage.setItem(LENS_FAVS, JSON.stringify(lensFavs)); } catch { /* ignore */ }
  }

  // Holding opens a sheet with ONLY the lenses on it. Sending the guest into the full settings menu
  // to pick a camera is the long way round — the point of the gesture is that it is the short one.
  let lensSheet = false;
  async function chooseLens(id: string) { lensSheet = false; await pickCamera(id); }

  // Drive the hardware torch on/off (where supported). Used as a flash pulse for photos and a
  // continuous light for video.
  async function setTorch(on: boolean) {
    if (!track || !torchSupported) return;
    try { await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }); }
    catch { /* unsupported mid-stream — ignore */ }
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
    videoMode = v;
    // In phone mode, switching to video means "open the phone's camera" — that is the whole point
    // of picking it, and re-acquiring a browser stream we are not going to record from is waste.
    if (v && videoQuality === 'phone') { nativeVideoInput?.click(); return; }
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
    // PHONE mode has no resolution to re-acquire — it hands straight to the native camera instead.
    if (q === 'phone') { if (videoMode) nativeVideoInput?.click(); return; }
    if (videoMode) await startCamera();   // re-acquire at the new resolution
  }

  // Brightness is a CSS filter on the preview (and baked into photo capture).
  $: if (videoEl) videoEl.style.filter = brightness === 1 ? '' : `brightness(${brightness})`;

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
  let bTracking = false, bHorizontal = false, bAbandoned = false;
  let bStartX = 0, bStartY = 0, bStartBright = 1;
  let bHudTimer: ReturnType<typeof setTimeout>;
  const BRIGHT_MIN = 0.5, BRIGHT_MAX = 1.6;

  function showHud() { clearTimeout(bHudTimer); brightnessHud = true; }
  function hideHudSoon() { clearTimeout(bHudTimer); bHudTimer = setTimeout(() => (brightnessHud = false), 1800); }

  function onGesturePointerDown(e: PointerEvent) {
    if (cameraError) return;
    bTracking = true; bHorizontal = false; bAbandoned = false;
    bStartX = e.clientX; bStartY = e.clientY; bStartBright = brightness;
    // Don't capture yet — a vertical swipe must stay with the browser (pull-to-refresh / scroll).
  }
  function onGesturePointerMove(e: PointerEvent) {
    if (!bTracking || bAbandoned) return;
    const dx = e.clientX - bStartX, dy = e.clientY - bStartY;
    if (!bHorizontal) {
      // Decide direction once past a small threshold. Vertical → hand it back to the browser.
      if (Math.abs(dy) > 8 && Math.abs(dy) >= Math.abs(dx)) { bAbandoned = true; return; }
      if (Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) {
        bHorizontal = true;
        try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* ignore */ }
      } else return;
    }
    const w = (e.currentTarget as HTMLElement).clientWidth || window.innerWidth;
    const next = bStartBright + (dx / w) * 1.5;
    brightness = Math.round(Math.min(BRIGHT_MAX, Math.max(BRIGHT_MIN, next)) * 100) / 100;
    showHud();
  }
  function onGesturePointerUp(e: PointerEvent) {
    if (!bTracking) return;
    const wasHorizontal = bHorizontal, abandoned = bAbandoned;
    bTracking = false; bHorizontal = false; bAbandoned = false;
    if (wasHorizontal) { hideHudSoon(); return; }
    if (!abandoned && focusSupported) tapFocus(e as unknown as MouseEvent);   // a tap → focus
  }
  function resetBrightness() { brightness = 1; showHud(); hideHudSoon(); }

  function toggleFullscreen() {
    const el = document.getElementById('cam-root');
    if (document.fullscreenElement) document.exitFullscreen();
    else el?.requestFullscreen?.().catch(() => {});
  }

  function aspectValue(a: string): number | null { if (a === 'full') return null; const [w, h] = a.split(':').map(Number); return w / h; }
  function cropRect(vw: number, vh: number, ratio: number | null) {
    if (ratio === null) return { sx: 0, sy: 0, sw: vw, sh: vh };
    const vr = vw / vh;
    let sw, sh;
    if (vr > ratio) { sh = vh; sw = vh * ratio; } else { sw = vw; sh = vw / ratio; }
    return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };
  }
  function applyViewfinderAspect() {
    if (!videoEl) return;
    const s = videoEl.style;
    // Always fill the screen width. 'full' fills the whole viewport; fixed ratios
    // are pinned to full width and centre-cropped vertically (taller ratios overflow
    // and are clipped by the viewfinder, shorter ones letterbox) — matching capture.
    s.objectFit = 'cover';
    s.width = '100%';
    s.maxWidth = '100%';
    s.maxHeight = '';
    if (aspect === 'full') { s.aspectRatio = ''; s.height = '100%'; }
    else { s.aspectRatio = aspect.replace(':', ' / '); s.height = 'auto'; }
  }
  function cycleAspect() {
    const i = allowedAspects.indexOf(aspect);
    aspect = allowedAspects[(i + 1) % allowedAspects.length];
    applyViewfinderAspect();
  }

  async function capturePhoto() {
    // Guard: one capture at a time, never below 0 remaining, and ONLY when the camera is truly
    // live (a real frame is decoded). Without the readiness check a failed camera (e.g. incognito)
    // could still "take" a blank shot and burn a snap — discard instead.
    if (capturing || photosRemaining <= 0 || cameraError || !stream || !videoEl || !videoEl.videoWidth) return;
    capturing = true;
    // Hardware flash: pulse the torch on and give auto-exposure a moment to settle before the shot.
    const useFlash = flashArmed && torchSupported && !ev?.noFlash;
    try {
      if (useFlash) { await setTorch(true); await new Promise((r) => setTimeout(r, 260)); }
      if (screenFlash) { fillActive = true; await new Promise((r) => setTimeout(r, 320)); }
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
      if (useFlash) setTorch(false);   // flash off again after the shot
      capturing = false;
    }
  }

  function toggleRecord() {
    if (!stream) return;
    if (!recording) {
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
      const recOpts: MediaRecorderOptions = { videoBitsPerSecond: recBitrate, audioBitsPerSecond: 128_000 };
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
      mediaRecorder?.stop();
      if (flashArmed && torchSupported) setTorch(false);
      stopFpsMonitor();
      recording = false; clearInterval(recTimer);
      // If the clip stuttered, apply the queued quality downgrade now (re-acquires the stream).
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
  function enqueue(blob: Blob, mediaType: 'photo' | 'video', ext: string, source: 'capture' | 'upload' = 'capture', extra?: { durationSecs?: number; w?: number; h?: number }) {
    // Whatever was armed at the moment of the shot, not at the moment of upload: a guest may well
    // arm the next mission while this one is still going up.
    const challengeId = armed ?? undefined;
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    queue = [...queue, { id, blob, mediaType, source, ext, status: 'pending', size: blob.size, challengeId, ...extra }];
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
      body: JSON.stringify({ sessionToken, uploadId, total, ext: item.ext, mediaType: item.mediaType, source: item.source, challengeId: item.challengeId }),
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

      benchResult = { results, best };

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
      photosRemaining = Math.min(photosRemaining + 1, ev?.maxPhotos || 99);
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
      if (Array.isArray(d?.challengesDone)) missionsDone = d.challengesDone;
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
      const r = await getPhotosBySession(identifier, sessionToken);
      galleryRevealed = r.revealed;
      allowDownloads = r.allowDownloads ?? true;
      galleryPhotos = r.photos || [];
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
      const r = await getPhotosBySession(identifier, sessionToken!);
      galleryRevealed = r.revealed;
      allowDownloads = r.allowDownloads ?? true;
      // Own photos come back even before reveal; everyone else's stay hidden.
      galleryPhotos = r.photos || [];
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
                <div class="ei-row"><span class="ei-k">Trick list</span><span class="chip trick">🎩 {ev.challengeCount} to pull off</span></div>
              {/if}
            </div>
          </details>
        {/if}
      {/if}
      <label for="join-name">Your name</label>
      <input id="join-name" bind:value={joinName} maxlength="40" placeholder="e.g. Alex" autocomplete="name" />
      <label for="join-email">Email <span class="muted">(optional)</span></label>
      <input id="join-email" bind:value={joinEmail} type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" />
      <p class="join-hint">Add your email to get your photos afterwards and pick up where you left off.</p>
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
  <div id="cam-root" class="cam">
    <div class="viewfinder">
      <!-- svelte-ignore a11y-media-has-caption -->
      <!-- Mirrored on the front camera, because that is what a phone does and what people expect
           when they look at themselves. It was not mirrored at all, while CAPTURE mirrors for
           'user' facing — so the preview and the photo you got back disagreed, which is the
           "it's flipped again" feeling. Now what you see is what is saved. -->
      <video bind:this={videoEl} class:mirrored={facing === 'user'} autoplay playsinline muted></video>
      <!-- svelte-ignore a11y-no-static-element-interactions -->
      <div class="gesture-layer"
        on:pointerdown={onGesturePointerDown}
        on:pointermove={onGesturePointerMove}
        on:pointerup={onGesturePointerUp}
        on:pointercancel={onGesturePointerUp}></div>
      {#if focusRing}<div class="focus-ring" style="left:{focusRing.x}px;top:{focusRing.y}px"></div>{/if}
      {#if brightnessHud}
        <div class="bright-hud" transition:fade={{ duration: 150 }}>
          <span aria-hidden="true">☀</span>
          <div class="bright-bar"><div class="bright-fill" style="width:{((brightness - BRIGHT_MIN) / (BRIGHT_MAX - BRIGHT_MIN)) * 100}%"></div></div>
          <span class="bright-val">{Math.round(brightness * 100)}%</span>
          <button class="ctrl tiny" on:click={resetBrightness} disabled={brightness === 1} title="Reset brightness" aria-label="Reset brightness">↺</button>
        </div>
      {/if}
      {#if fillActive}<div class="fill"></div>{/if}
      {#if blinking}<div class="blink" aria-hidden="true"></div>{/if}
      <Confetti bind:this={confetti} colors={ev?.theme?.accent ? [ev.theme.accent, '#f4e4c1', '#e8825a', '#7fb3a3'] : undefined} />
      <div class="topbar">
        {#if ev?.isDemo}
          <div class="demo-nav">
            <!-- Order is the tour, not the escape: a visitor should see what the host and the
                 gallery look like before they are offered the way out. "Home" was ambiguous — it
                 read as "my dashboard" as easily as "leave" — so the exit says what it does. -->
            {#if demoHostHref}<a class="home-btn" href={demoHostHref} aria-label="See the host's view of this demo">🎛 Host view</a>{/if}
            <!-- "Gallery" alone collided with the guest's OWN roll button at the bottom left, which
                 is also a 🖼. Name this one for whose photos it holds. -->
            <a class="home-btn" href={demoGalleryHref} aria-label="See the whole event's gallery, everyone's photos">🖼 Event gallery</a>
            <a class="home-btn quiet" href="/" aria-label="Leave the demo and go back to the Snapdini home page">✕ Exit demo</a>
          </div>
        {:else}
          <div class="evname"><Logo word={false} color={ev?.theme?.accent ?? ''} /> {ev?.name}</div>
        {/if}
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
                    on:click={() => { missionsOpen = true; trackEvent('mission_list_opened', undefined, ev?.joinCode); }}
                    aria-label="Trick list, {missionsDone.length} of {missions.length} pulled off">
              {missionsDone.length}/{missions.length}
            </button>
            <span class="mcap">{!missionsLeft.length ? 'all done' : 'trick list'}</span>
          </div>
        {/if}
        <div class="counter" class:low={photosRemaining <= 5}>{photosRemaining}<small>left</small></div>
      </div>
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
        {#if facing === 'user'}<button class="ctrl" on:click={() => (screenFlash = !screenFlash)} class:active={screenFlash} title="Flash" aria-label="Flash">⚡</button>{/if}
        {#if torchSupported && !ev?.noFlash}<button class="ctrl" on:click={() => (flashArmed = !flashArmed)} class:active={flashArmed} title="Flash" aria-label="Flash">⚡</button>{/if}
        {#if allowedAspects.length > 1}<button class="ctrl" on:click={cycleAspect} title="Photo shape" aria-label="Change photo shape (currently {aspect})">{aspect === 'full' ? 'Full' : aspect}</button>{/if}
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
                    {#if !isDone(m.id)}<span class="m-go">{armed === m.id ? 'Armed' : 'Shoot'}</span>{/if}
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
              <button class="ctrl" on:click={() => (gridOn = !gridOn)} class:active={gridOn} aria-pressed={gridOn} title="Grid">⊞</button>
            </div>

            <div class="sm-row">
              <span class="sm-labelwrap">
                <span class="sm-label">Save a copy to my device</span>
                <span class="sm-desc">Also download each shot to your phone as you take it.</span>
              </span>
              <button class="ctrl" on:click={toggleSaveToDevice} class:active={saveToDevice} aria-pressed={saveToDevice} title="Also save a copy to my device" aria-label="Save copies to my device">💾</button>
            </div>

            {#if cameras.length > 1}
              <div class="sm-row col">
                <span class="sm-labelwrap">
                  <span class="sm-label">Camera</span>
                  <span class="sm-desc">Switch between the cameras on this device.{#if recording} Stop recording to change.{/if}</span>
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
                <button class="sm-select" type="button" on:click={() => nativeVideoInput?.click()}>🎥 Record with phone camera</button>
              </div>
            {/if}

            {#if saveNote}<div class="sm-note">Now also saving a copy of each shot to your device.</div>{/if}

            <div class="sm-row">
              <button class="sm-select" type="button" on:click={() => { settingsOpen = false; showFeedback = true; }}>💬 Report a problem / feedback</button>
            </div>
          </div>
        </div>
      {/if}
      {#if gridOn}<div class="grid"><span></span><span></span><span></span><span></span></div>{/if}
      {#if recording}<div class="rec">● {Math.floor(recSecs / 60)}:{String(recSecs % 60).padStart(2, '0')}{#if videoMaxSecs > 0} / {Math.floor(videoMaxSecs / 60)}:{String(videoMaxSecs % 60).padStart(2, '0')}{/if}</div>{/if}
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
          <p class="cd-hint">
            If nothing happens, your browser is remembering an earlier “don't allow”. On iPhone tap
            <b>aA</b> in the address bar → <b>Website Settings</b> → <b>Camera</b> → <b>Allow</b>, then tap above again.
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
      <button class="round" on:click={openGallery} title="Gallery" aria-label="Gallery{pendingCount ? ` (${pendingCount} uploading)` : ''}">🖼{#if pendingCount}<span class="badge" class:error={hasUploadError}>{pendingCount}</span>{/if}</button>
      {#if videoMode}
        <button class="shutter video" class:recording on:click={toggleRecord} disabled={!!cameraError} aria-label={recording ? 'Stop recording' : 'Record'}><span class="core"></span></button>
      {:else}
        <button class="shutter photo" on:click={capturePhoto} disabled={photosRemaining <= 0 || !!cameraError} aria-label="Take photo"><span class="core"></span></button>
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
    {#if lensSheet}
      <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions a11y-no-noninteractive-element-interactions -->
      <div class="lens-back" on:click|self={() => (lensSheet = false)} role="dialog" aria-modal="true" aria-label="Choose a lens">
        <div class="lens-sheet">
          <div class="lens-head">Choose a lens</div>
          {#each cameras as c}
            <div class="lens-row">
              <button class="lens-opt" class:on={c.id === deviceId} on:click={() => chooseLens(c.id)}>
                <span class="lens-name">{c.label}</span>
                {#if c.id === deviceId}<span class="lens-now" aria-label="Currently in use">●</span>{/if}
              </button>
              {#if canFavourite(c)}
                <button class="lens-fav" class:on={isFav(c)}
                        on:click|stopPropagation={() => toggleFav(c)}
                        aria-pressed={isFav(c)}
                        title={isFav(c) ? 'Flip lands here for this side' : 'Make this the lens flip goes to'}
                        aria-label={isFav(c) ? `${c.label} is where flip lands` : `Make ${c.label} where flip lands`}>
                  {isFav(c) ? '★' : '☆'}
                </button>
              {/if}
            </div>
          {/each}
          <button class="lens-cancel" on:click={() => (lensSheet = false)}>Cancel</button>
        </div>
      </div>
    {/if}
    {#if benchPrompt || benchRunning || benchResult}
      <div class="bench-panel">
        {#if benchRunning}
          <div class="bench-title">Checking your camera…</div>
          <div class="bench-sub">Testing {benchStep === 'high' ? '4K' : benchStep === 'standard' ? '1080p' : '720p'}</div>
        {:else if benchResult}
          <div class="bench-title">Your phone handles</div>
          <ul class="bench-list">
            <li><b>4K</b><span>{benchResult.results.high} fps · {fpsLabel(benchResult.results.high)}</span></li>
            <li><b>1080p</b><span>{benchResult.results.standard} fps · {fpsLabel(benchResult.results.standard)}</span></li>
            <li><b>720p</b><span>{benchResult.results.smooth} fps · {fpsLabel(benchResult.results.smooth)}</span></li>
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
              <button class="btn ghost sm" on:click={() => { benchResult = null; benchPrompt = false; void setVideoQuality('phone'); nativeVideoInput?.click(); }}>
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
        <button class="btn primary sm" on:click={() => { void setVideoQuality('phone'); nativeVideoInput?.click(); }}>🎥 Use phone camera</button>
      </div>
    {/if}
    {#if outOfShots && (canAskHost || canBuyShots)}
      <div class="oos-panel">
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
        <button class="btn ghost sm" on:click={backToCamera}>← Camera</button>
      </div>
    </header>
    {#if !galleryRevealed}
      <div class="notice">
        <span aria-hidden="true">🔒</span>
        <span>{revealMsg}{#if galleryPhotos.length} Only you can see your own shots until then.{/if}</span>
      </div>
    {/if}
    {#if shownPhotos.length}
      <!-- --tile-ar is the EVENT's shape, not the guest's current one. The shape control changes
           what the NEXT photo is cropped to; it is not a statement about how the roll should be
           drawn. Letting it redraw the grid meant the same photos were square in the gallery and
           9:16 in the roll on any event with more than one shape enabled — which is every demo. -->
      <div class="pgrid" class:has-meta={shownPhotos.some((p) => p.caption || p.challenge)}
           style={`--tile-ar:${tileAspect(allowedAspects)}`}>
        {#each shownPhotos as p, i}
          <!-- The card itself is PhotoCard; the only thing this roll adds is the delete bin, which
               goes in the tile slot because the bin belongs ON the photo. Own photos only for the
               editable caption — this roll holds nothing else, but the guard is the rule, not the
               filter that happens to be upstream of it. -->
          <PhotoCard photo={p} shotNumber={shownPhotos.length - i}
                     captionMode={p.isOwn ? 'edit' : 'static'}
                     on:open={() => { lbIndex = i; lbOpen = true; }}
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
                    🗑<span class="bin-secs">{secsLeft(p, nowTick)}</span>
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
    {#if galleryRevealed && othersCount > 0 && ev?.joinCode}
      <a class="full-gallery" href="/gallery/{ev.joinCode}">
        🖼 See everyone's photos{#if faceMatching} — and find the ones you're in{/if} →
      </a>
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
  {#if lbOpen}<Lightbox photos={shownPhotos} index={lbIndex} captionMode="own"
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
          <div class="capm-mission">🎩 {captionFor.challenge}</div>
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
        <span class="qthumb">{item.mediaType === 'video' ? '🎥' : '🖼'}</span>
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
  .btn.primary { background: var(--accent); color: var(--accent-ink, #111); width: 100%; }
  .btn.ghost { border-color: var(--border); color: var(--text); background: transparent; }
  /* Between ghost and primary. A ghost button on the out-of-shots card reads as a line of text
     rather than as something to press — and that card is a DARK overlay in both themes, so in the
     light theme a --text label on it is nearly invisible. A light wash of the accent gives it a
     button's shape without letting it compete with the solid primary beside it; the wash is the
     same one .roll-note already uses on the join screen for the same job. */
  .btn.soft { border-color: var(--accent); color: var(--text);
    background: color-mix(in srgb, var(--accent) 12%, transparent); }
  .btn.sm { padding: 7px 12px; font-size: 0.82rem; }

  /* Event poster image as the sign-in backdrop, with the join form in a readable card. */
  .join-bg { position: absolute; inset: 0; z-index: 0; overflow: hidden; }
  /* Keep the image's aspect ratio (contain) over a blurred, darkened fill — no oversized crop on wide screens. */
  .join-bg-blur { position: absolute; inset: -24px; background-size: cover; background-position: center; filter: blur(26px) brightness(0.5); }
  .join-bg-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
  .center.hasbg::after { content: ''; position: absolute; inset: 0; background: rgba(0,0,0,0.5); z-index: 1; }
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
  .join .btn { margin-top: 20px; }
  .manage-link { display: inline-block; margin-top: 16px; font-size: 0.78rem; color: var(--text-muted); text-decoration: none; }
  .manage-link:hover { color: var(--accent); text-decoration: underline; }

  .cam { position: fixed; inset: 0; background: #000; overflow: hidden; z-index: 10; }
  /* The viewfinder fills the whole screen; controls overlay it (native-camera style), so
     'full' aspect is truly edge-to-edge and fixed ratios sit behind the floating controls. */
  .viewfinder { position: absolute; inset: 0; overflow: hidden; display: flex; align-items: center; justify-content: center; }
  video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .mirrored { transform: scaleX(-1); }
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
  .bright-hud { position: absolute; top: 70px; left: 50%; transform: translateX(-50%); z-index: 5;
    display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 999px;
    background: rgba(0,0,0,0.6); color: #fff; backdrop-filter: blur(4px); }
  .bright-hud > span:first-child { font-size: 1rem; }
  .bright-bar { width: 120px; height: 5px; border-radius: 3px; background: rgba(255,255,255,0.25); overflow: hidden; }
  .bright-fill { height: 100%; background: var(--accent); }
  .bright-val { font-family: var(--font-mono); font-size: 0.72rem; min-width: 38px; text-align: right; }
  .focus-ring { position: absolute; z-index: 4; width: 76px; height: 76px; margin: -38px 0 0 -38px; border: 2px solid #fff;
    border-radius: 50%; box-shadow: 0 0 0 1px rgba(0,0,0,.3); pointer-events: none; animation: focuspulse 0.85s ease-out forwards; }
  @keyframes focuspulse { 0% { transform: scale(1.4); opacity: 0; } 25% { transform: scale(1); opacity: 1; } 100% { transform: scale(0.9); opacity: 0; } }
  .topbar { position: absolute; top: 0; left: 0; right: 0; z-index: 6; padding: 16px 20px; display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; background: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent); pointer-events: none; }
  .evname { display: inline-flex; align-items: center; gap: 7px; font-family: var(--font-mono); font-size: 0.85rem; color: #fff; }
  .demo-nav { display: flex; gap: 6px; flex-wrap: wrap; }
  /* Demo-only escape hatch back to the marketing site. pointer-events:auto re-enables
     clicks inside the otherwise click-through topbar. */
  .home-btn { pointer-events: auto; display: inline-flex; align-items: center; gap: 6px;
    background: rgba(0,0,0,0.5); color: #fff; text-decoration: none; font-weight: 700; font-size: 0.8rem;
    padding: 8px 14px; border-radius: 999px; backdrop-filter: blur(4px); }
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
  .counter { font-family: var(--font-mono); font-size: 1.5rem; font-weight: bold; color: #fff; text-align: right; line-height: 1; }
  .counter.low { color: var(--danger); } .counter small { display: block; font-size: 0.6rem; opacity: 0.7; text-transform: uppercase; }
  .rail { position: absolute; top: 64px; right: 14px; display: flex; flex-direction: column; gap: 10px; z-index: 6; }
  .ctrl { width: 40px; height: 40px; border-radius: 50%; border: 1px solid rgba(255,255,255,0.25); background: rgba(0,0,0,0.45); color: #fff; font-size: 0.95rem; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  .ctrl.active { border-color: var(--accent); background: rgba(245,197,24,0.25); }
  .ctrl.tiny { width: 34px; height: 34px; font-size: 0.85rem; flex: none; }
  .ctrl:disabled { opacity: 0.35; cursor: default; }

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
  .sm-select { width: 100%; background: rgba(0,0,0,0.5); color: #fff; border: 1px solid rgba(255,255,255,0.3);
    border-radius: 8px; padding: 9px 10px; font: inherit; font-size: 0.85rem; }
  .sm-note { font-size: 0.74rem; color: rgba(255,255,255,0.75); padding-top: 12px; }
  .grid { position: absolute; inset: 0; pointer-events: none; } .grid span { position: absolute; background: rgba(255,255,255,0.2); }
  .grid span:nth-child(1) { left: 33.3%; top: 0; bottom: 0; width: 1px; } .grid span:nth-child(2) { left: 66.6%; top: 0; bottom: 0; width: 1px; }
  .grid span:nth-child(3) { top: 33.3%; left: 0; right: 0; height: 1px; } .grid span:nth-child(4) { top: 66.6%; left: 0; right: 0; height: 1px; }
  /* Clear of the topbar — at top:16px a long event name sat straight over the timer. */
  .rec { position: absolute; top: 64px; left: 50%; transform: translateX(-50%); z-index: 7; color: #fff; background: rgba(0,0,0,0.5); padding: 4px 12px; border-radius: 999px; font-family: var(--font-mono); }
  /* Keeps the shutter row from reflowing when the flip button is hidden mid-recording. */
  .round-spacer { display: inline-block; width: 44px; height: 44px; }
  .modes { position: absolute; bottom: 108px; left: 50%; transform: translateX(-50%); display: flex; background: rgba(0,0,0,0.5); border-radius: 999px; padding: 3px; z-index: 10; }
  .modes button { padding: 5px 14px; border-radius: 999px; border: none; background: transparent; color: rgba(255,255,255,0.6); font-size: 0.78rem; font-weight: 600; cursor: pointer; -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; user-select: none; outline: none; }
  .modes button.on { background: #fff; color: #111; }
  .bottombar { position: absolute; left: 0; right: 0; bottom: 0; z-index: 8; padding: 20px;
    background: linear-gradient(transparent, rgba(0,0,0,0.65)); display: flex; align-items: center; justify-content: space-between; }
  .round { width: 52px; height: 52px; border-radius: 50%; border: none; background: rgba(255,255,255,0.15); color: #fff; font-size: 1.3rem; cursor: pointer; position: relative; }
  .badge { position: absolute; top: -4px; right: -4px; background: var(--accent); color: var(--accent-ink, #111); border-radius: 999px; min-width: 18px; height: 18px; font-size: 0.65rem; font-weight: bold; display: flex; align-items: center; justify-content: center; padding: 0 4px; }
  .badge.error { background: #c0392b; color: #fff; }
  /* A hold-for-more marker, the same idea as the dot iOS puts on a control that has a long press.
     Only drawn when there IS more than one lens: advertising a gesture that does nothing is worse
     than not advertising it. */
  .round.has-more::after {
    /* An ellipsis, not a single dot. A lone dot is not a recognised affordance for anything; "…"
       is the long-standing convention for "there is more behind this". */
    content: '\2026'; position: absolute; right: 6px; bottom: 1px;
    font-size: .8rem; line-height: 1; color: rgba(255,255,255,.9);
    text-shadow: 0 1px 3px rgba(0,0,0,.8); pointer-events: none;
  }
  .lens-back { position: absolute; inset: 0; z-index: 12; display: flex; align-items: flex-end;
    justify-content: center; padding: 0 12px 96px; pointer-events: auto; background: rgba(0,0,0,.34); }
  .lens-sheet { width: min(340px, 92vw); display: flex; flex-direction: column; gap: 6px; padding: 12px;
    border-radius: 16px; color: #fff; background: rgba(0,0,0,.86); border: 1px solid rgba(255,255,255,.22);
    backdrop-filter: blur(6px); }
  .lens-head { font-size: .78rem; text-transform: uppercase; letter-spacing: .08em; opacity: .72; padding: 2px 6px 6px; }
  .lens-row { display: flex; align-items: stretch; gap: 6px; }
  .lens-row .lens-opt { flex: 1; min-width: 0; }
  .lens-fav { flex: none; width: 44px; border-radius: 11px; border: 1px solid rgba(255,255,255,.16);
    background: rgba(255,255,255,.06); color: rgba(255,255,255,.55); font-size: 1rem; cursor: pointer; }
  .lens-fav.on { color: #f0b429; border-color: rgba(240,180,41,.6); background: rgba(240,180,41,.12); }
  .lens-opt { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%;
    padding: 12px 14px; border-radius: 11px; border: 1px solid rgba(255,255,255,.16); background: rgba(255,255,255,.06);
    color: #fff; font: inherit; font-size: .92rem; cursor: pointer; text-align: left; }
  .lens-opt.on { border-color: rgba(240,180,41,.75); background: rgba(240,180,41,.14); }
  .lens-now { color: #f0b429; font-size: .7rem; }
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
  .full-gallery {
    display: block; max-width: 720px; margin: 0 auto 14px; padding: 12px 16px; text-align: center;
    border: 1px solid var(--border); border-radius: 12px; background: var(--surface);
    color: var(--text); text-decoration: none; font-size: .88rem; font-weight: 600;
  }
  .full-gallery:hover { border-color: var(--accent); }
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
  .shutter:disabled { opacity: 0.4; }
  .shutter .core { transition: width 0.18s ease, height 0.18s ease, border-radius 0.18s ease, background 0.18s ease; }
  /* Photo: solid white circle. */
  .shutter.photo .core { width: 60px; height: 60px; border-radius: 50%; background: #fff; }
  .shutter.photo:active:not(:disabled) .core { width: 54px; height: 54px; }
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
  .gallery-actions { display: flex; align-items: center; gap: 8px; }
  .queue-btn { display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; }
  .qbadge { background: var(--accent); color: var(--accent-ink, #111); font-size: 0.68rem; font-weight: 800; min-width: 17px; height: 17px; border-radius: 9px; padding: 0 4px; display: inline-flex; align-items: center; justify-content: center; }
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
  .armed-x {
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
  .m-go { flex: none; font-size: .72rem; text-transform: uppercase; letter-spacing: .06em; opacity: .6; }
  .m-item.armed .m-go { opacity: 1; color: #7fb3a3; }

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
  /* The exit is the one thing here that is not part of the tour, so it recedes. */
  .home-btn.quiet { background: rgba(0,0,0,.32); font-weight: 600; opacity: .82; }
  .home-btn.quiet:hover { opacity: 1; }
  /* Sits where the armed strip does, and clears the control rail the same way. */
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
