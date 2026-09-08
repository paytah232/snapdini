# Upgrading Snapdini

Most of the time an upgrade really is `docker compose pull && docker compose up -d`. The three
things that make it *not* that are below — all three have bitten a real deployment, so they are
worth two minutes before you start.

The quickest safe route:

```bash
cd /path/to/your/snapdini            # the directory holding your .env and docker-compose.yml
./upgrade.sh 1.4.0                   # or omit the version for :latest
```

The script checks the three traps, backs up `.env` and the database, upgrades, and verifies the
running version. It never overwrites your files — it tells you what differs and lets you decide.

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
diff docker-compose.yml   <(curl -fsSL https://raw.githubusercontent.com/paytah232/snapdini/v1.1.1/app/docker-compose.yml)
diff nginx/default.conf   <(curl -fsSL https://raw.githubusercontent.com/paytah232/snapdini/v1.1.1/app/nginx/default.conf)
```

Watch for defaults that move out of compose into `.env`: if a value was only a compose default
(`${OPS_DIGEST_HOUR:-8}`) and the new file drops the default, pin it in `.env` first or the
behaviour changes quietly.

### 3. A pinned `IMAGE_TAG` means `pull` fetches the same version

If `.env` has `IMAGE_TAG=1.0.8`, `docker compose pull` re-fetches 1.0.8 forever. Bump it:

```bash
sed -i 's/^IMAGE_TAG=.*/IMAGE_TAG=1.1.1/' .env
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
