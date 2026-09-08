<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/stores';
  import { getConfig, getMe, postJson } from '$lib/api';
  import Turnstile from '$lib/components/Turnstile.svelte';
  import { track } from '$lib/analytics';
  import { fireLead } from '$lib/adtracking';
  import { hasFreshDraft } from '$lib/eventDraft';

  let signupStarted = false;
  const startedSignup = () => { if (!signupStarted) { signupStarted = true; track('signup_started'); } };
  import Logo from '$lib/components/Logo.svelte';
  import SiteFooter from '$lib/components/SiteFooter.svelte';

  // Same-origin relative destination after auth (no open-redirect); default dashboard.
  $: nextDest = (() => { const n = $page.url.searchParams.get('next'); return n && n.startsWith('/') && !n.startsWith('//') ? n : '/dashboard'; })();
  // Came from a part-filled event form, so the page should read as the next step of that rather
  // than a cold sign-up.
  $: fromCreate = nextDest === '/app';

  let name = '';
  let email = '';
  let password = '';
  let turnstileToken = '';
  let turnstile: Turnstile;
  let submitting = false;

  let googleEnabled = false;
  let version = '';

  // Inline message (mirrors the old #msg element).
  let msg: { text: string; link?: { href: string; label: string }; ok: boolean } | null = null;

  // ── Waiting for verification ───────────────────────────────────────────────
  // Once the account exists there is nothing left to fill in, so the form is replaced outright.
  // Leaving name/email/password/Turnstile/"Create account" on screen read as if nothing had
  // happened and invited a second submission.
  let awaitingEmail = '';            // truthy ⇒ show the verification card instead of the form
  let pendingToken = '';
  let devVerifyLink = '';
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pollStop = 0;                  // wall-clock deadline; the token outlives nothing
  let verifyExpired = false;
  let resending = false;

  // Verification usually happens on ANOTHER DEVICE — you sign up on a laptop and open the email on
  // your phone. That device gets the session and the redirect; this one is where the half-finished
  // event actually lives. So this browser asks the server whether the address has been proven yet,
  // and picks the journey back up itself when it has.
  const POLL_MS = 3000;
  function startPolling(token: string, ttlMs: number) {
    pendingToken = token;
    pollStop = Date.now() + Math.max(60_000, ttlMs || 0);
    schedule();
  }
  function schedule() {
    clearTimeout(pollTimer);
    if (!pendingToken || Date.now() > pollStop) { if (pendingToken) verifyExpired = true; return; }
    pollTimer = setTimeout(poll, POLL_MS);
  }
  async function poll() {
    if (!pendingToken) return;
    try {
      const r = await fetch(`/api/auth/pending?token=${encodeURIComponent(pendingToken)}`);
      const d = (await r.json()) as { verified?: boolean; expired?: boolean; marker?: string };
      if (d.expired) { pendingToken = ''; verifyExpired = true; return; }
      if (d.verified) { pendingToken = ''; await onVerified(d.marker); return; }
    } catch { /* offline or a blip — just try again */ }
    schedule();
  }
  async function onVerified(marker?: string) {
    clearTimeout(pollTimer);
    // Fire the conversion from THIS device. It is the one that saw the ad, so it is the one holding
    // the click id — the verifying phone may have neither. Both use the same marker as the
    // de-duplication id, so the platforms count one sign-up, not two.
    if (marker) fireLead($page.data, 'signup', marker);
    // Straight back to the event they were building, if there still is one. If another tab already
    // claimed the draft, the dashboard is the honest destination rather than an empty form.
    await goto(hasFreshDraft() ? '/app' : nextDest);
  }
  onDestroy(() => clearTimeout(pollTimer));

  async function resend() {
    if (resending || !awaitingEmail) return;
    resending = true;
    try {
      const d = await postJson<{ devLink?: string }>('/api/auth/magic-link', { email: awaitingEmail });
      if (d.devLink) devVerifyLink = d.devLink;
      msg = { text: 'Sent again — check your inbox (and your spam folder).', ok: true };
    } catch (e) {
      msg = { text: e instanceof Error ? e.message : 'Could not resend just now', ok: false };
    } finally { resending = false; }
  }

  onMount(async () => {
    try {
      const { user, googleEnabled: g } = await getMe();
      if (user) { goto(nextDest); return; }
      googleEnabled = g;
    } catch { /* offline / not logged in */ }
    try { version = (await getConfig()).version; } catch { /* offline */ }
  });

  async function register(e: SubmitEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!name.trim()) { msg = { text: 'Please enter your name so we can address you properly.', ok: false }; return; }
    submitting = true;
    msg = null;
    try {
      const data = await postJson<{ devLink?: string; pendingToken?: string; pendingTtlMs?: number }>(
        '/api/auth/register',
        { name: name.trim(), displayName: name.trim(), email, password, 'cf-turnstile-response': turnstileToken },
      );
      // The account exists now; there is nothing left to type. Swap the card over rather than
      // leaving a filled-in form and a "Create account" button sitting there.
      awaitingEmail = email;
      devVerifyLink = data.devLink || '';
      msg = null;
      if (data.pendingToken) startPolling(data.pendingToken, data.pendingTtlMs || 0);
      // No sign-up conversion here. It fires once the address is actually verified (the dashboard
      // handles it), so a spoofed address that never opens its inbox is never counted as a sign-up.
    } catch (err) {
      msg = { text: err instanceof Error ? err.message : 'Sign-up failed', ok: false };
    } finally {
      submitting = false;
      turnstile?.reset();   // Turnstile tokens are single-use
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

<svelte:head><title>Sign up — Snapdini</title></svelte:head>

<main>
  <div class="card">
    <a class="brand" href="/"><Logo /></a>
    {#if awaitingEmail}
      <h1>Check your email</h1>
      <p class="sub">We've sent a confirmation link to <b class="to">{awaitingEmail}</b>. Open it and
      your account is ready.{#if fromCreate} We'll bring you straight back here to finish your event.{/if}</p>
    {:else if fromCreate}
      <h1>Your event is almost ready</h1>
      <p class="sub">Create your account and confirm your email — we'll take you straight back to
      finish setting up your event, exactly as you left it.</p>
    {:else}
      <h1>Now you see them, now you don't</h1>
      <p class="sub">Snapdini is the shared event camera with a disappearing act — every photo vanishes the moment it's snapped, then reappears all at once, like magic, when your event ends. ✨</p>
    {/if}

    {#if awaitingEmail}
      <!-- Nothing here to fill in: the account exists and the only remaining step happens in an
           inbox, which may well be on a different device. -->
      <div class="verify">
        {#if verifyExpired}
          <p class="vwait">The link has expired. Send a fresh one and we'll carry on.</p>
        {:else}
          <p class="vwait"><span class="spin" aria-hidden="true"></span> Waiting for you to confirm…</p>
          <p class="vhint">You can open the link on <b>any device</b> — your phone is fine. This page
          is watching, and will pick things up here the moment you do.</p>
        {/if}
        {#if devVerifyLink}
          <a class="btn" href={devVerifyLink}>Dev: click to verify →</a>
        {/if}
        <button class="btn ghost" type="button" on:click={resend} disabled={resending}>
          {resending ? 'Sending…' : 'Resend the email'}
        </button>
        <button class="btn ghost" type="button"
                on:click={() => { awaitingEmail = ''; pendingToken = ''; verifyExpired = false; msg = null; }}>
          Use a different email
        </button>
      </div>
    {:else}
    <form on:submit={register}>
      <label for="name">Your name</label>
      <!-- Fires once, on first interaction: the gap between this and signup_submitted is the
           form abandonment that nothing currently measures. -->
      <input id="name" type="text" autocomplete="name" placeholder="e.g. Alex Rivera" maxlength="80" required
             bind:value={name} on:focus={startedSignup} />

      <label for="email">Email</label>
      <input id="email" type="email" autocomplete="email" placeholder="you@example.com" required bind:value={email} />

      <label for="password">Password</label>
      <input id="password" type="password" autocomplete="new-password" placeholder="At least 8 characters" required bind:value={password} />

      <Turnstile bind:token={turnstileToken} bind:this={turnstile} action="register" />

      <button class="btn" type="submit" disabled={submitting}>
        {submitting ? 'Creating…' : 'Create account'}
      </button>
    </form>

    <button class="btn ghost" type="button" on:click={magicLink}>Email me a sign-in link instead</button>

    {#if googleEnabled}
      <div class="divider">or</div>
      <a class="btn ghost block" href="/api/auth/google">Continue with Google</a>
    {/if}
    {/if}

    {#if msg}
      <div class="msg" class:ok={msg.ok} class:err={!msg.ok}>
        {msg.text}
        {#if msg.link}<br /><br /><a href={msg.link.href}>{msg.link.label}</a>{/if}
      </div>
    {/if}

    <div class="foot">Already have an account? <a href="/login">Sign in</a></div>
  </div>
  <div class="version">{version ? 'Snapdini v' + version : ''}</div>
</main>

<SiteFooter showSupport={false} />

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
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .sub { color: var(--text-muted); margin: 0 0 24px; font-size: 0.9rem; }
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

  .to { word-break: break-all; }
  .verify { display: flex; flex-direction: column; gap: 10px; }
  .vwait { display: flex; align-items: center; gap: 9px; margin: 2px 0 0; font-weight: 600; }
  .vhint { margin: 0 0 4px; font-size: .86rem; color: var(--text-muted); line-height: 1.45; }
  /* A quiet, continuous signal that the page really is watching — the whole point of the state. */
  .spin {
    width: 14px; height: 14px; flex: none; border-radius: 50%;
    border: 2px solid var(--border); border-top-color: var(--text);
    animation: spin 900ms linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) {
    .spin { animation: none; border-top-color: var(--border); }
  }
</style>
