<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { modalFocus } from '$lib/ui';

  // Where it was opened from (e.g. "Manage page", "Camera") — helps us triage in Site admin.
  export let context = '';

  const dispatch = createEventDispatcher();
  let kind: 'bug' | 'feedback' | 'suggestion' = 'feedback';
  let message = '';
  let emailAddr = '';
  let file: File | null = null;
  let busy = false;
  let done = false;
  let err = '';

  function pick(e: Event) { file = (e.currentTarget as HTMLInputElement).files?.[0] || null; }

  async function submit() {
    if (busy) return;
    if (!message.trim()) { err = 'Please describe it first.'; return; }
    busy = true; err = '';
    try {
      const fd = new FormData();
      fd.append('kind', kind);
      fd.append('message', message.trim());
      if (emailAddr.trim()) fd.append('email', emailAddr.trim());
      if (context) fd.append('context', context);
      if (file) fd.append('screenshot', file);
      const r = await fetch('/api/contact', { method: 'POST', body: fd, credentials: 'same-origin' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d as { error?: string }).error || 'Could not send — please try again.');
      done = true;
    } catch (e) { err = e instanceof Error ? e.message : 'Could not send.'; }
    finally { busy = false; }
  }
</script>

<svelte:window on:keydown={(e) => { if (e.key === 'Escape') dispatch('close'); }} />
<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="fb-backdrop" on:click|self={() => dispatch('close')} role="dialog" aria-modal="true" aria-label="Send feedback">
  <div class="fb-card" use:modalFocus tabindex="-1">
    {#if done}
      <h3>Thanks! 🙏</h3>
      <p class="fb-sub">Your {kind} has been sent — we really appreciate it.</p>
      <div class="fb-actions"><button class="fb-btn primary" on:click={() => dispatch('close')}>Close</button></div>
    {:else}
      <h3>Report a problem or share feedback</h3>
      <div class="fb-kinds">
        <button type="button" class:on={kind === 'bug'} on:click={() => (kind = 'bug')}>🐞 Bug</button>
        <button type="button" class:on={kind === 'feedback'} on:click={() => (kind = 'feedback')}>💬 Feedback</button>
        <button type="button" class:on={kind === 'suggestion'} on:click={() => (kind = 'suggestion')}>💡 Suggestion</button>
      </div>
      <textarea bind:value={message} rows="4" placeholder="What happened, or what would make Snapdini better?"></textarea>
      <input class="fb-input" type="email" bind:value={emailAddr} placeholder="Your email (optional — so we can reply)" />
      <label class="fb-file">
        <input type="file" accept="image/*" on:change={pick} />
        <span>{file ? `📎 ${file.name}` : '📎 Attach a screenshot (optional)'}</span>
      </label>
      {#if err}<p class="fb-err">{err}</p>{/if}
      <div class="fb-actions">
        <button class="fb-btn" type="button" on:click={() => dispatch('close')}>Cancel</button>
        <button class="fb-btn primary" type="button" on:click={submit} disabled={busy}>{busy ? 'Sending…' : 'Send'}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .fb-backdrop { position: fixed; inset: 0; z-index: 400; background: rgba(0,0,0,.6);
    display: flex; align-items: center; justify-content: center; padding: 18px; }
  .fb-card { width: min(460px, 100%); background: var(--surface, #191713); color: var(--text, #f4efe4);
    border: 1px solid var(--border, #2b271f); border-radius: 16px; padding: 22px; box-shadow: 0 24px 60px rgba(0,0,0,.5); }
  .fb-card h3 { margin: 0 0 12px; font-size: 1.15rem; }
  .fb-sub { color: var(--text-muted, #a39b8c); margin: 0 0 16px; }
  .fb-kinds { display: flex; gap: 8px; margin-bottom: 12px; }
  .fb-kinds button { flex: 1; padding: 9px 6px; border-radius: 9px; border: 1px solid var(--border, #3a3630);
    background: transparent; color: var(--text, #f4efe4); cursor: pointer; font: inherit; font-size: .85rem; }
  .fb-kinds button.on { border-color: var(--accent, #f0b429); background: color-mix(in srgb, var(--accent, #f0b429) 16%, transparent); }
  textarea, .fb-input { width: 100%; box-sizing: border-box; background: var(--bg, #100f0d); color: var(--text, #f4efe4);
    border: 1px solid var(--border, #3a3630); border-radius: 10px; padding: 10px 12px; font: inherit; margin-bottom: 10px; resize: vertical; }
  .fb-file { display: block; border: 1px dashed var(--border, #3a3630); border-radius: 10px; padding: 10px 12px;
    color: var(--text-muted, #a39b8c); cursor: pointer; font-size: .88rem; margin-bottom: 12px; }
  .fb-file input { display: none; }
  .fb-err { color: #ff6b6b; font-size: .85rem; margin: 0 0 10px; }
  .fb-actions { display: flex; gap: 8px; justify-content: flex-end; }
  .fb-btn { padding: 9px 18px; border-radius: 9px; border: 1px solid var(--border, #3a3630);
    background: transparent; color: var(--text, #f4efe4); cursor: pointer; font: inherit; font-weight: 600; }
  .fb-btn.primary { background: var(--accent, #f0b429); color: var(--accent-ink, #111); border-color: transparent; }
  .fb-btn:disabled { opacity: .6; cursor: default; }
</style>
