import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pins the warn list as shrink-only: every entry must also be in `tenantScopeWarnFiles.frozen.json` (hash pinned),
 * and no new test file may switch itself to `warn`.
 */

const backendDirectory = fileURLToPath(new URL("../../../../../", import.meta.url));
const testSupportDirectory = fileURLToPath(new URL("../", import.meta.url));

/** SHA-256 of `tenantScopeWarnFiles.frozen.json`. Never update it. */
const FROZEN_LIST_SHA256 = "bc79eb0c43bfcddc7014945f6d180e9843949c55fa00bd2ea4e333bbafb4fb60";

/** None of these may be listed. */
const OWN_NEW_TEST_FILES: readonly string[] = [
  "packages/data/src/testSupport/__tests__/tenantScopeModeDefault.test.ts",
  "packages/data/src/testSupport/__tests__/tenantScopeMode.unit.test.ts",
  "packages/data/src/testSupport/__tests__/tenantScopeWarnFiles.unit.test.ts",
];

/**
 * The original set of integration files mentioning `ALLDOTS_TENANT_SCOPE` with `"warn"`. Never edit it; its hash
 * is pinned so `FROZEN_SCOPE_MODE_SUITES` (a subset) cannot grow.
 */
const FIRST_SCOPE_MODE_SUITES: readonly string[] = [
  "packages/data/src/__tests__/runtimeRoleAssertion.test.ts",
  "packages/data/src/__tests__/strictTenantEnforcement.test.ts",
  "packages/data/src/__tests__/tenantScopePool.test.ts",
  "services/alldots-agents/src/__tests__/agentsTenantScope.test.ts",
  "services/alldots-api/src/__tests__/adapterTenantScope.test.ts",
  "services/alldots-api/src/__tests__/bespokeListenerTenantScope.test.ts",
  "services/alldots-api/src/__tests__/tenantIsolationRoutes.test.ts",
  "services/alldots-transcribe/src/transcriptionTenantScope.test.ts",
];

/** SHA-256 of `FIRST_SCOPE_MODE_SUITES`, newline-joined with a trailing newline. Never update it. */
const FIRST_SCOPE_MODE_SUITES_SHA256 = "22ba46e967ac21d5e5dc3f951e4af3f649472180e1b5cf093bd626c5f79b6b8d";

/** Files allowed to mention `ALLDOTS_TENANT_SCOPE` with `"warn"`. Only shrinks. */
const FROZEN_SCOPE_MODE_SUITES: readonly string[] = [
  "packages/data/src/__tests__/runtimeRoleAssertion.test.ts",
  "packages/data/src/__tests__/strictTenantEnforcement.test.ts",
  "packages/data/src/__tests__/tenantScopePool.test.ts",
  "services/alldots-agents/src/__tests__/agentsTenantScope.test.ts",
  "services/alldots-api/src/__tests__/adapterTenantScope.test.ts",
  "services/alldots-api/src/__tests__/bespokeListenerTenantScope.test.ts",
  "services/alldots-api/src/__tests__/tenantIsolationRoutes.test.ts",
  "services/alldots-transcribe/src/transcriptionTenantScope.test.ts",
];

/** The file is a boundary, so each entry is checked instead of cast. */
function readList(fileName: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(path.join(testSupportDirectory, fileName), "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${fileName} is not a JSON array`);
  return parsed.map((entry: unknown) => {
    if (typeof entry !== "string") throw new Error(`${fileName} holds a non-string entry`);
    return entry;
  });
}

/**
 * Mirrors `vitest.integration.config.ts`'s include/exclude patterns (pinned by the first test below).
 */
function integrationTestFiles(): string[] {
  const found: string[] = [];
  for (const group of ["packages", "services"]) {
    for (const entry of readdirSync(path.join(backendDirectory, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourceDirectory = path.join(backendDirectory, group, entry.name, "src");
      if (!existsSync(sourceDirectory)) continue;
      for (const relativeToSource of readdirSync(sourceDirectory, { recursive: true, encoding: "utf8" })) {
        const parts = relativeToSource.split(path.sep);
        if (parts.includes("node_modules") || parts.includes("dist")) continue;
        if (!relativeToSource.endsWith(".test.ts")) continue;
        if (relativeToSource.endsWith(".unit.test.ts") || relativeToSource.endsWith(".e2e.test.ts")) continue;
        found.push([group, entry.name, "src", ...parts].join("/"));
      }
    }
  }
  return found.sort();
}

describe("the integration tier's selection of test files", () => {
  it("is the one this file walks", () => {
    const config = readFileSync(path.join(backendDirectory, "vitest.integration.config.ts"), "utf8");
    expect(config).toContain('include: ["packages/*/src/**/*.test.ts", "services/*/src/**/*.test.ts"]');
    expect(config).toContain('"**/*.unit.test.ts", "**/*.e2e.test.ts"');
    expect(config).toMatch(/setupFiles: \[[^\]]*"\.\/packages\/data\/src\/testSupport\/tenantScopeMode\.ts"/);
    expect(config).toContain("provide: { explicitTenantScopeMode: process.env.ALLDOTS_TENANT_SCOPE ?? null }");
  });

  it("keeps the e2e tier on warn", () => {
    const config = readFileSync(path.join(backendDirectory, "vitest.e2e.config.ts"), "utf8");
    expect(config).toContain('ALLDOTS_TENANT_SCOPE: process.env.ALLDOTS_TENANT_SCOPE ?? "warn"');
    expect(config).not.toContain("setupFiles");
  });

  it("walks the files the tier runs, test files of the source included", () => {
    const files = integrationTestFiles();
    expect(files).toContain("packages/data/src/testSupport/__tests__/tenantScopeModeDefault.test.ts");
    expect(files).toContain("services/alldots-api/src/__tests__/tenantIsolationRoutes.test.ts");
    expect(files).not.toContain("packages/data/src/testSupport/__tests__/tenantScopeWarnFiles.unit.test.ts");
    expect(files).not.toContain("packages/e2e/src/__tests__/nativeEntrypoints.e2e.test.ts");
  });
});

describe("tenantScopeWarnFiles.json", () => {
  const list = readList("tenantScopeWarnFiles.json");
  const integrationFiles = new Set(integrationTestFiles());

  it("is sorted", () => {
    expect(list).toEqual([...list].sort());
  });

  it("has no duplicate", () => {
    expect(list.filter((entry, index) => list.indexOf(entry) !== index)).toEqual([]);
  });

  it("names only files that exist", () => {
    expect(list.filter((entry) => !existsSync(path.join(backendDirectory, entry)))).toEqual([]);
  });

  it("names only integration test files", () => {
    expect(list.filter((entry) => !integrationFiles.has(entry))).toEqual([]);
  });

  it("names none of the test files of the source that introduced it", () => {
    expect(list.filter((entry) => OWN_NEW_TEST_FILES.includes(entry))).toEqual([]);
  });

  it("holds only entries of the frozen first list", () => {
    const frozen = new Set(readList("tenantScopeWarnFiles.frozen.json"));
    expect(list.filter((entry) => !frozen.has(entry))).toEqual([]);
  });
});

describe("tenantScopeWarnFiles.frozen.json", () => {
  it("is unchanged since it was committed", () => {
    const bytes = readFileSync(path.join(testSupportDirectory, "tenantScopeWarnFiles.frozen.json"));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(FROZEN_LIST_SHA256);
  });
});

describe("the set of frozen scope-mode suites", () => {
  it("is sorted and has no duplicate", () => {
    expect(FROZEN_SCOPE_MODE_SUITES).toEqual([...new Set(FROZEN_SCOPE_MODE_SUITES)].sort());
  });

  it("holds only entries of the first set", () => {
    expect(FROZEN_SCOPE_MODE_SUITES.filter((file) => !FIRST_SCOPE_MODE_SUITES.includes(file))).toEqual([]);
  });

  it("has a first set that is unchanged since it was committed", () => {
    const digest = createHash("sha256")
      .update(FIRST_SCOPE_MODE_SUITES.map((file) => `${file}\n`).join(""))
      .digest("hex");
    expect(digest).toBe(FIRST_SCOPE_MODE_SUITES_SHA256);
  });
});

describe("the integration test files that switch the mode to warn themselves", () => {
  const matching = integrationTestFiles().filter((file) => {
    const text = readFileSync(path.join(backendDirectory, file), "utf8");
    return text.includes("ALLDOTS_TENANT_SCOPE") && text.includes('"warn"');
  });

  it("are only the frozen scope-mode suites", () => {
    expect(matching.filter((file) => !FROZEN_SCOPE_MODE_SUITES.includes(file))).toEqual([]);
  });

  it("are all still among them, so a converted suite leaves the frozen set", () => {
    expect(FROZEN_SCOPE_MODE_SUITES.filter((file) => !matching.includes(file))).toEqual([]);
  });
});
