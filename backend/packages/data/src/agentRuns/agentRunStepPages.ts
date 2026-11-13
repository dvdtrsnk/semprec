import {
  parseToolEventPayload,
  type McpToolEventIdentity,
  type ToolResultChange,
  type ToolUseEventPayload,
} from "@semprec/shared";
import { approvalConflictReason } from "../mcp/approvalConflictReason.js";
import type { ApprovalRequestStateView } from "../mcp/approvalRequestsStore.js";
import type { AgentRunEventKind, AgentRunEventRow } from "./agentRunEventsStore.js";
import { stepKindTitle, stepSummary, stepTitle, type AgentStepTool } from "./agentStepCatalog.js";

/** The `limit` of `GET /api/agent-runs/:id/steps` when the request names none (issue #1821). */
export const AGENT_RUN_STEP_DEFAULT_LIMIT = 100;

/** The largest `limit` of `GET /api/agent-runs/:id/steps`; a larger one is a validation error (issue #1821). */
export const AGENT_RUN_STEP_MAX_LIMIT = 500;

/**
 * The event kinds that can produce a step. The others (`turn_start`, `turn_end`, `compaction` and
 * `user_message`) never do, so a page read leaves them out in SQL and a compaction checkpoint, the
 * largest legitimate payload, is never loaded for it.
 */
export const AGENT_RUN_STEP_EVENT_KINDS: readonly AgentRunEventKind[] = [
  "run_status",
  "message",
  "tool_use",
  "tool_result",
];

/**
 * Events read beyond the two a step needs at most, so that a block of parallel tool calls, whose
 * steps overlap and so cannot be split by a cursor, still fits in the one read of a page.
 */
const PAGE_ROW_MARGIN = 100;

/**
 * How long after its `finished_at` a run counts as settled for the cursor. The runtime closes the row
 * first and stores the terminal `run_status` event after it, so for a moment a finished run has no
 * `end` or `error` event yet; a reader told "nothing is left" in that moment would never see it.
 */
export const AGENT_RUN_STEP_SETTLE_MS = 60_000;

/**
 * Whether a run will not receive another event as far as a paging reader is concerned: it is no longer
 * `running` and it finished at least `AGENT_RUN_STEP_SETTLE_MS` ago. Only then may the cursor end
 * (`null`) on a run whose terminal event is missing.
 */
export function isAgentRunStepReadSettled(
  run: { status: string; finishedAt: string | null },
  now: Date = new Date(),
): boolean {
  if (run.status === "running" || run.finishedAt === null) return false;
  return now.getTime() - Date.parse(run.finishedAt) >= AGENT_RUN_STEP_SETTLE_MS;
}

/** How many events (of `AGENT_RUN_STEP_EVENT_KINDS`) the read of a page of `stepLimit` steps fetches at most. */
export function agentRunStepPageRowLimit(stepLimit: number): number {
  return stepLimit * 2 + PAGE_ROW_MARGIN;
}

export type AgentRunStepKind = "start" | "plan" | "tool" | "approval" | "answer" | "end" | "error";
/** What the events alone say about a step; `running` is a call without a result. */
type AgentRunDraftState = "running" | "ok" | "error";
/** `waitingApproval` is an approval step whose request is still pending (issue #1862); the events never say so. */
export type AgentRunStepState = AgentRunDraftState | "waitingApproval";

/** Where the approval request of an approval step stands, read from the request when the steps are read (issue #1862). */
export type AgentRunApprovalState = "pending" | "executing" | "executed" | "failed" | "conflict" | "rejected";

/** The longest a value of a step's `change` is: a longer string is cut and marked with an ellipsis. */
export const AGENT_RUN_STEP_VALUE_MAX_LENGTH = 200;

/** The text the stored result of a content-bearing call on a sensitive database is replaced with (issue #1827). */
const REDACTED_RESULT_MARKER = "[redacted: sensitive]";

/** The first property a call changed; `from` and `to` are `null` when the call did not report that value. */
export interface AgentRunStepChange {
  property: string;
  from: unknown;
  to: unknown;
}

/** The part of a step the events alone decide (issues #1821, #1847). */
interface AgentRunStepCore {
  /** The id of the step's first event. */
  stepId: string;
  /** `approval` is a tool step whose call created an approval request. */
  kind: AgentRunStepKind;
  /** When the step's first event was stored. */
  at: string;
  /** The milliseconds between a tool call and its result; `null` for every other step and for a tool call without a result. */
  durationMs: number | null;
  /** The tool call's id; `null` for every step that is not a tool step. */
  toolCallId: string | null;
  /** The dotted generic operation a tool step called; `null` for an MCP tool, for a tool stored without identity and for any other step. */
  operation: NonNullable<ToolUseEventPayload["operation"]> | null;
  /** The MCP tool a tool step called; `null` for a generic operation, for a tool stored without identity and for any other step. */
  mcp: McpToolEventIdentity | null;
  /** The id of the approval request the call created; `null` unless `kind` is `approval`. */
  approvalRequestId: string | null;
}

/**
 * One step of a run as `GET /api/agent-runs/:id/steps` returns it (issues #1821 and #1847). Tool arguments,
 * tool results, the model's text, raw error text and thinking are never part of it.
 */
export interface AgentRunStep extends AgentRunStepCore {
  state: AgentRunStepState;
  /** The localized title: the tool and its target database ("Changing a task"), or what a non-tool step is. */
  title: string;
  /** The display name of the item the call worked on; `null` when the call named none or it cannot be read. */
  targetName: string | null;
  /** The first property an `item.patch` changed; `null` for any other step and for a redacted result. */
  change: AgentRunStepChange | null;
  /** The localized outcome of the step, composed from structured fields only; `null` while a call runs and for steps with none. */
  summary: string | null;
  /** Only on an approval step whose request could be read. */
  approvalState?: AgentRunApprovalState;
  /** The `approval.conflict.*` key that says why an approved request was not carried out; only when `approvalState` is `conflict`. */
  conflictReason?: string;
}

/**
 * What the events say about a step beyond its core, kept for the projection and never returned as it is.
 * Ids that the model wrote into a call's arguments are kept only for a generic operation, whose argument
 * names are the platform's own.
 */
export interface AgentRunStepFacts {
  /** The model-facing name of the called tool; `null` for a step that is not a tool step. */
  toolName: string | null;
  targetDatabaseId: string | null;
  targetItemId: string | null;
  /** The first `details.changes` entry, its values bounded; `null` for none and for a redacted result. */
  change: AgentRunStepChange | null;
  /** How many entries `details.changes` holds; 0 for a redacted result. */
  changeCount: number;
}

/** A step as the grouping builds it: the core of the returned step and the facts its projection needs. */
export interface AgentRunStepDraft extends AgentRunStepCore {
  state: AgentRunDraftState;
  facts: AgentRunStepFacts;
}

export interface AgentRunStepPage {
  steps: AgentRunStepDraft[];
  nextCursor: string | null;
}

/** A step with the bookkeeping the page selection needs and the response does not carry. */
interface PendingStep {
  step: AgentRunStepDraft;
  /** The id of the step's last event; equal to `step.stepId` for a step of one event. */
  lastEventId: string;
  /** False for a tool call whose result has not been seen. */
  closed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function noFacts(): AgentRunStepFacts {
  return { toolName: null, targetDatabaseId: null, targetItemId: null, change: null, changeCount: 0 };
}

function closedStep(event: AgentRunEventRow, kind: AgentRunStepKind, state: AgentRunDraftState): PendingStep {
  return {
    step: {
      stepId: event.id,
      kind,
      state,
      at: event.at,
      durationMs: null,
      toolCallId: null,
      operation: null,
      mcp: null,
      approvalRequestId: null,
      facts: noFacts(),
    },
    lastEventId: event.id,
    closed: true,
  };
}

/** `start` for the opening `running`, `end` for `done`, `error` for `error`; any other payload is not a step. */
function runStatusStep(event: AgentRunEventRow): PendingStep | null {
  if (!isRecord(event.payload)) return null;
  switch (event.payload.status) {
    case "running":
      return closedStep(event, "start", "ok");
    case "done":
      return closedStep(event, "end", "ok");
    case "error":
      return closedStep(event, "error", "error");
    default:
      return null;
  }
}

function hasToolCallBlock(content: unknown): boolean {
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.type === "toolCall");
}

/** `plan` for an assistant message with text that calls tools, `answer` for one that does not; a message without text is not a step. */
function messageStep(event: AgentRunEventRow): PendingStep | null {
  const payload = event.payload;
  if (!isRecord(payload) || payload.role !== "assistant") return null;
  if (typeof payload.text !== "string" || payload.text.trim() === "") return null;
  return closedStep(event, hasToolCallBlock(payload.content) ? "plan" : "answer", "ok");
}

/**
 * A tool call failed when its result says so: `isError`, `result.details.error`, or, for a row stored
 * before the interrupted-result fix of issue #1374, a top-level `error: true`.
 */
function toolResultFailed(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (payload.isError === true || payload.error === true) return true;
  return isRecord(payload.result) && isRecord(payload.result.details) && payload.result.details.error === true;
}

function toolCallIdOf(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.toolCallId === "string" ? payload.toolCallId : null;
}

/** Orders step events by id; ids are bigints kept as strings. */
function laterId(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}

/** A string longer than `AGENT_RUN_STEP_VALUE_MAX_LENGTH` is cut and marked; JSON longer than that becomes such a string. */
function boundValue(value: unknown): unknown {
  const text =
    typeof value === "string" ? value : typeof value === "object" && value !== null ? JSON.stringify(value) : null;
  if (text === null || text.length <= AGENT_RUN_STEP_VALUE_MAX_LENGTH) return value;
  return `${text.slice(0, AGENT_RUN_STEP_VALUE_MAX_LENGTH)}\u2026`;
}

/** Whether the stored result is the marker of a result redacted as sensitive (issue #1827), as a text or as the content of a result. */
function isRedactedResult(result: unknown): boolean {
  if (result === REDACTED_RESULT_MARKER) return true;
  if (!isRecord(result)) return false;
  const content = result.content;
  if (content === REDACTED_RESULT_MARKER) return true;
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.text === REDACTED_RESULT_MARKER);
}

/** The first of `changes` as a step's `change`, its values bounded; `null` for no entry. */
function firstChange(changes: readonly ToolResultChange[]): AgentRunStepChange | null {
  const first = changes[0];
  if (first === undefined) return null;
  return {
    property: first.key,
    from: first.before === undefined ? null : boundValue(first.before),
    to: first.after === undefined ? null : boundValue(first.after),
  };
}

/** The ids a tool event names, kept only for a generic operation (see `AgentRunStepFacts`). */
function targetIds(event: {
  operation?: unknown;
  targetDatabaseId?: string;
  targetItemId?: string;
}): Pick<AgentRunStepFacts, "targetDatabaseId" | "targetItemId"> {
  if (event.operation === undefined) return { targetDatabaseId: null, targetItemId: null };
  return { targetDatabaseId: event.targetDatabaseId ?? null, targetItemId: event.targetItemId ?? null };
}

/**
 * What the typed parse of a stored `tool_result` adds to the step it closes (or, for a result whose call
 * is gone, to the step it makes): the approval request, the changes and, for a call stored without
 * target ids, the ones of the result. A result that does not parse adds nothing.
 */
function applyResultFacts(step: AgentRunStepDraft, payload: unknown): void {
  const result = parseToolEventPayload("tool_result", payload);
  if (!result) return;
  const ids = targetIds(result);
  step.facts.targetDatabaseId ??= ids.targetDatabaseId;
  step.facts.targetItemId ??= ids.targetItemId;
  const approvalRequestId = result.details?.approvalRequestId;
  if (approvalRequestId !== undefined) {
    step.kind = "approval";
    step.approvalRequestId = approvalRequestId;
  }
  const changes = result.details?.changes;
  if (changes !== undefined && !isRedactedResult(result.result)) {
    step.facts.change = firstChange(changes);
    step.facts.changeCount = changes.length;
  }
}

/** Groups the events, which must be in id order, into steps in the order of their first event. */
function groupSteps(events: readonly AgentRunEventRow[]): PendingStep[] {
  const steps: PendingStep[] = [];
  const openTools = new Map<string, PendingStep>();
  for (const event of events) {
    switch (event.kind) {
      case "run_status": {
        const step = runStatusStep(event);
        if (step) steps.push(step);
        break;
      }
      case "message": {
        const step = messageStep(event);
        if (step) steps.push(step);
        break;
      }
      case "tool_use": {
        const use = parseToolEventPayload("tool_use", event.payload);
        if (!use) break;
        const step: PendingStep = {
          step: {
            stepId: event.id,
            kind: "tool",
            state: "running",
            at: event.at,
            durationMs: null,
            toolCallId: use.toolCallId,
            operation: use.operation ?? null,
            mcp: use.mcp ?? null,
            approvalRequestId: null,
            facts: { ...noFacts(), toolName: use.name, ...targetIds(use) },
          },
          lastEventId: event.id,
          closed: false,
        };
        steps.push(step);
        openTools.set(use.toolCallId, step);
        break;
      }
      case "tool_result": {
        const toolCallId = toolCallIdOf(event.payload);
        if (toolCallId === null) break;
        const state = toolResultFailed(event.payload) ? "error" : "ok";
        const open = openTools.get(toolCallId);
        if (open) {
          openTools.delete(toolCallId);
          open.step.state = state;
          open.step.durationMs = Date.parse(event.at) - Date.parse(open.step.at);
          applyResultFacts(open.step, event.payload);
          open.lastEventId = event.id;
          open.closed = true;
          break;
        }
        // A result whose call is gone (the history before it was removed) is still a step of the run.
        const result = parseToolEventPayload("tool_result", event.payload);
        const orphan = closedStep(event, "tool", state);
        orphan.step.toolCallId = toolCallId;
        orphan.step.operation = result?.operation ?? null;
        orphan.step.mcp = result?.mcp ?? null;
        orphan.step.facts.toolName = result?.name ?? null;
        applyResultFacts(orphan.step, event.payload);
        steps.push(orphan);
        break;
      }
      default:
        break;
    }
  }
  return steps;
}

/**
 * One page of a run's steps (issue #1821), from the events `listAgentRunEventsForStepPage` read after
 * the request's cursor.
 *
 * The events are grouped into steps (`start`, `plan`, `tool`, `answer`, `end`, `error`); a tool call and
 * its result, matched on `toolCallId`, are one `tool` step. A page holds the first `limit` steps and
 * its `nextCursor` is the id of the last event of the last step the page closes, with these rules:
 *
 * - The cursor never lies inside a step, and never lies before an event of a step the page does not
 *   hold: the page ends at the last point where every step that started is closed and holds all its
 *   events. Parallel tool calls overlap, so they are one block that is never split; a block of more
 *   than `limit` steps at the start of the page is returned whole, which is the one way a page holds
 *   more steps than `limit`.
 * - A tool call whose result has not arrived is returned as `running` after the closed steps, and the
 *   cursor stays before it, so the next request returns it again, complete. Closed steps that come
 *   after it in the run wait for that request as well.
 * - `nextCursor` is `null` when the page holds every step there is and nothing is left to read: the
 *   last of them is the run's `end` or `error` step, or the run is settled (`runSettled`, see
 *   `isAgentRunStepReadSettled`) and so will not change, which also covers a finished run whose events
 *   retention removed or whose terminal `run_status` was never stored. When the page holds no step, the cursor stays at `after`, the request's
 *   own cursor, except that it moves to the last event of a read that was full of events producing no
 *   step.
 *
 * A settled run has no running step: a tool call that still has no result will never get one, so it
 * is returned as an `error` step (the call was interrupted) and the cursor passes it. Without that, a
 * reader that follows `nextCursor` until `null` would be handed the same step for ever.
 *
 * `hasMore` says that the read stopped at its row limit with more events behind it. Then a tool call
 * without a result is not known to be running, since its result may follow in a later read, so it is
 * not returned.
 *
 * Throws when `hasMore` and the read holds steps but no point where the cursor could be placed: one
 * block of overlapping tool calls, or one call whose result lies beyond the read, fills it. The read
 * allows for blocks of dozens of parallel calls (`agentRunStepPageRowLimit`).
 */
export function buildAgentRunStepPage(input: {
  events: readonly AgentRunEventRow[];
  hasMore: boolean;
  after: string;
  limit: number;
  /** The run is over and past `AGENT_RUN_STEP_SETTLE_MS`; false for a running run. */
  runSettled: boolean;
}): AgentRunStepPage {
  const { events, hasMore, after, limit, runSettled } = input;
  const steps = groupSteps(events);
  // The read holds every event of the run after the cursor, so a call still open in it never gets a result.
  const exhausted = runSettled && !hasMore;
  if (exhausted) {
    for (const step of steps) {
      if (step.closed) continue;
      step.step.state = "error";
      step.closed = true;
    }
  }

  // `chosen` is the number of leading steps the cursor passes: the most that is at most `limit`, or
  // else the first block that ends the page whole.
  let chosen = 0;
  let cursor = after;
  let prefixEnd = "0";
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (!step.closed) break;
    prefixEnd = laterId(prefixEnd, step.lastEventId);
    const next = steps[i + 1];
    if (next !== undefined && BigInt(next.step.stepId) <= BigInt(prefixEnd)) continue;
    if (i + 1 > limit && chosen > 0) break;
    chosen = i + 1;
    cursor = prefixEnd;
    if (chosen >= limit) break;
  }

  const running = hasMore
    ? []
    : steps
        .slice(chosen)
        .filter((step) => !step.closed)
        .slice(0, Math.max(0, limit - chosen));
  const pageSteps = [...steps.slice(0, chosen), ...running].map((step) => step.step);

  if (pageSteps.length === 0) {
    const lastRead = events.at(-1);
    // The read ended on events that make no step. Nothing before its last event is left to return,
    // so the cursor moves past it and a long run of such events cannot stall the reader.
    if (hasMore && steps.length === 0 && lastRead) return { steps: [], nextCursor: lastRead.id };
    if (hasMore)
      throw new Error(
        "A step page read holds no point for a cursor: overlapping tool calls or an unanswered call fill it",
      );
    return { steps: [], nextCursor: exhausted ? null : after };
  }

  const last = steps[chosen - 1];
  const reachedEnd =
    !hasMore &&
    chosen === steps.length &&
    (runSettled || (last !== undefined && (last.step.kind === "end" || last.step.kind === "error")));
  return { steps: pageSteps, nextCursor: reachedEnd ? null : cursor };
}

/** The longest a step's `targetName` is: a longer name is cut and marked with an ellipsis. */
export const AGENT_RUN_STEP_TARGET_NAME_MAX_LENGTH = 200;

/**
 * What one page's steps point at, read in one batch (`loadAgentRunStepTargets`): the items by id with
 * the database they are in and their display name, and the module id of each database.
 */
export interface AgentRunStepTargets {
  items: ReadonlyMap<string, { databaseId: string; name: string | null }>;
  /** The `owner_module_id` of a database; `null` for a database no module owns. */
  databaseModuleIds: ReadonlyMap<string, string | null>;
}

/** The tool and approval steps of a whole run, for the summary of its `end` step. */
export interface AgentRunToolStepCounts {
  toolCount: number;
  approvalCount: number;
}

function stepTool(step: AgentRunStepDraft): AgentStepTool {
  if (step.operation !== null) return { kind: "operation", operation: step.operation };
  if (step.mcp !== null) return { kind: "mcp", toolName: step.mcp.toolName };
  return step.facts.toolName === null ? { kind: "unknown" } : { kind: "named", toolName: step.facts.toolName };
}

function boundName(name: string): string {
  return name.length <= AGENT_RUN_STEP_TARGET_NAME_MAX_LENGTH
    ? name
    : `${name.slice(0, AGENT_RUN_STEP_TARGET_NAME_MAX_LENGTH)}\u2026`;
}

async function projectToolStep(
  step: AgentRunStepDraft,
  locale: string,
  targets: AgentRunStepTargets,
): Promise<Pick<AgentRunStep, "title" | "targetName" | "summary">> {
  const { facts } = step;
  const item = facts.targetItemId === null ? undefined : targets.items.get(facts.targetItemId);
  const databaseId = facts.targetDatabaseId ?? item?.databaseId ?? null;
  const moduleId = databaseId === null ? null : (targets.databaseModuleIds.get(databaseId) ?? null);
  return {
    title: await stepTitle(locale, stepTool(step), moduleId),
    targetName: item?.name == null ? null : boundName(item.name),
    summary: await stepSummary(locale, {
      kind: "tool",
      state: step.state,
      operation: step.operation,
      approval: step.kind === "approval",
      changeCount: facts.changeCount,
    }),
  };
}

/** The reason key of a request whose MCP tool call failed on execution (issue #1437): that outcome is `failed`, not a conflict. */
const APPROVAL_CALL_FAILED_KEY = "approval.outcome.failed";

/** The reason of a conflict that no `execution_result_jsonb` discriminator explains, and of a request from before the execution protocol. */
const APPROVAL_CONFLICT_OTHER_KEY = "approval.conflict.other";

/**
 * Where an approval step stands, from its request (issue #1862); `null` for a state no row can have (an
 * `approved` request whose execution is not `queued`, `succeeded` or terminal). The decision comes first:
 * a `pending` request is `pending` and a `rejected` one `rejected` whatever its execution status, so a
 * request the cutover to the execution protocol rejected and marked `legacy_terminal` reads `rejected`.
 * An approved one reads its execution: `queued` is `executing`, `succeeded` `executed`, a `conflict` whose
 * reason is the failed MCP call (`approvalConflictReason`) `failed` and any other `conflict`, like
 * `legacy_terminal`, `conflict` with that reason's key. Only the discriminators of the stored result are
 * read; its text never is.
 */
export function approvalStepState(
  request: Pick<ApprovalRequestStateView, "status" | "executionStatus" | "executionResult">,
): { approvalState: AgentRunApprovalState; conflictReason?: string } | null {
  if (request.status === "pending") return { approvalState: "pending" };
  if (request.status === "rejected") return { approvalState: "rejected" };
  switch (request.executionStatus) {
    case "queued":
      return { approvalState: "executing" };
    case "succeeded":
      return { approvalState: "executed" };
    case "conflict": {
      // `approvalConflictReason` answers `null` only for a request that is not in `conflict`, which this is.
      const key = approvalConflictReason("conflict", request.executionResult)?.key ?? APPROVAL_CONFLICT_OTHER_KEY;
      return key === APPROVAL_CALL_FAILED_KEY
        ? { approvalState: "failed" }
        : { approvalState: "conflict", conflictReason: key };
    }
    case "legacy_terminal":
      return { approvalState: "conflict", conflictReason: APPROVAL_CONFLICT_OTHER_KEY };
    case "not_approved":
      return null;
  }
}

/** The step state an approval state gives: waiting while pending, an error for a failure or a conflict, ok otherwise. */
function stepStateOfApproval(approvalState: AgentRunApprovalState): AgentRunStepState {
  if (approvalState === "pending") return "waitingApproval";
  return approvalState === "failed" || approvalState === "conflict" ? "error" : "ok";
}

/**
 * The steps of a page as the route returns them (issues #1847 and #1862): each draft with its localized
 * title and summary, its target's name and its first change. `targets` is what the page's calls point at,
 * `counts` the tool and approval steps of the whole run, read only when the page holds the `end` step, and
 * `approvals` the requests of the page's approval steps by id. An approval step whose request is in
 * `approvals` and has a state (`approvalStepState`) carries `approvalState`, the `conflictReason` of a
 * conflict, and the step `state` that follows from it; one whose request is missing keeps the state of its
 * call and has no `approvalState`. A call whose item or database cannot be read keeps its title with the
 * generic noun and has no `targetName`. The only values it takes from a result are the structured fields
 * of its `details` (the approval request id and the changes); no argument, result content, model text or
 * error text reaches it.
 */
export async function projectAgentRunSteps(input: {
  steps: readonly AgentRunStepDraft[];
  locale: string;
  targets: AgentRunStepTargets;
  counts: AgentRunToolStepCounts | null;
  approvals: ReadonlyMap<string, ApprovalRequestStateView>;
}): Promise<AgentRunStep[]> {
  const { locale, targets, counts, approvals } = input;
  return Promise.all(
    input.steps.map(async (draft): Promise<AgentRunStep> => {
      const { facts, ...core } = draft;
      if (draft.kind === "tool" || draft.kind === "approval") {
        const request = draft.approvalRequestId === null ? undefined : approvals.get(draft.approvalRequestId);
        const derived = request === undefined ? null : approvalStepState(request);
        return {
          ...core,
          ...(await projectToolStep(draft, locale, targets)),
          change: facts.change,
          ...(derived === null ? {} : { ...derived, state: stepStateOfApproval(derived.approvalState) }),
        };
      }
      return {
        ...core,
        title: await stepKindTitle(locale, draft.kind),
        targetName: null,
        change: null,
        summary: draft.kind === "end" && counts !== null ? await stepSummary(locale, { kind: "end", ...counts }) : null,
      };
    }),
  );
}
