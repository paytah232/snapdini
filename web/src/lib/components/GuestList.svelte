<script lang="ts">
  // The guest list: who the host means to invite, and what became of the emails we sent them.
  //
  // The thing this card exists to do that a mail client cannot is the SECOND half. Anyone can type
  // twenty addresses into Gmail; nobody can tell you afterwards which three of them bounced. So
  // every row carries its own delivery state, and the two states that need the host to DO something
  // — a bounce and a spam complaint — are the only ones drawn in red.
  //
  // The honesty rule this whole component follows: never imply we know something we don't. On a
  // deployment without Mailgun delivery tracking there is no webhook and there never will be, so
  // "Sent" is final and says "delivery unknown" rather than looking like a status that is about to
  // change. `deliveryTracking` on the payload is what distinguishes the two, and it is checked
  // rather than assumed — a host staring at a status that will never update is worse off than one
  // who was told plainly that we cannot see.
  import { createEventDispatcher } from 'svelte';
  import type { EventGuest, GuestListPayload, ImportPreview, GuestField, InviteStatus } from '$lib/events';

  export let data: GuestListPayload;
  export let busy = false;

  const dispatch = createEventDispatcher<{
    add: { name: string; email: string; phone: string; notes: string };
    update: { id: string; name: string; email: string; phone: string; notes: string };
    remove: { id: string };
    preview: { text: string; mapping?: GuestField[] };
    import: { text: string; mapping: GuestField[] };
    send: { guestIds?: string[] };
  }>();

  /** The parent owns the preview, because it owns the request. Null = the import panel is closed
   *  or waiting. */
  export let preview: ImportPreview | null = null;
  export let importText = '';

  let addOpen = false;
  let importOpen = false;
  let editing: string | null = null;
  let form = { name: '', email: '', phone: '', notes: '' };

  const blank = () => ({ name: '', email: '', phone: '', notes: '' });

  function openAdd() {
    editing = null; form = blank(); addOpen = true; importOpen = false;
  }
  function openEdit(g: EventGuest) {
    editing = g.id;
    form = { name: g.name ?? '', email: g.email ?? '', phone: g.phone ?? '', notes: g.notes ?? '' };
    addOpen = true; importOpen = false;
  }
  function submitForm() {
    if (editing) dispatch('update', { id: editing, ...form });
    else dispatch('add', { ...form });
    addOpen = false; editing = null; form = blank();
  }

  // Upload and paste are the same input on purpose: the browser reads the file into text, so there
  // is one code path, one size limit and one set of parsing rules behind both. It also means the
  // host can fix a bad row in the box before importing, which they cannot do with a file.
  async function pickFile(e: Event) {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    importText = await file.text();
    dispatch('preview', { text: importText });
  }

  function remap(i: number, value: string) {
    if (!preview) return;
    const mapping = [...preview.mapping];
    mapping[i] = value as GuestField;
    dispatch('preview', { text: importText, mapping });
  }

  /** Commit what is on screen. The guard is real rather than a `!` in the markup: the preview can
   *  be cleared by another request landing between the render and the click. */
  function commitImport() {
    if (!preview || preview.fatal || !preview.counts.add) return;
    dispatch('import', { text: importText, mapping: preview.mapping });
  }

  // ── How a status reads ─────────────────────────────────────────────────────
  // Mirrors describe() in app/src/server/delivery.ts. Duplicated rather than fetched because it is
  // three lines of words and a network round trip to share them would be worse; the server copy is
  // the one under test, and this one must be kept in step with it.
  function label(status: InviteStatus, provider: string | null): string {
    switch (status) {
      case 'delivered': return 'Delivered';
      case 'bounced': return 'Bounced';
      case 'complained': return 'Marked as spam';
      case 'unsubscribed': return 'Unsubscribed';
      case 'failed': return 'Failed';
      default: return provider === 'mailgun' && data.deliveryTracking ? 'Sent' : 'Sent (delivery unknown)';
    }
  }
  const tone = (s: InviteStatus): string =>
    s === 'delivered' ? 'good' : (s === 'bounced' || s === 'complained') ? 'bad'
    : (s === 'failed' || s === 'unsubscribed') ? 'warn' : 'muted';

  $: mailable = data.guests.filter((g) => g.email && !g.suppressed);
  $: withAddress = data.guests.filter((g) => g.email);
  $: blocked = data.guests.filter((g) => g.suppressed);
  // The number worth putting on the card, because it is the one that needs a decision.
  $: needsAttention = data.guests.filter(
    (g) => g.lastInvite && (g.lastInvite.status === 'bounced' || g.lastInvite.status === 'complained'),
  ).length;

  const when = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const FIELDS: GuestField[] = ['name', 'email', 'phone', 'notes', 'ignore'];
</script>

<div class="head">
  <div class="counts">
    {#if data.guests.length}
      <span>{data.guests.length} guest{data.guests.length === 1 ? '' : 's'}</span>
      <span class="sep">·</span>
      <span>{withAddress.length} with an email</span>
      {#if needsAttention}
        <span class="sep">·</span><span class="bad">{needsAttention} need{needsAttention === 1 ? 's' : ''} a look</span>
      {/if}
    {:else}
      <span class="muted">Nobody on the list yet</span>
    {/if}
  </div>
  <div class="acts">
    <button class="btn ghost sm" on:click={openAdd}>+ Add guest</button>
    <button class="btn ghost sm" class:on={importOpen}
            on:click={() => { importOpen = !importOpen; addOpen = false; }}>Import</button>
    {#if data.emailEnabled}
      <button class="btn primary sm" disabled={busy || !mailable.length}
              on:click={() => dispatch('send', {})}>
        {busy ? '…' : `Send invites${mailable.length ? ` (${mailable.length})` : ''}`}
      </button>
    {/if}
  </div>
</div>

{#if !data.emailEnabled}
  <!-- The list is still worth keeping without a mail server — it is a record of who is coming, and
       it holds the phone numbers. Saying so beats hiding the whole card. -->
  <p class="hint">Email isn't configured on this server, so invites can't be sent from here. The list
    still works as your record of who's coming.</p>
{:else if !data.deliveryTracking}
  <!-- The honesty rule, stated once at the top rather than repeated on every row. -->
  <p class="hint">This server sends invites but can't see what happens to them afterwards — each one
    will show as “sent, delivery unknown”. Delivery tracking needs Mailgun with a webhook signing key.</p>
{/if}

{#if addOpen}
  <div class="panel">
    <div class="grid2">
      <input placeholder="Name" bind:value={form.name} />
      <input type="email" placeholder="guest@example.com" bind:value={form.email} />
      <input placeholder="Phone (optional)" bind:value={form.phone} />
      <input placeholder="Notes (optional)" bind:value={form.notes} />
    </div>
    <!-- No field is required individually, which is deliberate: a plus-one with only a name and a
         cousin with only a phone number are both real entries on a real guest list. -->
    <p class="hint">A name, an email or a phone number — whichever you have.</p>
    <div class="row-acts">
      <button class="btn primary sm" on:click={submitForm} disabled={busy}>
        {editing ? 'Save' : 'Add to list'}</button>
      <button class="btn ghost sm" on:click={() => { addOpen = false; editing = null; }}>Cancel</button>
    </div>
  </div>
{/if}

{#if importOpen}
  <div class="panel">
    <div class="label-mono">PASTE OR UPLOAD</div>
    <textarea rows="4" bind:value={importText}
      placeholder={'Name,Email,Phone\nJo Smith,jo@example.com,0400 000 000'}></textarea>
    <div class="row-acts">
      <!-- Pasting straight out of a spreadsheet gives tab-separated text, which the parser handles.
           That is why there is no .xlsx upload: the way people actually move a list already works. -->
      <button class="btn ghost sm" disabled={busy || !importText.trim()}
              on:click={() => dispatch('preview', { text: importText })}>Preview</button>
      <label class="btn ghost sm file">
        Choose a CSV<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" on:change={pickFile} />
      </label>
    </div>
    <p class="hint">CSV or tab-separated. Export from Excel or Google Sheets with
      <b>File → Save As → CSV</b>, or just copy the cells and paste them here.</p>

    {#if preview}
      {#if preview.fatal}
        <p class="hint bad">{preview.fatal}</p>
      {:else}
        {#if preview.headerless}
          <p class="hint">No header row found — the first line looks like a guest, so it's been kept
            as one. Set what each column is below.</p>
        {/if}
        <div class="map">
          {#each preview.headers as h, i}
            <label class="mapcol">
              <span class="colname">{h}</span>
              <select value={preview.mapping[i]} on:change={(e) => remap(i, e.currentTarget.value)}>
                {#each FIELDS as f}<option value={f}>{f === 'ignore' ? "don't import" : f}</option>{/each}
              </select>
            </label>
          {/each}
        </div>

        <div class="summary">
          <b>{preview.counts.add}</b> to add
          {#if preview.counts.duplicate}<span class="sep">·</span>{preview.counts.duplicate} already on the list{/if}
          {#if preview.counts.invalid}<span class="sep">·</span>{preview.counts.invalid} bad address{preview.counts.invalid === 1 ? '' : 'es'}{/if}
          {#if preview.counts.skip}<span class="sep">·</span>{preview.counts.skip} skipped{/if}
        </div>

        <!-- Skipped rows are SHOWN, greyed, with the reason. Reporting only "160 imported" is how a
             host discovers at the party that forty of their guests were never invited. -->
        <div class="rows">
          {#each preview.rows as r (r.line)}
            <div class="prow" class:skip={r.action === 'skip'}>
              <span class="ln">{r.line}</span>
              <span class="pname">{r.guest.name || '—'}</span>
              <span class="pmail">{r.guest.email || '—'}</span>
              {#if r.problems.length}<span class="why">{r.problems[0]}</span>{/if}
            </div>
          {/each}
          {#if preview.truncated}
            <p class="hint">Showing the first {preview.rows.length} of {preview.total} rows.</p>
          {/if}
        </div>

        <div class="row-acts">
          <button class="btn primary sm" disabled={busy || !preview.counts.add} on:click={commitImport}>
            Import {preview.counts.add} guest{preview.counts.add === 1 ? '' : 's'}
          </button>
          <button class="btn ghost sm" on:click={() => { importOpen = false; }}>Cancel</button>
        </div>
      {/if}
    {/if}
  </div>
{/if}

{#if data.guests.length}
  <div class="list">
    {#each data.guests as g (g.id)}
      <div class="guest">
        <div class="who">
          <span class="gname">{g.name || g.email || g.phone}</span>
          <span class="sub">
            {#if g.name && g.email}{g.email}{/if}
            {#if g.phone}{#if g.name && g.email}<span class="sep">·</span>{/if}{g.phone}{/if}
            {#if !g.email}<span class="sep">·</span><span class="muted">no email</span>{/if}
          </span>
          {#if g.notes}<span class="sub notes">{g.notes}</span>{/if}
        </div>

        <div class="state">
          {#if g.suppressed}
            <!-- The one state a host cannot fix from here, so it explains itself rather than just
                 refusing. Un-suppressing is deliberately not offered: the whole value of the list is
                 that it cannot be talked out of protecting the sending domain. -->
            <span class="badge bad" title={g.suppressed.detail || ''}>
              Blocked · {g.suppressed.reason}
            </span>
          {:else if g.lastInvite}
            <span class="badge {tone(g.lastInvite.status)}" title={g.lastInvite.reason || ''}>
              {label(g.lastInvite.status, g.lastInvite.provider)}
            </span>
            <span class="at">{when(g.lastInvite.sentAt)}</span>
          {:else if g.email}
            <span class="badge muted">Not invited</span>
          {/if}
        </div>

        <div class="acts">
          {#if data.emailEnabled && g.email && !g.suppressed}
            <button class="btn ghost sm" disabled={busy}
                    on:click={() => dispatch('send', { guestIds: [g.id] })}>
              {g.lastInvite ? 'Resend' : 'Invite'}
            </button>
          {/if}
          <button class="btn ghost sm" on:click={() => openEdit(g)}>Edit</button>
          <button class="btn ghost sm" on:click={() => dispatch('remove', { id: g.id })}>Remove</button>
        </div>
      </div>

      {#if g.lastInvite?.reason && (g.lastInvite.status === 'bounced' || g.lastInvite.status === 'failed')}
        <!-- The mail server's own words, not our paraphrase. "550 no such user" means fix the
             address; "mailbox full" means try again tomorrow. Collapsing both to "failed" throws
             away the only thing that tells the host which one they are looking at. -->
        <p class="reason">{g.lastInvite.reason}</p>
      {/if}
    {/each}
  </div>

  {#if blocked.length}
    <p class="hint">
      {blocked.length} address{blocked.length === 1 ? '' : 'es'} on this list {blocked.length === 1 ? 'is' : 'are'}
      blocked from further sends, because mail to {blocked.length === 1 ? 'it' : 'them'} hard-bounced or was
      reported as spam. Sending to dead addresses is what gets a sending domain throttled, so we stop
      — ask that guest for a different address and add it.
    </p>
  {/if}
{/if}

<style>
  .head {
    display: flex; align-items: center; justify-content: space-between;
    gap: 10px; flex-wrap: wrap; padding-bottom: 8px;
  }
  .counts { font-size: 0.82rem; color: var(--text-muted); }
  .acts { display: flex; gap: 6px; flex-wrap: wrap; }
  .sep { opacity: 0.5; margin: 0 5px; }
  .muted { color: var(--text-muted); }
  .bad { color: var(--danger); }
  .hint { margin: 6px 0; color: var(--text-muted); font-size: 0.75rem; line-height: 1.45; }

  .panel {
    display: flex; flex-direction: column; gap: 8px;
    padding: 10px 0; border-top: 1px solid var(--border);
  }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
  /* One column on a phone: two side-by-side text inputs at 360px are unusable, and a host typing
     up their list is very often doing it on the sofa rather than at a desk. */
  @media (max-width: 520px) { .grid2 { grid-template-columns: 1fr; } }
  .panel input, .panel textarea, .panel select {
    width: 100%; padding: 8px 10px; font: inherit; font-size: 0.85rem;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text);
  }
  .panel textarea { font-family: var(--font-mono); font-size: 0.78rem; resize: vertical; }
  .row-acts { display: flex; gap: 6px; flex-wrap: wrap; }
  .label-mono { font-family: var(--font-mono); font-size: 0.68rem; color: var(--text-muted); letter-spacing: 0.06em; }

  /* A file input styled as a button. The native control cannot be styled, so it is made invisible
     and the label carries the appearance — which also keeps the keyboard and screen-reader
     behaviour of a real <input type=file>. */
  .file { position: relative; overflow: hidden; }
  .file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }

  .map { display: flex; gap: 8px; flex-wrap: wrap; }
  .mapcol { display: flex; flex-direction: column; gap: 3px; min-width: 130px; flex: 1; }
  .colname { font-size: 0.72rem; color: var(--text-muted); overflow-wrap: anywhere; }

  .summary { font-size: 0.82rem; padding: 4px 0; }
  .rows { display: flex; flex-direction: column; max-height: 260px; overflow-y: auto; }
  .prow {
    display: flex; gap: 8px; align-items: baseline;
    font-size: 0.76rem; padding: 3px 0; border-bottom: 1px solid var(--border);
  }
  .prow.skip { opacity: 0.5; }
  .ln { color: var(--text-muted); font-family: var(--font-mono); min-width: 2.2em; }
  .pname { min-width: 0; overflow-wrap: anywhere; }
  .pmail { color: var(--text-muted); min-width: 0; overflow-wrap: anywhere; }
  .why { margin-left: auto; color: var(--accent); font-size: 0.72rem; text-align: right; }

  .list { display: flex; flex-direction: column; }
  .guest {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 8px 0; border-bottom: 1px solid var(--border);
  }
  .who { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
  .gname { font-weight: 600; font-size: 0.9rem; overflow-wrap: anywhere; }
  /* An address must never be truncated — it is the thing the host is reading the row to check. */
  .sub { color: var(--text-muted); font-size: 0.76rem; overflow-wrap: anywhere; }
  .notes { font-style: italic; }
  .state { display: flex; align-items: center; gap: 6px; }
  .at { color: var(--text-muted); font-size: 0.72rem; white-space: nowrap; }

  .badge {
    font-size: 0.68rem; font-weight: 700; padding: 2px 7px; border-radius: 999px;
    border: 1px solid var(--border); white-space: nowrap;
  }
  .badge.good { color: var(--success); border-color: var(--success); }
  /* Red is reserved for the two states that need the host to do something. A deferral is not one of
     them — Mailgun is still retrying, and colouring it as a failure sends hosts chasing guests whose
     mail is simply a few minutes late. */
  .badge.bad { color: var(--danger); border-color: var(--danger); }
  .badge.warn { color: var(--accent); border-color: var(--accent); }
  .badge.muted { color: var(--text-muted); }

  .reason {
    margin: -4px 0 8px; padding-left: 2px;
    color: var(--text-muted); font-size: 0.72rem; font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
</style>
