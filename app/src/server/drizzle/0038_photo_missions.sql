-- Photo missions: a shot list the host picks, the guests tick off, and the gallery is annotated by.
--
-- Three additions, all nullable, so every existing event keeps working untouched with the feature
-- simply absent.

-- What KIND of event this is, chosen in the event's theming. Drives which mission pack the host is
-- offered, and is worth having on its own: until now nothing recorded whether a given event was a
-- wedding or a work party, so none of the analytics could tell them apart. NULL = the host never
-- said, which is treated as the general pack rather than as an error.
ALTER TABLE events ADD COLUMN IF NOT EXISTS event_type text;

-- The missions this host chose, as a JSON array of {id, text}. Stored as the host's own words
-- rather than as ids alone, deliberately: a host can write their own, and a shipped one whose
-- wording we later improve must NOT silently change on a printed card someone is holding.
ALTER TABLE events ADD COLUMN IF NOT EXISTS challenges text;

-- Which mission a photo satisfied. The guest picks a mission and then shoots, so this is known at
-- upload time. It is also what makes progress derivable instead of tracked: "how far is this guest
-- through their list" is a count over photos, so deleting a photo un-completes its mission with no
-- second copy of the truth to drift.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS challenge_id text;

-- Progress is read per guest on every mission-screen load, so it needs to be cheap. Partial: only
-- a small fraction of photos will ever carry a mission.
CREATE INDEX IF NOT EXISTS idx_photos_challenge
  ON photos (event_id, participant_id, challenge_id) WHERE challenge_id IS NOT NULL;

-- For ranking which missions hosts actually pick and guests actually complete, per event type.
-- No separate counter table: both questions are queries over the two columns above, which means
-- the ranking has retrospective data from the day it is switched on rather than starting at zero.
CREATE INDEX IF NOT EXISTS idx_events_type
  ON events (event_type) WHERE event_type IS NOT NULL;
