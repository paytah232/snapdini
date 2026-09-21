import { sveltekit } from '@sveltejs/kit/vite';
import { svelteTesting } from '@testing-library/svelte/vite';
// Types only, no runtime import: vitest 5 no longer augments Vite's UserConfig by default, so
// without this the `test` block at the bottom does not typecheck. A real `import … from
// 'vitest/config'` would also work, but it would put vitest on the critical path of `vite build`
// — and the Dockerfile prunes devDependencies, so a production build must not need it.
/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig(({ mode }) => ({
  // svelteTesting() (browser resolve condition + auto-cleanup, needed so component onMount runs
  // under vitest) is added ONLY when running tests, so it can never affect the dev/prod build.
  // Vitest resolves this config with mode 'test'. That used to be read off `process.env.VITEST`,
  // which now needs @types/node — a dependency this package deliberately does not carry, so that
  // node:fs cannot typecheck in web source (see the note above the `?raw` imports in
  // componentLock.test.ts). `mode` says the same thing and is typed by Vite itself.
  plugins: [sveltekit(), ...(mode === 'test' ? [svelteTesting()] : [])],
  server: {
    // Vite 8 refuses to serve a file outside the project root unless it is allow-listed ("Denied
    // ID"), and `web/` is the root — so the two places this package reaches across the monorepo
    // have to be named or their imports stop resolving. Named individually rather than as the
    // repo root: an allow-list entry is also what the DEV SERVER will hand out over /@fs, and
    // `..` would put every .env in the repo behind it.
    //   ../shared          — imported for real (caption, reveal, token-paths, …)
    //   ../app/src/server  — read as TEXT by featureUpsell.test.ts, via `?raw`
    // Paths are relative to the project root, so no node:url import is needed. Listing `.`
    // keeps web/ itself allowed, which is what the default would have been.
    fs: { allow: ['.', '../shared', '../app/src/server'] },
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
}));
