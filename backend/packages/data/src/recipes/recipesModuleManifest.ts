import type { ModuleDatabaseDescriptor, ModuleManifest } from "@semprec/module-registry";
import { RECIPES_MODULE_ID } from "../seed/recipesModuleKeys.js";

/**
 * The descriptor of the `recipes` database (issue #1707): position 9 of the overview and of the collection
 * switcher, and a `gallery` default view. `seed/seedRecipesModule.ts` creates the default view with the type and
 * the name declared here. The user may hide the database from the overview (issue #2002).
 */
export const RECIPES_DATABASE_DESCRIPTOR = {
  key: RECIPES_MODULE_ID,
  name: "Recipes",
  defaultViewType: "gallery",
  icon: "fork-knife",
  color: "#FF9500",
  overviewOrder: 9,
  switcherOrder: 9,
  overviewHideable: true,
} as const satisfies ModuleDatabaseDescriptor;

/**
 * Manifest of the Recipes module (issue #1707): one system database, `recipes`, seeded by
 * `seed/seedRecipesModule.ts` and owned by its own system project. The photo check on its items
 * (`recipePhotoHook.ts`) is a choke-point hook registered in `domainWriteHooks.ts`, not a manifest declaration.
 */
export const manifest: ModuleManifest = {
  id: RECIPES_MODULE_ID,
  version: "1.0.0",
  name: "Recipes",
  removable: false,
  systemProject: true,
  databases: [RECIPES_DATABASE_DESCRIPTOR],
  capabilities: [],
  agentTools: [],
};
