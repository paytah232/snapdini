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
  import { EVENT_TYPES, MOODS, PACKS, packFor, pickChallenges, varySets, varyOne, customChallenge,
           offeredChallenges, isCustomId, ALL_BY_ID,
           CHALLENGE_MAX_LEN, DEFAULT_COUNT, MAX_COUNT, MAX_SETS, tickFor, cleanTick,
           TICKS_OUTLINE, TICKS_EMOJI,
           type Challenge, type Mood, type MissionSet } from '$lib/challenges';
  import { showToast } from '$lib/toast';
  import { track } from '$lib/analytics';

  export let joinCode: string;
  export let orgCode: string;
  export let eventType: string | null = null;
  /** What is already saved, in the stored shape. */
  export let savedSets: { key: string; label: string; items: { id: string; text: string }[] }[] = [];
  /** The glyph already chosen, if any. Null means follow the event type's default. */
  export let savedTick: string | null = null;
  /** The guest's roll size, so we can say when a list outruns it. */
  export let maxPhotos = 10;
  /** 0 means the event allows no video at all, so clip prompts must not be offered. Not the only
   *  gate any more — CLIP_TRICKS_ENABLED hides them for every event — but still the per-event one. */
  export let videoSeconds = 0;
  export let onClose: () => void = () => {};
  export let onSaved: (sets: MissionSet[]) => void = () => {};
  /** A save that had already closed the modal turned out to fail. Hands back exactly what the host
   *  had so the parent can reopen the editor on THEIR work, not on the stored list. */
  export let onSaveFailed: (sets: { key: string; label: string; items: { id: string; text: string }[] }[]) => void = () => {};

  let type = eventType ?? 'general';
  let count = DEFAULT_COUNT;
  let busy = false;
  let customText = '';
  let active = 0;
  // The tick belongs to the LIST, not the poster: a host may never print anything, and a digital-only
  // list still needs a mark beside each line. Chosen once here, used on the guest's screen and on
  // the printed card alike.
  let tick = savedTick ?? tickFor(eventType);
  let tickTouched = !!savedTick;
  let ownTick = '';
  // Which quick pick produced what is on screen, so the host can see where the list came from.
  // Cleared the moment they tick anything by hand — otherwise the chip would claim credit for a
  // list the host has since edited.
  let lastQuick: Mood | 'shuffle' | null = null;
  // Follow the event type until the host picks one deliberately — otherwise switching from Wedding
  // to Baby shower would leave a heart on a bottle-themed card.
  $: if (!tickTouched) tick = tickFor(type === 'general' ? null : type);
  const setTick = (t: string) => { const c = cleanTick(t); if (c) { tick = c; tickTouched = true; } };
  // Astral = emoji: drawn in colour by the device's own font, so it ignores the card's ink.
  $: tickIsEmoji = (tick.codePointAt(0) ?? 0) > 0xffff;

  $: pack = packFor(type);
  $: allowVideo = videoSeconds > 0;
  // What this event type actually offers. Note allowVideo is not the only gate: clip tricks are
  // currently hidden product-wide (CLIP_TRICKS_ENABLED in challenges.ts), so an event WITH video
  // still gets a stills-only list. offeredChallenges owns both rules — never filter here.
  $: offered = offeredChallenges(pack, allowVideo);
  $: offeredIds = new Set(offered.map((c) => c.id));

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
  // Each card has its own length, so the field follows whichever one is open.
  $: if (current) count = current.items.length;
  $: chosenIds = new Set(current?.items.map((i) => i.id) ?? []);
  // The warning that matters: a guest with a 10-shot roll and 15 missions cannot finish, and would
  // spend the whole roll trying. Said plainly, not enforced — a host may have a reason.
  $: outrunsRoll = (current?.items.length ?? 0) > maxPhotos;

  // Everything on the card that the list below does NOT show, so nothing a host chose can go
  // invisible while still printing: their own wording, a clip trick saved before clips were
  // hidden, and a trick from another pack if they changed the event type after saving.
  $: extras = (current?.items ?? []).filter((i) => !offeredIds.has(i.id));
  /** What to call a trick that is on the card but not in the list. */
  const extraTag = (c: { id: string }) =>
    isCustomId(c.id) ? 'yours' : ALL_BY_ID[c.id]?.video ? 'clip' : 'kept';
  // A clip trick already saved on a card is NOT silently dropped. The host may have printed it, and
  // a line disappearing off a list on the table is worse than a line we would no longer offer. It
  // is shown, flagged, and one tap from being removed — their call, not ours.
  $: strandedClips = extras.filter((i) => !isCustomId(i.id) && !!ALL_BY_ID[i.id]?.video).length;

  /** The number field and the tick list were two views of one thing that could disagree — a host
   *  could ask for 6 and tick 9, and nothing reconciled them or said which one the card would use.
   *  Now there is a single number: ticking moves it, and typing it tops up from the pack or trims
   *  from the end rather than throwing away what the host already chose. */
  function setCount(n: number) {
    if (!pack || !current) return;
    const want = Math.max(1, Math.min(MAX_COUNT, Math.floor(n || 1)));
    const items = [...current.items];
    if (items.length > want) items.length = want;
    else for (const c of offered) {
      if (items.length >= want) break;
      if (!items.some((i) => i.id === c.id)) items.push(c);
    }
    current.items = items;
    count = items.length;
    lastQuick = null;                     // the list is no longer what a quick pick produced
    drafts = drafts;
  }

  function toggle(c: Challenge) {
    if (!current) return;
    lastQuick = null;
    current.items = chosenIds.has(c.id)
      ? current.items.filter((i) => i.id !== c.id)
      : [...current.items, c].slice(0, MAX_COUNT);
    count = current.items.length;         // the field always shows what is actually on the card
    drafts = drafts;
  }
  function quick(mood: Mood | null) {
    if (!pack || !current) return;
    // No mood means Shuffle, which has to draw at random — re-applying the curated order would
    // hand back the list already on screen and read as a dead button.
    current.items = pickChallenges(pack, { count, mood, allowVideo, shuffle: !mood });
    count = current.items.length;
    lastQuick = mood ?? 'shuffle';
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
    count = current.items.length;
    lastQuick = null;
    drafts = drafts;
    customText = '';
  }
  function addCard() {
    if (!pack || drafts.length >= MAX_SETS) return;
    const key = String.fromCharCode(97 + drafts.length);
    // Varied against the cards that already exist, not a fresh copy of the curated order — which
    // would hand the host an exact duplicate of card A and leave them to rebuild it by hand. It
    // keeps whatever the existing cards already share, so the essentials stay on every table, and
    // the host can still rework the whole thing from here.
    const items = varyOne(pack, drafts.map((d) => d.items), { count, allowVideo });
    drafts = [...drafts, { key, label: `Card ${key.toUpperCase()}`, items }];
    active = drafts.length - 1;
  }
  /** The host's own name for a card. The key ('a', 'b', …) is what the data and the QR links use
   *  and never changes — this is only what gets printed and shown, so renaming is always safe. */
  function renameCard(name: string) {
    if (!current) return;
    const t = name.trim().replace(/\s+/g, ' ').slice(0, 24);
    current.label = t || `Card ${current.key.toUpperCase()}`;
    drafts = drafts;
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

  /**
   * Save, and close the modal WITHOUT waiting for the server.
   *
   * Awaiting the round trip first left the host staring at a disabled "Saving…" button for however
   * long the request took — about 100ms on an idle box, but seconds on a loaded one or a thin
   * connection — with nothing useful to do in the meantime. The list is already finished in
   * `drafts`; the request only writes it down.
   *
   * The hazard that buys is a save that fails once the modal has gone, so two rules hold here:
   *  • the admin card is updated ONLY from what the server says it stored — never optimistically,
   *    or the host would be shown a list that does not exist;
   *  • a failure is loud AND gives the work back, via onSaveFailed, so the editor reopens on the
   *    host’s own drafts rather than on the last saved list.
   */
  function save() {
    // Guards a double tap within the same frame. Never reset, because the modal is gone a line
    // later and the failure path remounts a fresh one.
    if (busy) return;
    busy = true;
    const sets = drafts.filter((d) => d.items.length).map((d) => ({
      key: d.key, label: d.label, items: d.items.map((i) => ({ id: i.id, text: i.text })),
    }));
    const body = { eventType: type === 'general' ? null : type, tick, challenges: { sets } };
    // Started BEFORE the teardown so the request is already on the wire while the modal unmounts.
    // Nothing here touches component state afterwards, so being destroyed mid-flight is harmless.
    const pending = fetch(`/api/events/${encodeURIComponent(joinCode)}/challenges`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-organizer-code': orgCode },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const per = count;
    onClose();
    void (async () => {
      try {
        const r = await pending;
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error || 'Could not save');
        // Echo what was STORED, not what we sent: the server drops malformed rows, so this is the
        // only honest thing to put on the admin card.
        onSaved(d.sets ?? []);
        track('missions_saved', { cards: (d.sets ?? []).length, per, type }, joinCode);
        showToast(d.sets?.length ? `Saved — ${d.sets.length} card${d.sets.length === 1 ? '' : 's'} ready to print` : 'Trick list cleared');
      } catch (e) {
        showToast(`${e instanceof Error ? e.message : 'Could not save'} — your trick list is back open, nothing was lost`, true);
        onSaveFailed(sets);
      }
    })();
  }
</script>

<!-- svelte-ignore a11y-click-events-have-key-events a11y-no-static-element-interactions a11y-no-noninteractive-element-interactions -->
<div class="back" on:click|self={onClose} role="dialog" aria-modal="true" aria-label="Trick list">
  <div class="sheet">
    <div class="head">
      <span>Trick list</span>
      <button class="x" on:click={onClose} aria-label="Close">✕</button>
    </div>

    <p class="lede">
      A short list of shots for your guests — a few tricks to pull off. It prints on cards for the
      tables, and they tick them off in the camera as they go. Entirely optional: guests can ignore
      the list and just take photos.
    </p>

    <label class="fld" for="m-type">What kind of event is this?</label>
    <select id="m-type" bind:value={type} on:change={() => { seeded = false; }}>
      {#each EVENT_TYPES as t}<option value={t.key}>{t.label}</option>{/each}
    </select>
    <p class="hint">Sets which tricks you're offered, and the mark beside each one.</p>

    <span class="fld">The mark beside each trick</span>
    <div class="ticks">
      {#each TICKS_OUTLINE as t}
        <button class="tk" class:on={tick === t} on:click={() => setTick(t)} aria-label="Use {t}">{t}</button>
      {/each}
      {#each TICKS_EMOJI as t}
        <button class="tk" class:on={tick === t} on:click={() => setTick(t)} aria-label="Use {t}">{t}</button>
      {/each}
      <input class="tkown" bind:value={ownTick} maxlength="2" placeholder="•"
             aria-label="Your own character" on:input={() => setTick(ownTick)} />
    </div>
    <p class="hint">
      Used on the guests' screens and on the printed cards.
      {#if tickIsEmoji}Emoji are drawn in colour by each device's own font, so they won't match the card's ink — the outline marks will.{/if}
    </p>

    {#if drafts.length > 1}
      <div class="tabs" role="tablist">
        {#each drafts as d, i}
          <button class="tab" class:on={i === active} on:click={() => (active = i)} role="tab" aria-selected={i === active}>
            {d.label}<span class="tcount" aria-label="{d.items.length} tricks">{d.items.length}</span>
          </button>
        {/each}
        {#if drafts.length < MAX_SETS}<button class="tab add" on:click={addCard}>+ Card</button>{/if}
      </div>
      <div class="ctl">
        <label class="fld" for="m-label">What to call this card</label>
        <input id="m-label" maxlength="24" placeholder={`Card ${current?.key.toUpperCase() ?? 'A'}`}
               value={current?.label ?? ''} on:input={(e) => renameCard(e.currentTarget.value)} />
      </div>
      <p class="hint">
        Printed on the card itself, so "Golden oldies" or "The tricksters" beats "Card B" when you're
        handing them out. Each card prints separately and guests are spread evenly across them, so
        different tables hunt for different things.
        <button class="link" on:click={() => removeCard(active)}>Remove this card</button>
      </p>
    {:else}
      <div class="row">
        <button class="btn ghost sm" on:click={addCard}>+ Add a second card</button>
        <button class="btn ghost sm" on:click={() => makeVaried(3)}>Make 3 varied cards</button>
      </div>
      <p class="hint">Varied cards share the essentials and differ on the rest, so nothing important goes unphotographed.</p>
    {/if}

    <div class="ctl">
      <label class="fld" for="m-count">Tricks on this card</label>
      <input id="m-count" type="number" min="1" max={MAX_COUNT} value={count}
             on:change={(e) => setCount(+e.currentTarget.value)} />
      <!-- The OFFERED count, not the pack size: with clip tricks hidden the two differ, and a host
           told "of 24" while looking at 23 rows would reasonably think one had gone missing. -->
      <span class="of">of {offered.length} to choose from</span>
    </div>
    {#if outrunsRoll}
      <p class="warn">
        That's more tricks than the {maxPhotos} shots on a guest's roll. They can still shoot
        whatever they like — they just can't finish the list.
      </p>
    {/if}

    <div class="quick">
      <span class="qlabel">Quick pick</span>
      {#each MOODS as m}
        <button class="chip" class:on={lastQuick === m.key} on:click={() => quick(m.key)} title={m.hint}>{m.label}</button>
      {/each}
      <button class="chip" class:on={lastQuick === 'shuffle'} on:click={() => quick(null)} title="Pick at random from the whole list">Shuffle</button>
    </div>

    <div class="listhead">
      <span>Every trick {pack?.label ?? ''} offers</span>
      <span class="lh-hint">Tick the ones you want</span>
    </div>
    <ul class="opts">
      {#each offered as c (c.id)}
        <li>
          <button class="opt" class:on={chosenIds.has(c.id)} on:click={() => toggle(c)}>
            <span class="obox" aria-hidden="true">{chosenIds.has(c.id) ? '✓' : ''}</span>
            <span class="otext">{c.text}</span>
            {#if c.video}<span class="ovid" title="Asks for a short clip">clip</span>{/if}
          </button>
        </li>
      {/each}
      {#each extras as c (c.id)}
        <li>
          <button class="opt on own" on:click={() => toggle(c)}>
            <span class="obox" aria-hidden="true">✓</span>
            <span class="otext">{c.text}</span>
            <span class="ovid">{extraTag(c)}</span>
          </button>
        </li>
      {/each}
    </ul>
    {#if strandedClips}
      <p class="warn">
        {strandedClips === 1
          ? 'One trick on this card asks for a clip.'
          : `${strandedClips} tricks on this card ask for a clip.`}
        Tricks are photos now, so shooting a clip won’t tick {strandedClips === 1 ? 'it' : 'them'} off.
        Left on the card in case you’ve already printed it — select {strandedClips === 1 ? 'it' : 'them'}
        above to take {strandedClips === 1 ? 'it' : 'them'} off.
      </p>
    {/if}

    <div class="ctl">
      <label class="fld" for="m-own">Write your own</label>
      <input id="m-own" bind:value={customText} maxlength={CHALLENGE_MAX_LEN}
             placeholder="e.g. The dog in a bow tie" on:keydown={(e) => e.key === 'Enter' && addCustom()} />
      <button class="btn ghost sm" on:click={addCustom} disabled={!customText.trim()}>Add</button>
    </div>

    <div class="foot">
      <button class="btn ghost" on:click={onClose}>Cancel</button>
      <button class="btn primary" on:click={save} disabled={busy}>
        {busy ? 'Saving…' : drafts.length > 1 ? `Save ${drafts.length} cards` : 'Save trick list'}
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

  .tabs { display: flex; gap: 10px; flex-wrap: wrap; margin: 8px 0 6px; }
  .tab { position: relative; padding: 7px 11px; border: 1px solid var(--border); border-radius: 8px;
    background: transparent; color: var(--text); font: inherit; font-size: .8rem; cursor: pointer; }
  .tab.on { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); font-weight: 700; }
  /* Same corner-bubble treatment as .preset-check on the admin page, so the count reads as a badge
     on the card rather than a second word in its name. The ring in --surface keeps it legible
     wherever it lands, including over the accent fill of the selected tab. */
  .tcount {
    position: absolute; top: -7px; right: -7px;
    min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
    display: flex; align-items: center; justify-content: center;
    background: var(--accent); color: var(--accent-ink, #111);
    font-size: .64rem; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums;
    box-shadow: 0 0 0 2px var(--surface);
  }
  /* On the selected tab the accent is already the background, so the badge inverts to stay visible. */
  .tab.on .tcount { background: var(--surface); color: var(--text); }

  /* The label takes its own full-width row and the controls sit under it, which is how every other
     field in this sheet already reads. It used to be a flex ITEM beside the input, and the row then
     could not shrink: an <input> has an intrinsic min-width (~210px here) and min-width:auto stops a
     flex item going under it, so label + box + Add measured a fixed ~354px whatever the viewport
     was. Measured: that hangs past the sheet’s own edge at 360px and off the screen entirely below
     ~344px — sooner still on a device whose default input font is a shade larger, which is what the
     host was looking at. The label got whatever was left, which was 47px for a 14-character phrase.
     flex-basis 100% on the label plus min-width:0 on the field is the whole fix, and it is not
     behind a media query because the stacked version reads better at every width. */
  .ctl { display: flex; flex-wrap: wrap; align-items: end; gap: 8px; margin-bottom: 10px; }
  .ctl .fld { flex: 1 0 100%; margin: 0 0 1px; }
  /* Fields take the row by default. min-width:0 because a flex item will not shrink below its
     intrinsic input width otherwise, which is the other half of how Add got pushed off screen. */
  .ctl input { flex: 1 1 160px; width: auto; min-width: 0; }
  /* Only the count is a fixed narrow box — it holds two digits. */
  .ctl input#m-count { flex: none; width: 92px; }
  .of { flex: none; font-size: .78rem; color: var(--text-muted); padding-bottom: 10px; }

  .quick { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 4px 0 16px; }
  .qlabel { font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); }
  /* Same shape as .seg in the poster designer and .tab in the admin page, so the modal looks like
     the rest of Snapdini rather than a component with its own opinions. */
  .chip { padding: 7px 11px; border: 1px solid var(--border); border-radius: 8px; background: transparent;
    color: var(--text); cursor: pointer; font: inherit; font-size: .8rem; }
  .chip:hover { border-color: var(--accent); }
  .chip.on { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); font-weight: 700; }

  /* Wraps rather than squashing: at 360px "Every trick Hens / bachelorette offers" and the hint
     cannot share a line. */
  .listhead { display: flex; flex-wrap: wrap; gap: 2px 10px; justify-content: space-between;
    align-items: baseline; margin-bottom: 7px;
    font-size: .78rem; text-transform: uppercase; letter-spacing: .06em; color: var(--text-muted); }
  .lh-hint { text-transform: none; letter-spacing: 0; }
  /* Scrolls rather than growing: 24 options plus the host's own would push Save off a phone. */
  .opts { list-style: none; margin: 0 0 14px; padding: 0; display: flex; flex-direction: column; gap: 5px;
    max-height: 42vh; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .opt { width: 100%; display: flex; align-items: center; gap: 9px; text-align: left; cursor: pointer;
    padding: 9px 10px; border-radius: 9px; font: inherit; font-size: .87rem;
    border: 1px solid var(--border); background: var(--bg); color: var(--text); }
  .opt:hover { border-color: var(--text-muted); }
  .opt.on { border-color: var(--accent); background: rgba(245, 197, 24, .1); }
  .obox { flex: none; width: 18px; height: 18px; border-radius: 5px; border: 1px solid var(--border);
    display: flex; align-items: center; justify-content: center; font-size: .7rem; }
  .opt.on .obox { border-color: var(--accent); color: var(--accent); }
  .otext { flex: 1; min-width: 0; }
  .ovid { flex: none; font-size: .68rem; text-transform: uppercase; letter-spacing: .05em;
    color: var(--text-muted); border: 1px solid var(--border); border-radius: 5px; padding: 1px 5px; }

  .foot { display: flex; gap: 8px; justify-content: flex-end; margin-top: 4px; }
  .btn { font-weight: 700; border-radius: var(--radius-sm); padding: 10px 14px; font-size: 0.86rem;
    border: 1px solid transparent; cursor: pointer; text-decoration: none; text-align: center; }
  .btn.sm { padding: 7px 12px; font-size: 0.8rem; }
  .btn.primary { background: var(--accent); color: var(--accent-ink, #111); }
  .btn.ghost { background: transparent; color: var(--text); border-color: var(--border); }
  .btn:disabled { opacity: 0.6; cursor: default; }
  .ticks { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; margin-bottom: 6px; }
  .tk { width: 34px; height: 34px; border-radius: 8px; cursor: pointer; font-size: 1rem; line-height: 1;
    border: 1px solid var(--border); background: transparent; color: var(--text); }
  .tk.on { background: var(--accent); border-color: var(--accent); }
  .tkown { width: 46px; flex: none; text-align: center; }
</style>
