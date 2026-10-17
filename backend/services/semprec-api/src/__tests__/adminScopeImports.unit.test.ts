import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const SNIPPET = 'import { runInTenant } from "@semprec/shared";\nvoid runInTenant;\n';

// One instance for the file: the first type-aware lint builds the TypeScript program and is slow.
const eslint = new ESLint({ cwd: backendRoot, overrideConfigFile: path.join(backendRoot, "eslint.config.mjs") });
const LINT_TIMEOUT_MS = 60_000;

async function ruleIdsFor(relativePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(SNIPPET, { filePath: path.join(backendRoot, relativePath) });
  return (result?.messages ?? []).map((message) => message.ruleId ?? "");
}

describe("admin scope import restriction (issue #1037)", () => {
  it.each(["services/semprec-api/src/adminHandler.ts", "packages/data/src/tenancy/accountsAdminStore.ts"])(
    "forbids runInTenant in %s",
    async (file) => {
      expect(await ruleIdsFor(file)).toContain("no-restricted-imports");
    },
    LINT_TIMEOUT_MS,
  );

  it(
    "allows runInTenant in any other file",
    async () => {
      expect(await ruleIdsFor("services/semprec-api/src/adapter/adapterRoute.ts")).not.toContain(
        "no-restricted-imports",
      );
    },
    LINT_TIMEOUT_MS,
  );
});
