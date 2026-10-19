import { readFileSync, copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { guestServiceWorker } from './guest/service-worker.ts';
import { defineConfig, type Plugin } from 'vite';
import { svelte, vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const web = fileURLToPath(new URL('.', import.meta.url));
const output = resolve(web, 'guest-dist');
const { version } = JSON.parse(readFileSync(resolve(web, 'package.json'), 'utf8'));
const fonts = ['playfair-display', 'cormorant-garamond', 'great-vibes', 'sacramento', 'jost'];

function guestOnly(): Plugin {
  return {
    name: 'guest-only-artifact',
    enforce: 'pre',
    transform(source, id) {
      // Shared styles normally use the site's root fonts. The independently served artifact
      // carries its own allowlisted copies, so its assets never depend on a working origin.
      if (id === resolve(web, 'src/app.css')) return source.replaceAll('/fonts/', '/guest/fonts/');
    },
    generateBundle(_options, bundle) {
      let modules = 0;
      for (const item of Object.values(bundle)) {
        if (item.type !== 'chunk') continue;
        for (const id of Object.keys(item.modules)) {
          modules++;
          const path = id.replaceAll('\\', '/');
          const local = path.startsWith(web) && !path.includes('/node_modules/');
          const allowed = path.startsWith(`${web}guest/`) || path.startsWith(`${web}src/lib/`) || path === `${web}src/app.css`;
          if ((local && !allowed) || /\/(?:server|routes)\/|\/(?:admin|siteadmin)[^/]*\.|\$env\/|(?:^|\/)\.env(?:\.|$)/i.test(path)) {
            throw new Error(`Non-guest module in static artifact: ${id}`);
          }
        }
      }
      const files = Object.keys(bundle);
      const hash = createHash('sha256');
      for (const item of Object.values(bundle)) hash.update(item.type === 'chunk' ? item.code : item.source);
      for (const name of fonts) hash.update(readFileSync(resolve(web, `static/fonts/${name}.woff2`)));
      hash.update(readFileSync(resolve(web, 'static/icon.svg')));
      const fingerprint = hash.digest('hex').slice(0, 16);
      const assets = [...files.map(name => `/guest/${name}`), ...fonts.map(name => `/guest/fonts/${name}.woff2`), '/guest/icon.svg'];
      this.emitFile({ type: 'asset', fileName: 'release.json', source: JSON.stringify({ version, fingerprint }) });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: guestServiceWorker(fingerprint, assets) });
      console.info(`Guest artifact audited: ${modules} browser modules; no routes/server/env modules.`);
    },
    closeBundle() {
      mkdirSync(resolve(output, 'fonts'), { recursive: true });
      for (const name of fonts) copyFileSync(resolve(web, `static/fonts/${name}.woff2`), resolve(output, `fonts/${name}.woff2`));
      copyFileSync(resolve(web, 'static/icon.svg'), resolve(output, 'icon.svg'));
    },
  };
}

export default defineConfig({
  root: resolve(web, 'guest'),
  base: '/guest/',
  // Never copy the whole site static directory or load .env files into this dedicated build.
  publicDir: false,
  envDir: false,
  plugins: [svelte({ configFile: false, preprocess: vitePreprocess() }), guestOnly()],
  define: { __GUEST_BUILD_VERSION__: JSON.stringify(`${version}-guest`) },
  resolve: {
    alias: {
      $lib: resolve(web, 'src/lib'),
      '$app/navigation': resolve(web, 'guest/shims/navigation.ts'),
      '$app/environment': resolve(web, 'guest/shims/environment.ts'),
    },
  },
  build: { outDir: output, emptyOutDir: true, sourcemap: false },
});
