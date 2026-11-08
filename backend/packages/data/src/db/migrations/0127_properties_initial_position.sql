ALTER TABLE properties ADD COLUMN initial_position integer
  CHECK (initial_position IS NULL OR initial_position >= 0);
