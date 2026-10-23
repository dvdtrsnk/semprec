import type { ModuleManifest } from "../../manifest.js";

/**
 * Declares one database key that no other fixture uses, then a second one that collides with
 * `goodModule`'s — used to prove `loadModule` rejects this module atomically: the first
 * ("fixturePartialFirst") must never end up claimed, since this module itself is never
 * registered.
 */
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
