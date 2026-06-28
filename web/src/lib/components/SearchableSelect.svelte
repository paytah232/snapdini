<script lang="ts">
  // Lightweight chosen.js-style searchable dropdown. Used for long option lists
  // (e.g. timezones) where a native <select> is unwieldy. Keyboard-navigable.
  import { tick } from 'svelte';

  export let options: string[] = [];
  export let value = '';
  export let placeholder = 'Select…';
  export let id = '';

  let open = false;
  let query = '';
  let highlight = 0;
  let wrapEl: HTMLDivElement;
  let inputEl: HTMLInputElement;

  $: filtered = (query.trim()
    ? options.filter((o) => o.toLowerCase().includes(query.trim().toLowerCase()))
    : options
  ).slice(0, 60);

  async function openList() {
    open = true;
    query = '';
    highlight = Math.max(0, filtered.indexOf(value));
    await tick();
    inputEl?.focus();
  }
  function choose(o: string) {
    value = o;
    open = false;
  }
  function onKey(e: KeyboardEvent) {
    if (e.key === 'ArrowDown') { e.preventDefault(); highlight = Math.min(highlight + 1, filtered.length - 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); highlight = Math.max(highlight - 1, 0); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[highlight]) choose(filtered[highlight]); }
    else if (e.key === 'Escape') { e.preventDefault(); open = false; }
  }
  function onWindowClick(e: MouseEvent) {
    if (open && wrapEl && !wrapEl.contains(e.target as Node)) open = false;
  }
</script>

<svelte:window on:click={onWindowClick} />

<div class="ss" bind:this={wrapEl}>
  <button type="button" {id} class="ss-display" on:click={() => (open ? (open = false) : openList())} aria-haspopup="listbox" aria-expanded={open}>
    <span class:placeholder={!value}>{value || placeholder}</span>
    <span class="ss-caret">▾</span>
  </button>
  {#if open}
    <div class="ss-pop">
      <input
        class="ss-search"
        bind:this={inputEl}
        bind:value={query}
        placeholder="Type to search…"
        on:keydown={onKey}
      />
      <ul class="ss-list" role="listbox">
        {#each filtered as o, i}
          <li>
            <button
              type="button"
              class="ss-opt"
              class:hi={i === highlight}
              class:sel={o === value}
              on:click={() => choose(o)}
              on:mouseenter={() => (highlight = i)}
            >{o}</button>
          </li>
        {/each}
        {#if !filtered.length}<li class="ss-empty">No matches</li>{/if}
      </ul>
    </div>
  {/if}
</div>

<style>
  .ss { position: relative; }
  .ss-display {
    width: 100%;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 11px 13px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text);
    font-size: 0.95rem;
    font-family: var(--font);
    cursor: pointer;
    text-align: left;
  }
  .ss-display:focus { outline: 2px solid var(--accent); border-color: transparent; }
  .ss-display .placeholder { color: var(--text-muted); }
  .ss-caret { color: var(--text-muted); font-size: 0.8rem; }
  .ss-pop {
    position: absolute;
    z-index: 40;
    top: calc(100% + 4px);
    left: 0;
    right: 0;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
    overflow: hidden;
  }
  .ss-search {
    width: 100%;
    padding: 10px 12px;
    border: none;
    border-bottom: 1px solid var(--border);
    background: var(--surface-2);
    color: var(--text);
    font-size: 0.9rem;
    font-family: var(--font);
    border-radius: 0;
  }
  .ss-search:focus { outline: none; }
  .ss-list { list-style: none; margin: 0; padding: 4px; max-height: 240px; overflow-y: auto; }
  .ss-opt {
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 9px 11px;
    border-radius: 7px;
    color: var(--text);
    font-size: 0.88rem;
    font-family: var(--font);
    cursor: pointer;
  }
  .ss-opt.hi { background: color-mix(in srgb, var(--accent) 16%, var(--surface)); }
  .ss-opt.sel { font-weight: 800; color: var(--accent); }
  .ss-empty { padding: 10px 12px; color: var(--text-muted); font-size: 0.85rem; }
</style>
