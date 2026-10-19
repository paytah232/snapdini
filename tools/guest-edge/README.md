# Isolated development guest edge

This package prepares a new `snapdini-guest-dev` Worker on the selected account's
`workers.dev` hostname. It has no zone routes, custom domains, KV bindings, scheduled
jobs or account-plan changes. The existing failover Worker is never named or modified.
Preparation does not call Cloudflare or require a token, and never deploys automatically.

First build the guest-only artifact (`cd web && npm run build:guest`) and run the
development recovery snapshot publisher in `../guest-recovery/`. Then, from the repo root:

```sh
DEPLOYMENT_LANE=dev \
APP_ORIGIN='https://your-development-origin.example' \
CLOUDFLARE_ACCOUNT_ID='<selected account ID>' \
node tools/guest-edge/prepare.mjs
```

The default sources are `web/guest-dist` and `app/data/guest-recovery`; override them with
`GUEST_ASSET_DIR` and `GUEST_SNAPSHOT_DIR` if needed. The script returns a temporary artifact
directory and snapshot count. Its private generated `wrangler.json` contains the account ID
and actual origin; keep it outside the public repo. The checked-in template contains neither.

Review the artifact before using an available Wrangler CLI to deploy it:

```sh
# Only after reviewing the prepared directory and supplying the authorized token via environment:
wrangler deploy --config '<artifact directory>/wrangler.json'
```

No Wrangler dependency is installed by these scripts. Tokens belong in the process environment
as `CLOUDFLARE_API_TOKEN`, never in shell history, checked-in files or browser assets. Use the
account that owns the production domain, while targeting only this isolated development Worker.
The origin must be an explicit HTTPS development origin without credentials, path, query or
fragment. These development settings reject production `snapdini.com` and `www.snapdini.com` origins; production preparation requires the explicit configuration below.

The needed API token permission is **Account → Workers Scripts → Edit** (the API documents
this as `Workers Scripts Write`), scoped to that selected account. No DNS edit, zone routes,
KV or billing permission is needed for this package. Supply the account ID explicitly so
account discovery is unnecessary. An account-scoped token can potentially edit other Workers
in that account: treat it as a deployment credential and deploy only this generated config.
The existing DNS-only credential is insufficient. Cloudflare documents the accepted Worker
upload permissions [here](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)
and Wrangler's account/token environment variables [here](https://developers.cloudflare.com/workers/wrangler/system-environment-variables/).

Only the compiled guest allowlist is copied. No complete web build, server code, source maps,
`.env`, organizer bundle or arbitrary files are included. Snapshot JSON is parsed and allowlisted
again before it enters the package. Public files are under `/guest/`, with snapshots at
`/guest/events/<identifier>.json`. The static `_redirects` file internally serves the same
guest HTML for `/guest/join/*`, `/guest/e/*` and `/guest/saved/*`. Cloudflare supports these
relative `200` proxies in its [static redirect rules](https://developers.cloudflare.com/workers/static-assets/redirects/).

Existing assets and guest deep links use static asset serving first; they do not require a
Worker invocation. Only `/api/*` and `/uploads/*` are configured to run the proxy first. Unknown
paths get a 404, with no global SPA fallback that could turn missing JSON or scripts into HTML.
The proxy preserves guest session/visitor tokens, bodies, media ranges and conditional headers,
and streams responses. It strips account cookies, Authorization, organizer/admin keys, caller
forwarding headers and upstream Set-Cookie. Origin redirects are returned without following them;
it is not an unrestricted proxy. Organizer/account controls remain on the normal application.
Origin failures return an uncached 503, allowing the guest's existing recovery flow to run.

The package adds CSP, camera/microphone permissions and basic security headers. Hashed assets
are immutable; HTML and the service worker revalidate; snapshots use no-store. Do not enable
Workers Caching or change the asset-first routing just to cache these already-static files.
The expected free-tier advantage follows Cloudflare's [static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/).

This is a deployment snapshot: later origin event edits are not automatically sent to Cloudflare.
Regenerate and deploy after relevant event-setting changes during development, and redeploy a
new guest artifact after app changes. For automatic operation, use the verified separate event publisher described below. Do not promise current lock/revocation knowledge during an outage.
Browser queues on this separate hostname also belong to that hostname; they are not migrated
from the primary site's IndexedDB or localStorage.

Run isolated checks with no account credentials or network calls:

```sh
node --test tools/guest-edge/edge.test.mjs
```

The extensionless `/guest/shell` is an identical HTML alias with an explicit HTML content type.
It avoids Cloudflare rejecting index.html rewrites as loops despite html_handling:none.


## Release promotion and ordinary guest links

The camera artifact also serves `/join/*` and `/e/*` as static aliases. There is no browser
redirect, so normal-domain sessions, IndexedDB queues and camera permissions keep their origin.
`/guest/sw.js` has `Service-Worker-Allowed: /`; guest pages register only their own `/join/`,
`/e/`, or `/guest/` scope. Updates wait for existing camera clients to close.

Set `GUEST_EVENTS_WORKER=snapdini-guest-events-dev` in dev or `snapdini-guest-events` in an
explicit production lane. This binds the independently deployed settings Worker. Camera
artifacts then omit event snapshots; settings changes never require a camera deployment.
Production preparation requires this binding, disables workers.dev and prepares only the three
guest path routes. It never reroutes account pages, `/api/*`, `/uploads/*` or existing failover.
Review existing zone routes before deploying; no production route is installed by dev commands.

`EXPECTED_VERSION=<release> node tools/guest-edge/promote.mjs` prepares a private artifact after
checking app/web versions, the built guest manifest and a matching writable live origin.
Supply explicit lane, account, origin and event Worker as above. `--deploy` additionally requires
a private process deployment token and rechecks health immediately before uploading. The checked-in
Wrangler template remains isolated to dev; generated production configuration is opt-in only.

For normal upgrades, set `SNAPDINI_GUEST_RELEASE_HOOK` to an operator-owned executable when
running `app/scripts/upgrade.sh`. The hook receives the running version after origin startup.
Configure it to load private deployment settings/token and invoke
`node tools/guest-edge/update-from-container.mjs "$1"` with `GUEST_WEB_CONTAINER` explicitly set.
That helper extracts the guest artifact from the **running web image**, verifies its release,
and uses the same health-gated promotion. No hook is needed for ordinary self-hosting.
A failed promotion fails the upgrade's final step and leaves the prior edge deployment available;
it does not report an edge update as successful. Preserve the previous deployment ID for rollback.

See [the 1.5.10 runbook](../../docs/RELEASE_1.5.10.md) for acceptance and rollback limits.

For staged acceptance, set `GUEST_CANARY_CODE` to one eight-character event code in the production
lane. This routes only its normal join link, its recovery settings/export link and independent
camera assets. Other `/join/*` and `/e/*` links retain origin handling. Trailing route wildcards
allow query strings while the shell still validates its event identifier. Remove the explicit
canary setting only after acceptance to promote the normal guest path routes.
