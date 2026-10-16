# Standalone guest camera

`npm run build:guest` builds a browser-only camera entry into `web/guest-dist`.
It reuses the shared camera with recovery enabled; no SvelteKit server, route,
organizer, or administrator entry is built. APIs remain relative to the page's
origin. `npm run preview:guest` previews the artifact locally.

Serve the artifact under `/guest/`, with `/guest/join/<code>` and
`/guest/e/<slug>` and `/guest/saved/<code>` mapped to its `index.html`. Publish recovery event manifests
separately at `/guest/events/<identifier>.json`; the guest service worker never
caches those responses. Serving this directory from the ordinary application
host is a development prototype, not independent hosting during an origin outage.

The build disables public-directory copying and .env loading, rejects server
and route modules in its bundle graph, omits source maps, and explicitly copies
only the icon and five bundled typefaces. Review this allowlist when adding guest
assets. Browser code is public; authorization always belongs on the server.

The `/guest/` service worker caches an explicit list of build assets and supplies
the camera shell for offline guest navigation. It does not cache APIs, manifests,
photos, organizer pages, or arbitrary responses. Updates wait for existing tabs;
old caches are retained so a running camera can finish on its loaded build.
The artifact publisher must also retain previous hashed assets across releases.

After building, run `node --test guest/service-worker.test.mjs` to verify shell
fallback, cache boundaries, and update behaviour. Capture persistence and event
reconciliation are tested with their shared application modules separately.

The saved-captures route reads only the local IndexedDB queue. It makes no API or
event requests, keeps captures after export, and requires explicit confirmation
before deleting a local copy.
