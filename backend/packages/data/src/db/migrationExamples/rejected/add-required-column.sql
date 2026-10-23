-- Required without a default: the previous release's INSERTs do not name body.
ALTER TABLE notes ADD COLUMN body text NOT NULL;
