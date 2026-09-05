-- Guest feedback: how it felt to USE the thing, from the people who actually used it.
--
-- Deliberately separate from survey_responses (the host's post-event survey) and from
-- contact_messages (support). A guest is a different respondent with a different question: not "was
-- it worth the money" but "was it any good to hold". Keyed to the participant so we ask once and
-- never nag, and it dies with the event like everything else about that guest.
CREATE TABLE IF NOT EXISTS guest_feedback (
  id             text    NOT NULL PRIMARY KEY,
  event_id       text    NOT NULL REFERENCES events(id)       ON DELETE CASCADE,
  participant_id text    NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
  rating         smallint,
  comment        text,
  created_at     bigint  NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_guest_feedback_participant ON guest_feedback (participant_id);
CREATE INDEX IF NOT EXISTS idx_guest_feedback_created ON guest_feedback (created_at);

-- Asked once. Set whether they answer or dismiss, so a guest is never prompted twice.
ALTER TABLE participants ADD COLUMN IF NOT EXISTS feedback_asked_at bigint;
