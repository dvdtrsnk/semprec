import { z } from "zod";
import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-missing-export",
  version: "1.0.0",
  name: "Fixture Missing Export",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [
    {
      name: "fixtureMissing.tool",
      handlerExport: "doesNotExist",
      argumentSchemaExport: "toolArgsSchema",
      approval: "none",
      riskClass: "read",
    },
  ],
};

export const toolArgsSchema = z.object({});
