# Snapdini — development & maintainer guide

Everything beyond the self-host quick start in the [README](../README.md): architecture, building
from source, the dev stack, gotchas, and releasing. If you just want to **run** Snapdini, the
README's quick start is all you need.

## Architecture

- **Backend** — `app/` — Express + TypeScript (run via `tsx`) + Postgres + Drizzle ORM.
- **Frontend** — `web/` — SvelteKit 2 + TypeScript (adapter-node), served behind nginx.
- **nginx** routes `/api` + `/uploads` → the app, everything else → the web (SvelteKit) server.
- Per-stack Docker Compose; a reverse proxy you manage (Traefik, Caddy, nginx…) terminates TLS and
  routes your public domain → the stack's host port.

## Two ways to run

| Mode | File | What it does |
|---|---|---|
| **Published images** (default) | `app/docker-compose.yml` | Pulls `ghcr.io/paytah232/snapdini-{app,web}` + Postgres + nginx. For self-hosting / production. |
| **Build from source** | `app/docker-compose.dev.yml` | Builds app + web from local source with hot-reload, for development. |

Each compose file declares an explicit **`name:`** (project) so stacks stay isolated on one host —
keep it; otherwise a `down` on one can tear down another. **Run production from its own folder with
its own `.env`** — don't share the dev tree's env file.

## Build from source

```bash
git clone https://github.com/paytah232/snapdini.git && cd snapdini/app
cp .env.example .env            # edit: BASE_URL, POSTGRES_PASSWORD, optional Stripe/Mailgun/admin
docker compose -f docker-compose.dev.yml up -d --build     # dev stack (hot-reload)
```

The dev stack bind-mounts the source for hot-reload. For production you don't build at all — run the
**published images** with `docker-compose.yml` (see the README quick start). To publish your own
images from a fork, see **Releasing** below.

### Dev stack tips

```bash
cd app
docker compose -f docker-compose.dev.yml up -d             # start (builds on first run)
docker compose -f docker-compose.dev.yml up -d --build web  # after web changes
docker compose -f docker-compose.dev.yml restart app        # after backend changes (src is bind-mounted)
docker compose -f docker-compose.dev.yml restart nginx      # after recreating app (stale upstream → 502)
```

## Landing hero images (the film-strip)

The rotated film-strip on the landing page (`web/src/routes/+page.svelte`) shows four frames.
By default they're warm gradients; drop real photos in to replace them:

- Put `1.jpg … 4.jpg` in **`web/static/sample/`**, then rebuild web. Missing files fall back to the
  gradient automatically.
- **Any aspect ratio is fine** — each frame adopts its image's real shape on load, so a mix of
  1:1 / 4:5 / etc. displays true-to-shape (equal width, centre-aligned).
- The resize uses a Svelte action that checks `img.complete` **and** listens for `load`. This is
  deliberate: relying on the `load` event alone misses **already-cached** images (the image finishes
  before the handler attaches), which made the resize hit-or-miss. Keep both paths.

## Integration suite layout

`testsuite/run.mjs` is an orchestrator, not the tests. It discovers `testsuite/specs/*.mjs`, runs
them as **separate child processes** in a concurrency pool (`--jobs`, default 4), buffers each
spec's output so parallel runs stay readable, and aggregates the pass/fail totals. `npm run
test:integration` still just calls it.

- `--only=<substring>` runs one spec in a few seconds — the normal loop while writing a test.
- Specs named `9x-` are **serial**: they call `POST /api/admin/run-sweep` (which purges every
  eligible event in the database) or compare `/api/admin/overview` counts against a live
  `SELECT count(*)`. Anything creating an event concurrently races them, so they run alone after
  the pool. Put a new spec in the `9x-` band if it sweeps or counts globally.
- `testsuite/lib/harness.mjs` holds the shared helpers. Process-level parallelism drove three of
  its details: the cookie jar is `session.cookie` (an exported `let` cannot be reassigned by an
  importer), the test account is unique per **process** (a per-second suffix collided when two
  specs started in the same second), and `spec()` gives each process its own verified owner and
  tears it down. `createEvent()` records event **ids** so teardown can delete the whole upload
  directory — looking filenames up from `photos` failed once a sweep had already deleted the rows.
- Ownerless rows (demo events) survive deleting the test user, so a spec that creates one must push
  its join code to `orphanJoinCodes`.
- Timing-sensitive assertions: the write-behind counter tests read the DB shortly after a request to
  prove nothing is written inline. Keep `COUNTER_FLUSH_MS` comfortably above that gap — at 400ms the
  flush landed first once the suite got fast enough.

## Notes & gotchas

**Write-behind counters.** Gallery views, per-photo views/downloads and referral clicks are hot-path
writes on the guest side, so they never touch Postgres inline. `app/src/server/counters.ts` keeps
in-memory `Map`s keyed by row id, coalesces every bump, and flushes on an interval with a single
`UPDATE … FROM (VALUES …)` per table — 100 photo views become one statement. The tracking routes in
`routes/track.ts` respond **before** doing any work, and the browser sends beacons
(`navigator.sendBeacon`) so nothing blocks navigation. Tunables and caveats:

- `COUNTER_FLUSH_MS` (default `5000`) — flush interval. The dev stack sets `400` so tests do not sleep.
- Counters are flushed on `SIGTERM`/`SIGINT`, but an unclean kill loses at most one interval's worth.
  These are engagement metrics, not billing data — that trade is deliberate.
- The map is capped (20k keys) so a hostile client cannot grow it without bound.

- **Typecheck runs on the HOST, not in the container** — `tsconfig.json` isn't bind-mounted, so `tsc`
  inside the app container can't find it. Use `npm run typecheck` from `app/` (or the root).
- **`BASE_URL` is REQUIRED in production** — it's baked into QR codes, email/verify links, Stripe
  redirects + webhook, and OG tags. For security the app does **not** trust the request `Host` header
  for these in prod (anti host-header-poisoning); if `BASE_URL` is unset it logs a warning and falls
  back to the host. Always set it (dev default: `http://localhost:3001`).
- **Billing is env-gated** — `STRIPE_SECRET_KEY` unset ⇒ billing off, no "Pro" UI, fully free (the
  self-host default). Keys live in the stack's `.env` (gitignored).
- **Site admin** is bootstrapped from `ADMIN_EMAIL`/`ADMIN_PASSWORD` (no shipped default).
- **Contact form** (`/contact`) is a **durable DB mailbox**: every submission is stored in the
  `contact_messages` table and surfaced under **Site admin → Contact messages** (with a *mark done*
  toggle). If **`SUPPORT_EMAIL`** + an email transport (Mailgun/SMTP) are configured it *also*
  forwards by email (best-effort) — but submitting always succeeds and is never lost if email is off
  or fails. On a Mailgun **sandbox** domain, `SUPPORT_EMAIL` must be an *authorized recipient* or the
  forwarded copy won't deliver (the DB record is kept regardless).
- **Google sign-in (optional)** — set `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` to show the Google
  button. Create them at <https://console.cloud.google.com/apis/credentials> (OAuth client ID → "Web
  application"); the **Authorised redirect URI must be `<BASE_URL>/api/auth/google/callback`** and
  match `BASE_URL` exactly. CSRF `state` is handled automatically. Both unset ⇒ button hidden.
- **Social share image** — `web/static/og.png` is generated by `app/src/scripts/make-og.mjs` (needs
  the fonts baked into `Dockerfile.dev`). See that script's header to regenerate.
- **Capacity / load testing** — uploads are the CPU-bound ceiling; see `loadtest/CAPACITY.md` and
  `npm run test:load` / `npm run test:load:multi`.
- **Search indexing — only ONE deployment may say "I am the original"** (`SEO_INDEXABLE`).
  Every SEO tag used to be built from the *request host*, and robots.txt even documented that as a
  feature ("correct on any domain, dev or prod"). It is the opposite: the dev deployment served
  `canonical: <itself>` plus `robots: index, follow`, so Google saw two identical pages each
  declaring itself the master copy, **picked the dev one, and demoted the real homepage to a
  duplicate**. A preview host cannot be trusted to describe itself.
  - `SEO_INDEXABLE=1` opts a deployment in. **Unset is the default and means noindex**, so a new
    staging or preview host suppresses itself without anyone remembering to do anything. Set it on
    exactly one host — the public one named in `BASE_URL`.
  - Canonical, `og:url` and the sitemap come from `ORIGIN` (= `BASE_URL`), never the request host.
    Logic is in `web/src/lib/seo.ts` (unit-tested); pages read `$page.data.canonicalOrigin` and
    `$page.data.robotsMeta` from `routes/+layout.server.ts`, and `hooks.server.ts` adds an
    `X-Robots-Tag` header so routes rendering no head tags are covered too.
  - **Crawling stays ALLOWED on a non-indexable host, deliberately.** A crawler has to fetch a page
    to see the noindex, so `Disallow: /` would strand a preview host in the index with no way to
    tell anyone to drop it. What it does not do is advertise a sitemap, and `/sitemap.xml` 404s.
  - Per-event `og:url` (join/gallery/share pages) is still request-derived on purpose — those are
    social previews for one shared link, not canonicals, and they are all `Disallow`ed.
  - **Alternative, if you cannot set env on your host**: send the header at your reverse proxy
    instead. Traefik file provider:

    ```yaml
    http:
      middlewares:
        dev-noindex:
          headers:
            customResponseHeaders:
              X-Robots-Tag: "noindex, nofollow"
      routers:
        my-dev-router:
          middlewares: [dev-noindex]
    ```

    or as labels: `traefik.http.middlewares.dev-noindex.headers.customresponseheaders.X-Robots-Tag=noindex, nofollow`
    and `traefik.http.routers.<router>.middlewares=dev-noindex`. nginx: `add_header X-Robots-Tag
    "noindex, nofollow" always;`. Caddy: `header X-Robots-Tag "noindex, nofollow"`. Same caveat
    applies — do **not** also block it in robots.txt, or the noindex is never read.

- **Analytics / ads (optional, off by default)** — two ad platforms are supported, configured
  **independently**: set **`GTAG_ID`** (a Google tag id, e.g. `AW-…`/`G-…`) for a Google tag with
  **Consent Mode v2**, and/or **`MSUET_ID`** (the numeric Microsoft Advertising UET tag id) for the
  Microsoft UET tag. Either, both or neither — with neither set, no third-party scripts load at all.
  - Per-platform logic lives in `web/src/lib/consent.ts` (Google) and `web/src/lib/msads.ts`
    (Microsoft), both unit-tested. The SSR hook `web/src/hooks.server.ts` injects whichever are
    configured into the `%snapdini.analytics%` slot in `app.html`.
  - **Conversions go through `web/src/lib/adtracking.ts`, not the per-platform modules.** That
    facade fires every configured platform from one call, so a call site can't accidentally measure
    only one of them, and `purchaseTracked()` lets a page skip work (the Stripe session lookup)
    that exists solely to feed a conversion. Goals are operator config: `GADS_*_LABEL` for Google,
    `MSADS_*_EVENT` for Microsoft (the goal's *Action* name in Microsoft Advertising).
  - **The draft hand-off.** A signed-out host can fill in `/app`, and the create button then sends
    them to sign up. `web/src/lib/eventDraft.ts` owns that draft (key, 24h window). Reading it is
    **non-destructive on purpose**: it used to consume, and two tabs then raced for it — on one
    device the tab opening the email and the tab that was polling both head for `/app`, and
    whichever mounted first ate the draft, leaving the other blank. The draft's life ends when the
    event is created (`clearDraft()` right after the create call, so it covers the Stripe branch
    too) or when it ages out. Do not reintroduce consume-on-read. It
    it must be `localStorage`, because verifying an email opens a NEW TAB where `sessionStorage`
    does not exist. `/dashboard` peeks (never consumes) on `?verified=` and sends them back to
    `/app` to finish, which is what the "we'll take you straight back" copy promises.
  - **Verification can happen on another device**, and usually does — you sign up on a laptop and
    open the email on your phone. The phone gets the session and the redirect; the laptop is where
    the draft lives. So registration returns a `pendingToken` and the signup page polls
    `GET /api/auth/pending?token=…` (`signup_poll` purpose, non-consuming `peekEmailToken`) until
    the address is verified, at which point that browser gets a session too and carries on. It is
    deliberately token-based, never address-based: an address parameter would make it an
    account-enumeration oracle. Both devices fire the conversion with the same
    `auth.signupMarker(userId)` digest, which is what makes the platforms count one sign-up — keep
    them identical if you touch either side.
  - **When each conversion fires.** Purchase fires only after the Stripe session confirms
    `paid`. Event-created fires on the return to an event that already exists. **Sign-up fires when
    the address is VERIFIED, not when the registration form succeeds** — three paths verify an
    address (the verification link, a magic-link sign-in, Google sign-in), so `routes/auth.ts`
    keys on the *transition* to verified and appends `?verified=<digest>` to the `/dashboard`
    redirect; `routes/dashboard/+page.svelte` fires on that marker and strips it. Keying on the
    transition is what stops a returning magic-link sign-in re-counting as a new sign-up — see
    `testsuite/specs/95-signup-conversion.mjs`. The marker is a one-way digest of the user id, so
    it de-duplicates without handing an ad platform a user identifier.
  - `ANALYTICS_EXCLUDE_EMAILS` suppresses conversions for the operator's own signed-in sessions.
    Site admins are excluded automatically, so this list is for **non-admin** accounts you use for
    testing — the easy thing to get wrong, since an unlisted non-admin account looks identical to
    a real customer in the data.
  - One consent decision drives both: visitors in the EEA, UK and Switzerland get a consent banner
    (`ConsentBanner.svelte`, defaults denied there); elsewhere the tags run by default with a "Your
    Privacy Choices" opt-out link and Global Privacy Control honoured. Region comes from
    Cloudflare's `CF-IPCountry` header. Google takes the four Consent Mode v2 signals; UET has a
    single `ad_storage`, and because UET has no region parameter its default is decided server-side.
  - Both libraries are loaded on **idle or first interaction**, never during the initial paint —
    they queue, so a conversion fired before the library arrives is replayed. Keep it that way;
    loading either eagerly costs the mobile LCP.
  - `bat.bing.com` is allowed in the nginx CSP (`script`/`connect`/`img`).
  - **You cannot verify either tag from inside the LAN**: `bat.bing.com` and
    `www.googletagmanager.com` are blocked at DNS (Pi-hole), so both fail with a connection error
    and never run. That is why dev traffic cannot reach either platform — convenient, but it also
    means testing the tags on production from a home device shows nothing. Use a connection off
    that network (mobile data) or allowlist the two domains.
  - Run the tests with `cd web && npm test`; the journey itself is covered end to end in
    `web/e2e/signup-verification.spec.ts`.

## Releasing (maintainers)

Two images are published per release — `snapdini-app` (Express API) and `snapdini-web` (SvelteKit).

**Automated (recommended):** bump `app/package.json` + `web/package.json` to the new version, commit,
then push a version tag. GitHub Actions builds + pushes both, multi-arch (amd64 + arm64), to GHCR —
no registry secrets needed (uses the built-in `GITHUB_TOKEN`):

```bash
git tag v1.0.0 && git push origin v1.0.0
```

Workflow: `.github/workflows/release.yml`. Output: `ghcr.io/<owner>/snapdini-app:1.0.0` (+ `:latest`)
and `…-web:…`. Make the GHCR packages public so self-hosters can pull without auth. (Each arch builds
on its own native runner — `ubuntu-latest` + `ubuntu-24.04-arm` — then a merge job stitches the
multi-arch manifest; QEMU emulation is avoided because it crashes on the native-dep `npm install`.)

**Manual (no CI):** `app/publish.sh <version> <prefix>` does the same with `docker buildx` after a
`docker login`:

```bash
cd app && ./publish.sh 1.0.0 ghcr.io/youruser/snapdini
```

Self-hosters consume these via the README quick start — `docker-compose.yml` pulls them. Pin a release
with `IMAGE_TAG` in `.env`; point at your own registry with `IMAGE_PREFIX`.

## Other docs

- **[GUIDE.md](GUIDE.md)** — page-by-page walkthrough of the app (visitor → organizer → guest → admin).
- **[../TESTING.md](../TESTING.md)** — manual QA checklist.
