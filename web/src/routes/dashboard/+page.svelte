<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { getMe, getConfig, postJson } from '$lib/api';
  import { getMyEvents, listMyCohostInvites, acceptCohost, type MyEvent, type MyCohostInvite } from '$lib/events';
  import { clearAllAdminCodes } from '$lib/session';
  import { showToast, showSuccess } from '$lib/toast';
  import Logo from '$lib/components/Logo.svelte';

  let loading = true;
  let loadError = false;
  let who = '';
  let isAdmin = false;
  let events: MyEvent[] = [];
  let invites: MyCohostInvite[] = [];
  let acceptingToken = '';
  let version = '';

  async function acceptInvite(inv: MyCohostInvite) {
    acceptingToken = inv.token;
    try {
      await acceptCohost(inv.token);
      showSuccess(`You're now a co-host of ${inv.eventName}`);
      invites = invites.filter((i) => i.token !== inv.token);
      ({ events } = await getMyEvents());          // the event now appears in your list — stay here
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not accept the invite', true);
    } finally {
      acceptingToken = '';
    }
  }

  type Status = { label: string; cls: string };
  function status(ev: MyEvent): Status {
    if (ev.isLocked) return { label: '🔒 Locked', cls: 'b-lock' };
    if (ev.isExpired) return { label: 'Ended', cls: 'b-end' };
    if (ev.isUpcoming) return { label: '⏰ Upcoming', cls: 'b-soon' };
    return { label: '● Live', cls: 'b-live' };
  }

  // Filters. "Active" = anything not yet ended (live, locked, or upcoming).
  // "Recent" = active OR ended within the last 14 days.
  type Filter = 'recent' | 'active' | 'all';
  const RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  let filter: Filter = 'recent';

  const isActive = (ev: MyEvent) => !ev.isExpired;
  const isRecent = (ev: MyEvent, now: number) => isActive(ev) || now - ev.expiresAt < RECENT_WINDOW_MS;

  $: now = Date.now();
  $: counts = {
    all: events.length,
    active: events.filter(isActive).length,
    recent: events.filter((e) => isRecent(e, now)).length
  };
  $: shown =
    filter === 'all' ? events
    : filter === 'active' ? events.filter(isActive)
    : events.filter((e) => isRecent(e, now));

  const manageHref = (ev: MyEvent) => `/admin/${ev.joinCode}#${encodeURIComponent(ev.organizerCode)}`;
  const galleryHref = (ev: MyEvent) => `/gallery/${ev.slug || ev.joinCode}`;
  const joinHref = (ev: MyEvent) => (ev.slug ? `/e/${ev.slug}` : `/join/${ev.joinCode}`);

  onMount(async () => {
    let user;
    try {
      ({ user } = await getMe());
    } catch {
      // Transient network/API failure — DON'T bounce a (possibly logged-in) user to /login.
      // Show the retry state instead; a real "logged out" is a successful {user:null} response.
      loadError = true; loading = false;
      return;
    }
    if (!user) {
      goto('/login');
      return;
    }
    who = user.displayName || user.email;
    isAdmin = !!user.isAdmin;
    try {
      ({ events } = await getMyEvents());
      loadError = false;
    } catch {
      events = [];
      loadError = true;
    }
    try {
      ({ invites } = await listMyCohostInvites());
    } catch {
      invites = [];
    }
    try {
      version = (await getConfig()).version;
    } catch {
      /* offline */
    }
    loading = false;
  });

  async function logout() {
    try {
      await postJson('/api/auth/logout', {});
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not sign out', true);
    }
    clearAllAdminCodes();   // signing out also revokes this browser's cached manager access
    goto('/login');
  }
</script>

<svelte:head><title>Dashboard — Snapdini</title></svelte:head>

<header>
  <a class="brand" href="/"><Logo /></a>
  <div class="who-row">
    {#if who}<span class="who">{who}</span>{/if}
    {#if isAdmin}<a class="btn ghost" href="/siteadmin">🎩 Admin</a>{/if}
    <button class="btn ghost" on:click={logout}>Sign out</button>
  </div>
</header>

<div class="wrap">
  {#if invites.length}
    <div class="invites">
      {#each invites as inv (inv.token)}
        <div class="invite">
          <div class="inv-text"><b>{inv.inviter}</b> invited you to co-host <b>{inv.eventName}</b>.</div>
          <button class="btn primary sm" on:click={() => acceptInvite(inv)} disabled={acceptingToken === inv.token}>
            {acceptingToken === inv.token ? 'Accepting…' : 'Accept invite'}
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <div class="row">
    <h1>Your events</h1>
    <button class="btn primary" on:click={() => goto('/app')}>+ New event</button>
  </div>

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if loadError}
    <div class="empty">
      <p>Couldn’t load your events.</p>
      <button class="btn primary" on:click={() => location.reload()}>Retry</button>
    </div>
  {:else if events.length === 0}
    <div class="empty">
      <p>No events yet.</p>
      <button class="btn primary" on:click={() => goto('/app')}>Create your first event</button>
    </div>
  {:else}
    <div class="filters" role="tablist" aria-label="Filter events">
      <button class="chip-btn" class:on={filter === 'recent'} on:click={() => (filter = 'recent')}>Recent <span class="n">{counts.recent}</span></button>
      <button class="chip-btn" class:on={filter === 'active'} on:click={() => (filter = 'active')}>Active <span class="n">{counts.active}</span></button>
      <button class="chip-btn" class:on={filter === 'all'} on:click={() => (filter = 'all')}>All <span class="n">{counts.all}</span></button>
    </div>

    {#if shown.length === 0}
      <div class="empty">
        <p>No {filter === 'active' ? 'active' : 'recent'} events.</p>
        <button class="btn ghost" on:click={() => (filter = 'all')}>Show all events</button>
      </div>
    {:else}
    <div class="grid">
      {#each shown as ev (ev.id)}
        <div class="ev">
          <div class="ev-head">
            <h3>{ev.name}</h3>
            <span class="badge {status(ev).cls}">{status(ev).label}</span>
            {#if ev.coHost}<span class="badge b-cohost" title="You co-host this event">Co-host</span>{/if}
          </div>
          <div class="stats">
            <div><b>{ev.participantCount}</b>guests</div>
            <div><b>{ev.photoCount}</b>photos</div>
          </div>
          <div class="links">
            <a href={manageHref(ev)}>⚙ Manage</a>
            <a href={galleryHref(ev)}>🖼 Gallery</a>
            <a href={joinHref(ev)}>📷 Join page</a>
          </div>
        </div>
      {/each}
    </div>
    {/if}
  {/if}

  <div class="version">© 2026 Snapdini{#if version} · v{version}{/if} · <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a> · <a href="https://buymeacoffee.com/paytah232" target="_blank" rel="noopener noreferrer">☕ Buy me a coffee</a></div>
</div>

<style>
  header { display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 16px 24px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 800; text-decoration: none; }
  .who-row { display: flex; align-items: center; gap: 14px; }
  .who { color: var(--text-muted); font-size: 0.85rem; }

  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 10px 18px; font-size: 0.9rem;
    border: 1px solid transparent; cursor: pointer; text-decoration: none; font: inherit; }
  .primary { background: var(--accent); color: var(--accent-ink, #111); }
  .ghost { border-color: var(--border); color: var(--text); background: transparent; }
  .ghost:hover { border-color: var(--accent); }

  .wrap { max-width: 880px; margin: 0 auto; padding: 28px 24px 60px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 20px; flex-wrap: wrap; }
  .invites { display: flex; flex-direction: column; gap: 8px; margin-bottom: 20px; }
  .invite { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;
    background: var(--surface); border: 1px solid var(--accent); border-radius: 12px; padding: 12px 14px; }
  .inv-text { font-size: 0.9rem; }
  .btn.sm { padding: 7px 12px; font-size: 0.82rem; }
  h1 { font-size: 1.5rem; margin: 0; }
  .muted { color: var(--text-muted); }

  .filters { display: flex; gap: 8px; margin-bottom: 18px; flex-wrap: wrap; }
  .chip-btn { display: inline-flex; align-items: center; gap: 7px; font: inherit; font-size: 0.82rem;
    font-weight: 700; padding: 7px 14px; border-radius: 999px; cursor: pointer;
    background: var(--surface); border: 1px solid var(--border); color: var(--text-muted); }
  .chip-btn:hover { border-color: var(--accent); }
  .chip-btn.on { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); }
  .chip-btn .n { font-size: 0.72rem; opacity: 0.7; }
  .chip-btn.on .n { opacity: 0.85; }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 16px; }
  .ev { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px; }
  .ev-head { display: flex; justify-content: space-between; align-items: start; gap: 8px; }
  .ev h3 { margin: 0 0 6px; font-size: 1.05rem; overflow-wrap: anywhere; word-break: break-word; }

  .badge { font-size: 0.7rem; font-weight: 700; padding: 2px 8px; border-radius: 20px; white-space: nowrap; }
  .b-live { background: #1a2e1a; color: #9bffb0; }
  .b-lock { background: #3a2e15; color: #f5c518; }
  .b-soon { background: #15263a; color: #7db8ff; }
  .b-end { background: #2a2a2a; color: #999; }
  .b-cohost { background: color-mix(in srgb, var(--accent) 20%, var(--surface)); color: var(--accent); }

  .stats { display: flex; gap: 18px; margin: 12px 0 14px; }
  .stats div { font-size: 0.78rem; color: var(--text-muted); }
  .stats b { display: block; font-size: 1.2rem; color: var(--text); }

  .links { display: flex; gap: 8px; flex-wrap: wrap; }
  .links a { font-size: 0.8rem; padding: 7px 12px; border-radius: 8px; border: 1px solid var(--border);
    color: var(--text); text-decoration: none; }
  .links a:hover { border-color: var(--accent); }

  .empty { text-align: center; color: var(--text-muted); padding: 48px 20px;
    border: 1px dashed var(--border); border-radius: 14px; }
  .empty p { margin: 0 0 18px; }

  .version { text-align: center; font-size: 0.72rem; color: var(--text-muted); margin-top: 36px;
    font-family: var(--font-mono); }
  .version a { color: var(--text-muted); }
  .version a:hover { color: var(--accent); }
</style>
