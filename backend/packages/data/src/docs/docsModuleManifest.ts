import type { ModuleManifest } from "@semprec/module-registry";

/**
 * Retrofit manifest (module-contract issue #226) for blocks/docs: `0003_docs.sql` (`docs`,
 * `doc_snapshots`, `doc_updates` — the block-append mechanism — and `doc_snapshot_history`)
 * plus `0036_doc_history_retention.sql` (issue #216's retained history model: mirrored
 * `doc_history_updates`, checkpoint-boundary columns, `docs.history_available_from`).
 * `doc_updates` attaches to any item in any database, so the only database this module
 * declares is the hidden `pages` one (below). Its periodic maintenance (compaction sweep, history cleanup) still runs as core
 * cron tasks (`CORE_TASK_NAMES` in `@semprec/queue`, scheduled directly in `worker.ts`), not
 * through the module task/heartbeat mechanism, so they are deliberately not re-declared here
 * as `taskNames` or `heartbeatActions` — doing so would collide with core's reserved names
 * and would be a behavior change, not a retrofit. Authoring this manifest changed no
 * behavior; the `pages` entry only declares the hidden database that `pagesDatabase.ts` creates.
 */
export const manifest: ModuleManifest = {
  id: "docs",
  version: "1.0.0",
  name: "Docs",
  removable: false,
  systemProject: true,
  // The hidden Pages database (docs/adr/2026-10-29-subpages-are-items-of-a-hidden-pages-database.md): no order fields,
  // so no collection list or switcher shows it; it is created on the first subpage, not by the tenant seed.
  databases: [{ key: "pages", name: "Pages" }],
  capabilities: [],
  agentTools: [],
  migrations: ["0003_docs.sql", "0036_doc_history_retention.sql"],
};
