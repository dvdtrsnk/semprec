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
    expect(violation?.rules).toContain("no-module-to-module");
  });

  it("rejects a service reaching into another service's internals", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find((v: BoundaryViolation) => v.importer === "services/svcB/src/badImport.ts");

    expect(violation?.imported).toBe("services/svcA/src/internal.ts");
    expect(violation?.rules).toContain("no-service-to-service");
  });

  it("rejects a service importing another service's public entry point (issue #173: no imports across the service boundary at all)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find(
      (v: BoundaryViolation) => v.importer === "services/svcB/src/badServiceEntryImport.ts",
    );

    expect(violation?.imported).toBe("services/svcA/src/index.ts");
    expect(violation?.rules).toContain("no-service-to-service");
  });

  it("rejects a module reaching into a service's internals", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find(
      (v: BoundaryViolation) => v.importer === "modules/beta/src/badCrossCategoryImport.ts",
    );

    expect(violation?.imported).toBe("services/svcA/src/internal.ts");
    expect(violation?.rules).toContain("no-module-to-service");
  });

  it("rejects a service reaching into a module's internals", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find((v: BoundaryViolation) => v.importer === "services/svcB/src/badModuleImport.ts");

    expect(violation?.imported).toBe("modules/alpha/src/internal.ts");
    expect(violation?.rules).toContain("no-service-to-module");
  });

  it("rejects a module importing a service's public entry point (issue #173: no imports across the service boundary at all)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find(
      (v: BoundaryViolation) => v.importer === "modules/beta/src/usesServicePublicEntry.ts",
    );

    expect(violation?.imported).toBe("services/svcA/src/index.ts");
    expect(violation?.rules).toContain("no-module-to-service");
  });

  it("allows imports of another module's public entry point", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const importers = violations.map((violation: BoundaryViolation) => violation.importer);

    expect(importers).not.toContain("modules/beta/src/goodImport.ts");
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

  it.each([
    ["itemsStore.ts", "modules/beta/src/badCoreTableWrite.ts", "packages/data/src/chokePoint/itemsStore.ts"],
    [
      "databasesStore.ts",
      "modules/beta/src/badCoreTableWriteDatabases.ts",
      "packages/data/src/chokePoint/databasesStore.ts",
    ],
    [
      "propertiesStore.ts",
      "modules/beta/src/badCoreTableWriteProperties.ts",
      "packages/data/src/chokePoint/propertiesStore.ts",
    ],
  ])("rejects a route handler or module importing %s directly (issue #154)", async (_storeName, importer, imported) => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find((v: BoundaryViolation) => v.importer === importer);

    expect(violation?.imported).toBe(imported);
    expect(violation?.rules).toContain("no-core-table-write-outside-choke-point");
  });

  it("lets the choke-point package itself import its own write-capable store (issue #154)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const importers = violations.map((violation: BoundaryViolation) => violation.importer);

    expect(importers).not.toContain("packages/data/src/chokePoint/usesOwnStore.ts");
  });

  it("rejects a core package importing module code (issue #173: core-knows-nobody)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find(
      (v: BoundaryViolation) => v.importer === "packages/shared/src/badModuleImport.ts",
    );

    expect(violation?.imported).toBe("modules/alpha/src/index.ts");
    expect(violation?.rules).toContain("core-knows-nobody");
  });

  it("rejects a core package importing service code (issue #173: core-knows-nobody)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find(
      (v: BoundaryViolation) => v.importer === "packages/shared/src/badServiceImport.ts",
    );

    expect(violation?.imported).toBe("services/svcA/src/index.ts");
    expect(violation?.rules).toContain("core-knows-nobody");
  });

  it("rejects code outside agent-runtime importing pi-agent-core directly (issue #173: pi-only-in-agent-runtime)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find((v: BoundaryViolation) => v.importer === "packages/shared/src/badPiImport.ts");

    expect(violation?.imported).toContain("node_modules/@earendil-works/pi-agent-core");
    expect(violation?.rules).toContain("pi-only-in-agent-runtime");
  });

  it("lets packages/agent-runtime import pi-agent-core itself (issue #173: pi-only-in-agent-runtime)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const importers = violations.map((violation: BoundaryViolation) => violation.importer);

    expect(importers).not.toContain("packages/agent-runtime/src/__tests__/usesPiAgentCore.ts");
  });

  it("rejects a service other than semprec-agents importing agent-runtime (issue #173: agent-runtime-only-in-agents)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find(
      (v: BoundaryViolation) => v.importer === "services/svcB/src/badAgentRuntimeImport.ts",
    );

    expect(violation?.imported).toBe("packages/agent-runtime/src/index.ts");
    expect(violation?.rules).toContain("agent-runtime-only-in-agents");
  });

  it("lets services/semprec-agents import agent-runtime (issue #173: agent-runtime-only-in-agents)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const importers = violations.map((violation: BoundaryViolation) => violation.importer);

    expect(importers).not.toContain("services/semprec-agents/src/usesAgentRuntime.ts");
  });

  it("rejects a package reaching past another package's entry point (issue #173: no-deep-imports)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find(
      (v: BoundaryViolation) => v.importer === "packages/shared/src/badDeepPackageImport.ts",
    );

    expect(violation?.imported).toBe("packages/data/src/someOtherStore.ts");
    expect(violation?.rules).toContain("no-deep-imports");
  });

  it("rejects a module reaching past a package's entry point (issue #173: no-deep-imports)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find(
      (v: BoundaryViolation) => v.importer === "modules/beta/src/badDeepPackageImport.ts",
    );

    expect(violation?.imported).toBe("packages/data/src/someOtherStore.ts");
    expect(violation?.rules).toContain("no-deep-imports");
  });

  it("allows importing a package's testSupport secondary entry point (issue #173: no-deep-imports exempts the hardcoded testSupport/ path)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const importers = violations.map((violation: BoundaryViolation) => violation.importer);

    expect(importers).not.toContain("packages/shared/src/usesDataTestSupport.ts");
  });

  it("rejects code outside packages/data importing the item store (issue #173: items-store-private)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find((v: BoundaryViolation) => v.importer === "modules/beta/src/badCoreTableWrite.ts");

    expect(violation?.imported).toBe("packages/data/src/chokePoint/itemsStore.ts");
    expect(violation?.rules).toContain("items-store-private");
  });

  it("rejects a choke-point domain module importing another domain module (issue #496: no-choke-point-domain-cross-import)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find(
      (v: BoundaryViolation) => v.importer === "packages/data/src/chokePoint/databaseOps.ts",
    );

    expect(violation?.imported).toBe("packages/data/src/chokePoint/propertyOps.ts");
    expect(violation?.rules).toContain("no-choke-point-domain-cross-import");
  });

  it("lets a choke-point domain module import a shared module and a store (issue #496: no-choke-point-domain-cross-import)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const importers = violations.map((violation: BoundaryViolation) => violation.importer);

    expect(importers).not.toContain("packages/data/src/chokePoint/itemReads.ts");
  });

  it("rejects an import cycle between chokePoint/ and rollup/ (issue #497: no-choke-point-rollup-cycle)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const violation = violations.find(
      (v: BoundaryViolation) => v.importer === "packages/data/src/chokePoint/cycleWithRollup.ts",
    );

    expect(violation).toBeDefined();
    expect(violation?.imported).toBe("packages/data/src/rollup/cycleWithChokePoint.ts");
    expect(violation?.rules).toContain("no-choke-point-rollup-cycle");
  });

  it("lets a choke-point module import rollup code without a cycle (issue #497: no-choke-point-rollup-cycle)", async () => {
    const { violations } = await checkModuleBoundaries(fixturesDir, ["modules", "services", "packages"]);
    const importers = violations.map((violation: BoundaryViolation) => violation.importer);

    expect(importers).not.toContain("packages/data/src/chokePoint/usesRollup.ts");
  });
});
