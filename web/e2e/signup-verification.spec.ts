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
  await page.locator('#max-guests').selectOption('150').catch(() => {});
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
  await ctx.route('**/api/auth/pending*', (r) => { polls++; r.continue(); });
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
    await A.waitForTimeout(1200);
    const atHide = polls;
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
