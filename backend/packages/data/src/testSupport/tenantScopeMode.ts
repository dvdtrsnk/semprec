import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";

/**
 * Vitest `setupFiles` entry of the integration tier (`vitest.integration.config.ts`): it runs before the first
 * test of every test file, in that file's own worker, and sets `SEMPREC_TENANT_SCOPE` for it.
 *
 * - A file listed in `tenantScopeWarnFiles.json` runs under `warn`, as the whole tier did before the list existed.
 * - Every other file runs under `strict`, the production mode, so a code path that loses its tenant scope fails
 *   the test that reaches it.
 * - A `SEMPREC_TENANT_SCOPE` that the vitest process was started with is a developer override and is kept for
 *   every file. Nothing in `globalSetup.ts` sets the variable any more, so a value present here is explicit.
 *
 * A file may still switch the mode itself, as the isolation suites do; the mode is read on every call. The list
 * only shrinks (`__tests__/tenantScopeWarnFiles.unit.test.ts` pins it), and the rule is recorded in
 * `docs/adr/2026-11-15-integration-tests-run-strict-unless-listed.md`.
 */

export type TenantScopeMode = "warn" | "strict";

/** `packages/data/src/testSupport` up to `backend/`, the directory the list's paths are relative to. */
const BACKEND_DIRECTORY = fileURLToPath(new URL("../../../../", import.meta.url));

const WARN_FILES_URL = new URL("./tenantScopeWarnFiles.json", import.meta.url);

/** Reads and validates the list; the file is a boundary, so a wrong shape stops the run instead of mapping to strict. */
export function readTenantScopeWarnFiles(url: URL = WARN_FILES_URL): ReadonlySet<string> {
  const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
  if (!Array.isArray(parsed) || !parsed.every((entry): entry is string => typeof entry === "string")) {
    throw new Error(`${url.pathname} must be a JSON array of repository-relative paths`);
  }
  return new Set(parsed);
}

/**
 * The mode for one test file. `testPath` is the absolute path of the running file; a file whose path cannot be
 * determined throws, because defaulting it to either mode would hide the problem (`warn` silently weakens the
 * check, `strict` would fail with an error that does not name the cause).
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

/** Sets the variable in `env` unless it is already set; see the module comment for why a set value is an override. */
export function applyTenantScopeMode(
  env: NodeJS.ProcessEnv,
  testPath: string | undefined,
  warnFiles: ReadonlySet<string>,
): void {
  if (env.SEMPREC_TENANT_SCOPE !== undefined) return;
  env.SEMPREC_TENANT_SCOPE = selectTenantScopeMode(testPath, warnFiles);
}

applyTenantScopeMode(process.env, expect.getState().testPath, readTenantScopeWarnFiles());
