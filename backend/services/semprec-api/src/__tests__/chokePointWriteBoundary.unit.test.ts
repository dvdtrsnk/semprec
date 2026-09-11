import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkModuleBoundaries } from "@semprec/module-boundaries";
import { ROUTE_MATRIX } from "../routeMatrix.js";

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

/**
 * Issue #154: every route this service and the ModuleRegistry manifest it mounts (#239) register
 * is dispatched from `app.ts` into a handler under `src/`, which reaches `items`/`databases`/
 * `properties` only by calling into `@semprec/data`'s choke-point (`createChokePoint` and its
 * individually re-exported functions) — never by importing the write-capable stores that back it
 * directly. `dependency-cruiser.rules.json`'s `no-core-table-write-outside-choke-point` rule
 * (enforced fixture-level in `@semprec/module-boundaries`) makes that structurally impossible; this
 * test runs the same rule against the real adapter, choke-point, and module-registry source instead
 * of a fixture, so a handler that bypasses the choke-point fails here, not just in code review.
 */
describe("choke-point write boundary for route handlers (issue #154)", () => {
  it("has at least one registered route to guard", () => {
    expect(ROUTE_MATRIX.filter((route) => route.surface === "api").length).toBeGreaterThan(0);
  });

  it(
    "keeps every handler reachable from this service's dispatcher free of direct core-table writes",
    async () => {
      const { violations } = await checkModuleBoundaries(backendRoot, [
        "services/semprec-api",
        "packages/data",
        "packages/module-registry",
      ]);
      const writeBoundaryViolations = violations.filter((violation) =>
        violation.rules.includes("no-core-table-write-outside-choke-point"),
      );

      expect(writeBoundaryViolations).toEqual([]);
    },
    30_000,
  );

  it(
    "does not itself flag the choke-point package's own writes to items/databases/properties",
    async () => {
      const { violations } = await checkModuleBoundaries(backendRoot, ["packages/data"]);
      const writeBoundaryViolations = violations.filter((violation) =>
        violation.rules.includes("no-core-table-write-outside-choke-point"),
      );

      expect(writeBoundaryViolations).toEqual([]);
    },
    30_000,
  );
});
