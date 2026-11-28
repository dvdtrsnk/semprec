import type { GenericOperationName } from "@alldots/shared";
import type { AgentRunEventRow } from "../agentRuns/agentRunEventsStore.js";
import { AGENT_RUN_STEP_TARGET_NAME_MAX_LENGTH, boundValue } from "../agentRuns/agentRunStepPages.js";
import type { SempReplyTargets } from "./sempReplyTargets.js";
import { pairSempToolCalls, sempToolCallApprovalRequestId, sempUuid, type SempToolCall } from "./sempReplyToolCalls.js";

/**
 * Typed step summary of a Semp reply, stored on the assistant message so it outlives event retention. Steps hold
 * `agentStep.*` i18n keys with params, never localized text.
 *
 * It is permanent, so params are conservative: counts, target names, changed property keys and `before`/`after`
 * from `details.changes`, never free text from arguments or results, and nothing for a sensitive database.
 */

/** `running` exists only while the turn runs and is never stored. */
export type SempReplyStepStatus = "ok" | "wait" | "error";

export interface SempReplyStepChange {
  key: string;
  before?: unknown;
  after?: unknown;
}

export type SempReplyStepParams = Readonly<
  Record<string, string | number | readonly string[] | readonly SempReplyStepChange[]>
>;

export interface SempReplyStepText {
  key: string;
  params: SempReplyStepParams;
}

export interface SempReplyStep {
  kind: "tool" | "model";
  toolCallId?: string;
  toolName?: string;
  operation?: GenericOperationName;
  label: SempReplyStepText;
  detail: SempReplyStepText;
  status: SempReplyStepStatus;
  startedAt: string;
  durationMs: number;
  approvalRequestId?: string;
  /** `ChokePointError.code` of a failed operation, or `failureKind` of a failed MCP call. */
  errorCode?: string;
  /** What a later successful call of the same MCP tool is matched on. */
  mcpToolRegistrationId?: string;
  mcpServerItemId?: string;
  /** As the grant named it. */
  connectorName?: string;
  /** Set when `errorCode` is `timeout`. */
  timeoutMs?: number;
  tokens?: { input: number; output: number };
}

export const SEMP_REPLY_OPERATIONS_WITH_SUMMARY: ReadonlySet<GenericOperationName> = new Set<GenericOperationName>([
  "item.get",
  "item.create",
  "item.patch",
  "item.delete",
  "item.restore",
  "database.query",
  "view.query",
]);

/** Anything else has no name worth storing and reads the generic title. */
const MODEL_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A platform code (`ChokePointError` code, MCP failure kind); free text never matches. */
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundName(name: string): string {
  return name.length <= AGENT_RUN_STEP_TARGET_NAME_MAX_LENGTH
    ? name
    : `${name.slice(0, AGENT_RUN_STEP_TARGET_NAME_MAX_LENGTH)}…`;
}

function elapsedMs(from: string, to: string): number {
  return Math.max(0, Date.parse(to) - Date.parse(from));
}

/**
 * First `turn_start` to last `turn_end`, not the sum of steps. pi emits both per model round, so a round started
 * after the last `turn_end` never ended and the turn lasted until its last event. `null` without a `turn_start`.
 */
export function sempTurnDurationMs(events: readonly AgentRunEventRow[]): number | null {
  const start = events.find((event) => event.kind === "turn_start");
  if (!start) return null;
  const lastEnd = events.map((event) => event.kind).lastIndexOf("turn_end");
  const unfinishedRound = events.map((event) => event.kind).lastIndexOf("turn_start") > lastEnd;
  const end = lastEnd === -1 || unfinishedRound ? events.at(-1) : events[lastEnd];
  return end ? elapsedMs(start.at, end.at) : null;
}

function messageTokens(payload: Record<string, unknown>): { input: number; output: number } | undefined {
  const usage = payload.usage;
  if (!isRecord(usage)) return undefined;
  const { input, output } = usage;
  if (typeof input !== "number" || typeof output !== "number") return undefined;
  if (!Number.isSafeInteger(input) || !Number.isSafeInteger(output) || input < 0 || output < 0) return undefined;
  return { input, output };
}

function hasToolCallBlock(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === "toolCall");
}

interface ModelMessage {
  event: AgentRunEventRow;
  payload: Record<string, unknown>;
  /** When its generation began: the latest `turn_start` before it, else the preceding event. */
  startedAt: string;
}

/**
 * Intermediate generations: assistant text followed by further tool calls or a later assistant message. The last
 * assistant message is the reply itself and never a step.
 */
function modelMessages(events: readonly AgentRunEventRow[]): ModelMessage[] {
  const found: ModelMessage[] = [];
  let generationStart: string | undefined;
  let previousAt: string | undefined;
  events.forEach((event, index) => {
    if (event.kind === "turn_start") generationStart = event.at;
    if (event.kind === "message" && isRecord(event.payload) && event.payload.role === "assistant") {
      const payload = event.payload;
      const followed =
        hasToolCallBlock(payload.content) ||
        events.slice(index + 1).some((later) => {
          if (later.kind === "tool_use") return true;
          return later.kind === "message" && isRecord(later.payload) && later.payload.role === "assistant";
        });
      if (typeof payload.text === "string" && payload.text.trim() !== "" && followed) {
        found.push({ event, payload, startedAt: generationStart ?? previousAt ?? event.at });
      }
      generationStart = undefined;
    }
    previousAt = event.at;
  });
  return found;
}

/** The operation's title with the database's module, else a named or generic tool. */
function toolLabel(call: SempToolCall, moduleId: string | null): SempReplyStepText {
  if (call.operation !== undefined) {
    return {
      key: `agentStep.title.operation.${call.operation}`,
      params: moduleId === null ? {} : { targetModuleId: moduleId },
    };
  }
  const toolName = call.mcp?.toolName ?? call.name;
  if (MODEL_TOOL_NAME.test(toolName)) return { key: "agentStep.title.namedTool", params: { toolName } };
  return { key: "agentStep.title.tool", params: {} };
}

function doneDetailKey(operation: GenericOperationName | undefined): string {
  return operation !== undefined && SEMP_REPLY_OPERATIONS_WITH_SUMMARY.has(operation)
    ? `agentStep.summary.operation.${operation}`
    : "agentStep.summary.done";
}

function changeParams(call: SempToolCall): SempReplyStepParams | null {
  const changes = call.result?.details?.changes;
  if (changes === undefined || changes.length === 0) return null;
  return {
    count: changes.length,
    changedKeys: changes.map((change) => change.key),
    changes: changes.map((change) => ({
      key: change.key,
      ...(change.before === undefined ? {} : { before: boundValue(change.before) }),
      ...(change.after === undefined ? {} : { after: boundValue(change.after) }),
    })),
  };
}

function toolStep(call: SempToolCall, targets: SempReplyTargets, turnEndAt: string): SempReplyStep {
  // An MCP tool's argument ids are the model's own and name nothing of the platform's.
  const generic = call.operation !== undefined;
  const itemId = generic ? sempUuid(call.targetItemId ?? call.args.itemId) : null;
  const item = itemId === null ? undefined : targets.items.get(itemId);
  const databaseId = generic
    ? (sempUuid(call.targetDatabaseId ?? call.args.databaseId) ?? item?.databaseId ?? null)
    : null;
  const database = databaseId === null ? undefined : targets.databases.get(databaseId);
  // A target the lookup cannot place counts as sensitive: on a doubt nothing is stored.
  const namesTarget = itemId !== null || databaseId !== null;
  const targetUnknown = namesTarget && (databaseId === null || database === undefined);
  const sensitive = call.redacted || database?.sensitive === true || targetUnknown;
  const itemName: SempReplyStepParams = !sensitive && item?.name != null ? { itemName: boundName(item.name) } : {};

  const approvalRequestId = sempToolCallApprovalRequestId(call);
  const status: SempReplyStepStatus =
    call.result === null || call.failed ? "error" : approvalRequestId !== undefined ? "wait" : "ok";

  let detail: SempReplyStepText;
  if (status === "error") {
    detail = { key: "agentStep.summary.failed", params: {} };
  } else if (sensitive) {
    detail = {
      key: status === "wait" ? "agentStep.summary.approvalRequested" : doneDetailKey(call.operation),
      params: {},
    };
  } else if (status === "wait") {
    detail = { key: "agentStep.summary.approvalRequested", params: itemName };
  } else {
    const changed = call.operation === "item.patch" ? changeParams(call) : null;
    detail = changed
      ? { key: "agentStep.summary.changedProperties", params: { ...itemName, ...changed } }
      : { key: doneDetailKey(call.operation), params: itemName };
  }

  const code = call.result?.details?.errorCode ?? call.result?.details?.failureKind;
  const failedCode = status === "error" && code !== undefined && ERROR_CODE.test(code) ? code : undefined;
  const registrationId = sempUuid(call.mcp?.toolRegistrationId);
  const serverItemId = sempUuid(call.mcp?.serverItemId);
  const timeoutMs = call.result?.details?.timeoutMs;
  return {
    kind: "tool",
    toolCallId: call.toolCallId,
    ...(MODEL_TOOL_NAME.test(call.name) ? { toolName: call.name } : {}),
    ...(call.operation === undefined ? {} : { operation: call.operation }),
    label: toolLabel(call, database?.moduleId ?? null),
    detail,
    status,
    startedAt: call.startedAt,
    durationMs: elapsedMs(call.startedAt, call.resultAt ?? turnEndAt),
    ...(status === "wait" && approvalRequestId !== undefined ? { approvalRequestId } : {}),
    ...(failedCode !== undefined ? { errorCode: failedCode } : {}),
    ...(registrationId !== null ? { mcpToolRegistrationId: registrationId } : {}),
    // Ids and the grant's name only, never a call's text.
    ...(status === "error" && call.mcp !== undefined
      ? {
          ...(serverItemId !== null ? { mcpServerItemId: serverItemId } : {}),
          connectorName: boundName(call.mcp.serverName),
          ...(failedCode === "timeout" && timeoutMs !== undefined && Number.isSafeInteger(timeoutMs)
            ? { timeoutMs }
            : {}),
        }
      : {}),
  };
}

/**
 * The steps of one turn from its events, ordered by each step's first event. A tool call without a result ended
 * with the turn and is an `error` step. Deterministic: the same events always give the same stored steps.
 */
export function projectSempReplySteps(input: {
  events: readonly AgentRunEventRow[];
  targets: SempReplyTargets;
}): SempReplyStep[] {
  const { events, targets } = input;
  const turnEndAt = events.at(-1)?.at;
  if (turnEndAt === undefined) return [];
  const slots = [
    ...pairSempToolCalls(events).map((call) => ({ firstEventId: call.firstEventId, call })),
    ...modelMessages(events).map((message) => ({ firstEventId: message.event.id, message })),
  ];
  return slots
    .sort((a, b) => (BigInt(a.firstEventId) < BigInt(b.firstEventId) ? -1 : 1))
    .map((slot): SempReplyStep => {
      if ("call" in slot) return toolStep(slot.call, targets, turnEndAt);
      const { message } = slot;
      const tokens = messageTokens(message.payload);
      return {
        kind: "model",
        label: { key: "agentStep.title.plan", params: {} },
        detail: { key: "agentStep.summary.done", params: {} },
        status: "ok",
        startedAt: message.startedAt,
        durationMs: elapsedMs(message.startedAt, message.event.at),
        ...(tokens ? { tokens } : {}),
      };
    });
}
