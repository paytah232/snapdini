<script lang="ts">
  import type { PageData } from './$types';
  export let data: PageData;

  // Ticked means UNSUBSCRIBED. Seeded from what is actually stored rather than always-empty: on a
  // first visit nothing is stored, so the page opens all-unticked as intended — but someone coming
  // back to check, or to put one back, has to see the state they are actually in. An always-empty
  // form would show them as subscribed and then re-subscribe them the moment they saved.
  let off: Record<string, boolean> = Object.fromEntries(data.optional.map((k) => [k.key, k.optedOut]));

  let busy = false, saved = false, err = '';
  $: allOff = data.optional.every((k) => off[k.key]);

  async function save(next: Record<string, boolean> = off) {
    if (busy) return;
    busy = true; err = ''; saved = false;
    try {
      // The whole desired set, not a change: saving twice, or from two open copies of this link,
      // must land on the state the person can see rather than on whatever arrived last.
      const optOut = data.optional.filter((k) => next[k.key]).map((k) => k.key);
      const r = await fetch(`/api/email-prefs/${data.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optOut }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d as { error?: string }).error || 'Could not save — please try again.');
      off = next;
      saved = true;
    } catch (e) {
      err = e instanceof Error ? e.message : 'Could not save.';
    } finally { busy = false; }
  }

  function unsubscribeAll() {
    save(Object.fromEntries(data.optional.map((k) => [k.key, true])));
  }
</script>

<svelte:head>
  <title>Email preferences · Snapdini</title>
  <!-- The URL is a bearer token. Nothing here should ever end up in an index. -->
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="wrap">
  <div class="card">
    <span class="brand">🎩 Snapdini</span>

    <h1>Email preferences</h1>
    <p class="sub">These are the emails we send to <b>{data.email}</b>. Tick anything you'd rather not get.</p>

    {#if saved}
      <p class="ok" role="status">
        {allOff
          ? 'Saved — we won’t send you any of the optional emails below.'
          : 'Saved. Your choices take effect straight away.'}
      </p>
    {/if}

    <section class="group">
      <h2>Optional emails</h2>
      {#each data.optional as k (k.key)}
        <label class="row">
          <input type="checkbox" bind:checked={off[k.key]} disabled={busy} />
          <span class="rowtext">
            <span class="rowlabel">{k.label}</span>
            <small>{k.description}</small>
            <small class="state">{off[k.key] ? 'Unsubscribed' : 'Currently on'}</small>
          </span>
        </label>
      {/each}

      {#if err}<p class="err" role="alert">{err}</p>{/if}

      <button class="btn primary" type="button" on:click={() => save()} disabled={busy}>
        {busy ? 'Saving…' : 'Save my preferences'}
      </button>
      <button class="btn" type="button" on:click={unsubscribeAll} disabled={busy || allOff}>
        {allOff ? 'You’re unsubscribed from all of these' : 'Unsubscribe from all optional emails'}
      </button>
    </section>

    <section class="group keep">
      <h2>We’ll still email you about your events</h2>
      <p class="sub">These aren’t marketing — they’re about an event you’ve set up, or about getting
        into your account, so they keep coming.</p>
      {#each data.service as k}
        <div class="row static">
          <span class="tick" aria-hidden="true">✓</span>
          <span class="rowtext">
            <span class="rowlabel">{k.label}</span>
            <small>{k.description}</small>
          </span>
        </div>
      {/each}
    </section>

    <p class="tiny">Not what you expected? Reply to any of our emails, or write to
      <a href="mailto:support@snapdini.com">support@snapdini.com</a> — a real person reads every message.</p>
  </div>
</main>

<style>
  :global(body) { background: var(--bg, #100f0d); }
  .wrap { min-height: 100vh; display: flex; align-items: flex-start; justify-content: center; padding: 32px 16px 64px; }
  .card { width: min(560px, 100%); background: var(--surface, #191713); color: var(--text, #f4efe4);
    border: 1px solid var(--border, #2b271f); border-radius: 18px; padding: 28px 22px; box-shadow: 0 24px 60px rgba(0,0,0,.4); }
  .brand { display: inline-block; background: var(--accent, #f0b429); color: #17140e; padding: 7px 13px; border-radius: 9px;
    font-weight: 800; font-size: 1rem; }
  h1 { font-size: 1.5rem; margin: 20px 0 6px; letter-spacing: -.01em; line-height: 1.2; }
  h2 { font-size: 1rem; margin: 0 0 10px; font-weight: 650; }
  .sub { color: var(--text-muted, #a39b8c); margin: 0 0 8px; font-size: .96rem; line-height: 1.5; }
  .ok { background: color-mix(in srgb, var(--accent, #f0b429) 14%, transparent); border: 1px solid var(--border, #3a3630);
    border-radius: 9px; padding: 11px 13px; font-size: .9rem; margin: 16px 0 0; }
  .err { color: #ff6b6b; font-size: .88rem; margin: 12px 0 0; }

  .group { padding: 22px 0 0; margin-top: 20px; border-top: 1px solid var(--border, #2b271f); }

  /* One tap target per choice, the whole row — a 20px checkbox on a phone is a miss waiting to
     happen, and a missed tap on an unsubscribe page reads as the page ignoring you. */
  .row { display: flex; gap: 13px; align-items: flex-start; min-height: 44px; padding: 13px 14px; margin-bottom: 10px;
    cursor: pointer; background: var(--bg, #100f0d); border: 1px solid var(--border, #3a3630); border-radius: 11px; }
  .row.static { cursor: default; }
  .row input { width: 22px; height: 22px; margin: 1px 0 0; accent-color: var(--accent, #f0b429); flex: none; }
  .tick { flex: none; width: 22px; text-align: center; color: var(--accent, #f0b429); font-weight: 800; }
  .rowtext { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .rowlabel { font-size: .95rem; font-weight: 600; }
  .rowtext small { color: var(--text-muted, #a39b8c); font-size: .82rem; line-height: 1.45; }
  .state { text-transform: uppercase; letter-spacing: .05em; font-size: .68rem !important; }

  .btn { display: block; width: 100%; box-sizing: border-box; margin-top: 10px; min-height: 48px; padding: 13px 20px;
    border-radius: 10px; border: 1px solid var(--border, #3a3630); background: transparent; color: var(--text, #f4efe4);
    text-decoration: none; font: inherit; font-weight: 700; cursor: pointer; }
  .btn.primary { background: var(--accent, #f0b429); color: #17140e; border-color: transparent; font-size: 1rem; }
  .btn:disabled { opacity: .6; cursor: default; }

  .keep .row { background: transparent; border-style: dashed; }
  .tiny { text-align: center; color: var(--text-muted, #a39b8c); font-size: .78rem; line-height: 1.5; margin: 22px 0 0; }
  .tiny a { color: var(--accent, #f0b429); }

  @media (max-width: 380px) {
    .card { padding: 22px 16px; }
    h1 { font-size: 1.32rem; }
  }
</style>
