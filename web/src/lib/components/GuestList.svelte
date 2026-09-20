<script lang="ts">
  import { MAIL_BATCH_SIZE } from '../../../../shared/mail-batch';
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
  //
  // ── What is on screen, and what waits to be asked for ──────────────────────────────────────────
  // Everything above was true and the card still showed all of it AT ONCE: a three-line blurb, a
  // second blurb under it, a delivery-tracking caveat, then per guest a name, an address,
  // a note, a badge, a date and three buttons — times however many people are coming. At twenty
  // guests that is a wall, and a wall is not a list you can read.
  //
  // So the split is by QUESTION. Scanning the card answers "who is coming, and did their invite
  // land?" — a name and a badge per row, and the one count that needs a decision. Everything else
  // answers "what do I do about THIS guest?", which is a question you only ask about one row at a
  // time, so it lives inside that row and opens when you press it.
  //
  // The disclosure is the admin page's own `.disc` idiom — native <details>, suppressed marker, our
  // own chevron — because it is already the answer to this exact problem three times over on the
  // page this card sits in (the trick-list "why", the share-links correction, the shot-request
  // note). Its rules are COPIED here rather than inherited: Svelte scopes a component's styles to
  // that component's markup, so the page's `.disc` cannot reach inside this file. Same reason the
  // button rules below are local — see app.css for the long version.
  import { createEventDispatcher, onDestroy, tick } from 'svelte';
  import { showToast } from '$lib/toast';
  import type { EventGuest, GuestListPayload, ImportPreview, GuestField, InviteState } from '$lib/events';

  export let data: GuestListPayload;
  export let busy = false;
  /** Shown, not writable. Set by the event manager when a SITE ADMIN is inside an event they do not
   *  own — accident prevention, never access control; $lib/adminGuard has the long version.
   *
   *  This card is six separate mutations and one of them (Remove) is a single press, so the guard
   *  is put where they all pass rather than on each button: `dispatch` below is shadowed, and a
   *  write that does not leave this component cannot happen. The buttons are marked up as refused
   *  as well, because the press should be stopped before it is answered — the shadow is what
   *  catches the seventh mutation somebody adds next year. */
  export let readOnly = false;

  type GuestWrites = {
    add: { name: string; email: string; notes: string };
    update: { id: string; name: string; email: string; notes: string };
    remove: { id: string };
    preview: { text: string; mapping?: GuestField[] };
    import: { text: string; mapping: GuestField[] };
    send: { guestIds?: string[] };
  };
  const READ_ONLY_WHY = 'Read-only — take control in the red bar to change this event’s guest list.';
  const emit = createEventDispatcher<GuestWrites>();
  /** THE choke point. Every event this component raises is a write on the host's event — there is
   *  no read-only event in the map above — so refusing here refuses all of them, including any
   *  added later, with no per-call-site discipline required. Answered out loud rather than
   *  swallowed, for the reason blockedPress() exists. */
  function dispatch<K extends keyof GuestWrites>(type: K, detail: GuestWrites[K]): void {
    if (readOnly) { blockedPress(READ_ONLY_WHY); return; }
    emit(type, detail);
  }

  /** The parent owns the preview, because it owns the request. Null = the import panel is closed
   *  or waiting. */
  export let preview: ImportPreview | null = null;
  export let importText = '';

  let addOpen = false;
  let importOpen = false;
  let editing: string | null = null;
  let form = { name: '', email: '', notes: '' };
  let importBox: HTMLTextAreaElement | undefined;

  const blank = () => ({ name: '', email: '', notes: '' });

  /** A press on a control that is not ready.
   *
   *  Every such control here is `aria-disabled`, not `disabled`, so the press still ARRIVES — and
   *  that is the whole point of it, which means something has to answer. A `disabled` button
   *  consumes no events at all: the tap falls through to the text behind it and the phone raises
   *  its own Copy/Search menu over the app, so the host's press appears to do nothing at all.
   *  docs/DEVELOPMENT.md names this; the Preview button below is how it was found again. */
  function blockedPress(why: string, fix?: () => void) {
    showToast(why, true);
    fix?.();
  }

  function openAdd() {
    editing = null; form = blank(); addOpen = true; importOpen = false;
  }
  function openEdit(g: EventGuest) {
    editing = g.id;
    form = { name: g.name ?? '', email: g.email ?? '', notes: g.notes ?? '' };
    addOpen = true; importOpen = false;
  }
  /** Where the guest you just saved went.
   *
   *  The list is ordered ALPHABETICALLY (see GUEST_ORDER in routes/guests.ts), which is what a host
   *  wants when they are looking for a person — but it means a new guest drops into the MIDDLE of
   *  the list instead of onto the end, and renaming someone moves them on purpose. Both read as
   *  "nothing happened". So the row says where it is: a brief ring, the same answer the create
   *  wizard and the poster designer give for the same problem.
   *
   *  `outline` with an offset rather than a box-shadow, and position/z-index alongside it: a guest
   *  row has no padding of its own, so a shadow on the border box runs flush through the text, and
   *  the ring is drawn in space the NEXT row owns — which paints over it. The class is applied in
   *  the markup rather than to a DOM node by hand, which is what lets the rule and its keyframes
   *  stay component-scoped instead of needing `:global`. */
  let flashId: string | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  /** An ADD has no id until the server answers, so the row is recognised on the way back by the
   *  ADDRESS the host typed — which every add has, since the form will not send without one. An
   *  EDIT already has an id. */
  let pendingAdd: string | null = null;

  async function flash(id: string) {
    clearTimeout(flashTimer);
    flashId = id;
    flashTimer = setTimeout(() => { flashId = null; }, 1600);
    // Alphabetical means the row can be off screen entirely. 'nearest' rather than 'center': it
    // scrolls only as far as it has to, so a row already in view does not jump under the host.
    await tick();
    const el = document.querySelector('.guest-disc.flash');
    const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Optional CALL as well as optional chain: jsdom does not implement scrollIntoView at all,
    // and a ring that throws is worse than a ring that does not scroll.
    el?.scrollIntoView?.({ block: 'nearest', behavior: still ? 'auto' : 'smooth' });
  }
  onDestroy(() => clearTimeout(flashTimer));

  $: if (pendingAdd) {
    const match = data.guests.find((g) => g.email === pendingAdd);
    if (match) { pendingAdd = null; void flash(match.id); }
  }

  /** The one thing this form will not send without. Said in the same words the server answers a
   *  body with no address with (cleanGuest() in app/src/server/routes/guests.ts) — the press is
   *  answered here so the host does not have to make a round trip to find out, and the two must not
   *  drift, so change both. */
  const NEEDS_EMAIL = 'Add an email address — that is how the join link is sent. Print a card for anyone without one.';

  function submitForm() {
    if (busy) { blockedPress('Still working — one moment.'); return; }
    if (!form.email.trim()) { blockedPress(NEEDS_EMAIL); return; }
    if (editing) { dispatch('update', { id: editing, ...form }); void flash(editing); }
    else {
      // Lower-cased to match: the server stores addresses folded, and every comparison in this
      // feature is a byte comparison.
      pendingAdd = form.email.trim().toLowerCase();
      dispatch('add', { ...form });
    }
    addOpen = false; editing = null; form = blank();
  }

  /** Send to everyone who can be sent to. What blocks it is never a mystery: either a request is in
   *  flight, or there is nobody to send to — and in that case the fix is the Add panel, so the press
   *  opens it instead of dying.
   *
   *  "Nobody has an address" used to be one of the answers here. It cannot happen any more: every
   *  guest on the list has one. What is left is an empty list, or a list whose addresses are all
   *  blocked. */
  /** What ONE press actually delivers (MAX_PER_SEND in routes/guests.ts).
   *
   *  The button read `Send invites (250)` on a 250-guest list and the endpoint mailed two hundred,
   *  so the label was a promise the product did not keep — and the fifty were reported nowhere. The
   *  number is duplicated here rather than fetched because it is a LABEL: it has to be right before
   *  the press, and the response carries the authoritative `perSend` for everything after it. */
  const PER_SEND = MAIL_BATCH_SIZE;

  function sendAll() {
    if (busy) { blockedPress('Still sending — one moment.'); return; }
    if (!mailable.length) {
      blockedPress(
        data.guests.length
          ? 'Every address on this list is blocked from further sends. Add a different one.'
          : 'Nobody on the list yet — add a guest and their email address.',
        openAdd,
      );
      return;
    }
    dispatch('send', {});
  }

  function sendOne(id: string) {
    if (busy) { blockedPress('Still sending — one moment.'); return; }
    dispatch('send', { guestIds: [id] });
  }

  // Upload and paste are the same input on purpose: the browser reads the file into text, so there
  // is one code path, one size limit and one set of parsing rules behind both. It also means the
  // host can fix a bad row in the box before importing, which they cannot do with a file.
  async function pickFile(e: Event) {
    const el = e.currentTarget as HTMLInputElement;
    const file = el.files?.[0];
    // Clear the control BEFORE the await. A file input fires `change` only when the selection
    // CHANGES, so picking the same file twice in a row — which is exactly what someone does after
    // fixing a typo and re-saving it — fired nothing at all the second time, and looked like the
    // button had stopped working.
    el.value = '';
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

  /** Read what is in the box.
   *
   *  This was the bug behind "Preview seems to do nothing": the button carried
   *  `disabled={busy || !importText.trim()}`, so with an empty box the press was swallowed whole.
   *  The server has had the right words for this all along — POST with an empty text answers 400
   *  "Paste some rows, or choose a file" — and the host could never reach them, because the request
   *  was never sent. Said here instead, without the round trip, and the box takes focus so the
   *  answer points at the thing to fix. */
  function doPreview() {
    if (busy) return;
    if (!importText.trim()) {
      blockedPress('Paste some rows, or choose a file', () => importBox?.focus());
      return;
    }
    dispatch('preview', { text: importText });
  }

  /** Commit what is on screen. The guard is real rather than a `!` in the markup: the preview can
   *  be cleared by another request landing between the render and the click.
   *
   *  A fatal now ANSWERS the press rather than swallowing it. Same rule as every other control
   *  here: the button is aria-disabled, so the press lands, so something has to say why. */
  function commitImport() {
    if (busy) return;
    if (!preview) return;
    if (preview.fatal) { blockedPress(preview.fatal); return; }
    if (!preview.counts.add) {
      blockedPress('Nothing here to add — every row is a duplicate or was skipped.');
      return;
    }
    dispatch('import', { text: importText, mapping: preview.mapping });
  }

  /** What the file was read AS, confirmed after the fact.
   *
   *  Tab-separated is the format a spreadsheet paste actually produces, it has always worked, and
   *  nothing on screen ever said so — the host had no way to know their paste had been understood.
   *  Said here, once the answer is known, rather than as one more instruction up front. */
  $: readAs = !preview ? ''
    : preview.delimiter === 'tab' ? 'tab-separated'
    : preview.delimiter === ';' ? 'semicolon-separated'
    : 'comma-separated';

  // ── How a status reads ─────────────────────────────────────────────────────
  // Mirrors describe() in app/src/server/delivery.ts. Duplicated rather than fetched because it is
  // three lines of words and a network round trip to share them would be worse; the server copy is
  // the one under test, and this one must be kept in step with it.
  /** A `delivered` that the receiving server quarantined.
   *
   *  Mailgun reports a message Gmail files as spam as `delivered`, and the only evidence is a
   *  phrase inside the server's own reply ("2.0.0 OK DMARC:Quarantine"), which already travels to
   *  this component as `lastInvite.reason`. Without reading it, this card puts a green Delivered
   *  tick beside mail that went to spam — and the host stops looking. Mirrors quarantined() in
   *  app/src/server/delivery.ts; keep the two in step. */
  const QUARANTINE_RE = /\bdmarc\s*[:=]?\s*quarantine\b/i;
  const quarantined = (i: InviteState): boolean =>
    i.status === 'delivered' && !!i.reason && QUARANTINE_RE.test(i.reason);
  const QUARANTINE_NOTE =
    'The receiving server accepted this and then quarantined it — it most likely landed in spam, '
    + 'so treat it as not yet seen.';

  function label(i: InviteState): string {
    if (quarantined(i)) return 'Delivered to spam';
    switch (i.status) {
      case 'delivered': return 'Delivered';
      case 'bounced': return 'Bounced';
      case 'complained': return 'Marked as spam';
      case 'unsubscribed': return 'Unsubscribed';
      case 'failed': return 'Failed';
      default: return i.provider === 'mailgun' && data.deliveryTracking ? 'Sent' : 'Sent (delivery unknown)';
    }
  }
  const tone = (i: InviteState): string =>
    quarantined(i) ? 'warn'
    : i.status === 'delivered' ? 'good' : (i.status === 'bounced' || i.status === 'complained') ? 'bad'
    : (i.status === 'failed' || i.status === 'unsubscribed') ? 'warn' : 'muted';

  /** What the collapsed row is CALLED. The name where there is one, and otherwise the address —
   *  which every guest has, so there is always something to call them. */
  const title = (g: EventGuest) => g.name || g.email;

  /** The contact lines the opened row shows — minus whatever the summary already spent as the
   *  title, because repeating it back is how a two-line row becomes a four-line one. A guest with
   *  no name is titled by their address, and that row shows nothing here rather than the address
   *  twice. The "no email address" line this used to carry is gone: there is no such guest. */
  const contact = (g: EventGuest): string[] => (g.email === title(g) ? [] : [g.email]);

  $: mailable = data.guests.filter((g) => !g.suppressed);
  $: blocked = data.guests.filter((g) => g.suppressed);
  // The number worth putting on the card, because it is the one that needs a decision.
  $: needsAttention = data.guests.filter(
    (g) => g.lastInvite && (g.lastInvite.status === 'bounced' || g.lastInvite.status === 'complained'),
  ).length;

  const when = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  // The mapper's options, and so the whole list of things an import can store. No phone: Snapdini
  // sends email and nothing else, so there is nothing a number could be used for. A host whose
  // spreadsheet has one gets that column guessed as "don't import", and can point it at notes from
  // this same dropdown if they want the digits kept as a note.
  const FIELDS: GuestField[] = ['name', 'email', 'notes', 'ignore'];
</script>

<div class="head">
  <div class="counts">
    {#if data.guests.length}
      <!-- Two numbers at most. "N with an email" used to sit here permanently beside the total, and
           on the ordinary list where everyone has an address it simply said the total twice; where
           it differs, the Send button's own count already says so. The full breakdown moved into
           the disclosure below. What stays is the one number that asks the host for a decision. -->
      <span>{data.guests.length} guest{data.guests.length === 1 ? '' : 's'}</span>
      {#if needsAttention}
        <span class="sep">·</span><span class="bad">{needsAttention} need{needsAttention === 1 ? 's' : ''} a look</span>
      {/if}
    {:else}
      <span class="muted">Nobody on the list yet</span>
    {/if}
  </div>
  <div class="acts">
    <button class="btn ghost sm" on:click={openAdd} disabled={readOnly}>+ Add guest</button>
    <button class="btn ghost sm" class:on={importOpen} disabled={readOnly}
            on:click={() => { importOpen = !importOpen; addOpen = false; }}>Import</button>
    {#if data.emailEnabled}
      <!-- aria-disabled, NOT disabled. See blockedPress(): the press still lands and still says
           what is missing, and where there is somewhere that would fix it, it goes there. -->
      <button class="btn primary sm" aria-disabled={busy || !mailable.length || undefined}
              disabled={readOnly} on:click={sendAll}>
        {busy ? '…' : `Send invites${mailable.length ? ` (${Math.min(mailable.length, PER_SEND)})` : ''}`}
      </button>
    {/if}
  </div>
</div>

{#if data.emailEnabled}
  <!-- Why this card is worth filling in, in ONE sentence, said where the host can actually read it.
       It used to be three lines plus a second paragraph under them, and both were the first thing
       on the card — so the card opened with a lecture. The value proposition is the half that
       earns its place (an empty list otherwise reads as a chore with no payoff, and hosts skip it);
       the reasoning behind it does not need to be on screen to be available.

       It also, until now, did not render as written: `.why` was declared twice in this file at the
       same specificity — once for this paragraph and once for a problem label in the import
       preview — so the later rule won and the card's opening line came out at 0.72rem, in gold,
       right-aligned. The import one is `.prob` now. -->
  <p class="why">
    Send everyone the join link in one go, then watch what became of each invite — delivered,
    bounced, or marked as spam. That last part is what your mail app can never tell you.
  </p>

  <!-- The mechanics, one tap away. Four separate blocks of standing copy used to be stacked on the
       card: the list/participants distinction, the address breakdown, the delivery-tracking
       caveat, and the blocked-address explanation. They are all answers to "how does sending
       work", they are all read once, and none of them changes what the host does today. (The
       address breakdown has since gone entirely — see below.) -->
  <details class="disc">
    <summary>How invites work, and who gets the photos</summary>
    <div class="disc-body">
      <!-- Not padding. `eventGuests` (this list) is only ever used to send invites — see
           routes/guests.ts — while the photos at reveal go to `participants` who joined AND ticked
           "send me my photos" (guest-delivery.ts). Two different lists, and nothing on screen said
           so, which is exactly the kind of thing a host assumes wrongly and only discovers after
           the event, when it is far too late to fix. -->
      <p class="hint">
        This is your <b>invite</b> list. Photos go to whoever joins and asks for a copy — which may
        not be the same people.
      </p>
      <!-- "N of M have an email address" stood here. Every guest has one now, so it could only
           ever say the total twice. -->
      {#if !data.deliveryTracking}
        <!-- The honesty rule. The row label already says "delivery unknown" and is final; this is
             why it says it. -->
        <p class="hint">This server sends invites but can't see what happens to them afterwards, so
          each one shows as “sent, delivery unknown”. Delivery tracking needs Mailgun with a webhook
          signing key.</p>
      {/if}
      {#if blocked.length}
        <!-- Un-suppressing is deliberately not offered anywhere: the whole value of the list is
             that it cannot be talked out of protecting the sending domain. -->
        <p class="hint">
          {blocked.length} address{blocked.length === 1 ? '' : 'es'} here {blocked.length === 1 ? 'is' : 'are'}
          blocked from further sends, after mail to {blocked.length === 1 ? 'it' : 'them'} hard-bounced or
          was reported as spam. Sending to dead addresses is what gets a sending domain throttled —
          ask that guest for a different address and add it.
        </p>
      {/if}
    </div>
  </details>
{:else}
  <!-- The list is still worth building without a mail server — the addresses are there the moment
       one is configured. Stays on the card rather than behind the disclosure: it is the only thing
       explaining why there is no Send button. -->
  <p class="hint">Email isn't set up on this server, so invites can't be sent from here — the list
    keeps everyone's address ready for when it is.</p>
{/if}

{#if addOpen}
  <div class="panel">
    <div class="grid2">
      <input placeholder="Name" bind:value={form.name} />
      <input type="email" placeholder="guest@example.com" bind:value={form.email} required />
      <input placeholder="Notes (optional)" bind:value={form.notes} />
    </div>
    <!-- The address is the whole point of the list: it is what the join link is sent to. There is
         no phone box — nothing here could ring it. -->
    <p class="hint">Email is required — anyone you haven't got an address for needs a printed card.</p>
    <div class="row-acts">
      <!-- aria-disabled, NOT disabled — see blockedPress(). The press lands on an empty address box
           and is answered in the server's own words. -->
      <button class="btn primary sm" on:click={submitForm} disabled={readOnly}
              aria-disabled={busy || !form.email.trim() || undefined}>
        {editing ? 'Save' : 'Add to list'}</button>
      <button class="btn ghost sm" on:click={() => { addOpen = false; editing = null; }}>Cancel</button>
    </div>
  </div>
{/if}

{#if importOpen}
  <div class="panel">
    <div class="label-mono">PASTE OR UPLOAD</div>
    <textarea rows="4" bind:this={importBox} bind:value={importText}
      placeholder={'Name,Email,Notes\nJo Smith,jo@example.com,Coming with Dan'}></textarea>
    <div class="row-acts">
      <!-- Pasting straight out of a spreadsheet gives tab-separated text, which the parser handles.
           That is why there is no .xlsx upload: the way people actually move a list already works. -->
      <button class="btn ghost sm" aria-disabled={busy || !importText.trim() || undefined}
              disabled={readOnly} on:click={doPreview}>{busy ? '…' : 'Preview'}</button>
      <!-- The disabled input is what refuses: a <label> whose control is disabled activates nothing,
           so the file picker never opens. -->
      <label class="btn ghost sm file" class:ctl-locked={readOnly}>
        Choose a CSV<input type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" disabled={readOnly} on:change={pickFile} />
      </label>
    </div>
    <!-- The formats, in words. A tab cannot be SHOWN in a placeholder — it collapses or renders
         unpredictably depending on the browser — so the example above stays the comma one, which
         is the legible one, and the accepted set is said here instead. -->
    <p class="hint">Paste from your spreadsheet, or save it as CSV
      (<b>File → Save As → CSV</b>). Tabs, commas and semicolons all work.</p>

    {#if preview}
      <!-- What was read, and what became of line 1. The delimiter is the server's own answer, not a
           guess repeated back: it says the paste was understood, which is the thing a host has no
           other way to find out. -->
      <p class="hint">Read as {readAs}.{#if preview.headerless} No header row found — the first line
        looks like a guest, so it's been kept as one.{/if} The columns below are a guess — change
        any that are wrong.</p>

      <!-- THE FATAL SITS ABOVE THE MAPPER, NOT INSTEAD OF IT.
           There is exactly one fatal reachable here — buildImport's "map at least one column to
           Name or Email" — and it asks the host to use the very control that used to be inside the
           {:else} branch this message replaced. So it told them to do something and then hid the
           thing, which is indistinguishable from the Preview button doing nothing.
           Every OTHER refusal (empty box, an .xlsx, no rows, too many rows) is a 400 from the route
           with no preview at all, and none of them is fixable by remapping a column — so there is
           no unmappable fatal to branch on, and a branch would be inventing a case. If one is ever
           added, the rule is the one this comment states: a message that asks for a control renders
           that control. -->
      {#if preview.fatal}
        <p class="hint bad">{preview.fatal}</p>
      {/if}

      <div class="map">
        {#each preview.headers as h, i}
          <label class="mapcol">
            <span class="colname">{h}</span>
            <select value={preview.mapping[i]} disabled={readOnly} on:change={(e) => remap(i, e.currentTarget.value)}>
              {#each FIELDS as f}<option value={f}>{f === 'ignore' ? "don't import" : f}</option>{/each}
            </select>
          </label>
        {/each}
      </div>

      {#if !preview.fatal}
        <!-- A SUMMARY, not a row. It used to open with a bare bold numeral sitting in the same
             left-hand column as the monospace line numbers below it, so "1 to add" over "2  Jo
             Smith" read as lines 1 and 2 — and the host concluded the header had been imported.
             The numbering starting at 2 was the PROOF it had not. Leading with a word and a
             hairline under it puts the two back in different categories. -->
        <div class="tally">
          Ready to add <b>{preview.counts.add}</b>
          {#if preview.counts.duplicate}<span class="sep">·</span>{preview.counts.duplicate} already on the list{/if}
          <!-- Its own number, not folded into "skipped". A spreadsheet where half the people have
               no address must SAY so: it is the one skip reason the host can act on, and the one
               that otherwise turns up at the party as guests who were never invited. -->
          {#if preview.counts.noEmail}<span class="sep">·</span>{preview.counts.noEmail} with no email{/if}
          {#if preview.counts.invalid}<span class="sep">·</span>{preview.counts.invalid} bad address{preview.counts.invalid === 1 ? '' : 'es'}{/if}
          {#if preview.counts.skip}<span class="sep">·</span>{preview.counts.skip} skipped{/if}
        </div>
        {#if preview.counts.noEmail}
          <p class="hint">Rows with no email address aren't imported — print those guests a card instead.</p>
        {/if}

        <!-- Skipped rows are SHOWN, greyed, with the reason. Reporting only "160 imported" is how a
             host discovers at the party that forty of their guests were never invited. -->
        <div class="rows">
          {#if !preview.headerless}
            <!-- Line 1, by the same rule: a row that was CONSUMED and not imported should be
                 visible with its reason, not merely absent. Absent is what made the host ask why
                 the numbering started at 2 and conclude the header had been imported.
                 Rendered from `preview.headers`, which the client already has — no payload change
                 for something the server has already sent. Only when a header exists: a headerless
                 paste has no line 1 to explain, and line 1 there IS a guest. -->
            <div class="prow skip hdr">
              <span class="ln">1</span>
              <span class="pname">{preview.headers.join('  ·  ')}</span>
              <span class="prob">Header row — names the columns, not imported</span>
            </div>
          {/if}
          {#each preview.rows as r (r.line)}
            <div class="prow" class:skip={r.action === 'skip'}>
              <span class="ln">{r.line}</span>
              <span class="pname">{r.guest.name || '—'}</span>
              <span class="pmail">{r.guest.email || '—'}</span>
              {#if r.problems.length}<span class="prob">{r.problems[0]}</span>{/if}
            </div>
          {/each}
          {#if preview.truncated}
            <p class="hint">Showing the first {preview.rows.length} of {preview.total} rows.</p>
          {/if}
        </div>
      {/if}

      <!-- Shown even when there is nothing to import, and aria-disabled rather than disabled, so
           the press lands and commitImport() says what is in the way. -->
      <div class="row-acts">
        <button class="btn primary sm" disabled={readOnly}
                aria-disabled={busy || !!preview.fatal || !preview.counts.add || undefined}
                on:click={commitImport}>
          Import{preview.counts.add ? ` ${preview.counts.add} guest${preview.counts.add === 1 ? '' : 's'}` : ''}
        </button>
        <button class="btn ghost sm" on:click={() => { importOpen = false; }}>Cancel</button>
      </div>
    {/if}
  </div>
{/if}

{#if data.guests.length}
  <div class="list">
    {#each data.guests as g (g.id)}
      <!-- One row, one question at a time. Closed it answers "who, and did it land?"; opened it
           answers "what do I do about this one?" — which is the only time the address, the note,
           the date, the mail server's own words and the three buttons are any use.
           Native <details>, so the open row survives the list being replaced after a send. -->
      <details class="disc guest-disc" class:flash={flashId === g.id}>
        <summary>
          <span class="gname">{title(g)}</span>
          <span class="state">
            {#if g.suppressed}
              <!-- The one state a host cannot fix from here. It stays on the closed row because it
                   is the reason a send will skip them, which is a scanning fact, not a detail. -->
              <span class="badge bad">Blocked · {g.suppressed.reason}</span>
            {:else if g.lastInvite}
              <span class="badge {tone(g.lastInvite)}">{label(g.lastInvite)}</span>
            {:else}
              <span class="badge muted">Not invited</span>
            {/if}
          </span>
        </summary>

        <div class="disc-body">
          <div class="g-meta">
            <!-- An address must never be truncated — it is the thing the host opened the row to
                 check. `overflow-wrap: anywhere` on .sub, no ellipsis anywhere. -->
            {#each contact(g) as line}<span class="sub">{line}</span>{/each}
            {#if g.notes}<span class="sub notes">{g.notes}</span>{/if}
            {#if g.lastInvite}<span class="sub">Sent {when(g.lastInvite.sentAt)}</span>{/if}
          </div>

          {#if g.suppressed?.detail}
            <p class="reason">{g.suppressed.detail}</p>
          {/if}
          {#if g.lastInvite && quarantined(g.lastInvite)}
            <!-- Said in words, above the server's raw reply. "2.0.0 OK DMARC:Quarantine" is not a
                 sentence a host can act on, and the badge alone does not say what to do next. -->
            <p class="reason">{QUARANTINE_NOTE}</p>
          {/if}
          {#if g.lastInvite?.reason}
            <!-- The mail server's own words, not our paraphrase. "550 no such user" means fix the
                 address; "mailbox full" means try again tomorrow. Collapsing both to "failed"
                 throws away the only thing that tells the host which one they are looking at.
                 Shown for ANY status carrying a reason, not just bounced/failed. Those two had this
                 paragraph and every other status had the same text as a `title` tooltip on the
                 badge — and a tooltip cannot be reached on a phone at all, which is where hosts
                 read this. One mechanism, in the row, where there is now room for it. -->
            <p class="reason">{g.lastInvite.reason}</p>
          {/if}

          <div class="row-acts">
            {#if data.emailEnabled && !g.suppressed}
              <button class="btn ghost sm" aria-disabled={busy || undefined} disabled={readOnly}
                      on:click={() => sendOne(g.id)}>
                {g.lastInvite ? 'Resend' : 'Invite'}
              </button>
            {/if}
            <button class="btn ghost sm" on:click={() => openEdit(g)} disabled={readOnly}>Edit</button>
            <button class="btn ghost sm" on:click={() => dispatch('remove', { id: g.id })} disabled={readOnly}>Remove</button>
          </div>
        </div>
      </details>
    {/each}
  </div>
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
  /* A step up from .hint: this is the card's purpose, not a footnote to it, so it reads at body
     size in body colour. 0.85rem is the blurb size the project standardises on. */
  .why { margin: 2px 0 10px; color: var(--text); font-size: 0.85rem; line-height: 1.5; max-width: 62ch; }

  /* ── Progressive disclosure ──────────────────────────────────────────────────────────────────
     The admin page's own `.disc`, copied rather than inherited. Svelte scopes a component's styles
     to that component's markup, so the rules in routes/admin/[code]/+page.svelte cannot reach in
     here — the same boundary that made the button set below local. Copied verbatim so the two
     read as one control: native <details>, native marker suppressed, our own chevron. */
  .disc { border: 1px solid var(--border); border-radius: var(--radius-sm); margin: 0 0 12px; }
  .disc > summary { display: flex; align-items: center; gap: 8px; list-style: none; cursor: pointer;
    padding: 9px 12px; font-size: 0.78rem; font-weight: 700; color: var(--text-muted); }
  .disc > summary::-webkit-details-marker { display: none; }
  .disc > summary::before { content: '▸'; flex: none; display: inline-block; width: .8em; text-align: center; }
  .disc[open] > summary::before { content: '▾'; }
  .disc > summary:hover { color: var(--text); }
  .disc-body { padding: 0 12px 11px; display: flex; flex-direction: column; gap: 8px; }
  .disc-body .hint { margin: 0; line-height: 1.5; }
  .disc-body b { color: var(--text); font-weight: 700; }

  /* AFTER `.disc`, not before it — `.review-disc` on the admin page carries the same warning, and
     for the same reason: these are the same specificity, so source order is the whole argument.
     A guest row is a LIST row, not a card-level box, so the border and the 12px gap come off and
     one hairline underneath puts the flat list back. */
  .guest-disc { border: none; border-bottom: 1px solid var(--border); border-radius: 0; margin: 0; }
  .guest-disc > summary { padding: 9px 0; font-size: inherit; font-weight: 400; color: var(--text); }
  .guest-disc > summary::before { color: var(--text-muted); }
  .guest-disc .disc-body { padding: 0 0 10px 1.5em; }
  /* Where the guest you just saved went. `outline` and not box-shadow: the row has no padding of
     its own, so a shadow on the border box runs through the text; an outline takes no space, so
     nothing reflows, and the offset lifts it clear. position/z-index because the ring is drawn
     OUTSIDE the box, in space the next row owns — and a sibling with a background paints over it.
     Scoped, not :global, because the class is applied in this component's markup, which is what
     lets Svelte scope the keyframe name to match. */
  .flash { position: relative; z-index: 2; animation: guestflash 1.6s ease-out; }
  @keyframes guestflash {
    0%, 55% { outline: 2px solid var(--accent); outline-offset: 2px; }
    100%    { outline: 2px solid transparent;   outline-offset: 2px; }
  }
  /* A colour change, not movement — so reduced motion still gets the ring, it just does not
     animate away. */
  @media (prefers-reduced-motion: reduce) {
    .flash { animation: none; outline: 2px solid var(--accent); outline-offset: 2px; }
  }

  .gname { font-weight: 600; font-size: 0.9rem; min-width: 0; overflow-wrap: anywhere; }
  /* Right-aligned, and never squeezed: the badge is half of what the closed row says. */
  .state { display: flex; align-items: center; gap: 6px; margin-left: auto; flex: none; }
  .g-meta { display: flex; flex-direction: column; gap: 1px; }

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
  /* A <label> acting as a button, so it is a CONTROL and must not highlight as text under a
     finger. app.css matches `button`, `summary` and `.toggle` for this and cannot be expected to
     know a label class it has never seen, so this shape says so itself. */
  .file { position: relative; overflow: hidden;
    -webkit-tap-highlight-color: transparent; -webkit-user-select: none; user-select: none; }
  .file input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
  /* Says what the disabled input already does. The input is stretched over the whole label, so its
     own not-allowed cursor is what the pointer actually lands on — this is only the greying, so a
     refused control looks like every other refused control on the page. */
  .file.ctl-locked { opacity: .55; }

  .map { display: flex; gap: 8px; flex-wrap: wrap; }
  .mapcol { display: flex; flex-direction: column; gap: 3px; min-width: 130px; flex: 1; }
  .colname { font-size: 0.72rem; color: var(--text-muted); overflow-wrap: anywhere; }

  /* A hairline under it, and it leads with a word rather than a numeral — both because the bold
     count used to sit in the same left-hand column as .ln below and read as a line number. */
  .tally { font-size: 0.82rem; padding: 4px 0 6px; border-bottom: 1px solid var(--border); }
  .tally b { font-weight: 800; }
  .rows { display: flex; flex-direction: column; max-height: 260px; overflow-y: auto; }
  .prow {
    display: flex; gap: 8px; align-items: baseline;
    font-size: 0.76rem; padding: 3px 0; border-bottom: 1px solid var(--border);
  }
  .prow.skip { opacity: 0.5; }
  /* The header row is a skipped row, but it is not a guest — a little more legible than the other
     greys, and italic so it cannot be mistaken for a person at a glance. */
  .prow.hdr { opacity: 0.65; font-style: italic; }
  .ln { color: var(--text-muted); font-family: var(--font-mono); min-width: 2.2em; }
  .pname { min-width: 0; overflow-wrap: anywhere; }
  .pmail { color: var(--text-muted); min-width: 0; overflow-wrap: anywhere; }
  /* Was `.why`, which is also the card's opening blurb — two rules, one name, same specificity, so
     the blurb silently inherited this one's 0.72rem gold right-alignment. */
  .prob { margin-left: auto; color: var(--accent); font-size: 0.72rem; text-align: right; }

  .list { display: flex; flex-direction: column; }
  /* An address must never be truncated — it is the thing the host opened the row to check. */
  .sub { color: var(--text-muted); font-size: 0.76rem; overflow-wrap: anywhere; }
  .notes { font-style: italic; }

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
    margin: 0; color: var(--text-muted); font-size: 0.72rem; font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
  /* The FULL button rule set, local on purpose. app.css explains why a global one cannot work:
     Svelte emits a component's own `.btn` as `.btn.svelte-xxx.svelte-xxx.svelte-xxx`, specificity
     (0,4,0), so a global rule loses in every component that defines one and wins in the ones that
     do not — half-applied, which is worse than absent.
     This component used to carry ONLY the `.ghost` colour patch. That fixed the cold-grey UA
     ButtonFace it was written for, and left everything else: no padding, no radius, no weight, no
     `sm` sizing, and `primary` with no gold at all — so `btn primary sm` painted as a raw browser
     button. Colours without the shape is why these still did not read as Snapdini buttons. */
  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 10px 18px;
    font-size: 0.9rem; border: 1px solid transparent; cursor: pointer; text-decoration: none;
    font-family: inherit; text-align: center; }
  .btn.sm { padding: 7px 14px; font-size: 0.82rem; border-radius: var(--radius-sm); }
  .btn.primary { background: var(--accent-fill); color: var(--accent-ink, #111); }
  .btn.ghost { background: transparent; color: var(--text); border-color: var(--border); }
  .btn.ghost:hover { border-color: var(--accent); }
  .btn.on { border-color: var(--accent); color: var(--accent); }
  /* `[aria-disabled]`, not `:disabled` — every one of these still takes its press and answers it.
     See blockedPress(). */
  .btn[aria-disabled='true'] { opacity: 0.6; cursor: default; }
</style>
