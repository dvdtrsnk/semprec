import type { PoolClient } from "pg";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import type { ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { requireAffectedRows } from "../db/pool.js";
import { RECIPES_DATABASE_DESCRIPTOR } from "../recipes/recipesModuleManifest.js";
import type { PropertyOwner, PropertyType } from "../types.js";
import { RECIPES_MODULE_ID } from "./recipesModuleKeys.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "./systemProjectAgentGuidance.js";

interface PropSpec {
  key: string;
  type: PropertyType;
  owner: PropertyOwner;
  config?: Record<string, unknown>;
}

/** The six properties of a recipe; the labels of each, of the options and of the presets are in `recipes/i18n`. */
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
];

export interface RecipesModuleResult {
  /** The Projects item "Recipes" that owns the `recipes` database. */
  projectItemId: string;
}

/**
 * Seeds the Recipes module (issue #1707) into the caller's open transaction: the system project item "Recipes"
 * in the Projects database, the `recipes` system database it owns, the six properties of `RECIPE_PROPERTIES`,
 * and the default `gallery` view (two columns, 4:3 tiles, the photo as the tile image). The schema is locked
 * once the view exists. Resolves with the id of the project item it created.
 *
 * Not idempotent on its own: `seedSystem` calls it once for a new tenant and
 * `recipes/recipesModuleCutoverMigration.ts` calls it only for a tenant without a `recipes` database.
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
    // `name` stays null: the label of each property comes from the module catalog.
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
