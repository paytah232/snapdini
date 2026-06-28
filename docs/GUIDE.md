# Snapdini — page & feature guide

A walk through every page and what each control does, grouped by who uses it. Snapdini is a digital
**disposable camera for events**: guests scan a QR, take a limited roll, and the gallery is revealed
when the event ends (or instantly, if you choose). Billing is optional — with no Stripe keys set, the
whole app is free and the "Pro"/pricing UI is hidden.

Roles: **visitor** (not signed in) · **organizer** (created an event) · **co-host** (invited to help
run one) · **guest** (takes photos at an event) · **site admin** (operates the platform).

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

## 4. Guest capture — `/join/<code>` or `/e/<slug>`

What a guest sees after scanning the QR (both URLs open the same camera; the slug is just prettier).
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

---

## 6. Site administration — `/siteadmin`

Platform operators only. A red "Site admin mode" banner; every list has search, filters and paging.
- **Events** — all events with status + purge timing; **Manage →** opens any event's panel (support
  override).
- **Users** — accounts, plan, event counts, verified/admin flags (view-only).
- **Contact messages** — the contact-form mailbox; mark done / reopen.
- **Client errors** — device error reports; resolve / reopen.
- **Promo codes** (billing on) — create Stripe-backed discount codes guests redeem at checkout.

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
