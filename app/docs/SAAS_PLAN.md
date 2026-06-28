# Snapdini — SaaS Architecture Plan

> Status (updated 2026-06-21): **EXECUTING.** Postgres migration + accounts/auth proceed
> NOW so the full flow is testable. **Billing is the only deferred piece** — added later.
> Landing page + security-hardening tracks run alongside.

## 1. Where we are today

- No user accounts. Events are anonymous; the organizer holds a secret `organizer_code`
  (a capability/bearer token). Guests hold a `session_token`.
- SQLite (better-sqlite3, WAL), single prod container behind nginx + Traefik on a NAS VM.
- Feature-complete event app: create/join, camera, upload queue, galleries, reveal modes,
  themes, highlights, email, admin dashboard.

The SaaS pivot adds an **identity + ownership + billing layer above** the existing event
engine. The event engine itself changes little — events simply gain an `owner_user_id`.

## 2. Target architecture

```
Visitor → Landing page (marketing)
        → Register (email+password | magic link | Google)
        → Verify email (single-use, expiring token)
        → Dashboard ("my events")  ──owns──▶  Events (existing engine)
        → Billing (Stripe Checkout) → plan/limits enforced
Guests (no account) → join via code/slug → camera → gallery   (unchanged)
```

Two distinct user classes stay separate: **organizers** (registered, paying) and
**guests** (anonymous, session-token only). We do NOT force guests to register.

## 3. Data model (Postgres)

New tables; existing tables gain an owner link. (Migrate the 3 current tables 1:1 from
SQLite — schema is tiny, types map cleanly.)

```sql
users (
  id uuid pk, email citext unique not null, email_verified_at timestamptz,
  password_hash text,                 -- null for magic-link/social-only accounts
  display_name text, created_at timestamptz default now(),
  plan text not null default 'free',  -- free | pro | ...
  stripe_customer_id text
)

auth_identities (                     -- social / external logins
  id uuid pk, user_id uuid fk users,
  provider text,                      -- 'google', ...
  provider_user_id text,
  unique (provider, provider_user_id)
)

email_tokens (                        -- verification + magic-link, single-use
  id uuid pk, user_id uuid fk users, purpose text,  -- 'verify' | 'magic_login'
  token_hash text not null,           -- store HASH, never the raw token
  expires_at timestamptz not null, consumed_at timestamptz
)

sessions (                            -- server-side sessions (or use signed cookies)
  id uuid pk, user_id uuid fk users, created_at, expires_at,
  user_agent text, ip inet
)

subscriptions (                       -- mirror of Stripe state via webhooks
  id uuid pk, user_id uuid fk users, stripe_subscription_id text,
  status text, current_period_end timestamptz, plan text
)

-- existing tables:
events ... + owner_user_id uuid fk users   -- null = legacy/anonymous event
```

Tenancy is **row-level by `owner_user_id`** — every organizer query is scoped to the
authenticated user. (Optional later: Postgres RLS for defense in depth.)

## 4. Authentication (password + magic link + Google)

- **Password**: argon2id hashing. Registration triggers an email-verification token;
  account is unverified (limited) until confirmed.
- **Magic link**: enter email → emailed one-time link (`email_tokens`, purpose
  `magic_login`, ~15 min expiry, single-use, store only the hash). Doubles as
  verification.
- **Google**: OAuth 2.0 / OIDC. On callback, match or create `users` + `auth_identities`.
  Google emails are pre-verified.
- **Sessions**: HttpOnly + Secure + SameSite=Lax cookie holding an opaque session id
  (server-side `sessions` row). Rotate on login; revoke on logout.
- Library choice TBD (e.g. Lucia/Auth.js-style, or hand-rolled minimal) — decide at
  execution time.

## 5. Billing (Stripe)

- **Stripe Checkout** for subscriptions — we never touch card data.
- **Webhooks** (signature-verified) are the source of truth → write `subscriptions`.
- Plans gate limits: # active events, storage per account, video on/off, max guests,
  **photo retention window**, custom domain/branding. Enforce server-side at create/upload time.
- Free tier to drive signups; paid tiers for real events.

### Photo retention policy

- Photos (and their files) are purged after a **retention window**. Default **7 days**
  (self-host configurable via env, e.g. `RETENTION_DAYS=7`). Paid plans raise it
  (e.g. Pro = 90 days, etc.) — the effective window is `max(plan_retention, event override)`.
- Data model: store a `purge_at` (BIGINT epoch-ms) on `events` computed at create time
  from the owner's plan (falls back to the env default for anonymous/self-host events).
  Recompute on plan change.
- A periodic **sweeper** (interval job, e.g. hourly) deletes events past `purge_at`,
  cascade-removes participants/photos rows, AND unlinks the upload files + theme images
  from disk (this also fixes audit #12 — deletion currently leaks files).
- Surface retention to organizers ("photos available until <date>") and in plan copy.
- This is also our GDPR/retention story (see security priorities): bounded data lifetime
  by default, plus explicit account/event deletion.
- NOTE: a basic 7-day sweeper can ship now (pre-billing); plan-scaled windows land with
  accounts/billing.

## 6. Landing page (track running NOW)

- Replaces `index.html` as the front door (current create/join UI moves to the app/dashboard).
- Hero + value prop, feature showcase, how-it-works, placeholder screenshots, pricing
  teaser, register CTA (CTA wired to real auth at execution time).
- Self-contained, on-brand (dark, `#f5c518` accent).

## 7. Security baked in (see also security-hardening track)

- Secrets out of URL query strings → headers/cookies/POST bodies.
- Rate limiting on auth + verification + join/organizer lookups.
- Email tokens: hashed at rest, single-use, expiring, high-entropy.
- Upload hardening: magic-byte validation, EXIF/GPS strip, per-account storage caps.
- helmet (HSTS, CSP), TLS via Traefik (already), Stripe webhook signature checks.
- PII/GDPR: account + event deletion, data retention policy (we store emails + photos).

## 8. Phasing (execution order, later)

1. **Postgres migration** of the existing 3 tables (no behavior change) + connection layer.
2. **Accounts + email verification** (password + magic link), sessions, dashboard,
   `events.owner_user_id`, scope all organizer routes to the user.
3. **Google login**.
4. **Billing** (Stripe Checkout + webhooks + plan limits).
5. **Landing page CTA** wired to real registration; cut over `index.html`.

Security hardening (track 3) lands incrementally alongside, not as a final step.
