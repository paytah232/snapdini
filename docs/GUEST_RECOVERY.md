# Guest camera recovery (1.5.10 release candidate)

## Optional for self-hosters

Independent guest hosting is optional. A normal self-hosted Snapdini installation
needs no Cloudflare account, API token, Worker or recovery publisher. Leave these
components disabled to keep the existing guest links and camera behavior.

The guest build, service worker, publisher and edge proxy are included in the
source. Deployment credentials, account configuration and event data belong to
operators and must not be committed or placed in browser assets. The standalone
static artifact can be hosted independently; the supplied edge deployment example
currently targets Cloudflare Workers and the development environment only.

## Development setup

1. Build the browser-only camera with `cd web && npm run build:guest`.
2. Run the development snapshot publisher as described in
   [the publisher instructions](../tools/guest-recovery/README.md). The supplied
   `app/docker-compose.dev.yml` includes it; the default production stack does not.
3. To test independence from the app server, prepare and deploy the allowlisted
   artifact using [the Cloudflare dev instructions](../tools/guest-edge/README.md).
   Supply your own account and a scoped deployment token through the environment.
   This creates a separate development Worker with no production domain routes.
4. Configure the optional [automatic settings publisher](../tools/guest-recovery/README.md)
   and bind its dedicated event Worker as `EVENTS_ASSETS`. Settings changes and withdrawals
   publish independently of camera releases, with complete-source checks, coalescing and retries.
   Camera promotion uses `tools/guest-edge/promote.mjs` after matching origin health checks.
   New events need a successful settings publication before first visits can recover from an outage.

Without independent hosting, the locally served preview still depends on the
Snapdini web server for a first visit. An already cached camera can work offline,
but that does not make a first-time visitor independent of the server.

The development Compose web service also sets `GUEST_RECOVERY_ENV=dev` to
opt normal `/join/CODE` and `/e/slug` pages into the same recovery logic. This
allows a guest to join online, keep the same session through a backend outage,
reload, and upload to the original roll after recovery. The flag is empty or unset in
normal self-hosted and production configurations. This test still relies on the
dev web server to serve the normal page; it does not prove independent hosting
through that domain during a complete site outage.

The independent artifact supports ordinary `/join/CODE` and `/e/slug` links without
redirecting to another origin. Its scoped service workers preserve those navigation shells.
Explicit production artifact preparation includes only `/join/*`, `/e/*`, and `/guest/*`
routes, leaving APIs, uploads and account pages on their existing paths. Browser storage
stays on the normal origin. Production routing is not activated by development setup;
see the [release runbook](RELEASE_1.5.10.md).

## Capture preservation and authority

The guest camera can be built independently of the SvelteKit server with
`cd web && npm run build:guest`. The generated `web/guest-dist` contains only
browser camera code, styles, allowlisted fonts and the icon. It excludes server
routes, organizer pages, environment files and source maps. Camera code remains
shared with the normal application.

Development serves this artifact at `/guest/join/CODE` and `/guest/e/slug`.
Open `/demo?camera=guest` for a new demo using this preview camera.
Existing event links keep their current behavior during this preview. The dev
Compose file also runs a read-only publisher of public event recovery settings;
see `tools/guest-recovery/README.md`. It checks once a minute but rewrites a
snapshot only when camera settings change, with no KV operations.

When the API is unavailable, published settings or a previously cached event
allow the guest interface to open. Returning guests reuse their own cached
session and confirmed allowance. A new guest gets a provisional identity on the
device, which does not grant server access. The camera reserves all unfinished
captures against its local allowance, including failed uploads. Captures enter
IndexedDB before upload, and remain there until the server acknowledges them or
the guest explicitly removes their local copy. A failed storage write/read is
shown visibly; the app cannot promise durability when the browser refuses it.
Recovery notices use the normal message box with a dismiss button. Closing a
notice does not stop retries or remove saved captures; the queue remains available
for inspection and export. Retries do not reopen a dismissed notice.

On recovery, provisional guests pass normal server admission, including current
payment, lock, time and guest-cap rules. A persisted random join nonce makes
concurrent or lost-response admission retries reuse one participant. It is
removed after confirmed admission and durable queue ownership transfer. Uploads
carry stable capture IDs scoped to the authenticated event and participant;
concurrent or lost-response retries count once and return the existing photo.
Legacy clients remain supported. Migration 0074 adds deletion receipts so late retries
acknowledge a deliberately deleted capture without recreating it or consuming another frame.
Upload finalization and guest deletion share the same participant lock. Receipts retain no
photo contents and remain until the participant/event is deleted. Migration 0073 adds the
optional diagnostic evidence journal; neither migration changes existing photo rows.

If admission or upload is refused, captures remain on the device. The queue
provides export, and `/guest/saved/CODE` reads only local IndexedDB for export
without a live event or server session. Saving does not remove the original;
removal requires explicit confirmation. The primary API remains authoritative.
A new guest reconnecting after the event ends may need host/support resolution
or export: this preview does not bypass expired-event admission or restore
revoked access. Browser clocks and multiple tabs/devices are not admission proof.

The guest service worker caches only its own public shell/assets, never APIs,
event snapshots or uploaded media. It does not force a running camera to reload.
A first-time visit still needs internet to obtain the independent shell. Device
queues are not a backup; browser eviction, clearing site data and device failure
can remove them. Physical iPhone/Android acceptance remains necessary.

The isolated Cloudflare dev Worker hosts an independent copy of the guest
artifact and public snapshots on its workers.dev hostname. The optional automatic
publisher deploys allowlisted settings to a separate event Worker, keeping camera releases
independent. It validates a complete source generation before deployment, sends explicit
HTTP 410 withdrawals, and preserves the last good publication on failures. Publication
is asynchronous; new events can work online before their outage settings are published.
See `tools/guest-edge/README.md` for the deployment steps. The existing
failover Worker, its KV budget and checks are unchanged. Production rollout must
configure the trusted publication pipeline and same-release promotion hook, review actual
zone-route overlap, and complete physical acceptance. Publication uses the authenticated
Cloudflare deployment API and the same trusted HTTPS application origin; public write endpoints
and browser deployment credentials are never enabled.

## Physical phone outage test

Use a disposable development event and an independently hosted guest link.
Keep the phone on mobile data so it can reach the independent host while the
Snapdini backend is stopped. Do not stop a production service for this test.

1. Join while the development backend is available. Take one or two photos and
   verify they reach the event before starting the outage.
2. The operator stops only the development API backend. Keep the independent
   host, development database and storage running.
3. Take more photos. Confirm the camera shows one queue reminder, then reload
   and confirm the queued photos remain. Keep within the event's shot allowance.
4. The operator starts the development backend. Keep or reopen the same camera
   on the same browser and device. Confirm automatic uploads empty the queue
   and that every original appears once in the event.
5. Separately test a first-time browser opening the independent link while the
   backend is already down. This proves published settings support a new guest;
   the returning-guest test alone does not prove that behavior.

Repeat on physical iPhone Safari and Android Chrome. Export a saved copy if the
browser reports storage failure. R2 is not part of this preview: captures wait on
the device, and no Cloudflare photo-storage subscription is required.

The optional [capture/upload evidence trail](UPLOAD_EVIDENCE.md) links saved
captures and retries to server storage and phone acknowledgements. It uses the
same capture IDs and retries its metadata after reconnection; it does not grant
admission or upload permission.
