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
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }]
});
