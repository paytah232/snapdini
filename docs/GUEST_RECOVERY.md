# Guest camera recovery (development preview)

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
