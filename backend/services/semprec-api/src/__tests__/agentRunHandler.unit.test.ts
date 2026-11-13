import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Client, Pool } from "pg";
import type { AgentRunRow } from "@semprec/data";
import { createAgentRunRequestListener } from "../agentRunHandler.js";
import type { authenticateRequest } from "../authHandler.js";

const ids = vi.hoisted(() => ({
  sessionUser: "11111111-1111-4111-8111-111111111111",
  otherUser: "22222222-2222-4222-8222-222222222222",
  tenant: "33333333-3333-4333-8333-333333333333",
  run: "44444444-4444-4444-8444-444444444444",
}));

/** What the mocked session and data layer answer, how often the detail was read and what the usage was read with. */
const fixtures = vi.hoisted(() => ({
  run: null as AgentRunRow | null,
  locale: "cs",
  detailReads: 0,
  usageReads: [] as { runId: string; locale: string }[],
}));

const DETAIL = {
  title: "forged",
  projectName: null,
  heartbeatName: null,
  durationMs: null,
  trigger: { kind: "user" as const, threadId: null, mcpClientName: null },
  approvals: { count: 0, pending: 0, approved: 0, rejected: 0, requestIds: [] },
};

const USAGE = { totalCostUsd: 0, estimated: false, perModel: [] };

vi.mock("../authHandler.js", () => {
  const identity = (): Awaited<ReturnType<typeof authenticateRequest>> => ({
    tenantId: ids.tenant,
    role: "member",
    user: {
      id: ids.sessionUser,
      email: "session@example.test",
      displayName: null,
      locale: fixtures.locale,
      createdAt: "2026-11-01T00:00:00.000Z",
    },
    session: {
      id: "55555555-5555-4555-8555-555555555555",
      userId: ids.sessionUser,
      tokenHash: "unused",
      platform: "ios",
      createdAt: "2026-11-01T00:00:00.000Z",
      lastSeenAt: "2026-11-01T00:00:00.000Z",
      expiresAt: "2026-12-01T00:00:00.000Z",
      userAgent: null,
      revokedAt: null,
      deviceId: null,
      deviceName: null,
      deviceKind: null,
      osVersion: null,
      appVersion: null,
    },
  });
  return { authenticateRequest: async () => identity() };
});

vi.mock("@semprec/data", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@semprec/data")>()),
  withTransaction: async (_pool: Pool, fn: (client: Client) => Promise<unknown>) => fn(new Client()),
  getAgentRun: async () => fixtures.run,
  getAgentRunDetail: async () => {
    fixtures.detailReads += 1;
    return DETAIL;
  },
  getAgentRunUsage: async (_client: Client, runId: string, locale: string) => {
    fixtures.usageReads.push({ runId, locale });
    return USAGE;
  },
}));

/** A row as `getAgentRun` returns it, forged with the given actor: no database holds it. */
function forgedRun(actorUserId: string): AgentRunRow {
  return {
    id: ids.run,
    projectItemId: null,
    parentRunId: null,
    heartbeatId: null,
    retryOfRunId: null,
    attempt: 1,
    heartbeatOccurrenceId: null,
    threadId: null,
    mcpClientName: null,
    triggeredBy: "user",
    unit: "invocation",
    task: "forged",
    status: "running",
    result: null,
    errorCode: null,
    errorDetail: null,
    startedAt: "2026-11-01T00:00:00.000Z",
    finishedAt: null,
    actorUserId,
  };
}

describe("GET /api/agent-runs/:id actor check (issue #1805) and usage locale (issue #1822)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    fixtures.run = null;
    fixtures.locale = "cs";
    fixtures.detailReads = 0;
    fixtures.usageReads = [];
    server = createServer(createAgentRunRequestListener(new Pool()));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function read(): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`${baseUrl}/api/agent-runs/${ids.run}`);
    return { status: res.status, body: await res.json() };
  }

  it("answers a run of another actor with the 404 of an unknown id and reads neither detail nor usage", async () => {
    fixtures.run = forgedRun(ids.otherUser);
    const otherActor = await read();
    fixtures.run = null;
    const unknown = await read();

    expect(otherActor).toEqual({ status: 404, body: { error: "Not found" } });
    expect(unknown).toEqual(otherActor);
    expect(fixtures.detailReads).toBe(0);
    expect(fixtures.usageReads).toEqual([]);
  });

  it("answers the session user's own run with its row, detail, error fields and usage", async () => {
    fixtures.run = forgedRun(ids.sessionUser);

    const own = await read();

    expect(own).toEqual({
      status: 200,
      body: { ...forgedRun(ids.sessionUser), ...DETAIL, errorCode: null, errorSummary: null, usage: USAGE },
    });
    expect(fixtures.detailReads).toBe(1);
    expect(fixtures.usageReads).toEqual([{ runId: ids.run, locale: "cs" }]);
  });

  it("reads the usage in English for a session user whose locale has no catalog (issue #1822)", async () => {
    fixtures.run = forgedRun(ids.sessionUser);
    fixtures.locale = "de";

    const own = await read();

    expect(own.status).toBe(200);
    expect(fixtures.usageReads).toEqual([{ runId: ids.run, locale: "en" }]);
  });
});
