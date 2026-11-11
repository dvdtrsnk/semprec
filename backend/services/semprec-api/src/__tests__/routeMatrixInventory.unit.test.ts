import { describe, expect, it } from "vitest";
import { ROUTE_MATRIX, type RouteMatrixEntry } from "../routeMatrix.js";

/** Every value of `key` that two or more of `entries` share, each reported once, in the order of its first repeat. */
function sharedValues(entries: readonly RouteMatrixEntry[], key: (entry: RouteMatrixEntry) => string): string[] {
  const seen = new Set<string>();
  const shared = new Set<string>();
  for (const entry of entries) {
    const value = key(entry);
    if (seen.has(value)) shared.add(value);
    seen.add(value);
  }
  return [...shared];
}

function sharedNames(entries: readonly RouteMatrixEntry[]): string[] {
  return sharedValues(entries, (entry) => entry.name);
}

function sharedMethodPathPairs(entries: readonly RouteMatrixEntry[]): string[] {
  return sharedValues(entries, (entry) => `${entry.method} ${entry.path}`);
}

function entry(name: string, method: string, path: string): RouteMatrixEntry {
  return { name, method, path, surface: "api", public: false, tenancy: "tenant" };
}

describe("route matrix inventory", () => {
  it("reports every name that two entries share", () => {
    const entries = [
      entry("list examples", "GET", "/api/examples"),
      entry("create example", "POST", "/api/examples"),
      entry("list examples", "GET", "/api/examples/archived"),
      entry("delete example", "DELETE", "/api/examples/1"),
      entry("delete example", "DELETE", "/api/examples/2"),
      entry("list examples", "GET", "/api/examples/recent"),
    ];

    expect(sharedNames(entries)).toEqual(["list examples", "delete example"]);
    expect(sharedMethodPathPairs(entries)).toEqual([]);
  });

  it("reports every method plus path pair that two entries share", () => {
    const entries = [
      entry("list examples", "GET", "/api/examples"),
      entry("create example", "POST", "/api/examples"),
      entry("list examples again", "GET", "/api/examples"),
      entry("delete example", "DELETE", "/api/examples/1"),
      entry("remove example", "DELETE", "/api/examples/1"),
      entry("list examples once more", "GET", "/api/examples"),
    ];

    expect(sharedMethodPathPairs(entries)).toEqual(["GET /api/examples", "DELETE /api/examples/1"]);
    expect(sharedNames(entries)).toEqual([]);
  });

  it("reports nothing when only a method or only a path repeats", () => {
    const entries = [
      entry("list examples", "GET", "/api/examples"),
      entry("create example", "POST", "/api/examples"),
      entry("example detail", "GET", "/api/examples/1"),
    ];

    expect(sharedNames(entries)).toEqual([]);
    expect(sharedMethodPathPairs(entries)).toEqual([]);
  });

  it("has no name that two ROUTE_MATRIX entries share", () => {
    expect(sharedNames(ROUTE_MATRIX)).toEqual([]);
  });

  it("has no method plus path pair that two ROUTE_MATRIX entries share", () => {
    expect(sharedMethodPathPairs(ROUTE_MATRIX)).toEqual([]);
  });
});
