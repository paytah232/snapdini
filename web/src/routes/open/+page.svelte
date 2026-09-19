<script lang="ts">
  // Where the installed app lands.
  //
  // A launcher icon carries no event with it, so this page's whole job is to work out which event
  // this browser was in and go there — before anything is painted, so the guest sees their camera
  // coming back rather than a screen that looks like the app forgot them.
  //
  // The fallback is a code box rather than a bounce to the marketing page: someone opening the
  // installed app is not a visitor being introduced to the product, they are a guest trying to get
  // back into a party. It is also the only way in when the last event has been purged.
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { lastEvent } from '$lib/session';

  let resolving = true;
  let code = '';

  onMount(() => {
    const last = lastEvent();
    // replaceState so the launcher's own URL does not sit in history as a step to go "back" to.
    if (last) { void goto(last.path, { replaceState: true }); return; }
    resolving = false;
  });

  function go() {
    const c = code.trim().toUpperCase();
    if (c) void goto(`/join/${encodeURIComponent(c)}`);
  }
</script>

<svelte:head><title>Open your event · Snapdini</title><meta name="robots" content="noindex" /></svelte:head>

<main>
  {#if resolving}
    <p class="hint" role="status">Opening your event…</p>
  {:else}
    <h1>Open your event</h1>
    <p class="hint">Enter the code from your invite or the poster at the party.</p>
    <form on:submit|preventDefault={go}>
      <!-- svelte-ignore a11y-autofocus -->
      <input bind:value={code} autofocus autocapitalize="characters" autocomplete="off"
             spellcheck="false" placeholder="ABCD1234" aria-label="Event code" />
      <button type="submit" disabled={!code.trim()}>Go</button>
    </form>
  {/if}
</main>

<style>
  main {
    min-height: 100dvh; display: flex; flex-direction: column;
    align-items: center; justify-content: center; gap: 14px;
    padding: 24px; text-align: center; background: #0f0f0f; color: #f2ece0;
  }
  h1 { font-size: 1.25rem; margin: 0; }
  .hint { margin: 0; font-size: .85rem; color: rgba(242,236,224,.6); max-width: 32ch; line-height: 1.4; }
  form { display: flex; gap: 8px; width: min(320px, 100%); }
  input {
    flex: 1; min-width: 0; padding: 12px 14px; font: inherit; letter-spacing: .12em;
    text-align: center; text-transform: uppercase; border-radius: 10px;
    border: 1px solid rgba(255,255,255,.25); background: rgba(255,255,255,.06); color: inherit;
  }
  button {
    padding: 12px 20px; font: inherit; font-weight: 700; cursor: pointer;
    border: 0; border-radius: 10px; background: #f5c518; color: #111;
  }
  button:disabled { opacity: .5; cursor: default; }
</style>
