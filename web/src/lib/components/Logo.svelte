<script lang="ts">
  // Single source of truth for the Snapdini brand mark. To rebrand later, change ONLY this file —
  // e.g. swap the 🎩 emoji for `<img src="/logo.svg" .../>` or an inline <svg>. Everywhere that
  // shows the logo uses this component, so the rest of the app needs no changes.
  export let chip = true;    // gold rounded-rect behind the mark (the usual header/footer treatment)
  export let word = true;    // show the "Snapdini" wordmark next to the mark
  export let label = 'Snapdini';
  // Optional chip-colour override. Defaults to the fixed brand gold (kept everywhere for brand
  // consistency); pass an event's theme accent in event-scoped spots (e.g. the camera) so the
  // mark matches that event.
  export let color = '';
</script>

<span class="logo">
  <span class="mark" class:chip aria-hidden="true" style={chip && color ? `background:${color}` : ''}>🎩</span>{#if word}&nbsp;<span class="word">{label}</span>{/if}
</span>

<style>
  .logo { display: inline-flex; align-items: center; font-weight: 800; }
  /* The mark scales with surrounding font-size; chip padding/radius are em-relative so one size fits all.
     The chip is the FIXED Snapdini brand gold (not the event's theme accent) so the logo is identical
     everywhere — matching the slideshow card and keeping the brand consistent on themed pages. */
  .mark.chip { background: #f5c518; color: #111; padding: 0.12em 0.34em; border-radius: 0.3em; line-height: 1.1; }
  .word { color: inherit; }
</style>
