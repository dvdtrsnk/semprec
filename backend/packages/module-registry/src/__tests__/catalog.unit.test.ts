import { describe, expect, it } from "vitest";
import { resolveCatalogLabel } from "../catalog.js";

const en = { "database.tasks.name": "Tasks" };
const cs = { "database.tasks.name": "Úkoly" };

describe("resolveCatalogLabel (issue #236)", () => {
  it("prefers an explicit override over every catalog entry", () => {
    expect(resolveCatalogLabel("My tasks", cs, en, "database.tasks.name")).toBe("My tasks");
  });

  it("treats an empty-string override as present, not absent", () => {
    expect(resolveCatalogLabel("", cs, en, "database.tasks.name")).toBe("");
  });

  it("falls back to the requested locale's catalog when there is no override", () => {
    expect(resolveCatalogLabel(null, cs, en, "database.tasks.name")).toBe("Úkoly");
    expect(resolveCatalogLabel(undefined, cs, en, "database.tasks.name")).toBe("Úkoly");
  });

  it("falls back to the English reference catalog when the requested locale has no entry", () => {
    expect(resolveCatalogLabel(null, {}, en, "database.tasks.name")).toBe("Tasks");
    expect(resolveCatalogLabel(null, undefined, en, "database.tasks.name")).toBe("Tasks");
  });

  it("falls back to the raw canonical key when no catalog has an entry", () => {
    expect(resolveCatalogLabel(null, cs, en, "database.unknownDb.name")).toBe("database.unknownDb.name");
  });
});
