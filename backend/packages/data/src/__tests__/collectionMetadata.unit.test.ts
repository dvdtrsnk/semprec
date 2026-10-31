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
      });
    }
    expect(resolver.resolve({ key: null, system: false })).toEqual({
      icon: DEFAULT_DATABASE_ICON,
      color: DEFAULT_DATABASE_COLOR,
      overviewOrder: null,
      switcherOrder: null,
      clientVisible: true,
    });
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
