import { describe, expect, it } from "vitest";
import type { AgentRunEventKind, AgentRunEventRow } from "../agentRuns/agentRunEventsStore.js";
import {
  AGENT_RUN_STEP_EVENT_KINDS,
  agentRunStepPageRowLimit,
  AGENT_RUN_STEP_SETTLE_MS,
  buildAgentRunStepPage,
  isAgentRunStepReadSettled,
  type AgentRunStepDraft,
  type AgentRunStepPage,
} from "../agentRuns/agentRunStepPages.js";

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const BASE_MS = Date.parse("2026-11-01T10:00:00.000Z");

/** An event of the run with the given id; its time is the id in seconds after a fixed start. */
function event(id: number, kind: AgentRunEventKind, payload: unknown): AgentRunEventRow {
  return { id: String(id), agentRunId: RUN_ID, kind, payload, at: new Date(BASE_MS + id * 1000).toISOString() };
}

const status = (id: number, value: string) => event(id, "run_status", { kind: "run_status", status: value });

function message(id: number, text: string, content: unknown[] = []): AgentRunEventRow {
  return event(id, "message", { kind: "message", role: "assistant", text, content, stopReason: "stop" });
}

const TOOL_CALL = { type: "toolCall", id: "c", name: "item_get", arguments: {} };

function toolUse(id: number, toolCallId: string, extra: Record<string, unknown> = {}): AgentRunEventRow {
  return event(id, "tool_use", {
    kind: "tool_use",
    toolCallId,
    name: "item_get",
    arguments: { secret: "x" },
    ...extra,
  });
}

function toolResult(id: number, toolCallId: string, extra: Record<string, unknown> = {}): AgentRunEventRow {
  return event(id, "tool_result", {
    kind: "tool_result",
    toolCallId,
    name: "item_get",
    result: { content: [{ type: "text", text: "secret result" }] },
    isError: false,
    ...extra,
  });
}

const OPERATION = { operation: "item.get" };
const MCP = {
  mcp: { toolRegistrationId: "reg-1", serverItemId: "server-1", serverName: "Weather", toolName: "forecast" },
};

function page(
  events: AgentRunEventRow[],
  limit = 100,
  after = "0",
  hasMore = false,
  runSettled = false,
): AgentRunStepPage {
  return buildAgentRunStepPage({ events, hasMore, after, limit, runSettled });
}

/** Reads a page as `listAgentRunEventsForStepPage` does: the step-producing events after the cursor, bounded by the row limit. */
function readPage(all: AgentRunEventRow[], after: string, limit: number, runSettled = false): AgentRunStepPage {
  const rowLimit = agentRunStepPageRowLimit(limit);
  const rows = all
    .filter((e) => BigInt(e.id) > BigInt(after) && AGENT_RUN_STEP_EVENT_KINDS.includes(e.kind))
    .slice(0, rowLimit + 1);
  return buildAgentRunStepPage({
    events: rows.slice(0, rowLimit),
    hasMore: rows.length > rowLimit,
    after,
    limit,
    runSettled,
  });
}

/** Follows `nextCursor` until it is null and returns every page. */
function readAll(all: AgentRunEventRow[], limit: number, runSettled = false): AgentRunStepPage[] {
  const pages: AgentRunStepPage[] = [];
  let after = "0";
  for (let i = 0; i < 100; i++) {
    const next = readPage(all, after, limit, runSettled);
    pages.push(next);
    if (next.nextCursor === null) return pages;
    after = next.nextCursor;
  }
  throw new Error("The cursor did not reach the end of the run");
}

/** A step as the route returns it before the projection adds its text: without the facts the projection reads. */
const withoutFacts = ({ facts: _facts, ...core }: AgentRunStepDraft) => core;

const kinds = (steps: AgentRunStepDraft[]) => steps.map((s) => s.kind);

/** A finished run: start, plan, two sequential tool calls, answer, end. */
function finishedRun(): AgentRunEventRow[] {
  return [
    status(1, "running"),
    event(2, "turn_start", { kind: "turn_start" }),
    message(3, "I will look it up", [{ type: "text", text: "I will look it up" }, TOOL_CALL]),
    toolUse(4, "call-1", OPERATION),
    toolResult(5, "call-1"),
    toolUse(6, "call-2", MCP),
    toolResult(7, "call-2"),
    message(8, "Here is the answer", [{ type: "text", text: "Here is the answer" }]),
    event(9, "turn_end", { kind: "turn_end" }),
    status(10, "done"),
  ];
}

describe("buildAgentRunStepPage grouping (issue #1821)", () => {
  it("groups a finished run into start, plan, tool, tool, answer and end", () => {
    const result = page(finishedRun());

    expect(result.steps.map(withoutFacts)).toEqual([
      {
        stepId: "1",
        kind: "start",
        state: "ok",
        at: "2026-11-01T10:00:01.000Z",
        durationMs: null,
        toolCallId: null,
        operation: null,
        mcp: null,
        approvalRequestId: null,
      },
      {
        stepId: "3",
        kind: "plan",
        state: "ok",
        at: "2026-11-01T10:00:03.000Z",
        durationMs: null,
        toolCallId: null,
        operation: null,
        mcp: null,
        approvalRequestId: null,
      },
      {
        stepId: "4",
        kind: "tool",
        state: "ok",
        at: "2026-11-01T10:00:04.000Z",
        durationMs: 1000,
        toolCallId: "call-1",
        operation: "item.get",
        mcp: null,
        approvalRequestId: null,
      },
      {
        stepId: "6",
        kind: "tool",
        state: "ok",
        at: "2026-11-01T10:00:06.000Z",
        durationMs: 1000,
        toolCallId: "call-2",
        operation: null,
        mcp: MCP.mcp,
        approvalRequestId: null,
      },
      {
        stepId: "8",
        kind: "answer",
        state: "ok",
        at: "2026-11-01T10:00:08.000Z",
        durationMs: null,
        toolCallId: null,
        operation: null,
        mcp: null,
        approvalRequestId: null,
      },
      {
        stepId: "10",
        kind: "end",
        state: "ok",
        at: "2026-11-01T10:00:10.000Z",
        durationMs: null,
        toolCallId: null,
        operation: null,
        mcp: null,
        approvalRequestId: null,
      },
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it("returns neither arguments, results, message text nor thinking content", () => {
    const events = [
      status(1, "running"),
      message(2, "visible only to the model", [{ type: "thinking", thinking: "private reasoning" }, TOOL_CALL]),
      toolUse(3, "call-1", OPERATION),
      toolResult(4, "call-1"),
    ];

    const json = JSON.stringify(page(events));

    for (const hidden of ["private reasoning", "visible only to the model", "secret", "arguments", "result"]) {
      expect(json).not.toContain(hidden);
    }
  });

  it("maps a run that failed to an error step in the error state", () => {
    const result = page([status(1, "running"), status(2, "error")]);

    expect(result.steps.map((s) => [s.kind, s.state])).toEqual([
      ["start", "ok"],
      ["error", "error"],
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it("makes no step of turn markers, a compaction checkpoint or a user message", () => {
    const events = [
      event(1, "turn_start", {}),
      event(2, "compaction", {}),
      event(3, "user_message", { text: "hello" }),
      event(4, "turn_end", {}),
    ];

    expect(page(events)).toEqual({ steps: [], nextCursor: "0" });
  });

  it.each([
    ["an assistant message without text", message(1, "", [TOOL_CALL])],
    ["an assistant message with only whitespace", message(1, "  \n ", [])],
    ["a message of another role", event(1, "message", { role: "user", text: "hello", content: [] })],
    ["a message whose text is not a string", event(1, "message", { role: "assistant", text: 5, content: [] })],
    ["a message whose payload is not an object", event(1, "message", "text")],
    ["a run_status of an unknown status", status(1, "paused")],
    ["a run_status whose payload is not an object", event(1, "run_status", null)],
  ])("makes no step of %s", (_label, ignored) => {
    expect(page([ignored]).steps).toEqual([]);
  });

  it("calls an assistant message with text and no tool call an answer, also when it is not the last event", () => {
    const events = [
      message(1, "first"),
      status(2, "running"),
      message(3, "second", [{ type: "text", text: "second" }]),
    ];

    expect(kinds(page(events).steps)).toEqual(["answer", "start", "answer"]);
  });

  it("calls an assistant message whose content is not a list an answer", () => {
    expect(kinds(page([event(1, "message", { role: "assistant", text: "hi", content: "hi" })]).steps)).toEqual([
      "answer",
    ]);
  });

  it("matches a result to its call on toolCallId and not on position", () => {
    const events = [toolUse(1, "a"), toolUse(2, "b"), toolResult(3, "b", { isError: true }), toolResult(4, "a")];

    const { steps } = page(events);

    expect(steps.map((s) => [s.toolCallId, s.state, s.durationMs])).toEqual([
      ["a", "ok", 3000],
      ["b", "error", 1000],
    ]);
  });

  it.each([
    ["isError is true", { isError: true }],
    ["the result's details say error", { isError: false, result: { content: [], details: { error: true } } }],
    [
      "a row stored before the interrupted-result fix has error at the top level",
      { isError: undefined, error: true, result: "interrupted" },
    ],
  ])("marks a tool step as an error when %s", (_label, extra) => {
    const { steps } = page([toolUse(1, "a"), toolResult(2, "a", extra)]);

    expect(steps[0]).toMatchObject({ kind: "tool", state: "error" });
  });

  it.each([
    ["a result with isError false", {}],
    ["details.error false", { result: { content: [], details: { error: false } } }],
    ["a string result without flags", { isError: undefined, result: "done" }],
    ["error set to something other than true", { isError: undefined, error: "yes", result: "done" }],
  ])("keeps a tool step ok for %s", (_label, extra) => {
    const { steps } = page([toolUse(1, "a"), toolResult(2, "a", extra)]);

    expect(steps[0]).toMatchObject({ kind: "tool", state: "ok" });
  });

  it("reads operation and mcp of a tool step from the call, and leaves both null for a call stored without identity", () => {
    const { steps } = page([
      toolUse(1, "a", OPERATION),
      toolResult(2, "a"),
      toolUse(3, "b", MCP),
      toolResult(4, "b"),
      toolUse(5, "c"),
      toolResult(6, "c"),
    ]);

    expect(steps.map((s) => [s.operation, s.mcp?.toolName ?? null])).toEqual([
      ["item.get", null],
      [null, "forecast"],
      [null, null],
    ]);
  });

  it("makes no step of a call the typed parser rejects, and none of a result without a call id", () => {
    const events = [
      event(1, "tool_use", { kind: "tool_use", toolCallId: "a", name: "item_get" }),
      event(2, "tool_use", {
        kind: "tool_use",
        toolCallId: "b",
        name: "item_get",
        arguments: {},
        operation: "nope.nope",
      }),
      event(3, "tool_result", { kind: "tool_result", name: "item_get", result: {}, isError: false }),
      event(4, "tool_result", "not an object"),
    ];

    expect(page(events)).toEqual({ steps: [], nextCursor: "0" });
  });

  it("shows a result whose call is gone as a tool step of its own, with the identity the result carries", () => {
    const { steps } = page([
      toolResult(5, "gone", OPERATION),
      toolResult(6, "legacy", { isError: undefined, error: true }),
    ]);

    expect(steps.map(withoutFacts)).toEqual([
      {
        stepId: "5",
        kind: "tool",
        state: "ok",
        at: "2026-11-01T10:00:05.000Z",
        durationMs: null,
        toolCallId: "gone",
        operation: "item.get",
        mcp: null,
        approvalRequestId: null,
      },
      {
        stepId: "6",
        kind: "tool",
        state: "error",
        at: "2026-11-01T10:00:06.000Z",
        durationMs: null,
        toolCallId: "legacy",
        operation: null,
        mcp: null,
        approvalRequestId: null,
      },
    ]);
  });

  it("treats a second result for a call that already has one as a step of its own", () => {
    const { steps } = page([toolUse(1, "a"), toolResult(2, "a"), toolResult(3, "a")]);

    expect(steps.map((s) => [s.stepId, s.durationMs])).toEqual([
      ["1", 1000],
      ["3", null],
    ]);
  });
});

describe("buildAgentRunStepPage cursor (issue #1821)", () => {
  it("returns the steps of a run read page by page with limit 2 as the unpaged read, with no page ending inside a call", () => {
    const all = finishedRun();
    const unpaged = readPage(all, "0", 500);

    const pages = readAll(all, 2);

    expect(pages.flatMap((p) => p.steps)).toEqual(unpaged.steps);
    expect(pages.map((p) => p.steps.length)).toEqual([2, 2, 2]);
    // Each cursor is the last event of the last step of its page: the plan (event 3), the second call's
    // result (event 7), and null with the end. Events 4 and 6 are calls whose results follow.
    expect(pages.map((p) => p.nextCursor)).toEqual(["3", "7", null]);
  });

  it("returns every step once at every page size", () => {
    const all = finishedRun();
    const unpaged = readPage(all, "0", 500).steps.map((s) => s.stepId);

    for (let limit = 1; limit <= 7; limit++) {
      const ids = readAll(all, limit).flatMap((p) => p.steps.map((s) => s.stepId));
      expect(ids, `limit ${limit}`).toEqual(unpaged);
    }
  });

  it("returns a call without a result as running, keeps the cursor before it and returns it complete on the next request", () => {
    const events = [status(1, "running"), message(2, "plan", [TOOL_CALL]), toolUse(3, "a", OPERATION)];

    const first = page(events);

    expect(first.steps.map((s) => [s.kind, s.state])).toEqual([
      ["start", "ok"],
      ["plan", "ok"],
      ["tool", "running"],
    ]);
    expect(first.steps[2]?.durationMs).toBeNull();
    expect(first.nextCursor).toBe("2");

    const second = page(
      [...events, toolResult(4, "a")].filter((e) => BigInt(e.id) > 2n),
      100,
      "2",
    );

    expect(second.steps.map((s) => [s.stepId, s.kind, s.state, s.durationMs])).toEqual([["3", "tool", "ok", 1000]]);
    expect(second.nextCursor).toBe("4");
  });

  it("keeps the cursor at the request's own when the first step is still running", () => {
    expect(page([toolUse(7, "a")], 100, "6").nextCursor).toBe("6");
    expect(page([toolUse(7, "a")]).nextCursor).toBe("0");
  });

  it("holds back the closed steps that come after a call still running", () => {
    const events = [status(1, "running"), toolUse(2, "a"), toolUse(3, "b"), toolResult(4, "b"), message(5, "done")];

    const result = page(events);

    expect(result.steps.map((s) => [s.stepId, s.state])).toEqual([
      ["1", "ok"],
      ["2", "running"],
    ]);
    expect(result.nextCursor).toBe("1");
  });

  it("counts a running step against the limit", () => {
    const events = [status(1, "running"), toolUse(2, "a")];

    expect(page(events, 1).steps.map((s) => s.stepId)).toEqual(["1"]);
    expect(page(events, 1).nextCursor).toBe("1");
    expect(page(events, 2).steps.map((s) => s.stepId)).toEqual(["1", "2"]);
  });

  it("keeps the cursor non-null for a live run whose read ended with a closed step", () => {
    const result = page([status(1, "running"), message(2, "thinking aloud", [])]);

    expect(result.nextCursor).toBe("2");
  });

  it("keeps the cursor non-null when the page holds the end but more steps were asked for than it holds", () => {
    const events = [status(1, "running"), status(2, "done")];

    expect(page(events, 1).nextCursor).toBe("1");
    expect(page(events, 2).nextCursor).toBeNull();
  });

  it("returns the steps of a block of parallel calls whole when the block is larger than the limit", () => {
    const events = [
      status(1, "running"),
      toolUse(2, "a"),
      toolUse(3, "b"),
      toolUse(4, "c"),
      toolResult(5, "b"),
      toolResult(6, "a"),
      toolResult(7, "c"),
      message(8, "answer"),
      status(9, "done"),
    ];

    const pages = readAll(events, 1);

    expect(pages.map((p) => p.steps.map((s) => s.stepId))).toEqual([["1"], ["2", "3", "4"], ["8"], ["9"]]);
    expect(pages.map((p) => p.nextCursor)).toEqual(["1", "7", "8", null]);
  });

  it("passes a block of parallel calls inside the limit together with the steps around it", () => {
    const events = [
      status(1, "running"),
      toolUse(2, "a"),
      toolUse(3, "b"),
      toolResult(4, "a"),
      toolResult(5, "b"),
      message(6, "x"),
    ];

    const result = page(events, 3);

    expect(result.steps.map((s) => s.stepId)).toEqual(["1", "2", "3"]);
    expect(result.nextCursor).toBe("5");
  });

  it("does not split a block when the limit would end the page inside it", () => {
    const events = [status(1, "running"), toolUse(2, "a"), toolUse(3, "b"), toolResult(4, "a"), toolResult(5, "b")];

    const result = page(events, 2);

    expect(result.steps.map((s) => s.stepId)).toEqual(["1"]);
    expect(result.nextCursor).toBe("1");
  });

  it("returns no step and the request's cursor for a read without events", () => {
    expect(page([], 100, "41")).toEqual({ steps: [], nextCursor: "41" });
  });

  it("moves the cursor past a read that was full of events that make no step", () => {
    const events = [message(1, ""), message(2, ""), message(3, "")];

    expect(page(events, 100, "0", true)).toEqual({ steps: [], nextCursor: "3" });
  });

  it("does not return a call as running when more events follow the read, and ends the page at the last closed step", () => {
    const events = [status(1, "running"), toolUse(2, "a")];

    const result = page(events, 100, "0", true);

    expect(result.steps.map((s) => s.stepId)).toEqual(["1"]);
    expect(result.nextCursor).toBe("1");
  });

  it("does not report the end of the run while more events follow the read", () => {
    const result = page([status(1, "running"), status(2, "done")], 100, "0", true);

    expect(result.nextCursor).toBe("2");
  });

  it("throws when a block of overlapping calls, or a single call whose result lies beyond it, fills a read that more events follow", () => {
    expect(() => page([toolUse(1, "a"), toolUse(2, "b")], 100, "0", true)).toThrow(/holds no point for a cursor/);
    expect(() => page([toolUse(1, "a")], 100, "0", true)).toThrow(/holds no point for a cursor/);
  });

  it("pages a run whose events interleave more than a page's worth of parallel calls", () => {
    const events: AgentRunEventRow[] = [status(1, "running")];
    let id = 2;
    for (let i = 0; i < 30; i++) events.push(toolUse(id++, `call-${i}`));
    for (let i = 29; i >= 0; i--) events.push(toolResult(id++, `call-${i}`));
    events.push(status(id, "done"));

    const pages = readAll(events, 1);

    expect(pages.flatMap((p) => p.steps).map((s) => s.kind)).toEqual([
      "start",
      ...Array<string>(30).fill("tool"),
      "end",
    ]);
    expect(pages.map((p) => p.steps.length)).toEqual([1, 30, 1]);
  });
});

describe("buildAgentRunStepPage cursor of a settled run (issue #1821)", () => {
  it("ends a finished run whose terminal step is absent: no event at all, and a last step that is not end or error", () => {
    expect(page([], 100, "0", false, true)).toEqual({ steps: [], nextCursor: null });
    expect(page([message(5, "")], 100, "4", false, true)).toEqual({ steps: [], nextCursor: null });

    const withoutEnd = [status(1, "running"), message(2, "plan", [TOOL_CALL]), toolUse(3, "a"), toolResult(4, "a")];

    expect(page(withoutEnd, 100, "0", false, true).nextCursor).toBeNull();
    expect(page(withoutEnd, 100, "0", false, false).nextCursor).toBe("4");
  });

  it("follows nextCursor to null for a settled run without a terminal step, at every page size", () => {
    const events = [status(1, "running"), message(2, "plan", [TOOL_CALL]), toolUse(3, "a"), toolResult(4, "a")];
    const unpaged = readPage(events, "0", 500, true).steps.map((s) => s.stepId);

    for (let limit = 1; limit <= 4; limit++) {
      const ids = readAll(events, limit, true).flatMap((p) => p.steps.map((s) => s.stepId));
      expect(ids, `limit ${limit}`).toEqual(unpaged);
    }
    expect(readAll(events, 1, true).map((p) => p.nextCursor)).toEqual(["1", "2", null]);
  });

  it("keeps the cursor of a page that does not hold every step of a settled run", () => {
    const events = [status(1, "running"), message(2, "an answer"), message(3, "another answer")];

    expect(page(events, 2, "0", false, true).nextCursor).toBe("2");
    expect(page(events, 3, "0", false, true).nextCursor).toBeNull();
  });

  it("does not end the cursor while more events follow the read, even for a settled run", () => {
    expect(page([status(1, "running"), message(2, "an answer")], 100, "0", true, true).nextCursor).toBe("2");
    expect(page([message(1, ""), message(2, "")], 100, "0", true, true)).toEqual({ steps: [], nextCursor: "2" });
  });

  it("closes a call that never got a result as an error step instead of returning it as running for ever", () => {
    const events = [status(1, "running"), toolUse(2, "a", OPERATION), message(3, "an answer"), status(4, "error")];

    const result = page(events, 100, "0", false, true);

    expect(result.steps.map((s) => [s.stepId, s.kind, s.state, s.durationMs])).toEqual([
      ["1", "start", "ok", null],
      ["2", "tool", "error", null],
      ["3", "answer", "ok", null],
      ["4", "error", "error", null],
    ]);
    expect(result.nextCursor).toBeNull();
  });

  it("ends a settled run whose last event is a call without a result", () => {
    const events = [status(1, "running"), toolUse(2, "a")];

    const pages = readAll(events, 1, true);

    expect(pages.flatMap((p) => p.steps.map((s) => [s.stepId, s.state]))).toEqual([
      ["1", "ok"],
      ["2", "error"],
    ]);
    expect(pages.at(-1)?.nextCursor).toBeNull();
  });

  it("still returns a call without a result as running while the run is not settled", () => {
    const result = page([status(1, "running"), toolUse(2, "a")], 100, "0", false, false);

    expect(result.steps.map((s) => s.state)).toEqual(["ok", "running"]);
    expect(result.nextCursor).toBe("1");
  });
});

describe("isAgentRunStepReadSettled (issue #1821)", () => {
  const finishedAt = "2026-11-01T10:00:00.000Z";
  const at = (ms: number) => new Date(Date.parse(finishedAt) + ms);

  it("is false for a running run, for a run without finished_at and for a run that finished moments ago", () => {
    expect(isAgentRunStepReadSettled({ status: "running", finishedAt: null }, at(1e9))).toBe(false);
    expect(isAgentRunStepReadSettled({ status: "done", finishedAt: null }, at(1e9))).toBe(false);
    expect(isAgentRunStepReadSettled({ status: "done", finishedAt }, at(AGENT_RUN_STEP_SETTLE_MS - 1))).toBe(false);
  });

  it("is true once the settle time has passed for a done and for an error run", () => {
    expect(isAgentRunStepReadSettled({ status: "done", finishedAt }, at(AGENT_RUN_STEP_SETTLE_MS))).toBe(true);
    expect(isAgentRunStepReadSettled({ status: "error", finishedAt }, at(AGENT_RUN_STEP_SETTLE_MS))).toBe(true);
  });
});
