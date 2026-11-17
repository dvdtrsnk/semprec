import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyTenantScopeMode, readTenantScopeWarnFiles, selectTenantScopeMode } from "../tenantScopeMode.js";

/**
 * Importing the module also runs it here, where `vitest.unit.config.ts` pins `SEMPREC_TENANT_SCOPE`, so the pinned
 * value stays; each case passes its own env object and leaves `process.env` alone.
 */

const backendDirectory = fileURLToPath(new URL("../../../../../", import.meta.url));
const LISTED = "services/semprec-api/src/__tests__/tenantIsolationRoutes.test.ts";
const UNLISTED = "packages/data/src/testSupport/__tests__/tenantScopeModeDefault.test.ts";
const warnFiles: ReadonlySet<string> = new Set([LISTED]);

function absolute(relative: string): string {
  return path.join(backendDirectory, relative);
}

describe("selectTenantScopeMode", () => {
  it("selects warn for a file on the list", () => {
    expect(selectTenantScopeMode(absolute(LISTED), warnFiles)).toBe("warn");
  });

  it("selects strict for a file that is not on the list", () => {
    expect(selectTenantScopeMode(absolute(UNLISTED), warnFiles)).toBe("strict");
  });

  it("selects strict for a file outside backend/, whose relative path cannot be on the list", () => {
    expect(selectTenantScopeMode(path.join(tmpdir(), "elsewhere.test.ts"), warnFiles)).toBe("strict");
  });

  it("fails when the running file is unknown", () => {
    expect(() => selectTenantScopeMode(undefined, warnFiles)).toThrow(/cannot determine the running test file/);
  });

  it("fails when the running file path is empty", () => {
    expect(() => selectTenantScopeMode("", warnFiles)).toThrow(/cannot determine the running test file/);
  });

  it("fails when the running file path is not absolute", () => {
    expect(() => selectTenantScopeMode(LISTED, warnFiles)).toThrow(/cannot determine the running test file/);
  });
});

describe("applyTenantScopeMode", () => {
  it("sets warn for a listed file", () => {
    const env: NodeJS.ProcessEnv = {};
    applyTenantScopeMode(env, absolute(LISTED), warnFiles);
    expect(env.SEMPREC_TENANT_SCOPE).toBe("warn");
  });

  it("sets strict for a file that is not listed", () => {
    const env: NodeJS.ProcessEnv = {};
    applyTenantScopeMode(env, absolute(UNLISTED), warnFiles);
    expect(env.SEMPREC_TENANT_SCOPE).toBe("strict");
  });

  it("keeps an explicit strict for a listed file", () => {
    const env: NodeJS.ProcessEnv = { SEMPREC_TENANT_SCOPE: "strict" };
    applyTenantScopeMode(env, absolute(LISTED), warnFiles);
    expect(env.SEMPREC_TENANT_SCOPE).toBe("strict");
  });

  it("keeps an explicit warn for a file that is not listed", () => {
    const env: NodeJS.ProcessEnv = { SEMPREC_TENANT_SCOPE: "warn" };
    applyTenantScopeMode(env, absolute(UNLISTED), warnFiles);
    expect(env.SEMPREC_TENANT_SCOPE).toBe("warn");
  });

  it("keeps an explicit override when the running file is unknown", () => {
    const env: NodeJS.ProcessEnv = { SEMPREC_TENANT_SCOPE: "warn" };
    applyTenantScopeMode(env, undefined, warnFiles);
    expect(env.SEMPREC_TENANT_SCOPE).toBe("warn");
  });

  it("sets nothing and fails when the running file is unknown and there is no override", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(() => applyTenantScopeMode(env, undefined, warnFiles)).toThrow(/cannot determine the running test file/);
    expect(env.SEMPREC_TENANT_SCOPE).toBeUndefined();
  });
});

describe("readTenantScopeWarnFiles", () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "tenant-scope-warn-files-"));
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  async function fileWith(name: string, content: string): Promise<URL> {
    const file = path.join(scratch, name);
    await writeFile(file, content);
    return pathToFileURL(file);
  }

  it("reads the committed list", () => {
    const files = readTenantScopeWarnFiles();
    expect(files.has(LISTED)).toBe(true);
    expect(files.has(UNLISTED)).toBe(false);
  });

  it("reads the entries of a list file as a set", async () => {
    const url = await fileWith("valid.json", JSON.stringify(["a.test.ts", "b.test.ts"]));
    expect([...readTenantScopeWarnFiles(url)]).toEqual(["a.test.ts", "b.test.ts"]);
  });

  it("rejects a file that is not a JSON array", async () => {
    const url = await fileWith("object.json", JSON.stringify({ files: ["a.test.ts"] }));
    expect(() => readTenantScopeWarnFiles(url)).toThrow(/must be a JSON array of repository-relative paths/);
  });

  it("rejects an array with a non-string entry", async () => {
    const url = await fileWith("number.json", JSON.stringify(["a.test.ts", 7]));
    expect(() => readTenantScopeWarnFiles(url)).toThrow(/must be a JSON array of repository-relative paths/);
  });

  it("rejects malformed JSON", async () => {
    const url = await fileWith("broken.json", "[");
    expect(() => readTenantScopeWarnFiles(url)).toThrow(SyntaxError);
  });
});
