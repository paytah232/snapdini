import { test, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';

// The sign-up → verification journey, which has three properties that only show up end to end:
//
//  1. once the account exists there is nothing left to type, so the card must stop being a form;
//  2. the address is usually proven on a DIFFERENT DEVICE, and the browser that filled in the
//     event has to find that out and carry on with the draft it is holding;
//  3. nothing may consume the draft on read, or two tabs race for it and one shows a blank form.
//
// These need a real registration (Turnstile test keys auto-pass in dev) and the dev verification
// link, so they are skipped when the stack has no devLink to hand out.
const PASSWORD = 'Str0ngPass!23';
const uniqueEmail = () => `e2e_${Date.now()}_${Math.random().toString(36).slice(2, 6)}@example.com`;

async function fillEventThenSignUp(page: Page, eventName: string) {
  await page.goto('/app', { waitUntil: 'domcontentloaded' });
  await page.locator('#event-name').waitFor({ timeout: 15_000 });
  await page.locator('#event-name').fill(eventName);

  /* THROUGH THE "SHOW ME EVERYTHING" DOOR, not the wizard.
   *
   * /app became a step-by-step wizard and these four tests were never updated, so they had been
   * failing on every engine for some time — quietly, because the e2e suite is not what `npm test`
   * runs. What they were reaching for is now seven steps away: naming the event leaves you on step
   * one with a "Next →", and the account CTA only appears at the end.
   *
   * The wizard's own escape hatch is one click and, more to the point, is a STABLE thing to aim
   * at: a test that walks seven steps has to be rewritten every time a step is added, reordered or
   * made conditional, which is exactly how this spec rotted in the first place. What it is really
   * about — sign up, verify elsewhere, come back to your draft — does not care how the form was
   * laid out on the way in.
   *
   * The `.catch(() => {})` that used to sit on the guest selector is gone with it. It was there to
   * be tolerant and what it actually did was hide the evidence: #max-guests had stopped existing
   * at this point in the flow, the selector silently did nothing, and the failure surfaced three
   * lines later as a timeout on a button, which is the hardest possible place to read it from. */
  await page.locator('button', { hasText: /Show me everything at once/i }).first().click();
  await page.locator('#max-guests').waitFor({ timeout: 10_000 });
  await page.locator('#max-guests').selectOption('150');
  await page.locator('button', { hasText: /Create my account/i }).first().click();
  await expect(page).toHaveURL(/\/signup\?next=/);
  await page.locator('#name').fill('E2E Tester');
  await page.locator('#email').fill(uniqueEmail());
  await page.locator('#password').fill(PASSWORD);
  // Turnstile needs a moment to hand back a token before the form will post.
  await page.waitForTimeout(4500);
  await page.locator('button[type=submit]').first().click();
}

async function verifyLink(page: Page): Promise<string | null> {
  const link = page.locator('a', { hasText: /Dev: click to verify/i }).first();
  if (!(await link.count())) return null;
  const href = await link.getAttribute('href');
  return href ? href.replace(/^https?:\/\/[^/]+/, '') : null;
}

test('the card stops being a form once the account exists', async ({ page }) => {
  await fillEventThenSignUp(page, 'E2E Card ' + Date.now());
  await expect(page.getByText(/Check your email/i)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/Waiting for you to confirm/i)).toBeVisible();
  // The whole point: nothing left to fill in, so no invitation to submit again.
  await expect(page.locator('#password')).toHaveCount(0);
  await expect(page.locator('button[type=submit]')).toHaveCount(0);
  await expect(page.locator('iframe[src*="challenges.cloudflare"]')).toHaveCount(0);
  // And a way out if the mail never lands.
  await expect(page.getByText(/Resend the email/i)).toBeVisible();
});

test('verifying on another device carries the event back to the first one', async ({ browser }) => {
  // Separate contexts = separate cookies AND separate storage. A real second device.
  const laptop: BrowserContext = await browser.newContext();
  const phone: BrowserContext = await browser.newContext();
  try {
    const A = await laptop.newPage();
    const NAME = 'E2E Cross ' + Date.now();
    await fillEventThenSignUp(A, NAME);
    await expect(A.getByText(/Check your email/i)).toBeVisible({ timeout: 15_000 });
    const link = await verifyLink(A);
    test.skip(!link, 'no dev verification link (SMTP is enabled on this stack)');

    const P = await phone.newPage();
    // The phone holds no draft of its own — the event lives only on the laptop.
    await P.goto('/', { waitUntil: 'domcontentloaded' });
    expect(await P.evaluate(() => localStorage.getItem('snapdini-event-draft'))).toBeNull();
    await P.goto(link!, { waitUntil: 'domcontentloaded' });
    await expect(P).toHaveURL(/\/dashboard/, { timeout: 20_000 });

    // The laptop must notice by itself and pick the event back up.
    await A.waitForFunction(() => location.pathname === '/app', null, { timeout: 25_000 });
    await expect(A.locator('#event-name')).toHaveValue(NAME);
    /* The guest count is on a later step of the wizard, so it has to be revealed before it can be
     * read — coming back to /app puts the laptop at step one, holding the draft but not showing
     * all of it. Asserted anyway, and not dropped: "the draft came back" is the whole point of
     * this test, and a draft that restored only the field that happens to be on screen would
     * satisfy a check on the name alone while having lost everything behind it. */
    await A.locator('button', { hasText: /Show me everything at once/i }).first().click();
    await expect(A.locator('#max-guests')).toHaveValue('150');
  } finally {
    await laptop.close();
    await phone.close();
  }
});

test('the draft is not consumed on read, so tabs cannot starve each other', async ({ browser }) => {
  const ctx: BrowserContext = await browser.newContext();
  try {
    const A = await ctx.newPage();
    const NAME = 'E2E Race ' + Date.now();
    await fillEventThenSignUp(A, NAME);
    await expect(A.getByText(/Check your email/i)).toBeVisible({ timeout: 15_000 });
    const link = await verifyLink(A);
    test.skip(!link, 'no dev verification link (SMTP is enabled on this stack)');

    // Verify with a bare request so NO tab claims the draft — this deterministically makes the
    // polling tab the first to arrive, which is the case that used to eat the draft.
    await ctx.request.get(link!, { maxRedirects: 0 }).catch(() => {});
    await A.waitForFunction(() => location.pathname === '/app', null, { timeout: 25_000 });
    await expect(A.locator('#event-name')).toHaveValue(NAME);

    // A second and third tab must get the same event, not an empty form.
    for (const _ of [1, 2]) {
      const T = await ctx.newPage();
      await T.goto('/app', { waitUntil: 'domcontentloaded' });
      await expect(T.locator('#event-name')).toHaveValue(NAME, { timeout: 15_000 });
      await T.close();
    }
  } finally {
    await ctx.close();
  }
});

test('a hidden tab stops polling, and wakes the instant it is looked at', async ({ browser }) => {
  const ctx: BrowserContext = await browser.newContext();
  let polls = 0;
  /* COUNTED BY WATCHING, not by intercepting.
   *
   * This used ctx.route() purely as a tally — the handler did nothing but increment and continue.
   * Interception is the wrong instrument for counting, and WebKit proves it: measured directly,
   * four fetches to this URL were seen by ctx.route() twice and by ctx.on('request') four times,
   * while Chromium saw four both ways. So the test reported zero polls on Safari and failed an
   * assertion about the PRODUCT on the strength of a gap in the harness.
   *
   * Verified separately that the polling itself is fine in WebKit — three requests in twelve
   * seconds, the same as Chromium. Nothing was wrong except how they were being counted.
   *
   * ctx.on('request') is passive, sees every request in the context, and needs no continue(). */
  ctx.on('request', (r) => { if (/\/api\/auth\/pending/.test(r.url())) polls++; });
  try {
    const A = await ctx.newPage();
    const NAME = 'E2E Wake ' + Date.now();
    await fillEventThenSignUp(A, NAME);
    await expect(A.getByText(/Waiting for you to confirm/i)).toBeVisible({ timeout: 15_000 });
    const link = await verifyLink(A);
    test.skip(!link, 'no dev verification link (SMTP is enabled on this stack)');

    const setVis = (v: string) => A.evaluate((vv) => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => vv });
      document.dispatchEvent(new Event('visibilitychange'));   // fired AT document, per spec
    }, v);

    await A.waitForTimeout(7000);
    expect(polls).toBeGreaterThan(0);                 // polling while someone is watching

    await setVis('hidden');
    /* Wait for QUIESCENCE, not a fixed 1.2 seconds.
     *
     * The claim being made is "no polls happen while nobody is watching", and it is sampled by
     * reading a counter. A request already in flight when the tab was hidden lands AFTER it and is
     * counted — so the sample point has to be after the last of those, not after an arbitrary
     * pause. 1.2s was enough when one browser ran this file and not when three do: the test passed
     * alone and failed in the full run, on every engine, which is the signature of the harness
     * racing rather than the product misbehaving.
     *
     * Polling until the number stops moving is not load-sensitive at all, which is the point. */
    let atHide = polls;
    for (let quiet = 0; quiet < 3; ) {
      await A.waitForTimeout(500);
      if (polls === atHide) quiet++; else { atHide = polls; quiet = 0; }
    }
    await A.waitForTimeout(9000);                     // three intervals
    expect(polls).toBe(atHide);                       // …and none while nobody is

    await ctx.request.get(link!, { maxRedirects: 0 }).catch(() => {});
    await A.waitForTimeout(3000);
    expect(new URL(A.url()).pathname).toBe('/signup');   // hidden ⇒ hasn't noticed

    const t0 = Date.now();
    await setVis('visible');
    await A.waitForFunction(() => location.pathname !== '/signup', null, { timeout: 15_000 });
    // Well inside the 3s interval: it checked on being looked at, not on a timer.
    expect(Date.now() - t0).toBeLessThan(1500);
    await expect(A.locator('#event-name')).toHaveValue(NAME);
  } finally {
    await ctx.close();
  }
});
