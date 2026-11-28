import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

/**
 * Integration-tier `setupFiles` entry: sets `ALLDOTS_TENANT_SCOPE` per test file, in that file's worker.
 *
 * - Files in `tenantScopeWarnFiles.json` run under `warn`; every other file under `strict` (production mode).
 * - A value the vitest process was started with is a developer override and is kept.
 *
 * A file may still switch the mode itself; it is read on every call. The list only shrinks
 * (pinned by `__tests__/tenantScopeWarnFiles.unit.test.ts`; docs/architecture/testing.md#tenant-scope-mode-per-file).
 */

export type TenantScopeMode = "warn" | "strict";

/** `backend/`, which the list's paths are relative to. */
const BACKEND_DIRECTORY = fileURLToPath(new URL("../../../../", import.meta.url));

const WARN_FILES_URL = new URL("./tenantScopeWarnFiles.json", import.meta.url);

/** The file is a boundary: a wrong shape stops the run instead of defaulting to strict. */
export function readTenantScopeWarnFiles(url: URL = WARN_FILES_URL): ReadonlySet<string> {
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every((entry): entry is string => typeof entry === "string")) {
    throw new Error(`${url.pathname} must be a JSON array of repository-relative paths`);
  }
  return new Set(parsed);
}

/**
 * Throws when the running file's path is unknown: `warn` would silently weaken the check and `strict` would fail
 * without naming the cause.
 */
export function selectTenantScopeMode(testPath: string | undefined, warnFiles: ReadonlySet<string>): TenantScopeMode {
  if (testPath === undefined || testPath === "" || !path.isAbsolute(testPath)) {
    throw new Error(
      `tenantScopeMode: cannot determine the running test file (got ${JSON.stringify(testPath)}), ` +
        "so its tenant-scope mode is unknown",
    );
  }
  const relative = path.relative(BACKEND_DIRECTORY, testPath).split(path.sep).join("/");
  return warnFiles.has(relative) ? "warn" : "strict";
}

/** An already-set value is a developer override. */
export function applyTenantScopeMode(
  env: NodeJS.ProcessEnv,
  testPath: string | undefined,
  warnFiles: ReadonlySet<string>,
): void {
  if (env.ALLDOTS_TENANT_SCOPE !== undefined) return;
  env.ALLDOTS_TENANT_SCOPE = selectTenantScopeMode(testPath, warnFiles);
}

applyTenantScopeMode(process.env, expect.getState().testPath, readTenantScopeWarnFiles());
