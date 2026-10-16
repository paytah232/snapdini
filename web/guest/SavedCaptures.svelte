<script lang="ts">
  import { onMount } from 'svelte';
  import { listCaptures, delCapture, type StoredCapture } from '$lib/captureStore';
  import { saveBlob } from '$lib/saveImage';
  import { savedRecoveryCode } from '$lib/guestRecovery';

  export let identifier: string;
  $: code = savedRecoveryCode(identifier);
  let mounted = false;
  let readVersion = 0;
  let loadedCode = '';
  let captures: StoredCapture[] = [];
  let loading = true;
  let error = '';
  let notice = '';
  let removing: string | null = null;

  onMount(() => { mounted = true; return () => { mounted = false; }; });
  $: if (mounted && code) void reload();

  async function reload() {
    const version = ++readVersion;
    if (loadedCode !== code) { captures = []; loadedCode = code; }
    loading = true; error = '';
    try {
      if (!/^[A-Z0-9]{1,80}$/.test(code)) throw new Error('Open this page using your event’s join code.');
      if (typeof indexedDB === 'undefined') throw new Error('This browser cannot read captures saved on this device.');
      const saved = await listCaptures(code);
      if (version === readVersion) captures = saved;
    } catch (cause) {
      if (version !== readVersion) return;
      error = cause instanceof Error && /join code|cannot read/.test(cause.message)
        ? cause.message : 'This device could not read your saved captures. Nothing has been removed. Try again in this same browser.';
    } finally { if (version === readVersion) loading = false; }
  }

  function capturedTime(capture: StoredCapture): string {
    const time = capture.capturedAt ?? capture.createdAt;
    return Number.isFinite(time) ? new Date(time).toLocaleString() : 'Time unavailable';
  }

  async function saveCopy(capture: StoredCapture) {
    error = ''; notice = '';
    const extension = capture.ext.replace(/[^a-z0-9]/gi, '').slice(0, 8) || (capture.mediaType === 'video' ? 'mp4' : 'jpg');
    const result = await saveBlob(capture.blob, `snapdini-${code}-${capture.id.replace(/[^a-z0-9_-]/gi, '')}.${extension}`);
    if (result === 'failed') error = 'The save could not be opened. Your capture is still saved here; please try again.';
    else if (result !== 'cancelled') notice = 'Save opened. Check your Photos or Downloads before removing the copy saved here.';
  }

  async function removeCapture(capture: StoredCapture) {
    if (!window.confirm('Remove this capture from this device? This deletes its local saved copy. Save a copy first if you want to keep it. A camera still open in another tab may already be uploading it.')) return;
    removing = capture.id; error = ''; notice = '';
    try {
      await delCapture(capture.id);
      captures = captures.filter(item => item.id !== capture.id);
      notice = 'The local saved copy was removed.';
    } catch {
      error = 'This device could not remove the saved copy. Please try again.';
    } finally { removing = null; }
  }
</script>

<main class="saved-captures">
  <h1>Captures saved on this device</h1>
  <p>Event <strong>{code}</strong>. These copies belong to this browser. You can save them without opening the event or contacting Snapdini.</p>
  <p>Saving a copy keeps it in this queue. Remove it only after checking that you have another copy.</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if notice}<p role="status">{notice}</p>{/if}
  {#if loading}
    <p role="status">Reading saved captures…</p>
  {:else if captures.length}
    <ul>
      {#each captures as capture (capture.id)}
        <li>
          <div><strong>{capture.mediaType === 'video' ? 'Video' : 'Photo'}</strong><br /><span>{capturedTime(capture)}</span></div>
          <div class="actions">
            <button class="btn primary" disabled={removing !== null} on:click={() => saveCopy(capture)}>Save a copy</button>
            <button class="btn ghost" disabled={removing !== null} on:click={() => removeCapture(capture)}>{removing === capture.id ? 'Removing…' : 'Remove local copy'}</button>
          </div>
        </li>
      {/each}
    </ul>
  {:else if !error}
    <p>No queued captures were found for this event in this browser. Check the same browser and device where you took them.</p>
  {/if}
  <button class="btn ghost" disabled={loading || removing !== null} on:click={reload}>Check again</button>
  <p><a href={`/guest/join/${encodeURIComponent(code)}`}>Back to the event camera</a></p>
</main>

<style>
  .saved-captures { max-width: 760px; margin: 0 auto; padding: 40px 20px; }
  h1 { font-size: 1.8rem; line-height: 1.2; }
  p { line-height: 1.6; }
  ul { padding: 0; list-style: none; margin: 24px 0; }
  li { padding: 20px 0; border-bottom: 1px solid var(--border); display: flex; gap: 16px; align-items: center; justify-content: space-between; flex-wrap: wrap; }
  li span { color: var(--text-muted); font-size: .9rem; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .error { color: var(--danger); }
</style>
