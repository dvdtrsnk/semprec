-- Issue #87: per-agent ownership of AI-created views. `created_by = 'ai_agent'` alone cannot
-- distinguish two concrete agents, so a view created by one agent was writable by any other.
-- `creator_project_item_id` stores the owning Projects item id of the concrete agent that
-- created the view — additive and nullable, same as `ai_gateway_calls.project_item_id` (#215)
-- and `project_agent_guidance.project_item_id` (#214). No FK to `items`: `items` is a
-- partitioned table with one partition per database and cannot supply a direct FK target, so
-- the application layer (chokePoint.ts) validates it against the Projects system database
-- before writing here.
--
-- Every row that existed before this migration (and every 'user'/'system' row) keeps this
-- column NULL. A NULL is never treated as "no owner, anyone may write" — the choke-point
-- rejects an agent write against a NULL-owned 'ai_agent' view (`reason: 'legacy_creator_unknown'`)
-- while still allowing a user to adopt it, so a legacy row is safe by default.
ALTER TABLE views ADD COLUMN creator_project_item_id uuid;
CREATE INDEX views_creator_project_item_id_idx ON views (creator_project_item_id);
