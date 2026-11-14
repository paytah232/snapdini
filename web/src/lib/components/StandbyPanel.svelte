<script lang="ts">
  /* The failover standby, as the host-side runner sees it, and the one thing an admin may ask of it.
   *
   *  Opened from a phone, from an alert, often mid-incident — so it says plainly what is wrong and
   *  what the button will do, and the button is a typed confirmation, not a tap. A REBUILD discards
   *  the standby's database and re-clones it from production; the runner re-checks every gate
   *  before it starts and may still refuse (see app/src/server/standby.ts). */
  import { onDestroy, onMount } from 'svelte';
  import { api, postJson, ApiError } from '$lib/api';
  import { showToast } from '$lib/toast';

  type Check = { name: string; ok: boolean; detail: string };
  type Status = { checkedAt: number; healthy: boolean; summary: string; checks: Check[]; canRebuild: boolean; blockReason: string | null };
  type Req = { id: string; state: 'requested' | 'running' | 'done' | 'failed' | 'refused'; requestedBy: string;
               requestedAt: number; startedAt: number | null; finishedAt: number | null; steps: { at: number; msg: string }[]; error: string | null };
  type View = { status: Status | null; request: Req | null; staleAfterMs: number; confirmWord: string };

  let view: View | null = null;
  let loadError = '';
  let confirming = false;
  let typed = '';
  let sending = false;
  let now = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  $: status = view?.status ?? null;
  $: req = view?.request ?? null;
  $: active = !!req && (req.state === 'requested' || req.state === 'running');
  $: stale = !!status && !!view && now - status.checkedAt > view.staleAfterMs;
  $: panelState = !status ? 'none' : stale ? 'stale' : status.healthy ? 'ok' : 'bad';
  $: blocked = !status ? 'No standby runner is reporting.'
    : stale ? 'The runner has stopped reporting, so nothing would pick a request up.'
    : active ? `A rebuild is already ${req?.state}.`
    : !status.canRebuild ? (status.blockReason || 'The runner reports that a rebuild is not allowed right now.')
    : '';

  const ago = (ms: number) => {
    const s = Math.max(0, Math.round((now - ms) / 1000));
    if (s < 90) return `${s}s ago`;
    const m = Math.round(s / 60);
    return m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  };
  const clock = (ms: number | null) => (ms ? new Date(ms).toLocaleTimeString() : '—');

  async function load() {
    try { view = await api<View>('/api/admin/standby'); loadError = ''; }
    catch (e) { loadError = e instanceof ApiError ? e.message : 'Could not load standby status.'; }
    now = Date.now();
    clearTimeout(timer);
    // Fast while a rebuild is in flight so the steps read as progress; otherwise the runner only
    // reports once a minute and polling faster would show nothing new.
    const r = view?.request;   // not `active`: reactive statements have not re-run yet inside this function
    timer = setTimeout(load, r && (r.state === 'requested' || r.state === 'running') ? 4000 : 30000);
  }

  async function submit() {
    if (!view || typed !== view.confirmWord) return;
    sending = true;
    try {
      await postJson('/api/admin/standby/rebuild', { confirm: typed });
      showToast('Rebuild requested — the runner picks it up within a minute.');
      confirming = false; typed = '';
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : 'Request failed.');
    } finally {
      sending = false;
      load();
    }
  }

  onMount(load);
  onDestroy(() => clearTimeout(timer));
</script>

<!-- The page is /siteadmin/standby and this is all of it, so the heading is its h1. -->
<section class="standby">
  <h1>
    Failover standby
    <span class="pill {panelState}">
      {panelState === 'ok' ? 'Healthy' : panelState === 'bad' ? 'Needs attention' : panelState === 'stale' ? 'Runner silent' : 'Not reporting'}
    </span>
  </h1>

  {#if loadError}
    <p class="err">{loadError}</p>
  {:else if !view}
    <p class="muted">Loading…</p>
  {:else if !status}
    <p class="muted">No standby runner has reported. Nothing to show unless a standby and its runner are set up.</p>
  {:else}
    <p class="summary">{status.summary || (status.healthy ? 'All checks passing.' : 'One or more checks failing.')}
      <span class="muted">· checked {ago(status.checkedAt)}</span></p>
    {#if status.checks.length}
      <ul class="checks">
        {#each status.checks as c}
          <li class:fail={!c.ok}><span class="mark" aria-label={c.ok ? 'passing' : 'failing'}>{c.ok ? '✓' : '✗'}</span>
            <span class="name">{c.name}</span>{#if c.detail}<span class="detail">{c.detail}</span>{/if}</li>
        {/each}
      </ul>
    {/if}
  {/if}

  {#if req}
    <div class="req {req.state}">
      <div class="req-head">
        <strong>Last rebuild: {req.state}</strong>
        <span class="muted">asked by {req.requestedBy} at {clock(req.requestedAt)}{#if req.finishedAt}&nbsp;· finished {clock(req.finishedAt)}{/if}</span>
      </div>
      {#if req.error}<p class="err">{req.error}</p>{/if}
      {#if req.steps.length}
        <ol class="steps">
          {#each req.steps.slice(-12) as s}<li><span class="muted">{clock(s.at)}</span> {s.msg}</li>{/each}
        </ol>
      {/if}
    </div>
  {/if}

  {#if view && status}
    {#if !confirming}
      <button class="btn danger" disabled={!!blocked} on:click={() => { confirming = true; typed = ''; }}>Rebuild standby…</button>
      {#if blocked}<p class="muted small">{blocked}</p>{/if}
    {:else}
      <div class="confirm">
        <p>This <strong>discards the standby's database</strong> and re-clones it from production, then
          re-arms replication, media mirroring and the failover watcher. Production keeps serving
          throughout; the standby cannot take over until it finishes (a few minutes).</p>
        <label><span>Type <code>{view.confirmWord}</code> to confirm</span>
          <input bind:value={typed} autocomplete="off" autocapitalize="characters" spellcheck="false" />
        </label>
        <div class="row">
          <button class="btn danger" disabled={typed !== view.confirmWord || sending} on:click={submit}>
            {sending ? 'Requesting…' : 'Request rebuild'}</button>
          <button class="btn ghost" on:click={() => { confirming = false; typed = ''; }}>Cancel</button>
        </div>
      </div>
    {/if}
  {/if}
</section>

<style>
  .standby { margin-bottom: 30px; }
  h1 { margin: 6px 0 8px; font-size: 1.6rem; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .pill { border-radius: 999px; padding: 1px 10px; font-size: 0.76rem; font-weight: 700; background: var(--border, #eee); color: var(--text-muted); }
  .pill.ok { background: #1e8449; color: #fff; }
  .pill.bad, .pill.stale { background: #c0392b; color: #fff; }
  .muted { color: var(--text-muted); }
  .small { font-size: 0.85rem; margin: 6px 0 0; }
  .err { color: #c0392b; }
  .summary { margin: 4px 0 8px; }
  .checks { list-style: none; padding: 0; margin: 0 0 12px; display: grid; gap: 4px; font-size: 0.9rem; }
  .checks li { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; }
  .mark { color: #1e8449; font-weight: 700; width: 1em; flex: none; }
  .fail .mark { color: #c0392b; }
  .name { font-weight: 600; }
  .detail { color: var(--text-muted); overflow-wrap: anywhere; }
  .req { border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; margin: 0 0 12px; font-size: 0.9rem; }
  .req.failed, .req.refused { border-color: #c0392b; }
  .req-head { display: flex; gap: 8px; flex-wrap: wrap; align-items: baseline; }
  .steps { margin: 8px 0 0; padding-left: 1.2em; display: grid; gap: 2px; overflow-wrap: anywhere; }
  .confirm { border: 1px solid #c0392b; border-radius: 10px; padding: 12px; max-width: 560px; }
  .confirm p { margin: 0 0 10px; }
  .confirm label { display: grid; gap: 6px; font-size: 0.9rem; }
  .confirm input { font: inherit; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg, #fff); color: var(--text); max-width: 220px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; }
  .btn { display: inline-block; margin-top: 10px; padding: 8px 14px; border-radius: 10px; border: 1px solid transparent; cursor: pointer; font: inherit; font-weight: 700; }
  .btn:disabled { opacity: .5; cursor: not-allowed; }
  .btn.danger { background: #c0392b; color: #fff; }
  .btn.ghost { background: transparent; color: var(--text); border-color: var(--border); }
</style>
