import type { ModuleManifest } from "../../manifest.js";

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
  agentTools: [{ name: "fixtureSecond.ungranted", handlerExport: "handleUngranted", capability: "fixtureSecond.neverGranted" }],
};

export function handleUngranted(): void {}
