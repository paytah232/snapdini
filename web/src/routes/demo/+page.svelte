<script lang="ts">
  // /demo — the one URL that is always a working demo.
  //
  // WHY THIS EXISTS: a printed QR cannot POST. The demo has only ever been reachable by pressing a
  // button on the landing page, which calls POST /api/events/demo — so the QR on a sample poster
  // had nowhere real to point and led to a 404. This route is a stable, linkable, printable address
  // that behaves exactly like scanning a guest's QR: you arrive, and you are in a camera.
  //
  // WHY THE POST HAPPENS HERE AND NOT IN A SERVER LOAD: a GET that creates a row is a GET that
  // link-preview bots create rows with. Slack, WhatsApp and iMessage all fetch a URL the moment it
  // is pasted, and this address is meant to be pasted — it is going on a poster. Server-side, every
  // unfurl would mint a demo event, and the demo count is a number this product actually watches
  // (see the comment on POST /api/events/demo: there are far more demo rolls than real events).
  // Bots do not run this script; phones do. The cost is one splash frame, which is what a QR scan
  // looks like anyway.
  import { onMount } from 'svelte';
  import { postJson } from '$lib/api';
  import Loading from '$lib/components/Loading.svelte';
  import Logo from '$lib/components/Logo.svelte';

  let failed = false;
  let busy = false;

  async function start() {
    // Guard the retry path: every call to this endpoint mints an event, so a double-tap on
    // "Try again" would leave a stray one behind.
    if (busy) return;
    busy = true;
    failed = false;
    try {
      const { joinCode, sessionToken, organizerCode } = await postJson<{
        joinCode: string; sessionToken: string; organizerCode: string;
      }>('/api/events/demo', {});
      // The same two keys the landing page writes. The session token is what makes this feel like a
      // scan rather than a signup: without it the camera opens on a "what's your name?" prompt.
      try {
        localStorage.setItem('session_' + joinCode, sessionToken);
        if (organizerCode) localStorage.setItem('demo_org_' + joinCode, organizerCode);
      } catch { /* private mode — the camera still works, the host link just is not offered */ }
      // replace(), not href: the demo is spent once it is created. A back-button press must return
      // to wherever they came from, not re-run this page and mint a second event.
      location.replace('/join/' + joinCode);
    } catch {
      failed = true;
    } finally {
      busy = false;
    }
  }

  onMount(start);
</script>

<svelte:head>
  <title>Try Snapdini</title>
  <!-- Never indexed: the canonical robots.txt disallows it too, but a crawler that ignores robots
       still must not put a URL that creates an event into a search index. -->
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="wrap">
  {#if failed}
    <div class="mark"><Logo word /></div>
    <h1>We couldn’t start the demo</h1>
    <p>Something went wrong setting up a camera for you. It is worth another go.</p>
    <div class="acts">
      <!-- A button, not <a href="/demo">: this IS /demo, so SvelteKit treats the link as the same
           route, never remounts the component, and onMount would not fire again. -->
      <button class="btn primary" on:click={start} disabled={busy}>
        {busy ? 'Starting…' : 'Try again'}
      </button>
      <a class="btn ghost" href="/">Back to the site</a>
    </div>
  {:else}
    <Loading label="Setting up your camera…" />
  {/if}
</main>

<style>
  .wrap { min-height: 70vh; display: flex; flex-direction: column; align-items: center;
          justify-content: center; gap: 12px; padding: 32px 24px; text-align: center; }
  .mark { margin-bottom: 4px; }
  h1 { margin: 0; font-size: 1.3rem; }
  p { margin: 0; color: var(--text-muted); max-width: 34ch; line-height: 1.5; }
  .acts { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; margin-top: 8px; }
  .btn { display: inline-block; padding: 11px 18px; border: 1px solid transparent;
         border-radius: var(--radius-sm); font-weight: 700; font-size: 0.92rem;
         text-decoration: none; cursor: pointer; }
  .btn.primary { background: var(--accent-fill); color: var(--accent-ink, #111); }
  .btn.ghost { background: transparent; color: var(--text); border-color: var(--border); }
</style>
