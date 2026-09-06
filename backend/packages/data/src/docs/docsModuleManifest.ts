import type { ModuleManifest } from "@semprec/module-registry";

/**
 * Retrofit manifest (module-contract issue #226) for blocks/docs: `0003_docs.sql` (`docs`,
 * `doc_snapshots`, `doc_updates` — the block-append mechanism — and `doc_snapshot_history`).
 * `doc_updates` attaches to any item in any database, so this module declares no databases
 * of its own. Its periodic maintenance (compaction sweep, history squash, history cleanup)
 * still runs as core cron tasks (`CORE_TASK_NAMES` in `@semprec/queue`, scheduled directly in
 * `worker.ts`), not through the module task/heartbeat mechanism, so they are deliberately not
 * re-declared here as `taskNames` or `heartbeatActions` — doing so would collide with core's
 * reserved names and would be a behavior change, not a retrofit. Authoring this manifest
 * changes no behavior.
 */
export const manifest: ModuleManifest = {
  id: "docs",
  version: "1.0.0",
  name: "Docs",
  removable: false,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [],
  migrations: ["0003_docs.sql"],
};
