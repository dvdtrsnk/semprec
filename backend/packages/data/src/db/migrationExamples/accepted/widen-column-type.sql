-- expand-contract-exemption: widening. Every varchar(200) value is a valid text value, and the
-- previous release reads and writes title as a string either way.
ALTER TABLE notes ALTER COLUMN title TYPE text;
