<script lang="ts">
  // Cloudflare Turnstile widget.
  //
  // Renders nothing at all unless the server reports a site key (`turnstileSiteKey` in /api/config),
  // so self-host installs and any deploy made before the keys exist behave exactly as before. The
  // server verifier fails open on a Cloudflare outage, so a blocked or slow script must never stop
  // a real user submitting — hence every failure path here simply leaves the token empty.
  import { onMount, onDestroy } from 'svelte';
  import { getConfig } from '$lib/api';

  export let token = '';
  export let action = '';

  let el: HTMLDivElement;
  let widgetId: string | undefined;

  type TurnstileApi = {
    render: (el: HTMLElement, opts: Record<string, unknown>) => string;
    reset: (id: string) => void;
    remove: (id: string) => void;
  };
  const win = () => window as unknown as { turnstile?: TurnstileApi; __snapdiniTurnstile?: Promise<void> };

  const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

  function loadScript(): Promise<void> {
    const w = win();
    if (w.turnstile) return Promise.resolve();
    if (!w.__snapdiniTurnstile) {
      w.__snapdiniTurnstile = new Promise<void>((resolve, reject) => {
        const s = document.createElement('script');
        s.src = SRC; s.async = true; s.defer = true;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('Turnstile script blocked'));
        document.head.appendChild(s);
      });
    }
    return w.__snapdiniTurnstile;
  }

  /** Tokens are single-use — call this after any submit that did not navigate away. */
  export function reset(): void {
    const w = win();
    if (widgetId !== undefined && w.turnstile) {
      try { w.turnstile.reset(widgetId); } catch { /* widget already gone */ }
    }
    token = '';
  }

  onMount(async () => {
    try {
      const siteKey = (await getConfig()).turnstileSiteKey;
      if (!siteKey) return;                     // feature off — submit without a token
      await loadScript();
      const w = win();
      if (!w.turnstile || !el) return;
      widgetId = w.turnstile.render(el, {
        sitekey: siteKey,
        theme: 'auto',
        // 'flexible' fills the container instead of the fixed 300px default, so the widget matches
        // the form rather than overhanging it. Cloudflare still enforces a 300px minimum, hence the
        // scale fallback in the styles below for very narrow screens.
        size: 'flexible',
        ...(action ? { action } : {}),
        callback: (t: string) => { token = t; },
        'expired-callback': () => { token = ''; },
        'error-callback': () => { token = ''; },
      });
    } catch {
      /* script blocked or config unreachable — server fails open */
    }
  });

  onDestroy(() => {
    const w = typeof window === 'undefined' ? null : win();
    if (widgetId !== undefined && w?.turnstile) {
      try { w.turnstile.remove(widgetId); } catch { /* already removed */ }
    }
  });
</script>

<div bind:this={el} class="turnstile"></div>

<style>
  .turnstile { width: 100%; }
  .turnstile:not(:empty) { margin: .75rem 0; }
  /* The widget has a hard 300px minimum. Below that (small phones, or a narrow card with padding)
     scale it down from the left edge so it can never overhang the form. */
  @media (max-width: 360px) {
    .turnstile { transform: scale(.85); transform-origin: left top; height: 60px; }
  }
  :global(.turnstile iframe) { max-width: 100% !important; }
</style>
