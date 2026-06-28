// Shared front-end helpers. Loaded as a classic script BEFORE each page's own script,
// so these are plain globals the page/inline scripts can call directly.

// Escape a string for safe interpolation into innerHTML.
function escHtml(str) {
  return String(str).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Some pages call it `esc` — keep the alias as a (redeclaration-safe) function.
function esc(str) { return escHtml(str); }

// Fetch the server config once (cached). Options for dropdowns live here so they're
// never hard-coded in the pages.
let _configPromise = null;
function getConfig() {
  if (!_configPromise) _configPromise = fetch('/api/config').then(r => r.json());
  return _configPromise;
}

// Build <option>s for a <select> from [{value,label}] items.
function fillSelect(el, items, selected) {
  if (!el) return;
  el.innerHTML = (items || []).map(o => `<option value="${escHtml(o.value)}">${escHtml(o.label)}</option>`).join('');
  if (selected !== undefined && selected !== null && String(selected) !== '') el.value = String(selected);
}

// Transient toast. No-ops if the page has no #toast element.
function showToast(msg, isError = false) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.className = isError ? 'error show' : 'show';
  setTimeout(() => { t.className = ''; }, 2600);
}

// Download a single URL as a file (used by per-page downloadAll loops).
async function downloadOne(url, filename) {
  try {
    const blob = await fetch(url).then(r => r.blob());
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
    a.click();
    URL.revokeObjectURL(a.href);
  } catch { showToast('Download failed', true); }
}
