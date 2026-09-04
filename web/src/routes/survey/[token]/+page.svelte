<script lang="ts">
  import type { PageData } from './$types';
  export let data: PageData;

  // Scores: 0 = unanswered. NPS is 0–10 (0 is a valid answer, tracked separately via npsSet).
  let overall = data.initialOverall || 0;
  let setup = 0, guest = 0, value = 0, video = 0;
  let nps = -1;
  const comments: Record<string, string> = {};
  let contactOptIn = false;
  // Only ask to quote someone who is actually happy. Asking after mediocre feedback is tone-deaf,
  // and the server enforces the same threshold so this cannot be bypassed.
  let testimonialOk = false;
  let testimonialName = '';
  $: happy = overall >= 4 || nps >= 8;
  let openComment: Record<string, boolean> = {};

  let busy = false, done = false, err = '';

  const FACES = ['😞', '😕', '😐', '🙂', '😍'];
  const FACE_LABELS = ['Poor', 'Meh', 'OK', 'Good', 'Loved it'];

  function toggleComment(key: string) { openComment[key] = !openComment[key]; openComment = openComment; }

  async function submit() {
    if (busy) return;
    busy = true; err = '';
    try {
      const payload = {
        overall: overall || undefined,
        setup: setup || undefined,
        guestExperience: guest || undefined,
        value: value || undefined,
        nps: nps >= 0 ? nps : undefined,
        comments: { ...comments, ...(video ? { video: String(video) } : {}) },
        contactOptIn,
        testimonialOk: happy && testimonialOk,
        testimonialName: happy && testimonialOk ? testimonialName : undefined,
      };
      const r = await fetch(`/api/survey/${data.token}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error((d as { error?: string }).error || 'Could not send — please try again.');
      done = true;
      if (typeof window !== 'undefined') window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) { err = e instanceof Error ? e.message : 'Could not send.'; }
    finally { busy = false; }
  }
</script>

<svelte:head><title>How did {data.eventName} go? · Snapdini</title></svelte:head>

<main class="wrap">
  <div class="card">
    <span class="brand">🎩 Snapdini</span>

    {#if done}
      <h1>Thank you{data.ownerName ? `, ${data.ownerName}` : ''} 🙏</h1>
      <p class="sub">Your feedback is in — we read every word, and it genuinely shapes what we build next.</p>
      {#if contactOptIn}<p class="sub">We may reach out about what you shared. If not, enjoy the memories!</p>{/if}
      <a class="btn" href="https://snapdini.com">Back to Snapdini</a>
    {:else}
      <h1>How did {data.eventName} go?</h1>
      <p class="sub">{data.ownerName ? `Hi ${data.ownerName} — ` : ''}two minutes, honest as you like. Skip anything you want.</p>
      {#if data.alreadySubmitted}<p class="note">You've already sent feedback — thank you! You're welcome to add more below.</p>{/if}

      <!-- Overall (faces) -->
      <div class="q">
        <div class="ql">Overall, how was your Snapdini experience?</div>
        <div class="faces">
          {#each FACES as f, i}
            <button type="button" class="face" class:on={overall === i + 1} on:click={() => (overall = i + 1)} aria-label={FACE_LABELS[i]}>
              <span class="fc">{f}</span><span class="fl">{FACE_LABELS[i]}</span>
            </button>
          {/each}
        </div>
        <button type="button" class="addc" on:click={() => toggleComment('overall')}>{openComment.overall ? '– comment' : '+ add a comment'}</button>
        {#if openComment.overall}<textarea bind:value={comments.overall} rows="2" placeholder="What stood out — good or bad?"></textarea>{/if}
      </div>

      <!-- Setup -->
      <div class="q">
        <div class="ql">How easy was it to set up your event?</div>
        <div class="scale">
          {#each [1,2,3,4,5] as n}<button type="button" class="num" class:on={setup === n} on:click={() => (setup = n)}>{n}</button>{/each}
        </div>
        <span class="ends"><span>Hard</span><span>Easy</span></span>
      </div>

      <!-- Guest experience -->
      <div class="q">
        <div class="ql">How did your guests find taking photos?</div>
        <div class="scale">
          {#each [1,2,3,4,5] as n}<button type="button" class="num" class:on={guest === n} on:click={() => (guest = n)}>{n}</button>{/each}
        </div>
        <span class="ends"><span>Struggled</span><span>Loved it</span></span>
        <button type="button" class="addc" on:click={() => toggleComment('guest')}>{openComment.guest ? '– comment' : '+ add a comment'}</button>
        {#if openComment.guest}<textarea bind:value={comments.guest} rows="2" placeholder="e.g. older guests found the QR easy; loved the reveal"></textarea>{/if}
      </div>

      {#if data.hadVideo}
        <!-- Conditional: only shown to events that bought video -->
        <div class="q">
          <div class="ql">How were the video clips?</div>
          <div class="scale">
            {#each [1,2,3,4,5] as n}<button type="button" class="num" class:on={video === n} on:click={() => (video = n)}>{n}</button>{/each}
          </div>
          <span class="ends"><span>Poor</span><span>Great</span></span>
        </div>
      {/if}

      <!-- Value -->
      <div class="q">
        <div class="ql">Value for money?</div>
        <div class="scale">
          {#each [1,2,3,4,5] as n}<button type="button" class="num" class:on={value === n} on:click={() => (value = n)}>{n}</button>{/each}
        </div>
        <span class="ends"><span>Not worth it</span><span>Great value</span></span>
      </div>

      <!-- NPS -->
      <div class="q">
        <div class="ql">How likely are you to recommend Snapdini?</div>
        <div class="scale nps">
          {#each Array(11) as _, n}<button type="button" class="num" class:on={nps === n} on:click={() => (nps = n)}>{n}</button>{/each}
        </div>
        <span class="ends"><span>Not likely</span><span>Very likely</span></span>
      </div>

      <!-- Open -->
      <div class="q">
        <div class="ql">Anything we could do better?</div>
        <textarea bind:value={comments.improve} rows="3" placeholder="Ideas, gripes, wishes — all welcome."></textarea>
      </div>

      <!-- Contact opt-in -->
      <label class="optin">
        <input type="checkbox" bind:checked={contactOptIn} />
        <span>You may contact me about my feedback.
          <small>Only if it'd help — to fix something or follow up on an idea. Never marketing.</small></span>
      </label>

      <!-- Only shown once the feedback is genuinely positive. The server applies the same threshold,
           so a tampered payload cannot turn lukewarm feedback into a public quote. -->
      {#if happy}
        <label class="optin">
          <input type="checkbox" bind:checked={testimonialOk} />
          <span>Happy for us to share this as a review on our website
            <small>We'll quote the words you wrote above — never your email.</small></span>
        </label>
        {#if testimonialOk}
          <input class="tname" type="text" maxlength="80" bind:value={testimonialName}
                 placeholder="Name to credit (e.g. Gillian D., or leave blank)" />
        {/if}
      {/if}

      {#if err}<p class="err">{err}</p>{/if}
      <button class="btn primary" on:click={submit} disabled={busy}>{busy ? 'Sending…' : 'Send feedback'}</button>
      <p class="tiny">Feedback for <b>{data.eventName}</b> · Snapdini</p>
    {/if}
  </div>
</main>

<style>
  .tname { width: 100%; margin-top: 8px; padding: 8px 10px; border: 1px solid var(--border);
    border-radius: 9px; background: var(--bg); color: var(--text); font-size: .9rem; }
  :global(body) { background: var(--bg, #100f0d); }
  .wrap { min-height: 100vh; display: flex; align-items: flex-start; justify-content: center; padding: 32px 16px 64px; }
  .card { width: min(560px, 100%); background: var(--surface, #191713); color: var(--text, #f4efe4);
    border: 1px solid var(--border, #2b271f); border-radius: 18px; padding: 28px 26px; box-shadow: 0 24px 60px rgba(0,0,0,.4); }
  .brand { display: inline-block; background: var(--accent, #f0b429); color: #17140e; padding: 7px 13px; border-radius: 9px;
    font-weight: 800; font-size: 1rem; }
  h1 { font-size: 1.5rem; margin: 20px 0 6px; letter-spacing: -.01em; line-height: 1.2; }
  .sub { color: var(--text-muted, #a39b8c); margin: 0 0 8px; font-size: .96rem; }
  .note { background: color-mix(in srgb, var(--accent, #f0b429) 14%, transparent); border: 1px solid var(--border, #3a3630);
    border-radius: 9px; padding: 9px 12px; font-size: .86rem; color: var(--text, #f4efe4); margin: 12px 0 0; }

  .q { padding: 20px 0; border-top: 1px solid var(--border, #2b271f); }
  .q:first-of-type { border-top: 0; }
  .ql { font-weight: 650; font-size: 1rem; margin-bottom: 12px; }

  .faces { display: flex; gap: 7px; }
  .face { flex: 1; background: var(--bg, #100f0d); border: 1px solid var(--border, #3a3630); border-radius: 11px; padding: 10px 2px;
    cursor: pointer; color: inherit; display: flex; flex-direction: column; align-items: center; gap: 6px; transition: border-color .1s, transform .05s; }
  .face .fc { font-size: 1.55rem; line-height: 1; }
  .face .fl { font-size: .6rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted, #a39b8c); }
  .face.on { border-color: var(--accent, #f0b429); background: color-mix(in srgb, var(--accent, #f0b429) 18%, transparent); }
  .face:active { transform: scale(.96); }

  .scale { display: flex; gap: 7px; }
  .scale.nps { flex-wrap: wrap; }
  .num { flex: 1; min-width: 38px; background: var(--bg, #100f0d); border: 1px solid var(--border, #3a3630); border-radius: 9px;
    padding: 11px 0; cursor: pointer; color: inherit; font: inherit; font-weight: 600; transition: border-color .1s, transform .05s; }
  .num.on { border-color: var(--accent, #f0b429); background: color-mix(in srgb, var(--accent, #f0b429) 20%, transparent); }
  .num:active { transform: scale(.94); }
  .ends { display: flex; justify-content: space-between; font-size: .72rem; color: var(--text-muted, #a39b8c); margin-top: 7px; }

  .addc { background: none; border: 0; color: var(--accent, #f0b429); cursor: pointer; font: inherit; font-size: .82rem;
    padding: 10px 0 0; }
  textarea { width: 100%; box-sizing: border-box; margin-top: 10px; background: var(--bg, #100f0d); color: var(--text, #f4efe4);
    border: 1px solid var(--border, #3a3630); border-radius: 10px; padding: 10px 12px; font: inherit; resize: vertical; }

  .optin { display: flex; gap: 11px; align-items: flex-start; margin: 22px 0 6px; padding: 14px 16px; cursor: pointer;
    background: var(--bg, #100f0d); border: 1px solid var(--border, #3a3630); border-radius: 11px; }
  .optin input { width: 20px; height: 20px; margin: 1px 0 0; accent-color: var(--accent, #f0b429); flex: none; }
  .optin small { display: block; color: var(--text-muted, #a39b8c); margin-top: 3px; font-size: .82rem; }

  .btn { display: inline-block; margin-top: 20px; padding: 13px 26px; border-radius: 10px; border: 1px solid var(--border, #3a3630);
    background: transparent; color: var(--text, #f4efe4); text-decoration: none; font: inherit; font-weight: 700; cursor: pointer; }
  .btn.primary { background: var(--accent, #f0b429); color: #17140e; border-color: transparent; width: 100%; font-size: 1rem; }
  .btn:disabled { opacity: .6; cursor: default; }
  .err { color: #ff6b6b; font-size: .88rem; margin: 12px 0 0; }
  .tiny { text-align: center; color: var(--text-muted, #a39b8c); font-size: .74rem; margin: 16px 0 0; }
</style>
