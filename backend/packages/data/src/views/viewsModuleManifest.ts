import type { ModuleManifest } from "@semprec/module-registry";
import { BUILTIN_VIEW_TYPES } from "../chokePoint/viewTypeRegistry.js";

/**
 * Retrofit manifest (module-contract issue #226) for the views mechanism: `0002_views.sql`
 * (the `views`/`view_items` tables) plus the built-in view types it ships with out of the
 * box (`viewTypeRegistry.ts`'s `BUILTIN_VIEW_TYPES`). Domain-specific view types registered
 * on top of this mechanism (e.g. Journal's `temporal-switcher`) belong to the module that
 * owns that domain, not to this one. Declares no databases of its own — views attach to any
 * module's database. Authoring this manifest changes no behavior.
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
  migrations: ["0002_views.sql"],
};
