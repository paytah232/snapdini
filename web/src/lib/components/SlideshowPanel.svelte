<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getSlideshow, startSlideshowJob, uploadSlideshowAudio, favouriteSlideshow, deleteSlideshowVersion, slideshowDownloadUrl, buyBrandingRemoval, type SlideshowStatus } from '$lib/events';
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
  let trackDur: Record<string, number> = {};   // id → duration (s), loaded client-side from <audio> metadata
  let tracksInit = false;              // so refresh() only seeds a default once
  let secondsPer = 3;
  let quality = 'best';
  let resolution = '4k';
  let removeBranding = false;   // drop the Snapdini intro/outro (paid add-on; only when entitled)
  let brandingBusy = false;
  let starting = false;
  let poll: ReturnType<typeof setInterval> | undefined;

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
  function loadDur(id: string) {
    if (id === '__custom__' || trackDur[id] != null) return;
    const a = new Audio(`/api/music/${encodeURIComponent(id)}`);
    a.preload = 'metadata';
    a.onloadedmetadata = () => { if (isFinite(a.duration)) trackDur = { ...trackDur, [id]: a.duration }; };
  }
  function addTrack(id: string) { if (!selectedTracks.includes(id)) selectedTracks = [...selectedTracks, id]; tracksInit = true; loadDur(id); }
  function removeTrack(i: number) { selectedTracks = selectedTracks.filter((_, j) => j !== i); tracksInit = true; }
  function clearTracks() { selectedTracks = []; tracksInit = true; }
  function moveTrack(i: number, dir: -1 | 1) {
    const j = i + dir; if (j < 0 || j >= selectedTracks.length) return;
    const next = [...selectedTracks]; [next[i], next[j]] = [next[j], next[i]]; selectedTracks = next;
  }
  // Preload catalog durations (so labels show length) once the list arrives.
  $: if (st?.music) for (const m of st.music) loadDur(m.id);
  $: musicTotalSecs = selectedTracks.reduce((s, id) => s + (trackDur[id] || 0), 0);
  $: durKnown = selectedTracks.length > 0 && selectedTracks.every((id) => id !== '__custom__' && trackDur[id] != null);
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
  $: videoN = includeVideos && !favouritesOnly ? (st?.videoCount ?? 0) : 0;   // videos aren't favourited
  $: includeCount = Math.min(photoN + videoN, st?.maxImages ?? 60);
  // Photos = secondsPer each; clips ≈ 4s avg. Minus crossfade overlaps.
  $: estSeconds = Math.max(0, Math.round((includeCount - videoN) * secondsPer + videoN * 4 - Math.max(0, includeCount - 1) * 0.6));
  const fmtDur = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
  // Rough output size = (video kbps for the chosen quality + audio kbps if there's a track) × seconds.
  $: qKbps = st?.qualities?.find((q) => q.id === quality)?.kbps ?? 6000;
  $: resScale = st?.resolutions?.find((r) => r.id === resolution)?.sizeScale ?? 1;
  $: estMB = Math.max(0.1, ((qKbps * resScale + (selectedTracks.length || keepVideoAudio ? 160 : 0)) * estSeconds) / 8 / 1000);

  async function refresh() {
    try {
      st = await getSlideshow(code, orgCode);
      if (st.music?.length && !tracksInit && !selectedTracks.length) { selectedTracks = [st.music[0].id]; tracksInit = true; }
      if (st.status === 'running' && !poll) poll = setInterval(refresh, 1500);
      if (st.status !== 'running' && poll) { clearInterval(poll); poll = undefined; }
    } catch { /* ignore */ }
  }
  async function generate() {
    starting = true;
    try {
      // The POST returns only the bare job (no music/recent). Don't assign it to `st` directly —
      // pull the FULL status via refresh() so the template's st.music/recent stay defined.
      await startSlideshowJob(code, orgCode, { favouritesOnly, tracks: selectedTracks, loopMusic, secondsPer, includeVideos, keepVideoAudio: includeVideos && keepVideoAudio, quality, resolution, branding: !(removeBranding && st?.brandingRemovable) });
      await refresh();
      if (!poll) poll = setInterval(refresh, 1500);
    } catch (e) { showToast(e instanceof Error ? e.message : 'Could not start', true); }
    finally { starting = false; }
  }
  onMount(async () => {
    await refresh();
    // Returning from a successful branding-removal checkout → turn the toggle on automatically.
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('brandingpaid') === '1' && st?.brandingRemovable) {
      removeBranding = true;
    }
  });
  onDestroy(() => { if (poll) clearInterval(poll); if (audio) audio.pause(); });
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
    <p class="hint">Rejected photos are never included{#if st?.maxImages}; up to {st.maxImages} items{/if}.</p>
    {#if (st?.videoCount ?? 0) > 0 && !favouritesOnly}
      <label class="chk"><input type="checkbox" bind:checked={includeVideos} /> Include video clips <small>({st?.videoCount}, capped at 6s each)</small></label>
      {#if includeVideos}
        <label class="chk sub"><input type="checkbox" bind:checked={keepVideoAudio} /> Keep the clips' sound <small>(mixed under the backing track, if any)</small></label>
      {/if}
    {/if}

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
              <span class="bo-sub">A one-off <b>{money(st.brandingPriceCents ?? 100)}</b> add-on for this event — unlock once and every render skips the intro &amp; outro.</span>
            </div>
            <button class="btn primary sm" on:click={buyBranding} disabled={brandingBusy}>{brandingBusy ? 'Starting…' : `Unlock · ${money(st.brandingPriceCents ?? 100)}`}</button>
          </div>
        {/if}
      </div>
    {/if}

    {#if includeCount > 0}
      <p class="estimate">≈ <b>{fmtDur(estSeconds)}</b> long · {includeCount - videoN} photo{includeCount - videoN === 1 ? '' : 's'}{#if videoN} + {videoN} clip{videoN === 1 ? '' : 's'}{/if} · ~<b>{estMB < 10 ? estMB.toFixed(1) : Math.round(estMB)} MB</b>
        {#if selectedTracks.length}· 🎵 {loopMusic ? 'looped to fit' : (musicWarn ? 'ends early' : 'plays once')}{/if}</p>
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
              <button class="track grow" on:click={() => addTrack(m.id)}>{m.label}{#if trackDur[m.id]} <small>· {fmtDur(Math.round(trackDur[m.id]))}</small>{/if}</button>
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

    {#if st?.status === 'running'}
      <div class="progress"><div class="bar" style="width:{st.progress ?? 0}%"></div></div>
      <p class="hint">{st.phase === 'encoding' ? `Encoding… ${st.progress ?? 0}%` : 'Collecting photos…'} — leave it running.</p>
    {:else}
      <button class="btn primary full" on:click={generate} disabled={starting || includeCount === 0}>
        {starting ? 'Starting…' : st?.status === 'done' ? '↻ Regenerate' : '🎬 Generate slideshow'}
      </button>
      {#if includeCount === 0}<p class="hint">{favouritesOnly ? 'No favourites yet — star some photos first.' : 'No photos to include yet.'}</p>{/if}
    {/if}

    {#if st?.status === 'done' && st.url}
      <!-- svelte-ignore a11y-media-has-caption -->
      <video class="preview" src={st.url} controls playsinline></video>
      {#if st.truncated}<p class="hint">⚠ Used the first {st.maxImages ?? 60} photos to keep it quick.</p>{/if}
    {:else if st?.status === 'error'}
      <p class="err">{st.error || 'Generation failed.'}</p>
    {/if}

    {#if st?.recent && st.recent.length}
      <div class="recent">
        <div class="recent-head">Recent slideshows</div>
        <p class="hint" style="margin:0 0 8px">Plays in the browser. Unfavourited renders auto-clear after a day — ★ one to keep it for the event's retention window.</p>
        {#each st.recent as s (s.id)}
          <div class="ritem">
            <!-- svelte-ignore a11y-media-has-caption -->
            <video class="rthumb" src={s.url} muted preload="metadata" playsinline></video>
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
  .fld { display: block; font-size: 0.76rem; color: var(--text-muted); margin-bottom: 12px; }
  .fld > span { display: block; margin-bottom: 4px; }
  .fld select { width: 100%; padding: 9px 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text); font: inherit; font-size: 0.88rem; }
  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 11px 18px; font-size: 0.9rem; border: 1px solid var(--border); cursor: pointer; font: inherit; text-align: center; background: transparent; color: var(--text); text-decoration: none; }
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
  .seg-btn { flex: 1; background: transparent; color: var(--text-muted); border: none; padding: 9px; font: inherit; font-size: 0.84rem; font-weight: 700; cursor: pointer; }
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
  .progress { height: 10px; background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; overflow: hidden; margin: 4px 0 0; }
  .progress .bar { height: 100%; background: var(--accent); transition: width 0.4s ease; }
</style>
