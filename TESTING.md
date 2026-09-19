# Snapdini — manual test checklist (dev)

Dev URL: your dev deployment (e.g. `http://localhost:3001`). Admin: the `ADMIN_EMAIL` / `ADMIN_PASSWORD` you set in `.env`.
Stripe **test** card: `4242 4242 4242 4242`, any future expiry, any CVC.

> **Before you start:** hard-refresh once (Ctrl/Cmd+Shift+R), or DevTools → Application → Service Workers → Unregister, so you're not on a stale bundle.
> **Legend:** `[ ]` = to verify · `[x]` = broken (tell me) · `↳` = note. Big rework since the last pass (moderation model, Review hub, share links, versioned 4K slideshows, camera, unified logo) — so it's all fresh `[ ]`.

## 0. Pre-flight
- [/] Dev URL loads over HTTPS; **logo is the gold 🎩 chip everywhere** (landing, dashboard, manage, gallery, login, share page) — same colour in all spots.
- [/] Stripe **test** webhook points at `…/api/billing/webhook`.
- [/] Email: Mailgun configured (magic-link, contact, gallery). *(dev sandbox only delivers to authorised recipients)*

## 1. Landing / marketing
- [/] Hero + branding; **theme toggle** (☀/🌙) flips + persists (default dark); light-mode gold legible.
- [/] Footer: **Contact · Terms · Privacy · GitHub** + **© 2026 Snapdini**; Terms/Privacy open and read professionally.
- [/] FAQ present; **"See the demo"** → desktop shows QR + Camera/Host/Gallery, phone opens camera. *(demo capped 2 guests × 12 shots)*
- [/] **Logged in:** nav/CTAs show **"My events →"** (→ dashboard), not a sign-in prompt.

## 2. Account & auth
- [/] Sign up → **verify** (dev link or real email to an authorised sandbox address) → dashboard.
- [/] Sign out, sign back in with password; **magic-link** login. **Google** → §9.
- [/] Rapidly navigate/refresh — **no spurious "too many login attempts"**.
- [/] **Promo create / general nav doesn't bounce a logged-in user to /login** (transient `getMe` failure no longer logs you out).
- [/] **Dashboard:** **Recent / Active / All** filter (default Recent) with counts; **real** guest/photo counts; long titles wrap; footer © + Terms/Privacy.

## 3. Create an event (pricing)
- [/] ~~Card order: "Your event" (name, **blurb**, guests, video, live price) → "When" → collapsible "Advanced settings".~~ *Superseded by the 4-step guided form — see §23.*
- [/] **Live total updates on EVERY change**; free features show **struck-through-green** price at ≤10 guests, un-strike to +$ above 10.
- [/] **Frame shapes:** ≤10 guests → all shapes **free & selectable**; **>10 guests → +$5 frame pack** (selectable, priced in). No in-between "limited" tier any more.
- [/] Duration free ≤2 days / paid 3+; retention "1 year" = 365 days from event end; downloads default on (tooltip).
- [/] Reveal defaults **"At the End"**; timezone searchable.
- [/] **Welcome blurb** → appears under the title on the join screen (and becomes the poster's default message).
- [/] **Free event** → manager + welcome modal (QR + link); no leftover `#code` in the URL.
- [/] **Paid event** → Stripe Checkout → success modal, `?paid` stripped, event active.

## 4. Manage event (organizer)
- [/] **Share & invite:** event code + *Copy*; **📤 Share** sends a link; **Save QR** PNG; copy join/gallery links.
- [/] Custom slug → `/e/<slug>` opens it.
- [/] **Theme:** pick a preset (**applies + saves instantly — no Preview/Save buttons**); **upload event image** (drag-drop) → reload → palette + image persist; no-theme event shows the warm default.
- [/] **Create poster:** title/message default from the event (**blurb** as the message); two-pane desktop; per-section colours + image palette; **colours follow the event theme until you edit one, then lock**; export PDF/PNG/JPG/Print. *(The S/M/L + 3×3 QR grid this line used to describe is gone — every element is now freely dragged and resized; see §16 and §23.)*
- [/] **Upgrades panel:** matches the create-form pricing — **priced line items** + a **new total**, charges only the difference; frame pack can't be added free; promo records the **actual** amount.
- [/] **Reveal / Lock / Downloads** toggle + persist; **Reveal ↔ Hide both work** (incl. ended at-end); **Settings** persist and keep the paid retention window.
- [/] The old **"All photos" card is gone** — there's a **Review & Curate** link card instead.
- [/] As a **site admin** on someone else's event: nav shows **🎩 Site admin / ← My events**; the **`#organizer` hash is stripped** from the URL after load (not left lingering).

## 5. Guest / camera (best on a phone)
- [/] Join screen: themed, blurb under title, bg keeps aspect; **email field hint** explains it lets you continue on another device / after sign-out; **Join & open camera**.
- [/] **Recovery:** re-join the same event with the **same email** on another device/incognito → "Welcome back" with your remaining-shots preserved (not a fresh participant).
- [/] Capture full quality; aspect shapes; grid; **photo/video labels black when selected**.
- [/] **Brightness:** **drag left/right across the viewfinder** → HUD with level + **↺ reset**, lingers ~2s; a **vertical** swipe still scrolls/pulls-to-refresh (not hijacked).
- [/] **Camera off** button (🎥-with-slash) in the rail → "Camera is off" overlay → **Turn camera on** works; leaving to the gallery / backgrounding releases the camera (indicator clears).
- [/] **Flash/torch:** back camera shows ⚡ that **fires for the shot** (and stays on for video); front camera screen-flash.
- [/] **Settings modal** (centred): Grid, Save-to-device, Camera picker (2+ cams), **Video quality** (4K default / 1080p / 720p) — each with a one-line description.
- [/] **Video records smoothly** (no slideshow framerate); if a device struggles, a "lower the quality" toast appears; quality switch keeps the **same camera** (no lens swap).
- [/] Re-acquiring the camera shows a **spinner** over the image only (top bar/menus stay visible).
- [/] **Upload queue:** opens from a **⬆ Queue** button in the gallery header (with count), not automatically; rows show **size / dimensions / length**; "done" clears on close; badge goes **red** on error.
- [/] **Offline test:** mid-capture `docker compose -f app/docker-compose.dev.yml stop app`, shoot (queues), `… start app` → auto-uploads.
- [/] **Gallery (instant-reveal events):** **Mine / All / Others** filter (default Mine) with counts, newest-first; lightbox shows who/when + size.

## 6. Moderation model
- [/] Event with **moderation OFF:** a new photo is **visible** in the gallery immediately (stored pending, shown).
- [/] Turn **moderation ON** afterwards → those existing photos are **held** (hidden) until approved — not auto-approved.
- [/] Approve one → it appears in the gallery.

## 7. Review & Curate (the photo hub — after photos exist)
- [/] Header: **Cards / Single** toggle + a separate **🎬 Slideshow** button.
- [/] **Approve** shows on pending photos (and bulk); **★ Favourite is separate** — favouriting does **not** approve.
- [/] **Reject is two-click:** ✕ Reject → **"Sure?"** → second click confirms; clicking elsewhere resets. Rejected → **🗑 bin**, **Restore**-able, excluded from gallery/share/slideshow.
- [/] Per-card + lightbox show **media info** (dimensions/length · size).
- [/] **Select mode:** tap to select, **shift-click range**, All / ★ Favs quick-select; bulk **Download / Share / Favourite / Approve / Reject**.
- [/] **Download:** one = the image/video, several = a **.zip**.
- [/] **Single view** is condensed (two tidy rows, not a tall stack).

## 8. Sharing
- [/] **📤 Share gallery** → a link to the whole (visible) gallery.
- [/] **Select photos → 📤 Share** → a **`/s/<token>`** link showing just that subset.
- [/] Open a share link (signed out): event name + theme, newest-first, lightbox; **rejected/pending-when-moderated photos are excluded**; invalid token → friendly error.

## 9. Slideshow (🎬 in Review)
- [/] **All / Favourites** with counts; **seconds-per-photo**; **Resolution (4K default / 1080p)**; **Quality (Best/High/Smaller)**; **estimate** shows length + photos/clips + **~MB**.
- [/] **Backing track:** ▶ preview + volume; upload your own; **include video clips** + **keep clips' sound**.
- [/] **Generate** → **live progress bar** (no "stuck on starting"); result **plays in-browser**; **intro card** (gold 🎩 chip + event name/blurb/date over the event image, theme accent, © footer) and a **closing card** (snapdini.com + ©).
- [/] **No mid-video freeze** with video clips included; the logo chip is the **same gold** as the site.
- [/] **Recent slideshows** list: play / **⬇ download** / **★ favourite-to-keep** / **🗑 delete**. *(non-favourites auto-purge after ~a day; favourites kept to retention)*

## Manager links (the URL shape that actually works)
The manage page is `/admin/<joinCode>?code=<organizerCode>` — the path segment is the **join code**,
and the organizer code rides in `?code=`. Passing the organizer code as the path segment looks right
and renders a page, but the event lookup 404s and you are dropped at the "enter your code" prompt.
Once used, the code is cached per-event in localStorage, so later visits to `/admin/<joinCode>` work
on their own.

## 10. Site admin
- [/] Sign in as admin → **🎩 Admin** → `/siteadmin` (distinct styling, back-to-events).
- [/] **Events table:** narrower/stacked — name + **join code beneath**, **owner/guests/photos stacked**, **status + purge timing** (e.g. "purges ~5d" / "purged …"); Active/All filter, search, pagination, **Manage →** override.
- [/] **Users / Contact / Client-errors** panels: search, filters, pagination work.
- [/] **Promo codes:** create → list + Stripe (test) → discount at Checkout.
- [ ] **Guest feedback** panel lists ratings + comments with the event they came from, and a
      running average. Guests from purged events show as **anonymised** rather than vanishing.

## 11. Security spot-checks
- [/] `/siteadmin` signed out → prompt; non-admin → "admins only"; `GET /api/admin/*` no admin session → **401/403**.
- [/] `/admin/<someone-else's-code>` in a **fresh browser** → access wall.
- [/] **Frame pack can't be unlocked free** via the manage Settings on a paid-tier event (non-square shapes are disabled there unless paid).

## 12. Needs external setup before full verification
- [/] **Google sign-in:** add the dev callback `…/api/auth/google/callback` (+ JS origin) on the OAuth client → button appears, sign-in completes.
- [/] **Stripe end-to-end:** real test checkout **incl. a 100%-off promo** → webhook records the **actual** amount, event activates.
- [/] **Email:** dev (sandbox, authorised recipients) + prod (`mg.snapdini.com`) sends.

## 13. Latest session (verify these specifically)
- [/] **No 11–15 tier:** create form — ≤10 free + frame shapes selectable; **11+ guests is paid** (no free "limited" band); >10 adds the **+$5 frame pack**.
- [/] **Upgrade blocked while settings dirty:** on Manage, change a setting (don't save) → the Upgrade panel shows **"Save your settings first"** and is disabled until you save.
- [/] **Poster:** Plain-colour background defaults **white** + colour picker + **White/Match theme**; text auto-contrasts; **QR is white with the 🎩 logo in the centre** and still scans.
- [/] **Camera:** logo chip uses the **event theme** colour; **#snap-number badge** on each "Mine" thumbnail; off-button is a **camera-with-slash** when on, plain camera in the "camera off" overlay.
- [/] **No-flash event:** create with **No flash** on (advanced settings) → on a phone, the rear **⚡ flash button is gone** / rear LED never fires; front selfie screen-flash still works.
- [/] **Recovered gallery:** re-join by email, shoot after the host has revealed (moderation on) → your **new shots still show in your own gallery** (pending), but not in the public gallery.
- [/] **Share link:** before reveal shows a **countdown** (not photos); after reveal shows photos with **Select + Download all/selected** (zip).
- [/] **Review single view:** no Select; **Share** sits beside Approve/Reject; only the top **Cards** toggle (no in-view duplicate).
- [/] **Restore:** restoring a rejected photo (moderation on) sends it back to **pending** (Approve button reappears), not straight to approved.
- [/] **Pink theme** appears in the theme presets and applies.
- [/] **Slideshow:** intro card event image uses **smart crop** (faces not sliced); low-res selfies look cleaner (Lanczos upscale); **download names the file** `<event>-<date>-snapdini.mp4`; a **4K render also offers a 1080p** download (live transcode).

## 14. Co-hosts
- [/] Manage → **Co-hosts** card: invite by email → an **invite row with 🔗 Copy link**; invitee opens `/cohost/<token>`, signs up/in (verified), **Accepts**, lands on the manager.
- [/] Co-host **manages like the owner** (settings/reveal/photos/slideshow/cohosts); the event shows on their dashboard with a **Co-host** badge.
- [/] **Owner is protected:** a co-host can't remove the owner and **can't delete the event** (only the owner can); co-hosts can add/remove other co-hosts.

## 15. Slideshow music, paid-frames, share v2
- [/] **Music:** pick **multiple tracks in order** (reorder/remove) + **Loop** toggle; durations show; with loop off and music shorter than the show, a **⚠ warning** appears (still generate-able).
- [/] **Remove Snapdini frames:** slideshow shows a **$1** "Remove intro & outro" option. It is **always paid** on hosted plans (no free-over-$50 rule) — only free on self-host (billing off). Paying unlocks a frames-free video, and returning from checkout **auto-enables the toggle**.
- [/] **Share v2:** **📤 Share** with nothing selected shares the **current filter** (gallery or favourites) via a **modal** (summary + link + Copy/Share/View + rename + custom URL); selecting photos shares just those; Manage → **Shared links** lists all shares to **copy / rename / change URL / delete** (existing links keep working).

## 16. Latest pass — poster, join, theme, co-host accept, scheduling (verify these)
- [ ] **Poster editor:** click an element → its **outline + corner ⤡ resize grip** appear (hidden otherwise); **drag anywhere** on an element to move; elements **can't be dragged off** the poster; the outline **resizes live** as you edit text or toggle the QR's code/URL; **Reset layout** lands everything correctly with no overlap; the **logo** slides left/right along the top only (no resize).
- [ ] **Poster theme colours:** "Match theme" is **always** offered (even on an un-themed event — uses the warm default) and is the **default background** when there's no event image; "**↺ Use theme colours**" reverts edited text colours to the theme.
- [ ] **QR everywhere:** the manage-page QR, **Save QR** download, and poster QR all look the **same** — black-on-white with the **🎩 logo baked into the centre** — and still scan.
- [ ] **Custom URL post-create:** Manage → Settings has a **Custom URL** field (set / change / clear, with availability check); taken slug → error.
- [ ] **No-flash sticks:** toggle **No flash** in Manage → Settings, save, reload → it **persists**; on a phone the rear ⚡ is gone.
- [ ] **Scheduling:** new events default start to **midnight of the next day**; once an event has **started**, the start date/time is **locked** (note shown); upcoming events still reschedule.
- [ ] **Join screen:** **Snapdini logo** at top (not a camera emoji); a prominent **"limited roll — N snaps, make them count"**; an **Event info** section (collapsed) with photo shapes / video / reveal — **no "Square" chip** when square is the only shape; fits one mobile screen with info closed.
- [ ] **Co-host accept in-app:** an invited, signed-in user sees **"X invited you to co-host Y"** on their **dashboard** with **Accept**; accepting stays on the dashboard and the event appears in their list (the emailed link still works too).
- [ ] **Slideshow theme:** a freshly-generated slideshow uses the **event theme background** (not black/white) and the **event image** on the intro **and** outro cards.
- [ ] **No white flash** on load or when navigating between event pages (theme is applied before first paint).
- [ ] **Review:** **Approve** buttons disappear when moderation is **off**; cards stay the **same height** whether one or two action buttons show.

## Automated coverage (no manual test needed)
- Moderation default + enable-later hold, decouple (favourite ≠ approve), reveal/hide override, retention purge (thumbnails, custom audio, slideshows), `/mine` counts, reject-bin, client-error capture, custom-audio validation, **share v2 (all/favourites/selected + slug rename + reveal-gating + zip download)**, **slideshow versioning + download endpoint**, **frame-pack settings gate**, **no-flash persistence**, **restore→pending**, **own-photos-visible-after-reveal**, **11+ paid tier**, **co-hosts (invite/accept/manage-by-identity/owner-only-delete/remove)**, timezones, billing-amount audit.
- **1.0 additions:** settings `noFlash` round-trip + `noFlash` on the join / `/me` / `/admin` responses; **event slug** set/clear + **too-short 400 / duplicate 409**; **reschedule locked once started** (allowed while upcoming); **share-create no longer auto-claims a slug** (token URL) + default label leads with the event name; **`/qr` returns a logo-baked PNG**; **co-host pending-invite list** (appears / drops off on accept); **10s video tier = $2**; **frame-removal always paid** (branding:false → 402 until bought); **purge frees the event slug + deletes share rows** (via admin `/run-sweep`); `photoIds` capped on moderate/highlights; login rate-limited.
- Run from `devel/`: `npm test` (typecheck → unit → integration → e2e). Integration suite:
  **787 integration + 850 unit passed, 0 failed** (integration ~140s), and it gives the same totals
  run three times back to back — and leaves every table's row count byte-identical while doing it — the dev stack raises the per-IP limiters the suite spends
  (`FACE_ENROL_RATE_LIMIT`; see docs/DEVELOPMENT.md). `run.mjs` lifts `ADMIN_EMAIL`/`ADMIN_PASSWORD` off the
  local dev container when they aren't in your environment, so the operator-only assertions run
  by default instead of silently skipping (they were skipping, and it hid ~22 tests).
- The integration suite is an orchestrator (`testsuite/run.mjs`) over per-area specs in
  `testsuite/specs/`, run as separate processes in a concurrency pool. Useful flags:
  `--only=<substring>` (one spec — a few seconds), `--jobs=N`, `--serial`, `--list`.
  Specs named `9x-` touch global DB state (`run-sweep`, admin-overview counts) and run alone
  after the pool, so nothing can create an event while they are counting. `11-video-length` is now
  `91b-video-length` for that reason. A determinism pass (see "Integration suite layout" in
  docs/DEVELOPMENT.md) removed every fixed sleep before a DB read, scoped the whole-table counts to
  each spec's own rows, and moved every clean-up into the teardown `finally`; the suite no longer
  truncates `site_events`, no longer deletes users by a `LIKE` pattern, and no longer leaks
  operator sessions (1,845 had accumulated) or operator-owned events.
- **1.2 additions:** referral attribution (cookie is httpOnly and resolves to the event id;
  a referred signup *and* their first event are both attributed; a host referring themselves is
  not counted; a cookie outliving its event is ignored); write-behind counters coalesce and do
  not write on the request path; `download_count` is separate from `view_count`; no unpaid or
  refunded event holds a host reward code; testimonial consent is gated on positive feedback.
- **1.5 additions:** the CSV import plan (header guessing, column mapping, duplicate identity by
  **the address alone** — `identityKey()` (name + note) went with 0054, since every guest now has
  an address — a phone column detected and resolved to *don't import* rather than
  stored, per-row problems); Mailgun webhook signature verification and event
  normalising; delivery-state ordering (a provider event older than the one already recorded cannot
  overwrite it); the suppression **chokepoint** — a test walks the server source and fails if
  anything but `email.ts` reaches for a transport, and pins the check as running *before* a transport
  is chosen; unsubscribe token/scope/feedback parsing and the merge of global vs per-event blocks;
  account email preferences; the guest-delivery rules shared by the create wizard and Settings
  (reminder window, scheduled-send vs reveal); the email-budget month window, floor and thresholds.
  Plus the **email-recovery hardening**: the recovery budget's key (per event + lower(address), a
  guest list not locked out by one burned address, and a 30-guest venue on ONE NAT address passing
  untouched), that a refused attempt mints no session token, and the takeover alert's masked address
  and escaped names (`app/src/server/__tests__/recovery-hardening.test.ts`,
  `testsuite/specs/97c-recovery-hardening.mjs`).
  And the **guest list and invite sending end to end**, which until now had no integration spec at
  all: `testsuite/specs/17-guest-list.mjs` (an address is required on create *and* on edit, with the
  exact wording; a name is not; a case-folded duplicate is a 409; an organizer code reaches only its
  own event's list; the order is alphabetical and an edit does not move a guest — built over a
  batch import so the whole batch shares one `created_at`, which is the tie the old
  `ORDER BY created_at` fell apart on; **and that one address per list is the DATABASE's rule** —
  `idx_event_guests_event_email` is asserted to be keyed on `lower(btrim(email))` (migration
  **0055**), and a plain `INSERT` that skips the writer's own `toLowerCase()`, or carries a stray
  space, is refused by the index itself. Going round the writer is the only way to test a second
  line of defence, and under 0047's byte-exact key those inserts both landed), `testsuite/specs/18-guest-import.mjs` (a `Name,Email,Phone`
  sheet imports clean with the digits reaching no stored field; `{add, skip, duplicate, invalid,
  noEmail}` with `noEmail` counted apart from `invalid`; per-row reasons that keep the guest's name;
  one loud `fatal` when no column maps to Email; headerless inference from a 20-row sample and a
  consumed header row reported; dedupe by the address alone) and
  `testsuite/specs/19-guest-invites.mjs` (a suppressed address — global *or* event-scoped — is
  reported as `skipped` with its reason and never counted as `sent`, and gets no `guest_invites`
  row; deleting a guest leaves the invite behind with `guest_id` NULL; one `share_sends` row per
  address for ever, surviving a second press, a case variant and an explicit resend; a withheld send
  corrects its claim row to `ok:false`; a forged webhook signature is a 406).
  **Those three send no real mail and do not depend on any leaving**: every address is
  `@example.com` with a per-run unique prefix, suppression rows are written directly rather than
  provoked with a real bounce, and every assertion is on the API's own accounting and on the
  database. §24 stays as the manual pass over the SCREENS.
- **Two latent guest-list defects fixed in 1.5.0, both second-line-of-defence answers that were
  wrong** (neither reachable from outside, both found by deliberately removing the first line):
  the `POST`/`PATCH` guest routes reported a **NOT NULL** violation as *"That email is already on
  this guest list"*, and the unique index was keyed on the raw column so it could not catch what
  the writer was trusted to do. `app/src/server/__tests__/db-errors.test.ts` pins the SQLSTATE
  discriminator — including the shape that matters, a `DrizzleQueryError` whose `.code` is
  `undefined` because the real code sits on its `cause`.
- **DB:** migration `0019_perf_indexes` adds indexes on the hot paths (`photos(event_id)`, `(event_id,status)`, `(event_id,taken_at)`, `(participant_id)`, `participants(event_id)`, `event_cohosts lower(email)`, and the user-FK cascade columns).

## 17. Version 1.2 — referrals, gallery stats, retention (verify these)
- [ ] **Gallery referral card:** open a revealed gallery → a **"Liked this? / Start your own"** card
      sits under the photos, and its link carries `?ref=<join code>`. Within 48h of a reveal the
      wording becomes **"Want this at yours?"**.
- [ ] **Guest roll-finished card:** as a guest, use your last shot → your own gallery shows the same
      card, emphasised (it should NOT be emphasised on a casual gallery visit with shots left).
- [ ] **Shared-link card:** open `/s/<token>`, hit **Download all** → the card appears emphasised.
      Its link uses `s:<token>`, **never the join code** (a share is view-only by design).
- [ ] **Attribution:** follow a `?ref=` link, sign up, create an event → `/siteadmin` →
      **Referral funnel** shows the click, the signup and the event against that source gallery.
- [ ] **Gallery stats:** scroll a gallery, download a photo → per-photo **views/downloads** climb in
      the funnel's engagement figures. They should update a few seconds later, not instantly.
- [ ] **Testimonial consent:** open a survey link, score **4-5 / NPS 8+** → a
      **"Happy for us to share this as a review on our website"** checkbox appears with an optional
      name field. Score low → the ask must **not** appear.
- [ ] **Retention:** create a free event → **7 days**. Create a paid one → **30 days included**, with
      **3-month** and **12-month** add-ons priced above it. The pricing page must say the same.
- [ ] **Reschedule:** open an event that has **started but had no guests join** → *Move to a new date*
      is offered, capped at 6 months from the ORIGINAL start. Once a guest joins, it locks.
- [ ] **Pricing page:** no **LAUNCH20** claim anywhere (it expired 2026-07-28); the discount FAQ
      leads with the free-under-10-guests tier and the post-event host code.
- [ ] **Maker links:** hosted (billing on) → **no "Buy me a coffee"** on home / pricing / use-case /
      contact / login / signup. Self-hosted (billing off) → **always visible**.
- [ ] **Turnstile:** contact, signup and login all **render the widget** and submit cleanly. Verify
      from **outside the LAN** — the widget is blocked by Pi-hole on-network. The submit button must
      not jump when the widget appears.
- [ ] **Turnstile blocked** (this one is best tested **on** the LAN, where Pi-hole blocks it): signup
      and login show the "couldn't load the security check … challenges.cloudflare.com" notice in the
      space the widget would have taken, in **both themes** and at **400px** with no sideways scroll.
      With `TURNSTILE_FAIL_OPEN` unset, submitting then names the same address rather than answering
      "bot check failed".
- [ ] **Video over the tier:** on an event with a 10s video add-on, upload a ~20s clip from your
      camera roll → it is **accepted, with no message telling you it was over** (the tolerance must
      stay invisible to guests). On an event with **no** video add-on, the same upload is **refused**.
      `/siteadmin` then shows it under video overages, tagged as a camera-roll upload.
- [ ] **Dark mode:** `/siteadmin` promo-code inputs are **not white-on-white** in dark mode.

## 18. Version 1.3 — delete window, guest top-ups (verify these)
- [ ] **Take a shot back:** shoot a photo, open your own gallery → a **bin with a countdown** sits on
      that photo. Tap it: the photo goes and the roll goes back up. Wait past **30s** (the window is
      `PHOTO_DELETE_WINDOW_SECONDS`, served to the client at `/api/config`, so a deployment that
      changes it changes the countdown too) → the bin disappears and the shot is permanent.
      **No delete control on the camera screen.**
- [ ] **Two shots, two bins:** take two quickly; each carries its **own** countdown, and deleting one
      leaves the other ticking.
- [ ] **Out of shots:** spend the roll → a panel offers *Ask the host for more* and *Get 12 more*.
      Nothing about upgrades appears while shots remain.
- [ ] **Asking** confirms in place ("✓ Host asked") without leaving the camera, and the count shows
      on the host's Manage page.
- [ ] **Buying** opens Stripe (test card `4242 4242 4242 4242`), returns to the camera with a
      confirmation, and the roll is higher. Refresh: the confirmation does not repeat.
- [ ] **Host switches** on Manage: turn *buy* off → the Get-more button disappears for guests. Turn
      *ask* off → the Ask button disappears. Both off → no panel at all.
- [ ] **Purchased shots survive** the host lowering the event roll.
- [ ] **Sales close** in the last 15 minutes of an event.
- [ ] **`/siteadmin` → Guest top-ups** lists paid guests and offers a refund.

- [ ] **Video capability check:** switching to video for the first time offers a check. Running it
      reports real fps for 4K / 1080p / 720p, names the quality it picked, states the event's video
      limit, and waits for **Got it**. If 4K misses 30fps it also offers the phone's own camera and —
      on a square-only event — asks them to frame it square. Asked once per device; Skip is honoured.
- [ ] **Uploads pause while recording:** shoot a photo then immediately record — the clip should not
      stutter from the photo uploading underneath it.

## 19. Version 1.4 — face matching (verify these)
- [ ] **Absent by default (the kill switch):** with no `MACHINE_LEARNING_URL` the feature is fully
      inert — the host never sees the *Let guests find photos of themselves* toggle, `/me` reports
      `faceMatching: false` **even if `face_matching_enabled` is already true on the event row**,
      `/api/faces/enrol` and `/api/faces/mine` return 503, and the privacy policy's face section is
      not rendered. `DELETE /api/faces/enrol` deliberately still works, so anyone who enrolled
      while it was on can always withdraw.
- [ ] **This is how it ships.** Face matching stays **off in production** — face templates are
      biometric data and the compliance picture varies by jurisdiction. It is fully built and supported
      as a **self-host** feature: a
      self-hoster running their own events points `MACHINE_LEARNING_URL` at an Immich ML container
      and gets it. Leave it unset on prod; devel is the only place it is on.
- [ ] **Self-host story reads correctly:** README's *"find the photos I'm in"* section explains the
      ML container needs no access to photo storage, and that the feature ships off.
- [ ] **Host gate:** with the host switch OFF, a guest sees no "Find photos of me" control and the
      endpoint refuses with 403.
- [ ] **Consent gate:** the checkbox is **never pre-ticked**; the selfie button stays disabled until
      it is ticked; submitting without consent is refused server-side too.
- [ ] **Where it lives:** only on the **shared gallery** (`/gallery/<code>`) — never on a guest's own
      roll inside the camera, where searching your own shots for yourself means nothing. Once the
      gallery is revealed and other guests have shot something, the camera's gallery shows an
      **Open the full event gallery** link, which is the only route guests have to that page
      (there is no automatic redirect when an event ends).
- [ ] **Participants only:** the control appears only if this browser holds a guest session for the
      event. Open `/gallery/<code>` in a private window → no enrol control at all.
- [ ] **It works:** enrol with a selfie → told how many photos you were found in → an **All / Me**
      filter appears on the shared gallery showing exactly those photos, and the lightbox pages
      through the filtered set, not the full one.
- [ ] **It discriminates:** a photo of somebody else is NOT matched to you.
- [ ] **A phone selfie works:** enrol using a photo taken in **portrait on a handset** (these carry
      an EXIF rotation the ML service ignores). If it is rejected, `docker logs snapdini-dev-app |
      grep '\[faces\] selfie rejected'` now prints the format, dimensions, EXIF orientation and the
      best score seen at a low probe floor — that line says whether the floor, the format or the
      photo itself is at fault.
- [ ] **Withdrawal:** "Stop and delete" removes the template and every match; the Me chip disappears
      and `/api/faces/mine` reports you as not enrolled.
- [ ] **No leakage:** no API response anywhere contains an `embedding`.
- [ ] **Privacy page** section 6b explains face templates in plain language.

## 20. End of event — guests land on the gallery
- [ ] **Redirect:** open a join link for an event that has **ended with its gallery open** → you are
      sent to `/gallery/<code>` instead of a camera that cannot take a photo. Pressing **Back** does
      not bounce you into a loop (the join entry is replaced, not pushed).
- [ ] **Not before reveal:** an event that has ended but whose gallery is still **locked** (manual
      reveal, host hasn't pressed it) does **not** redirect — the in-app view is the only place a
      guest can still see their own shots.
- [ ] **Never mid-session:** an event that expires while you are shooting leaves you on the camera
      with a toast. The redirect only happens on a fresh load.
- [ ] **Nothing stranded:** if captures are still queued for upload, the redirect is skipped until
      they finish.

## 21. Version 1.4 — guest feedback (verify these)
- [ ] **Where it's offered:** a **Leave feedback** button sits next to *Start your own* in the
      gallery, and on the **"that's your roll"** toast on the camera page. Nowhere else — it should
      never interrupt someone mid-shoot.
- [ ] **Optional by design:** a rating alone submits; a comment alone submits; an empty form is
      refused. Dismissing is accepted and you are **never asked again on that device**.
- [ ] **One guest, one opinion:** submitting twice does not create a second entry, and the first
      answer stands.
- [ ] **You can actually read it:** `/siteadmin` → **Guest feedback** shows what you just left,
      with the comment and the event name.
- [ ] **It outlives the event:** feedback is product signal, so the retention purge **detaches** it
      from the guest instead of deleting it — the rating and comment survive, the person does not.
      (Before 1.4 it cascaded off `participants` and erased itself ~31 days after every event.)

## 22. Product analytics (first-party, cookieless)
- [ ] **It records:** browse the site, open a FAQ, click a pricing tier, then join an event and take
      a shot. `/siteadmin` → **How people use the site** shows a host funnel and a guest funnel with
      the drop-off between steps, plus most-visited pages and which tier was clicked.
- [ ] **Camera permission finally has a denominator:** the panel states an *allowed %* — denials were
      always visible in client errors, but nothing said how many people said yes.
- [ ] **Nothing is stored on your device:** open DevTools → Application. There must be **no cookie
      and no localStorage/sessionStorage key** for analytics. Visit grouping happens server-side.
- [ ] **No URL secrets:** visit `/admin/<code>?code=<organizerCode>`, then check the panel's
      most-visited list — it must read `/admin/:code`, never the code or the token.
- [ ] **Unfelt:** the site should be indistinguishable with tracking blocked. Measured on a Pixel 7
      profile over 5 runs: median FCP 104ms with tracking vs 108ms blocked on `/`, 88ms vs 104ms on
      `/pricing`, and **0ms of long tasks** either way — the difference is noise.
- [ ] **Ingest is cheap:** `POST /api/track/events` is 3–6ms p95, and a 20-event batch costs no more
      than a 1-event batch (the response is sent before anything is written).

## 23. Version 1.4.4 — event type, poster designer, reveal timing, downloads, slideshow

### Event type at creation
- [/] ~~**`/app` walks you through it:** a step strip (*Your event · When it runs · The details ·
      Ready*)~~ *Superseded in 1.5.0 — five steps now, and step 3 was renamed. See §24.*
      **Show me everything at once** on step 1 drops to the flat form and **Walk me through
      it instead** restores it. No step blocks you except "name it to continue".
- [ ] **Event type chips** sit directly under the name. Tapping the selected one clears it. Skipping
      it entirely still creates a working event.
- [ ] With a type picked, **"Give my guests a list of shots to hunt for"** appears; ticking it and
      creating the event lands on a manager that already has a trick list, matching that type.
- [ ] The type drives **four** things, so check all four: the missions offered, the **tick glyph**,
      the **card decoration**, and which **poster design** the gallery puts first and marks.
- [ ] Changing the type later in the trick-list editor works and does not strip the existing list.

### Reveal timing
- [ ] **Start time and reveal time both step in 15 minutes** on the picker (`/app` and Manage →
      Settings, and the reschedule dialog).
- [ ] **Delay presets** read: immediately · 1h · 3h · 12h · 24h · **2 days · 3 days · 1 week**.
- [ ] **"Pick an exact date & time…"** reveals date + time inputs, and the hint states the exact
      moment ("Photos appear from …"). Type **7:05 pm** → it says **7:15 pm** and explains why.
- [ ] **The event's timezone, not yours.** Set the event to a zone several hours from your device,
      pick a reveal, save, reload → the form shows back **the wall-clock time you typed**, not that
      instant translated into your own zone.
- [ ] **Refused, not silently fudged:** pick a reveal *after* the retention window ends → a clear
      error naming retention, and nothing is saved.
- [ ] **Existing events are untouched:** an event created before this release still reveals at
      end + delay, and its `reveal_at` is NULL.
- [ ] **The gate agrees with the countdown.** With a custom reveal a few minutes out, the guest
      countdown, the share page and the actual unlock all name the same minute.

### Poster designer
- [ ] **Design gallery** shows **8** tiles + **Start from scratch**; the tiles carry your event's
      real name/message/QR, not lorem. Escape and the backdrop both close it.
- [ ] Picking a design also **themes the app** (join screen / camera / gallery), and the Theme card
      shows the design's matching palette as the selected preset rather than highlighting nothing.
- [ ] With a design saved, the button reads **🎩 Manage poster** and a second button
      **Start again from a design…** reopens the gallery. Manage poster must NOT throw the work away.
- [ ] **Guided steps:** *Words · Type · Join · Art · Colour · Place*, each with its question and the
      preview beside it. **Skip — show me every control** and **Walk me through it instead** both work.
- [ ] **Cards tab steps:** *Words · List · Layout · Art · Colour*; with only one trick card the
      **List** step is stepped over and says why, rather than being a dead end.
- [ ] **Type:** all five pairings (Plain / Editorial / Formal / Garden / Modern) render in their real
      faces — **no frame of Arial** when flipping between them, and the exported PNG matches the
      preview. (The fonts are self-hosted; test with the network throttled.)
- [ ] **Names lockup:** "Rachel and Ross" → two stacked names with *and* in script between hairlines;
      "Mia & Sam" keeps the ampersand; "The Wus" sets as one line; blank draws nothing.
- [ ] **Small lines above/below the title** set as tracked caps and can be left empty.
- [ ] **Snapdini mark** toggles off; the **logo inside the QR** does not (and the code still scans).
- [ ] **White card behind the QR:** on a light background the checkbox is enabled and the hint states
      a contrast % and grade; on a dark background it is **disabled** with the reason; over a photo
      background it always stays. Untick it, then darken the background → **it turns itself back on**.
- [ ] **Placed decorations:** add several, drag, resize, **rotate**, ↺ Upright, remove one, Remove
      all. Adding one must **not** change the design's own decoration.
- [ ] **Your own text lines:** add two, edit, drag, resize, delete. They can't leave the page.
- [ ] **Tap an element on the preview to edit it** (title / message / how-to / names) — and a *drag*
      must not open the keyboard.
- [ ] **Hover or focus a control → the thing it changes is outlined**, including an empty field,
      which shows where its words *would* go.
- [ ] **↶ / ↷** are in the header, enabled/disabled correctly, and reachable **mid-drag and in
      full-screen Arrange**. Ctrl/⌘+Z works.
- [ ] **Background as paper:** with a plain colour and "print the background" off, the colour shows
      while designing and is **absent from the exported PDF/PNG/JPG**.
- [ ] **Light ink on dark paper** produces a *note* about white toner / screen print / foil, not a block.
- [ ] Nothing can be dragged outside the **5 mm print margin**.
- [ ] **Card sheet orientation:** Portrait/Landscape at **1, 2 and 4** per sheet; the note under the
      buttons names the real result ("Two portrait A5 cards, cut down the middle"), and a landscape
      PDF/print dialog is **landscape** — not a letterboxed portrait page.
- [ ] **🖨 Front & back…** (only with a trick list) previews both pages sharply, pairs the poster
      with the **previewed** set, and says to flip on the **long edge**.
- [ ] **A big design still saves.** Place ~20 motifs and several text lines, reload the event page →
      it opens. (An oversized design must be refused with a message, never 500 the event page.)
- [ ] `grep -ri camerabig` over the repo returns **nothing** — the motif was added and removed.

### Sharing & downloading
- [ ] **Review → 📤 Share** opens a scope question: **whole gallery / favourites only / pick them
      myself**, with real counts, and photos vs clips counted separately. Favourites is disabled with
      an explanation when nothing is starred.
- [ ] The **favourites link keeps up**: open it, then star another photo → the link shows it, with no
      re-share.
- [ ] **Gallery → Download** asks the same three questions; "the whole gallery" must not change
      meaning with the **Highlights** toggle.
- [ ] **Per-photo ⬇** on gallery tiles saves one photo, and the tile then shows it is already saved
      on this device. Hidden entirely when the host has disallowed downloads.
- [ ] **Files vs zip:** on a phone the first bulk download **asks**, remembers the answer, and the ⚙
      reopens the choice. On a desktop it goes straight to a zip. A big roll saved as files shows a
      running count and does not blow the tab up.
- [ ] **iOS:** saving opens the share sheet (→ Photos, not Files); **cancelling it saves nothing**
      and must not fall through to a download or tick the tile.

### Slideshow
- [ ] **No cap:** render an event with well over 60 photos → every one is in the film, and the end of
      the night is not missing.
- [ ] **Order:** *Start → end* vs *🔀 Shuffled*. Re-watching a shuffled render plays the **same**
      cut; a new render deals a different one.
- [ ] **Queue:** press Generate while one runs → a toast says it was queued, the queue list shows it,
      and it starts on its own. A 4th while 3 wait is refused with a message, and the running render
      is never killed.
- [ ] **Survives the tab:** start a long render, close the tab, come back → the bar picks up (or the
      film is in Recent). Lock the phone mid-render and return → the bar resumes rather than sitting
      frozen.
- [ ] **Chunk joins are invisible:** watch a long render right through — no dropped or doubled frame
      at a crossfade, and the music runs across the joins without a seam.

### Guest
- [ ] **A way back out of the album:** a guest holding a session for the event sees a link from the
      shared gallery back to their own camera. A stranger opening the same link does **not**.
- [ ] **Guest filter popover** opens fully on screen at 320 / 360 / 390 px wide, with no sideways
      scroll.

## 24. Version 1.5.0 — guest list, invites, delivery tracking, guest photo delivery, unsubscribes

### The create wizard gained a step
- [ ] **`/app` is five steps** — *Your event · When it runs · Make it yours · Your guests · Ready*.
      **Show me everything at once** still drops to the flat form and **Walk me through it instead**
      restores it; nothing blocks you but "name it to continue".
- [ ] **Make it yours** leads with the paid features as cards (video clips, shots each, frame shapes,
      keep them longer) with what each costs — or, on a free-tier event, a line counting up what you
      are *not* paying — and keeps custom URL, timezone, downloads and no-flash collapsed under
      **Other settings**. Reveal mode and moderation are still on this step.

### Guest list (Manage → Guest list)
- [ ] **Add by hand:** an **email is required** and a name is not — email only saves, name only and
      notes only are each refused in words ("Add an email address — that is how the join link is
      sent. Print a card for anyone without one."), and so is a body carrying *only* a phone number.
      The **Add to list** button is `aria-disabled` with an empty address box, never `disabled`, and
      the press still answers. Clearing the address on an existing guest is refused the same way.
      A second guest with the same address on the same event is refused as a duplicate — a 409 with
      a sentence, not a 500.
- [ ] **A phone column is recognised and skipped, never stored.** Paste `Name,Email,Phone` with and
      without a header row, and with the phone column first — each previews as
      *name · email · don't import* with the right counts, and the digits appear on no stored guest.
      A phone-only paste — or any paste with no address column — is the one loud "Map a column to
      Email", not a list of blank guests. Switching that column's dropdown to **notes** keeps the
      digits as a note, which is the host's choice to make.
- [ ] **Addresses are lower-cased on the way in.** Add `Mum@Example.com`, then try `mum@example.com`
      → refused as the duplicate it is.
- [ ] **Import → Preview** shows your real column headings with a dropdown against each, a guessed
      mapping you can correct, and counts (to add / already on the list / **with no email** / bad
      address / skipped). Skipped rows are listed, greyed, each with its reason — never silently
      dropped.
- [ ] **Paste a sheet where some rows have no address.** Those rows are greyed with "No email
      address — skipped", they carry the guest's NAME so you can see who to print a card for, they
      have their own number in the tally, and none of them is stored after the commit.
- [ ] **Paste from a spreadsheet** (tab-separated) parses as happily as a comma CSV. Uploading an
      `.xlsx` is refused with "save it as CSV", not rendered as one guest of mojibake.
- [ ] **Importing the same file twice adds nobody the second time** — on the address, which every
      guest now has, and case-insensitively (`JO@X.COM` is `jo@x.com`).
- [ ] **A file with no header row** says so and keeps the first line as a guest rather than eating it.
- [ ] **Limits:** an import over 2000 rows is refused by number, and the list cannot pass 2000 guests.
- [ ] **Remove a guest who has already been invited** → the row goes, and the record of what was sent
      to them (and any bounce) is still there.

### Invites and delivery state
- [ ] **Send invites (N)** counts the guests who are not blocked. Every guest has an address, so
      the only thing a send skips is a suppressed one — reported by address and reason, never as a
      silent failure.
- [ ] **The invite** carries the event name, the join link, the join code and an unsubscribe link.
      The event name is **escaped** — call an event `<b>Jo</b>` and the inbox must show the
      characters, not bold text.
- [ ] **Per-row Invite / Resend** sends and records a second message; the row shows the **latest**
      state and the earlier record is not overwritten.
- [ ] **No mail transport configured** → the card says invites cannot be sent and the list still
      works as a record of who is coming.
- [ ] **Mailgun with no webhook signing key** → every invite reads **"Sent (delivery unknown)"** and a
      line at the top explains why. It must not read like a state about to change.
- [ ] **With the webhook wired** (see `UPGRADING.md`): a delivered message becomes **Delivered**; a
      dead address becomes **Bounced**, in red, with the mail server's own words underneath.
- [ ] **A wrong signing key is loud** in the app logs rather than quietly discarding every delivery
      event — the two failures look identical from the outside, and only the log tells them apart.
- [ ] **A redelivered webhook changes nothing** — replay the same event and there is still one record.
- [ ] **A bounce blocks the address everywhere.** The row reads **Blocked** with the reason and has
      no invite button; a *Send invites* that would have included them reports them as skipped, by
      address and reason. Put the same address on a **different** event's list → blocked there too.

### Guest unsubscribe
- [ ] **The body link** opens `/unsubscribe/<token>` already saying *You're unsubscribed* — there is
      nothing to press — and the address it names is masked.
- [ ] **Widen, then narrow.** Choose *never email me from Snapdini again*, reload → still in force.
      Choose *just this event* → the global block lifts. Now do the same for an address that actually
      **bounced**: that block must NOT lift.
- [ ] **Feedback comes after and is optional.** Skipping it leaves the unsubscribe in place. A
      comment with no reason, and a reason with no comment, both save.
- [ ] **JavaScript off:** the page still offers both choices as a plain form, and both work.
- [ ] **Nothing unsubscribes on a GET.** GET the one-click URL → no opt-out. POST to it → unsubscribed
      everywhere, answered in plain text.
- [ ] **A junk or retired token answers the same as a real one** on the one-click endpoint (200), so
      it cannot be used to tell a valid token from an invalid one.
- [ ] **The host can see it** — an unsubscribed guest shows as blocked on the guest list with a
      reason that says it was a request.

### Suppression reaches every sender
- [ ] Unsubscribe an address globally, then confirm it receives **none** of: an invite, the guest
      photo email, the release reminder, the photos-are-live message, the post-event survey.
- [ ] It **does** still receive a sign-in / verification link (otherwise they are locked out of their
      own account), the contact form still forwards, and operator alerts still arrive.

### Guests asking for their photos
- [ ] **Join screen:** *Email me the photos when the event ends* sits beside the address field. Tick
      it with the field empty → the hint asks for an address and the join still goes through.
- [ ] **From their own roll:** *Want your shots when the event ends?* below the photos. With an
      address already on file it is one tap and no dialog; without one, an inline field asks where.
- [ ] **Actually, no thanks** switches it back off, and it stays off through a reload.
- [ ] **A duplicate address** — one another guest at this event already uses — still opts this guest
      in, does **not** move the address off the other roll, and says so plainly instead of erroring.

### Getting the photos out (Manage → Settings, foot of the card)
- [ ] All four delivery options save and load back. **Which photos do they get?** appears only on
      *At a time I choose* and *I'll send it myself*.
- [ ] **A scheduled send before the reveal is refused**, with a message naming the reveal moment, and
      nothing is saved. A time of 7:05 pm moves up to 7:15 pm and the hint says why.
- [ ] The scheduled moment is read in the **event's** timezone and loads back as the wall-clock time
      you typed — check from a device several hours away.
- [ ] **The day-before reminder is offered only when there is a day to fit it in.** When there isn't,
      the card says why rather than quietly omitting a switch you have seen on another event.
- [ ] **📨 Send the gallery link to guests now** sends the **saved** scope, not an unsaved edit, and
      afterwards the card says when it went. A second press reads **Send it again now**.
- [ ] **Only guests who asked are ever emailed.** An event where nobody opted in sends nothing and
      does not pretend otherwise.
- [ ] **An event that existed before this release mails no guests at all**, whatever its delivery
      setting reads — nothing was backfilled, so nobody on it has asked.

### Email allowance (operators)
- [ ] With `OPS_NOTIFICATIONS` on, the daily digest carries an **Email allowance** line: the
      month-to-date count against the limit, the split between invites and share sends, and the note
      that it is a floor.
- [ ] Set `MAILGUN_BUDGET_WARN_PCT` low → the digest sends on an otherwise quiet day, and the warning
      leads the **subject line** rather than sitting halfway down the body.
- [ ] **Nothing is ever blocked.** Past the limit, sends still go out and the digest simply says the
      allowance is spent.

## 25. Version 1.5.0 — hearts, downloads, poster paper, admin sections

### Guest hearts
- [ ] **A guest can heart another guest's photo** after the reveal: the ♥ fills, the count goes up,
      and a second tap takes it back. Reload → it is still where you left it.
- [ ] **Your own roll, before the reveal:** the hearts on your own shots show there too. A stranger
      with only the join code sees no counts for photos that are not revealed yet.
- [ ] **Double tap, two tabs, flaky signal:** hearting twice never counts twice, and a heart made in
      one tab shows in the other within a poll.
- [ ] **Host opt-out:** *Manage → Event settings → Guest hearts* off → no ♥ anywhere, on the gallery
      or on a guest's roll, and the two heart rows disappear from the download sheet. Turn it back
      on → **the counts are all still there.**
- [ ] **Rejected and pending photos carry no hearts** — reject a hearted photo under moderation and
      it drops out of the counts and out of that guest's own hearted list.
- [ ] **Locked event:** hearting is refused like uploading is. **Ended event:** hearting still works
      — people browse the gallery for weeks.

### Downloading
- [ ] **The files-or-zip question is asked EVERY time.** Download, pick one, download again → it
      asks again. There is no remembered preference, and nothing beside the button to change one.
- [ ] **The scope sheet offers** the whole gallery, highlights only, *what everyone loved*
      (hearted, most-hearted first), *highlights and hearts* (counted once — check the number is the
      union, not the sum), pick them myself, and — when some are already saved on this device —
      only the ones you don't have.
- [ ] **The heart rows vanish** when every photo is hearted, when the union is the same as one of
      its halves, and when hearts are off for the event.
- [ ] **Sharing offers only three scopes** (gallery / favourites / hand-picked). No heart scopes —
      a share link is a query the server re-resolves, and there is no such query.
- [ ] **A guest zips their own roll before the reveal** from their camera gallery, and gets only
      their own photos. Someone else's session token, or none, gets "Photos are not revealed yet".

### The poster's Print tab
- [ ] **One tab holds every way out** — poster, trick cards and front-and-back — rather than a row
      at the foot of two different tabs.
- [ ] **Paper size A6 → A2**, and the line above the buttons states the real dpi for the size picked
      (A4 and below 300; A3 ≈288; A2 ≈203). The design itself does not change as you switch.
- [ ] **An A2 PDF is not blank on an iPhone.** This is the reason the export is capped — test it on
      a real iOS device if you have one.
- [ ] **Cut guides** toggle off → the sheet prints with no dashed lines, and the cards still tile it
      edge to edge with **no white gutter between them**.

### The manager's section menu
- [ ] **`/admin/<code>` opens on the menu** of eight tiles, with a pending count on Photos and the
      guest count on Guests. Open one → it takes the page, **← All settings** comes back.
- [ ] **Refresh inside a section** and you land back in it, not at the top. Open a second event in
      another tab → the two remember their own places. Close the tab → it forgets.
- [ ] **Poster is not a section** — the tile opens the designer.

### Everything else
- [ ] **One header** on the landing page, pricing, the dashboard, the manager and `/siteadmin` — the
      same height, no jump moving between them, ADMIN on the two operator-facing ones. At 400px it
      does not drag the page sideways.
- [ ] **The offline page:** stop the `web` container → a branded "we'll be right back" page that
      counts down and reloads itself when the container is back. Stop `app` → `/api` calls answer a
      small JSON body, not an HTML document. Check the status code is still the original 502/504
      (`curl -I`), not flattened to 503.
- [ ] **A venue's worth of guests does not hit the rate limiter.** Reading the gallery, the event,
      `/participants/me` and the hearts endpoint are exempt from `API_RATE_LIMIT`; uploads, auth and
      writes are not.
- [ ] **The CSV import limiter** (`IMPORT_RATE_LIMIT`, default 30/min) refuses the 31st import or
      preview in a minute, and says so in words rather than failing silently.
