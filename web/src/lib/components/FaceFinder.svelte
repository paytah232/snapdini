<script lang="ts">
  // "Find the photos I'm in".
  //
  // Consent is the whole point of this component, so it is deliberately unhurried: plain language
  // about what is created and what is deleted, an explicit tick that is never pre-checked, and a
  // withdraw control that is as easy to reach as the opt-in was. Nothing here nudges — no urgency,
  // no pre-selection, no "skip" styled to look like the wrong choice.
  import { showToast } from '$lib/toast';

  export let sessionToken: string;
  export let enrolled = false;
  /** Photo ids the guest appears in, so the parent can filter the gallery. */
  export let onMatched: (photoIds: string[]) => void = () => {};

  let open = false;
  let consent = false;          // never pre-ticked
  let busy = false;
  let file: File | null = null;
  let fileInput: HTMLInputElement;

  function pick(e: Event) {
    file = (e.currentTarget as HTMLInputElement).files?.[0] ?? null;
  }

  async function submit() {
    if (!consent || !file || busy) return;
    busy = true;
    try {
      const fd = new FormData();
      fd.append('sessionToken', sessionToken);
      fd.append('consent', 'true');
      fd.append('selfie', file);
      const r = await fetch('/api/faces/enrol', { method: 'POST', body: fd, credentials: 'same-origin' });
      const d = await r.json().catch(() => null);
      if (!r.ok) { showToast(d?.error || 'Could not do that just now', true); busy = false; return; }
      enrolled = true; open = false;
      showToast(d?.matched ? `Found you in ${d.matched} photo${d.matched === 1 ? '' : 's'}` : 'No photos of you yet — we’ll keep looking as more arrive');
      await refresh();
    } catch { showToast('Could not do that just now', true); }
    busy = false;
  }

  async function refresh() {
    try {
      const r = await fetch('/api/faces/mine', { headers: { 'X-Session-Token': sessionToken } });
      const d = await r.json().catch(() => null);
      if (d?.enrolled) onMatched(d.photoIds || []);
    } catch { /* a failed refresh must not disturb the gallery */ }
  }

  async function withdraw() {
    if (busy) return;
    busy = true;
    try {
      await fetch('/api/faces/enrol', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ sessionToken }),
      });
      enrolled = false; consent = false; file = null;
      onMatched([]);
      showToast('Deleted — your face data and every match are gone');
    } catch { showToast('Could not do that just now', true); }
    busy = false;
  }
</script>

{#if enrolled}
  <div class="ff-row">
    <span class="ff-on">✓ Finding photos of you</span>
    <button class="ff-link" on:click={withdraw} disabled={busy}>Stop and delete</button>
  </div>
{:else if !open}
  <button class="ff-cta" on:click={() => (open = true)}>🙂 Find photos of me</button>
{:else}
  <div class="ff-panel">
    <h3>Find photos of you</h3>
    <p>
      Take a selfie and we'll pick out the photos you appear in. To do that we create a
      <b>face template</b> from your selfie and compare it with the photos in this event.
    </p>
    <ul>
      <li>Your selfie is used for the comparison and <b>not saved</b>.</li>
      <li>Only <b>your</b> face template is kept, and only while you want this on.</li>
      <li>Stop at any time and the template and every match are deleted.</li>
      <li>It only applies to this event. Nothing is shared with anyone else.</li>
    </ul>
    <label class="ff-consent">
      <input type="checkbox" bind:checked={consent} />
      <span>I agree to Snapdini creating a face template from my selfie to find my photos.</span>
    </label>
    <input type="file" accept="image/*" capture="user" bind:this={fileInput} on:change={pick} hidden />
    <div class="ff-actions">
      <button class="ff-link" on:click={() => (open = false)}>Not now</button>
      <button class="ff-cta" on:click={() => fileInput.click()} disabled={!consent}>
        {file ? 'Choose a different selfie' : 'Take a selfie'}
      </button>
      {#if file}
        <button class="ff-go" on:click={submit} disabled={busy || !consent}>{busy ? 'Looking…' : 'Find my photos'}</button>
      {/if}
    </div>
  </div>
{/if}

<style>
  .ff-cta, .ff-go {
    border-radius: 999px; padding: 8px 14px; font-size: .85rem; font-weight: 600; cursor: pointer;
    background: var(--surface-2, #1e1b14); color: var(--text, #f2ece0); border: 1px solid var(--border, #3a3630);
  }
  .ff-go { background: var(--accent, #f0b429); color: var(--accent-ink, #111); border-color: transparent; }
  .ff-cta:disabled, .ff-go:disabled { opacity: .5; cursor: default; }
  .ff-link { background: none; border: none; color: var(--text-muted, #a39b8c); font-size: .82rem; cursor: pointer; text-decoration: underline; }
  .ff-row { display: flex; align-items: center; gap: 12px; justify-content: center; margin: 10px 0; }
  .ff-on { font-size: .85rem; color: var(--accent, #f0b429); font-weight: 600; }
  .ff-panel {
    max-width: 560px; margin: 14px auto; padding: 16px 18px; text-align: left;
    border: 1px solid var(--border, #3a3630); border-radius: 14px; background: var(--surface, #17150f);
  }
  .ff-panel h3 { margin: 0 0 8px; font-size: 1rem; }
  .ff-panel p { margin: 0 0 10px; font-size: .9rem; color: var(--text-muted, #a39b8c); line-height: 1.5; }
  .ff-panel ul { margin: 0 0 12px; padding-left: 18px; font-size: .86rem; color: var(--text-muted, #a39b8c); line-height: 1.6; }
  .ff-consent { display: flex; gap: 10px; align-items: flex-start; font-size: .87rem; margin-bottom: 12px; cursor: pointer; }
  .ff-consent input { width: 19px; height: 19px; margin-top: 1px; flex: none; accent-color: var(--accent, #f0b429); }
  .ff-actions { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; }
</style>
