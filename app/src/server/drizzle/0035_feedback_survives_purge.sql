-- Guest feedback is about the PRODUCT, not the event, so it has to outlive the event's media.
-- It previously cascaded off participants, and the retention sweep deletes participants at the
-- end of the retention window — meaning every rating quietly erased itself ~31 days after the
-- party, and the operator would only ever see feedback from events younger than that.
--
-- Detaching instead of deleting is also the more private option: the purge still removes the
-- guest (name, email, photos) exactly as before, and what survives is an anonymous rating and
-- comment that can no longer be traced back to a person.
ALTER TABLE guest_feedback DROP CONSTRAINT IF EXISTS guest_feedback_participant_id_fkey;
ALTER TABLE guest_feedback ALTER COLUMN participant_id DROP NOT NULL;
ALTER TABLE guest_feedback
  ADD CONSTRAINT guest_feedback_participant_id_fkey
  FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE SET NULL;

-- The unique index kept one opinion per guest. NULLs are distinct in a btree unique index, so
-- anonymised rows no longer collide with each other while live guests are still held to one.
