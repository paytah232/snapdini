<script lang="ts">
  // The one site footer. Previously every page hand-rolled its own, so the links drifted: home had
  // GitHub + coffee, /pricing and the use-case pages had GitHub only, /dashboard had coffee only,
  // and /contact, /login, /signup, /terms and /privacy had neither.
  //
  // `compact` renders the single-line variant the dashboard used. `showSupport` exists so the
  // capture flow and conversion pages can drop the coffee link — nothing should compete with
  // "take a photo" or "complete checkout".
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { getConfig } from '$lib/api';
  import { usecaseLinks } from '$lib/usecases';

  export let loggedIn = false;
  export let compact = false;
  export let showSupport = true;
  export let showNav = true;
  /** "Popular uses" row: real internal links to the use-case landing pages. Off by default — it
   *  belongs on marketing pages, not the capture flow or the dashboard, where it is just noise. */
  export let showUses = false;

  let version = '';
  onMount(async () => {
    try { version = (await getConfig()).version; } catch { /* offline — footer still renders */ }
  });

  const GITHUB = 'https://github.com/paytah232/snapdini';
  const COFFEE = 'https://buymeacoffee.com/paytah232';
</script>

{#if compact}
  <div class="version">
    © 2026 Snapdini{#if version} · v{version}{/if} ·
    <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> ·
    <a href={GITHUB} target="_blank" rel="noopener noreferrer">GitHub</a>
    {#if showSupport} · <a href={COFFEE} target="_blank" rel="noopener noreferrer">☕ Buy me a coffee</a>{/if}
  </div>
{:else}
  <footer>
    <div class="fl">
      {#if showNav}
        {#if loggedIn}<a href="/dashboard">My events</a>{:else}<a href="/login">Sign in</a>{/if}
        <a href="/signup">Start free</a>
        <a href="/pricing">Pricing</a>
        <a href="/contact">Contact</a>
      {/if}
      <a href="/terms">Terms</a>
      <a href="/privacy">Privacy</a>
      {#if $page.data.analyticsEnabled}<a href="/?consent=1">Your Privacy Choices</a>{/if}
      <a href={GITHUB} target="_blank" rel="noopener noreferrer">GitHub</a>
      {#if showSupport}<a href={COFFEE} target="_blank" rel="noopener noreferrer">☕ Buy me a coffee</a>{/if}
      <slot />
    </div>
    {#if showUses}
      <nav class="uses" aria-label="Popular uses">
        <span class="uses-label">Popular uses</span>
        {#each usecaseLinks as u}<a href={`/${u.slug}`}>{u.label}</a>{/each}
      </nav>
    {/if}
    <span class="v">© 2026 Snapdini{version ? ` · v${version}` : ''}</span>
  </footer>
{/if}

<style>
  footer { border-top: 1px solid var(--border); max-width: 1080px; margin: 40px auto 0; padding: 30px 24px;
    display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
  .fl { display: flex; gap: 18px; font-size: .85rem; color: var(--text-muted); align-items: center; flex-wrap: wrap; }
  .fl a, .fl :global(.linklike) { color: var(--text-muted); text-decoration: none; background: none; border: none; cursor: pointer; font: inherit; }
  .fl a:hover, .fl :global(.linklike):hover { color: var(--text); }
  .uses { flex-basis: 100%; order: 3; display: flex; flex-wrap: wrap; gap: 6px 14px; align-items: baseline;
    padding-top: 16px; margin-top: 4px; border-top: 1px solid var(--border); font-size: .8rem; }
  .uses-label { color: var(--text); font-weight: 600; margin-right: 4px; }
  .uses a { color: var(--text-muted); text-decoration: none; }
  .uses a:hover { color: var(--text); text-decoration: underline; }
  .v { font-size: .72rem; color: var(--text-muted); font-family: var(--font-mono); }
  .version { margin-top: 28px; text-align: center; font-size: .75rem; color: var(--text-muted); }
  .version a { color: var(--text-muted); text-decoration: none; }
  .version a:hover { color: var(--text); }
</style>
