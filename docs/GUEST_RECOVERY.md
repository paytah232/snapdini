# Guest camera recovery (development preview)

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
4. Regenerate and redeploy after camera changes or relevant event-setting changes.
   New events need their snapshots published to the independent host before a
   first-time guest can open them during a backend outage.

Without independent hosting, the locally served preview still depends on the
Snapdini web server for a first visit. An already cached camera can work offline,
but that does not make a first-time visitor independent of the server.

Normal QR links are not automatically redirected by this preview. A production
integration would serve the camera under the existing guest URLs at the edge,
use the live Snapdini API whenever available, and fall back to published settings
when it is unavailable. Keep browser storage on the same origin so queues remain
accessible. This production integration is not enabled by these dev instructions.

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

On recovery, provisional guests pass normal server admission, including current
payment, lock, time and guest-cap rules. A persisted random join nonce makes
concurrent or lost-response admission retries reuse one participant. It is
removed after confirmed admission and durable queue ownership transfer. Uploads
carry stable capture IDs scoped to the authenticated event and participant;
concurrent or lost-response retries count once and return the existing photo.
No schema migration is required; legacy clients remain supported. Replay receipts
currently use the photo row: deleting that row removes its receipt. Before production,
add a deletion receipt or equivalent coordination so an in-flight retry cannot
recreate a deliberately deleted photo.

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
artifact and public snapshots on its workers.dev hostname. Event snapshots
currently require regenerating and redeploying the package after settings change;
new dev events will work online before their outage snapshots are published.
See `tools/guest-edge/README.md` for the deployment steps. The existing
failover Worker, its KV budget and checks are unchanged. Production rollout must
include trusted snapshot publication, same-release asset promotion after origin
health checks, and outage tests from an independent origin. Production must not
activate an unverified or unsigned recovery publication policy by accident.

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
