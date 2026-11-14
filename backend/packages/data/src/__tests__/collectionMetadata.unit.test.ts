import { describe, expect, it } from "vitest";
import type { ModuleRegistry } from "@semprec/module-registry";
import {
  compareCollections,
  createCollectionMetadataResolver,
  DEFAULT_DATABASE_COLOR,
  DEFAULT_DATABASE_ICON,
} from "../manifest/collectionMetadata.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";

describe("collection metadata resolver (issue #1407)", () => {
  it("declares unique overview and switcher orders across the fully loaded registry", async () => {
    const registry = await loadFullModuleRegistry();
    const databases = await registry.getDatabases();
    for (const field of ["overviewOrder", "switcherOrder"] as const) {
      const orders = databases.map((db) => db[field]).filter((order): order is number => typeof order === "number");
      expect(orders.length).toBeGreaterThan(0);
      expect(new Set(orders).size).toBe(orders.length);
    }
    const byKey = new Map(databases.map((db) => [db.key, db]));
    for (const key of ["mailboxes", "folders"]) {
      const db = byKey.get(key)!;
      expect(db.icon).toBeUndefined();
      expect(db.overviewOrder).toBeUndefined();
      expect(db.clientVisible).toBeUndefined();
    }
  });

  it("resolves declared, undeclared and user-created databases", async () => {
    const resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
    expect(resolver.resolve({ key: "books", system: true })).toEqual({
      icon: "book-open",
      color: "#A2845E",
      overviewOrder: 7,
      switcherOrder: null,
      clientVisible: true,
      overviewHidden: false,
    });
    expect(resolver.resolve({ key: "emails", system: true })).toMatchObject({
      overviewOrder: null,
      switcherOrder: null,
      clientVisible: true,
    });
    for (const key of ["mailboxes", "folders", "unknownInternal", null]) {
      expect(resolver.resolve({ key, system: true })).toEqual({
        icon: null,
        color: null,
        overviewOrder: null,
        switcherOrder: null,
        clientVisible: false,
        overviewHidden: false,
      });
    }
    expect(resolver.resolve({ key: null, system: false })).toEqual({
      icon: DEFAULT_DATABASE_ICON,
      color: DEFAULT_DATABASE_COLOR,
      overviewOrder: null,
      switcherOrder: null,
      clientVisible: true,
      overviewHidden: false,
    });
  });

  it.each([
    { name: "a system database with a descriptor", database: { key: "recipes", system: true } },
    { name: "a system database without a descriptor", database: { key: "unknownInternal", system: true } },
    { name: "a user-created database", database: { key: null, system: false } },
  ])(
    "resolves overviewHidden as the stored flag of $name, and false without one (issue #2002)",
    async ({ database }) => {
      const resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
      const shown = resolver.resolve({ ...database, overviewHidden: false });
      expect(shown.overviewHidden).toBe(false);
      // Hiding changes the flag alone: the orders, the look and the visibility stay as resolved for the shown row.
      expect(resolver.resolve({ ...database, overviewHidden: true })).toEqual({ ...shown, overviewHidden: true });
      expect(resolver.resolve(database)).toEqual(shown);
    },
  );

  it("reports as hideable only a system database whose descriptor declares overviewHideable true (issue #2002)", async () => {
    const resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
    expect(resolver.overviewHideable({ key: "recipes", system: true })).toBe(true);
    // A system database whose descriptor does not declare it, one without a descriptor and one without a key.
    for (const key of ["projects", "books", "unknownInternal", null]) {
      expect(resolver.overviewHideable({ key, system: true })).toBe(false);
    }
    // A user-created database never takes a module's declaration, whatever its key column holds.
    expect(resolver.overviewHideable({ key: null, system: false })).toBe(false);
    expect(resolver.overviewHideable({ key: "recipes", system: false })).toBe(false);

    const explicitlyFixed = {
      getDatabases: async () => [{ moduleId: "fixture", key: "fixed", name: "Fixed", overviewHideable: false }],
    } as unknown as ModuleRegistry;
    expect(
      (await createCollectionMetadataResolver(explicitlyFixed)).overviewHideable({ key: "fixed", system: true }),
    ).toBe(false);
  });

  it("declares overviewHideable for the recipes database only across the fully loaded registry (issue #2002)", async () => {
    const databases = await (await loadFullModuleRegistry()).getDatabases();
    expect(
      databases.filter((db) => db.overviewHideable !== undefined).map((db) => [db.key, db.overviewHideable]),
    ).toEqual([["recipes", true]]);
  });

  it("derives clientVisible from an order, and ignores clientVisible false", async () => {
    const registry = {
      getDatabases: async () => [
        { moduleId: "fixture", key: "overviewOnly", name: "A", overviewOrder: 1 },
        { moduleId: "fixture", key: "switcherOnly", name: "B", switcherOrder: 1 },
        { moduleId: "fixture", key: "hidden", name: "C", overviewOrder: null, clientVisible: false },
      ],
    } as unknown as ModuleRegistry;
    const resolver = await createCollectionMetadataResolver(registry);
    expect(resolver.resolve({ key: "overviewOnly", system: true }).clientVisible).toBe(true);
    expect(resolver.resolve({ key: "switcherOnly", system: true }).clientVisible).toBe(true);
    expect(resolver.resolve({ key: "hidden", system: true }).clientVisible).toBe(false);
  });

  it("resolves the declared collection filter of a system database only, as a copy (issue #1709)", async () => {
    const resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
    const declared = resolver.collectionFilter({ key: "projects", system: true });
    expect(declared).toEqual({ type: "is_empty", property: "systemActive" });
    // A caller changing its copy does not change what the resolver answers next.
    if (declared) declared.property = "changed";
    expect(resolver.collectionFilter({ key: "projects", system: true })).toEqual({
      type: "is_empty",
      property: "systemActive",
    });
    // A system database without a declaration, one without a descriptor and one without a key.
    for (const key of ["tasks", "unknownInternal", null]) {
      expect(resolver.collectionFilter({ key, system: true })).toBeUndefined();
    }
    // A user-created database never takes a module's declaration, whatever its key column holds.
    expect(resolver.collectionFilter({ key: null, system: false })).toBeUndefined();
    expect(resolver.collectionFilter({ key: "projects", system: false })).toBeUndefined();
  });

  it("resolves the declared related order of a system database only, keeping the keys of active databases (issue #1839)", async () => {
    const resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
    const projects = resolver.relatedOrder?.({ key: "projects", system: true });
    // Projects omit Tasks, and the order lists the future key of a database that is not active.
    expect(projects?.omit).toEqual(["tasks"]);
    expect(projects?.order.slice(0, 3)).toEqual(["projects", "events", "files"]);
    // People omit Emails: the mail of a person is listed as threads (issue gh-1874).
    expect(resolver.relatedOrder?.({ key: "people", system: true })?.omit).toEqual(["emails"]);
    // A system database without a declaration, one without a descriptor and one without a key.
    for (const key of ["tasks", "unknownInternal", null]) {
      expect(resolver.relatedOrder?.({ key, system: true })).toBeUndefined();
    }
    // A user-created database never takes a module's declaration, whatever its key column holds.
    expect(resolver.relatedOrder?.({ key: "projects", system: false })).toBeUndefined();

    const registry = {
      getDatabases: async () => [
        {
          moduleId: "fixture",
          key: "source",
          name: "Source",
          relatedOrder: { order: ["active", "gone"], omit: ["inactive", "active"] },
        },
        { moduleId: "fixture", key: "active", name: "Active" },
        { moduleId: "fixture", key: "inactive", name: "Inactive" },
      ],
    } as unknown as ModuleRegistry;
    const fixture = await createCollectionMetadataResolver(registry);
    expect(fixture.relatedOrder?.({ key: "source", system: true })).toEqual({
      order: ["active"],
      omit: ["inactive", "active"],
    });
  });

  it("resolves the declared area filter of a system database only, as a copy (issue #1839)", async () => {
    const resolver = await createCollectionMetadataResolver(await loadFullModuleRegistry());
    const declared = resolver.areaFilter?.({ key: "projects", system: true });
    expect(declared).toEqual({ type: "relation_contains", property: "area", value: { areaValue: true } });
    // A caller changing its copy does not change what the resolver answers next.
    if (declared?.type === "relation_contains") declared.property = "changed";
    expect(resolver.areaFilter?.({ key: "projects", system: true })).toMatchObject({ property: "area" });
    // A system database without a declaration, one without a descriptor and one without a key.
    for (const key of ["transcripts", "unknownInternal", null]) {
      expect(resolver.areaFilter?.({ key, system: true })).toBeUndefined();
    }
    // A user-created database never takes a module's declaration, whatever its key column holds.
    expect(resolver.areaFilter?.({ key: "projects", system: false })).toBeUndefined();
  });

  it("orders switcher rows, then overview-only rows, then the rest by name then id", () => {
    const rows = [
      { id: "6", name: "beta", switcherOrder: null, overviewOrder: null },
      { id: "5", name: "Alpha", switcherOrder: null, overviewOrder: null },
      { id: "4", name: "alpha", switcherOrder: null, overviewOrder: null },
      { id: "3", name: "Film", switcherOrder: null, overviewOrder: 8 },
      { id: "2", name: "Book", switcherOrder: null, overviewOrder: 7 },
      { id: "1", name: "Task", switcherOrder: 2, overviewOrder: null },
      { id: "0", name: "Project", switcherOrder: 1, overviewOrder: 1 },
    ];
    expect([...rows].sort(compareCollections).map((r) => r.id)).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
  });
});
