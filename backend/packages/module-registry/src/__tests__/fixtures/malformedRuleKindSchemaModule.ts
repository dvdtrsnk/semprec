import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-malformed-rule-kind-schema",
  version: "1.0.0",
  name: "Fixture Malformed Rule Kind Schema",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  heartbeatRuleKinds: [
    { kind: "fixtureMalformed.onTick", schemaExport: "notASchema", nextFireAtExport: "computeNextFireAt" },
  ],
};

// Not schema-shaped (no `safeParse`), so loadModule must reject it at load time.
export const notASchema = { parse: (value: unknown) => value };

export function computeNextFireAt(): Date {
  return new Date(0);
}
