import { z } from "zod";
import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "gatedMissingSnapshot",
  version: "1.0.0",
  name: "Gated Missing Snapshot",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [
    {
      name: "gatedMissing.apply",
      handlerExport: "createApplyTool",
      argumentSchemaExport: "applyArgsSchema",
      approval: "always",
      requiresApproval: true,
      snapshotExport: "doesNotExist",
    },
  ],
};

export const applyArgsSchema = z.object({}).strict();

export function createApplyTool() {
  return async () => ({ error: false, result: "unused" });
}
