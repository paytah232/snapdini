CREATE TABLE capture_evidence (
 id text PRIMARY KEY, evidence_id text NOT NULL,
 event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
 participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
 capture_id text NOT NULL, source text NOT NULL CHECK(source IN ('client','server')),
 stage text NOT NULL, at bigint NOT NULL, received_at bigint NOT NULL,
 upload_id text, chunk_index integer, chunk_total integer, bytes bigint,
 http_status integer, reason text, photo_id text
);
CREATE UNIQUE INDEX capture_evidence_dedup_idx ON capture_evidence(participant_id,source,evidence_id);
CREATE INDEX capture_evidence_event_idx ON capture_evidence(event_id,received_at);
CREATE INDEX capture_evidence_retention_idx ON capture_evidence(received_at);
