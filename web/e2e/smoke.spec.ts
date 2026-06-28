import { test, expect } from '@playwright/test';

// Core smoke coverage for the public routes: SSR shell, client hydration, and that
// the SvelteKit app can reach the Express API through nginx. The gallery/join assertions
// need a real event — we seed a throwaway demo event at startup (override with
// E2E_EVENT_CODE to point at a specific one).
let EVENT = process.env.E2E_EVENT_CODE || '';
test.beforeAll(async ({ request }) => {
  if (EVENT) return;
  const res = await request.post('/api/events/demo');
  EVENT = (await res.json()).joinCode;
});

test('landing page renders the hero', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle(/Snapdini/i);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('signup page shows the email form', async ({ page }) => {
  await page.goto('/signup');
  await expect(page.locator('input[type="email"]')).toBeVisible();
});

test('login page shows the email form', async ({ page }) => {
  await page.goto('/login');
  await expect(page.locator('input[type="email"]')).toBeVisible();
});

test('shared gallery link renders an event heading (SSR + API)', async ({ page }) => {
  await page.goto(`/gallery/${EVENT}`);
  const h1 = page.getByRole('heading', { level: 1 });
  await expect(h1).toBeVisible();
  await expect(h1).not.toBeEmpty();
});

test('shared gallery link emits Open Graph tags for previews', async ({ request }) => {
  const res = await request.get(`/gallery/${EVENT}`);
  const html = await res.text();
  expect(html).toContain('property="og:title"');
  expect(html).toContain('property="og:description"');
});

test('invite link shows the join screen', async ({ page }) => {
  await page.goto(`/join/${EVENT}`);
  await expect(page.getByRole('button', { name: /join/i })).toBeVisible();
});
