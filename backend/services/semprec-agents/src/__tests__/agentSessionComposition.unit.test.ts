import { describe, expect, it, vi, afterEach } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Pool, Client } from "pg";
import { ModuleRegistry } from "@semprec/module-registry";
import type { AgentRunRow, McpToolGrantForProject } from "@semprec/data";
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

const fixtures = vi.hoisted(() => ({ grants: [] as McpToolGrantForProject[] }));
vi.mock("@semprec/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@semprec/data")>()),
  withClient: async (_pool: Pool, fn: (client: Client) => Promise<unknown>) => fn(new Client()),
  listMcpToolGrantsForProject: async () => fixtures.grants,
}));
vi.mock("@semprec/agent-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@semprec/agent-runtime")>()),
  listGrantedGenericOperationAgentTools: async () => ["item.patch"],
  createGenericOperationAgentTools: () => ({ "item.patch": async () => ({ result: "patched", error: false }) }),
  createApprovalGatedMcpInvokeTool: () => async () => ({ result: "found", error: false }),
  createProjectAgentGuidanceSystemPromptOverride: async () => (prompt: string) => prompt,
}));

function grant(registration: string, server: string, granted = true): McpToolGrantForProject {
  return {
    mcpToolRegistrationId: registration,
    mcpServerItemId: server,
    mcpServerName: `${server} name`,
    toolName: "search",
    description: null,
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
