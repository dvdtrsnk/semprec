-- Issue gh-1930, step 2 of 2: validate the foreign key that 0169 added NOT VALID. VALIDATE CONSTRAINT scans
-- semp_messages under SHARE UPDATE EXCLUSIVE, which does not block reads or writes.
ALTER TABLE semp_messages VALIDATE CONSTRAINT semp_messages_replaced_by_fkey;
