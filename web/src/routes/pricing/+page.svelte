<script lang="ts">
  import { onMount } from 'svelte';
  import { getConfig, getMe } from '$lib/api';
  import { page } from '$app/stores';
  import Logo from '$lib/components/Logo.svelte';
  import { appearance, setAppearance } from '$lib/appearance';
  import { guestTiers, addOns, pricingFaqs } from '$lib/pricing';

  let version = '';
  let loggedIn = false;
  onMount(async () => {
    try { version = (await getConfig()).version; } catch { /* offline */ }
    try { loggedIn = !!(await getMe()).user; } catch { /* signed out */ }
  });

  const TITLE = 'Pricing — Snapdini | Free Event Photo App, Pay Per Event';
  const DESC = 'Snapdini pricing: free for up to 10 guests with every feature, then a one-off pass from A$5 per event (up to 400 guests). No subscription. Optional add-ons for shots, length and video. Self-host free.';
  $: origin = $page.url.origin;
  $: canonical = origin + '/pricing';
  $: ldApp = {
    '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'Snapdini',
    applicationCategory: 'MultimediaApplication', operatingSystem: 'Web', url: canonical, description: DESC,
    offers: { '@type': 'Offer', price: '0', priceCurrency: 'AUD', description: 'Free for up to 10 guests; paid events from A$5' },
  };
  $: ldFaq = {
    '@context': 'https://schema.org', '@type': 'FAQPage',
    mainEntity: pricingFaqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  };
</script>

<svelte:head>
  <title>{TITLE}</title>
  <meta name="description" content={DESC} />
  <link rel="canonical" href={canonical} />
  <meta name="robots" content="index, follow" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Snapdini" />
  <meta property="og:title" content={TITLE} />
  <meta property="og:description" content={DESC} />
  <meta property="og:url" content={canonical} />
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
  <div class="eyebrow"><span class="dot"></span> Pricing</div>
  <h1>Free to start. <em>Pay once</em> per event.</h1>
  <p class="lede">Up to 10 guests is free forever, with every feature. Bigger events are a single one-off charge — no subscription, no surprises.</p>
  <p class="promo">🎉 Launch offer: use code <b>LAUNCH20</b> at checkout for <b>20% off</b> any paid event.</p>
</header>

<section class="band">
  <div class="tiers">
    {#each guestTiers as t}
      <div class="tier" class:highlight={t.highlight}>
        {#if t.highlight}<div class="badge">Most popular</div>{/if}
        <div class="tier-guests">{t.guests}</div>
        <div class="tier-price">{t.price}</div>
        <div class="tier-note">{t.note}</div>
        <a class="btn {t.highlight ? 'primary' : 'ghost'}" href={loggedIn ? '/app' : '/signup'}>
          {t.price === 'Free' ? 'Start free' : 'Choose'}
        </a>
      </div>
    {/each}
  </div>
  <p class="fine">Prices in AUD, charged once per event. The exact total is always shown before you pay.</p>
</section>

<section class="band">
  <div class="kicker">Optional add-ons</div>
  <h2>Tailor any event with one-off extras.</h2>
  <div class="addons">
    {#each addOns as a}
      <div class="addon"><div class="ic">{a.ic}</div><div><h3>{a.name}</h3><p>{a.detail}</p></div></div>
    {/each}
  </div>
</section>

<section class="band">
  <div class="kicker">Self-hosting</div>
  <h2>Or run it yourself, free.</h2>
  <p class="selfhost">Snapdini is open source (AGPL-3.0). Self-host the whole app for free from the public Docker images —
    billing only switches on if you add your own Stripe keys.
    <a href="https://github.com/paytah232/snapdini" target="_blank" rel="noopener noreferrer">See it on GitHub →</a></p>
</section>

<section class="band">
  <div class="kicker">Questions</div>
  <h2 class="sec-title">Pricing FAQ</h2>
  <div class="faq">
    {#each pricingFaqs as f}
      <details class="faq-item"><summary>{f.q}</summary><p>{f.a}</p></details>
    {/each}
  </div>
</section>

<section class="band cta-band">
  <div class="cta-card">
    <h2>Start your roll.</h2>
    <p>Create an event free — no card needed — and upgrade only if you need to.</p>
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
  .hero { max-width: 760px; margin: 0 auto; padding: 80px 24px 40px; text-align: center; }
  .eyebrow { display: inline-flex; align-items: center; gap: 8px; font-size: .74rem; letter-spacing: .16em;
    text-transform: uppercase; color: var(--text-muted); font-weight: 700; margin-bottom: 22px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
  h1 { font-size: clamp(2.3rem, 5.5vw, 3.6rem); font-weight: 850; line-height: 1.06; letter-spacing: -.02em; }
  :global(.hero h1 em) { font-style: normal; color: var(--accent); }
  .lede { font-size: 1.12rem; color: var(--text-muted); max-width: 50ch; margin: 22px auto 18px; }
  .promo { font-size: .92rem; background: var(--surface); border: 1px solid var(--border); border-radius: 999px;
    display: inline-block; padding: 8px 18px; color: var(--text); }
  .band { max-width: 1080px; margin: 0 auto; padding: 40px 24px; }
  .band:not(.cta-band) + .band, .band.cta-band { border-top: 1px solid var(--border); }
  .tiers { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; }
  .tier { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 22px 16px; text-align: center;
    display: flex; flex-direction: column; gap: 8px; position: relative; }
  .tier.highlight { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .badge { position: absolute; top: -10px; left: 50%; transform: translateX(-50%); background: var(--accent); color: var(--accent-ink,#111);
    font-size: .64rem; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; padding: 3px 10px; border-radius: 999px; white-space: nowrap; }
  .tier-guests { font-size: .9rem; font-weight: 700; }
  .tier-price { font-size: 1.8rem; font-weight: 850; color: var(--accent); }
  .tier-note { font-size: .76rem; color: var(--text-muted); min-height: 2.4em; }
  .tier .btn { margin-top: auto; }
  .fine { text-align: center; font-size: .78rem; color: var(--text-muted); margin-top: 16px; }
  .kicker { font-size: .74rem; letter-spacing: .16em; text-transform: uppercase; color: var(--accent); font-weight: 800; }
  h2 { font-size: clamp(1.6rem, 4vw, 2.1rem); font-weight: 800; margin: 10px 0 26px; }
  .sec-title { font-size: 1.5rem; }
  .addons { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  .addon { display: flex; gap: 14px; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 18px; }
  .addon .ic { font-size: 1.4rem; }
  .addon h3 { font-size: 1rem; margin: 0 0 4px; }
  .addon p { color: var(--text-muted); font-size: .9rem; margin: 0; }
  .selfhost { color: var(--text-muted); max-width: 60ch; line-height: 1.6; }
  .selfhost a { color: var(--accent); text-decoration: none; font-weight: 600; }
  .faq { display: grid; gap: 10px; }
  .faq-item { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 14px 18px; }
  .faq-item summary { cursor: pointer; font-weight: 700; }
  .faq-item p { color: var(--text-muted); margin: 10px 0 0; line-height: 1.5; }
  .cta-card { background: var(--surface); border: 1px solid var(--border); border-radius: 20px; padding: 48px 40px; text-align: center; }
  .cta-card p { color: var(--text-muted); margin: 14px auto 26px; max-width: 44ch; }
  footer { border-top: 1px solid var(--border); max-width: 1080px; margin: 40px auto 0; padding: 30px 24px;
    display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
  .fl { display: flex; gap: 18px; font-size: .85rem; color: var(--text-muted); align-items: center; }
  .fl a { color: var(--text-muted); text-decoration: none; }
  .v { font-size: .72rem; color: var(--text-muted); font-family: var(--font-mono); }
  @media (max-width: 860px) { .tiers { grid-template-columns: 1fr 1fr; } .addons { grid-template-columns: 1fr; } }
  @media (max-width: 520px) { .tiers { grid-template-columns: 1fr; } }
</style>
