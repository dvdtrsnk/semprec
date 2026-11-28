import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { ModuleRegistry } from "@alldots/module-registry";
import { CAPABILITY_IDS, canonicalizeJson, type RiskClass } from "@alldots/shared";
import { getAgentRun } from "../agentRuns/agentRunsStore.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { generatePermissionManifest } from "../manifest/permissionManifest.js";

function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === "function";
}

function isCoreCapability(capability: string): boolean {
  return CAPABILITY_IDS.some((id) => id === capability);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A module agent tool bound to one run: what a session offers, and what a deferred call runs later. */
export interface ResolvedModuleAgentTool {
  name: string;
  argumentSchema: Record<string, unknown>;
  acceptsArguments: (args: unknown) => boolean;
  /** The caller must defer the call instead of invoking it. */
  requiresApproval: boolean;
  /** `unclassified` when the manifest declares none. */
  riskClass: RiskClass;
  /**
   * SHA-256 of the canonical JSON of the tool's `snapshotExport` for `args`; `null` without one. Throws
   * `ValidationError` for unaccepted arguments.
   */
  snapshotOf: (args: unknown) => Promise<string | null>;
  /**
   * `sensitive`: the answer is content of a sensitive record and must be stored redacted. `approvalRequestId`: an
   * approval request the handler itself filed (e.g. `mail.draft.send`), recorded in the stored result's details.
   */
  invoke: (args: unknown) => Promise<{ result: string; error: boolean; sensitive?: true; approvalRequestId?: string }>;
}

/**
 * The module agent tools a run of `projectItemId` may use.
 *
 * - `requiresApproval` tools are returned only with `includeApprovalGated`, so a caller that does not ask cannot run
 *   one without approval.
 * - `effectiveCapabilities` bounds the project's capabilities (the MCP endpoint passes those its run credential
 *   lists), so a credential without `mail.draft` never gets that capability's tools.
 * - `mcpExposure` (MCP endpoint): a module-owned capability's tool is returned only when its manifest declares `mcp`.
 */
export async function resolveModuleAgentToolsForRun(
  pool: Pool,
  registry: ModuleRegistry,
  runId: string,
  projectItemId: string,
  effectiveCapabilities?: ReadonlySet<string>,
  options: { includeApprovalGated?: boolean; mcpExposure?: boolean } = {},
): Promise<ResolvedModuleAgentTool[]> {
  const manifest = await withTransaction(pool, async (client) => {
    const run = await getAgentRun(client, runId);
    if (!run || run.projectItemId !== projectItemId) throw new NotFoundError("Run not found");
    return generatePermissionManifest(client, projectItemId, { moduleRegistry: registry });
  });
  const mcpExposure = options.mcpExposure === true;
  const capabilities = new Set(
    manifest.grantedCapabilities.filter(
      (capability) => effectiveCapabilities === undefined || effectiveCapabilities.has(capability),
    ),
  );
  const definitions = (
    await registry.getAgentToolDefinitions(
      capabilities,
      options.includeApprovalGated === undefined ? {} : { includeApprovalGated: options.includeApprovalGated },
    )
  ).filter(
    (definition) =>
      !mcpExposure ||
      definition.capability === undefined ||
      isCoreCapability(definition.capability) ||
      definition.mcp !== undefined,
  );
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
    const snapshotFactory: unknown = definition.snapshot;
    if (snapshotFactory !== undefined && !isCallable(snapshotFactory))
      throw new Error(`Invalid module tool snapshot: ${definition.name}`);
    return {
      name: definition.name,
      argumentSchema: definition.argumentSchema,
      acceptsArguments: (args: unknown) => definition.parseArguments(args).success,
      requiresApproval: definition.requiresApproval === true,
      riskClass: definition.riskClass ?? "unclassified",
      async snapshotOf(args: unknown): Promise<string | null> {
        if (snapshotFactory === undefined) return null;
        const parsed = definition.parseArguments(args);
        if (!parsed.success) throw new ValidationError("Invalid tool arguments.");
        const snapshot: unknown = snapshotFactory(pool, ruleKinds);
        if (!isCallable(snapshot)) throw new Error(`Invalid module tool snapshot factory: ${definition.name}`);
        return createHash("sha256")
          .update(canonicalizeJson(await snapshot(runId, parsed.data)), "utf8")
          .digest("hex");
      },
      async invoke(
        args: unknown,
      ): Promise<{ result: string; error: boolean; sensitive?: true; approvalRequestId?: string }> {
        const parsed = definition.parseArguments(args);
        if (!parsed.success) throw new ValidationError("Invalid tool arguments.");
        return toolResultOf(await handler(runId, parsed.data));
      },
    };
  });
}

/** Checks the shape every handler promises (`result`, `error`). */
function toolResultOf(result: unknown): {
  result: string;
  error: boolean;
  sensitive?: true;
  approvalRequestId?: string;
} {
  if (!isRecord(result) || typeof result.result !== "string" || typeof result.error !== "boolean")
    throw new Error("Invalid module tool result");
  return {
    result: result.result,
    error: result.error,
    ...(result.sensitive === true ? { sensitive: true } : {}),
    ...(typeof result.approvalRequestId === "string" ? { approvalRequestId: result.approvalRequestId } : {}),
  };
}

/** A module agent tool bound to the user of a human `/mcp` session, which has no run. */
export type ResolvedHumanModuleAgentTool = Pick<ResolvedModuleAgentTool, "name" | "argumentSchema" | "invoke">;

/**
 * The tools a human `/mcp` session may use as `userId`: active modules' tools that declare `mcp`, bound to their
 * `humanHandlerExport` built with `dependencies` (the container the module's custom routes get). No run or project,
 * so no grant applies; calls run as the user without approval, including `requiresApproval` tools, since there is
 * no run to file an approval for.
 */
export async function resolveModuleAgentToolsForUser(
  pool: Pool,
  registry: ModuleRegistry,
  userId: string,
  dependencies: unknown,
): Promise<ResolvedHumanModuleAgentTool[]> {
  const definitions = await registry.getAgentToolDefinitions(new Set(await registry.getCapabilities()), {
    includeApprovalGated: true,
  });
  return definitions.flatMap((definition) => {
    const humanHandler = definition.mcp?.humanHandler;
    if (humanHandler === undefined) return [];
    if (!isCallable(humanHandler)) throw new Error(`Invalid module tool human handler: ${definition.name}`);
    const handler: unknown = humanHandler(pool, dependencies);
    if (!isCallable(handler)) throw new Error(`Invalid module tool human handler factory: ${definition.name}`);
    return [
      {
        name: definition.name,
        argumentSchema: definition.argumentSchema,
        async invoke(args: unknown) {
          const parsed = definition.parseArguments(args);
          if (!parsed.success) throw new ValidationError("Invalid tool arguments.");
          return toolResultOf(await handler(userId, parsed.data));
        },
      },
    ];
  });
}
