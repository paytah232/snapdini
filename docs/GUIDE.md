# Snapdini — page & feature guide

A walk through every page and what each control does, grouped by who uses it. Snapdini is a digital
**disposable camera for events**: guests scan a QR, take a limited roll, and the gallery is revealed
when the event ends (or instantly, if you choose). Billing is optional — with no Stripe keys set, the
whole app is free and the "Pro"/pricing UI is hidden.

Roles: **visitor** (not signed in) · **organizer** (created an event) · **co-host** (invited to help
run one) · **guest** (takes photos at an event) · **site admin** (operates the platform).

## In a nutshell

1. **Create an event** — name it, say what kind of event it is, pick how many shots each guest gets
   and when the photos appear.
2. **Share the QR** — print the poster (and, if you like, a card of shots for guests to hunt down)
   or send the link. Guests scan and a camera opens in their browser, no app.
3. **Guests shoot** their limited roll; every photo lands in one shared gallery.
4. **Reveal & download** — show the gallery (at the end, at a moment you pick, or live), share a
   link to some or all of it, and grab the lot as a zip or straight onto a phone.

The rest of this guide is the full reference for each page.

## Contents

- [1 · Public / marketing](#1-public--marketing)
- [2 · Account & sign-in](#2-account--sign-in)
- [3 · Organizer portal](#3-organizer-portal) — create, manage, poster, review & slideshow
- [4 · Guest capture](#4-guest-capture)
- [5 · Public sharing & gallery](#5-public-sharing--gallery)
- [6 · Site administration](#6-site-administration)
- [Lifecycle emails](#lifecycle-emails)
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

The form walks you through **four steps** — *Your event · When it runs · The details · Ready* — with
a step strip across the top. **Show me everything at once** on the first step drops the walkthrough
and puts every field on one page; **Walk me through it instead** puts it back. Nothing is gated: the
steps are an order to answer the questions in, not permission to proceed.

**1 · Your event**
- **Event name**.
- **What kind of event is it?** — a row of chips (wedding, birthday, corporate, baby shower, hens,
  engagement, graduation, Christmas, or *Any event*). Optional, and tap it again to clear it. It is
  asked here because the rest of the event is built from the answer: the photo ideas we offer, the
  mark guests tick a shot off with, the decoration on the printed cards, and which poster design is
  put first. You can still set or change it later.
- **Give my guests a list of shots to hunt for** — appears once a type is picked, and starts the
  event with a ready-made [trick list](#manage-an-event--admincode) you can edit or print later.
- **Welcome blurb** (optional) — shown under the title on the join screen, and used as the poster's
  default message.
- **Expected guests** — sets the tier. **Video clips** — enable/disable guest video and its length.
- **Live total** — when billing is on, an itemised quote updates on every change; free-tier features
  show a struck-through price.

**2 · When it runs**
- **Start date** and **Start time**. The time picker steps in **15 minutes**, which is the same grid
  the reveal runs on — an event ending at 7:07 would have its reveal checked at 7:15 anyway, so
  offering minutes we cannot honour would be offering precision that does not exist.
- A line under the fields says which **timezone** the times are read in, with the resolved start
  spelled out. If your device is in a different zone from the event, it says so and offers to switch.
  The times you type are always the event's local times, never your phone's.
- **Duration** — short events are free; longer is a paid add-on.

**3 · The details** — **Advanced settings**: **Custom URL** (a pretty `/e/<name>` link, with a live
availability check — optional, blank uses the automatic link), **Shots per person**, **Keep photos
for** (retention), **Timezone**, **Photo shapes** (Square is always free; other shapes are the frame
pack on paid tiers), **Allow downloads**, **No flash**, and **Reveal mode**:

- **Instant** — photos appear as they are taken.
- **At the end** — plus a **reveal delay** of *immediately · 1 hour · 3 hours · 12 hours · 24 hours ·
  2 days · 3 days · 1 week* after the event ends, **or "Pick an exact date & time…"** for a moment of
  your own. A custom moment is read in the **event's** timezone (not the browser's) and rounded
  **up** onto the next 15-minute tick — rounding to the nearest would show the photos *before* the
  moment you chose, and an early reveal is the one mistake that cannot be undone. The form tells you
  the exact instant it will use before you create anything, and refuses a reveal booked after the
  photos are deleted at the end of retention.
- **Manual** — nothing appears until you press Reveal.
- **Moderate photos** — offered on any non-instant event.

**4 · Ready** — a summary of what you are about to create and what it costs, then **Create event**.
Free events go straight to the manager; paid events go through Stripe Checkout and activate on
payment. Signed out, the button becomes **Create my account & event** — your answers are kept and
you come straight back to finish.

### Manage an event — `/admin/<code>`
The organizer control panel (owners and co-hosts; accessed by your account or the organizer code).

- **Share & invite:** the event's **QR** (Snapdini logo in the centre), **Copy code**, **Share
  invite** (native share sheet), **Copy join link**, **Save QR** (print-quality PNG), and
  **🎩 Create poster** — which reads **🎩 Manage poster** once a design exists, because by then the
  button reopens your work rather than starting over. With a design saved, a second button,
  **Start again from a design…**, reopens the design gallery.
- **Controls:** **Reveal all now / Hide photos** (override the reveal timing either way), **Allow
  downloads** toggle, **Lock / Unlock** (stop new joins/uploads), and **Delete** (two confirmations;
  owner only).
- **Settings** (saved together): name, blurb, start date/time (**locked once the event has started**),
  timezone, **Custom URL** (add/change/clear), photo shapes, reveal mode + delay — including
  **Pick an exact date & time…**, which loads back as the wall-clock time you typed rather than that
  instant translated into wherever you happen to be editing from — **Moderate photos**, and
  **No flash**. Unsaved changes block the Upgrade panel so quotes stay accurate.
- **Theme:** pick a colour preset or upload an event image (crop/zoom) — applies and saves instantly;
  it themes the join screen, gallery, poster and slideshow.
- **Upgrades** (billing on): raise guests/shots/video/retention/length or add the frame pack — you
  pay only the difference.
- **Trick list** (optional, off until you add one): a short list of shots to hunt for — "someone
  laughing", "the oldest person here". It is loaded from the **event type** you picked when you
  created the event (change it here if you like); tap a **mood** (the classics, fun, silly,
  heartfelt, get-them-mixing) for an instant list, or go through the full list and choose your own —
  you can write your own tricks too. Five by default; anything from 1 to 20.
  - Pick the **tick** guests and cards mark off with (a heart, a bottle, a star, or type your own).
  - **Several cards** (up to 8) hand different guests slightly different lists, so the room isn't
    shooting the same six things. Name each one — "Golden oldies", "The tricksters" — and print
    them separately. Every guest is given one card and keeps it.
  - Guests see it as a pill in the camera; ticking one off is automatic when they shoot it.
- **Review & Curate** — link to the photo hub (shows a pending count under moderation).
- **Co-hosts:** invite by email (they get a link + an in-app accept), copy a pending invite link, or
  remove a co-host. The owner can't be removed and only the owner can delete the event.
- **Shared links:** every link you've made — **Copy**, **Edit** (rename / change the `/s/` URL), or
  **Delete** (existing links keep working until deleted).
- **Participants:** **Remove** a guest (also deletes their photos — useful for a duplicate join).
  With more than one trick card in play, each guest also has a **Card** picker — for the guest who
  scanned the wrong table's card by mistake. Moving them destroys nothing: their ticks for the old
  card simply stop counting, and come back if you move them back.

#### Poster & trick cards (in Manage)

An A4 poster you print and drop on the tables, and — on a second tab — the **trick cards** guests
hold. They are two outputs of **one** design: the cards borrow the poster's title, typeface,
colours and join details, so what comes out of the printer reads as one set.

**Start from a design.** The first thing you see is a gallery of **eight finished designs** —
Minimal, Botanical, Art deco, Letterpress, Celebration, Wavy, Sweetheart and Editorial — or
**Start from scratch**. The tiles are not mock-ups: each one is drawn by the real renderer with your
event's own name, message and QR, so what you pick is what you get. If you told us what kind of
event it is, the design that suits it is put first and marked. Picking one also themes the app —
join screen, camera and gallery — to match the paper.

**Then it walks you through changing it.** Six short steps with the live preview beside them:

| Step | The question it asks |
|---|---|
| **Words** | What does your sign say? |
| **Type** | How should the words look? |
| **Join** | How do guests join? |
| **Art** | Anything drawn on it? |
| **Colour** | What colours? |
| **Place** | Where does everything sit? |

**Skip — show me every control** on the first step opens the whole editor instead; **Walk me
through it instead** puts the steps back. Changes save as you make them.

##### Words
- **Title**, **Message** and **How-to** line.
- **Small lines above and below the title** — short tracked capitals bracketing the headline, which
  is how a printed sign usually sets a title. Empty unless you want them.
- **Names** sets the couple or the hosts at the foot. Type it as you'd say it: put **and**, **&** or
  **+** in the middle and it sets as a *lockup* — the two names stacked with your own joiner in
  script between two hairlines. Your separator is kept exactly as you typed it. No separator and
  it's one line; blank and nothing is drawn.
- **Your own lines** — add as many extra lines as you like (a table number, a hashtag, a wifi
  password), each dragged, resized and deleted on its own.
- **Tap the words on the preview to edit them.** On a phone the controls sit below the poster, so
  changing a title meant typing blind and scrolling back to look; tapping the title, message,
  how-to line or names puts the caret where you are already looking.

##### Type
Five bundled typeface pairings — **Plain, Editorial, Formal, Garden, Modern** — each a display face,
a script face and a body face chosen to go together, plus whether the title is set in the
**structural** face or the **script** one. The faces ship with Snapdini rather than being fetched
from a font service, so they work on a venue's bad wifi and what you see is what prints.

##### Join
- What shows under the QR: the **join link**, the **join code**, or **nothing**.
- **Show the link along the bottom**, and **Show the Snapdini mark at the top** — our wordmark on
  someone else's wedding sign is your call. (The small logo inside the QR is not optional; it is
  what makes the code ours.)
- **White card behind the QR** — on by default. You can turn it off *only when the paper can
  actually carry the code*, and that is **measured, not guessed**: the panel reports the background's
  symbol contrast as a percentage and a grade, and unlocks at 40% — the lowest a code is expected to
  read reliably in bad light, by a stranger, at an angle. Over a photo background the card always
  stays, because the code could land on a bright sky or a dark suit. Drop the card and the hint still
  says: print one and scan it before you print fifty.

##### Art
A line-art motif — **Border, Wavy border, Black tie, Birds, Glasses, Confetti, Sparkles, Sprig, Art
deco, Rings, Hearts, Camera (round the QR), Camera (one line)** or **Camera (heart lens)** — with its
own position (top / corners / both, for the ones where position means anything), size and colour.
Everything is drawn as an outline rather than a fill, because these get printed, often at home,
where a solid shape is both uglier and dearer.

Separately, **place your own**: drop any of the positional motifs onto the page, then drag, resize,
**rotate** (or ↺ Upright) and delete each one. As many as you like, in any mix. Tap a placed motif
on the preview to select it, or pick it from the list.

##### Colour
Per-element colours, or **Use theme colours** to follow the event. Background is the event image, a
plain colour (including **Match theme**), or an upload — and a plain colour asks one more question:
is it **ink or paper**? Left as paper it is shown the whole time you design, so your ink is chosen
against what it will really sit on, but left *off* what prints — because a host ordering cream card
stock does not want us spraying cream ink onto it. Text colours adjust themselves to stay readable
on whatever is behind them, including the join code, which sits on the QR panel's white rather than
on the poster's background. Pick ink lighter than the paper and you get a note rather than a block:
ordinary four-colour printing can only darken stock, so light type on dark card needs white toner,
screen printing or foil — a sign shop can, a home printer can't.

##### Place
**Drag any element to move it, and its corner to resize.** Nothing can leave the page, and
everything stays inside a **5 mm print margin**, which is roughly what a consumer printer loses off
every edge. **⛶ Arrange** gives the layout the full screen. Hovering or focusing a control outlines
the thing it changes — including where an *empty* field would go, so you can see the Names line has
a place waiting before deciding to fill it. **↶ / ↷** undo and redo (Ctrl/⌘+Z) and sit in the
header, so they are still reachable mid-drag and in full screen — which is the moment an undo is
worth anything.

##### Getting it out
**🖨 Print · PDF · PNG · JPG**. With a trick list set up there is also **🖨 Front & back…**, which
shows you both pages — poster on the front, one trick card sheet on the back — before it prints
anything. A double-sided job is the one print you cannot check without wasting a sheet. The dialog
also reminds you to flip on the **long edge**: short-edge duplex turns the back upside down, and
the browser's own print dialog owns that setting, not us.

#### Trick cards (the second tab)

The cards guests hold. Everything above about words, type, colour and dragging applies here too;
these are the decisions that are the card's own, in their own five steps (*Words · List · Layout ·
Art · Colour* — the List step steps itself over when the event has only one card).

- **4 per A4 / 2 / 1** — A6 place cards, A5 halves, or one full-page card. A4 halves and quarters
  exactly, so every option fills the sheet with nothing wasted.
- **Portrait or Landscape**, at **every** card count — not just 2-up. The line under the buttons
  says what you actually get ("Two portrait A5 cards, cut down the middle"), and the PDF and print
  dialog are set to match, so a landscape sheet is not letterboxed onto a portrait page.
- **Rounded corners** on or off — off means the card edge *is* the cut line, which is what a
  guillotine can follow.
- Show or hide the **QR** and the join link, and write your own **caption**.
- Pick which **sets** to print and which one you're previewing. Turn the **card identifiers** off to
  shuffle the stack and hand them out at random — each card's QR still carries its own list.
- The **tick** is the one chosen in the trick-list editor, so the printed card and the app in a
  guest's hand can never disagree.
- **Ink saver** prints on white. Text colours adjust themselves to stay readable on whatever
  background you choose.

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
  bulk **Download** (one photo saves as itself; several as a zip), **Share**, **Favourite**,
  **Approve**, or **Reject**.
- **Shooter filter** — narrow the grid to one guest, or several.
- **📤 Share asks what to share**, rather than meaning whatever tab you happened to be standing on:
  **the whole gallery** (everything approved), **favourites only**, or **pick them myself**. The
  favourites link is a *query*, not a snapshot — star or unstar a photo later and everyone holding
  that link sees the change, so you never have to re-share. Rejected photos are never included in
  any of them.

#### Slideshow panel (in Review)
A film of the night, rendered on the server.
- Source **All photos / ★ Favourites**. On *All*, optionally **include video clips** (capped at 6s
  each so one clip cannot dominate) and keep their sound.
- **Order** — **Start → end** (the night as it happened) or **🔀 Shuffled**. Two orders and only
  two: a hand-sorted running order is a video editor's job. A shuffled film is fixed for the life of
  that render, so re-watching it plays the same cut; only a *new* render deals a new order.
- **Seconds per photo**, **Resolution** (4K / 1080p), **Quality**; a live length + size estimate.
- **No cap on how many photos go in.** Every visible photo you asked for is included — long films
  are encoded in pieces and joined, rather than the end of a long night being quietly binned.
- **Music:** pick one or more bundled tracks (reorder / remove), **Loop to fill**, preview with a
  volume slider, or **upload your own** (you're responsible for its licensing).
- **Remove Snapdini frames** — a paid one-off that drops the intro/outro cards (free on self-host).
- **Generate** — a live progress bar, then it plays in-browser. Cards use your event theme + image.
- **It carries on without you.** Close the tab, lock the phone, walk away — the render runs on the
  server and the finished film is waiting in the list below when you come back. The bar picks itself
  back up the moment you return to the page.
- **Queue another while one runs.** Change the settings and press go again and the second render is
  queued behind the first (up to three waiting) rather than thrown away — they run one at a time,
  because an encode already uses every core. The panel lists what is waiting.
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
- **Trick list:** if the host set one up, a pill in the top bar — the event's tick glyph and a
  "2/5" count, captioned *trick list* — opens the list of shots to hunt for. Shoot one and it
  ticks itself off — one go per trick — with confetti when you finish the lot.
  It's a suggestion, never a requirement; you can ignore it and just shoot.
- **Saving a photo:** every tile carries a **⬇** button when the host has allowed downloads, and the
  button remembers — it shows that this photo has already been saved to this device. On a phone
  saving opens your own share sheet, so the photo goes straight into **Photos**; on an iPhone a plain
  download would land in *Files*, where nobody ever looks for a picture.
- **Captions:** tap a photo — yours, or any of them if you're the host — and write a line under it.
  Editable afterwards. A photo that was a trick keeps saying which trick it was, underneath.
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
- **⬇ on every photo** — save one straight to the device, and the tile shows that you already have it.
- **Downloading the lot asks what you want**, the same three answers as sharing: **the whole
  gallery**, **favourites only**, or **pick them myself**. "Download all" used to mean whatever was
  on screen, which quietly changed with the Highlights toggle.
- **Files or a zip is your call, and it is remembered.** A zip is right on a desktop; on a phone it
  is close to a dead end, because what comes out sits in a folder rather than in the camera roll.
  Browsers disagree far too much to guess reliably, so it asks once on a touch device and the ⚙
  beside the button changes the answer later. Big rolls are saved in batches with a running count,
  and the choice lives on that device only.
- **Back to your camera** — a guest who still holds a session for this event gets a link back to
  their own roll. (A stranger opening a shared gallery has no camera to go back to, so they are not
  offered one.)
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

## Lifecycle emails
What Snapdini sends a host, all of it skippable via the unsubscribe link in the footer.
**Welcome** on payment · **Check-in** a few days before the event · **Account welcome** and a one-off
**nudge** for accounts that haven't made an event yet · **Post-event survey** 3 days after it ends,
carrying the thank-you discount for the next event and — when there are still photos to make one
from — a prompt to turn them into a **slideshow**, with the date they're deleted. Internal and admin
accounts are excluded from all of it.

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

## Moderation, reveal & retention — how it behaves
- **Reveal mode** decides when guests/public see photos: **Instant** (as taken), **At the end** (when
  the event ends, plus an optional delay — or an exact moment you pick), or **Manual** (you press
  Reveal). **Hide photos** and **Reveal now** override either way.
- **Reveal timing, exactly.** The delay presets run from *immediately* to *1 week* after the event
  ends. "Pick an exact date & time…" stores an absolute instant instead, which is what a delay could
  never express: it cannot say "next Saturday at 7 pm" (further out than the delay's one-week
  ceiling), it cannot say 7:15 (finer than an hour), and it *moves* — rescheduling an event would
  silently drag a chosen date onto a different day. Two rules make an exact reveal behave:
  - It is read in the **event's** timezone, not the browser's. A planner in Sydney setting the
    reveal for a Perth event would otherwise book it two hours out, with nothing on either side
    noticing.
  - It is rounded **up** onto the next 15-minute tick, and stored rounded — so the instant you were
    shown when you picked it is the instant every countdown and every gate reads back afterwards.
    Fifteen minutes because that is the finest sweep the product runs; a reveal rides that tick
    rather than adding one of its own. Rounding *down* would show the photos before the moment you
    chose, and an early reveal is the one thing that cannot be undone.
  - Start times snap to the same grid and are read in the same zone, for the same reasons.
  - Events created before this existed are untouched: they reveal exactly when they did before.
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
  (see the README section). **Take your own legal advice before enabling this on a hosted deployment** — a face template
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
