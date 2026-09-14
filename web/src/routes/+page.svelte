<script lang="ts">
  import { onMount } from 'svelte';
  import { getConfig, postJson, api, getMe } from '$lib/api';
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

  const isMobile = () =>
    typeof navigator !== 'undefined' &&
    (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
      (navigator.maxTouchPoints > 1 && Math.min(innerWidth, innerHeight) < 820));

  onMount(async () => {
    // A guest arriving from someone's gallery: tell the server so it can set the attribution
    // cookie. Guests never sign up, so this link is the only way to connect "was a guest" to
    // "later ran their own event".
    const ref = $page.url.searchParams.get('ref');
    if (ref) claimReferral(ref);
    try { version = (await getConfig()).version; } catch { /* offline */ }
    try { loggedIn = !!(await getMe()).user; } catch { /* not signed in */ }
  });

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
        location.href = '/join/' + joinCode;
      } else {
        const q = await api<{ qrCode: string; joinUrl: string }>('/api/events/' + joinCode + '/qr');
        qr = { src: q.qrCode, url: q.joinUrl };
        demoLinks = {
          camera: '/join/' + joinCode,
          host: '/admin/' + joinCode + '#' + encodeURIComponent(organizerCode),
          gallery: '/gallery/' + joinCode,
        };
      }
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not start the demo', true);
    } finally {
      demoBusy = false;
    }
  }

  const features = [
    { ic: '🎞️', t: 'A limited roll', d: 'Each guest gets a set number of shots. No do-overs, no endless scrolling — every frame counts.' },
    { ic: '🪄', t: 'The grand reveal', d: 'Photos stay up the magician’s sleeve all night, then reappear together the moment your event ends — as one gallery, and as a film you can play at the next one.' },
    { ic: '🔗', t: 'Join in one tap', d: 'Scan a QR or punch in a short code. No app to install — poof, they’re in.' },
    { ic: '🎩', t: 'One shared gallery', d: 'Every guest’s shots land in one gallery to relive and download together.' },
      // Sits here rather than in the hero: the lede already explains the whole product in eight
      // words, and a hero that explains two things explains neither. This is still the first
      // screenful on most viewports.
      { ic: '🃏', t: 'A list of tricks', d: 'Hand out a few shots to pull off — printed for the tables, ticked off in the camera. Optional.' }
  ];
  const steps = [
    { n: '01 / CONJURE', t: 'Set the stage', d: 'Name it, choose how many shots each guest gets, and when the photos reappear.' },
    // "Drop the QR on the tables" is the exact moment a host thinks "…on what?" — and we answer
    // that in the product and used to say nothing about it here. Every competitor has QR-join;
    // what we have is the thing that gets the QR onto a table looking like it belongs there.
    // `img` is optional on every step — drop the two lines and the slot disappears cleanly rather
    // than leaving a broken frame. Files live in web/static/marketing/; ship a .webp and a .jpg of
    // the same name and <picture> below picks whichever the browser can take.
    { n: '02 / SHARE', t: 'Put it on the tables', d: 'Design the poster and table cards right here — pick a look, print, done. Or just send the link. Guests join in a tap.',
      img: 'poster-sweetheart', alt: 'A printable table poster: the couple’s names, a QR code with the Snapdini mark in it, and the join link' },
    { n: '03 / REVEAL', t: 'Make them reappear', d: 'Everyone shoots through the night — then the whole gallery reappears at once.' }
  ];

  // ── SEO ──
  const TITLE = 'Snapdini — Disposable Camera App for Events & Weddings | QR Photo Sharing';
  const DESC = 'Snapdini is a digital disposable camera for events. Guests scan a QR code to snap a limited roll — no app to install — and the whole gallery reappears when your event ends, as a gallery and as a slideshow film. Design printable posters and table cards in the app. Free for up to 10 guests.';
  const faqs = [
    { q: 'What is Snapdini?', a: 'Snapdini is a digital disposable camera for weddings, parties and events. Guests scan a QR code to open a camera with a limited roll of shots, and every photo lands in one shared gallery that reappears when the event ends.' },
    { q: 'Do guests need to download an app?', a: 'No. Guests scan a QR code or open a link and the camera opens right in their browser — nothing to install.' },
    { q: 'How much does Snapdini cost?', a: 'It is free for events of up to 10 guests with every feature included — including the printable posters and table cards, and the slideshow film of the gallery. Larger events are a one-off pass starting at A$5, with optional add-ons for extra shots, frame sizes and video clips.' },
    { q: 'When do the photos appear?', a: 'You choose: photos can reappear all at once the moment your event ends (the classic disposable-camera reveal), or show up instantly as they are taken.' },
    { q: 'Can I use it for a wedding?', a: 'Yes — Snapdini is ideal for weddings, birthdays, parties and corporate events. Print the QR poster for the tables and guests join in a tap.' },
    { q: 'Can everyone download the photos?', a: 'Yes. All shots collect in one shared gallery you can browse and download together, including a full zip of the event.' },
  ];
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
    mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
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

<nav>
  <a class="brand" href="/"><Logo /></a>
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
</nav>

<main>
<header class="hero">
  <div>
    <div class="eyebrow"><span class="dot"></span> The disappearing event camera</div>
    <h1>Now you see them.<br><em>Now you don't.</em></h1>
    <p class="lede">Guests scan a code and shoot a limited roll. Every photo vanishes the second it's taken — then the whole gallery reappears at once when your event ends. A disposable camera with a disappearing act.</p>
    <div class="cta">
      <a class="btn primary" href={loggedIn ? '/app' : '/signup'}>Create your event</a>
      <button class="btn ghost" on:click={startDemo} disabled={demoBusy}>
        {demoBusy ? 'Starting…' : 'See what it looks like →'}
      </button>
    </div>
    <p class="note">No app to install. <b>Free</b> to start.</p>
  </div>
  <div class="strip" aria-hidden="true">
    {#each ['#3a2a4d,#c8607a', '#1d3b4d,#46b3c9', '#4d3b1d,#e8994a', '#2a4d33,#7ad08a'] as g, i}
      <div class="frame" style="background:linear-gradient(135deg,{g}); aspect-ratio:{frameRatio[i]}">
        <!-- Drop real event photos at static/sample/1.jpg…4.jpg. They develop in (see CSS);
             until then they fail quietly and the gradient "latent image" shows. -->
        <!-- Displayed at ~99px wide, so 220w covers 2x and 330w covers 3x. The originals were
             472px and cost 180KB for four thumbnails; these cost about 32KB. -->
        <picture>
          <source type="image/webp"
                  srcset="/sample/{i + 1}-220.webp 220w, /sample/{i + 1}-330.webp 330w" sizes="100px" />
          <img src="/sample/{i + 1}-220.jpg"
               srcset="/sample/{i + 1}-220.jpg 220w, /sample/{i + 1}-330.jpg 330w" sizes="100px"
               alt="" loading="eager" fetchpriority={i === 0 ? 'high' : 'auto'}
               style="--d:{(i * 0.22).toFixed(2)}s"
               use:develop={i} on:error={(e) => e.currentTarget.closest('picture')?.remove()} />
        </picture>
        <span class="stamp">▶ {24 + i}</span>
      </div>
    {/each}
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
      <div class="card" class:has-img={s.img}>
        <div class="step-n">{s.n}</div>
        <h3>{s.t}</h3>
        <p>{s.d}</p>
        {#if s.img}
          <!-- width/height are the real intrinsic size, so the row does not jump when it loads.
               lazy + async: it is below the fold and must never hold up the first paint. -->
          <picture>
            <source srcset="/marketing/{s.img}.webp" type="image/webp" />
            <img class="step-img" src="/marketing/{s.img}.jpg" alt={s.alt}
                 width="620" height="877" loading="lazy" decoding="async" />
          </picture>
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

<svelte:window on:keydown={(e) => { if (e.key === 'Escape' && qr) qr = null; }} />

{#if qr}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="modal" on:click|self={() => (qr = null)} role="dialog" aria-modal="true" aria-label="Demo QR code">
    <div class="modal-card" tabindex="-1" use:modalFocus>
      <h3>Best on your phone</h3>
      <p>It is a camera, so a phone shows it at its best — scan to open the live demo.</p>
      <img src={qr.src} alt="Demo QR code" />
      <p class="url">{qr.url}</p>
      {#if demoLinks}
        <!-- The demo works perfectly well on a laptop with a webcam, and someone reading this on a
             desktop should not have to find a phone to see anything. The QR stays the headline
             because a phone IS better, but carrying on here is offered plainly rather than hidden
             behind a button labelled "Camera" that reads like one of three equal side-trips. -->
        <p class="or-explore">No phone to hand? Carry on right here:</p>
        <div class="demo-explore">
          <a class="btn primary sm" href={demoLinks.camera}>💻 Open the camera here</a>
        </div>
        <div class="demo-explore">
          <a class="btn ghost sm" href={demoLinks.host}>🎛 Host view</a>
          <a class="btn ghost sm" href={demoLinks.gallery}>🖼 Gallery</a>
        </div>
      {/if}
      <button class="btn ghost" on:click={() => (qr = null)}>Close</button>
    </div>
  </div>
{/if}

<style>
  :global(body) { overflow-x: hidden; }
  nav { position: sticky; top: 0; z-index: 50; display: flex; align-items: center; justify-content: space-between;
    height: 62px; padding: 0 24px; backdrop-filter: blur(10px); background: color-mix(in srgb, var(--bg) 78%, transparent);
    border-bottom: 1px solid var(--border); }
  .brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 800; text-decoration: none; }
  .nav-links { display: flex; gap: 8px; align-items: center; }
  .theme-toggle { background: transparent; border: 1px solid var(--border); border-radius: 10px; width: 38px; height: 38px; font-size: 1rem; cursor: pointer; line-height: 1; }
  .theme-toggle:hover { border-color: var(--accent); }
  .btn { display: inline-block; font-weight: 700; border-radius: var(--radius-sm); padding: 10px 18px; font-size: .9rem;
    border: 1px solid transparent; cursor: pointer; text-decoration: none; }
  .nav-links .btn { padding: 7px 14px; font-size: .82rem; border-radius: var(--radius-sm); }
  .primary { background: var(--accent); color: var(--accent-ink, #111); }
  .ghost { border-color: var(--border); color: var(--text); background: transparent; }
  .ghost:hover { border-color: var(--accent); }
  .hero { display: grid; grid-template-columns: 1.05fr .95fr; gap: 48px; align-items: center;
    max-width: 1080px; margin: 0 auto; padding: 84px 24px 64px; }
  .eyebrow { display: inline-flex; align-items: center; gap: 8px; font-size: .74rem; letter-spacing: .16em;
    text-transform: uppercase; color: var(--text-muted); font-weight: 700; margin-bottom: 22px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
  h1 { font-size: clamp(2.5rem, 6vw, 4.3rem); font-weight: 850; line-height: 1.05; letter-spacing: -.02em; }
  h1 em { font-style: normal; color: var(--accent); }
  .lede { font-size: 1.15rem; color: var(--text-muted); max-width: 32ch; margin: 22px 0 30px; }
  .cta { display: flex; gap: 12px; flex-wrap: wrap; }
  .note { margin-top: 18px; font-size: .82rem; color: var(--text-muted); }
  /* The illustration sits UNDER its step's words, not beside them: the three steps are a row on a
     desktop and a column on a phone, and an image that floats left of the text reflows into a
     different reading order at the breakpoint. Capped in height so a tall portrait poster cannot
     make its card twice the height of its neighbours. */
  .step-img {
    display: block;
    width: 100%;
    max-width: 260px;
    height: auto;
    margin: 14px auto 0;
    border-radius: var(--radius-sm, 10px);
    /* Posters are printed on white; on a dark page they need an edge or they float. */
    box-shadow: 0 8px 26px rgba(0, 0, 0, 0.45);
  }

  .strip { display: flex; align-items: center; gap: 8px; transform: rotate(-4deg); background: #0a0a0b; padding: 12px; border-radius: 12px;
    box-shadow: 0 30px 60px rgba(0,0,0,.45); }
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
  .band { max-width: 1080px; margin: 0 auto; padding: 56px 24px; border-top: 1px solid var(--border); }
  .kicker { font-size: .74rem; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); font-weight: 800; }
  .sec-title { margin: 8px 0 24px; font-size: 1.5rem; }
  .faq { display: grid; gap: 10px; }
  .faq-item { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px; }
  .faq-item summary { cursor: pointer; font-weight: 700; }
  .faq-item p { color: var(--text-muted); margin: 10px 0 0; line-height: 1.5; }
  h2 { font-size: clamp(1.8rem, 4vw, 2.5rem); font-weight: 800; margin: 12px 0 36px; max-width: 22ch; }
  .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
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
  .modal-card img { width: 220px; height: 220px; border-radius: 10px; background: #fff; }
  .modal-card .url { font-size: .7rem; color: var(--text-muted); word-break: break-all; margin: 14px 0; font-family: var(--font-mono); }
  .or-explore { font-size: 0.82rem; color: var(--text-muted); margin: 6px 0 8px; }
  .demo-explore { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; margin-bottom: 12px; }
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
