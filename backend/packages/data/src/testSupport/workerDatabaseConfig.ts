import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The pure half of `workerDatabase.ts`, importable by the unit tier.

/** `backend/`, which the list's paths are relative to. */
export const BACKEND_DIRECTORY = fileURLToPath(new URL("../../../../", import.meta.url));

export const EXCLUSIVE_FILES_URL = new URL("./clusterExclusiveFiles.json", import.meta.url);

/** Arbitrary but fixed advisory-lock keys, taken in the admin database. */
export const CLUSTER_LOCK_KEY = 7_302_118;
export const CLONE_LOCK_KEY = 7_302_119;

/** The file is a boundary: a wrong shape stops the run instead of running a cluster-changing file in parallel. */
export function readClusterExclusiveFiles(url: URL = EXCLUSIVE_FILES_URL): ReadonlySet<string> {
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every((entry): entry is string => typeof entry === "string")) {
    throw new Error(`${url.pathname} must be a JSON array of repository-relative paths`);
  }
  return new Set(parsed);
}

export function isClusterExclusive(testPath: string, exclusiveFiles: ReadonlySet<string>): boolean {
  const relative = path.relative(BACKEND_DIRECTORY, testPath).split(path.sep).join("/");
  return exclusiveFiles.has(relative);
}

/** `alldots_test_w<pool id>`; the pool id is vitest's worker slot, stable for the run. */
export function workerDatabaseName(poolId: string | undefined): string {
  if (poolId === undefined || !/^\d{1,4}$/.test(poolId)) {
    throw new Error(`workerDatabase: VITEST_POOL_ID is not a worker slot number (got ${JSON.stringify(poolId)})`);
  }
  return `alldots_test_w${poolId}`;
}
