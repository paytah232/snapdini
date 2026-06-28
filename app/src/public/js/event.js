// ── State ─────────────────────────────────────────────────────────────────────
const pathParts  = window.location.pathname.split('/');
const identifier = pathParts[2];

let stream          = null;
let facingMode      = 'environment';
let sessionToken    = null;
let photosRemaining = 0;
let eventData       = null;
let countdownTimer  = null;
let torchOn         = false;
let gridVisible     = false;
let exposureVisible = false;
let allowedAspects  = ['1:1'];   // ratios the event permits
let currentAspect   = '1:1';     // ratio currently selected for capture
let screenFlash     = false;     // light the screen white on capture (selfie fill light)

// Video state
let videoMode       = false;   // false = photo, true = video
let mediaRecorder   = null;
let recordedChunks  = [];
let recordingTimer  = null;
let recordingSecs   = 0;
let videoMaxSecs    = 0;
let isRecording     = false;

// Upload queue
const uploadQueue   = [];
let isUploading     = false;
let queueVisible    = false;

// Gallery state
let showHighlightsOnly = false;
let currentPhotos      = [];
let myParticipantId    = null;
let allowDownloads     = true;
let lbPhotos = [], lbIndex = 0;

// Elements
const joinScreen  = document.getElementById('join-screen');
const cameraPage  = document.getElementById('camera-page');
const galleryPage = document.getElementById('gallery-page');

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function init() {
  // Load server config (video enabled?)
  try {
    const cfg = await fetch('/api/config').then(r => r.json());
    videoMaxSecs = cfg.videoMaxSeconds || 0;
  } catch {}

  try {
    const res = await fetch(`/api/events/${identifier}`);
    if (!res.ok) { showFatalError('Event not found'); return; }
    eventData = await res.json();
  } catch { showFatalError('Could not reach the server'); return; }

  document.title = `${eventData.name} — Snapdini`;
  document.getElementById('join-event-name').textContent    = eventData.name;
  document.getElementById('cam-event-name').textContent     = eventData.name;
  document.getElementById('gallery-event-name').textContent = eventData.name;

  applyTheme(eventData.theme);
  allowDownloads = eventData.allowDownloads !== false;

  // Check for upcoming event
  if (eventData.isUpcoming) {
    showUpcomingScreen();
    return;
  }

  const storageKey = `session_${eventData.joinCode}`;
  sessionToken = localStorage.getItem(storageKey) || localStorage.getItem(`session_${identifier.toUpperCase()}`);

  if (sessionToken) {
    const ok = await verifySession();
    if (ok) { await enterCamera(); return; }
    localStorage.removeItem(storageKey);
    sessionToken = null;
  }

  joinScreen.style.display = 'flex';
}

async function verifySession() {
  try {
    const res = await fetch(`/api/participants/me`, { headers: { 'X-Session-Token': sessionToken } });
    if (!res.ok) return false;
    const d = await res.json();
    photosRemaining = d.photosRemaining;
    return true;
  } catch { return false; }
}

// ── Upcoming screen ───────────────────────────────────────────────────────────
function showUpcomingScreen() {
  joinScreen.style.display = 'none';
  cameraPage.classList.add('hidden');
  document.body.innerHTML += `
    <div style="position:fixed;inset:0;background:var(--bg);display:flex;align-items:center;justify-content:center;z-index:100;padding:24px">
      <div class="upcoming-wall">
        <span class="icon">⏰</span>
        <h2>${escHtml(eventData.name)}</h2>
        <p>This event hasn't opened yet.</p>
        <div class="upcoming-time">${new Date(eventData.startsAt).toLocaleString()}</div>
        <button class="btn btn-secondary" onclick="location.reload()" style="width:auto;margin:0 auto">↻ Check again</button>
      </div>
    </div>
  `;
}

// ── Join ──────────────────────────────────────────────────────────────────────
document.getElementById('join-btn').addEventListener('click', async () => {
  const name  = document.getElementById('participant-name').value.trim();
  const email = document.getElementById('participant-email').value.trim();
  if (!name) { showToast('Enter your name', true); return; }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { showToast('That email doesn\'t look right', true); return; }

  const btn = document.getElementById('join-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Joining…';

  try {
    const res  = await fetch('/api/participants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ joinCode: identifier, name, email: email || undefined }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    sessionToken    = data.sessionToken;
    photosRemaining = data.photosRemaining;
    localStorage.setItem(`session_${data.joinCode || identifier.toUpperCase()}`, sessionToken);
    await enterCamera();
  } catch (err) {
    showToast(err.message || 'Failed to join', true);
    btn.disabled = false;
    btn.textContent = 'Join & Open Camera';
  }
});

// ── Camera ────────────────────────────────────────────────────────────────────
async function enterCamera() {
  joinScreen.style.display = 'none';
  cameraPage.classList.remove('hidden');
  updateCounter();

  if (videoMaxSecs !== 0) {
    document.getElementById('mode-toggle').classList.remove('hidden');
  }

  // Aspect ratios the event allows (1 = locked, several = guest cycles via the button).
  allowedAspects = (eventData.aspectRatios && eventData.aspectRatios.length) ? eventData.aspectRatios : ['1:1'];
  currentAspect  = allowedAspects[0];
  const aspectBtn = document.getElementById('btn-aspect');
  if (allowedAspects.length > 1) { aspectBtn.classList.remove('hidden'); aspectBtn.textContent = aspectLabel(currentAspect); }
  else aspectBtn.classList.add('hidden');

  if (eventData.isExpired || eventData.isLocked) { showEventEnded(); return; }
  await startCamera();
  initTouchFocus();
}

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facingMode }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: videoMaxSecs !== 0,
    });
    const video = document.getElementById('video');
    video.srcObject = stream;
    await video.play();
    document.getElementById('no-camera').classList.add('hidden');
    document.getElementById('cam-perm').classList.add('hidden');
    video.classList.remove('hidden');
    document.getElementById('camera-actions-row').style.display = 'flex';
    // Only show the torch button if this camera actually reports torch support (else it's noise).
    const track0 = stream.getVideoTracks()[0];
    const torchOk = !!(track0 && track0.getCapabilities && track0.getCapabilities().torch === true);
    document.getElementById('btn-torch').classList.toggle('hidden', !torchOk);
    applyViewfinderAspect(currentAspect);
  } catch (err) {
    document.getElementById('camera-actions-row').style.display = 'none';
    document.getElementById('video').classList.add('hidden');
    // Permission denied → show a clear prompt with a retry button. Other errors → file fallback.
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    document.getElementById('no-camera').classList.toggle('hidden', denied);
    document.getElementById('cam-perm').classList.toggle('hidden', !denied);
  }
}

function stopCamera() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  torchOn = false;
  document.getElementById('btn-torch').classList.remove('active');
}

document.getElementById('btn-flip').addEventListener('click', async () => {
  facingMode = facingMode === 'environment' ? 'user' : 'environment';
  stopCamera();
  await startCamera();
  initTouchFocus();
});

// ── Camera controls ───────────────────────────────────────────────────────────
document.getElementById('btn-torch').addEventListener('click', async () => {
  const track = stream?.getVideoTracks()[0];
  if (!track) { showToast('Camera not ready yet', true); return; }
  if (facingMode === 'user') { showToast('Flip to the back camera for the torch', true); return; }
  const caps = track.getCapabilities?.() || {};
  if (caps.torch === false) { showToast('This camera has no torch', true); return; }
  const next = !torchOn;
  // Try the advanced form, then the top-level form (some browsers only honor one).
  let ok = false;
  try { await track.applyConstraints({ advanced: [{ torch: next }] }); ok = true; } catch {}
  if (!ok) { try { await track.applyConstraints({ torch: next }); ok = true; } catch {} }
  const applied = (track.getSettings?.() || {}).torch;
  if (!ok || applied === false) {
    showToast('Your browser blocked the torch (works best in Chrome on Android)', true);
    return;
  }
  torchOn = next;
  document.getElementById('btn-torch').classList.toggle('active', torchOn);
});

document.getElementById('btn-grid').addEventListener('click', () => {
  gridVisible = !gridVisible;
  document.getElementById('camera-grid').classList.toggle('hidden', !gridVisible);
  document.getElementById('btn-grid').classList.toggle('active', gridVisible);
});

document.getElementById('btn-exposure').addEventListener('click', () => {
  exposureVisible = !exposureVisible;
  document.getElementById('exposure-slider').classList.toggle('hidden', !exposureVisible);
  document.getElementById('btn-exposure-reset').classList.toggle('hidden', !exposureVisible);
  document.getElementById('btn-exposure').classList.toggle('active', exposureVisible);
});

document.getElementById('exposure-slider').addEventListener('input', async function () {
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const caps = track.getCapabilities?.() || {};
  if (!caps.exposureCompensation) return;
  const { min, max } = caps.exposureCompensation;
  const ev = min + (max - min) * (this.value / 100);
  // Manual exposure mode is required on many devices for compensation to take effect.
  try { await track.applyConstraints({ advanced: [{ exposureMode: 'manual', exposureCompensation: ev }] }); }
  catch { try { await track.applyConstraints({ advanced: [{ exposureCompensation: ev }] }); } catch {} }
});

// Reset brightness back to the camera's automatic exposure.
document.getElementById('btn-exposure-reset').addEventListener('click', async () => {
  document.getElementById('exposure-slider').value = 50;
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const caps = track.getCapabilities?.() || {};
  try {
    if (caps.exposureMode && caps.exposureMode.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ exposureMode: 'continuous' }] }); // back to auto
    } else if (caps.exposureCompensation) {
      const { min, max } = caps.exposureCompensation;
      await track.applyConstraints({ advanced: [{ exposureCompensation: min + (max - min) * 0.5 }] });
    }
    showToast('Brightness reset');
  } catch {}
});

// ── Settings cog / fullscreen / permission retry ──────────────────────────────
document.getElementById('btn-settings').addEventListener('click', () => {
  const panel = document.getElementById('cam-settings-panel');
  const open = panel.classList.toggle('hidden') === false;
  document.getElementById('btn-settings').classList.toggle('active', open);
});

document.getElementById('btn-fullscreen').addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await (document.getElementById('camera-page') || document.documentElement).requestFullscreen();
  } catch { showToast('Fullscreen not supported here', true); }
});

document.getElementById('cam-perm-retry').addEventListener('click', () => startCamera());

// Screen flash — lights the whole screen white on capture (a fill light for selfies,
// since hardware torch isn't reliable from the browser).
document.getElementById('btn-screenflash').addEventListener('click', () => {
  screenFlash = !screenFlash;
  document.getElementById('btn-screenflash').classList.toggle('active', screenFlash);
  showToast(screenFlash ? 'Screen flash on' : 'Screen flash off');
});

// ── Aspect ratio ──────────────────────────────────────────────────────────────
function aspectLabel(a) { return a === 'full' ? 'Full' : a; }
function aspectValue(a) { if (a === 'full') return null; const [w, h] = a.split(':').map(Number); return w / h; }
function cropRect(vw, vh, ratio) {
  if (ratio === null) return { sx: 0, sy: 0, sw: vw, sh: vh };  // full frame, no crop
  const vr = vw / vh;
  let sw, sh;
  if (vr > ratio) { sh = vh; sw = vh * ratio; } else { sw = vw; sh = vw / ratio; }
  return { sx: (vw - sw) / 2, sy: (vh - sh) / 2, sw, sh };       // centered crop
}
document.getElementById('btn-aspect').addEventListener('click', () => {
  const i = allowedAspects.indexOf(currentAspect);
  currentAspect = allowedAspects[(i + 1) % allowedAspects.length];
  document.getElementById('btn-aspect').textContent = aspectLabel(currentAspect);
  applyViewfinderAspect(currentAspect);
});

// Make the live view show EXACTLY what will be captured (WYSIWYG).
// Fixed ratios: letterbox the video to that ratio (cover = the same centred crop we capture).
// 'full': show the whole frame (contain) — matches the full-frame capture.
function applyViewfinderAspect(aspect) {
  const v = document.getElementById('video');
  const corners = document.querySelector('.camera-overlay');
  if (!v) return;
  if (!aspect || aspect === 'full') {
    v.style.aspectRatio = ''; v.style.width = '100%'; v.style.height = '100%'; v.style.objectFit = 'contain';
    if (corners) corners.style.display = '';
  } else {
    v.style.aspectRatio = aspect.replace(':', ' / ');
    v.style.width = 'auto'; v.style.height = 'auto';
    v.style.maxWidth = '100%'; v.style.maxHeight = '100%'; v.style.objectFit = 'cover';
    if (corners) corners.style.display = 'none'; // brackets would misframe the letterboxed video
  }
}

// ── Touch to focus ────────────────────────────────────────────────────────────
function initTouchFocus() {
  const video = document.getElementById('video');
  video.addEventListener('click', handleTapFocus);
}

async function handleTapFocus(e) {
  showFocusRing(e.clientX, e.clientY);   // always give visual feedback on tap
  const track = stream?.getVideoTracks()[0];
  if (!track) return;
  const caps = track.getCapabilities?.() || {};
  const rect = e.currentTarget.getBoundingClientRect();
  const x = (e.clientX - rect.left) / rect.width;
  const y = (e.clientY - rect.top)  / rect.height;
  const adv = {};
  if (caps.pointOfInterest) adv.pointOfInterest = { x, y };
  if (Array.isArray(caps.focusMode)) {
    if (caps.focusMode.includes('single-shot')) adv.focusMode = 'single-shot';
    else if (caps.focusMode.includes('manual')) adv.focusMode = 'manual';
  }
  if (!Object.keys(adv).length) return; // no programmatic focus on this device; the tap ring still shows
  try {
    await track.applyConstraints({ advanced: [adv] });
    if (Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous'))
      setTimeout(() => track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {}), 3000);
  } catch {}
}

function showFocusRing(x, y) {
  const ring = document.getElementById('focus-ring');
  ring.style.left = x + 'px'; ring.style.top = y + 'px';
  ring.className = 'focusing';
  setTimeout(() => { ring.className = 'focused'; }, 300);
  setTimeout(() => { ring.className = ''; }, 1200);
}

// ── Video mode toggle ─────────────────────────────────────────────────────────
document.getElementById('btn-mode-photo').addEventListener('click', () => {
  if (isRecording) stopVideoRecording();
  videoMode = false;
  document.getElementById('btn-mode-photo').classList.add('active');
  document.getElementById('btn-mode-video').classList.remove('active');
  updateShutterAppearance();
});

document.getElementById('btn-mode-video').addEventListener('click', () => {
  videoMode = true;
  document.getElementById('btn-mode-video').classList.add('active');
  document.getElementById('btn-mode-photo').classList.remove('active');
  updateShutterAppearance();
});

function updateShutterAppearance() {
  const btn = document.getElementById('btn-shutter');
  btn.classList.remove('recording');
  btn.title = videoMode ? (isRecording ? 'Stop Recording' : 'Start Recording') : 'Take Photo';
}

// ── Shutter ───────────────────────────────────────────────────────────────────
document.getElementById('btn-shutter').addEventListener('click', () => {
  if (videoMode) {
    isRecording ? stopVideoRecording() : startVideoRecording();
  } else {
    capturePhoto();
  }
});

// ── Photo capture ─────────────────────────────────────────────────────────────
async function capturePhoto() {
  if (photosRemaining <= 0) return;

  const video = document.getElementById('video');
  const flash = document.getElementById('flash');
  // Screen-flash fill: hold the screen white briefly so the camera exposes to the lit subject.
  if (screenFlash) { flash.classList.add('fill'); await new Promise(r => setTimeout(r, 320)); }
  flash.classList.add('active');
  setTimeout(() => flash.classList.remove('active'), 120);

  const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
  const { sx, sy, sw, sh } = cropRect(vw, vh, aspectValue(currentAspect));
  const canvas = document.createElement('canvas');
  canvas.width  = Math.round(sw);
  canvas.height = Math.round(sh);
  const ctx = canvas.getContext('2d');
  if (facingMode === 'user') { ctx.translate(canvas.width, 0); ctx.scale(-1, 1); }
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  if (screenFlash) flash.classList.remove('fill');

  const galleryBtn = document.getElementById('btn-gallery');
  galleryBtn.innerHTML = `<img src="${canvas.toDataURL('image/jpeg', 0.25)}" alt="gallery" />
    <div class="queue-badge hidden" id="queue-badge">0</div>`;

  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.88));
  if (blob) queueUpload(blob, 'image/jpeg', 'photo');
}

document.getElementById('file-upload-input').addEventListener('change', async function () {
  if (!this.files[0]) return;
  const file = this.files[0];
  queueUpload(file, file.type, file.type.startsWith('video/') ? 'video' : 'photo');
  this.value = '';
});

// ── Video recording ───────────────────────────────────────────────────────────
function startVideoRecording() {
  if (!stream || photosRemaining <= 0) return;

  const mimeType = ['video/webm;codecs=vp8,opus','video/webm','video/mp4','']
    .find(m => m === '' || MediaRecorder.isTypeSupported(m));
  recordedChunks = [];
  mediaRecorder  = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'video/webm' });
    const isMP4 = blob.type.includes('mp4');
    queueUpload(blob, blob.type, 'video', isMP4 ? 'mp4' : 'webm');
  };
  mediaRecorder.start();
  isRecording = true;
  recordingSecs = 0;
  document.getElementById('btn-shutter').classList.add('recording');
  document.getElementById('rec-timer').classList.remove('hidden');
  if (videoMaxSecs > 0) {
    document.getElementById('rec-limit').textContent = ` / ${fmtTime(videoMaxSecs)}`;
  }

  recordingTimer = setInterval(() => {
    recordingSecs++;
    document.getElementById('rec-time').textContent = fmtTime(recordingSecs);
    if (videoMaxSecs > 0 && recordingSecs >= videoMaxSecs) stopVideoRecording();
  }, 1000);
}

function stopVideoRecording() {
  if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
  if (recordingTimer) { clearInterval(recordingTimer); recordingTimer = null; }
  isRecording = false;
  document.getElementById('btn-shutter').classList.remove('recording');
  document.getElementById('rec-timer').classList.add('hidden');
}

function fmtTime(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2,'0')}`;
}

// ── Upload queue ──────────────────────────────────────────────────────────────
function queueUpload(blob, mimeType, mediaType = 'photo', ext = null) {
  if (!ext) ext = mimeType.startsWith('video/') ? (mimeType.includes('mp4') ? 'mp4' : 'webm') : 'jpg';
  const id = Date.now() + Math.random();
  const previewUrl = URL.createObjectURL(blob);
  uploadQueue.push({ id, blob, mimeType, mediaType, ext, previewUrl, status: 'pending', error: null });
  photosRemaining = Math.max(0, photosRemaining - 1);
  updateCounter();
  renderQueueBadge();
  processQueue();
}

async function processQueue() {
  if (isUploading) return;
  const item = uploadQueue.find(q => q.status === 'pending');
  if (!item) return;

  isUploading = true;
  item.status = 'uploading';
  renderQueueDrawerBody();

  const form = new FormData();
  form.append('photo', item.blob, `media.${item.ext}`);
  form.append('sessionToken', sessionToken);

  try {
    const res  = await fetch('/api/photos', { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    item.status = 'done';
    photosRemaining = data.photosRemaining;
  } catch (err) {
    item.status = 'error';
    item.error  = err.message || 'Upload failed';
    photosRemaining = Math.min(photosRemaining + 1, eventData?.maxPhotos || 99);
  }

  isUploading = false;
  updateCounter();
  renderQueueBadge();
  renderQueueDrawerBody();
  processQueue();
}

function renderQueueBadge() {
  const pending = uploadQueue.filter(q => q.status !== 'done').length;
  const badge = document.getElementById('queue-badge');
  if (!badge) return;
  if (pending > 0) { badge.textContent = pending; badge.classList.remove('hidden'); }
  else badge.classList.add('hidden');
}

document.getElementById('btn-gallery').addEventListener('click', () => {
  if (queueVisible) { closeQueueDrawer(); return; }
  if (uploadQueue.length > 0) { openQueueDrawer(); return; }
  openGallery();
});

function openQueueDrawer() {
  queueVisible = true;
  renderQueueDrawerBody();
  document.getElementById('queue-drawer').classList.add('open');
}

function closeQueueDrawer() {
  queueVisible = false;
  document.getElementById('queue-drawer').classList.remove('open');
}

document.getElementById('queue-drawer-close').addEventListener('click', () => {
  closeQueueDrawer();
  if (uploadQueue.every(q => q.status === 'done')) openGallery();
});

document.getElementById('queue-drawer-handle').addEventListener('click', closeQueueDrawer);

function renderQueueDrawerBody() {
  const body = document.getElementById('queue-drawer-body');
  if (!body) return;
  if (!uploadQueue.length) { body.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:16px">Queue is empty</p>'; return; }

  body.innerHTML = uploadQueue.map(item => {
    const statusLabel = { pending:'Queued', uploading:'Uploading…', done:'Done ✓', error:`Failed: ${escHtml(item.error||'')}` }[item.status];
    const thumb = item.mediaType === 'video'
      ? `<div class="queue-thumb">🎥</div>`
      : `<div class="queue-thumb"><img src="${item.previewUrl}" /></div>`;
    const retry = item.status === 'error'
      ? `<button onclick="retryItem('${item.id}')" class="btn btn-secondary btn-sm" style="margin-top:4px;font-size:0.7rem;padding:4px 8px">Retry</button>`
      : '';
    const progress = item.status === 'uploading'
      ? `<div class="queue-progress"><div class="queue-progress-bar" style="width:60%;animation:pulse 1s ease-in-out infinite"></div></div>`
      : '';
    return `<div class="queue-item">
      ${thumb}
      <div class="queue-item-info">
        <div class="queue-item-name">${item.mediaType === 'video' ? 'Video clip' : 'Photo'} #${uploadQueue.indexOf(item)+1}</div>
        <div class="queue-item-status ${item.status}">${statusLabel}</div>
        ${progress}${retry}
      </div>
    </div>`;
  }).join('');
}

function retryItem(id) {
  const item = uploadQueue.find(q => q.id == id);
  if (!item) return;
  item.status = 'pending'; item.error = null;
  photosRemaining = Math.max(0, photosRemaining - 1);
  updateCounter(); renderQueueBadge(); renderQueueDrawerBody();
  processQueue();
}

// ── Gallery ───────────────────────────────────────────────────────────────────
document.getElementById('btn-back-camera').addEventListener('click', async () => {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  galleryPage.style.display = 'none';
  cameraPage.classList.remove('hidden');
  if (!stream && !eventData?.isExpired && !eventData?.isLocked) { await startCamera(); initTouchFocus(); }
  updateCounter();
});

async function openGallery() {
  stopCamera();
  cameraPage.classList.add('hidden');
  galleryPage.style.display = 'block';
  await loadGallery();
}

async function loadGallery() {
  const content = document.getElementById('gallery-content');
  content.innerHTML = '<div style="text-align:center;padding:48px;color:var(--text-muted)">Loading…</div>';

  const qs  = showHighlightsOnly ? '?highlightsOnly=true' : '';
  const res = await fetch(`/api/photos/${eventData.joinCode}${qs}`, { headers: { 'X-Session-Token': sessionToken } });
  const data = await res.json();
  if (!res.ok) { content.innerHTML = `<div style="text-align:center;padding:48px;color:var(--danger)">${escHtml(data.error)}</div>`; return; }

  allowDownloads    = data.allowDownloads !== false;
  myParticipantId   = data.myParticipantId || null;
  const count       = data.revealed ? data.photos.length : data.photoCount;

  document.getElementById('gallery-meta').textContent =
    `${count} photo${count !== 1 ? 's' : ''}${showHighlightsOnly ? ' · highlights' : ''}`;

  // Highlights toggle
  const hlToggle = document.getElementById('btn-highlights-toggle');
  if (data.hasHighlights && data.revealed) {
    hlToggle.classList.remove('hidden');
    hlToggle.textContent = showHighlightsOnly ? '📷 All' : '⭐ Highlights';
    hlToggle.onclick = () => { showHighlightsOnly = !showHighlightsOnly; loadGallery(); };
  } else {
    hlToggle.classList.add('hidden');
  }

  // Download all / mine buttons
  const dlAll  = document.getElementById('btn-download-all');
  const dlMine = document.getElementById('btn-download-mine');
  if (allowDownloads && data.revealed) {
    dlAll.classList.remove('hidden');
    dlAll.onclick = () => downloadAll(currentPhotos);
    dlMine.classList.remove('hidden');
    dlMine.onclick = () => downloadAll(currentPhotos.filter(p => p.isOwn));
  } else {
    dlAll.classList.add('hidden'); dlMine.classList.add('hidden');
  }

  // Email my photos button
  const emailBtn = document.getElementById('btn-email-photos');
  // shown if server supports email (we'll check via config, but simplify: always show)
  emailBtn.classList.remove('hidden');

  if (!data.revealed) { renderRevealWall(data); return; }

  currentPhotos = data.photos;
  renderPhotoGrid(data.photos);
}

function renderRevealWall(data) {
  if (countdownTimer) { clearInterval(countdownTimer); countdownTimer = null; }
  const modeText = {
    at_end:  'Photos are hidden until the event ends',
    manual:  'The organiser will reveal photos when ready',
    instant: 'Photos are visible — refresh to see them',
  }[data.revealMode] || '';
  document.getElementById('gallery-content').innerHTML = `
    <div class="reveal-wall">
      <span class="lock-icon">🔒</span>
      <h2>${data.photoCount} photo${data.photoCount !== 1 ? 's' : ''} waiting</h2>
      <p>${modeText}</p>
      ${data.revealMode === 'at_end' && data.revealAt ? '<div class="countdown" id="countdown"></div>' : ''}
      <button class="btn btn-secondary" onclick="loadGallery()" style="width:auto;margin:0 auto">↻ Refresh</button>
    </div>`;
  if (data.revealMode === 'at_end' && data.revealAt) startCountdown(data.revealAt);
}

function startCountdown(revealAt) {
  function tick() {
    const el   = document.getElementById('countdown');
    if (!el) { clearInterval(countdownTimer); return; }
    const diff = Math.max(0, revealAt - Date.now());
    if (diff === 0) { clearInterval(countdownTimer); loadGallery(); return; }
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    const s = Math.floor((diff % 60_000) / 1000);
    el.textContent = [h,m,s].map(n => String(n).padStart(2,'0')).join(':');
  }
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function renderPhotoGrid(photos) {
  const content = document.getElementById('gallery-content');
  if (!photos.length) {
    content.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted)">No photos yet — be the first to shoot! 📷</div>';
    return;
  }
  const grid = document.createElement('div');
  grid.className = 'gallery-grid';
  photos.forEach((photo, i) => {
    const item = document.createElement('div');
    item.className = 'photo-item';
    const time = new Date(photo.takenAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    const isOwn = photo.isOwn;
    const dlBtn = allowDownloads
      ? `<button class="photo-download-btn" title="Download">⬇</button>`
      : '';

    if (photo.mediaType === 'video') {
      item.innerHTML = `
        <video src="${photo.url}" preload="metadata" muted playsinline></video>
        <div class="play-overlay">▶</div>
        <div class="photo-author">${escHtml(photo.participantName)} · ${time}</div>
        ${isOwn ? '<div class="photo-own-badge">Mine</div>' : ''}
        ${photo.isHighlighted ? '<div class="highlight-badge">⭐</div>' : ''}
        ${dlBtn}
      `;
    } else {
      item.innerHTML = `
        <img src="${photo.url}" alt="" loading="lazy" />
        <div class="photo-author">${escHtml(photo.participantName)} · ${time}</div>
        ${isOwn ? '<div class="photo-own-badge">Mine</div>' : ''}
        ${photo.isHighlighted ? '<div class="highlight-badge">⭐</div>' : ''}
        ${dlBtn}
      `;
    }

    if (allowDownloads) {
      item.querySelector('.photo-download-btn')?.addEventListener('click', async e => {
        e.stopPropagation();
        const ext = photo.mediaType === 'video' ? 'mp4' : 'jpg';
        await downloadOne(photo.url, `${photo.participantName.replace(/\s+/g,'_')}_${i+1}.${ext}`);
      });
    }

    item.addEventListener('click', () => openLightbox(photos, i));
    grid.appendChild(item);
  });
  content.innerHTML = '';
  content.appendChild(grid);
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(photos, index) {
  lbPhotos = photos; lbIndex = index;
  renderLightboxFrame();
  document.getElementById('lightbox').classList.add('open');
}

function renderLightboxFrame() {
  const p    = lbPhotos[lbIndex];
  const img  = document.getElementById('lightbox-img');
  const vid  = document.getElementById('lightbox-video');
  const dlBtn = document.getElementById('lightbox-download');
  if (p.mediaType === 'video') {
    img.style.display = 'none';
    vid.style.display = 'block'; vid.src = p.url;
  } else {
    vid.style.display = 'none'; vid.src = '';
    img.style.display = 'block'; img.src = p.url;
  }
  document.getElementById('lightbox-caption').textContent =
    `${p.participantName} · ${new Date(p.takenAt).toLocaleString()} · ${lbIndex+1}/${lbPhotos.length}`;
  if (allowDownloads) {
    dlBtn.classList.remove('hidden');
    const ext = p.mediaType === 'video' ? 'mp4' : 'jpg';
    dlBtn.onclick = () => downloadOne(p.url, `${p.participantName.replace(/\s+/g,'_')}_${lbIndex+1}.${ext}`);
  } else {
    dlBtn.classList.add('hidden');
  }
}

document.getElementById('lightbox').addEventListener('click', e => {
  const lb = document.getElementById('lightbox');
  if (e.target.id === 'lightbox-close' || e.target.id === 'lightbox') { lb.classList.remove('open'); return; }
  if (e.target.tagName === 'VIDEO' || e.target.tagName === 'BUTTON') return;
  const half = window.innerWidth / 2;
  if (e.clientX > half && lbIndex < lbPhotos.length - 1) lbIndex++;
  else if (e.clientX <= half && lbIndex > 0) lbIndex--;
  renderLightboxFrame();
});

document.addEventListener('keydown', e => {
  if (!document.getElementById('lightbox').classList.contains('open')) return;
  if (e.key === 'ArrowRight' && lbIndex < lbPhotos.length - 1) { lbIndex++; renderLightboxFrame(); }
  if (e.key === 'ArrowLeft'  && lbIndex > 0)                   { lbIndex--; renderLightboxFrame(); }
  if (e.key === 'Escape') document.getElementById('lightbox').classList.remove('open');
});

// ── Download helpers ──────────────────────────────────────────────────────────
async function downloadAll(photos) {
  if (!photos.length) { showToast('No photos to download', true); return; }
  showToast(`Downloading ${photos.length} files…`);
  for (const [i, p] of photos.entries()) {
    const ext = p.mediaType === 'video' ? 'mp4' : 'jpg';
    await downloadOne(p.url, `snapdini_${p.participantName.replace(/\s+/g,'_')}_${i+1}.${ext}`);
    await new Promise(r => setTimeout(r, 350));
  }
}

// ── Email my photos ───────────────────────────────────────────────────────────
document.getElementById('btn-email-photos').addEventListener('click', () => {
  document.getElementById('email-modal').classList.remove('hidden');
  // Pre-fill from localStorage if we know it
  const emailInput = document.getElementById('email-input');
  emailInput.value = '';
  emailInput.focus();
});

document.getElementById('email-cancel').addEventListener('click', () => {
  document.getElementById('email-modal').classList.add('hidden');
});

document.getElementById('email-send').addEventListener('click', async () => {
  const addr = document.getElementById('email-input').value.trim();
  if (!addr) { showToast('Enter an email address', true); return; }

  const btn = document.getElementById('email-send');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>';

  try {
    const res = await fetch('/api/participants/email-my-photos', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionToken, emailOverride: addr }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('Email sent! Check your inbox.');
    document.getElementById('email-modal').classList.add('hidden');
  } catch (err) {
    showToast(err.message || 'Failed to send email', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send Link';
  }
});

// ── Counter + shutter ─────────────────────────────────────────────────────────
function updateCounter() {
  const counter = document.getElementById('shot-counter');
  document.getElementById('shots-num').textContent = photosRemaining;
  counter.classList.toggle('low', photosRemaining > 0 && photosRemaining <= 5);
  counter.classList.toggle('out', photosRemaining <= 0);
  setShutterDisabled(photosRemaining <= 0 && !isRecording);
}

function setShutterDisabled(disabled) {
  document.getElementById('btn-shutter').disabled = disabled;
}

// ── Event ended ───────────────────────────────────────────────────────────────
function showEventEnded() {
  const reason = eventData.isLocked ? 'locked by the organiser' : 'ended';
  document.getElementById('viewfinder').innerHTML = `
    <div class="ended-screen">
      <span class="icon">🎞️</span>
      <h2>Event ${reason}</h2>
      <p>No more shots can be taken. You can still view the gallery.</p>
      <button class="btn btn-primary" onclick="openGallery()" style="width:auto;margin:0 auto">View Gallery →</button>
    </div>`;
  setShutterDisabled(true);
  document.getElementById('btn-flip').disabled = true;
}

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(theme) {
  if (!theme) return;
  const r = document.documentElement;
  if (theme.bg)         r.style.setProperty('--bg', theme.bg);
  if (theme.surface)    r.style.setProperty('--surface', theme.surface);
  if (theme.surface2)   r.style.setProperty('--surface-2', theme.surface2);
  if (theme.border)     r.style.setProperty('--border', theme.border);
  if (theme.text)       r.style.setProperty('--text', theme.text);
  if (theme.textMuted)  r.style.setProperty('--text-muted', theme.textMuted);
  if (theme.accent)     r.style.setProperty('--accent', theme.accent);
  if (theme.accentDark) r.style.setProperty('--accent-dark', theme.accentDark);
  if (theme.mode) r.classList.toggle('light',
    theme.mode === 'light' ? true : theme.mode === 'dark' ? false : matchMedia('(prefers-color-scheme:light)').matches);
  if (theme.font) r.style.setProperty('--font', theme.font);
  if (theme.customCss) { const s = document.createElement('style'); s.textContent = theme.customCss; document.head.appendChild(s); }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showFatalError(msg) {
  document.body.innerHTML = `
    <div class="page" style="text-align:center;padding-top:80px">
      <span style="font-size:56px">😕</span>
      <h2 style="margin:16px 0 8px">${msg}</h2>
      <p style="color:var(--text-muted);margin-bottom:24px">Check the event code and try again</p>
      <a href="/" class="btn btn-secondary" style="width:auto;margin:0 auto">← Go Home</a>
    </div>`;
}

// Pulse animation for upload progress bar
const pulseStyle = document.createElement('style');
pulseStyle.textContent = `@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }`;
document.head.appendChild(pulseStyle);

init();
