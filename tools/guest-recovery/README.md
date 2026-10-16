# Development recovery snapshots

This publisher is a development-only, read-only bridge from the primary event settings
to public guest-camera recovery JSON. It neither admits guests nor authorizes uploads.
Snapdini remains authoritative when a guest reconnects. It does not use Cloudflare APIs,
KV, billing or the existing failover Worker.

Run from the repository root with Node 22 and the existing `app/node_modules` installed:

```sh
GUEST_RECOVERY_ENV=dev \
DATABASE_URL='<development database connection URL>' \
INTERNAL_API_BASE='http://localhost:3001' \
OUTPUT_DIR='<dedicated development recovery directory>' \
node tools/guest-recovery/publish.mjs --once
```

Supply database credentials through the runtime environment; never commit them. The
database connection sets `default_transaction_read_only=on`. All three destination/source
variables are required, with no production defaults. `GUEST_RECOVERY_ENV=dev` is required
and known production API hosts are rejected. The operator must still supply the correct
development database; these checks cannot identify an arbitrary database URL as production.

Without `--once`, successful or failed passes repeat every 60 seconds, with a 15-second
timeout per API request. SIGTERM/SIGINT stop the publisher. A one-shot pass exits nonzero
if publication fails. Use only one publisher process per output directory.

Serve the dedicated output directory at `/guest/events/` with directory listing disabled,
short cache lifetimes and no immutable caching. Files are keyed by uppercase join code
and optional lowercase slug. There is deliberately no public event index. The response is:

```json
{"schema":1,"publishedAt":1700000000000,"event":{"id":"public-event-id","joinCode":"EXAMPLE1"}}
```

The actual event has allowlisted public camera settings, including its title, schedule,
photo limit, frame ratios, video duration, flash and lock settings. Secret codes, identities,
emails, host permissions, guest lists and nested unknown theme fields are omitted. Demo
organizer codes are omitted too. Counts and flags derived from the current time are omitted;
the camera uses the schedule and its own queue rather than treating stale counts as admission
authority. Consumers must derive `isUpcoming`/`isExpired` themselves and obtain gallery/reveal
state from the normal API. Settings payloads are rendered as data, never trusted HTML.

Only changes in the allowlisted settings replace JSON, using a temporary file plus atomic
rename. Count changes do not update `publishedAt`: it records settings publication time,
not a heartbeat or a fresh confirmation that the primary is online. The files are unsigned
in this development prototype; they must be served over the trusted application origin.

Unpurged events whose retention deadline has not passed are eligible. The query uses
`purge_at`, falling back to `expires_at + retention_days` for older rows. Locked events
publish `isLocked: true`; removed, purged and retention-ended events have their files removed
on the next successful pass, as do old slugs. HTTP 404/410 also removes existing files.
A database outage preserves the last good publication, and a transient event API error
preserves that event's files. Guests cannot learn subsequent changes during a real outage;
the client must enforce the published end time and reconcile with the primary afterward.

Check the publisher without databases, network access or application restarts:

```sh
node --test tools/guest-recovery/publish.test.mjs
```

No Cloudflare publishing, account changes or production deployment is included here.
