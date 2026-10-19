CREATE TABLE capture_upload_tombstones (
 photo_id text PRIMARY KEY,
 event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
 deleted_at bigint NOT NULL
);
CREATE INDEX capture_upload_tombstones_event_idx ON capture_upload_tombstones(event_id);
CREATE INDEX capture_upload_tombstones_participant_idx ON capture_upload_tombstones(participant_id);
