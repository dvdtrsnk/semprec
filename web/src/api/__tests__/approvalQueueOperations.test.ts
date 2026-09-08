import { describe, expect, it } from "vitest";
import { OperationError } from "../genericOperations.js";
import { createApprovalQueueOperations } from "../approvalQueueOperations.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function makeRawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "req-1",
    toolName: "send_email",
    riskClass: "high",
    requestedAt: "2026-09-01T12:00:00.000Z",
    safeSummary: { mcpToolRegistrationId: "reg-1", mcpServerItemId: "server-1", argKeys: ["to"] },
    agentRunId: "run-1",
    projectItemId: "project-1",
    projectName: "Acme project",
    ...overrides,
  };
}

describe("approval queue operations", () => {
  it("lists rows and parses them", async () => {
    const operations = createApprovalQueueOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse({ rows: [makeRawRow()] }),
    });

    const entries = await operations.listApprovalRequests();

    expect(entries).toEqual([{ kind: "ok", row: makeRawRow() }]);
  });

  it("degrades a single malformed row to a placeholder, keeping the rest of the list", async () => {
    const operations = createApprovalQueueOperations({
      baseUrl: "/api",
      fetchImpl: async () =>
        jsonResponse({ rows: [{ id: "bad-1", toolName: 42 }, makeRawRow({ id: "req-2" })] }),
    });

    const entries = await operations.listApprovalRequests();

    expect(entries[0]).toEqual({ kind: "malformed", row: { id: "bad-1", raw: { id: "bad-1", toolName: 42 } } });
    expect(entries[1]).toMatchObject({ kind: "ok", row: { id: "req-2" } });
  });

  it("extracts a null id when a malformed row's id itself isn't a string", async () => {
    const operations = createApprovalQueueOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse({ rows: [{ id: 123 }] }),
    });

    const entries = await operations.listApprovalRequests();

    expect(entries).toEqual([{ kind: "malformed", row: { id: null, raw: { id: 123 } } }]);
  });

  it("sends a decision as a PATCH and validates the response", async () => {
    const calls: Array<{ url: string; method?: string; body: unknown }> = [];
    const operations = createApprovalQueueOperations({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
        return jsonResponse({ id: "req-1", status: "approved", decidedAt: "2026-09-01T12:05:00.000Z", decidedBy: "user-1" });
      },
    });

    const result = await operations.decideApprovalRequest({
      approvalRequestId: "req-1",
      decision: "approved",
      decidedByUserId: "user-1",
    });

    expect(calls[0]).toMatchObject({
      url: "/api/approval-requests/req-1",
      method: "PATCH",
      body: { decision: "approved", decidedByUserId: "user-1" },
    });
    expect(result).toEqual({ id: "req-1", status: "approved", decidedAt: "2026-09-01T12:05:00.000Z", decidedBy: "user-1" });
  });

  it("classifies a forbidden or missing resource as unavailable and a server error as retryable", async () => {
    const withStatus = (status: number) =>
      createApprovalQueueOperations({ baseUrl: "/api", fetchImpl: async () => jsonResponse({}, status) }).listApprovalRequests();

    await expect(withStatus(403)).rejects.toMatchObject({ kind: "unavailable" });
    await expect(withStatus(500)).rejects.toMatchObject({ kind: "retryable" });
  });

  it("classifies a transport failure as retryable", async () => {
    const operations = createApprovalQueueOperations({
      baseUrl: "/api",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    await expect(operations.listApprovalRequests()).rejects.toBeInstanceOf(OperationError);
    await expect(operations.listApprovalRequests()).rejects.toMatchObject({ kind: "retryable" });
  });
});
