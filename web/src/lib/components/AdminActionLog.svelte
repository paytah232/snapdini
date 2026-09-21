<script lang="ts">
  /* What a site admin changed on somebody else's event.
   *
   *  THERE IS NO REVERT BUTTON, and that is a decision rather than an omission — the same decision
   *  the migration that created the table wrote down (0068), for the same reason. An automated
   *  revert has to answer "what if the host has changed it themselves since?", which is a merge,
   *  and a merge on settings nobody is watching resolves itself wrong about as often as right. It
   *  would also be a second, hidden write path into a customer's event, running outside the
   *  guardrail the manager now puts in front of every other control.
   *
   *  So the BEFORE VALUE is the product here, not a column. It is rendered selectable, it is never
   *  truncated out of existence, and it has its own copy button — because the recovery is "read
   *  this, go to the control, set it back", and every character of friction in that loop is
   *  friction in the only remedy there is.
   *
   *  ONE GENERIC RENDERER, not a layout per feature. `before`/`after` arrive as objects with the
   *  same keys holding only what moved, so a row is `key: was X · now Y` whatever the action was —
   *  a settings save, a rotation, a bulk moderation, and the toggle nobody has written yet. That is
   *  why the table is shaped that way; see $lib/events for the unzip.
   *
   *  Defensive about its own data on purpose. Rows come through normalizeAdminAction, so a field
   *  the server renames shows as an em dash instead of taking the page down. This is the screen
   *  somebody opens when something has already gone wrong; it does not get to be the second thing
   *  that is broken. */
  import { onMount } from 'svelte';
  import { ApiError } from '$lib/api';
  import { listAdminActions, type AdminAction } from '$lib/events';
  import { showToast } from '$lib/toast';

  /** Filter to one event. Null is the platform-wide view (the console). */
  export let eventId: string | null = null;
  export let limit = 25;
  /** The manager shows this inside a card that already has a title; the console gives it its own. */
  export let heading = '';
  /** In the manager the event is implied by the page, so its column would read the same on every
   *  row and say nothing. */
  export let showEvent = true;
  /** Closed unless somebody asks for it, everywhere.
   *
   *  This is a record you consult when something looks wrong, not a feed. Open by default it is the
   *  first thing on the screen every single visit, most of them about something else entirely —
   *  which is how a log stops being read: not by being hidden, but by always being there. */
  export let startOpen = false;
  /** Does this component provide its OWN show/hide?
   *
   *  False where the caller already has one. The manager wraps this in a titled disclosure of its
   *  own, and two nested ones mean two presses to reach a list — the second of which looks like the
   *  page is broken, because the first press appears to do nothing. */
  export let collapsible = true;

  let open = collapsible ? startOpen : true;
  /** Which event groups are expanded, by key. A Set rather than a flag on the row, so collapsing a
   *  group and loading more pages does not lose what was open. */
  let openGroups = new Set<string>();

  function toggleGroup(key: string) {
    openGroups.has(key) ? openGroups.delete(key) : openGroups.add(key);
    openGroups = openGroups;   // Svelte does not see Set mutation
  }

  let rows: AdminAction[] = [];
  let total = 0;
  let loading = true;
  let loadingMore = false;
  /** Told apart from "nothing happened yet", because the two look identical — an empty list — and
   *  mean opposite things. */
  let failed = '';
  /** 404/501 from a route that is not deployed on this server. Said in those words rather than as
   *  an error, so nobody spends an afternoon debugging a backend that simply is not there. */
  let notYet = false;

  async function load(more = false) {
    if (more) loadingMore = true; else loading = true;
    try {
      const page = await listAdminActions({ eventId, limit, offset: more ? rows.length : 0 });
      rows = more ? [...rows, ...page.actions] : page.actions;
      total = page.total;
      failed = '';
      notYet = false;
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 501)) notYet = true;
      // Keep what is already on screen when a "load more" fails: blanking a list somebody is
      // reading because the NEXT page did not arrive loses the part that did.
      else if (!more || !rows.length) failed = e instanceof Error ? e.message : 'Could not load the log';
      else showToast('Could not load more of the log', true);
    } finally {
      loading = false;
      loadingMore = false;
    }
  }

  onMount(() => { void load(); });

  /* One entry per EVENT, newest activity first.
   *
   *  Flat, this list answers "what happened recently" and nothing else. The question actually asked
   *  of it is "what was done to THIS customer's event", and with fifty rows spread across a dozen
   *  events that question takes a scroll and a squint. Grouping puts one line per event on screen
   *  with its count, and the detail one press away.
   *
   *  Rows arrive newest-first, and inserting into a plain object keeps insertion order for string
   *  keys — so groups come out ordered by most recent activity with no sort at all.
   *
   *  The manager gets exactly one group and never renders its header: the event is the page. */
  type Group = { key: string; name: string; code: string; exists: boolean; items: AdminAction[] };
  $: groups = (() => {
    const by = new Map<string, Group>();
    for (const a of rows) {
      const key = a.eventId || a.eventCode || '—';
      let g = by.get(key);
      if (!g) { g = { key, name: a.eventName, code: a.eventCode, exists: a.eventExists, items: [] }; by.set(key, g); }
      g.items.push(a);
    }
    return [...by.values()];
  })();

  const when = (at: number | null) => (at === null ? '—' : new Date(at).toLocaleString());
  /** Em dash for absent, so a row missing one field still reads as a row. */
  const or = (s: string) => (s ? s : '—');

  async function copyValue(v: string) {
    if (!v) { showToast('Nothing recorded as the previous value', true); return; }
    try {
      await navigator.clipboard.writeText(v);
      showToast('Previous value copied');
    } catch {
      // No clipboard (insecure origin, or a browser that refuses). The value is selectable in the
      // row, so say that rather than pretending it worked.
      showToast('Select the value and copy it', true);
    }
  }
</script>

<div class="log">
  <!-- The whole log behind one press. `aria-expanded` on the button that does the expanding, so a
       screen reader is told the same thing the caret says. Suppressed when the caller is already
       providing the disclosure — see `collapsible`. -->
  {#if collapsible}
    <button class="disclose" on:click={() => (open = !open)} aria-expanded={open}>
      <span class="caret" class:on={open} aria-hidden="true">▸</span>
      <span class="d-title">{heading || 'Admin changes to this event'}</span>
      {#if total}<span class="count">{total}</span>{/if}
    </button>
  {/if}

  {#if !open}
    <!-- Nothing else. A collapsed log that still explains itself is a log that is not collapsed. -->
  {:else if loading}
    <p class="muted">Loading…</p>
  {:else if notYet}
    <p class="muted">The action log isn't live on this server yet. It fills in on its own once the
      endpoint ships — nothing here needs changing.</p>
  {:else if failed}
    <p class="bad">{failed}</p>
    <button class="log-btn" on:click={() => void load()}>Try again</button>
  {:else if !rows.length}
    <p class="muted">
      {#if eventId}Nothing in this event has been changed by a site admin.
      {:else}No site admin has changed anyone else's event.{/if}
    </p>
  {:else}
    {#each groups as g (g.key)}
      {#if showEvent}
        <!-- One line per event: who it is, how much happened, and when it last did. Enough to decide
             whether to open it, which is the only decision being made at this level. -->
        <button class="grp" on:click={() => toggleGroup(g.key)} aria-expanded={openGroups.has(g.key)}>
          <span class="caret" class:on={openGroups.has(g.key)} aria-hidden="true">▸</span>
          <span class="g-name">{g.name || g.code || g.key}</span>
          {#if !g.exists}<span class="r-gone">deleted</span>{/if}
          <span class="g-meta">{g.items.length} change{g.items.length === 1 ? '' : 's'} · {when(g.items[0].at)}</span>
        </button>
      {/if}
      {#if !showEvent || openGroups.has(g.key)}
    <ul class="rows">
      {#each g.items as a (a.id)}
        <li class="row">
          <div class="r-head">
            <span class="r-what">{or(a.action)}{#if a.target}<span class="r-target">{a.target}</span>{/if}</span>
            <span class="r-when">{when(a.at)}</span>
          </div>
          <div class="r-who">
            {or(a.actor)}
            {#if showEvent && (a.eventName || a.eventCode || a.eventId)}
              <span class="r-sep">·</span>
              {#if a.eventExists && a.eventCode}
                <!-- The join code, never the name: the manager route is keyed by code, and a link
                     built from a name would 404. And only while the event still exists — one of the
                     actions recorded here is `event.delete`, and a link to a deleted event is a
                     dead end offered as a way forward. -->
                <a class="r-ev" href={`/admin/${a.eventCode}`}>{a.eventName || a.eventCode}</a>
              {:else}
                <span class="r-ev">{a.eventName || a.eventCode || a.eventId}</span>
                {#if !a.eventExists}<span class="r-gone">deleted</span>{/if}
              {/if}
            {/if}
          </div>

          {#if a.changes.length}
            <!-- was → now, in that order and with `was` given the weight, because `was` is the one
                 you act on. -->
            <div class="changes">
              {#each a.changes as c (c.key)}
                <div class="chg">
                  <span class="c-key">{c.key}</span>
                  <div class="vals">
                    <div class="val before">
                      <span class="v-label">was</span>
                      <code class="v">{or(c.before)}</code>
                      <button class="v-copy" title="Copy the previous value" aria-label="Copy the previous value for {c.key}"
                              on:click={() => void copyValue(c.before)}>⧉</button>
                    </div>
                    <div class="val after">
                      <span class="v-label">now</span>
                      <code class="v">{or(c.after)}</code>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {:else if a.before || a.after}
            <!-- Not key-shaped: a scalar pair, or a shape this client has not been taught. Shown raw
                 rather than dropped — a value you can read is worth more than a tidy blank. -->
            <div class="chg">
              <div class="vals">
                <div class="val before">
                  <span class="v-label">was</span>
                  <code class="v">{or(a.before)}</code>
                  <button class="v-copy" title="Copy the previous value" aria-label="Copy the previous value"
                          on:click={() => void copyValue(a.before)}>⧉</button>
                </div>
                <div class="val after">
                  <span class="v-label">now</span>
                  <code class="v">{or(a.after)}</code>
                </div>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
      {/if}
    {/each}
    {#if rows.length < total}
      <button class="log-btn" on:click={() => void load(true)} disabled={loadingMore}>
        {loadingMore ? 'Loading…' : `Load more — ${rows.length} of ${total}`}
      </button>
    {/if}
    <p class="foot">No undo, on purpose — the “was” value is the fix: copy it and set it back through
      the normal control, so every check that control carries still runs.</p>
  {/if}
</div>

<style>
  .log { min-width: 0; }
  /* The two disclosures share a caret and differ in weight: the outer one is a heading, the inner
     one is a row in a list. */
  .disclose, .grp {
    display: flex; align-items: center; gap: 8px; width: 100%;
    background: none; border: 0; padding: 8px 0; cursor: pointer;
    color: var(--text); font: inherit; text-align: left;
  }
  .disclose { font-weight: 700; font-size: 1.02rem; }
  .grp { border-top: 1px solid var(--border); font-size: 0.9rem; }
  .caret { display: inline-block; transition: transform .15s ease; flex: none; color: var(--text-muted); }
  .caret.on { transform: rotate(90deg); }
  @media (prefers-reduced-motion: reduce) { .caret { transition: none; } }
  .d-title, .g-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .g-name { font-weight: 600; }
  /* Pushed to the far end so the counts line up down the list and can be compared at a glance. */
  .g-meta { margin-left: auto; color: var(--text-muted); font-size: 0.78rem; white-space: nowrap; }
  .count { margin-left: 8px; font-size: 0.8rem; font-weight: 600; color: var(--text-muted); }
  .muted { color: var(--text-muted); font-size: 0.86rem; margin: 0; }
  .bad { color: #c0392b; font-size: 0.86rem; margin: 0 0 8px; }

  /* A list of rows rather than a table. The console's other panels are tables because their columns
     are short and comparable; a before-value is neither — it can be one character or a whole theme
     object — and in a table cell it either wraps the row to four lines or gets clipped to
     uselessness. Rows let the values have the space they need without dragging six other columns
     along. It also survives the manager's 720px column, where a six-column table cannot go. */
  .rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
  .row { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px;
         background: var(--surface-2, transparent); }
  .r-head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  .r-what { font-weight: 700; font-size: 0.88rem; }
  .r-target { margin-left: 6px; font-weight: 600; color: var(--text-muted); font-family: var(--font-mono); font-size: 0.8rem; }
  .r-when { color: var(--text-muted); font-size: 0.78rem; white-space: nowrap; }
  .r-who { color: var(--text-muted); font-size: 0.8rem; margin-top: 2px; }
  .r-sep { opacity: 0.6; margin: 0 4px; }
  .r-ev { color: inherit; }
  .r-gone { margin-left: 6px; font-size: 0.72rem; font-weight: 700; text-transform: uppercase;
            letter-spacing: 0.05em; color: #c0392b; }

  .changes { display: flex; flex-direction: column; gap: 8px; }
  .chg { margin-top: 8px; }
  .c-key { display: block; font-family: var(--font-mono); font-size: 0.78rem; font-weight: 700;
           margin-bottom: 3px; overflow-wrap: anywhere; }
  .vals { display: grid; gap: 6px; }
  .val { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
  .v-label { flex: none; width: 34px; font-size: 0.72rem; font-weight: 800; letter-spacing: 0.06em;
             text-transform: uppercase; color: var(--text-muted); padding-top: 3px; }
  /* WRAPS rather than scrolls or ellipses. A before-value you cannot read in full is a recovery you
     cannot perform, and overflow-x on a phone hides the end of the string behind a gesture nobody
     discovers. `user-select: all` makes one tap select the whole value for the copy that follows —
     the clipboard button is the fast path, this is the one that always works. */
  .v { flex: 1 1 auto; min-width: 0; font-family: var(--font-mono); font-size: 0.8rem;
       overflow-wrap: anywhere; white-space: pre-wrap; user-select: all;
       background: var(--surface, rgba(127,127,127,.08)); border-radius: 6px; padding: 3px 7px; }
  .val.before .v { border-left: 3px solid #c0392b; }
  .val.after .v { border-left: 3px solid var(--accent, #f5c518); }
  .v-copy { flex: none; border: 1px solid var(--border); background: transparent; color: var(--text-muted);
            border-radius: 6px; padding: 2px 7px; font: inherit; font-size: 0.78rem; cursor: pointer; }
  .v-copy:hover { color: var(--text); border-color: var(--accent); }

  .log-btn { margin-top: 10px; border: 1px solid var(--border); background: transparent; color: var(--text);
             border-radius: var(--radius-sm, 8px); padding: 7px 14px; font: inherit; font-size: 0.82rem;
             font-weight: 700; cursor: pointer; }
  .log-btn:hover:not(:disabled) { border-color: var(--accent); }
  .log-btn:disabled { opacity: 0.6; cursor: default; }
  .foot { color: var(--text-muted); font-size: 0.76rem; line-height: 1.45; margin: 10px 0 0; }

  @media (min-width: 640px) {
    /* Side by side once there is room for two readable columns. Below that they stack, because two
       monospace values in half a phone width is two columns of one word each. */
    .vals { grid-template-columns: 1fr 1fr; }
  }
</style>
