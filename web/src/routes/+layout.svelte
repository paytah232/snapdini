<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { initAppearance } from '$lib/appearance';
  import { clearEventTheme } from '$lib/theme';
  import Toast from '$lib/components/Toast.svelte';
  import ConsentBanner from '$lib/components/ConsentBanner.svelte';
  import InAppBrowserNotice from '$lib/components/InAppBrowserNotice.svelte';
  import { initAnalytics, track } from '$lib/analytics';
  import { refreshConfig } from '$lib/api';
  import { page, updated } from '$app/stores';
  import { browser } from '$app/environment';

  // Apply the saved appearance preference (defaults to dark). Per-event pages apply their
  // own theme; this governs the marketing/app chrome.
  onMount(() => { initAppearance(); initAnalytics(); });

  /* The recovery banner.
     Shown whenever the server reports it is serving from a read-only replica, which happens when
     the primary site is unreachable and the standby has taken over. The site still WORKS — galleries
     and downloads read fine — so the banner exists to answer the one question a guest actually has
     when their upload will not go: is my stuff lost? It is not, and the camera's queue resends on
     its own, so the honest message is "paused", not "failed".
     POLLED, and deliberately not through the memoised getConfig(): promotion back to read-write
     happens under a running tab, and a cached config would leave this up on a site that had already
     recovered. Sixty seconds — this is not urgent enough to poll harder, and a page open through a
     whole incident is the case it has to get right. */
  let readOnly = false;
  onMount(() => {
    if (!browser) return;
    let alive = true;
    const look = async () => {
      try { const c = await refreshConfig(); if (alive) readOnly = !!c.readOnly; }
      catch { /* offline, or the server is mid-restart: leave the banner as it was */ }
    };
    void look();
    const t = setInterval(look, 60_000);
    return () => { alive = false; clearInterval(t); };
  });

  // One page_view per route change, recorded from the layout so every page is covered without
  // each one remembering to. `track` reduces the path to a route pattern server-side, so a URL
  // carrying an organizer code or a join code never lands in the table verbatim.
  let lastPath = '';
  $: if (browser && $page.url.pathname !== lastPath) {
    lastPath = $page.url.pathname;
    track('page_view');
  }

  // Routes that paint their OWN per-event theme on mount (gallery / admin / camera / share / join).
  const EVENT_ROUTE = /^\/(admin|gallery|e|join|s)(\/|$)/;
  // Before an INTERNAL navigation to a CHROME page, strip any per-event palette left on <html> and
  // restore the chrome appearance, so a viewed event's colours never bleed into the home page.
  // We DON'T clear when heading to another event-themed route — that page re-themes itself, and
  // resetting to chrome first would cause a visible flash. Also skip when leaving the app (Stripe).
  /* ── A deploy while somebody is mid-event ──────────────────────────────────
     SvelteKit ships hashed JS chunks and fetches them on demand. Deploy while a guest has the
     camera open and the page they are running asks for chunks that no longer exist on the server —
     the app stops working, silently, with no error a guest could act on. The service worker does
     not save us: it takes the new version over immediately (skipWaiting + clients.claim), which is
     the right thing for the NEXT load and does nothing for the tab already open.

     `updated` goes true when SvelteKit notices the deployed version has changed. We do NOT reload
     for them — a guest halfway through a shot would lose it — we offer it, and let them finish. */
  $: if (browser && $updated) offerReload();

  let reloadOffered = false;
  function offerReload() {
    if (reloadOffered) return;
    reloadOffered = true;
  }

  beforeNavigate((nav) => {
    // A navigation is the natural moment to pick up a new version: nothing is half-typed and no
    // shot is mid-capture, so this one CAN be taken automatically.
    if (browser && $updated && nav.to?.url) { location.href = nav.to.url.href; return; }
    if (nav.type === 'leave') return;
    if (EVENT_ROUTE.test(nav.to?.url.pathname ?? '')) return;
    clearEventTheme();
    initAppearance();
  });
</script>

<InAppBrowserNotice />
<!-- Top, not bottom: this is a standing condition rather than a transient message, and the bottom
     belongs to Toast and the update bar. role="status" so it is announced once, politely, instead of
     interrupting — nothing here needs acting on. -->
{#if readOnly}
  <div class="recovery-bar" role="status">
    <strong>We're recovering a server.</strong>
    Your photos and videos are safe. Uploads are paused and will work again shortly — there's no
    need to re-upload anything.
  </div>
{/if}
<!-- Deliberately not a modal and not auto-dismissing: it has to survive until they choose, and it
     must never take the screen off a guest who is shooting. -->
{#if reloadOffered}
  <div class="update-bar" role="status">
    <span>Snapdini has been updated.</span>
    <button on:click={() => location.reload()}>Reload</button>
    <button class="later" on:click={() => (reloadOffered = false)} aria-label="Dismiss">✕</button>
  </div>
{/if}
<slot />
<Toast />
<ConsentBanner />

<style>
  .recovery-bar {
    position: sticky; top: 0; z-index: 320;
    padding: 10px 16px; text-align: center; line-height: 1.4; font-size: 0.86rem;
    /* Its own colour, not --danger: nothing is broken and nothing was lost. Amber reads as "hold
       on", which is exactly what it is asking for. */
    background: #4a3a10; color: #f7e6b8; border-bottom: 1px solid #6b5418;
  }
  .recovery-bar strong { color: #ffd968; }
  @media (prefers-color-scheme: light) {
    /* :global on the ANCESTOR only — the root element is not part of this component, so Svelte
       scopes the selector to nothing and drops the rule. .recovery-bar stays scoped. */
    :global(:root:not([data-theme='dark'])) .recovery-bar { background: #fff4d6; color: #5a4510; border-bottom-color: #e2c882; }
    :global(:root:not([data-theme='dark'])) .recovery-bar strong { color: #7a5c00; }
  }

  /* Bottom, not top: the top of a camera screen is the shot counter and the trick list, and the
     bottom is where this app already puts transient messages (see Toast). */
  .update-bar {
    position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); z-index: 300;
    display: flex; align-items: center; gap: 10px; max-width: calc(100vw - 32px);
    padding: 10px 12px; border-radius: 999px; font-size: 0.85rem;
    background: var(--surface, #1b1b1b); color: var(--text, #fff);
    border: 1px solid var(--border, #333); box-shadow: 0 8px 24px rgba(0,0,0,.4);
  }
  .update-bar button {
    font: inherit; font-weight: 700; cursor: pointer; border-radius: 999px;
    padding: 5px 12px; border: 0; background: var(--accent-fill, #f5c518); color: var(--accent-ink, #111);
  }
  .update-bar .later { background: none; color: var(--text-muted, #999); padding: 5px 6px; }
</style>
