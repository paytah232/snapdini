# Upgrading Snapdini

Most of the time an upgrade really is `docker compose pull && docker compose up -d`. The four
things that make it *not* that are below — every one of them has bitten a real deployment, so they
are worth two minutes before you start.

The quickest safe route:

```bash
cd /path/to/your/snapdini            # the directory holding your .env and docker-compose.yml
./upgrade.sh 1.5.0                   # or omit the version for :latest
```

The script checks traps 1–3, backs up `.env` and the database, upgrades, and verifies the running
version — and when that verification fails in the way trap 0 fails, it restarts the proxy and tries
again. It never overwrites your files: it tells you what differs and lets you decide.

---

## The traps


### 0. Recreate a backend and the proxy may still point at the old one

nginx resolves `app` and `web` **once, at startup**, because they sit in an `upstream {}` block —
and that block is not optional: without its keepalive pool nginx opens a fresh connection per
request and exhausts the ephemeral port range in about 34 seconds at 840 rps.

So if you recreate a backend without restarting nginx, it can keep proxying to an address that now
belongs to a different container. `/api/` then returns the *other* service's 404 and nothing looks
broken — no error, no log, just a feature that quietly stopped working.

`docker-compose.yml` now declares `depends_on: … restart: true` on nginx, so a plain
`docker compose up -d` restarts the proxy whenever a backend is recreated. **That only fires when
nginx is in the command's service set**, so:

```bash
docker compose up -d            # ✅ nginx follows its backends
docker compose up -d app web    # ⚠️ nginx is NOT in the set — restart it yourself
```

`./upgrade.sh` uses the safe form, and if the site still does not answer it now tells you the
proxy is stale rather than blaming the app, and restarts it for you.

### 1. New settings need adding in TWO places, not one

`docker-compose.yml` passes environment **explicitly**, not via `env_file`. A variable you add to
`.env` but not to the compose file **never reaches the container**, and nothing warns you — the
feature is simply, silently inert.

So for each new setting: add it to `.env` **and** to the `environment:` list of the service that
reads it. **Two services read settings, not one** — most belong to `app`, but anything the web
front-end reads (the ad/analytics tags, `BASE_URL`) belongs to `web`, and putting it on the wrong
service is as silent as leaving it out.

```yaml
  app:
    environment:
      - TURNSTILE_SECRET=${TURNSTILE_SECRET:-}     # ← must exist here too

  web:
    environment:
      - MSUET_ID=${MSUET_ID:-}                     # ← front-end settings go HERE, not on app
```

Check with:

```bash
docker compose exec app printenv | grep TURNSTILE
docker compose exec web printenv | grep MSUET
```

If it prints nothing, the variable never arrived.

A unit test (`app/src/server/__tests__/compose-env.test.ts`) now enforces this for both services,
so a setting missing from either compose file fails the build rather than the deployment.

### 2. `docker-compose.yml` and `nginx/default.conf` are YOUR files

`docker compose pull` updates images. It does not touch those two files. A release that adds a
service setting, an nginx directive, or a new environment entry needs you to merge the change in
by hand.

Compare yours against the release before upgrading:

```bash
diff docker-compose.yml   <(curl -fsSL https://raw.githubusercontent.com/paytah232/snapdini/v1.5.0/app/docker-compose.yml)
diff nginx/default.conf   <(curl -fsSL https://raw.githubusercontent.com/paytah232/snapdini/v1.5.0/app/nginx/default.conf)
```

Watch for defaults that move out of compose into `.env`: if a value was only a compose default
(`${OPS_DIGEST_HOUR:-8}`) and the new file drops the default, pin it in `.env` first or the
behaviour changes quietly.

### 3. A pinned `IMAGE_TAG` means `pull` fetches the same version

If `.env` has `IMAGE_TAG=1.4.3`, `docker compose pull` re-fetches 1.4.3 forever. Bump it:

```bash
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=1.5.0/' .env
```

Pinning is the right default for production — you just have to change it deliberately.

---

## Database migrations

They run automatically when the `app` container boots; there is no separate step. Take a dump first
anyway:

```bash
docker compose exec -T db pg_dump -U snapdini --no-owner snapdini > db-backup-$(date +%F).sql
```

Migrations are forward-only. To roll back a release, restore that dump **and** set `IMAGE_TAG` back.

## Verifying

```bash
curl -s http://localhost:8080/api/config | grep -o '"version":"[^"]*"'
```

## Rolling back

```bash
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=<previous>/' .env
docker compose up -d
# plus restore the DB dump if the release included migrations
```

---

## Version notes

### 1.5.2

**Nothing to configure.** No new settings, no new environment variables, no database migrations.
If you pull the images and restart, you are done. Two things change underneath you, and one of
them is worth reading before you upgrade if you have accounts.

#### Password hashing moves argon2 0.41 → 0.45

Nothing you do, but worth knowing why it is safe, because "the auth library had a major bump" is
the sort of sentence that should make you check rather than trust.

Hashes minted by 0.41 verify correctly under 0.45, and hashes minted by 0.45 verify correctly under
0.41 — so **rolling back after people have signed in does not lock anyone out either**. The default
parameters are unchanged (argon2id, m=65536, t=3, p=4), so new hashes are exactly as strong as old
ones. The only visible difference is cosmetic: 0.45 writes the parameters in a different order
inside the hash string, which both versions parse happily and nothing in Snapdini reads.

#### express 4 → 5, and what it means if you have modified anything

Snapdini itself is updated for it. This matters only if you run a fork or have added middleware:

- **`req.body` is now `undefined` rather than `{}`** when a request carries no parsable body
  (body-parser 2.x). Destructuring it throws, and express 5 forwards that to the error handler — so
  a route that used to answer 400 answers 500. Snapdini restores the old behaviour globally, but
  your own handlers will not be covered if they run before that middleware.
- **`express-async-errors` is removed and must stay removed.** It deep-requires a path express 5
  does not have, so merely importing it throws and the server does not start. Express 5 forwards a
  rejected promise from a handler to the error middleware natively, which is what the shim existed
  for.
- Route patterns are unchanged in Snapdini, but path-to-regexp 8 is stricter: a bare `*` in a path
  is no longer valid and wants a named wildcard.

#### Frontend and base images

The frontend moves Svelte 4 → 5 (running in legacy mode — no behaviour change) and Vite 5 → 8. If
you pull the published images this is invisible to you; the client bundle is about 28% smaller.
Eleven security advisories clear with it, including the two highest-rated.

Both Dockerfiles now pin their Node 22 base image **by digest** rather than by the floating
`node:22-alpine` tag. If you build your own images, a rebuild will no longer silently pick up a new
base — which is the point — so bump the digest deliberately when you want a newer Node.

#### One small data note

Demo events are now created with a timezone; previously they were stored without one. Existing
demos keep their empty value and are unaffected — the event settings form no longer misreads an
absent timezone as a request to move the event's start.

### 1.5.0
**Five new settings, and every one of them is optional** — the release works with none of them set,
so trap 2 only applies if you want one. Two things do change under you whether you want them or
not: the **photo undo window** is now 30 seconds rather than 60, and **`nginx/default.conf` has
moved on** without touching your copy. Both are below. It is a large release, so here is what
changes under you.

#### ⚠ If you send mail over SMTP, read this one first

`nodemailer` moves 6.x → 10.x in this release (along with `sharp` 0.33 → 0.35 and `multer` 1.x → 2.x,
which need nothing from you). **nodemailer 9 turned on TLS certificate validation by default.**

If your SMTP server presents a self-signed certificate, or one whose name does not match the host
you connect to — which is common on a LAN relay or a mail container on the same Docker network —
sending will start failing after this upgrade with a certificate error. Nothing else changes, and
**this does not affect you at all if you send through Mailgun**: that path is an HTTPS API call and
never touches nodemailer.

Two ways out, in order of preference:

1. **Fix the certificate.** Point `SMTP_HOST` at the name the certificate is actually issued for, or
   give the relay a real certificate. This is the one that leaves you encrypted *and* authenticated.
2. **Tell it to accept the certificate anyway**, if the relay is on a network you control and you
   accept that a machine on that network could impersonate it:

   ```yaml
     app:
       environment:
         - SMTP_TLS_REJECT_UNAUTHORIZED=false
   ```

Verify either way by sending yourself a test — see [Verifying](#verifying). A send that fails this
way fails loudly in the app logs with a certificate error, so you will not be left guessing.

#### ⚠ `nginx/default.conf` has changed, and the upgrade does not touch yours

See [trap 2](#2-docker-composeyml-and-nginxdefaultconf-are-your-files). Nothing here breaks if you
skip it — you simply keep the old behaviour. Diff your
copy against
[`app/nginx/default.conf`](https://raw.githubusercontent.com/paytah232/snapdini/main/app/nginx/default.conf)
and take what you want:

| What | Why you might want it |
|---|---|
| **An offline page for 5xx** | A guest mid-event who hits the bare `502 Bad Gateway` wall assumes the photos they just took are gone and mashes refresh, which is the worst possible traffic for a box that is already struggling. The replacement is a branded page that says nothing has been lost, polls both upstreams with jitter and backoff (3s → 15s), and reloads itself when they answer. `/api/` and `/uploads/` get a small JSON body instead, because those callers are XHR and `<img>`. |
| **gzip on `application/json`** | There was none: nginx handed the gallery answer to the edge as plaintext and a cache MISS went out untouched. Measured on a 95-photo event: 48,994 bytes → 7,546, 6.49×. 150 guests crossing a reveal together is ~59 Mbit of JSON before this and ~9 after it — and the byte that costs money is the one leaving the house. |
| **`proxy_connect_timeout 5s`** | The default is 60. A stopped container's address stops being *routable* rather than refusing, so the SYNs are swallowed and nginx waits the whole timeout out: measured at 22.7s to first byte with the web container down. Connect only — `/api/` keeps its 3600s read/send timeouts, so long uploads are untouched. |
| **The static cache block matches filenames, not `/icons/`** | The old pattern covered a directory that has never existed, so `/icon.svg`, `/favicon.ico`, `/favicon-32.png` and `/og.png` were served on the edge's 4-hour default instead of the 30 days the block was written for. |
| **`proxy_intercept_errors on` for the frontend** | Without it, a SvelteKit SSR 500 — or the node process shutting down mid-deploy — streams its own raw error page to a guest. The trade-off is that a *persistent* SSR 500 now hides behind "we'll be right back"; it is still `us=500` in the access log and in the app logs. |

The offline page is inlined in the config rather than sitting beside it as `offline.html`, because
the nginx container mounts exactly one path (`./nginx/default.conf`) — a file next to it is not in
the container at all. If you edit the markup, note that it contains no ASCII apostrophe, no
backslash and no `$` on purpose (nginx would read them as quoting and as variables), and that it
arrives in seven chunks because nginx rejects any quoted parameter over 4096 bytes.

#### The photo undo window is 30 seconds now, not 60 — and your compose file may still say 60

`PHOTO_DELETE_WINDOW_SECONDS` is how long a guest may bin a shot they have just taken and get the
frame back. The default moved to **30**, and — the part that matters for an upgrade — the shipped
`docker-compose.yml` no longer supplies a literal:

```yaml
  app:
    environment:
      # was:  PHOTO_DELETE_WINDOW_SECONDS=${PHOTO_DELETE_WINDOW_SECONDS:-60}
      - PHOTO_DELETE_WINDOW_SECONDS=${PHOTO_DELETE_WINDOW_SECONDS:-}
```

The old `:-60` silently outranked the application's own default: the code said one number and every
stack ran another, because compose had already answered. **Your `docker-compose.yml` is your file,
so it still says `:-60` until you change it** — if you want the new default, drop the `60`; if you
liked 60, set `PHOTO_DELETE_WINDOW_SECONDS=60` in `.env` and you have it deliberately rather than by
accident. Either way the camera now reads the real number from `/api/config` rather than counting
down from a figure of its own, so the bin can no longer offer itself for longer than the server will
accept.

#### Guest hearts — new, on by default, nothing to configure

Guests can heart each other's photos, and everyone sees the count. There is no setting: it is a
per-event switch (`events.hearts_enabled`, **default on**) that a host turns off under *Event
settings → Guest hearts*. Turning it off hides hearts and refuses the endpoints; **no rows are
deleted**, so turning it back on restores every count.

What it means operationally:

- **Two endpoints**: `POST /api/photos/:id/heart` (a guest session token; explicit `heart: true|false`,
  not a toggle, so a retry is idempotent) and `GET /api/photos/:code/hearts` (every count for one
  event, plus which are the asker's own).
- **The counts are a `COUNT(*)`, not a column.** There is no `photos.heart_count` to drift; see
  `0057` below.
- **The gallery polls the second endpoint**, which is why it is on the guest-read exemption list in
  the section below. On a deployment with a hand-written per-IP limit in front of `/api`, that is
  the path to exempt.
- A host can download **what everyone loved** — everything with at least one ♥ — or that together
  with their own stars, counted once. Existing events get hearts switched on by the column default,
  which adds a control to the gallery and takes nothing away.

#### Guest list & invite delivery tracking
Adds a **guest list** per event (add by hand or import a CSV), Snapdini-branded **invite emails**,
and per-recipient **delivery tracking**. Nothing to configure to get the list and the invites:
they use whichever mail transport you already have.

**The one setting this half wants, and it is optional:**

```yaml
  app:
    environment:
      - MAILGUN_WEBHOOK_SIGNING_KEY=${MAILGUN_WEBHOOK_SIGNING_KEY:-}
```

This is Mailgun's **HTTP webhook signing key** (Mailgun dashboard → Account Settings → Webhooks).
It is **not** the API key — using the API key here fails every signature check, and the only
symptom is that delivery state never updates. Then add a Mailgun webhook pointing at:

```
https://your-host/api/webhooks/mailgun
```

subscribed to `delivered`, `permanent_fail`, `temporary_fail`, `complained` and `unsubscribed`.

**Leave it unset and nothing breaks.** Invites send exactly as before; each one simply stays at
"sent — delivery unknown", and no address is ever automatically suppressed. The endpoint answers
404 when there is no key, because an unverified webhook receiver would let anyone forge delivery
events — including bounces, which would block real guests from being invited.

With it set, a hard bounce or a spam complaint adds the address to a deployment-wide **suppression
list** and it is skipped on every later send, visibly, with the reason shown on the guest's row.
That is deliberate and not per-event: repeatedly mailing dead addresses is what gets a sending
domain throttled and then blocked.

#### Unsubscribes, and where suppression is now enforced

Invites carry two unsubscribe mechanisms. A **`List-Unsubscribe` header** (RFC 8058) that a mail
client turns into its own one-press button — no page, no confirmation, because a confirmation step
fails the standard outright, and because the thing sitting next to that button is *report spam*,
which costs your sending domain far more than one lost guest. And a **link in the body**, which
opens a page offering the two choices a guest actually has: stop mail about *this event*, or never
from this deployment again. The page applies the unsubscribe on arrival and asks *why* only
afterwards, on a page that already says "you're unsubscribed" — feedback that gated the opt-out
would stop it being the cheap option, which is the one property the mechanism depends on.

The operational change worth knowing: **suppression is now enforced inside `sendMail`**, not in the
route that happens to be sending. Every sender honours it, including ones written later. Three
sends are deliberately exempt, because for those *not* sending is the greater harm:

- **sign-in and verification links** — withholding one locks someone out of their own account
- **ops alerts and the daily digest** — addressed to your own support inbox
- **the contact form** forward — someone asking you for help

Everything else is suppressible by default, which is the point: the next email anyone adds is
compliant without having to remember. Note the consequence for a host whose address has bounced or
unsubscribed — they can still sign in, but the optional mail stops.

#### Sending volume, before you hit the wall

Mailgun's free plan allows **3000 messages per calendar month**, and running out of it is a *silent*
failure — sends start being refused, invites stop arriving, and nothing on any screen says why. The
daily ops digest now reports month-to-date usage, so the number reaches you before the wall rather
than after it. Both settings are optional and go on **`app`** (see trap 1):

| Setting | Default | What it does |
|---|---|---|
| `MAILGUN_MONTHLY_LIMIT` | `3000` | The plan's monthly allowance. Raise it when you move to a paid plan, or the digest goes on measuring you against a ceiling you no longer have. |
| `MAILGUN_BUDGET_WARN_PCT` | `80` | How much of the allowance may be spent before the digest starts warning. |

Three things to know before you read the number:

- **It is a floor, not an exact count.** The figure is derived from `guest_invites` and
  `share_sends` — the two tables that record mail per recipient — rather than from a counter of its
  own, which would be a second source of truth for a number nobody bills on. Several kinds of mail
  are therefore invisible to it: account mail (sign-in and verification links, the event-live
  confirmation, check-ins, retention notices, the survey) is not recorded per recipient, and neither
  is the guests' event-end message or release reminder, which are one-shot-per-*event* guards and so
  cannot say how many people they reached. Real usage is always somewhat higher than reported. That
  tail is why the default warning sits at **80%** rather than something tighter like 95: a warning
  that arrives with 5% of the month's headroom left is one that arrives too late to move a plan.
- **It warns; it never blocks.** Nothing refuses a send at the limit. Silently not sending a host's
  invites to their own wedding is a worse outcome than an overage, and it is not a choice to make on
  their behalf. Past 100% the digest simply says the allowance is spent and that anything beyond it
  is billable or will start failing.
- **The month boundary is UTC**, deliberately not `OPS_TZ` (which the rest of the digest uses for
  "what day is it here"). The allowance is Mailgun's and resets on Mailgun's clock; counting a local
  month would put your figure and theirs in disagreement around each boundary — exactly when the
  number matters and when a disagreement is hardest to explain.

The digest normally stays silent on a quiet day. It will break that silence for this, and a warn or
over state is flagged in the **subject line** — a quiet week with no support messages and no errors
is precisely when invites that have stopped going out go unnoticed.

#### Guest recovery is budgeted, and one setting tunes it

A returning guest is recognised by their **email address alone** — that is how someone who joined on
one phone and opens the camera on another gets their own roll back, and it does not change in this
release. What is new is a budget around it: **5 recovery attempts per 15 minutes per event, per
address**. A real returning guest makes one, or two if they mistype the address; beyond the budget
the join answers `429` and asks them to wait a few minutes. **First-time joins are not affected at
all** — the budget applies only to the attempt that recovers an existing roll — and it is keyed on
the address at that event, **never on the IP**, because every guest at a venue shares one.

```yaml
  app:
    environment:
      - RECOVERY_RATE_LIMIT=5      # optional; recovery attempts per 15 min, per event + address
```

Leave it unset and you get 5. Raise it only if you have a real reason to — a guest who hits it is
told to wait, which is a worse experience than the thing the budget protects against.

The reason it exists: your join code is printed on a sign at the venue, so it is semi-public, and an
address is often guessable. Together they were enough to mint a session on another guest's roll at
your event, as fast as a script could ask. Alongside the budget, a recovery that **renames a roll
that already has photos on it** — the shape a takeover has — is now reported to `SUPPORT_EMAIL` when
`OPS_NOTIFICATIONS=1`, and written to the app log either way, with the address masked. Neither
change touches what a guest sees.

#### Rate limits: the guest read path is now exempt, and the CSV import has its own

Two changes, one new setting.

**The `/api` backstop (`API_RATE_LIMIT`, 600/min per IP) now skips guest READS.** It never should
have counted them. With the real-IP fix in place, `req.ip` is the actual client — and at a venue
that is **one NAT address shared by every guest**. Opening the gallery costs about six requests, so
600/min is a cliff at roughly 100 guests inside a minute, and a reveal is 150 people tapping one
link at the same moment: the whole room would have been told "Too many requests — slow down" at the
exact moment the product is being judged. GETs on the gallery, the event, `/participants/me` and the
hearts endpoint are exempt now. **Writes, auth, uploads, email and Stripe still count.** If you run
your own per-IP limiting in front of Snapdini — in nginx, Traefik or Cloudflare — those four paths
are the ones to leave alone.

**The CSV import is throttled separately**, because it is the only endpoint in the product that
accepts a 2 MB body and parses all of it (measured: 576 ms of CPU for 2 MB). Under the backstop
alone, one organizer code was enough to book ~345 s of CPU per minute on a single-process Node
server.

```yaml
  app:
    environment:
      - IMPORT_RATE_LIMIT=30       # optional; CSV import + preview, per minute per IP
```

Leave it unset and you get 30, which is a DoS bound rather than a product rule — a host correcting a
mapping and re-previewing five times in a row is ordinary use.

#### If anything in front of you caches `/api`

Every `/api` response now defaults to `Cache-Control: private, no-store`, and a route opts out
explicitly. Nothing changes for a normal deployment; it matters if you have — or are about to add —
a CDN rule over `/api/*`.

- The obvious fix for "my gallery cache rule isn't working" is a Cloudflare **Cache Everything** rule
  on `/api/*`. Cloudflare's default cache key is host + path + query and **ignores request
  headers**, so a cached `GET /api/events/<code>/admin` — authorised by the `x-organizer-code`
  *header* — would be served to anyone with the URL and no code at all. Defaulting closed is what
  stops a mis-scoped rule leaking; do not "fix" it by removing the default.
- The public gallery answer is the one reply that opts in, and its TTL is **computed per state**: 30s
  once revealed, 5s for a manual reveal, and before a scheduled reveal never past 10s short of the
  reveal instant — so a cached lock screen can never outlive the reveal it is denying. A Cache Rule
  with a fixed **Edge Cache TTL** overrides `Cache-Control` outright and flattens all of that into
  one blanket number, which is exactly what it exists to avoid. If you cache the gallery at the
  edge, respect the origin TTL.

#### Migrations

Applied automatically on boot. Every new table starts empty, and every added column either carries
the previous behaviour as its default or is nullable. One column is *dropped* (`0053`), one is
*tightened* (`0054`) and one index is *re-keyed* (`0055`) — all three on a table that is itself new
in this release, so none of them can touch a row you already have.

**Share-link reactions (`0061`) change nothing without you either.** Every share link — including
the ones you already made — starts with hearts and comments off. They are set **per link**, not per
event, so one event can have a family gallery that takes comments and a client gallery that does
not; you turn them on when you make a link or later from **Edit**.

**Guest comments (`0060`) change nothing without you.** The column defaults to false, so every existing event and every new one starts with comments off until a host turns them on in Event settings (or in the wizard when creating one).

**The one that changes an existing event is `0057`**: `events.hearts_enabled` defaults to **true**,
so every event you already have gains guest hearts. That adds a control to a gallery and removes
nothing, which is why it defaults on rather than off — and any host can switch it off per event.
Every other column added here is either a new feature's own storage or defaults to what the
deployment already did. `0059`'s `UPDATE` is the only backfill in the chain, and on a real upgrade
it touches nothing: `photo_hearts` is created empty by `0057` a moment earlier in the same run.

| Migration | What it adds |
|---|---|
| `0045` | `email_preferences` (new table) — per-**account** opt-outs for the optional emails. A row means opted *out*; there is no "subscribed" row and no boolean to get the wrong way round, so absence means send, and every account that already exists keeps receiving exactly what it received before. |
| `0046` | `events.guest_delivery`, `guest_send_scope`, `guest_send_at`, three one-shot send guards and three per-event mail toggles — how and when guests get the photos. Plus `participants.wants_photos`, the consent gate. |
| `0047` | `event_guests`, `guest_invites` and `email_suppressions` (new tables) — who the host means to invite, what became of each message sent to them, and the addresses that must never be mailed again. |
| `0048` | `guest_unsubscribes` (new table) — per-event guest opt-outs, with the optional "why" if they gave one. |
| `0049` | `participants.challenge_set_source` — how a guest's trick card was decided: scanned from the card itself, chosen by the guest, or guessed for them. NULL reads as "settled", so every participant that already exists is left alone and is never re-asked. |
| `0050` | `processed_stripe_events` (new table) — one row per Stripe event id, claimed before the webhook does any work. Stripe retries on any non-2xx, and the upgrade branch used to add the money again on each retry; an inflated total then made the *next* upgrade free. |
| `0051` | Makes `idx_survey_event` **unique**, so one event has one survey response. The route checked first and inserted second, which two simultaneous submissions both passed — each firing its own "unhappy survey" alert. Deduplicates first, keeping the published answer if there is one, else the earliest. |
| `0052` | Two **partial unique** indexes on `share_sends`, keyed on `lower(btrim(email))` — one for the standing gallery link (`share_id IS NULL`), one for curated shares. Partial and paired rather than one three-column index, because Postgres treats NULLs as distinct: a single index would have constrained the curated shares and left the common case unconstrained. This is what makes "one gallery link per address, ever" a rule the database keeps. |
| `0053` | **Drops** `event_guests.phone`. Data minimisation: Snapdini invites guests by email and by nothing else, so a phone number was personal data nothing in the product could act on. |
| `0054` | Makes `event_guests.email` **`NOT NULL`**. The guest list exists to mail a lot of people one join link, so an entry with no address is one nothing in the product can ever reach. |
| `0055` | Re-keys the guest-list unique index onto **`(event_id, lower(btrim(email)))`**, so one address per list is a rule the database keeps rather than one every writer has to remember. Matches `participants` (`0031`) and `share_sends` (`0052`), which were already case-folded. |
| `0056` | `guest_invites.mailed` (default `true`) — marks an invite that was recorded but deliberately never handed to a transport. Demo events show their own guest list without mailing strangers from your sending domain, and the email-allowance count filters on this so a demo's fake sends never move the number you are billed on. |
| `0057` | `photo_hearts` (new table) + `events.hearts_enabled` (default **true**). One row per guest per photo, with a unique index on `(photo_id, participant_id)` — there is deliberately **no counter column**, because a denormalised tally drifts the moment any path forgets it (a purge, a cascade, a moderation reject) and the drift is invisible until someone counts by hand. The unique index is also what makes the endpoint idempotent on a double tap or a retry. |
| `0058` | Index on `photo_hearts (participant_id)` — "which of this event's photos have I hearted?" had no index path, because `0057`'s composite leads on `photo_id`. At a 400-guest event that is the difference between a keyed lookup of your own few dozen rows and reading every heart in the event. |
| `0059` | `photo_hearts.event_id`, backfilled from `photos` and then set `NOT NULL`, plus two indexes on it. It removes the join on the live count: measured on a synthetic 400-guest event (14,000 photos, 60,215 hearts) the joined form was a 64.9 ms sequential scan of every heart on the server, growing with the number that grows fastest at a busy event. Not the counter-column mistake `0057` avoided — a photo's event never changes, so this is a copy of an immutable fact rather than a running total. |
| `0060` | `photo_comments` (new table) + `events.comments_enabled` (default **false**). Same shape as hearts — no counter column, `event_id` carried on the row so the read needs no join — and the opposite default, deliberately: a heart only adds a number to a screen, while a comment puts one guest's words on another guest's gallery under their name. Existing events are unaffected; the host opts in. |
| `0061` | `share_visitors` (new table) + `photo_hearts` / `photo_comments` widened to a **nullable** `participant_id` beside a new `visitor_id`, + `shares.hearts_enabled` / `shares.comments_enabled` (both default **false**). This is what lets someone holding a `/s/` link heart and comment without joining the event — a link visitor is deliberately **not** a participant, so a forwarded link never takes a seat against your guest cap, a roll, a trick card or a line in your guest list. Both reaction tables carry `CHECK ((participant_id IS NULL) <> (visitor_id IS NULL))` so a row always has exactly one author, added `NOT VALID` because the existing rows already satisfy it and validating would take a lock nothing needs. The visitor uniqueness index is **partial** — `WHERE visitor_id IS NOT NULL` — because Postgres treats NULLs as distinct and a plain composite over a nullable column would deduplicate nothing at all while looking exactly like idempotency. Existing events and existing links are unaffected: every share starts with both switches off and the host turns them on per link. |

**About `0053`.** It is the only statement in this upgrade that removes anything, and on an existing
deployment it removes **nothing that was ever there**: `event_guests` is itself new in 1.5.0, so
`0047` creates the table a few statements earlier in the same run and `0053` drops the column again
before the table has ever held a row. `DROP COLUMN IF EXISTS` makes it a no-op on any database that
somehow lacks it. Rehearsed against a restored production dump: the whole `0039` → `0053` chain
applies cleanly and `event_guests` ends as `id, event_id, name, email, notes, created_at,
updated_at`. The importer still *recognises* a phone column in a host's spreadsheet and resolves it
to "don't import", so an ordinary `Name,Email,Phone` paste is unaffected.

**About `0054`.** It deletes any `event_guests` row with a null email before applying the
constraint, so the `ALTER` cannot abort halfway on data it was always going to be applied over — and
on a real upgrade it deletes nothing, for the same reason `0053` drops nothing: `0047` creates this
table, empty, a few statements earlier in the same run. No released version has ever had it. The
record of what was mailed is unaffected regardless (`guest_invites.guest_id` is `ON DELETE SET
NULL`), and nothing without an address can have been mailed in any case. Rehearsed the same way as
`0053` — a production dump restored into a scratch database, `0039` → `0054` applied over it, then
repeated with a violating row inserted by hand: the delete removes exactly that row and the
constraint takes.

**About `0055`.** `0047` created the guest-list unique index on the raw `(event_id, email)` columns,
deliberately, because the writer lower-cases and trims every address on the way in. It still does.
What that arrangement could not do is catch a writer who *didn't*: going round the normalising call
with a plain `INSERT` put `MUM@Example.COM` and `mum@example.com` on one event as **two rows**,
which is exactly the duplicate the index exists to refuse. `0055` keys it on
`lower(btrim(email))` instead, so the constraint enforces the rule rather than trusting one caller
— the same choice `0031` made for `participants` and `0052` for `share_sends`. Nothing reads
`event_guests` by email (every read is by `event_id` or by `id`), so no query plan changes.
Like `0051` and `0052` it **deduplicates before rebuilding**, because the new key is stricter than
the old one and a unique index cannot be built over rows that violate it: the earliest row of a
colliding set survives — the one your list has been showing all along, and the one the product's own
duplicate check already keeps — and any `guest_invites` rows belonging to the losers are re-pointed
to it first, so a bounce stays attached to the person it was sent to. On a real upgrade it finds
nothing, for the same reason `0053` and `0054` do. Rehearsed the same way as both: a production dump
restored into a scratch database, `0039` → `0055` applied over it (a clean no-op, `event_guests`
ending empty with the new index), then a second scratch database put back to `0047`'s byte-exact
index and hand-loaded with collisions — six guest rows across three spellings of one inbox collapsed
to three, all six invites kept a guest, and the rebuilt index then refused both a re-cased and a
space-padded insert. The `WHERE email IS NOT NULL` predicate from `0047` goes with the rebuild;
`0054` had already made it always true.

**About `0046`.** `participants.wants_photos` defaults to **false** and is not backfilled, which is
the honest reading of every row already in that table: there was no way to ask, so nobody asked. An
event that exists today therefore mails **no guests at all**, whatever the delivery columns happen
to default to — the sweep looks for recipients first and stops when there are none. The defaults on
the other columns describe what a *new* event should do; they are not a decision taken retroactively
on behalf of hosts who never asked for any of it.

**About `email_suppressions` being global.** It has no event column, on purpose. Sending reputation
belongs to the *domain*, not to one party: an address that hard-bounced at one host's wedding is
just as dead at another's birthday, and mailing it again from the same domain is what gets a domain
throttled and then blocked — after which nothing this deployment sends reaches anyone. Scoping
suppression per event would defeat the point of having it.

**About `0048` being keyed by address.** The opt-out belongs to the *address at this event*, not to
the host's row for that person. Keyed by guest id, a host who removed a guest and re-imported their
spreadsheet would resurrect someone who had already said stop — a request honoured until the next
import, which is the same as not honouring it. It is kept apart from `email_suppressions` because
"stop mailing me about this wedding" is not "cut me off from every event I am ever invited to"; when
a guest *does* choose the global option that lands in `email_suppressions` as well, and this table
records that it was a request rather than a bounce, and which event it came from.


#### The bot check on sign-up and sign-in now actually runs

If you set `TURNSTILE_SITE_KEY` / `TURNSTILE_SECRET`, know that until this release the widget was
rendered on the **contact form only**. `POST /api/auth/register` and `POST /api/auth/login` were
guarded server-side, but no token was ever produced on those two pages, so every real sign-up and
sign-in was decided by `TURNSTILE_FAIL_OPEN` — and a bot that simply omitted the field was treated
exactly the same way. The bot check on your auth endpoints was, in practice, off.

Both pages now render it. **Nothing to change if Turnstile is unset** — the widget stays invisible
and both endpoints behave as before.

**What to do about `TURNSTILE_FAIL_OPEN`.** Keep it set for now, then close it deliberately:

1. A refusal now explains itself. Someone whose network eats `challenges.cloudflare.com` is told so,
   in plain words, and told which address to allow — so closing the hatch is no longer the silent
   lock-out it used to be. A Cloudflare outage answers `503`, not `403`, and says it is our end.
2. Before closing it, measure who you would be refusing. Every pass that happened *only* because
   the hatch is open is logged:

   ```bash
   docker compose logs --since 168h app | grep 'turnstile.*fail-open'
   ```

   `fail-open:missing-token` is a visitor whose widget never loaded — the people who start being
   refused the moment you unset it. `fail-open:verify-unreachable` is Cloudflare being unreachable
   from your server, which is a different problem and usually your own DNS or egress.
3. If that count over a week is small, unset `TURNSTILE_FAIL_OPEN` and watch for contact-form
   reports. If it is not small, leave it set: the honeypot and the per-IP limiters below are doing
   the work either way, and locking out real customers to stop bots that a rate limit already
   stops is a bad trade.

The honeypot (`website`) and the per-IP limiters are unaffected by any of this, and are what carries
the load while the hatch is open — but note the honeypot is on the **contact form only**; sign-up
and sign-in have never had one.

#### Also in this release, with nothing to configure

Nothing below needs a setting or a migration; it is here so an upgrade does not surprise you. All of
it is written up in the [page & feature guide](docs/GUIDE.md).

- **The event manager opens on a menu** of eight sections instead of ten stacked cards, and
  remembers which one you were in for as long as the tab is open. Nothing moved out of the page —
  only how you reach it.
- **One site header** across the landing page, pricing, the dashboard, the manager and
  `/siteadmin`, which previously drew three different ones and, on the console, none.
- **The poster prints at A6, A5, A4, A3 or A2**, rendered at that paper's own resolution rather than
  one fixed size, with the real dpi stated beside the buttons. Printing and downloads for the poster
  and the trick cards now live together on one **Print** tab. Trick cards **bleed to the cut line**
  (no white gutter between them) and the dashed cut guides became a toggle.
- **Downloads ask what, then how.** The files-or-zip question is asked **every time** — the
  remembered per-device answer was deliberately removed, because the right answer changes with the
  browser, the size of the set and what the person means to do with it. A guest can now zip **their
  own roll before the reveal**, bounded by their session to their own photos.

### 1.4.4 — never released; read this if you are coming from 1.4.3
The version after 1.4.3 was **1.5.0**: 1.4.4 was written up but never stamped, so no one ever ran
it. The section is kept because its migrations (`0040`–`0044`) are real and still have to be
applied — if you are upgrading **1.4.3 → 1.5.0** you apply everything from `0040` to `0061`, and
the notes for the first five of them are here rather than under 1.5.0.

Adds a **trick list** — an optional shot list a host gives guests, printed on cards and ticked off
in the camera. It is off for every existing event until a host sets one up.

Also in this release:

- **The event type is asked when an event is created**, and it drives the shot ideas offered, the
  mark a shot is ticked off with, the decoration on the printed cards, and which poster design is
  suggested. Optional, and existing events are unaffected — they keep the generic defaults until a
  host sets a type.
- **A rebuilt poster designer.** A gallery of **eight** finished designs (was five) to start from,
  five bundled typeface pairings, a guided six-step flow for the poster and five for the cards,
  placed decorations you drag and rotate, your own extra text lines, a name lockup, a front-and-back
  print preview, and card sheets in portrait or landscape at every card count. Designs saved before
  this release open exactly as they were left: every new field defaults to the old behaviour.
- **An exact reveal moment.** "At the end" gains *2 days · 3 days · 1 week* presets and a
  **"Pick an exact date & time…"** option. See the migration note below — the behaviour of every
  existing event is unchanged.
- **Photo captions.** Guests write a line under their own shots; hosts can add, edit or delete any
  of them.
- **Emailing a shared link, with a record of it.** The gallery link and every curated share can be
  emailed from the admin page, and who received what is kept — previously a send left no trace at
  all, so "did I already send this to Mum?" had no answer and a failure was invisible.
- **Server-side clip cropping.** A guest who picks a shape gets it even on a browser that ignores
  the request. Chrome on Android crops at the camera; iOS Safari and Firefox on Android do not, and
  those clips are now cropped after upload — losslessly for H.264 (an SPS header rewrite, no frames
  re-encoded), and folded into the existing H.264 transcode for WebM. The uncropped original is
  kept beside the result until the event's normal purge.
- **Sharing and downloading ask what you mean.** Whole gallery / favourites only / pick your own,
  instead of the button quietly meaning whatever filter was on screen. Plus a download button on
  every photo, and a files-or-zip choice that is remembered per device.
- **The slideshow lost its 60-item cap.** Long films are encoded in pieces and joined rather than
  truncated, a second render queues behind the first instead of being dropped, the order can be
  chronological or shuffled, and a render survives the tab being closed.

Migrations apply automatically on boot. Every column is nullable and additive, and every table is
new, so the upgrade is safe to run against a populated database and needs no downtime:

| Migration | What it adds |
|---|---|
| `0038` | event type, challenges, `photos.challenge_id` |
| `0039` | `participants.challenge_set` |
| `0040` | `photos.caption` |
| `0041` | `share_sends` — who a link has been emailed to (new table) |
| `0042` | `photos.capture_orientation` — whether the phone was held sideways |
| `0043` | `photos.capture_shape` — the shape the guest asked for, which is what lets the server finish a crop the camera refused |
| `0044` | `events.reveal_at` — an exact reveal instant, chosen by the host |

**About `0044`.** It is nullable, and **NULL is not a special case — it is the old rule.** Every
event that already exists gets NULL and reveals exactly when it did before (`expires_at` plus the
delay in hours). Nothing is backfilled. Only an event whose host explicitly picks a date and time
gets a value, and that value is resolved in the **event's own timezone** and rounded up onto the
15-minute tick before it is stored — so what is in the column is the instant the host was shown.

**Disk note.** Cropping a clip writes up to two files beside the original (`_crop.mp4`, and
`_dl.mp4` for downloads), and the original is deliberately never deleted. Budget roughly double the
video footprint of previous releases for events that use both clips and a fixed shape.

**CPU note.** An uncapped slideshow is a longer ffmpeg job than any previous release could produce.
The encode timeout now scales with the length of the film rather than being a flat five minutes, so
a long render is no longer killed merely for being long — but a 400-photo 4K render will keep every
core busy for a while, and renders are serialised **per event**, not per box. On a small VPS running
several events at once, that is worth knowing before a Saturday night.

### 1.4.3
**Action required if you want your site in search results.** Search indexing is now opt-in per
deployment, because deriving SEO tags from the request host let a staging copy declare itself
canonical and outrank the real site.

| Setting | Default | What it does |
|---|---|---|
| `SEO_INDEXABLE` | unset ⇒ **noindex** | `1` allows search engines to index this deployment. Set it on exactly one host — the public one in `BASE_URL`. |

Goes on the **`web`** service (see trap 1). If you run a single public instance and want it indexed,
add `SEO_INDEXABLE=1`; otherwise every page will answer `noindex, nofollow` after upgrading. If you
run a staging copy, leave it unset there — that is the point.

Crawling remains allowed on non-indexable hosts on purpose: a crawler must fetch a page to see the
noindex. Prefer to do this at your reverse proxy instead? `X-Robots-Tag: noindex, nofollow` on the
staging router has the same effect — see `docs/DEVELOPMENT.md` for Traefik/nginx/Caddy snippets.

### 1.4.1
Adds **Microsoft Advertising (UET)** alongside the existing Google tag. All optional — skip it and
nothing changes. These go on the **`web`** service (see trap 1), not `app`:

| Setting | Default | What it does |
|---|---|---|
| `MSUET_ID` | unset | Numeric UET tag id (Microsoft Advertising → Tools → UET tag). **Unset = `bat.bing.com` is never loaded.** |
| `MSADS_PURCHASE_EVENT` | unset | Goal *Action* name fired on a completed payment, with the real amount charged |
| `MSADS_SIGNUP_EVENT` | unset | Goal *Action* name fired on sign-up |
| `MSADS_CREATE_EVENT` | unset | Goal *Action* name fired when an event is created |

Google and Microsoft are **independent**: run either, both or neither. The consent banner covers
both from one decision, and Global Privacy Control is honoured for both.

**Behaviour change to an existing conversion:** the sign-up conversion now fires when the address is
**verified**, not when the registration form succeeds. This affects Google too, not just the new
Microsoft goal. Expect the count to drop and the quality to rise — an address that never opens its
inbox is no longer counted. Attribution can also be lost when someone opens the verification email
on a different device from the ad click, so treat the before/after numbers as different measures
rather than a regression.

If you use `ANALYTICS_EXCLUDE_EMAILS`, note that **site admins are excluded automatically but your
non-admin accounts are not** — an unlisted one is indistinguishable from a real customer.

`nginx/default.conf` also gains `https://bat.bing.com` in the (report-only) CSP for
`script-src`/`connect-src`/`img-src`. Merge that in if you set `MSUET_ID` — see trap 2.


### 1.1.1
Fixes a case where a visitor whose network blocks `challenges.cloudflare.com` (ad blockers, privacy
DNS, some corporate firewalls) could not sign up, log in, or use the contact form. If you enable
Turnstile, set `TURNSTILE_FAIL_OPEN=1` unless you specifically want those visitors blocked.

### 1.1.0
New settings, all optional — everything works unchanged if you skip them:

| Setting | Default | What it does |
|---|---|---|
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET` | unset | Cloudflare Turnstile on contact/sign-up/login. **Both unset = feature entirely off.** |
| `TURNSTILE_ALLOWED_HOSTNAMES` | `BASE_URL`'s host | Extra hostnames the widget may be solved on, comma-separated |
| `TURNSTILE_FAIL_OPEN` | unset (strict) | `1` = allow through when Turnstile is unreachable or blocked. See the 1.5.0 notes before deciding — the refusal it avoids now explains itself. |
| `CONTACT_RATE_LIMIT` | 5/hour | Contact-form submissions per IP |
| `AUTH_RATE_LIMIT` / `LOGIN_RATE_LIMIT` / `API_RATE_LIMIT` | 40/15m · 15/15m · 600/60s | Per-IP limits. Raise only for automated test runs. |

Remember trap 1: these need adding to `docker-compose.yml` as well as `.env`.

**If you run behind a reverse proxy or CDN**, this release also depends on the real client IP
reaching the app — every per-IP limit above is meaningless otherwise, because every visitor looks
like the proxy. `nginx/default.conf` now carries `set_real_ip_from` for Cloudflare plus private
ranges; if you use a different CDN, replace those ranges with your own, and make sure your proxy
preserves `X-Forwarded-For` rather than overwriting it.

Migrations `0026` (event reschedule) and `0027` (indexes) apply automatically.
