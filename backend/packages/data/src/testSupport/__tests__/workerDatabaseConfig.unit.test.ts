import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BACKEND_DIRECTORY,
  isClusterExclusive,
  readClusterExclusiveFiles,
  workerDatabaseName,
} from "../workerDatabaseConfig.js";

/** A statement that changes role state every worker of the run sees. */
const CLUSTER_WIDE_ROLE_CHANGE = /ALTER ROLE \S+ WITH PASSWORD|CREATE ROLE|DROP ROLE/;

/** Every integration-tier test file under `packages/` and `services/`, relative to `backend/`. */
function integrationTestFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".unit.test.ts") &&
        !entry.name.endsWith(".e2e.test.ts")
      ) {
        found.push(path.relative(BACKEND_DIRECTORY, full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(BACKEND_DIRECTORY, "packages"));
  walk(path.join(BACKEND_DIRECTORY, "services"));
  return found.sort();
}

function listFile(content: string): URL {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "alldots-exclusive-")), "list.json");
  writeFileSync(file, content);
  return pathToFileURL(file);
}

describe("clusterExclusiveFiles.json", () => {
  const listed = readClusterExclusiveFiles();
  const roleChangers = integrationTestFiles().filter((file) =>
    CLUSTER_WIDE_ROLE_CHANGE.test(readFileSync(path.join(BACKEND_DIRECTORY, file), "utf8")),
  );

  it("lists every integration file that changes roles, which a parallel file would otherwise see", () => {
    expect(roleChangers.filter((file) => !listed.has(file))).toEqual([]);
  });

  it("lists only files that still change roles, so the exclusive set does not outlive its reason", () => {
    expect([...listed].filter((file) => !roleChangers.includes(file))).toEqual([]);
  });
});

describe("readClusterExclusiveFiles", () => {
  it("reads a JSON array of paths", () => {
    expect(readClusterExclusiveFiles(listFile('["a.test.ts"]'))).toEqual(new Set(["a.test.ts"]));
  });

  it("refuses a list that is not an array of strings", () => {
    expect(() => readClusterExclusiveFiles(listFile('{"a": 1}'))).toThrow(/JSON array/);
    expect(() => readClusterExclusiveFiles(listFile("[1]"))).toThrow(/JSON array/);
  });
});

describe("isClusterExclusive", () => {
  const listed = new Set(["packages/data/src/__tests__/x.test.ts"]);

  it("matches a listed file by its path relative to backend/", () => {
    expect(isClusterExclusive(path.join(BACKEND_DIRECTORY, "packages/data/src/__tests__/x.test.ts"), listed)).toBe(
      true,
    );
  });

  it("does not match an unlisted file", () => {
    expect(isClusterExclusive(path.join(BACKEND_DIRECTORY, "packages/data/src/__tests__/y.test.ts"), listed)).toBe(
      false,
    );
  });
});

describe("workerDatabaseName", () => {
  it("names the database after the worker slot", () => {
    expect(workerDatabaseName("3")).toBe("alldots_test_w3");
  });

  it.each([undefined, "", "1; DROP", "12345"])("refuses %j, which is not a worker slot", (poolId) => {
    expect(() => workerDatabaseName(poolId)).toThrow(/VITEST_POOL_ID/);
  });
});
