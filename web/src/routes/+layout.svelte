<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { beforeNavigate } from '$app/navigation';
  import { initAppearance } from '$lib/appearance';
  import { clearEventTheme } from '$lib/theme';
  import Toast from '$lib/components/Toast.svelte';

  // Apply the saved appearance preference (defaults to dark). Per-event pages apply their
  // own theme; this governs the marketing/app chrome.
  onMount(() => { initAppearance(); });

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

<slot />
<Toast />
