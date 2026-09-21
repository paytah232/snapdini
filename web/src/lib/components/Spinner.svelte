<script lang="ts">
  /* The one turning mark in the product.
   *
   * WHY IT IS A COMPONENT AND NOT THREE COPIES OF SIX CSS LINES. It already existed, in
   * RotateControl, with a comment arguing the case: a static ellipsis sitting there for half a
   * minute reads as a hang, and a hang is when somebody presses the button again. Every other
   * place that waits had the ellipsis anyway — the three bulk-download buttons all showed
   * "Saving 3/12…" through a save that can run for minutes on event wifi, which is exactly the
   * duration the argument was made about.
   *
   * Copying the rule would have been quicker and is how the two of them drift: one picks up
   * prefers-reduced-motion and the other does not, one is sized in `em` and the other in pixels,
   * and a year later the product has two spinners that are almost the same.
   *
   * `currentColor` and `1em` are the whole design: it takes the colour and the size of whatever
   * label it sits beside, so it looks correct inside a ghost button, a primary button and a
   * danger button without any of them knowing about it.
   */

  /** Announced to assistive tech by the BUTTON, via aria-busy, not by this. A live region for a
   *  spinner would say "loading" over and over to no purpose. */
  export let label: string | undefined = undefined;
</script>

<span class="spin" role={label ? 'status' : undefined} aria-label={label} aria-hidden={label ? undefined : true}></span>

<style>
  .spin {
    display: inline-block; width: 1em; height: 1em; border-radius: 50%;
    border: 2px solid currentColor; border-top-color: transparent;
    vertical-align: -0.125em; animation: spin 0.7s linear infinite;
  }
  /* Slowed rather than stopped. The point of the thing is to say work is happening, and a
     motionless ring says the opposite more loudly than no ring at all. */
  @media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2.4s; } }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
