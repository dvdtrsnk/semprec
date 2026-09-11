import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkModuleBoundaries, type BoundaryViolation } from "../index.js";

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("checkModuleBoundaries", () => {
  it("rejects a module reaching into another module's internals", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const importers = violations.map((violation: BoundaryViolation) => violation.importer);

    expect(importers).toContain("modules/beta/src/badImport.ts");
    const violation = violations.find((v: BoundaryViolation) => v.importer === "modules/beta/src/badImport.ts");
    expect(violation?.imported).toBe("modules/alpha/src/internal.ts");
    expect(violation?.rules).toContain("no-module-service-internal-cross-import");
  });

  it("rejects a service reaching into another service's internals", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find((v: BoundaryViolation) => v.importer === "services/svcB/src/badImport.ts");

    expect(violation?.imported).toBe("services/svcA/src/internal.ts");
    expect(violation?.rules).toContain("no-module-service-internal-cross-import");
  });

  it("rejects a module reaching into a service's internals", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find(
      (v: BoundaryViolation) => v.importer === "modules/beta/src/badCrossCategoryImport.ts",
    );

    expect(violation?.imported).toBe("services/svcA/src/internal.ts");
    expect(violation?.rules).toContain("no-module-service-internal-cross-import");
  });

  it("rejects a service reaching into a module's internals", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find((v: BoundaryViolation) => v.importer === "services/svcB/src/badModuleImport.ts");

    expect(violation?.imported).toBe("modules/alpha/src/internal.ts");
    expect(violation?.rules).toContain("no-module-service-internal-cross-import");
  });

  it("allows imports of another module's or service's public entry point", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const importers = violations.map((violation: BoundaryViolation) => violation.importer);

    expect(importers).not.toContain("modules/beta/src/goodImport.ts");
    expect(importers).not.toContain("services/svcB/src/goodImport.ts");
    expect(importers).not.toContain("modules/beta/src/usesServicePublicEntry.ts");
  });

  it("allows a module reaching into its own internals", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const importers = violations.map((violation: BoundaryViolation) => violation.importer);

    expect(importers).not.toContain("modules/alpha/src/usesOwnInternal.ts");
  });

  it("allows importing a neutral shared package", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const importers = violations.map((violation: BoundaryViolation) => violation.importer);

    expect(importers).not.toContain("modules/beta/src/usesShared.ts");
  });

  it("reports exactly the deliberate violations, naming importer, imported path, and rule", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);

    expect(violations).toEqual(
      expect.arrayContaining([
        {
          importer: "modules/beta/src/badImport.ts",
          imported: "modules/alpha/src/internal.ts",
          rules: ["no-module-service-internal-cross-import"],
        },
        {
          importer: "services/svcB/src/badImport.ts",
          imported: "services/svcA/src/internal.ts",
          rules: ["no-module-service-internal-cross-import"],
        },
        {
          importer: "modules/beta/src/badCrossCategoryImport.ts",
          imported: "services/svcA/src/internal.ts",
          rules: ["no-module-service-internal-cross-import"],
        },
        {
          importer: "services/svcB/src/badModuleImport.ts",
          imported: "modules/alpha/src/internal.ts",
          rules: ["no-module-service-internal-cross-import"],
        },
        {
          importer: "modules/beta/src/badCoreTableWrite.ts",
          imported: "packages/data/src/chokePoint/itemsStore.ts",
          rules: ["no-core-table-write-outside-choke-point"],
        },
      ]),
    );
    expect(violations).toHaveLength(5);
  });

  it("rejects a route handler or module importing a core-table write-capable store directly (issue #154)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find((v: BoundaryViolation) => v.importer === "modules/beta/src/badCoreTableWrite.ts");

    expect(violation?.imported).toBe("packages/data/src/chokePoint/itemsStore.ts");
    expect(violation?.rules).toContain("no-core-table-write-outside-choke-point");
  });

  it("lets the choke-point package itself import its own write-capable store (issue #154)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const importers = violations.map((violation: BoundaryViolation) => violation.importer);

    expect(importers).not.toContain("packages/data/src/chokePoint/usesOwnStore.ts");
  });
});
