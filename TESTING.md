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
- [/] Card order: "Your event" (name, **blurb**, guests, video, live price) → "When" → collapsible "Advanced settings".
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
- [/] **Create poster:** title/message default from the event (**blurb** as the message); two-pane desktop; **QR size (S/M/L) + 3×3 position**; text reflows around the QR; per-section colours + image palette; **colours follow the event theme until you edit one, then lock**; export PDF/PNG/JPG/Print.
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
  **365 passed, 0 failed** in ~40s. `run.mjs` lifts `ADMIN_EMAIL`/`ADMIN_PASSWORD` off the
  local dev container when they aren't in your environment, so the operator-only assertions run
  by default instead of silently skipping (they were skipping, and it hid ~22 tests).
- The integration suite is an orchestrator (`testsuite/run.mjs`) over per-area specs in
  `testsuite/specs/`, run as separate processes in a concurrency pool. Useful flags:
  `--only=<substring>` (one spec — a few seconds), `--jobs=N`, `--serial`, `--list`.
  Specs named `9x-` touch global DB state (`run-sweep`, admin-overview counts) and run alone
  after the pool, so nothing can create an event while they are counting.
- **1.2 additions:** referral attribution (cookie is httpOnly and resolves to the event id;
  a referred signup *and* their first event are both attributed; a host referring themselves is
  not counted; a cookie outliving its event is ignored); write-behind counters coalesce and do
  not write on the request path; `download_count` is separate from `view_count`; no unpaid or
  refunded event holds a host reward code; testimonial consent is gated on positive feedback.
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
- [ ] **Turnstile:** contact, signup and login submit cleanly. Verify from **outside the LAN** — the
      widget is blocked by Pi-hole on-network.
- [ ] **Video over the tier:** on an event with a 10s video add-on, upload a ~20s clip from your
      camera roll → it is **accepted, with no message telling you it was over** (the tolerance must
      stay invisible to guests). On an event with **no** video add-on, the same upload is **refused**.
      `/siteadmin` then shows it under video overages, tagged as a camera-roll upload.
- [ ] **Dark mode:** `/siteadmin` promo-code inputs are **not white-on-white** in dark mode.

## 18. Version 1.3 — delete window, guest top-ups (verify these)
- [ ] **Take a shot back:** shoot a photo, open your own gallery → a **bin with a countdown** sits on
      that photo. Tap it: the photo goes and the roll goes back up. Wait past 60s → the bin
      disappears and the shot is permanent. **No delete control on the camera screen.**
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
- [ ] **This is how it ships.** 1.4 is built but NOT enabled in production pending legal review
      (`docs/PIA-face-matching.md`, open items 6.1 and 6.2). Leave `MACHINE_LEARNING_URL` unset on
      prod; devel is the only place it is on.
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
