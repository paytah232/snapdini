<script lang="ts">
  // One shareable link, with every way of handing it to someone in one place.
  //
  // Both kinds of link — the standing gallery link every event has, and the curated shares a host
  // creates — are the same object from the host's point of view: a URL, a name, and three ways to
  // pass it on. They had drifted apart, with the gallery link owning an email box that was always
  // open and the custom shares having no email path at all.
  //
  // The three actions are genuinely different jobs, not one job with options:
  //   Copy  — paste it wherever you were already talking to this person
  //   Share — hand it to the OS sheet: WhatsApp, Messenger, wherever the guests actually are
  //   Email — we send it, and we remember who we sent it to
  //
  // Email is collapsed by default. It is the heaviest of the three and the least often wanted, and
  // left open it pushed the links themselves down the card.
  import { createEventDispatcher } from 'svelte';
  import type { LinkSend } from '$lib/events';

  export let url: string;
  export let title: string;
  export let subtitle = '';
  /** Null for the standing gallery link; a share id for a created one. Also the key that picks
   *  this row's sends out of the event-wide list. */
  export let shareId: string | null = null;
  /** Only render the email disclosure when the server can actually send. Without this the host
   *  gets a form that silently does nothing on a self-host with no SMTP configured. */
  export let canEmail = false;
  export let sends: LinkSend[] = [];
  /** Extra controls the caller owns — Edit and Delete on a created share, a tag on the standing
   *  one. Kept as a slot so this component never has to know which kind of link it is holding. */
  export let busy = false;

  const dispatch = createEventDispatcher<{
    copy: { url: string };
    send: { emails: string[]; shareId: string | null };
  }>();

  let emailOpen = false;
  let listOpen = false;
  let input = '';

  // The OS share sheet, where one exists. On a desktop there is usually no sheet at all, so the
  // button is simply absent rather than present and inert — a control that does nothing when
  // pressed is worse than one that was never offered.
  let canShare = false;
  $: canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function nativeShare() {
    try {
      await navigator.share({ title, url });
    } catch {
      /* A dismissed sheet throws AbortError, which is not a failure — the person changed their
         mind. Nothing to report either way. */
    }
  }

  function submit() {
    const emails = input.split(/[,;\s]+/).map((e) => e.trim()).filter(Boolean);
    if (!emails.length) return;
    dispatch('send', { emails, shareId });
    input = '';
  }

  // Newest first, and one row per address: re-sending to the same person is a real event the host
  // may want to see ("I sent it again on Tuesday"), not a duplicate to collapse.
  $: mine = sends.filter((s) => s.shareId === shareId);
  $: failed = mine.filter((s) => !s.ok).length;
  const when = (t: number) =>
    new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
</script>

<div class="row">
  <div class="head">
    <div class="who">
      <span class="title">{title}</span>
      {#if subtitle}<span class="sub">{subtitle}</span>{/if}
    </div>
    <div class="acts">
      <slot name="tag" />
      <button class="btn ghost sm" on:click={() => dispatch('copy', { url })}>🔗 Copy</button>
      {#if canShare}
        <button class="btn ghost sm" on:click={nativeShare}>📤 Share</button>
      {/if}
      {#if canEmail}
        <!-- A third way of handing the link over, sitting with the other two rather than on a row
             of its own. It was a disclosure bar under every link, which meant a permanent extra row
             per link for something most hosts never use — and it read as a heading for the link
             below it as much as a control for the one above. As a button it is simply absent until
             pressed, and the count rides along so "have I already sent this?" is answerable without
             opening anything. -->
        <button class="btn ghost sm" class:on={emailOpen} aria-expanded={emailOpen}
                on:click={() => (emailOpen = !emailOpen)}>
          ✉️ Email{#if mine.length}<span class="count">{mine.length}</span>{/if}
        </button>
      {/if}
      <slot name="extra" />
    </div>
  </div>

  {#if canEmail}
    {#if emailOpen}
      <div class="panel">
        <div class="email-row">
          <input
            type="email"
            bind:value={input}
            placeholder="guest@example.com, another@example.com"
            on:keydown={(e) => e.key === 'Enter' && submit()}
          />
          <button class="btn ghost sm" on:click={submit} disabled={busy || !input.trim()}>
            {busy ? '…' : 'Send'}
          </button>
        </div>
        <p class="hint">Comma-separated addresses — we'll send it for you.</p>

        {#if mine.length}
          <!-- Nested on purpose: the answer a host usually wants is the COUNT ("did I send this
               already?"), which the button above carries. The addresses themselves are the rarer
               follow-up question. -->
          <button class="disclose inner" aria-expanded={listOpen} on:click={() => (listOpen = !listOpen)}>
            <span class="chev" class:open={listOpen}>›</span>
            Sent to {mine.length}
            {#if failed}<span class="bad">{failed} failed</span>{/if}
          </button>
          {#if listOpen}
            <ul class="sent">
              {#each mine as s, i (s.email + s.sentAt + i)}
                <li class:bad={!s.ok}>
                  <span class="addr">{s.email}</span>
                  <span class="at">{s.ok ? when(s.sentAt) : 'failed'}</span>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .row { display: flex; flex-direction: column; gap: 0; }
  .head {
    display: flex; align-items: center; justify-content: space-between; gap: 10px;
    flex-wrap: wrap; padding: 10px 0;
  }
  .who { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .title { font-weight: 600; font-size: 0.92rem; }
  .sub { color: var(--text-muted); font-size: 0.78rem; }
  .acts { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }

  .disclose {
    display: flex; align-items: center; gap: 6px; width: 100%;
    background: none; border: 0; padding: 7px 0; cursor: pointer;
    color: var(--text-muted); font: inherit; font-size: 0.82rem; text-align: left;
  }
  .disclose:hover { color: var(--text); }
  .disclose.inner { font-size: 0.78rem; padding: 6px 0 2px; }
  .chev { display: inline-block; transition: transform 0.15s ease; }
  .chev.open { transform: rotate(90deg); }
  @media (prefers-reduced-motion: reduce) { .chev { transition: none; } }
  /* Rides on the Email button: the number of people this link has already gone to. */
  .count {
    margin-left: 5px; font-size: 0.68rem; font-weight: 700;
    color: var(--accent-ink, #111); background: var(--accent);
    border-radius: 999px; padding: 0 5px;
  }
  .bad { color: var(--danger); }

  .panel { display: flex; flex-direction: column; gap: 6px; padding: 2px 0 10px; }
  .email-row { display: flex; gap: 6px; }
  .email-row input {
    flex: 1; min-width: 0; padding: 8px 10px; font: inherit; font-size: 0.85rem;
    background: var(--surface-2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); color: var(--text);
  }
  .hint { margin: 0; color: var(--text-muted); font-size: 0.75rem; }

  .sent { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
  .sent li {
    display: flex; justify-content: space-between; gap: 10px;
    font-size: 0.78rem; padding: 3px 0; border-bottom: 1px solid var(--border);
  }
  .sent li:last-child { border-bottom: 0; }
  /* An address is the one thing here that must not be cut short to fit — it is what the host is
     reading the list to check. */
  .addr { overflow-wrap: anywhere; min-width: 0; }
  .at { color: var(--text-muted); white-space: nowrap; }
  .sent li.bad .at { color: var(--danger); }
</style>
