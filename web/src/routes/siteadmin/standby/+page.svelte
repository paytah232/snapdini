<script lang="ts">
  /* The failover standby, on a page of its own.
   *
   *  It used to be a panel inside the site-admin console. It moved out because it is the one screen
   *  there that can change infrastructure, and because it is opened from an alert on a phone,
   *  mid-incident, where scrolling a long console to find it is the wrong first step. Alerts link
   *  here; /siteadmin#standby (the old address) redirects here. */
  import { onMount } from 'svelte';
  import SiteNav from '$lib/components/SiteNav.svelte';
  import Loading from '$lib/components/Loading.svelte';
  import AdminBanner from '$lib/components/AdminBanner.svelte';
  import StandbyPanel from '$lib/components/StandbyPanel.svelte';
  import { getMe } from '$lib/api';
  import type { User } from '$lib/types';

  let loading = true;
  let user: User | null = null;
  let error = '';

  onMount(async () => {
    try { user = (await getMe()).user; } catch (e) { error = (e as Error).message; }
    loading = false;
  });
</script>

<svelte:head><title>Failover standby · Snapdini</title></svelte:head>

<SiteNav admin />

<main class="wrap">
  {#if loading}
    <Loading />
  {:else if error}
    <h1>Failover standby</h1>
    <p class="err">{error}</p>
  {:else if !user}
    <h1>Failover standby</h1>
    <p class="muted">You need to <a href="/app">sign in</a> as an admin to view this.</p>
  {:else if !user.isAdmin}
    <h1>Failover standby</h1>
    <p class="muted">This area is for site administrators only.</p>
  {:else}
    <AdminBanner>🎩 SITE ADMIN MODE — platform-wide controls</AdminBanner>
    <nav class="crumbs" aria-label="Site admin">
      <a href="/siteadmin">← Site admin</a>
      <a href="/dashboard">My events</a>
    </nav>
    <StandbyPanel />
  {/if}
</main>

<style>
  .wrap { max-width: 860px; margin: 0 auto; padding: 0 16px 64px; }
  .muted { color: var(--text-muted); }
  .err { color: #c0392b; }
  .crumbs { display: flex; justify-content: space-between; gap: 12px; padding-top: 4px; font-size: .9rem; font-weight: 700; }
  .crumbs a { color: var(--accent, #b08b08); text-decoration: none; }
  .crumbs a:hover { text-decoration: underline; }
</style>
