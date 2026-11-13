import type { ChokePoint, CollectionMetadataResolver } from "@semprec/data";
import type { Pool } from "pg";
import {
  ApprovalRequiredError,
  ChokePointError,
  createChokePoint,
  generatePermissionManifest,
  getAgentRun,
  readItemPatchChangeMetadata,
  withTransaction,
} from "@semprec/data";
import type { ModuleRegistry } from "@semprec/module-registry";
import {
  GENERIC_OPERATION_NAMES,
  CAPABILITY_IDS,
  type AuthenticatedActor,
  type CapabilityId,
  type GenericOperationName,
} from "@semprec/shared";
import { createGenericOperationGateway, type GenericOperationGateway } from "@semprec/application";
import { logger } from "../../logger.js";
import type { ToolResultChange } from "../../toolEventPayload.js";

/** Shaped like a pi-agent-core `tool_result` payload — the same local approximation `heartbeatAgentTools.ts`'s `HeartbeatAgentToolResult` uses. */
export interface GenericOperationAgentToolResult {
  error: boolean;
  result: string;
  /** The approval request this call created, when it was deferred to a human. */
  approvalRequestId?: string;
  /** Per-property changes of a successful `item.patch`. */
  changes?: ToolResultChange[];
  /**
   * Set (issue #1827) when a content-bearing operation answered with content of a sensitive database: the
   * run history stores such a result redacted (`sensitiveToolResult.ts`). The result itself is unchanged.
   */
  sensitive?: true;
}

/** Longest string a `changes` entry stores for a `before` or `after` value. */
export const TOOL_CHANGE_VALUE_MAX_LENGTH = 200;

function boundValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > TOOL_CHANGE_VALUE_MAX_LENGTH ? value.slice(0, TOOL_CHANGE_VALUE_MAX_LENGTH) : value;
  }
  if (typeof value === "object" && value !== null) {
    const json = JSON.stringify(value);
    return json.length > TOOL_CHANGE_VALUE_MAX_LENGTH ? json.slice(0, TOOL_CHANGE_VALUE_MAX_LENGTH) : value;
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Builds `changes` for a successful `item.patch` from the operation's own `previous` values (read
 * inside its write transaction) and the call's `properties`. A `longText` property keeps only its
 * key; a key without a reported previous value has no `before`. Missing write-time classification
 * leaves a key without values.
 */
function buildPatchChanges(output: unknown, args: unknown): ToolResultChange[] | undefined {
  if (!isRecord(output) || !isRecord(args) || !isRecord(args.properties)) return undefined;
  const patched = args.properties;
  const previous = isRecord(output.previous) ? output.previous : {};
  const keys = Object.keys(patched);
  if (keys.length === 0) return undefined;
  const eligibility = readItemPatchChangeMetadata(output);
  return keys.map((key): ToolResultChange => {
    if (eligibility?.get(key) !== true) return { key };
    return {
      key,
      ...(Object.hasOwn(previous, key) ? { before: boundValue(previous[key]) } : {}),
      after: boundValue(patched[key]),
    };
  });
}

/** The operations whose answer carries item content (issue #1827); every other operation answers with structure or ids. */
const CONTENT_BEARING_OPERATIONS: ReadonlySet<GenericOperationName> = new Set<GenericOperationName>([
  "item.get",
  "item.create",
  "item.patch",
  "item.delete",
  "item.restore",
  "database.query",
  "view.query",
]);

/** The databases whose content an answer carries; `unresolved` when some content cannot be tied to a database. */
interface AnswerDatabases {
  ids: Set<string>;
  unresolved: boolean;
}

/** The target database of each relation property of one database, by property key (`undefined` when the config names none). */
async function relationTargetDatabases(
  chokePoint: ChokePoint,
  databaseId: string,
): Promise<Map<string, string | undefined>> {
  const targets = new Map<string, string | undefined>();
  for (const property of await chokePoint.listProperties(databaseId)) {
    if (property.type !== "relation") continue;
    const target = property.config.targetDatabaseId;
    targets.set(property.key, typeof target === "string" ? target : undefined);
  }
  return targets;
}

/**
 * The databases whose content an answer carries (issue #1827): the database of each item it answered with
 * (the item itself, or every item of a page), the database of each relation target expanded inside such an
 * item (`include.relations`; a target the agent may not read is only `{ id, hidden: true }` and carries no
 * content), and the target database of each relation property projected on such a target, whose targets come
 * as reduced entries without a database id. Content that names no database, or a projected relation property
 * of no known target database, is `unresolved`.
 */
async function answerDatabases(chokePoint: ChokePoint, output: unknown): Promise<AnswerDatabases> {
  const answer: AnswerDatabases = { ids: new Set(), unresolved: false };
  if (!isRecord(output)) return answer;
  const items: unknown[] = Array.isArray(output.items) ? output.items : [output];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (typeof item.databaseId === "string") answer.ids.add(item.databaseId);
    if (item.relations === undefined) continue;
    if (!isRecord(item.relations)) {
      answer.unresolved = true;
      continue;
    }
    for (const targets of Object.values(item.relations)) {
      if (!Array.isArray(targets)) {
        answer.unresolved = true;
        continue;
      }
      for (const target of targets) {
        if (!isRecord(target)) {
          answer.unresolved = true;
        } else if (target.hidden === true) {
          continue;
        } else if (typeof target.databaseId !== "string") {
          answer.unresolved = true;
        } else {
          answer.ids.add(target.databaseId);
          await addProjectedRelationDatabases(chokePoint, target.databaseId, target.properties, answer);
        }
      }
    }
  }
  return answer;
}

/** Adds the target database of every relation property of `databaseId` that `properties` carries an entry with content for. */
async function addProjectedRelationDatabases(
  chokePoint: ChokePoint,
  databaseId: string,
  properties: unknown,
  answer: AnswerDatabases,
): Promise<void> {
  if (!isRecord(properties)) return;
  const withContent = Object.entries(properties).filter(
    ([, value]) => Array.isArray(value) && value.some((entry) => isRecord(entry) && entry.hidden !== true),
  );
  if (withContent.length === 0) return;
  const relationTargets = await relationTargetDatabases(chokePoint, databaseId);
  for (const [key] of withContent) {
    if (!relationTargets.has(key)) continue;
    const targetDatabaseId = relationTargets.get(key);
    if (targetDatabaseId === undefined) answer.unresolved = true;
    else answer.ids.add(targetDatabaseId);
  }
}

/** The database a `database.query` or `view.query` asked about; a curated view belongs to none. */
async function queriedDatabaseId(
  chokePoint: ChokePoint,
  operation: GenericOperationName,
  args: unknown,
): Promise<string | undefined> {
  if (!isRecord(args)) return undefined;
  if (operation === "database.query") return typeof args.databaseId === "string" ? args.databaseId : undefined;
  if (operation === "view.query" && typeof args.viewId === "string") {
    return (await chokePoint.getView(args.viewId))?.databaseId ?? undefined;
  }
  return undefined;
}

/**
 * Whether the answer of a successful call is content of a sensitive database (issue #1827): the
 * operation is content-bearing and a database it answered with, queried or expanded through
 * `include.relations` (`answerDatabases`) has `sensitive = true`.
 * The flag is read through the choke point when the call has answered, in the caller's tenant scope. A
 * database id that resolves to no database, or content that names no database, counts as sensitive, so
 * the answer is never stored in full on a doubt.
 */
async function isSensitiveAnswer(
  chokePoint: ChokePoint,
  operation: GenericOperationName,
  args: unknown,
  output: unknown,
): Promise<boolean> {
  if (!CONTENT_BEARING_OPERATIONS.has(operation)) return false;
  const queried = await queriedDatabaseId(chokePoint, operation, args);
  const answer = await answerDatabases(chokePoint, output);
  if (answer.unresolved) return true;
  if (queried !== undefined) answer.ids.add(queried);
  for (const databaseId of answer.ids) {
    const database = await chokePoint.getDatabase(databaseId);
    if (database === null || database.sensitive) return true;
  }
  return false;
}

/**
 * `isSensitiveAnswer` for a call that already succeeded: when the flag cannot be read, the call is not
 * reported as failed (an `item.patch` has committed) and the answer is treated as sensitive. The log
 * line names the operation, the run and the error class, never the answer.
 */
async function markSensitiveAnswer(
  chokePoint: ChokePoint,
  operation: GenericOperationName,
  args: unknown,
  output: unknown,
  currentRunId: string,
): Promise<boolean> {
  try {
    return await isSensitiveAnswer(chokePoint, operation, args, output);
  } catch (err) {
    logger.error(
      { operation, agentRunId: currentRunId, errorName: err instanceof Error ? err.name : typeof err },
      "Could not read whether an agent tool answer is sensitive; treating it as sensitive",
    );
    return true;
  }
}

export type GenericOperationAgentTool = (
  currentRunId: string,
  args: unknown,
  /** `reason`: the agent's reason for an approval-gated call, removed from `args` by the caller; reaches the approval request only. `toolCallId`: the model-runtime tool call, stored on a created approval request. */
  options?: { reason?: string; toolCallId?: string },
) => Promise<GenericOperationAgentToolResult>;

interface AgentContext {
  actor: AuthenticatedActor;
  grantedCapabilities: Set<CapabilityId>;
}

/**
 * Resolves the calling agent's actor identity and granted capabilities strictly from the
 * persisted `agent_run` row for `currentRunId` — never from tool arguments, mirroring
 * `heartbeatAgentTools.ts`'s `resolveCallingProjectItemId` discipline. A run that doesn't exist,
 * or carries no project context, resolves to `null`; every caller below turns that into
 * `owner_violation` before any capability or approval check runs.
 */
async function resolveAgentContext(
  pool: Pool,
  moduleRegistry: ModuleRegistry | undefined,
  currentRunId: string,
): Promise<AgentContext | null> {
  const run = await getAgentRun(pool, currentRunId);
  const projectItemId = run?.projectItemId;
  if (!run || !projectItemId) return null;

  const manifest = await withTransaction(pool, (client) =>
    generatePermissionManifest(client, projectItemId, { moduleRegistry }),
  );

  return {
    actor: { userId: run.actorUserId, runId: run.id, agentProjectItemId: projectItemId },
    grantedCapabilities: new Set(
      CAPABILITY_IDS.filter((capability) => manifest.grantedCapabilities.includes(capability)),
    ),
  };
}

/**
 * Mirrors `mcpInvokeTool.ts`'s `pendingApprovalResult`: the *tool call itself* is reported as
 * successful (`error: false`) so the agent turn and run complete normally, even though the
 * underlying operation was deferred to a human decision instead of executed.
 */
function pendingApprovalResult(
  err: ApprovalRequiredError,
  operation: GenericOperationName,
): GenericOperationAgentToolResult {
  return {
    error: false,
    result: `Operation '${operation}' requires human approval before it can run. Approval request ${err.details.approvalRequestId} has been created and is awaiting a decision; this call has not been executed.`,
    approvalRequestId: err.details.approvalRequestId,
  };
}

function toolResultFromError(err: unknown, operation: GenericOperationName): GenericOperationAgentToolResult {
  if (err instanceof ApprovalRequiredError) return pendingApprovalResult(err, operation);
  if (err instanceof ChokePointError) return { error: true, result: `${err.code}: ${err.message}` };
  return { error: true, result: err instanceof Error ? err.message : String(err) };
}

function createTool(
  gateway: GenericOperationGateway,
  chokePoint: ChokePoint,
  pool: Pool,
  moduleRegistry: ModuleRegistry | undefined,
  operation: GenericOperationName,
): GenericOperationAgentTool {
  return async function invoke(currentRunId, args, options) {
    try {
      const context = await resolveAgentContext(pool, moduleRegistry, currentRunId);
      if (!context) {
        return { error: true, result: "owner_violation: no persisted run context for this agent tool call" };
      }
      const output = await gateway.invoke(operation, context.actor, context.grantedCapabilities, args ?? {}, options);
      const changes = operation === "item.patch" ? buildPatchChanges(output, args) : undefined;
      const sensitive = await markSensitiveAnswer(chokePoint, operation, args, output, currentRunId);
      return {
        error: false,
        result: JSON.stringify(output),
        ...(changes ? { changes } : {}),
        ...(sensitive ? { sensitive: true as const } : {}),
      };
    } catch (err) {
      return toolResultFromError(err, operation);
    }
  };
}

/**
 * One AgentTool per generic operation (issue #220), named verbatim after the operation
 * (`GENERIC_OPERATION_NAMES`) — MCP's own composition root (`services/semprec-api/src/mcp`)
 * prefixes the same names `semprec.` for its own catalog, both dispatching through
 * `createGenericOperationGateway(pool, resolver)` so there is exactly one path into the 44-operation
 * catalog's business logic for this process, alongside REST's own separate
 * `dispatchGenericOperation` (#219) over the same neutral `GenericApplicationPort` (#219's ADR:
 * "one instance per injected Pool" — this composition root's own instance, not REST's).
 *
 * A REST-only operation (`REST_ONLY_OPERATION_NAMES`, issue #1699) gets a tool object here like
 * every other name, but the gateway lists it for no run and refuses every call to it as an unknown
 * operation; the assistant will propose a new select option on an Inbox proposal instead (#1994).
 *
 * `services/semprec-agents` (issue #91, not yet built) is the eventual composition root that
 * decides, per run, which of these to even expose to a model — `listGrantedGenericOperationAgentTools`
 * below is that discovery counterpart. Every tool here re-checks the grant on every call
 * regardless of whether the caller filtered its catalog first, so a stale or wrongly-filtered
 * catalog can never itself become a bypass.
 */
export function createGenericOperationAgentTools(
  pool: Pool,
  moduleRegistry: ModuleRegistry | undefined,
  resolver: CollectionMetadataResolver,
): Record<GenericOperationName, GenericOperationAgentTool> {
  const gateway = createGenericOperationGateway(pool, resolver);
  const chokePoint = createChokePoint(pool);
  const tools = {} as Record<GenericOperationName, GenericOperationAgentTool>;
  for (const operation of GENERIC_OPERATION_NAMES) {
    tools[operation] = createTool(gateway, chokePoint, pool, moduleRegistry, operation);
  }
  return tools;
}

/**
 * The operation names visible to `currentRunId` right now: absent, not present-but-forbidden,
 * for an operation whose capability isn't granted to the run's project. Resolves the same
 * persisted-run actor context `createGenericOperationAgentTools`'s tools re-check on every call.
 */
export async function listGrantedGenericOperationAgentTools(
  pool: Pool,
  moduleRegistry: ModuleRegistry | undefined,
  currentRunId: string,
  resolver: CollectionMetadataResolver,
): Promise<GenericOperationName[]> {
  const context = await resolveAgentContext(pool, moduleRegistry, currentRunId);
  if (!context) return [];
  return createGenericOperationGateway(pool, resolver).listOperations(context.grantedCapabilities);
}
