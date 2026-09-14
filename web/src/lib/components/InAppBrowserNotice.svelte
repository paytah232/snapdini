<script lang="ts">
  // Shown when the visitor is inside an app's embedded browser, where the camera API is missing.
  // Without this they simply cannot take a photo and are given no reason why.
  import { onMount } from 'svelte';
  import { inAppBrowserName, cameraUnavailable, isIOS } from '$lib/inAppBrowser';

  let show = false;
  let noCamera = false;
  let appName: string | null = null;
  let ios = false;
  let copied = false;

  onMount(() => {
    appName = inAppBrowserName();
    ios = isIOS();
    // Show when we recognise an in-app browser OR the camera API is genuinely missing, so an
    // unrecognised webview still gets the message.
    noCamera = cameraUnavailable();
    show = (!!appName || noCamera) && !dismissed();
  });

  function dismissed(): boolean {
    try { return sessionStorage.getItem('snapdini.iab.dismissed') === '1'; } catch { return false; }
  }
  function dismiss() {
    show = false;
    try { sessionStorage.setItem('snapdini.iab.dismissed', '1'); } catch { /* private mode */ }
  }
  async function copyLink() {
    try { await navigator.clipboard.writeText(window.location.href); copied = true; setTimeout(() => (copied = false), 2500); }
    catch { /* clipboard blocked — the instructions below still apply */ }
  }
</script>

{#if show}
  <div class="iab" role="status">
    <div class="iab-body">
      <strong>Open this in your browser</strong>
      <p>
        <!-- Two different problems were being described as one. Some embedded browsers have no
             camera API at all, and photos genuinely cannot work. Others — Facebook's on Android is
             the one people hit — hand over the camera perfectly well but forget the permission
             between calls, so flipping the camera or switching to video asks all over again, every
             time. Telling that second group "photos won't work here" is plainly wrong to someone
             whose photos are working, and it buries the thing they actually need to know. -->
        {#if noCamera}
          {appName ? `${appName}'s built-in browser` : 'This app’s built-in browser'} doesn’t allow
          camera access at all, so photos won’t work here.
        {:else}
          {appName ? `${appName}'s built-in browser` : 'This app’s built-in browser'} forgets camera
          permission between uses, so it will keep asking every time you flip the camera or switch
          to video. Your real browser remembers it once.
        {/if}
        {#if ios}
          Tap the <strong>•••</strong> menu and choose <strong>Open in Safari</strong>.
        {:else}
          Tap the <strong>⋮</strong> menu and choose <strong>Open in browser</strong>.
        {/if}
      </p>
      <button class="iab-copy" type="button" on:click={copyLink}>
        {copied ? 'Link copied' : 'Copy link'}
      </button>
    </div>
    <button class="iab-x" type="button" on:click={dismiss} aria-label="Dismiss">×</button>
  </div>
{/if}

<style>
  .iab {
    display: flex; gap: .5rem; align-items: flex-start;
    background: #14110b; color: #e8e0cf;
    border-left: 3px solid #f0b429;
    padding: .75rem .9rem; border-radius: 0 8px 8px 0;
    font-size: .9rem; line-height: 1.4; margin: 0 auto .9rem; max-width: 42rem;
  }
  .iab-body { flex: 1; min-width: 0; }
  .iab p { margin: .35rem 0 .5rem; }
  .iab-copy {
    background: #f0b429; color: #14110b; border: 0; border-radius: 6px;
    padding: .35rem .7rem; font-weight: 600; cursor: pointer;
  }
  .iab-x {
    background: none; border: 0; color: #e8e0cf; font-size: 1.3rem;
    line-height: 1; cursor: pointer; padding: 0 .2rem; opacity: .7;
  }
  .iab-x:hover { opacity: 1; }
</style>
