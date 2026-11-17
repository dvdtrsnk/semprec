import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  createCollectionMetadataResolver,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  resolveModuleRuleKinds,
  type PasswordResetMailer,
} from "@semprec/data";
import { createGenericApplicationService } from "@semprec/application";
import { createResourceRouteDefinitions, type AppOptions } from "../app.js";
import { ROUTE_MATRIX, type RouteMatrixEntry } from "../routeMatrix.js";

interface MountedRoute {
  method: string;
  path: string;
}

/** As in `adapterTenantScope.test.ts`: a `:param` segment is one non-empty segment. */
function pathPatternToRegExp(path: string): RegExp {
  const source = path
    .split("/")
    .map((segment) => (segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}$`);
}

/** Routes with no `surface: "api"` matrix entry of the same method whose path, query removed, matches. */
function findUnmatchedRoutes(
  definitions: readonly MountedRoute[],
  matrix: readonly RouteMatrixEntry[],
): MountedRoute[] {
  const apiEntries = matrix.filter((entry) => entry.surface === "api");
  return definitions
    .filter((definition) => {
      const pattern = pathPatternToRegExp(definition.path);
      return !apiEntries.some((entry) => entry.method === definition.method && pattern.test(entry.path.split("?")[0]!));
    })
    .map(({ method, path }) => ({ method, path }));
}

function entry(method: string, path: string, surface: RouteMatrixEntry["surface"] = "api"): RouteMatrixEntry {
  return { name: `${method} ${path}`, method, path, surface, public: false, tenancy: "tenant" };
}

describe("findUnmatchedRoutes", () => {
  it("does not report a definition that has a matching entry", () => {
    expect(findUnmatchedRoutes([{ method: "GET", path: "/api/x/:id" }], [entry("GET", "/api/x/1")])).toEqual([]);
  });

  it("matches a literal definition and an entry that carries a query string", () => {
    expect(findUnmatchedRoutes([{ method: "GET", path: "/api/x" }], [entry("GET", "/api/x?limit=1")])).toEqual([]);
  });

  it("reports a definition that has no entry, and only that one", () => {
    const definitions = [
      { method: "GET", path: "/api/x/:id" },
      { method: "GET", path: "/api/y" },
    ];

    expect(findUnmatchedRoutes(definitions, [entry("GET", "/api/x/1")])).toEqual([{ method: "GET", path: "/api/y" }]);
  });

  it("does not let an entry with another method match", () => {
    expect(findUnmatchedRoutes([{ method: "GET", path: "/api/x" }], [entry("POST", "/api/x")])).toEqual([
      { method: "GET", path: "/api/x" },
    ]);
  });

  it("does not let a surface view entry match", () => {
    expect(findUnmatchedRoutes([{ method: "GET", path: "/api/x" }], [entry("GET", "/api/x", "view")])).toEqual([
      { method: "GET", path: "/api/x" },
    ]);
  });

  it("does not let a surface ws entry match", () => {
    expect(findUnmatchedRoutes([{ method: "GET", path: "/api/x" }], [entry("GET", "/api/x", "ws")])).toEqual([
      { method: "GET", path: "/api/x" },
    ]);
  });

  it("does not let a parameter segment match more than one segment", () => {
    expect(findUnmatchedRoutes([{ method: "GET", path: "/api/x/:id" }], [entry("GET", "/api/x/1/y")])).toEqual([
      { method: "GET", path: "/api/x/:id" },
    ]);
  });

  it("does not let a parameter segment match an empty segment", () => {
    expect(findUnmatchedRoutes([{ method: "GET", path: "/api/x/:id" }], [entry("GET", "/api/x/")])).toEqual([
      { method: "GET", path: "/api/x/:id" },
    ]);
  });

  it("does not let a literal segment match a different segment", () => {
    expect(findUnmatchedRoutes([{ method: "GET", path: "/api/x/:id/y" }], [entry("GET", "/api/x/1/z")])).toEqual([
      { method: "GET", path: "/api/x/:id/y" },
    ]);
  });
});

describe("ROUTE_MATRIX coverage of the mounted routes", () => {
  const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
  const pool = new Pool();
  let customRoutes: MountedRoute[];
  let resourceRoutes: MountedRoute[];

  beforeAll(async () => {
    const moduleRegistry = await loadFullModuleRegistry();
    const options: AppOptions = {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: "route-matrix-coverage-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), "semprec-route-matrix-coverage-unused")),
      maxFileSizeBytes: 1024,
    };
    const resolver = await createCollectionMetadataResolver(moduleRegistry);
    customRoutes = await moduleRegistry.getCustomRouteDefinitions();
    resourceRoutes = createResourceRouteDefinitions(
      pool,
      options,
      () => resolveModuleRuleKinds(moduleRegistry),
      createGenericApplicationService(pool, resolver),
      resolver,
    );
  });

  afterAll(async () => {
    await pool.end();
  });

  it("collects module custom routes and resource routes", () => {
    expect(customRoutes.length).toBeGreaterThan(0);
    expect(resourceRoutes.length).toBeGreaterThan(0);
  });

  it("has a surface api entry for every mounted module custom route and resource route", () => {
    expect(findUnmatchedRoutes([...customRoutes, ...resourceRoutes], ROUTE_MATRIX)).toEqual([]);
  });

  it("names a module custom route whose entry is missing", () => {
    const route = customRoutes[0]!;
    const withoutEntry = ROUTE_MATRIX.filter(
      (candidate) => !(candidate.method === route.method && pathPatternToRegExp(route.path).test(candidate.path)),
    );

    expect(findUnmatchedRoutes([...customRoutes, ...resourceRoutes], withoutEntry)).toContainEqual({
      method: route.method,
      path: route.path,
    });
  });

  it("names a resource route whose entry is missing", () => {
    const route = resourceRoutes[0]!;
    const withoutEntry = ROUTE_MATRIX.filter(
      (candidate) => !(candidate.method === route.method && pathPatternToRegExp(route.path).test(candidate.path)),
    );

    expect(findUnmatchedRoutes([...customRoutes, ...resourceRoutes], withoutEntry)).toContainEqual({
      method: route.method,
      path: route.path,
    });
  });
});
