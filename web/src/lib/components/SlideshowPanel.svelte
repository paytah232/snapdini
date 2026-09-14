<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getSlideshow, startSlideshowJob, uploadSlideshowAudio, favouriteSlideshow, deleteSlideshowVersion, slideshowDownloadUrl, buyBrandingRemoval, type SlideshowStatus, type SlideshowOrder } from '$lib/events';
  import { showToast } from '$lib/toast';
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;

  async function toggleFav(id: string) {
    try { await favouriteSlideshow(code, orgCode, id); await refresh(); }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed', true); }
  }
  async function removeVersion(id: string) {
    try { await deleteSlideshowVersion(code, orgCode, id); await refresh(); }
    catch (e) { showToast(e instanceof Error ? e.message : 'Failed', true); }
  }
  const fmtAgo = (ts: number) => {
    const m = Math.round((Date.now() - ts) / 60000);
    if (m < 1) return 'just now'; if (m < 60) return `${m}m ago`;
    const h = Math.round(m / 60); return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
  };

  export let code: string;
  export let orgCode: string;
  export let hasPhotos = false;

  let st: SlideshowStatus | null = null;
  let favouritesOnly = false;
  let includeVideos = false;
  let keepVideoAudio = false;
  let selectedTracks: string[] = [];   // ordered backing tracks ('__custom__' allowed); empty = no music
  let loopMusic = true;                // loop the music to fill the whole show

  let tracksInit = false;              // so refresh() only seeds a default once
  let secondsPer = 3;
  let order: SlideshowOrder = 'chronological';   // the night as it happened, or shuffled
  let quality = 'best';
  let resolution = '4k';
  let removeBranding = false;   // drop the Snapdini intro/outro (paid add-on; only when entitled)
  let brandingBusy = false;
  let starting = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  let polling = false;   // one request in flight at a time
  let again = false;     // something asked for a refresh while one was in flight
  let dead = false;      // the panel is gone; a poll still in the air must not re-arm the timer

  async function buyBranding() {
    brandingBusy = true;
    try {
      const r = await buyBrandingRemoval(code, orgCode);
      if (r.url) { location.href = r.url; return; }       // → Stripe Checkout
      if (r.entitled) { await refresh(); removeBranding = true; showToast('Frames can now be removed ✓'); }
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not start checkout', true); }
    finally { brandingBusy = false; }
  }

  const CARDS_SECS = 6;   // ≈ Snapdini intro + outro cards (3s each) — counted in the music-length check
  function trackLabel(id: string): string {
    if (id === '__custom__') return 'Your uploaded track';
    return st?.music?.find((m) => m.id === id)?.label ?? id;
  }
  function addTrack(id: string) { if (!selectedTracks.includes(id)) selectedTracks = [...selectedTracks, id]; tracksInit = true; }
  function removeTrack(i: number) { selectedTracks = selectedTracks.filter((_, j) => j !== i); tracksInit = true; }
  function clearTracks() { selectedTracks = []; tracksInit = true; }
  function moveTrack(i: number, dir: -1 | 1) {
    const j = i + dir; if (j < 0 || j >= selectedTracks.length) return;
    const next = [...selectedTracks]; [next[i], next[j]] = [next[j], next[i]]; selectedTracks = next;
  }
  // Track lengths come from the server (ffprobe), not from <audio preload="metadata"> — that never
  // fires on iOS without a user gesture, so on an iPhone every length, and the "your music is
  // shorter than the show" warning that depends on them, was silently missing.
  $: trackSecs = Object.fromEntries([
    ...(st?.music ?? []).filter((m) => m.secs).map((m) => [m.id, m.secs as number]),
    ...(st?.customAudioSecs ? [['__custom__', st.customAudioSecs] as [string, number]] : []),
  ]) as Record<string, number>;
  $: musicTotalSecs = selectedTracks.reduce((s, id) => s + (trackSecs[id] || 0), 0);
  $: durKnown = selectedTracks.length > 0 && selectedTracks.every((id) => trackSecs[id] != null);
  $: musicWarn = !loopMusic && durKnown && musicTotalSecs > 0 && musicTotalSecs < (estSeconds + CARDS_SECS - 1);

  // Track preview — a single shared <audio> the play buttons drive. Volume defaults to 50%.
  let previewId = '';
  let volume = 0.5;
  let audio: HTMLAudioElement | null = null;
  function previewTrack(id: string) {
    if (!audio) audio = new Audio();
    audio.volume = volume;
    if (previewId === id) { audio.pause(); previewId = ''; return; }   // toggle off
    audio.src = `/api/music/${encodeURIComponent(id)}`;
    audio.play().then(() => (previewId = id)).catch(() => (previewId = ''));
    audio.onended = () => (previewId = '');
  }
  // Live-adjust preview volume while playing.
  $: if (audio) audio.volume = volume;

  let uploadingAudio = false;
  async function onAudioFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    uploadingAudio = true;
    try {
      await uploadSlideshowAudio(code, orgCode, file);
      if (!selectedTracks.includes('__custom__')) selectedTracks = [...selectedTracks, '__custom__'];
      tracksInit = true;
      await refresh();   // picks up hasCustomAudio
      showToast('Track uploaded 🎵');
    } catch (err) { showToast(err instanceof Error ? err.message : 'Upload failed', true); }
    finally { uploadingAudio = false; }
  }

  // How many items this run will include, and a rough length estimate.
  $: photoN = st ? (favouritesOnly ? (st.favouriteCount ?? 0) : (st.photoCount ?? 0)) : 0;
  $: favouriteClips = st?.favouriteVideoCount ?? 0;
  $: videoN = includeVideos ? (favouritesOnly ? favouriteClips : (st?.videoCount ?? 0)) : 0;
  $: includeCount = photoN + videoN;   // there is no cap — everything the host asked for goes in
  $: running = st?.status === 'running';
  $: queueFull = (st?.queued?.length ?? 0) >= (st?.maxQueue ?? 3);
  // Photos = secondsPer each; clips ≈ 4s avg. Minus crossfade overlaps.
  $: estSeconds = Math.max(0, Math.round((includeCount - videoN) * secondsPer + videoN * 4 - Math.max(0, includeCount - 1) * 0.6));
  const fmtDur = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
  // Rough output size = (video kbps for the chosen quality + audio kbps if there's a track) × seconds.
  $: qKbps = st?.qualities?.find((q) => q.id === quality)?.kbps ?? 6000;
  $: resScale = st?.resolutions?.find((r) => r.id === resolution)?.sizeScale ?? 1;
  $: estMB = Math.max(0.1, ((qKbps * resScale + (selectedTracks.length || keepVideoAudio ? 160 : 0)) * estSeconds) / 8 / 1000);
  // With no cap, a host can ask for a film that takes an hour to build, and they should know that
  // before they press go rather than ten minutes into watching a bar. renderScale is what this box
  // really does, measured server-side from finished renders.
  // A 4K render over an all-1080p event is quietly done at 1080p, so quote what it will really
  // cost rather than what 4K would have.
  $: effectiveRes = resolution === '4k' && st?.sourcesFitIn1080 ? '1080p' : resolution;
  $: resProfile = st?.resolutions?.find((r) => r.id === effectiveRes);
  $: renderScale = resProfile?.renderScale ?? 1;
  $: prepPerItem = resProfile?.prepPerItem ?? 0.19;
  $: estRenderSecs = Math.round(estSeconds * renderScale + includeCount * prepPerItem);
  // "About six minutes", not "371 seconds": an estimate given to the second is a promise it cannot
  // keep, and reads as precision it does not have.
  function roughTime(secs: number): string {
    if (secs < 120) return 'a minute or two';
    const mins = Math.round(secs / 60);
    if (mins < 60) return `about ${mins} minutes`;
    const hours = Math.round(secs / 1800) / 2;
    return `about ${hours} hour${hours === 1 ? '' : 's'}`;
  }

  // Render progress reaches this panel by polling — there is no push channel, no SSE — and the two
  // things that made the bar look dead on a phone are both about that poll, not about the render.
  //
  // (1) A CHAIN, not setInterval. On a phone a poll can easily outlast the 1.5s gap; setInterval
  // fires anyway, requests stack, and whichever answer lands last wins — which on a slow link is
  // not the newest one. Each tick is scheduled only once the previous answer is in.
  const POLL_MS = 1500;
  function stopPoll() { if (poll) clearTimeout(poll); poll = undefined; }
  async function refresh(): Promise<void> {
    if (polling) { again = true; return; }
    polling = true;
    try {
      st = await getSlideshow(code, orgCode);
      if (st.music?.length && !tracksInit && !selectedTracks.length) { selectedTracks = [st.music[0].id]; tracksInit = true; }
    } catch { /* one dropped poll isn't worth a toast — the next tick asks again */ }
    finally {
      polling = false;
      stopPoll();
      // The panel lives inside the review screen's slideshow tab, so it is destroyed whenever the
      // host looks at their photos. Without this the request already in the air lands afterwards
      // and schedules the next tick, and the dead panel polls the server for the rest of the visit.
      if (dead) { /* nothing to schedule */ }
      else if (again) { again = false; void refresh(); }
      else if (st?.status === 'running') poll = setTimeout(refresh, POLL_MS);
    }
  }
  // (2) The phone-specific half. A backgrounded page has its timers suspended — the host locks the
  // screen, takes a call, switches app — so the bar stops dead on whatever it last read and the
  // render looks frozen while the server is in fact still working. Nothing restarted it but the
  // tick that never came. Ask again the moment the page is visible, and on pageshow too, because
  // iOS restores from the back/forward cache without firing a visibility change.
  function resync() {
    if (dead || typeof document === 'undefined' || document.visibilityState !== 'visible') return;
    stopPoll();
    void refresh();
  }
  async function generate() {
    starting = true;
    try {
      // The POST returns only the bare job (no music/recent). Don't assign it to `st` directly —
      // pull the FULL status via refresh() so the template's st.music/recent stay defined.
      const r = await startSlideshowJob(code, orgCode, { favouritesOnly, tracks: selectedTracks, loopMusic, secondsPer, includeVideos, keepVideoAudio: includeVideos && keepVideoAudio, quality, resolution, order, branding: !(removeBranding && st?.brandingRemovable) });
      // Say which of the three things just happened. Pressing go during a render used to look
      // identical to starting one, while the settings were quietly thrown away.
      if (r.queueFull) showToast('Already rendering, and the queue is full — this one wasn’t added', true);
      else if (r.queuedCount) showToast('Queued behind the render already going 🎬');
      await refresh();
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not start', true); }
    finally { starting = false; }
  }
  onMount(async () => {
    await refresh();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', resync);
    if (typeof window !== 'undefined') window.addEventListener('pageshow', resync);
    // Returning from a successful branding-removal checkout → turn the toggle on automatically.
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('brandingpaid') === '1' && st?.brandingRemovable) {
      removeBranding = true;
    }
  });
  onDestroy(() => {
    dead = true;
    stopPoll();
    if (audio) audio.pause();
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', resync);
    if (typeof window !== 'undefined') window.removeEventListener('pageshow', resync);
  });
</script>

<div class="card">
  <div class="card-title">🎬 Slideshow <span class="exp">experimental</span></div>
  {#if !hasPhotos}
    <p class="hint">Once photos roll in, generate a video slideshow set to music.</p>
  {:else}
    <!-- What goes in -->
    <div class="seg">
      <button class="seg-btn" class:on={!favouritesOnly} on:click={() => (favouritesOnly = false)}>All photos {#if st?.photoCount != null}<small>({st.photoCount})</small>{/if}</button>
      <button class="seg-btn" class:on={favouritesOnly} on:click={() => (favouritesOnly = true)}>★ Favourites {#if st?.favouriteCount != null}<small>({st.favouriteCount})</small>{/if}</button>
    </div>
    <p class="hint">Rejected photos are never included.</p>
    <!-- A favourites render used to drop favourite CLIPS without a word: the query strips videos
         before the favourite filter runs. Asked for by name and by number, rather than left to a
         generic toggle the host has no reason to connect to the clips they starred. -->
    {#if favouritesOnly && favouriteClips > 0}
      <label class="chk offer"><input type="checkbox" bind:checked={includeVideos} />
        <span>{favouriteClips} of your favourites {favouriteClips === 1 ? 'is a video clip' : 'are video clips'} —
          include {favouriteClips === 1 ? 'it' : 'them'}? <small>(capped at 6s each)</small></span></label>
    {:else if !favouritesOnly && (st?.videoCount ?? 0) > 0}
      <label class="chk"><input type="checkbox" bind:checked={includeVideos} /> Include video clips <small>({st?.videoCount}, capped at 6s each)</small></label>
    {/if}
    {#if videoN > 0}
      <label class="chk sub"><input type="checkbox" bind:checked={keepVideoAudio} /> Keep the clips' sound <small>(mixed under the backing track, if any)</small></label>
    {/if}

    <div class="fld"><span>Order</span>
      <div class="seg">
        <button class="seg-btn" class:on={order === 'chronological'} on:click={() => (order = 'chronological')}>Start → end</button>
        <button class="seg-btn" class:on={order === 'shuffled'} on:click={() => (order = 'shuffled')}>🔀 Shuffled</button>
      </div>
    </div>

    <label class="fld"><span>Seconds per photo</span>
      <select bind:value={secondsPer}>
        {#each [2, 3, 4, 5, 6] as s}<option value={s}>{s}s each</option>{/each}
      </select>
    </label>

    {#if st?.resolutions?.length}
      <label class="fld"><span>Resolution</span>
        <select bind:value={resolution}>
          {#each st.resolutions as r}<option value={r.id}>{r.label}</option>{/each}
        </select>
      </label>
    {/if}

    {#if st?.qualities?.length}
      <label class="fld"><span>Quality</span>
        <select bind:value={quality}>
          {#each st.qualities as q}<option value={q.id}>{q.label}</option>{/each}
        </select>
      </label>
    {/if}

    {#if st}
      <div class="branding-opt">
        {#if st.brandingRemovable}
          <label class="chk"><input type="checkbox" bind:checked={removeBranding} /> Remove the Snapdini intro &amp; outro frames</label>
        {:else}
          <div class="bo-row">
            <div class="bo-text">
              <b>Remove the Snapdini intro &amp; outro frames</b>
              <span class="bo-sub">A one-off <b>{money(st.brandingPriceCents ?? 500)}</b> add-on for this event — unlock once and every render skips the intro &amp; outro.</span>
            </div>
            <button class="btn primary sm" on:click={buyBranding} disabled={brandingBusy}>{brandingBusy ? 'Starting…' : `Unlock · ${money(st.brandingPriceCents ?? 500)}`}</button>
          </div>
        {/if}
      </div>
    {/if}

    {#if includeCount > 0}
      <p class="estimate">≈ <b>{fmtDur(estSeconds)}</b> long · {includeCount - videoN} photo{includeCount - videoN === 1 ? '' : 's'}{#if videoN} + {videoN} clip{videoN === 1 ? '' : 's'}{/if} · ~<b>{estMB < 10 ? estMB.toFixed(1) : Math.round(estMB)} MB</b>
        {#if selectedTracks.length}· 🎵 {loopMusic ? 'looped to fit' : (musicWarn ? 'ends early' : 'plays once')}{/if}</p>
      <p class="how-long">All <b>{includeCount}</b> of them go in — nothing is left out. Building it takes
        <b>{roughTime(estRenderSecs)}</b>, and it runs on our server, so you only have to start it.
        {#if effectiveRes !== resolution}<br />Your photos are all 1080p or smaller, so this renders at
        1080p — 4K would only enlarge them, and take three times as long.{/if}</p>
    {/if}

    {#if st?.music?.length}
      <div class="fld"><span>Backing music <small>(tap a track to add · ▶ to preview)</small></span>
        <div class="tracks">
          <button class="track" class:on={!selectedTracks.length} on:click={clearTracks}>🔇 No music</button>
          {#if st.hasCustomAudio}
            <button class="track" class:on={selectedTracks.includes('__custom__')} on:click={() => addTrack('__custom__')}>🎵 Your uploaded track</button>
          {/if}
          {#each st.music as m}
            <div class="track-row" class:on={selectedTracks.includes(m.id)}>
              <button class="track grow" on:click={() => addTrack(m.id)}>{m.label}{#if m.secs}<small>&nbsp;· {fmtDur(Math.round(m.secs))}</small>{/if}</button>
              <button class="play-btn" on:click={() => previewTrack(m.id)} aria-label="Preview">{previewId === m.id ? '⏸' : '▶'}</button>
            </div>
          {/each}
        </div>

        {#if selectedTracks.length}
          <div class="chosen">
            <div class="chosen-h">Plays in this order{#if durKnown} · ~{fmtDur(Math.round(musicTotalSecs))} of music{/if}:</div>
            {#each selectedTracks as id, i (id)}
              <div class="chosen-row">
                <span class="chosen-name">{i + 1}. {trackLabel(id)}</span>
                <button class="mv" on:click={() => moveTrack(i, -1)} disabled={i === 0} aria-label="Move up">↑</button>
                <button class="mv" on:click={() => moveTrack(i, 1)} disabled={i === selectedTracks.length - 1} aria-label="Move down">↓</button>
                <button class="mv" on:click={() => removeTrack(i)} aria-label="Remove">✕</button>
              </div>
            {/each}
            <label class="chk loop"><input type="checkbox" bind:checked={loopMusic} /> Loop music to fill the whole show</label>
            {#if musicWarn}
              <p class="warn">⚠ Your music (~{fmtDur(Math.round(musicTotalSecs))}) is shorter than the show (~{fmtDur(estSeconds + CARDS_SECS)}). The end will be silent — turn on looping or add another track. You can still generate.</p>
            {/if}
          </div>
        {/if}

        <label class="upload-track">
          {uploadingAudio ? 'Uploading…' : st.hasCustomAudio ? '⬆ Replace with your own (mp3/wav/mp4)' : '⬆ Upload your own (mp3/wav/mp4)'}
          <input type="file" accept="audio/*,.mp3,.wav,.m4a,.mp4" on:change={onAudioFile} hidden disabled={uploadingAudio} />
        </label>
        <p class="rights-note">Only upload music you have the rights to use. You're responsible for any licensing; Snapdini takes no responsibility for third-party content. <a href="/terms" target="_blank" rel="noopener">Terms</a></p>
        <label class="vol"><span>🔊 Preview volume</span>
          <input type="range" min="0" max="1" step="0.05" bind:value={volume} />
          <span class="vol-pct">{Math.round(volume * 100)}%</span>
        </label>
      </div>
    {/if}

    {#if running}
      <!-- aria-valuenow is left off while collecting: there is no number to report yet, and
           announcing a stuck "0%" is worse than announcing nothing. -->
      <div class="progress" role="progressbar" aria-label="Rendering slideshow" aria-valuemin={0} aria-valuemax={100}
           aria-valuenow={st?.phase === 'encoding' ? (st?.progress ?? 0) : undefined}>
        <div class="bar" style="width:{st?.phase === 'encoding' ? (st?.progress ?? 0) : 0}%"></div>
      </div>
      <p class="hint">{st?.phase === 'encoding' ? `Encoding… ${st?.progress ?? 0}%` : 'Collecting photos…'}{#if st?.label} · {st.label}{/if}</p>
      <p class="bg-note">This keeps rendering on our server. Close the tab, lock your phone, change the
        settings above and queue another — it carries on regardless, and every finished slideshow is
        waiting in the list below whenever you come back.</p>
    {/if}

    {#if st?.queued?.length}
      <div class="queued">
        <div class="queued-h">Queued next — they start on their own, in this order</div>
        {#each st.queued as q (q.id)}<div class="queued-row">⏳ {q.label}</div>{/each}
      </div>
    {/if}

    <!-- Never hidden while a render runs. Hiding it is what made a second render impossible and made
         a mid-render press look like it had thrown the settings away. -->
    <button class="btn primary full" on:click={generate} disabled={starting || includeCount === 0 || queueFull}>
      {starting ? 'Starting…' : running ? '＋ Queue another render' : st?.status === 'done' ? '↻ Generate another' : '🎬 Generate slideshow'}
    </button>
    {#if includeCount === 0}
      <p class="hint">{favouritesOnly ? 'No favourites yet — star some photos first.' : 'No photos to include yet.'}</p>
    {:else if queueFull}
      <p class="hint">{st?.maxQueue ?? 3} renders are already waiting — the next one starts as soon as this finishes.</p>
    {:else if running}
      <p class="hint">Changing anything above won't disturb the render already going; it'll be used for the next one.</p>
    {/if}

    {#if st?.status === 'done' && st.url}
      <!-- svelte-ignore a11y-media-has-caption -->
      <!-- Preview streams the 1080p copy when it exists; the download button below still hands
           over the full-quality render. -->
      <video class="preview" src={st.playUrl ?? st.url} controls playsinline></video>
    {:else if st?.status === 'error'}
      <p class="err">{st.error || 'Generation failed.'}</p>
    {/if}

    {#if st?.failed && st.status !== 'error'}
      <p class="err">An earlier render failed — {st.failed.label}: {st.failed.error}</p>
    {/if}

    {#if st?.recent && st.recent.length}
      <div class="recent">
        <div class="recent-head">Recent slideshows</div>
        <p class="hint" style="margin:0 0 8px">Plays in the browser. Unfavourited renders auto-clear after a day — ★ one to keep it for the event's retention window.</p>
        {#each st.recent as s (s.id)}
          <div class="ritem">
            <!-- svelte-ignore a11y-media-has-caption -->
            <video class="rthumb" src={s.playUrl ?? s.url} muted preload="metadata" playsinline></video>
            <div class="rinfo">
              <div class="rlabel">{s.label}{#if s.resolution} · {s.resolution === '4k' ? '4K' : s.resolution}{/if}</div>
              <div class="rwhen">{fmtAgo(s.createdAt)}{#if s.favourite} · ★ kept{/if}</div>
            </div>
            <div class="racts">
              <button class="ic" class:on={s.favourite} on:click={() => toggleFav(s.id)} title={s.favourite ? 'Unfavourite' : 'Keep (favourite)'} aria-label="Favourite">{s.favourite ? '★' : '☆'}</button>
              <a class="ic" href={slideshowDownloadUrl(code, s.id)} title="Download {s.resolution === '4k' ? '4K' : '1080p'}" aria-label="Download">⬇</a>
              {#if s.resolution === '4k'}<a class="ic txt" href={slideshowDownloadUrl(code, s.id, '1080p')} title="Download a smaller 1080p version" aria-label="Download 1080p">1080p</a>{/if}
              <button class="ic" on:click={() => removeVersion(s.id)} title="Delete" aria-label="Delete">🗑</button>
            </div>
          </div>
        {/each}
      </div>
    {/if}

    {#if st?.music?.length}
      <p class="credit">Royalty-free music (no attribution required).</p>
    {/if}
  {/if}
</div>

<style>
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 18px; }
  .card-title { font-weight: 800; font-size: 0.95rem; margin-bottom: 10px; display: flex; align-items: center; gap: 8px; }
  .exp { font-size: 0.62rem; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; background: var(--surface-2); color: var(--text-muted); border: 1px solid var(--border); border-radius: 5px; padding: 1px 6px; }
  .chk { display: flex; align-items: center; gap: 8px; font-size: 0.85rem; margin-bottom: 10px; }
  .chk.sub { margin-left: 22px; margin-top: -4px; font-size: 0.8rem; color: var(--text-muted); }
  .chk.offer { align-items: flex-start; gap: 10px; min-height: 44px; padding: 9px 10px; line-height: 1.4;
               border-radius: var(--radius-sm); background: color-mix(in srgb, var(--accent) 12%, var(--surface)); }
  .chk.offer input { margin-top: 2px; width: 20px; height: 20px; flex: none; }
  .fld { display: block; font-size: 0.76rem; color: var(--text-muted); margin-bottom: 12px; }
  .fld > span { display: block; margin-bottom: 4px; }
  .fld select { width: 100%; padding: 9px 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font: inherit; font-size: 0.88rem; }
  .btn { display: inline-block; min-height: 44px; font-weight: 700; border-radius: var(--radius-sm); padding: 11px 18px; font-size: 0.9rem; border: 1px solid var(--border); cursor: pointer; font: inherit; text-align: center; background: transparent; color: var(--text); text-decoration: none; }
  .btn.primary { background: var(--accent); color: var(--accent-ink, #111); border-color: var(--accent); }
  .full { width: 100%; }
  .recent { margin-top: 16px; border-top: 1px solid var(--border); padding-top: 12px; }
  .recent-head { font-weight: 800; font-size: 0.85rem; margin-bottom: 4px; }
  .ritem { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--border); }
  .ritem:first-of-type { border-top: none; }
  .rthumb { width: 64px; height: 40px; object-fit: cover; border-radius: 6px; background: #000; flex: none; }
  .rinfo { flex: 1; min-width: 0; }
  .rlabel { font-size: 0.82rem; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rwhen { font-size: 0.7rem; color: var(--text-muted); }
  .racts { display: flex; gap: 4px; flex: none; }
  .ic { width: 34px; height: 34px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: var(--text); cursor: pointer; text-decoration: none; font-size: 0.9rem; }
  .ic.on { color: var(--accent); border-color: var(--accent); }
  .ic.txt { width: auto; padding: 0 8px; font-size: 0.66rem; font-weight: 800; letter-spacing: .02em; }
  .ic:hover { border-color: var(--accent); }
  .btn:disabled { opacity: 0.7; cursor: default; }
  .preview { width: 100%; border-radius: var(--radius-sm); margin-top: 12px; background: #000; }
  .hint { font-size: 0.76rem; color: var(--text-muted); margin: 8px 0 0; }
  .err { font-size: 0.8rem; color: #e06666; margin: 8px 0 0; }
  .credit { font-size: 0.68rem; color: var(--text-muted); margin: 10px 0 0; }
  .seg { display: flex; gap: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; margin-bottom: 8px; }
  .seg-btn { flex: 1; min-height: 44px; background: transparent; color: var(--text-muted); border: none; padding: 9px; font: inherit; font-size: 0.84rem; font-weight: 700; cursor: pointer; }
  .seg-btn.on { background: var(--accent); color: var(--accent-ink, #111); }
  .seg-btn small { font-weight: 600; opacity: 0.8; }
  .estimate { font-size: 0.8rem; color: var(--text); margin: 0 0 12px; }
  .tracks { display: flex; flex-direction: column; gap: 5px; max-height: 220px; overflow-y: auto; }
  .track-row { display: flex; gap: 5px; align-items: stretch; }
  .track { text-align: left; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--text); padding: 9px 11px; font: inherit; font-size: 0.84rem; cursor: pointer; }
  .track.grow { flex: 1; }
  .track-row.on .track, .track.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--surface-2)); }
  .play-btn { width: 42px; flex: none; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--text); cursor: pointer; font-size: 0.9rem; }
  .play-btn:hover { border-color: var(--accent); }
  .upload-track { display: block; margin-top: 8px; text-align: center; cursor: pointer; font-size: 0.8rem; font-weight: 600;
    padding: 9px; border: 1px dashed var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); }
  .upload-track:hover { border-color: var(--accent); }
  .rights-note { font-size: 0.68rem; color: var(--text-muted); margin: 6px 2px 0; line-height: 1.4; }
  .rights-note a { color: var(--accent); }
  .chosen { margin-top: 10px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
  .chosen-h { font-size: 0.72rem; color: var(--text-muted); margin-bottom: 6px; }
  .chosen-row { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
  .chosen-name { flex: 1; font-size: 0.82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mv { width: 28px; height: 26px; flex: none; background: var(--surface); border: 1px solid var(--border); border-radius: 6px; color: var(--text); cursor: pointer; font-size: 0.8rem; }
  .mv:disabled { opacity: 0.4; cursor: default; }
  .mv:not(:disabled):hover { border-color: var(--accent); }
  .chk.loop { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 0.82rem; }
  .warn { margin: 8px 0 0; font-size: 0.78rem; line-height: 1.4; color: var(--accent); background: color-mix(in srgb, var(--accent) 14%, var(--surface)); border-radius: var(--radius-sm); padding: 8px 10px; }
  .branding-opt { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; font-size: 0.82rem; }
  .bo-label { color: var(--text-muted); }
  .vol { display: flex; align-items: center; gap: 8px; margin-top: 10px; font-size: 0.78rem; color: var(--text-muted); }
  .vol input[type="range"] { flex: 1; accent-color: var(--accent); }
  .vol-pct { min-width: 34px; text-align: right; }
  .progress { position: relative; height: 12px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; overflow: hidden; margin: 4px 0 0; }
  .progress .bar { height: 100%; background: var(--accent); transition: width 0.4s ease; }
  /* A percentage that hasn't moved in a minute and a render that has died look exactly alike, and
     ffmpeg really does sit on one number while it works through a long still or a clip — for the
     whole collecting phase there is no number at all and the bar is 0px wide. The sweep claims
     nothing about progress; it answers the only question a motionless bar leaves open, which is
     whether anything is happening. */
  .progress::after {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 60%, transparent), transparent);
    animation: sweep 1.6s linear infinite;
  }
  @keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
  /* The same promise without the travel, for someone who can't have a thing sliding across their
     screen — it still has to say "working", so it breathes instead of standing still. */
  @media (prefers-reduced-motion: reduce) {
    .progress::after { background: color-mix(in srgb, var(--accent) 30%, transparent); animation: breathe 2s ease-in-out infinite; }
    @keyframes breathe { 0%, 100% { opacity: 0.15; } 50% { opacity: 0.6; } }
  }
  .bg-note { font-size: 0.76rem; color: var(--text-muted); margin: 8px 0 0; line-height: 1.45; }
  .how-long { font-size: 0.78rem; line-height: 1.45; margin: 0 0 12px; padding: 8px 10px; border-radius: var(--radius-sm);
              color: var(--text); background: color-mix(in srgb, var(--accent) 12%, var(--surface)); }
  .queued { margin: 10px 0 0; padding: 8px 10px; border: 1px dashed var(--border); border-radius: var(--radius-sm); }
  .queued-h { font-size: 0.72rem; color: var(--text-muted); margin-bottom: 4px; }
  .queued-row { font-size: 0.8rem; padding: 3px 0; }
</style>
