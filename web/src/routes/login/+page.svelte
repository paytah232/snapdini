<script lang="ts">
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { getConfig, getMe, postJson } from '$lib/api';
  import Logo from '$lib/components/Logo.svelte';

  // Post-login destination — only same-origin relative paths (no open-redirect); default dashboard.
  $: nextDest = (() => { const n = $page.url.searchParams.get('next'); return n && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard'; })();

  let email = '';
  let password = '';
  let submitting = false;

  let googleEnabled = false;
  let version = '';

  // Inline message (mirrors the old #msg element).
  let msg: { text: string; link?: { href: string; label: string }; ok: boolean } | null = null;
  let needsVerification = false;

  onMount(async () => {
    try {
      const { user, googleEnabled: g } = await getMe();
      if (user) { goto(nextDest); return; }
      googleEnabled = g;
    } catch { /* offline / not logged in */ }
    try { version = (await getConfig()).version; } catch { /* offline */ }
  });

  async function login(e: SubmitEvent) {
    e.preventDefault();
    if (submitting) return;
    submitting = true;
    msg = null;
    needsVerification = false;
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 403 && data.needsVerification) {
          needsVerification = true;
          msg = { text: "Please verify your email first — check your inbox for the link. Didn't get it? Tap “Resend my sign-in link” below.", ok: false };
        } else {
          msg = { text: data.error || 'Sign-in failed', ok: false };
        }
        return;
      }
      goto(nextDest);
    } catch (err) {
      msg = { text: err instanceof Error ? err.message : 'Sign-in failed', ok: false };
    } finally {
      submitting = false;
    }
  }

  async function magicLink() {
    if (!email) { msg = { text: 'Enter your email above first', ok: false }; return; }
    msg = null;
    try {
      const data = await postJson<{ devLink?: string }>('/api/auth/magic-link', { email });
      const text = data.devLink ? 'Sign-in link (dev):' : 'Check your email for a sign-in link.';
      msg = data.devLink
        ? { text, link: { href: data.devLink, label: 'Dev: click to sign in →' }, ok: true }
        : { text, ok: true };
    } catch (err) {
      msg = { text: err instanceof Error ? err.message : 'Could not send link', ok: false };
    }
  }
</script>

<svelte:head><title>Sign in — Snapdini</title></svelte:head>

<main>
  <div class="card">
    <a class="brand" href="/"><Logo /></a>
    <h1>Welcome back</h1>

    <form on:submit={login}>
      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="email" placeholder="you@example.com" required bind:value={email} />

      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="current-password" placeholder="Your password" required bind:value={password} />

      <button class="btn" type="submit" disabled={submitting}>
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>

    {#if needsVerification}
      <button class="btn ghost" type="button" on:click={magicLink}>Resend my sign-in link</button>
    {:else}
      <button class="btn ghost" type="button" on:click={magicLink}>Email me a sign-in link</button>
    {/if}

    {#if googleEnabled}
      <div class="divider">or</div>
      <a class="btn ghost block" href="/api/auth/google">Continue with Google</a>
    {/if}

    {#if msg}
      <div class="msg" class:ok={msg.ok} class:err={!msg.ok}>
        {msg.text}
        {#if msg.link}<br /><br /><a href={msg.link.href}>{msg.link.label}</a>{/if}
      </div>
    {/if}

    <div class="foot">New here? <a href="/signup">Create an account</a></div>
  </div>
  <div class="version">{version ? 'Snapdini v' + version : ''}</div>
</main>

<style>
  main {
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .card {
    width: 100%;
    max-width: 400px;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 32px;
  }
  .brand {
    display: inline-block;
    background: var(--accent);
    color: var(--accent-ink, #111);
    padding: 5px 11px;
    border-radius: 7px;
    font-weight: 800;
    font-size: 1rem;
    margin-bottom: 20px;
    text-decoration: none;
  }
  h1 { font-size: 1.5rem; margin: 0 0 24px; }
  label { display: block; font-size: 0.8rem; color: var(--text-muted); margin: 14px 0 5px; }
  input {
    width: 100%;
    padding: 11px 13px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.95rem;
    font-family: var(--font);
  }
  input:focus { outline: 2px solid var(--accent); border-color: transparent; }
  .btn {
    width: 100%;
    margin-top: 20px;
    padding: 12px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    font-weight: 700;
    font-size: 0.95rem;
    cursor: pointer;
    background: var(--accent);
    color: var(--accent-ink, #111);
    font-family: var(--font);
  }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .btn.ghost { background: transparent; color: var(--text); border-color: var(--border); margin-top: 10px; }
  .btn.ghost:hover { border-color: var(--accent); }
  .btn.block { display: block; text-align: center; text-decoration: none; }
  .divider {
    display: flex;
    align-items: center;
    gap: 12px;
    color: var(--text-muted);
    font-size: 0.75rem;
    margin: 18px 0;
  }
  .divider::before, .divider::after { content: ''; flex: 1; height: 1px; background: var(--border); }
  .msg {
    margin-top: 16px;
    padding: 11px 13px;
    border-radius: var(--radius-sm);
    font-size: 0.85rem;
  }
  .msg.err { background: color-mix(in srgb, var(--danger) 22%, var(--surface)); color: var(--danger); }
  .msg.ok { background: color-mix(in srgb, var(--success) 22%, var(--surface)); color: var(--success); }
  .msg a { color: var(--accent); text-decoration: none; }
  .foot { margin-top: 22px; text-align: center; font-size: 0.85rem; color: var(--text-muted); }
  .foot a { color: var(--accent); text-decoration: none; }
  .version {
    margin-top: 18px;
    font-size: 0.72rem;
    color: var(--text-muted);
    letter-spacing: 0.03em;
    font-family: var(--font-mono);
  }
</style>
