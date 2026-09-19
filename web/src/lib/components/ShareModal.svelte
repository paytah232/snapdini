<script lang="ts">
  import { createEventDispatcher, onDestroy } from 'svelte';
  import { modalFocus } from '$lib/ui';
  import { showToast, showSuccess } from '$lib/toast';
  import { updateShare, checkShareSlug, type ShareKind } from '$lib/events';
  import Toggle from '$lib/components/Toggle.svelte';
  import { slugVerdict } from '$lib/eventEdit';

  export let code: string;
  export let orgCode: string;
  // The share to show — from createShare() or an existing row.
  export let share: { id: string; kind: ShareKind; label: string; slug: string | null; url: string; count?: number | null;
                      heartsEnabled?: boolean; commentsEnabled?: boolean };

  const dispatch = createEventDispatcher<{ close: void; changed: void }>();

  let label = share.label;
  // What is actually STORED right now, so "changed" can mean something. Updated only by a successful
  // save. The button looked identical whether you had typed nothing or renamed the link completely,
  // so the one state that matters — you have edits that are not saved — was the one nothing showed.
  let savedLabel = share.label;
  /** How many people this link has already been emailed to, when the caller knows. Sharpens the
   *  warning below from "if you have shared it" to "you have, with six people" — but the warning
   *  does not depend on it, because a host who copied the link into a message left no record here. */
  export let sentCount = 0;

  /** Reactions belong to the LINK, not the event: one event can have a family gallery that wants
   *  comments and a client gallery that must not. Both start off — a link can be forwarded anywhere,
   *  so the audience is not knowable and opening a gallery up is a decision, not an inheritance. */
  let hearts = !!share.heartsEnabled;
  let comments = !!share.commentsEnabled;
  let savedHearts = hearts;
  let savedComments = comments;

  let savedSlug = share.slug ?? '';
  let slug = share.slug ?? '';
  let url = share.url;
  let saving = false;

  $: origin = (() => { try { return new URL(url).origin; } catch { return ''; } })();
  const kindText = (k: ShareKind, n?: number | null) =>
    k === 'favourites' ? 'Your favourite photos' : k === 'selected' ? `${n ?? 'the'} selected photo${n === 1 ? '' : 's'}` : 'The whole gallery';
  // Clean a custom URL the same way the server does, so what the organizer sees is what they get.
  const slugify = (s: string) => s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  $: cleanSlug = slugify(slug);

  /** The same live availability check the event's own Custom URL has had all along.
   *
   *  Without it this field could only answer by FAILING: you typed a name, pressed Save, and the
   *  server came back 409. Two fields doing the same job on one product, one of them answering as
   *  you type and the other only after you commit.
   *
   *  Debounced at 250ms and "Checking…" is set only once a request is actually in flight — the same
   *  shape the wizard arrived at, because setting it on every keystroke made a ~5ms check read as a
   *  slow one. The verdict wording is shared too (`slugVerdict`), so the two fields cannot end up
   *  describing the same answer differently. */
  let slugFeedback: { text: string; cls: 'ok' | 'err' | 'muted' } | null = null;
  let slugTimer: ReturnType<typeof setTimeout> | undefined;
  /** The value the standing question is about. Guards the async answer against arriving for a name
   *  the host has already typed past. */
  let slugAsked = '';

  /** Takes the RAW field value, and does not read `cleanSlug`.
   *
   *  It did read it, and that was a one-character lag: `cleanSlug` is a `$:` derived value, so
   *  inside an `on:input` handler — which runs before the next flush — it still holds the PREVIOUS
   *  keystroke's slug. Typing a new name over an old one therefore answered about the old one, and
   *  the field cheerfully said "✓ This is this share's URL" about a URL no longer in the box.
   *  Same shape as the bug in the upgrade panel's keep-photos control: a handler trusting derived
   *  state that has not caught up yet. Pass the value in and there is nothing to lag. */
  function onSlugInput(raw: string) {
    clearTimeout(slugTimer);
    const val = slugify(raw);
    slugAsked = val;
    if (!raw.trim()) { slugFeedback = null; return; }
    if (val.length < 2) { slugFeedback = { text: 'Too short — at least 2 characters', cls: 'err' }; return; }
    // The share's own URL is "taken", by itself. Answer that here rather than asking.
    if (val === savedSlug) { slugFeedback = slugVerdict(val, { available: false }, savedSlug, 's'); return; }
    // Clear first: whatever is on screen describes a shorter version of this name.
    slugFeedback = null;
    slugTimer = setTimeout(async () => {
      if (slugAsked !== val) return;
      slugFeedback = { text: 'Checking…', cls: 'muted' };
      try {
        const answer = await checkShareSlug(code, orgCode, val, share.id);
        if (slugAsked === val) slugFeedback = slugVerdict(val, answer, null, 's');
      } catch {
        // A check that could not run must not claim the name is free — say nothing, and let Save answer.
        if (slugAsked === val) slugFeedback = null;
      }
    }, 250);
  }
  onDestroy(() => clearTimeout(slugTimer));
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
  // Trimmed on both sides: trailing whitespace nobody can see must not make a link look edited.
  $: dirty = label.trim() !== savedLabel.trim() || cleanSlug !== savedSlug.trim()
            || hearts !== savedHearts || comments !== savedComments;
  /** Would saving BREAK a URL that is already out there?
   *
   *  Only the custom part can break. `/s/<id>` is the share's permanent address and resolveShare()
   *  matches on either the id or the slug — so the token link always works. The slug does not: the
   *  row carries one value, and overwriting it is the moment `/s/<old-name>` stops resolving and
   *  starts 404ing for anybody holding it.
   *
   *  So the warning fires on a CHANGE or a CLEAR of an existing custom URL, and NOT on setting one
   *  for the first time — there was no pretty link to break, and the link the host has been sending
   *  goes on working. Renaming the label is safe too: it changes what the page is called, not where
   *  it lives. */
  $: breaksOldLink = !!savedSlug && cleanSlug !== savedSlug;

  function revert() { label = savedLabel; slug = savedSlug; hearts = savedHearts; comments = savedComments; }
  async function save() {
    saving = true;
    try {
      const r = await updateShare(code, orgCode, share.id, {
        label: label.trim() || undefined, slug: cleanSlug || undefined,
        heartsEnabled: hearts, commentsEnabled: comments,
      });
      url = r.url; slug = r.slug ?? ''; label = r.label;
      savedLabel = r.label; savedSlug = r.slug ?? '';
      savedHearts = r.heartsEnabled ?? hearts; savedComments = r.commentsEnabled ?? comments;
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

    <p class="sum">Sharing <b>{kindText(share.kind, share.count)}</b>. Anyone with the link can view — no account needed.{#if excludesRejected}{' '}<b>Rejected photos are never included.</b>{/if}</p>

    <label class="fld"><span>Name</span>
      <input bind:value={label} maxlength="80" placeholder="e.g. Sam &amp; Riley's wedding" />
      <span class="sub-hint">Shows when the link is previewed — in messages, chat, socials.</span>
    </label>
    <div class="fld"><span>Custom link <small>(optional)</small></span>
      <div class="urlrow"><span class="origin">/s/</span><input class="slug" bind:value={slug} on:input={(e) => onSlugInput(e.currentTarget.value)} placeholder="leave blank for the default" /></div>
      {#if slugFeedback}<p class="slug-msg {slugFeedback.cls}">{slugFeedback.text}</p>{/if}
      {#if breaksOldLink}
        <p class="break-note">
          ⚠ <b>The old link will stop working.</b>
          {#if sentCount}
            You've emailed <b>/s/{savedSlug}</b> to {sentCount} {sentCount === 1 ? 'person' : 'people'} — they will
            get a "not found" page unless you send them the new one.
          {:else}
            Anyone already holding <b>/s/{savedSlug}</b> will get a "not found" page. Send them the new
            link, or press Undo below to keep the old one.
          {/if}
        </p>
      {/if}
      <div class="slug-row">
        <button class="mini" type="button" on:click={() => { slug = slugify(label); onSlugInput(slug); }}>↩ Use the name</button>
        {#if slug && cleanSlug !== slug.trim()}<span class="sub-hint">→ will save as <b>{cleanSlug || '(default)'}</b></span>{/if}
      </div>
    </div>
    <!-- The product's own switch (Toggle.svelte), the same one Event settings uses to ask this
         question of guests — two places asking "can these people react?" should not answer with two
         different controls. NOT inside `.fld`: that class styles `input` for the text fields it was
         written for (full width, padding, a border), which is what turned the checkboxes into
         stretched grey boxes. -->
    <div class="react">
      <p class="react-h">Let people react</p>
      <p class="react-s">Anyone with this link — no account, no join code. They give a name the first
        time they react, and nothing else.</p>
      <div class="toggle-row">
        <div>
          <label class="t-label" for="sh-hearts">Hearts</label>
          <div class="t-sub">Double-tap a photo to love it. Counts include your guests' own hearts.</div>
        </div>
        <Toggle id="sh-hearts" bind:checked={hearts} />
      </div>
      <div class="toggle-row">
        <div>
          <label class="t-label" for="sh-comments">Comments</label>
          <!-- Says who can remove one, because that is what a host weighs before switching this on:
               it puts a stranger's words on their gallery. -->
          <div class="t-sub">Leave words under a photo. You can delete any of them from
            <b>Review → Captions &amp; comments</b>.</div>
        </div>
        <Toggle id="sh-comments" bind:checked={comments} />
      </div>
      {#if comments && !savedComments}
        <p class="react-s warn">A link can be forwarded anywhere, so think about who might end up holding it.</p>
      {/if}
    </div>
    <button class="btn sm" class:primary={dirty} class:ghost={!dirty} on:click={save} disabled={saving || !dirty}>
      {saving ? 'Saving…' : dirty ? 'Save changes' : '✓ Saved'}
    </button>
    {#if dirty && !saving}<button class="btn ghost sm" on:click={revert}>↩ Undo</button>{/if}

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
  .react { margin-bottom: 12px; padding: 12px; border: 1px solid var(--border);
    border-radius: var(--radius-sm); background: var(--surface-2); }
  .react-h { margin: 0; font-size: 0.76rem; font-weight: 700; color: var(--text); }
  .react-s { margin: 4px 0 0; font-size: 0.7rem; line-height: 1.45; color: var(--text-muted); }
  .react-s.warn { margin-top: 10px; }
  /* Same row as the event page's settings rows. `.t-label`'s weight and colour are global (app.css);
     the row and the description are three lines, copied rather than reached for because Svelte
     scopes styles to their own file. */
  .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 10px 0 0; }
  .toggle-row > div { min-width: 0; }
  .t-label { display: block; font-size: 0.82rem; }
  .t-sub { font-size: 0.72rem; line-height: 1.45; color: var(--text-muted); margin-top: 2px; }
  .head { display: flex; align-items: center; justify-content: space-between; font-weight: 800; margin-bottom: 12px; }
  .x { background: none; border: none; color: var(--text-muted); font-size: 1.1rem; cursor: pointer; }
  .sum { font-size: 0.86rem; color: var(--text-muted); margin: 0 0 16px; line-height: 1.5; }
  .fld { display: block; font-size: 0.76rem; color: var(--text-muted); margin-bottom: 10px; }
  .fld > span { display: block; margin-bottom: 4px; }
  .fld input { width: 100%; padding: 9px 11px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font: inherit; font-size: 0.9rem; box-sizing: border-box; }
  .urlrow { display: flex; align-items: stretch; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; background: var(--surface-2); }
  .urlrow .origin { padding: 9px 4px 9px 11px; font-size: 0.82rem; color: var(--text-muted); white-space: nowrap; display: flex; align-items: center; }
  .urlrow .slug { border: none; border-radius: 0; padding-left: 0; }
  /* Stated where the change is made, not behind the Save button: a host should be able to decide
     against it while they are still typing, rather than be asked to confirm something they have
     already mentally committed to. */
  .break-note { margin: 8px 0 0; padding: 8px 10px; border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--danger, #e5484d) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger, #e5484d) 35%, transparent);
    font-size: 0.76rem; line-height: 1.45; }
  .slug-msg { margin: 6px 0 0; font-size: 0.76rem; font-weight: 600; }
  .slug-msg.ok { color: var(--success, #2ecc71); }
  .slug-msg.err { color: var(--danger, #e5484d); }
  .slug-msg.muted { color: var(--text-muted); font-weight: 500; }
  .sub-hint { display: block; margin-top: 4px; font-size: 0.7rem; color: var(--text-muted); }
  .slug-row { display: flex; align-items: center; gap: 10px; margin-top: 5px; flex-wrap: wrap; }
  .mini { background: none; border: none; color: var(--accent); font-size: 0.72rem; font-weight: 700; cursor: pointer; padding: 0; }
  .linkbox { margin: 14px 0 10px; padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); }
  .link { font-size: 0.82rem; word-break: break-all; color: var(--text); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  /* inline-FLEX with an explicit line-height, so a link and a button of the same class come out the
     same height. A <button> gets `line-height: normal` from the UA while an <a> inherits the page's
     1.5, so "Open"/"View" sat visibly taller than the buttons beside it — the row read as one odd
     control among several. Setting both here means the element an action happens to be written as
     stops being something the layout can feel. */
  .btn { display: inline-flex; align-items: center; justify-content: center; line-height: 1.2;
    font-weight: 700; border-radius: var(--radius-sm); padding: 10px 14px; font-size: 0.86rem;
    border: 1px solid transparent; cursor: pointer; text-decoration: none; text-align: center;
    min-height: 40px; }
  /* A floor, because an emoji is taller than a letter. "🔗 Copy" and "Edit" are the same font at
     the same padding, but the emoji glyph raises the line box by most of a pixel, so the row came
     out a mix of 31.8px and 31px controls — small enough to look like a rendering accident rather
     than a decision, which is exactly what makes it read as sloppy. The floor is the emoji height,
     so the plain ones come up to meet it instead of the row being ragged. */
  .btn.sm { padding: 7px 12px; font-size: 0.8rem; min-height: 32px; }
  .btn.primary { background: var(--accent-fill); color: var(--accent-ink, #111); }
  .btn.ghost { background: transparent; color: var(--text); border-color: var(--border); }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .hint { font-size: 0.74rem; color: var(--text-muted); margin: 14px 0 0; }
  /* An unsaved name should look unsaved. The field carries the state too, not just the button —
     on a phone the button can be below the fold while the field you just typed in is not. */
  .fld:has(input) input { transition: border-color .12s; }
</style>
