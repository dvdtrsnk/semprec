import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import type { ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { requireAffectedRows } from "../db/pool.js";
import { RECIPES_DATABASE_DESCRIPTOR } from "../recipes/recipesModuleManifest.js";
import type { PropertyOwner, PropertyType } from "../types.js";
import { RECIPES_MODULE_ID, RECIPE_SOURCE_URL_KEY } from "./recipesModuleKeys.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "./systemProjectAgentGuidance.js";

interface PropSpec {
  key: string;
  type: PropertyType;
  owner: PropertyOwner;
  config?: Record<string, unknown>;
}

/**
 * Labels of properties, options and presets are in `recipes/i18n`. `sourceUrl` values are checked by
 * `recipes/recipeSourceUrlHook.ts`.
 */
const RECIPE_PROPERTIES: readonly PropSpec[] = [
  { key: "name", type: "title", owner: "user" },
  {
    key: "category",
    type: "select",
    owner: "user",
    config: {
      options: [
        { key: "main", color: "#FF9500" },
        { key: "breakfast", color: "#FFCC00" },
        { key: "dessert", color: "#FF2D55" },
      ],
    },
  },
  {
    key: "prepMinutes",
    type: "number",
    owner: "user",
    config: {
      filterPresets: [15, 30, 60].map((value) => ({
        value,
        op: "lte",
        labelKey: `property.${RECIPES_MODULE_ID}.prepMinutes.preset.${value}`,
      })),
    },
  },
  { key: "servings", type: "number", owner: "user" },
  { key: "favorite", type: "checkbox", owner: "user" },
  // { blobId } over the shared `blobs` table; `recipes/recipePhotoHook.ts` checks each written value.
  { key: "photo", type: "image", owner: "user" },
  { key: RECIPE_SOURCE_URL_KEY, type: "url", owner: "user" },
];

export interface RecipesModuleResult {
  projectItemId: string;
}

/**
 * Seeds the Recipes module into the caller's transaction: the "Recipes" system project, its `recipes`
 * database and properties, and the default `gallery` view; the schema is locked after the view.
 * Resolves with the project item id.
 *
 * Not idempotent: `seedSystem` calls it once per new tenant.
 */
export async function seedRecipesModuleInTransaction(
  client: PoolClient,
  projectsDatabaseId: string,
  viewTypeRegistry: ViewTypeRegistry,
): Promise<RecipesModuleResult> {
  const project = await itemsStore.insertItem(client, {
    databaseId: projectsDatabaseId,
    properties: {
      name: "Recipes",
      systemActive: true,
      agents: SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS[RECIPES_MODULE_ID],
    },
  });
  const recipes = await databasesStore.createDatabase(client, {
    name: null,
    key: RECIPES_MODULE_ID,
    system: true,
    ownerModuleId: RECIPES_MODULE_ID,
    ownerProjectItemId: project.id,
  });
  for (const spec of RECIPE_PROPERTIES) {
    // `name` stays null: labels come from the module catalog.
    await propertiesStore.createProperty(client, {
      databaseId: recipes.id,
      key: spec.key,
      name: null,
      type: spec.type,
      owner: spec.owner,
      config: spec.config,
    });
  }
  await viewsStore.createView(
    client,
    {
      databaseId: recipes.id,
      type: RECIPES_DATABASE_DESCRIPTOR.defaultViewType,
      name: RECIPES_DATABASE_DESCRIPTOR.name,
      isDefault: true,
      createdBy: "system",
      config: { columns: 2, aspect: "4:3", coverKey: "photo" },
    },
    viewTypeRegistry,
  );
  requireAffectedRows(
    await client.query("UPDATE databases SET schema_locked = true WHERE id = $1", [recipes.id]),
    "recipes schema lock",
  );
  return { projectItemId: project.id };
}
