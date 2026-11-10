-- Additive: existing messages have no classified error.
ALTER TABLE semp_messages ADD COLUMN error_code text;
