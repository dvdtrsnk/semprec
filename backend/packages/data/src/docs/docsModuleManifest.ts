import type { ModuleManifest } from "@semprec/module-registry";

/**
 * Documents attach to any item in any database, so the only database declared is the hidden `pages` one. Compaction
 * and history cleanup run as core cron tasks; declaring them here as `taskNames`/`heartbeatActions` would collide with
 * core's reserved names.
 */
export const manifest: ModuleManifest = {
  id: "docs",
  version: "1.0.0",
  name: "Docs",
  removable: false,
  systemProject: true,
  // No order fields, so no collection list or switcher shows it; created on the first subpage, not by the seed.
  databases: [{ key: "pages", name: "Pages" }],
  capabilities: [],
  agentTools: [],
};
