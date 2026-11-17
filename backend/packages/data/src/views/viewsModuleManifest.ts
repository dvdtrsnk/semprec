import type { ModuleManifest } from "@semprec/module-registry";
import { BUILTIN_VIEW_TYPES } from "../chokePoint/viewTypeRegistry.js";

/**
 * The views mechanism and its built-in view types. Domain view types (e.g. `temporal-switcher`) belong to their own
 * modules. Declares no databases: views attach to any module's database.
 */
export const manifest: ModuleManifest = {
  id: "views",
  version: "1.0.0",
  name: "Views",
  removable: false,
  systemProject: true,
  databases: [],
  capabilities: [],
  agentTools: [],
  viewTypes: [...BUILTIN_VIEW_TYPES],
};
