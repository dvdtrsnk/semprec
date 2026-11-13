import type { GenericOperationName } from "@semprec/shared";
import type { AgentRunEventRow } from "../agentRuns/agentRunEventsStore.js";
import { AGENT_RUN_STEP_TARGET_NAME_MAX_LENGTH, boundValue } from "../agentRuns/agentRunStepPages.js";
import type { SempReplyTargets } from "./sempReplyTargets.js";
import { pairSempToolCalls, sempToolCallApprovalRequestId, sempUuid, type SempToolCall } from "./sempReplyToolCalls.js";

/**
 * The typed summary of the steps of a Semp reply (issue #1860), stored on the assistant message when its turn
 * ends so it outlives the 30-day retention of the events it is made from. A step carries i18n keys with
 * params, never a localized text: the keys are the `agentStep.*` entries of the agent-run catalog
 * (`agentRuns/i18n`), which also render the steps of `GET /api/agent-runs/:id/steps` (issue #1847).
 *
 * What a step may hold is conservative because it is permanent. Params are counts, names of targets, the
 * property keys of a change and the `before` and `after` of fields from `details.changes`; never free text
 * from a call's arguments or result. A step on an item of a sensitive database holds none of them.
 */

/** The status a stored step has; `running` exists only while the turn runs and is never stored. */
export type SempReplyStepStatus = "ok" | "wait" | "error";

/** One changed property in the params of a step: its key and the values the result reported for it. */
export interface SempReplyStepChange {
  key: string;
  before?: unknown;
  after?: unknown;
}

/** The params of an i18n key; every value is a JSON value. */
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
  /** The model-facing name of a tool step's tool. */
  toolName?: string;
  /** The dotted name of the generic operation a tool step called. */
  operation?: GenericOperationName;
  label: SempReplyStepText;
  detail: SempReplyStepText;
  status: SempReplyStepStatus;
  startedAt: string;
  durationMs: number;
  approvalRequestId?: string;
  /** The `ChokePointError.code` of a failed generic operation, or the `failureKind` of a failed MCP tool call. */
  errorCode?: string;
  /** Only for a model step whose message event carries token usage. */
  tokens?: { input: number; output: number };
}

/** The operations whose own summary entry (`agentStep.summary.operation.<name>`) the catalog holds. */
export const SEMP_REPLY_OPERATIONS_WITH_SUMMARY: ReadonlySet<GenericOperationName> = new Set<GenericOperationName>([
  "item.get",
  "item.create",
  "item.patch",
  "item.delete",
  "item.restore",
  "database.query",
  "view.query",
]);

/** A tool name as a model provider accepts it; anything else has no name worth storing and reads the generic title. */
const MODEL_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A code as the platform writes it (a `ChokePointError` code, an MCP failure kind); free text never matches. */
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
 * The time of the whole turn: from its first `turn_start` event to its last `turn_end` event, not the sum of
 * its steps. pi emits a `turn_start` and a `turn_end` for every model round, so a turn that failed in a later
 * round has the `turn_end` of an earlier one; a round that started after the last `turn_end` (or a turn with no
 * `turn_end` at all) never ended, and the turn lasted until its last event. `null` for events with no `turn_start`.
 */
export function sempTurnDurationMs(events: readonly AgentRunEventRow[]): number | null {
  const start = events.find((event) => event.kind === "turn_start");
  if (!start) return null;
  const lastEnd = events.map((event) => event.kind).lastIndexOf("turn_end");
  const unfinishedRound = events.map((event) => event.kind).lastIndexOf("turn_start") > lastEnd;
  const end = lastEnd === -1 || unfinishedRound ? events.at(-1) : events[lastEnd];
  return end ? elapsedMs(start.at, end.at) : null;
}

/** The token usage of a message event, when it carries one (`usage.input` and `usage.output` as counts). */
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

/** The assistant messages of the turn that carry text (the candidates for a model step), with what follows them. */
interface ModelMessage {
  event: AgentRunEventRow;
  payload: Record<string, unknown>;
  /** The latest `turn_start` before the message, else the event before it: when its generation began. */
  startedAt: string;
}

/**
 * The intermediate model generations of the turn: an assistant message with text that is followed by further
 * tool calls (it calls tools itself, or a call event follows it) or by a later assistant message. The last
 * assistant message of the turn is the reply itself and is never a step.
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

/** The label of a tool step: the generic operation's title entry with the database's module, else a named or generic tool. */
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

/** The summary entry of a step that did not fail and is not waiting for approval. */
function doneDetailKey(operation: GenericOperationName | undefined): string {
  return operation !== undefined && SEMP_REPLY_OPERATIONS_WITH_SUMMARY.has(operation)
    ? `agentStep.summary.operation.${operation}`
    : "agentStep.summary.done";
}

/** The params of a changed-properties summary: the count, the changed keys and the values of each change. */
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
  // The ids in an MCP tool's arguments are the model's own and name nothing of the platform's.
  const generic = call.operation !== undefined;
  const itemId = generic ? sempUuid(call.targetItemId ?? call.args.itemId) : null;
  const item = itemId === null ? undefined : targets.items.get(itemId);
  const databaseId = generic
    ? (sempUuid(call.targetDatabaseId ?? call.args.databaseId) ?? item?.databaseId ?? null)
    : null;
  const database = databaseId === null ? undefined : targets.databases.get(databaseId);
  // A generic operation that names a target the lookup cannot place counts as sensitive: on a doubt nothing is stored.
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
    ...(status === "error" && code !== undefined && ERROR_CODE.test(code) ? { errorCode: code } : {}),
  };
}

/**
 * The steps of one turn, from its events (`agent_run_id` = the message's run and `id` between its
 * `event_from_id` and `event_to_id`), in the order of each step's first event. A tool step is a tool call and
 * its result matched on `toolCallId`; a call without a result ended with the turn and is an `error` step.
 * `targets` is what the calls point at (`loadSempReplyTargets`). The result is the array stored in
 * `semp_messages.steps`: the same events always give the same steps.
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
