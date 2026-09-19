<script lang="ts">
  /* The heart the product draws, everywhere it means "liked".
   *
   *  It replaces the characters ♥ / ♡ (U+2665 / U+2661), and the reason is shape: those are
   *  TYPOGRAPHIC hearts drawn by whatever font the device happens to use for that codepoint, so the
   *  same control was a narrow pinched spade on one phone and a wide flat one on the next, sitting
   *  on a baseline it does not share with the number beside it. This is one path, the same on every
   *  device, with the round shoulders and the short point of the shape people actually picture.
   *
   *  NOT used for the trick-list tick. That glyph is the host's CHOICE out of a set of characters,
   *  and it is printed on the poster and the cards by canvas fillText — which can draw a character
   *  and cannot draw a component. Swapping the app's copy for an SVG would make the screen and the
   *  printed card show different marks, which is the one thing that set of glyphs must never do. */
  export let filled = false;
  export let size = 18;
</script>

<svg class="heart-i" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
     fill={filled ? 'currentColor' : 'none'} stroke="currentColor" stroke-width={filled ? 0 : 2}
     stroke-linejoin="round">
  <!-- Two circles and a point: shoulders at y≈7.5, the widest part at y≈9, tapering to a tip at
       y≈20.5 that sits just inside the box so the stroke is never clipped. -->
  <path d="M12 20.8 C12 20.8 2.6 14.6 2.6 8.6 C2.6 5.5 5 3.2 7.9 3.2 C9.7 3.2 11.2 4.1 12 5.5
           C12.8 4.1 14.3 3.2 16.1 3.2 C19 3.2 21.4 5.5 21.4 8.6 C21.4 14.6 12 20.8 12 20.8 Z" />
</svg>

<style>
  .heart-i { display: block; overflow: visible; }
</style>
