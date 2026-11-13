import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { WebSocket, type RawData } from "ws";
import {
  createAgentRun,
  createChokePoint,
  createPendingApprovalRequest,
  createTasksDayRolloverAction,
  createPendingApprovalRequestAndPublish,
  createUser,
  decideAndEnqueueApprovalRequest,
  finishAgentRun,
  hashPassword,
  patchNotificationPreferences,
  provisionTenant,
  publishAccountInvalidation,
  raiseProblem,
  resolveProblem,
  seedSystem,
  setInvalidationHook,
  setProjectMcpGrantForAgentPage,
  syncMcpServerTools,
  updateItemWithClient,
  upsertMcpToolRegistration,
  withTransaction,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  tenantForNextTestUser,
} from "@semprec/data/testSupport";
import { allowLoopbackOutboundForTests, startHttpContractServer } from "@semprec/data/testSupport/mcpContractServers";
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

describe("derived realtime invalidations (issues #1863, #1866, #1868, #1918, #1946, #1951, #2025)", () => {
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
      await waitUntil(() => actor.frames.length >= 3);
      await settle();

      expect(actor.frames).toHaveLength(3);
      expect(actor.frames).toContainEqual({
        type: "invalidate",
        scope: "approvalRequest",
        approvalRequestId: request.id,
      });
      // The decision also changes the actor's pending-decision count (issue #1918).
      expect(actor.frames).toContainEqual({ type: "invalidate", scope: "badgeCounts" });
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
  describe("notificationPreferences and badgeCounts scopes (issue #1918)", () => {
    /** Two sockets of one user (two devices), another user of the same tenant, and a socket of another tenant with that user's id. */
    async function connectOwnerPeerAndForeign() {
      const ownerId = await createTestUser();
      const peerId = await createTestUser();
      const otherTenant = await createTestTenant(pool);
      return {
        ownerId,
        phone: await connect("phone", { tenantId: getTenantZeroId(), userId: ownerId, sessionId: "session-phone" }),
        laptop: await connect("laptop", { tenantId: getTenantZeroId(), userId: ownerId, sessionId: "session-laptop" }),
        peer: await connect("peer", { tenantId: getTenantZeroId(), userId: peerId, sessionId: "session-peer" }),
        foreign: await connect("foreign", { tenantId: otherTenant, userId: ownerId, sessionId: "session-foreign" }),
      };
    }

    const framesOf = (inbox: Inbox, scope: string) => inbox.frames.filter((frame) => frame.scope === scope);

    const patchPreferences = (
      userId: string,
      patch: Parameters<typeof patchNotificationPreferences>[2],
      rollBack = false,
    ) =>
      runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, async (client) => {
          await patchNotificationPreferences(client, userId, patch);
          if (rollBack) throw new Error("force rollback");
        }),
      );

    /** A pending approval request on a new run whose actor is `userId`, created without announcing anything. */
    async function createRequestFor(userId: string, toolCallId: string | null = null) {
      const run = await runInTenant(getTenantZeroId(), () =>
        createAgentRun(pool, { triggeredBy: "user", task: "needs approval", userId }),
      );
      const input = {
        agentRunId: run.id,
        toolName: "search",
        riskClass: "write",
        toolCallId,
        payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
        resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
      } as const;
      const request = await runInTenant(getTenantZeroId(), () => createPendingApprovalRequest(pool, input));
      return { run, input, request };
    }

    const createAndPublish = (input: Parameters<typeof createPendingApprovalRequestAndPublish>[1], rollBack = false) =>
      runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, async (client) => {
          const request = await createPendingApprovalRequestAndPublish(client, input);
          if (rollBack) throw new Error("force rollback");
          return request;
        }),
      );

    const decide = (approvalRequestId: string, decidedByUserId: string, rollBack = false) =>
      runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, async (client) => {
          const decided = await decideAndEnqueueApprovalRequest(client, {
            approvalRequestId,
            decision: "rejected",
            decidedByUserId,
          });
          if (rollBack) throw new Error("force rollback");
          return decided;
        }),
      );

    it("sends a committed preference change to every socket of that user only, with no field but the scope", async () => {
      const { ownerId, phone, laptop, peer, foreign } = await connectOwnerPeerAndForeign();
      wireRealtimeHooks(pool);

      await patchPreferences(ownerId, { reminders: false, problemsLevel: "all" });
      await waitUntil(() => phone.frames.length >= 1 && laptop.frames.length >= 1);
      await settle();

      const expected = { type: "invalidate", scope: "notificationPreferences" };
      expect(phone.frames).toEqual([expected]);
      expect(laptop.frames).toEqual([expected]);
      expect(peer.frames).toEqual([]);
      expect(foreign.frames).toEqual([]);
    });

    it("sends nothing when the preference change rolls back or the patch has no field, and still sends a committed change", async () => {
      const { ownerId, phone } = await connectOwnerPeerAndForeign();
      wireRealtimeHooks(pool);

      await expect(patchPreferences(ownerId, { reminders: false }, true)).rejects.toThrow("force rollback");
      await patchPreferences(ownerId, {});
      await settle();
      expect(phone.frames).toEqual([]);

      await patchPreferences(ownerId, { badgeInbox: true });
      await waitUntil(() => phone.frames.length >= 1);
      await settle();

      expect(phone.frames).toEqual([{ type: "invalidate", scope: "notificationPreferences" }]);
    });

    it("sends the badge count change of a created request to the owner's sockets only, once, with no field but the scope", async () => {
      const { ownerId, phone, laptop, peer, foreign } = await connectOwnerPeerAndForeign();
      const { input } = await createRequestFor(ownerId, "tool-call-created");
      const second = await createRequestFor(ownerId);
      wireRealtimeHooks(pool);

      // The first call inserts a new row: one announcement. The same tool call again returns the existing row.
      await createAndPublish({ ...second.input, toolCallId: "tool-call-new" });
      await createAndPublish(input);
      await waitUntil(() => framesOf(phone, "badgeCounts").length >= 1 && framesOf(laptop, "badgeCounts").length >= 1);
      await settle();

      expect(framesOf(phone, "badgeCounts")).toEqual([{ type: "invalidate", scope: "badgeCounts" }]);
      expect(framesOf(laptop, "badgeCounts")).toEqual([{ type: "invalidate", scope: "badgeCounts" }]);
      expect(framesOf(peer, "badgeCounts")).toEqual([]);
      expect(foreign.frames).toEqual([]);
    });

    it("sends the badge count change of a decision to the owner's sockets only, and nothing for a decision that rolls back or finds the request already decided", async () => {
      const { ownerId, phone, peer, foreign } = await connectOwnerPeerAndForeign();
      const { request } = await createRequestFor(ownerId);
      wireRealtimeHooks(pool);

      await expect(decide(request.id, ownerId, true)).rejects.toThrow("force rollback");
      await settle();
      expect(framesOf(phone, "badgeCounts")).toEqual([]);

      expect((await decide(request.id, ownerId))?.outcome).toBe("decided");
      await waitUntil(() => framesOf(phone, "badgeCounts").length >= 1);
      expect((await decide(request.id, ownerId))?.outcome).toBe("unchanged");
      await settle();

      expect(framesOf(phone, "badgeCounts")).toEqual([{ type: "invalidate", scope: "badgeCounts" }]);
      expect(framesOf(peer, "badgeCounts")).toEqual([]);
      expect(foreign.frames).toEqual([]);
    });

    it("sends nothing for a creation whose transaction rolls back", async () => {
      const { ownerId, phone } = await connectOwnerPeerAndForeign();
      const { input } = await createRequestFor(ownerId);
      wireRealtimeHooks(pool);

      await expect(createAndPublish({ ...input, toolCallId: "tool-call-rolled-back" }, true)).rejects.toThrow(
        "force rollback",
      );
      await settle();

      expect(phone.frames).toEqual([]);
    });

    it.each(["notificationPreferences", "badgeCounts"] as const)(
      "sends a %s message to the sockets of the user it names only, without the extra fields it carries",
      async (scope) => {
        const { ownerId, phone, laptop, peer, foreign } = await connectOwnerPeerAndForeign();

        await notifyEnvelope(getTenantZeroId(), { type: "invalidation", scope, userId: ownerId, count: 3 });
        await waitUntil(() => phone.frames.length >= 1 && laptop.frames.length >= 1);
        await settle();

        expect(phone.frames).toEqual([{ type: "invalidate", scope }]);
        expect(laptop.frames).toEqual([{ type: "invalidate", scope }]);
        expect(peer.frames).toEqual([]);
        expect(foreign.frames).toEqual([]);
      },
    );

    it.each(["notificationPreferences", "badgeCounts"] as const)(
      "drops a %s message that names no user or a malformed user instead of widening it to the tenant",
      async (scope) => {
        const { ownerId, phone, peer } = await connectOwnerPeerAndForeign();

        for (const malformed of [{ userId: undefined }, { userId: "not-a-uuid" }, { userId: 7 }, { userId: null }]) {
          await notifyEnvelope(getTenantZeroId(), { type: "invalidation", scope, ...malformed });
        }
        // A valid message behind the malformed ones proves they were handled first and sent nothing.
        await notifyEnvelope(getTenantZeroId(), { type: "invalidation", scope, userId: ownerId });
        await waitUntil(() => phone.frames.length >= 1);
        await settle();

        expect(phone.frames).toEqual([{ type: "invalidate", scope }]);
        expect(peer.frames).toEqual([]);
      },
    );
  });
  describe("account scope (issue #1946)", () => {
    /** Two sockets of one user (two devices), another user of the same tenant, and a socket of another tenant with that user's id. */
    async function connectOwnerPeerAndForeign() {
      const ownerId = await createTestUser();
      const peerId = await createTestUser();
      const otherTenant = await createTestTenant(pool);
      return {
        ownerId,
        phone: await connect("phone", { tenantId: getTenantZeroId(), userId: ownerId, sessionId: "session-phone" }),
        laptop: await connect("laptop", { tenantId: getTenantZeroId(), userId: ownerId, sessionId: "session-laptop" }),
        peer: await connect("peer", { tenantId: getTenantZeroId(), userId: peerId, sessionId: "session-peer" }),
        foreign: await connect("foreign", { tenantId: otherTenant, userId: ownerId, sessionId: "session-foreign" }),
      };
    }

    const publishInTenantZero = (userId: string, rollBack = false) =>
      runInTenant(getTenantZeroId(), () =>
        withTransaction(pool, async (client) => {
          publishAccountInvalidation(client, userId);
          if (rollBack) throw new Error("force rollback");
        }),
      );

    it("sends a committed publication to every socket of that user in the tenant, with no field but the scope, and to nobody else", async () => {
      const { ownerId, phone, laptop, peer, foreign } = await connectOwnerPeerAndForeign();
      wireRealtimeHooks(pool);

      await publishInTenantZero(ownerId);
      await waitUntil(() => phone.frames.length >= 1 && laptop.frames.length >= 1);
      await settle();

      const expected = { type: "invalidate", scope: "account" };
      expect(phone.frames).toEqual([expected]);
      expect(laptop.frames).toEqual([expected]);
      expect(peer.frames).toEqual([]);
      expect(foreign.frames).toEqual([]);
    });

    it("sends nothing when the transaction rolls back, and still sends a committed publication", async () => {
      const { ownerId, phone } = await connectOwnerPeerAndForeign();
      wireRealtimeHooks(pool);

      await expect(publishInTenantZero(ownerId, true)).rejects.toThrow("force rollback");
      await settle();
      expect(phone.frames).toEqual([]);

      await publishInTenantZero(ownerId);
      await waitUntil(() => phone.frames.length >= 1);
      await settle();

      expect(phone.frames).toEqual([{ type: "invalidate", scope: "account" }]);
    });

    it("sends the frame of a message that carries more than its scope without the extra fields, to the user it names only", async () => {
      const { ownerId, phone, laptop, peer } = await connectOwnerPeerAndForeign();

      await notifyEnvelope(getTenantZeroId(), {
        type: "invalidation",
        scope: "account",
        userId: ownerId,
        displayName: "Private Name",
        locale: "cs",
      });
      await waitUntil(() => phone.frames.length >= 1 && laptop.frames.length >= 1);
      await settle();

      expect(phone.frames).toEqual([{ type: "invalidate", scope: "account" }]);
      expect(laptop.frames).toEqual([{ type: "invalidate", scope: "account" }]);
      expect(peer.frames).toEqual([]);
    });

    it("drops a message that names no user or a malformed user instead of widening it to the tenant", async () => {
      const { ownerId, phone, peer } = await connectOwnerPeerAndForeign();

      for (const malformed of [{ userId: undefined }, { userId: "not-a-uuid" }, { userId: 7 }, { userId: null }]) {
        await notifyEnvelope(getTenantZeroId(), { type: "invalidation", scope: "account", ...malformed });
      }
      // A valid message behind the malformed ones proves they were handled first and sent nothing.
      await notifyEnvelope(getTenantZeroId(), { type: "invalidation", scope: "account", userId: ownerId });
      await waitUntil(() => phone.frames.length >= 1);
      await settle();

      expect(phone.frames).toEqual([{ type: "invalidate", scope: "account" }]);
      expect(peer.frames).toEqual([]);
    });
  });
  describe("overview scope (issue #1951)", () => {
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

    /**
     * Runs the nightly rollover for tenant zero over a Tasks database that holds no task (an id no database has), so
     * that nothing moves and the frame is the whole of what the run announces.
     */
    const runRolloverInTenantZero = () =>
      runInTenant(getTenantZeroId(), () =>
        createTasksDayRolloverAction(pool)(
          { tasksDatabaseId: randomUUID() },
          { heartbeatId: randomUUID(), projectItemId: randomUUID() },
        ),
      );

    it("sends the end of a rollover to every socket of the tenant whose rollover ran, even when no task moved, and to no other tenant's socket", async () => {
      const { first, second, foreign } = await connectTenantTwoUsersAndForeign();
      wireRealtimeHooks(pool);

      await runRolloverInTenantZero();
      await waitUntil(() => first.frames.length >= 1 && second.frames.length >= 1);
      await settle();

      const expected = { type: "invalidate", scope: "overview" };
      expect(first.frames).toEqual([expected]);
      expect(second.frames).toEqual([expected]);
      expect(foreign.frames).toEqual([]);
    });

    it("sends nothing when a transaction of the run rolls back, to the tenant's sockets or to another tenant's, and still sends a later announcement", async () => {
      const { first, second, foreign } = await connectTenantTwoUsersAndForeign();
      const admin = getTestPool();
      const chokePoint = createChokePoint(pool);
      const tasksDatabaseId = await runInTenant(getTenantZeroId(), async () => {
        await seedSystem(pool);
        const database = (await chokePoint.listDatabases()).find((entry) => entry.ownerModuleId === "tasks");
        if (!database) throw new Error("The Tasks database was not seeded");
        // An unfinished one-off task of a day long past: the rollover moves it, and the trigger below rejects that write.
        await chokePoint.createItem({
          databaseId: database.id,
          properties: { name: "overview poison", date: "2000-01-01" },
        });
        return database.id;
      });
      // The only way to make a chunk transaction of the run fail: a trigger that rejects the write of one task.
      await admin.query(`
        CREATE FUNCTION test_overview_rollover_poison() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.properties->>'name' = 'overview poison' THEN
            RAISE EXCEPTION 'simulated rollover failure';
          END IF;
          RETURN NEW;
        END $$`);
      await admin.query(
        "CREATE TRIGGER test_overview_rollover_poison BEFORE UPDATE ON items FOR EACH ROW EXECUTE FUNCTION test_overview_rollover_poison()",
      );
      try {
        wireRealtimeHooks(pool);

        await expect(
          runInTenant(getTenantZeroId(), () =>
            createTasksDayRolloverAction(pool)(
              { tasksDatabaseId },
              { heartbeatId: randomUUID(), projectItemId: randomUUID() },
            ),
          ),
        ).rejects.toThrow("simulated rollover failure");
        await settle();
        expect(first.frames).toEqual([]);
        expect(second.frames).toEqual([]);
        expect(foreign.frames).toEqual([]);

        // NOTIFY is ordered: a frame the failed run had queued would sit before this sentinel.
        await notifyEnvelope(getTenantZeroId(), { type: "invalidation", scope: "overview" });
        await waitUntil(() => first.frames.length >= 1 && second.frames.length >= 1);
        await settle();
        expect(first.frames).toEqual([{ type: "invalidate", scope: "overview" }]);
        expect(second.frames).toEqual([{ type: "invalidate", scope: "overview" }]);
        expect(foreign.frames).toEqual([]);
      } finally {
        await admin.query("DROP TRIGGER test_overview_rollover_poison ON items");
        await admin.query("DROP FUNCTION test_overview_rollover_poison()");
      }
    });

    it("sends the frame of a message that carries more than its scope, to every socket of the tenant and without the extra fields", async () => {
      const { first, second, foreign } = await connectTenantTwoUsersAndForeign();

      await notifyEnvelope(getTenantZeroId(), {
        type: "invalidation",
        scope: "overview",
        userId: randomUUID(),
        tasksForToday: 4,
      });
      await waitUntil(() => first.frames.length >= 1 && second.frames.length >= 1);
      await settle();

      expect(first.frames).toEqual([{ type: "invalidate", scope: "overview" }]);
      expect(second.frames).toEqual([{ type: "invalidate", scope: "overview" }]);
      expect(foreign.frames).toEqual([]);
    });

    it("drops a message whose scope is not exactly overview before any socket", async () => {
      const { first } = await connectTenantTwoUsersAndForeign();

      for (const malformed of [{ scope: "Overview" }, { scope: "" }, { scope: null }, { scope: 7 }]) {
        await notifyEnvelope(getTenantZeroId(), { type: "invalidation", ...malformed });
      }
      // A valid message behind the malformed ones proves they were handled first and sent nothing.
      await notifyEnvelope(getTenantZeroId(), { type: "invalidation", scope: "overview" });
      await waitUntil(() => first.frames.length >= 1);
      await settle();

      expect(first.frames).toEqual([{ type: "invalidate", scope: "overview" }]);
    });
  });
  describe("mcpServers scope (issue #2025)", () => {
    let runtimePool: Pool;
    let restoreOutboundPolicy: () => void;

    beforeAll(async () => {
      // The http contract server listens on loopback, which the default outbound policy refuses.
      restoreOutboundPolicy = allowLoopbackOutboundForTests();
      runtimePool = await createRuntimeRolePool(getTestPool(), "semprec_data");
    });

    afterAll(async () => {
      restoreOutboundPolicy();
      await runtimePool?.end();
    });

    /**
     * The hooks are wired to the runtime-role pool: it carries the tenant scope of the writing code to the NOTIFY
     * (the superuser test pool always answers tenant zero), which is what puts a frame on a tenant's sockets.
     *
     * A provisioned tenant with its one user on two devices, a project that has a grant on a registered tool of the
     * MCP server it holds, and a socket of another tenant. The grant is written before the hooks are wired, so the
     * `projectAgent` frame it announces is not part of what a test looks at.
     */
    async function connectTenantWithGrantedServer(config?: unknown) {
      const tenantId = await createTestTenant(pool);
      await provisionTenant(runtimePool, tenantId);
      const user = await createUser(pool, {
        email: `mcp-servers-${randomUUID()}@example.test`,
        passwordHash: await hashPassword("s3cret-password"),
        locale: "en",
        tenantId,
      });
      const otherTenant = await createTestTenant(pool);
      const chokePoint = createChokePoint(runtimePool);
      const setup = await runInTenant(tenantId, async () => {
        const database = (await chokePoint.listDatabases()).find((entry) => entry.ownerModuleId === "mcpServers");
        if (!database) throw new Error("The mcpServers database was not provisioned");
        const server = await chokePoint.createItem({
          databaseId: database.id,
          properties: {
            name: "Contract server",
            connectionConfig: { transport: "http", url: "https://mcp.example.test/mcp" },
          },
        });
        // The write hook refuses a loopback URL, which is where a contract server listens: this state is only
        // reachable by writing the stored config directly.
        if (config !== undefined) {
          await pool.query(
            "UPDATE items SET properties = properties || jsonb_build_object('connectionConfig', $2::jsonb) WHERE id = $1",
            [server.id, JSON.stringify(config)],
          );
        }
        const projectItemId = await createTestProjectItem(runtimePool);
        const registration = await upsertMcpToolRegistration(runtimePool, {
          mcpServerItemId: server.id,
          toolName: "search_web",
          toolSchema: {},
        });
        await withTransaction(runtimePool, (client) =>
          setProjectMcpGrantForAgentPage(client, {
            projectItemId,
            mcpToolRegistrationId: registration.id,
            granted: true,
          }),
        );
        return { databaseId: database.id, serverItemId: server.id };
      });
      return {
        ...setup,
        tenantId,
        chokePoint,
        phone: await connect("phone", { tenantId, userId: user.id, sessionId: "session-phone" }),
        laptop: await connect("laptop", { tenantId, userId: user.id, sessionId: "session-laptop" }),
        foreign: await connect("foreign", { tenantId: otherTenant, userId: user.id, sessionId: "session-foreign" }),
      };
    }

    const framesOf = (inbox: Inbox, scope: string) => inbox.frames.filter((frame) => frame.scope === scope);

    it("sends one frame to every socket of the tenant when a server is switched off and one when it is switched on, and no projectAgent frame", async () => {
      const { tenantId, chokePoint, databaseId, serverItemId, phone, laptop, foreign } =
        await connectTenantWithGrantedServer();
      wireRealtimeHooks(runtimePool);
      const setActive = (active: boolean) =>
        runInTenant(tenantId, () =>
          chokePoint.updateItem({ databaseId, itemId: serverItemId, propertiesPatch: { active } }),
        );

      await setActive(false);
      await waitUntil(() => framesOf(phone, "mcpServers").length >= 1 && framesOf(laptop, "mcpServers").length >= 1);
      await settle();
      expect(framesOf(phone, "mcpServers")).toEqual([{ type: "invalidate", scope: "mcpServers" }]);
      expect(framesOf(laptop, "mcpServers")).toEqual([{ type: "invalidate", scope: "mcpServers" }]);

      await setActive(true);
      await waitUntil(() => framesOf(phone, "mcpServers").length >= 2 && framesOf(laptop, "mcpServers").length >= 2);
      await settle();

      expect(framesOf(phone, "mcpServers")).toHaveLength(2);
      expect(framesOf(laptop, "mcpServers")).toHaveLength(2);
      expect(framesOf(phone, "projectAgent")).toEqual([]);
      expect(framesOf(laptop, "projectAgent")).toEqual([]);
      expect(foreign.frames).toEqual([]);
    });

    it("sends nothing for an update that does not name active, and nothing when the transaction rolls back", async () => {
      const { tenantId, chokePoint, databaseId, serverItemId, phone, foreign } = await connectTenantWithGrantedServer();
      wireRealtimeHooks(runtimePool);

      await runInTenant(tenantId, () =>
        chokePoint.updateItem({ databaseId, itemId: serverItemId, propertiesPatch: { name: "Renamed" } }),
      );
      await expect(
        runInTenant(tenantId, () =>
          withTransaction(runtimePool, async (client) => {
            await updateItemWithClient(client, {
              databaseId,
              itemId: serverItemId,
              propertiesPatch: { active: false },
            });
            throw new Error("force rollback");
          }),
        ),
      ).rejects.toThrow("force rollback");
      await settle();

      expect(framesOf(phone, "mcpServers")).toEqual([]);
      expect(foreign.frames).toEqual([]);
    });

    it("sends one frame to the tenant's sockets after a successful synchronization, and none for a failed one", async () => {
      const contract = await startHttpContractServer();
      const { tenantId, serverItemId, phone, laptop, foreign } = await connectTenantWithGrantedServer(
        contract.connectionConfig,
      );
      wireRealtimeHooks(runtimePool);
      try {
        contract.setTools([
          { name: "dup", description: "one", inputSchema: { type: "object", properties: {} } },
          { name: "dup", description: "two", inputSchema: { type: "object", properties: {} } },
        ]);
        await expect(runInTenant(tenantId, () => syncMcpServerTools(runtimePool, serverItemId))).rejects.toThrow();
        await settle();
        expect(framesOf(phone, "mcpServers")).toEqual([]);

        contract.setTools([
          { name: "search_web", description: "Searches", inputSchema: { type: "object", properties: {} } },
        ]);
        await runInTenant(tenantId, () => syncMcpServerTools(runtimePool, serverItemId));
        await waitUntil(() => framesOf(phone, "mcpServers").length >= 1 && framesOf(laptop, "mcpServers").length >= 1);
        await settle();

        expect(framesOf(phone, "mcpServers")).toEqual([{ type: "invalidate", scope: "mcpServers" }]);
        expect(framesOf(laptop, "mcpServers")).toEqual([{ type: "invalidate", scope: "mcpServers" }]);
        expect(framesOf(phone, "projectAgent")).toEqual([]);
        expect(foreign.frames).toEqual([]);
      } finally {
        await contract.stop();
      }
    });

    it("sends the frame of a message that carries more than its scope to every socket of the tenant, without the extra fields", async () => {
      const { tenantId, phone, laptop, foreign } = await connectTenantWithGrantedServer();

      await notifyEnvelope(tenantId, {
        type: "invalidation",
        scope: "mcpServers",
        userId: randomUUID(),
        mcpServerItemId: randomUUID(),
      });
      await waitUntil(() => framesOf(phone, "mcpServers").length >= 1 && framesOf(laptop, "mcpServers").length >= 1);
      await settle();

      expect(framesOf(phone, "mcpServers")).toEqual([{ type: "invalidate", scope: "mcpServers" }]);
      expect(framesOf(laptop, "mcpServers")).toEqual([{ type: "invalidate", scope: "mcpServers" }]);
      expect(foreign.frames).toEqual([]);
    });
  });
});
