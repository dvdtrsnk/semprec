import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-reserved-rule-kind",
  version: "1.0.0",
  name: "Fixture Reserved Rule Kind",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  heartbeatRuleKinds: [{ kind: "dailyTime", schemaExport: "ruleSchema", nextFireAtExport: "computeNextFireAt" }],
};

export const ruleSchema = { safeParse: (value: unknown) => ({ success: true, data: value }) };

export function computeNextFireAt(): Date {
  return new Date(0);
}
