import type { ModuleDatabaseDescriptor, ModuleManifest } from "@semprec/module-registry";
import { RECIPES_MODULE_ID } from "../seed/recipesModuleKeys.js";

/** `seed/seedRecipesModule.ts` creates the default view with this type and name. The user may hide it from the overview. */
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

/** The photo check (`recipePhotoHook.ts`) is a choke-point hook in `domainWriteHooks.ts`, not a manifest declaration. */
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
