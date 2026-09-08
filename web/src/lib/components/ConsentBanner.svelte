<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { updateUetConsent, type Uetq } from '$lib/msads';

  // Shown only to EEA/UK visitors who haven't chosen yet, and only when an analytics/ads tag is
  // actually configured (window.__snapdiniConsent is injected by hooks.server.ts). Consent Mode v2
  // already defaults those regions to "denied", so this banner is what flips them to "granted".
  let show = false;

  let mounted = false;
  onMount(() => { mounted = true; });

  const cfg = () => (window as unknown as { __snapdiniConsent?: { enabled?: boolean; eea?: boolean } })
    .__snapdiniConsent;

  // `?consent=1` force-opens the banner regardless of region / prior choice — it is the "change
  // your consent" entry point linked from the footer and privacy policy.
  //
  // This MUST be reactive on $page, not a one-shot onMount read: the banner lives in the persistent
  // layout, so a client-side navigation to /?consent=1 never remounts it. Reading the URL only on
  // mount made the footer link silently do nothing unless the page was hard-loaded.
  $: if (mounted && $page.url.searchParams.has('consent')) show = true;

  onMount(() => {
    const c = cfg();
    if (!c?.enabled) return;   // no tag configured → nothing to consent to
    if ($page.url.searchParams.has('consent')) { show = true; return; }
    if (!c.eea) return;        // outside the consent-required regions → don't ask
    try {
      if (localStorage.getItem('snapdini-consent')) return; // already decided
    } catch {
      /* storage blocked — fall through and ask */
    }
    show = true;
  });

  function decide(granted: boolean) {
    try {
      localStorage.setItem('snapdini-consent', granted ? 'granted' : 'denied');
    } catch {
      /* ignore */
    }
    // One decision drives every platform on the page. Google takes the four Consent Mode v2
    // signals; Microsoft UET has only ad_storage.
    const w = window as unknown as { gtag?: (...a: unknown[]) => void; uetq?: Uetq };
    const state = granted ? 'granted' : 'denied';
    w.gtag?.('consent', 'update', {
      ad_storage: state,
      ad_user_data: state,
      ad_personalization: state,
      analytics_storage: state,
    });
    updateUetConsent(w.uetq, granted);
    show = false;
  }
</script>

{#if show}
  <div class="consent" role="dialog" aria-label="Privacy consent" aria-live="polite">
    <p class="consent-text">
      We use Google and Microsoft to measure our ads and understand what's working. Allow Snapdini
      to share your data with them for this? You can change your mind any time — see our
      <a href="/privacy">Privacy&nbsp;Policy</a>.
    </p>
    <div class="consent-actions">
      <button type="button" class="btn reject" on:click={() => decide(false)}>Reject</button>
      <button type="button" class="btn accept" on:click={() => decide(true)}>Accept</button>
    </div>
  </div>
{/if}

<style>
  .consent {
    position: fixed;
    left: 50%;
    bottom: 16px;
    transform: translateX(-50%);
    z-index: 300;
    width: min(680px, calc(100vw - 24px));
    display: flex;
    align-items: center;
    gap: 16px;
    flex-wrap: wrap;
    padding: 14px 18px;
    background: var(--surface, #191713);
    color: var(--text, #f4efe4);
    border: 1px solid var(--border, #2b271f);
    border-radius: 14px;
    box-shadow: 0 18px 46px rgba(0, 0, 0, 0.45);
  }
  .consent-text {
    margin: 0;
    flex: 1 1 300px;
    font-size: 0.86rem;
    line-height: 1.5;
    color: var(--text-muted, #a39b8c);
  }
  .consent-text a {
    color: var(--accent, #f0b429);
    text-decoration: underline;
  }
  .consent-actions {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }
  .btn {
    font: inherit;
    font-size: 0.84rem;
    font-weight: 700;
    padding: 8px 18px;
    border-radius: 9px;
    cursor: pointer;
    border: 1px solid transparent;
  }
  .reject {
    background: transparent;
    color: var(--text, #f4efe4);
    border-color: var(--border, #3a3630);
  }
  .reject:hover {
    border-color: var(--accent, #f0b429);
  }
  .accept {
    background: var(--accent, #f0b429);
    color: var(--accent-ink, #111);
  }
  .accept:hover {
    filter: brightness(1.06);
  }
  .btn:focus-visible {
    outline: 2px solid var(--accent, #f0b429);
    outline-offset: 2px;
  }
  @media (max-width: 480px) {
    .consent-actions {
      width: 100%;
    }
    .btn {
      flex: 1;
    }
  }
</style>
