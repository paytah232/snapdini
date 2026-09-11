<script lang="ts">
  // The host's mission picker.
  //
  // Two things shape this screen. First, the list has to be OBVIOUS: a host should be able to read
  // every option their event type offers and tick the ones they want, rather than trust a black box.
  // The quick picks are a shortcut past that, never a replacement for it.
  //
  // Second, the count is the host's call. Five is the default because a list you can finish beats a
  // thorough one, but a planner who wants fifteen gets fifteen — with a warning, not a refusal, when
  // the list outruns the roll.
  import { EVENT_TYPES, MOODS, PACKS, packFor, pickChallenges, varySets, customChallenge,
           CHALLENGE_MAX_LEN, DEFAULT_COUNT, MAX_COUNT, MAX_SETS, tickFor,
           type Challenge, type Mood, type MissionSet } from '$lib/challenges';
  import { showToast } from '$lib/toast';
  import { track } from '$lib/analytics';

  export let joinCode: string;
  export let orgCode: string;
  export let eventType: string | null = null;
  /** What is already saved, in the stored shape. */
  export let savedSets: { key: string; label: string; items: { id: string; text: string }[] }[] = [];
  /** The guest's roll size, so we can say when a list outruns it. */
  export let maxPhotos = 10;
  /** 0 means the event allows no video at all, so clip prompts must not be offered. */
  export let videoSeconds = 0;
  export let onClose: () => void = () => {};
  export let onSaved: (sets: MissionSet[]) => void = () => {};

  let type = eventType ?? 'general';
  let count = DEFAULT_COUNT;
  let busy = false;
  let customText = '';
  let active = 0;

  $: pack = packFor(type);
  $: allowVideo = videoSeconds > 0;

  // Working state: one editable list per card. Seeded from what is saved, or from the pack's
  // curated order for a host opening this for the first time.
  type Draft = { key: string; label: string; items: Challenge[] };
  let drafts: Draft[] = [];
  let seeded = false;
  $: if (!seeded && pack) {
    drafts = savedSets.length
      ? savedSets.map((s) => ({ key: s.key, label: s.label, items: s.items.map((i) => ({ ...i, moods: [] as Mood[] })) }))
      : [{ key: 'a', label: 'Card A', items: pickChallenges(pack, { count, allowVideo }) }];
    if (savedSets.length) count = Math.max(...savedSets.map((s) => s.items.length));
    seeded = true;
  }
  $: current = drafts[active] ?? drafts[0];
  $: chosenIds = new Set(current?.items.map((i) => i.id) ?? []);
  // The warning that matters: a guest with a 10-shot roll and 15 missions cannot finish, and would
  // spend the whole roll trying. Said plainly, not enforced — a host may have a reason.
  $: outrunsRoll = (current?.items.length ?? 0) > maxPhotos;

  function toggle(c: Challenge) {
    if (!current) return;
    current.items = chosenIds.has(c.id)
      ? current.items.filter((i) => i.id !== c.id)
      : [...current.items, c].slice(0, MAX_COUNT);
    drafts = drafts;
  }
  function quick(mood: Mood | null) {
    if (!pack || !current) return;
    current.items = pickChallenges(pack, { count, mood, allowVideo });
    drafts = drafts;
  }
  function addCustom() {
    if (!current) return;
    // Sequence off the highest existing own-N across ALL cards, so two cards never share an id —
    // ids tag photos and rank packs, so a collision would merge two different missions.
    const used = drafts.flatMap((d) => d.items.map((i) => i.id)).filter((id) => /^own-\d+$/.test(id));
    const next = used.reduce((m, id) => Math.max(m, Number(id.slice(4))), 0) + 1;
    const c = customChallenge(customText, next);
    if (!c) { showToast(`Keep it under ${CHALLENGE_MAX_LEN} characters so it fits the card`, true); return; }
    current.items = [...current.items, c].slice(0, MAX_COUNT);
    drafts = drafts;
    customText = '';
  }
  function addCard() {
    if (!pack || drafts.length >= MAX_SETS) return;
    const key = String.fromCharCode(97 + drafts.length);
    drafts = [...drafts, { key, label: `Card ${key.toUpperCase()}`, items: pickChallenges(pack, { count, allowVideo }) }];
    active = drafts.length - 1;
  }
  function removeCard(i: number) {
    drafts = drafts.filter((_, n) => n !== i);
    active = Math.min(active, drafts.length - 1);
  }
  function makeVaried(n: number) {
    if (!pack) return;
    // Every card keeps the same core, so the shots a host would regret missing are on all of them.
    drafts = varySets(pack, { sets: n, count, allowVideo }).map((s) => ({ ...s }));
    active = 0;
  }

  async function save() {
    busy = true;
    try {
      const body = {
        eventType: type === 'general' ? null : type,
        challenges: { sets: drafts.filter((d) => d.items.length).map((d) => ({
          key: d.key, label: d.label, items: d.items.map((i) => ({ id: i.id, text: i.text })),
        })) },
      };
      const r = await fetch(`/api/events/${encodeURIComponent(joinCode)}/challenges`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-organizer-code': orgCode },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || 'Could not save');
      onSaved(d.sets ?? []);
      track('missions_saved', { cards: (d.sets ?? []).length, per: count, type }, joinCode);
      showToast(d.sets?.length ? `Saved — ${d.sets.length} card${d.sets.length === 1 ? '' : 's'} ready to print` : 'Missions cleared');
      onClose();
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save', true);
    } finally {
      busy = false;
    }
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions a11y-no-noninteractive-element-interactions -->
<div class="back" on:click|self={onClose} role="dialog" aria-modal="true" aria-label="Photo missions">
  <div class="sheet">
    <div class="head">
      <span>Photo missions</span>
      <button class="x" on:click={onClose} aria-label="Close">✕</button>
    </div>

    <p class="lede">
      A short list of shots for your guests. It prints on cards for the tables, and they tick them
      off in the camera as they go.
    </p>

    <label class="fld" for="m-type">What kind of event is this?</label>
    <select id="m-type" bind:value={type} on:change={() => { seeded = false; }}>
      {#each EVENT_TYPES as t}<option value={t.key}>{t.label}</option>{/each}
    </select>
    <p class="hint">Sets which list you're offered, and the tick on the card ({tickFor(type === 'general' ? null : type)}).</p>

    {#if drafts.length > 1}
      <div class="tabs" role="tablist">
        {#each drafts as d, i}
          <button class="tab" class:on={i === active} on:click={() => (active = i)} role="tab" aria-selected={i === active}>
            {d.label} <span class="tcount">{d.items.length}</span>
          </button>
        {/each}
        {#if drafts.length < MAX_SETS}<button class="tab add" on:click={addCard}>+ Card</button>{/if}
      </div>
      <p class="hint">
        Each card is printed separately and guests are spread evenly across them, so different tables
        hunt for different things. <button class="link" on:click={() => removeCard(active)}>Remove this card</button>
      </p>
    {:else}
      <div class="row">
        <button class="btn ghost sm" on:click={addCard}>+ Add a second card</button>
        <button class="btn ghost sm" on:click={() => makeVaried(3)}>Make 3 varied cards</button>
      </div>
      <p class="hint">Varied cards share the essentials and differ on the rest, so nothing important goes unphotographed.</p>
    {/if}

    <div class="ctl">
      <label class="fld" for="m-count">How many on each card</label>
      <input id="m-count" type="number" min="1" max={MAX_COUNT} bind:value={count} />
      <span class="of">{current?.items.length ?? 0} chosen</span>
    </div>
    {#if outrunsRoll}
      <p class="warn">
        That's more missions than the {maxPhotos} shots on a guest's roll. They can still shoot
        whatever they like — they just can't finish the list.
      </p>
    {/if}

    <div class="quick">
      <span class="qlabel">Quick pick</span>
      {#each MOODS as m}
        <button class="chip" on:click={() => quick(m.key)} title={m.hint}>{m.label}</button>
      {/each}
      <button class="chip" on:click={() => quick(null)} title="The pack's own order">Shuffle</button>
    </div>

    <div class="listhead">
      <span>Everything {pack?.label ?? ''} offers</span>
      <span class="lh-hint">Tick the ones you want</span>
    </div>
    <ul class="opts">
      {#each pack?.challenges ?? [] as c (c.id)}
        {#if allowVideo || !c.video}
          <li>
            <button class="opt" class:on={chosenIds.has(c.id)} on:click={() => toggle(c)}>
              <span class="obox" aria-hidden="true">{chosenIds.has(c.id) ? '✓' : ''}</span>
              <span class="otext">{c.text}</span>
              {#if c.video}<span class="ovid" title="Asks for a short clip">clip</span>{/if}
            </button>
          </li>
        {/if}
      {/each}
      {#each (current?.items ?? []).filter((i) => /^own-\d+$/.test(i.id)) as c (c.id)}
        <li>
          <button class="opt on own" on:click={() => toggle(c)}>
            <span class="obox" aria-hidden="true">✓</span>
            <span class="otext">{c.text}</span>
            <span class="ovid">yours</span>
          </button>
        </li>
      {/each}
    </ul>

    <div class="ctl">
      <label class="fld" for="m-own">Write your own</label>
      <input id="m-own" bind:value={customText} maxlength={CHALLENGE_MAX_LEN}
             placeholder="e.g. The dog in a bow tie" on:keydown={(e) => e.key === 'Enter' && addCustom()} />
      <button class="btn ghost sm" on:click={addCustom} disabled={!customText.trim()}>Add</button>
    </div>

    <div class="foot">
      <button class="btn ghost" on:click={onClose}>Cancel</button>
      <button class="btn primary" on:click={save} disabled={busy}>
        {busy ? 'Saving…' : drafts.length > 1 ? `Save ${drafts.length} cards` : 'Save missions'}
      </button>
    </div>
  </div>
</div>

<style>
  .back { position: fixed; inset: 0; z-index: 80; background: rgba(0,0,0,.55); display: flex;
    align-items: flex-start; justify-content: center; padding: 24px 14px; overflow: auto;
    -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
  .sheet { width: 100%; max-width: 560px; background: var(--surface); border: 1px solid var(--border);
    border-radius: 16px; padding: 18px; }
  .head { display: flex; justify-content: space-between; align-items: center; font-weight: 800; margin-bottom: 8px; }
  .x { border: none; background: none; color: var(--text-muted); font-size: .95rem; cursor: pointer; }
  .lede { margin: 0 0 14px; font-size: .88rem; line-height: 1.5; color: var(--text-muted); }
  .fld { display: block; font-size: .78rem; text-transform: uppercase; letter-spacing: .06em;
    color: var(--text-muted); margin-bottom: 5px; }
  select, input { width: 100%; padding: 9px 11px; border-radius: 9px; border: 1px solid var(--border);
    background: var(--bg); color: var(--text); font: inherit; font-size: .9rem; }
  .hint { margin: 6px 0 14px; font-size: .78rem; line-height: 1.45; color: var(--text-muted); }
  .warn { margin: 6px 0 14px; font-size: .8rem; line-height: 1.45; padding: 9px 11px; border-radius: 9px;
    background: rgba(245,197,24,.12); border: 1px solid rgba(245,197,24,.4); }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 4px; }
  .link { background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font: inherit;
    font-size: inherit; text-decoration: underline; }

  .tabs { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 6px; }
  .tab { padding: 6px 11px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg);
    color: var(--text); font: inherit; font-size: .8rem; cursor: pointer; }
  .tab.on { border-color: var(--accent); background: rgba(245,197,24,.14); font-weight: 700; }
  .tcount { opacity: .55; font-variant-numeric: tabular-nums; }

  .ctl { display: flex; align-items: end; gap: 8px; margin-bottom: 10px; }
  .ctl .fld { flex: 1; margin: 0 0 5px; }
  .ctl input { flex: none; width: 92px; }
  .ctl input#m-own { flex: 1; width: auto; }
  .of { flex: none; font-size: .78rem; color: var(--text-muted); padding-bottom: 10px; }

  .quick { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 4px 0 16px; }
  .qlabel { font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); }
  .chip { padding: 5px 10px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg);
    color: var(--text); font: inherit; font-size: .78rem; cursor: pointer; }
  .chip:hover { border-color: var(--accent); }

  .listhead { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 7px;
    font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); }
  .lh-hint { text-transform: none; letter-spacing: 0; }
  /* Scrolls rather than growing: 24 options plus the host's own would push Save off a phone. */
  .opts { list-style: none; margin: 0 0 14px; padding: 0; display: flex; flex-direction: column; gap: 5px;
    max-height: 42vh; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .opt { width: 100%; display: flex; align-items: center; gap: 9px; text-align: left; cursor: pointer;
    padding: 9px 10px; border-radius: 9px; font: inherit; font-size: .87rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--text); }
  .opt:hover { border-color: var(--text-muted); }
  .opt.on { border-color: var(--accent); background: rgba(245,197,24,.1); }
  .obox { flex: none; width: 18px; height: 18px; border-radius: 5px; border: 1px solid var(--border);
    display: flex; align-items: center; justify-content: center; font-size: .7rem; }
  .opt.on .obox { border-color: var(--accent); color: var(--accent); }
  .otext { flex: 1; min-width: 0; }
  .ovid { flex: none; font-size: .68rem; text-transform: uppercase; letter-spacing: .05em;
    color: var(--text-muted); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }

  .foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
  .btn.sm { padding: 7px 11px; font-size: .8rem; }
</style>
