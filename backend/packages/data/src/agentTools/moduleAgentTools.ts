import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import { CAPABILITY_IDS, canonicalizeJson, type RiskClass } from "@semprec/shared";
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
  /** `true` for a tool declared with `requiresApproval`; its caller must defer the call instead of invoking it. */
  requiresApproval: boolean;
  /** The declared risk class of the tool; `unclassified` when the manifest declares none. */
  riskClass: RiskClass;
  /**
   * The SHA-256 of the canonical JSON of what the tool's `snapshotExport` returns for `args`, read
   * now; `null` when the tool declares no `snapshotExport`. Throws `ValidationError` for arguments
   * the tool does not accept, and whatever the snapshot export throws.
   */
  snapshotOf: (args: unknown) => Promise<string | null>;
  /**
   * `sensitive` is true when the handler marked its answer as content of a sensitive record (issue #1999); the caller
   * that stores the tool result keeps it redacted, as for a generic-operation answer (issue #1827).
   * `approvalRequestId` is the id of an approval request the handler itself filed (issue gh-1949, `mail.draft.send`); the
   * caller that stores the tool result writes it into the result's details like the id of a deferred call's request.
   */
  invoke: (args: unknown) => Promise<{ result: string; error: boolean; sensitive?: true; approvalRequestId?: string }>;
}

/**
 * The module agent tools `runId` (a run of `projectItemId`) may use. A tool declared with
 * `requiresApproval` is returned only with `options.includeApprovalGated`: a caller that does not
 * ask (the MCP endpoint) never sees it, so it cannot run the handler without an approval.
 *
 * `effectiveCapabilities` is the upper bound of the caller: a capability of the project is used only when the set holds
 * it, core or a module's own. A session passes none or its own set; the MCP endpoint passes the capabilities its run
 * credential lists, core ids and the module capability ids the mint action accepted (issue gh-1956), so a credential
 * that does not list `mail.draft` never gets the tools of that capability, whatever its project holds.
 *
 * `options.mcpExposure` is set by the MCP endpoint for the caller of a run credential: a tool whose capability is a
 * module's own is then returned only when its manifest declares `mcp`. The endpoint passes `includeApprovalGated`
 * too (issue gh-1957): it files the approval request of a gated tool on a call instead of running the handler.
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

/** The answer of a module tool handler, checked for the shape every handler promises (`result`, `error`). */
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
 * The module agent tools a human `/mcp` session may use as `userId` (issue gh-1956): the tools of the active modules
 * whose manifest declares `mcp`, each bound to the handler its `humanHandlerExport` builds with `dependencies`, the
 * container the composition root hands the module's custom routes. A session has no run and no project, so no
 * project grant applies: a tool is offered when its module is active, which is when its capability is registered.
 * The call runs as the user and needs no approval (docs/adr/2026-10-28-module-agent-tools-approval-and-grants.md); a
 * tool that is not declared with `mcp` is never returned. A tool declared with `requiresApproval` and `mcp` (the
 * calendar write tools, issue gh-1957) is returned: the approval request is what an agent's proposal waits on, and a
 * session has no run to file one for, so its human handler runs as the user like the mail send.
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
