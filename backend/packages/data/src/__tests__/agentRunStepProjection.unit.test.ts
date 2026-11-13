import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { GENERIC_OPERATION_NAMES, type GenericOperationName } from "@semprec/shared";
import type { AgentRunEventKind, AgentRunEventRow } from "../agentRuns/agentRunEventsStore.js";
import type { ApprovalRequestStateView } from "../mcp/approvalRequestsStore.js";
import {
  AGENT_RUN_STEP_TARGET_NAME_MAX_LENGTH,
  AGENT_RUN_STEP_VALUE_MAX_LENGTH,
  approvalStepState,
  buildAgentRunStepPage,
  projectAgentRunSteps,
  type AgentRunApprovalState,
  type AgentRunStep,
  type AgentRunStepTargets,
  type AgentRunToolStepCounts,
} from "../agentRuns/agentRunStepPages.js";
import { stepSummary, stepTitle } from "../agentRuns/agentStepCatalog.js";

const RUN_ID = "00000000-0000-4000-8000-000000000001";
const BASE_MS = Date.parse("2026-11-01T10:00:00.000Z");
const TASK_DB = "00000000-0000-4000-8000-0000000000d1";
const TASK_ITEM = "00000000-0000-4000-8000-0000000000a1";
const APPROVAL_ID = "00000000-0000-4000-8000-0000000000b1";
const SECRET = "tok-9f3a-never-returned";

function event(id: number, kind: AgentRunEventKind, payload: unknown): AgentRunEventRow {
  return { id: String(id), agentRunId: RUN_ID, kind, payload, at: new Date(BASE_MS + id * 1000).toISOString() };
}

const status = (id: number, value: string) => event(id, "run_status", { kind: "run_status", status: value });

function toolUse(id: number, toolCallId: string, extra: Record<string, unknown> = {}): AgentRunEventRow {
  return event(id, "tool_use", {
    kind: "tool_use",
    toolCallId,
    name: "item_patch",
    arguments: { secretArgument: SECRET },
    ...extra,
  });
}

function toolResult(
  id: number,
  toolCallId: string,
  extra: Record<string, unknown> = {},
  details: Record<string, unknown> = { error: false },
): AgentRunEventRow {
  return event(id, "tool_result", {
    kind: "tool_result",
    toolCallId,
    name: "item_patch",
    result: { content: [{ type: "text", text: `result ${SECRET}` }], details },
    isError: false,
    ...extra,
  });
}

const PATCH = { operation: "item.patch", targetDatabaseId: TASK_DB, targetItemId: TASK_ITEM };
const MCP = {
  mcp: { toolRegistrationId: "reg-1", serverItemId: "server-1", serverName: "Weather", toolName: "forecast" },
};

const TARGETS: AgentRunStepTargets = {
  items: new Map([[TASK_ITEM, { databaseId: TASK_DB, name: "Buy milk" }]]),
  databaseModuleIds: new Map([[TASK_DB, "tasks"]]),
};
const NO_TARGETS: AgentRunStepTargets = { items: new Map(), databaseModuleIds: new Map() };

async function project(
  events: AgentRunEventRow[],
  options: {
    locale?: string;
    targets?: AgentRunStepTargets;
    counts?: AgentRunToolStepCounts | null;
    approvals?: ReadonlyMap<string, ApprovalRequestStateView>;
    settled?: boolean;
  } = {},
): Promise<AgentRunStep[]> {
  const page = buildAgentRunStepPage({
    events,
    hasMore: false,
    after: "0",
    limit: 100,
    runSettled: options.settled ?? false,
  });
  return projectAgentRunSteps({
    steps: page.steps,
    locale: options.locale ?? "en",
    targets: options.targets ?? TARGETS,
    counts: options.counts ?? null,
    approvals: options.approvals ?? new Map(),
  });
}

async function projectOne(
  events: AgentRunEventRow[],
  options: Parameters<typeof project>[1] = {},
): Promise<AgentRunStep> {
  const [step] = await project(events, options);
  if (!step) throw new Error("The events produced no step");
  return step;
}

describe("step titles (issue #1847)", () => {
  it.each([
    ["database.query", "en", "Searching tasks"],
    ["database.query", "cs", "Vyhledávání úkolů"],
    ["item.patch", "en", "Changing a task"],
    ["item.patch", "cs", "Změna úkolu"],
    ["item.create", "en", "Creating a task"],
    ["item.create", "cs", "Vytvoření úkolu"],
  ] as const)("titles %s over the task database in %s as %s", async (operation, locale, title) => {
    expect(await stepTitle(locale, { kind: "operation", operation }, "tasks")).toBe(title);
  });

  it("reads the English title for a locale other than cs", async () => {
    expect(await stepTitle("de", { kind: "operation", operation: "item.patch" }, "tasks")).toBe("Changing a task");
  });

  it("uses the generic noun for a database without a known module id and for no module id at all", async () => {
    expect(await stepTitle("en", { kind: "operation", operation: "item.create" }, "customThings")).toBe(
      "Creating an item",
    );
    expect(await stepTitle("cs", { kind: "operation", operation: "database.query" }, null)).toBe("Vyhledávání položek");
  });

  it("names an MCP tool and a tool stored without identity", async () => {
    expect(await stepTitle("en", { kind: "mcp", toolName: "forecast" }, null)).toBe("Using forecast");
    expect(await stepTitle("cs", { kind: "named", toolName: "item_get" }, null)).toBe("Použití nástroje item_get");
  });

  it("falls back to the generic title for a tool with no identity and for an operation without an entry", async () => {
    expect(await stepTitle("en", { kind: "unknown" }, null)).toBe("Using a tool");
    expect(await stepTitle("cs", { kind: "unknown" }, null)).toBe("Použití nástroje");
    // `page.nothing` is not an operation; a catalog that lacks an entry for a new operation must still title it.
    const unlisted = { kind: "operation", operation: "page.nothing" as GenericOperationName } as const;
    expect(await stepTitle("en", unlisted, null)).toBe("Using a tool");
  });

  it("does not expand braces inside a tool name", async () => {
    expect(await stepTitle("en", { kind: "mcp", toolName: "{targetOne}" }, "tasks")).toBe("Using {targetOne}");
  });

  it("has a title for every generic operation in both locales", async () => {
    for (const operation of GENERIC_OPERATION_NAMES) {
      for (const locale of ["cs", "en"]) {
        const title = await stepTitle(locale, { kind: "operation", operation }, "tasks");
        expect(title, `${operation} in ${locale}`).not.toBe(await stepTitle(locale, { kind: "unknown" }, null));
        expect(title, `${operation} in ${locale}`).not.toMatch(/[{}]/);
        expect(title).not.toContain("agentStep.");
      }
    }
  });
});

describe("step summaries (issue #1847)", () => {
  const tool = (extra: Partial<Extract<Parameters<typeof stepSummary>[1], { kind: "tool" }>>) =>
    ({ kind: "tool", state: "ok", operation: null, approval: false, changeCount: 0, ...extra }) as const;

  it("has no summary for a call that has not returned", async () => {
    expect(await stepSummary("en", tool({ state: "running", operation: "item.get" }))).toBeNull();
  });

  it("says a failed call failed, whatever the operation, in both locales", async () => {
    expect(await stepSummary("en", tool({ state: "error", operation: "item.patch", changeCount: 2 }))).toBe("Failed");
    expect(await stepSummary("cs", tool({ state: "error" }))).toBe("Selhalo");
  });

  it("says an approval step requested approval", async () => {
    expect(await stepSummary("en", tool({ approval: true, operation: "item.delete" }))).toBe("Approval requested");
    expect(await stepSummary("cs", tool({ approval: true }))).toBe("Požádáno o schválení");
  });

  it("counts the changed properties of an item.patch with the plural of the locale", async () => {
    const patch = (changeCount: number) => tool({ operation: "item.patch", changeCount });
    expect(await stepSummary("en", patch(1))).toBe("1 property changed");
    expect(await stepSummary("en", patch(3))).toBe("3 properties changed");
    expect(await stepSummary("cs", patch(1))).toBe("Změněna 1 vlastnost");
    expect(await stepSummary("cs", patch(3))).toBe("Změněny 3 vlastnosti");
    expect(await stepSummary("cs", patch(5))).toBe("Změněno 5 vlastností");
  });

  it("reads the entry of the operation, and the generic one for an operation without it", async () => {
    expect(await stepSummary("en", tool({ operation: "item.patch", changeCount: 0 }))).toBe("Changed");
    expect(await stepSummary("cs", tool({ operation: "item.create" }))).toBe("Vytvořeno");
    expect(await stepSummary("en", tool({ operation: "database.query" }))).toBe("Search finished");
    expect(await stepSummary("en", tool({ operation: "property.list" }))).toBe("Done");
    expect(await stepSummary("cs", tool({ operation: null }))).toBe("Hotovo");
  });

  it("summarises the end of a run as its tool and approval counts", async () => {
    const end = (toolCount: number, approvalCount: number) => ({ kind: "end", toolCount, approvalCount }) as const;
    expect(await stepSummary("en", end(3, 0))).toBe("3 tools, no approvals");
    expect(await stepSummary("en", end(1, 1))).toBe("1 tool, 1 approval");
    expect(await stepSummary("en", end(0, 0))).toBe("no tools, no approvals");
    expect(await stepSummary("cs", end(3, 0))).toBe("3 nástroje, bez schválení");
    expect(await stepSummary("cs", end(5, 2))).toBe("5 nástrojů, 2 schválení");
    expect(await stepSummary("cs", end(1, 1))).toBe("1 nástroj, 1 schválení");
  });
});

describe("the agentStep catalog entries (issue #1847)", () => {
  function catalog(locale: string): Record<string, string> {
    const url = new URL(`../agentRuns/i18n/${locale}.json`, import.meta.url);
    const parsed: unknown = JSON.parse(readFileSync(url, "utf8"));
    if (typeof parsed !== "object" || parsed === null) throw new Error("catalog is not an object");
    return Object.fromEntries(
      Object.entries(parsed).filter(([key]) => key.startsWith("agentStep.")) as [string, string][],
    );
  }

  it("holds the same keys in cs and en, each with a text", () => {
    const en = catalog("en");
    const cs = catalog("cs");
    const stripPlural = (keys: string[]) => keys.filter((key) => !/\.(zero|one|few|many)$/.test(key));
    expect(stripPlural(Object.keys(cs)).sort()).toEqual(stripPlural(Object.keys(en)).sort());
    for (const text of [...Object.values(en), ...Object.values(cs)]) expect(text.trim()).not.toBe("");
  });
});

describe("projectAgentRunSteps tool steps (issue #1847)", () => {
  it("projects an item.patch on a task with its title, target name and change in English", async () => {
    const step = await projectOne([
      toolUse(1, "c1", PATCH),
      toolResult(2, "c1", PATCH, {
        error: false,
        changes: [
          { key: "status", before: "todo", after: "done" },
          { key: "note", before: "a", after: "b" },
        ],
      }),
    ]);

    expect(step).toEqual({
      stepId: "1",
      kind: "tool",
      state: "ok",
      at: "2026-11-01T10:00:01.000Z",
      durationMs: 1000,
      toolCallId: "c1",
      operation: "item.patch",
      mcp: null,
      approvalRequestId: null,
      title: "Changing a task",
      targetName: "Buy milk",
      change: { property: "status", from: "todo", to: "done" },
      summary: "2 properties changed",
    });
  });

  it("projects the same step in Czech", async () => {
    const step = await projectOne(
      [
        toolUse(1, "c1", PATCH),
        toolResult(2, "c1", PATCH, { error: false, changes: [{ key: "status", after: "done" }] }),
      ],
      { locale: "cs" },
    );

    expect(step.title).toBe("Změna úkolu");
    expect(step.summary).toBe("Změněna 1 vlastnost");
    // A value the call did not report is null, not absent.
    expect(step.change).toEqual({ property: "status", from: null, to: "done" });
  });

  it("titles database.query and item.create over the task database and shows no target name for them", async () => {
    const steps = await project([
      toolUse(1, "q", { operation: "database.query", targetDatabaseId: TASK_DB }),
      toolResult(2, "q", { operation: "database.query", targetDatabaseId: TASK_DB }),
      toolUse(3, "n", { operation: "item.create", targetDatabaseId: TASK_DB }),
      toolResult(4, "n", { operation: "item.create", targetDatabaseId: TASK_DB }),
    ]);

    expect(steps.map((s) => [s.title, s.targetName, s.change, s.summary])).toEqual([
      ["Searching tasks", null, null, "Search finished"],
      ["Creating a task", null, null, "Created"],
    ]);
  });

  it("takes the database of an item-only call from the item", async () => {
    const step = await projectOne([
      toolUse(1, "c1", { operation: "item.get", targetItemId: TASK_ITEM }),
      toolResult(2, "c1", { operation: "item.get" }),
    ]);

    expect(step.title).toBe("Reading a task");
    expect(step.targetName).toBe("Buy milk");
  });

  it("falls back to the generic noun and no target name when the target cannot be read", async () => {
    const step = await projectOne([toolUse(1, "c1", PATCH), toolResult(2, "c1", PATCH)], { targets: NO_TARGETS });

    expect(step.title).toBe("Changing an item");
    expect(step.targetName).toBeNull();
  });

  it("shows no target name for an item whose name is not text", async () => {
    const targets: AgentRunStepTargets = {
      items: new Map([[TASK_ITEM, { databaseId: TASK_DB, name: null }]]),
      databaseModuleIds: new Map([[TASK_DB, "tasks"]]),
    };
    const step = await projectOne([toolUse(1, "c1", PATCH), toolResult(2, "c1", PATCH)], { targets });

    expect(step.targetName).toBeNull();
    expect(step.title).toBe("Changing a task");
  });

  it("cuts a target name longer than the cap", async () => {
    const name = "n".repeat(AGENT_RUN_STEP_TARGET_NAME_MAX_LENGTH + 50);
    const targets: AgentRunStepTargets = {
      items: new Map([[TASK_ITEM, { databaseId: TASK_DB, name }]]),
      databaseModuleIds: new Map(),
    };
    const step = await projectOne([toolUse(1, "c1", PATCH), toolResult(2, "c1", PATCH)], { targets });

    expect(step.targetName).toBe(`${"n".repeat(AGENT_RUN_STEP_TARGET_NAME_MAX_LENGTH)}…`);
  });

  it("titles an MCP tool by its tool name, with the server name on the step and no target", async () => {
    const step = await projectOne([
      toolUse(1, "m1", { ...MCP, name: "weather_forecast", targetItemId: TASK_ITEM, targetDatabaseId: TASK_DB }),
      toolResult(2, "m1", { ...MCP, name: "weather_forecast", targetItemId: TASK_ITEM }),
    ]);

    expect(step.mcp?.serverName).toBe("Weather");
    expect(step.title).toBe("Using forecast");
    expect(step.operation).toBeNull();
    // The ids an MCP tool's arguments carry are the tool's own, not this platform's items.
    expect(step.targetName).toBeNull();
    expect(step.summary).toBe("Done");
  });

  it("titles a call stored without identity by the model-facing name, and a result without a call generically", async () => {
    const steps = await project([
      toolUse(1, "old", { name: "item_get" }),
      toolResult(2, "old", { name: "item_get" }),
      event(3, "tool_result", { toolCallId: "gone", result: "legacy", error: true }),
    ]);

    expect(steps.map((s) => [s.title, s.targetName, s.state])).toEqual([
      ["Using item_get", null, "ok"],
      ["Using a tool", null, "error"],
    ]);
  });

  it("projects a call without a result as running with no summary", async () => {
    const step = await projectOne([toolUse(1, "c1", PATCH)]);

    expect(step.state).toBe("running");
    expect(step.summary).toBeNull();
    expect(step.title).toBe("Changing a task");
  });
});

describe("projectAgentRunSteps change (issue #1847)", () => {
  const changeOf = async (details: Record<string, unknown>) =>
    (await projectOne([toolUse(1, "c1", PATCH), toolResult(2, "c1", PATCH, details)])).change;

  it("composes the change from the first details.changes entry", async () => {
    expect(
      await changeOf({
        error: false,
        changes: [
          { key: "date", before: "2026-01-01", after: "2026-02-02" },
          { key: "status", before: "a", after: "b" },
        ],
      }),
    ).toEqual({ property: "date", from: "2026-01-01", to: "2026-02-02" });
  });

  it("keeps a reported null value and a false value as they are", async () => {
    expect(await changeOf({ error: false, changes: [{ key: "done", before: false, after: null }] })).toEqual({
      property: "done",
      from: false,
      to: null,
    });
  });

  it("shortens a long string value and a long object value", async () => {
    const long = "x".repeat(AGENT_RUN_STEP_VALUE_MAX_LENGTH + 20);
    const change = await changeOf({
      error: false,
      changes: [{ key: "note", before: long, after: { list: ["y".repeat(AGENT_RUN_STEP_VALUE_MAX_LENGTH)] } }],
    });

    expect(change?.from).toBe(`${"x".repeat(AGENT_RUN_STEP_VALUE_MAX_LENGTH)}…`);
    expect(typeof change?.to).toBe("string");
    expect(String(change?.to)).toHaveLength(AGENT_RUN_STEP_VALUE_MAX_LENGTH + 1);
  });

  it("keeps a short object value whole", async () => {
    const change = await changeOf({ error: false, changes: [{ key: "tags", after: { a: 1 } }] });

    expect(change?.to).toEqual({ a: 1 });
  });

  it("has a change with no values for a property the runtime reported only by key", async () => {
    expect(await changeOf({ error: false, changes: [{ key: "body" }] })).toEqual({
      property: "body",
      from: null,
      to: null,
    });
  });

  it("has no change when details hold none, an empty list, or a failed call", async () => {
    expect(await changeOf({ error: false })).toBeNull();
    expect(await changeOf({ error: false, changes: [] })).toBeNull();
    const failed = await projectOne([
      toolUse(1, "c1", PATCH),
      toolResult(2, "c1", { ...PATCH, isError: true }, { error: true }),
    ]);
    expect(failed.change).toBeNull();
    expect(failed.state).toBe("error");
  });

  const CHANGES = [{ key: "k", after: "v" }];
  it.each([
    ["a text", "[redacted: sensitive]"],
    ["the content of the result", { content: "[redacted: sensitive]", details: { error: false, changes: CHANGES } }],
    [
      "a text block of the content",
      { content: [{ type: "text", text: "[redacted: sensitive]" }], details: { error: false, changes: CHANGES } },
    ],
  ])("has no change for a result redacted as sensitive (%s)", async (_label, result) => {
    const step = await projectOne([toolUse(1, "c1", PATCH), toolResult(2, "c1", { ...PATCH, result })]);

    expect(step.change).toBeNull();
    expect(JSON.stringify(step)).not.toContain('"v"');
  });

  it("has a change for a result that only mentions the marker in another text", async () => {
    const result = {
      content: [{ type: "text", text: "was [redacted: sensitive] before" }],
      details: { error: false, changes: CHANGES },
    };
    const step = await projectOne([toolUse(1, "c1", PATCH), toolResult(2, "c1", { ...PATCH, result })]);

    expect(step.change).toEqual({ property: "k", from: null, to: "v" });
  });
});

describe("projectAgentRunSteps approval steps (issue #1847)", () => {
  const approvalEvents = (): AgentRunEventRow[] => [
    toolUse(1, "a1", { operation: "item.delete", targetDatabaseId: TASK_DB, targetItemId: TASK_ITEM }),
    toolResult(
      2,
      "a1",
      { operation: "item.delete", targetDatabaseId: TASK_DB, targetItemId: TASK_ITEM },
      { error: false, approvalRequestId: APPROVAL_ID },
    ),
  ];

  it("marks a call that created an approval request as an approval step with its request id", async () => {
    const step = await projectOne(approvalEvents());

    expect(step.kind).toBe("approval");
    expect(step.approvalRequestId).toBe(APPROVAL_ID);
    expect(step.state).toBe("ok");
    expect(step.title).toBe("Deleting a task");
    expect(step.summary).toBe("Approval requested");
  });

  it("returns no argument key or value of the call", async () => {
    const steps = await project(approvalEvents());
    const json = JSON.stringify(steps);

    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("secretArgument");
    expect(json).not.toContain("result tok-");
  });

  it("marks the result of a call whose use is gone as an approval step too", async () => {
    const step = await projectOne([approvalEvents()[1]!]);

    expect(step.kind).toBe("approval");
    expect(step.approvalRequestId).toBe(APPROVAL_ID);
  });

  it("does not mark a call whose result has no request id, nor a non-string request id", async () => {
    const plain = await projectOne([toolUse(1, "c1", PATCH), toolResult(2, "c1", PATCH)]);
    const malformed = await projectOne([
      toolUse(1, "c2", PATCH),
      toolResult(2, "c2", PATCH, { error: false, approvalRequestId: 42 }),
    ]);

    expect([plain.kind, plain.approvalRequestId]).toEqual(["tool", null]);
    expect([malformed.kind, malformed.approvalRequestId]).toEqual(["tool", null]);
  });
});

describe("projectAgentRunSteps exposes no content (issue #1847)", () => {
  it("returns neither the arguments nor the output of an MCP call", async () => {
    const steps = await project([
      toolUse(1, "m1", { ...MCP, arguments: { query: SECRET } }),
      toolResult(2, "m1", {
        ...MCP,
        result: { content: [{ type: "text", text: `out ${SECRET}` }], details: { error: false } },
      }),
    ]);
    const json = JSON.stringify(steps);

    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("query");
    expect(json).not.toContain("out ");
  });

  it("returns no raw error text of a failed call", async () => {
    const steps = await project([
      toolUse(1, "c1", PATCH),
      toolResult(2, "c1", {
        ...PATCH,
        isError: true,
        result: { content: [{ type: "text", text: `validation_failed: ${SECRET}` }], details: { error: true } },
      }),
    ]);

    expect(steps[0]?.state).toBe("error");
    expect(steps[0]?.summary).toBe("Failed");
    expect(JSON.stringify(steps)).not.toContain(SECRET);
    expect(JSON.stringify(steps)).not.toContain("validation_failed");
  });

  it("returns no model text for a plan step and no thinking for any step", async () => {
    const steps = await project([
      status(1, "running"),
      event(2, "message", {
        kind: "message",
        role: "assistant",
        text: `I will ${SECRET}`,
        content: [
          { type: "thinking", thinking: `private ${SECRET}` },
          { type: "text", text: `I will ${SECRET}` },
          { type: "toolCall", id: "c", name: "item_get", arguments: {} },
        ],
      }),
      event(3, "message", { kind: "message", role: "assistant", text: `answer ${SECRET}`, content: [] }),
    ]);

    expect(steps.map((s) => [s.kind, s.title])).toEqual([
      ["start", "Run started"],
      ["plan", "Planning"],
      ["answer", "Answering"],
    ]);
    expect(JSON.stringify(steps)).not.toContain(SECRET);
    expect(JSON.stringify(steps)).not.toContain("thinking");
    expect(steps.every((s) => s.targetName === null && s.change === null && s.summary === null)).toBe(true);
  });

  it("projects a call interrupted by a restart, closed with an ordinary error result, as an error step", async () => {
    const interrupted = event(2, "tool_result", {
      kind: "tool_result",
      toolCallId: "c1",
      name: "item_patch",
      operation: "item.patch",
      result: { content: [{ type: "text", text: "The run was interrupted_by_restart" }], details: { error: true } },
      isError: true,
    });
    const steps = await project(
      [status(1, "running"), toolUse(3, "c1", PATCH), interrupted].sort((a, b) => Number(a.id) - Number(b.id)),
    );
    const tool = steps.find((s) => s.kind === "tool");

    expect(tool?.state).toBe("error");
    expect(tool?.summary).toBe("Failed");
    expect(JSON.stringify(steps)).not.toContain("interrupted_by_restart");
  });
});

describe("projectAgentRunSteps run boundaries (issue #1847)", () => {
  it("gives the end step the counts of the run and every other step none", async () => {
    const steps = await project([status(1, "running"), status(2, "done")], {
      counts: { toolCount: 3, approvalCount: 0 },
    });

    expect(steps.map((s) => [s.kind, s.title, s.summary])).toEqual([
      ["start", "Run started", null],
      ["end", "Run finished", "3 tools, no approvals"],
    ]);
  });

  it("gives the end step its summary in Czech", async () => {
    const [, end] = await project([status(1, "running"), status(2, "done")], {
      locale: "cs",
      counts: { toolCount: 2, approvalCount: 1 },
    });

    expect(end?.title).toBe("Dokončení běhu");
    expect(end?.summary).toBe("2 nástroje, 1 schválení");
  });

  it("gives an end step no summary when no counts were read, and an error step none ever", async () => {
    const steps = await project([status(1, "running"), status(2, "error")], {
      counts: { toolCount: 1, approvalCount: 0 },
    });
    const end = await projectOne([status(1, "done")]);

    expect(steps[1]).toMatchObject({ kind: "error", title: "Run failed", summary: null });
    expect(end).toMatchObject({ kind: "end", summary: null });
  });

  it("returns an empty list for a page with no step", async () => {
    expect(await project([])).toEqual([]);
  });
});

type RequestFixture = Pick<ApprovalRequestStateView, "status" | "executionStatus" | "executionResult">;

const GENERIC_CONFLICT = (reason?: string) => ({
  error: { code: "version_conflict", details: reason === undefined ? {} : { reason } },
});

describe("approvalStepState (issue #1862)", () => {
  const cases: [string, RequestFixture, ReturnType<typeof approvalStepState>][] = [
    [
      "a pending request",
      { status: "pending", executionStatus: "not_approved", executionResult: null },
      { approvalState: "pending" },
    ],
    [
      "an approved and queued request",
      { status: "approved", executionStatus: "queued", executionResult: null },
      { approvalState: "executing" },
    ],
    [
      "a succeeded request",
      { status: "approved", executionStatus: "succeeded", executionResult: { result: 1 } },
      { approvalState: "executed" },
    ],
    [
      "a rejected request",
      { status: "rejected", executionStatus: "not_approved", executionResult: null },
      { approvalState: "rejected" },
    ],
    [
      "a failed MCP tool call",
      { status: "approved", executionStatus: "conflict", executionResult: { text: "boom", outcomeKind: "callFailed" } },
      { approvalState: "failed" },
    ],
    [
      "a source that changed",
      { status: "approved", executionStatus: "conflict", executionResult: GENERIC_CONFLICT() },
      { approvalState: "conflict", conflictReason: "approval.conflict.changed" },
    ],
    [
      "a source that was deleted",
      { status: "approved", executionStatus: "conflict", executionResult: GENERIC_CONFLICT("not_found") },
      { approvalState: "conflict", conflictReason: "approval.conflict.deleted" },
    ],
    [
      "an archived database",
      { status: "approved", executionStatus: "conflict", executionResult: GENERIC_CONFLICT("database_archived") },
      { approvalState: "conflict", conflictReason: "approval.conflict.archived" },
    ],
    [
      "a revoked grant",
      {
        status: "approved",
        executionStatus: "conflict",
        executionResult: { text: "x", outcomeKind: "toolUnavailable" },
      },
      { approvalState: "conflict", conflictReason: "approval.conflict.toolUnavailable" },
    ],
    [
      "a stuck claim",
      { status: "approved", executionStatus: "conflict", executionResult: { text: "x", outcomeKind: "staleClaim" } },
      { approvalState: "conflict", conflictReason: "approval.conflict.other" },
    ],
    [
      "a conflict with a result nobody can classify",
      { status: "approved", executionStatus: "conflict", executionResult: "plain legacy text" },
      { approvalState: "conflict", conflictReason: "approval.conflict.other" },
    ],
    [
      "a request from before the execution protocol",
      { status: "approved", executionStatus: "legacy_terminal", executionResult: null },
      { approvalState: "conflict", conflictReason: "approval.conflict.other" },
    ],
    [
      "a request the cutover rejected and marked legacy_terminal",
      { status: "rejected", executionStatus: "legacy_terminal", executionResult: null },
      { approvalState: "rejected" },
    ],
    [
      "an approved request that is not queued",
      { status: "approved", executionStatus: "not_approved", executionResult: null },
      null,
    ],
  ];

  it.each(cases)("maps %s", (_name, request, expected) => {
    expect(approvalStepState(request)).toEqual(expected);
  });
});

describe("projectAgentRunSteps approval state (issue #1862)", () => {
  const SENTINEL = "execution-text-never-returned";
  const approvalEvents = (): AgentRunEventRow[] => [
    toolUse(1, "a1", { operation: "item.delete" }),
    toolResult(2, "a1", { operation: "item.delete" }, { error: false, approvalRequestId: APPROVAL_ID }),
  ];
  const view = (request: RequestFixture): ReadonlyMap<string, ApprovalRequestStateView> =>
    new Map([[APPROVAL_ID, { id: APPROVAL_ID, ...request }]]);
  const read = (request: RequestFixture) => projectOne(approvalEvents(), { approvals: view(request) });

  it.each([
    ["pending", { status: "pending", executionStatus: "not_approved" }, "pending", "waitingApproval"],
    ["executing", { status: "approved", executionStatus: "queued" }, "executing", "ok"],
    ["executed", { status: "approved", executionStatus: "succeeded" }, "executed", "ok"],
    ["rejected", { status: "rejected", executionStatus: "not_approved" }, "rejected", "ok"],
    ["conflict", { status: "approved", executionStatus: "conflict" }, "conflict", "error"],
    ["legacy", { status: "approved", executionStatus: "legacy_terminal" }, "conflict", "error"],
  ] as const)("shows a %s request as %s and the step as %s", async (_name, request, approvalState, state) => {
    const step = await read({ ...request, executionResult: { text: SENTINEL } });

    expect(step).toMatchObject({ kind: "approval", approvalRequestId: APPROVAL_ID, approvalState, state });
    expect(JSON.stringify(step)).not.toContain(SENTINEL);
  });

  it("shows a failed MCP tool call as failed, with the step in error and no conflict reason", async () => {
    const step = await read({
      status: "approved",
      executionStatus: "conflict",
      executionResult: { text: SENTINEL, outcomeKind: "callFailed" },
    });

    expect(step).toMatchObject({ approvalState: "failed", state: "error" });
    expect("conflictReason" in step).toBe(false);
  });

  it("sets the conflict reason of a conflict only", async () => {
    const conflict = await read({
      status: "approved",
      executionStatus: "conflict",
      executionResult: GENERIC_CONFLICT("not_found"),
    });
    const executed = await read({ status: "approved", executionStatus: "succeeded", executionResult: null });

    expect(conflict.conflictReason).toBe("approval.conflict.deleted");
    expect("conflictReason" in executed).toBe(false);
  });

  it("reads the same step as pending, then executing, then executed as its request moves on", async () => {
    const states: RequestFixture[] = [
      { status: "pending", executionStatus: "not_approved", executionResult: null },
      { status: "approved", executionStatus: "queued", executionResult: null },
      { status: "approved", executionStatus: "succeeded", executionResult: null },
    ];

    const steps = [];
    for (const request of states) steps.push(await read(request));

    expect(steps.map((s) => [s.approvalState, s.state])).toEqual([
      ["pending", "waitingApproval"],
      ["executing", "ok"],
      ["executed", "ok"],
    ] satisfies [AgentRunApprovalState, string][]);
  });

  it("keeps the step of an unreadable request with the state of its call and no approval state", async () => {
    const missing = await projectOne(approvalEvents(), { approvals: new Map() });
    const unmapped = await read({ status: "approved", executionStatus: "not_approved", executionResult: null });

    for (const step of [missing, unmapped]) {
      expect(step).toMatchObject({ kind: "approval", state: "ok", approvalRequestId: APPROVAL_ID });
      expect("approvalState" in step).toBe(false);
      expect("conflictReason" in step).toBe(false);
    }
  });

  it("does not give an ordinary tool step an approval state even when a request with some id is known", async () => {
    const step = await projectOne([toolUse(1, "c1", PATCH), toolResult(2, "c1", PATCH)], {
      approvals: view({ status: "pending", executionStatus: "not_approved", executionResult: null }),
    });

    expect(step).toMatchObject({ kind: "tool", state: "ok" });
    expect("approvalState" in step).toBe(false);
  });
});
