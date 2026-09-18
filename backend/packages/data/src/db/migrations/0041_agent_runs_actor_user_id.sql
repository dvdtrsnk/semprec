-- Issue #220: every agent_run must carry the user its writes are attributed to, so an AgentTool
-- composition root can derive an actor's `userId` from the persisted run alone, never from tool
-- input. Added nullable per the expand/contract migration ADR
-- (docs/adr/2026-09-10-expand-contract-forward-only-migrations.md) — backfilling a parent-chain
-- walk and then setting NOT NULL requires application code (Yjs-style app-code cutover, see
-- docs/adr/2026-09-10-app-code-post-migration-steps.md), so that step runs as
-- runAgentRunsActorUserIdCutoverMigration.ts immediately after structural migrations, the same
-- way 0036_doc_history_retention.sql's follow-up cutover does.
ALTER TABLE agent_runs ADD COLUMN actor_user_id uuid REFERENCES users(id);
