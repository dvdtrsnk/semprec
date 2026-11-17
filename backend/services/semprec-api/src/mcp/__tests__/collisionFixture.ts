import { z } from "zod";
import type { ModuleManifest } from "@semprec/module-registry";
export const manifest: ModuleManifest = {
  id: "collisionFixture",
  version: "1.0.0",
  name: "Collision fixture",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: ["fixture.read"],
  agentTools: [
    {
      name: "item.get",
      handlerExport: "createTool",
      argumentSchemaExport: "args",
      capability: "fixture.read",
      approval: "always",
      riskClass: "read",
    },
  ],
};
export const args = z.object({});
export function createTool() {
  return async () => ({ result: "ok", error: false });
}
