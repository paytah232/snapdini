<script lang="ts">
  // THE download/save mark. One file, so the four surfaces that offer "get this onto your device"
  // — the QR on the host's page, a card in the event gallery, the guest's own roll and the
  // single-photo view — cannot drift apart again. They had: `⬇` (U+2B07) in two places and `⤓`
  // (U+2913) in the other two, at four different font sizes.
  //
  // Why a drawn arrow and not a character:
  //
  //  * `⬇` U+2B07 is an EMOJI codepoint with default text presentation. That is the worst of both
  //    worlds — iOS renders it from Apple Color Emoji anyway (a fat blue-and-white tile), Android
  //    renders a thin monochrome glyph from Noto Symbols, and the two are nothing like each other
  //    in weight, colour or size. Appending U+FE0F (the fix this project already applies to
  //    🖼️ 🎛️ 🗑️ 🖨️ ☀️) only pins it to emoji EVERYWHERE, which is the wrong end to pin: a
  //    multicolour tile cannot take `currentColor`, so the green "saved" state could not tint it.
  //  * `⤓` U+2913 is genuinely a text glyph, but it is a mathematical arrow with patchy coverage.
  //    Where the UI font lacks it the browser falls back to whatever does have it, at that font's
  //    optical size — which is exactly why "⤓ Save" in the lightbox and "⬇ Download" in the
  //    gallery looked like two different icons on the same phone.
  //  * An inline SVG has no font dependency at all: the same vector on iOS Safari and Android
  //    Chrome, sized in px rather than at the mercy of a fallback face, and `stroke="currentColor"`
  //    so it inherits the button's colour in both themes and in the green done state for free.
  //
  // Shape is arrow-to-a-tray rather than arrow-into-a-box: at 20px a box costs a third of the
  // ink to an outline that says nothing, while a stem, a wide head and a baseline read as
  // "down, onto something" at a glance in the dark at a party.
  //
  // A component and not a global CSS rule or a copied snippet — app.css explains at length why a
  // global `.btn` cannot work here (Svelte scopes each component's own `.btn` at specificity
  // (0,4,0), so a global loses in every file that defines one and wins in the ones that don't).
  // None of that applies to a component: it brings its own scoped style with it.

  /** One size for every control that can be pressed: 20px, the default, and no call site overrides
   *  it. The only deviation is the past-tense "saved" note in a card's foot, which is 0.68rem body
   *  text rather than a control — a 20px arrow in a line of small print is not consistency, it is
   *  a different mistake. */
  export let size = 20;
</script>

<!-- aria-hidden throughout: every call site is a button or link that already carries its own
     accessible name (an aria-label, or visible words beside this). focusable="false" because IE/old
     Edge put SVG in the tab order; harmless now, and one less thing to rediscover. -->
<svg
  class="dlic"
  width={size}
  height={size}
  viewBox="0 0 24 24"
  aria-hidden="true"
  focusable="false"
  fill="none"
  stroke="currentColor"
  stroke-width="2.2"
  stroke-linecap="round"
  stroke-linejoin="round"
>
  <path d="M12 4v10" />
  <path d="M7.5 10.5 12 15l4.5-4.5" />
  <path d="M5 19h14" />
</svg>

<style>
  /* inline-block + vertical-align, not block: this icon sits inside two kinds of button in this
     codebase. Every `.btn` here is `display: inline-block`, so the icon shares an inline formatting
     context with its label and needs a baseline nudge to sit level with it; the lightbox's pill and
     the card's corner plate are flex, where vertical-align is ignored and `align-items: center`
     does the same job. One rule covers both.
     `flex: none` so a flex button never squeezes the icon before it wraps the words. */
  .dlic { display: inline-block; vertical-align: -0.3em; flex: none; }
</style>
