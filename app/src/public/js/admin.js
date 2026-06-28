// ── State ─────────────────────────────────────────────────────────────────────
const pathParts    = window.location.pathname.split('/');
const joinCode     = pathParts[2];
const urlParams    = new URLSearchParams(window.location.search);
// Organizer code is read from the URL hash fragment (never sent to the server / logs),
// falling back to the legacy ?code= query and then localStorage.
let organizerCode  = decodeURIComponent((location.hash || '').slice(1)) || urlParams.get('code') || localStorage.getItem(`admin_${joinCode}`) || '';
let eventData      = null;
let allPhotos      = [];
let selectionMode  = false;
let selectedIds    = new Set();
let lbPhotos = [], lbIndex = 0;
let themeState = {};
let headerImageUrl = null;
let pendingHeaderBlob = null;
let pendingPhotos = [];   // photos awaiting moderation

const THEME_PRESETS = {
  dark:     { bg:'#0f0f0f', surface:'#1a1a1a', surface2:'#222', border:'#2a2a2a', text:'#f5f5f5', textMuted:'#888', accent:'#a8ff78', accentDark:'#72d52d' },
  light:    { bg:'#f5f5f0', surface:'#ffffff', surface2:'#f0f0ea', border:'#ddd', text:'#1a1a1a', textMuted:'#777', accent:'#2563eb', accentDark:'#1d4ed8' },
  warm:     { bg:'#1a1209', surface:'#231a0e', surface2:'#2c2010', border:'#3d2e18', text:'#f5e8c8', textMuted:'#9c8060', accent:'#e8994a', accentDark:'#c47830' },
  ocean:    { bg:'#050d1a', surface:'#0a1628', surface2:'#0e1e36', border:'#162944', text:'#d0e8ff', textMuted:'#6698bb', accent:'#38bdf8', accentDark:'#0ea5e9' },
  midnight: { bg:'#0a0a14', surface:'#111128', surface2:'#16163a', border:'#222248', text:'#e8e8ff', textMuted:'#6668aa', accent:'#818cf8', accentDark:'#6366f1' },
  forest:   { bg:'#0a130a', surface:'#111e11', surface2:'#162416', border:'#1e3020', text:'#d8f0d8', textMuted:'#5a8060', accent:'#4ade80', accentDark:'#22c55e' },
};

// ── Auth wall ─────────────────────────────────────────────────────────────────
if (organizerCode) {
  document.getElementById('org-code-input').value = organizerCode;
  bootstrap();
} else {
  document.getElementById('auth-wall').style.display = 'flex';
}

document.getElementById('auth-btn').addEventListener('click', () => {
  organizerCode = document.getElementById('org-code-input').value.trim();
  if (!organizerCode) { showToast('Enter your organizer code', true); return; }
  bootstrap();
});

// Build the settings dropdowns from the server config (single source — never hard-coded).
async function buildOptionSelects() {
  const cfg = await getConfig();
  const o = cfg.options || {};
  fillSelect(document.getElementById('adm-set-duration'), o.durations);
  fillSelect(document.getElementById('adm-set-reveal'), (o.revealModes || []).map(m => ({ value: m.value, label: m.label })));
  fillSelect(document.getElementById('adm-set-delay'), o.revealDelays);
  fillSelect(document.getElementById('adm-theme-mode'), o.themeModes);
  fillSelect(document.getElementById('adm-theme-font'), (o.fonts || []).map(f => ({ value: f.stack, label: f.label })));
  // Timezone datalist (searchable, named IANA zones only).
  let zones = []; try { zones = Intl.supportedValuesOf('timeZone'); } catch {}
  if (!zones.length) zones = ['UTC'];
  document.getElementById('adm-tz-datalist').innerHTML = zones.map(z => `<option value="${z}"></option>`).join('');
  document.getElementById('adm-aspect-options').innerHTML = (o.aspectRatios || []).map(a =>
    `<label class="aspect-opt"><input type="checkbox" value="${escHtml(a.value)}" /> ${escHtml(a.label)}${a.pro ? ' <span class="pro-tag">Pro</span>' : ''}</label>`).join('');
}

async function bootstrap() {
  document.getElementById('auth-wall').style.display = 'none';
  try {
    await buildOptionSelects();   // before loadEvent → options exist when populateSettings sets values
    await loadEvent();
    document.getElementById('admin-dashboard').classList.remove('hidden');
  } catch (err) {
    showToast(err.message || 'Login failed', true);
    organizerCode = '';
    document.getElementById('auth-wall').style.display = 'flex';
  }
}

// ── Load event ────────────────────────────────────────────────────────────────
async function loadEvent() {
  const res  = await fetch(`/api/events/${joinCode}/admin`, { headers: { 'X-Organizer-Code': organizerCode } });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Access denied');
  eventData = data;
  localStorage.setItem(`admin_${joinCode}`, organizerCode);
  renderEvent();
  await loadPhotos();
}

function renderEvent() {
  const ev = eventData;
  document.title = `${ev.name} — Admin — Snapdini`;
  document.getElementById('adm-event-name').textContent = ev.name;

  const now      = Date.now();
  const expired  = ev.expiresAt && now > ev.expiresAt;
  const statusEl = document.getElementById('adm-status-badge');
  statusEl.innerHTML = ev.isLocked  ? '<span class="badge badge-warning">🔒 Locked</span>'
                     : expired      ? '<span class="badge badge-error">Ended</span>'
                     : ev.isUpcoming? '<span class="badge badge-info">⏰ Upcoming</span>'
                     : '<span class="badge badge-success">● Live</span>';

  if (ev.expiresAt) {
    document.getElementById('adm-expires').textContent =
      (expired ? 'Ended ' : 'Ends ') + new Date(ev.expiresAt).toLocaleString();
  }
  if (ev.startsAt && ev.isUpcoming) {
    const el = document.getElementById('adm-starts');
    el.textContent = `⏰ Opens ${new Date(ev.startsAt).toLocaleString()}`;
    el.style.display = 'block';
  }

  document.getElementById('adm-participant-count').textContent = ev.participantCount || 0;
  document.getElementById('adm-photo-count').textContent       = ev.photoCount || 0;
  document.getElementById('adm-max-photos').textContent        = ev.maxPhotos;
  document.getElementById('adm-shots-left').textContent        =
    Math.max(0, ev.maxPhotos * (ev.participantCount || 0) - (ev.photoCount || 0));

  const joinUrl = `${location.origin}/join/${ev.slug || joinCode}`;
  document.getElementById('adm-join-link').href = joinUrl;
  document.getElementById('adm-join-url').textContent  = joinUrl;
  document.getElementById('adm-join-code').textContent = ev.slug || joinCode;

  fetch(`/api/events/${joinCode}/qr`).then(r => r.json()).then(d => {
    document.getElementById('adm-qr').src = d.qrCode;
  }).catch(() => {});

  // Reveal
  const revBtn  = document.getElementById('adm-reveal-btn');
  const revText = document.getElementById('reveal-status-text');
  if (ev.isRevealed) {
    revBtn.textContent  = 'Hide';
    revText.textContent = 'Photos are visible to participants';
  } else {
    revBtn.textContent  = 'Reveal Now';
    revText.textContent = ev.revealMode === 'at_end' ? 'Auto-reveals when event ends'
                        : ev.revealMode === 'manual' ? 'Manual — reveal when ready'
                        : 'Instant — photos visible as taken';
  }

  // Allow downloads
  document.getElementById('adm-allow-downloads').checked = ev.allowDownloads !== false;

  // Lock
  document.getElementById('adm-lock-btn').textContent = ev.isLocked ? 'Unlock' : 'Lock';

  // Email gallery section
  if (ev.emailEnabled) {
    document.getElementById('adm-email-gallery-section').classList.remove('hidden');
  }

  // Theme editor
  themeState     = ev.theme || {};
  headerImageUrl = themeState.headerImage || null;
  renderThemePresets();
  syncColorInputsFromTheme();
  document.getElementById('adm-custom-css').value = themeState.customCss || '';
  document.getElementById('adm-theme-mode').value = themeState.mode || 'system';
  if (themeState.font) document.getElementById('adm-theme-font').value = themeState.font;
  if (headerImageUrl) showHeaderImagePreview(headerImageUrl);

  // Participants
  renderParticipants(ev.participants || []);

  // Settings form
  populateSettings(ev);
}

// ── Event settings form ─────────────────────────────────────────────────────
// Populate the timezone dropdown once (defaults filled from the event in populateSettings).
function syncRevealFields(mode) {
  document.getElementById('adm-set-delay-field').classList.toggle('hidden', mode !== 'at_end');
  document.getElementById('adm-set-moderation-row').classList.toggle('hidden', mode === 'instant');
}

function populateSettings(ev) {
  const pad = n => String(n).padStart(2, '0');
  const d = new Date(ev.startsAt);
  document.getElementById('adm-set-name').value     = ev.name || '';
  document.getElementById('adm-set-date').value     = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  document.getElementById('adm-set-time').value     = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  document.getElementById('adm-set-duration').value = Math.round(((ev.expiresAt - ev.startsAt) / 3600000) * 10) / 10;
  document.getElementById('adm-set-reveal').value   = ev.revealMode || 'instant';
  document.getElementById('adm-set-delay').value    = ev.revealDelayHours || 0;
  document.getElementById('adm-set-moderation').checked = !!ev.moderationEnabled;
  document.getElementById('adm-set-timezone').value = ev.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const allowed = ev.aspectRatios || ['1:1'];
  document.querySelectorAll('#adm-aspect-options input').forEach(i => { i.checked = allowed.includes(i.value); });
  syncRevealFields(ev.revealMode || 'instant');
}

document.getElementById('adm-set-reveal').addEventListener('change', function () {
  syncRevealFields(this.value);
});

document.getElementById('adm-set-save').addEventListener('click', async () => {
  const btn = document.getElementById('adm-set-save');
  btn.disabled = true; btn.textContent = 'Saving…';
  try {
    const res = await fetch(`/api/events/${joinCode}/settings`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Organizer-Code': organizerCode },
      body: JSON.stringify({
        name:             document.getElementById('adm-set-name').value,
        // Epoch computed in the organizer's timezone (server stores it directly).
        startsAt:         (() => { const d = document.getElementById('adm-set-date').value, t = document.getElementById('adm-set-time').value;
                                    return d ? new Date(`${d}T${t || '00:00'}`).getTime() : undefined; })(),
        startDate:        document.getElementById('adm-set-date').value,
        startTime:        document.getElementById('adm-set-time').value,
        durationHours:    parseFloat(document.getElementById('adm-set-duration').value),
        revealMode:       document.getElementById('adm-set-reveal').value,
        revealDelayHours: parseInt(document.getElementById('adm-set-delay').value, 10) || 0,
        moderationEnabled: document.getElementById('adm-set-moderation').checked,
        timezone:         document.getElementById('adm-set-timezone').value,
        aspectRatios:     [...document.querySelectorAll('#adm-aspect-options input:checked')].map(i => i.value),
      }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    showToast('Settings saved');
    await loadEvent();
  } catch (err) { showToast(err.message || 'Save failed', true); }
  finally { btn.disabled = false; btn.textContent = 'Save Settings'; }
});

// ── Participants ──────────────────────────────────────────────────────────────
function renderParticipants(participants) {
  const el = document.getElementById('adm-participants');
  if (!participants.length) {
    el.innerHTML = '<div class="text-muted" style="font-size:0.85rem">No participants yet</div>';
    return;
  }
  el.innerHTML = participants.map(p => {
    const joined = new Date(p.joinedAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    return `<div class="participant-row">
      <div class="participant-avatar">${esc(p.name[0].toUpperCase())}</div>
      <div class="participant-info">
        <div class="participant-name">${esc(p.name)}</div>
        <div class="participant-email">${p.email ? esc(p.email) : '<span style="color:var(--text-muted)">no email</span>'}</div>
        <div class="participant-meta">${p.photosTaken || 0} photos · joined ${joined}</div>
      </div>
    </div>`;
  }).join('');
}

// ── Photos ────────────────────────────────────────────────────────────────────
async function loadPhotos() {
  const res  = await fetch(`/api/photos/${joinCode}`, { headers: { 'X-Organizer-Code': organizerCode } });
  const data = await res.json();
  if (!res.ok) { showToast('Could not load photos', true); return; }
  const all     = data.photos || [];
  pendingPhotos = all.filter(p => p.status === 'pending');   // moderation queue
  allPhotos     = all.filter(p => p.status !== 'pending');   // approved → main grid + lightbox
  selectedIds.clear();
  renderPhotoGrid();
  renderPendingGrid();
}

// ── Moderation queue ──────────────────────────────────────────────────────────
function renderPendingGrid() {
  const card = document.getElementById('adm-moderation-card');
  const grid = document.getElementById('adm-pending-grid');
  document.getElementById('adm-pending-num').textContent = pendingPhotos.length;
  card.classList.toggle('hidden', pendingPhotos.length === 0);
  grid.innerHTML = '';
  pendingPhotos.forEach(photo => {
    const item = document.createElement('div');
    item.className = 'admin-photo-item';
    const time  = new Date(photo.takenAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    const media = photo.mediaType === 'video'
      ? `<video src="${photo.url}" preload="metadata" muted playsinline></video><div class="play-overlay">▶</div>`
      : `<img src="${photo.url}" alt="" loading="lazy" />`;
    item.innerHTML = `${media}
      <div class="photo-author">${esc(photo.participantName)} · ${time}</div>
      <div style="display:flex;gap:6px;padding:6px">
        <button class="btn btn-primary btn-sm mod-approve" data-id="${photo.id}" style="flex:1">✓ Approve</button>
        <button class="btn btn-danger btn-sm mod-reject" data-id="${photo.id}" style="flex:1">✕ Reject</button>
      </div>`;
    grid.appendChild(item);
  });
  grid.querySelectorAll('.mod-approve').forEach(b => b.addEventListener('click', () => moderate('approve', [b.dataset.id])));
  grid.querySelectorAll('.mod-reject').forEach(b => b.addEventListener('click', () => moderate('reject', [b.dataset.id])));
}

async function moderate(action, ids) {
  try {
    const res = await fetch(`/api/events/${joinCode}/moderate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Organizer-Code': organizerCode },
      body: JSON.stringify({ photoIds: ids, action }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    showToast(action === 'approve' ? 'Approved ✓' : 'Rejected');
    await loadEvent();
  } catch (err) { showToast(err.message || 'Failed', true); }
}

function renderPhotoGrid() {
  const grid = document.getElementById('adm-photos');
  if (!allPhotos.length) {
    grid.innerHTML = '<div class="text-muted" style="font-size:0.85rem;grid-column:1/-1">No photos yet</div>';
    return;
  }
  grid.innerHTML = '';
  allPhotos.forEach((photo, i) => {
    const item = document.createElement('div');
    item.className = 'admin-photo-item' +
      (photo.isHighlighted ? ' highlighted' : '') +
      (selectedIds.has(photo.id) ? ' selected' : '');
    item.dataset.id = photo.id;
    const time = new Date(photo.takenAt).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
    const checkHtml = selectionMode ? `<div class="select-check">${selectedIds.has(photo.id) ? '✓' : ''}</div>` : '';

    if (photo.mediaType === 'video') {
      item.innerHTML = `
        <video src="${photo.url}" preload="metadata" muted playsinline></video>
        <div class="play-overlay">▶</div>
        <div class="photo-author">${esc(photo.participantName)} · ${time}</div>
        ${photo.isHighlighted ? '<div class="highlight-badge">⭐</div>' : ''}
        ${checkHtml}
      `;
    } else {
      item.innerHTML = `
        <img src="${photo.url}" alt="" loading="lazy" />
        <div class="photo-author">${esc(photo.participantName)} · ${time}</div>
        ${photo.isHighlighted ? '<div class="highlight-badge">⭐</div>' : ''}
        ${checkHtml}
      `;
    }

    item.addEventListener('click', () => {
      if (selectionMode) {
        if (selectedIds.has(photo.id)) selectedIds.delete(photo.id);
        else selectedIds.add(photo.id);
        updateSelectionActions();
        renderPhotoGrid();
      } else {
        lbPhotos = allPhotos; lbIndex = i; openLightbox();
      }
    });
    grid.appendChild(item);
  });
}

// ── Invite controls ───────────────────────────────────────────────────────────
document.getElementById('adm-copy-link').addEventListener('click', () => {
  const url = `${location.origin}/join/${eventData?.slug || joinCode}`;
  navigator.clipboard.writeText(url).then(() => showToast('Join link copied!'));
});

document.getElementById('adm-download-qr').addEventListener('click', () => {
  const img = document.getElementById('adm-qr');
  if (!img.src) return;
  Object.assign(document.createElement('a'), { href: img.src, download: `snapdini-${joinCode}.png` }).click();
});

document.getElementById('adm-copy-gallery').addEventListener('click', () => {
  const url = `${location.origin}/gallery/${eventData?.slug || joinCode}`;
  navigator.clipboard.writeText(url).then(() => showToast('Gallery link copied!'));
});

// Email gallery
document.getElementById('adm-email-send').addEventListener('click', async () => {
  const input = document.getElementById('adm-email-input').value.trim();
  if (!input) { showToast('Enter at least one email address', true); return; }
  const addresses = input.split(',').map(s => s.trim()).filter(Boolean);
  const btn = document.getElementById('adm-email-send');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>';
  try {
    const res = await fetch(`/api/events/${joinCode}/email-gallery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizerCode, emails: addresses }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast(`Sent to ${addresses.length} address${addresses.length !== 1 ? 'es' : ''}!`);
    document.getElementById('adm-email-input').value = '';
  } catch (err) {
    showToast(err.message || 'Send failed', true);
  } finally {
    btn.disabled = false; btn.textContent = 'Send';
  }
});

// ── Event controls ────────────────────────────────────────────────────────────
document.getElementById('adm-reveal-btn').addEventListener('click', async () => {
  const isRevealed = eventData?.isRevealed;
  if (!isRevealed && !confirm('Reveal all photos to participants now?')) return;
  try {
    const res = await fetch(`/api/events/${joinCode}/${isRevealed ? 'unreveal' : 'reveal'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizerCode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast(isRevealed ? 'Photos hidden' : 'Photos revealed! 🎉');
    await loadEvent();
  } catch (err) { showToast(err.message || 'Failed', true); }
});

document.getElementById('adm-allow-downloads').addEventListener('change', async function () {
  try {
    const res = await fetch(`/api/events/${joinCode}/allow-downloads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizerCode, allowDownloads: this.checked }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    showToast(this.checked ? 'Downloads enabled' : 'Downloads disabled');
  } catch (err) { this.checked = !this.checked; showToast(err.message || 'Failed', true); }
});

document.getElementById('adm-lock-btn').addEventListener('click', async () => {
  const locking = !eventData?.isLocked;
  if (locking && !confirm('Lock this event? Participants won\'t be able to take new photos.')) return;
  try {
    const res = await fetch(`/api/events/${joinCode}/lock`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizerCode }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    showToast(locking ? 'Event locked' : 'Event unlocked');
    await loadEvent();
  } catch (err) { showToast(err.message || 'Failed', true); }
});

document.getElementById('adm-delete-btn').addEventListener('click', async () => {
  if (!confirm('Delete this event and ALL photos permanently?\n\nThis cannot be undone.')) return;
  if (!confirm('Last chance — are you absolutely sure?')) return;
  try {
    const res = await fetch(`/api/events/${joinCode}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizerCode }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    localStorage.removeItem(`admin_${joinCode}`);
    showToast('Event deleted');
    setTimeout(() => { window.location.href = '/'; }, 1200);
  } catch (err) { showToast(err.message || 'Failed', true); }
});

// ── Photo selection ───────────────────────────────────────────────────────────
document.getElementById('adm-select-toggle').addEventListener('click', () => {
  selectionMode = !selectionMode;
  selectedIds.clear();
  document.getElementById('adm-select-toggle').textContent = selectionMode ? 'Cancel' : 'Select';
  updateSelectionActions();
  renderPhotoGrid();
});

function updateSelectionActions() {
  const count   = selectedIds.size;
  const show    = selectionMode && count > 0;
  ['adm-selection-actions','adm-download-sel','adm-highlight-sel','adm-unhighlight-sel'].forEach(id => {
    document.getElementById(id).classList.toggle('hidden', !show);
  });
  if (show) document.getElementById('adm-sel-count').textContent = count;
}

document.getElementById('adm-download-sel').addEventListener('click', async () => {
  const photos = allPhotos.filter(p => selectedIds.has(p.id));
  showToast(`Downloading ${photos.length} files…`);
  for (const [i, p] of photos.entries()) {
    const ext = p.mediaType === 'video' ? 'mp4' : 'jpg';
    await downloadOne(p.url, `${p.participantName.replace(/\s+/g,'_')}_${i+1}.${ext}`);
    await new Promise(r => setTimeout(r, 350));
  }
});

document.getElementById('adm-highlight-sel').addEventListener('click', () => bulkHighlight(true));
document.getElementById('adm-unhighlight-sel').addEventListener('click', () => bulkHighlight(false));

async function bulkHighlight(highlight) {
  const ids = [...selectedIds];
  try {
    const res = await fetch(`/api/events/${joinCode}/highlights`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizerCode, photoIds: ids, highlight }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    showToast(highlight ? `${ids.length} highlighted ⭐` : 'Highlights removed');
    selectionMode = false;
    selectedIds.clear();
    document.getElementById('adm-select-toggle').textContent = 'Select';
    updateSelectionActions();
    await loadPhotos();
  } catch (err) { showToast(err.message || 'Failed', true); }
}

// ── Theme editor ──────────────────────────────────────────────────────────────
function renderThemePresets() {
  const container = document.getElementById('adm-theme-presets');
  container.innerHTML = Object.keys(THEME_PRESETS).map(key => {
    const p = THEME_PRESETS[key];
    return `<button class="theme-preset-btn" data-preset="${key}" title="${key}"
      style="background:${p.bg};border:2px solid ${p.accent}">
      <span style="color:${p.text};font-size:0.65rem;font-weight:700;text-transform:capitalize">${key}</span>
    </button>`;
  }).join('');

  container.querySelectorAll('.theme-preset-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const preset = THEME_PRESETS[btn.dataset.preset];
      themeState = { ...themeState, ...preset };
      syncColorInputsFromTheme();
      if (document.getElementById('adm-theme-preview').dataset.previewing === 'true') applyThemeToPage();
    });
  });
}

function syncColorInputsFromTheme() {
  const map = {
    'adm-color-bg':       themeState.bg,
    'adm-color-surface':  themeState.surface,
    'adm-color-accent':   themeState.accent,
    'adm-color-text':     themeState.text,
    'adm-color-surface2': themeState.surface2,
    'adm-color-border':   themeState.border,
  };
  for (const [id, val] of Object.entries(map)) {
    if (val) { const el = document.getElementById(id); if (el) el.value = normalizeHex(val); }
  }
}

function readColorsFromInputs() {
  return {
    bg:       document.getElementById('adm-color-bg').value,
    surface:  document.getElementById('adm-color-surface').value,
    accent:   document.getElementById('adm-color-accent').value,
    text:     document.getElementById('adm-color-text').value,
    surface2: document.getElementById('adm-color-surface2').value,
    border:   document.getElementById('adm-color-border').value,
  };
}

['adm-color-bg','adm-color-surface','adm-color-accent','adm-color-text','adm-color-surface2','adm-color-border'].forEach(id => {
  document.getElementById(id)?.addEventListener('input', () => {
    if (document.getElementById('adm-theme-preview').dataset.previewing === 'true') applyThemeToPage();
  });
});

document.getElementById('adm-theme-preview').addEventListener('click', function () {
  const previewing = this.dataset.previewing === 'true';
  if (previewing) {
    this.dataset.previewing = 'false'; this.textContent = 'Preview';
    clearThemeFromPage();
  } else {
    this.dataset.previewing = 'true'; this.textContent = 'Stop Preview';
    applyThemeToPage();
  }
});

function applyThemeToPage() {
  const c = readColorsFromInputs();
  const r = document.documentElement;
  r.style.setProperty('--bg',        c.bg);
  r.style.setProperty('--surface',   c.surface);
  r.style.setProperty('--surface-2', c.surface2);
  r.style.setProperty('--border',    c.border);
  r.style.setProperty('--text',      c.text);
  r.style.setProperty('--accent',    c.accent);
  let s = document.getElementById('admin-preview-style');
  if (!s) { s = document.createElement('style'); s.id = 'admin-preview-style'; document.head.appendChild(s); }
  s.textContent = document.getElementById('adm-custom-css').value;
}

function clearThemeFromPage() {
  ['--bg','--surface','--surface-2','--border','--text','--accent'].forEach(v =>
    document.documentElement.style.removeProperty(v));
  const s = document.getElementById('admin-preview-style');
  if (s) s.textContent = '';
}

// Header image
document.getElementById('adm-header-img-input').addEventListener('change', function () {
  if (!this.files[0]) return;
  pendingHeaderBlob = this.files[0];
  showHeaderImagePreview(URL.createObjectURL(pendingHeaderBlob));
});

document.getElementById('adm-header-img-clear').addEventListener('click', () => {
  pendingHeaderBlob = null; headerImageUrl = null;
  document.getElementById('adm-header-img-preview').style.display = 'none';
  document.getElementById('adm-header-img-input').value = '';
});

function showHeaderImagePreview(src) {
  document.getElementById('adm-header-img-thumb').src = src;
  document.getElementById('adm-header-img-preview').style.display = 'block';
}

document.getElementById('adm-theme-save').addEventListener('click', async () => {
  const btn = document.getElementById('adm-theme-save');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Saving…';
  try {
    if (pendingHeaderBlob) {
      const form = new FormData();
      form.append('headerImage', pendingHeaderBlob);
      const res  = await fetch(`/api/events/${joinCode}/theme-image`, {
        method: 'POST', body: form, headers: { 'X-Organizer-Code': organizerCode },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      headerImageUrl = data.url; pendingHeaderBlob = null;
    }

    const colors = readColorsFromInputs();
    const theme  = {
      ...colors,
      mode:        document.getElementById('adm-theme-mode').value || 'system',
      font:        document.getElementById('adm-theme-font').value || undefined,
      customCss:   document.getElementById('adm-custom-css').value || undefined,
      headerImage: headerImageUrl || undefined,
    };

    const res  = await fetch(`/api/events/${joinCode}/theme`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ organizerCode, theme }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast('Theme saved!');
    themeState = theme;
  } catch (err) {
    showToast(err.message || 'Save failed', true);
  } finally {
    btn.disabled = false; btn.textContent = 'Save Theme';
  }
});

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox() {
  renderLb();
  document.getElementById('lightbox').classList.add('open');
}

function renderLb() {
  const p   = lbPhotos[lbIndex];
  const img = document.getElementById('lightbox-img');
  const vid = document.getElementById('lightbox-video');
  if (p.mediaType === 'video') {
    img.style.display = 'none';
    vid.style.display = 'block'; vid.src = p.url;
  } else {
    vid.style.display = 'none'; vid.src = '';
    img.style.display = 'block'; img.src = p.url;
  }
  document.getElementById('lightbox-caption').textContent =
    `${p.participantName} · ${new Date(p.takenAt).toLocaleString()} · ${lbIndex+1}/${lbPhotos.length}`;
}

document.getElementById('lightbox').addEventListener('click', e => {
  const lb = document.getElementById('lightbox');
  if (e.target.id === 'lightbox-close' || e.target.id === 'lightbox') { lb.classList.remove('open'); return; }
  if (e.target.tagName === 'VIDEO' || e.target.tagName === 'BUTTON') return;
  const half = window.innerWidth / 2;
  if (e.clientX > half && lbIndex < lbPhotos.length - 1) lbIndex++;
  else if (e.clientX <= half && lbIndex > 0) lbIndex--;
  renderLb();
});

document.addEventListener('keydown', e => {
  const lb = document.getElementById('lightbox');
  if (!lb.classList.contains('open')) return;
  if (e.key === 'ArrowRight' && lbIndex < lbPhotos.length - 1) { lbIndex++; renderLb(); }
  if (e.key === 'ArrowLeft'  && lbIndex > 0)                   { lbIndex--; renderLb(); }
  if (e.key === 'Escape') lb.classList.remove('open');
});

// ── Auto-refresh ──────────────────────────────────────────────────────────────
setInterval(async () => {
  try {
    const res  = await fetch(`/api/events/${joinCode}/admin`, { headers: { 'X-Organizer-Code': organizerCode } });
    const data = await res.json();
    if (res.ok) { eventData = data; renderEvent(); await loadPhotos(); }
  } catch {}
}, 30_000);

// ── Helpers ───────────────────────────────────────────────────────────────────
// escHtml/esc, showToast, downloadOne are provided by /js/util.js (loaded first).

function normalizeHex(val) {
  if (!val) return '#000000';
  if (val.startsWith('#')) return val;
  const m = val.match(/(\d+),\s*(\d+),\s*(\d+)/);
  if (!m) return '#000000';
  return '#' + [m[1],m[2],m[3]].map(n => parseInt(n).toString(16).padStart(2,'0')).join('');
}
