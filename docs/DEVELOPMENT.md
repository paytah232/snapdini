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
    the cut guides and the corner radius following the choice (square corners exist because a
    guillotine cannot round them). Paper scale is **height-based, not area-based** — an A5 half
    sheet is the same height as an A6, so scaling it by √2 blew the QR up and squeezed the list.
  - Card identifiers can be turned **off** so a host shuffles the stack and hands them out at
    random; the QR still carries its own `?set=`, so a shuffled card is still the right card.
  - `cardSkip` stores **exclusions**, not inclusions, so a set added later prints by default.
  - Decorations (`web/src/lib/cardDecor.ts`) are drawn vector, no assets and no requests, before
    the content so text always sits on top. Confetti is **seeded** or it shimmers between redraws.

- **The poster designer** — `web/src/lib/components/PosterModal.svelte` (the editor),
  `PosterWizard.svelte` (the design gallery), `posterRender.ts` (every drawing primitive),
  `posterPresets.ts` (the eight designs), `posterFonts.ts` (typography), `cardDecor.ts` (motifs).
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
  the grid's saved marks can never overstate. `prefersFiles()` (coarse pointer) picks which option to
  OFFER first; the answer is then remembered per device, because no amount of sniffing gets this
  right and every wrong guess looks like the button being broken.

- **Scope is ASKED, not inferred** (`web/src/lib/components/ShareScope.svelte`). Share used to mean
  whatever tab you were standing on — All shared the gallery, Favourites shared the favourites, and
  Select mode had a different button — three behaviours behind one word, and the only way to know
  which you were about to get was to notice which tab was underlined. One component now serves both
  verbs and offers exactly the three scopes the SERVER already understands (`shares.kind` is
  `all | favourites | selected`), so it can never offer something that cannot be created. The
  favourites link resolves at read time, which is worth saying in the UI: a host who thinks it is a
  snapshot will make five links instead of one.

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
  `tier: 'custom'` for a guest count above the top rung of `PAID_TIERS` (`MAX_QUOTABLE_GUESTS`,
  currently 400). That branch has `baseCents: 0` and no add-on charges, so `requiresPayment` comes
  back **false** — which is correct in itself (there is no price) and a trap for every caller, since
  `POST /api/events` derived `entPaid = !q.requiresPayment`. Asking the API for 1000 guests produced
  a fully-entitled 1000-guest event with video and every frame shape for A$0: strictly more than the
  A$59 tier, free, to anyone who could write a `curl` command. The upgrade route was worse — the
  quote came back cheaper than what the host had already paid, so `diff` went negative and the
  free-delta branch applied it immediately. Both routes now refuse `tier: 'custom'` outright with
  `CUSTOM_PLAN_ERROR`, rather than clamping: clamping would hand somebody who asked for 600 guests a
  400-guest event and tell them it worked. Self-hosters (billing off) are unaffected — there is no
  ladder to fall off. The pricing UI never offers a number this high; only a hand-made request gets
  there. Covered by `retention-pricing.test.ts`.

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

- **A `disabled` button is not an inert button.** It consumes nothing: the tap falls through to
  whatever is behind it, and on a phone the browser reads that as the start of a text selection and
  throws its own Copy/Search menu over the app. It is also, usually, a control that states a
  condition ("Name your event to continue") and then does nothing when you do what it says. Prefer
  `aria-disabled` plus a handler that takes the person to whatever is blocking them — same muted
  look, same announcement to a screen reader, no dead tap.

- **A toggle is for a setting, not for a selection.** `Toggle.svelte`'s header carries the rule, and
  the exceptions are the interesting part: consent stays a checkbox (an affirmative act should not be
  a switch that can be nudged), and choosing several things from a list stays a checkbox, because a
  column of switches reads as ten settings rather than one question with ten answers.

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
- **[../UPGRADING.md](../UPGRADING.md)** — the traps a `pull && up -d` does not close, plus per-release notes.
- **[../TESTING.md](../TESTING.md)** — manual QA checklist, and what the automated suites already cover.
- **[../shared/README.md](../shared/README.md)** — why `shared/` exists and how one relative path resolves in both images.
- **[../loadtest/CAPACITY.md](../loadtest/CAPACITY.md)** — measured capacity and where the ceiling is.
