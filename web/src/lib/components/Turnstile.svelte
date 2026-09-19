<script lang="ts">
  // Cloudflare Turnstile widget.
  //
  // Renders nothing at all unless the server reports a site key (`turnstileSiteKey` in /api/config),
  // so self-host installs and any deploy made before the keys exist behave exactly as before.
  //
  // When a site key DOES exist there are two further states, and they are the whole reason this
  // component is more than a div:
  //
  //  * the widget is on its way — space is reserved for it the moment we know it is coming, because
  //    a 65px box appearing after the network round trip pushes the submit button down out from
  //    under a thumb already moving towards it;
  //  * the script never arrived — an ad blocker or a privacy DNS resolver (Pi-hole and friends)
  //    swallowing challenges.cloudflare.com, which is common enough that it is the single most
  //    likely reason a real customer cannot sign in. Saying so HERE is the difference between
  //    self-diagnosing in ten seconds and a form that refuses for ever without explaining itself.
  //    The wording is conditional on purpose: with TURNSTILE_FAIL_OPEN set the submit still goes
  //    through, and crying wolf at someone whose sign-up is about to work would be its own bug.
  import { onMount, onDestroy } from 'svelte';
  import { getConfig } from '$lib/api';

  export let token = '';
  export let action = '';

  /** off = no bot check on this deployment · waiting = space reserved · blocked = script refused. */
  let state: 'off' | 'waiting' | 'blocked' = 'off';

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
    let siteKey = '';
    try { siteKey = (await getConfig()).turnstileSiteKey || ''; } catch { return; }
    if (!siteKey) return;                       // feature off — stay invisible, submit with no token
    state = 'waiting';                          // reserve the space before the widget can arrive
    try {
      await loadScript();
      const w = win();
      if (!w.turnstile || !el) { state = 'blocked'; return; }
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
      state = 'blocked';
    }
  });

  onDestroy(() => {
    const w = typeof window === 'undefined' ? null : win();
    if (widgetId !== undefined && w?.turnstile) {
      try { w.turnstile.remove(widgetId); } catch { /* already removed */ }
    }
  });
</script>

<div class="turnstile" class:live={state !== 'off'} class:blocked={state === 'blocked'}>
  <div bind:this={el} class="box"></div>
  {#if state === 'blocked'}
    <p class="note">
      We couldn’t load the security check on this page — usually an ad blocker or private DNS
      blocking <b>challenges.cloudflare.com</b>. If this form won’t go through, allow that address
      or try again on a different network.
    </p>
  {/if}
</div>

<style>
  .turnstile { width: 100%; }
  /* Only once a site key is known: on a deployment with no bot check this element must take up no
     room whatsoever, and `min-height` on the bare class would leave a mystery gap in every form. */
  .turnstile.live { margin: .75rem 0; min-height: var(--ts-h, 65px); }
  .note { margin: 0; font-size: .8rem; line-height: 1.45; color: var(--text-muted); }
  .note b { font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
  /* The widget has a hard 300px minimum. Below that (small phones, or a narrow card with padding)
     scale it down from the left edge so it can never overhang the form. The notice is plain text
     and wraps on its own, so it is exempt — scaling it would only make it harder to read. */
  @media (max-width: 360px) {
    .turnstile.live:not(.blocked) {
      transform: scale(.85); transform-origin: left top; min-height: calc(var(--ts-h, 65px) * .85);
    }
  }
  :global(.turnstile iframe) { max-width: 100% !important; }
</style>
