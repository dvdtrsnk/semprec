import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const guardModule = pathToFileURL(fileURLToPath(new URL("../testSupport/preserveFailingExitCode.ts", import.meta.url)));

/**
 * Runs a fresh Node process that loads `embedded-postgres` the way the test tiers' `globalSetup`
 * does, optionally installs the guard, then fails the way vitest does — by setting
 * `process.exitCode` and letting the event loop drain — and returns the process' exit status.
 */
function exitStatusOfFailingProcess(withGuard: boolean): number | null {
  const script = [
    'import "embedded-postgres";',
    withGuard ? `import { preserveFailingExitCode } from ${JSON.stringify(guardModule.href)};` : "",
    withGuard ? "preserveFailingExitCode();" : "",
    "process.exitCode = 1;",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", script], {
    cwd: packageRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  return result.status;
}

describe("preserveFailingExitCode", () => {
  it("without it, embedded-postgres' exit hook turns a failing exit code into 0 — the reason it exists", () => {
    expect(exitStatusOfFailingProcess(false)).toBe(0);
  });

  it("keeps a failing exit code when embedded-postgres is loaded", () => {
    expect(exitStatusOfFailingProcess(true)).toBe(1);
  });
});
