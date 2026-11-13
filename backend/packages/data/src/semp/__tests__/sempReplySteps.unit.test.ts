import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AgentRunEventKind, AgentRunEventRow } from "../../agentRuns/agentRunEventsStore.js";
import { projectSempReplySteps, SEMP_REPLY_OPERATIONS_WITH_SUMMARY, sempTurnDurationMs } from "../sempReplySteps.js";
import type { SempReplyTargets } from "../sempReplyTargets.js";

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const TASKS_DB = "11111111-1111-4111-8111-111111111111";
const HEALTH_DB = "22222222-2222-4222-8222-222222222222";
const TASK_ID = "33333333-3333-4333-8333-333333333333";
const RECORD_ID = "44444444-4444-4444-8444-444444444444";
const FREE_TEXT = "SECRET-FREE-TEXT-FROM-THE-MODEL";

let nextId = 1;
function event(kind: AgentRunEventKind, payload: unknown, atMs: number): AgentRunEventRow {
  return {
    id: String(nextId++),
    agentRunId: "run",
    kind,
    payload,
    at: new Date(T0 + atMs).toISOString(),
  };
}

const turnStart = (atMs: number) => event("turn_start", { kind: "turn_start" }, atMs);
const turnEnd = (atMs: number) => event("turn_end", { kind: "turn_end" }, atMs);

function assistant(text: string, atMs: number, extra: Record<string, unknown> = {}) {
  return event("message", { kind: "message", role: "assistant", text, content: [], ...extra }, atMs);
}

interface CallOptions {
  toolCallId: string;
  name?: string;
  operation?: string;
  mcp?: { toolRegistrationId: string; serverItemId: string; serverName: string; toolName: string };
  args?: unknown;
  targetItemId?: string;
  targetDatabaseId?: string;
}

/** The identity and target fields a stored tool event carries next to its call id and name. */
function metadataOf(options: CallOptions) {
  return {
    ...(options.operation ? { operation: options.operation } : {}),
    ...(options.mcp ? { mcp: options.mcp } : {}),
    ...(options.targetItemId ? { targetItemId: options.targetItemId } : {}),
    ...(options.targetDatabaseId ? { targetDatabaseId: options.targetDatabaseId } : {}),
  };
}

function toolUse(options: CallOptions, atMs: number) {
  return event(
    "tool_use",
    {
      kind: "tool_use",
      toolCallId: options.toolCallId,
      name: options.name ?? "item_patch",
      arguments: options.args ?? {},
      ...metadataOf(options),
    },
    atMs,
  );
}

function toolResult(
  options: CallOptions,
  atMs: number,
  outcome: { isError?: boolean; details?: Record<string, unknown>; text?: string } = {},
) {
  return event(
    "tool_result",
    {
      kind: "tool_result",
      toolCallId: options.toolCallId,
      name: options.name ?? "item_patch",
      result: { content: [{ type: "text", text: outcome.text ?? "{}" }], details: outcome.details ?? { error: false } },
      isError: outcome.isError ?? false,
      ...metadataOf(options),
    },
    atMs,
  );
}

const emptyTargets: SempReplyTargets = { items: new Map(), databases: new Map(), properties: new Map() };
const targets: SempReplyTargets = {
  items: new Map([
    [TASK_ID, { databaseId: TASKS_DB, name: "Write the report" }],
    [RECORD_ID, { databaseId: HEALTH_DB, name: "Blood test" }],
  ]),
  databases: new Map([
    [TASKS_DB, { moduleId: "tasks", sensitive: false }],
    [HEALTH_DB, { moduleId: "healthRecords", sensitive: true }],
  ]),
  properties: new Map(),
};

const patch = (id: string, itemId = TASK_ID, databaseId?: string): CallOptions => ({
  toolCallId: id,
  operation: "item.patch",
  targetItemId: itemId,
  ...(databaseId ? { targetDatabaseId: databaseId } : {}),
  args: { itemId, properties: { dueDate: FREE_TEXT }, ifVersion: "1" },
});

describe("projectSempReplySteps", () => {
  it("returns no step for no event", () => {
    expect(projectSempReplySteps({ events: [], targets: emptyTargets })).toEqual([]);
  });

  it("makes one tool step per call with its duration and status, in the order of the calls", () => {
    const first = patch("call-1");
    const second: CallOptions = { toolCallId: "call-2", operation: "database.list", name: "database_list" };
    const events = [
      turnStart(0),
      toolUse(first, 100),
      toolResult(first, 600, {
        details: { error: false, changes: [{ key: "dueDate", before: "2026-11-02", after: "2026-11-03" }] },
      }),
      toolUse(second, 700),
      toolResult(second, 1000),
      assistant("done", 1200),
      turnEnd(1300),
    ];

    const steps = projectSempReplySteps({ events, targets });

    expect(steps.map((step) => [step.kind, step.toolCallId, step.operation, step.status, step.durationMs])).toEqual([
      ["tool", "call-1", "item.patch", "ok", 500],
      ["tool", "call-2", "database.list", "ok", 300],
    ]);
    expect(steps[0]).toMatchObject({
      toolName: "item_patch",
      startedAt: new Date(T0 + 100).toISOString(),
      label: { key: "agentStep.title.operation.item.patch", params: { targetModuleId: "tasks" } },
      detail: {
        key: "agentStep.summary.changedProperties",
        params: {
          itemName: "Write the report",
          count: 1,
          changedKeys: ["dueDate"],
          changes: [{ key: "dueDate", before: "2026-11-02", after: "2026-11-03" }],
        },
      },
    });
    expect(steps[1]).toMatchObject({
      label: { key: "agentStep.title.operation.database.list", params: {} },
      detail: { key: "agentStep.summary.done", params: {} },
    });
    expect(sempTurnDurationMs(events)).toBe(1300);
  });

  it("orders overlapping parallel calls by their first event", () => {
    const a: CallOptions = { toolCallId: "a", operation: "database.list", name: "database_list" };
    const b: CallOptions = { toolCallId: "b", operation: "view.list", name: "view_list" };
    const steps = projectSempReplySteps({
      events: [turnStart(0), toolUse(a, 10), toolUse(b, 20), toolResult(b, 30), toolResult(a, 90), turnEnd(100)],
      targets: emptyTargets,
    });
    expect(steps.map((step) => [step.toolCallId, step.durationMs])).toEqual([
      ["a", 80],
      ["b", 10],
    ]);
  });

  it("marks a call that created an approval request as waiting, with the request id and no failure", () => {
    const call: CallOptions = {
      toolCallId: "del",
      operation: "item.delete",
      name: "item_delete",
      targetItemId: TASK_ID,
      args: { itemId: TASK_ID },
    };
    const [step] = projectSempReplySteps({
      events: [
        turnStart(0),
        toolUse(call, 10),
        toolResult(call, 40, { details: { error: false, approvalRequestId: "approval-1" } }),
        turnEnd(50),
      ],
      targets,
    });

    expect(step).toMatchObject({
      status: "wait",
      approvalRequestId: "approval-1",
      detail: { key: "agentStep.summary.approvalRequested", params: { itemName: "Write the report" } },
    });
    expect(step?.errorCode).toBeUndefined();
  });

  it("marks a failed generic operation as an error with the choke point code", () => {
    const call = patch("bad");
    const [step] = projectSempReplySteps({
      events: [
        turnStart(0),
        toolUse(call, 10),
        toolResult(call, 20, { isError: false, details: { error: true, errorCode: "version_conflict" } }),
        turnEnd(30),
      ],
      targets,
    });

    expect(step).toMatchObject({
      status: "error",
      errorCode: "version_conflict",
      detail: { key: "agentStep.summary.failed", params: {} },
    });
    expect(step?.approvalRequestId).toBeUndefined();
  });

  it("takes the failure kind of a failed MCP tool call as its code and keeps no error text", () => {
    const call: CallOptions = {
      toolCallId: "mcp-1",
      name: "mcp_search_aaaaaaaa",
      mcp: { toolRegistrationId: "r", serverItemId: "s", serverName: "Server", toolName: "search" },
      args: { databaseId: TASKS_DB, itemId: TASK_ID, query: FREE_TEXT },
    };
    const [step] = projectSempReplySteps({
      events: [
        toolUse(call, 0),
        toolResult(call, 5, { isError: true, text: FREE_TEXT, details: { error: true, failureKind: "timeout" } }),
      ],
      targets,
    });

    expect(step).toMatchObject({
      status: "error",
      errorCode: "timeout",
      label: { key: "agentStep.title.namedTool", params: { toolName: "search" } },
    });
    expect(step?.operation).toBeUndefined();
    expect(JSON.stringify(step)).not.toContain(FREE_TEXT);
  });

  it("stores a failure without a code as an error with no code, and refuses a code that is free text", () => {
    const quiet = patch("quiet");
    const loud = patch("loud");
    const steps = projectSempReplySteps({
      events: [
        toolUse(quiet, 0),
        toolResult(quiet, 1, { isError: true }),
        toolUse(loud, 2),
        toolResult(loud, 3, { isError: true, details: { error: true, errorCode: `bad code: ${FREE_TEXT}` } }),
      ],
      targets,
    });

    expect(steps.map((step) => step.status)).toEqual(["error", "error"]);
    expect(steps.every((step) => step.errorCode === undefined)).toBe(true);
  });

  it("makes a call with no result an error step that lasted until the turn's last event", () => {
    const call = patch("cut");
    const [step] = projectSempReplySteps({ events: [turnStart(0), toolUse(call, 100), assistant("", 400)], targets });

    expect(step).toMatchObject({ status: "error", durationMs: 300, detail: { key: "agentStep.summary.failed" } });
    expect(step?.errorCode).toBeUndefined();
  });

  it("makes a result whose call is not among the events a step", () => {
    const call = patch("orphan");
    const [step] = projectSempReplySteps({ events: [toolResult(call, 50, { details: { error: false } })], targets });

    expect(step).toMatchObject({
      toolCallId: "orphan",
      status: "ok",
      durationMs: 0,
      startedAt: new Date(T0 + 50).toISOString(),
    });
  });

  it("stores neither a name nor a value for a result redacted as sensitive", () => {
    const call = patch("redacted", RECORD_ID);
    const [step] = projectSempReplySteps({
      events: [
        toolUse(call, 0),
        event(
          "tool_result",
          {
            kind: "tool_result",
            toolCallId: "redacted",
            name: "item_patch",
            operation: "item.patch",
            targetItemId: RECORD_ID,
            result: {
              content: [{ type: "text", text: "[redacted: sensitive]" }],
              details: { error: false, changes: [{ key: "result" }] },
            },
            isError: false,
          },
          10,
        ),
      ],
      targets,
    });

    expect(step).toMatchObject({
      status: "ok",
      label: { key: "agentStep.title.operation.item.patch", params: { targetModuleId: "healthRecords" } },
      detail: { key: "agentStep.summary.operation.item.patch", params: {} },
    });
    expect(JSON.stringify(step)).not.toMatch(/Blood test|result/u);
  });

  it("stores no param for an approval waiting on an item of a sensitive database", () => {
    const call: CallOptions = {
      toolCallId: "del-sensitive",
      operation: "item.delete",
      name: "item_delete",
      targetItemId: RECORD_ID,
      args: { itemId: RECORD_ID },
    };
    const [step] = projectSempReplySteps({
      events: [toolUse(call, 0), toolResult(call, 5, { details: { error: false, approvalRequestId: "approval-2" } })],
      targets,
    });

    expect(step).toMatchObject({
      status: "wait",
      approvalRequestId: "approval-2",
      detail: { key: "agentStep.summary.approvalRequested", params: {} },
    });
    expect(JSON.stringify(step)).not.toContain("Blood test");
  });

  it("stores no param for a patch whose result still carries values but whose database is sensitive", () => {
    const call = patch("flagged", RECORD_ID);
    const [step] = projectSempReplySteps({
      events: [
        toolUse(call, 0),
        toolResult(call, 5, { details: { error: false, changes: [{ key: "result", before: "a", after: "b" }] } }),
      ],
      targets,
    });

    expect(step?.detail).toEqual({ key: "agentStep.summary.operation.item.patch", params: {} });
  });

  it("treats a target the lookup cannot place as sensitive", () => {
    const call = patch("unplaced", "55555555-5555-4555-8555-555555555555");
    const [step] = projectSempReplySteps({
      events: [
        toolUse(call, 0),
        toolResult(call, 5, { details: { error: false, changes: [{ key: "dueDate", before: "a", after: "b" }] } }),
      ],
      targets,
    });

    expect(step?.detail.params).toEqual({});
    expect(step?.label.params).toEqual({});
  });

  it("does not trust the ids an MCP tool's arguments carry", () => {
    const call: CallOptions = {
      toolCallId: "mcp-2",
      name: "mcp_read_bbbbbbbb",
      mcp: { toolRegistrationId: "r", serverItemId: "s", serverName: "Server", toolName: "read" },
      targetItemId: TASK_ID,
      targetDatabaseId: TASKS_DB,
      args: { itemId: TASK_ID },
    };
    const [step] = projectSempReplySteps({ events: [toolUse(call, 0), toolResult(call, 4)], targets });

    expect(step?.status).toBe("ok");
    expect(step?.detail).toEqual({ key: "agentStep.summary.done", params: {} });
  });

  it("names a module tool by its model-facing name and gives any other tool the generic title", () => {
    const module: CallOptions = { toolCallId: "m", name: "heartbeat_trigger" };
    const odd: CallOptions = { toolCallId: "o", name: "weird name with spaces" };
    const steps = projectSempReplySteps({
      events: [toolUse(module, 0), toolResult(module, 1), toolUse(odd, 2), toolResult(odd, 3)],
      targets,
    });

    expect(steps[0]?.label).toEqual({ key: "agentStep.title.namedTool", params: { toolName: "heartbeat_trigger" } });
    expect(steps[0]?.toolName).toBe("heartbeat_trigger");
    expect(steps[1]?.label).toEqual({ key: "agentStep.title.tool", params: {} });
    expect(steps[1]?.toolName).toBeUndefined();
  });

  it("keeps no free text of arguments or results in any step", () => {
    const call: CallOptions = {
      toolCallId: "free",
      operation: "item.create",
      name: "item_create",
      targetDatabaseId: TASKS_DB,
      args: { databaseId: TASKS_DB, properties: { title: FREE_TEXT } },
    };
    const steps = projectSempReplySteps({
      events: [toolUse(call, 0), toolResult(call, 9, { text: JSON.stringify({ title: FREE_TEXT }) })],
      targets,
    });

    expect(steps).toHaveLength(1);
    expect(JSON.stringify(steps)).not.toContain(FREE_TEXT);
  });

  describe("model steps", () => {
    const call: CallOptions = { toolCallId: "c", operation: "database.list", name: "database_list" };

    it("records an intermediate generation with text that calls tools, and not the final reply", () => {
      const steps = projectSempReplySteps({
        events: [
          turnStart(0),
          assistant("Let me look.", 200, { content: [{ type: "toolCall", id: "c", name: "database_list" }] }),
          toolUse(call, 210),
          toolResult(call, 260),
          turnEnd(270),
          turnStart(280),
          assistant("Here is the answer.", 900),
          turnEnd(910),
        ],
        targets,
      });

      expect(steps.map((step) => [step.kind, step.status, step.durationMs])).toEqual([
        ["model", "ok", 200],
        ["tool", "ok", 50],
      ]);
      expect(steps[0]).toMatchObject({
        label: { key: "agentStep.title.plan", params: {} },
        detail: { key: "agentStep.summary.done", params: {} },
        startedAt: new Date(T0).toISOString(),
      });
      expect(steps[0]?.toolCallId).toBeUndefined();
      expect(steps[0]?.tokens).toBeUndefined();
    });

    it("records a generation with text that is followed by a later assistant message without a tool call", () => {
      const steps = projectSempReplySteps({
        events: [turnStart(0), assistant("First thought.", 100), assistant("Final.", 300), turnEnd(310)],
        targets,
      });

      expect(steps.map((step) => step.kind)).toEqual(["model"]);
    });

    it("records no step for a message without text, or for a lone reply", () => {
      const steps = projectSempReplySteps({
        events: [
          turnStart(0),
          assistant("   ", 50, { content: [{ type: "toolCall", id: "c", name: "database_list" }] }),
          toolUse(call, 60),
          toolResult(call, 70),
          assistant("Only reply.", 90),
        ],
        targets,
      });

      expect(steps.map((step) => step.kind)).toEqual(["tool"]);
    });

    it("carries the token usage of the message event, and only a well-formed one", () => {
      const withUsage = projectSempReplySteps({
        events: [
          turnStart(0),
          assistant("Thinking.", 10, { usage: { input: 12, output: 34 } }),
          assistant("Final.", 20),
        ],
        targets,
      });
      const malformed = projectSempReplySteps({
        events: [
          turnStart(0),
          assistant("Thinking.", 10, { usage: { input: -1, output: "x" } }),
          assistant("Final.", 20),
        ],
        targets,
      });
      const missingOutput = projectSempReplySteps({
        events: [turnStart(0), assistant("Thinking.", 10, { usage: { input: 5 } }), assistant("Final.", 20)],
        targets,
      });

      expect(withUsage[0]?.tokens).toEqual({ input: 12, output: 34 });
      expect(malformed[0]?.tokens).toBeUndefined();
      expect(missingOutput[0]?.tokens).toBeUndefined();
    });

    it("starts a generation at the event before it when the turn stored no turn_start", () => {
      const steps = projectSempReplySteps({
        events: [toolUse(call, 0), toolResult(call, 40), assistant("More.", 100, { content: [{ type: "toolCall" }] })],
        targets,
      });

      expect(steps.map((step) => [step.kind, step.startedAt, step.durationMs])).toEqual([
        ["tool", new Date(T0).toISOString(), 40],
        ["model", new Date(T0 + 40).toISOString(), 60],
      ]);
    });
  });
});

describe("sempTurnDurationMs", () => {
  it("is the time from the first turn_start to the last turn_end, not the sum of the model turns", () => {
    expect(sempTurnDurationMs([turnStart(0), turnEnd(100), turnStart(150), turnEnd(400)])).toBe(400);
  });

  it("lasts until the last event for a turn that ended without a turn_end", () => {
    expect(sempTurnDurationMs([turnStart(0), assistant("x", 250)])).toBe(250);
  });

  it("lasts until the last event when a later round started and never ended, as in a turn that failed in a later round", () => {
    const call: CallOptions = { toolCallId: "a", operation: "database.list", name: "database_list" };
    const events = [
      turnStart(0),
      toolUse(call, 100),
      toolResult(call, 300),
      turnEnd(500),
      turnStart(600),
      toolUse({ toolCallId: "b", operation: "view.list", name: "view_list" }, 700),
    ];
    expect(sempTurnDurationMs(events)).toBe(700);
    expect(sempTurnDurationMs(events.slice(0, 4))).toBe(500);
  });

  it("is unknown without a turn_start", () => {
    expect(sempTurnDurationMs([assistant("x", 5), turnEnd(9)])).toBeNull();
    expect(sempTurnDurationMs([])).toBeNull();
  });
});

describe("the agent step catalog", () => {
  const catalogDir = join(dirname(fileURLToPath(import.meta.url)), "../../agentRuns/i18n");

  it.each(["en", "cs"])("holds a summary entry for exactly the operations the projection names in %s", (locale) => {
    const catalog: Record<string, string> = JSON.parse(readFileSync(join(catalogDir, `${locale}.json`), "utf8"));
    const prefix = "agentStep.summary.operation.";
    const entries = Object.keys(catalog)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();

    expect(entries).toEqual([...SEMP_REPLY_OPERATIONS_WITH_SUMMARY].sort());
  });

  it.each(["en", "cs"])("holds every other key a stored step names in %s", (locale) => {
    const catalog: Record<string, string> = JSON.parse(readFileSync(join(catalogDir, `${locale}.json`), "utf8"));
    for (const key of [
      "agentStep.title.plan",
      "agentStep.title.tool",
      "agentStep.title.namedTool",
      "agentStep.summary.done",
      "agentStep.summary.failed",
      "agentStep.summary.approvalRequested",
      "agentStep.summary.changedProperties.one",
      "agentStep.summary.changedProperties.other",
    ]) {
      expect(catalog[key], key).toEqual(expect.any(String));
    }
  });
});
