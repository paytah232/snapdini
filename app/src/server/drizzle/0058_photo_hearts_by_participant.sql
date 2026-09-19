-- "Which of this event's photos have I hearted?" had no index path.
--
-- 0057 indexed (photo_id) and (photo_id, participant_id). Both answer "who hearted THIS photo".
-- Neither answers the other direction — a guest opening a 14,000-photo gallery asks for their own
-- hearts across the whole event at once, and on the composite index that is a scan, because
-- participant_id is the trailing column and the query does not constrain the leading one.
--
-- At a 400-guest event this is the difference between a keyed lookup of the few dozen rows that are
-- actually yours and reading every heart in the event to find them.
CREATE INDEX IF NOT EXISTS photo_hearts_participant_idx ON photo_hearts (participant_id);
