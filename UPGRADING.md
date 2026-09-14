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

### 1.5.0
**Three new settings, and every one of them is optional** — the release works with none of them set,
so trap 2 only applies if you want one. It is a large release, so here is what changes under you.

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

#### Migrations

Four of them, applied automatically on boot, and **no event that already exists changes behaviour
because of any of them.** Every new table starts empty; every added column is either nullable or
carries the previous behaviour as its default. Nothing is backfilled.

| Migration | What it adds |
|---|---|
| `0045` | `email_preferences` (new table) — per-**account** opt-outs for the optional emails. A row means opted *out*; there is no "subscribed" row and no boolean to get the wrong way round, so absence means send, and every account that already exists keeps receiving exactly what it received before. |
| `0046` | `events.guest_delivery`, `guest_send_scope`, `guest_send_at`, three one-shot send guards and three per-event mail toggles — how and when guests get the photos. Plus `participants.wants_photos`, the consent gate. |
| `0047` | `event_guests`, `guest_invites` and `email_suppressions` (new tables) — who the host means to invite, what became of each message sent to them, and the addresses that must never be mailed again. |
| `0048` | `guest_unsubscribes` (new table) — per-event guest opt-outs, with the optional "why" if they gave one. |

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


### 1.4.4
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
| `TURNSTILE_FAIL_OPEN` | unset (strict) | `1` = allow through when Turnstile is unreachable or blocked. Recommended. |
| `CONTACT_RATE_LIMIT` | 5/hour | Contact-form submissions per IP |
| `AUTH_RATE_LIMIT` / `LOGIN_RATE_LIMIT` / `API_RATE_LIMIT` | 40/15m · 15/15m · 600/60s | Per-IP limits. Raise only for automated test runs. |

Remember trap 1: these need adding to `docker-compose.yml` as well as `.env`.

**If you run behind a reverse proxy or CDN**, this release also depends on the real client IP
reaching the app — every per-IP limit above is meaningless otherwise, because every visitor looks
like the proxy. `nginx/default.conf` now carries `set_real_ip_from` for Cloudflare plus private
ranges; if you use a different CDN, replace those ranges with your own, and make sure your proxy
preserves `X-Forwarded-For` rather than overwriting it.

Migrations `0026` (event reschedule) and `0027` (indexes) apply automatically.
