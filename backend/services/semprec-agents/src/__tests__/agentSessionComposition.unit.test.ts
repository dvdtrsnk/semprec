import { describe, expect, it, vi, afterEach } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Pool, Client } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import type { AgentRunRow, McpInvokeResult, McpToolGrantForProject } from "@semprec/data";
import { Type, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSessionFactoryForRun, mcpModelToolName, withUniqueNames } from "../agentSessionComposition.js";
import { logger } from "../logger.js";
import * as piSession from "../piAgentSession.js";

const testMetadataResolver = {
  resolve: () => ({ icon: null, color: null, overviewOrder: null, switcherOrder: null, clientVisible: true }),
};

function fakeTool(name: string, label: string): AgentTool {
  return {
    name,
    label,
    description: `fake ${label}`,
    parameters: Type.Object({}),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("withUniqueNames (issue #1074)", () => {
  it("keeps the first tool of a colliding name and logs only the tool name", () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const first = fakeTool("mcp_search", "serverA: search");
    const second = fakeTool("mcp_search", "serverB: search");

    const kept = withUniqueNames([first, second]);

    expect(kept).toEqual([first]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      { toolName: "mcp_search" },
      "Agent tool name collides with an earlier tool; skipped",
    );
    const serialized = JSON.stringify(warnSpy.mock.calls);
    expect(serialized).not.toContain("serverB");
    expect(serialized).not.toContain("serverA");
  });
});

it("retains native call events for a module tool without inventing generic or MCP identity", async () => {
  const pool = new Pool();
  const faux = fauxProvider();
  const registry = new ModuleRegistry(() => new Set());
  vi.spyOn(registry, "getAgentToolDefinitions").mockResolvedValue([
    {
      moduleId: "fixture",
      name: "fixture.inspect",
      argumentSchema: { type: "object", properties: {} },
      handler: () => async () => ({ error: false, result: "ok" }),
      parseArguments: (value) => ({ success: true, data: value }),
    },
  ]);
  const run: AgentRunRow = {
    id: "run-1",
    projectItemId: "project-1",
    parentRunId: null,
    heartbeatId: null,
    heartbeatOccurrenceId: null,
    retryOfRunId: null,
    attempt: 1,
    threadId: null,
    triggeredBy: "user",
    unit: "invocation",
    task: "run",
    status: "running",
    result: null,
    errorCode: null,
    errorDetail: null,
    startedAt: "2026-10-27T00:00:00Z",
    finishedAt: null,
    actorUserId: "user-1",
  };
  fixtures.operations = [];
  fixtures.grants = [];
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("fixture_inspect", {}, { id: "module-call" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("done"),
  ]);
  try {
    const factory = await createAgentSessionFactoryForRun(
      pool,
      registry,
      {
        model: faux.getModel(),
        streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
        isBudgetRefusal: () => false,
      },
      run,
    );
    const events = [];
    for await (const event of factory({ task: run.task }).messages())
      if (event.kind === "tool_use" || event.kind === "tool_result") events.push(event);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event).toMatchObject({ name: "fixture_inspect", toolCallId: "module-call" });
      expect(event).not.toHaveProperty("operation");
      expect(event).not.toHaveProperty("mcp");
    }
  } finally {
    fixtures.operations = ["item.patch"];
    await pool.end();
  }
});

it("keeps the earlier generic tool when a module name collides in a composed session", async () => {
  const pool = new Pool();
  const faux = fauxProvider();
  const registry = new ModuleRegistry(() => new Set());
  vi.spyOn(registry, "getAgentToolDefinitions").mockResolvedValue([
    {
      moduleId: "fixture",
      name: "item.patch",
      argumentSchema: { type: "object", properties: {} },
      handler: () => async () => ({ error: false, result: "module" }),
      parseArguments: (value) => ({ success: true, data: value }),
    },
  ]);
  const warn = vi.spyOn(logger, "warn");
  let tools: AgentTool[] = [];
  vi.spyOn(piSession, "createPiAgentSessionFactory").mockImplementation((options) => {
    tools = options.tools;
    return () => ({ async *messages() {} });
  });
  const run: AgentRunRow = {
    id: "run-1",
    projectItemId: "project-1",
    parentRunId: null,
    heartbeatId: null,
    heartbeatOccurrenceId: null,
    retryOfRunId: null,
    attempt: 1,
    threadId: null,
    triggeredBy: "user",
    unit: "invocation",
    task: "run",
    status: "running",
    result: null,
    errorCode: null,
    errorDetail: null,
    startedAt: "2026-10-27T00:00:00Z",
    finishedAt: null,
    actorUserId: "user-1",
  };
  fixtures.operations = ["item.patch"];
  fixtures.grants = [];
  try {
    await createAgentSessionFactoryForRun(
      pool,
      registry,
      {
        model: faux.getModel(),
        streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
        isBudgetRefusal: () => false,
      },
      run,
    );
    expect(tools.filter((tool) => tool.name === "item_patch")).toHaveLength(1);
    const tool = tools.find((candidate) => candidate.name === "item_patch");
    if (!tool) throw new Error("Generic tool missing");
    expect((await tool.execute("call", {})).content).toEqual([{ type: "text", text: "patched" }]);
    expect(warn).toHaveBeenCalledWith(
      { toolName: "item_patch" },
      "Agent tool name collides with an earlier tool; skipped",
    );
  } finally {
    await pool.end();
  }
});

const fixtures = vi.hoisted(() => ({
  grants: [] as McpToolGrantForProject[],
  operations: ["item.patch"] as string[],
  calls: [] as unknown[][],
  resolverCalls: [] as unknown[],
  locale: null as string | null,
  guidance: null as string | null,
  mcpResult: null as (McpInvokeResult & { approvalRequestId?: string }) | null,
  structured: {},
}));
vi.mock("@semprec/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@semprec/data")>()),
  createCollectionMetadataResolver: async () => testMetadataResolver,
  withClient: async (_pool: Pool, fn: (client: Client) => Promise<unknown>) => fn(new Client()),
  withTransaction: async (_pool: Pool, fn: (client: Client) => Promise<unknown>) => fn(new Client()),
  resolveModuleAgentToolsForRun: async (pool: Pool, registry: ModuleRegistry, runId: string) => {
    const isCallable = (value: unknown): value is (...args: unknown[]) => unknown => typeof value === "function";
    const definitions = await registry.getAgentToolDefinitions(new Set());
    return definitions.map((definition) => ({
      name: definition.name,
      argumentSchema: definition.argumentSchema,
      acceptsArguments: (args: unknown) => definition.parseArguments(args).success,
      invoke: async (args: unknown) => {
        const parsed = definition.parseArguments(args);
        if (!parsed.success || !isCallable(definition.handler)) throw new Error("Invalid fixture");
        const handler: unknown = definition.handler(pool, new Map());
        if (!isCallable(handler)) throw new Error("Invalid fixture handler");
        const result: unknown = await handler(runId, parsed.data);
        if (typeof result !== "object" || result === null || !("result" in result) || !("error" in result))
          throw new Error("Invalid fixture result");
        return result;
      },
    }));
  },
  listMcpToolGrantsForProject: async () => fixtures.grants,
  getTenantUserLocale: async () => fixtures.locale,
}));
vi.mock("@semprec/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@semprec/agent-runtime")>()),
  listGrantedGenericOperationAgentTools: async (...args: unknown[]) => {
    fixtures.resolverCalls.push(args.at(-1));
    return fixtures.operations;
  },
  createGenericOperationAgentTools: (...args: unknown[]) => {
    fixtures.resolverCalls.push(args.at(-1));
    return {
      "item.patch": async () => ({ result: "patched", error: false }),
      "item.delete": async (...call: unknown[]) => {
        fixtures.calls.push(call);
        return { result: "deferred", error: false, ...fixtures.structured };
      },
    };
  },
  createApprovalGatedMcpInvokeTool: () => async () => fixtures.mcpResult ?? { result: "found", error: false },
  createProjectAgentGuidanceSystemPromptOverride: async () => (prompt: string) =>
    fixtures.guidance ? `${prompt}\n${fixtures.guidance}` : prompt,
}));

function grant(registration: string, server: string, granted = true, online = true): McpToolGrantForProject {
  return {
    mcpToolRegistrationId: registration,
    mcpServerItemId: server,
    mcpServerName: `${server} name`,
    toolName: "search",
    description: null,
    displayLabel: "search",
    requiresApproval: false,
    riskClass: "read",
    mcpServerOnline: online,
    granted,
    effective: granted && online,
    server: { state: online ? "connected" : "offline", lastConnectedAt: null, lastErrorReason: null },
  };
}

it.each([true, false])(
  "wires retained generic and MCP metadata into the production session (project=%s)",
  async (hasProject) => {
    const pool = new Pool();
    const faux = fauxProvider();
    fixtures.grants = [
      grant("denied", "denied", false),
      grant("first-reg", "first-server"),
      grant("second-reg", "second-server"),
    ];
    const run: AgentRunRow = {
      id: "run-1",
      projectItemId: hasProject ? "project-1" : null,
      parentRunId: null,
      heartbeatId: null,
      heartbeatOccurrenceId: null,
      retryOfRunId: null,
      attempt: 1,
      threadId: null,
      triggeredBy: "user",
      unit: "invocation",
      task: "run",
      status: "running",
      result: null,
      errorCode: null,
      errorDetail: null,
      startedAt: "2026-10-27T00:00:00Z",
      finishedAt: null,
      actorUserId: "user-1",
    };
    const model = faux.getModel();
    const names: string[][] = [];
    faux.setResponses([
      (context) => {
        names.push(context.tools?.map((tool) => tool.name) ?? []);
        return fauxAssistantMessage(
          [
            fauxToolCall("item_patch", { itemId: "item-1", properties: {} }, { id: "generic-call" }),
            ...(hasProject
              ? [fauxToolCall(mcpModelToolName("search", "first-server"), { databaseId: "db-1" }, { id: "mcp-call" })]
              : []),
          ],
          { stopReason: "toolUse" },
        );
      },
      fauxAssistantMessage("done"),
    ]);
    try {
      const factory = await createAgentSessionFactoryForRun(
        pool,
        new ModuleRegistry(() => new Set<string>()),
        {
          model,
          streamFn: (m, context, options) => faux.provider.streamSimple(m, context, options),
          isBudgetRefusal: () => false,
        },
        run,
      );
      const events = [];
      for await (const event of factory({ task: run.task }).messages()) {
        if (event.kind === "tool_use" || event.kind === "tool_result") events.push(event);
      }
      expect(fixtures.resolverCalls.length).toBeGreaterThanOrEqual(2);
      expect(fixtures.resolverCalls.every((resolver) => resolver === testMetadataResolver)).toBe(true);
      expect(names).toEqual([
        hasProject
          ? ["item_patch", mcpModelToolName("search", "first-server"), mcpModelToolName("search", "second-server")]
          : ["item_patch"],
      ]);
      expect(events).toHaveLength(hasProject ? 4 : 2);
      for (const kind of ["tool_use", "tool_result"]) {
        expect(events.find((event) => event.kind === kind && event.name === "item_patch")).toMatchObject({
          operation: "item.patch",
          targetItemId: "item-1",
        });
        const mcp = events.find(
          (event) => event.kind === kind && event.name === mcpModelToolName("search", "first-server"),
        );
        if (hasProject) {
          expect(mcp).toMatchObject({
            mcp: {
              toolRegistrationId: "first-reg",
              serverItemId: "first-server",
              serverName: "first-server name",
              toolName: "search",
            },
            targetDatabaseId: "db-1",
          });
          expect(mcp).not.toHaveProperty("operation");
        } else expect(mcp).toBeUndefined();
      }
      expect(JSON.stringify(events)).not.toContain("second-reg");
      expect(JSON.stringify(events)).not.toContain("denied");
    } finally {
      await pool.end();
    }
  },
);

describe("mcpModelToolName (issue #1533)", () => {
  const github = "a1b2c3d4-0000-4000-8000-000000000001";
  const linear = "ffeeddcc-0000-4000-8000-000000000002";

  it("qualifies the tool name with the first 8 hex characters of the server id", () => {
    expect(mcpModelToolName("list_issues", github)).toBe("mcp_list_issues_a1b2c3d4");
    expect(mcpModelToolName("list_issues", "A1B2C3D4-0000")).toBe("mcp_list_issues_a1b2c3d4");
  });

  it("gives different servers different names for the same tool", () => {
    expect(mcpModelToolName("list_issues", github)).not.toBe(mcpModelToolName("list_issues", linear));
  });

  it("warns and keeps the first tool when different servers share the same id prefix", () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const samePrefix = "a1b2c3d4-0000-4000-8000-000000000002";
    const first = fakeTool(mcpModelToolName("list_issues", github), "first");
    const second = fakeTool(mcpModelToolName("list_issues", samePrefix), "second");
    expect(first.name).toBe(second.name);
    expect(withUniqueNames([first, second])).toEqual([first]);
    expect(warnSpy).toHaveBeenCalledWith(
      { toolName: first.name },
      "Agent tool name collides with an earlier tool; skipped",
    );
  });

  it("sanitizes the tool name and keeps the name within 64 characters ending in the suffix", () => {
    expect(mcpModelToolName("list.issues/v1", github)).toBe("mcp_list_issues_v1_a1b2c3d4");
    const long = mcpModelToolName("x".repeat(120), github);
    expect(long).toHaveLength(64);
    expect(long.endsWith("_a1b2c3d4")).toBe(true);
    expect(long).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it("offers the same tool of two servers under two names and survives a server rename", async () => {
    const pool = new Pool();
    const faux = fauxProvider();
    const offered: string[][] = [];
    faux.setResponses([
      (context) => {
        offered.push(context.tools?.map((tool) => tool.name) ?? []);
        return fauxAssistantMessage("done");
      },
      (context) => {
        offered.push(context.tools?.map((tool) => tool.name) ?? []);
        return fauxAssistantMessage("done");
      },
    ]);
    const run = { id: "run-1", projectItemId: "project-1", actorUserId: "user-1", task: "run" } as AgentRunRow;
    try {
      for (const renamed of [false, true]) {
        fixtures.grants = [grant("gh-reg", github), grant("li-reg", linear)].map((g) => ({
          ...g,
          toolName: "list_issues",
          mcpServerName: renamed ? "Renamed" : g.mcpServerName,
        }));
        const factory = await createAgentSessionFactoryForRun(
          pool,
          new ModuleRegistry(() => new Set<string>()),
          {
            model: faux.getModel(),
            streamFn: (m, context, options) => faux.provider.streamSimple(m, context, options),
            isBudgetRefusal: () => false,
          },
          run,
        );
        for await (const event of factory({ task: "run" }).messages()) void event;
      }
      const expected = [mcpModelToolName("list_issues", github), mcpModelToolName("list_issues", linear)];
      expect(offered.map((names) => names.filter((n) => n.startsWith("mcp_")))).toEqual([expected, expected]);
    } finally {
      await pool.end();
    }
  });

  it("skips the later of two tools of one server that shorten to the same name, with the warning", () => {
    const warnSpy = vi.spyOn(logger, "warn");
    const a = fakeTool(mcpModelToolName("x".repeat(60) + "a", github), "a");
    const b = fakeTool(mcpModelToolName("x".repeat(60) + "b", github), "b");
    expect(withUniqueNames([a, b])).toEqual([a]);
    expect(warnSpy).toHaveBeenCalledWith(
      { toolName: a.name },
      "Agent tool name collides with an earlier tool; skipped",
    );
  });
});

describe("MCP tool catalog of inactive servers (issue #1447)", () => {
  async function offeredToolNames(): Promise<string[]> {
    const pool = new Pool();
    const faux = fauxProvider();
    let names: string[] = [];
    faux.setResponses([
      (context) => {
        names = context.tools?.map((tool) => tool.name) ?? [];
        return fauxAssistantMessage("done");
      },
    ]);
    try {
      const factory = await createAgentSessionFactoryForRun(
        pool,
        new ModuleRegistry(() => new Set<string>()),
        {
          model: faux.getModel(),
          streamFn: (m, context, options) => faux.provider.streamSimple(m, context, options),
          isBudgetRefusal: () => false,
        },
        {
          id: "run-1",
          projectItemId: "project-1",
          parentRunId: null,
          heartbeatId: null,
          heartbeatOccurrenceId: null,
          retryOfRunId: null,
          attempt: 1,
          threadId: null,
          triggeredBy: "user",
          unit: "invocation",
          task: "run",
          status: "running",
          result: null,
          errorCode: null,
          errorDetail: null,
          startedAt: "2026-10-27T00:00:00Z",
          finishedAt: null,
          actorUserId: "user-1",
        },
      );
      for await (const event of factory({ task: "run" }).messages()) void event;
      return names.filter((name) => name.startsWith("mcp_"));
    } finally {
      await pool.end();
    }
  }

  it("leaves out a granted tool of an inactive server, keeps the grant and offers it again once active", async () => {
    const inactive = grant("off-reg", "off-server", true, false);
    fixtures.grants = [inactive];
    expect(await offeredToolNames()).toEqual([]);
    expect(fixtures.grants).toEqual([inactive]);
    expect(inactive.granted).toBe(true);

    fixtures.grants = [grant("off-reg", "off-server", true, true)];
    expect(await offeredToolNames()).toEqual([mcpModelToolName("search", "off-server")]);
  });

  it("keeps a granted tool of an active server and drops an ungranted one", async () => {
    fixtures.grants = [grant("on-reg", "on-server", true, true)];
    expect(await offeredToolNames()).toEqual([mcpModelToolName("search", "on-server")]);
    fixtures.grants = [grant("on-reg", "on-server", false, true)];
    expect(await offeredToolNames()).toEqual([]);
  });
});

describe("agent-only approval reason (issue #1420)", () => {
  const run: AgentRunRow = {
    id: "run-1",
    projectItemId: null,
    parentRunId: null,
    heartbeatId: null,
    heartbeatOccurrenceId: null,
    retryOfRunId: null,
    attempt: 1,
    threadId: null,
    triggeredBy: "user",
    unit: "invocation",
    task: "run",
    status: "running",
    result: null,
    errorCode: null,
    errorDetail: null,
    startedAt: "2026-10-27T00:00:00Z",
    finishedAt: null,
    actorUserId: "user-1",
  };

  async function runCalls(args: Record<string, unknown>) {
    fixtures.operations = ["item.patch", "item.delete"];
    fixtures.calls = [];
    const pool = new Pool();
    const faux = fauxProvider();
    const schemas: Record<string, unknown> = {};
    faux.setResponses([
      (context) => {
        for (const tool of context.tools ?? []) schemas[tool.name] = tool.parameters;
        return fauxAssistantMessage([fauxToolCall("item_delete", args, { id: "call" })], { stopReason: "toolUse" });
      },
      fauxAssistantMessage("done"),
    ]);
    try {
      const factory = await createAgentSessionFactoryForRun(
        pool,
        new ModuleRegistry(() => new Set<string>()),
        {
          model: faux.getModel(),
          streamFn: (m, context, options) => faux.provider.streamSimple(m, context, options),
          isBudgetRefusal: () => false,
        },
        run,
      );
      const results: string[] = [];
      for await (const event of factory({ task: run.task }).messages()) {
        if (event.kind === "tool_result") results.push(JSON.stringify(event));
      }
      return { schemas, results };
    } finally {
      fixtures.operations = ["item.patch"];
      await pool.end();
    }
  }

  it("adds reason to the approval-gated schema only and strips it from the operation arguments", async () => {
    const { schemas } = await runCalls({ itemId: "item-1", reason: "You never open it." });
    expect(JSON.stringify(schemas.item_delete)).toContain('"reason"');
    expect(JSON.stringify(schemas.item_patch)).not.toContain('"reason"');
    expect(fixtures.calls).toEqual([
      ["run-1", { itemId: "item-1" }, { reason: "You never open it.", toolCallId: "call" }],
    ]);
  });

  it("passes only the tool call id when the model gave no reason (issue #1618)", async () => {
    await runCalls({ itemId: "item-1" });
    expect(fixtures.calls).toEqual([["run-1", { itemId: "item-1" }, { toolCallId: "call" }]]);
  });

  it("normalizes a null reason to absence in the provider-facing composition", async () => {
    await runCalls({ itemId: "item-1", reason: null });
    expect(fixtures.calls).toEqual([["run-1", { itemId: "item-1" }, { toolCallId: "call" }]]);
  });

  it.each([true, 123])("documents SDK normalization of generic reason %s before the wrapper", async (reason) => {
    await runCalls({ itemId: "item-1", reason });
    expect(fixtures.calls).toEqual([["run-1", { itemId: "item-1" }, { reason: String(reason), toolCallId: "call" }]]);
  });

  it.each([true, 123])("rejects generic non-string reason %s that reaches the wrapper", async (reason) => {
    fixtures.operations = ["item.delete"];
    fixtures.calls = [];
    const pool = new Pool();
    const faux = fauxProvider();
    let tools: AgentTool[] = [];
    vi.spyOn(piSession, "createPiAgentSessionFactory").mockImplementation((options) => {
      tools = options.tools;
      return () => ({ async *messages() {} });
    });
    try {
      await createAgentSessionFactoryForRun(
        pool,
        new ModuleRegistry(() => new Set<string>()),
        {
          model: faux.getModel(),
          streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
          isBudgetRefusal: () => false,
        },
        run,
      );
      const tool = tools.find((candidate) => candidate.name === "item_delete");
      if (!tool) throw new Error("expected generic tool");
      const result = await tool.execute("call", { itemId: "item-1", reason });
      expect(result.details).toMatchObject({ error: true });
      expect(fixtures.calls).toEqual([]);
    } finally {
      fixtures.operations = ["item.patch"];
      await pool.end();
    }
  });

  it("writes approvalRequestId and changes into the generic tool result details", async () => {
    fixtures.structured = { approvalRequestId: "req-1", changes: [{ key: "due", before: "a", after: "b" }] };
    try {
      const { results } = await runCalls({ itemId: "item-1" });
      const details = (JSON.parse(results[0]!) as { result: { details: unknown } }).result.details;
      expect(details).toEqual({
        error: false,
        approvalRequestId: "req-1",
        changes: [{ key: "due", before: "a", after: "b" }],
      });
    } finally {
      fixtures.structured = {};
    }
  });

  it("writes neither field when the operation reported none", async () => {
    const { results } = await runCalls({ itemId: "item-1" });
    const details = (JSON.parse(results[0]!) as { result: { details: unknown } }).result.details;
    expect(details).toEqual({ error: false });
  });

  it("rejects a reason over 500 characters without calling the operation", async () => {
    const { results } = await runCalls({ itemId: "item-1", reason: "x".repeat(501) });
    expect(fixtures.calls).toEqual([]);
    expect(results.join()).toMatch(/reason/);
  });

  it("accepts 500 non-BMP characters and rejects 501", async () => {
    const reason = "😀".repeat(500);
    await runCalls({ itemId: "item-1", reason });
    expect(fixtures.calls).toEqual([["run-1", { itemId: "item-1" }, { reason, toolCallId: "call" }]]);
    const { results } = await runCalls({ itemId: "item-1", reason: "😀".repeat(501) });
    expect(fixtures.calls).toEqual([]);
    expect(results.join()).toMatch(/reason/i);
  });
});

describe("agent language instruction (issue #1388)", () => {
  const CS = "Answer and write all user-visible text in Czech.";
  const EN = "Answer and write all user-visible text in English.";

  async function composedPrompt(
    locale: string | null,
    projectItemId: string | null = null,
    localeAfterComposition: string | null = locale,
  ): Promise<string> {
    fixtures.locale = locale;
    const pool = new Pool();
    const faux = fauxProvider();
    let prompt = "";
    faux.setResponses([
      (context) => {
        prompt = context.systemPrompt ?? "";
        return fauxAssistantMessage("done");
      },
    ]);
    const run: AgentRunRow = {
      id: "run-1",
      projectItemId,
      parentRunId: null,
      heartbeatId: null,
      heartbeatOccurrenceId: null,
      retryOfRunId: null,
      attempt: 1,
      threadId: null,
      triggeredBy: "user",
      unit: "invocation",
      task: "run",
      status: "running",
      result: null,
      errorCode: null,
      errorDetail: null,
      startedAt: "2026-10-27T00:00:00Z",
      finishedAt: null,
      actorUserId: "user-1",
    };
    try {
      const factory = await createAgentSessionFactoryForRun(
        pool,
        new ModuleRegistry(() => new Set<string>()),
        {
          model: faux.getModel(),
          streamFn: (m, context, options) => faux.provider.streamSimple(m, context, options),
          isBudgetRefusal: () => false,
        },
        run,
      );
      fixtures.locale = localeAfterComposition;
      for await (const event of factory({ task: run.task }).messages()) void event;
      return prompt;
    } finally {
      fixtures.locale = null;
      fixtures.guidance = null;
      await pool.end();
    }
  }

  it("adds the Czech sentence for cs and not the English one", async () => {
    const prompt = await composedPrompt("cs");
    expect(prompt).toContain(CS);
    expect(prompt).not.toContain(EN);
  });

  it("adds the English sentence for en and not the Czech one", async () => {
    const prompt = await composedPrompt("en");
    expect(prompt).toContain(EN);
    expect(prompt).not.toContain(CS);
  });

  it.each([null, "de"])("leaves the base prompt unchanged for locale %s", async (locale) => {
    const prompt = await composedPrompt(locale);
    expect(prompt).not.toContain("Answer and write all user-visible text");
    expect(prompt).toBe(await composedPrompt(null));
    expect(prompt.endsWith("instead of retrying it.")).toBe(true);
  });

  it("applies the project guidance after the language sentence", async () => {
    fixtures.guidance = "Project guidance: be brief.";
    const prompt = await composedPrompt("en", "project-1");
    expect(prompt.indexOf(EN)).toBeGreaterThan(-1);
    expect(prompt.indexOf("Project guidance: be brief.")).toBeGreaterThan(prompt.indexOf(EN));
  });

  it("keeps the composed run's locale when it changes and uses the new locale for the next run", async () => {
    const existing = await composedPrompt("en", null, "cs");
    const next = await composedPrompt("cs");
    expect(existing).toContain(EN);
    expect(existing).not.toContain(CS);
    expect(next).toContain(CS);
    expect(next).not.toContain(EN);
  });
});

describe("MCP failure classification in the tool result (issue #1444)", () => {
  const run: AgentRunRow = {
    id: "run-1",
    projectItemId: "project-1",
    parentRunId: null,
    heartbeatId: null,
    heartbeatOccurrenceId: null,
    retryOfRunId: null,
    attempt: 1,
    threadId: null,
    triggeredBy: "user",
    unit: "invocation",
    task: "run",
    status: "running",
    result: null,
    errorCode: null,
    errorDetail: null,
    startedAt: "2026-10-27T00:00:00Z",
    finishedAt: null,
    actorUserId: "user-1",
  };

  async function mcpToolResultDetails(mcpResult: typeof fixtures.mcpResult, args: unknown = { databaseId: "db-1" }) {
    fixtures.grants = [grant("first-reg", "first-server")];
    fixtures.mcpResult = mcpResult;
    const pool = new Pool();
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall(mcpModelToolName("search", "first-server"), args as Record<string, unknown>, { id: "call" })],
        {
          stopReason: "toolUse",
        },
      ),
      fauxAssistantMessage("done"),
    ]);
    try {
      const factory = await createAgentSessionFactoryForRun(
        pool,
        new ModuleRegistry(() => new Set<string>()),
        {
          model: faux.getModel(),
          streamFn: (m, context, options) => faux.provider.streamSimple(m, context, options),
          isBudgetRefusal: () => false,
        },
        run,
      );
      for await (const event of factory({ task: run.task }).messages()) {
        if (event.kind === "tool_result") return (event.result as { details: unknown }).details;
      }
      throw new Error("no tool_result event");
    } finally {
      fixtures.mcpResult = null;
      await pool.end();
    }
  }

  it("writes failureKind, mcpServerItemId, connectorName and timeoutMs for a timeout", async () => {
    const details = await mcpToolResultDetails({
      result: "x",
      error: true,
      failure: { failureKind: "timeout", mcpServerItemId: "first-server", timeoutMs: 60000 },
    });
    expect(details).toEqual({
      error: true,
      failureKind: "timeout",
      mcpServerItemId: "first-server",
      connectorName: "first-server name",
      timeoutMs: 60000,
    });
  });

  it("omits the keys that are absent from the failure (unavailable without a server item)", async () => {
    const details = await mcpToolResultDetails({
      result: "x",
      error: true,
      failure: { failureKind: "unavailable" },
    });
    expect(details).toEqual({ error: true, failureKind: "unavailable", connectorName: "first-server name" });
  });

  it("writes approvalRequestId for a deferred MCP call", async () => {
    expect(await mcpToolResultDetails({ result: "pending", error: false, approvalRequestId: "req-9" })).toEqual({
      error: false,
      approvalRequestId: "req-9",
    });
  });

  it("carries none of the classification keys for a successful call", async () => {
    expect(await mcpToolResultDetails({ result: "found", error: false })).toEqual({ error: false });
  });
});
