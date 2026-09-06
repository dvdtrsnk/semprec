import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-good",
  version: "1.0.0",
  name: "Fixture Good",
  removable: true,
  systemProject: true,
  databases: [{ key: "fixtureGoodItems", name: "Fixture Good Items" }],
  capabilities: ["fixtureGood.send"],
  agentTools: [{ name: "fixtureGood.doThing", handlerExport: "handleDoThing", capability: "fixtureGood.send" }],
  viewTypes: ["fixture-good-view"],
  heartbeatActions: ["fixtureGood.heartbeat"],
  heartbeatRuleKinds: ["onItemEvent"],
  taskNames: [{ name: "fixtureGood.processThing", payloadSchemaExport: "processThingPayloadSchema", handlerExport: "handleProcessThing" }],
  workers: [{ name: "fixtureGood.worker", handlerExport: "runWorker" }],
  migrations: ["0001_fixture_good.sql"],
};

export function handleDoThing(): string {
  return "did the thing";
}

export const processThingPayloadSchema = { parse: (value: unknown) => value };

export function handleProcessThing(): void {}

export function runWorker(): void {}
