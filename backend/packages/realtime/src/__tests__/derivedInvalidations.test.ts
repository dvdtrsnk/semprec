import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { WebSocket, type RawData } from "ws";
import {
  createAgentRun,
  createPendingApprovalRequest,
  createUser,
  decideAndEnqueueApprovalRequest,
  finishAgentRun,
  hashPassword,
  raiseProblem,
  resolveProblem,
  setInvalidationHook,
  setProjectMcpGrantForAgentPage,
  upsertMcpToolRegistration,
  withTransaction,
} from "@semprec/data";
import {
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  tenantForNextTestUser,
} from "@semprec/data/testSupport";
import { runInTenant } from "@semprec/shared";
import { publishRealtimeMessage } from "../pgNotifyPublisher.js";
import { createSyncServer, type SyncIdentity, type SyncServer } from "../syncServer.js";
import { wireRealtimeHooks } from "../wireHooks.js";

const { realtimeWarn } = vi.hoisted(() => ({ realtimeWarn: vi.fn() }));

// Only the realtime package's own logger is replaced so its warnings can be asserted.
vi.mock("@semprec/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/shared")>();
  return {
    ...actual,
    createLogger: (name: string) =>
      name === "realtime" ? ({ warn: realtimeWarn, error: vi.fn() } as never) : actual.createLogger(name),
  };
});

let pool: Pool;

afterAll(async () => {
  await pool?.end();
});

function messageText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil: condition never became true");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Hand-publishes an envelope, as a foreign or misbehaving publisher could. */
async function notifyEnvelope(tenantId: string, message: unknown): Promise<void> {
  await pool.query("SELECT pg_notify($1, $2)", ["semprec_events", JSON.stringify({ tenantId, message })]);
}

/** The frames one socket received, parsed. */
interface Inbox {
  frames: Array<Record<string, unknown>>;
}

describe("derived realtime invalidations (issues #1863, #1866, #1868)", () => {
  let httpServer: Server;
  let syncServer: SyncServer;
  let port: number;
  let identityByToken: Map<string, SyncIdentity>;
  let sockets: WebSocket[];

  async function createTestUser(): Promise<string> {
    const user = await createUser(pool, {
      email: `derived-${Math.random()}@example.test`,
      passwordHash: await hashPassword("s3cret-password"),
      locale: "en",
      tenantId: await tenantForNextTestUser(pool),
    });
    return user.id;
  }

  /** Opens a socket for `identity` and records every frame it receives. */
  async function connect(token: string, identity: SyncIdentity): Promise<Inbox> {
    identityByToken.set(token, identity);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=${token}`);
    sockets.push(socket);
    const inbox: Inbox = { frames: [] };
    socket.on("message", (data) => inbox.frames.push(JSON.parse(messageText(data)) as Record<string, unknown>));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return inbox;
  }

  /** Lets frames that were going to arrive arrive, so an absence can be asserted. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    identityByToken = new Map();
    sockets = [];
    realtimeWarn.mockClear();
    syncServer = await createSyncServer(pool, {
      authenticate: async (req: IncomingMessage) => {
        const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        return token ? (identityByToken.get(token) ?? null) : null;
      },
      revalidateSession: async () => true,
      heartbeatIntervalMs: 30_000,
    });
    httpServer = createServer();
    httpServer.on("upgrade", (req, socket, head) => syncServer.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const address = httpServer.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    port = address.port;
  });

  afterEach(async () => {
    setInvalidationHook(() => {});
    for (const socket of sockets) socket.close();
    await syncServer.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  describe("agentRuns scope (issue #1863)", () => {
    /**
     * Three sockets: the run's actor (tenant zero's user), another user of the same tenant, and a socket of
     * another tenant that carries the actor's user id. Only the first may receive the run's frames.
     */
    async function connectActorPeerAndForeign() {
      const actorId = await createTestUser();
      const peerId = await createTestUser();
      const otherTenant = await createTestTenant(pool);
      return {
        actorId,
        actor: await connect("actor", { tenantId: getTenantZeroId(), userId: actorId, sessionId: "session-actor" }),
        peer: await connect("peer", { tenantId: getTenantZeroId(), userId: peerId, sessionId: "session-peer" }),
        foreign: await connect("foreign", { tenantId: otherTenant, userId: actorId, sessionId: "session-foreign" }),
      };
    }

    it("sends a created run and a run closed as done to the actor's sockets only, carrying the two ids and nothing else", async () => {
      const { actor, peer, foreign } = await connectActorPeerAndForeign();
      const projectItemId = await runInTenant(getTenantZeroId(), () => createTestProjectItem(pool));
      wireRealtimeHooks(pool);

      const run = await runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, (client) =>
          createAgentRun(client, { triggeredBy: "user", task: "private task text", projectItemId }),
        ),
      );
      await waitUntil(() => actor.frames.length >= 1);
      await runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, (client) => finishAgentRun(client, run.id, "done", "private result text")),
      );
      await waitUntil(() => actor.frames.length >= 2);
      await settle();

      const expected = { type: "invalidate", scope: "agentRuns", projectItemId, agentRunId: run.id };
      expect(actor.frames).toEqual([expected, expected]);
      expect(peer.frames).toEqual([]);
      expect(foreign.frames).toEqual([]);
    });

    it("sends a run closed as error to the actor, with a null project for a run without one", async () => {
      const { actor, peer } = await connectActorPeerAndForeign();
      wireRealtimeHooks(pool);

      const run = await runInTenant(getTenantZeroId(), () => createAgentRun(pool, { triggeredBy: "user", task: "x" }));
      await waitUntil(() => actor.frames.length >= 1);
      await runInTenant(getTenantZeroId(), () => finishAgentRun(pool, run.id, "error", "interrupted"));
      await waitUntil(() => actor.frames.length >= 2);
      await settle();

      const expected = { type: "invalidate", scope: "agentRuns", projectItemId: null, agentRunId: run.id };
      expect(actor.frames).toEqual([expected, expected]);
      expect(peer.frames).toEqual([]);
    });

    it("sends nothing when the transaction that created the run rolls back, and then still sends a committed one", async () => {
      const { actor } = await connectActorPeerAndForeign();
      wireRealtimeHooks(pool);

      await expect(
        runInTenant(getTenantZeroId(), () =>
          withTransaction(pool, async (client) => {
            await createAgentRun(client, { triggeredBy: "user", task: "rolled back" });
            throw new Error("force rollback");
          }),
        ),
      ).rejects.toThrow("force rollback");
      const committed = await runInTenant(getTenantZeroId(), () =>
        createAgentRun(pool, { triggeredBy: "user", task: "committed" }),
      );
      await waitUntil(() => actor.frames.length >= 1);
      await settle();

      expect(actor.frames).toEqual([
        { type: "invalidate", scope: "agentRuns", projectItemId: null, agentRunId: committed.id },
      ]);
    });

    it("sends the web decision of an approval request to the actor as an agentRuns frame for the run and its project", async () => {
      const { actor, actorId, peer, foreign } = await connectActorPeerAndForeign();
      const projectItemId = await runInTenant(getTenantZeroId(), () => createTestProjectItem(pool));
      const run = await runInTenant(getTenantZeroId(), () =>
        createAgentRun(pool, { triggeredBy: "user", task: "needs approval", projectItemId }),
      );
      const request = await runInTenant(getTenantZeroId(), () =>
        createPendingApprovalRequest(pool, {
          agentRunId: run.id,
          toolName: "search",
          riskClass: "write",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        }),
      );
      wireRealtimeHooks(pool);

      const decided = await runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: request.id,
            decision: "approved",
            decidedByUserId: actorId,
          }),
        ),
      );
      expect(decided?.outcome).toBe("decided");
      await waitUntil(() => actor.frames.length >= 2);
      await settle();

      expect(actor.frames).toHaveLength(2);
      expect(actor.frames).toContainEqual({
        type: "invalidate",
        scope: "approvalRequest",
        approvalRequestId: request.id,
      });
      expect(actor.frames).toContainEqual({
        type: "invalidate",
        scope: "agentRuns",
        projectItemId,
        agentRunId: run.id,
      });
      expect(peer.frames).toEqual([]);
      expect(foreign.frames).toEqual([]);
    });

    it("sends nothing for a decision whose transaction rolls back", async () => {
      const { actor, actorId } = await connectActorPeerAndForeign();
      const run = await runInTenant(getTenantZeroId(), () => createAgentRun(pool, { triggeredBy: "user", task: "x" }));
      const request = await runInTenant(getTenantZeroId(), () =>
        createPendingApprovalRequest(pool, {
          agentRunId: run.id,
          toolName: "search",
          riskClass: "write",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        }),
      );
      wireRealtimeHooks(pool);

      await expect(
        runInTenant(getTenantZeroId(), () =>
          withTransaction(pool, async (client) => {
            await decideAndEnqueueApprovalRequest(client, {
              approvalRequestId: request.id,
              decision: "rejected",
              decidedByUserId: actorId,
            });
            throw new Error("force rollback");
          }),
        ),
      ).rejects.toThrow("force rollback");
      await settle();

      expect(actor.frames).toEqual([]);
    });

    it("drops a message with a malformed id, with a malformed project id or with a malformed user id before any socket", async () => {
      const { actor, actorId } = await connectActorPeerAndForeign();
      const valid = { type: "invalidation", scope: "agentRuns", projectItemId: randomUUID(), agentRunId: randomUUID() };

      for (const malformed of [
        { agentRunId: "not-a-uuid" },
        { agentRunId: undefined },
        { agentRunId: 7 },
        { projectItemId: "not-a-uuid" },
        { projectItemId: undefined },
        { userId: "not-a-uuid" },
      ]) {
        await notifyEnvelope(getTenantZeroId(), { ...valid, userId: actorId, ...malformed });
      }
      // A valid message behind the malformed ones proves they were handled first and sent nothing.
      await notifyEnvelope(getTenantZeroId(), { ...valid, userId: actorId });
      await waitUntil(() => actor.frames.length >= 1);
      await settle();

      expect(actor.frames).toEqual([
        { type: "invalidate", scope: "agentRuns", projectItemId: valid.projectItemId, agentRunId: valid.agentRunId },
      ]);
    });

    it("drops a message that names no actor instead of widening it to the tenant", async () => {
      const { actor, peer } = await connectActorPeerAndForeign();
      await publishRealtimeMessage(pool, {
        type: "invalidation",
        scope: "agentRuns",
        projectItemId: null,
        agentRunId: randomUUID(),
      });
      await vi.waitFor(() =>
        expect(realtimeWarn).toHaveBeenCalledWith(
          { type: "invalidation", scope: "agentRuns" },
          "realtime_agent_runs_without_user",
        ),
      );
      await settle();

      expect(actor.frames).toEqual([]);
      expect(peer.frames).toEqual([]);
    });
  });

  describe("projectAgent scope (issue #1866)", () => {
    /** Two sockets of tenant zero (two users) and a socket of another tenant. */
    async function connectTenantTwoUsersAndForeign() {
      const firstId = await createTestUser();
      const secondId = await createTestUser();
      const otherTenant = await createTestTenant(pool);
      return {
        first: await connect("first", { tenantId: getTenantZeroId(), userId: firstId, sessionId: "session-first" }),
        second: await connect("second", { tenantId: getTenantZeroId(), userId: secondId, sessionId: "session-second" }),
        foreign: await connect("foreign", { tenantId: otherTenant, userId: firstId, sessionId: "session-foreign" }),
      };
    }

    async function grantTool(projectItemId: string, granted: boolean, rollBack = false): Promise<void> {
      const registration = await upsertMcpToolRegistration(pool, {
        mcpServerItemId: randomUUID(),
        toolName: "search_web",
        toolSchema: {},
      });
      await runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, async (client) => {
          await setProjectMcpGrantForAgentPage(client, {
            projectItemId,
            mcpToolRegistrationId: registration.id,
            granted,
          });
          if (rollBack) throw new Error("force rollback");
        }),
      );
    }

    it("sends a committed change of a project's agent setup to every socket of the tenant and to no other tenant's socket", async () => {
      const { first, second, foreign } = await connectTenantTwoUsersAndForeign();
      const projectItemId = await runInTenant(getTenantZeroId(), () => createTestProjectItem(pool));
      wireRealtimeHooks(pool);

      await grantTool(projectItemId, true);
      await waitUntil(() => first.frames.length >= 1 && second.frames.length >= 1);
      await settle();

      const expected = { type: "invalidate", scope: "projectAgent", projectItemId };
      expect(first.frames).toEqual([expected]);
      expect(second.frames).toEqual([expected]);
      expect(foreign.frames).toEqual([]);
    });

    it("sends nothing when the transaction that changed the setup rolls back, and still sends a committed one", async () => {
      const { first } = await connectTenantTwoUsersAndForeign();
      const projectItemId = await runInTenant(getTenantZeroId(), () => createTestProjectItem(pool));
      wireRealtimeHooks(pool);

      await expect(grantTool(projectItemId, true, true)).rejects.toThrow("force rollback");
      await grantTool(projectItemId, false);
      await waitUntil(() => first.frames.length >= 1);
      await settle();

      expect(first.frames).toEqual([{ type: "invalidate", scope: "projectAgent", projectItemId }]);
    });

    it("reaches every socket of the tenant even when a message names a user", async () => {
      const { first, second } = await connectTenantTwoUsersAndForeign();
      const projectItemId = randomUUID();

      await notifyEnvelope(getTenantZeroId(), {
        type: "invalidation",
        scope: "projectAgent",
        projectItemId,
        userId: randomUUID(),
      });
      await waitUntil(() => first.frames.length >= 1 && second.frames.length >= 1);
      await settle();

      const expected = { type: "invalidate", scope: "projectAgent", projectItemId };
      expect(first.frames).toEqual([expected]);
      expect(second.frames).toEqual([expected]);
    });

    it("drops a message with a malformed project id before any socket", async () => {
      const { first } = await connectTenantTwoUsersAndForeign();
      const valid = { type: "invalidation", scope: "projectAgent", projectItemId: randomUUID() };

      for (const malformed of [
        { projectItemId: "not-a-uuid" },
        { projectItemId: "" },
        { projectItemId: undefined },
        { projectItemId: null },
        { projectItemId: 7 },
      ]) {
        await notifyEnvelope(getTenantZeroId(), { ...valid, ...malformed });
      }
      // A valid message behind the malformed ones proves they were handled first and sent nothing.
      await notifyEnvelope(getTenantZeroId(), valid);
      await waitUntil(() => first.frames.length >= 1);
      await settle();

      expect(first.frames).toEqual([{ type: "invalidate", scope: "projectAgent", projectItemId: valid.projectItemId }]);
    });
  });

  describe("sempStatus scope (issue #1868)", () => {
    /** Two sockets of tenant zero (two users) and a socket of another tenant. */
    async function connectTenantTwoUsersAndForeign() {
      const firstId = await createTestUser();
      const secondId = await createTestUser();
      const otherTenant = await createTestTenant(pool);
      return {
        userId: firstId,
        first: await connect("first", { tenantId: getTenantZeroId(), userId: firstId, sessionId: "session-first" }),
        second: await connect("second", { tenantId: getTenantZeroId(), userId: secondId, sessionId: "session-second" }),
        foreign: await connect("foreign", { tenantId: otherTenant, userId: firstId, sessionId: "session-foreign" }),
      };
    }

    /** The frames of the sempStatus scope a socket received (the problem also writes a notification, which is not one). */
    const statusFrames = (inbox: Inbox) => inbox.frames.filter((frame) => frame.scope === "sempStatus");

    const raiseInTenantZero = (userId: string, rollBack = false) =>
      runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, async (client) => {
          await raiseProblem(client, {
            userId,
            category: "mail",
            kind: "mailSyncFailed",
            severity: "warning",
            sourceTable: "mail_account_sync_state",
            sourceId: randomUUID(),
            dedupeKey: "mail:sync:private-mailbox-name",
          });
          if (rollBack) throw new Error("force rollback");
        }),
      );

    it("sends a raised and a resolved problem to every socket of the tenant, with no field but the scope, and to no other tenant's socket", async () => {
      const { userId, first, second, foreign } = await connectTenantTwoUsersAndForeign();
      wireRealtimeHooks(pool);

      await raiseInTenantZero(userId);
      await waitUntil(() => statusFrames(first).length >= 1 && statusFrames(second).length >= 1);
      await runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, (client) =>
          resolveProblem(client, { dedupeKey: "mail:sync:private-mailbox-name", resolutionKind: "recovered" }),
        ),
      );
      await waitUntil(() => statusFrames(first).length >= 2 && statusFrames(second).length >= 2);
      await settle();

      const expected = { type: "invalidate", scope: "sempStatus" };
      expect(statusFrames(first)).toEqual([expected, expected]);
      expect(statusFrames(second)).toEqual([expected, expected]);
      expect(foreign.frames).toEqual([]);
    });

    it("sends nothing when the transaction that raised the problem rolls back", async () => {
      const { userId, first } = await connectTenantTwoUsersAndForeign();
      wireRealtimeHooks(pool);

      await expect(raiseInTenantZero(userId, true)).rejects.toThrow("force rollback");
      await settle();

      expect(first.frames).toEqual([]);
    });

    it("sends the frame of a message that carries more than its scope without the extra fields", async () => {
      const { first } = await connectTenantTwoUsersAndForeign();

      await notifyEnvelope(getTenantZeroId(), {
        type: "invalidation",
        scope: "sempStatus",
        userId: randomUUID(),
        title: "private problem text",
      });
      await waitUntil(() => first.frames.length >= 1);
      await settle();

      expect(first.frames).toEqual([{ type: "invalidate", scope: "sempStatus" }]);
    });
  });
});
