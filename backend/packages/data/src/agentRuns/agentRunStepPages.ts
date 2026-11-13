import { parseToolEventPayload, type McpToolEventIdentity, type ToolUseEventPayload } from "@semprec/shared";
import type { AgentRunEventKind, AgentRunEventRow } from "./agentRunEventsStore.js";

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

export type AgentRunStepKind = "start" | "plan" | "tool" | "answer" | "end" | "error";
export type AgentRunStepState = "running" | "ok" | "error";

/** One step of a run as `GET /api/agent-runs/:id/steps` returns it (issue #1821); arguments, results and thinking are never part of it. */
export interface AgentRunStep {
  /** The id of the step's first event. */
  stepId: string;
  kind: AgentRunStepKind;
  state: AgentRunStepState;
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
}

export interface AgentRunStepPage {
  steps: AgentRunStep[];
  nextCursor: string | null;
}

/** A step with the bookkeeping the page selection needs and the response does not carry. */
interface PendingStep {
  step: AgentRunStep;
  /** The id of the step's last event; equal to `step.stepId` for a step of one event. */
  lastEventId: string;
  /** False for a tool call whose result has not been seen. */
  closed: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closedStep(event: AgentRunEventRow, kind: AgentRunStepKind, state: AgentRunStepState): PendingStep {
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
