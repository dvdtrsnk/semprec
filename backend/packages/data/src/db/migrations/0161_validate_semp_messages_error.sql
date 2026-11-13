-- Issue #1907, step 2 of 2: validate the constraints that 0160 added NOT VALID. VALIDATE CONSTRAINT scans
-- semp_messages under SHARE UPDATE EXCLUSIVE, which does not block reads or writes.
ALTER TABLE semp_messages VALIDATE CONSTRAINT semp_messages_error_code_check;
ALTER TABLE semp_messages VALIDATE CONSTRAINT semp_messages_error_params_check;
