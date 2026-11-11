import { describe, expect, it } from "vitest";
import { createCollectionMetadataResolver } from "../manifest/collectionMetadata.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { legacyAgentsTextToSections } from "../projectAgentGuidance/legacyAgentsConversion.js";
import { SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS } from "../seed/systemProjectAgentGuidance.js";

describe("Recipes module manifest (issue #1707)", () => {
  it("is loaded by the full registry as a non-removable system project module with its one database descriptor", async () => {
    const registry = await loadFullModuleRegistry();

    expect(registry.listModuleIds()).toContain("recipes");
    expect(await registry.listActiveModuleIds()).toContain("recipes");
    expect(await registry.getSystemProjectModuleIds()).toContain("recipes");
    expect(registry.isRemovable("recipes")).toBe(false);
    expect((await registry.getDatabases()).filter((database) => database.moduleId === "recipes")).toEqual([
      {
        moduleId: "recipes",
        key: "recipes",
        name: "Recipes",
        defaultViewType: "gallery",
        icon: "fork-knife",
        color: "#FF9500",
        overviewOrder: 9,
        switcherOrder: 9,
      },
    ]);
  });

  it("resolves to a client-visible collection at position 9 of the overview and of the switcher", async () => {
    const resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());

    expect(resolver.resolve({ key: "recipes", system: true })).toEqual({
      icon: "fork-knife",
      color: "#FF9500",
      overviewOrder: 9,
      switcherOrder: 9,
      clientVisible: true,
    });
  });

  it("ships a Czech and an English catalog with the same keys and the database name in each", async () => {
    const catalogs = await (await loadFullModuleRegistry()).getCatalogs("recipes");
    if (!catalogs) throw new Error("The recipes module has no catalogs");

    expect(Object.keys(catalogs.cs).sort()).toEqual(Object.keys(catalogs.en).sort());
    expect(Object.keys(catalogs.cs).sort()).toEqual(
      [
        "database.recipes.name",
        "database.recipes.searchPlaceholder",
        "property.recipes.name.name",
        "property.recipes.category.name",
        "property.recipes.category.option.main",
        "property.recipes.category.option.breakfast",
        "property.recipes.category.option.dessert",
        "property.recipes.prepMinutes.name",
        "property.recipes.prepMinutes.preset.15",
        "property.recipes.prepMinutes.preset.30",
        "property.recipes.prepMinutes.preset.60",
        "property.recipes.servings.name",
        "property.recipes.favorite.name",
        "property.recipes.photo.name",
      ].sort(),
    );
    expect(catalogs.cs["database.recipes.name"]).toBe("Recepty");
    expect(catalogs.en["database.recipes.name"]).toBe("Recipes");
    for (const catalog of [catalogs.cs, catalogs.en]) {
      for (const label of Object.values(catalog)) expect(label.trim()).not.toBe("");
    }
  });

  it("gives the Recipes project an agents text with a purpose, allowed writes and not-allowed writes", () => {
    const sections = legacyAgentsTextToSections(SYSTEM_PROJECT_AGENT_GUIDANCE_SEED_TEXTS.recipes);

    expect(sections.purpose).toContain("recipes");
    expect(sections.allowed).toContain("name/category/prepMinutes/servings/favorite/photo");
    expect(sections.notAllowed).toContain("photo");
    expect(sections.generalInstructions).not.toBe("");
  });
});
