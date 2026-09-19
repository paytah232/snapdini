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

**Only ever run ONE `docker compose build` against this stack at a time.** Two concurrent builds of
the same compose project collide on a single BuildKit session, and dockerd kills it outright:

```
session healthcheck failed fatally: "transport: Error while dialing: only one connection allowed"
```

Both builds then hang **forever** at ~0% CPU having printed nothing at all. They do not recover and
they do not time out, and because the symptom is silence it reads like a slow build or a stalled
download — people go looking at the network, which is fine. The tell is no output for more than a
minute or two *combined with* near-zero CPU:

```bash
ps -eo pid,etimes,pcpu,args | grep "buildx[ ]bake"     # ~0.2% CPU on a "running" build = wedged
journalctl -u docker --since "20 min ago" | grep -i healthcheck
```

Recovery is to kill the `buildx bake` processes and re-run one build. Kill them **by PID**, or with
the bracket trick above — `pkill -f "buildx bake"` matches the shell running the pkill and takes
out your own session.

This is easy to hit when several people (or several agents) share one dev VM. Whoever is iterating
on the front end should own rebuilds while that work is in flight.

## Landing hero images (the film-strip)

The rotated film-strip on the landing page (`web/src/routes/+page.svelte`) shows four frames from
ONE event, picked at random per request. By default they're warm gradients; real photos replace them.

- Photos live in **`web/static/sample/`** and are grouped into **rolls** in `web/src/lib/samples.ts`
  — one roll per real event, each with a label ("Sarah & Peter", "Japan 2026"). A request picks one
  roll, shuffles it, and takes four. Missing files fall back to the gradient automatically.
- **The grouping is load-bearing.** The frames are stamped with consecutive numbers (▶12 ▶13 ▶14
  ▶15), which says "four frames off one roll" — so they must come from the same event. Drawing four
  at random from every photo put a wedding, a birthday and a ski slope on one roll.
- **The pick happens in `+page.server.ts`, never in the component.** Randomising during render runs
  once on the server and again on the client with a different answer, and the hydration mismatch
  shows up as the strip visibly swapping images after load. The frame numbers and the roll caption
  come through the same load for the same reason.
- Each photo needs **four files**: `-220` and `-330` in both `.jpg` and `.webp`. Generate them with
  a 4:5 centre crop, e.g.
  ```
  ffmpeg -i in.jpg -vf "scale=220:275:force_original_aspect_ratio=increase,crop=220:275" -q:v 4 out-220.jpg
  ffmpeg -i out-220.jpg -quality 78 out-220.webp
  ```
- The same files feed the **use-case page** photo strips via `SAMPLE_SETS` (see
  `UseCasePage.svelte`), so a birthday page shows a birthday. A page with no set renders no strip.
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
  the pool. Put a new spec in the `9x-` band if it sweeps or counts globally. `11-video-length`
  moved there as `91b-video-length` for exactly that reason: it reads the DB-wide
  `videos_over_limit` / `capture_overshoots` totals, which is not something a pool spec may do.

### The three rules every spec follows

1. **Scope every assertion to what the spec created.** A whole-table count is a claim about every
   other spec's behaviour, and it fails in the most expensive way — an investigation into a
   product that is fine. Filter by the spec's own `UNIQ`, its own event id, or (for an
   append-only table like `site_events`) a high-water mark taken on entry. Two things are allowed
   to stay global: an **invariant** whose expected value is zero however the table got that way
   (`10-referral-attribution`'s "no unpaid event anywhere holds a reward code" — a match is a
   product bug wherever it came from), and a claim about an endpoint's **own** WHERE clause.
   Where a global TOTAL genuinely is the thing under test, take a **delta** against a snapshot and
   move the spec to the `9x-` band so nothing can move the total underneath it. `91b` does both:
   `videos_over_limit` must move by exactly `+2`, not be `>= 2`. The old `>= 2` was passing on
   sixteen unrelated rows this dev box was carrying, and still passed with the product
   contributing nothing at all.
2. **Never sleep for a deadline — poll for the condition.** `harness.waitFor(pred, what)` polls to
   a timeout, so a slow box is slow rather than red and a fast one does not wait. A fixed
   `setTimeout` before an exact-equality read is a bet on how busy the box is: the gap between
   `03-referral-funnel`'s track POSTs and its read measured **124 ms of a 2500 ms
   `COUNTER_FLUSH_MS` window — about a 5% chance, every run, of failing for no product reason**.
   Where a spec has to assert that something has *not* happened yet — the write-behind counters —
   sleeping is not just slow, it is ill-formed, because the flusher ticks on its own schedule.
   `probeWriteBehind()` in `03` shows the shape: synchronise to a flush tick first (send one hit
   and wait for it to land), probe inside the fresh window, and treat a tick that still beats you
   as INCONCLUSIVE and retry — a real write-through regression fails all three attempts.
   Better still, use a **barrier**: track a legitimate id alongside the one that must not count,
   and wait for the legitimate one. `flushCounters()` writes the whole bucket in one statement, so
   once the legitimate count lands, a zero next to it is a fact rather than a guess.
3. **Clean up in the `finally`, never on the last line.** `spec()` always runs `cleanup()`; a
   trailing `DELETE` does not run when an assertion above it throws, which is exactly when a leak
   happens. The harness owns four registries — push to them BEFORE creating the row:
   `createdJoinCodes` / `createdEventIds` (events + upload files), `orphanJoinCodes` (ownerless
   demo events), **`orphanEmails`** (a second account the spec registered itself — deleted by
   EXACT address, never a `LIKE` pattern), and **`teardownSql`** (anything else, e.g. the four
   `client_errors` rows `02-core-features` files). `91-auth-cooldown-admin` used to finish with
   `DELETE FROM users WHERE … OR email LIKE 'other_%@example.com'` and destroyed unrelated
   accounts; a seeded `other_persons_account@example.com` now survives it.
- **Operator sessions**: log in as the operator through `harness.adminLogin()`, never by hand.
  Every hand-rolled login minted a `sessions` row that no teardown could reach (the admin account
  outlives the run, so nothing cascades) — **1,845 of them had piled up on this dev box**;
  `adminLogin()` records the sid and teardown deletes exactly those. And put the OWNER session
  back before creating anything: an event created while the operator session is active belongs to
  the OPERATOR and survives teardown for ever. `13-guest-upgrades` was doing that with its paying
  guest's event.
- **Uniqueness comes from `UNIQ`**, which is per PROCESS — never a second-resolution `TS`
  (`09-cohosts` used `cohost_${TS}@example.com`; seed that address and its "co-host user
  registers" fails and then throws past its own cleanup line) and never a fixed literal in a
  global namespace (`05`/`07` hard-coded `my-event-url` / `taken-url-x` / `my-custom-link`, so one
  killed run claimed those slugs for ever and the duplicate-→409 tests failed on the wrong line).
- **Never `TRUNCATE` a table the spec did not create.** `94-analytics` truncated `site_events`
  three times, which destroyed the dev box's real analytics AND was the only reason its
  whole-table counts were correct — remove the truncate and seven assertions fail. It now takes
  the bigserial high-water mark on entry, scopes every count to `id > FLOOR`, and deletes exactly
  those rows in teardown. Parenthesise the scoped clause: `id > floor AND a OR b` binds as
  `(id > floor AND a) OR b` and the scope silently falls off the second disjunct.
- **Wall-clock margins are written out, not left to be re-derived.** `92-reschedule`'s
  `edgeAnchor` names its `EDGE_MARGIN` and the spec asserts the boundary it is claiming
  (`canReschedule === true`) rather than inferring it from the event merely not being swept.
- `testsuite/lib/harness.mjs` holds the shared helpers. Process-level parallelism drove three of
  its details: the cookie jar is `session.cookie` (an exported `let` cannot be reassigned by an
  importer), the test account is unique per **process** (a per-second suffix collided when two
  specs started in the same second), and `spec()` gives each process its own verified owner and
  tears it down. `createEvent()` records event **ids** so teardown can delete the whole upload
  directory — looking filenames up from `photos` failed once a sweep had already deleted the rows.
- Ownerless rows (demo events) survive deleting the test user, so a spec that creates one must push
  its join code to `orphanJoinCodes`. **`email_suppressions` is the other table teardown cannot
  reach**: it is global by design (no event, no owner — see `0047_guest_invites.sql`), so nothing
  cascades from deleting the test user. `specs/19-guest-invites.mjs` writes its rows with the per-run
  `UNIQ` prefix in the address and deletes them in a `finally`, so they go even when an assertion
  above throws.
- **The guest list and invite specs (`17-`, `18-`, `19-`) are in the POOL, not the `9x-` band**, and
  deliberately: they assert per-event counts and their own ledger rows, never a DB-wide or
  admin-wide total. Everything they create is scoped to an event they own, which cascades away with
  the test user.
- **`19-guest-invites.mjs` must never send real mail, and must not depend on any leaving.** Devel
  sends from a Mailgun **sandbox** domain, which answers `403` for any recipient not on its
  Authorized Recipients list, so every address in these specs is `@example.com` (IANA-reserved, no
  MX) with the per-run unique prefix — **never add a real address to a fixture**. The suppression
  path is exercised by writing the `email_suppressions` / `guest_unsubscribes` row DIRECTLY rather
  than provoking a bounce, which is also the only way to make it deterministic. The one mailable
  guest is asserted as an INVARIANT rather than an outcome — exactly one send attempted, exactly one
  ledger row, and the recorded status agreeing with the count the route returned — which holds
  whether the transport accepted it, refused it, or was not there to ask.
- Timing-sensitive assertions no longer depend on `COUNTER_FLUSH_MS` being generous: they poll, and
  the one assertion that is genuinely about something NOT having happened yet synchronises to a
  flush tick first (see rule 2 above). Lowering `COUNTER_FLUSH_MS` now makes the suite faster, not
  flakier.
- **The suite must be re-runnable back to back**, so any per-IP limiter it spends has to be raised
  on the DEV STACK — it is one IP, and a limiter that lasts longer than a run turns the next run's
  429s into product failures. `docker-compose.dev.yml` therefore raises `CONTACT_RATE_LIMIT`,
  `DEMO_RATE_LIMIT` and `FACE_ENROL_RATE_LIMIT` (60; the code default is 3 per 15 min, which
  `specs/14-face-matching.mjs` exhausts in one run — it needs six enrol POSTs). **Production leaves
  all three unset and keeps the tight code defaults.** Changing one of these values needs the app
  container RECREATED (`docker compose -f docker-compose.dev.yml up -d app`), not just restarted:
  compose passes env explicitly.
  Do not try to dodge a limiter from the client instead — nginx overwrites `X-Forwarded-For` with
  `$remote_addr`, so `req.ip` is the suite's own address no matter what it sends.
- A spec that can be starved by a limiter reports a **visible SKIP**, never a silent pass: spec 14
  routes every enrol-dependent assertion through `okEnrol()`, which on a 429 prints a banner, counts
  the skips and says so again at the end. A 400/403/503 the product chose is still asserted.
- A survey is **one response per event** (unique index + `onConflictDoNothing`), so a spec needs a
  FRESH event per survey scenario. `specs/06-negative-survey-contact.mjs` proves the rule with a
  concurrent burst on one token: sequential posts are caught by the route's own SELECT and pass even
  with the index dropped, so only a burst actually tests the insert — and the caller whose insert
  stored nothing is the caller that must not fire the operator alert.

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
- **Every outbound email goes through `email.sendMail()` — and has to.** That is where the
  suppression check lives: the deployment-wide list, plus (when an `eventId` is passed) that event's
  own guest opt-outs. It used to live in a single route, which meant a guest who chose "never email
  me again" carried on receiving the gallery link, the thank-you, the reminder and every lifecycle
  message — the unsubscribe worked perfectly and simply reached nothing. So:
  - Never reach for nodemailer or the Mailgun API from another module.
    `app/src/server/__tests__/suppression-chokepoint.test.ts` walks the server source and fails the
    build if anything but `email.ts` touches a transport, and pins the check as happening *before* a
    transport is chosen.
  - `always: true` bypasses it, and belongs only where *not* sending does the greater harm — auth
    links, ops alerts, and the contact form. Everything else stays suppressible by default, so the
    next email anyone adds is compliant without having to remember.
  - A suppressed send **returns** `{ suppressed: true }`; it does not throw. Callers stamp one-shot
    guards and write ledger rows around these calls, and an exception would leave the claim unmade —
    so the sweep would retry the same suppressed address on every tick, forever.
- **Every email is built from ONE shell — `emailShell()` in `app/src/server/email-theme.ts`** — and
  the rules it enforces are not stylistic. A host opened a real Snapdini email and reported *"it's
  awful dark, the link is in dark blue and very hard to read"*; two more looks pinned the cause
  exactly. Outlook mobile was fine, the Gmail mobile app was fine **except the yellow button had
  vanished**, and Outlook web showed the call-to-action as a default dark-blue link on a near-black
  ground. Two independent clients, one cause: the `.btn` rule lived in a `<style>` block, and
  **Outlook.com and the Gmail app both delete `<style>`**. So:
  - **Nothing load-bearing may live in a `<style>` block or depend on a class.** The one `<style>`
    element is in `<head>`, holds a narrow-screen tweak and the `color-scheme` declaration, and the
    message must be completely legible with it thrown away.
  - **Every `<a>` carries an inline `color:`.** Use `link()` or `button()` from `email-theme.ts`
    rather than writing an anchor; an anchor with no colour of its own takes the client's default.
  - **Every call-to-action is a one-cell `<table>`** with the fill as a `bgcolor` **attribute** and
    near-black ink inline on the anchor. `background` and `border-radius` on an `<a>` are ignored by
    Outlook's Word engine even inline, so an inline-styled anchor is not enough.
  - **Layout is tables with `bgcolor` attributes, and every text cell states its own `color`.**
    Outlook desktop honours neither `background` on `<body>`/`<div>` nor inherited `color`, and a
    dark email drawn that way renders on white with invisible text.
  - **Sizes are `px`.** The Word engine does not support `rem`.
  - **`#f5c518` is a background, never text on a pale ground.** Pale text on the brand gold measures
    about 1.6:1. The ink on gold is `#111`. `#b08b08` is the gold that works as text on light.
  - **Dark or light is one constant**: `SCHEME` at the top of `email-theme.ts`. Flipping it
    re-colours every email — shell, cards, links, buttons and the `color-scheme` meta — with no
    other edit. It is dark deliberately (it matches the app), which is the harder of the two to get
    right, which is what all of the above is for.
  - `htmlEmail()` also **repairs the body it is handed**: an uncoloured anchor gets a colour and a
    `class="btn"` call-to-action becomes a real table button. That chokepoint is what covers markup
    written by hand in a route module, the same way `sendMail()` covers suppression.
  - `app/src/server/__tests__/email-shell.test.ts` is the guard. It builds one of every message,
    then **strips the `<style>` block and every class attribute** — precisely what the two failing
    clients do — and fails unless the result is still legible with its CTA still a gold button.
  - `npx tsx app/scripts/email-sampler.ts --out DIR` renders one of every email (HTML **and** text)
    to files, and lints them on the way out. It is the fastest way to see a change.
- **Every customer-facing email carries a `text/plain` alternative part.** `sendMail({ text })`,
  passed to **both** transports (Mailgun's `text` form field, nodemailer's `text`). It is the real
  fallback for a client that cannot render the HTML, what a screen-reader-driven client prefers, and
  HTML-only mail is a deliverability penalty. Two rules, both of which fail silently:
  - **Generated from the view model, never by stripping tags off the HTML.** Tag-stripping gives
    bare URLs mid-sentence and stranded button labels. Every link appears as a full URL on its own
    line, labelled with what it does.
  - **Raw strings, never escaped ones.** `&amp;` in a text part reaches the inbox literally — the
    same bug as an escaped `Subject:` header. The builders in `lifecycle-emails.ts`,
    `guest-emails.ts` and `inline-emails.ts` take raw values and do all three encodings themselves
    (raw for the subject and the text, escaped for the markup).
  - `text` is **optional with a fallback** so an internal ops mail without one still sends, but the
    sweep test fails if a customer-facing builder stops supplying one. The single exception today is
    the guest invite, still built inline in `routes/guests.ts`.
- **`normaliseAddress()` in `app/src/server/delivery.ts` is the canonical form of an address**, and
  it is the same function on both sides of every suppression check — the rows are written through it
  (`routes/guests.ts`) and the lookup key is built through it (`unsubscribe.ts` → `blocksFor`). It
  collapses exactly three things: surrounding whitespace, case, and a **trailing dot** (`x.com.` is
  the fully-qualified spelling of `x.com` — the final dot is the DNS root label, `isEmail` accepts
  both, and without this a host who typed it mailed an address we had a bounce on record for).
  - It deliberately does **not** strip `+tag` subaddressing or Gmail-style local-part dots. Those are
    conventions of particular providers, not rules — RFC 5321 leaves the local part opaque to
    everyone but the delivering host — so collapsing them would let one person's spam complaint
    silently block a **different real person**. Under-normalising is a visible, reportable mistake;
    over-normalising is mail that is never sent, to someone who never asked us to stop, with nothing
    anywhere saying why. If a provider table is ever wanted, it belongs beside this function with its
    own tests, not inside it.
- **`share_sends` is one row per address per link, enforced** (`ux_share_sends_gallery` /
  `ux_share_sends_share`, migration **0052**). Both senders decide whether to mail somebody by
  reading this table first, and until 1.5.0 that read stood on nothing: two presses of Send, or the
  host's blast racing the automatic guest delivery, put the same link in the same inbox twice.
  - **Two partial indexes, not one over `(event_id, share_id, email)`.** `share_id IS NULL` is the
    standing gallery link — the common case, and every send the automatic guest delivery makes — and
    Postgres treats NULLs as *distinct* in a unique index, so a single three-column index would have
    left exactly those rows unconstrained.
  - **Keyed on `lower(btrim(email))`**, because that is what the readers key on. `participants.email`
    is stored as the guest typed it, on purpose, so an index on the raw column would let
    `Mum@x.com` and `mum@x.com` both past a constraint the reads treat as one person.
  - **The host's blast CLAIMS an address before it mails it** (`routes/events.ts` → `email-link`):
    insert with `onConflictDoNothing().returning()`, and send only if a row comes back. An index
    alone does not stop the double-mail — both racers still send and the loser merely fails to write
    its row. A claim that *throws* (a broken database, as opposed to a conflict) still sends: the
    worst case there is the duplicate the guard exists to avoid, which is smaller than a link nobody
    gets. `resend: true` clears the prior rows for the batch first, which is the only place rows are
    ever deleted.
  - **A claim is written `ok: true`, so anything that is not a delivery has to correct it to
    `ok: false`** — a failed send *and* one the suppression chokepoint refused. Both readers count
    `ok` rows only, and under 0052 that row is the address's one row for ever: an `ok: true` row for
    a message nobody received would go on to refuse that person the real link once their suppression
    is lifted. A withheld send is also **not counted in `sent`** (it lands in `skipped`, which is
    "every address that was not mailed and was not an error") — `sent` means messages that left the
    building, and the host is shown that number.
  - **The automatic guest send writes the batch in ONE multi-row insert** (`guest-delivery.ts` →
    `recordSends`), so it too must `onConflictDoNothing()`. A unique violation rolls back the
    *statement*, not the offending row, and the catch around it swallows the error — the mail has
    already gone, so a batch without the clause loses **every** recipient's ledger row over one
    racing address, and a missing row reads as "never sent them the link". Proven on devel: a
    three-row batch against one prior row kept 0 rows without the clause and 2 of 3 with it.
    Drizzle emits an **untargeted** `on conflict do nothing`, which is what makes it cover a pair of
    *partial expression* indexes at all — a `target:` cannot name `lower(btrim(email))`.
- **One survey response per event is a database rule** (`idx_survey_event` is UNIQUE as of migration
  **0051**; `routes/survey.ts` inserts with `onConflictDoNothing`). The survey token sits in an
  emailed link, never expires and is replayable, and a low score fires an instant ops notification —
  so a check-then-insert over a non-unique index meant every concurrent POST passed the check,
  inserted, *and* notified. The **operator alert is gated on the insert returning a row**: a
  submission that stored nothing must not produce a notification.
- **The guest list stores name, email and notes — and NO phone number. Data minimisation, and it
  is not to be re-added.** Snapdini reaches a guest by email and by nothing else, so a phone number
  is a field nothing in this product can act on, and keeping personal data with no purpose is what
  data minimisation forbids — this deployment publishes a PIA (`docs/PIA-face-matching.md`), which
  makes that a commitment rather than a preference. The column existed briefly in `0047` and was
  dropped by **`0053_guest_drop_phone.sql`**; production never created it (`event_guests` ships new
  in 1.5.0 and prod was on 1.4.3 at `0038`), so there was no data to lose.
  - **The test a field has to pass:** `notes` stays because it is **rendered back to the host** in
    the guest row, so being read is the job it does. A phone number was read by nothing. Apply that
    test before adding any field here, and do not re-add this one "for completeness".
  - **The importer still RECOGNISES a phone column — deliberately.** `looksPhone()` in
    `app/src/server/csv.ts` survives the column's removal because it does two jobs that are about
    reading the host's file, not storing anything from it: a phone-shaped cell in row 1 proves row 1
    is data rather than column names (without it a headerless `Name,Phone` paste has its first guest
    eaten as a header), and a phone column must resolve to **`ignore`** so an ordinary
    `Name,Email,Phone` spreadsheet still pastes cleanly and a column of digits is never mistaken for
    a column of names. Header labels are caught by `SKIP_HINTS`, values by `CellKind` `'phone'`
    being a kind no field claims.
  - A host who wants the digits kept can point that column at `notes` in the mapper. That is their
    call; guessing it for them is not.
  - `readMapping()` keeps `'phone'` out of `valid`, so an older client that still posts it has that
    column coerced to `'ignore'` by the same rule as any other unrecognised value — the import
    succeeds, the numbers are skipped.
  - **`identityKey()` is GONE, and that is the point of requiring an email** (below). It was the
    duplicate check for guests with no address — name + note, after the phone column went — and it
    carried a genuine trade-off about two real guests called "John Smith". With an address on every
    row it had nothing left to match, so it was removed along with `buildImport`'s `existingKeys`
    parameter rather than left as dead weight. Do not reintroduce a second identity: dedupe is the
    unique index on `(event_id, lower(btrim(email)))`, and the preview keys on the same thing the
    database does.
- **AN EMAIL ADDRESS IS REQUIRED ON A GUEST LIST ENTRY** (`0054_guest_email_required.sql`; `email`
  is `NOT NULL`). The scope decision behind it, from the owner: *"we're not an invitation service,
  there's really no need for us to have contact information for anyone without an email… the host
  will need to print cards or directly message the people they don't have an email for."* The list
  exists to mail a lot of people one link; a row nothing can be sent to is a row that shows up in
  "who have I invited?" having never been reachable.
  - **The refusal has to be VISIBLE and COUNTED, or this is a worse feature, not a stricter one.**
    `buildImport` makes a row with no address a `'skip'` with `'No email address — skipped'` on it,
    and `ImportPlan.counts.noEmail` is broken out from `counts.skip` on purpose: it is the one skip
    reason a host can act on, so it gets its own word in the tally rather than being lumped in with
    blank lines and duplicates. A host pasting a sheet where half the rows have no address must SEE
    that number.
  - A **malformed** address is skipped too, but counted as `invalid`, not `noEmail` — it used to be
    imported without the address. The two need different things done about them: a typo is fixed in
    the file, a missing address means that guest gets a printed card.
  - **No email column mapped at all ⇒ one `fatal`**, not a page of identical grey rows, and the
    preview keeps the mapper on screen beside it (a message that asks for a control renders that
    control).
  - The web copy says it once, in the host's terms: *"Email is required — anyone you haven't got an
    address for needs a printed card."* `GuestList.svelte`'s `NEEDS_EMAIL` mirrors the server's own
    400 from `cleanGuest()` so the blocked press answers without a round trip — change both.
  - The migration **deletes** any row with a null email before `SET NOT NULL`, which is safe because
    no released version has this table: `event_guests` ships new in 1.5.0 (created by `0047`) and
    production is on 1.4.3 at `0038`, verified read-only. Rehearsed by restoring a production
    `pg_dump` into a scratch database and running `0039 … 0054` over it, then again with a
    violating row inserted by hand.
- **THE GUEST-LIST UNIQUE INDEX IS CASE-FOLDED, AND THAT IS THE DATABASE'S RULE RATHER THAN THE
  WRITER'S** (`idx_event_guests_event_email` on `(event_id, lower(btrim(email)))`, migration
  **`0055_guest_email_case_fold.sql`**). `0047` keyed it on the raw column and said so on purpose —
  the writer lower-cases and trims on the way in, so byte equality was enough. It still does, and
  it still should. What did not hold up is treating that discipline **as** the constraint: going
  round `normaliseAddress()` with a plain `INSERT` put `MUM@Example.COM` and `mum@example.com` on
  one event as **two rows**, which is precisely the duplicate the index exists to refuse.
  - **This overrides a documented decision deliberately.** The rest of the schema had already gone
    the other way twice and the guest list was the straggler: `participants` on
    `(event_id, lower(email))` since **0031**, `share_sends` on `lower(btrim(email))` since
    **0052**. Three address-keyed tables with two different answers is a rule a reader has to look
    up per table. An index that only holds while every present and future writer remembers a
    `toLowerCase()` is a convention with an index standing next to it.
  - **It costs no query plan**, which is the half of 0047's reasoning that turned out not to apply:
    *nothing reads this table by email*. Every read filters on `event_id` or on `id` — `listPayload`,
    the import's existing-address scan, the send's row fetch, `unsubscribe.ts`'s join on `guest_id`.
    The index has only ever been a rule, never a lookup path.
  - **The migration dedupes FIRST**, the way `0051` and `0052` do, because the new key is *stricter*
    than the old one and a unique index cannot be built over rows that violate it. **The earliest
    row survives** — the row the host's list has been showing all along, and the one the product's
    own duplicate rule already preserves (a second add is refused, so the first one stays);
    `created_at, id`, because a batch import shares one timestamp. **The invites are re-pointed to
    the survivor before the delete** rather than being cut loose by `ON DELETE SET NULL`: a case
    collision is one person, so "Mum bounced" has to stay attached to Mum.
  - Rehearsed both ways. Against a production `pg_dump` restored into a scratch database, `0039 …
    0055` runs clean and 0055 is a **no-op** (`event_guests` ships new in 1.5.0; prod is on 1.4.3 at
    `0038`, `to_regclass('event_guests') IS NOT NULL` → `f`). Against a second scratch database put
    back to 0047's byte-exact index and hand-loaded with collisions, six guest rows across three
    spellings of one inbox collapsed to three, all six invites kept a guest, none detached.
- **A `catch` around a write must say WHICH refusal it caught** (`pgErrorCode`, `PG_UNIQUE_VIOLATION`,
  `PG_NOT_NULL_VIOLATION` in `app/src/server/db.ts`). `POST /:joinCode/guests` caught everything and
  answered *"That email is already on this guest list"*, on the stated grounds that the unique index
  was the only thing that could fail — true when it was written, and untrue from `0054`, which made
  `email` NOT NULL. A null address therefore came back to the host as a duplicate, sending them to
  hunt for a guest who is not there. `cleanGuest()` refuses a missing address first so it was never
  reachable; a second line of defence that answers the *wrong* thing is worth no more than one that
  answers nothing. The `PATCH` route carried the same assumption and got the same fix; the import
  commit did not — it uses `onConflictDoNothing()` and no `catch`, so a fault there is a fault.
  - **Discriminate on the SQLSTATE, never on the message or the constraint name.** The message is
    the server's own prose in the operator's locale and version; the constraint name belongs to
    whichever migration last touched it (this one just renamed nothing and rebuilt it); the
    five-character code is in the standard.
  - **The code is NOT on the error you catch.** Drizzle wraps every driver failure in a
    `DrizzleQueryError` carrying the query and params, and the node-postgres `DatabaseError` holding
    `.code` is its `cause` — so `(e as { code?: string }).code` reads `undefined` and every
    comparison against it is quietly false. `pgErrorCode` walks the cause chain, and
    `__tests__/db-errors.test.ts` pins that with the real wrapped shapes; a test built on a bare
    `{ code }` object would pass against the broken version.
  - **Anything that is not one of the two handled codes is rethrown**, so a dead database is a 500
    in the log rather than a 409 the host can do nothing about.
- **Delivery status wording is duplicated on purpose.** `GuestList.svelte`'s `label()` mirrors
  `describe()` in `app/src/server/delivery.ts` — three lines of words are not worth a round trip —
  but the server copy is the one under test, so change both.
- **The email allowance** (`MAILGUN_MONTHLY_LIMIT`, `MAILGUN_BUDGET_WARN_PCT`) puts a month-to-date
  send count in the daily ops digest. `email-budget.ts` derives it from `guest_invites` +
  `share_sends` rather than keeping a counter of its own, which makes it a **floor** rather than an
  exact number; the month is a **UTC** one to match Mailgun's clock rather than `OPS_TZ`; and it
  reports, never blocks. Full reasoning in `UPGRADING.md` → 1.5.0.
- **Google sign-in (optional)** — set `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` to show the Google
  button. Create them at <https://console.cloud.google.com/apis/credentials> (OAuth client ID → "Web
  application"); the **Authorised redirect URI must be `<BASE_URL>/api/auth/google/callback`** and
  match `BASE_URL` exactly. CSRF `state` is handled automatically. Both unset ⇒ button hidden.
- **Social share image** — `web/static/og.png` is generated by `app/src/scripts/make-og.mjs` (needs
  the fonts baked into `Dockerfile.dev`). See that script's header to regenerate.
- **Capacity / load testing** — uploads are the CPU-bound ceiling; see `loadtest/CAPACITY.md` and
  `npm run test:load` / `npm run test:load:multi`.
- **Trick list** — a shot list a host gives guests, printed on cards and ticked off in the app.
  (Named "photo missions" while it was built; the ids and columns still say `challenge`.)
  - **The event TYPE is asked at creation** (`/app`, step 1, optional), not discovered later, because
    four separate things key off it: which mission pack is offered, the default tick glyph
    (`tickFor`), the card's default decoration (`decorFor`), and which poster design the gallery puts
    first (`presetForEventType`). One vocabulary — the pack keys in `EVENT_TYPES` — and never a
    second one invented alongside it. Until it was asked up front, every new event silently took the
    generic fallback. It stays editable in the trick-list editor, and `null` is a valid answer.
  - Content lives in `web/src/lib/challenges.ts`: 9 packs (the 8 use-case types + a `general`
    default) × 24 challenges, each tagged with one or more **moods** that drive the quick-pick
    buttons. Ids are **stable for the life of the product** — they are stored on photos and counted
    to rank packs, so renaming one silently rewrites history. Add a new id instead.
  - An event can carry **1–8 sets**. A guest is handed exactly one and keeps it (`participants
    .challenge_set`), so different tables hunt for different things. Assignment is **round-robin,
    not random** — several sets exist for even coverage and random clusters. `varySets()` gives every
    card the same **core** from the front of the pack, because picking each card independently puts
    the must-have shots on one card out of six.
  - A printed card's QR carries `?set=<key>`, validated server-side against the event's own sets
    before it is encoded — a typo there would be printed onto every card before anyone noticed.
  - **`challenge_set_source` (migration 0049) is a label, not a claim, and `'qr'` is not
    authenticated.** `?set=` is a query parameter on a page the guest's *browser* loads; the join
    call is a `POST /api/participants` that carries no query string, so only the guest's own
    JavaScript can move the key between them (`Camera.svelte` → `joinEvent`). By the time it reaches
    `assignSetWithSource()` a scanned card and a hand-written `{"set":"a"}` are the same request, and
    reading `req.query` instead would break every card already printed. That is acceptable because
    **`'qr'` and `'self'` are one state everywhere they are read** — `resolveSetChoice()` locks on
    `source !== 'pending'` and nothing compares the two — so the forged path ends at exactly the card
    an honest guest reaches by answering the "which card are you?" prompt. There is no fairness
    advantage to take. If provenance ever has to be trustworthy it needs a per-card secret in the QR,
    which is a new column and a new print format, and can only apply to cards printed after it ships.
  - **Progress is derived, never stored**: "how far through is this guest" is a count over
    `photos.challenge_id`, so deleting a photo un-ticks its mission and there is no second copy of
    the truth to drift. Do not add a completions table.
  - The server holds **no opinion on the wording** (`app/src/server/challenges.ts` validates shape
    only) because a host can write their own, and stores the host's text rather than resolving an id
    at read time — a printed card cannot be updated, so improving our wording later must not
    silently disagree with the card on the table.
  - **A trick is a PHOTO.** Every challenge ships worded as a still, the stored shape is
    `{id,text}` with no notion of a clip, and the tension the feature runs on is that a roll is
    finite — spending one of a fixed number of shots is a real decision. A clip is a different
    currency and one of them plausibly contains several tricks at once. The SERVER drops
    `challengeId` on a video (`98d-tricks-are-photos.mjs`); the camera hiding the option is a
    courtesy, not the enforcement.
  - `videoSeconds: 0` events must not be offered clip prompts; `pickChallenges({allowVideo:false})`
    strips them and can still fill the maximum for every pack and mood.
  - Guest UI is one pill in the camera topbar (`Camera.svelte`) opening a sheet — the camera has to
    stay a camera. Note `.topbar` is `pointer-events: none`, so anything tappable in there must opt
    back in. The pill shows only the count: it used to lead with the event's tick glyph, which as a
    bare outline circle read as a stray mark rather than an icon. The glyph still bullets each item
    inside the sheet, which is where it means something.
  - **The tick is optimistic, and it is taken back if it has to be.** Confetti and the tick fire in
    `enqueue()`, at the shutter — not in the upload handler where they started. By that line the
    shot is in the queue and on its way into IndexedDB, so the trick really is pulled off; waiting
    on the network made a finished thing feel like the app lagging behind the guest, worst exactly
    where connections are worst. `untickMission()` reverses it on a terminal upload failure, because
    progress is DERIVED from the photos table and a reload would otherwise disagree with the screen.
    A capture restored from the offline queue in a later session ticks quietly — there is no shutter
    moment to celebrate. `Confetti.svelte` honours `prefers-reduced-motion`.
  - **Camera fallbacks must keep the lens.** A bare `video: true` drops `facingMode` as well as
    `deviceId`, so a failed switch to video handed the guest their front camera back. A chosen lens
    also gets a second attempt with NO resolution ask before being abandoned: a secondary lens
    (ultra-wide, telephoto) tops out below the main sensor and some Android stacks answer that
    pairing with `OverconstrainedError` rather than a smaller frame. When a lens still cannot be
    opened the picker SAYS so — `refreshCameras()` re-syncs the dropdown to what was really
    acquired, and that silent snap-back is what "this option does nothing" actually was.
  - **The microphone differential runs on ANY failure, not just a denial.** A mic that is permitted
    but unavailable throws `NotReadableError` (another tab or app holds it), and gating the
    diagnosis on `NotAllowedError` sent exactly those guests a message about permission they had
    already granted. The `DOMException` name is reported to `client_errors` so this stops being
    guesswork.
  - A **tick glyph** per event (`events.challenge_tick`) is what a guest and a printed card mark
    off with — a heart for a wedding, a bottle for a baby shower. The event type only sets the
    *default*; the host can pick any of the offered glyphs or type their own, so `parseTick` keeps
    a short free-text value rather than an enum.
  - A set's **label** is the host's, not ours. The backend stores the key (`a`, `b`, …) and the
    label beside it, so "Golden oldies" can be renamed without moving anyone between sets. The
    field only appears once there are two sets, because a lone card's name is never printed.
  - The count defaults to **5** and goes to 20. It is the host's call, not a rule: `setCount()`
    tops up from the pack or trims the tail rather than refusing, so the number field and the
    ticked list can never disagree.
  - Cards print from the poster designer: **4-up A6, 2-up A5 or 1-up A4**, one sheet per set, with
    the corner radius following the choice (square corners exist because a guillotine cannot round
    them). Paper scale is **height-based, not area-based** — an A5 half sheet is the same height as
    an A6, so scaling it by √2 blew the QR up and squeezed the list.
  - **`CARD_GAP` is 0: the cards bleed to the cut line.** It was 10 (≈2mm a side) to give scissors
    somewhere to go, which is the wrong way round — with a gutter, a cut a millimetre off centre
    takes a white sliver off one card *and* slices into the art of its neighbour, so the error shows
    on both. Bleeding means an off cut only moves where the border sits. `CARD_PAD` is untouched:
    that is quiet space around the WORDS, a typographic decision with nothing to do with cutting.
  - **Cut guides are a toggle** (`cardCutLines`, default on), drawn only along tile boundaries — a
    1-up sheet has nothing to cut, so it gets none.
  - Card identifiers can be turned **off** so a host shuffles the stack and hands them out at
    random; the QR still carries its own `?set=`, so a shuffled card is still the right card.
  - `cardSkip` stores **exclusions**, not inclusions, so a set added later prints by default.
  - Decorations (`web/src/lib/cardDecor.ts`) are drawn vector, no assets and no requests, before
    the content so text always sits on top. Confetti is **seeded** or it shimmers between redraws.

- **The poster designer** — `web/src/lib/components/PosterModal.svelte` (the editor),
  `PosterWizard.svelte` (the design gallery), `PosterPalette.svelte` (the image swatch strip),
  `posterRender.ts` (every drawing primitive), `posterPresets.ts` (the eight designs),
  `posterFonts.ts` (typography), `cardDecor.ts` (motifs), `cardRender.ts` (the trick-card sheet),
  `posterFlow.ts` (the steps, the tabs and the flow rules), `paper.ts` (paper sizes and export
  resolution).

- **Paper size is an EXPORT decision, not a design one** (`web/src/lib/paper.ts`). Every ISO A size
  is 1:√2, and the poster's design space (1080×1527) is that ratio to within 0.02%, so a design is
  byte-identical between A6 and A2 — only the number of pixels it is rasterised to changes. That is
  the whole reason the file is small, and the reason the size control lives on the Print tab beside
  the buttons that use it rather than in the design steps.
  - `exportWidthPx()` honours two caps that are **canvas ceilings, not quality ones**:
    `MAX_EXPORT_PX` (16M) and `MAX_EXPORT_EDGE` (4096). A2 at 300dpi is 4961×7016 — 35 megapixels,
    ~139MB of backing store — and iOS Safari refuses a canvas over roughly 16.7 megapixels by
    returning a **blank** one, with no error. Without the cap, "export an A2" is a silently empty
    PDF on every iPhone.
  - What the caps cost: A4 and below still resolve the full 300dpi, A3 ≈288 and A2 ≈203 — all well
    above the ~131dpi the old fixed export produced at A4, which is the bar this had to clear.
  - `effectiveDpi()` exists so the UI can state the honest number *after* the caps. Print resolution
    is the one property of an export a host cannot check until it is on paper.
  - **One control per setting, and a colour belongs beside the thing it colours.** The designer
    shipped two controls for six of its eight text colours: a swatch on each text field, AND a flat
    "Text colours" list of all eight on the Background step. The host found it — "why do we have a
    colour picked on the 5th page for the words when the words tab has a colour picker". It was
    worse than a guided-mode wart: every block in this modal is gated `{#if !pGuided || pStep ===
    N}`, so in **Show all controls** every step renders at once and both copies were on screen
    together — which means "keep the flat list for that mode" is not a home for it, it is the same
    defect. The list is gone. `POSTER_COLOR_STEP` in `posterFlow.ts` is now the single table of
    where each colour lives: Words owns the six that colour words, Join owns `code` and `footer`
    beside the switches that print them, and the Background step owns no colour but the paper —
    which is why it is called **Paper** now and no longer asks "what colours?".
    `colorRowsForStep()` and `aimedColorTarget()` are read by the swatch strip's label, by the
    target it writes to, and by the re-point that stops it writing somewhere off screen.
    `PosterModal.colors.test.ts` asserts on the template itself, because which dot is written where
    is a fact about the markup and no test of the helpers can watch the duplication come back.
  - **Deleting a duplicate means rehoming whatever only it carried.** The flat list was
    load-bearing for two things: the image-palette swatches worked only because each of its rows
    pointed `activeTarget` at itself `on:focus`, and it held the `colorsLocked` reset. So the dots
    got that focus handler (`aimAt`, one shared handler rather than the same inline arrow twelve
    times), the strip became `PosterPalette.svelte` so it could be used from three places without
    being copied, and the reset moved to Words. A `{#if pGuided}` gate on the Join copy of the strip
    is what keeps it off the Show-all screen, where the Words copy is already rendered.
  - **`.fc-dot` needs its parent in the selector.** `.fc-row > input.fc-dot` and
    `.chk > input.fc-dot` are a selector list, not two copies of the rules: a bare `.fc-dot` is one
    class and loses to `.fld input` (one class plus one element), and losing means inheriting
    `width: 100%` — a 445px colour bar squeezing the text field down to 22px. Measured; that
    shipped once.
  - **The renderer is shared, and that is the point.** `drawPoster()` was pulled out of the modal so
    the gallery's thumbnails could be drawn by the *same* function with the event's own name,
    message and QR. A gallery of approximations would be asking a host to choose from something they
    are not going to get.
  - **A preset IS a saved poster config** — the same object shape `events.poster_config` already
    holds, handed to the modal as `initialConfig` and applied by the existing `restore()`. No
    parallel format to keep in step. It deliberately omits `headline`/`message`/`stepsText`, because
    `restore()` reads every field with `??`: picking a style must never eat the host's words. Every
    preset sets `colorsLocked: true`, or the next reactive pass recomputes text colours from the
    theme and quietly overwrites the palette.
  - Each preset also carries a **screen** palette for the guest-facing app, NOT derived from the
    poster's colours. A poster palette is for print — light stock, dark ink; the app is dark-first
    and lit from behind. Botanical's cream as an app background reads as the lights coming on, not
    as the same design. Same character, different values.
  - Poster typography (`posterFonts.ts`) picks from five bundled pairings. The faces are
    self-hosted in `web/static/fonts` (five OFL 1.1 families, latin woff2, ~169KB) and declared in
    `app.css` but used by **no selector**, so nothing downloads until a pairing is asked for.
    **`ctx.font` falls back silently** — a canvas will happily print in Arial and never say so — so
    `drawPoster()` awaits `ensurePosterFonts()` before it paints anything. Nothing may draw ahead of
    that: the poster is exported as a PNG the host takes to a printer, not a preview they can
    re-render. `plain` is the default, which is what keeps a design saved before this existed
    opening exactly as its host left it.
  - Canvas `letterSpacing` is **sticky state**, like `fillStyle`. A tracked headline will space out
    the join code drawn after it unless the tracking is actively cleared, which is why every face
    sets it (to `0px` when it wants none) rather than only setting it when it has some.
  - The headline is up to **three rows in two faces** but exactly **one draggable box**. The
    designer measures it through the renderer's own `measureTitleBlock()` rather than keeping a
    second guess — a handle sized from a different measurement is a handle that does not sit on the
    text.
  - **The renderer owns glyph geometry. Never keep a second guess at it.** This is a recurring class
    of bug in `PosterModal.svelte`, and it has now been found three times: the title (fixed by
    `measureTitleBlock`), the name lockup (`measureNames`), and then the message and the how-to line,
    which the designer was still measuring itself — in Helvetica, at the box's own size, with no
    tracking and no casing — while the renderer set them in the host's chosen **body face**. That
    face is tracked up to 0.14em, usually upper-cased, scaled 0.90–1.06 and on its own line height up
    to 1.45, so the measurement was right on `plain` and wrong on the other four pairings. Measured
    in Chromium against the real woff2 files: the how-to outline came out **221px narrower** than its
    own text in Editorial, the message wrapped to two lines where the renderer drew three, and
    Garden's was 31px too **wide** — both directions, which is why the report was "*some* of the
    text". The rule, concretely:
    - one function turns a string + a face + a wrap width into geometry (`facedBlock`), and both the
      draw path and the measure path call it. Not "the same maths in two places";
    - a wrap width, a font shorthand or a shrink loop written twice is the same defect one step
      earlier — hence `BODY_MAX_W`, `TEXT_ITEM_MAX_W`, `FOOTER_FONT`, `brandFont()` and `fitted()`,
      each of which existed as two or three copies before;
    - measurement must run through `applyFace()` too, so it picks up tracking and casing, and must
      `clearTracking()` after itself. Seven elements are measured in a row on one shared offscreen
      canvas, and `letterSpacing` is sticky (see above) — one leak corrupts every later measurement;
    - **and it must wait for the fonts.** `measureCtx()` is a bare offscreen canvas that cannot
      await a face, so `ctx.font` silently falls back to Arial and the outlines are measured for a
      typeface the poster will not be set in. `PosterModal` carries a `fontsReady` flag, flipped when
      `warmAllPosterFonts()` resolves and **named in the `bounds` reactive statement**, so every
      outline is recomputed the moment the real metrics exist.
    `posterRender.test.ts` pins this by running the real `drawPoster()` against a recording context
    and asserting the measured rect equals the widest line it actually drew, for every one of the
    five pairings. Reinstating the old measurement fails 14 of those tests and passes the three
    `plain` ones — which is exactly the shape of the original report.
    - **Rotation is the fourth thing this rule covers.** An element's `rot` turns it about its own
      anchor, and the hit box and the selection outline are `rotatedRect()` **from the renderer**,
      applied as one line (`turned()`) at the end of every bounds function. There is no `Math.cos`
      anywhere in `PosterModal.svelte` and `PosterModal.rotate.test.ts` asserts there is not. An
      axis-aligned hull is the honest answer for a hit box — the drag code speaks in rects, for its
      snap lines, its print-margin clamp and the element's own `left/top/width/height` — and a hull
      is what the element is *inside*; the quad would be a second geometry for every one of those to
      learn.
  - **`rot` is radians, optional, and upright is spelled ABSENT.** The placed decorations have
    stored exactly this since they were added (`DecorPlacement.rot`, drawn by `drawDecorAt`), so the
    text and the host's own lines extend that one vocabulary rather than inventing a second,
    degrees-based one. Degrees exist in two places only: `snapAngle()` in `$lib/posterFlow`, and the
    label on a control. Two consequences that are not cosmetic:
    - `rot: 0` and no `rot` render the same and do **not** serialise the same, and `cfg` is what the
      history watcher compares and what `persist()` saves. `withRot()` deletes the key at zero, the
      way `readTextItem()` already does for a line's colour — otherwise a design turned and put back
      upright reads as an edit, which sets `designEdited` and unlocks every export on it;
    - `snapAngle()` folds `+180` onto `−180` and `−0` onto `0` for the same reason: one angle, one
      name, or two identical designs compare as different and push a phantom undo step.
    - `canRotate()` holds which elements turn, with the reasoning. The **QR** is refused outright
      rather than limited to 90° steps: a scanner finds a code's own orientation before decoding, so
      it buys nothing, while the join code printed in the panel's lower strip would come out sideways
      and `qrKeepOut()` would go onto a diagonal. The **mark** is refused because it is ours, not the
      host's — it has no resize grip either.
  - **The QR's quiet zone is baked into the PNG, so the panel is not the keep-out.** The server
    generates the code with `{ margin: 4, errorCorrectionLevel: 'H' }`
    (`app/src/server/routes/events.ts`), so the four modules ISO 18004 asks for travel *inside* the
    image. `qrPanelRect` adds 45px all round plus up to 195px of strip for the code or URL — spare
    margin, not symbology. Host-placed motifs therefore draw **over** the panel (they used to draw
    before it and simply vanish under the white rect, which looked like the control not working) and
    are clipped only out of `qrImageRect`. Three details that were each found by measuring:
    - the clip rect is `qrKeepOut()`, the image rect rounded **outward to whole pixels**. The QR's
      rect lands on fractional coordinates, and a clip edge falling mid-pixel is antialiased: before
      the rounding, a motif straddling the code's corner put **nine pixels** of ink on the bottom row
      of the symbol;
    - the clip is applied **only when a motif could actually reach the code** (`decorReach()` in
      `cardDecor.ts`, so the sizing is not copied). A clip is not free where it excludes nothing — it
      puts the strokes through a different rasterisation, and measured in Chromium that moved 872
      antialiased pixels of a motif at the *top* of the page by up to 6/255. Invisible, and still a
      change to a design nobody edited;
    - the code and the URL are drawn **after** the motifs (`drawQrCaption`, split out of
      `drawQrPanel` for exactly this). That strip is not quiet zone, so a motif may reach it — it
      simply may not be on top of words a guest has to read off a wall, which is the rule the rest of
      the poster already follows.
  - **The card orientation control means the CARD; what is stored is the SHEET.** `cardSheetLandscape`
    sets the paper, and the paper's orientation is the card's at 4-up and at 1-up and its **opposite**
    at 2-up — two A5s side by side on a landscape A4 are each portrait, necessarily. So one toggle
    meant "card orientation" for two sizes and the reverse for the third. The fix is entirely at the
    UI layer, which is the low-risk half: `cardLandscapeOn()` / `sheetLandscapeFor()` (one mapping,
    used both ways, because a flip is its own inverse) read and write the stored field, and
    `cardGrid()` reproduces the old pair of inline ternaries exactly. Two things this must not break,
    both pinned in `PosterModal.cards.test.ts`:
    - `@page { size: A4 … }` and the jsPDF orientation still receive the **sheet**;
    - nothing writes `cardSheetLandscape` from a reactive statement. `setCardsPerSheet()` keeps the
      host's chosen card shape by turning the paper, and it is a **click handler** — a `$:` keyed on
      `cardsPerSheet` fires once on mount and would rewrite the stored orientation of every saved
      design the moment it opened, for a design that may already be printed.
  - **The trick cards are one design by default and can be one per card.** `cardOneDesign` (on) and
    `cardSets` (a map of overrides) are new; the four colour scalars and `cardLayout` are **Card A's**
    design and, while the toggle is on, everyone's. The shape is the codebase's usual *absent means
    inherit*: the first card IS the base and cannot have an entry, any other card with no entry
    follows it, and "↺ Same as Card A" **deletes** the entry rather than copying values across — a
    copy would look identical and then stop tracking. `cardLookFor()` in `$lib/posterFlow` is the
    rule, and it returns `base` **itself** (`toBe`, not `toEqual`) whenever the answer is the shared
    one, which is what makes "a saved design renders identically" a property of the code rather than
    a hope about arithmetic. Two traps:
    - **a sheet must be painted from its own set, not from the previewed one.** `drawSheet()` lays
      out a page per set, so `drawCard()` takes `cardPaintFor(set)` and `titleGeom`/`joinGeom` take
      the set too. A draw site left reading the reactive `cardInk` prints the whole stack in whatever
      was last on screen;
    - **every write goes through `patchCardDesign()`**, which is the one place that decides *which*
      card is being edited. A control left assigning `cardCTitle` directly edits Card A while the
      host is looking at Card B. The test counts the assignments and allows them only in the writer,
      `restore()` and `applyCfg()`.
  - **Proving a saved design still renders identically.** Canvas `toDataURL` hashes in real headless
    Chromium (`playwright-core`, the real bundled woff2), across all five typefaces × three
    code/URL modes × panel on and off, plus a fully decorated design and a stripped one: 34 designs,
    before and after, byte for byte. The baseline is the **working tree before the change**, not
    `HEAD` — this branch carries other uncommitted work, and comparing against `HEAD` reported all 32
    designs as changed because the wordmark's default position had moved in that other work. A second
    pass compares the two builds' pixels in one browser, which turns "the hash differs" into "872
    pixels, max channel delta 6, inside the motif's own box" — the difference between a rendering
    change and a rasterisation one.
  - **The guided flows are one design, written three times** — the event wizard (`app/+page.svelte`),
    the poster tab and the trick-cards tab (both in `PosterModal.svelte`). The owner's standing
    complaint is surfaces that do not match each other, so a change to one is a change to all three:
    Next is `btn primary grow`, Back is `btn ghost`, the refusal is `aria-disabled` (never
    `disabled` — a disabled button consumes no events, so on a phone the tap reaches the text
    underneath and the browser throws its own Copy/Search menu over the app), and a blocked Next
    **says what is missing in its label** and takes the press to whatever is blocking it. A `title`
    tooltip does not count: there is no hover on a phone, and the phone is where these flows are
    used. The cards tab deliberately has no precondition to state (`C_CAN_ADVANCE = true` — the card
    title falls back to the poster headline, then the event name) and inventing one for symmetry
    would be a dead end.
  - **A flex-basis fix in a nav row depends on rule ORDER, and it silently did not apply.**
    `.pnav .grow { flex: 2 1 0 }` was written *before* `.pnav > .seg { flex: 1 1 0 }`. Both are
    (0,2,0), so the later rule won and Next was handed an equal share of the row rather than twice
    the share — the documented fix was in the file and dead. Sibling trap to the `.btn` specificity
    note in `app.css`: the same class of failure, one where a global rule loses and one where the
    earlier of two equal rules loses. `PosterModal.nav.test.ts` asserts the order, not just the
    presence.
  - `readableOn()` walks a colour's own lightness until it clears the WCAG bar rather than
    flipping to black — a gold title on white goes darker gold. The join code is drawn on the QR
    panel's **white**, so it needs contrast against that, not against the poster background.
  - **The QR panel is dropped on a MEASUREMENT, not on taste.** `symbolContrast()` is Rmax − Rmin in
    reflectance and `panelOptional()` clears it at grade C (40) — the floor a code is expected to
    read at in the wild, which is exactly what this is: read once, in bad light, by a stranger
    holding a phone at an angle. A photographic background is not measurable this way at all (the
    code could land on sky or on a dark suit), so over an image the panel stays, full stop. And a
    design saved on one background and reopened on another turns the panel back on by itself rather
    than waiting to be noticed.
  - **Placed decorations and custom text lines are lists**, not a spare slot each. `decorItems`
    (kind, x, y, scale, rot) and `textItems` (text, x, y, size) go through the same drag surface as
    the fixed elements, keyed `decor:<i>` / `text:<i>`. `DECOR_PX` is the one number converting the
    drag system's pixels to a placement's scale — keep it single. The PLACE tool's `placeKind` is
    deliberately separate from the design's `decorKind`: they used to share one value, so choosing
    what to add destroyed the decoration you already had.
  - **The card sheet's orientation applies at every card count**, not only 2-up. Turning the paper
    turns every card on it, and `sheetOrientation` is passed to the print/PDF path — a landscape
    sheet sent to a portrait page is letterboxed at half size with nothing on screen warning of it.
  - Paper scale is **height-based, not area-based** (see the trick-card notes above).
  - **Never truncate `poster_config`.** It used to be `.slice(0, 4000)`, and the organizer payload
    parses that column on every load — JSON cut mid-string is a syntax error, so one oversized
    design would have 500'd the event page permanently. Saving now refuses (413) and reading is
    defensive, so a row that is already bad reads as "no design" instead of locking the host out.

- **Event palettes, and the custom one** — `web/src/lib/theme.ts` (the palettes we ship, the apply
  path and the contrast guard), `web/src/lib/palette.ts` (the maths that invents one),
  `web/src/lib/components/PaletteModal.svelte` (the picker), wired from the Theme card in
  `web/src/routes/admin/[code]/+page.svelte`.
  - **The picker's two columns are DERIVED, not listed.** The Theme card asks `isLightBg()` — the
    same function `applyEventTheme` uses to decide the chrome — which column each palette belongs
    in. A hand-kept list would be a second place to update, and the day the two disagreed the card
    would file a palette under "Dark" and then render the event light. Add one to `THEME_PRESETS`
    and it sorts itself. The swatch markup is written once and the grouping is data, so the two
    columns cannot drift apart either.
  - **A section's icon and its name are ONE entry.** `SECTION_META` holds `{ icon, title }` per
    section and is read by both the hub tile and the bar you land on, for the reason the title was
    already shared: a host taps a picture and should arrive somewhere carrying that picture, not a
    bar of words they have to re-read. Poster keeps its icon inline because Poster is not a section.
  - **An emoji used as an ICON needs U+FE0F, or desktop draws it in ink.** Roughly a hundred emoji
    default to TEXT presentation (`Emoji_Presentation=No`) — ⚙, ⬆, 🗜, 🎛 among them. A phone
    colours them in anyway; a desktop browser renders a monochrome glyph, or tofu where the font has
    no outline. In a row of eight tile icons that reads as one broken tile, which is exactly how it
    was reported. `🎛` on the Controls tile and `🗜` on the zip option both lacked it, while `⚙️`
    beside them always had it. The rule is only about icons: the many bare `♥ ⚠ ↩ ↗ ▶ ©` in labels
    and prose are deliberately typographic — they inherit `color`, and forcing emoji presentation on
    them would turn a warning caret into a yellow sign. `emojiPresentation.test.ts` covers the icon
    slots; add a slot to it when you add one.
  - **One image, several crops — the original is kept.** The editor used to upload the cropped canvas
    and throw the original away, which made "move it a bit" impossible: there was nothing left to
    reposition. A theme now carries three things — `headerImage` (the rendered 3:4 crop every reader
    already uses: join screen, gallery hero, OG card, slideshow), `imageOriginal` (the untouched
    upload) and `imageCrop` (`"sx,sy,sw,sh"` in the original's own 0–1 coordinates, a STRING so the
    theme column stays the flat map it has always been). All three optional; an event that predates
    them renders exactly as before, and the Reposition button only appears when there is an original
    to re-cut. `applyCrop()` and `cropRect()` in EventImageEditor must stay exact inverses — a reopen
    that lands anywhere but where the host left it silently changes a picture they were happy with.
    The poster takes its own crop of the same original at 1:√2 and stores the result as its own
    background, so the canvas renderer never learns about crop maths.
    The editor's zoom goes BELOW cover (`MIN_ZOOM`), and the gap fills with a blurred copy that is
    baked into the exported JPEG — a flat JPEG has no transparency, so a crop with gaps would be
    black in the gallery hero, the OG card and the slideshow alike.
  - **Cleanup walks the JSON for `/uploads/` paths** rather than unlinking a hand-listed key. It was
    `theme.headerImage` and nothing else, which was right while that was the only file a theme owned;
    it is now one of several. A list of keys here goes stale silently and the symptom — orphaned
    files in a dead event's folder — is one nobody ever sees.
  - **A poster logo is a DecorPlacement with a `url`.** `'logo'` is in the `DecorKind` union but
    deliberately NOT in `DECOR_KINDS`, so `drawDecorAt` (pure vector geometry, shared with the card
    renderer) declines it and the poster renderer paints the image instead. That one decision buys
    the whole feature: drag, resize, rotate, the control cluster, the Placed list and the bin all
    work already. It draws last and OUTSIDE the QR keep-out — that clip stops decoration WE chose
    from wandering over the code; a logo goes where the host put it. The aspect ratio is measured in
    the browser before upload and stored, so the hit box is the shape of the mark on the first frame
    rather than a square until the file loads. Uploaded via `?kind=logo`, which re-encodes to PNG
    with alpha (the scrub is the re-encode, not the format) — the JPEG path would flatten a cut-out
    to a black box.
  - **The heart is drawn, the trick tick is not.** `HeartIcon.svelte` replaces `♥`/`♡` wherever the
    product means "liked": those are typographic hearts drawn by whatever font the device picks, so
    the same control was a different shape on every phone. The trick-list tick is the ONE exception
    and must stay a character — it is the host's choice out of a set, and it is printed on posters
    and cards by canvas `fillText`, which can draw a character and cannot draw a component.
  - **Double tap is one prop, two meanings.** `PhotoCard.doubleTap: 'heart' | 'favourite' | 'none'` —
    guests heart, the host's review grid favourites, select mode switches it off (which also removes
    the single-tap delay, because there a tap means "pick this"). It only ever ADDS: a mistimed
    second tap silently undoing a mark is worse than doing nothing. The review grid shows heart
    COUNTS only — the endpoint attributes a heart to a participant and a host reviewing is not one.
  - **Sorting by hearts lives in `photoSort.ts` because of the TIE-BREAK.** Most photos at a real
    event share the same small count, so a sort on the count alone leaves most of the grid in
    whatever order the array happened to be in — which is not stable between loads. It falls back to
    newest-first, and never sorts in place (the download scope reads the same array).
  - **The review page's single view has ONE way in.** Entering it is two halves — the view, and the
    `pushState` entry that Back pops — and a reactive mirror of `$page.state` used to enforce the
    pair. That store does not update synchronously with `pushState`, so the guard could read stale
    state and bounce the view straight back: the header's Single button did nothing at all, while
    opening a photo worked purely because that path arrives on a timer and lands in a later flush.
    The mirror is gone; `<svelte:window on:popstate>` is the whole mechanism. `reviewSingleView.test.ts`
    pins it, including that the mirror does not come back.
  - **Light/dark is the palette's job, and there is no second control for it.** `applyEventTheme`
    stamps `data-theme` from the background's luminance (`> 0.5` ⇒ light), so a pale `bg` — shipped
    or custom — puts the whole event in light chrome on its own. `EventTheme.mode` survives only as
    back-compat for events saved before that, and nothing writes it. A separate light/dark selector
    was considered and rejected: it duplicates a decision the colours already make, and its one new
    state (dark chrome on a light palette) is the broken one.
    That left a real gap, though, and it was coverage rather than a missing switch — of the nine
    palettes we shipped, exactly ONE was light, and `linen` reads like a tenth while being
    `#141414`. So four light palettes now sit at the end of the record (`light`, `cream`, `mist`,
    `blush`), each the counterpart of a dark one, with the surface ladder inverted — `surface` is
    white and `border` the darkest step. Two constraints bind a new light palette, both pinned by
    tests: the accent has to be dark rather than mid-tone, because `accentInk()` must clear 4.5:1
    against it for the Join button's label and a mid-tone accent clears neither `#fff` nor `#111`;
    and the accent has to survive `hexToHsl`→`hslToHex` byte for byte.
    `linen`'s KEY cannot change — poster presets name it and saved events store it — so
    `THEME_PRESET_LABELS` carries the honest display name ("ink & linen") and the picker reads
    through it, falling back to the key.
  - **The custom swatch is a door, not a label.** It used to be rendered only while the palette
    matched none of the presets, and hidden the moment one did — so the single entry that could have
    invited a host to their own colours instead appeared unbidden, said "custom", and vanished.
    Worse, since every poster preset now names a built-in palette (`themePreset`), that state had
    stopped arising at all: it was a chip nobody could see and nobody could reach. It is now
    permanent, with two states — **idle** (dashed edge, muted label, a `+` where the tick goes) and
    **in use** (the event's real colours plus the same tick every other swatch gets). "In use" is
    still just `selectedPreset === ''`, which is what it has always meant; there is no new state.
  - **The builder makes light palettes too, and opens on the one you are already wearing.**
    `buildPalette(base, harmony, mode)` takes a third argument; `RUNGS` holds the lightness ladder
    for each direction, read off the shipped palettes in both (dark from `warm`/`ocean`, light from
    `light`/`cream`). Light is NOT the dark ladder upside down — the accent has to come DOWN, and
    how far is hue-dependent, so `legibleAccent()` walks it until `accentInk()` clears 4.5:1. A
    mid-tone accent clears neither ink: `#b4661a` manages 4.32 on white and 4.37 on black.
    This is the one place the picker returns a different colour from the one the host chose, and
    only in light mode; dark still hands `#e8994a` back byte for byte, and a test pins both.
    The modal seeds `mode` from `isLightBg(theme?.bg)` rather than defaulting to dark, which was the
    reported fault: picking `blush` and then opening **custom** dragged the host back to dark with
    no control to say otherwise — the modal overruling a choice made one tap earlier. Dark remains
    the default for an event that has no palette yet, because `DEFAULT_EVENT_THEME` is dark.
  - **One colour in, a palette out.** `buildPalette(baseHex, harmony)` keeps the host's colour as
    the **accent** — its own hue and saturation, lightness clamped into 0.45–0.72 so it can be seen
    on a dark page — and rotates the **background family** by the harmony's angle (0 / 30 / 120 /
    180). Rotating the background rather than the accent is the whole reason "complementary" means
    anything here: a host picks their colour and chooses what to set it AGAINST. Rotate the accent
    instead and the tool is answering a question nobody asked. The background's lightness rungs
    (6.5 / 10.5 / 14.5 / 22.5%, text 93%, muted 56%) are read off `THEME_PRESETS`, not invented, so
    a generated palette belongs in the same product as the shipped ones. Plain HSL, no dependency:
    it is a dozen lines, HSL is not perceptually uniform so it is never trusted to judge
    legibility, and these pages serve a CSP that restricts script sources.
  - **There is exactly ONE definition of legible.** `contrast()` and `PALETTE_MIN_CONTRAST` are
    exported from `theme.ts` and imported by `palette.ts`; `paletteReport().blocked` is deliberately
    the same condition as `applyEventTheme`'s palette guard, and a test asserts the two agree
    case-for-case. Two implementations would eventually disagree at the boundary, and the picker
    would bless a palette the page then silently throws away — which from the host's side looks
    like the setting not having taken. For the same reason the picker refuses no MORE than the page
    does: muted text and the accent are warned about, never blocked, because the guard does not drop
    a palette over either.
  - **The guard used to fail silently; now it speaks before the save.** Three live checks (event
    name, small print, buttons) with the ratio and a sentence about what to change. The blocked
    primary is `aria-disabled`, never `disabled` — see the disabled-button note below — and pressing
    it opens the colour swatches, scrolls the checks into view and focuses the text colour.
  - **The picker does NOT apply as you type**, unlike the rest of the Theme card. It is drawn in the
    PAGE's colours, so live-applying would repaint the modal: pick something illegible and the
    warning saying so is the first thing to become unreadable. The preview carries the palette
    instead (real join chrome, event variables set on its own root, so it is the cascade rather than
    a drawing of it), and Cancel really cancels.
  - **`textMuted` and `accentDark` were being dropped on every save.** Neither has a colour input,
    so neither was read back into the admin page's `c*` variables, and `persistTheme()` wrote the
    other six — a palette's muted text survived until the next theme change and then fell back to
    the app chrome's grey. They are now carried through from the `theme` object; undefined stays
    undefined, so an event that never had them still saves none.
  - **`--accent-fill` follows the event accent** (`EVENT_VARS`). The app splits the brand yellow
    into `--accent` (text, borders) and `--accent-fill` (anything the colour sits behind) because a
    near-white page needs two lightnesses of one colour; an event palette has no such split, and
    nothing was telling the fill — so a guest on a green event pressed a brand-**yellow** Join
    button (`.btn.primary` paints from `--accent-fill`) wearing ink `applyEventTheme` had already
    computed from the green. White on `#f5c518` is 1.6:1. This is the one change here that alters
    how an ALREADY-SAVED theme renders; it has its own test, named as such, so it can be found and
    reverted on its own. Still open and deliberately not touched: `accentInk()`'s 0.45 luminance
    threshold is too high — the break-even is nearer 0.18, so a mid-luminance accent such as
    `#e8994a` gets white ink where near-black would read four times better.
  - **One colour parser.** `hexSix()` in `palette.ts` backs both `toHex6()` (strict `#rrggbb`, the
    only thing `<input type="color">` will take — hand it anything else and the swatch renders empty
    with no error anywhere) and `normalizeStoredColor()` (lenient, keeps an exotic-but-valid stored
    value such as an 8-digit hex rather than flattening it to black). The admin page's
    `normalizeHex` is now the latter. Stored themes really do hold `#ddd` and `rgb(…)`.
  - **Opening the picker on an existing event is a no-op.** `paletteFromTheme()` passes every stored
    colour through verbatim — spelling, case and all — and fills only the two keys the editor used
    to drop, from a monochrome palette off the theme's **own** accent (an ocean theme should gain a
    muted blue, not the shipped warm brown). No new field, no schema change, nothing for
    `sanitizeTheme()` to learn: the base colour the picker reopens on is the accent, which is
    already stored. Which harmony produced a palette is deliberately not remembered — a saved
    palette may have been hand-tuned, and no chip claims to be the chosen one until the host picks
    one in this session.

- **Reveal timing lives in `shared/reveal.ts`**, because the host is *shown* the moment ("photos
  appear from 7:15 pm") in the browser and *gated* on it by the server — two computations of one
  instant, whose only interesting failure is the one where they disagree silently.
  - `events.reveal_at` (migration **0044**) is an absolute epoch-ms instant and **nullable**. NULL is
    not a special case: it is the old rule, `expires_at + revealDelayHours`, and every event that
    already existed has it. Nothing is backfilled. `scheduledRevealAt()` is the single function the
    gate, the guest countdown, the share-page countdown and the camera all read — they were four
    copies of `expiresAt + delay * 3600000` and drifted the moment one learned something.
  - The delay column it sits beside **cannot express what hosts asked for**: it is hours, clamped to
    a week, anchored to `expires_at` — so it cannot say "next Saturday at 7 pm", cannot say 7:15,
    and *moves* when an event is rescheduled, silently dragging a chosen date onto another day.
  - **Resolved server-side from wall-clock strings + the EVENT's timezone**, deliberately not taken
    as an epoch from the client the way `starts_at` is: the browser's zone is wherever the host is
    standing. A refusal is returned rather than a fallback to the delay — a silent fallback saves a
    reveal at a time the host did not choose and reports it as saved.
  - **Rounded UP onto `REVEAL_TICK_MS` (15 min) before storage**, never on the way out. Fifteen
    because that is the finest sweep the product runs (`lifecycle.ts` SWEEP_MS); reveal rides that
    tick rather than adding a timer. Rounding to nearest would reveal *before* the chosen moment,
    and an early reveal cannot be undone. Start times snap to the same grid, for the same reason.
  - `zonedWallTimeToMs()` probes the zone on either side of the reading and keeps the latest
    candidate that survives a round trip. The obvious single correction resolves Sydney's skipped
    02:30 forwards and New York's backwards — half the world's hosts would get the reveal an hour
    early. Both DST exceptions resolve **late**, on purpose.

- **Saving photos to a device** (`web/src/lib/saveImage.ts`) has two routes and the platform decides:
  `navigator.share({files})` on iOS (the only way into Photos — a download lands in Files), a plain
  `<a download>` everywhere else, where the share sheet is worse. `saveMany()` batches by **bytes and
  count** (48MB / 10 files) because a phone tab will not hold a whole roll at once, records WHICH ids
  landed rather than a count, and treats a dismissed sheet (`AbortError`) as "nothing arrived" — so
  the grid's saved marks can never overstate.
  - **Files-or-zip is ASKED EVERY TIME, and `prefersFiles()` was deleted** (`DownloadFormat.svelte`,
    and the note at the top of `web/src/lib/download.ts`). It used to sniff a coarse pointer to
    decide which answer to offer first and then remember what you picked, per device. Both halves
    were wrong: the right answer changes with the browser (Chrome on Android saves a whole roll
    silently, Opera prompts per file, iOS has no downloads folder at all), with the size of the set,
    and with what the person means to do with it — and a remembered answer turns the button into one
    that downloads without asking, which is indistinguishable from a button that ignores you. If you
    are tempted to re-add the memory, that is the argument to beat.

- **Scope is ASKED, not inferred** (`web/src/lib/components/ShareScope.svelte`). Share used to mean
  whatever tab you were standing on — All shared the gallery, Favourites shared the favourites, and
  Select mode had a different button — three behaviours behind one word, and the only way to know
  which you were about to get was to notice which tab was underlined. One component now serves both
  verbs and offers exactly the three scopes the SERVER already understands (`shares.kind` is
  `all | favourites | selected`), so it can never offer something that cannot be created. The
  favourites link resolves at read time, which is worth saying in the UI: a host who thinks it is a
  snapshot will make five links instead of one.
  - **Downloading has two scopes sharing cannot have** — `hearts` (everything with at least one ♥,
    most-hearted first) and `both` (the host's stars ∪ the guests' hearts, counted once). They are
    download-only because a share is a LINK the server re-resolves on every open, and `shares.kind`
    has no "the hearted ones": offering it under Share would promise a link that cannot exist.
  - They ride a **second dispatch event** (`pickHearts`) rather than widening `pick`. That is a type
    decision, not a UI one: `Camera.svelte` and the review screen hand `e.detail` straight to a
    handler declared for the original four scopes, and neither passes a heart count, so widening
    `pick` would turn both into compile errors over rows they can never show.
  - The heart rows **hide** when their answer is another visible row's answer (everything hearted;
    the union equal to one of its halves) and when the event has hearts off — which the caller
    expresses by passing 0, so the component never has to know what a feature flag is. The
    favourites row, by contrast, stays visible and `aria-disabled` with "star some photos first",
    because that is an instruction the host can act on — nobody can make other people's hearts
    appear from inside the sheet.
  - `heartedPhotos()`'s ORDER only reaches the files path. A zip is named and ordered by the server
    (`participants.name`, `participants.id`, `takenAt`, `photos.id`) on purpose — a tie there
    renumbers files between two downloads of one event.
  - `favouritesUnion()` is written as ONE filter over the gallery rather than two lists
    concatenated, which is what makes it deduplicated for free and keeps it in the gallery's order.

- **Hearts are counted, never stored as a tally** (`photo_hearts`, migrations `0057`–`0059`;
  `routes/photos.ts`). A `photos.heart_count` column is the obvious shape and the one this codebase
  has been bitten by repeatedly: a denormalised tally drifts the moment any path forgets it (a
  purge, a cascade, a moderation reject) and the drift is invisible until someone counts by hand.
  A row per heart with a unique index on `(photo_id, participant_id)` is the truth.
  - That unique index **is the idempotency**. `POST /api/photos/:id/heart` takes an explicit
    `heart: true|false`, not a toggle, and inserts `onConflictDoNothing` — so a double tap, two tabs
    or a retried request cannot double-count, and a request that times out and is re-sent lands on
    what was asked for rather than its opposite.
  - `photo_hearts.event_id` (`0059`) is a **copy of an immutable fact, not a counter**: a photo's
    event never changes, so unlike a tally this column cannot become wrong after it is written. It
    exists to drop the join to `photos` on the hot read — measured on a synthetic 400-guest event
    (14,000 photos, 60,215 hearts) the joined form was a 64.9ms sequential scan of every heart on
    the *server*, growing with the number that grows fastest at a busy event.
  - `GET /api/photos/:code/hearts` is its own endpoint, not a field on the gallery, for two reasons
    that point the same way: the gallery reply is big and **shared-cacheable**, so it can carry
    neither live numbers nor per-viewer state; and counts move constantly while the photos do not.
    It is queried **by event**, never by a list of ids — 14,000 uuids in an `IN` list is a megabyte
    of query text — and `?ids=` over 500 is **ignored rather than truncated**, because truncating
    returned a silent zero for every photo past the 500th, which reads as hearts having randomly
    stopped working on big galleries rather than as "too many ids".
  - **Visibility is applied to the counts as well as to the photos.** The endpoint once scoped by
    event alone and never joined `photos`, so anyone with the join code could read back the ids of
    pre-reveal and rejected photos. Both reads (the tally and the caller's own `mine`) now carry the
    same `seeable` predicate, so a photo the host rejects drops out of a guest's own list too —
    otherwise the client keeps drawing a filled heart on something no longer in the gallery.
  - `events.hearts_enabled` defaults **true**, and a host switching it off hides the feature and
    refuses the endpoint without deleting a row, so turning it back on restores the counts. Hearts
    default on because a heart only ever ADDS to a screen.
  - **One heart per participant is not one per person.** Joining is unauthenticated, so somebody
    determined can mint participants and heart from each — bounded by the guest cap where billing is
    on, unbounded on a self-host build. The ceiling on the damage is a vanity number, and the same
    trick fills the guest list, which is the pre-existing problem worth solving.
  - Hearting honours **lock** (423) and an event that has not started (403), like every other guest
    write. It deliberately does **not** stop when the event ENDS: uploads stop because the roll is
    over, but people browse a gallery for weeks and hearting is part of browsing.

- **Reacting on a share link, without being a guest** (`0061_share_reactions.sql`,
  `app/src/server/routes/shares.ts`).
  - A **link visitor is not a participant**, and that is the whole design. Participants are the paid
    entitlement: they count against `guest_cap`, hold a roll, get a trick card and appear in the
    guest list. A gallery link forwarded to forty relatives must never mint forty of those, so
    `share_visitors` is its own small table — a name, a token, and the share it belongs to. The
    token is scoped to **one link**: the same person on another share of the same event is another
    visitor, which is the honest model for something with no login behind it.
  - `photo_hearts.participant_id` and `photo_comments.participant_id` became **nullable**, with a
    `visitor_id` beside each and a `CHECK ((participant_id IS NULL) <> (visitor_id IS NULL))` so a
    row always has exactly one author. Added `NOT VALID` — the existing rows already satisfy it, and
    validating a large table takes a lock nothing here needs.
  - The visitor heart index is **partial** (`WHERE visitor_id IS NOT NULL`). Postgres treats NULLs
    as distinct, so a plain composite over a nullable column deduplicates nothing at all while
    looking exactly like idempotency. Same shape as `share_sends` in 0052.
  - **Every read of a comment thread joins BOTH author tables, and both joins are LEFT.** A comment
    has one author but two possible kinds of author; an inner join on either silently drops the
    other kind — from the guest gallery, from the share page, and from the host's own moderation
    screen. `share-reactions.test.ts` fails if any of the three joins tightens.
  - `shares.hearts_enabled` / `shares.comments_enabled` default **false** and are read from the
    SHARE, never the event. One event can have a family gallery that wants comments and a client
    gallery that must not; inheriting the event's flag would open every link the moment the host
    turned comments on for their guests. Switching one off hides rows rather than deleting them.
  - The visitor token rides in `X-Visitor-Token`, the way a guest's rides in `X-Session-Token`, and
    every reply that carries `mine` or the visitor's own name is `Cache-Control: private, no-store`.
  - Photo membership is checked against the share's **own** `where` — the same condition the grid is
    built from — so a hand-picked share can never be talked into hearting a photo it left out.
  - **Deleting a share cascades to its visitors and so to their reactions**, and that is the only
    coherent option rather than a choice: the one-author CHECK means a comment must always have an
    author, and a visitor's name lives on the link. So there is no orphan state to keep them in. The
    admin Delete now asks first and says so.

- **`GET /api/events/:code/words`** (organizer) is the host's moderation feed: every caption and
  every comment in the event in one list, newest first, capped at 300 with the true total reported.
  Deleting goes through the endpoints that already own each kind — a caption is cleared by saving an
  empty one, a comment is deleted outright — so neither needed a new route.

- **The slideshow renders in CHUNKS, and has no item cap** (`app/src/server/slideshow.ts`).
  - What bounds peak memory is how much **film one ffmpeg run produces** — measured at ~3.3GB before
    the first frame plus ~86MB per second of output — not how many photos the host uploaded. So
    `planChunks()` splits the timeline against a frame budget and an item budget, each chunk is
    encoded to its own MPEG-TS part with one identical settings object (the concat demuxer joins by
    trusting the codec parameters match), and consecutive chunks **share their boundary item** so a
    crossfade is never cut in half.
  - Two guards, because they catch different failures: the **budget** scales with the length of the
    film (`encodeTimeoutMs`), so a 400-photo render is not killed for being long; the **stall** guard
    (10 min of silence on `-progress`) is what catches a wedged process.
  - **Order** is `chronological | shuffled` and nothing else — a hand-sorted running order is a video
    editor's job. A shuffle is seeded from the **render id**, so a film is reproducible from its job
    row and only a NEW render deals a new order.
  - A second request while one runs is **queued** (`MAX_QUEUE = 3`), never dropped and never allowed
    to kill the running encode: renders are versioned rows in `slideshows`, so both films survive and
    the host picks. Serial, because ffmpeg here already takes every core.
  - That queue is **per event**; `withSlideshowSlot` is the limit **across** them. Ten hosts pressing
    Build at the same moment used to mean ten concurrent ffmpeg graphs, each asking for `-threads
    NCPU` and each staging 4K intermediates in `UPLOADS_DIR/.ss-tmp` — on a box whose whole reason
    for chunking the timeline is that one 4K run peaks in the gigabytes. Organizer-gated bounds who
    can start a render, not how much of the machine it takes, and there is no rate limiter in front
    of it. One render at a time, globally.
  - It is a **separate** slot from the guest-video one in `images.ts`, which is the interesting
    choice: reusing that would have been the DRY answer and the wrong one. That slot is what a
    guest's clip waits in for its crop and its playback proxy, so a 4K render holding it for the
    several minutes it takes would leave guests at *every other event on the box* with a clip their
    phone may not decode at all (a Firefox/iOS WebM without its H.264 proxy is unplayable, not
    merely lower quality) — trading an organizer's wait, which their panel already shows them, for
    guests losing playback. One slot each. Both are built from `makeSlot()`; pinned by
    `slideshow-slot.test.ts`.

- **`UPLOADS_DIR` is a REMOTE volume, so never ask it a question per row.** The uploads volume is
  normally an NFS share (18TB here), and `playFile()`/`downloadFile()` ask "is this sibling on
  disk?" up to three times for every row a gallery returns — `existsSync`, synchronous, on the event
  loop, so the stall is paid by every request the process is serving, not just that one. All three
  siblings live in the same event folder, so `onDisk()` now answers from ONE `readdirSync` per
  folder, cached for 2s. Measured on this box against the real share, 200-clip gallery, 500
  questions, caches dropped between runs: **73.0ms → 12.2ms** of blocked loop (median of 5; worst
  case 376ms → 16.6ms). At 500 clips, **230.8ms → 30.6ms**, worst case 1196ms → 101ms. The 2s
  staleness is inside a window the callers are already built for — a crop lands after the upload
  response, and "until it lands, serve the original" is the documented answer. Legacy flat
  filenames (pre per-event layout) deliberately keep the single stat: listing the uploads ROOT to
  answer one question costs 193ms cold, so the fast path is only taken where it is actually faster.

- **compose-env is checked PER SERVICE.** The guard used to scan the whole compose file, so a
  variable listed under `web:` satisfied the app's requirement and vice versa — it only ever
  proved the name appeared somewhere. `ANALYTICS_EXCLUDE_EMAILS` passed that test for months
  while being absent from the app container that reads it, which left internal accounts
  un-excluded from the lifecycle emails in production. The check is now service-scoped.

- **Clip shape comes from the CAMERA, not from cropping.** Photos are cropped to the chosen frame in
  a canvas (`cropRect`); `MediaRecorder` records the stream exactly as the sensor gives it, so an
  event set to 1:1 used to produce square photos and wide clips. `applyConstraints({aspectRatio})`
  on the LIVE track fixes it for free — 1ms, no re-encode, no quality loss, and the recorder needs
  no help. Measured against the alternatives: a canvas redraw costs 16.7ms a frame against a 33ms
  budget at 30fps, and an ffmpeg crop costs 19–114 CPU-seconds a clip plus ~0.985 SSIM on the file
  people download.
  - The constraint goes on the live track, never into `getUserMedia` — an `OverconstrainedError`
    there falls into the retry chain and costs the guest their lens.
  - **The shape is checked against the EVENT, not against the grammar** (`readShape`). Matching
    `\d{1,2}:\d{1,2}` was all it used to do, which made the frame pack a client-side decoration:
    `captureShape: '9:16'` posted by hand to a free, square-only event was honoured, `'99:1'` was a
    legal shape, and — the expensive part — every shaped clip queues a full-resolution CRF-18
    re-encode inside the one global video slot that guest playback proxies also wait in, so one
    forged field per upload on one free event was CPU taken from every other event's guests. The
    requested shape is now intersected with the event's `aspect_ratios`. A shape we will not honour
    falls back to `'full'` (keep the clip as recorded) rather than refusing the upload — a guest at
    a party must not lose a shot over a field that only decides framing, and `'full'` is the only
    fallback that neither does work nor removes pixels. Honest clients cannot reach it: the camera
    offers only the event's own shapes. Pinned by `capture-shape.test.ts`.
  - The ask is **never trusted**: `getSettings()` is read back and only a ratio that actually
    arrived turns the viewfinder framing on. A camera that refuses keeps the honest behaviour —
    no framing, no shape control in video — and reports it, which is the only way we learn what
    real devices do.
  - Verified square end to end on real Android hardware (a 2160×2160 file with audio). **iOS Safari
    is unverified** — it does not implement `resizeMode` at all — which is exactly why the refusal
    path exists.
- **Saving a photo on iOS goes through the SHARE SHEET, not a download.** Safari has no API that
  writes to the camera roll, so `<a download>` lands in Files and the guest never finds it.
  `navigator.share({files})` opens the sheet, which has "Save Image" on it. Two rules in
  `shared`-adjacent `web/src/lib/saveImage.ts`: it needs a real tap (so it lives on a button, not on
  the capture path, where a sheet after every shutter press would be intolerable), and a cancelled
  sheet throws `AbortError` and must NOT fall through to a download.
- **`/api/contact` is bot-checked, so every form that posts to it needs a token.** The contact page
  had one; the in-app feedback modal and the refund request did not, so from 2026-08-30 until it was
  found, every bug report, piece of feedback and refund request sent from inside the app died on the
  bot check and the words were thrown away — production received zero of them. A Turnstile token is
  single-use, so a failed submit must `reset()` the widget or the retry fails for a second reason.
- **The same bug, one floor up: `/api/auth/register` and `/api/auth/login` were guarded and no page
  rendered the widget at all.** Both halves were individually correct — a hardened verifier with
  sixteen tests, and two mounts in `index.ts` — and the pair was inert, because a check nobody can
  satisfy is decided entirely by its escape hatch (`TURNSTILE_FAIL_OPEN`, which production sets). A
  bot omitting the field got in with a `console.warn`. Nothing was red, so the two halves are now
  asserted **against each other**: `turnstile-wiring.test.ts` reads the guarded actions out of the
  server and the rendered actions out of the forms and requires the sets to be equal, the same
  anti-drift shape as `shared/guest-reminder.ts`.
  - And the refusal itself was a dead end. "Bot check failed — reload the page and try again" was
    one line for three different truths, and the commonest — no token at all — is overwhelmingly an
    ad blocker or a privacy DNS resolver eating `challenges.cloudflare.com`, which reloading cannot
    fix. `refusalFor()` now splits them: the blocked case names the address to allow, an invalid
    token is told to reload, and our own outage answers 503 and says so. The widget says the same
    thing in the form itself when its script never loads, worded as a conditional because with
    FAIL_OPEN set the submit still succeeds.
- **`shared/` holds the rules the server and the browser must agree about**, imported directly by
  both — see `shared/README.md`. Agreeing by copy does not work: captions counted one way in the box
  and another on the server, and the difference was silent truncation. Three modules live there
  today: `caption.ts` (the length rule), `reveal.ts` (when a scheduled reveal happens — see below)
  and `guest-reminder.ts` (whether the day-before reminder can fire at all).
  - `guest-reminder.ts` is the newest, and it is there because of the sharpest version of this bug
    yet. The rule was written out twice and the copies differed **by one character** — the server
    required the gap to exceed a day (`>`), the browser accepted exactly a day (`>=`) — and each
    half carried a confident test asserting precisely what the other denied. Both suites were green
    the entire time a host who chose a 24-hour reveal delay was shown the reminder switched on, with
    the exact time it would fire, for an email the sweep would never send. Nothing compared the two
    because there was nothing to compare against. The rule is now one function, `guestReminderInstant()`,
    and the inequality is strict on purpose: the thank-you goes out when the event ends and already
    names the release moment, so a reminder landing in that same tick has been overtaken by it.
- **A guest's trick card can be reassigned by the HOST.** `participants.challenge_set` is written
  once, at join, and a returning guest deliberately keeps the card they were given (that is what
  stops them shopping for easier tricks) — which left a genuine mis-scan with no way out. The host
  moves them from the Participants list. Nothing is destroyed: progress is derived from photos and
  scoped to the card held, so ticks stop counting and come back if they are moved back.

- **`Permissions-Policy` must permit the features the app itself uses.** It shipped as
  `microphone=()` on 2026-09-07. In that header `()` disables a feature for EVERY origin,
  including our own — the browser refuses it at the document level and never shows a prompt, so
  every guest's video clip recorded silently and nobody could grant their way out of it. The
  camera was `(self)` and worked throughout, which is exactly what made it look like a device
  permission problem. `(self)` still shuts third-party frames out, which was the actual intent.
  Guarded by `testsuite/specs/99c-permissions-policy.mjs`.

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

- **`purgeAt` is the most destructive number in the product, so it is computed in exactly one
  place** — `purgeAtFor()` in `app/src/server/lib.ts`, alongside `RETENTION_DAYS`. `cleanup.ts`
  deletes every photo of every event whose `purge_at` has passed, with no undo and no warning, and
  the value used to be assembled at four separate call sites. Two of them were wrong:
  - The Stripe upgrade webhook hard-coded `|| 7`, so an operator who set `RETENTION_DAYS=30` got
    thirty days everywhere **except** the one path a customer reaches by paying us.
  - The same line read the expiry as `parseInt(metadata.expiresAt, 10) || 0`. Absent metadata
    therefore became the epoch, `purge_at` landed on 8 January 1970 — already in the past — and the
    next sweep destroyed the photos of an event whose owner had, one webhook earlier, paid to
    upgrade it. Every neighbouring field in that same update used `|| undefined` precisely so a
    missing value would leave the stored one alone.
  `purgeAtFor()` throws on an unusable expiry rather than inventing one, falls back to the
  configured floor (never to a shorter window) on unusable retention, and the webhook now takes
  `Math.max` against the event's existing `purge_at` so a retry or an out-of-order event cannot walk
  somebody's retention backwards. Covered by `retention-purge.test.ts`.

- **A `custom` quote is a referral, not a price — never entitle one.** `quote()` returns
  `tier: 'custom'` for any configuration no rung can price: a guest count above the top of
  `PAID_TIERS` (`MAX_QUOTABLE_GUESTS`, 400), an event longer than the last duration rung
  (`MAX_QUOTABLE_HOURS`, 3 months) or a retention window past the last one (`MAX_QUOTABLE_DAYS`,
  1 year). Every component of that quote is 0, so `requiresPayment` comes
  back **false** — which is correct in itself (there is no price) and a trap for every caller, since
  `POST /api/events` derived `entPaid = !q.requiresPayment`. Asking the API for 1000 guests produced
  a fully-entitled 1000-guest event with video and every frame shape for A$0: strictly more than the
  A$59 tier, free, to anyone who could write a `curl` command. The upgrade route was worse — the
  quote came back cheaper than what the host had already paid, so `diff` went negative and the
  free-delta branch applied it immediately. Both routes now refuse `tier: 'custom'` outright with
  `customPlanError(q)` — which names the limit that was actually hit, because "events over 400
  guests need a custom plan" answers nothing for somebody who asked for 100,000 hours — rather than
  clamping: clamping would hand somebody who asked for 600 guests a 400-guest event and tell them it
  worked. The settings route's frame-shape re-quote refuses it too: a `custom` quote costs 0, and
  "costs no more than has already been paid" would otherwise give the frame pack away on any event
  no rung fits. Self-hosters (billing off) are unaffected — there is no ladder to fall off. The
  pricing UI never offers a number this high; only a hand-made request gets there. Covered by
  `retention-pricing.test.ts` and `billing-upgrade.test.ts`.
  - **Video is the only add-on priced by guests × seconds** (`PAID_TIERS.videoMul`, 1× / 1.25× /
    1.75× / 2.25×, rounded to whole dollars in `videoCentsFor`). Everything else is flat, correctly:
    a frame pack is a setting, an event's length is the same length whoever attends, and guests
    demonstrably do not fill their rolls (production: the most anyone has ever shot is 18 of 24), so
    photos self-limit. Video does not — every guest can record ~50MB and it is held for the whole
    retention window. Before this, one flat $24 bought 25 clips on a small event or 400 on a big one:
    $23.76 a gigabyte at the bottom against $4.25 at the top, so the heaviest events got the deepest
    discount on the heaviest thing they do. The multiplier is deliberately gentle against a 16×
    spread — being cheaper than the alternatives is the position, and it still is at every rung.
    The client reads `videoMul` off the same `paidTiers` the server sends and must round the same
    way: the wizard quotes a rung before the server charges it, and a card that says $18 and bills
    $17.50 is worse than either number alone. `featureUpsell.test.ts` pins that, including that no
    rung can produce a part-dollar.
  - **Both ladders climb, and neither used to.** `SHOTS_TIERS` is flat at A$3 a dozen for the first
    three dozens — the ordinary event, which should not feel surcharged — then climbs to A$9 for the
    tenth. `VIDEO_ADDONS` was worse than flat: $2/$5/$8/$12 worked out at 20¢, 16.7¢, 13.3¢, 13.3¢ a
    second, so the longest clips were the cheapest per second sold.
  - **A price change is never retroactive**, and that is what `Math.max(covered, amountPaidCents)` in
    the upgrade route is for — `covered` re-prices what an event already holds at TODAY's prices, and
    the floor stops a rise reaching back into an event somebody already bought. Both changes above
    were checked against a real paid event before shipping: re-priced $42 against $39 paid, owing $0.
  - **The pricing PAGE derives its volatile numbers now** (`lib/pricing.ts` → `addOnsFor`). It used to
    mirror the ladders by hand with a comment asking the next person to remember, and that failed:
    "36 (+A$5) or 48 (+A$8)" sat on the live page for a whole release after those rungs became $6 and
    $9. The static fallback quotes NO figure — it cannot be wrong about a number it does not state —
    and `pricing.test.ts` asserts exactly that for the no-config case. `options.ts` derives
    `shotsPerPerson` from `SHOTS_TIERS` for the same reason; its old hand-kept copy carried three
    wrong prices in a comment.
  - **Duration and retention were the same hole, and duration was the worse half.** Each
    `…TierFor()` helper falls back to its LAST rung, so an off-the-ladder value was priced at that
    rung: `durationHours: 100000` cost the 3-month rung's $25 — and `expiresAt`/`purgeAt` are
    written from the *request*, so the event outlived every cleanup sweep. On a ≤10-guest event it
    cost nothing at all, since the `diff <= 0` branch applies immediately with no checkout.
  - **`quote()` answers with the RUNG, never with the request.** It used to return
    `maxPhotos: <whatever was asked for>`, and the upgrade route wrote that to the event: a million
    shots per guest for the top rung's $8, or for free below 11 guests. Shots are deliberately
    *clamped* rather than refused (`MAX_QUOTABLE_SHOTS`, 48) — unlike the three ceilings above, the
    top shots rung is a real saleable product and was already the price being charged, so only the
    allowance was wrong. The upgrade route floors the write at the event's current `maxPhotos`, so a
    grandfathered row above the cap is never quietly cut down by an *upgrade*.

- **A paid `guestCap` is enforced with a row lock, not with a count** — `POST /api/participants`
  (`app/src/server/routes/participants.ts`). `guestCap` is the tier the host actually bought, and it
  was enforced as `SELECT count(*)` → compare → `INSERT` a few statements later: a check-then-act
  with nothing holding the two halves together. The traffic this endpoint sees is a QR code on a
  venue sign scanned by a whole table at the same moment, so the burst is the *normal* case and not
  an edge one — every request read the same count before any of them had inserted, and every one of
  them passed. Measured on dev: **25 simultaneous joins at a cap of 10 admitted 17**. Guests beyond
  the tier the host paid for were getting in free, which is a revenue bug as much as a correctness
  one.
  - The count and the insert now happen inside **one transaction that first takes
    `select … for no key update` on the EVENT row**, so joins to one event queue behind each other
    and each one counts the rows the one before it wrote. Joins to other events are untouched — the
    lock is per event row. `for no key update` rather than `for update` because it conflicts with
    itself (that is exactly what serialises the joins) but *not* with the `for key share` lock every
    `INSERT INTO participants` takes on the event row for its foreign key; `for update` would have
    made unrelated writers queue behind a join for nothing. The cap is re-read from the **locked**
    row rather than from the copy read before the lock existed, so a host who buys a bigger tier
    mid-rush is believed immediately.
  - **`INSERT … SELECT … WHERE (SELECT count(*) …) < cap` does not fix this.** It reads as a single
    atomic statement and is not: under READ COMMITTED each statement's subquery sees a snapshot
    taken before the others committed, so the whole burst still passes and the overshoot survives.
    An advisory transaction lock would work, but it needs the event's uuid hashed down to a bigint
    (two unrelated events can then collide and serialise each other) and it is a lock with no
    visible relationship to the row whose capacity it protects.
  - **Recovery still runs BEFORE the cap check**, unchanged and deliberately: a guest who already
    has a roll must never be turned away as "full", so serialising the joins must not quietly
    reorder that. The lock spans three statements against Postgres and nothing else — `missionsFor()`
    and the response are built after the commit, because none of it affects who gets a seat and
    holding a row lock across unrelated work would turn one slow query into a queue of guests
    watching a spinner.
  - **The duplicate-address retry needs a SAVEPOINT** — which is what a nested Drizzle transaction
    compiles to, and it is load bearing. In Postgres a failed statement poisons the whole
    transaction, so the existing "lost the `(event_id, lower(email))` race ⇒ join without the
    address" fallback would otherwise have fired its second `INSERT` into an aborted transaction,
    got `25P02` back, and handed the guest exactly the HTTP 500 that used to lock people out of an
    event (`specs/97-participant-email.mjs`). Self-hosters are untouched throughout: the whole cap
    block is gated on `billingEnabled`. Covered by `testsuite/specs/16-guest-cap-race.mjs`, which
    fires the burst for real rather than reasoning about it and asserts that exactly the cap is
    admitted, that a returning guest still recovers at a full event, and that simultaneous joins on
    one address answer 200 rather than 500.

- **Email-only guest recovery is an ACCEPTED RISK, hardened rather than changed** — `POST
  /api/participants` (`app/src/server/routes/participants.ts`). A returning guest is matched on
  their **email address alone**, not on address + name. That is deliberate and it stays: an address
  identifies one roll per event (`(event_id, lower(email))` is UNIQUE), which is what makes recovery
  work at all when someone comes back on a new phone and types their name slightly differently.
  `testsuite/specs/97-participant-email.mjs` pins that intent, including the part people are tempted
  to "fix" — two people sharing an inbox share a roll, and the second to join takes over the first
  one's participant row, name and all.
  - **What that costs, stated plainly.** A join code is printed on a venue sign, so it is
    semi-public; an address is often guessable. Code + address mints a *fresh, valid session* on
    that guest's roll: their photos can be read, shots uploaded as them, the name on the roll
    changed, and their own session token invalidated (recovery rotates it). Matching on name as well
    would remove that, and would break the case recovery exists for — and the address could not then
    be stored for the second person anyway, because of the UNIQUE index. So the trade is taken
    knowingly, and the abuse case is made **slow** and **noisy** instead.
  - **Slow: recovery attempts are budgeted per `(event id, lower(address))`** — 5 per 15 minutes,
    `RECOVERY_RATE_LIMIT`. Three things about that key, each of which was a way to get it wrong:
    it is **not the IP** (a whole venue is one NAT address — see the `GUEST_READ` note in `index.ts`
    for what an IP-keyed limiter does to a wedding, and a prior audit found `trust proxy` resolving
    to the venue NAT); it is the **event row**, not the code the client sent, because `joinCode` and
    `slug` both resolve to the same event and keying on the client's string hands out two budgets;
    and it is **`lower()`**, to agree with the lookup and the index, or shifting one letter to caps
    is a free extra budget.
  - **It counts attempts, not failures.** Skipping successful recoveries would leave the limiter with
    nothing to count: someone who has the address gets a *successful* recovery every single time, so
    volume is the only signal, not failure. A real returning guest makes one attempt, or two if they
    fat-finger the address; spec 97 legitimately spends exactly five and is unaffected.
  - **It is called on the recovery branch, not mounted on the route.** A limiter in front of `POST
    /api/participants` would throttle **first-time joins**, which at a venue is the whole party
    arriving at once. A first-time join, and a guest who gives no address at all, never reach it.
    Being over budget means no new session token is minted, so nothing is handed over.
  - **Noisy: one narrow shape is reported to the operator** —
    `ops-notify.notifyRiskyRecovery()`, the same `OPS_NOTIFICATIONS` + `SUPPORT_EMAIL` channel as
    every other instant alert, plus a one-line `[ops] risky recovery …` in the log whether or not
    that is enabled. The shape is *a recovery that changes the name on a roll that already has
    photos* — a guest returning to an empty roll says nothing, a guest retyping the same name says
    nothing, and putting a different name on someone's shot roll is the takeover signature. The
    address is **masked** (`unsubscribe.maskAddress()`), as everywhere else that an address reaches a
    log or a response.
  - **What is NOT closed: the oracle.** A matching address answers `recovered: true` while a
    non-matching one falls through to an ordinary join, so the response still tells a caller whether
    an address is on an event's guest list. Closing that needs the matching or the response shape to
    change, which is the decision `specs/97-participant-email.mjs` exists to make deliberate. The
    limiter slows enumeration down; it does not remove the signal.
  - Covered by `app/src/server/__tests__/recovery-hardening.test.ts` (the budget key, including a
    30-guest venue on one IP, and the alert's masking and escaping) and
    `testsuite/specs/97c-recovery-hardening.mjs` (the same thing end to end, plus "a refusal mints no
    token").

- **Stripe webhook deliveries are claimed before they are processed** — `processed_stripe_events`
  (migration 0050), keyed by Stripe's own event id, which every retry of a delivery reuses. Stripe
  redelivers anything it does not get a 2xx for, with backoff, for up to three days, and the handler
  had no record of what it had already done. Most branches survive that by accident (they SET a
  total or flip a boolean); the `upgrade` branch does not, because `amountPaidCents` is cumulative
  real money — and an inflated total makes the host's **next** upgrade free, since the upgrade route
  only charges `newTotal − amountPaidCents`. One transient failure was enough.
  - **Why a table, and not another payment-intent column** the way the guest top-up branch guards
    itself with `participants.stripe_payment_intent`: `events.stripe_payment_intent` is the refund
    handle for the event's *original* payment (site-admin refunds that intent), so an upgrade
    writing its own intent there would silently repoint the one-click refund at the top-up. And one
    slot only remembers the last payment, while upgrades are meant to be repeatable — Stripe's
    retry window is long enough for upgrade A's retry to land after upgrade B succeeded, by which
    time the slot says B and A is applied twice.
  - **The claim is given back if the work throws.** Claiming first is what makes the guard atomic
    (the `INSERT … ON CONFLICT DO NOTHING … RETURNING` *is* the claim, so two simultaneous
    deliveries cannot both win), but it would otherwise turn one failed webhook into a payment that
    is never credited at all — the worse failure. The handler now catches, releases the claim, and
    answers 500 so Stripe retries into a clean first delivery. Covered by `billing-upgrade.test.ts`.

- **A space before a `{#if}` is not a space.** Svelte trims the whitespace at the start of a block's
  content, so `…event ends.{#if cond} No release moment…{/if}` renders as **"ends.No release
  moment"**. It bit twice in one afternoon, in prose nobody re-reads after writing it, and it is
  invisible in the source — the space is right there. Two things make it hard to catch: it does not
  happen in every construct, so a single counter-example "proves" it is fine; and it is a rendering
  fault, so no test, type-check or linter sees it.
  - The fix is an explicit `{' '}` **inside** the block: an expression is a node, not whitespace, so
    it survives, and it renders nothing when the branch is skipped. Moving the space *outside* the
    block looks equivalent and is not — `on its own {#if n > 1}(attempt {n}){/if}, so you can` then
    reads "on its own , so you can" whenever the branch is false.
  - To sweep for it: text ending in a non-space, immediately followed by `{#if`/`{#each`/`{:else}`,
    whose content starts with whitespace. There were 16 across nine files.

- **A field inside a save flow that cannot be saved is worse than a field that is not there.** The
  wizard's edit mode showed *What kind of event is it?* as read-only text, on the reasoning that the
  type is "written by the same endpoint as the trick list, so changing it here would quietly
  regenerate a list the host may have spent time editing". Half of that was true, and the wrong half
  was load-bearing:
  - `PUT /api/events/:code/challenges` really does write `event_type` and `challenges` in one
    statement. It **400s** on a body with no parseable list, and it **clears the column** when the
    list it is given is empty (`parseChallengeSets([])` returns `[]`, not `null`; `serialiseSets`
    turns that into `null`) — and then reseats every guest holding a card. So a type change routed
    through there would genuinely destroy work. That part of the old comment was right.
  - Nothing anywhere derives the trick list **from** the type. The mission packs are front-end data
    (`web/src/lib/challenges.ts`) because a host can write their own, and seeding a list from one is
    a one-shot client action taken at creation (`seedMissionList`, only reachable from
    `submitCreate`). `parseEventType` is a string validator. So the type on its own is a plain
    column, and it now goes through `PUT /settings` under the ordinary present-key rule
    (`nextEventType` in `app/src/server/challenges.ts` — `undefined` leaves it alone so an older
    client cannot clear it; anything else, `null` included, is the host speaking).
  - The failure this produced was total for one host in particular: an event that never had a type —
    every event created before the question existed, and the demo — rendered the literal words
    **"Not set"**, in a `<b>` at full `--text`, so an absence wore the weight and colour of a
    heading. There was nothing to protect *and* nowhere to go. **An absence is not a value:** render
    it muted and subordinate to its own label, never in the styling of a real answer.
  - The general rule: the last step of the wizard asks *are you sure you want to save* over a list of
    changes. Everything that flow displays must be something it can actually write, and must appear
    on that list. A control that is genuinely blocked still has to take the person to whatever is
    blocking them (see the `disabled` entry above) — but check first whether it is blocked at all.
    Pinned by `app/src/server/__tests__/event-type-setting.test.ts` and the bucket assertions in
    `web/src/lib/eventEdit.test.ts`.

- **`step` on `<input type="time">` only validates — it does not constrain the picker.** An off-grid
  value is still accepted into the field; it merely fails `checkValidity()`, which nothing surfaces.
  And the picker widget belongs to the browser, so Chrome's list and Android's dial offer five-minute
  options whatever `step` says. Every time field therefore goes through `TimeField.svelte`, which
  keeps the native control (it is the one people know, and on a phone it is a wheel their thumb
  understands) and snaps the value after the change, out loud.
  - The rule is `$lib/timeGrid.ts`, and it has a **direction**, which is the part worth keeping
    straight. A start time snaps **down** — doors opening a few minutes early cost nothing, while
    rounding 9:50 up to 10:00 locks out somebody at the door at 9:55. A reveal or a scheduled guest
    send snaps **up**, because early is the mistake with no undo: the photos are already out. That
    is the same reasoning `ceilToRevealTick` encodes server-side.

- **Scoped styles do not cross a component boundary.** Moving a control into a shared component
  silently orphans the page's `input { … }` rule, and the control renders as a raw browser widget
  beside styled neighbours. `svelte-check` catches it as an unused selector — which is the only
  reason it was caught — so treat "Unused CSS selector" on a rule you did not touch as a signal that
  markup moved, not as lint noise. `Toggle.svelte` and `TimeField.svelte` both carry their own
  styling, built from the same tokens.
  - **The other half of the same rule: scoping does not separate two things INSIDE one component.**
    Svelte appends the same scoping class to every selector in a file, so two unrelated `.dot`
    rules compile to the identical `.dot.svelte-hash` — equal specificity, and the later one wins
    on source order. On the landing page that was the hero eyebrow's 7px accent bullet losing to
    the carousel's 20px dot *button* 70 lines further down: it rendered as a transparent 20px box
    with the carousel's grey `::after` inside it. Nothing warns — both selectors are used, so
    there is no unused-selector hint, and the CSS is valid. In a 600-line `<style>` block a generic
    class name (`.dot`, `.row`, `.card`, `.tab`) is not scoped to the part of the page you were
    thinking about; prefix it (`.eb-dot`) rather than reaching for specificity.

- **A `disabled` button is not an inert button.** It consumes nothing: the tap falls through to
  whatever is behind it, and on a phone the browser reads that as the start of a text selection and
  throws its own Copy/Search menu over the app. It is also, usually, a control that states a
  condition ("Name your event to continue") and then does nothing when you do what it says. Prefer
  `aria-disabled` plus a handler that takes the person to whatever is blocking them — same muted
  look, same announcement to a screen reader, no dead tap.

- **The card renderer is a module now, so card output is provable in pixels.** `web/src/lib/
  cardRender.ts` was lifted out of `PosterModal.svelte` for one reason: a module can be bundled with
  esbuild, loaded into headless Chromium with the real woff2 faces, and hashed — which is how
  `posterRender.ts` changes have been proven safe. While it lived inside the component the card side
  could only be argued from source tests, which is weaker evidence for the same risk. The extraction
  was itself proven that way: **385 renders, 385 identical** (5 typefaces × 3 sizes × both card
  shapes × one-design/per-card × decoration × join block, plus 26 extra axes and the per-card paint
  rule). Negative controls moved exactly the renders they should — flipping the identifier's side
  moved 5, scaling a 2-up sheet by area moved 80, changing `CARD_PAD` moved all 385. Use the same
  harness for any future change to either renderer; a source grep asserting that a function
  *contains a call* is not evidence that it draws the right thing.

- **Pick a contrast by measuring it, not by a luminance threshold.** `accentInk()` in
  `web/src/lib/theme.ts` chooses the label colour that sits on the accent — a Join button's text, a
  tick in a filled circle. It used to switch at luminance 0.45; break-even is nearer 0.18, so every
  accent between the two got white when it wanted near-black. Measured over the nine shipped
  palettes, **five failed**, including `warm`, the default every event gets: white on `#e8994a` is
  2.31:1, near-black is 8.17:1. `contrast()` was already exported from the same file, so the
  approximation bought nothing. The related half of the same bug: `--accent-fill` was absent from
  `EVENT_VARS`, so a themed event's `.btn.primary` stayed brand gold while its ink was computed
  from the event accent — white on `#f5c518`, 1.63:1. Two lessons worth keeping: a threshold that
  stands in for a measurement you can afford to take is a bug waiting for the right input, and a
  token that is half-overridden (accent themed, fill not) is worse than one that is not overridden
  at all. Tests sweep every palette for AA rather than pinning the old answers.

- **`path.join` does not neutralise `..`, it resolves it.** Every user-supplied string that becomes
  a filesystem path goes through `uploadDiskPath()` in `app/src/server/paths.ts`, which resolves the
  result and throws unless it lands under `UPLOADS_DIR`; deletes go through `safeUnlink()`, which
  checks the same thing. Do not rebuild either by hand. The bug this replaced is the shape to
  recognise: the theme header image was validated by a regex that allowed `.` (extensions need it)
  and `/`, so `/uploads/../../etc/passwd` matched, and an unanchored `.replace('/uploads/', '')`
  then turned it into `/etc/passwd` — an arbitrary file read through the slideshow renderer and an
  arbitrary file delete through event deletion, reachable with no account at all via the demo
  event's organizer code. A validating regex is the cheap layer; **containment at the point the
  path is built is the load-bearing one**, because the regex has to keep allowing the characters
  that make the traversal spellable. Also beware placing the `..` guard *after* a fixed prefix in
  the pattern — anchored there it has no preceding slash to match and `/uploads/..` walks past it.

- **An icon that has to look the same on two phones cannot be a character.** The download/save
  arrow is `web/src/lib/components/DownloadIcon.svelte` — one inline SVG, one 20px size, imported by
  every surface that offers a save (the QR on the host page, the card in the gallery, the guest's own
  roll, the lightbox, the share page, review, the slideshow list). It replaced `⬇` in four places and
  `⤓` in two, which is how a host came to report that "the arrow is different on every screen".
  `⬇` (U+2B07) is an **emoji codepoint with default text presentation**: iOS draws Apple Color Emoji
  anyway, Android draws a thin Noto glyph, and they share neither weight nor colour nor size. Adding
  U+FE0F — the fix this project does apply to 🖼️ 🎛️ 🗑️ 🖨️ ☀️, which are emoji either way — pins it
  to the colour tile *everywhere*, and a colour tile cannot take `currentColor`, so the green
  "already saved" state could not tint it. `⤓` (U+2913) is honest text but has patchy font coverage,
  so it renders from a fallback face at that face's optical size. An SVG has no font to depend on.
  The icon is `aria-hidden` and the accessible name stays on the button; it strokes in
  `currentColor`, so both themes and the done state come free.

- **A card that paints its own overlays has to be a stacking context.** `PhotoCard.svelte`'s
  `.pcell-wrap` is `position: relative` with `z-index: auto` — a positioned box that is *not* a
  stacking context, so any descendant with a positive `z-index` is sorted into the nearest real one
  (the document root) and paints after the whole card has been drawn. A letterboxed photo carried
  `z-index: 1` for no reason beyond sitting above its own blurred fill, and so painted over the
  select ring, the save plate and the tile's own tick. Two halves to the fix, and both are worth
  keeping: `isolation: isolate` on the card, so nothing inside it can escape it; and no `z-index` on
  the fitted photo at all — it and the blur are both positioned, so **tree order** already puts the
  photo on top and costs nothing.
  The ring itself is a `::after` with a positive `z-index` rather than the `outline` it used to be.
  An outer `box-shadow` was ruled out here long ago for the right reason (children paint over it
  when the container has no padding, and this card's photo starts at its top edge), but an outline
  only wins by being painted after descendants, which CSS 2.1 E.2 explicitly leaves to the
  implementation. A positive-`z-index` descendant beating its `z-index: auto` siblings does not.

- **The poster designer's selection model: a tap SELECTS; it does not open anything.** The host's
  report was "the text edit box opening on the poster on click is annoying". A tap used to open the
  inline editor directly, so nudging an element threw a keyboard over the design. Now a tap selects,
  and the selected element carries its own cluster — its name, **✏️** (open the words), **🗑️** (the
  bin) and **✕** (let go) — beside the **⤡** resize grip it already had. `PosterElControls.svelte`.
  The pieces that are easy to get wrong:
  - **Selection happens at `pointerdown`**, inside `dragOn`, because a drag has to select what it is
    dragging. So by the time the element's `on:click` runs, it is *already* selected — and "was this
    the first tap or the second?" cannot be answered from `selectedKey`. That is what `tapHeld` is:
    what was selected *before* the gesture, set in `onUp` next to the existing `tapped`. A second
    deliberate tap on something already held opens the editor; the first never does.
  - **Selection is EXCLUSIVE.** While one element is held, a press on another may not take it over —
    `pressRole()` in `$lib/posterFlow`. But a refused press still *runs the gesture*, returning
    `'pinch'` rather than `'none'`: the stage is a 316px thumbnail almost entirely covered by other
    elements' boxes, so a two-finger pinch of the held element has nowhere else to start from. The
    refused press never selects and never moves what it landed on. It still sets `dragKey`, because
    that is what puts `touch-action: none` on the stage, and that has to be in force *before* the
    second finger lands — `preventDefault()` on a pointerdown does not stop a pinch becoming a page
    zoom, only `touch-action` does.
  - **A press on the stage background no longer deselects.** The controls a host reaches for are
    mostly *below* the preview, and a tap that clipped the stage on the way would drop the selection
    they were about to use. `✕` and Escape are the two ways out. The modal's *backdrop* dismissal is
    deliberately left alone: a selection is ephemeral view state on an auto-saved design, unlike the
    open editor, whose `blur` fires on the press — which is why that one blocks a dismiss and this
    one does not.
  - **Escape's order lives in `escapeLayer()`**, not in a ladder of early returns in the component.
    It was a ladder, which is fine until a layer has to be added in the *middle* — which is exactly
    what a selected element is. Innermost first: armed bin → armed "Start again" → armed "Reset
    layout" → open editor → selected element → full-screen Arrange → close. A selection sits *inside*
    full screen, because it lives on that stage.
  - **One cluster, rendered once per stage**, from a derived `selectedEl` — which is only possible
    *because* selection is exclusive. Hung off the element loops it would be three copies (fixtures,
    the host's own lines, the placed motifs) and two chances to drift. It is gated on the element
    still being in `elements`, not merely on having a rect: a cleared fixture still measures, because
    `bounds` asks for `message || ' '`, so a rect is not proof the element is on the poster. Without
    that gate a cleared element leaves an outline and a row of controls around a blank line.

- **`dragOn` arms undo at pointerdown and pushes it at the first mutation.** It used to push
  unconditionally on press. That was already a bug — a tap that only selected added a no-op undo step
  *and* set `designEdited`, which is the flag that unlocks `persist()` and every export on a poster
  nobody had edited — and tap-to-select makes it fire on every single selection. So `snap0` is taken
  at pointerdown (cfg cannot change before the first move without a mutation) and `armUndo()` pushes
  it once, ahead of the move, the grip resize and the pinch. A whole drag is still exactly one step.
  Miss one of those three call sites and that gesture silently becomes un-undoable.

- **The bin means three different things, and for two elements it means nothing.** `binActionFor()` /
  `cardBinActionFor()` in `$lib/posterFlow` own the verb; `applyPosterBin()` / `applyCardBin()` in the
  component own the mutation. They live apart on purpose and `PosterModal.select.test.ts` pins them
  together, so a key cannot be added to one and forgotten in the other.
  - `'delete'` — something the host *added* (their own line, a motif they placed).
  - `'clear'` — a *fixture* (`message`, `steps`, `names`): empty the words, keep the position, the
    size and the colour. `VISIBLE_COLOR_ROWS` already hides a swatch for an element that is off and
    deliberately never resets the value behind it, which is the other half of the same promise —
    re-typing brings the design back rather than starting the element over.
  - `'toggle-off'` — `brand` and `footer`, both of which a switch in the panel already governs.
  - **`null` for `title` and `qr`, and that is the load-bearing case.** The title is the poster's one
    required field (`pCanAdvance`), and the renderer falls back to `'Our Event'` when it is blank — so
    a bin there would look like it had done nothing while quietly blocking the way forward. The QR
    *is* how a guest joins and nothing in the designer can remove it; the only switch near it
    (`qrPanel`) governs the white card *behind* the code, and `$: if (!qrPanel && !qrSafe) qrPanel =
    true` force-restores it, so a bin wired to that would visibly do nothing on every design over a
    photograph. **Omit a control rather than ship one that means something surprising on one
    element.**
  - It **arms then confirms**, like "Start again" and "Reset layout", and it **shows armed by colour
    alone**. The header's two stack two labels so the button cannot jump wider between the arming
    press and the confirming one; a 44px chip has no room for a word, so the armed rule changes
    `background`, `border-color` and `color` and nothing that occupies space. A test asserts that
    rule sets no `width`, `height`, `padding`, `font-size` or `border-width`.
  - Undo is pushed **before** the mutation, and `releaseSelection()` is the **last statement** — the
    test asserts that as the last statement rather than merely as text after the mutation, because an
    early `return` would leave the call sitting there unreachable and an ordering check reads that as
    a pass.

- **Don't name a draggable element after where it starts.** "Show the link along the bottom" was
  wrong the moment anybody dragged it: `footer` is an `ElKey` with its own box and its own measured
  bounds. It is now "Show the web address". The distinction worth keeping: a *structural* relationship
  inside a block that always draws that way is fine ("Small line above the title" — the title is one
  box of up to three rows; "the code under the QR" — drawn inside the panel rect and travelling with
  it; "Note beside the QR" on a card — `placeOnCard(g, cardLayout.qr, …)`, so it moves with the join
  block). The *default position* of an independently movable element is not.

- **Copy rule, twice re-learned in this file:** say what happens and stop. Two hints were rewritten
  after the same complaint — the name stacker described itself as "a lockup … your own joiner in
  script between two hairlines" (four pieces of trade jargon in one sentence, describing the mechanism
  instead of the result), and a hint about "a title set as two parts — small tracked caps over a big
  word" sat at the foot of the Words step, ~140 lines from the fields it described, explaining why a
  *designer* likes an effect. The second was deleted rather than moved: both fields are already
  labelled, so it had no instruction in it.

- **A wizard step with no control of its own is not a step.** The poster flow's sixth step, "Place",
  held a paragraph about dragging, the QR-too-small warning, and one **⛶ Full-screen arrange** button
  that was already in the header — a duplicate setting inside the same wizard. `P_LAST` is 5. The
  paragraph is what the per-element cluster replaced: direct manipulation teaches itself where it
  happens, which a paragraph three steps away never did. **The warning was the one thing worth
  keeping, and it was in the worst possible place** — buried in a step a host can skip, warning about
  something they changed two steps earlier. It now renders outside every `pStep ===` gate, so it
  shows whenever it is true: the QR is resized by dragging or pinching it, which can happen on any
  step, and a host who prints a sign nobody can scan cannot fix it afterwards.

- **A toggle is for a setting, not for a selection.** `Toggle.svelte`'s header carries the rule, and
  the exceptions are the interesting part: consent stays a checkbox (an affirmative act should not be
  a switch that can be nudged), and choosing several things from a list stays a checkbox, because a
  column of switches reads as ten settings rather than one question with ten answers.

- **`/api` responses default to `private, no-store`, and a route opts OUT.** One middleware sets it
  before the routers (`index.ts`), and `cacheableFor()` in `routes/photos.ts` is the only thing that
  overrides it. The reason is an edge rule nobody would call reckless: the obvious fix for "my
  gallery cache rule isn't working" is a Cloudflare *Cache Everything* rule on `/api/*`, and
  Cloudflare's default cache key is host+path+query — it **ignores request headers**. A cached
  `GET /api/events/<code>/admin`, authorised by the `x-organizer-code` *header*, would then be
  served to anyone with the URL and no code at all. Defaulting closed means a mis-scoped edge rule
  cannot leak. `cacheableFor()` also sets `Vary: x-organizer-code` where it makes a reply `public`,
  so the organizer branch and the guest branch of one URL cannot share an entry; `perViewer()` is
  the explicit "this carries who you are" marker (the hearts endpoint uses it).

- **The public gallery's TTL is computed PER STATE, and never spans the reveal**
  (`galleryCacheSeconds()` / `galleryCacheControl()` in `shared/reveal.ts`, pinned by
  `gallery-cache.test.ts`). One blanket number is the tempting implementation and the wrong one,
  because of which state it lands in: the pre-reveal body contains `revealed: false`, so caching it
  for 60s lets a guest sit on the lock wall for up to a minute *after* the reveal fired — served a
  stale "not yet" by the edge while their client did everything right. So: 30s once revealed (short
  because un-reveal is a real endpoint, and a stale revealed body is the one direction of staleness
  that shows people something they were meant to stop seeing), 5s for a `manual` reveal (no
  scheduled instant means no provably safe window), and before a scheduled reveal, whatever is left
  minus a 10s margin — which covers the edge's clock disagreeing with ours and the round trip that
  stored the entry. Under 5s it rounds to "do not cache" rather than shaving the margin.
  **This only works if the CDN respects the origin's TTL.** A Cloudflare Cache Rule with a fixed
  Edge Cache TTL overrides `Cache-Control` outright and gives every state one blanket number, which
  is precisely what this exists to avoid.

- **The `/api` backstop skips the guest READ path, which is what makes its own comment true.**
  `API_RATE_LIMIT` (600/min per IP) sat across all of `/api` with no exemption while the code beside
  it claimed guest reads were intentionally not IP-limited. With `trust proxy` resolving `req.ip` to
  the real client, a venue is ONE NAT address: opening the gallery costs ~6 requests, so 600/min is
  a cliff at roughly 100 guests a minute — and a reveal is 150 people tapping one link at once.
  `GUEST_READ` in `index.ts` exempts GETs on the gallery, the event, `/participants/me` and
  `/photos/:code/hearts`. The hearts path needed its own pattern because it has two segments and did
  not match the first: at ~1.33 polls/min per open gallery, 400 guests is ~533/min of the budget
  before a single upload. Writes, auth, uploads, email and Stripe keep the backstop; volumetric DoS
  belongs at Cloudflare.

- **The CSV import has its own limiter** — `IMPORT_RATE_LIMIT`, default 30/min, mounted on the
  `/guests/import` PREFIX so it covers both the preview and the real import, which is deliberately
  the same path the 2 MB body limit is mounted on so the two cannot drift apart. These are the only
  two endpoints that accept a 2 MB body and each parses all of it: measured at 576ms of CPU for
  2 MB, and 1.42s wall for five at once. Under the 600/min backstop alone that is ~345s of CPU per
  minute available to one IP on a single-process Node server, and an organizer code is all it takes
  to reach it. 30 is a DoS bound, not a product rule — re-previewing a mapping five times is
  ordinary use.

- **`PHOTO_DELETE_WINDOW_SECONDS` defaults to 30 IN CODE, and compose must not answer for it.**
  `routes/photos.ts` exports `DELETE_WINDOW_SECONDS`; `docker-compose.yml` passes
  `${PHOTO_DELETE_WINDOW_SECONDS:-}` — **empty**, not a literal. It used to carry `:-60`, which
  silently outranked the code: the source said one number and every stack ran another, because
  compose had already answered. The window is published at `/api/config` as
  `photoDeleteWindowSeconds` and `Camera.svelte` reads it, instead of keeping the hardcoded `60_000`
  it used to hold beside a comment saying the server is the authority.

- **The admin page opens on a MENU, and the section is remembered in `sessionStorage`.** It had
  grown to ten cards in one column, so every host scrolled past nine things to reach the one they
  came for and the length itself read as complexity. `web/src/lib/rememberedView.ts` stores the
  place per tab and per subject. Two rules in it are load-bearing: it is **not** the URL, because
  the admin hash already carries the organizer code (a bearer credential) and a view name has no
  business sitting next to a secret — and because a link someone sends should open the page, not
  reproduce the tab they were standing on; and every read is **validated against the caller's own
  list**, since a stored view name goes stale the moment a section is renamed and a page that
  trusts one renders a state it no longer has. The sections are hidden with `display:none`, not
  `{#if}`, so the components inside them keep their state and their in-flight loads.

- **One site header — `web/src/lib/components/SiteNav.svelte`.** Landing, pricing, the dashboard,
  the event manager and `/siteadmin` drew their own at 62px, 56px and not at all, so moving between
  them made the page jump and the console looked like a different product. The shell is the
  component; what goes on the right is the page's own business and arrives through the slot, styled
  by that page (Svelte scopes slotted content to the parent). Both sides carry `min-width: 0` — with
  `nowrap` links and no minimum the row ran past the viewport on a phone and dragged the whole page
  sideways, which is where a stray horizontal scroll came from.

- **nginx answers a 5xx with a branded page that polls itself back** (`app/nginx/default.conf`).
  A guest mid-event who gets the bare "502 Bad Gateway" wall assumes the photos they just took are
  gone and mashes refresh, which is the worst possible traffic shape for a box that is already
  struggling. Things worth knowing before editing it:
  - The page is **inlined in the config**, not a sibling `offline.html`, because the nginx container
    mounts exactly one path (`./nginx/default.conf`) in both compose files — a file beside it simply
    is not in the container.
  - It is set in **seven `set $...` chunks** because nginx reads its config through a fixed
    4096-byte buffer and rejects any longer quoted parameter with *"too long parameter, probably
    missing terminating quote"*, which reads like a quoting bug and is not one. Split further rather
    than trying to raise it; it is a compile-time constant. They live inside the named location, not
    at server level, so 11KB of string is not rebuilt on every request.
  - The markup may contain **no ASCII apostrophe, no backslash and no `$`**. `nginx -t` catches the
    first; the second blanks part of the page silently.
  - `error_page` is written **without `=`**, so the client still gets the original 500/502/503/504 —
    monitoring, Cloudflare and `curl -I` go on the status code, and flattening a connect-refused and
    a 60s timeout into one throws away the only cheap signal for which happened.
  - It declares **no `add_header` of any kind**, deliberately: one would drop the entire inherited
    server-level security header set. A cache header is also not needed — no 5xx is heuristically
    cacheable — and `expires -1;` is not the workaround, since its filter ignores any status outside
    200/201/204/206/3xx and emits nothing at all on a 502.
  - `/api/` and `/uploads/` route to `@api_unavailable` instead, which returns a small JSON body:
    those callers are XHR and `<img>`, and handing an image request an HTML document wastes the
    bytes. `proxy_intercept_errors` stays **off** there so the app's own JSON errors reach API
    clients, and is **on** for the frontend so a SvelteKit SSR 500 does not stream its raw error
    page to a guest mid-deploy.
  - `proxy_connect_timeout 5s` (the default 60 is what a guest stares at a blank tab for — measured
    22.7s to first byte with the dev web container stopped, because a stopped container's address
    stops being routable rather than refusing, so the SYNs are swallowed). Connect only; `/api/`
    keeps its 3600s read/send timeouts, so long uploads are untouched.
  - **gzip is on for `application/json`** at level 5, `gzip_proxied any` (the default `off` for
    proxied requests would have made the whole block a no-op behind Traefik) and `gzip_vary on`.
    Measured on `GET /api/photos/<code>?gallery=true` for a 95-photo event: 48,994 bytes plain,
    7,546 gzipped — 6.49×. Level 9 is ~1% smaller for twice the CPU; the constraint is the uplink.

- **A self-hoster's `nginx/default.conf` is THEIR file, like `docker-compose.yml`.** Nothing in an
  upgrade rewrites it, so anything above only reaches an existing deployment if the operator merges
  it. That is what the nginx section of `UPGRADING.md` is for — when you change this file, say so
  there.

## Releasing (maintainers)

**Before deploying, presence-test the target `.env`.** `__tests__/compose-env.test.ts` asserts that
both compose files *pass* every variable the code reads — it cannot know whether the deploy target
actually *sets* one, so a var that is missing from production's `.env` ships a silently inert
feature and the test stays green. Check with `grep -qE '^VAR=.+' .env && echo SET` — never
`echo "${VAR:-x}"`, which prints the value (a Mailgun key was leaked in this project exactly that
way). Vars with a safe default do not block a release; the ones that silently disable a feature do.
`reportDeliveryTracking()` logs one line at boot saying which side of that line the running
container is on.

**Face matching must be inert in production, and the check is `MACHINE_LEARNING_URL`.** The feature
is built but not enabled: it carries privacy obligations that are still open (`PIA-face-matching.md`),
and that one variable is the whole interlock — `faces-killswitch.test.ts` treats it as a safety
device rather than a config flag, and it overrides a stale `face_matching_enabled = true` left on an
events row. The risk is not the code, it is the deploy: **devel sets this variable**, so an `.env`
copied from devel turns face matching on in production without a word. Presence-test it the same way
as everything else — `grep -qE '^MACHINE_LEARNING_URL=.+' .env && echo SET` — and expect NOT set.
The app also says so at boot, in both states, so the log is evidence either way:

```
[faces] face matching inert (MACHINE_LEARNING_URL unset) — the intended state for production
[faces] FACE MATCHING IS LIVE — MACHINE_LEARNING_URL is set. …
```

**The page CSP is Report-Only, on purpose.** nginx serves `Content-Security-Policy-Report-Only`
rather than an enforcing policy, and reports land on `/api/csp-report` (both `report-uri` for Safari
and older Chrome, and `report-to` + the `Reporting-Endpoints` header for everything newer). The
handler keeps the violated directive and the blocked **origin** and deliberately throws the URLs
away: a report carries `document-uri` and `blocked-uri` in full, and on this app those hold join
codes, share slugs and recovery tokens, so logging one verbatim would copy live credentials into an
ordinary log file. `CSP_REPORT_RATE_LIMIT` (default 60/min per IP) bounds an endpoint that is
necessarily unauthenticated. Promote the header to an enforcing `Content-Security-Policy` once
`[csp]` lines have stayed quiet on real traffic — not before, and not on release day.

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
- **[../UPGRADING.md](../UPGRADING.md)** — the traps a `pull && up -d` does not close, plus per-release notes.
- **[../TESTING.md](../TESTING.md)** — manual QA checklist, and what the automated suites already cover.
- **[../shared/README.md](../shared/README.md)** — why `shared/` exists and how one relative path resolves in both images.
- **[../app/src/server/drizzle/README.md](../app/src/server/drizzle/README.md)** — the one rule about
  a migration's `when` timestamp, and why breaking it fails **silently** on every database.
- **[../loadtest/CAPACITY.md](../loadtest/CAPACITY.md)** — measured capacity and where the ceiling is.
