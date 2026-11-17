import type { ModuleManifest } from "../../manifest.js";

/** A unique database key followed by one colliding with `goodModule`'s; the first must not stay claimed after rejection. */
export const manifest: ModuleManifest = {
  id: "fixture-partial-collision",
  version: "1.0.0",
  name: "Fixture Partial Collision",
  removable: true,
  systemProject: false,
  databases: [
    { key: "fixturePartialFirst", name: "Partial First" },
    { key: "fixtureGoodItems", name: "Colliding Second Database" },
  ],
  capabilities: [],
  agentTools: [],
};
