# Snapdini — page & feature guide

A walk through every page and what each control does, grouped by who uses it. Snapdini is a digital
**disposable camera for events**: guests scan a QR, take a limited roll, and the gallery is revealed
when the event ends (or instantly, if you choose). Billing is optional — with no Stripe keys set, the
whole app is free and the "Pro"/pricing UI is hidden.

Roles: **visitor** (not signed in) · **organizer** (created an event) · **co-host** (invited to help
run one) · **guest** (takes photos at an event) · **site admin** (operates the platform).

## In a nutshell

1. **Create an event** — pick how many shots each guest gets and when the photos appear.
2. **Share the QR** — print the poster or send the link. Guests scan and a camera opens in their browser, no app.
3. **Guests shoot** their limited roll; every photo lands in one shared gallery.
4. **Reveal & download** — show the gallery (at the end, or live) and grab the lot as a zip.

The rest of this guide is the full reference for each page.

## Contents

- [1 · Public / marketing](#1-public--marketing)
- [2 · Account & sign-in](#2-account--sign-in)
- [3 · Organizer portal](#3-organizer-portal) — create, manage, poster, review & slideshow
- [4 · Guest capture](#4-guest-capture)
- [5 · Public sharing & gallery](#5-public-sharing--gallery)
- [6 · Site administration](#6-site-administration)
- [Guest referrals & gallery stats](#guest-referrals--gallery-stats)
- [Moderation, reveal & retention](#moderation-reveal--retention--how-it-behaves)

---

## 1. Public / marketing

### Landing — `/`
The front door. Hero, feature grid, FAQ, and a footer.
- **Theme toggle (🌙/☀️)** — switches light/dark and remembers it.
- **Create your event** — to the create form (`/app`) if signed in, otherwise to sign-up.
- **See the demo** — spins up a throwaway demo event: on a phone it opens straight into the camera;
  on desktop it shows a QR + links to explore the camera / host / gallery views.
- When you're signed in, the sign-in CTAs become **My events →** (your dashboard).

### Contact — `/contact`
- **Send message** — stored in the platform's mailbox (and emailed to support if email is configured).
  Submitting always succeeds even if email is off.

### Terms `/terms` · Privacy `/privacy`
Plain-language legal pages (reliability, refunds, your content/rights, data retention, limitation of
liability). Static, cross-linked.

---

## 2. Account & sign-in

### Sign up — `/signup`
- **Create account** — registers you, then asks you to **verify your email** (it does not log you in
  until you do). On a dev build the verify link is shown inline.
- **Email me a sign-in link** — passwordless magic-link login.
- **Continue with Google** — shown only when Google sign-in is configured.

### Log in — `/login`
- **Sign in** — email + password. If the account isn't verified yet you get a verify prompt and a
  **Resend sign-in link** button.
- **Email me a sign-in link** / **Continue with Google** — passwordless options.

Both pages honour a `?next=` return path (e.g. after accepting a co-host invite).

---

## 3. Organizer portal

### Dashboard — `/dashboard`
Your events and account home.
- **+ New event** — opens the create form.
- **Event cards** — each has **⚙ Manage** (the control panel), **🖼 Gallery** (the public gallery),
  and **📷 Join page** (the guest camera link / QR target).
- **Recent / Active / All** filter chips with live counts.
- **Co-host invites** — if someone invited you to co-host, a banner appears: **Accept invite** adds
  the event to your list (you stay on the dashboard).
- **🎩 Admin** (site admins only) → the platform console. **Sign out** ends the session.

### Create an event — `/app`
- **Event name** and an optional **welcome blurb** (shown to guests on the join screen).
- **Expected guests** — sets the tier. **Video clips** — enable/disable guest video and its length.
- **Live total** — when billing is on, an itemised quote updates on every change; free-tier features
  show a struck-through price.
- **Start date/time** and **Duration** (short events are free; longer is a paid add-on).
- **Advanced settings** (collapsible): **Custom URL** (a pretty `/e/<name>` link, with a live
  availability check — optional, blank uses the automatic link), **Shots per person**, **Keep photos
  for** (retention), **Timezone**, **Photo shapes** (Square is always free; other shapes are the
  frame pack on paid tiers), **Allow downloads**, **No flash**, and **Reveal mode** (Instant / At the
  end / Manual — plus a reveal delay and a **Moderate photos** toggle for non-instant events).
- **Create event** — free events go straight to the manager; paid events go through Stripe Checkout
  and activate on payment.

### Manage an event — `/admin/<code>`
The organizer control panel (owners and co-hosts; accessed by your account or the organizer code).

- **Share & invite:** the event's **QR** (Snapdini logo in the centre), **Copy code**, **Share
  invite** (native share sheet), **Copy join link**, **Save QR** (print-quality PNG), and
  **🎩 Create poster** (see below). Also **Copy gallery-only link** and **Email the gallery link**.
- **Controls:** **Reveal all now / Hide photos** (override the reveal timing either way), **Allow
  downloads** toggle, **Lock / Unlock** (stop new joins/uploads), and **Delete** (two confirmations;
  owner only).
- **Settings** (saved together): name, blurb, start date/time (**locked once the event has started**),
  timezone, **Custom URL** (add/change/clear), photo shapes, reveal mode + delay, **Moderate photos**,
  and **No flash**. Unsaved changes block the Upgrade panel so quotes stay accurate.
- **Theme:** pick a colour preset or upload an event image (crop/zoom) — applies and saves instantly;
  it themes the join screen, gallery, poster and slideshow.
- **Upgrades** (billing on): raise guests/shots/video/retention/length or add the frame pack — you
  pay only the difference.
- **Review & Curate** — link to the photo hub (shows a pending count under moderation).
- **Co-hosts:** invite by email (they get a link + an in-app accept), copy a pending invite link, or
  remove a co-host. The owner can't be removed and only the owner can delete the event.
- **Shared links:** every link you've made — **Copy**, **Edit** (rename / change the `/s/` URL), or
  **Delete** (existing links keep working until deleted).
- **Participants:** **Remove** a guest (also deletes their photos — useful for a duplicate join).

#### Poster editor (in Manage)
A printable A4 poster. Editable **Title / Message / How-to** lines; choose what shows under the QR
(join link / code / nothing); toggle the footer URL. **Drag any element to move it and the corner to
resize** (it can't leave the poster; the outline shows its real size). Background = event image,
plain colour (incl. **Match theme**), or an upload. Per-element colours (or **Use theme colours**).
The QR always carries the centre logo. Export **PDF / PNG / JPG** or **Print**. Changes auto-save.

### Review & Curate — `/admin/<code>/review`
Where you approve, curate and share photos.
- **Cards / Single** views + a **🎬 Slideshow** button.
- **Filter tabs:** Pending (under moderation), All, ★ Favourites, 🗑 Rejected.
- **Per photo:** **★ favourite** (separate from approval), **✓ Approve** (only when moderation is on),
  **✕ Reject** (two-click "Sure?" → goes to the bin, restorable, excluded from gallery/share/slideshow),
  **↩ Restore** (rejected → back to pending).
- **Single view:** arrow-key navigation, click/⛶ for full screen, **📤 Share** this one photo, **⬇**
  download it.
- **Select mode:** tap to select, shift-click for a range, quick-select **All / ★ Favourites**, then
  bulk **Download** (a zip), **Share**, **Favourite**, **Approve**, or **Reject**.
- **Share gallery / Share favourites** — makes a public link to the current filter (rejected photos
  are never included).

#### Slideshow panel (in Review)
- Source **All photos / ★ Favourites**; optionally **include video clips** and keep their sound.
- **Seconds per photo**, **Resolution** (4K / 1080p), **Quality**; a live length + size estimate.
- **Music:** pick one or more bundled tracks (reorder / remove), **Loop to fill**, preview with a
  volume slider, or **upload your own** (you're responsible for its licensing).
- **Remove Snapdini frames** — a paid one-off that drops the intro/outro cards (free on self-host).
- **Generate** — shows a live progress bar, then plays in-browser. Cards use your event theme + image.
- **Recent slideshows** — keep (★, survives auto-purge), download (incl. a 1080p version of a 4K
  render), or delete. Non-kept renders auto-purge after about a day.

---

## 4. Guest capture

What a guest sees after scanning the QR. Both **`/join/<code>`** and the prettier **`/e/<slug>`** open
the same camera.
- **Join screen:** event branding + blurb, a **"limited roll — N snaps"** callout, an **Event info**
  panel (photo shapes, video, when photos appear), your **name** (and an optional **email** so you can
  resume on another device), then **Join & open camera**. Returning with the same email resumes your
  remaining roll.
- **Camera:** full-resolution **shutter** (the counter drops; disabled at 0), tap-to-focus,
  drag-across-the-viewfinder **brightness**, **⚡ flash** (front screen-flash always; the rear LED is
  hidden if the host turned No-flash on), **flip**, camera picker, grid, save-to-device, fullscreen.
- **Video** (if the event allows it): a Photo/Video switch, a record timer that auto-stops at the
  limit, and a quality picker.
- **Upload queue:** photos are saved on your device immediately and uploaded one at a time with a live
  %. If you go offline they queue and **auto-retry** when you're back — nothing is lost.
- **Gallery (🖼):** before reveal you always see your own shots (with "#N" snap numbers); after reveal,
  **Mine / All / Others** filters. Downloads appear only if the host allowed them.

---

## 5. Public sharing & gallery

### Shared link — `/s/<token>`
Anyone with the link (no account). Resolves to the whole gallery, favourites, or a hand-picked set.
- Before reveal it shows a lock / countdown. After reveal: a themed grid, lightbox, and — if downloads
  are allowed — **Download all** or select a few and **Download N** (a recipient can only ever pull
  what was shared).

### Event gallery — `/gallery/<code>`
The public gallery for an event.
- **⭐ Highlights / 📷 All photos** toggle, lightbox, and the same reveal-gating + optional downloads.
- **"Start your own"** — a footer card inviting guests to run their own event. It is emphasised for
  48 hours after a reveal (the moment guests are most impressed) and carries the source event's join
  code, so sign-ups can be attributed back to the gallery that produced them. See
  [Guest referrals](#guest-referrals--gallery-stats) below.
- **Gallery stats** — views and downloads are counted per photo and per gallery. Counting is
  fire-and-forget from the browser (`navigator.sendBeacon`) and batched server-side, so it never slows
  a page down.

---

## 6. Site administration

Platform operators only, at **`/siteadmin`**. A red "Site admin mode" banner; every list has search,
filters and paging.
- **Events** — all events with status + purge timing; **Manage →** opens any event's panel (support
  override).
- **Users** — accounts, event counts, **verified**/admin flags (view-only). Accounts must verify
  their email before they can create an event, which is what blocks bulk sign-up spam.
- **Contact messages** — the contact-form mailbox; mark done / reopen.
- **Client errors** — device error reports; resolve / reopen.
- **Promo codes** (billing on) — create Stripe-backed discount codes guests redeem at checkout.
- **Referral funnel** — where new organizers came from, and gallery engagement. See
  [Guest referrals](#guest-referrals--gallery-stats).

---

## Guest referrals & gallery stats

Every guest who sees a gallery is a plausible next customer, so three surfaces carry a referral link
back to the event that introduced them:

1. The **gallery footer** card described above.
2. The **guest "roll finished"** screen, once a guest has used their last shot.
3. The **download/share** confirmation.

**How attribution works**

- The link is `/(signup|/)?ref=<join code>`. On arrival the code is stored in a first-party cookie
  (`snapdini_ref`, 60 days, httpOnly, `SameSite=Lax`), so a guest who wanders off and returns later is
  still credited.
- At sign-up and at event creation the cookie is resolved to the source event and recorded on
  `users.referred_by_event_id` / `events.referred_by_event_id`. Self-referral (the host clicking their
  own link) is ignored.
- **No discount is attached to the guest link.** It exists to measure where organic growth comes from.

**Host reward**

When a paid, unrefunded event finishes, the host is emailed a single-use code (`THANKS######`,
20% off, valid 90 days) alongside their feedback request. The code is minted in Stripe on demand and
stored on the event, so it is never re-issued.

**Measuring it** — `/siteadmin` → *Referral funnel* shows clicks → sign-ups → events → paid events,
plus the galleries producing the most referrals and per-photo view/download engagement.

---

---

## Moderation, reveal & retention — how it behaves
- **Reveal mode** decides when guests/public see photos: **Instant** (as taken), **At the end** (when
  the event ends, plus an optional delay), or **Manual** (you press Reveal). **Hide photos** and
  **Reveal now** override either way.
- **Moderation** (non-instant events): new photos are held as *pending* and only appear once approved.
  Turning it on later holds existing photos until you approve them. Rejected photos go to a bin and are
  excluded everywhere; restoring returns them to pending.
- **Retention:** photos + guest data are deleted after the event's retention window; a slim stats-only
  record is kept. Freed custom URLs become available again.
- **Find the photos I'm in** (optional, off by default): a guest may upload a selfie and be shown
  the photos from that event they appear in. Requires `MACHINE_LEARNING_URL` pointing at an Immich
  machine-learning container (image bytes over HTTP — no volume mounts), the **host** to switch it on
  per event, and the **guest** to consent explicitly. Only an enrolled guest's own face template is
  stored; every other face is compared and discarded inside the request, and what persists is a
  photo↔guest link, not biometric data. Withdrawing deletes the template and every match.
  Shipped **off** and off in the hosted service; it is supported as a **self-host** feature
  (see the README section). **Read `docs/PIA-face-matching.md` before enabling this on a hosted deployment** — a face template
  is sensitive information under the Privacy Act and this is not a feature to switch on casually.
- **Taking a shot back:** for **60 seconds** after a photo lands, a guest sees a bin on that photo
  in their own gallery, with a countdown. Deleting it removes the photo and **returns the frame to
  their roll**. After the window it is permanent — a longer window would turn a limited roll into
  unlimited retries. `PHOTO_DELETE_WINDOW_SECONDS` tunes it.
- **Guest top-ups:** a guest who runs out can buy **12 more shots for A$3**, for themselves only.
  The purchase is *added* to the event's roll, so a host lowering the roll later never removes what
  a guest paid for. Two independent host switches on Manage control it — *Guests can buy more shots*
  and *Guests can ask you for more* — and all four combinations are meaningful (take the money but
  no interruptions; keep control but accept being asked; and so on). Sales close **15 minutes before
  the event ends**, because shots bought then are worthless. Requests appear on the host's own pages;
  nothing is pushed at them mid-event. Operators can see and refund guest payments in `/siteadmin`.
- **Video length:** the video add-on (10s / 30s / 60s / 90s) is what guests are shown and asked to
  stay within, and the in-app recorder stops itself at it. Operationally, though, the server does not
  throw a clip away for running over — a recorder that flushes late, or a guest who filmed the
  speeches on their own phone because the browser cannot manage 4K, would otherwise lose the moment
  for good. Only an absolute ceiling refuses a clip (`VIDEO_HARD_MAX_SECONDS`, default 10 minutes);
  `VIDEO_GRACE_SECONDS` tightens it per-deployment. **Buying video at all is still required** — an
  event with no video add-on refuses video uploads outright.
  This tolerance is deliberately **not surfaced to guests**: the stated limit is the limit, or it
  stops being one. `/siteadmin` reports overages, split by source — a camera-roll overage is the
  tolerance doing its job, while an *in-app capture* overage means the recorder failed to stop and is
  a defect worth chasing.
- **Retention windows:** free events keep photos for **7 days**. Paid events include **30 days** as
  standard, extendable to **3 months** or **12 months** as a paid add-on. When the window expires the
  photos and guest data are deleted and a slim stats-only record is kept; freed custom URLs become
  available again.
- **Reschedule:** an event that has not been used — no guests joined, no photos taken — can be moved
  to any start time within **6 months of its original start date**, even after its original start has
  passed. Its retention clock restarts from the new date, and the purge sweeper leaves unused events
  alone until that whole window (plus a day's grace) has elapsed, so a paid organizer who never ran
  their event does not silently lose it.
