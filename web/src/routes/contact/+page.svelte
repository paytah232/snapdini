<script lang="ts">
  import { onMount } from 'svelte';
  import { getConfig, postJson } from '$lib/api';
  import { showToast, showSuccess } from '$lib/toast';
  import Logo from '$lib/components/Logo.svelte';

  let name = '';
  let email = '';
  let message = '';
  let sending = false;
  let sent = false;
  let supportEmail: string | null = null;

  onMount(async () => {
    try { supportEmail = (await getConfig()).supportEmail; } catch { /* offline */ }
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (sending) return;
    if (!message.trim()) { showToast('Please enter a message', true); return; }
    sending = true;
    try {
      await postJson('/api/contact', { name, email, message });
      sent = true;
      showSuccess('Thanks — we’ll be in touch!');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Could not send — try again', true);
    } finally {
      sending = false;
    }
  }
</script>

<svelte:head><title>Contact — Snapdini</title></svelte:head>

<main>
  <div class="card">
    <a class="brand" href="/"><Logo /></a>
    <h1>Contact us</h1>
    <p class="sub">Questions, ideas, or trouble? Send us a note and we’ll get back to you.</p>

    {#if sent}
      <div class="done">
        <span class="big" aria-hidden="true">✉️</span>
        <p>Message sent — thanks! We’ll reply soon.</p>
        <a class="btn ghost block" href="/">← Back home</a>
      </div>
    {:else}
      <form on:submit={submit}>
        <label for="c-name">Your name</label>
        <input id="c-name" type="text" autocomplete="name" maxlength="80" bind:value={name} placeholder="Alex Rivera" />

        <label for="c-email">Your email</label>
        <input id="c-email" type="email" inputmode="email" autocomplete="email" maxlength="200" bind:value={email} placeholder="you@example.com" />

        <label for="c-msg">Message</label>
        <textarea id="c-msg" rows="5" maxlength="5000" bind:value={message} placeholder="How can we help?"></textarea>

        <button class="btn primary" type="submit" disabled={sending}>{sending ? 'Sending…' : 'Send message'}</button>
      </form>
      {#if supportEmail}
        <p class="alt">Or email us directly at <a href={`mailto:${supportEmail}`}>{supportEmail}</a></p>
      {/if}
    {/if}
  </div>
</main>

<style>
  main { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .card { width: 100%; max-width: 440px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 16px; padding: 32px; }
  .brand { display: inline-flex; align-items: center; gap: 8px; font-weight: 800; text-decoration: none; color: var(--text); margin-bottom: 18px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  .sub { color: var(--text-muted); margin: 0 0 22px; font-size: 0.9rem; }
  label { display: block; font-size: 0.8rem; color: var(--text-muted); margin: 14px 0 5px; }
  input, textarea { width: 100%; padding: 11px 13px; background: var(--bg); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text); font-size: 0.95rem; font-family: var(--font); resize: vertical; }
  input:focus, textarea:focus { outline: 2px solid var(--accent); border-color: transparent; }
  .btn { display: inline-block; width: 100%; margin-top: 20px; padding: 12px; border: 1px solid transparent;
    border-radius: var(--radius-sm); font-weight: 700; font-size: 0.95rem; cursor: pointer; font: inherit; text-align: center; text-decoration: none; }
  .btn.primary { background: var(--accent); color: var(--accent-ink, #111); }
  .btn.ghost { background: transparent; color: var(--text); border-color: var(--border); }
  .btn.block { display: block; }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .alt { margin-top: 18px; text-align: center; font-size: 0.85rem; color: var(--text-muted); }
  .alt a { color: var(--accent); text-decoration: none; }
  .done { text-align: center; padding: 16px 0; }
  .done .big { font-size: 44px; display: block; margin-bottom: 12px; }
  .done p { color: var(--text-muted); margin-bottom: 20px; }
</style>
