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
  import { page } from '$app/stores';
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
  beforeNavigate((nav) => {
    if (nav.type === 'leave') return;
    if (EVENT_ROUTE.test(nav.to?.url.pathname ?? '')) return;
    clearEventTheme();
    initAppearance();
  });
</script>

<InAppBrowserNotice />
<slot />
<Toast />
<ConsentBanner />
