<script lang="ts">
  /* The star the product draws, everywhere it means "favourite".
   *
   *  Same reasoning as HeartIcon, and the same report behind it: ★ / ☆ (U+2605 / U+2606) are
   *  TYPOGRAPHIC symbols drawn by whatever font the device happens to have for that codepoint, so
   *  both the shape AND where the ink sits inside the line box vary by machine. In a 38px circular
   *  button that shows up as a star sitting low — measurable on one device, dead-centre on another,
   *  which is exactly what makes it hard to chase. One path, centred on its own viewBox, is the
   *  same everywhere.
   *
   *  NOT used where a star sits inline in a sentence or a tab label ("★ Favourites", "star a photo
   *  with ★"). Those are typographic by intent: they take the colour and size of the text around
   *  them, and swapping them for a component would make a word taller than its line. */
  export let filled = false;
  export let size = 18;
</script>

<svg class="star-i" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false"
     fill={filled ? 'currentColor' : 'none'} stroke="currentColor" stroke-width={filled ? 0 : 1.9}
     stroke-linejoin="round">
  <!-- A regular five-point star, points at r=9.4 and valleys at r=3.8, drawn about (12,12) so the
       ink's centre IS the box's centre — which is the whole point of drawing it. -->
  <path d="M12 2.6 14.55 9.25 21.4 9.62 16.1 14.0 17.82 20.7 12 16.9 6.18 20.7 7.9 14.0 2.6 9.62 9.45 9.25 Z" />
</svg>

<style>
  .star-i { display: block; }
</style>
