import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  // svelteTesting() (browser resolve condition + auto-cleanup, needed so component onMount runs
  // under vitest) is added ONLY when running tests, so it can never affect the dev/prod build.
  plugins: [sveltekit(), ...(process.env.VITEST ? [svelteTesting()] : [])],
  server: {
    // Dev: proxy API + uploads to the existing Express backend (via the dev nginx on :3001).
    proxy: {
      '/api': 'http://localhost:3001',
      '/uploads': 'http://localhost:3001'
    }
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.{test,spec}.{js,ts}']
  }
});
