-- Issue #1528: icon and color of a user-created database. Both stay NULL until a user picks one; the
-- defaults (icon 'database', color '#FF9500') are applied when the API reads the row, never stored, so a
-- later change of the default needs no data migration. System databases keep NULL: their icon and color
-- come from the module manifest.
--
-- Additive and rollback-safe: two nullable columns the previous release never reads or writes. The
-- runtime role already holds table-level privileges on `databases`, so it can write the new columns.
ALTER TABLE databases
  ADD COLUMN icon text,
  ADD COLUMN color text,
  ADD CONSTRAINT databases_icon_format CHECK (icon IS NULL OR icon ~ '^[a-z][a-z0-9-]{0,63}$'),
  ADD CONSTRAINT databases_color_format CHECK (color IS NULL OR color ~ '^#[0-9A-F]{6}$');
