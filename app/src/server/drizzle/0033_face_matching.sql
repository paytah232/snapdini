-- "Find the photos I'm in" — enrolment-based, opt-in, per event.
--
-- The design point: the ONLY face template stored is the one belonging to the guest who chose to
-- enrol. Every other face in every gallery photo is embedded transiently, compared, and discarded
-- inside the request. What persists for those people is a LINK (photo -> participant), which is
-- personal information but not a biometric template.
--
-- Be honest about what this does and does not achieve: it removes retention and breach exposure for
-- non-enrolled guests. It does NOT make their momentary processing disappear — collection happens
-- when a face is analysed, not when it is saved. That is why the feature is off by default and
-- gated behind explicit consent.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS face_matching_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE participants
  -- Unit-normalised 512-float vector as JSON. Sensitive information: never returned by any API.
  ADD COLUMN IF NOT EXISTS face_embedding  text,
  -- When they consented. Null means no enrolment, and the absence of a template is the enforcement.
  ADD COLUMN IF NOT EXISTS face_consent_at bigint;

-- The durable output: which enrolled guest appears in which photo. Not a biometric template.
CREATE TABLE IF NOT EXISTS photo_faces (
  photo_id       text NOT NULL REFERENCES photos(id)       ON DELETE CASCADE,
  participant_id text NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  score          real NOT NULL,
  created_at     bigint NOT NULL,
  PRIMARY KEY (photo_id, participant_id)
);

CREATE INDEX IF NOT EXISTS idx_photo_faces_participant ON photo_faces (participant_id);
