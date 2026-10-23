-- Issue #784: 0031's own header comment documents that deleting a session "orphans" a
-- push_subscriptions row rather than cascading its deletion, but the column was declared with no
-- `ON DELETE` clause (implicit `NO ACTION`), so deleting a referenced session actually failed
-- with a foreign-key violation instead. Same drop/recreate pattern as migration 0035's
-- notifications_kind_check: the constraint is replaced with one that matches the documented
-- behavior.
ALTER TABLE push_subscriptions DROP CONSTRAINT push_subscriptions_session_id_fkey;
ALTER TABLE push_subscriptions
  ADD CONSTRAINT push_subscriptions_session_id_fkey
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL;
