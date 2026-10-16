import { describe, expect, it, vi, afterEach } from "vitest";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { withUniqueNames } from "../agentSessionComposition.js";
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
