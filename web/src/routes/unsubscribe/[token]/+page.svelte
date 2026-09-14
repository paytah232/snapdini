<script lang="ts">
  import { onMount } from 'svelte';
  import type { PageData } from './$types';
  export let data: PageData;

  // The unsubscribe is applied the moment this page loads, with nothing to press. Arriving here IS
  // the request — a page that opened with "confirm you want to unsubscribe" would be asking someone
  // to do the same thing twice, and every extra step is a step at which the spam button starts
  // looking easier.
  //
  // Server-side load does NOT do it, because mail scanners fetch links before a human sees them.
  // A POST from the browser is the line between "somebody opened this" and "something crawled it".
  let scope: 'event' | 'all' | null = data.scope;
  let state: 'applying' | 'done' | 'failed' = data.scope ? 'done' : 'applying';
  let busy = false;
  let err = '';

  async function setScope(next: 'event' | 'all') {
    busy = true; err = '';
    try {
      const r = await fetch(`/api/guest-unsubscribe/${data.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: next }),
      });
      if (!r.ok) throw new Error('failed');
      scope = next;
      state = 'done';
    } catch {
      state = scope ? 'done' : 'failed';
      err = 'That did not go through. Please try again.';
    } finally { busy = false; }
  }

  onMount(() => {
    // Already unsubscribed (a reopened link) → leave the stronger choice alone. Re-posting 'event'
    // here would quietly NARROW someone who had asked us to stop everything.
    if (!data.scope) void setScope('event');
  });

  // ── The optional "why", asked only once the unsubscribe above has taken effect ──
  let reason = '';
  let comment = '';
  let feedbackState: 'idle' | 'sending' | 'sent' = data.feedbackGiven ? 'sent' : 'idle';
  let feedbackErr = '';
  $: canSend = (!!reason || comment.trim().length > 0) && feedbackState !== 'sending';

  async function sendFeedback() {
    if (!canSend) return;
    feedbackState = 'sending'; feedbackErr = '';
    try {
      const r = await fetch(`/api/guest-unsubscribe/${data.token}/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason || null, comment: comment.trim() || null }),
      });
      if (!r.ok) throw new Error('failed');
      feedbackState = 'sent';
    } catch {
      feedbackState = 'idle';
      // Worded so it cannot be read as the unsubscribe having failed. That one is already done, and
      // a vague "something went wrong" here would send someone back to the spam button over a
      // comment box.
      feedbackErr = 'Your unsubscribe is saved — only the note failed to send.';
    }
  }
</script>

<svelte:head>
  <title>Unsubscribe · Snapdini</title>
  <!-- The URL is a bearer token. Nothing here should ever end up in an index. -->
  <meta name="robots" content="noindex, nofollow" />
</svelte:head>

<main class="wrap">
  <div class="card">
    <span class="brand">🎩 Snapdini</span>

    {#if state === 'applying'}
      <h1>Unsubscribing…</h1>
      <p class="sub">One moment.</p>
    {:else if state === 'failed'}
      <h1>That didn’t go through</h1>
      <p class="sub">Nothing has changed yet. Try once more — and if it still fails, reply to the
        email you got and a real person will take you off the list.</p>
      <button class="btn primary" type="button" on:click={() => setScope('event')} disabled={busy}>
        {busy ? 'Trying…' : 'Try again'}
      </button>
    {:else}
      <h1>You’re unsubscribed</h1>
      <p class="sub">
        {#if scope === 'all'}
          We won’t email <b>{data.email}</b> from Snapdini again.
        {:else}
          We won’t email <b>{data.email}</b> about <b>{data.eventName}</b> again.
        {/if}
      </p>

      {#if err}<p class="err" role="alert">{err}</p>{/if}

      <section class="group">
        <h2>Was that the right amount?</h2>
        <button
          class="choice"
          class:on={scope === 'event'}
          type="button"
          aria-pressed={scope === 'event'}
          disabled={busy}
          on:click={() => setScope('event')}
        >
          <span class="mark" aria-hidden="true">{scope === 'event' ? '✓' : ''}</span>
          <span class="rowtext">
            <span class="rowlabel">Just stop emails about {data.eventName}</span>
            <small>You can still be invited to other events by other hosts.</small>
          </span>
        </button>

        <button
          class="choice"
          class:on={scope === 'all'}
          type="button"
          aria-pressed={scope === 'all'}
          disabled={busy}
          on:click={() => setScope('all')}
        >
          <span class="mark" aria-hidden="true">{scope === 'all' ? '✓' : ''}</span>
          <span class="rowtext">
            <span class="rowlabel">Never email me from Snapdini again</span>
            <small>Any host, any event. This address is taken off everything.</small>
          </span>
        </button>
      </section>

      <!-- Asked AFTER the unsubscribe, never as a condition of it. Skipping this costs nothing and
           changes nothing above. -->
      <section class="group">
        {#if feedbackState === 'sent'}
          <h2>Thanks — that’s noted</h2>
          <p class="sub">It genuinely helps us work out which hosts are sending to people who never
            asked to hear from them.</p>
        {:else}
          <h2>Would you mind saying why?</h2>
          <p class="sub">Completely optional — you’re already unsubscribed either way.</p>

          {#each data.reasons as r (r.key)}
            <label class="row">
              <input type="radio" name="reason" value={r.key} bind:group={reason} />
              <span class="rowlabel">{r.label}</span>
            </label>
          {/each}

          <label class="row textrow" for="unsub-comment">
            <span class="rowlabel">Anything else? (optional)</span>
          </label>
          <textarea id="unsub-comment" bind:value={comment} maxlength="500" rows="3"
            placeholder="A sentence is plenty."></textarea>

          {#if feedbackErr}<p class="err" role="alert">{feedbackErr}</p>{/if}

          <button class="btn primary" type="button" on:click={sendFeedback} disabled={!canSend}>
            {feedbackState === 'sending' ? 'Sending…' : 'Send'}
          </button>
        {/if}
      </section>
    {/if}

    <noscript>
      <!-- Without JavaScript nothing above has run. One form, one button, same endpoint — an
           unsubscribe that only works when a script runs is one that sometimes does not. -->
      <section class="group">
        <h2>Unsubscribe</h2>
        <form method="POST">
          <input type="hidden" name="scope" value="event" />
          <button class="btn primary" type="submit">Stop emails about {data.eventName}</button>
        </form>
        <form method="POST">
          <input type="hidden" name="scope" value="all" />
          <button class="btn" type="submit">Never email me from Snapdini again</button>
        </form>
      </section>
    </noscript>

    <p class="tiny">Not what you expected? Write to
      <a href="mailto:support@snapdini.com">support@snapdini.com</a> — a real person reads every message.</p>
  </div>
</main>

<style>
  /* Mobile first, and meant it: this page is opened on a phone, from a mail app, by someone who
     wants to be done with it in one tap. Every target is at least 44px tall and the whole layout
     holds at 360px with no horizontal scroll. */
  :global(body) { background: var(--bg, #100f0d); }
  .wrap { min-height: 100vh; display: flex; align-items: flex-start; justify-content: center; padding: 24px 16px 56px; }
  .card { width: min(560px, 100%); box-sizing: border-box; background: var(--surface, #191713); color: var(--text, #f4efe4);
    border: 1px solid var(--border, #2b271f); border-radius: 18px; padding: 26px 20px; box-shadow: 0 24px 60px rgba(0,0,0,.4); }
  .brand { display: inline-block; background: var(--accent, #f0b429); color: #17140e; padding: 7px 13px; border-radius: 9px;
    font-weight: 800; font-size: 1rem; }
  h1 { font-size: 1.45rem; margin: 20px 0 6px; letter-spacing: -.01em; line-height: 1.25; }
  h2 { font-size: 1rem; margin: 0 0 10px; font-weight: 650; }
  .sub { color: var(--text-muted, #a39b8c); margin: 0 0 8px; font-size: .96rem; line-height: 1.5; overflow-wrap: anywhere; }
  .err { color: #ff6b6b; font-size: .88rem; margin: 12px 0 0; }
  .group { padding: 20px 0 0; margin-top: 18px; border-top: 1px solid var(--border, #2b271f); }

  /* The scope choices. Buttons rather than radios: one press both selects and applies, so there is
     no second "save" step between changing your mind and it being true. */
  .choice { display: flex; gap: 12px; align-items: flex-start; width: 100%; box-sizing: border-box; text-align: left;
    min-height: 56px; padding: 13px 14px; margin-bottom: 10px; cursor: pointer; font: inherit; color: inherit;
    background: var(--bg, #100f0d); border: 1px solid var(--border, #3a3630); border-radius: 11px; }
  .choice.on { border-color: var(--accent, #f0b429); }
  .choice:disabled { opacity: .6; cursor: default; }
  .mark { flex: none; width: 22px; text-align: center; color: var(--accent, #f0b429); font-weight: 800; }

  .row { display: flex; gap: 12px; align-items: center; min-height: 44px; padding: 10px 14px; margin-bottom: 8px;
    cursor: pointer; background: var(--bg, #100f0d); border: 1px solid var(--border, #3a3630); border-radius: 11px; }
  .row input { width: 22px; height: 22px; margin: 0; accent-color: var(--accent, #f0b429); flex: none; }
  .textrow { background: transparent; border: 0; padding: 12px 2px 4px; margin: 0; cursor: default; }
  .rowtext { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .rowlabel { font-size: .95rem; font-weight: 600; line-height: 1.35; }
  .rowtext small { color: var(--text-muted, #a39b8c); font-size: .82rem; line-height: 1.45; }

  textarea { width: 100%; box-sizing: border-box; min-height: 88px; padding: 12px 13px; border-radius: 10px;
    border: 1px solid var(--border, #3a3630); background: var(--bg, #100f0d); color: var(--text, #f4efe4);
    font: inherit; font-size: 1rem; resize: vertical; }

  .btn { display: block; width: 100%; box-sizing: border-box; margin-top: 10px; min-height: 48px; padding: 13px 20px;
    border-radius: 10px; border: 1px solid var(--border, #3a3630); background: transparent; color: var(--text, #f4efe4);
    font: inherit; font-weight: 700; cursor: pointer; }
  .btn.primary { background: var(--accent, #f0b429); color: #17140e; border-color: transparent; font-size: 1rem; }
  .btn:disabled { opacity: .6; cursor: default; }

  .tiny { text-align: center; color: var(--text-muted, #a39b8c); font-size: .78rem; line-height: 1.5; margin: 22px 0 0; }
  .tiny a { color: var(--accent, #f0b429); }

  @media (max-width: 380px) {
    .card { padding: 20px 14px; }
    h1 { font-size: 1.3rem; }
  }
</style>
