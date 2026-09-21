import { defineConfig, devices } from '@playwright/test';

// E2E runs against a running stack (the dev nginx on :3001 by default).
// Override with E2E_BASE_URL to point at staging/prod.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3001',
    trace: 'on-first-retry'
  },
  /* THREE ENGINES, and the two new ones are here because of what nearly shipped without them.
   *
   * 1.5.2 moved the whole frontend from Svelte 4 to Svelte 5 — every component in the product
   * recompiled by a different compiler — and the only browser this suite had ever run in was
   * Chromium. Snapdini's guests are at weddings, which is about as iPhone-heavy an audience as
   * exists, and nothing in the project had ever executed a line of the built output in a
   * Safari-family engine.
   *
   * WHAT THIS IS AND IS NOT. WebKit on Linux is the same engine family as iOS Safari, not iOS
   * Safari: no real share sheet, no iOS media quirks, no Photos app. It will not tell you whether
   * a download reaches somebody's camera roll. It WILL tell you whether the compiled Svelte runs,
   * whether the CSS holds, and whether any API the new output relies on behaves differently — the
   * class of breakage a compiler change actually produces, and the class that would otherwise be
   * discovered by a bride.
   *
   * `iPhone 14` rather than only Desktop Safari because the phone viewport is where this product
   * lives, and the mobile layout is the one with the camera controls in it. */
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
    { name: 'mobile-safari', use: { ...devices['iPhone 14'] } }
  ]
});
