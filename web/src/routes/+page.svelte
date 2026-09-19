<script lang="ts">
  import SiteNav from '$lib/components/SiteNav.svelte';
  import { usecaseLinks } from '$lib/usecases';
  import { onMount } from 'svelte';
  import { getConfig, postJson, api, getMe } from '$lib/api';
  import { carouselStep, wrapReal } from '$lib/carousel';
  import { showToast } from '$lib/toast';
  import { modalFocus } from '$lib/ui';
  import { page } from '$app/stores';
  import { claimReferral } from '$lib/referral';
  import SiteFooter from '$lib/components/SiteFooter.svelte';
  import Logo from '$lib/components/Logo.svelte';
  import MissionList from '$lib/components/MissionList.svelte';
  import { appearance, setAppearance } from '$lib/appearance';
  import ScrollDepth from '$lib/components/ScrollDepth.svelte';

  let version = '';
  let loggedIn = false;   // logged-in visitors get "My events" links (→ portal), not a sign-in prompt
  let demoBusy = false;
  let qr: { src: string; url: string } | null = null;
  let demoLinks: { camera: string; host: string; gallery: string } | null = null;

  // Hero film-strip: each frame adopts its photo's true aspect ratio, but the reshape happens
  // while the photo is still invisible — so you only ever see the empty gradient frame reflow
  // (gently, via a CSS transition), never a photo squish. Once sized, the photo "develops in"
  // like a fresh shot off the event — a blurred, over-exposed latent image that sharpens and
  // settles, staggered frame-by-frame so they arrive live. Fires on load (and immediately if
  // the image is already cached, which on:load alone would miss).
  // The shipped samples are 472x591, 472x472, 472x591, 472x472. Stating the real ratios here means
  // the frames lay out correctly on the FIRST paint instead of being reshaped after load.
  let frameRatio = ['4 / 5', '1 / 1', '4 / 5', '1 / 1'];
  // The develop-in animation is pure CSS now (see .frame img). It used to be gated on this action
  // adding a class, which meant the hero could not paint until hydration — worth ~2.3s of render
  // delay on mobile, and the whole of a 4.0s LCP. This is left as a progressive enhancement only:
  // if someone replaces the sample photos with a different shape, the frame still adapts.
  function develop(node: HTMLImageElement, i: number) {
    const show = () => {
      if (!node.naturalWidth || !node.naturalHeight) return;
      const actual = `${node.naturalWidth} / ${node.naturalHeight}`;
      if (frameRatio[i] === actual) return;      // the shipped samples already match — nothing to do
      frameRatio[i] = actual;
      frameRatio = frameRatio;
    };
    if (node.complete) show();
    node.addEventListener('load', show);
    return { destroy() { node.removeEventListener('load', show); } };
  }

  // Sending a desktop visitor straight into the camera is the wrong outcome — the demo is worth
  // more on a phone, and the desktop path offers a QR to get it there. Two rules, and NOT a
  // window-size rule: the old `maxTouchPoints > 1 && min(innerWidth, innerHeight) < 820` treated
  // any touch-capable machine with a short browser window as a phone, which is a laptop with a
  // touchscreen and a mouse — a common thing, and it skipped straight past the QR.
  //   1. The user agent, which is honest for actual phones.
  //   2. iPadOS 13+ lies in rule 1 (it reports a desktop Safari UA), so the tell is a touch
  //      device with NO mouse-like pointer available at all. A touchscreen laptop has a
  //      trackpad, so `any-pointer: fine` matches there and it stays on the desktop path.
  const isMobile = () =>
    typeof navigator !== 'undefined' &&
    (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.maxTouchPoints > 1
        && typeof matchMedia === 'function'
        && !matchMedia('(any-pointer: fine)').matches));

  onMount(async () => {
    // A guest arriving from someone's gallery: tell the server so it can set the attribution
    // cookie. Guests never sign up, so this link is the only way to connect "was a guest" to
    // "later ran their own event".
    const ref = $page.url.searchParams.get('ref');
    if (ref) claimReferral(ref);
    try { version = (await getConfig()).version; } catch { /* offline */ }
    try { loggedIn = !!(await getMe()).user; } catch { /* not signed in */ }
  });

  /* Leaving demoBusy set on the way out means the BACK button can restore this page from the
     bfcache with the demo button still disabled and still reading "Starting…", and nothing is left
     running to clear it. A restore is the one moment it has to be reset by hand. Bound on the
     svelte:window tag below rather than added in onMount, because that onMount is async: Svelte
     ignores whatever an async mount returns, so the cleanup would never run. A component gets only
     one such tag, hence sharing it with the Escape handler. */
  function onPageShow(e: PageTransitionEvent) { if (e.persisted) demoBusy = false; }

  async function startDemo() {
    if (demoBusy) return;
    demoBusy = true;
    try {
      const { joinCode, sessionToken, organizerCode } = await postJson<{ joinCode: string; sessionToken: string; organizerCode: string }>(
        '/api/events/demo', {}
      );
      // Stash the demo's session + organizer code so the camera can link into the host + gallery views.
      localStorage.setItem('session_' + joinCode, sessionToken);
      if (organizerCode) localStorage.setItem('demo_org_' + joinCode, organizerCode);
      if (isMobile()) {
        // Assigning location.href STARTS the navigation; it does not stop this function. So the
        // `finally` that used to sit below ran immediately, putting "See what it looks like" back
        // while the browser was still fetching the demo — the button reporting that it had finished
        // a second or two before the camera actually appeared, which reads as the tap not having
        // worked. This page is on its way out, so the label stays "Starting…" until it is gone.
        location.href = '/join/' + joinCode;
        return;
      }
      const q = await api<{ qrCode: string; joinUrl: string }>('/api/events/' + joinCode + '/qr');
      qr = { src: q.qrCode, url: q.joinUrl };
      demoLinks = {
        camera: '/join/' + joinCode,
        host: '/admin/' + joinCode + '#' + encodeURIComponent(organizerCode),
        gallery: '/gallery/' + joinCode,
      };
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not start the demo', true);
    }
    // Desktop, or a failure: either way this page is staying, so the button goes back to being a
    // button. The mobile success path returned above and deliberately never reaches here.
    demoBusy = false;
  }

  const features = [
    { ic: '🎞️', t: 'A limited roll', d: 'Each guest gets a set number of shots. No do-overs, no endless scrolling — every frame counts.' },
    { ic: '🪄', t: 'The grand reveal', d: 'Photos stay up the magician’s sleeve all night, then reappear together the moment your event ends.' },
    { ic: '🔗', t: 'Join in one tap', d: 'Scan a QR or punch in a short code. No app to install — poof, they’re in.' },
    { ic: '🖼️', t: 'One shared gallery', d: 'Every guest’s shots land in one gallery to relive and download together.' },
      // Sits here rather than in the hero: the lede already explains the whole product in eight
      // words, and a hero that explains two things explains neither. This is still the first
      // screenful on most viewports.
      { ic: '🃏', t: 'A list of tricks', d: 'Hand out a few shots to pull off — printed for the tables, ticked off in the camera. Optional.' }
  ];
  // ── "How it works" media slots ───────────────────────────────────────────────
  // All three steps carry a media slot of the SAME size (.media below, one fixed ratio), so the
  // row reads as three equal cards rather than one illustrated step flanked by two paragraphs.
  //
  // `slot` chooses what fills it:
  //   'carousel' → the rotating poster styles (step 02 only)
  //   'still'    → `img` when it is set, otherwise the tinted placeholder block
  //
  // SWAP POINT — to drop real art into step 01 or 03: put <name>.webp and <name>.jpg (520×735,
  // the same size as the poster slides) in web/static/marketing/ and set that step's `img` to
  // '<name>'. That one line is the whole change — the placeholder disappears, nothing else moves.
  const steps = [
    { n: '01 / CONJURE', t: 'Set the stage', d: 'Name it, choose how many shots each guest gets, and when the photos reappear.',
      slot: 'still', img: 'setup-screen', ic: '📝', cap: 'The setup screen',
      alt: 'The Snapdini setup screen, where a host names the event and chooses the roll size' },
    // "Drop the QR on the tables" is the exact moment a host thinks "…on what?" — and we answer
    // that in the product and used to say nothing about it here. Every competitor has QR-join;
    // what we have is the thing that gets the QR onto a table looking like it belongs there.
    // One still poster is one look, and "pick a look" is the whole claim — so this slot cycles.
    { n: '02 / SHARE', t: 'Put it on the tables', d: 'Design the poster and table cards right here — pick a look, print, done. Or just send the link. Guests join in a tap.',
      slot: 'carousel', img: '', ic: '🎨', cap: 'Poster styles', alt: '' },
    { n: '03 / REVEAL', t: 'Make them reappear', d: 'Everyone shoots through the night — then the whole gallery reappears at once.',
      slot: 'still', img: 'gallery-reveal', ic: '🖼️', cap: 'The gallery reveal',
      alt: 'The shared gallery, every guest’s shots appearing together after the reveal' }
  ];

  // The poster styles step 02 cycles. Each lives in web/static/marketing/ as a matching .webp and
  // .jpg pair and <picture> takes whichever the browser can read. Regenerate them from the
  // full-size renders at 520×735 (2× the 260px slot); the width/height attrs in the markup are
  // hardcoded to that, so the row cannot jump while a slide loads.
  const posters = [
    { f: 'poster-sweetheart',  name: 'Sweetheart' },
    { f: 'poster-art-deco',    name: 'Art deco' },
    { f: 'poster-botanical',   name: 'Botanical' },
    { f: 'poster-celebration', name: 'Celebration' },
    { f: 'poster-minimal',     name: 'Minimal' }
  ];
  const posterAlt = (name: string) =>
    `A printable table poster in the ${name.toLowerCase()} style: the couple’s names, a QR code with the Snapdini mark in it, and the join link`;

  // The track carries a clone of the LAST poster before the first, and a clone of the FIRST after
  // the last. "Next" from the end then moves ONE step to the right onto a picture identical to
  // slide 1, and the instant that transition lands we jump — with transitions off — to the real
  // slide 1. The swap is invisible because the two frames are the same image. Without the clones,
  // wrapping set translateX from -400% to 0 and animated the whole strip backwards past every
  // style, which is what it looked like: a fast rewind.
  $: pSlides = [posters[posters.length - 1], ...posters, posters[0]];
  let pPos = 1;              // index into pSlides; 1..posters.length are the real slides
  let pAnim = true;          // false for the single frame we snap across the seam
  $: pIdx = ((pPos - 1) % posters.length + posters.length) % posters.length;   // dots + aria
  let pHover = false, pFocus = false, pStill = false;   // pStill = prefers-reduced-motion
  let pTimer: ReturnType<typeof setInterval> | null = null;
  const P_MS = 4200;
  // One place decides whether the thing is rotating, so hover/focus/reduced-motion/manual can
  // never disagree about it. Every manual move calls this too, which restarts the clock — an
  // auto-advance a quarter-second after someone pressed the arrow is the classic carousel bug.
  function pSync() {
    if (pTimer) { clearInterval(pTimer); pTimer = null; }
    if (pStill || pHover || pFocus) return;
    // Through pGo, so the auto-advance cannot walk off the track either — a backgrounded tab
    // fires the interval while transitions (and transitionend) are paused.
    pTimer = setInterval(() => pGo(1), P_MS);
  }
  // A press that arrives while the strip is still moving is QUEUED, not applied.
  //
  // Applying it immediately walked the track PAST the clone: pSeam only corrects at exactly 0 or
  // pSlides.length - 1, so one step beyond and it never matched again — the strip parked where no
  // slide is, which is a black frame, permanently. Wrapping instead of walking fixed that but
  // SNAPPED, and a snap mid-glide reads as the carousel stalling and then lurching. Queueing keeps
  // it gliding: a press is spent the moment the current slide lands, so spam-pressing looks like
  // one continuous run through the styles rather than a stutter.
  //
  // At most ONE press is held. A queue that counts every press winds up like a spring and keeps
  // moving long after the finger stops, which is its own kind of broken.
  let pBusy = false;                                   // the strip is mid-transition
  let pQueued = 0;                                     // -1, 0 or 1
  let pWatch: ReturnType<typeof setTimeout> | null = null;
  const P_SLIDE_MS = 450;                              // matches `transition: transform .45s` on .track

  /** Actually move. Only ever called when the strip is at rest and in range. */
  function pStep(d: number) {
    // carouselStep is kept as the belt to this braces: even if a settle were ever missed, a step
    // cannot leave the track. See $lib/carousel for what that costs and why it matters.
    const step = carouselStep(pPos, d, posters.length);
    pAnim = step.animate;
    pPos = step.pos;
    if (!step.animate) { requestAnimationFrame(() => requestAnimationFrame(() => { pAnim = true; })); }
    pBusy = true;
    // transitionend is the real signal, but it does not always arrive — a backgrounded tab, an
    // interrupted transition, a browser that drops the event. Without this the carousel would
    // freeze for good, which is worse than what it replaced.
    if (pWatch) clearTimeout(pWatch);
    pWatch = setTimeout(pSettled, P_SLIDE_MS + 120);
    pSync();
  }

  /** Step one slide. Direction, not destination — the seam handler puts us back in range. */
  function pGo(d: number) {
    // Reduced motion never animates, so transitionend never fires and the seam handler never
    // runs. Wrap arithmetically instead, or pPos would walk off the end of the track.
    if (pStill) { pPos = wrapReal(pPos, d, posters.length); pSync(); return; }
    if (pBusy) { pQueued = d > 0 ? 1 : -1; pSync(); return; }
    pStep(d);
  }

  /** The strip has stopped: cross the seam if we landed on a clone, then spend a queued press. */
  function pSettled() {
    if (pWatch) { clearTimeout(pWatch); pWatch = null; }
    pBusy = false;
    if (pPos !== 0 && pPos !== pSlides.length - 1) { pDrain(); return; }
    pAnim = false;
    pPos = pPos === 0 ? posters.length : 1;
    // Two frames, not one: the browser needs a paint with transitions off before they go back on,
    // or re-enabling lands in the same frame as the snap and the seam animates after all.
    requestAnimationFrame(() => requestAnimationFrame(() => { pAnim = true; pDrain(); }));
  }

  function pDrain() {
    if (!pQueued) return;
    const d = pQueued;
    pQueued = 0;
    pStep(d);
  }

  /** A dot is a destination, and always lands on a real slide. */
  function pDot(i: number) { pQueued = 0; pAnim = !pStill; pPos = i + 1; pSync(); }
  function pSeam(e: TransitionEvent) {
    // Only the track's own transform — not a bubbled transition from anything inside it.
    if (e.propertyName !== 'transform' || e.target !== e.currentTarget) return;
    pSettled();
  }
  function pKey(e: KeyboardEvent) {
    if (e.key === 'ArrowLeft') { e.preventDefault(); pGo(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); pGo(1); }
  }
  let pTx = 0, pTy = 0;
  function pTouchStart(e: TouchEvent) { pTx = e.touches[0].clientX; pTy = e.touches[0].clientY; }
  function pTouchEnd(e: TouchEvent) {
    const t = e.changedTouches[0];
    const dx = t.clientX - pTx, dy = t.clientY - pTy;
    // Horizontal-dominant only: a vertical flick is the page scrolling past, not a swipe.
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) pGo(dx < 0 ? 1 : -1);
  }
  onMount(() => {
    // Reduced motion means no auto-rotation at all — the arrows and dots are the whole control
    // surface then. Tracked live, because the OS setting can flip while the page is open.
    const mq = matchMedia('(prefers-reduced-motion: reduce)');
    const apply = () => { pStill = mq.matches; pSync(); };
    apply();
    mq.addEventListener('change', apply);
    return () => { mq.removeEventListener('change', apply); if (pTimer) clearInterval(pTimer); };
  });

  // ── SEO ──
  const TITLE = 'Snapdini — Disposable Camera App for Events & Weddings | QR Photo Sharing';
  const DESC = 'Snapdini is a digital disposable camera for events. Guests scan a QR code to snap a limited roll — no app to install — and the whole gallery reappears when your event ends, as a gallery and as a slideshow film. Design printable posters and table cards in the app. Free for up to 10 guests.';
  // `more` is navigation, not part of the answer — which is why it is a separate field and not
  // markup inside `a`. That string is also fed verbatim to the FAQ JSON-LD below, where an anchor
  // tag would be a literal "<a href..." in the structured data Google reads.
  /* `bullets` is for an answer that is genuinely a list. The page renders them as one, while the
     JSON-LD below folds them back into `a` as a sentence — structured data takes plain text, and a
     <ul> in that field would be read as literal tag soup by everything that consumes it. */
  const faqs: { q: string; a: string; bullets?: string[]; more?: { href: string; label: string }[] }[] = [
    { q: 'What is Snapdini?', a: 'Snapdini is a digital disposable camera for weddings, parties and events. Guests scan a QR code to open a camera with a limited roll of shots, and every photo lands in one shared gallery that reappears when the event ends.' },
    { q: 'Do guests need to download an app?', a: 'No. Guests scan a QR code or open a link and the camera opens right in their browser — nothing to install.' },
    { q: 'How much does Snapdini cost?', a: 'It is free for events of up to 10 guests with every feature included — including the printable posters and table cards, and the slideshow film of the gallery. Larger events are a one-off pass starting at A$5, with optional add-ons for extra shots, frame sizes and video clips.',
      more: [{ href: '/pricing', label: 'See the full pricing' }] },
    { q: 'When do the photos appear?', a: 'You choose: photos can reappear all at once the moment your event ends (the classic disposable-camera reveal), or show up instantly as they are taken.' },
    { q: 'Can I use it for a wedding?', a: 'Yes — Snapdini is ideal for weddings, birthdays, parties and corporate events. Print the QR poster for the tables and guests join in a tap.' },
    { q: 'Can everyone download the photos?', a: 'Yes, if you want them to. All shots collect in one shared gallery you can browse and download together — a single photo, or the whole event in one go. You can also turn guest downloads off, or keep the gallery to yourself entirely and just collect: set the reveal to Manual and never unveil it, and the photos come to you without ever going up for the room. Useful for a corporate shoot where the pictures are yours to sort through first.' },
    // The features nobody thinks to ask about, in the one place people go looking for answers.
    { q: 'Anything else worth checking out?',
      a: 'Plenty — Snapdini is a fair bit more than the camera:',
      bullets: [
        'Themes, so the camera, the gallery and your posters all match the event.',
        'Printable posters and table cards you design in the app.',
        'A trick list of shots for guests to pull off, ticked off as they shoot.',
        'Short video clips as well as stills.',
        'A slideshow film of the whole gallery to play when the night is over.',
        'Hearts and comments, so guests can react to each other’s photos.',
        'Favourites and hand-picked share links for just the shots you choose.',
        'Moderation, to approve photos before anyone else sees them.',
        'Co-hosts, so someone else can help you run it.',
      ],
      more: [{ href: '/demo', label: 'Try the live demo' }] },
    { q: 'What kinds of events is Snapdini for?',
      a: 'Any event where the guests are the photographers. Weddings and birthdays are the common ones, but the same roll-and-reveal works for engagements, hens and bucks nights, baby showers, graduations, Christmas parties and corporate days out.',
      more: usecaseLinks.map((u) => ({ href: `/${u.slug}`, label: u.label })) },
  ];
  /* The four photos in the hero strip, drawn at random per request by +page.server.ts. Read off
     $page.data rather than an `export let data` prop, which is how everything else on this page
     reaches server state. The fallback is the original fixed four, so the strip still renders if
     the load ever returns nothing. */
  /* The strip cycles through every event we have photos of. The SERVER decides the order and which
     roll is first (see pickDeck) so the first paint matches between server and client; from there
     this advances it on a timer. One roll on screen at a time — the frame numbers are consecutive,
     so the four frames must always belong to the same event. */
  $: deck = $page.data.deck ?? [{ photos: ['1', '2', '3', '4'], label: '' }];
  /* A clone of the first roll sits at the end of the track, which is what makes the wrap seamless:
     sliding from the last roll onto the clone moves ONE step forward, and the instant that
     transition lands we jump back to the real first roll with the transition switched off. Without
     it, going from the last roll to the first rewinds the whole track backwards past every event.
     Same mechanism as the poster carousel above — see pSeam. */
  $: rollSlides = deck.length > 1 ? [...deck, deck[0]] : deck;
  let rollIndex = 0;
  let rollSnap = false;          // true only for the frame in which we jump, so the jump is invisible
  $: current = deck[rollIndex % deck.length];
  $: samples = current.photos;

  function rollSeam() {
    if (rollIndex !== deck.length) return;   // a normal step, not the clone
    rollSnap = true;                         // transition off
    rollIndex = 0;                           // ...and back to the real first roll
    // Re-enable on the next frame, once the browser has painted the jump. Doing it synchronously
    // lets the same style recalculation see both changes, and the jump animates — visibly rewinding.
    requestAnimationFrame(() => requestAnimationFrame(() => (rollSnap = false)));
  }

  /** Fetch one roll's photos ahead of time, when the browser has nothing better to do. */
  function preloadRoll(i: number) {
    const roll = deck[i % deck.length];
    if (!roll) return;
    const go = () => { for (const key of roll.photos) { const im = new Image(); im.src = `/sample/${key}-220.webp`; } };
    // requestIdleCallback where it exists (not Safari); a timeout elsewhere. Either way it must not
    // compete with first paint, which is the whole point of doing this after mount.
    if ('requestIdleCallback' in window) (window as unknown as { requestIdleCallback: (f: () => void) => void }).requestIdleCallback(go);
    else setTimeout(go, 1200);
  }

  /** Is the roll we are about to slide to actually painted yet? */
  function rollReady(i: number): boolean {
    if (typeof document === 'undefined') return true;
    const slide = document.querySelectorAll('.roll-slide')[i];
    if (!slide) return true;
    // A picture whose file 404s is removed by the error handler, so "no img" is ready, not pending.
    return [...slide.querySelectorAll('img')].every((im) => (im as HTMLImageElement).complete);
  }

  onMount(() => {
    /* ONE roll ahead, never the whole deck.
       `loading="lazy"` is right for first paint but means "when it scrolls into view", and a slide
       arriving by transform never does — so a rotation could land on empty frames. The first fix
       here preloaded all six rolls on mount: 21 image requests and 216KB on a page whose whole job
       is to be fast, for photos most visitors never scroll far enough in time to see. Now the next
       roll is fetched while the current one is on screen, during idle time, so there is always
       exactly one roll in hand and never five wasted. */
    preloadRoll(1);

    // Long enough to actually look at a roll, and off entirely for anyone who has asked for less
    // motion: a strip that slides every few seconds in the corner of the eye is what that setting
    // is for.
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => {
      const next = rollIndex >= deck.length ? 1 : rollIndex + 1;
      // Hold on this roll rather than slide onto half-painted frames; the preload above means this
      // is a rare, brief wait on a cold cache, and the next tick tries again.
      if (!rollReady(next)) return;
      rollIndex = next;
      preloadRoll(next + 1);   // keep exactly one roll in hand
    }, 6000);
    return () => clearInterval(t);
  });
  /* The event those four frames came from. Without it the strip is four unexplained photographs —
     and now that a visit might land on a ski slope or a tent rather than a wedding, "what am I
     looking at" is a fair question. One caption for the roll, not one per frame: they are four
     frames off the same roll (see SAMPLE_ROLLS) and four captions would say so four times. */
  $: rollLabel = current.label ?? '';
  // Consecutive from a random start — see pickStampStart.
  $: stampStart = $page.data.stampStart ?? 24;

  // Configuration, NOT the request host: a preview host must not declare itself canonical.
  $: origin = $page.data.canonicalOrigin ?? $page.url.origin;
  $: ldApp = {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Snapdini',
    applicationCategory: 'MultimediaApplication', operatingSystem: 'Web', url: origin + '/',
    description: DESC,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'AUD', description: 'Free for up to 10 guests' },
  };
  $: ldFaq = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: faqs.map((f) => ({
      '@type': 'Question', name: f.q,
      // Points folded back into the sentence they belong to — see the note on `bullets`.
      acceptedAnswer: { '@type': 'Answer', text: f.bullets ? `${f.a} ${f.bullets.join(' ')}` : f.a },
    })),
  };
</script>

<ScrollDepth page="home" />

<svelte:head>
  <title>{TITLE}</title>
  <meta name="description" content={DESC} />
  <link rel="canonical" href={origin + '/'} />
  <meta name="robots" content={$page.data.robotsMeta ?? 'noindex, nofollow'} />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Snapdini" />
  <meta property="og:title" content={TITLE} />
  <meta property="og:description" content={DESC} />
  <meta property="og:url" content={origin + '/'} />
  <meta property="og:image" content={origin + '/og.png'} />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={TITLE} />
  <meta name="twitter:description" content={DESC} />
  <meta name="twitter:image" content={origin + '/og.png'} />
  {@html `<script type="application/ld+json">${JSON.stringify(ldApp)}</` + `script>`}
  {@html `<script type="application/ld+json">${JSON.stringify(ldFaq)}</` + `script>`}
</svelte:head>

<SiteNav>
  <div class="nav-links">
    <button class="theme-toggle" on:click={() => setAppearance($appearance === 'light' ? 'dark' : 'light')}
      title="Toggle light / dark" aria-label="Toggle light or dark mode">{$appearance === 'light' ? '🌙' : '☀️'}</button>
    {#if loggedIn}
      <a class="btn primary" href="/dashboard">My events →</a>
    {:else}
      <a class="btn ghost" href="/login">Sign in</a>
      <a class="btn primary" href="/signup">Start free</a>
    {/if}
  </div>
</SiteNav>

<main>
<header class="hero">
  <div>
    <div class="eyebrow"><span class="eb-dot"></span> The disappearing event camera</div>
    <h1>Now you see them.<br><em>Now you don't.</em></h1>
    <p class="lede">Guests scan a code and shoot a limited roll. Every photo vanishes the second it's taken — then the whole gallery reappears at once when your event ends. A disposable camera with a disappearing act.</p>
    <div class="cta">
      <a class="btn primary" href={loggedIn ? '/app' : '/signup'}>Create your event</a>
      <button class="btn ghost" on:click={startDemo} disabled={demoBusy}>
        <!-- Both labels sit in the SAME grid cell, so the button is always as wide as the longest
             one and pressing it cannot resize anything. Swapping the text outright shrank the
             button to fit "Starting…", which on a phone re-wrapped the whole call-to-action row —
             the layout jumping at the exact moment the guest is waiting to see whether their tap
             worked. Hidden with `visibility`, not `display`, because the space is the point. -->
        <span class="swap">
          <span class="lbl" class:off={demoBusy} aria-hidden={demoBusy || undefined}>See what it looks like →</span>
          <span class="lbl" class:off={!demoBusy} aria-hidden={!demoBusy || undefined}>Starting…</span>
        </span>
      </button>
    </div>
    <p class="note">No app to install. <b>Free</b> to start.</p>
  </div>
  <div class="strip-wrap">
  <!-- The tilt, the dark card and the shadow live on the WINDOW, not on each roll: the window is
       what clips, and a rotated element with overflow:hidden clips along its own rotated edges, so
       a roll slides out under the tilted corner instead of past a straight one. -->
  <div class="strip" aria-hidden="true">
    <ul class="roll-track" class:snap={rollSnap} on:transitionend={rollSeam}
        style="transform: translateX(calc({rollIndex} * (-100% - 8px)))">
      {#each rollSlides as roll, r}
        <li class="roll-slide">
          {#each ['#3a2a4d,#c8607a', '#1d3b4d,#46b3c9', '#4d3b1d,#e8994a', '#2a4d33,#7ad08a'] as g, i}
            <div class="frame" style="background:linear-gradient(135deg,{g}); aspect-ratio:{frameRatio[i]}">
              <!-- One roll per slide — four frames off the same event, because the stamps below are
                   consecutive. The deck and its order come from +page.server.ts; see lib/samples.ts
                   for why the pick cannot happen here. A missing file fails quietly and the gradient
                   "latent image" shows. -->
              <!-- Displayed at ~99px wide, so 220w covers 2x and 330w covers 3x. -->
              <!-- The <picture> only EXISTS for the roll on screen and the one after it.
                   `loading="lazy"` does not help here: every slide is laid out inside the strip, so
                   the browser counts them all as near-viewport and fetches the lot — measured at 21
                   image requests and 217KB for a page whose whole job is to be fast, most of it for
                   rolls a visitor never waits long enough to see. No element, no request. The gradient
                   underneath stands in until then, which is the same "latent image" a missing file
                   falls back to. -->
              {#if r <= rollIndex + 1}
                <picture>
                  <source type="image/webp"
                          srcset="/sample/{roll.photos[i]}-220.webp 220w, /sample/{roll.photos[i]}-330.webp 330w" sizes="100px" />
                  <img src="/sample/{roll.photos[i]}-220.jpg"
                       srcset="/sample/{roll.photos[i]}-220.jpg 220w, /sample/{roll.photos[i]}-330.jpg 330w" sizes="100px"
                       alt="" loading={r === 0 ? 'eager' : 'lazy'} fetchpriority={r === 0 && i === 0 ? 'high' : 'auto'}
                       style="--d:{(i * 0.22).toFixed(2)}s"
                       use:develop={i} on:error={(e) => e.currentTarget.closest('picture')?.remove()} />
                </picture>
              {/if}
              <span class="stamp">▶ {stampStart + i}</span>
            </div>
          {/each}
        </li>
      {/each}
    </ul>
  </div>
    <!-- OUTSIDE the strip, deliberately. `.strip` is a flex row whose frames are `flex: 1`, so a
         caption inside it took a share of the row and squeezed all four photos to zero width — the
         images loaded fine and rendered at 0x0. It is also outside the -4deg rotation, so the words
         sit straight while the film strip stays tilted. -->
    {#if rollLabel}<span class="roll">{rollLabel}</span>{/if}
  </div>
</header>

<section class="band">
  <div class="kicker">Why it's magic</div>
  <h2>The fun of a disposable camera, with a disappearing act.</h2>
  <div class="grid">
    {#each features as f}
      <div class="card"><div class="ic">{f.ic}</div><h3>{f.t}</h3><p>{f.d}</p></div>
    {/each}
  </div>
</section>

<section class="band">
  <div class="kicker">Trick list</div>
  <h2>Hand your guests a few tricks.</h2>
  <div class="missions">
    <div>
      <p>Pick the shots you’d hate to miss. They print on a card for the tables, and guests get the
        same list inside the camera to tick off as they shoot — so the cake gets photographed before
        it’s cut, and the quiet table in the corner ends up in a frame.</p>
      <p>The usual version of this sits on top of a shared album, where a guest can shoot the same
        thing fifty times and keep the best one. Snapdini is the camera: one roll, no takebacks,
        nothing visible until the reveal. Spending a frame on a trick is a real decision, which is
        what makes a ticked-off list worth looking at.</p>
      <p class="note">Every kind of event gets its own list — reword any line, or write your own.
        It’s a suggestion, never a task: guests can ignore the whole thing and just take photos.</p>
    </div>
    <MissionList eventType="wedding" />
  </div>
</section>

<section class="band">
  <div class="kicker">How it works</div>
  <h2>Set up the whole trick in about a minute.</h2>
  <div class="grid steps">
    {#each steps as s}
      <div class="card">
        <div class="step-n">{s.n}</div>
        <h3>{s.t}</h3>
        <p>{s.d}</p>
        {#if s.slot === 'carousel'}
          <!-- Rotating poster styles: auto-advances, stops dead under the cursor or keyboard
               focus, never auto-advances under prefers-reduced-motion, and can always be driven
               by the arrows, the dots, or a horizontal swipe. -->
          <div class="media art" role="group" aria-roledescription="carousel" aria-label={s.cap}
               on:mouseenter={() => { pHover = true; pSync(); }}
               on:mouseleave={() => { pHover = false; pSync(); }}
               on:focusin={() => { pFocus = true; pSync(); }}
               on:focusout={() => { pFocus = false; pSync(); }}
               on:touchstart={pTouchStart} on:touchend={pTouchEnd}>
            <ul class="track" class:snap={!pAnim} on:transitionend={pSeam}
                style="transform: translateX({pPos * -100}%)">
              {#each pSlides as p, i}
                <li class="slide" aria-hidden={i !== pPos}>
                  <picture>
                    <source srcset="/marketing/{p.f}.webp" type="image/webp" />
                    <!-- width/height are the real intrinsic size, so the row does not jump when it
                         loads. lazy + async: it is below the fold and must never hold up first paint.
                         The two clones at either end are decorative duplicates, so no alt text. -->
                    <img src="/marketing/{p.f}.jpg"
                         alt={i === 0 || i === pSlides.length - 1 ? '' : posterAlt(p.name)}
                         width="520" height="735" loading="lazy" decoding="async" />
                  </picture>
                </li>
              {/each}
            </ul>
            <!-- Chevrons are drawn, not typed. The ‹ / › glyphs carry asymmetric side bearings, so
                 the ink sits off-centre inside its text box and no amount of place-items fixes it —
                 a path centred on the viewBox is centred on every platform. -->
            <button type="button" class="arrow prev" aria-label="Previous poster style"
                    on:click={() => pGo(-1)} on:keydown={pKey}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M15.5 5 L8.5 12 L15.5 19" />
              </svg>
            </button>
            <button type="button" class="arrow next" aria-label="Next poster style"
                    on:click={() => pGo(1)} on:keydown={pKey}>
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M8.5 5 L15.5 12 L8.5 19" />
              </svg>
            </button>
          </div>
          <div class="media-cap dots">
            {#each posters as p, i}
              <button type="button" class="dot" class:on={i === pIdx}
                      aria-label="Show the {p.name} poster"
                      aria-current={i === pIdx ? 'true' : undefined}
                      on:click={() => pDot(i)} on:keydown={pKey}></button>
            {/each}
          </div>
          <p class="sr" aria-live="polite">{posters[pIdx].name} poster</p>
        {:else if s.img}
          <div class="media art">
            <picture>
              <source srcset="/marketing/{s.img}.webp" type="image/webp" />
              <img src="/marketing/{s.img}.jpg" alt={s.alt}
                   width="520" height="735" loading="lazy" decoding="async" />
            </picture>
          </div>
          <div class="media-cap">{s.cap}</div>
        {:else}
          <!-- Placeholder until the real art lands — see the SWAP POINT comment in the script. -->
          <div class="media ph" aria-hidden="true"><span class="ph-ic">{s.ic}</span></div>
          <div class="media-cap">{s.cap}</div>
        {/if}
      </div>
    {/each}
  </div>
</section>

<section class="band">
  <div class="kicker">Questions</div>
  <h2 class="sec-title">Disposable camera app, the modern way</h2>
  <div class="faq">
    {#each faqs as f}
      <details class="faq-item">
        <summary>{f.q}</summary>
        <p>{f.a}</p>
        {#if f.bullets}<ul class="faq-list">{#each f.bullets as b}<li>{b}</li>{/each}</ul>{/if}
        {#if f.more}
          <p class="faq-more">
            {#each f.more as m}<a href={m.href}>{m.label} →</a>{/each}
          </p>
        {/if}
      </details>
    {/each}
  </div>
</section>

<section class="band cta-band">
  <div class="cta-card">
    <h2>Start your roll.</h2>
    <p>Create an event free and have your vanishing camera ready before the first guest arrives.</p>
    <a class="btn primary" href={loggedIn ? '/app' : '/signup'}>Create your event →</a>
  </div>
</section>
</main>

<SiteFooter {loggedIn} showUses showSupport={false}>
  <button class="linklike" on:click={startDemo}>See the demo</button>
</SiteFooter>

<svelte:window on:keydown={(e) => { if (e.key === 'Escape' && qr) qr = null; }}
               on:pageshow={onPageShow} />

{#if qr}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="modal" on:click|self={() => (qr = null)} role="dialog" aria-modal="true" aria-label="Demo QR code">
    <div class="modal-card" tabindex="-1" use:modalFocus>
      <h3>Best on your phone</h3>
      <p class="modal-lead">It is a camera, so a phone shows it at its best — scan to open the live demo.</p>
      <img src={qr.src} alt="Demo QR code" />
      <p class="url">{qr.url}</p>
      {#if demoLinks}
        <!-- The demo works perfectly well on a laptop with a webcam, and someone reading this on a
             desktop should not have to find a phone to see anything. The QR stays the headline
             because a phone IS better, but carrying on here is offered plainly rather than hidden
             behind a button labelled "Camera" that reads like one of three equal side-trips. -->
        <p class="or-explore">No phone on hand? Carry on right here:</p>
        <div class="demo-explore">
          <a class="btn primary sm" href={demoLinks.camera}>💻 Open the camera here</a>
        </div>
        <div class="demo-explore">
          <a class="btn ghost sm" href={demoLinks.host}>🎛️ Host view</a>
          <a class="btn ghost sm" href={demoLinks.gallery}>🖼️ Gallery</a>
        </div>
      {/if}
      <button class="btn ghost" on:click={() => (qr = null)}>Close</button>
    </div>
  </div>
{/if}

<style>
  :global(body) { overflow-x: hidden; }
  .nav-links { display: flex; gap: 8px; align-items: center; }
  .theme-toggle { background: transparent; border: 1px solid var(--border); border-radius: 10px; width: 38px; height: 38px; font-size: 1rem; cursor: pointer; line-height: 1; }
  .theme-toggle:hover { border-color: var(--accent); }
  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 10px 18px; font-size: .9rem;
    border: 1px solid transparent; cursor: pointer; text-decoration: none; }
  .nav-links .btn { padding: 7px 14px; font-size: .82rem; border-radius: var(--radius-sm); }
  .primary { background: var(--accent-fill); color: var(--accent-ink, #111); }
  .btn.sm { padding: 7px 14px; font-size: 0.82rem; border-radius: var(--radius-sm); }
  .ghost { border-color: var(--border); color: var(--text); background: transparent; }
  .ghost:hover { border-color: var(--accent); }
  .hero { display: grid; grid-template-columns: 1.05fr .95fr; gap: 48px; align-items: center;
    max-width: 1080px; margin: 0 auto; padding: 84px 24px 64px; }
  .eyebrow { display: inline-flex; align-items: center; gap: 8px; font-size: .74rem; letter-spacing: .16em;
    text-transform: uppercase; color: var(--text-muted); font-weight: 700; margin-bottom: 22px; }
  /* eb-dot, not .dot: the carousel's dot BUTTON further down this same file is also `.dot`, and
     Svelte scopes both with the same repeated scoping class — so the two were one specificity tie
     broken by source order, and the later rule won. The eyebrow's 7px accent bullet was being
     drawn as a 20px `background: none` button box with the carousel's ::after inside it, i.e. an
     8px grey dot in a hole three times too wide. Renamed rather than made more specific: two
     unrelated things sharing a class name in one component is the fault, not the tie. */
  .eb-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent-fill); }
  h1 { font-size: clamp(2.5rem, 6vw, 4.3rem); font-weight: 850; line-height: 1.05; letter-spacing: -.02em; }
  h1 em { font-style: normal; color: var(--accent); }
  .lede { font-size: 1.15rem; color: var(--text-muted); max-width: 32ch; margin: 22px 0 30px; }
  .cta { display: flex; gap: 12px; flex-wrap: wrap; }
  /* One cell, both labels stacked in it: the grid takes the width of the widest child, and the
     one that is not current is hidden without giving its space back. */
  .swap { display: grid; }
  .swap > .lbl { grid-area: 1 / 1; }
  .swap > .lbl.off { visibility: hidden; }

  .note { margin-top: 18px; font-size: .82rem; color: var(--text-muted); }
  /* One media slot, three steps. The illustration sits UNDER its step's words, not beside them:
     the steps are a row on a desktop and a column on a phone, and an image that floats left of
     the text reflows into a different reading order at the breakpoint. Every slot is the same
     width and the same ratio (the poster's), so the row reads as three equal cards — step 02's
     just happens to cycle. Capped in width so a tall portrait poster cannot make its card twice
     the height of its neighbours. */
  .media {
    position: relative;
    width: 100%;
    max-width: 260px;
    aspect-ratio: 520 / 735;
    margin: 16px auto 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm, 8px);
    overflow: hidden;
  }
  /* Posters are printed on white; on a dark page they need an edge or they float. */
  .media.art { box-shadow: 0 8px 26px rgba(0, 0, 0, 0.32); }
  .media picture { display: block; width: 100%; height: 100%; }
  .media img { display: block; width: 100%; height: 100%; object-fit: cover; }

  /* Placeholder: a soft accent-tinted block behind a dashed edge, so it reads as "art goes here"
     rather than "the image is broken". Replaced via the SWAP POINT comment in the script. */
  .media.ph {
    display: grid;
    place-items: center;
    border-style: dashed;
    border-color: color-mix(in srgb, var(--accent) 34%, var(--border));
    background: linear-gradient(155deg, color-mix(in srgb, var(--accent) 13%, var(--surface-2)), var(--surface-2) 70%);
  }
  .ph-ic { font-size: 2.6rem; line-height: 1; opacity: .75; }

  /* The line under every slot: a caption on steps 01 and 03, the carousel dots on 02. A fixed
     height so all three cards keep the same rhythm whichever of the two it is. */
  .media-cap {
    display: flex; align-items: center; justify-content: center; gap: 2px;
    min-height: 26px; max-width: 260px; margin: 8px auto 0;
    font-size: .7rem; letter-spacing: .1em; text-transform: uppercase;
    color: var(--text-muted); text-align: center;
  }

  /* Slides sit in a flex track and the whole track slides — no scroll container, so the carousel
     can never contribute horizontal scroll to the page. */
  .track { display: flex; height: 100%; margin: 0; padding: 0; list-style: none;
    transition: transform .45s cubic-bezier(.4, 0, .2, 1); }
  /* The one frame where the track jumps across the seam between a clone and its real slide. */
  .track.snap { transition: none; }
  .slide { flex: 0 0 100%; height: 100%; }
  .arrow {
    position: absolute; top: 50%; transform: translateY(-50%); z-index: 2;
    width: 30px; height: 30px; padding: 0; display: grid; place-items: center;
    border: 1px solid var(--border); border-radius: 50%; cursor: pointer;
    background: color-mix(in srgb, var(--surface) 84%, transparent);
    backdrop-filter: blur(4px);
    color: var(--text);
  }
  .arrow svg { width: 13px; height: 13px; display: block; fill: none; stroke: currentColor;
    stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; }
  .arrow.prev { left: 6px; }
  .arrow.next { right: 6px; }
  .arrow:hover { background: var(--surface); border-color: var(--accent); }
  .arrow:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  /* The visible dot is the ::after; the button around it is a 20px target you can actually hit
     with a thumb. */
  .dot { position: relative; width: 20px; height: 20px; padding: 0; border: 0;
    background: none; cursor: pointer; border-radius: 50%; }
  .dot::after { content: ''; position: absolute; inset: 6px; border-radius: 50%;
    background: var(--border); transition: background .2s ease, transform .2s ease; }
  .dot.on::after { background: var(--accent-fill); transform: scale(1.2); }
  .dot:hover::after { background: var(--accent-dark); }
  .dot:focus-visible { outline: 2px solid var(--accent); outline-offset: -1px; }
  /* Announced, never shown: which style is on screen, for anyone who cannot see the slot. */
  .sr { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden;
    clip-path: inset(50%); white-space: nowrap; border: 0; }
  @media (prefers-reduced-motion: reduce) {
    .track { transition: none; }
    .dot::after { transition: none; }
  }

  /* The clipping window. Keeps the tilt, the card and the shadow it always had; what is new is
     `overflow: hidden`, which is what lets a roll slide out of view instead of overflowing the hero. */
  .strip { transform: rotate(-4deg); background: #0a0a0b; padding: 12px; border-radius: 12px;
    box-shadow: 0 30px 60px rgba(0,0,0,.45); overflow: hidden; }
  /* One roll per slide, full width, sliding horizontally — the same shape as .track above, and the
     same 450ms, so the two carousels on this page move at one speed rather than two. */
  /* The 8px gap is the same one between the frames INSIDE a roll, so the roll sliding in keeps the
     rhythm of the one going out — without it the last frame of one event butts straight against the
     first frame of the next and the strip looks like eight photos, not two rolls of four. The
     translate has to carry the gap too (calc above), or each step drifts 8px out of alignment. */
  .roll-track { display: flex; gap: 8px; margin: 0; padding: 0; list-style: none; transition: transform .45s ease; }
  .roll-track.snap { transition: none; }
  .roll-slide { flex: 0 0 100%; display: flex; align-items: center; gap: 8px; }
  /* Frame adopts the photo's real ratio; the reshape eases (and only the empty gradient is
     visible while it happens — the photo is opacity 0 until it develops, so no squish). */
  .frame { flex: 1; border-radius: 4px; position: relative; overflow: hidden; aspect-ratio: 4 / 5;
    transition: aspect-ratio .35s ease; }
  /* Photos develop in like a fresh shot: start as a blurred, over-exposed latent image and
     settle to a sharp frame. `both` fill-mode holds the 0% state through the stagger delay
     (--d), so each frame stays "undeveloped" until its turn, then locks at 100%. */
  .frame picture { position: absolute; inset: 0; }
  /* `both` holds opacity 0 through the per-frame delay, so this is the same effect the JS class
     produced — it just no longer waits for hydration to start. */
  .frame img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover;
    animation: develop 1.05s ease-out var(--d, 0s) both; }
  @keyframes develop {
    0%   { opacity: 0; filter: blur(13px) saturate(.12) brightness(1.95) contrast(.55); transform: scale(1.09); }
    28%  { opacity: 1; }
    100% { opacity: 1; filter: blur(0) saturate(1) brightness(1) contrast(1); transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .frame img { opacity: 1; animation: none; }
  }
  .stamp { position: absolute; right: 6px; top: 5px; font-size: .55rem; color: #fff; font-family: var(--font-mono); opacity: .9; }
  /* Wraps the tilted strip and its caption so the hero grid still sees a single child.
     NO align-items:center here — that shrinks the strip to fit-content, and its frames are
     `flex: 1` with no intrinsic width, so all four collapse to 0x0 while still loading fine. The
     column stretches; the caption centres itself with text-align instead. */
  .strip-wrap { display: flex; flex-direction: column; }
  /* The margin clears the rotated strip's corners, which reach below its layout box. */
  .roll { text-align: center; margin-top: 22px; font-family: var(--font-mono);
    font-size: 0.72rem; letter-spacing: .06em; color: var(--text-muted); text-transform: uppercase;
    opacity: 0; animation: rollin .6s ease-out 1.1s forwards; }
  @keyframes rollin { to { opacity: 1; } }
  @media (prefers-reduced-motion: reduce) { .roll { animation: none; opacity: 1; } .roll-track { transition: none; } }
  .band { max-width: 1080px; margin: 0 auto; padding: 56px 24px; border-top: 1px solid var(--border); }
  .kicker { font-size: .74rem; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); font-weight: 800; }
  .sec-title { margin: 8px 0 24px; font-size: 1.5rem; }
  .faq { display: grid; gap: 10px; }
  .faq-item { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px; }
  .faq-item summary { cursor: pointer; font-weight: 700; }
  .faq-item p { color: var(--text-muted); margin: 10px 0 0; line-height: 1.5; }
  /* A row of its own rather than trailing the sentence: one link can sit inline, eight cannot. */
  /* Sits under the lead-in line as part of the same answer, so it is indented to the text rather
     than to the disclosure, and set a touch tighter than body copy: nine short lines read as a
     list, not as nine paragraphs. */
  .faq-item .faq-list { margin: 8px 0 0; padding-left: 1.1em; display: grid; gap: 4px; }
  .faq-item .faq-list li { color: var(--text-muted); line-height: 1.45; }
  .faq-item .faq-more { display: flex; flex-wrap: wrap; gap: 8px 16px; margin-top: 10px; }
  .faq-item .faq-more a { color: var(--accent); font-weight: 700; text-decoration: none; white-space: nowrap; }
  .faq-item .faq-more a:hover { text-decoration: underline; }
  h2 { font-size: clamp(1.8rem, 4vw, 2.5rem); font-weight: 800; margin: 12px 0 36px; max-width: 22ch; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
  /* Five cards in a four-wide grid leaves one on a row of its own, and a row sizes itself to its
     own contents — so that last card came out visibly shorter than the four above it, which read
     as a mistake rather than as a fifth thing. `1fr` auto-rows in a content-sized grid resolves
     EVERY row to the tallest row's max-content, so the odd one out matches. Not applied to
     `.steps`, which is one row and deliberately top-aligned (see below). */
  .grid:not(.steps) { grid-auto-rows: 1fr; }
  /* align-items: start so a card carrying an illustration does not stretch its two neighbours to
     match. Grid's default is `stretch`, which turned steps 01 and 03 into tall boxes with their
     text at the top and a void underneath the moment step 02 gained a poster. */
  .grid.steps { grid-template-columns: repeat(3, 1fr); align-items: start; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 22px; }
  .card .ic { font-size: 1.5rem; }
  .card h3 { font-size: 1.05rem; margin: 12px 0 8px; }
  .card p { color: var(--text-muted); font-size: .92rem; }
  .step-n { font-size: .78rem; color: var(--accent); font-family: var(--font-mono); }
  .missions { display: grid; grid-template-columns: 1.05fr .95fr; gap: 40px; align-items: start; }
  .missions p { color: var(--text-muted); font-size: .98rem; line-height: 1.6; margin: 0 0 14px; }
  /* .note is smaller and muted everywhere else on the page; keep it that way inside the grid. */
  .missions p.note { font-size: .82rem; margin: 18px 0 0; }
  .cta-card { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 54px 40px; text-align: center; }
  .cta-card h2 { margin-left: auto; margin-right: auto; }
  .cta-card p { color: var(--text-muted); margin: 14px auto 28px; max-width: 44ch; }
  .modal { position: fixed; inset: 0; background: rgba(0,0,0,.86); z-index: 200; display: flex; align-items: center; justify-content: center; padding: 24px; }
  .modal-card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 28px; max-width: 340px; text-align: center; }
  .modal-card h3 { margin: 0 0 8px; }
  /* This is a blurb, and every other blurb in the product is muted and a size down — .url and
     .or-explore in this very card already are. Left unstyled it inherited full-strength --text,
     which in dark mode is near-white, so the one sentence explaining the QR shouted louder than
     the heading above it. The bottom margin is the other half: the QR was sitting right under
     the text with nothing between them. */
  .modal-card .modal-lead { color: var(--text-muted); font-size: 0.85rem; line-height: 1.5;
    margin: 0 0 20px; }
  .modal-card img { width: 220px; height: 220px; border-radius: 10px; background: #fff; }
  .modal-card .url { font-size: .7rem; color: var(--text-muted); word-break: break-all; margin: 14px 0; font-family: var(--font-mono); }
  .or-explore { font-size: 0.82rem; color: var(--text-muted); margin: 6px 0 8px; }
  .demo-explore { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-bottom: 12px; }
  @media (min-width: 821px) {
    /* Reserve three lines for every step's prose so the three media slots start on the same
       line. Without it the middle step — the only one that needs a third line — pushes its
       poster ~22px below its neighbours and the row looks untidy. A min, so longer copy
       still just grows. */
    .grid.steps .card p:not(.sr) { min-height: 4.5em; }
  }
  @media (max-width: 820px) {
    .hero { grid-template-columns: 1fr; gap: 36px; padding: 48px 24px; }
    /* Stacked hero reads better centred. */
    .hero > div { text-align: center; }
    .hero .lede { margin-left: auto; margin-right: auto; }
    .hero .cta { justify-content: center; }
    .grid, .grid.steps { grid-template-columns: 1fr 1fr; }
    .missions { grid-template-columns: 1fr; gap: 26px; }
  }
  @media (max-width: 520px) { .grid, .grid.steps { grid-template-columns: 1fr; } }
</style>
