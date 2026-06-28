<script lang="ts">
  import { onMount } from 'svelte';
  import { getConfig, getMe } from '$lib/api';
  import { page } from '$app/stores';
  import Logo from '$lib/components/Logo.svelte';
  import { appearance, setAppearance } from '$lib/appearance';
  import { usecases, type UseCase } from '$lib/usecases';

  export let content: UseCase;

  let version = '';
  let loggedIn = false;

  onMount(async () => {
    try { version = (await getConfig()).version; } catch { /* offline */ }
    try { loggedIn = !!(await getMe()).user; } catch { /* signed out */ }
  });

  const steps = [
    { n: '01 / CREATE', t: 'Set the stage', d: 'Name your event, choose how many shots each guest gets, and when the photos appear.' },
    { n: '02 / SHARE', t: 'Hand out the code', d: 'Print the QR poster or share the link — guests join in a single tap, no app.' },
    { n: '03 / REVEAL', t: 'Gather the gallery', d: 'Everyone shoots through the event, then the whole gallery comes together to relive and download.' },
  ];

  // Internal cross-links to the other use-case pages (good for SEO + discovery).
  $: others = Object.values(usecases).filter((u) => u.slug !== content.slug);

  $: origin = $page.url.origin;
  $: canonical = `${origin}/${content.slug}`;
  $: fullTitle = `${content.title} | Snapdini`;
  $: ldApp = {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Snapdini',
    applicationCategory: 'MultimediaApplication', operatingSystem: 'Web', url: canonical,
    description: content.desc,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'AUD', description: 'Free for up to 10 guests' },
  };
  $: ldFaq = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: content.faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  };
  $: ldCrumbs = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${origin}/` },
      { '@type': 'ListItem', position: 2, name: content.eyebrow, item: canonical },
    ],
  };
</script>

<svelte:head>
  <title>{fullTitle}</title>
  <meta name="description" content={content.desc} />
  <link rel="canonical" href={canonical} />
  <meta name="robots" content="index, follow" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Snapdini" />
  <meta property="og:title" content={fullTitle} />
  <meta property="og:description" content={content.desc} />
  <meta property="og:url" content={canonical} />
  <meta property="og:image" content={origin + '/og.png'} />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content={fullTitle} />
  <meta name="twitter:description" content={content.desc} />
  <meta name="twitter:image" content={origin + '/og.png'} />
  {@html `<script type="application/ld+json">${JSON.stringify(ldApp)}</` + `script>`}
  {@html `<script type="application/ld+json">${JSON.stringify(ldFaq)}</` + `script>`}
  {@html `<script type="application/ld+json">${JSON.stringify(ldCrumbs)}</` + `script>`}
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
  <div class="eyebrow"><span class="dot"></span> {content.eyebrow}</div>
  <h1>{@html content.h1}</h1>
  <p class="lede">{content.lede}</p>
  <div class="cta">
    <a class="btn primary" href={loggedIn ? '/app' : '/signup'}>Create your event</a>
    <a class="btn ghost" href="/">See how it works →</a>
  </div>
  <p class="note">No app to install. <b>Free</b> for up to 10 guests.</p>
</header>

<section class="band">
  <div class="kicker">Why it works</div>
  <h2>{content.eyebrow}, captured by everyone who was there.</h2>
  <div class="grid">
    {#each content.features as f}
      <div class="card"><div class="ic">{f.ic}</div><h3>{f.t}</h3><p>{f.d}</p></div>
    {/each}
  </div>
</section>

<section class="band">
  <div class="kicker">How it works</div>
  <h2>Set it up in about a minute.</h2>
  <div class="grid steps">
    {#each steps as s}
      <div class="card"><div class="step-n">{s.n}</div><h3>{s.t}</h3><p>{s.d}</p></div>
    {/each}
  </div>
</section>

<section class="band">
  <div class="kicker">Questions</div>
  <h2 class="sec-title">{content.eyebrow} — common questions</h2>
  <div class="faq">
    {#each content.faqs as f}
      <details class="faq-item">
        <summary>{f.q}</summary>
        <p>{f.a}</p>
      </details>
    {/each}
  </div>
</section>

<section class="band cta-band">
  <div class="cta-card">
    <h2>{content.ctaTitle}</h2>
    <p>{content.ctaText}</p>
    <a class="btn primary" href={loggedIn ? '/app' : '/signup'}>Create your event →</a>
  </div>
</section>

<section class="band also">
  <div class="kicker">Also great for</div>
  <div class="also-links">
    {#each others as u}
      <a class="also-link" href={'/' + u.slug}>{u.eyebrow.replace(/^For /, '')} →</a>
    {/each}
  </div>
</section>

<footer>
  <a class="brand" href={loggedIn ? '/dashboard' : '/'}><Logo /></a>
  <div class="fl">
    {#if loggedIn}<a href="/dashboard">My events</a>{:else}<a href="/login">Sign in</a>{/if}
    <a href="/signup">Start free</a>
    <a href="/pricing">Pricing</a>
    <a href="/contact">Contact</a>
    <a href="/terms">Terms</a>
    <a href="/privacy">Privacy</a>
    <a href="https://github.com/paytah232/snapdini" target="_blank" rel="noopener noreferrer">GitHub</a>
  </div>
  <span class="v">© 2026 Snapdini{version ? ` · v${version}` : ''}</span>
</footer>

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
  .nav-links .btn { padding: 7px 14px; font-size: .82rem; }
  .primary { background: var(--accent); color: var(--accent-ink, #111); }
  .ghost { border-color: var(--border); color: var(--text); background: transparent; }
  .ghost:hover { border-color: var(--accent); }
  .hero { max-width: 760px; margin: 0 auto; padding: 84px 24px 56px; text-align: center; }
  .eyebrow { display: inline-flex; align-items: center; gap: 8px; font-size: .74rem; letter-spacing: .16em;
    text-transform: uppercase; color: var(--text-muted); font-weight: 700; margin-bottom: 22px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
  h1 { font-size: clamp(2.3rem, 5.5vw, 3.8rem); font-weight: 850; line-height: 1.06; letter-spacing: -.02em; }
  :global(.hero h1 em) { font-style: normal; color: var(--accent); }
  .lede { font-size: 1.12rem; color: var(--text-muted); max-width: 52ch; margin: 22px auto 30px; }
  .cta { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
  .note { margin-top: 18px; font-size: .82rem; color: var(--text-muted); }
  .band { max-width: 1080px; margin: 0 auto; padding: 56px 24px; border-top: 1px solid var(--border); }
  .kicker { font-size: .74rem; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); font-weight: 800; }
  .sec-title { margin: 8px 0 24px; font-size: 1.5rem; }
  .faq { display: grid; gap: 10px; }
  .faq-item { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px; }
  .faq-item summary { cursor: pointer; font-weight: 700; }
  .faq-item p { color: var(--text-muted); margin: 10px 0 0; line-height: 1.5; }
  h2 { font-size: clamp(1.7rem, 4vw, 2.3rem); font-weight: 800; margin: 12px 0 32px; max-width: 26ch; }
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
  .also-links { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 14px; }
  .also-link { background: var(--surface); border: 1px solid var(--border); border-radius: 999px; padding: 8px 16px;
    font-size: .88rem; font-weight: 600; text-decoration: none; color: var(--text); }
  .also-link:hover { border-color: var(--accent); }
  footer { border-top: 1px solid var(--border); max-width: 1080px; margin: 40px auto 0; padding: 30px 24px;
    display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
  .fl { display: flex; gap: 18px; font-size: .85rem; color: var(--text-muted); align-items: center; }
  .fl a { color: var(--text-muted); text-decoration: none; }
  .v { font-size: .72rem; color: var(--text-muted); font-family: var(--font-mono); }
  @media (max-width: 820px) {
    .grid, .grid.steps { grid-template-columns: 1fr 1fr; }
  }
  @media (max-width: 520px) { .grid, .grid.steps { grid-template-columns: 1fr; } }
</style>
