import { afterEach, describe, expect, it } from "vitest";
import { clearHooksForTests, projectItemForRead, registerItemReadProjection } from "../chokePoint/hooks.js";
import type { ItemRow } from "../types.js";
const item: ItemRow = {
  id: "item",
  databaseId: "db",
  properties: { body: "raw" },
  computed: {},
  createdAt: "now",
  updatedAt: "now",
  deletedAt: null,
};
afterEach(() => clearHooksForTests());
describe("item read projection registry", () => {
  it("applies the selected owner projection without mutating its input", () => {
    registerItemReadProjection({
      ownerModuleId: "emails",
      project: (row) => ({ ...row, properties: { ...row.properties, body: "safe" } }),
    });
    expect(projectItemForRead(item, "emails").properties.body).toBe("safe");
    expect(item.properties.body).toBe("raw");
  });
  it("leaves unregistered and ownerless items unchanged", () => {
    expect(projectItemForRead(item, null)).toBe(item);
    expect(projectItemForRead(item, "other")).toBe(item);
  });
  it("clears projections with the test reset", () => {
    registerItemReadProjection({ ownerModuleId: "emails", project: (row) => ({ ...row, properties: {} }) });
    clearHooksForTests();
    expect(projectItemForRead(item, "emails")).toBe(item);
  });
});
