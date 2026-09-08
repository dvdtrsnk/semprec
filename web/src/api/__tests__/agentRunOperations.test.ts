import { describe, expect, it } from "vitest";
import { OperationError } from "../genericOperations.js";
import { createAgentRunOperations } from "../agentRunOperations.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeRawRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "run-1",
    projectItemId: "project-1",
    parentRunId: null,
    heartbeatId: null,
    triggeredBy: "user",
    unit: "invocation",
    task: "search the docs",
    status: "running",
    result: null,
    startedAt: "2026-09-01T12:00:00.000Z",
    finishedAt: null,
    ...overrides,
  };
}

describe("agent run operations", () => {
  it("fetches and parses an agent run", async () => {
    const calls: string[] = [];
    const operations = createAgentRunOperations({
      baseUrl: "/api",
      fetchImpl: async (input) => {
        calls.push(String(input));
        return jsonResponse(makeRawRun());
      },
    });

    const run = await operations.getAgentRun("run-1");

    expect(calls[0]).toBe("/api/agent-runs/run-1");
    expect(run).toEqual(makeRawRun());
  });

  it("returns null for an unknown agent run id", async () => {
    const operations = createAgentRunOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse({}, 404),
    });

    await expect(operations.getAgentRun("missing")).resolves.toBeNull();
  });

  it("classifies a forbidden response as unavailable and a server error as retryable", async () => {
    const withStatus = (status: number) =>
      createAgentRunOperations({
        baseUrl: "/api",
        fetchImpl: async () => jsonResponse({}, status),
      }).getAgentRun("run-1");

    await expect(withStatus(403)).rejects.toMatchObject({ kind: "unavailable" });
    await expect(withStatus(500)).rejects.toMatchObject({ kind: "retryable" });
  });

  it("classifies a transport failure as retryable", async () => {
    const operations = createAgentRunOperations({
      baseUrl: "/api",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    await expect(operations.getAgentRun("run-1")).rejects.toBeInstanceOf(OperationError);
    await expect(operations.getAgentRun("run-1")).rejects.toMatchObject({ kind: "retryable" });
  });
});
