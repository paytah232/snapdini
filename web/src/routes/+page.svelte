<script lang="ts">
  import { onMount } from 'svelte';
  import { getConfig, postJson, api, getMe } from '$lib/api';
  import { showToast } from '$lib/toast';
  import { modalFocus } from '$lib/ui';
  import { page } from '$app/stores';
  import Logo from '$lib/components/Logo.svelte';
  import { appearance, setAppearance } from '$lib/appearance';

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
  let frameRatio = ['4 / 5', '4 / 5', '4 / 5', '4 / 5'];
  let developed = [false, false, false, false];
  function develop(node: HTMLImageElement, i: number) {
    const show = () => {
      if (!node.naturalWidth || !node.naturalHeight) return;
      frameRatio[i] = `${node.naturalWidth} / ${node.naturalHeight}`;  // reshape (photo still opacity 0)
      frameRatio = frameRatio;
      developed[i] = true;                                              // then develop it in
      developed = developed;
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
    { ic: '🪄', t: 'The grand reveal', d: 'Photos stay up the magician’s sleeve all night, then reappear together the moment your event ends.' },
    { ic: '🔗', t: 'Join in one tap', d: 'Scan a QR or punch in a short code. No app to install — poof, they’re in.' },
    { ic: '🎩', t: 'One shared gallery', d: 'Every guest’s shots land in one gallery to relive and download together.' }
  ];
  const steps = [
    { n: '01 / CONJURE', t: 'Set the stage', d: 'Name it, choose how many shots each guest gets, and when the photos reappear.' },
    { n: '02 / SHARE', t: 'Hand out the code', d: 'Drop the QR on the tables or share the link. Guests join in a tap.' },
    { n: '03 / REVEAL', t: 'Make them reappear', d: 'Everyone shoots through the night — then the whole gallery reappears at once.' }
  ];

  // ── SEO ──
  const TITLE = 'Snapdini — Disposable Camera App for Events & Weddings | QR Photo Sharing';
  const DESC = 'Snapdini is a digital disposable camera for events. Guests scan a QR code to snap a limited roll — no app to install — and the whole gallery reappears when your event ends. Free for up to 10 guests.';
  const faqs = [
    { q: 'What is Snapdini?', a: 'Snapdini is a digital disposable camera for weddings, parties and events. Guests scan a QR code to open a camera with a limited roll of shots, and every photo lands in one shared gallery that reappears when the event ends.' },
    { q: 'Do guests need to download an app?', a: 'No. Guests scan a QR code or open a link and the camera opens right in their browser — nothing to install.' },
    { q: 'How much does Snapdini cost?', a: 'It is free for events of up to 10 guests with every feature included. Larger events are a one-off pass starting at A$5, with optional add-ons for extra shots, frame sizes and video clips.' },
    { q: 'When do the photos appear?', a: 'You choose: photos can reappear all at once the moment your event ends (the classic disposable-camera reveal), or show up instantly as they are taken.' },
    { q: 'Can I use it for a wedding?', a: 'Yes — Snapdini is ideal for weddings, birthdays, parties and corporate events. Print the QR poster for the tables and guests join in a tap.' },
    { q: 'Can everyone download the photos?', a: 'Yes. All shots collect in one shared gallery you can browse and download together, including a full zip of the event.' },
  ];
  $: origin = $page.url.origin;
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

<svelte:head>
  <title>{TITLE}</title>
  <meta name="description" content={DESC} />
  <link rel="canonical" href={origin + '/'} />
  <meta name="robots" content="index, follow" />
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
        <img src="/sample/{i + 1}.jpg" alt="" loading="eager"
             class:developed={developed[i]} style="--d:{(i * 0.22).toFixed(2)}s"
             use:develop={i} on:error={(e) => e.currentTarget.remove()} />
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
  <div class="kicker">How it works</div>
  <h2>Set up the whole trick in about a minute.</h2>
  <div class="grid steps">
    {#each steps as s}
      <div class="card"><div class="step-n">{s.n}</div><h3>{s.t}</h3><p>{s.d}</p></div>
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

<footer>
  <a class="brand" href={loggedIn ? '/dashboard' : '/'}><Logo /></a>
  <div class="fl">
    {#if loggedIn}<a href="/dashboard">My events</a>{:else}<a href="/login">Sign in</a>{/if}
    <a href="/signup">Start free</a>
    <a href="/contact">Contact</a>
    <a href="/terms">Terms</a>
    <a href="/privacy">Privacy</a>
    <a href="https://github.com/paytah232/snapdini" target="_blank" rel="noopener noreferrer">GitHub</a>
    <a href="https://buymeacoffee.com/paytah232" target="_blank" rel="noopener noreferrer">☕ Buy me a coffee</a>
    <button class="linklike" on:click={startDemo}>See the demo</button>
  </div>
  <span class="v">© 2026 Snapdini{version ? ` · v${version}` : ''}</span>
</footer>

<svelte:window on:keydown={(e) => { if (e.key === 'Escape' && qr) qr = null; }} />

{#if qr}
  <!-- svelte-ignore a11y-click-events-have-key-events a11y-no-noninteractive-element-interactions -->
  <div class="modal" on:click|self={() => (qr = null)} role="dialog" aria-modal="true" aria-label="Demo QR code">
    <div class="modal-card" tabindex="-1" use:modalFocus>
      <h3>Try it on your phone</h3>
      <p>The camera works best on mobile — scan to open the live demo.</p>
      <img src={qr.src} alt="Demo QR code" />
      <p class="url">{qr.url}</p>
      {#if demoLinks}
        <p class="or-explore">…or explore it here:</p>
        <div class="demo-explore">
          <a class="btn ghost sm" href={demoLinks.camera}>📷 Camera</a>
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
  .strip { display: flex; align-items: center; gap: 8px; transform: rotate(-4deg); background: #0a0a0b; padding: 12px; border-radius: 12px;
    box-shadow: 0 30px 60px rgba(0,0,0,.45); }
  /* Frame adopts the photo's real ratio; the reshape eases (and only the empty gradient is
     visible while it happens — the photo is opacity 0 until it develops, so no squish). */
  .frame { flex: 1; border-radius: 4px; position: relative; overflow: hidden; aspect-ratio: 4 / 5;
    transition: aspect-ratio .35s ease; }
  /* Photos develop in like a fresh shot: start as a blurred, over-exposed latent image and
     settle to a sharp frame. `both` fill-mode holds the 0% state through the stagger delay
     (--d), so each frame stays "undeveloped" until its turn, then locks at 100%. */
  .frame img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; }
  .frame img.developed { animation: develop 1.05s ease-out var(--d, 0s) both; }
  @keyframes develop {
    0%   { opacity: 0; filter: blur(13px) saturate(.12) brightness(1.95) contrast(.55); transform: scale(1.09); }
    28%  { opacity: 1; }
    100% { opacity: 1; filter: blur(0) saturate(1) brightness(1) contrast(1); transform: scale(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .frame img { opacity: 1; }
    .frame img.developed { animation: none; }
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
  .grid.steps { grid-template-columns: repeat(3, 1fr); }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 22px; }
  .card .ic { font-size: 1.5rem; }
  .card h3 { font-size: 1.05rem; margin: 12px 0 8px; }
  .card p { color: var(--text-muted); font-size: .92rem; }
  .step-n { font-size: .78rem; color: var(--accent); font-family: var(--font-mono); }
  .cta-card { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 54px 40px; text-align: center; }
  .cta-card h2 { margin-left: auto; margin-right: auto; }
  .cta-card p { color: var(--text-muted); margin: 14px auto 28px; max-width: 44ch; }
  footer { border-top: 1px solid var(--border); max-width: 1080px; margin: 40px auto 0; padding: 30px 24px;
    display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
  .fl { display: flex; gap: 18px; font-size: .85rem; color: var(--text-muted); align-items: center; }
  .fl a, .linklike { color: var(--text-muted); text-decoration: none; background: none; border: none; cursor: pointer; font: inherit; }
  .v { font-size: .72rem; color: var(--text-muted); font-family: var(--font-mono); }
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
  }
  @media (max-width: 520px) { .grid, .grid.steps { grid-template-columns: 1fr; } }
</style>
