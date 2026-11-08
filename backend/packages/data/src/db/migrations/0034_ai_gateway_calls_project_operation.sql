-- Issue #215: attribute `POST /internal/complete` calls to the project item and operation that
-- triggered them. Both columns are nullable and additive — every call recorded before this route
-- existed (embed/transcribe/diarize, and complete() calls with no project context) has neither,
-- and stays that way; this route is the only writer that ever sets them, always together, never
-- one without the other. No FK to `items` for the same reason `project_agent_guidance` (#214)
-- has none: `items` is partitioned per database and cannot supply a direct FK target.
ALTER TABLE ai_gateway_calls ADD COLUMN project_item_id uuid;
ALTER TABLE ai_gateway_calls ADD COLUMN operation text;
