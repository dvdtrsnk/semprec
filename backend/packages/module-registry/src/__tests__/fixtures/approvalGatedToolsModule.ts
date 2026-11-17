import { z } from "zod";
import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "gatedTools",
  version: "1.0.0",
  name: "Gated Tools",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [
    {
      name: "gated.apply",
      handlerExport: "createApplyTool",
      argumentSchemaExport: "applyArgsSchema",
      approval: "always",
      riskClass: "write",
      requiresApproval: true,
      snapshotExport: "createApplySnapshot",
    },
    {
      name: "gated.noSnapshot",
      handlerExport: "createApplyTool",
      argumentSchemaExport: "applyArgsSchema",
      approval: "always",
      requiresApproval: true,
    },
    // Declares no `riskClass` and `approval: "none"`: only `requiresApproval` keeps it from running directly.
    {
      name: "gated.noneApproval",
      handlerExport: "createApplyTool",
      argumentSchemaExport: "applyArgsSchema",
      approval: "none",
      requiresApproval: true,
    },
    {
      name: "gated.free",
      handlerExport: "createApplyTool",
      argumentSchemaExport: "applyArgsSchema",
      approval: "none",
      riskClass: "read",
    },
    {
      name: "gated.always",
      handlerExport: "createApplyTool",
      argumentSchemaExport: "applyArgsSchema",
      approval: "always",
      riskClass: "destructive",
    },
  ],
};

export const applyArgsSchema = z
  .object({ value: z.string(), mode: z.enum(["ok", "errorResult", "throw"]).optional() })
  .strict();

interface ApplyArgs {
  value: string;
  mode?: "ok" | "errorResult" | "throw";
}

/** The minimal pool surface the fixture handlers use; a module receives the real pool and may use more. */
interface FixturePool {
  query<R extends Record<string, unknown>>(text: string, values: unknown[]): Promise<{ rows: R[] }>;
}

/**
 * Every tool's source is the title of the requesting run's chat thread: the handler appends
 * `+<value>`, the snapshot is the title, and reading it fails while the title is `boom`. Raw SQL,
 * since this module has no database.
 */
export function createApplyTool(pool: FixturePool) {
  return async (runId: string, args: ApplyArgs) => {
    await pool.query(
      `UPDATE semp_threads SET title = coalesce(title, '') || $2
        WHERE id = (SELECT thread_id FROM agent_runs WHERE id = $1)`,
      [runId, `+${args.value}`],
    );
    if (args.mode === "throw") throw new Error("private handler detail");
    if (args.mode === "errorResult") return { error: true, result: "handler refused" };
    return { error: false, result: `applied ${args.value}` };
  };
}

export function createApplySnapshot(pool: FixturePool) {
  return async (runId: string, _args: ApplyArgs) => {
    const { rows } = await pool.query<{ title: string | null }>(
      "SELECT title FROM semp_threads WHERE id = (SELECT thread_id FROM agent_runs WHERE id = $1)",
      [runId],
    );
    const title = rows[0]?.title ?? null;
    if (title === "boom") throw new Error("snapshot unavailable");
    return { title };
  };
}
