<script lang="ts">
  // The site header, once.
  //
  // The landing page, the event manager and the platform console each drew their own — at 62px,
  // 56px and not at all — so moving between them made the page jump and the console looked like a
  // different product. The SHELL lives here; what goes on the right is the page's own business and
  // arrives through the slot, styled by that page (Svelte scopes slotted content to the parent).
  import Logo from '$lib/components/Logo.svelte';

  /** Marks the manager and the console as the operator-facing side of the site. */
  export let admin = false;
  /** Where the mark goes. Home by default; a page with its own "back" may point it elsewhere. */
  export let href = '/';
</script>

<nav class="topnav">
  <a class="brand" {href}><Logo />{#if admin}<small>ADMIN</small>{/if}</a>
  <div class="topnav-right"><slot /></div>
</nav>

<style>
  .topnav {
    position: sticky; top: 0; z-index: 50;
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    height: var(--nav-h, 62px); padding: 0 24px; min-width: 0;
    backdrop-filter: blur(10px); background: color-mix(in srgb, var(--bg) 78%, transparent);
    border-bottom: 1px solid var(--border);
  }
  /* Both sides may shrink. On a phone a site admin gets a third item nobody else sees, and with
     nowrap links and no min-width:0 the row simply ran past the viewport — dragging the whole page
     wider with it, which is where a stray horizontal scroll came from. */
  .brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 800;
    text-decoration: none; color: var(--text); min-width: 0; flex: 0 1 auto; overflow: hidden; }
  .brand small { font-size: .62rem; letter-spacing: .12em; opacity: .6; }
  .topnav-right { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 0 1 auto; }
  @media (max-width: 460px) { .topnav { padding: 0 16px; } }
</style>
