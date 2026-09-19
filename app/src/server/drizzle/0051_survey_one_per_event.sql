-- "One response per event" becomes a rule the database keeps.
--
-- routes/survey.ts read survey_responses for the event, returned early if it found a row, and
-- otherwise inserted. The index behind that read (idx_survey_event) was NOT unique, so the check
-- and the write were two statements with a gap between them. The survey token lives in an emailed
-- link, never expires and is replayable, and a low score fires an instant operator notification —
-- so concurrent POSTs all passed the SELECT, all inserted, and all notified. The cost was
-- duplicate rows and an ops notification storm from one link.
--
-- Replacing the same index NAME rather than adding a second one: a unique index on (event_id)
-- serves the existing read (every survey for an event) exactly as well as the non-unique one did,
-- so keeping both would be two indexes for one query.

-- Deduplicate FIRST. A unique index cannot be built over existing duplicates, and a migration that
-- fails halfway on somebody's data is worse than one that decides what to keep and says so.
-- Production held 0 survey rows when this was written, but a self-hoster who has been running the
-- survey for months may well have some.
--
-- Which row survives, in order:
--   1. a PUBLISHED one. published_at is set when an operator quotes a testimonial on the site;
--      deleting that breaks a live page and throws away consent we recorded.
--   2. the EARLIEST otherwise, which is the row the route's own check would have preserved: the
--      first answer wins and every later submission is told "your answer is in".
WITH ranked AS (
  SELECT id, row_number() OVER (
    PARTITION BY event_id
    ORDER BY (published_at IS NULL), created_at, id
  ) AS rn
  FROM survey_responses
)
DELETE FROM survey_responses WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

DROP INDEX IF EXISTS idx_survey_event;
CREATE UNIQUE INDEX IF NOT EXISTS idx_survey_event ON survey_responses (event_id);
