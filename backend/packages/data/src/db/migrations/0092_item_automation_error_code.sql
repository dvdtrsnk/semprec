-- Stable failure class beside the diagnostic `error` text; null while no failure is recorded.
ALTER TABLE item_automation ADD COLUMN error_code text NULL;
