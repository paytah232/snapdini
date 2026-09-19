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

- [One header, everywhere](#one-header-everywhere)
- [1 · Public / marketing](#1-public--marketing)
- [2 · Account & sign-in](#2-account--sign-in)
- [3 · Organizer portal](#3-organizer-portal) — create, manage, poster, review & slideshow
- [4 · Guest capture](#4-guest-capture)
- [5 · Public sharing & gallery](#5-public-sharing--gallery)
- [6 · Site administration](#6-site-administration)
- [Lifecycle emails](#lifecycle-emails)
- [Guest emails, unsubscribes & suppression](#guest-emails-unsubscribes--suppression)
- [Guest referrals & gallery stats](#guest-referrals--gallery-stats)
- [Moderation, reveal & retention](#moderation-reveal--retention--how-it-behaves)

---

## One header, everywhere

The landing page, pricing, your dashboard, an event's manager and the platform console all draw the
**same header**: the mark on the left, the page's own controls on the right. It used to be three
different headers at three different heights — and none at all on the console — so moving between
them made the page jump and `/siteadmin` read as a different product. The operator-facing pages (the
event manager and the console) mark the mark with a small **ADMIN**.

---

## 1. Public / marketing

### Landing — `/`
The front door. Hero, feature grid, FAQ, and a footer.
- **Theme toggle (🌙/☀️)** — switches light/dark and remembers it.
- **Create your event** — to the create form (`/app`) if signed in, otherwise to sign-up.
- **See the demo** — spins up a throwaway demo event: on a phone it opens straight into the camera;
  on desktop it shows a QR + links to explore the camera / host / gallery views.
- When you're signed in, the sign-in CTAs become **My events →** (your dashboard).

### Try the demo — `/demo`
A stable, printable address that is always a working demo. Landing on it creates a throwaway demo
event and drops you straight into the camera, exactly as if you had scanned a guest's QR code.
- **Why it exists** — the demo used to be reachable only by pressing a button on the landing page,
  which issues a `POST`. A printed QR cannot POST, so the QR on a sample poster had nowhere real to
  point. This is the address those posters print.
- **Why the event is created by client-side script, not a server load** — a `GET` that creates a row
  is a `GET` that link-preview bots create rows with. Slack, WhatsApp and iMessage all fetch a URL
  the moment it is pasted, and this one is meant to be pasted. Bots do not run the script; phones
  do. `robots.txt` disallows it and the page answers `noindex` as well.
- **Never an `/e/<slug>` URL.** Marketing posters print `snapdini.com/demo` rather than a pretty
  custom slug: a slug is claimable, so a sample poster showing one would eventually point the public
  at whichever real host later registered it.
- Going *back* from the camera does not mint a second event — the redirect replaces the history
  entry.

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
- **Event cards** — each has **⚙ Manage** (the control panel), **🖼️ Gallery** (the public gallery),
  and **📷 Join page** (the guest camera link / QR target).
- **Recent / Active / All** filter chips with live counts.
- **Co-host invites** — if someone invited you to co-host, a banner appears: **Accept invite** adds
  the event to your list (you stay on the dashboard).
- **🎩 Admin** (site admins only) → the platform console. **Sign out** ends the session.

### Create an event — `/app`

The form walks you through **five steps** — *Your event · When it runs · Make it yours · Your guests ·
Ready* — with a step strip across the top. **Show me everything at once** on the first step drops the walkthrough
and puts every field on one page; **Walk me through it instead** puts it back. Nothing is gated: the
steps are an order to answer the questions in, not permission to proceed — and a step you have
finished is a button, so you can jump straight back to it rather than pressing Back four times.

**1 · Your event** — three short pages behind the same **Next**, because it used to ask three
unrelated things on one screen: what the event *is*, what its guests get, and how big it is.

*1 of 3 — Your event*
- **Event name**.
- **What kind of event is it?** — a grid of chips (wedding, birthday, corporate, baby shower, hens,
  engagement, graduation, Christmas, or *Any event*). Optional, and tap it again to clear it. It is
  asked here because the rest of the event is built from the answer: the photo ideas we offer, the
  mark guests tick a shot off with, the decoration on the printed cards, and which poster design is
  put first. You can still set or change it later — either in the trick-list editor on your event
  page, or by running the wizard again from **Settings**, where it is the same grid of chips. It is
  the only thing the wizard asks that is **not** answered by the words on your own trick list, so
  changing it leaves that list exactly as you wrote it: only the photo ideas we go on to *suggest*,
  the card decoration and the poster order follow the new answer.

*2 of 3 — What your guests see* — everything on this page changes what appears on a **guest's**
screen, which is why it is a page of its own rather than a footnote.
- **Trick list** — starts the event with a ready-made [trick list](#manage-an-event--admincode). It
  is **off until you turn it on**: it puts a list of shots in your guests' camera, and a default that
  changes somebody else's screen is not a default we get to make. The examples shown are the real
  first two shots from the pack your event type would get.
- **Change it up** (once the trick list is on) — makes three different cards instead of one, so
  guests are not all hunting the same shots. The must-haves stay on every card, so coverage of the
  moments you would actually regret missing does not come down to which table got which card. Add,
  edit or remove any of them later.
- **No flash** — stops guests' phones firing the bright rear flash. The gentle front-camera selfie
  flash still works.
- **Welcome blurb** (optional) — shown on the join screen, and used as the poster's default message.

*3 of 3 — How many guests?* — **Expected guests** sets the tier, and an itemised **live total**
updates on every change; free-tier features show a struck-through price.

**2 · When it runs**
- **Start date** and **Start time**. The time picker is your phone's own, and it lands on the
  **15-minute** grid the whole product runs on — pick 9:07 and it becomes 9:00, and it tells you it
  did. The grid is not a nicety: the sweeps that open a gallery and send an email wake on it, so a
  moment between ticks is one we cannot honour. Start times round **down**, because doors opening a
  few minutes early cost nothing while rounding 9:50 up to 10:00 would lock out somebody at the door
  at 9:55.
- **Times are in …** — says which **timezone** the times are read in, with the resolved start spelled
  out. Press the zone to change it **on this page**. If your device is in a different zone from the
  event it says so and offers to switch. The times you type are always the event's local times,
  never your phone's.
- **Duration** — short events are free; longer is a paid add-on.

**3 · Make it yours** — the things that change the day, one card each with what they cost (or, on a
free-tier event, a count of what you are *not* paying): **Video clips**, **Shots each**, **Frame
shapes** (Square is always free; the rest are the frame pack on paid tiers) and **Keep them longer**
(retention).
The name is deliberate — everything the product actually sells used to sit behind a
disclosure marked *Advanced settings*, a label that reads as "not for you" to exactly the host who
would have enjoyed it. Only the **Custom URL** stays collapsed under *Other settings* — a pretty
`/e/<name>` link with a live availability check; blank uses the automatic one.

Two of those cards are worth a word on how they are priced:
- **Shots each** runs from the included **12** up to **120**, in dozens, three at a time — press
  **go bigger →** for the next rungs and **← go smaller** to come back. The first three dozens are
  A$3 each; past that a dozen costs a little more than the one before it, so a normal roll is priced
  like a normal roll and a very long one pays its own way. Whatever you pick stays on screen.
- **Video clips** run 10 to 90 seconds, from +A$2. It is the one add-on whose price moves with your
  **guest count**, because it is the one whose cost does: every guest can record, a 90-second clip is
  a big file, and it is kept for the whole retention window. Everything else is a flat fee whatever
  the size of the event.

A short list of words is **reserved** and cannot be claimed (`support`, `billing`, `account`,
`password`, `admin`, `snapdini`, and similar). Slugs live under `/e/` and shares under `/s/`, so
they can never shadow a real page — the reason is impersonation, not routing: a custom URL on our
own domain borrows our authority, and `snapdini.com/e/support` reads as a page we wrote. The match
is **exact on purpose**: `snapdini` is refused, `snapdini1` and `support-crew-xmas` are fine. A
prefix rule would look tighter and be worse, silently refusing hosts the actual name of their own
party. Events already holding one of these words keep it — only a *changed* slug is re-checked, so
a printed poster never stops working.

**4 · Your guests** — what happens *after* the party, in three pages.

*1 of 3 — When can people see the photos?* The gallery itself: when it opens, and what is allowed in.
- **Instant** — photos appear as they are taken.
- **At the end** — plus a **reveal delay** of *immediately · 1 hour · 3 hours · 12 hours · 24 hours ·
  2 days · 3 days · 1 week* after the event ends, **or "Pick an exact date & time…"** for a moment of
  your own. A custom moment is read in the **event's** timezone and rounded **up** onto the next
  15-minute tick — both in the picker and again on the server. Up, not down: an early reveal is the
  one mistake that cannot be undone, because the photos are already out. The form tells you the
  exact instant before you create anything, and refuses a reveal booked after the photos are deleted
  at the end of retention.
- **Manual** — nothing appears until you press Reveal.
- **Moderate photos** — offered on any non-instant event. Nothing a guest takes reaches the gallery
  until you say yes to it.
- **Allow downloads** — guests can save single photos, or take the whole gallery at once. Off makes
  the gallery look-only; everyone still sees the photos.

*2 of 3 — How do your guests get their copy?* The email, which can never arrive before the gallery
opens. **How should your guests get the photos?** and, on the two manual settings, **Which photos do
they get?** and the send time. Full detail under [Getting the photos to your
guests](#getting-the-photos-to-your-guests-in-manage).

*3 of 3 — What we email your guests.* Only guests who asked for their photos are ever emailed, and
they get them whatever you choose here.
- **Thank-you & release date** — goes out when the event ends.
- **Day-before reminder** — 24 hours before the gallery opens. Shown even when your event cannot use
  it, switched off with the reason underneath, rather than quietly missing.
- **The gallery link** — *not a separate switch*. It is how the delivery you chose on the previous
  page actually reaches them, so it is shown locked: on for the two automatic settings, and off for
  the two where you press send yourself.

Nothing here is final — every answer is on your event page afterwards.

**5 · Ready** — a summary of what you are about to create and what it costs, then **Create event**.
Free events go straight to the manager; paid events go through Stripe Checkout and activate on
payment. Signed out, the button becomes **Create my account & event** — your answers are kept and
you come straight back to finish.

### Manage an event — `/admin/<code>`
The organiser control panel (owners and co-hosts; accessed by your account or the organiser code).

**It opens on a menu, not on the whole panel.** Eight tiles — *Controls, Share & invite, Poster,
Photos, Guests, Event settings, Theme, Trick list* — each saying what is inside it rather than only
naming itself, with a pending-moderation count on Photos and the guest count on Guests. Pick one and
that section takes the page, with **← All settings** at the top to come back. The place you were is
remembered per event for as long as the tab is open, so a refresh in the middle of the theme editor
lands back on the theme. **Poster** is not a section — the tile opens the designer.

The sections, and what is in each:

- **Share & invite:** the event's **QR** (Snapdini logo in the centre), **Copy code**, **Share
  invite** (native share sheet), **Copy join link**, **Save QR** (print-quality PNG), and
  **🎩 Create poster** — which reads **🎩 Manage poster** once a design exists, because by then the
  button reopens your work rather than starting over. With a design saved, a second button,
  **Start again from a design…**, reopens the design gallery.
- **Guest list:** who you mean to invite. It sits directly under *Share & invite* because it is the
  same job for the people you are *not* standing next to — and it is the only place that can answer
  "did that actually arrive?". Add guests by hand or import a spreadsheet, send the invites, and see
  what became of each one. Detail [below](#guest-list-in-manage).
- **Controls:** **Reveal all now / Hide photos** (override the reveal timing either way), **Allow
  downloads** toggle, **Lock / Unlock** (stop new joins/uploads), and **Delete** (two confirmations;
  owner only).
- **Settings** (saved together): name, blurb, start date/time (**locked once the event has started**),
  timezone, **Custom URL** (add/change/clear), photo shapes, reveal mode + delay — including
  **Pick an exact date & time…**, which loads back as the wall-clock time you typed rather than that
  instant translated into wherever you happen to be editing from — **Moderate photos**, **No flash**,
  **Guest hearts** (on unless you turn it off; see [below](#4-guest-capture)),
  and, at the foot of the same card, **how your guests get the photos** and what we email them
  ([below](#getting-the-photos-to-your-guests-in-manage)). Unsaved changes block the Upgrade panel so
  quotes stay accurate.
- **Theme:** pick a colour palette or upload an event image (crop/zoom) — applies and saves
  instantly; it themes the join screen, gallery, poster and slideshow.
  - **How the image is framed.** You crop it to 3:4, and on a phone — which is how guests arrive,
    since they scanned a QR — that crop fills the screen behind the join card, so what you framed is
    what they see. On a wide screen it is shown whole over a blurred copy of itself instead, rather
    than cropping your framing a second time to fit a landscape monitor.
  - **Pull it right back if you want to.** The zoom goes below "fills the frame", and whatever gap
    that leaves fills with a blurred copy of the same picture — so "show all of it, smaller" is a
    real answer, not something the cropper refuses.
  - **Reposition… any time.** Your original upload is kept, so you can reopen the framing later and
    it starts exactly where you left it. No need to find the file again.
  - **Your poster frames it separately.** A poster is a different shape (1:√2 against this 3:4), so
    it takes its own crop of the same picture — set in the poster designer, where you can see the
    result. See [Poster](#poster).
  - **There is no light/dark switch, because the palette is one.** The palettes sit in two labelled
    columns, **Dark** and **Light**, eight each. The light eight — **light** (neutral), **cream**
    (warm ivory), **sky** (blue), **lilac** (violet), **sage** (green), **blush** (pink), **clay**
    (warm red) and **mist** (cool grey) — put the whole event on a pale background with dark text;
    the dark eight are the lit-from-behind look.
    (**ink & linen** is in the Dark column for a reason: it is linen-coloured type on near-black.) (**ink & linen** sounds light and is not: it
    Anything you build yourself works the same way: **custom**
    asks **Dark or Light** before it asks anything else, and it opens on whichever your event is
    already — pick **blush**, open **custom**, and it stays light.
  - **custom** sits at the end of the palette row and is always there. Tap it to build a palette
    from **one colour of your own** — the flowers, the invitations, the team strip. Pick the colour,
    then choose what to set it against: first **Dark** or **Light**, then **Monochrome** (that one
    hue throughout), **Analogous** (the hue next door), **Triadic** (a third of the way round the
    colour wheel) or **Complementary** (straight opposite, the boldest). Your colour becomes the
    accent — buttons, links, highlights — and the background, cards and text are built around it.
    On a **light** palette your colour is darkened as far as it needs to be for button labels to
    stay readable on it; on a dark one it is used exactly as you picked it.
  - A **live preview** shows the actual join screen your guests will see, not colour squares.
  - **Can your guests read it?** underneath scores three real pairings — the event name, the small
    print, and the buttons — and says what to change. If the text and the background are too close
    together to read, **Use these colours** tells you so and takes you to the text colour rather
    than saving something your guests cannot read.
  - **Adjust the colours yourself** opens the individual swatches (background, cards, text, accent)
    if you already have a hex code in mind. Picking a new colour above rebuilds them; changing one
    here leaves it where you put it. Nothing is saved until you press **Use these colours**, and
    **Cancel** leaves your event exactly as it was.
  - Once it is in use, the **custom** swatch shows your own colours with a tick, like any other
    palette. Tap it again to change them; tap a named palette to go back.
- **Upgrades** (billing on): raise guests/shots/video/retention/length or add the frame pack — you
  pay only the difference. The top line always says what the event has now and what you have paid;
  the itemised breakdown appears only once you change something that costs more, and shows what is
  already covered and what is left to pay. Each control offers the published tiers and nothing
  beyond them: an event
  bigger, longer, or kept for longer than the largest tier is a **custom plan**
  (support@snapdini.com), not a silent upgrade — so you are never sold an allowance at a price that
  was never quoted for it.
- **Trick list** (optional, off until you add one): a short list of shots to hunt for — "someone
  laughing", "the oldest person here". It is loaded from the **event type** you picked when you
  created the event (change it here if you like); tap a **mood** (the classics, fun, silly,
  heartfelt, get-them-mixing) for an instant list, or go through the full list and choose your own —
  you can write your own tricks too. Five by default; anything from 1 to 20.
  - Pick the **tick** guests and cards mark off with (a heart, a bottle, a star, or type your own).
  - **Several cards** (up to 8) hand different guests slightly different lists, so the room isn't
    shooting the same six things. Name each one — "Golden oldies", "The tricksters" — and print
    them separately. Every guest is given one card and keeps it.
  - **Deleting a card says who it moved.** Guests holding that card are put onto the first card
    still in the list (or onto none, if you cleared the list), and Save tells you how many — they
    are asked which card they are holding the next time they open the camera. You cannot see that
    from the editor, which is exactly why it is said there.
  - Guests see it as a pill in the camera; ticking one off is automatic when they shoot it.
- **Review & Curate** — link to the photo hub (shows a pending count under moderation).
- **Co-hosts:** invite by email (they get a link + an in-app accept), copy a pending invite link, or
  remove a co-host. The owner can't be removed and only the owner can delete the event.
- **Shared links** (in **Photos**, under Review & curate — they are the other half of the same job:
  curate the photos, then decide who gets to see which of them): the event's standing gallery link
  and every curated share you've made, each with
  the same three ways of handing it on — **Copy**, **Share** (your device's own share sheet) and
  **Email**, which sends it for you and keeps a record of who received what, so *"did I already send
  this to Mum?"* has an answer. Email is collapsed by default: it is the heaviest of the three and
  the least often wanted, and it only appears at all when the server can actually send. An address
  this same link has already reached is **skipped rather than mailed twice** — including one your
  guest was already sent it at automatically. Each link also wears two small pills saying whether
  **hearts** and **comments** are on for it — both states, so "can people comment on this one?" has
  an answer at a glance rather than an absence. Plus **Edit** (rename / change the `/s/` URL, and
  flip those two switches) and
  **Delete** (existing links keep working until deleted).
- **Participants:** **Remove** a guest (also deletes their photos — useful for a duplicate join).
  With more than one trick card in play, each guest also has a **Card** picker — for the guest who
  scanned the wrong table's card by mistake. Moving them destroys nothing: their ticks for the old
  card simply stop counting, and come back if you move them back.

#### Guest list (in Manage)

A record of who is coming, and — once you have emailed them — what happened to each message. The
second half is the part you cannot do from your own inbox: anyone can type twenty addresses into
Gmail, but nothing there will tell you afterwards which three of them bounced.

**Building the list**

- **+ Add guest** — email (required), plus a name and a free-text note if you have them. The list
  is how you email people the join link, so an address is the one thing an entry cannot do without;
  anyone you haven't got an address for needs a printed card or a message from you directly. The
  name is optional — a guest you have only an address for is a perfectly good entry.
  - **There is no phone number field, on purpose.** Snapdini invites people by email and has no
    other way of reaching them, so a phone number would be a piece of your guests' personal
    information that nothing here could ever use — and storing what you cannot use is exactly what
    we try not to do. A note *is* kept, because you read your own notes back on the list.
    If you want a number written down, put it in the note and it will be there when you open the
    guest's row.
- **Import** — paste rows straight out of a spreadsheet (copying cells gives tab-separated text,
  which is read as happily as a comma; semicolons work too, which is what Excel writes in
  comma-decimal locales) or **Choose a CSV**. The preview tells you which one it read your paste
  as, so you can see it was understood. An `.xlsx` is detected and you are told to save it as CSV,
  instead of the parser rendering your spreadsheet as one guest named after a zip header.
- **Your spreadsheet can keep its phone column — we just will not import it.** Paste the
  `Name,Email,Phone` sheet you already have. The phone column is *recognised* and set to **don't
  import**, so nothing is mistaken for a name and nothing is refused; the preview shows you that is
  what happened. It works the same way whichever position the phone column is in, with or without a
  header row. If you want the numbers kept, switch that column's dropdown to **notes** — then they
  are kept, because you asked for them.
- **A header row is optional.** With one — `Name,Email,Notes` — the columns are matched by their
  names, and that row is shown in the preview greyed out and labelled, so you can see it was used
  for the names rather than imported as a guest. (It is also why the first guest is line 2.)
  Without one, the columns are worked out from what is *in* them: anything that looks like an email
  address is the email column, anything that looks like a phone number is a column we skip, the
  first remaining column of words is the name and the next is the notes. The preview says "no
  header row found" and keeps your first line as a guest rather than eating it. The same reading
  happens when you *do* have a header but we do not recognise the names in it.
  - It is a guess, and the dropdowns are there to correct it. Two email columns: the first is used
    and the second is left out rather than dropped into the wrong field. A single column of
    addresses with no names at all is a perfectly good import — a file with **no** address column is
    the one thing that cannot be imported, and you are told that once, above the dropdowns.
- **Preview first, always.** You get your own column headings with a dropdown against each —
  *name · email · notes · don't import* — a guessed mapping you can correct, and a count of
  what the import will do: how many to **add**, how many are **already on the list**, how many have
  **no email**, how many are **bad addresses**, how many **skipped**. Skipped rows are listed,
  greyed, each with its reason — and rows with no address get their own number in that count,
  because they are the ones you can do something about: print those guests a card.
  "160 imported" with no mention of the other forty is how a host finds out at the party that forty
  guests were never invited. Pressing Import re-runs the identical read over the identical text, so
  what you approved is what happens. With nothing in the box, **Preview** says so and puts the
  cursor there — it used to be greyed out, which on a phone is indistinguishable from broken. Picking
  the *same* file twice in a row works too, which matters the second time you fix a typo and re-save.
  If the mapping leaves nothing to import, the dropdowns stay on screen beside the message — the
  thing it is asking you to change is the thing you need in front of you.
- **The list is alphabetical**, by name, with anyone you have only an address for at the end. So adding or renaming a guest moves them to where their name belongs rather than to
  the bottom — the row rings briefly so you can see where it went.
- **Importing the same spreadsheet twice does not double the list.** Duplicates are caught on the
  email address, which every guest has — so two people who happen to share a name are simply two
  addresses, and re-importing the file you already imported adds nobody.
- Limits: **2000 guests** per event and **2000 rows** per import (a guest list is a party, not a
  mailing list), and the preview renders the first 200 rows with the totals beside them.

**Sending**

- **Send invites (N)** mails everyone on the list who has an address and is not blocked; N is that
  count. Each row also has its own **Invite** / **Resend**. One press sends to at most 200 people.
- The invite is a Snapdini-branded email with the event name, the join link and the join code, and
  an unsubscribe link in the footer.
- Afterwards you are told what actually happened — and anyone who was **not** mailed is reported
  first, as a warning, by address and reason. A send that says "20 sent" and nothing else is exactly
  as informative as one that silently dropped nineteen of them.

**What each row tells you**

Along the top: how many guests, and how many **need a look**.

Each guest is one line — their **name** and the state of the last invite sent to them: **Not
invited**, **Sent**, **Delivered**, **Bounced**, **Marked as spam**, **Unsubscribed**, **Failed**,
or **Blocked** with the reason. Only *Bounced* and *Marked as spam* are drawn in red, because they
are the only two that need you to do something: a deferral is Mailgun still retrying, and colouring
that as a failure sends hosts chasing guests whose mail is a few minutes late.

**Press a guest to open their row.** A closed list answers "who's coming, and did their invite
land?", which is what you are asking when you scan it. Everything you only want about *one* guest
waits inside that guest's row: their **email** and **note**, the **date** the invite went
out, the **mail server's own words** where there were any — *550 no such user* means fix the
address, *mailbox full* means try tomorrow, and collapsing both into "failed" throws away the only
thing that tells you which you are looking at — and the **Invite / Resend**, **Edit** and **Remove**
buttons.

**How invites work, and who gets the photos** — the panel under the blurb — holds the parts you read
once: that this is your *invite* list and photos go to whoever joins and asks for a copy (which may
not be the same people), and, where they apply, the two admissions below.

**Two honest admissions the card makes rather than hides**

- With no mail transport configured, invites cannot be sent at all and it says so — the list keeps
  everyone's address ready for when one is.
- Delivery tracking needs Mailgun *and* a webhook signing key (see `UPGRADING.md`). Without both,
  every invite reads **"Sent (delivery unknown)"** and stays there. A status that will never change
  is better said out loud than left looking like one that is about to update.

**Blocked addresses.** An address that hard-bounced or was reported as spam is marked **Blocked**
with the reason, and no send will go to it — not even *Resend*. That list is deployment-wide, not
per-event, so a guest can be blocked here because of something that happened at somebody else's
event entirely. There is deliberately no un-block button: repeatedly mailing dead addresses is what
gets a sending domain throttled and then blocked, after which nothing anyone sends arrives. Ask that
guest for a different address and add it.

**Removing a guest** takes them off the list but keeps the record of what was sent to them. A bounce
you still need to act on must not vanish along with the typo that caused it.

#### Getting the photos to your guests (in Manage)

At the foot of the **Settings** card — the same questions the create wizard asked on *Your guests*,
so setting it up one way and changing it later are the same screen.

Only guests who **asked** for their photos are ever emailed; see [Guest
capture](#4-guest-capture) for how they ask. The card shows how many have.

- **How should your guests get the photos?**
  - *Everything, as soon as photos are revealed* — the whole gallery the moment it opens. The
    default, and nothing for you to do.
  - *Just my favourites, when I've picked them* — nothing goes out until you say so.
  - *At a time I choose* — pick a date and time below.
  - *I'll send it myself* — nothing automatic, ever.
- **Which photos do they get?** — *Everything* or *Just my favourites*. Asked only on the two
  options that do not already answer it; on the other two the words you chose **are** the answer, and
  asking twice only lets the two disagree.
- **Send date / Send time** (on *At a time I choose*) — read in the **event's** timezone and stepped
  in 15 minutes, the same grid the reveal runs on. It cannot be set before the photos are revealed:
  a gallery link that arrives before the gallery opens sends a guest to a locked page, and they do
  not come back. The hint under the fields says what will happen, including when your time moves up
  to the next check.

Three messages, each its own switch:

- **Add a thank-you and the release date.** Note what this does *not* control: a guest who asked for
  their photos gets them either way — they asked, and that consent stands on its own. This decides
  whether that message also carries a thank-you and tells them when the full gallery opens.
- **Remind them the day before.** Goes 24 hours before the gallery opens. It is only offered when
  the gallery opens **more than** a day after your event ends; when it doesn't, the card says why
  rather than quietly omitting a switch you have seen on another event. Exactly 24 hours is not
  enough — the reminder would land in the same moment as the message that already tells your guests
  when the photos arrive, so they would be told the same thing twice.
- **Tell them the photos are live.** Goes with the gallery link the moment the photos are released.

Underneath, **📨 Send the gallery link to guests now** (**Send it again now** once you have) sends
your *saved* setting to every guest who asked. Once a send has gone, the card says when — without
that, a send that worked and a send that never ran look identical, and the obvious next move is to
send the whole thing again.

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

**Then it walks you through changing it.** Five short steps with the live preview beside them:

| Step | The question it asks |
|---|---|
| **Words** | What does your sign say? |
| **Type** | How should the words look? |
| **Join** | How do guests join? |
| **Art** | Anything drawn on it? |
| **Paper** | What is it printed on? |

**Skip — show me every control** on the first step opens the whole editor instead; **Walk me
through it instead** puts the steps back. Changes save as you make them.

##### Words
- **Title**, **Message** and **How-to** line.
- **Each line has its colour beside it.** The swatch sits on the field it colours, so "what colour
  is this line" is answered where the question is asked. There is no separate list of colours
  somewhere else in the flow — one control per line, and that control is the one you are looking at.
  The small lines and the names follow the title by default; pick a colour on one and only that line
  moves, with **↺ Sync to title colour** to put it back.
- **From your image.** With a photo background, the six colours it is mostly made of are offered as
  swatches; pressing one recolours whichever swatch you last touched. **↺ Use theme colours** puts
  the whole palette back to following the event.
- **Small lines above and below the title** — two short lines set smaller than the headline, one
  over it and one under, moving with it as one block. Empty unless you want them.
- **Names** sets the couple or the hosts. Type it as you'd say it: put **and**, **&** or **+** in
  the middle and the names stack — one above the other, with the joining word small between them.
  The separator you typed is the one that prints. No separator and it stays on one line; blank and
  nothing is drawn. **Stack the names** off prints the line exactly as you typed it.
- **Your own lines** — add as many extra lines as you like (a table number, a hashtag, a wifi
  password), each moved, resized, retyped and deleted on its own.
- **Tap the words on the preview to pick them up, then ✏️ to change them.** On a phone the
  controls sit below the poster, so changing a title meant typing blind and scrolling back to look.
  A tap now *selects* — the box gets its own row of controls, and ✏️ opens the words there, where
  you are already looking. (A tap used to open the keyboard immediately, which got in the way of
  simply nudging something.)
- **Turn it.** A selected element carries a **↻** grip at its top-left, diagonally opposite the ⤡
  resize corner: drag it round the element's own centre. It settles onto the nearest 15° when it is
  within 5° of one — upright, a slight tilt, 45°, sideways — and is free to the whole degree
  everywhere else, so there is no threshold to fight your way out of. Turn something and an
  **↺** chip joins its controls to put it back upright.
  - The title, the message, the how-to line, the names, the web address, your own lines and your own
    placed motifs all turn.
  - **The QR does not, and neither does the Snapdini mark.** A scanner works out a code's own
    orientation before it reads it, so turning one buys you nothing — while the join code or link
    printed under it would come out sideways on the wall. The mark is our imprint on your sign; it
    has no resize grip either.
  - The outline you drag turns with the words, because the same code that draws them works out where
    they now are.

##### Type
Five bundled typeface pairings — **Plain, Editorial, Formal, Garden, Modern** — each a display face,
a script face and a body face chosen to go together, plus whether the title is set in the
**structural** face or the **script** one. The faces ship with Snapdini rather than being fetched
from a font service, so they work on a venue's bad wifi and what you see is what prints.

##### Join
- What shows under the QR: the **join link**, the **join code**, or **nothing** — with its colour
  beside the choice, on the same principle as the words: the swatch lives next to the thing it
  colours, and appears only while there is something to colour.
- **Show the web address**, with its own colour in the same row, and **Show the Snapdini mark** —
  our wordmark on someone else's wedding sign is your call. (The small logo inside the QR is not
  optional; it is what makes the code ours.) Both start at the foot of the page and both can be
  dragged anywhere, which is why neither is named after where it begins.
- **White card behind the QR** — on by default. You can turn it off *only when the paper can
  actually carry the code*, and that is **measured, not guessed**: the panel reports the background's
  symbol contrast as a percentage and a grade, and unlocks at 55% — grade B, not the grade C a
  verifier calls a pass, because this code gets one attempt in bad light, from a stranger, at an
  angle. (At 40% the bar let through the kraft brown the white card was introduced to survive.) Over a photo background the card always
  stays, because the code could land on a bright sky or a dark suit. Drop the card and the hint still
  says: print one and scan it before you print fifty.

##### Art
A line-art motif — **Border, Wavy border, Black tie, Birds, Glasses, Confetti, Sparkles, Sprig, Art
deco, Rings, Hearts, Camera (round the QR), Camera (one line)** or **Camera (heart lens)** — with its
own position (top / corners / both, for the ones where position means anything), size and colour.
Everything is drawn as an outline rather than a fill, because these get printed, often at home,
where a solid shape is both uglier and dearer.

Separately, **place your own**: drop any of the positional motifs onto the page, then drag, resize,
**rotate** (the ↻ grip on the preview, the slider in the list, or ↺ Upright) and delete each one. As
many as you like, in any mix. Tap a placed motif on the preview to select it, or pick it from the
list.

**They may go over the white QR card.** A motif dragged there used to vanish — the card painted over
it — which looked like the control not working. It now draws on top of the card, and only the
**code's own square** is kept clear: the four-module quiet zone a scanner needs is generated into the
QR image itself, so the card's padding around it is spare margin rather than anything the code
requires. A motif is free to reach the strip where the join link prints, and the words print over the
top of it — they are what a guest has to read.

##### Paper
What the poster is printed ON — the text colours live beside the text, on the steps above.
Background is the event image, a plain colour (including **Match theme**), or an upload. An uploaded
background is kept with the design, so it is still there next time you open it. When the background
is the **event image**, **Reposition…** reframes it for the poster's shape rather than reusing the
crop you made for the join screen.

**Your own picture on the poster.** Beside the motifs, **＋ Add image** puts a picture of your own on
it — a crest, a monogram, a drawing, anything. It moves, resizes, rotates and deletes exactly like a
motif, and it appears in the **Placed** list as "Image". Use a **transparent PNG** if you have one:
it sits on the poster with no box around it. Anything else works, but a white background will print
as a white rectangle.

Back to the paper itself — and a
plain colour asks one more question: is it **ink or paper**? Left as paper it is shown the whole time you design, so your ink is chosen
against what it will really sit on, but left *off* what prints — because a host ordering cream card
stock does not want us spraying cream ink onto it. Text colours adjust themselves to stay readable
on whatever is behind them, including the join code, which sits on the QR panel's white rather than
on the poster's background. Pick ink lighter than the paper and you get a note rather than a block:
ordinary four-colour printing can only darken stock, so light type on dark card needs white toner,
screen printing or foil — a sign shop can, a home printer can't.

**The paper's *size* is not on this step** — every A size is the same shape, so it changes nothing
you can see here. It is picked on the 🖨️ Print tab, beside the buttons that use it.

##### Arranging it (no step of its own — you do this throughout)
Arranging used to be a sixth step at the end. It isn't any more: the preview is beside you the whole
way through, and every element carries its own controls, so you place things as you decide them
rather than afterwards.

**Tap an element on the preview to pick it up.** Its box outlines, and a small row appears on it:

| | |
|---|---|
| its **name** | so you know what you have hold of |
| **✏️** | open its words right there (only on things you wrote — not the web address, the mark or the code) |
| **🗑️** | get rid of it — press once to arm it, it turns red, press again to confirm |
| **✕** | let go of it |
| **⤡** | the resize corner, at the opposite end |

**While you are holding one element, tapping another does not swap to it.** That is deliberate: it
stops a stray tap dropping the thing you were working on while you reach for a control below the
preview. **✕** and the **Esc** key are the two ways to let go.

**To move it:** drag anywhere on the box. **To resize it:** drag the **⤡** corner, or pinch with two
fingers — the pinch works from anywhere on the page, so you are not trying to get two fingers onto a
line of text. Nothing can leave the page, and everything stays inside a **5 mm print margin**, which
is roughly what a consumer printer loses off every edge. Elements snap to the page centre and to
each other; a pink line shows what lined up, and dragging on past it breaks the snap.

**What 🗑️ does depends on the element**, because "get rid of it" means different things:

| element | 🗑️ |
|---|---|
| a line you added yourself | deletes it |
| **Message**, **How-to**, **Names** | empties the words, keeping the spot, size and colour — retype them and the design is back as it was |
| **Snapdini mark**, **web address** | switches it off (the same switch that is in the panel) |
| a motif you placed | deletes it |
| the **title** and the **QR** | no bin. The sign needs a title, and the code is the only way a guest can join |

To bring a cleared element back, type into its field in the panel below — or press **↶** once.
Hovering or focusing a control outlines the thing it changes, including where an *empty* field would
go, so you can see the Names line has a place waiting before deciding to fill it.

**⛶ Arrange** gives the layout the full screen. **↶ / ↷** undo and redo (Ctrl/⌘+Z) and sit in the
header, so they are still reachable mid-drag and in full screen — which is the moment an undo is
worth anything. **Esc** backs out one layer at a time: an armed bin, then an open text box, then the
element you are holding, then full screen, then the designer.

##### Getting it out — the 🖨️ Print tab
Every way out of the designer is on one tab, for the poster and the cards together. It used to be
two rows at the feet of two tabs, so what you could produce depended on where you happened to be
standing.

**The poster.** Pick the **paper — A6, A5, A4, A3 or A2** — then **🖨️ Print · PDF · PNG · JPG**.
Every A size is the same shape, so changing it changes nothing about the design; what it changes is
how many pixels the export is drawn at, and the line above the buttons says the resolution you are
actually getting (`One A3 sheet, for the door or the welcome table — 288 dpi`). That number is the
one thing you cannot see until it is printed. It is capped rather than unlimited: a full 300 dpi A2
is a 35-megapixel canvas, and iOS Safari silently hands back a **blank** one past about 17
megapixels, so the export stops below that line — which still leaves every size well above what the
old fixed-size export produced.

**Trick cards**, in their own block on the same tab: print the card you were previewing, or all of
them, as print, PDF or PNG. With no trick list it says so and offers to explain them rather than
sitting there dead.

**Front & back** shows you both pages — poster on the front, one trick card sheet on the back —
before it prints anything. A double-sided job is the one print you cannot check without wasting a
sheet. It also reminds you to flip on the **long edge**: short-edge duplex turns the back upside
down, and the browser's own print dialog owns that setting, not us.

#### Trick cards (the second tab)

The cards guests hold. Everything above about words, type, colour and dragging applies here too;
these are the decisions that are the card's own, in their own five steps (*Words · List · Layout ·
Art · Colour* — the List step steps itself over when the event has only one card).

- **4 per A4 / 2 / 1** — A6 place cards, A5 halves, or one full-page card. A4 halves and quarters
  exactly, so every option fills the sheet with nothing wasted.
- **Card shape — Portrait or Landscape**, at **every** card count. It means the **card in your
  hand**, and the sheet is worked out from it. That is a fix, not a rename: the button used to set
  the *paper*, which gives landscape cards at 4-up and at 1-up and **portrait** ones at 2-up — two
  A5s side by side on a landscape A4 are each portrait, necessarily — so one button meant two
  opposite things. Press Landscape now and you get landscape cards at every size; changing how many
  go on a sheet keeps the shape you chose and turns the paper instead. The line under the buttons
  says what you get and where to cut ("Two portrait A5 cards, cut down the middle"), and the PDF and
  the print dialog are set to the sheet, so a landscape sheet is never letterboxed onto a portrait
  page. **Nothing about a design you have already printed changes**: what is stored is still the
  paper, and an untouched design still writes the value it always did.
- **Rounded corners** on or off — off means the card edge *is* the cut line, which is what a
  guillotine can follow.
- **The cards bleed to the cut line.** There is no white gutter between them on the sheet, so the
  edge of the colour *is* the line to follow. With a gutter, a cut a millimetre off centre took a
  white sliver off one card and sliced into the art of its neighbour — the error showed on both;
  bleeding to the line means a slightly-off cut only moves where the border sits.
- **Cut guides** on or off — the dashed lines showing where to cut. On by default, because most
  people are cutting these out with scissors; turn them off for a guillotine, or for a design where
  the dashes are the only ink on an otherwise clean edge.
- Show or hide the **QR** and the join link, and write your own **caption**.
- Pick which **sets** to print and which one you're previewing. Turn the **card identifiers** off to
  shuffle the stack and hand them out at random — each card's QR still carries its own list.
- The **tick** is the one chosen in the trick-list editor, so the printed card and the app in a
  guest's hand can never disagree.
- **Ink saver** prints on white. Text colours adjust themselves to stay readable on whatever
  background you choose.
- **The card's colours sit beside the things they colour**, the same way the poster's do: the
  **title**'s swatch is on the title field, and the **code / link**'s is in the switch row that puts
  it on the card — so it is only there while there is something to colour. The other two — the
  **trick list**'s ink and the **card background** — have no field anywhere to sit beside, so they
  keep a pair of controls of their own on the Colour step. Blank means *follow the poster*, with
  **↺ Follow the poster** to put one back.
- **One design for every card** — on, which is what a set of table cards usually is: the same card
  with a different identifier and a different code. Turn it off and each card gets its own colours
  and its own arrangement. A strip at the top of the tab then says which card you are changing, the
  first card is the one the others start from, and any card that has been given a look of its own
  carries **↺ Same as Card A** to let go of it again. Cards you have not touched keep following the
  first one, so a change to it still reaches them. Every design saved before this existed opens as
  the one matching set it was designed as.

### Review & Curate — `/admin/<code>/review`
Where you approve, curate and share photos.
- **Cards / Single** views, a **💬 Captions & comments** button and a **🎬 Slideshow** button.
- **Filter tabs:** Pending (under moderation), All, ★ Favourites, 🗑️ Rejected.
- **What the room loved:** each card shows the guests' heart count. You cannot heart from here — a
  host is not a guest and does not get a vote — and **Most loved** reorders whichever tab is open.
- **Double-click a photo to favourite it**, the same gesture guests use to heart. It only ever adds;
  the corner ★ is how you take one back.
- **Per photo:** **★ favourite** (separate from approval), **✓ Approve** (only when moderation is on),
  **✕ Reject** (two-click "Sure?" → goes to the bin, restorable, excluded from gallery/share/slideshow),
  **↩ Restore** (rejected → back to pending).
- **Single view:** arrow-key navigation, click/⛶ for full screen, **📤 Share** this one photo, or
  save it with the download button.
- **Select mode:** tap to select — anywhere on the card, the words under the photo included —
  shift-click for a range, quick-select **All / ★ Favourites**, then bulk **Download** (one photo
  saves as itself; several as a zip), **Share**, **Favourite**, **Approve**, or **Reject**.
- **💬 Captions & comments** — every written line in the event in one list, newest first, with the
  photo it sits on: the captions your guests wrote on their own shots and the comments anyone left
  on anyone's. Filter to one kind, **Edit** a caption, **Remove** a line, or tick several and remove
  them together. Comments from someone holding a share link are labelled *via a share link* — a name
  typed into a forwarded link is not the same claim as a guest who joined. Lines on rejected photos
  are dimmed and say so: they are still readable, but they are not in anyone's gallery.
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
  panel (photo shapes, video, when photos appear), your **name**, an optional **email**, and
  **Email me the photos when the event ends** — then **Join & open camera**. Returning with the same
  email resumes your remaining roll. Only the name is really wanted: the address is both how you pick
  up on another device and where the photos would go, so the tick sits beside it rather than after
  the button. Tick it with the field empty and the hint asks for an address; leave it and the hint
  says you can opt in later. Nothing here blocks the join.
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
- **Saving a photo:** where the host has allowed downloads, every card carries a save button at its
  **bottom-right, under the picture** rather than over it, and the button remembers — it turns green
  once that photo has been saved to this device. On a phone saving opens your own share sheet, so the
  photo goes straight into **Photos**; on an iPhone a plain download would land in *Files*, where
  nobody ever looks for a picture.
- **Hearts:** every photo carries a ♥ you can tap, with the number of people who have. Before the
  reveal that is your own roll — which is where you find out that the shot *you* took has picked up
  eleven hearts — and after it, the whole gallery. One heart per guest per photo, tap again to take
  it back, and the count is live rather than fixed at page load. The host can switch hearts off for
  an event, in which case there is no ♥ anywhere and no count; switching them back on brings the
  counts back, because nothing is deleted.
  - **Double-tap the picture** to heart it, the way every photo app works. A single tap still opens
    the photo. It only ever *adds* a heart — a mistimed second tap can never take one away, and the
    ♥ itself is right there when you mean to.
  - **In your own roll there is no number.** You can still heart, you are simply not shown a score on
    your own photographs. The event gallery shows the counts, because there it is about the room.
  - **Most loved** sits beside **Newest** in the gallery once anything has been hearted, and reorders
    the grid by how many hearts each photo has.
- **Saving your whole roll:** the save-all button asks what and then how. Even **before the reveal**
  you can take your own shots as one zip — bounded to your own roll, which is exactly what the
  screen you pressed the button on was already showing you, so it only saves you tapping save
  thirty-five times.
- **Captions:** tap a photo — yours, or any of them if you're the host — and write a line under it.
  Editable afterwards. A photo that was a trick keeps saying which trick it was, underneath.
- **Gallery (🖼️):** before reveal you always see your own shots (with "#N" snap numbers); after reveal,
  **Mine / All / Others** filters. Downloads appear only if the host allowed them.
- **"📬 Want your shots when the event ends?"** — under your own roll, and deliberately not on the
  camera screen: nothing new goes near the shutter, and this is the moment you are already looking at
  your photos and thinking about keeping them. It is also the way back for anyone who skipped the
  address on the join screen — tap it and, if we have nothing to send to, an inline field asks where.
  Once you are opted in it confirms the address it will use, and **Actually, no thanks** undoes it at
  any time. If the address you type is already registered to another guest at this event it is not
  attached to your roll (that address is how *they* get back in on a new device) and the confirmation
  says so plainly rather than treating it as an error.

---

## 5. Public sharing & gallery

### Shared link — `/s/<token>`
Anyone with the link (no account). Resolves to the whole gallery, favourites, or a hand-picked set.
- The bar carries the **event** name, centred; the album's own name (*"For the family"*) is the
  title on the page itself, over the photos it names.
- Before reveal it shows a lock / countdown. After reveal: a themed grid, lightbox, and — if downloads
  are allowed — **Download all** or select a few and **Download N** (a recipient can only ever pull
  what was shared).
- **Hearts and comments, per link.** Each share link carries its own two switches, set when you make
  it or any time afterwards from **Edit**. A new link **starts wherever your event is**: if guest
  comments are on, a new link offers them too; if you turned hearts off for guests, a new link
  starts with them off. You have already told us what you are comfortable with, and a link that
  starts at the opposite is something you would only have to undo.
  - Only the STARTING POINT is inherited. Once a link exists it keeps its own pair, and changing
    your event settings later never reaches back and rewrites a link you have already sent. Pressing
    **Share** again on the same photos hands back the same link without resetting it either.
  - So one event can still have a family gallery that takes comments and a client gallery that must
    not — you just change the one that differs, instead of both.
  - Someone holding the link is asked for a **name the first time they react**, never on arrival —
    looking at the photos never asks who you are. The name and the token behind it belong to *that
    one link*; the same person on another link of the same event is another visitor.
  - They are **not a guest**. They do not count against your guest cap, hold a roll, get a trick
    card or appear in your guest list — a link that reaches forty relatives must never do that.
  - Hearts they leave count on the photo like anyone else's, so the number under a photo is the
    photo's number wherever it is read. Their comments show in the gallery alongside your guests',
    and in **Captions & comments** they are marked as having come in over a link.
  - Turning a switch back off hides what is there rather than deleting it — switch it on again and
    it comes back, instead of everyone having to type again.
  - **Deleting the link deletes what came in through it.** A visitor's name lives on the link rather
    than on the event, so the hearts and comments they left go when the link does. You are asked
    first. Your guests' own hearts and comments are untouched.

### Event gallery — `/gallery/<code>`
The public gallery for an event.
- **⭐ Favourites / 📷 All photos** toggle — shown only once the host has actually starred something
  — plus lightbox and the same reveal-gating + optional downloads.
- **A save button on every card** — bottom-right, below the photo so it never covers it: save one
  straight to the device, and the button shows that you already have that one.
- **Select mode** — **Select**, then tap photos to pick them; the whole card picks, the caption and
  the name underneath included, not only the picture. **Download N** takes just those.
- **Hearts** — a ♥ on every photo with the count of how many people have pressed it, live. Tap to
  add yours, tap again to take it back. Pressing one needs a guest session for this event, so
  somebody who only opened the gallery link can see the counts and not add to them. The whole thing
  is absent when the host has switched hearts off. (A curated **`/s/` share link** has its own pair
  of switches — see *Shared link* above — so the people holding one can react too, if the host said
  so when they made it.)
- **Downloading the lot asks what you want.** Sharing's three answers — **the whole gallery**,
  **highlights only** (the host's stars), or **pick them myself** — plus two that only a download
  can give:
  - **What everyone loved** — everything with at least one ♥, most-hearted first. That order only
    survives the files route; a zip is named and ordered by the server.
  - **Highlights and hearts** — the host's stars and the guests' hearts together, counted once, so
    a photo that is both appears once rather than twice.

  The two heart rows are hidden when they would hand back the same files as a row already on screen
  — everything hearted, or the union being one of its own halves — and the whole pair is absent with
  hearts off. There is also **only the ones I don't have**, when some of the gallery has already
  been saved on this device and some has not. "Download all" used to mean whatever was on screen,
  which quietly changed with the Highlights toggle.
- **Files or a zip is asked every time.** It is not remembered, on purpose: browsers disagree about
  what saving a file even means — one downloads a whole roll without asking, another prompts for
  every file, an iPhone has no downloads folder and needs the share sheet a batch at a time — so the
  right answer genuinely changes with the browser, with how many photos you asked for, and with what
  you mean to do with them. A remembered answer turns all of that into a download that starts with
  no question asked, which is indistinguishable from a button that ignores you. Big sets saved as
  files go in batches with a running count.
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
What Snapdini sends a **host**.
**Welcome** on payment · **Check-in** a few days before the event · **Account welcome** and a one-off
**nudge** for accounts that haven't made an event yet · **Post-event survey** 3 days after it ends,
carrying the thank-you discount for the next event and — when there are still photos to make one
from — a prompt to turn them into a **slideshow**, with the date they're deleted. Internal and admin
accounts are excluded from all of it.

**Which of them you can switch off — `/email-preferences/<token>`.** Two are promotional, or
arguably so: the **post-event survey** (it sometimes carries a discount code for your next event) and
the **activation nudge** (its entire purpose is to get you using the product). Those two, and only
those two, carry an *Unsubscribe* link in their footer. It opens a preference page that needs no
sign-in — an unsubscribe that first demands a password is not an unsubscribe facility, and the person
reading the email is often not the person with a live session in that browser. The page shows your
address masked, a switch for each optional message, and, listed plainly rather than quietly omitted,
the mail that keeps coming either way: **signing in** (verification and sign-in links), **your event
is live**, **just before the day**, **photos and deadlines** (retention and expiry notices) and
**co-host invitations**. Those are factual notices about something you set up, and being able to
switch off the warning that your photos are about to be deleted would be worse than the warning.

The rest carry no unsubscribe link at all, which is deliberate: a link labelled *Unsubscribe* that
does nothing is worse than no link, because it is the recipient's one attempt at opting out and it
fails silently.

Saving posts the whole set of switched-off messages rather than a change to it, so saving twice — or
opening a second copy of the link — leaves you in the state you can see. Un-ticking one puts that
message back.

## Guest emails, unsubscribes & suppression

Everything Snapdini sends to a **guest** rather than a host, and everything that stops it.

**What a guest can receive**

- An **invite** to the event, sent by the host from their [guest list](#guest-list-in-manage).
- Their **photos**, if they asked for them — and, at the host's option, a thank-you carrying the
  release date, a day-before reminder, and the gallery link when the photos go live. See [Getting the
  photos to your guests](#getting-the-photos-to-your-guests-in-manage).
- A **gallery or share link** the host emailed by hand from *Shared links*. This one is not gated on
  anyone having opted in — the host typed the addresses — so treat it as the host mailing their own
  contacts rather than as a Snapdini mailing list. A globally suppressed address is still skipped.

Nothing else is automatic. Guests are not mailed because they joined; they are mailed because they
were invited, because they asked for their photos, or because the host sent them a link.

**Unsubscribing — `/unsubscribe/<token>`**

Every invite carries two ways out, because they serve different people:

- A **one-click unsubscribe in the mail client's own chrome**, from a `List-Unsubscribe` header
  (RFC 8058). No page and no confirmation — a "are you sure?" step fails the standard outright, and
  the entire value of that button is being cheaper than the *report spam* button beside it. A mail
  client offers no way to say anything narrower, so one press has to mean **stop, everywhere**.
- A **link in the body**, for the person who wants to choose: *just stop emails about this event*, or
  *never email me from Snapdini again*.

The page applies the unsubscribe the moment it loads. Arriving is the request, and asking someone to
confirm the thing they have just done is how they end up at the spam button instead. It then shows
which of the two is in force, with your address masked, and lets you widen or narrow it. **Only
after that**, on a page already saying *You're unsubscribed*, does it ask why — *too many emails · I'm
not going to this event · I didn't give anyone my address · this isn't my email address · something
else*, plus a comment box. All of it optional, and skipping it changes nothing above it: feedback
that gated the opt-out would stop it being the cheap option, which is the one property the mechanism
depends on. It works with JavaScript switched off, as a plain form.

Links in an invite are never acted on by anything but a person. The one-click endpoint answers a POST
and nothing else, and the page's first load reads without changing anything — mail providers and
security gateways routinely fetch every link in a message before a human ever sees it, and a
scanner that could unsubscribe people would opt out guests who never opened the invite.

**Suppression**

An address stops being mailed when mail to it hard-bounces, when someone reports it as spam, or when
someone asks never to be emailed again. That list is **deployment-wide**, not per-event: sending
reputation belongs to the domain, so an address that is dead at one host's wedding is just as dead at
another's birthday, and mailing it again is what gets a domain throttled and then blocked — after
which nothing anyone sends arrives. A *just this event* unsubscribe is kept separate and stops only
that event's mail. Someone who reopens their link and narrows *everything* back to *this event* is
taken off the global list — but only when it was their own request that put them there. A bounce or a
spam complaint is a fact about the mailbox rather than a preference, and nobody holding an invite
link can erase one.

Suppression is checked in the one place every outgoing email passes through, so every sender honours
it, including ones written later. Three are deliberately exempt, because for those *not* sending is
the greater harm: **sign-in and verification links** (withholding one locks somebody out of their own
account), **operator alerts** addressed to the platform's own support inbox, and the **contact form** —
someone asking for help.

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
- **The gallery reveals itself — nobody has to reload.** A guest sitting on the countdown sees the
  photos appear on their own. Three things make that safe rather than merely automatic:
  - The client waits a few seconds **past** zero before asking. The server gates on *its* clock and
    the countdown runs on *yours*; a phone a couple of seconds fast would otherwise ask early, be
    told "not yet", and spend its one chance. The first ask is padded, then retried with backoff a
    handful of times before it gives up and leaves it to the slow poll.
  - **Moderated** events are a separate case, because moderation is a filter and not a gate: such an
    event is "revealed" while still showing nothing. The page says the host is still approving, and
    photos appear as each one is approved — again with no reload.
  - **Manual** reveals have no moment to count towards at all, so polling is their only signal. A
    scheduled reveal still hours away drops to a much slower poll (the countdown itself covers the
    moment precisely); anything with no scheduled instant, or a reveal that is close, polls briskly.
    Backgrounded tabs never poll, and catch up when you return to them.
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
- **Taking a shot back:** for **30 seconds** after a photo lands, a guest sees a bin on that photo
  in their own gallery, with a countdown. Deleting it removes the photo and **returns the frame to
  their roll**. After the window it is permanent — a longer window would turn a limited roll into
  unlimited retries. `PHOTO_DELETE_WINDOW_SECONDS` tunes it, and the camera reads the real number
  from `/api/config` rather than keeping a copy of its own — so a deployment that changes it does
  not end up with a bin that offers itself for longer than the server will accept.
- **Hearts:** on for every event unless the host turns them off in Settings. What a guest can heart
  is exactly what they can *see*: before the reveal that is their own roll and nothing else, a photo
  held back by moderation is not hearted at all, and a rejected photo drops out of the counts and
  out of a guest's own list of hearts. **Locking** the event stops hearting like it stops uploads,
  and an event that has not started yet accepts none. **Ending** the event does not stop them —
  people browse a gallery for weeks afterwards, and hearting is part of browsing. Turning hearts off
  hides them and refuses the endpoint; nothing is deleted, so turning them back on restores every
  count.
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
