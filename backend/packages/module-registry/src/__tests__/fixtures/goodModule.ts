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
  heartbeatRuleKinds: [{ kind: "fixtureGood.onWidgetTick", schemaExport: "widgetTickRuleSchema", nextFireAtExport: "computeWidgetTickNextFireAt" }],
  taskNames: [{ name: "fixtureGood.processThing", payloadSchemaExport: "processThingPayloadSchema", handlerExport: "handleProcessThing" }],
  workers: [{ name: "fixtureGood.worker", handlerExport: "runWorker" }],
  migrations: ["0001_fixture_good.sql"],
  dataMigrations: [{ databaseKey: "fixtureGoodItems", fromVersion: "1.0.0", toVersion: "2.0.0", converterExport: "convertFixtureGoodItem" }],
};

export function handleDoThing(): string {
  return "did the thing";
}

export const processThingPayloadSchema = { parse: (value: unknown) => value };

export function handleProcessThing(): void {}

export function runWorker(): void {}

export const widgetTickRuleSchema = { safeParse: (value: unknown) => ({ success: true, data: value }) };

export function computeWidgetTickNextFireAt(): Date {
  return new Date(0);
}

export function convertFixtureGoodItem(properties: Record<string, unknown>): Record<string, unknown> {
  return properties;
}
