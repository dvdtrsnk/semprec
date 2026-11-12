import { beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../errors.js";
import type { FilterNode } from "../views/filterTree.js";

const loadFullModuleRegistry = vi.hoisted(() => vi.fn());
vi.mock("../manifest/fullModuleRegistry.js", () => ({ loadFullModuleRegistry }));

const { excludeFacetConditions, loadFacetMetadata } = await import("../views/facetQuery.js");
type FacetTarget = Parameters<typeof excludeFacetConditions>[1];

const status: FacetTarget = { kind: "property", key: "status" };
const projectArea: FacetTarget = { kind: "path", path: ["project", "area"] };
const areaId = "11111111-1111-4111-8111-111111111111";

const done: FilterNode = { type: "equals", property: "status", value: "done" };
const open: FilterNode = { type: "in", property: "status", value: ["notDone"] };
const flagged: FilterNode = { type: "equals", property: "flagged", value: true };
const dated: FilterNode = { type: "is_not_empty", property: "date" };
const inArea: FilterNode = { type: "relation_path_contains", path: ["project", "area"], value: areaId };

function expectRefusedOnFilter(filter: FilterNode, facet: FacetTarget): void {
  let thrown: unknown;
  try {
    excludeFacetConditions(filter, facet);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ValidationError);
  expect(thrown).toMatchObject({ status: 400, code: "validation_failed", details: { field: "filter" } });
}

describe("excludeFacetConditions (issue #1759)", () => {
  it("leaves nothing of a filter that is one condition on the facet, and keeps one on another property", () => {
    expect(excludeFacetConditions(done, status)).toBeUndefined();
    expect(excludeFacetConditions(flagged, status)).toBe(flagged);
  });

  it("removes every condition on the facet among the children of the top-level and, and keeps the others in order", () => {
    const filter: FilterNode = { type: "and", nodes: [flagged, done, dated, open] };
    expect(excludeFacetConditions(filter, status)).toEqual({ type: "and", nodes: [flagged, dated] });
    // A facet the filter does not name leaves every child in place.
    expect(excludeFacetConditions(filter, { kind: "property", key: "name" })).toEqual(filter);
  });

  it("leaves nothing of an and whose every child is a condition on the facet", () => {
    expect(excludeFacetConditions({ type: "and", nodes: [done, open] }, status)).toBeUndefined();
  });

  it("removes a condition reached through nested and nodes, and drops an and that loses every child", () => {
    const nested: FilterNode = {
      type: "and",
      nodes: [{ type: "and", nodes: [done, flagged] }, { type: "and", nodes: [open] }, dated],
    };
    expect(excludeFacetConditions(nested, status)).toEqual({
      type: "and",
      nodes: [{ type: "and", nodes: [flagged] }, dated],
    });
  });

  it("refuses a condition on the facet inside or, at any depth below it", () => {
    expectRefusedOnFilter({ type: "or", nodes: [done, flagged] }, status);
    expectRefusedOnFilter({ type: "and", nodes: [flagged, { type: "or", nodes: [dated, done] }] }, status);
    expectRefusedOnFilter({ type: "or", nodes: [flagged, { type: "and", nodes: [dated, done] }] }, status);
  });

  it("refuses a condition on the facet inside not, at any depth below it", () => {
    expectRefusedOnFilter({ type: "not", node: done }, status);
    expectRefusedOnFilter({ type: "and", nodes: [flagged, { type: "not", node: done }] }, status);
    expectRefusedOnFilter({ type: "not", node: { type: "and", nodes: [flagged, done] } }, status);
  });

  it("keeps an or and a not that do not name the facet as they are", () => {
    const either: FilterNode = { type: "or", nodes: [flagged, dated] };
    const neither: FilterNode = { type: "not", node: flagged };
    expect(excludeFacetConditions(either, status)).toBe(either);
    expect(excludeFacetConditions(neither, status)).toBe(neither);
    expect(excludeFacetConditions({ type: "and", nodes: [done, either, neither] }, status)).toEqual({
      type: "and",
      nodes: [either, neither],
    });
  });

  it("removes for a path facet the conditions on the same path, and no condition on another path or on a property", () => {
    const reversed: FilterNode = { type: "relation_path_contains", path: ["area", "project"], value: areaId };
    const otherSecond: FilterNode = { type: "relation_path_contains", path: ["project", "company"], value: areaId };
    const otherFirst: FilterNode = { type: "relation_path_contains", path: ["event", "area"], value: areaId };
    const onProject: FilterNode = { type: "relation_is_empty", property: "project" };
    const filter: FilterNode = { type: "and", nodes: [inArea, reversed, otherSecond, otherFirst, onProject, done] };
    expect(excludeFacetConditions(filter, projectArea)).toEqual({
      type: "and",
      nodes: [reversed, otherSecond, otherFirst, onProject, done],
    });
    expect(excludeFacetConditions(inArea, projectArea)).toBeUndefined();
    expectRefusedOnFilter({ type: "or", nodes: [inArea, done] }, projectArea);
    expectRefusedOnFilter({ type: "not", node: inArea }, projectArea);
  });

  it("keeps a path condition for the property facet of its first relation, also inside or", () => {
    const project: FacetTarget = { kind: "property", key: "project" };
    const either: FilterNode = { type: "or", nodes: [inArea, done] };
    expect(excludeFacetConditions(inArea, project)).toBe(inArea);
    expect(excludeFacetConditions(either, project)).toBe(either);
  });

  it("takes a relative-date condition as a condition on its start property only", () => {
    const interval: FilterNode = { type: "date_relative", property: "date", endProperty: "endDate", preset: "today" };
    expect(excludeFacetConditions(interval, { kind: "property", key: "date" })).toBeUndefined();
    expect(excludeFacetConditions(interval, { kind: "property", key: "endDate" })).toBe(interval);
  });
});

describe("loadFacetMetadata (issue #1759)", () => {
  beforeEach(() => {
    loadFullModuleRegistry.mockReset();
  });

  it("retries after a failed manifest load, then keeps the loaded metadata for the process", async () => {
    const actual = await vi.importActual<typeof import("../manifest/fullModuleRegistry.js")>(
      "../manifest/fullModuleRegistry.js",
    );
    loadFullModuleRegistry
      .mockRejectedValueOnce(new Error("manifest load failed"))
      .mockImplementation(actual.loadFullModuleRegistry);

    await expect(loadFacetMetadata()).rejects.toThrow("manifest load failed");
    const metadata = await loadFacetMetadata();
    expect(loadFullModuleRegistry).toHaveBeenCalledTimes(2);

    // The declared area filters of the system databases, by database key.
    expect(metadata.areaFilters.get("tasks")).toEqual({
      type: "relation_path_contains",
      path: ["project", "area"],
      value: { areaValue: true },
    });
    expect(metadata.areaFilters.get("projects")).toEqual({
      type: "relation_contains",
      property: "area",
      value: { areaValue: true },
    });
    expect(metadata.areaFilters.has("people")).toBe(false);
    const catalogs = await metadata.catalogResolver.getCatalogsForDbKey("projects");
    expect(catalogs?.en["property.projects.status.option.inProgress"]).toBe("In progress");

    expect(await loadFacetMetadata()).toBe(metadata);
    expect(loadFullModuleRegistry).toHaveBeenCalledTimes(2);
  });
});
