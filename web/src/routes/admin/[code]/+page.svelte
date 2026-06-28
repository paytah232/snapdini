<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { getConfig, getMe } from '$lib/api';
  import {
    getAdmin, saveSettings, setReveal, toggleLock, deleteEvent,
    setHighlights, saveTheme, emailGallery, setAllowDownloads,
    getPhotosByOrganizer, listCohosts, inviteCohost, removeCohost,
    listShares, deleteShare, deleteParticipant,
    type AdminEvent, type Photo, type EventTheme, type CohostList, type ShareLink
  } from '$lib/events';
  import type { AppOptions, BillingConfig } from '$lib/types';
  import UpgradePanel from '$lib/components/UpgradePanel.svelte';
  import HelpTip from '$lib/components/HelpTip.svelte';
  import ShareModal from '$lib/components/ShareModal.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import { applyEventTheme } from '$lib/theme';
  import { getAdminCode, saveAdminCode } from '$lib/session';
  import { showToast, showSuccess } from '$lib/toast';
  import { imgFallback } from '$lib/ui';
  import Lightbox from '$lib/components/Lightbox.svelte';
  import PosterModal from '$lib/components/PosterModal.svelte';
  import EventImageEditor from '$lib/components/EventImageEditor.svelte';

  const code = $page.params.code ?? '';

  // ── State ──────────────────────────────────────────────────────────────────
  let orgCode = '';
  let authInput = '';
  let authed = false;
  let booting = true;
  let authBusy = false;
  let welcome: { title: string; sub: string } | null = null;  // post-create / post-payment celebration modal
  let viewerLoggedIn = false;   // for the top return bar
  let viewerIsAdmin = false;    // site admin drilled in via support-override → offer "back to site admin"

  let ev: AdminEvent | null = null;
  let options: AppOptions | null = null;
  let billing: BillingConfig | null = null;
  let qrCode = '';
  let timezones: string[] = ['UTC'];

  let allPhotos: Photo[] = [];   // approved photos — gates the Review & Curate link card
  let pendingPhotos: Photo[] = []; // status === 'pending'
  let posterOpen = false;

  // settings form
  let sName = '';
  let sBlurb = '';
  let sDate = '';
  let sTime = '';
  let sReveal = 'instant';
  let sDelay = 0;
  let sModeration = false;
  let sNoFlash = false;
  let sTimezone = '';
  let sSlug = '';
  let sAspects = new Set<string>();
  let actionBusy = false;   // guards reveal/lock/delete against double-submit
  let savingSettings = false;
  let baselineSig = '';     // settings signature at load — compared against to detect unsaved edits
  // Once an event has started, its start time is locked (can't reschedule).
  $: eventStarted = !!ev && Date.now() >= ev.startsAt;
  // Live-clean the custom URL as it's typed (server slugifies + validates on save).
  function onEventSlugInput() { sSlug = sSlug.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 50); }
  // Unsaved settings edits. The Upgrade panel quotes off the SAVED event (e.g. its frame sizes), so
  // an unticked-but-unsaved shape would under-quote — we block upgrading until settings are saved.
  $: settingsDirty = baselineSig !== '' &&
    baselineSig !== JSON.stringify([sName, sBlurb, sDate, sTime, sReveal, sDelay, sModeration, sNoFlash, sTimezone, sSlug, [...sAspects].sort()]);

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

  // email gallery
  let emailInput = '';
  let emailBusy = false;

  let refreshTimer: ReturnType<typeof setInterval> | undefined;

  // 'warm' is the default and listed first.
  const THEME_PRESETS: Record<string, Partial<EventTheme>> = {
    warm:     { bg:'#1a1209', surface:'#231a0e', surface2:'#2c2010', border:'#3d2e18', text:'#f5e8c8', textMuted:'#9c8060', accent:'#e8994a', accentDark:'#c47830' },
    dark:     { bg:'#0f0f0f', surface:'#1a1a1a', surface2:'#222', border:'#2a2a2a', text:'#f5f5f5', textMuted:'#888', accent:'#a8ff78', accentDark:'#72d52d' },
    light:    { bg:'#f5f5f0', surface:'#ffffff', surface2:'#f0f0ea', border:'#ddd', text:'#1a1a1a', textMuted:'#777', accent:'#2563eb', accentDark:'#1d4ed8' },
    ocean:    { bg:'#050d1a', surface:'#0a1628', surface2:'#0e1e36', border:'#162944', text:'#d0e8ff', textMuted:'#6698bb', accent:'#38bdf8', accentDark:'#0ea5e9' },
    midnight: { bg:'#0a0a14', surface:'#111128', surface2:'#16163a', border:'#222248', text:'#e8e8ff', textMuted:'#6668aa', accent:'#818cf8', accentDark:'#6366f1' },
    forest:   { bg:'#0a130a', surface:'#111e11', surface2:'#162416', border:'#1e3020', text:'#d8f0d8', textMuted:'#5a8060', accent:'#4ade80', accentDark:'#22c55e' },
    pink:     { bg:'#1a0a14', surface:'#26101e', surface2:'#331528', border:'#46203a', text:'#ffe4f3', textMuted:'#b06a92', accent:'#f472b6', accentDark:'#ec4899' }
  };

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
        ? 'Auto-reveals when event ends'
        : ev.revealMode === 'manual'
          ? 'Manual — reveal when ready'
          : 'Instant — photos visible as taken'
    : '';

  // ── Bootstrap ──────────────────────────────────────────────────────────────
  onMount(async () => {
    const sp = new URLSearchParams(location.search);
    // Celebrate a fresh create / successful payment / upgrade with a modal (QR + share link).
    if (sp.get('created') === '1') welcome = { title: 'Your event is live! 🎉', sub: 'Share the link or QR below with your guests. Customise the theme, reveal mode and more right here whenever you like.' };
    else if (sp.get('paid') === '1') welcome = { title: 'Payment received — your event is active! 🎉', sub: 'Share the link or QR below with your guests. Everything you paid for is unlocked.' };
    else if (sp.get('upgraded') === '1') welcome = { title: 'Upgrade applied! 🎉', sub: 'Your event now includes the extra capacity. Nothing else to do — carry on.' };
    // Strip the marker so a refresh doesn't re-show it (keep the #organizer hash).
    if (sp.has('paid') || sp.has('upgraded') || sp.has('created')) history.replaceState(null, '', location.pathname + location.hash);
    // Resolve identity first (and independently) so the Site-admin / My-events bar appears
    // promptly even if config is slow — and on every event, not just the viewer's own.
    try { const me = await getMe(); viewerLoggedIn = !!me.user; viewerIsAdmin = !!me.user?.isAdmin; } catch { /* anon organizer */ }
    try {
      const _cfg = await getConfig(); options = _cfg.options; billing = _cfg.billing;
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
      await tryLoad();
      // Once authenticated the organizer code is cached in localStorage (saveAdminCode), so we
      // can scrub it (and any ?paid/#hash) from the address bar — no more long code on screen.
      if (authed) history.replaceState(null, '', location.pathname);
    }
    booting = false;
    refreshTimer = setInterval(refresh, 30_000);
  });

  onDestroy(() => clearInterval(refreshTimer));

  async function tryLoad(): Promise<boolean> {
    try {
      await loadEvent();
      authed = true;
      saveAdminCode(code, orgCode);
      void loadCohosts();
      void loadShares();
      return true;
    } catch (e) {
      authed = false;
      orgCode = '';
      showToast(e instanceof Error ? e.message : 'Access denied', true);
      return false;
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
    const d = new Date(e.startsAt);
    sName = e.name || '';
    sBlurb = e.blurb || '';
    sDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    sTime = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    sReveal = e.revealMode || 'instant';
    sDelay = e.revealDelayHours || 0;
    sModeration = !!e.moderationEnabled;
    sNoFlash = !!e.noFlash;
    sTimezone = e.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    sSlug = e.slug || '';
    sAspects = new Set(e.aspectRatios && e.aspectRatios.length ? e.aspectRatios : ['1:1']);
    // Snapshot the saved settings so we can detect unsaved edits (gates the Upgrade panel).
    baselineSig = JSON.stringify([sName, sBlurb, sDate, sTime, sReveal, sDelay, sModeration, sNoFlash, sTimezone, sSlug, [...sAspects].sort()]);

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
      hydrateFromEvent(ev);
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

  // ── Settings ─────────────────────────────────────────────────────────────
  function toggleAspect(value: string) {
    if (value !== '1:1' && !canAllShapes) return;   // non-square shapes need the frame pack
    const next = new Set(sAspects);
    if (next.has(value)) next.delete(value); else next.add(value);
    sAspects = next;
  }
  // Entitlement: extra (non-square) shapes are free on small/free events, otherwise they need the
  // paid frame pack. If the event already has any non-square shape, the pack is owned.
  $: framePackOwned = (ev?.aspectRatios ?? []).some((a) => a !== '1:1');
  $: canAllShapes = !billing?.billingEnabled
    || (!!ev && ev.guestCap <= (billing?.freeAllGuests ?? 10))
    || framePackOwned;

  async function saveSettingsForm() {
    savingSettings = true;
    try {
      const startsAt = sDate
        ? new Date(`${sDate}T${sTime || '00:00'}`).getTime()
        : undefined;
      await saveSettings(code, orgCode, {
        name: sName,
        blurb: sBlurb.trim(),
        startsAt,
        startDate: sDate,
        startTime: sTime,
        revealMode: sReveal,
        revealDelayHours: parseInt(String(sDelay), 10) || 0,
        moderationEnabled: sModeration,
        noFlash: sNoFlash,
        ratingMode: 'favourite',
        timezone: sTimezone,
        slug: sSlug.trim(),
        aspectRatios: [...sAspects]
      });
      showSuccess('Settings saved');
      await loadEvent();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Save failed', true);
    } finally {
      savingSettings = false;
    }
  }

  // ── Co-hosts ─────────────────────────────────────────────────────────────────
  let cohostData: CohostList | null = null;
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

  async function sendEmails() {
    const input = emailInput.trim();
    if (!input) { showToast('Enter at least one email address', true); return; }
    const addresses = input.split(',').map((s) => s.trim()).filter(Boolean);
    emailBusy = true;
    try {
      await emailGallery(code, orgCode, addresses);
      showToast(`Sent to ${addresses.length} address${addresses.length !== 1 ? 'es' : ''}!`);
      emailInput = '';
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Send failed', true);
    } finally {
      emailBusy = false;
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
  <a class="brand" href={viewerLoggedIn ? '/dashboard' : '/'}><Logo /> <small>ADMIN</small></a>
  <nav class="topnav-right">
    {#if viewerIsAdmin}<a class="nav-link site-admin" href="/siteadmin" title="Back to the platform console">🎩 Site admin</a>{/if}
    {#if viewerLoggedIn}<a class="nav-link" href="/dashboard">← My events</a>{/if}
  </nav>
</header>

{#if booting}
  <div class="state">Loading…</div>
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
        {#if qrCode}<img class="qr" src={qrCode} alt="QR code" />{/if}
        <div class="code-label">EVENT CODE — guests type this to join</div>
        <div class="join-code">{code}</div>
        <button class="copy-code" on:click={() => copy(code, 'Event code copied!')}>⧉ Copy code</button>
        <div class="join-url">{joinUrl}</div>
      </div>
      <button class="btn primary sm full" on:click={shareInvite}>📤 Share invite</button>
      <div class="row gap mt">
        <button class="btn ghost sm grow" on:click={() => copy(joinUrl, 'Join link copied!')}>Copy join link</button>
        <button class="btn ghost sm grow" on:click={downloadQr}>Save QR</button>
      </div>
      <button class="btn primary sm full mt" on:click={() => (posterOpen = true)} disabled={!qrCode}>🎩 Create poster</button>
      <button class="btn ghost sm full mt" on:click={() => copy(galleryUrl, 'Gallery link copied!')}>🖼 Copy gallery-only link</button>

      {#if ev.emailEnabled}
        <div class="email-section">
          <div class="label-mono">EMAIL GALLERY LINK</div>
          <div class="email-row">
            <input type="email" bind:value={emailInput} placeholder="guest@example.com, another@example.com" />
            <button class="btn ghost sm" on:click={sendEmails} disabled={emailBusy}>{emailBusy ? '…' : 'Send'}</button>
          </div>
          <p class="hint">Comma-separated addresses</p>
        </div>
      {/if}
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
          <div class="t-label">Lock event</div>
          <div class="t-sub">Prevent new photos and joins</div>
        </div>
        <button class="btn ghost sm" on:click={doLock} disabled={actionBusy}>{ev.isLocked ? 'Unlock' : 'Lock'}</button>
      </div>
      <div class="divider"></div>

      <div class="toggle-row">
        <div>
          <div class="t-label">Delete event</div>
          <div class="t-sub">Permanently remove all data</div>
        </div>
        <button class="btn danger sm" on:click={doDelete}>Delete</button>
      </div>
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
        <div class="field"><label for="s-date">Start date</label><input id="s-date" type="date" bind:value={sDate} disabled={eventStarted} /></div>
        <div class="field"><label for="s-time">Start time</label><input id="s-time" type="time" bind:value={sTime} disabled={eventStarted} /></div>
      </div>
      {#if eventStarted}<p class="field-hint" style="margin:-4px 0 10px">This event has started, so its start time is locked.</p>{/if}
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
              <input type="checkbox" checked={sAspects.has(a.value)} disabled={a.value !== '1:1' && !canAllShapes} on:change={() => toggleAspect(a.value)} />
              {a.label}{#if a.pro}<span class="pro-tag">Pro</span>{/if}
            </label>
          {/each}
        </div>
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
          <select id="s-delay" bind:value={sDelay}>
            {#each options?.revealDelays ?? [] as d}<option value={d.value}>{d.label}</option>{/each}
          </select>
        </div>
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
            <button class="preset" class:selected={selectedPreset === key} title={key} on:click={() => applyPreset(key)}
              style="background:{THEME_PRESETS[key].bg};border-color:{selectedPreset === key ? 'var(--accent)' : THEME_PRESETS[key].accent}">
              <span style="color:{THEME_PRESETS[key].text}">{key}</span>
              {#if selectedPreset === key}<span class="preset-check">✓</span>{/if}
            </button>
          {/each}
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
      <a class="card review-link" href="/admin/{code}/review#{orgCode}">
        <div class="review-icon">⭐</div>
        <div class="review-text">
          <div class="card-title">Review &amp; curate photos</div>
          <p class="hint">
            {#if pendingPhotos.length}<strong class="pending-flag">{pendingPhotos.length} pending approval</strong> · {/if}
            Approve, reject, favourite and rate — in a focused full-screen view.
          </p>
        </div>
        <div class="review-arrow">→</div>
      </a>
    {/if}

    <!-- Co-hosts: invite people to manage this event with you -->
    <div class="card">
      <div class="card-title">Co-hosts</div>
      <p class="hint" style="margin:0 0 12px">Invite people to help manage this event — they get the same access as you. They can add or remove other co-hosts, but the event owner can never be removed.</p>
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
      <div class="cohost-add">
        <input type="email" placeholder="co-host@email.com" bind:value={cohostEmail} on:keydown={(e) => e.key === 'Enter' && addCohost()} />
        <button class="btn primary sm" on:click={addCohost} disabled={cohostBusy || !cohostEmail.trim()}>{cohostBusy ? 'Inviting…' : 'Invite'}</button>
      </div>
    </div>

    <!-- Shared links: every public link you've created (make them from Review & Curate → Share) -->
    <div class="card">
      <div class="card-title">Shared links</div>
      {#if sharesList.length}
        <div class="cohost-list">
          {#each sharesList as s (s.id)}
            <div class="cohost-row">
              <div class="cohost-who"><span class="cohost-email">{s.label}</span><span class="cohost-sub">{shareKindText(s.kind, s.count)} · /s/{s.slug || s.id}</span></div>
              <div class="cohost-acts">
                <button class="btn ghost sm" on:click={() => copyShare(s.url)}>🔗 Copy</button>
                <button class="btn ghost sm" on:click={() => (editShare = s)}>Edit</button>
                <button class="btn ghost sm" on:click={() => dropShare(s.id)} aria-label="Delete share">Delete</button>
              </div>
            </div>
          {/each}
        </div>
      {:else}
        <p class="hint" style="margin:0">No shared links yet. Create one from <b>Review &amp; Curate → 📤 Share</b> — you can rename it or change its link here any time.</p>
      {/if}
    </div>

    <!-- Slideshow now lives in Review & Curate (🎬) — linked from the card above. -->

    <!-- Participants -->
    <div class="card">
      <div class="card-title">Participants</div>
      {#if ev.participants && ev.participants.length}
        <div class="participant-list">
          {#each ev.participants as p (p.id)}
            <div class="participant-row">
              <div class="avatar">{(p.name?.[0] || '?').toUpperCase()}</div>
              <div class="p-info">
                <div class="p-name">{p.name}</div>
                <div class="p-email">{#if p.email}{p.email}{:else}<span class="muted">no email</span>{/if}</div>
                <div class="p-meta">{p.photosTaken || 0} photos · joined {fmtTime(p.joinedAt)}</div>
              </div>
              <button class="btn ghost sm p-del" on:click={() => removeParticipant(p)} title="Remove this participant">Remove</button>
            </div>
          {/each}
        </div>
      {:else}
        <div class="muted small">No participants yet</div>
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
    initialConfig={ev.posterConfig}
    on:close={() => (posterOpen = false)}
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
      <div class="join-code">{code}</div>
      <div class="welcome-url">{joinUrl}</div>
      <div class="row gap">
        <button class="btn ghost grow" on:click={() => { navigator.clipboard.writeText(joinUrl); showToast('Link copied!'); }}>Copy share link</button>
        <button class="btn primary grow" on:click={() => (welcome = null)}>Start managing →</button>
      </div>
    </div>
  </div>
{/if}

<style>
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
  .welcome-url { font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-muted);
    word-break: break-all; margin: 10px 0 16px; }
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
  .btn:disabled { opacity: 0.6; cursor: default; }
  .grow { flex: 1; }

  /* Cards */
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; }
  .card-title { font-weight: 800; font-size: 0.95rem; margin-bottom: 14px; }
  .card-title.nomb { margin-bottom: 0; }

  .review-link { display: flex; align-items: center; gap: 14px; text-decoration: none; color: var(--text); transition: border-color 0.15s; }
  .review-link:hover { border-color: var(--accent); }
  .review-link .card-title { margin-bottom: 4px; }
  .review-icon { font-size: 1.5rem; line-height: 1; }
  .review-text { flex: 1; }
  .review-text .hint { margin: 0; }
  .review-arrow { font-size: 1.3rem; color: var(--text-muted); }
  .pending-flag { color: var(--accent); }

  .muted { color: var(--text-muted); }
  .small { font-size: 0.85rem; }
  .hint { font-size: 0.72rem; color: var(--text-muted); }
  .cohost-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
  .cohost-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .cohost-who { display: flex; flex-direction: column; min-width: 0; }
  .cohost-email { font-weight: 600; font-size: 0.86rem; overflow-wrap: anywhere; }
  .cohost-sub { font-size: 0.72rem; color: var(--text-muted); }
  .cohost-acts { display: flex; align-items: center; gap: 8px; flex: none; }
  .cohost-tag { font-size: 0.64rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 5px; background: var(--accent); color: var(--accent-ink, #111); }
  .cohost-tag.owner { background: transparent; color: var(--text-muted); border: 1px solid var(--border); }
  .cohost-tag.pending { background: transparent; color: var(--text-muted); border: 1px dashed var(--border); }
  .cohost-add { display: flex; gap: 8px; }
  .cohost-add input { flex: 1; padding: 9px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font: inherit; font-size: 0.88rem; }
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
  .stat span { font-size: 0.65rem; color: var(--text-muted); }

  /* Invite */
  .qr-block { text-align: center; }
  .qr { width: 180px; height: 180px; border-radius: var(--radius-sm); background: #fff; }
  .code-label { font-size: 0.62rem; color: var(--text-muted); font-family: var(--font-mono); letter-spacing: .04em; margin-top: 12px; text-transform: uppercase; }
  .join-code { font-family: var(--font-mono); font-weight: 800; font-size: 1.5rem; margin-top: 2px; letter-spacing: 0.14em; color: var(--accent); }
  .copy-code { display: inline-block; margin-top: 6px; background: none; border: 1px solid var(--border); color: var(--text-muted);
    border-radius: 8px; padding: 3px 10px; font-size: 0.72rem; cursor: pointer; font-family: var(--font); }
  .copy-code:hover { color: var(--text); }
  .join-url { font-size: 0.72rem; color: var(--text-muted); word-break: break-all; margin-top: 8px; }
  .email-section { margin-top: 12px; }
  .email-row { display: flex; gap: 8px; }
  .email-row input { flex: 1; }

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

  .aspect-options { display: flex; flex-wrap: wrap; gap: 8px; }
  .aspect-opt { display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px; font-size: 0.82rem;
    border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); cursor: pointer; }
  .pro-tag { font-size: 0.6rem; background: var(--accent); color: var(--accent-ink, #111); padding: 1px 5px; border-radius: 4px; font-weight: 700; }
  .aspect-opt.locked { opacity: 0.5; cursor: not-allowed; }
  .aspect-opt.locked input { cursor: not-allowed; }

  /* Theme presets */
  .presets { display: flex; flex-wrap: wrap; gap: 8px; }
  .preset { position: relative; width: 64px; height: 48px; border-radius: var(--radius-sm); border: 2px solid; cursor: pointer;
    display: flex; align-items: center; justify-content: center; transition: transform .1s, box-shadow .1s; }
  .preset span { font-size: 0.65rem; font-weight: 700; text-transform: capitalize; }
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
  .participant-row { display: flex; gap: 12px; align-items: center; }
  .participant-row .p-info { flex: 1; min-width: 0; }
  .p-del { flex: none; }
  .avatar { width: 38px; height: 38px; border-radius: 50%; background: var(--accent); color: var(--accent-ink, #111);
    display: flex; align-items: center; justify-content: center; font-weight: 800; flex-shrink: 0; }
  .p-name { font-weight: 700; font-size: 0.9rem; }
  .p-email { font-size: 0.78rem; color: var(--text); }
  .p-meta { font-size: 0.72rem; color: var(--text-muted); }

  @media (max-width: 480px) {
    .stat-grid { grid-template-columns: repeat(2, 1fr); }
  }
</style>
