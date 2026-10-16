<script lang="ts">
  import { onMount } from 'svelte';
  import Camera from '$lib/components/Camera.svelte';
  import SavedCaptures from './SavedCaptures.svelte';
  import Toast from '$lib/components/Toast.svelte';
  import InAppBrowserNotice from '$lib/components/InAppBrowserNotice.svelte';
  import { track } from '$lib/analytics';

  // This entry owns only guest camera links. Gallery/host/navigation links still go to the
  // authoritative application; no SvelteKit router or server routes enter this build.
  const route = /^\/guest\/(join|e|saved)\/([^/]+)\/?$/.exec(window.location.pathname);
  let identifier = '';
  try { identifier = route ? decodeURIComponent(route[2]) : ''; } catch { /* malformed link */ }

  onMount(() => {
    if (identifier && route?.[1] === 'join') track('join_opened', undefined, identifier);
  });
</script>

<InAppBrowserNotice />
{#if identifier && route?.[1] === 'saved'}
  <SavedCaptures {identifier} />
{:else if identifier}
  <main><Camera {identifier} recoveryEnabled={true} /></main>
{:else}
  <main class="invalid-link">
    <h1>Open your event link</h1>
    <p>Use the link or QR code shared by your host to open the camera.</p>
  </main>
{/if}
<Toast />

<style>
  .invalid-link { max-width: 440px; margin: 15vh auto; padding: 24px; text-align: center; }
</style>
