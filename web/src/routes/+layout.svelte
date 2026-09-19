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
  import { page, updated } from '$app/stores';
  import { browser } from '$app/environment';

  // Apply the saved appearance preference (defaults to dark). Per-event pages apply their
  // own theme; this governs the marketing/app chrome.
  onMount(() => { initAppearance(); initAnalytics(); });

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
