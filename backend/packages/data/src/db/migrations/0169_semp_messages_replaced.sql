-- Issue gh-1930, step 1 of 2: an assistant reply that a regeneration replaced points to its replacement. The replaced
-- reply stays stored with its steps and is only hidden from the model: the events of its turn are left out of the
-- history a later wake rebuilds.
--
-- Additive and rollback-safe: a nullable column that a previous release never reads or writes (every existing row has
-- no replacement), and a composite foreign key that the column's NULLs satisfy. The key is tenant-consistent, like every
-- foreign key between tenant rows (0083): it refuses a replacement of another tenant's message. Deleting a thread
-- removes all its messages in one statement (semp_messages_thread_fkey), so the key does not hold that deletion back.
--
-- The foreign key is added NOT VALID, so adding it scans nothing; 0170 validates it under SHARE UPDATE EXCLUSIVE,
-- which does not block reads or writes, as 0084 does for the keys of 0083. The migration runs in one transaction, so
-- the locks of the statements below are held until it commits; this file therefore holds no scan.
ALTER TABLE semp_messages ADD COLUMN replaced_by_message_id uuid;
ALTER TABLE semp_messages ADD CONSTRAINT semp_messages_replaced_by_fkey
  FOREIGN KEY (tenant_id, replaced_by_message_id) REFERENCES semp_messages (tenant_id, id) NOT VALID;
