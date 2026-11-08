import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const srcRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The bespoke handlers serialise a caught `ChokePointError` through `toPublicErrorBody`, which
 * drops any `details` that is not a flat record of primitives. Reading `err.details` directly in a
 * handler would bypass that filter, so the only permitted occurrences live in
 * `adapter/errorContract.ts`.
 */
const BESPOKE_HANDLER_FILES = [
  "authHandler.ts",
  "setupHandler.ts",
  "notificationsHandler.ts",
  "approvalRequestsHandler.ts",
  "agentRunHandler.ts",
  "mcpAgentPageHandler.ts",
  "schemaHandler.ts",
  "mcp/mcpHandler.ts",
];

describe("bespoke handler error bodies (issue #638)", () => {
  it.each(BESPOKE_HANDLER_FILES)("%s never forwards err.details itself", (file) => {
    const source = readFileSync(path.join(srcRoot, file), "utf8");
    expect(source).toContain("toPublicErrorBody(err)");
    expect(source).not.toContain("err.details");
  });
});
