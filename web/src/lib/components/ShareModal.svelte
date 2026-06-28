<script lang="ts">
  import { createEventDispatcher } from 'svelte';
  import { modalFocus } from '$lib/ui';
  import { showToast, showSuccess } from '$lib/toast';
  import { updateShare, type ShareKind } from '$lib/events';

  export let code: string;
  export let orgCode: string;
  // The share to show — from createShare() or an existing row.
  export let share: { id: string; kind: ShareKind; label: string; slug: string | null; url: string; count?: number | null };

  const dispatch = createEventDispatcher<{ close: void; changed: void }>();

  let label = share.label;
  let slug = share.slug ?? '';
  let url = share.url;
  let saving = false;

  $: origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
  const kindText = (k: ShareKind, n?: number | null) =>
    k === 'favourites' ? 'Your favourite photos' : k === 'selected' ? `${n ?? 'the'} selected photo${n === 1 ? '' : 's'}` : 'The whole gallery';
  // Clean a custom URL the same way the server does, so what the organizer sees is what they get.
  const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  $: cleanSlug = slugify(slug);
  $: previewUrl = cleanSlug ? `${origin}/s/${cleanSlug}` : url;
  // 'all' / 'favourites' shares always exclude rejected (binned) photos.
  $: excludesRejected = share.kind === 'all' || share.kind === 'favourites';

  async function copy() {
    try { await navigator.clipboard.writeText(url); showToast('Link copied'); }
    catch { showToast(url, false); }
  }
  async function nativeShare() {
    const nav = navigator as Navigator & { share?: (d: { title?: string; url?: string }) => Promise<void> };
    if (nav.share) { try { await nav.share({ title: label, url }); } catch { /* cancelled */ } }
    else copy();
  }
  async function save() {
    saving = true;
    try {
      const r = await updateShare(code, orgCode, share.id, { label: label.trim() || undefined, slug: cleanSlug || undefined });
      url = r.url; slug = r.slug ?? ''; label = r.label;
      showSuccess('Saved');
      dispatch('changed');
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not save', true); }
    finally { saving = false; }
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
<div class="back" on:click|self={() => dispatch('close')} role="dialog" aria-modal="true" aria-label="Share">
  <div class="sheet" tabindex="-1" use:modalFocus>
    <div class="head"><span>📤 Share</span><button class="x" on:click={() => dispatch('close')} aria-label="Close">✕</button></div>

    <p class="sum">Sharing <b>{kindText(share.kind, share.count)}</b>. Anyone with the link can view — no account needed.{#if excludesRejected} <b>Rejected photos are never included.</b>{/if}</p>

    <label class="fld"><span>Name</span>
      <input bind:value={label} maxlength="80" placeholder="e.g. Sam &amp; Riley's wedding" />
      <span class="sub-hint">Shows when the link is previewed — in messages, chat, socials.</span>
    </label>
    <div class="fld"><span>Custom link <small>(optional)</small></span>
      <div class="urlrow"><span class="origin">/s/</span><input class="slug" bind:value={slug} placeholder="leave blank for the default" /></div>
      <div class="slug-row">
        <button class="mini" type="button" on:click={() => (slug = slugify(label))}>↩ Use the name</button>
        {#if slug && cleanSlug !== slug.trim()}<span class="sub-hint">→ will save as <b>{cleanSlug || '(default)'}</b></span>{/if}
      </div>
    </div>
    <button class="btn ghost sm" on:click={save} disabled={saving}>{saving ? 'Saving…' : 'Save name & link'}</button>

    <div class="linkbox"><span class="link">{previewUrl}</span></div>
    <div class="actions">
      <button class="btn primary" on:click={copy}>🔗 Copy link</button>
      <button class="btn ghost" on:click={nativeShare}>📤 Share…</button>
      <a class="btn ghost" href={url} target="_blank" rel="noopener">↗ View</a>
    </div>
    <p class="hint">Manage all your shared links any time from the event's <b>Shared links</b> section.</p>
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 80; padding: 16px; }
  .sheet { width: 100%; max-width: 460px; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 20px; }
  .head { display: flex; align-items: center; justify-content: space-between; font-weight: 800; margin-bottom: 12px; }
  .x { background: none; border: none; color: var(--text-muted); font-size: 1.1rem; cursor: pointer; }
  .sum { font-size: 0.86rem; color: var(--text-muted); margin: 0 0 16px; line-height: 1.5; }
  .fld { display: block; font-size: 0.76rem; color: var(--text-muted); margin-bottom: 10px; }
  .fld > span { display: block; margin-bottom: 4px; }
  .fld input { width: 100%; padding: 9px 11px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font: inherit; font-size: 0.9rem; box-sizing: border-box; }
  .urlrow { display: flex; align-items: stretch; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; background: var(--surface-2); }
  .urlrow .origin { padding: 9px 4px 9px 11px; font-size: 0.82rem; color: var(--text-muted); white-space: nowrap; display: flex; align-items: center; }
  .urlrow .slug { border: none; border-radius: 0; padding-left: 0; }
  .sub-hint { display: block; margin-top: 4px; font-size: 0.7rem; color: var(--text-muted); }
  .slug-row { display: flex; align-items: center; gap: 10px; margin-top: 5px; flex-wrap: wrap; }
  .mini { background: none; border: none; color: var(--accent); font-size: 0.72rem; font-weight: 700; cursor: pointer; padding: 0; }
  .linkbox { margin: 14px 0 10px; padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .link { font-size: 0.82rem; word-break: break-all; color: var(--text); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn { font-weight: 700; border-radius: var(--radius-sm); padding: 10px 14px; font-size: 0.86rem; border: 1px solid transparent; cursor: pointer; text-decoration: none; text-align: center; }
  .btn.sm { padding: 7px 12px; font-size: 0.8rem; }
  .btn.primary { background: var(--accent); color: var(--accent-ink, #111); }
  .btn.ghost { background: transparent; color: var(--text); border-color: var(--border); }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .hint { font-size: 0.74rem; color: var(--text-muted); margin: 14px 0 0; }
</style>
