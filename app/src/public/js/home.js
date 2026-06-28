// ── Tabs ─────────────────────────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    const which = tab.dataset.tab;
    document.getElementById('create-panel').classList.toggle('hidden', which !== 'create');
    document.getElementById('join-panel').classList.toggle('hidden', which !== 'join');
  });
});

// ── Reveal mode ───────────────────────────────────────────────────────────────
function selectRevealMode(mode) {
  document.querySelectorAll('.reveal-opt').forEach(o => o.classList.toggle('selected', o.dataset.mode === mode));
  document.getElementById('reveal-mode').value = mode;
  // Reveal-delay only applies to "At the End"; moderation only to non-instant modes.
  document.getElementById('reveal-delay-field').classList.toggle('hidden', mode !== 'at_end');
  document.getElementById('moderation-field').classList.toggle('hidden', mode === 'instant');
  if (mode === 'instant') document.getElementById('moderation-enabled').checked = false;
}

// Build every dropdown + the reveal-mode cards from the server config (single source).
getConfig().then(cfg => {
  const o = cfg.options || {};
  const def = o.defaults || {};
  fillSelect(document.getElementById('event-duration'),   o.durations,      def.durationHours);
  fillSelect(document.getElementById('event-max-photos'), o.shotsPerPerson, def.maxPhotos);
  fillSelect(document.getElementById('reveal-delay'),     o.revealDelays,   0);

  // Aspect-ratio checkboxes (1:1 is the free default; others tagged Pro).
  document.getElementById('aspect-options').innerHTML = (o.aspectRatios || []).map(a =>
    `<label class="aspect-opt"><input type="checkbox" value="${escHtml(a.value)}"${a.value === '1:1' ? ' checked' : ''} /> ${escHtml(a.label)}${a.pro ? ' <span class="pro-tag">Pro</span>' : ''}</label>`).join('');

  const wrap = document.getElementById('reveal-options');
  wrap.innerHTML = (o.revealModes || []).map(m => `
    <div class="reveal-opt" data-mode="${escHtml(m.value)}">
      <span class="opt-icon">${escHtml(m.icon || '')}</span>
      ${escHtml(m.label)}
      <br><small>${escHtml(m.desc || '')}</small>
    </div>`).join('');
  wrap.querySelectorAll('.reveal-opt').forEach(opt =>
    opt.addEventListener('click', () => selectRevealMode(opt.dataset.mode)));
  selectRevealMode(def.revealMode || 'instant');
}).catch(() => {});

// ── Timezone picker (defaults to the visitor's detected zone) ──────────────────
(function () {
  const input = document.getElementById('event-timezone');
  const list  = document.getElementById('tz-datalist');
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch {}   // IANA named zones only
  if (!zones.length) zones = ['UTC'];
  list.innerHTML = zones.map(z => `<option value="${z}"></option>`).join('');
  input.value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; // editable default
})();

// ── Start date/time defaults ──────────────────────────────────────────────────
(function () {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const dateStr = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  document.getElementById('event-start-date').value = dateStr;
  document.getElementById('event-start-date').min   = dateStr;
  document.getElementById('event-start-time').value = timeStr;
})();

// ── Slug auto-suggest + validation ───────────────────────────────────────────
const nameInput    = document.getElementById('event-name');
const slugInput    = document.getElementById('event-slug');
const slugFeedback = document.getElementById('slug-feedback');
let slugCheckTimer = null;
let slugUserEdited = false;

nameInput.addEventListener('input', () => {
  if (!slugUserEdited) {
    slugInput.value = slugify(nameInput.value);
    validateSlug();
  }
});

slugInput.addEventListener('input', () => {
  slugUserEdited = true;
  slugInput.value = slugify(slugInput.value, true);
  validateSlug();
});

slugInput.addEventListener('blur', () => {
  if (!slugInput.value) slugUserEdited = false;
});

function slugify(str, allowTrailingHyphen = false) {
  let s = str.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  if (!allowTrailingHyphen) s = s.replace(/^-+|-+$/g, '');
  return s.slice(0, 50);
}

function validateSlug() {
  clearTimeout(slugCheckTimer);
  const val = slugInput.value;
  if (!val) { slugFeedback.textContent = ''; return; }
  if (val.length < 2) {
    slugFeedback.innerHTML = '<span style="color:var(--danger)">Too short — at least 2 characters</span>';
    return;
  }
  slugFeedback.innerHTML = '<span style="color:var(--text-muted)">Checking…</span>';
  slugCheckTimer = setTimeout(async () => {
    try {
      const res  = await fetch(`/api/events/check-slug/${encodeURIComponent(val)}`);
      const data = await res.json();
      if (data.available) {
        slugFeedback.innerHTML = `<span style="color:var(--success)">✓ Available — URL will be <code style="color:var(--accent)">/e/${data.slug}</code></span>`;
      } else {
        slugFeedback.innerHTML = `<span style="color:var(--danger)">✗ Already taken — try a different name</span>`;
      }
    } catch { slugFeedback.textContent = ''; }
  }, 500);
}

// ── Create event ──────────────────────────────────────────────────────────────
document.getElementById('create-btn').addEventListener('click', async () => {
  // Creating an event requires a signed-in, verified account.
  const me = await fetch('/api/auth/me').then(r => r.json()).catch(() => ({}));
  if (!me.user) { showToast('Please sign in to create an event', true); setTimeout(() => location.href = '/login', 1200); return; }
  if (!me.user.emailVerified) { showToast('Please verify your email first', true); return; }

  const name           = nameInput.value.trim();
  const durationHours  = document.getElementById('event-duration').value;
  const maxPhotos      = document.getElementById('event-max-photos').value;
  const revealMode     = document.getElementById('reveal-mode').value;
  const slug           = slugInput.value.trim() || undefined;
  const startDate      = document.getElementById('event-start-date').value;
  const startTime      = document.getElementById('event-start-time').value;
  const allowDownloads = document.getElementById('allow-downloads').checked;
  const revealDelayHours = parseInt(document.getElementById('reveal-delay').value, 10) || 0;
  const moderationEnabled = document.getElementById('moderation-enabled').checked;
  const timezone = document.getElementById('event-timezone').value;
  const aspectRatios = [...document.querySelectorAll('#aspect-options input:checked')].map(i => i.value);
  // Compute the start as an epoch IN THE USER'S TIMEZONE so the server doesn't reparse it as UTC.
  const startsAt = startDate ? new Date(`${startDate}T${startTime || '00:00'}`).getTime() : Date.now();

  if (!name) { showToast('Enter an event name', true); nameInput.focus(); return; }

  const btn = document.getElementById('create-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating…';

  try {
    const res  = await fetch('/api/events', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, durationHours, maxPhotos, revealMode, slug, startsAt, startDate, startTime, allowDownloads, revealDelayHours, moderationEnabled, timezone, aspectRatios }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    const qrRes  = await fetch(`/api/events/${data.joinCode}/qr`);
    const qrData = await qrRes.json();

    document.getElementById('result-qr').src              = qrData.qrCode;
    document.getElementById('result-code').textContent     = data.slug || data.joinCode;
    document.getElementById('result-url').textContent      = qrData.joinUrl;
    document.getElementById('result-org-code').textContent = data.organizerCode;

    // Upcoming notice
    const startsAt   = data.event.startsAt;
    const upcomingEl = document.getElementById('result-upcoming-notice');
    if (startsAt > Date.now() + 60_000) {
      upcomingEl.textContent = `⏰ Event opens at ${new Date(startsAt).toLocaleString()}`;
      upcomingEl.classList.remove('hidden');
    } else {
      upcomingEl.classList.add('hidden');
    }

    const modal = document.getElementById('result-modal');
    modal.dataset.joinCode      = data.joinCode;
    modal.dataset.organizerCode = data.organizerCode;
    modal.dataset.joinUrl       = qrData.joinUrl;
    modal.classList.remove('hidden');
    modal.style.display = 'flex';
  } catch (err) {
    showToast(err.message || 'Failed to create event', true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Event';
  }
});

document.getElementById('copy-link-btn').addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('result-modal').dataset.joinUrl)
    .then(() => showToast('Link copied!'));
});
document.getElementById('open-admin-btn').addEventListener('click', () => {
  const m = document.getElementById('result-modal');
  window.open(`/admin/${m.dataset.joinCode}#${encodeURIComponent(m.dataset.organizerCode)}`, '_blank');
});
document.getElementById('go-camera-btn').addEventListener('click', () => {
  window.location.href = document.getElementById('result-modal').dataset.joinUrl;
});

// ── Join event ────────────────────────────────────────────────────────────────
document.getElementById('join-btn').addEventListener('click', async () => {
  const name = document.getElementById('join-name').value.trim();
  const code = document.getElementById('join-code-input').value.trim().toUpperCase();
  if (!name) { showToast('Enter your name', true); return; }
  if (code.length < 2) { showToast('Enter the event code', true); return; }

  const btn = document.getElementById('join-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Joining…';

  try {
    const res  = await fetch('/api/participants', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ joinCode: code, name }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    localStorage.setItem(`session_${data.joinCode || code}`, data.sessionToken);
    window.location.href = `/join/${data.joinCode || code}`;
  } catch (err) {
    showToast(err.message || 'Failed to join', true);
    btn.disabled = false;
    btn.textContent = 'Join Event';
  }
});

document.getElementById('join-code-input').addEventListener('input', function () {
  this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

const codeParam = new URLSearchParams(window.location.search).get('code');
if (codeParam) {
  document.getElementById('join-code-input').value = codeParam.toUpperCase();
  document.querySelector('[data-tab="join"]').click();
}

// showToast is provided by /js/util.js (loaded before this script).
