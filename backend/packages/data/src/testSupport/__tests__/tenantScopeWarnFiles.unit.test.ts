import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The shrink-only list of the integration test files that still run under `SEMPREC_TENANT_SCOPE=warn`
 * (`tenantScopeWarnFiles.json`, selected per file by `tenantScopeMode.ts`). The list may lose entries when a file
 * is converted to strict; it can gain none, because every entry must also be in `tenantScopeWarnFiles.frozen.json`,
 * whose hash is pinned below, and a new test file must not switch the mode to `warn` for itself.
 */

const backendDirectory = fileURLToPath(new URL("../../../../../", import.meta.url));
const testSupportDirectory = fileURLToPath(new URL("../", import.meta.url));

/** SHA-256 of `tenantScopeWarnFiles.frozen.json`, the byte copy of the first list. Never update it. */
const FROZEN_LIST_SHA256 = "a097f515c543d126420c86f40c2e7b68c98a22f3dc9a6f2965758d5eca7d67b6";

/** The test files of the source that introduced the list; none of them may be listed. */
const OWN_NEW_TEST_FILES: readonly string[] = [
  "packages/data/src/testSupport/__tests__/tenantScopeModeDefault.test.ts",
  "packages/data/src/testSupport/__tests__/tenantScopeMode.unit.test.ts",
  "packages/data/src/testSupport/__tests__/tenantScopeWarnFiles.unit.test.ts",
];

/**
 * The first set of the integration test files that mention `SEMPREC_TENANT_SCOPE` together with `"warn"`: the
 * scope-mode suites that switch the mode themselves, and files that name the string for another reason. Never edit
 * it. `FROZEN_SCOPE_MODE_SUITES` must stay a subset of it and its hash is pinned below, so an entry cannot be added
 * to the live set without changing this one and the hash, the way the list is pinned through its frozen file.
 */
const FIRST_SCOPE_MODE_SUITES: readonly string[] = [
  "packages/data/src/__tests__/runtimeRoleAssertion.test.ts",
  "packages/data/src/__tests__/strictTenantEnforcement.test.ts",
  "packages/data/src/__tests__/tenantScopePool.test.ts",
  "services/semprec-agents/src/__tests__/agentsTenantScope.test.ts",
  "services/semprec-api/src/__tests__/adapterTenantScope.test.ts",
  "services/semprec-api/src/__tests__/bespokeListenerTenantScope.test.ts",
  "services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts",
  "services/semprec-transcribe/src/transcriptionTenantScope.test.ts",
];

/** SHA-256 of `FIRST_SCOPE_MODE_SUITES` joined by newlines, with a trailing newline. Never update it. */
const FIRST_SCOPE_MODE_SUITES_SHA256 = "0eff7a82ad1e27204129bc8f793e8f4af799aa0cbe08517a169ddf5751d1ad25";

/**
 * The integration test files that are allowed to mention `SEMPREC_TENANT_SCOPE` together with `"warn"`. The set
 * only shrinks: remove a file here when it stops matching, and never add one (see `FIRST_SCOPE_MODE_SUITES`).
 */
const FROZEN_SCOPE_MODE_SUITES: readonly string[] = [
  "packages/data/src/__tests__/runtimeRoleAssertion.test.ts",
  "packages/data/src/__tests__/strictTenantEnforcement.test.ts",
  "packages/data/src/__tests__/tenantScopePool.test.ts",
  "services/semprec-agents/src/__tests__/agentsTenantScope.test.ts",
  "services/semprec-api/src/__tests__/adapterTenantScope.test.ts",
  "services/semprec-api/src/__tests__/bespokeListenerTenantScope.test.ts",
  "services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts",
  "services/semprec-transcribe/src/transcriptionTenantScope.test.ts",
];

/** Parses one of the two list files; the file is a boundary, so each entry is checked instead of cast. */
function readList(fileName: string): string[] {
  const parsed: unknown = JSON.parse(readFileSync(path.join(testSupportDirectory, fileName), "utf8"));
  if (!Array.isArray(parsed)) throw new Error(`${fileName} is not a JSON array`);
  return parsed.map((entry: unknown) => {
    if (typeof entry !== "string") throw new Error(`${fileName} holds a non-string entry`);
    return entry;
  });
}

/**
 * Every file the integration tier runs: `vitest.integration.config.ts` includes `packages/*\/src/**\/*.test.ts` and
 * `services/*\/src/**\/*.test.ts` and excludes `*.unit.test.ts`, `*.e2e.test.ts` and `node_modules`/`dist`
 * (the first test below pins the patterns this walk implements).
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
    expect(config).toContain('setupFiles: ["./packages/data/src/testSupport/tenantScopeMode.ts"]');
    expect(config).toContain("provide: { explicitTenantScopeMode: process.env.SEMPREC_TENANT_SCOPE ?? null }");
  });

  it("keeps the e2e tier on warn", () => {
    const config = readFileSync(path.join(backendDirectory, "vitest.e2e.config.ts"), "utf8");
    expect(config).toContain('SEMPREC_TENANT_SCOPE: process.env.SEMPREC_TENANT_SCOPE ?? "warn"');
    expect(config).not.toContain("setupFiles");
  });

  it("walks the files the tier runs, test files of the source included", () => {
    const files = integrationTestFiles();
    expect(files).toContain("packages/data/src/testSupport/__tests__/tenantScopeModeDefault.test.ts");
    expect(files).toContain("services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts");
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
    return text.includes("SEMPREC_TENANT_SCOPE") && text.includes('"warn"');
  });

  it("are only the frozen scope-mode suites", () => {
    expect(matching.filter((file) => !FROZEN_SCOPE_MODE_SUITES.includes(file))).toEqual([]);
  });

  it("are all still among them, so a converted suite leaves the frozen set", () => {
    expect(FROZEN_SCOPE_MODE_SUITES.filter((file) => !matching.includes(file))).toEqual([]);
  });
});
