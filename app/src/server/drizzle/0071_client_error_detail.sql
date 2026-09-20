-- Enough of a client error to act on it, and a key that says which reports are the SAME error.
--
-- WHAT THIS TABLE LOOKED LIKE WITH FIFTY ROWS IN IT. Eleven distinct problems, fifty rows, sorted
-- newest-first with no grouping: twelve consecutive lines of one camera permission failure, then
-- eight of another, and the six upload failures that actually cost somebody their photos sitting
-- below the fold. The screen stopped being read, which is the only failure mode a diagnostic
-- queue really has. Grouping is therefore the point of this migration; the extra detail columns
-- are what makes an opened group worth opening.
--
-- Every column here is NULLABLE and none is backfilled except `fingerprint`. A report from a
-- client too old to send a stack has not got an empty stack, it has no stack, and a reader must be
-- able to tell those apart — same rule as photos.captured_at (0070).

-- THE GROUPING KEY. Computed by the server at insert (fingerprintOf() in routes/clienterror.ts)
-- from the context and a normalised copy of the message, NOT from the stack: a minified stack
-- changes frame names on every build, so stack-keyed groups would split in half at each deploy —
-- which destroys the one question the operator is asking, "is this still happening since we
-- shipped the fix?".
--
-- WHY A STORED COLUMN RATHER THAN GROUPING BY (context, message) AT QUERY TIME. Three reasons, in
-- order of how much they mattered:
--   1. The rule for "the same error" is not equality. `camera: lens unavailable (ultrawide: ...)`
--      and the same line with a different lens are one defect; a message carrying a request id or
--      a byte count is one defect wearing fifty faces. Normalisation belongs in TypeScript where
--      it has unit tests against the real production strings, not in a regexp_replace nobody can
--      run in isolation.
--   2. It is stable. Sharpening the rule later re-groups NEW reports and leaves history where the
--      operator last saw it, rather than silently reshuffling every group in the archive on
--      deploy. Re-grouping history becomes a deliberate migration, which is what it should be.
--   3. `message` is display text and may yet be truncated harder or redacted; a key derived from
--      it at query time would change underfoot when that happened.
ALTER TABLE client_errors ADD COLUMN IF NOT EXISTS fingerprint text;

-- WHERE IT BROKE. The single most-missed field: production holds a row reading
-- `camera: TypeError Type error` with nothing else against it — a bug report with the bug removed.
-- Truncated hard on the way in (see the reporter): a stack is its top few frames or it is noise,
-- and the rest is bytes we would be keeping about somebody's browsing for nobody to read.
ALTER TABLE client_errors ADD COLUMN IF NOT EXISTS stack text;

-- WHICH GUEST. Six "Event has ended" upload failures arrived from one event and there was no way
-- to tell whether that was one phone retrying or six people losing their photos, so nobody could
-- be told and nothing could be put right.
--
-- THE ID ONLY, AND DELIBERATELY NOT THE NAME OR THE EMAIL. The admin view LEFT JOINs participants
-- for a display name, which means deleting a guest -- retention purge, or a request to be erased
-- -- takes their name off this screen too, with no second copy left behind to find. It also means
-- the client never sends an identity at all: it sends the session token it already carries on
-- every other API call, in the header, and the server exchanges it for this id. A bearer
-- credential must not come to rest in a diagnostic log that a human reads.
--
-- NO FOREIGN KEY, the same call as admin_actions.event_id in 0068: an error report has to outlive
-- the thing it is about. A cascade would delete the evidence at the moment the event was purged,
-- and SET NULL throws away the only handle that ties six reports to six different people.
ALTER TABLE client_errors ADD COLUMN IF NOT EXISTS participant_id text;

-- WHICH BUILD WAS LIVE, AND WHICH BUILD THE PHONE WAS RUNNING. Two columns, because they answer
-- two different questions and production will disagree about them.
--   app_version   the server's own package version, stamped server-side. "What was deployed when
--                 this happened" -- the one that answers "did the fix take?".
--   client_build  the SvelteKit build id of the bundle in the guest's tab, sent by the reporter.
-- An installed PWA can sit on a cached bundle for days, so a report can arrive from code we
-- stopped shipping a week ago. When these two disagree that is itself the finding, and a single
-- column would have had to choose which of the two to lie about.
ALTER TABLE client_errors ADD COLUMN IF NOT EXISTS app_version text;
ALTER TABLE client_errors ADD COLUMN IF NOT EXISTS client_build text;

-- THE DEVICE, in the three axes that have actually explained a Snapdini bug:
--   display_mode  'standalone' (installed to the home screen) or 'browser'. The installed app has
--                 no URL bar, a different viewport and its own service-worker cache; several
--                 camera and layout faults exist in exactly one of the two.
--   viewport      CSS pixels, "390x844". The camera UI is laid out against it.
--   connection    navigator.connection.effectiveType -- '4g', '3g', 'slow-2g'. The coarse bucket
--                 and nothing else. Deliberately not downlink/rtt: those are continuous values
--                 that make a device more identifiable, and neither would have changed a decision
--                 anyone has had to make here. effectiveType alone settles the standing question
--                 about the upload failures -- were those phones on a usable connection or not.
-- What is NOT here, on purpose: IP address (never stored, and the reverse proxy makes it cheap to
-- start), geolocation, device memory, CPU count, battery, and anything at all from the content of
-- the page the guest was looking at.
ALTER TABLE client_errors ADD COLUMN IF NOT EXISTS display_mode text;
ALTER TABLE client_errors ADD COLUMN IF NOT EXISTS viewport text;
ALTER TABLE client_errors ADD COLUMN IF NOT EXISTS connection text;

-- WHAT IT COST THE GUEST. An upload that failed and then succeeded on retry and an upload that
-- lost the photo are the same row today, and they are not remotely the same incident. Free text
-- from the call site ('recovered', 'lost', 'retrying', 'gave-up'); NULL means nobody said, which is every
-- report written before a call site is taught to say it, and must never read as "fine".
ALTER TABLE client_errors ADD COLUMN IF NOT EXISTS outcome text;

-- Backfill the key for the rows already here, so the archive groups alongside everything new
-- instead of arriving as fifty groups of one.
--
-- THIS EXPRESSION IS A COPY OF fingerprintOf(), AND IS ALLOWED TO BE, BECAUSE IT RUNS ONCE. It is
-- not a second implementation to keep in step: after this statement the server writes the column
-- on every insert and nothing reads this SQL again. If the two disagree about some legacy row the
-- worst that happens is that one old report groups on its own, which is where it was already.
UPDATE client_errors SET fingerprint =
  COALESCE(context, '-') || '|' || left(
    regexp_replace(
      regexp_replace(
        regexp_replace(btrim(message), '\s+', ' ', 'g'),
        '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}', '#', 'g'),
      '[0-9]{3,}', '#', 'g'),
    120)
WHERE fingerprint IS NULL;

-- Serves the one write here that is not an insert: marking a whole group handled is
-- `UPDATE ... WHERE fingerprint = ?`. The grouped read is a full aggregate and will seq-scan
-- whatever the planner decides, which is the right answer for a table holding tens of rows
-- between retention purges; an index bought for it would be maintenance in exchange for nothing.
CREATE INDEX IF NOT EXISTS client_errors_fingerprint_idx ON client_errors (fingerprint);
