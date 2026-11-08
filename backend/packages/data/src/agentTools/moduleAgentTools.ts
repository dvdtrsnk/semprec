import type { Pool } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import { getAgentRun } from "../agentRuns/agentRunsStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { generatePermissionManifest } from "../manifest/permissionManifest.js";

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function resolveModuleAgentToolsForRun(
  pool: Pool,
  registry: ModuleRegistry,
  runId: string,
  projectItemId: string,
  effectiveCapabilities?: ReadonlySet<string>,
) {
  const manifest = await withTransaction(pool, async (client) => {
    const run = await getAgentRun(client, runId);
    if (!run || run.projectItemId !== projectItemId) throw new NotFoundError("Run not found");
    return generatePermissionManifest(client, projectItemId, { moduleRegistry: registry });
  });
  const capabilities = new Set(
    manifest.grantedCapabilities.filter(
      (capability) => effectiveCapabilities === undefined || effectiveCapabilities.has(capability),
    ),
  );
  const definitions = await registry.getAgentToolDefinitions(capabilities);
  const ruleKinds = new Map(
    (await registry.getHeartbeatRuleKindDefinitions()).map((definition) => [
      definition.kind,
      { schema: definition.schema, nextFireAt: definition.nextFireAt },
    ]),
  );
  return definitions.map((definition) => {
    if (!isCallable(definition.handler)) throw new Error(`Invalid module tool handler: ${definition.name}`);
    const handler: unknown = definition.handler(pool, ruleKinds);
    if (!isCallable(handler)) throw new Error(`Invalid module tool factory: ${definition.name}`);
    return {
      name: definition.name,
      argumentSchema: definition.argumentSchema,
      acceptsArguments: (args: unknown) => definition.parseArguments(args).success,
      async invoke(args: unknown): Promise<{ result: string; error: boolean }> {
        const parsed = definition.parseArguments(args);
        if (!parsed.success) throw new ValidationError("Invalid tool arguments.");
        const result: unknown = await handler(runId, parsed.data);
        if (!isRecord(result) || typeof result.result !== "string" || typeof result.error !== "boolean")
          throw new Error("Invalid module tool result");
        return { result: result.result, error: result.error };
      },
    };
  });
}
