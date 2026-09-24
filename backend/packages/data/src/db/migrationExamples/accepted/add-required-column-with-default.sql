-- A required column is fine once it has a default: the previous release's INSERTs get the default.
ALTER TABLE notes ADD COLUMN pinned boolean NOT NULL DEFAULT false;
