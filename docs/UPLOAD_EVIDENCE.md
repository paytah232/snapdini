# Capture and upload evidence

This feature records a small diagnostic trail for newly captured media. A stable
browser capture ID connects a saved capture, upload attempts and chunks, the
committed server photo, and the phone's acknowledgement. It does not change shot
allowances, admission rules, media retention, or guest-facing upload warnings.

## What is recorded

The browser journals `local_saved`, `upload_started`, `upload_failed`,
`server_acknowledged`, and explicit `local_removed` events. Upload failures carry
bounded reason codes and HTTP status, plus upload ID and chunk index where known.
The acknowledgement is persisted before the local blob is deleted. If a response
or acknowledgement delivery is lost, retries keep their evidence IDs so the
server can deduplicate them.

A separate IndexedDB database, `snapdini-capture-evidence` version 1, holds the
journal. The existing photo queue remains at version 2, preserving compatibility
with camera tabs already using it. Blob saving precedes its best-effort journal
entry; restoring a queued blob can reconstruct a missing saved entry. Pending
evidence is retried on reconnect, foreground, camera opening and periodic retry,
even after the photo queue has emptied. Provisional guests' evidence is remapped
only after normal admission and durable capture ownership reconciliation.

The server records its own upload observations separately: received requests,
accepted or rejected chunks, upload rejections, committed photos, and receipt
replays. Rejected chunks include the actual validation reason, such as
`invalid_chunk_index` or `unexpected_file`. Correlation headers cover cases where
multipart parsing fails before the body fields are available. Parsed request
fields take precedence when the upload handler has them.

Only bounded metadata is retained: opaque IDs, stage, times, byte counts, HTTP
status and reason codes. Session tokens are used for authentication and local
ownership; they are excluded from the event JSON and server evidence table.

## Reading a trail

An authenticated site admin can request:

```text
GET /api/admin/upload-evidence?eventCode=EVENTCODE&limit=2000
```

Use the normal application origin and an authenticated admin session; the
independent guest host does not forward organizer/account cookies.

The result groups stages by participant and capture ID. It includes current
`storedPhotoIds`, a `clientAcknowledged` flag, `clientClaimsAreUnverified`,
`retentionDays`, and `truncated`. `limit` is bounded to 1–5000 records. A truncated
result must not be treated as a complete event audit.

- A rejected chunk followed by a committed photo and acknowledgement describes a
  recovered upload; it does not count as a missing photo.
- A locally saved capture with attempts and no committed photo needs attention.
- A committed photo without client acknowledgement may mean the phone missed the
  response or has not yet delivered its journal.
- Client reports remain claims. The diagnostic endpoint derives the expected
  photo ID and checks actual event/participant-owned database rows to establish
  current storage, including when an asynchronous server journal write failed.
- Deliberately deleted photos no longer appear as currently stored. Earlier server
  observations remain in the timeline until evidence retention expires.

## Access, bounds and retention

`POST /api/photos/evidence` accepts at most 50 events per authenticated guest
batch. Event and participant scope come from the guest's valid session, and the
client cannot submit server-observation stages. A separate per-guest request
budget avoids treating an entire venue's shared public IP as one guest. Existing
API protection still applies. Retries of accepted evidence remain deduplicated.

Server evidence expires after 30 days and cascades when its event or participant
is deleted. Pending local evidence stays until accepted; each flush limits its
batch size and request count. The server has a bounded per-roll client journal.
Diagnostic writes for upload responses are best effort and do not change media
responses or block successful uploads. Browser receipt persistence protects the
local original until that acknowledgement is durable; an idempotent upload retry
can repeat safely if cleanup was interrupted.

## Scope and verification

This is development work for the next release, 1.5.10. It cannot reconstruct
upload attempts from older clients that did not send correlated IDs. Requests
that never reach the server or end without a JSON response can have only the
browser's side of the trail. Browser storage failures are still reported visibly.
Evidence delivery resumes when the guest returns with working connectivity.

The tests cover journal persistence, lost response retries, provisional ownership,
separate guest budgets, malformed chunks and multipart parsing, receipt replay,
admin access, current-photo verification, retention, and event cleanup. The real
browser test deliberately causes a chunk rejection, retries successfully, loses
an evidence acknowledgement, and checks that the same capture has one stored
photo and one deduplicated client acknowledgement.
