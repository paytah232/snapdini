<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';
  import { getEvent, getMe, joinEvent, getPhotosBySession, type PublicEvent, type Photo } from '$lib/events';
  import { getSession, saveSession, clearSession } from '$lib/session';
  import { applyEventTheme } from '$lib/theme';
  import { showToast } from '$lib/toast';
  import { reportClientError } from '$lib/report';
  import { imgFallback, hidePoster } from '$lib/ui';
  import { putCapture, delCapture, listCaptures } from '$lib/captureStore';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import Logo from '$lib/components/Logo.svelte';

  export let identifier: string; // joinCode or slug

  type Screen = 'loading' | 'join' | 'upcoming' | 'camera' | 'gallery';
  let screen: Screen = 'loading';

  let ev: PublicEvent | null = null;
  let sessionToken: string | null = null;
  let photosRemaining = 0;

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
  let cameras: { id: string; label: string }[] = [];   // available video inputs (for the picker)
  let deviceId: string | null = null;                   // specific chosen camera (multi-camera systems)
  let videoMaxSecs = 0;
  let videoMode = false;
  let recording = false;
  let recSecs = 0;
  let recTimer: ReturnType<typeof setInterval> | undefined;
  let mediaRecorder: MediaRecorder | null = null;
  let chunks: BlobPart[] = [];

  let settingsOpen = false;
  let screenFlash = false;       // selfie screen-flash
  let torchSupported = false;    // hardware torch (back camera, Android Chrome)
  let flashArmed = false;        // when armed, the torch fires for the shot (and lights video)
  let fillActive = false;
  let gridOn = false;
  let brightness = 1;            // preview/photo brightness (CSS filter), 1 = normal
  let track: MediaStreamTrack | null = null;
  let focusRing: { x: number; y: number } | null = null;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  let cameraError = '';          // set when getUserMedia fails (permission/no-camera)
  let cameraStarting = false;    // true while the stream is (re)acquiring — shows a spinner
  let cameraPaused = false;      // user explicitly turned the camera off (manual privacy/battery)
  let focusSupported = false;     // true only if the device exposes tap-to-focus controls

  // aspect
  let allowedAspects: string[] = ['1:1'];
  let aspect = '1:1';

  // upload queue
  interface QueueItem { id: string; blob: Blob; mediaType: 'photo' | 'video'; ext: string; status: 'pending' | 'uploading' | 'done' | 'error'; error?: string; progress?: number; size: number; durationSecs?: number; w?: number; h?: number; retries?: number; }
  const MAX_UPLOAD_RETRIES = 5;   // auto-retry a failing upload this many times (with backoff) before asking the user
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
  let galleryFilter: 'mine' | 'all' | 'others' = 'mine';
  $: ownCount = galleryPhotos.filter((p) => p.isOwn).length;
  $: othersCount = galleryPhotos.length - ownCount;
  $: shownPhotos = galleryFilter === 'all' ? galleryPhotos
    : galleryFilter === 'mine' ? galleryPhotos.filter((p) => p.isOwn)
    : galleryPhotos.filter((p) => !p.isOwn);
  let revealMsg = '';
  let lbOpen = false;
  let lbIndex = 0;
  let allowDownloads = true;

  $: pendingCount = queue.filter((q) => q.status !== 'done').length;
  $: hasUploadError = queue.some((q) => q.status === 'error');
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
    // Apply the event's theme straight away so the JOIN screen (button, colours) is themed too —
    // applyEventTheme is contrast-guarded and falls back to the warm default for no-theme events.
    applyEventTheme(ev.theme);
    allowedAspects = ev.aspectRatios?.length ? ev.aspectRatios : ['1:1'];
    aspect = allowedAspects[0];
    document.title = `${ev.name} — Snapdini`;

    if (ev.isUpcoming) { screen = 'upcoming'; return; }

    const token = getSession(ev.joinCode);
    if (token) {
      try {
        const me = await getMe(token);
        sessionToken = token;
        photosRemaining = me.photosRemaining;
        allowDownloads = me.allowDownloads;
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
      const r = await joinEvent(identifier, joinName.trim(), joinEmail.trim() || undefined);
      sessionToken = r.sessionToken;
      photosRemaining = r.photosRemaining;
      saveSession(r.joinCode, r.sessionToken);
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
    try { const q = localStorage.getItem('snap_vidq'); if (q === 'high' || q === 'standard' || q === 'smooth') videoQuality = q; } catch { /* ignore */ }
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
    const liveId = track?.getSettings?.().deviceId;
    if (liveId) deviceId = liveId;
    // Tap-to-focus only works where the device exposes focus controls (some Android
    // Chrome); iOS Safari never does. Detect it so we don't show a fake focus ring.
    const caps = (track?.getCapabilities?.() ?? {}) as Record<string, unknown>;
    focusSupported = 'pointsOfInterest' in caps || 'focusMode' in caps;
    // Hardware torch (back camera on Android Chrome). iOS Safari never exposes it.
    torchSupported = 'torch' in caps && !!caps.torch;   // a fresh stream always starts with the torch physically off
    cameraError = '';
    matchRecBitrate();   // size the recorder to whatever the camera actually gave us
    applyViewfinderAspect();
  }

  // Photos: request the camera's max (soft `ideal` hints — a 4K/1080p sensor returns its best).
  // Video: phone browsers can't encode 4K/8K via MediaRecorder in real time (the frame rate
  // collapses), so we request a sane ceiling per the chosen quality. 'Standard' (1080p30) is the
  // reliable default; bump to High or drop to Smooth from the camera settings.
  const RES_PHOTO = { width: { ideal: 7680 }, height: { ideal: 4320 } };
  type VidQuality = 'high' | 'standard' | 'smooth';
  const VQ_RES: Record<VidQuality, { w: number; h: number }> = {
    high:     { w: 3840, h: 2160 },   // 4K — only on capable devices
    standard: { w: 1920, h: 1080 },   // 1080p — the default
    smooth:   { w: 1280, h: 720 },    // 720p — for older / struggling devices
  };
  let videoQuality: VidQuality = 'high';   // default to 4K; phones are usually capable, and we warn if it stutters
  let recBitrate = 10_000_000;
  let lowFpsWarned = false;                // one stutter warning per session unless quality changes

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
    const q = VQ_RES[videoQuality];
    const res = videoMode
      ? { width: { ideal: q.w }, height: { ideal: q.h }, frameRate: { ideal: 30 } }
      : RES_PHOTO;
    try {
      // A specific camera was chosen (multi-camera systems); else pick by front/back facing.
      const video: MediaTrackConstraints = deviceId
        ? { deviceId: { exact: deviceId }, ...res }
        : { facingMode: { ideal: facing }, ...res };
      await attachCamera({ video, audio });
    } catch {
      // The requested camera/facing may not exist (missing selfie cam, unplugged webcam, incognito).
      // Drop the specific pick and try ANY camera before giving up.
      deviceId = null;
      try {
        await attachCamera({ video: true, audio });
      } catch (err2) {
        stopCamera();   // make sure no half-open stream remains (shutter stays disabled on error)
        cameraStarting = false;
        const denied = err2 instanceof DOMException && (err2.name === 'NotAllowedError' || err2.name === 'SecurityError');
        const missing = err2 instanceof DOMException && err2.name === 'NotFoundError';
        cameraError = denied
          ? 'Camera access is blocked. Enable it in your browser settings, then tap Retry.'
          : missing ? 'No camera found on this device.' : 'Couldn’t start the camera.';
        reportClientError(`camera: ${err2 instanceof Error ? err2.name + ' ' + err2.message : 'failed'}`, 'camera', ev?.joinCode);
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
      cameras = devs.filter((d) => d.kind === 'videoinput')
        .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
      // Track the live camera so the picker reflects reality (e.g. after a facing flip).
      const live = track?.getSettings?.().deviceId;
      if (live) deviceId = live;
    } catch { /* enumeration unsupported — picker just won't appear */ }
  }

  function pickCamera(id: string) {
    if (id === deviceId) return;
    deviceId = id;   // session-only — we always start from the reliable default each visit
    startCamera();
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
  function flip() { deviceId = null; facing = facing === 'environment' ? 'user' : 'environment'; startCamera(); }

  // Drive the hardware torch on/off (where supported). Used as a flash pulse for photos and a
  // continuous light for video.
  async function setTorch(on: boolean) {
    if (!track || !torchSupported) return;
    try { await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] }); }
    catch { /* unsupported mid-stream — ignore */ }
  }

  // Photo ↔ Video. Re-acquires the stream so each mode runs at its own resolution
  // (max-res stills vs smooth 1080p30 recording) and only grabs the mic for video.
  async function setMode(v: boolean) {
    if (recording || v === videoMode) return;
    videoMode = v;
    await startCamera();
  }

  // Video quality is a per-device preference; lowering it helps weaker phones record smoothly.
  async function setVideoQuality(q: string) {
    if (q !== 'high' && q !== 'standard' && q !== 'smooth') return;
    if (recording || q === videoQuality) return;
    videoQuality = q;
    lowFpsWarned = false;   // let a fresh warning fire if the new quality still struggles
    try { localStorage.setItem('snap_vidq', q); } catch { /* ignore */ }
    if (videoMode) await startCamera();   // re-acquire at the new resolution
  }

  // Brightness is a CSS filter on the preview (and baked into photo capture).
  $: if (videoEl) videoEl.style.filter = brightness === 1 ? '' : `brightness(${brightness})`;

  // Tap-to-focus: best-effort. Where the device exposes focus/exposure points of
  // interest we apply them; everywhere we show a focus ring for feedback.
  async function tapFocus(e: MouseEvent) {
    const host = e.currentTarget as HTMLElement;
    const rect = host.getBoundingClientRect();
    const nx = (e.clientX - rect.left) / rect.width;
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
      // Maximum quality — capture at native resolution with JPEG quality 1.0 (no perceptible
      // compression). We don't downscale; big files are fine per product direction.
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 1.0));
      if (blob) enqueue(blob, 'photo', 'jpg', { w: canvas.width, h: canvas.height });
    } finally {
      if (useFlash) setTorch(false);   // flash off again after the shot
      capturing = false;
    }
  }

  function toggleRecord() {
    if (!stream) return;
    if (!recording) {
      const types = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4', ''];
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
        enqueue(blob, 'video', ext, { durationSecs: secs });
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
    if (fps < 20 && !lowFpsWarned && videoQuality !== 'smooth') {
      lowFpsWarned = true;
      showToast('Recording looks choppy — try a lower Video quality in ⚙ settings.', true);
    }
  }
  function stopFpsMonitor() {
    const v = videoEl as RVFCVideo | null;
    if (fpsHandle && v?.cancelVideoFrameCallback) v.cancelVideoFrameCallback(fpsHandle);
    fpsHandle = 0; clearTimeout(fpsCheckTimer);
  }

  function enqueue(blob: Blob, mediaType: 'photo' | 'video', ext: string, extra?: { durationSecs?: number; w?: number; h?: number }) {
    const id = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36).slice(2);
    queue = [...queue, { id, blob, mediaType, ext, status: 'pending', size: blob.size, ...extra }];
    photosRemaining = Math.max(0, photosRemaining - 1);
    // Persist to IndexedDB immediately so the capture survives an outage / reload / closed tab.
    if (sessionToken && ev) putCapture({ id, joinCode: ev.joinCode, sessionToken, blob, mediaType, ext, createdAt: Date.now() }).catch(() => {});
    if (saveToDevice) saveToDeviceCopy(blob, ext);
    processQueue();
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

  // Restore any captures still queued in IndexedDB (from a previous session / outage).
  async function restoreQueue() {
    if (!ev) return;
    try {
      const stored = await listCaptures(ev.joinCode);
      const have = new Set(queue.map((q) => q.id));
      const restored = stored.filter((s) => !have.has(s.id))
        .map((s) => ({ id: s.id, blob: s.blob, mediaType: s.mediaType, ext: s.ext, status: 'pending' as const, size: s.blob?.size ?? 0 }));
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

  async function processQueue() {
    if (uploading) return;
    const item = queue.find((q) => q.status === 'pending');
    if (!item) return;
    uploading = true; item.status = 'uploading'; item.progress = 0; queue = queue;
    try {
      const form = new FormData();
      form.append('photo', item.blob, `media.${item.ext}`);
      form.append('sessionToken', sessionToken!);
      // XHR (not fetch) so we get a live upload % — uploads still run in the background, one at a time.
      const data = await new Promise<{ photosRemaining: number }>((resolve, reject) => {
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
      item.status = 'done'; item.progress = 100;
      // Never let the count flicker UP: the per-upload server value lags behind the local
      // optimistic count during a burst, so only ever take the lower of the two.
      photosRemaining = Math.min(photosRemaining, data.photosRemaining);
      delCapture(item.id).catch(() => {});   // uploaded → drop from the offline queue
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : 'Upload failed';
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
    photosRemaining = Math.max(0, photosRemaining - 1);
    queue = queue;
    processQueue();
  }

  async function openGallery() {
    screen = 'gallery';
    galleryFilter = 'mine';   // default to the guest's own shots each visit
    stopCamera();   // free the camera while browsing the gallery — saves battery, drops the "in use" indicator
    applyEventTheme(ev?.theme);
    try {
      const r = await getPhotosBySession(identifier, sessionToken!);
      galleryRevealed = r.revealed;
      allowDownloads = r.allowDownloads ?? true;
      // Own photos come back even before reveal; everyone else's stay hidden.
      galleryPhotos = r.photos || [];
      if (!r.revealed) {
        revealMsg = r.revealMode === 'manual' ? 'The host will reveal everyone’s photos soon.'
          : r.revealMode === 'at_end' ? 'Everyone’s photos unlock when the event ends.'
          : 'Photos are hidden right now.';
      }
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not load gallery', true); }
  }

  function backToCamera() { screen = 'camera'; startCamera(); }
</script>

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
  <div id="cam-root" class="cam">
    <div class="viewfinder">
      <!-- svelte-ignore a11y-media-has-caption -->
      <video bind:this={videoEl} autoplay playsinline muted></video>
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
      <div class="topbar">
        {#if ev?.isDemo}
          <div class="demo-nav">
            <a class="home-btn" href="/" aria-label="Back to Snapdini home">⌂ Home</a>
            {#if demoHostHref}<a class="home-btn" href={demoHostHref} aria-label="See the host view">🎛 Host</a>{/if}
            <a class="home-btn" href={demoGalleryHref} aria-label="See the gallery">🖼 Gallery</a>
          </div>
        {:else}
          <div class="evname"><Logo word={false} color={ev?.theme?.accent ?? ''} /> {ev?.name}</div>
        {/if}
        <div class="counter" class:low={photosRemaining <= 5}>{photosRemaining}<small>left</small></div>
      </div>
      <div class="rail">
        {#if facing === 'user'}<button class="ctrl" on:click={() => (screenFlash = !screenFlash)} class:active={screenFlash} title="Flash" aria-label="Flash">⚡</button>{/if}
        {#if torchSupported && !ev?.noFlash}<button class="ctrl" on:click={() => (flashArmed = !flashArmed)} class:active={flashArmed} title="Flash" aria-label="Flash">⚡</button>{/if}
        {#if allowedAspects.length > 1}<button class="ctrl" on:click={cycleAspect} title="Photo shape" aria-label="Change photo shape (currently {aspect})">{aspect === 'full' ? 'Full' : aspect}</button>{/if}
        <button class="ctrl" on:click={() => (settingsOpen = !settingsOpen)} class:active={settingsOpen} title="Settings" aria-label="Camera settings">⚙</button>
        <button class="ctrl" on:click={toggleCameraPower} class:active={cameraPaused} title={cameraPaused ? 'Turn camera on' : 'Turn camera off'} aria-label={cameraPaused ? 'Turn camera on' : 'Turn camera off'} aria-pressed={cameraPaused}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="3.5"/>{#if !cameraPaused}<line x1="2" y1="2" x2="22" y2="22"/>{/if}</svg>
        </button>
        <button class="ctrl" on:click={toggleFullscreen} title="Fullscreen" aria-label="Fullscreen">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>
        </button>
      </div>
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
                  <span class="sm-desc">Switch between the cameras on this device.</span>
                </span>
                <select class="sm-select" aria-label="Choose camera" value={deviceId ?? ''} on:change={(e) => pickCamera(e.currentTarget.value)}>
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
                  <option value="high">High — 4K (default)</option>
                  <option value="standard">Standard — 1080p</option>
                  <option value="smooth">Smooth — 720p (older phones)</option>
                </select>
              </div>
            {/if}

            {#if saveNote}<div class="sm-note">Now also saving a copy of each shot to your device.</div>{/if}
          </div>
        </div>
      {/if}
      {#if gridOn}<div class="grid"><span></span><span></span><span></span><span></span></div>{/if}
      {#if recording}<div class="rec">● {Math.floor(recSecs / 60)}:{String(recSecs % 60).padStart(2, '0')}</div>{/if}
      {#if cameraStarting && !cameraError}
        <div class="cam-loading" transition:fade={{ duration: 120 }}>
          <div class="cam-spinner" aria-label="Starting camera"></div>
        </div>
      {/if}
      {#if cameraError}
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
      <button class="round" on:click={flip} title="Flip camera" aria-label="Flip camera" disabled={recording}>🔄</button>
    </div>
  </div>
{:else if screen === 'gallery'}
  <div class="gallery">
    <header>
      <h2><Logo word={false} color={ev?.theme?.accent ?? ''} /> {ev?.name}</h2>
      <div class="gallery-actions">
        {#if queue.length}
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
    {:else if othersCount > 0}
      <div class="gfilter" role="tablist" aria-label="Filter photos">
        <button class="gchip" class:on={galleryFilter === 'mine'} on:click={() => (galleryFilter = 'mine')}>Mine <span class="n">{ownCount}</span></button>
        <button class="gchip" class:on={galleryFilter === 'all'} on:click={() => (galleryFilter = 'all')}>All <span class="n">{galleryPhotos.length}</span></button>
        <button class="gchip" class:on={galleryFilter === 'others'} on:click={() => (galleryFilter = 'others')}>Others <span class="n">{othersCount}</span></button>
      </div>
    {/if}
    {#if shownPhotos.length}
      <div class="pgrid">
        {#each shownPhotos as p, i}
          <button class="pcell" on:click={() => { lbIndex = i; lbOpen = true; }}>
            {#if p.mediaType === 'video'}<img src={p.thumbUrl} alt="" loading="lazy" on:error={hidePoster} /><span class="play">▶</span>{:else}<img src={p.thumbUrl ?? p.url} alt="" loading="lazy" on:error={(e) => imgFallback(e, p.url)} />{/if}
            {#if galleryFilter === 'mine'}<span class="snapno">#{shownPhotos.length - i}</span>{/if}
          </button>
        {/each}
      </div>
    {:else}
      <div class="empty">
        <span class="big">{galleryRevealed ? '📷' : '🔒'}</span>
        <p class="muted">{galleryRevealed ? (galleryFilter === 'mine' ? 'You haven’t taken any yet — switch to All.' : 'Nothing here yet.') : 'You haven’t taken any photos yet.'}</p>
      </div>
    {/if}
  </div>
  {#if lbOpen}<Lightbox photos={shownPhotos} index={lbIndex} on:close={() => (lbOpen = false)} />{/if}
{/if}

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
  .fill { position: absolute; inset: 0; background: #fff; z-index: 5; }
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
  .topbar { position: absolute; top: 0; left: 0; right: 0; z-index: 6; padding: 16px 20px; display: flex; justify-content: space-between; align-items: flex-start; background: linear-gradient(to bottom, rgba(0,0,0,0.6), transparent); pointer-events: none; }
  .evname { display: inline-flex; align-items: center; gap: 7px; font-family: var(--font-mono); font-size: 0.85rem; color: #fff; }
  .demo-nav { display: flex; gap: 6px; flex-wrap: wrap; }
  /* Demo-only escape hatch back to the marketing site. pointer-events:auto re-enables
     clicks inside the otherwise click-through topbar. */
  .home-btn { pointer-events: auto; display: inline-flex; align-items: center; gap: 6px;
    background: rgba(0,0,0,0.5); color: #fff; text-decoration: none; font-weight: 700; font-size: 0.8rem;
    padding: 8px 14px; border-radius: 999px; backdrop-filter: blur(4px); }
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
  .rec { position: absolute; top: 16px; left: 50%; transform: translateX(-50%); color: #fff; background: rgba(0,0,0,0.5); padding: 4px 12px; border-radius: 999px; font-family: var(--font-mono); }
  .modes { position: absolute; bottom: 108px; left: 50%; transform: translateX(-50%); display: flex; background: rgba(0,0,0,0.5); border-radius: 999px; padding: 3px; z-index: 10; }
  .modes button { padding: 5px 14px; border-radius: 999px; border: none; background: transparent; color: rgba(255,255,255,0.6); font-size: 0.78rem; font-weight: 600; cursor: pointer; -webkit-tap-highlight-color: transparent; -webkit-touch-callout: none; user-select: none; outline: none; }
  .modes button.on { background: #fff; color: #111; }
  .bottombar { position: absolute; left: 0; right: 0; bottom: 0; z-index: 8; padding: 20px;
    background: linear-gradient(transparent, rgba(0,0,0,0.65)); display: flex; align-items: center; justify-content: space-between; }
  .round { width: 52px; height: 52px; border-radius: 50%; border: none; background: rgba(255,255,255,0.15); color: #fff; font-size: 1.3rem; cursor: pointer; position: relative; }
  .badge { position: absolute; top: -4px; right: -4px; background: var(--accent); color: var(--accent-ink, #111); border-radius: 999px; min-width: 18px; height: 18px; font-size: 0.65rem; font-weight: bold; display: flex; align-items: center; justify-content: center; padding: 0 4px; }
  .badge.error { background: #c0392b; color: #fff; }
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
  .gfilter { display: flex; gap: 8px; padding: 10px 12px; flex-wrap: wrap; }
  .gchip { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 0.8rem; font-weight: 700;
    padding: 6px 13px; border-radius: 999px; cursor: pointer; background: var(--surface); border: 1px solid var(--border); color: var(--text-muted); }
  .gchip.on { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); }
  .gchip .n { font-size: 0.7rem; opacity: 0.75; }
  .pgrid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 3px; padding: 3px; }
  .pcell { position: relative; aspect-ratio: 1; border: none; padding: 0; cursor: pointer; background: var(--surface-2); }
  .pcell img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .play { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 1.5rem; text-shadow: 0 1px 4px #000; }
  .snapno { position: absolute; top: 5px; left: 5px; min-width: 18px; padding: 1px 5px; border-radius: 9px;
    background: rgba(0,0,0,0.6); color: #fff; font-size: 0.7rem; font-weight: 700; line-height: 1.4; pointer-events: none; }
</style>
