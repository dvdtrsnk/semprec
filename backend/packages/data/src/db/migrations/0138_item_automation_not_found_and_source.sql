-- expand-contract-exemption: The status CHECK is widened; the required immediate predecessor is the separately deployed compatible reader bridge.
ALTER TABLE item_automation DROP CONSTRAINT item_automation_status_check;
ALTER TABLE item_automation ADD CONSTRAINT item_automation_status_check CHECK (status IN ('pending', 'done', 'error', 'locked', 'notFound'));
ALTER TABLE item_automation ADD COLUMN source text NULL CHECK (source IN ('openLibrary', 'googleBooks', 'tmdb'));
