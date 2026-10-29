import { describe, expect, it, vi, afterEach } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Pool, Client } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import type { AgentRunRow, McpInvokeResult, McpToolGrantForProject } from "@semprec/data";
import { Type, fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSessionFactoryForRun, withUniqueNames } from "../agentSessionComposition.js";
import { logger } from "../logger.js";

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

const fixtures = vi.hoisted(() => ({
  grants: [] as McpToolGrantForProject[],
  operations: ["item.patch"] as string[],
  calls: [] as unknown[][],
  locale: null as string | null,
  guidance: null as string | null,
  mcpResult: null as McpInvokeResult | null,
}));
vi.mock("@semprec/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@semprec/data")>()),
  withClient: async (_pool: Pool, fn: (client: Client) => Promise<unknown>) => fn(new Client()),
  listMcpToolGrantsForProject: async () => fixtures.grants,
  getTenantUserLocale: async () => fixtures.locale,
}));
vi.mock("@semprec/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@semprec/agent-runtime")>()),
  listGrantedGenericOperationAgentTools: async () => fixtures.operations,
  createGenericOperationAgentTools: () => ({
    "item.patch": async () => ({ result: "patched", error: false }),
    "item.delete": async (...call: unknown[]) => {
      fixtures.calls.push(call);
      return { result: "deferred", error: false };
    },
  }),
  createApprovalGatedMcpInvokeTool: () => async () => fixtures.mcpResult ?? { result: "found", error: false },
  createProjectAgentGuidanceSystemPromptOverride: async () => (prompt: string) =>
    fixtures.guidance ? `${prompt}\n${fixtures.guidance}` : prompt,
}));

function grant(registration: string, server: string, granted = true): McpToolGrantForProject {
  return {
    mcpToolRegistrationId: registration,
    mcpServerItemId: server,
    mcpServerName: `${server} name`,
    toolName: "search",
    description: null,
    displayLabel: "search",
    requiresApproval: false,
    riskClass: "read",
    mcpServerOnline: true,
    granted,
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
      triggeredBy: "user",
      unit: "invocation",
      task: "run",
      status: "running",
      result: null,
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
            ...(hasProject ? [fauxToolCall("mcp_search", { databaseId: "db-1" }, { id: "mcp-call" })] : []),
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
        { model, streamFn: (m, context, options) => faux.provider.streamSimple(m, context, options) },
        run,
      );
      const events = [];
      for await (const event of factory({ task: run.task }).messages()) {
        if (event.kind === "tool_use" || event.kind === "tool_result") events.push(event);
      }
      expect(names).toEqual([hasProject ? ["item_patch", "mcp_search"] : ["item_patch"]]);
      expect(events).toHaveLength(hasProject ? 4 : 2);
      for (const kind of ["tool_use", "tool_result"]) {
        expect(events.find((event) => event.kind === kind && event.name === "item_patch")).toMatchObject({
          operation: "item.patch",
          targetItemId: "item-1",
        });
        const mcp = events.find((event) => event.kind === kind && event.name === "mcp_search");
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

describe("agent-only approval reason (issue #1420)", () => {
  const run: AgentRunRow = {
    id: "run-1",
    projectItemId: null,
    parentRunId: null,
    heartbeatId: null,
    triggeredBy: "user",
    unit: "invocation",
    task: "run",
    status: "running",
    result: null,
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
        { model: faux.getModel(), streamFn: (m, context, options) => faux.provider.streamSimple(m, context, options) },
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
    expect(fixtures.calls).toEqual([["run-1", { itemId: "item-1" }, { reason: "You never open it." }]]);
  });

  it("passes no options when the model gave no reason", async () => {
    await runCalls({ itemId: "item-1" });
    expect(fixtures.calls).toEqual([["run-1", { itemId: "item-1" }, undefined]]);
  });

  it("rejects a reason over 500 characters without calling the operation", async () => {
    const { results } = await runCalls({ itemId: "item-1", reason: "x".repeat(501) });
    expect(fixtures.calls).toEqual([]);
    expect(results.join()).toMatch(/reason/);
  });
});

describe("agent language instruction (issue #1388)", () => {
  const CS = "Answer and write all user-visible text in Czech.";
  const EN = "Answer and write all user-visible text in English.";

  async function composedPrompt(locale: string | null, projectItemId: string | null = null): Promise<string> {
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
      triggeredBy: "user",
      unit: "invocation",
      task: "run",
      status: "running",
      result: null,
      startedAt: "2026-10-27T00:00:00Z",
      finishedAt: null,
      actorUserId: "user-1",
    };
    try {
      const factory = await createAgentSessionFactoryForRun(
        pool,
        new ModuleRegistry(() => new Set<string>()),
        { model: faux.getModel(), streamFn: (m, context, options) => faux.provider.streamSimple(m, context, options) },
        run,
      );
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
});

describe("MCP failure classification in the tool result (issue #1444)", () => {
  const run: AgentRunRow = {
    id: "run-1",
    projectItemId: "project-1",
    parentRunId: null,
    heartbeatId: null,
    triggeredBy: "user",
    unit: "invocation",
    task: "run",
    status: "running",
    result: null,
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
      fauxAssistantMessage([fauxToolCall("mcp_search", args as Record<string, unknown>, { id: "call" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("done"),
    ]);
    try {
      const factory = await createAgentSessionFactoryForRun(
        pool,
        new ModuleRegistry(() => new Set<string>()),
        { model: faux.getModel(), streamFn: (m, context, options) => faux.provider.streamSimple(m, context, options) },
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

  it("carries none of the classification keys for a successful call", async () => {
    expect(await mcpToolResultDetails({ result: "found", error: false })).toEqual({ error: false });
  });
});
