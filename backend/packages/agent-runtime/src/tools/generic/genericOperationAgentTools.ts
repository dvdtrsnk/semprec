import type { ChokePoint, CollectionMetadataResolver } from "@semprec/data";
import type { Pool } from "pg";
import {
  ApprovalRequiredError,
  ChokePointError,
  createChokePoint,
  generatePermissionManifest,
  getAgentRun,
  readItemPatchChangeMetadata,
  sensitiveSourceDatabaseIdsByItem,
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

/** Shaped like a pi-agent-core `tool_result` payload. */
export interface GenericOperationAgentToolResult {
  error: boolean;
  result: string;
  approvalRequestId?: string;
  /** Set only for a failure with a `ChokePointError`. */
  errorCode?: string;
  /** Per-property changes of a successful `item.patch`. */
  changes?: ToolResultChange[];
  /** Kept by the run history when it redacts a sensitive database's result text. */
  createdItemId?: string;
  /**
   * Set when a content-bearing operation answered with content of a sensitive database: the run history stores the
   * result redacted (`sensitiveToolResult.ts`).
   */
  sensitive?: true;
}

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An answer id that is no uuid names no stored item. */
function isItemId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `changes` for a successful `item.patch`, from the operation's `previous` values (read in its write transaction) and
 * the call's `properties`. A `longText` property keeps only its key; a key without a previous value has no `before`.
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

function answeredItemId(output: unknown): string | undefined {
  return isRecord(output) && typeof output.id === "string" ? output.id : undefined;
}

/** The operations whose answer carries item content; the others answer with structure or ids. */
const CONTENT_BEARING_OPERATIONS: ReadonlySet<GenericOperationName> = new Set<GenericOperationName>([
  "item.get",
  "item.create",
  "item.patch",
  "item.delete",
  "item.restore",
  "database.query",
  "view.query",
]);

/**
 * Databases and item ids whose content an answer carries (answered items and expanded relation targets); `unresolved`
 * when some content cannot be tied to a database.
 */
interface AnswerDatabases {
  ids: Set<string>;
  itemIds: Set<string>;
  unresolved: boolean;
}

/** By property key; `undefined` when the config names no target. */
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
 * The databases whose content an answer carries: each answered item's database, each expanded relation target's
 * database (a hidden target `{ id, hidden: true }` carries no content), and the target database of each relation
 * projected on such a target, whose reduced entries carry no database id (their ids are collected instead). Anything
 * not tied to a known database is `unresolved`.
 */
async function answerDatabases(chokePoint: ChokePoint, output: unknown): Promise<AnswerDatabases> {
  const answer: AnswerDatabases = { ids: new Set(), itemIds: new Set(), unresolved: false };
  if (!isRecord(output)) return answer;
  const items: unknown[] = Array.isArray(output.items) ? output.items : [output];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (typeof item.databaseId === "string") answer.ids.add(item.databaseId);
    if (isItemId(item.id)) answer.itemIds.add(item.id);
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
          if (isItemId(target.id)) answer.itemIds.add(target.id);
          await addProjectedRelationDatabases(chokePoint, target.databaseId, target.properties, answer);
        }
      }
    }
  }
  return answer;
}

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
  for (const [key, entries] of withContent) {
    if (!relationTargets.has(key)) continue;
    const targetDatabaseId = relationTargets.get(key);
    if (targetDatabaseId === undefined) answer.unresolved = true;
    else answer.ids.add(targetDatabaseId);
    // Reduced entries carry titles of items that may inherit sensitivity, so their ids are collected too.
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (isRecord(entry) && entry.hidden !== true && isItemId(entry.id)) answer.itemIds.add(entry.id);
    }
  }
}

/** A curated view belongs to no database. */
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
 * Whether a successful answer is sensitive: the operation is content-bearing and a database it answered with, queried
 * or expanded has `sensitive = true`, or an item it carries inherits sensitivity (a Files, Transcripts or Inbox item
 * linked to a sensitive database), regardless of the project's access there. An unresolvable database counts as
 * sensitive, so a doubtful answer is never stored in full.
 */
async function isSensitiveAnswer(
  chokePoint: ChokePoint,
  pool: Pool,
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
  if (answer.itemIds.size === 0) return false;
  const linked = await withTransaction(pool, (client) => sensitiveSourceDatabaseIdsByItem(client, [...answer.itemIds]));
  return linked.size > 0;
}

/**
 * For a call that already succeeded (an `item.patch` has committed): when the flag cannot be read, the answer is
 * treated as sensitive rather than the call failed. The log names the operation, run and error class, never the answer.
 */
async function markSensitiveAnswer(
  chokePoint: ChokePoint,
  pool: Pool,
  operation: GenericOperationName,
  args: unknown,
  output: unknown,
  currentRunId: string,
): Promise<boolean> {
  try {
    return await isSensitiveAnswer(chokePoint, pool, operation, args, output);
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
  /**
   * `reason` is removed from `args` by the caller and reaches only the approval request; `toolCallId` is stored on it.
   */
  options?: { reason?: string; toolCallId?: string },
) => Promise<GenericOperationAgentToolResult>;

interface AgentContext {
  actor: AuthenticatedActor;
  grantedCapabilities: Set<CapabilityId>;
}

/**
 * Resolves actor and capabilities strictly from the persisted `agent_run` row, never from tool arguments. A missing run
 * or one without project context resolves to `null`, which callers turn into `owner_violation` before any check.
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
 * The tool call itself succeeds (`error: false`) so the turn completes normally, though the operation was deferred to a
 * human.
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
  if (err instanceof ChokePointError)
    return { error: true, result: `${err.code}: ${err.message}`, errorCode: err.code };
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
      const createdItemId = operation === "item.create" ? answeredItemId(output) : undefined;
      const sensitive = await markSensitiveAnswer(chokePoint, pool, operation, args, output, currentRunId);
      return {
        error: false,
        result: JSON.stringify(output),
        ...(changes ? { changes } : {}),
        ...(createdItemId ? { createdItemId } : {}),
        ...(sensitive ? { sensitive: true as const } : {}),
      };
    } catch (err) {
      return toolResultFromError(err, operation);
    }
  };
}

/**
 * One AgentTool per generic operation, named after the operation (MCP prefixes the same names `semprec.`). Both
 * dispatch through `createGenericOperationGateway(pool, resolver)`, the single path into the catalog's business logic
 * in this process.
 *
 * A REST-only operation (`REST_ONLY_OPERATION_NAMES`) gets a tool here too, but the gateway lists it for no run and
 * refuses calls to it as unknown.
 *
 * `listGrantedGenericOperationAgentTools` is the discovery counterpart. Every tool re-checks the grant on each call, so
 * a stale or wrongly filtered catalog can never become a bypass.
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

/** Operations whose capability is not granted are absent, not listed as forbidden. */
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
