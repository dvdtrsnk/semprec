import {
  parseToolEventPayload,
  type McpToolEventIdentity,
  type ToolResultChange,
  type ToolUseEventPayload,
} from "@alldots/shared";
import { approvalConflictReason } from "../mcp/approvalConflictReason.js";
import type { ApprovalRequestStateView } from "../mcp/approvalRequestsStore.js";
import type { AgentRunEventKind, AgentRunEventRow } from "./agentRunEventsStore.js";
import { stepKindTitle, stepSummary, stepTitle, type AgentStepTool } from "./agentStepCatalog.js";

export const AGENT_RUN_STEP_DEFAULT_LIMIT = 100;

export const AGENT_RUN_STEP_MAX_LIMIT = 500;

/**
 * The other kinds never produce a step, so a page read filters them in SQL and never loads a compaction
 * checkpoint, the largest payload.
 */
export const AGENT_RUN_STEP_EVENT_KINDS: readonly AgentRunEventKind[] = [
  "run_status",
  "message",
  "tool_use",
  "tool_result",
];

/** Room for a block of parallel tool calls, whose overlapping steps cannot be split by a cursor. */
const PAGE_ROW_MARGIN = 100;

/**
 * The runtime closes the row before storing the terminal `run_status` event, so for a moment a finished run has
 * no `end` or `error` event; a reader told "nothing is left" then would never see it.
 */
export const AGENT_RUN_STEP_SETTLE_MS = 60_000;

/** Only a settled run may end the cursor (`null`) while its terminal event is missing. */
export function isAgentRunStepReadSettled(
  run: { status: string; finishedAt: string | null },
  now: Date = new Date(),
): boolean {
  if (run.status === "running" || run.finishedAt === null) return false;
  return now.getTime() - Date.parse(run.finishedAt) >= AGENT_RUN_STEP_SETTLE_MS;
}

export function agentRunStepPageRowLimit(stepLimit: number): number {
  return stepLimit * 2 + PAGE_ROW_MARGIN;
}

export type AgentRunStepKind = "start" | "plan" | "tool" | "approval" | "answer" | "end" | "error";
/** `running` is a call without a result. */
type AgentRunDraftState = "running" | "ok" | "error";
/** An approval step whose request is still pending; the events never say so. */
export type AgentRunStepState = AgentRunDraftState | "waitingApproval";

/** Read from the request at step-read time. */
export type AgentRunApprovalState = "pending" | "executing" | "executed" | "failed" | "conflict" | "rejected";

export const AGENT_RUN_STEP_VALUE_MAX_LENGTH = 200;

/** Replaces the stored result of a content-bearing call on a sensitive database. */
const REDACTED_RESULT_MARKER = "[redacted: sensitive]";

/** `from`/`to` are `null` when the call did not report that value. */
export interface AgentRunStepChange {
  property: string;
  from: unknown;
  to: unknown;
}

/** The part of a step the events alone decide. */
interface AgentRunStepCore {
  /** The id of the step's first event. */
  stepId: string;
  /** `approval` is a tool step whose call created an approval request. */
  kind: AgentRunStepKind;
  at: string;
  /** `null` except for a tool call with a result. */
  durationMs: number | null;
  toolCallId: string | null;
  operation: NonNullable<ToolUseEventPayload["operation"]> | null;
  mcp: McpToolEventIdentity | null;
  approvalRequestId: string | null;
}

/** Tool arguments, tool results, model text, raw error text and thinking are never part of it. */
export interface AgentRunStep extends AgentRunStepCore {
  state: AgentRunStepState;
  title: string;
  /** `null` when the call named no item or it cannot be read. */
  targetName: string | null;
  /** Only for `item.patch`; `null` for a redacted result. */
  change: AgentRunStepChange | null;
  /** Composed from structured fields only. */
  summary: string | null;
  /** Only on an approval step whose request could be read. */
  approvalState?: AgentRunApprovalState;
  /** Only when `approvalState` is `conflict`. */
  conflictReason?: string;
}

/**
 * Never returned as is. Ids the model wrote into arguments are kept only for a generic operation, whose argument
 * names are the platform's own.
 */
export interface AgentRunStepFacts {
  toolName: string | null;
  targetDatabaseId: string | null;
  targetItemId: string | null;
  /** Values bounded; `null` for none and for a redacted result. */
  change: AgentRunStepChange | null;
  /** 0 for a redacted result. */
  changeCount: number;
}

export interface AgentRunStepDraft extends AgentRunStepCore {
  state: AgentRunDraftState;
  facts: AgentRunStepFacts;
}

export interface AgentRunStepPage {
  steps: AgentRunStepDraft[];
  nextCursor: string | null;
}

interface PendingStep {
  step: AgentRunStepDraft;
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

/** A message without text is not a step. */
function messageStep(event: AgentRunEventRow): PendingStep | null {
  const payload = event.payload;
  if (!isRecord(payload) || payload.role !== "assistant") return null;
  if (typeof payload.text !== "string" || payload.text.trim() === "") return null;
  return closedStep(event, hasToolCallBlock(payload.content) ? "plan" : "answer", "ok");
}

/** Older rows mark an interrupted result with a top-level `error: true`. */
export function toolResultFailed(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (payload.isError === true || payload.error === true) return true;
  return isRecord(payload.result) && isRecord(payload.result.details) && payload.result.details.error === true;
}

function toolCallIdOf(payload: unknown): string | null {
  return isRecord(payload) && typeof payload.toolCallId === "string" ? payload.toolCallId : null;
}

/** Ids are bigints kept as strings. */
function laterId(a: string, b: string): string {
  return BigInt(a) >= BigInt(b) ? a : b;
}

export function boundValue(value: unknown): unknown {
  const text =
    typeof value === "string" ? value : typeof value === "object" && value !== null ? JSON.stringify(value) : null;
  if (text === null || text.length <= AGENT_RUN_STEP_VALUE_MAX_LENGTH) return value;
  return `${text.slice(0, AGENT_RUN_STEP_VALUE_MAX_LENGTH)}\u2026`;
}

/** As a text or as the content of a result. */
export function isRedactedResult(result: unknown): boolean {
  if (result === REDACTED_RESULT_MARKER) return true;
  if (!isRecord(result)) return false;
  const content = result.content;
  if (content === REDACTED_RESULT_MARKER) return true;
  return Array.isArray(content) && content.some((block) => isRecord(block) && block.text === REDACTED_RESULT_MARKER);
}

function firstChange(changes: readonly ToolResultChange[]): AgentRunStepChange | null {
  const first = changes[0];
  if (first === undefined) return null;
  return {
    property: first.key,
    from: first.before === undefined ? null : boundValue(first.before),
    to: first.after === undefined ? null : boundValue(first.after),
  };
}

/** Only for a generic operation (see `AgentRunStepFacts`). */
function targetIds(event: {
  operation?: unknown;
  targetDatabaseId?: string;
  targetItemId?: string;
}): Pick<AgentRunStepFacts, "targetDatabaseId" | "targetItemId"> {
  if (event.operation === undefined) return { targetDatabaseId: null, targetItemId: null };
  return { targetDatabaseId: event.targetDatabaseId ?? null, targetItemId: event.targetItemId ?? null };
}

/**
 * For a result whose call is gone, the facts go to the step the result makes. A call stored without target ids
 * takes the result's. A result that does not parse adds nothing.
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

/** `events` must be in id order. */
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
        // A result whose call is gone (history removed) is still a step.
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
 * A tool call and its result (matched on `toolCallId`) form one `tool` step. Cursor rules:
 *
 * - The cursor never lies inside a step or before an event of a step the page does not hold. Overlapping
 *   parallel calls form a block that is never split; a block larger than `limit` at the page start is returned
 *   whole (the only way a page exceeds `limit`).
 * - A call without a result is returned as `running` after the closed steps and the cursor stays before it, so
 *   the next request returns it complete (closed steps after it wait too).
 * - `nextCursor` is `null` when nothing is left: the last step is `end`/`error`, or the run is settled. An empty
 *   page keeps `after`, except that a full read of step-less events moves the cursor past them.
 *
 * A settled run has no running step: an open call is returned as `error` (interrupted) and passed, otherwise a
 * reader following `nextCursor` would get the same step forever. With `hasMore`, an open call is not returned,
 * since its result may follow in a later read.
 *
 * Throws when `hasMore` and the read has steps but no valid cursor point (one block fills the whole read).
 */
export function buildAgentRunStepPage(input: {
  events: readonly AgentRunEventRow[];
  hasMore: boolean;
  after: string;
  limit: number;
  runSettled: boolean;
}): AgentRunStepPage {
  const { events, hasMore, after, limit, runSettled } = input;
  const steps = groupSteps(events);
  // The read holds every event after the cursor, so a call still open in it never gets a result.
  const exhausted = runSettled && !hasMore;
  if (exhausted) {
    for (const step of steps) {
      if (step.closed) continue;
      step.step.state = "error";
      step.closed = true;
    }
  }

  // The number of leading steps the cursor passes: the most that fits in `limit`, else the first whole block.
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
    // Moves past step-less events so a long run of them cannot stall the reader.
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

export const AGENT_RUN_STEP_TARGET_NAME_MAX_LENGTH = 200;

export interface AgentRunStepTargets {
  items: ReadonlyMap<string, { databaseId: string; name: string | null }>;
  /** `null` for a database no module owns. */
  databaseModuleIds: ReadonlyMap<string, string | null>;
}

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

/** A failed MCP call on execution is `failed`, not a conflict. */
const APPROVAL_CALL_FAILED_KEY = "approval.outcome.failed";

const APPROVAL_CONFLICT_OTHER_KEY = "approval.conflict.other";

/**
 * The decision comes first (`pending`/`rejected` whatever the execution status); an approved request reads its
 * execution. `null` for an impossible row state. Only the stored result's discriminators are read, never its
 * text.
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
    case "not_approved":
      return null;
  }
}

function stepStateOfApproval(approvalState: AgentRunApprovalState): AgentRunStepState {
  if (approvalState === "pending") return "waitingApproval";
  return approvalState === "failed" || approvalState === "conflict" ? "error" : "ok";
}

/**
 * `counts` is read only when the page holds the `end` step. A step whose request is missing from `approvals`
 * keeps its call's state and has no `approvalState`. An unreadable target keeps the generic noun and has no
 * `targetName`. Only the structured `details` fields of a result are used; no argument, result content, model
 * text or error text reaches the output.
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
