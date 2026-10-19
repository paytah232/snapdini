# 1.5.10 release and rollout

## Changes

- Optional independent guest camera hosting for existing event links, with public recovery settings supplied separately from the app server.
- Device queues preserve captures through temporary backend outages and reloads, reconcile guests after recovery, and upload each capture once.
- Dismissible recovery messages and local export when server admission cannot resume.
- Correlated capture/upload diagnostics, including individual chunk rejection reasons, actual stored-photo proof and browser acknowledgement. Client claims remain distinct from server evidence.
- Deletion receipts prevent late upload retries from recreating a deliberately deleted capture.
- Service-worker updates preserve running camera builds and guest caches.

Independent hosting is optional for self-hosters. Normal installations need no Cloudflare account or publisher. Photo buffering remains on the device; no R2 photo storage or billing change is included.

## Rollout order

1. Back up the production database and existing app/web image tags, compose configuration and Worker deployment IDs. Confirm storage and backups are healthy and pick a quiet event window.
2. Build app, web and guest assets from the same 1.5.10 commit. Record the guest `release.json` fingerprint. Publish registry images through the normal release workflow only after acceptance and release authorization.
3. Deploy app/web first, retaining normal guest links. Migrations 0073 (evidence) and 0074 (deletion receipts) are additive. Confirm `/api/config` returns version `1.5.10` and `readOnly:false`.
4. Enable the read-only production settings publisher with its explicitly scoped deployment configuration. Publish and verify the independent settings Worker before binding or routing the camera to it. Keep the existing failover Worker and its cadence unchanged.
5. Prepare the guest artifact with `tools/guest-edge/promote.mjs`, explicit lane/account/origin/events Worker and `EXPECTED_VERSION=1.5.10`. Preparation verifies the live origin and built guest version. Without `--deploy`, this creates a reviewable artifact only.
6. Review the three narrow routes (`/join/*`, `/e/*`, `/guest/*`). Account pages, APIs and uploads retain their existing routing and authentication. Ensure these paths do not overlap an existing Worker route; compose routing rather than replacing the failover Worker. Deploy only after this account-specific review.
7. Verify normal QR links, settings freshness, session continuity, first visits during an outage, queued reload/recovery and exact photo counts. Observe diagnostics and errors before declaring completion.

Development tests do not activate normal-domain production routes; independent hosting requires explicit operator deployment. A Workers Scripts Edit credential alone may not authorize zone-route changes; use a separately scoped deployment credential when activating routes. Keep credentials outside browser assets and Git.

## Development validation

- 1,338 backend unit tests; 1,616 web unit tests; 1,037 real PostgreSQL/S3 integration checks.
- 40 isolated service-worker, edge and publication checks; clean typechecks (27 existing Svelte warnings).
- Browser coverage includes chunk rejection/retry, lost acknowledgement, fresh/returning outage guests,
  same-origin ordinary links, fully offline reload, queued originals across a waiting update and natural activation.
- Disposable database rehearsal upgrades the pre-1.5.10 schema through both new migrations and repeats boot safely.
- App/web candidate images built and exercised; running-image camera promotion verified on development and production.

Mobile-data outage acceptance on the normal production event link confirmed a newly joined guest,
two exactly-once stored captures and matching browser acknowledgements after recovery. Follow-up
join/gallery message fixes passed the browser recovery suite. Normal event-code, custom-slug and
guest-alias links were then checked with the API unavailable, and published settings verified.
The operator must still assess physical Safari/Chrome camera, storage and download behavior for
the devices they support; the completed phone exercise does not establish every device/browser pair.

## Acceptance

Automated coverage must include single/chunk retries, deletion races, authorization, settings update/deletion propagation, publisher retry/backoff, service-worker cache isolation, and fresh/returning guest outage/recovery. The development preview should use ordinary `/join/CODE` and `/e/slug` paths, without redirects to another hostname.

On physical iPhone Safari and Android Chrome, use disposable dev events over mobile data:

1. Join online and upload a photo; record the guest identity and count.
2. Stop the dev backend. Capture more, reload, and check the same queue and allowance.
3. Open the event in a fresh browser while the backend is still down; published settings must allow local preservation.
4. Restore the backend. Confirm one admitted identity per guest, every photo exactly once, and empty upload/evidence queues.
5. With photos still queued, publish a camera update. The open camera must remain usable; reload/reopen and verify the originals survive and later upload once.
6. Verify camera permission prompts, dismissal of notices, local export and video if enabled for the event.

Browser automation does not substitute for phone camera, iOS storage and download behavior. Record device/browser versions and outcomes.

## Rollback

- Preserve queued originals and the evidence/deletion tables. Do not reverse migrations or prune deletion receipts while their event/participant exists.
- For an edge-only problem, restore the previous compatible guest Worker deployment and settings binding. Keep last good independent settings available. Avoid switching hostname: browser queues are scoped to their original origin.
- Rolling back the app to 1.5.9 also removes capture retry idempotency. Coordinate app and guest rollback; do not let a recovery camera blindly replay queues against an incompatible backend. Prefer correcting forward or keeping captures locally/exportable until a compatible server is restored.
- Restore only the guest-specific routes if necessary, without changing existing API/media failover or account routing. A route rollback alone cannot provide the same outage guarantees.
- After any rollback, verify production health, guest identity, queued originals and event counts before resuming promotion.
