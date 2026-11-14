-- Issue gh-1926: a failed or incomplete Semp reply can be tried again. The new assistant message answers the same
-- user message (`reply_to_message_id`) as the reply it retries and has the next `attempt`; the failed message stays
-- stored with its own steps.
--
-- Additive and rollback-safe: a column with a constant default (every existing row is attempt 1, and a previous
-- release keeps inserting it without naming the column) and one partial unique index. An assistant message that
-- answers a message has exactly one per (tenant_id, reply_to_message_id) at attempt 1, and the reply of a heartbeat
-- run has a NULL reply_to_message_id, which a unique index treats as distinct, so no existing row can break the index.
--
-- The index is what stops two concurrent retries of one reply from both succeeding: the retry takes the thread's
-- row lock first, and the second retry would insert the same (reply, attempt) pair if that lock were ever skipped.
-- It leads with `tenant_id`, as every unique index of a tenant table does. No INSERT INTO semp_messages has an
-- ON CONFLICT clause, so no arbiter changes. CREATE INDEX takes a SHARE lock on semp_messages while it builds
-- (a migration runs in one transaction, so CONCURRENTLY is not available), which holds back writes to the table
-- for that time.
ALTER TABLE semp_messages ADD COLUMN attempt integer NOT NULL DEFAULT 1;
CREATE UNIQUE INDEX semp_messages_reply_attempt_uq
  ON semp_messages (tenant_id, reply_to_message_id, attempt) WHERE role = 'assistant';
