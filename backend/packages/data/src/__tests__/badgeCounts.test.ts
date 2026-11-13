import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createUser as createRawUser } from "../auth/usersStore.js";
import { createAgentRun, type CreateAgentRunInput } from "../agentRuns/agentRunsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createBadgeCountsRouteHandler } from "../notifications/badgeCountsRoute.js";
import { listApprovalRequestsQueue } from "../mcp/approvalRequestsQueue.js";
import { createPendingApprovalRequest, decideApprovalRequest } from "../mcp/approvalRequestsStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTenantZeroUser,
  createTestTenant,
  getTestPool,
  inTenantZero,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

let adminPool: Pool;
let dataPool: Pool;
let ownerId: string;

/** A pending approval request of a new run of `userId`, which `triggeredBy` decides the source kind of. */
async function pendingRequestOf(
  userId: string,
  triggeredBy: CreateAgentRunInput["triggeredBy"] = "user",
): Promise<string> {
  const run = await createAgentRun(adminPool, { triggeredBy, task: "badge counts", userId });
  const created = await createPendingApprovalRequest(adminPool, {
    agentRunId: run.id,
    toolName: "search_web",
    riskClass: "unclassified",
    payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
    resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
  });
  return created.id;
}

/** A second account in a tenant of its own (`users.tenant_id` is unique, so every account has one). */
async function createForeignUser(): Promise<{ id: string; tenantId: string }> {
  const tenantId = await createTestTenant(adminPool);
  const user = await createRawUser(adminPool, {
    email: `${randomUUID()}@example.com`,
    passwordHash: "unused",
    tenantId,
  });
  return { id: user.id, tenantId };
}

/** The answer of `GET /api/badge-counts` for the session user `userId`, on `pool`, inside tenant zero. */
function badgeCountsOf(pool: Pool, userId: string) {
  return inTenantZero(() => createBadgeCountsRouteHandler(pool)({ identity: { user: { id: userId } } }));
}

describe("GET /api/badge-counts (issue #1828)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await dataPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    await seedSystem(adminPool, createViewTypeRegistry());
    ownerId = (await createTenantZeroUser(adminPool)).id;
  });

  it("answers zero for all three counts when nothing waits for the user", async () => {
    expect(await badgeCountsOf(adminPool, ownerId)).toEqual({
      status: 200,
      body: { pendingApprovals: 0, pendingInvites: 0, openInboxItems: 0 },
    });
  });

  it("counts three pending approval requests as pendingApprovals 3 and leaves the other two counts at 0", async () => {
    await pendingRequestOf(ownerId);
    await pendingRequestOf(ownerId);
    await pendingRequestOf(ownerId);

    expect(await badgeCountsOf(adminPool, ownerId)).toEqual({
      status: 200,
      body: { pendingApprovals: 3, pendingInvites: 0, openInboxItems: 0 },
    });
  });

  it("counts the requests of runs started by a chat, a heartbeat and an MCP client, not only the chat ones", async () => {
    await pendingRequestOf(ownerId, "user");
    await pendingRequestOf(ownerId, "heartbeat");
    await pendingRequestOf(ownerId, "mcp");

    expect(await badgeCountsOf(adminPool, ownerId)).toMatchObject({ body: { pendingApprovals: 3 } });
  });

  it("no longer counts a request once it is approved or rejected", async () => {
    await pendingRequestOf(ownerId);
    const approved = await pendingRequestOf(ownerId);
    const rejected = await pendingRequestOf(ownerId);
    expect(await badgeCountsOf(adminPool, ownerId)).toMatchObject({ body: { pendingApprovals: 3 } });

    await decideApprovalRequest(adminPool, approved, "approved", ownerId);
    expect(await badgeCountsOf(adminPool, ownerId)).toMatchObject({ body: { pendingApprovals: 2 } });
    await decideApprovalRequest(adminPool, rejected, "rejected", ownerId);

    expect(await badgeCountsOf(adminPool, ownerId)).toMatchObject({ body: { pendingApprovals: 1 } });
  });

  it("equals the number of pending requests the approval queue lists", async () => {
    const decided = await pendingRequestOf(ownerId);
    await pendingRequestOf(ownerId, "heartbeat");
    await pendingRequestOf(ownerId, "mcp");
    await decideApprovalRequest(adminPool, decided, "approved", ownerId);

    const queue = await listApprovalRequestsQueue(adminPool, ownerId, "en");

    expect(queue).toHaveLength(2);
    expect(await badgeCountsOf(adminPool, ownerId)).toMatchObject({ body: { pendingApprovals: queue.length } });
  });

  describe("isolation, on the runtime role", () => {
    it("does not count the pending requests of another user", async () => {
      await pendingRequestOf(ownerId);
      const otherUser = await createForeignUser();
      await withTenantTransaction(adminPool, otherUser.tenantId, async (client) => {
        const foreignRun = await createAgentRun(client, { triggeredBy: "user", task: "other", userId: otherUser.id });
        await createPendingApprovalRequest(client, {
          agentRunId: foreignRun.id,
          toolName: "search_web",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        });
      });

      const own = await badgeCountsOf(dataPool, ownerId);
      const foreign = await runInTenant(otherUser.tenantId, () =>
        createBadgeCountsRouteHandler(dataPool)({ identity: { user: { id: otherUser.id } } }),
      );

      expect(own).toMatchObject({ body: { pendingApprovals: 1 } });
      expect(foreign).toMatchObject({ body: { pendingApprovals: 1 } });
    });

    it("keeps the requests of the first tenant out of a second tenant's count, whatever user id is passed", async () => {
      await pendingRequestOf(ownerId);
      await pendingRequestOf(ownerId);
      const otherUser = await createForeignUser();

      // The first tenant's user id is passed on purpose: only the tenant scope can keep its rows out.
      const crossTenant = await runInTenant(otherUser.tenantId, () =>
        createBadgeCountsRouteHandler(dataPool)({ identity: { user: { id: ownerId } } }),
      );
      const inOtherTenant = await runInTenant(otherUser.tenantId, () =>
        createBadgeCountsRouteHandler(dataPool)({ identity: { user: { id: otherUser.id } } }),
      );

      expect(crossTenant).toEqual({
        status: 200,
        body: { pendingApprovals: 0, pendingInvites: 0, openInboxItems: 0 },
      });
      expect(inOtherTenant).toMatchObject({ body: { pendingApprovals: 0 } });
      expect(await badgeCountsOf(dataPool, ownerId)).toMatchObject({ body: { pendingApprovals: 2 } });
    });
  });
});
