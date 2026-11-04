import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import { z } from "zod";
import type { Pool } from "pg";
import {
  ApprovalRequiredError,
  createAgentRun,
  createChokePoint,
  createUser,
  decideAndEnqueueApprovalRequest,
  deleteRelationWithClient,
  getApprovalRequest,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  isGenericOperationApprovalRequestPayload,
  provisionTenant,
  setAgentRunEventHook,
  setDocUpdateHook,
  setInvalidationHook,
  setNotificationCreatedHook,
  setNotificationReadStateHook,
  setSempThreadInvalidationHook,
  setSessionRevokedHook,
  withTransaction,
  type CollectionMetadataResolver,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createGenericOperationGateway, replayApprovedGenericOperation } from "@semprec/application";
import { CAPABILITY_IDS, runAsSystem, runInTenant } from "@semprec/shared";
import { createSyncServer, publishRealtimeMessage, wireRealtimeHooks } from "@semprec/realtime";
import { createDispatcher } from "../app.js";

const resolver: CollectionMetadataResolver = {
  resolve: () => ({ icon: null, color: null, overviewOrder: null, switcherOrder: null, clientVisible: true }),
};
const password = "test-password";
const zRelationFrame = z.object({ type: z.literal("invalidate"), scope: z.literal("relation"), itemId: z.string() });
function parseFrame(data: RawData): unknown {
  const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
  return JSON.parse(bytes.toString("utf8"));
}

describe("relation invalidations across REST, agent and realtime", () => {
  let admin: Pool;
  let pool: Pool;
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:verify-runtime-role", () =>
      pool.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ role_name: "semprec_data", rolsuper: false, rolbypassrls: false }]);
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  it("routes actual REST and agent edge writes only to the acting tenant and user after commit", async () => {
    await resetDatabase(admin);
    const tenantA = await createTestTenant(admin);
    const tenantB = await createTestTenant(admin);
    await provisionTenant(pool, tenantA);
    await provisionTenant(pool, tenantB);
    const hash = await hashPassword(password);
    const userA = await createUser(admin, {
      tenantId: tenantA,
      email: `${randomUUID()}@example.test`,
      passwordHash: hash,
    });
    const userB = await createUser(admin, {
      tenantId: tenantB,
      email: `${randomUUID()}@example.test`,
      passwordHash: hash,
    });
    const session = await login(admin, { email: userA.email, password, platform: "ios", ip: "127.0.0.1" });
    const cp = createChokePoint(pool);
    const fixture = await runInTenant(tenantA, async () => {
      const source = await cp.createDatabase({ name: "Source" });
      const target = await cp.createDatabase({ name: "Target" });
      const { property } = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        targetDatabaseId: target.id,
        key: "links",
        name: "Links",
        inverse: { key: "backlinks", name: "Backlinks" },
      });
      const from = await cp.createItem({ databaseId: source.id, properties: {} });
      const to = await cp.createItem({ databaseId: target.id, properties: {} });
      const projects = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === "projects");
      const tasks = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === "tasks");
      const files = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === "files");
      const areas = (await cp.listDatabases()).find((entry) => entry.ownerModuleId === "areas");
      if (!projects || !tasks || !files || !areas) throw new Error("Missing seeded databases");
      const project = await cp.createItem({ databaseId: projects.id, properties: { name: "Agent" } });
      const nextProject = await cp.createItem({ databaseId: projects.id, properties: { name: "Next" } });
      const task = await cp.createItem({ databaseId: tasks.id, properties: { name: "Moved task" } });
      const file = await cp.createItem({ databaseId: files.id, properties: { name: "File" } });
      const area = await cp.createItem({ databaseId: areas.id, properties: { name: "Area" } });
      const taskProject = (await cp.listProperties(tasks.id)).find((entry) => entry.key === "project");
      if (!taskProject) throw new Error("Missing task project relation");
      await cp.setRelation({ relationPropertyId: taskProject.id, callerItemId: task.id, targetItemId: project.id });
      const run = await createAgentRun(pool, {
        projectItemId: project.id,
        triggeredBy: "user",
        task: "relation write",
      });
      return {
        source,
        target,
        property,
        from,
        to,
        project,
        nextProject,
        task,
        tasks,
        projects,
        taskProject,
        files,
        areas,
        file,
        area,
        run,
      };
    });
    wireRealtimeHooks(pool);
    const otherUser = randomUUID();
    let sync: Awaited<ReturnType<typeof createSyncServer>> | undefined;
    let server: Server | undefined;
    const sockets: WebSocket[] = [];
    let failure: { error: unknown } | undefined;
    const cleanupErrors: unknown[] = [];
    try {
      const activeSync = await createSyncServer(pool, {
        authenticate: async (req) => {
          const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
          if (token === "owner") return { tenantId: tenantA, userId: userA.id, sessionId: randomUUID() };
          if (token === "other") return { tenantId: tenantA, userId: otherUser, sessionId: randomUUID() };
          if (token === "foreign") return { tenantId: tenantB, userId: userB.id, sessionId: randomUUID() };
          return null;
        },
        revalidateSession: async () => true,
        heartbeatIntervalMs: 30_000,
      });
      sync = activeSync;
      const dispatch = await createDispatcher(pool, {
        passwordResetMailer: { async sendPasswordResetEmail() {} },
        appBaseUrl: "http://localhost",
        setupToken: "unused",
        moduleRegistry: await loadFullModuleRegistry(),
        blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-rel-${randomUUID()}`)),
        maxFileSizeBytes: 1024,
      });
      server = createServer(dispatch);
      const ownedServer = server;
      ownedServer.on("upgrade", (req, socket, head) => activeSync.handleUpgrade(req, socket, head));
      await new Promise<void>((resolve, reject) => {
        ownedServer.once("error", reject);
        ownedServer.listen(0, "127.0.0.1", () => {
          ownedServer.off("error", reject);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing listen address");
      const port = address.port;
      const baseUrl = `http://127.0.0.1:${port}`;
      async function connect(token: string): Promise<WebSocket> {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=${token}`);
        sockets.push(socket);
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            socket.terminate();
            reject(new Error("Socket connection timed out"));
          }, 5000);
          socket.once("open", () => {
            clearTimeout(timeout);
            resolve();
          });
          socket.once("error", (error) => {
            clearTimeout(timeout);
            reject(error);
          });
        });
        return socket;
      }
      const owner = await connect("owner");
      const foreign = await connect("foreign");
      const other = await connect("other");
      const ownerFrames: unknown[] = [];
      const foreignFrames: unknown[] = [];
      const otherFrames: unknown[] = [];
      owner.on("message", (data) => ownerFrames.push(parseFrame(data)));
      foreign.on("message", (data) => foreignFrames.push(parseFrame(data)));
      other.on("message", (data) => otherFrames.push(parseFrame(data)));
      const sentinel = async (tenantId: string, userId: string, databaseId: string) =>
        runInTenant(tenantId, () =>
          publishRealtimeMessage(pool, { type: "invalidation", scope: "schema", databaseId, userId }),
        );
      const response = await fetch(`${baseUrl}/api/items/${fixture.from.id}/relations/links/${fixture.to.id}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
        body: "{}",
      });
      expect(response.status).toBe(200);
      await vi.waitFor(() => {
        expect(ownerFrames).toContainEqual({
          type: "invalidate",
          scope: "relation",
          databaseId: fixture.source.id,
          itemId: fixture.from.id,
          propertyKey: "links",
          op: "put",
        });
        expect(ownerFrames).toContainEqual({
          type: "invalidate",
          scope: "relation",
          databaseId: fixture.target.id,
          itemId: fixture.to.id,
          propertyKey: "backlinks",
          op: "put",
        });
      });
      const ownerMarker = randomUUID();
      const foreignMarker = randomUUID();
      const otherMarker = randomUUID();
      await sentinel(tenantA, userA.id, ownerMarker);
      await sentinel(tenantB, userB.id, foreignMarker);
      await sentinel(tenantA, otherUser, otherMarker);
      await vi.waitFor(() => {
        expect(ownerFrames).toContainEqual({ type: "invalidate", scope: "schema", databaseId: ownerMarker });
        expect(foreignFrames).toContainEqual({ type: "invalidate", scope: "schema", databaseId: foreignMarker });
        expect(otherFrames).toContainEqual({ type: "invalidate", scope: "schema", databaseId: otherMarker });
      });
      expect(ownerFrames).toContainEqual({
        type: "invalidate",
        scope: "relation",
        databaseId: fixture.source.id,
        itemId: fixture.from.id,
        propertyKey: "links",
        op: "put",
      });
      expect(ownerFrames).toContainEqual({
        type: "invalidate",
        scope: "relation",
        databaseId: fixture.target.id,
        itemId: fixture.to.id,
        propertyKey: "backlinks",
        op: "put",
      });
      expect(foreignFrames).toEqual([{ type: "invalidate", scope: "schema", databaseId: foreignMarker }]);
      expect(otherFrames).toEqual([{ type: "invalidate", scope: "schema", databaseId: otherMarker }]);
      ownerFrames.length = 0;
      const deleted = await fetch(`${baseUrl}/api/items/${fixture.from.id}/relations/links/${fixture.to.id}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.token}` },
      });
      expect(deleted.status).toBe(200);
      await vi.waitFor(() => {
        expect(ownerFrames).toContainEqual({
          type: "invalidate",
          scope: "relation",
          databaseId: fixture.source.id,
          itemId: fixture.from.id,
          propertyKey: "links",
          op: "delete",
        });
        expect(ownerFrames).toContainEqual({
          type: "invalidate",
          scope: "relation",
          databaseId: fixture.target.id,
          itemId: fixture.to.id,
          propertyKey: "backlinks",
          op: "delete",
        });
      });
      ownerFrames.length = 0;
      const gateway = createGenericOperationGateway(pool, resolver);
      await runInTenant(tenantA, () =>
        gateway.invoke(
          "relation.set",
          { userId: userA.id, runId: fixture.run.id, agentProjectItemId: fixture.project.id },
          new Set(CAPABILITY_IDS),
          {
            relationPropertyId: fixture.taskProject.id,
            callerItemId: fixture.task.id,
            targetItemId: fixture.nextProject.id,
          },
        ),
      );
      const moveMarker = randomUUID();
      await sentinel(tenantA, userA.id, moveMarker);
      await vi.waitFor(() =>
        expect(ownerFrames).toContainEqual({ type: "invalidate", scope: "schema", databaseId: moveMarker }),
      );
      const moveFrames = ownerFrames.filter((frame) => {
        const parsed = zRelationFrame.safeParse(frame);
        return (
          parsed.success && [fixture.task.id, fixture.project.id, fixture.nextProject.id].includes(parsed.data.itemId)
        );
      });
      expect(moveFrames).toEqual(
        expect.arrayContaining([
          {
            type: "invalidate",
            scope: "relation",
            databaseId: fixture.tasks.id,
            itemId: fixture.task.id,
            propertyKey: "project",
            op: "put",
          },
          {
            type: "invalidate",
            scope: "relation",
            databaseId: fixture.projects.id,
            itemId: fixture.project.id,
            propertyKey: "tasks",
            op: "delete",
          },
          {
            type: "invalidate",
            scope: "relation",
            databaseId: fixture.projects.id,
            itemId: fixture.nextProject.id,
            propertyKey: "tasks",
            op: "put",
          },
        ]),
      );
      expect(moveFrames).toHaveLength(3);
      const foreignMoveMarker = randomUUID();
      const otherMoveMarker = randomUUID();
      await sentinel(tenantB, userB.id, foreignMoveMarker);
      await sentinel(tenantA, otherUser, otherMoveMarker);
      await vi.waitFor(() => {
        expect(foreignFrames).toContainEqual({ type: "invalidate", scope: "schema", databaseId: foreignMoveMarker });
        expect(otherFrames).toContainEqual({ type: "invalidate", scope: "schema", databaseId: otherMoveMarker });
      });
      expect(foreignFrames).toEqual([
        { type: "invalidate", scope: "schema", databaseId: foreignMarker },
        { type: "invalidate", scope: "schema", databaseId: foreignMoveMarker },
      ]);
      expect(otherFrames).toEqual([
        { type: "invalidate", scope: "schema", databaseId: otherMarker },
        { type: "invalidate", scope: "schema", databaseId: otherMoveMarker },
      ]);
      ownerFrames.length = 0;
      for (const [method, op] of [
        ["PUT", "put"],
        ["DELETE", "delete"],
      ] as const) {
        const response = await fetch(`${baseUrl}/api/items/${fixture.file.id}/relations/area/${fixture.area.id}`, {
          method,
          headers: { Authorization: `Bearer ${session.token}`, "Content-Type": "application/json" },
          ...(method === "PUT" ? { body: "{}" } : {}),
        });
        expect(response.status).toBe(200);
        const marker = randomUUID();
        await sentinel(tenantA, userA.id, marker);
        await vi.waitFor(() =>
          expect(ownerFrames).toContainEqual({ type: "invalidate", scope: "schema", databaseId: marker }),
        );
        expect(ownerFrames).toContainEqual({
          type: "invalidate",
          scope: "relation",
          databaseId: fixture.files.id,
          itemId: fixture.file.id,
          propertyKey: "area",
          op,
        });
        expect(ownerFrames).toContainEqual({
          type: "invalidate",
          scope: "relation",
          databaseId: fixture.areas.id,
          itemId: fixture.area.id,
          propertyKey: null,
          op,
        });
        ownerFrames.length = 0;
      }
      const foreignFileMarker = randomUUID();
      const otherFileMarker = randomUUID();
      await sentinel(tenantB, userB.id, foreignFileMarker);
      await sentinel(tenantA, otherUser, otherFileMarker);
      await vi.waitFor(() => {
        expect(foreignFrames).toContainEqual({ type: "invalidate", scope: "schema", databaseId: foreignFileMarker });
        expect(otherFrames).toContainEqual({ type: "invalidate", scope: "schema", databaseId: otherFileMarker });
      });
      expect(foreignFrames).toEqual([
        { type: "invalidate", scope: "schema", databaseId: foreignMarker },
        { type: "invalidate", scope: "schema", databaseId: foreignMoveMarker },
        { type: "invalidate", scope: "schema", databaseId: foreignFileMarker },
      ]);
      expect(otherFrames).toEqual([
        { type: "invalidate", scope: "schema", databaseId: otherMarker },
        { type: "invalidate", scope: "schema", databaseId: otherMoveMarker },
        { type: "invalidate", scope: "schema", databaseId: otherFileMarker },
      ]);
      await runInTenant(tenantA, () =>
        gateway.invoke(
          "relation.put",
          { userId: userA.id, runId: fixture.run.id, agentProjectItemId: fixture.project.id },
          new Set(CAPABILITY_IDS),
          { relationPropertyId: fixture.property.id, callerItemId: fixture.from.id, targetItemId: fixture.to.id },
        ),
      );
      await vi.waitFor(() =>
        expect(ownerFrames).toContainEqual({
          type: "invalidate",
          scope: "relation",
          databaseId: fixture.target.id,
          itemId: fixture.to.id,
          propertyKey: "backlinks",
          op: "put",
        }),
      );
      const agentMarker = randomUUID();
      await sentinel(tenantA, userA.id, agentMarker);
      await vi.waitFor(() =>
        expect(ownerFrames).toContainEqual({ type: "invalidate", scope: "schema", databaseId: agentMarker }),
      );
      expect(ownerFrames).toContainEqual({
        type: "invalidate",
        scope: "relation",
        databaseId: fixture.source.id,
        itemId: fixture.from.id,
        propertyKey: "links",
        op: "put",
      });
      ownerFrames.length = 0;
      const input = {
        relationPropertyId: fixture.property.id,
        callerItemId: fixture.from.id,
        targetItemId: fixture.to.id,
      };
      let requestId: string | undefined;
      try {
        await runInTenant(tenantA, () =>
          gateway.invoke(
            "relation.delete",
            { userId: userA.id, runId: fixture.run.id, agentProjectItemId: fixture.project.id },
            new Set(CAPABILITY_IDS),
            input,
          ),
        );
        throw new Error("Expected approval request");
      } catch (error) {
        if (!(error instanceof ApprovalRequiredError)) throw error;
        requestId = error.details.approvalRequestId;
      }
      if (!requestId) throw new Error("Missing approval request ID");
      await runInTenant(tenantA, () =>
        withTransaction(pool, (client) =>
          decideAndEnqueueApprovalRequest(client, {
            approvalRequestId: requestId,
            decision: "approved",
            decidedByUserId: userA.id,
          }),
        ),
      );
      const beforeReplayMarker = randomUUID();
      await sentinel(tenantA, userA.id, beforeReplayMarker);
      await vi.waitFor(() =>
        expect(ownerFrames).toContainEqual({ type: "invalidate", scope: "schema", databaseId: beforeReplayMarker }),
      );
      expect(ownerFrames).not.toContainEqual({
        type: "invalidate",
        scope: "relation",
        databaseId: fixture.source.id,
        itemId: fixture.from.id,
        propertyKey: "links",
        op: "delete",
      });
      const request = await runInTenant(tenantA, () => getApprovalRequest(pool, requestId));
      if (!request || !isGenericOperationApprovalRequestPayload(request.payload))
        throw new Error("Expected approved generic operation");
      const payload = request.payload;
      const replay = await runInTenant(tenantA, () => replayApprovedGenericOperation(pool, { ...request, payload }));
      expect(replay.error).toBe(false);
      await vi.waitFor(() => {
        expect(ownerFrames).toContainEqual({
          type: "invalidate",
          scope: "relation",
          databaseId: fixture.source.id,
          itemId: fixture.from.id,
          propertyKey: "links",
          op: "delete",
        });
        expect(ownerFrames).toContainEqual({
          type: "invalidate",
          scope: "relation",
          databaseId: fixture.target.id,
          itemId: fixture.to.id,
          propertyKey: "backlinks",
          op: "delete",
        });
      });
      await runInTenant(tenantA, () =>
        gateway.invoke(
          "relation.put",
          { userId: userA.id, runId: fixture.run.id, agentProjectItemId: fixture.project.id },
          new Set(CAPABILITY_IDS),
          input,
        ),
      );
      await vi.waitFor(() =>
        expect(ownerFrames).toContainEqual({
          type: "invalidate",
          scope: "relation",
          databaseId: fixture.target.id,
          itemId: fixture.to.id,
          propertyKey: "backlinks",
          op: "put",
        }),
      );
      // Observe the real publisher's public queries so a later marker cannot overtake an
      // unexpectedly retained after-commit publication on another pooled connection.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const originalQuery = pool.query;
      let publications: Promise<{ error?: unknown }>[] = [];
      let relationPublications = 0;
      const settlePublications = async () => {
        for (const result of await Promise.all(publications)) if ("error" in result) throw result.error;
      };
      pool.query = new Proxy(originalQuery, {
        apply(target, receiver, args: unknown[]) {
          const result: unknown = Reflect.apply(target, receiver, args);
          if (typeof args[0] === "string" && args[0].includes("pg_notify") && result instanceof Promise) {
            publications.push(
              result.then(
                () => ({}),
                (error: unknown) => ({ error }),
              ),
            );
            if (Array.isArray(args[1]) && typeof args[1][1] === "string" && args[1][1].includes('"scope":"relation"'))
              relationPublications += 1;
          }
          return result;
        },
      });
      try {
        const internal = await runInTenant(tenantA, async () => {
          const from = await cp.createItem({ databaseId: fixture.source.id, properties: {} });
          const to = await cp.createItem({ databaseId: fixture.target.id, properties: {} });
          await cp.createRelation({
            relationPropertyId: fixture.property.id,
            callerItemId: from.id,
            targetItemId: to.id,
          });
          return { from, to };
        });
        expect(publications.length).toBeGreaterThan(0);
        expect(relationPublications).toBeGreaterThan(0);
        await settlePublications();
        const sourceFrame = {
          type: "invalidate",
          scope: "relation",
          databaseId: fixture.source.id,
          itemId: internal.from.id,
          propertyKey: "links",
          op: "put",
        };
        const targetFrame = {
          type: "invalidate",
          scope: "relation",
          databaseId: fixture.target.id,
          itemId: internal.to.id,
          propertyKey: "backlinks",
          op: "put",
        };
        await vi.waitFor(() => {
          for (const frames of [ownerFrames, otherFrames]) {
            expect(frames).toContainEqual(sourceFrame);
            expect(frames).toContainEqual(targetFrame);
          }
        });
        const foreignAfterInternal = randomUUID();
        await sentinel(tenantB, userB.id, foreignAfterInternal);
        await vi.waitFor(() =>
          expect(foreignFrames).toContainEqual({
            type: "invalidate",
            scope: "schema",
            databaseId: foreignAfterInternal,
          }),
        );
        expect(foreignFrames).not.toContainEqual(sourceFrame);
        expect(foreignFrames).not.toContainEqual(targetFrame);

        ownerFrames.length = 0;
        publications = [];
        await expect(
          runInTenant(tenantA, () =>
            withTransaction(pool, async (client) => {
              await deleteRelationWithClient(client, input, undefined, undefined, userA.id);
              throw new Error("rollback probe");
            }),
          ),
        ).rejects.toThrow("rollback probe");
        await settlePublications();
        const rollbackMarker = randomUUID();
        await sentinel(tenantA, userA.id, rollbackMarker);
        await vi.waitFor(() =>
          expect(ownerFrames).toContainEqual({ type: "invalidate", scope: "schema", databaseId: rollbackMarker }),
        );
        expect(ownerFrames).not.toContainEqual({
          type: "invalidate",
          scope: "relation",
          databaseId: fixture.source.id,
          itemId: fixture.from.id,
          propertyKey: "links",
          op: "delete",
        });
        expect(ownerFrames).not.toContainEqual({
          type: "invalidate",
          scope: "relation",
          databaseId: fixture.target.id,
          itemId: fixture.to.id,
          propertyKey: "backlinks",
          op: "delete",
        });
      } finally {
        pool.query = originalQuery;
      }
    } catch (error) {
      failure = { error };
    } finally {
      for (const socket of sockets) {
        try {
          socket.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (sync) {
        try {
          await sync.close();
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (server?.listening) {
        const ownedServer = server;
        try {
          await new Promise<void>((resolve, reject) =>
            ownedServer.close((error) => (error ? reject(error) : resolve())),
          );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      setInvalidationHook(() => {});
      setDocUpdateHook(() => {});
      setAgentRunEventHook(() => {});
      setNotificationCreatedHook(() => {});
      setNotificationReadStateHook(() => {});
      setSempThreadInvalidationHook(() => {});
      setSessionRevokedHook(() => {});
    }
    if (failure) {
      if (cleanupErrors.length > 0) console.error("Relation realtime fixture cleanup also failed");
      throw failure.error;
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Relation realtime fixture cleanup failed");
  });
});
