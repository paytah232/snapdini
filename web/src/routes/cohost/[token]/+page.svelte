<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import { getCohostInvite, acceptCohost, type CohostInvite } from '$lib/events';
  import { postJson } from '$lib/api';
  import { showToast } from '$lib/toast';
  import Logo from '$lib/components/Logo.svelte';

  const token = ($page.params as Record<string, string>).token ?? '';
  const next = encodeURIComponent(`/cohost/${token}`);
  let loading = true;
  let error = '';
  let invite: CohostInvite | null = null;
  let accepting = false;

  onMount(async () => {
    try { invite = await getCohostInvite(token); }
    catch (e) { error = e instanceof Error ? e.message : 'This invitation is invalid or has expired'; }
    finally { loading = false; }
  });

  async function accept() {
    accepting = true;
    try {
      const r = await acceptCohost(token);
      showToast('You’re now a co-host! 🎉');
      goto(r.joinCode ? `/admin/${r.joinCode}` : '/dashboard');
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not accept the invitation', true);
      accepting = false;
    }
  }

  // Signed in as the wrong account — sign out, then reload so they can use the invited email.
  async function switchAccount() {
    try { await postJson('/api/auth/logout', {}); } catch { /* ignore */ }
    location.reload();
  }
</script>

<svelte:head><title>Co-host invitation — Snapdini</title></svelte:head>

<main>
  <div class="card">
    <a class="brand" href="/"><Logo /></a>
    {#if loading}
      <p class="state">Loading…</p>
    {:else if error}
      <div class="state"><span class="big">🔗</span><p>{error}</p><a class="btn ghost" href="/">Go home</a></div>
    {:else if invite}
      <h1>Co-host invitation</h1>
      <p class="sub"><strong>{invite.inviter}</strong> invited you to co-host <strong>{invite.eventName}</strong>. As a co-host you can manage the event just like the owner.</p>

      <p class="sub">This invitation is for <strong>{invite.email}</strong> — you'll need to accept it from that account.</p>
      {#if invite.loggedIn && !invite.emailMatches}
        <div class="msg">You're signed in as <strong>{invite.yourEmail}</strong>, but this invite is for <strong>{invite.email}</strong>.</div>
        <button class="btn primary block" on:click={switchAccount}>Sign out & use {invite.email}</button>
      {:else if invite.loggedIn && !invite.verified}
        <div class="msg">Please <strong>verify your email</strong> first — check your inbox for the link, then reload this page to accept.</div>
      {:else if invite.loggedIn && invite.emailMatches && invite.verified}
        <button class="btn primary block" on:click={accept} disabled={accepting}>{accepting ? 'Accepting…' : 'Accept & manage event'}</button>
      {:else}
        <a class="btn primary block" href={`/signup?next=${next}`}>Create an account with {invite.email}</a>
        <a class="btn ghost block" href={`/login?next=${next}`}>I already have this account</a>
      {/if}
    {/if}
  </div>
</main>

<style>
  main { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 420px; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 32px; }
  .brand { display: inline-flex; margin-bottom: 18px; text-decoration: none; }
  h1 { font-size: 1.4rem; margin: 0 0 8px; }
  .sub { color: var(--text-muted); font-size: 0.9rem; margin: 0 0 18px; line-height: 1.5; }
  .state { text-align: center; padding: 20px; color: var(--text-muted); }
  .state .big { font-size: 40px; display: block; margin-bottom: 10px; }
  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 12px 18px; font-size: 0.95rem; cursor: pointer; border: 1px solid transparent; text-decoration: none; text-align: center; }
  .btn.block { display: block; width: 100%; margin-top: 10px; box-sizing: border-box; }
  .btn.primary { background: var(--accent); color: var(--accent-ink, #111); }
  .btn.ghost { background: transparent; color: var(--text); border-color: var(--border); }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .msg { margin-top: 8px; padding: 12px 14px; border-radius: var(--radius-sm); font-size: 0.85rem; background: color-mix(in srgb, var(--accent) 16%, var(--surface)); }
</style>
