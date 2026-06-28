# Snapdini — production cutover runbook

Clean cutover (no existing prod data). The public domain (`:3002` via Traefik) currently serves the
**coming-soon** holding page; this flips it to the real 1.0 app. Run the commands below from the
repo's `app/` directory on the host.

**Architecture (prod stack `snapdini-prod`, host port 3002):**
`nginx` → `web` (SvelteKit) for pages + `app` (Express) for `/api` + `/uploads`; `app` → `db` (Postgres 16).
Data: `./data-prod/pg` (Postgres, isolated from dev's `./data/pg`), media on `${UPLOADS_HOST}` (ZFS pool).
Secrets load from `.env.release` (NOT the dev `.env`).

---

## 0. Status of staging (done)
- [x] Prod compose (`docker-compose.yml`) brought to full parity — `db` + `web` + `app` + `nginx`.
- [x] `.env.release` complete — live Stripe/Mailgun, generated Postgres + admin secrets, `DATABASE_URL`.
- [x] Prod images built (`snapdini-prod-app`, `snapdini-prod-web`).
- [x] Boot dry-run on a fresh DB: 20 migrations applied (incl. perf indexes), admin bootstrapped,
      billing live (AUD), web 200. `./data-prod/pg` is the migrated, empty (admin-only) start state.

## 1. External prerequisites — CONFIRM before flipping
These live outside this repo. Production domain is **`snapdini.com`** (set in `.env.release`); every
item below uses it.

- [/] **DNS:** `snapdini.com` resolves to the NAS public IP.
- [/] **Traefik** routes `snapdini.com` → this host's `:3002`, with a valid TLS cert (Let's Encrypt).
- [/] **Stripe (LIVE)** webhook endpoint = `https://snapdini.com/api/billing/webhook`, event
      `checkout.session.completed`; its signing secret matches `STRIPE_WEBHOOK_SECRET` in `.env.release`.
- [/] **Mailgun** domain `mg.snapdini.com` is verified (DNS: SPF/DKIM/MX) and OUT of sandbox, so it can
      send to any recipient (verify by sending a real signup to a non-authorized address).
- [/] **Google sign-in (optional):** to enable, uncomment `GOOGLE_CLIENT_ID/SECRET` in `.env.release`
      and add redirect URI `https://snapdini.com/api/auth/google/callback` + JS origin `https://snapdini.com`
      on the OAuth client. Left commented = the Google button is hidden (password/magic-link still work).
- [/] **Uploads dir:** `${UPLOADS_HOST}` (=`/bigdata/snapdini/release`) exists and is writable by the
      container (app runs as root → `mkdir -p` it; if NFS, export `no_root_squash`).
- [/] **Admin:** `ADMIN_EMAIL` in `.env.release` is the address you want (currently `support@snapdini.com`);
      note the generated `ADMIN_PASSWORD` — rotate it in-app after first login.

## 2. The cutover (on the host)
```bash
# (optional) sanity from the repo root: integration suite green
npm run test:integration

cd app
# build the prod images from current code
docker compose -f docker-compose.yml --env-file .env.release build

# FLIP: stop coming-soon (frees :3002) and bring prod up — or just `./cutover.sh up`
docker compose -f docker-compose.comingsoon.yml down
docker compose -f docker-compose.yml --env-file .env.release up -d

# watch it come healthy
docker compose -f docker-compose.yml --env-file .env.release ps
docker logs -f snapdini-app   # Ctrl-C once "running on port 3000" + migrations done
```
Migrations apply automatically on `app` boot (Drizzle migrator) — the dry-run proved this on a fresh DB.

## 3. Smoke tests (against https://snapdini.com)
- [ ] Landing loads over HTTPS; logo + theme correct; no console errors.
- [ ] Sign up → **verification email arrives** (real inbox, not sandbox) → verify → dashboard.
- [ ] Create a **free** event → manager + QR (logo in centre); QR scans on a phone → join screen.
- [ ] Capture a few photos on a phone; reveal; gallery shows them; share link works (incognito).
- [ ] Generate a slideshow (intro/outro themed); download plays.
- [ ] **Admin:** sign in as `ADMIN_EMAIL` → `/siteadmin` loads; events/users tables populate.
- [ ] **Billing (LIVE):** create a paid event → Stripe Checkout (real card or 100%-off promo) →
      **webhook activates the event** (`docker logs snapdini-app | grep -i webhook`) → `?paid` stripped.
- [ ] Contact form sends; client-error capture lands in admin.

## 4. Rollback (instant)
```bash
docker compose -f docker-compose.yml down            # stop prod (data-prod persists)
docker compose -f docker-compose.comingsoon.yml up -d  # coming-soon back on :3002
```
`./cutover.sh down` does both. No data is lost — `./data-prod` and uploads are untouched.

## 5. Post-cutover
- [ ] Confirm the hourly retention sweeper logs (or `POST /api/admin/run-sweep` as admin to test).
- [ ] Back up `./data-prod/pg` (or `pg_dump`) + `${UPLOADS_HOST}` on a schedule.
- [ ] Watch `docker logs snapdini-app` / `snapdini-web` for the first day.
- [ ] Tag the release in git (`v1.0.0`) once the live stack is confirmed healthy.
