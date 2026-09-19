# Snapdini — delivery tracking with Mailgun

How to make the guest list tell the truth about what happened to an invite, instead of stopping at
*"we handed it over"*.

This is an **operator** job, not a code one: the app already knows how to receive and verify
Mailgun's delivery webhooks, but only Mailgun can tell it what happened, and only you can give it
the key that proves those messages really came from Mailgun. Everything below is that handover.

Everything here is optional. With none of it done, Snapdini sends invites exactly as it does today —
it just never learns anything more about them.

---

## What you get, and what you get without it

Sending is easy; **knowing** is the feature. A send that reports "20 sent" and nothing else is
exactly as informative as a send that silently dropped nineteen of them.

| | Delivery tracking **off** | Delivery tracking **on** |
|---|---|---|
| Guest list shows | *Sent — delivery unknown* | *Delivered* · *Delivered to spam* · *Bounced* · *Marked as spam* · *Unsubscribed* · *Failed — retrying* |
| A dead address | keeps being invited, every time | recorded, and **never mailed from this deployment again** |
| A spam complaint | invisible | shown to the host, and the address is suppressed |
| Your sending reputation | erodes quietly | protected, because bad addresses stop being retried |

The "off" column is not a broken state — it is an honest one, and the UI is written to say so. A
`sent` that will never change is presented as *delivery unknown* rather than as a status that is
about to update, precisely so nobody sits waiting for news that is never coming. That distinction is
driven by whether a signing key is configured, so turning tracking on and off is safe in both
directions and never leaves the screen lying.

The last row is the one that bites eventually. Mailbox providers decide whether you are a sender or
a spammer largely by how often you mail addresses that do not exist, and a guest list typed up from
a wedding spreadsheet always contains a few. Without tracking you cannot know which, so you keep
mailing all of them — and the day that catches up with you, *nothing* you send arrives for anyone.

---

## Step 1 — get the HTTP webhook signing key

**This is not the API key you already have.** Mailgun issues two different secrets and they are easy
to confuse:

| | What it is for | Where it goes |
|---|---|---|
| **Private API key** (sending) | authenticates *you* to Mailgun when Snapdini posts a message | `MAILGUN_API_KEY` |
| **HTTP webhook signing key** | lets Snapdini prove a webhook really came from *Mailgun* | `MAILGUN_WEBHOOK_SIGNING_KEY` |

They point in opposite directions, which is why one cannot stand in for the other. Pasting the API
key into the signing-key slot does not produce an error anywhere — every webhook simply fails
verification, is refused with a `406`, and delivery state never updates. It looks identical to
having done nothing at all, so it is worth checking twice at the moment you copy it.

**Where to find it.** In the Mailgun dashboard it lives with your *account* keys rather than with a
domain — look for the API-keys / API-security page reachable from your account menu, where it is
listed as **"HTTP webhook signing key"** next to the private API key. Mailgun moves this page around
between redesigns; the reliable tells are that it is **account-wide** (one key, shared by every
sending domain) and that it is labelled *webhook signing*. Reveal it, copy it, and treat it like a
password — anyone holding it can write delivery state for any address on your deployment.

> **EU accounts:** the EU region is a separate dashboard with separate keys. If your sending already
> uses `MAILGUN_BASE=https://api.eu.mailgun.net`, take the signing key from the EU dashboard too.

---

## Step 2 — put the key in the environment

In `app/.env`:

```ini
MAILGUN_WEBHOOK_SIGNING_KEY=your-webhook-signing-key-here
```

It belongs to the **`app`** service (the backend). The web front end never sees it and must not —
it is a secret, and the browser is not a place secrets go.

> ### The trap this project keeps falling into
>
> **Compose passes environment variables explicitly.** A variable that is in `.env` but not listed
> in the service's `environment:` block never reaches the container, and the feature it powers is
> silently inert — everything starts, nothing errors, and the thing simply does not happen. This has
> bitten here more than five times.
>
> `MAILGUN_WEBHOOK_SIGNING_KEY` is **already wired** into both `app/docker-compose.yml` and
> `app/docker-compose.dev.yml`, so there is nothing to do for this feature. It is spelled out
> because it is the first thing to suspect if a variable you add later "doesn't work", and because
> `app/src/server/__tests__/compose-env.test.ts` enforces it: it reads every `process.env` access in
> the backend source and fails the suite if either compose file does not pass it. **That test
> failing is the system working.**

Then recreate the app container so it picks the value up (an `.env` edit alone does nothing to a
running container):

```bash
cd app
docker compose up -d app          # or -f docker-compose.dev.yml for the dev stack
```

---

## Step 3 — subscribe the webhooks in Mailgun

In the Mailgun dashboard, under your **sending domain**'s webhooks, add this URL:

```
https://your-snapdini-domain/api/webhooks/mailgun
```

It must be **HTTPS** and reachable from the public internet — Mailgun is calling in from outside, so
a LAN address or a host behind a VPN will never deliver a single event. Point it at the same public
hostname your guests use; your existing reverse proxy already routes `/api` to the app.

Subscribe these five, and only these five:

| Mailgun webhook | Why |
|---|---|
| **Delivered Messages** | the whole point — turns *sent* into *delivered* |
| **Permanent Failure** | the address is dead; suppresses it |
| **Temporary Failure** | a full mailbox or a server having a bad hour; shown, but **not** suppressed |
| **Spam Complaints** | someone pressed *report spam*; suppresses, and the host needs to see it |
| **Unsubscribes** | Mailgun-side opt-outs, folded into the same suppression list |

Both failure webhooks are needed, and this is the subtlety most worth knowing: **they arrive as the
same event.** Subscribe to *permanent* and *temporary* separately and both turn up with
`"event": "failed"` — only a `severity` field distinguishes them. Snapdini reads that field, so
subscribing to just one of them silently loses half the picture: with only *Permanent Failure*, a
guest whose mail server was busy shows nothing at all; with only *Temporary Failure*, a genuinely
dead address is never suppressed.

**Do not subscribe Opens or Clicks.** Snapdini sends with Mailgun's own tracking switched off, on
purpose: click tracking rewrites every link in the invite through a redirector, which makes the join
link unreadable to anyone who looks at where it actually points, and open tracking is a pixel that
reports on a host's guests. Those events would be ignored on arrival anyway.

---

## Step 4 — check the app agrees that it is on

Snapdini says so at boot, once, every time:

```bash
docker compose logs app | grep '\[mailgun\]'
```

```
[mailgun] delivery tracking enabled (webhook signature verification armed)
```

If instead you see:

```
[mailgun] delivery tracking OFF — no MAILGUN_WEBHOOK_SIGNING_KEY. Invites still send, but every one
stays at "sent, delivery unknown" and no bounce or spam complaint is ever recorded. The webhook
endpoint answers 404 until a key is set.
```

…then the key did not reach the container: check the spelling in `.env`, and check you recreated the
container rather than only restarting the stack's other services.

If you see **neither line**, Mailgun is not your transport at all (no `MAILGUN_API_KEY` /
`MAILGUN_DOMAIN`, or SMTP configured instead). Delivery tracking is Mailgun-only — plain SMTP has
nowhere to report back from.

The guest list is the other tell, and it is the honest one: with tracking off it carries the note
*"This server sends invites but can't see what happens to them afterwards."* When that note
disappears, the app has the key.

---

## Step 5 — prove it end to end

Two sends, five minutes:

**1. A delivery.** Add yourself to a test event's guest list and send an invite. Within a few
seconds the row should move from *Sent* to **Delivered**. If it does not, nothing below will work
either — fix this first.

**2. A bounce.** Add an address that cannot exist at a domain you control —
`no-such-mailbox-9f3@yourdomain.com` — and invite it. The receiving server answers *550 no such
user*, Mailgun reports a permanent failure, and the row should turn **Bounced** carrying the mail
server's own words. Check afterwards that the address is on the suppression list: invite it again
and it should be skipped rather than sent.

Use a domain you own for this. A made-up domain gives you a DNS failure, which Mailgun may report as
*temporary* for hours before giving up — a slower and less conclusive test than a real domain
answering a clean rejection.

Mailgun's dashboard has its own **webhook log** showing every POST it made and the status code it
got back. That log is the fastest place to diagnose anything in the next section, because it tells
you whether Mailgun called at all — which is the first fork in every one of these.

---

## When it is silently not working

Delivery tracking's failure mode is **silence**: everything keeps working, invites keep arriving,
and the only symptom is that no invite ever moves off *Sent*. That looks exactly like a run of good
luck. Here is how to tell the causes apart.

| What you see | What it means | Fix |
|---|---|---|
| Mailgun's log shows **404** | The app has no signing key — the endpoint does not exist until it does | Step 2; check the boot log |
| Mailgun's log shows **406** | The key is *wrong*: a typo, the API key pasted by mistake, or a key from the other region | Re-copy the **HTTP webhook signing key** from the right dashboard |
| Mailgun's log shows **5xx** | The app could not reach its database. Nothing is lost — Mailgun retries for about eight hours, and the event lands when the app recovers | Check the app and database logs |
| Mailgun's log is **empty** | The webhook is not subscribed, or the URL is wrong or not publicly reachable | Step 3; try the URL from outside your network |
| Mailgun logs **2xx**, but the guest list does not change | Almost always an invite sent *before* tracking was switched on | Send a fresh invite and watch that one |
| Everything works, but some rows sit at *Failed — retrying* | Working as intended. That is Mailgun still trying; it becomes *Delivered* or *Bounced* on its own | Nothing |
| Rows say *Delivered to spam* | The receiving server accepted the message and then quarantined it — see below | Fix DMARC/DKIM/SPF alignment for your sending domain |

The app logs a loud line of its own on every refusal:

```
[mailgun] REJECTED webhook: bad signature
```

which is worth watching for, because the two causes look identical from inside the app: either
someone is forging events, or your key is wrong and **every** delivery event is being thrown away.

---

## *Delivered to spam* — the delivery that is not really a delivery

Worth knowing about because it is the one status where the provider and the truth disagree.

**Mailgun reports a message the recipient's server quarantined as `delivered`.** The send genuinely
was accepted — a 2xx, no bounce, nothing to retry — and then the receiving server applied its DMARC
policy and filed it where nobody looks. Gmail does this. The only trace is a phrase inside the
receiving server's own reply, which Mailgun passes through in `delivery-status.message`:

```
2.0.0 OK DMARC:Quarantine
```

Snapdini reads it. A `delivered` whose reason names a DMARC quarantine is shown as **Delivered to
spam** (amber, not green), with a sentence in the opened row saying the guest has most likely not
seen it. Everything else about the row is unchanged: the address is **not** suppressed, because
nothing is wrong with the address.

Nothing extra is recorded to make this work — the receiving server's words were already being stored
against every invite, and were simply not being read. So it applies retroactively to invites already
in the database, and there is no migration and nothing to switch on.

**What to do about it** is a sending-domain job, not a guest-list one. A quarantine means the
recipient's server could not line your message up with your published DMARC policy, so:

- Check that Mailgun's **DKIM** record for your sending domain is published and verified in the
  Mailgun dashboard, and that the domain you send `From:` matches the domain the DKIM key belongs to.
- Check **SPF** includes Mailgun.
- Check your **DMARC** record. `p=quarantine` with an unaligned message is exactly this outcome.
- A **subdomain** (`mg.example.com`) is Mailgun's recommended setup and aligns with a DMARC record on
  the parent by default (`aspf`/`adkim` are relaxed unless you set them strict).

One quarantined row is a curiosity. Several across different recipient domains is a domain
configuration problem, and it will be costing you mail you cannot see.

---

## What the endpoint refuses, and why

Worth understanding before you expose a public URL, because this one writes to your suppression
list and the damaging direction is not "mark it delivered" — it is "mark it **bounced**", which
takes a real guest's address off the mailing list permanently.

- **Every request must carry a valid signature.** Mailgun signs with HMAC-SHA256 over the timestamp
  and token, keyed with your signing key. Snapdini recomputes it and compares in **constant time** —
  a plain string comparison leaks, through how long it takes to fail, how many leading characters of
  a guess were right, which turns forging a signature from impossible into a few thousand tries.
- **Nothing happens before that check passes.** A forged event is refused before a single query
  runs.
- **Old signatures are refused.** A captured request stays perfectly signed forever, so age is the
  only thing that can rule one out. The window is deliberately generous (a day) because Mailgun's
  own retry ladder spans about eight hours and a tight window would reject exactly the retries that
  exist to recover events you missed.
- **A token is only ever processed once.** Mailgun redelivers, so repeats are expected; a repeat is
  acknowledged rather than re-applied. Independently of that, the state machine makes re-applying
  the same event a no-op anyway, so nothing depends on the cache surviving a restart.
- **The signature covers the timestamp and token, not the body.** That is Mailgun's design, not an
  omission here: it proves the *sender*, not the *contents*. HTTPS carries the rest, and every field
  in the payload is read defensively rather than trusted.
- **Out-of-order events cannot undo a bounce.** Webhooks arrive in whatever order they arrive in,
  and applying whichever turned up last would let a stale *delivered* overwrite a bounce — leaving a
  host mailing a dead address and seeing green.

**If the key is missing or wrong, the endpoint fails closed.** It refuses everything — `404` with no
key, `406` with the wrong one — and the app goes on presenting invites as *sent, delivery unknown*.
It never guesses, never marks anything delivered on trust, and never claims to know something it
does not.

---

## Rotating the key

Mailgun lets you roll the signing key. Doing so invalidates in-flight webhooks, so expect a gap:

1. Roll it in the Mailgun dashboard and copy the new value.
2. Update `MAILGUN_WEBHOOK_SIGNING_KEY` in `app/.env` and `docker compose up -d app`.
3. Confirm the boot line, then watch Mailgun's webhook log for `406`s — any that appear are events
   signed with the old key, and Mailgun will stop retrying them after about eight hours.

Events dropped during the gap are lost rather than deferred, so rotate at a quiet moment rather than
straight after a big send.

---

## Where the state ends up

Two tables, and the split matters:

- **`guest_invites`** — one row per message sent, carrying its status, the provider's reason in its
  own words, and the provider's timestamp. Delivery state belongs to the *message*, not the person:
  "Mum bounced" is meaningless without "which one, and when".

  One column here does **not** describe a delivery: `mailed`. It is true for every real send,
  including the failures — a provider refusal is still an attempt at somebody's inbox — and false
  only where the product wrote the record and deliberately sent nothing. Today that is demo events,
  which anyone can mint unauthenticated and whose organizer code is handed out on request: a demo
  shows the invite feature working and mails nobody. **Any count of "how much mail have we sent"
  must filter on it.** `email-budget.ts` does; it is the only global reader of this table.
- **`email_suppressions`** — addresses that must never be mailed again, keyed by the address and
  **deployment-wide** rather than per event. Sending reputation belongs to the domain, so an address
  that is dead at one host's wedding is just as dead at another's birthday. Every outgoing email
  passes through one chokepoint that consults this table, so every sender honours it, including ones
  written later.

A bounce or a complaint recorded here **cannot be undone from the UI**, and that is on purpose: it
is a fact about a mailbox rather than a preference, and nobody holding an invite link should be able
to erase one. If you genuinely need to clear one — the classic case is a mailbox that was full, then
fixed, then mistakenly reported as permanent — it is a deliberate trip to the database:

```sql
DELETE FROM email_suppressions WHERE email = 'someone@example.com';
```

Check *why* it is there before you do (`SELECT reason, detail FROM email_suppressions WHERE …`). An
address suppressed as `complained` should stay suppressed whatever anyone asks for: re-mailing
someone who pressed *report spam* is the single most damaging thing you can do to a sending domain.

---

## See also

- `app/.env.example` — every email-related variable, with the same warnings inline.
- [docs/GUIDE.md](GUIDE.md) → *Guest emails, unsubscribes & suppression* — what guests experience,
  and how unsubscribes differ from bounces.
- [docs/DEVELOPMENT.md](DEVELOPMENT.md) — the dev stack, and the compose-env rule in its general form.
