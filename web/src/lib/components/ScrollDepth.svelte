<script lang="ts">
  // How far down the page a visitor actually got, and how long they stayed.
  //
  // Added because the question "is this section keeping them scrolling?" was unanswerable: the
  // funnel shows visits ≫ signups, which cannot distinguish "nobody scrolled past the hero" from
  // "they read the lot and were not convinced". Those two call for opposite fixes.
  //
  // Deliberately cheap. One passive listener, throttled to an animation frame, reporting only when
  // a milestone is first crossed — so a visitor who scrolls the whole page sends four small beacons,
  // not one per pixel. Nothing is stored on their device and nothing blocks paint.
  import { onMount } from 'svelte';
  import { track } from '$lib/analytics';

  /** Which page this is, so the numbers can be read per page rather than in aggregate. */
  export let page: string;

  const MARKS = [25, 50, 75, 100] as const;

  onMount(() => {
    const seen = new Set<number>();
    const start = Date.now();
    let queued = false;

    const measure = () => {
      queued = false;
      const doc = document.documentElement;
      const scrollable = doc.scrollHeight - window.innerHeight;
      // A page shorter than the viewport is 100% read by definition; reporting 25/50/75 for it
      // would quietly inflate every average.
      const pct = scrollable <= 0 ? 100 : Math.min(100, Math.round(((window.scrollY + window.innerHeight) / doc.scrollHeight) * 100));
      for (const m of MARKS) {
        if (pct >= m && !seen.has(m)) {
          seen.add(m);
          track('scroll_depth', { page, depth: m }, undefined);
        }
      }
    };
    const onScroll = () => { if (!queued) { queued = true; requestAnimationFrame(measure); } };

    measure();                                          // a short page counts immediately
    addEventListener('scroll', onScroll, { passive: true });
    addEventListener('resize', onScroll, { passive: true });

    // Dwell is reported once, on the way out. visibilitychange rather than beforeunload, which is
    // unreliable on mobile Safari — a phone backgrounding the tab never fires it.
    let sent = false;
    const leave = () => {
      if (sent || document.visibilityState !== 'hidden') return;
      sent = true;
      const secs = Math.round((Date.now() - start) / 1000);
      // Bucketed, not exact: the useful question is "did they read it or bounce", and a precise
      // second-count on a single visitor is closer to a fingerprint than an answer.
      const bucket = secs < 5 ? '0-5' : secs < 15 ? '5-15' : secs < 45 ? '15-45' : secs < 120 ? '45-120' : '120+';
      track('page_dwell', { page, secs: bucket, depth: Math.max(0, ...seen) }, undefined);
    };
    document.addEventListener('visibilitychange', leave);

    return () => {
      removeEventListener('scroll', onScroll);
      removeEventListener('resize', onScroll);
      document.removeEventListener('visibilitychange', leave);
    };
  });
</script>
