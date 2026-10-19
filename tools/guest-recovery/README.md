# Recovery snapshots and optional Cloudflare publication

This publisher is an optional, read-only bridge from the primary event settings
to public guest-camera recovery JSON. It neither admits guests nor authorizes uploads.
Snapdini remains authoritative when a guest reconnects. Local publication needs no Cloudflare account. The optional independent-hosting publisher below
uses authenticated Cloudflare deployment APIs; neither mode uses KV, R2, billing APIs or the
existing failover Worker. Ordinary self-hosting continues to work without either publisher.

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
variables are required, with no production defaults. An explicit `GUEST_RECOVERY_ENV=dev` or `production` is required; there is no default lane.
The dev lane rejects known production API hosts. The operator must still supply the correct
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
not a heartbeat or a fresh confirmation that the primary is online. The files are public metadata, served through a trusted application origin over HTTPS.
Deployment authentication, rather than a browser-held secret, controls who may publish them.

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

## Optional independent event hosting

Camera releases and event settings have independent deployment lifecycles. Configure a dedicated
Workers Static Assets service for event JSON, named `snapdini-guest-events-dev` in dev (`snapdini-guest-events` in production), and bind it to
the camera Worker as `EVENTS_ASSETS`. The camera Worker delegates `/guest/events/*` to this service.
The dedicated service has no public `workers.dev` address, preview URLs, scheduled triggers or
custom-domain routes. It serves public settings only and has no authenticated guest-write API.
The existing failover Worker is not involved.

`edge-publish.mjs` builds a complete allowlisted metadata artifact and deploys it using pinned
**Wrangler 4.151.1**, installed separately. It re-applies the public allowlist at the upload boundary.
It sends the Cloudflare API token only in the child process environment, never in an argument,
public asset, settings response or log. The token must be in a regular file with mode `0600` or
stricter. It needs account-scoped **Workers Scripts: Edit**, not KV permissions. Keep the API token,
state directory, cached Wrangler installation and process environment private. A dedicated
publishing token limits accidental credential reuse, although Cloudflare's account-level permission
can edit other Workers in that account too.

Required runtime variables, supplied privately rather than committed:

```sh
GUEST_RECOVERY_ENV=dev
OUTPUT_DIR=/runtime/public-event-snapshots
GUEST_EDGE_WORKER_NAME=snapdini-guest-events-dev
CLOUDFLARE_ACCOUNT_ID=<explicit-account-id>
GUEST_EDGE_STATE_DIR=/runtime/private-edge-state
GUEST_EDGE_TOKEN_FILE=/run/secrets/cloudflare-api-token
GUEST_EDGE_WRANGLER_PACKAGE=/runtime/node_modules/wrangler
```

Use absolute paths. The private state and token must be outside public snapshot/artifact trees.
The lane-to-name mapping is exact: `dev` uses `snapdini-guest-events-dev`, and `production`
uses `snapdini-guest-events`. Witness/failover services cannot be publication targets. Production requires the explicit
`production` lane and its own separate name, source directory, credentials and state. These guards
cannot identify an incorrectly supplied account or database; deployment owners must scope them.
No production hosting or route change happens merely by shipping these optional scripts.

Preview the complete artifact without network writes or token reads:

```sh
node tools/guest-recovery/edge-publish.mjs --prepare-only
```

Publish once with the same environment:

```sh
node tools/guest-recovery/edge-publish.mjs --once
```

Run this command every minute from a trusted host scheduler, or set `GUEST_EDGE_PUBLISH=1` on the
existing local publisher to invoke it after each successful source pass. Choose one mechanism.
Use one publisher process per target/state directory. On Linux, protect the scheduler with an
OS lock, for example `flock -n /runtime/private-edge-state/scheduler.lock node ... --once`.
Create the private state directory before scheduling. An internal process lock also prevents
ordinary overlapping passes; a dead-owner lock is recovered after a process/container restart.
A malformed lock/state is preserved for operator inspection rather than treated as an empty list.

Only changed allowlisted content deploys; guest/photo counts do not trigger uploads. Defaults:

- At least 60 seconds between attempts (`GUEST_EDGE_MIN_INTERVAL_SECONDS`, 60–3600).
- At most 96 deployment attempts per UTC day (`GUEST_EDGE_MAX_DAILY_ATTEMPTS`, 1–500).
- Exponential retry backoff after errors, capped at one hour.
- At most 18,000 JSON identifiers/tombstones and 16 MiB of metadata per deployment.

Attempts are durably counted before network access, including failures. Repeated changes coalesce;
unchanged passes do not consume deployment attempts. When a budget is exhausted, the last confirmed
publication remains served and pending changes wait. Monitor `daily-budget`, `coalesced`, `locked`
and publication failures: normal updates usually arrive within a local poll plus a deployment, but
this is not an immediate revocation service. Snapdini's live API always remains authoritative.

Cloudflare atomically attaches the new complete asset manifest to a deployment; only changed
assets need upload. App/camera code is never rebuilt or uploaded by this publisher. Its private
state tracks the confirmed revision and known identifiers. `/guest/publication.json` exposes only
a schema version, SHA-256 content revision and publication time, with no event index. Deployment
success advances the confirmed revision; failure preserves it. A lost deployment response may
produce a harmless repeat deployment on retry.

Removed events, retention purges and old slugs become small withdrawal records. The event Worker
returns **HTTP 410**, so a guest cannot use a cached settings fallback for an explicitly withdrawn
identifier. Unknown identifiers return 404 to tolerate publication lag. Withdrawal records contain
no title, event settings or personal information. They persist for at least 30 days and until one
day after the previously published end time; a recreated identifier replaces its withdrawal record.
Keep a backup of the private publication state: losing it loses knowledge of past aliases needed
for tombstones. The local publisher writes `.publication-complete.json`, containing only a completion flag,
file count and content hash. It invalidates this receipt before each source pass and marks it
complete only after every source fetch succeeds. The receipt is readable by the host scheduler
but is never copied into the public deployment. The edge collector verifies its hash and reads
it again after collecting files; incomplete, missing or concurrently changed generations cannot
deploy. Source read failures preserve the existing publication instead of publishing an empty set. No system can learn new locks/deletions while its authoritative source is unavailable.

Static asset storage has no extra charge. Requests invoking Worker code, including snapshot
handling, use the account's Workers request allowance; this does not add KV or R2 usage. The
publisher does not enable paid plans, and the existing failover polling remains unchanged.
See [Cloudflare static asset billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)
and [direct asset uploads](https://developers.cloudflare.com/workers/static-assets/direct-upload/).

Run publisher and event-service tests without credentials or external calls:

```sh
node --test tools/guest-recovery/publish.test.mjs tools/guest-recovery/edge-publish.test.mjs
```
