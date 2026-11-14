import { createHash } from "node:crypto";
import type { Pool } from "pg";
import type { ModuleRegistry } from "@semprec/module-registry";
import { canonicalizeJson, type RiskClass } from "@semprec/shared";
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
 */
export async function resolveModuleAgentToolsForRun(
  pool: Pool,
  registry: ModuleRegistry,
  runId: string,
  projectItemId: string,
  effectiveCapabilities?: ReadonlySet<string>,
  options: { includeApprovalGated?: boolean } = {},
): Promise<ResolvedModuleAgentTool[]> {
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
  const definitions = await registry.getAgentToolDefinitions(capabilities, options);
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
        const result: unknown = await handler(runId, parsed.data);
        if (!isRecord(result) || typeof result.result !== "string" || typeof result.error !== "boolean")
          throw new Error("Invalid module tool result");
        return {
          result: result.result,
          error: result.error,
          ...(result.sensitive === true ? { sensitive: true } : {}),
          ...(typeof result.approvalRequestId === "string" ? { approvalRequestId: result.approvalRequestId } : {}),
        };
      },
    };
  });
}
