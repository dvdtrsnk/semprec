import type { ModuleManifest } from "../../manifest.js";
import { z } from "zod";

export const manifest: ModuleManifest = {
  id: "fixture-second",
  version: "1.0.0",
  name: "Fixture Second",
  removable: false,
  systemProject: false,
  databases: [{ key: "fixtureSecondItems", name: "Fixture Second Items" }],
  // Deliberately overlaps with goodModule's "fixtureGood.send" to exercise getCapabilities'
  // cross-module deduplication.
  capabilities: ["fixtureGood.send", "fixtureSecond.onlyHere"],
  agentTools: [
    {
      name: "fixtureSecond.ungranted",
      handlerExport: "handleUngranted",
      argumentSchemaExport: "toolArgsSchema",
      approval: "none",
      riskClass: "read",
      capability: "fixtureSecond.neverGranted",
    },
  ],
};

export const toolArgsSchema = z.object({});

export function handleUngranted(): void {}
