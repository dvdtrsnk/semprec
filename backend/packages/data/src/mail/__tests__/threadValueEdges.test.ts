import "../../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { getItemById, lockItemById } from "../../chokePoint/itemsStore.js";
import { createRelationPropertyWithClient } from "../../chokePoint/relationPropertyWrites.js";
import { registerRelationEdgeWriteHook } from "../../chokePoint/hooks.js";
import { insertValueLink, listValueLinksByItemIds } from "../../chokePoint/valueLinksStore.js";
import { VALUE_LINKS_OWNER_PROCESS } from "../../chokePoint/valueLinkWrites.js";
import {
  assertRelationTargetLinkableWithClient,
  createRelationWithClient,
  deleteRelationWithClient,
  updateRelationWithClient,
} from "../../chokePoint/relationOps.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem } from "../../chokePoint/relationsStore.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createMailThread, reassignThread, resolveMergedThreadId } from "../mailMessageMetaStore.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
describe("Threads single-value edges", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify thread edge role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
  });
  afterAll(async () => {
    const failures: unknown[] = [];
    try {
      await runtime?.end();
    } catch (error) {
      failures.push(error);
    }
    try {
      await admin?.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Thread fixture cleanup failed");
  });
  it.each(["project", "company"])(
    "allows %s replay, rejects a second value and admits preparation without a caller",
    async (key) => {
      await runInTenant(tenant, async () => {
        const cp = createChokePoint(runtime);
        const databases = await cp.listDatabases();
        const db = (key: string) => {
          const result = databases.find((d) => d.ownerModuleId === key);
          if (!result) throw new Error(`Missing ${key}`);
          return result.id;
        };
        const property = (await cp.listProperties(db("threads"))).find((p) => p.key === key);
        if (!property) throw new Error(`Missing thread ${key} property`);
        const targetDatabase = db(key === "project" ? "projects" : "companies");
        const first = await cp.createItem({ databaseId: targetDatabase, properties: { name: "First" } });
        const second = await cp.createItem({ databaseId: targetDatabase, properties: { name: "Second" } });
        await withTransaction(runtime, (client) =>
          assertRelationTargetLinkableWithClient(client, { relationPropertyId: property.id, targetItemId: first.id }),
        );
        const thread = await withTransaction(runtime, (client) => createMailThread(client, "Subject"));
        const found = await withTransaction(runtime, (client) =>
          client.query<{ item_id: string }>(
            "SELECT item_id FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = $1",
            [thread.id],
          ),
        );
        const callerItemId = found.rows[0]?.item_id;
        if (!callerItemId) throw new Error("Missing thread item");
        const put = (targetItemId: string, metadata: Record<string, unknown>) =>
          withTransaction(runtime, (client) =>
            createRelationWithClient(client, { relationPropertyId: property.id, callerItemId, targetItemId, metadata }),
          );
        const edges = () =>
          withTransaction(runtime, async (client) => {
            const definition = await getRelationDefinitionByPropertyId(client, property.id);
            if (!definition) throw new Error("Missing relation definition");
            return listRelationsForItem(client, definition.id, callerItemId);
          });
        await put(first.id, { marker: "original" });
        const original = await edges();
        expect(original).toHaveLength(1);
        expect([original[0]?.itemA, original[0]?.itemB]).toContain(first.id);
        expect(original[0]?.metadata).toEqual({ marker: "original" });
        await put(first.id, { marker: "original" });
        expect(await edges()).toEqual(original);
        await expect(put(second.id, { marker: "different" })).rejects.toMatchObject({
          status: 400,
          code: "validation_failed",
          details: { field: key },
        });
        expect(await edges()).toEqual(original);
      });
    },
  );

  it("retains the winner's project and transfers incoming values with their metadata", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(runtime);
      const databases = await cp.listDatabases();
      const db = (key: string) => {
        const result = databases.find((entry) => entry.ownerModuleId === key);
        if (!result) throw new Error(`Missing ${key}`);
        return result.id;
      };
      const threadProject = (await cp.listProperties(db("threads"))).find((entry) => entry.key === "project");
      if (!threadProject) throw new Error("Missing thread project");
      const source = await cp.createDatabase({ name: "Related" });
      const related = await cp.createItem({ databaseId: source.id, properties: {} });
      const duplicateRelated = await cp.createItem({ databaseId: source.id, properties: {} });
      const trashedRelated = await cp.createItem({ databaseId: source.id, properties: {} });
      const { property: incoming } = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        targetDatabaseId: db("threads"),
        key: "thread",
        name: "Thread",
        cardinality: "many_to_many",
      });
      const firstProject = await cp.createItem({ databaseId: db("projects"), properties: { name: "First" } });
      const winningProject = await cp.createItem({ databaseId: db("projects"), properties: { name: "Winner" } });
      // The winner is created first: with two values of one kind the older thread's value is kept (issue gh-1869).
      const winner = await withTransaction(runtime, (client) => createMailThread(client, "Winning"));
      const loser = await withTransaction(runtime, (client) => createMailThread(client, "Losing"));
      const bindings = await withTransaction(runtime, (client) =>
        client.query<{ id: string; item_id: string }>(
          "SELECT id, item_id FROM mail_threads WHERE id = ANY($1::uuid[])",
          [[loser.id, winner.id]],
        ),
      );
      const loserItem = bindings.rows.find((row) => row.id === loser.id)?.item_id;
      const winnerItem = bindings.rows.find((row) => row.id === winner.id)?.item_id;
      if (!loserItem || !winnerItem) throw new Error("Missing thread bindings");
      await cp.createRelation({
        relationPropertyId: threadProject.id,
        callerItemId: loserItem,
        targetItemId: firstProject.id,
      });
      await cp.createRelation({
        relationPropertyId: threadProject.id,
        callerItemId: winnerItem,
        targetItemId: winningProject.id,
      });
      await cp.createRelation({
        relationPropertyId: incoming.id,
        callerItemId: related.id,
        targetItemId: loserItem,
        metadata: { source: "preserve" },
      });
      await cp.createRelation({
        relationPropertyId: incoming.id,
        callerItemId: duplicateRelated.id,
        targetItemId: loserItem,
        metadata: { source: "loser" },
      });
      await cp.createRelation({
        relationPropertyId: incoming.id,
        callerItemId: duplicateRelated.id,
        targetItemId: winnerItem,
        metadata: { source: "winner" },
      });
      await cp.createRelation({
        relationPropertyId: incoming.id,
        callerItemId: trashedRelated.id,
        targetItemId: loserItem,
        metadata: { source: "trashed" },
      });
      await cp.softDeleteItem(source.id, trashedRelated.id);
      await withTransaction(runtime, (client) => reassignThread(client, loser.id, winner.id));
      expect(await withTransaction(runtime, (client) => resolveMergedThreadId(client, loser.id))).toBe(winner.id);
      const results = await withTransaction(runtime, async (client) => {
        const projectDefinition = await getRelationDefinitionByPropertyId(client, threadProject.id);
        const incomingDefinition = await getRelationDefinitionByPropertyId(client, incoming.id);
        if (!projectDefinition || !incomingDefinition) throw new Error("Missing definitions");
        return {
          projects: await listRelationsForItem(client, projectDefinition.id, winnerItem),
          incoming: await listRelationsForItem(client, incomingDefinition.id, winnerItem),
          loser: await listRelationsForItem(client, incomingDefinition.id, loserItem),
        };
      });
      expect(results.projects).toHaveLength(1);
      expect([results.projects[0]?.itemA, results.projects[0]?.itemB]).toContain(winningProject.id);
      expect(results.incoming).toHaveLength(3);
      expect(results.incoming.map((edge) => edge.metadata)).toEqual(
        expect.arrayContaining([{ source: "preserve" }, { source: "winner" }, { source: "trashed" }]),
      );
      const retainedTrash = await withTransaction(runtime, (client) =>
        getItemById(client, source.id, trashedRelated.id),
      );
      expect(retainedTrash?.deletedAt).toBeTruthy();
      expect(results.loser).toEqual([]);
      const deleted = await withTransaction(runtime, (client) => getItemById(client, db("threads"), loserItem));
      expect(deleted?.deletedAt).toBeTruthy();
    });
  });

  it.each(["project", "company"])("keeps the winning %s or inherits it when absent", async (key) => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(runtime);
      const databases = await cp.listDatabases();
      const threads = databases.find((database) => database.ownerModuleId === "threads");
      const targets = databases.find(
        (database) => database.ownerModuleId === (key === "project" ? "projects" : "companies"),
      );
      if (!threads || !targets) throw new Error("Missing merge databases");
      const property = (await cp.listProperties(threads.id)).find((entry) => entry.key === key);
      if (!property) throw new Error(`Missing Threads.${key}`);
      const inherited = await cp.createItem({ databaseId: targets.id, properties: { name: "Inherited" } });
      const retained = await cp.createItem({ databaseId: targets.id, properties: { name: "Retained" } });
      const merge = async (winnerHasValue: boolean) => {
        // The winner is created first: with two values of one kind the older thread's value is kept (issue gh-1869).
        const winner = await withTransaction(runtime, (client) => createMailThread(client, "Winner"));
        const loser = await withTransaction(runtime, (client) => createMailThread(client, "Loser"));
        const rows = await withTransaction(runtime, (client) =>
          client.query<{ id: string; item_id: string }>(
            "SELECT id, item_id FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = ANY($1::uuid[])",
            [[loser.id, winner.id]],
          ),
        );
        const loserItem = rows.rows.find((row) => row.id === loser.id)?.item_id;
        const winnerItem = rows.rows.find((row) => row.id === winner.id)?.item_id;
        if (!loserItem || !winnerItem) throw new Error("Missing thread bindings");
        await cp.createRelation({
          relationPropertyId: property.id,
          callerItemId: loserItem,
          targetItemId: inherited.id,
        });
        if (winnerHasValue)
          await cp.createRelation({
            relationPropertyId: property.id,
            callerItemId: winnerItem,
            targetItemId: retained.id,
          });
        await withTransaction(runtime, (client) => reassignThread(client, loser.id, winner.id));
        const edges = await withTransaction(runtime, async (client) => {
          const definition = await getRelationDefinitionByPropertyId(client, property.id);
          if (!definition) throw new Error("Missing definition");
          return listRelationsForItem(client, definition.id, winnerItem);
        });
        expect(edges).toHaveLength(1);
        expect([edges[0]?.itemA, edges[0]?.itemB]).toContain(winnerHasValue ? retained.id : inherited.id);
        expect([edges[0]?.itemA, edges[0]?.itemB]).not.toContain(winnerHasValue ? inherited.id : retained.id);
        expect(
          (await withTransaction(runtime, (client) => getItemById(client, threads.id, loserItem)))?.deletedAt,
        ).toBeTruthy();
      };
      await merge(false);
      await merge(true);
    });
  });

  it("transfers a protected incoming edge without granting generic writes and rolls back hook refusal", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(runtime);
      const threads = (await cp.listDatabases()).find((database) => database.ownerModuleId === "threads");
      if (!threads) throw new Error("Missing Threads database");
      const source = await cp.createDatabase({ name: "Protected source" });
      const item = await cp.createItem({ databaseId: source.id, properties: {} });
      const { property } = await withTransaction(runtime, (client) =>
        createRelationPropertyWithClient(
          client,
          {
            sourceDatabaseId: source.id,
            targetDatabaseId: threads.id,
            key: "protectedThread",
            name: "Protected thread",
            cardinality: "many_to_many",
            owner: "system",
            ownerProcess: "fixtureOwner",
          },
          { ownerProcess: "fixtureOwner" },
        ),
      );
      const loser = await withTransaction(runtime, (client) => createMailThread(client, "Loser"));
      const winner = await withTransaction(runtime, (client) => createMailThread(client, "Winner"));
      const bindings = await withTransaction(runtime, (client) =>
        client.query<{ id: string; item_id: string }>(
          "SELECT id, item_id FROM mail_threads WHERE tenant_id = app_tenant_default() AND id = ANY($1::uuid[])",
          [[loser.id, winner.id]],
        ),
      );
      const loserItem = bindings.rows.find((row) => row.id === loser.id)?.item_id;
      const winnerItem = bindings.rows.find((row) => row.id === winner.id)?.item_id;
      if (!loserItem || !winnerItem) throw new Error("Missing thread bindings");
      const edge = {
        relationPropertyId: property.id,
        callerItemId: item.id,
        targetItemId: loserItem,
        metadata: { source: "protected" },
      };
      await expect(cp.createRelation(edge)).rejects.toMatchObject({ code: "owner_violation" });
      await withTransaction(runtime, (client) =>
        createRelationWithClient(client, edge, { ownerProcess: "fixtureOwner" }),
      );
      let refuse = true;
      let refusalCalls = 0;
      registerRelationEdgeWriteHook(async (context) => {
        if (refuse && context.edgeContext.property.id === property.id && context.targetItemId === winnerItem) {
          refusalCalls += 1;
          throw new Error("fixture domain refusal");
        }
      });
      try {
        await expect(
          withTransaction(runtime, async (client) => {
            await client.query("SAVEPOINT merge_attempt");
            try {
              await reassignThread(client, loser.id, winner.id);
            } catch {
              await client.query("ROLLBACK TO SAVEPOINT merge_attempt");
            }
          }),
        ).rejects.toThrow("fixture domain refusal");
        expect(refusalCalls).toBe(1);
        const original = await withTransaction(runtime, async (client) => {
          const definition = await getRelationDefinitionByPropertyId(client, property.id);
          if (!definition) throw new Error("Missing protected definition");
          return listRelationsForItem(client, definition.id, loserItem);
        });
        expect(original).toHaveLength(1);
        expect(original[0]?.metadata).toEqual({ source: "protected" });
        expect(
          (await withTransaction(runtime, (client) => getItemById(client, threads.id, loserItem)))?.deletedAt,
        ).toBeNull();
        expect(await withTransaction(runtime, (client) => resolveMergedThreadId(client, loser.id))).toBe(loser.id);
      } finally {
        refuse = false;
      }
      await withTransaction(runtime, (client) => reassignThread(client, loser.id, winner.id));
      const transferred = await withTransaction(runtime, async (client) => {
        const definition = await getRelationDefinitionByPropertyId(client, property.id);
        if (!definition) throw new Error("Missing protected definition");
        return listRelationsForItem(client, definition.id, winnerItem);
      });
      expect(transferred).toHaveLength(1);
      expect(transferred[0]?.metadata).toEqual({ source: "protected" });
      await expect(cp.createRelation({ ...edge, targetItemId: winnerItem })).rejects.toMatchObject({
        code: "owner_violation",
      });
    });
  });

  it("rolls the entire merge back after a caught cardinality failure and savepoint rollback", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(runtime);
      const threads = (await cp.listDatabases()).find((database) => database.ownerModuleId === "threads");
      if (!threads) throw new Error("Missing Threads database");
      const source = await cp.createDatabase({ name: "Cardinality" });
      const first = await cp.createItem({ databaseId: source.id, properties: {} });
      const second = await cp.createItem({ databaseId: source.id, properties: {} });
      const relation = await cp.createRelationProperty({
        sourceDatabaseId: source.id,
        targetDatabaseId: threads.id,
        key: "thread",
        name: "Thread",
        cardinality: "one_to_one",
      });
      const loser = await withTransaction(runtime, (client) => createMailThread(client, "Loser"));
      const winner = await withTransaction(runtime, (client) => createMailThread(client, "Winner"));
      const bindings = await withTransaction(runtime, (client) =>
        client.query<{ id: string; item_id: string }>(
          "SELECT id, item_id FROM mail_threads WHERE id = ANY($1::uuid[])",
          [[loser.id, winner.id]],
        ),
      );
      const loserItem = bindings.rows.find((row) => row.id === loser.id)?.item_id;
      const winnerItem = bindings.rows.find((row) => row.id === winner.id)?.item_id;
      if (!loserItem || !winnerItem) throw new Error("Missing Threads bindings");
      await cp.createRelation({
        relationPropertyId: relation.property.id,
        callerItemId: first.id,
        targetItemId: loserItem,
      });
      await cp.createRelation({
        relationPropertyId: relation.property.id,
        callerItemId: second.id,
        targetItemId: winnerItem,
      });
      await expect(
        withTransaction(runtime, async (client) => {
          await client.query("SAVEPOINT before_merge");
          try {
            await reassignThread(client, loser.id, winner.id);
            throw new Error("Expected cardinality failure");
          } catch (error) {
            expect(error).toMatchObject({ code: "cardinality_violation" });
            await client.query("ROLLBACK TO SAVEPOINT before_merge");
          }
        }),
      ).rejects.toMatchObject({ code: "cardinality_violation" });
      expect(await withTransaction(runtime, (client) => resolveMergedThreadId(client, loser.id))).toBe(loser.id);
      const definition = await withTransaction(runtime, (client) =>
        getRelationDefinitionByPropertyId(client, relation.property.id),
      );
      if (!definition) throw new Error("Missing relation definition");
      expect(
        await withTransaction(runtime, (client) => listRelationsForItem(client, definition.id, loserItem)),
      ).toHaveLength(1);
      expect(
        await withTransaction(runtime, (client) => listRelationsForItem(client, definition.id, winnerItem)),
      ).toHaveLength(1);
      expect(
        (await withTransaction(runtime, (client) => getItemById(client, threads.id, loserItem)))?.deletedAt,
      ).toBeNull();
    });
  });

  it("retains the value-link busy and rollback-only contract when a Threads endpoint is locked", async () => {
    await runInTenant(tenant, async () => {
      const cp = createChokePoint(runtime);
      const databases = await cp.listDatabases();
      const threads = databases.find((database) => database.ownerModuleId === "threads");
      const projects = databases.find((database) => database.ownerModuleId === "projects");
      if (!threads || !projects) throw new Error("Missing Threads or Projects");
      const project = await cp.createItem({ databaseId: projects.id, properties: { name: "Project" } });
      const property = (await cp.listProperties(threads.id)).find((entry) => entry.key === "project");
      if (!property) throw new Error("Missing Threads.project");
      const thread = await withTransaction(runtime, (client) => createMailThread(client, "Busy"));
      const binding = await withTransaction(runtime, (client) =>
        client.query<{ item_id: string }>("SELECT item_id FROM mail_threads WHERE id = $1", [thread.id]),
      );
      const itemId = binding.rows[0]?.item_id;
      if (!itemId) throw new Error("Missing Threads binding");
      await withTransaction(runtime, (client) =>
        insertValueLink(client, { itemId, propertyKey: "project", ruleKey: "test", sources: [] }),
      );
      let release!: () => void;
      let ready!: (pid: number) => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = new Promise<number>((resolve) => {
        ready = resolve;
      });
      const holder = withTransaction(runtime, async (client) => {
        const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const item = await lockItemById(client, threads.id, itemId);
        if (!pid.rows[0] || !item) throw new Error("Missing Threads lock owner");
        ready(pid.rows[0].pid);
        await gate;
      });
      const failures: unknown[] = [];
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let ownerPid: number;
        try {
          ownerPid = await Promise.race([
            locked,
            holder.then(() => {
              throw new Error("Lock holder exited early");
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Threads lock barrier timed out")), 5000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
        await expect(
          withTransaction(runtime, async (client) => {
            const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            expect(pid.rows[0]?.pid).not.toBe(ownerPid);
            await client.query("SAVEPOINT before_value_link");
            try {
              await createRelationWithClient(
                client,
                { relationPropertyId: property.id, callerItemId: itemId, targetItemId: project.id },
                { ownerProcess: VALUE_LINKS_OWNER_PROCESS },
              );
              throw new Error("Expected value_link_busy");
            } catch (error) {
              expect(error).toMatchObject({ code: "value_link_busy" });
              await client.query("ROLLBACK TO SAVEPOINT before_value_link");
            }
          }),
        ).rejects.toMatchObject({ code: "value_link_busy" });
      } catch (error) {
        failures.push(error);
      }
      release();
      try {
        await holder;
      } catch (error) {
        if (!failures.includes(error)) failures.push(error);
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Value-link overlap or cleanup failed");
      const links = await withTransaction(runtime, (client) => listValueLinksByItemIds(client, [itemId]));
      expect(links).toHaveLength(1);
      expect(links[0]?.state).toBe("on");
      const definition = await withTransaction(runtime, (client) =>
        getRelationDefinitionByPropertyId(client, property.id),
      );
      if (!definition) throw new Error("Missing Threads.project definition");
      expect(await withTransaction(runtime, (client) => listRelationsForItem(client, definition.id, itemId))).toEqual(
        [],
      );
    });
  });

  it("orders incoming writers and merges even for a definition created after discovery", async () => {
    const foreignTenant = await createTestTenant(admin);
    await runInTenant(foreignTenant, () => seedSystem(runtime));
    let startForeign!: () => void;
    const foreignGate = new Promise<void>((resolve) => {
      startForeign = resolve;
    });
    const foreignOutcome = runInTenant(foreignTenant, async () => {
      await foreignGate;
      return withTransaction(runtime, (client) => createMailThread(client, "Other tenant"));
    }).then(
      (thread) => ({ ok: true as const, thread }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const allFailures: unknown[] = [];
    try {
      await runInTenant(tenant, async () => {
        const cp = createChokePoint(runtime);
        const threads = (await cp.listDatabases()).find((database) => database.ownerModuleId === "threads");
        if (!threads) throw new Error("Missing Threads database");
        const relatedDb = await cp.createDatabase({ name: "Related" });
        const related = await cp.createItem({ databaseId: relatedDb.id, properties: {} });
        const initialProperty = await cp.createRelationProperty({
          sourceDatabaseId: relatedDb.id,
          targetDatabaseId: threads.id,
          key: "initialThread",
          name: "Initial thread",
          cardinality: "many_to_many",
        });
        async function threadPair() {
          const loser = await withTransaction(runtime, (client) => createMailThread(client, "Loser"));
          const winner = await withTransaction(runtime, (client) => createMailThread(client, "Winner"));
          const rows = await withTransaction(runtime, (client) =>
            client.query<{ id: string; item_id: string }>(
              "SELECT id, item_id FROM mail_threads WHERE id = ANY($1::uuid[])",
              [[loser.id, winner.id]],
            ),
          );
          const losingItem = rows.rows.find((row) => row.id === loser.id)?.item_id;
          const winningItem = rows.rows.find((row) => row.id === winner.id)?.item_id;
          if (!losingItem || !winningItem) throw new Error("Missing Threads bindings");
          return { loser: loser.id, winner: winner.id, losingItem, winningItem };
        }
        async function observeBlock(blocker: number, waiter: number) {
          for (let i = 0; i < 100; i++) {
            const state = await runtime.query<{ blocked: boolean }>(
              "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
              [blocker, waiter],
            );
            if (state.rows[0]?.blocked) return;
            await new Promise<void>((resolve) => setTimeout(resolve, 25));
          }
          throw new Error("Expected transaction to wait for its owned blocker");
        }
        async function bounded<T>(promise: Promise<T>): Promise<T> {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              promise,
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error("Thread overlap barrier timed out")), 5000);
              }),
            ]);
          } finally {
            if (timer) clearTimeout(timer);
          }
        }
        const first = await threadPair();
        let releaseWriter!: () => void;
        let writerReady!: (pid: number) => void;
        const writerGate = new Promise<void>((resolve) => {
          releaseWriter = resolve;
        });
        const writerLocked = new Promise<number>((resolve) => {
          writerReady = resolve;
        });
        const writer = withTransaction(runtime, async (client) => {
          const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          await createRelationWithClient(client, {
            relationPropertyId: initialProperty.property.id,
            callerItemId: related.id,
            targetItemId: first.losingItem,
            metadata: { source: "earlier" },
          });
          if (!pid.rows[0]) throw new Error("Missing writer PID");
          writerReady(pid.rows[0].pid);
          await writerGate;
        });
        let merge: Promise<void> | undefined;
        const firstFailures: unknown[] = [];
        try {
          const writerPid = await bounded(
            Promise.race([
              writerLocked,
              writer.then(() => {
                throw new Error("Writer exited early");
              }),
            ]),
          );
          let mergeReady!: (pid: number) => void;
          const mergeStarted = new Promise<number>((resolve) => {
            mergeReady = resolve;
          });
          merge = withTransaction(runtime, async (client) => {
            const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            if (!pid.rows[0]) throw new Error("Missing merge PID");
            mergeReady(pid.rows[0].pid);
            await reassignThread(client, first.loser, first.winner);
          });
          try {
            const mergePid = await bounded(
              Promise.race([
                mergeStarted,
                merge.then(() => {
                  throw new Error("Merge exited early");
                }),
              ]),
            );
            expect(mergePid).not.toBe(writerPid);
            await observeBlock(writerPid, mergePid);
          } finally {
            releaseWriter();
          }
          await writer;
          await merge;
          const definition = await withTransaction(runtime, (client) =>
            getRelationDefinitionByPropertyId(client, initialProperty.property.id),
          );
          if (!definition) throw new Error("Missing initial definition");
          const edges = await withTransaction(runtime, (client) =>
            listRelationsForItem(client, definition.id, first.winningItem),
          );
          expect(edges).toHaveLength(1);
          expect(edges[0]?.metadata).toEqual({ source: "earlier" });
        } catch (error) {
          firstFailures.push(error);
        }
        releaseWriter();
        for (const pending of [writer, merge])
          if (pending) {
            try {
              await pending;
            } catch (error) {
              if (!firstFailures.includes(error)) firstFailures.push(error);
            }
          }
        if (firstFailures.length === 1) throw firstFailures[0];
        if (firstFailures.length > 1) throw new AggregateError(firstFailures, "Writer-first merge or cleanup failed");

        const second = await threadPair();
        const unrelated = await withTransaction(runtime, (client) => createMailThread(client, "Unrelated"));
        const unrelatedBinding = await withTransaction(runtime, (client) =>
          client.query<{ item_id: string }>("SELECT item_id FROM mail_threads WHERE id = $1", [unrelated.id]),
        );
        const unrelatedItem = unrelatedBinding.rows[0]?.item_id;
        if (!unrelatedItem) throw new Error("Missing unrelated Threads item");
        let releaseMerge!: () => void;
        let mergedReady!: (pid: number) => void;
        const mergeGate = new Promise<void>((resolve) => {
          releaseMerge = resolve;
        });
        const merged = new Promise<number>((resolve) => {
          mergedReady = resolve;
        });
        const holdingMerge = withTransaction(runtime, async (client) => {
          const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          await reassignThread(client, second.loser, second.winner);
          if (!pid.rows[0]) throw new Error("Missing merge PID");
          mergedReady(pid.rows[0].pid);
          await mergeGate;
        });
        let lateOutcome: Promise<unknown> | undefined;
        const secondFailures: unknown[] = [];
        try {
          const mergePid = await bounded(
            Promise.race([
              merged,
              holdingMerge.then(() => {
                throw new Error("Merge exited early");
              }),
            ]),
          );
          const lateProperty = await cp.createRelationProperty({
            sourceDatabaseId: relatedDb.id,
            targetDatabaseId: threads.id,
            key: "lateThread",
            name: "Late thread",
            cardinality: "many_to_many",
          });
          startForeign();
          const foreign = await bounded(foreignOutcome);
          if (!foreign.ok) throw foreign.error;
          expect(foreign.thread.id).toBeTruthy();
          await cp.createRelation({
            relationPropertyId: lateProperty.property.id,
            callerItemId: related.id,
            targetItemId: unrelatedItem,
          });
          let lateReady!: (pid: number) => void;
          const lateStarted = new Promise<number>((resolve) => {
            lateReady = resolve;
          });
          const late = withTransaction(runtime, async (client) => {
            const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            if (!pid.rows[0]) throw new Error("Missing late writer PID");
            lateReady(pid.rows[0].pid);
            await createRelationWithClient(client, {
              relationPropertyId: lateProperty.property.id,
              callerItemId: related.id,
              targetItemId: second.losingItem,
            });
          });
          lateOutcome = late.then(
            () => null,
            (error: unknown) => error,
          );
          try {
            const latePid = await bounded(
              Promise.race([
                lateStarted,
                late.then(() => {
                  throw new Error("Writer exited early");
                }),
              ]),
            );
            expect(latePid).not.toBe(mergePid);
            await observeBlock(mergePid, latePid);
          } finally {
            releaseMerge();
          }
          await holdingMerge;
          expect(await lateOutcome).toMatchObject({ status: 404 });
          const definition = await withTransaction(runtime, (client) =>
            getRelationDefinitionByPropertyId(client, lateProperty.property.id),
          );
          if (!definition) throw new Error("Missing late definition");
          expect(
            await withTransaction(runtime, (client) => listRelationsForItem(client, definition.id, second.losingItem)),
          ).toEqual([]);
        } catch (error) {
          secondFailures.push(error);
        }
        releaseMerge();
        try {
          await holdingMerge;
        } catch (error) {
          if (!secondFailures.includes(error)) secondFailures.push(error);
        }
        if (lateOutcome) await lateOutcome;
        if (secondFailures.length === 1) throw secondFailures[0];
        if (secondFailures.length > 1) throw new AggregateError(secondFailures, "Merge-first writer or cleanup failed");

        for (const mutation of ["update", "delete", "rollback"] as const) {
          const pair = await threadPair();
          const edge = {
            relationPropertyId: initialProperty.property.id,
            callerItemId: related.id,
            targetItemId: pair.losingItem,
          };
          await cp.createRelation({ ...edge, metadata: { version: "original" } });
          let release!: () => void;
          let started!: (pid: number) => void;
          const gate = new Promise<void>((resolve) => {
            release = resolve;
          });
          const ready = new Promise<number>((resolve) => {
            started = resolve;
          });
          const rollback = new Error("rollback thread relation mutation");
          const writing = withTransaction(runtime, async (client) => {
            const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
            if (!pid.rows[0]) throw new Error("Missing mutation PID");
            if (mutation === "delete") await deleteRelationWithClient(client, edge);
            else await updateRelationWithClient(client, { ...edge, metadata: { version: "updated" } });
            started(pid.rows[0].pid);
            await gate;
            if (mutation === "rollback") throw rollback;
          });
          const writerOutcome = writing.then(
            () => null,
            (error: unknown) => error,
          );
          let merging: Promise<unknown> | undefined;
          const failures: unknown[] = [];
          try {
            const writerPid = await bounded(
              Promise.race([
                ready,
                writerOutcome.then(() => {
                  throw new Error("Mutation exited early");
                }),
              ]),
            );
            let mergeStarted!: (pid: number) => void;
            const mergeReady = new Promise<number>((resolve) => {
              mergeStarted = resolve;
            });
            merging = withTransaction(runtime, async (client) => {
              const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
              if (!pid.rows[0]) throw new Error("Missing merge PID");
              mergeStarted(pid.rows[0].pid);
              await reassignThread(client, pair.loser, pair.winner);
            }).then(
              () => null,
              (error: unknown) => error,
            );
            const mergePid = await bounded(mergeReady);
            expect(mergePid).not.toBe(writerPid);
            await observeBlock(writerPid, mergePid);
          } catch (error) {
            failures.push(error);
          }
          release();
          const writerError = await writerOutcome;
          if (mutation === "rollback") {
            if (writerError !== rollback)
              failures.push(new Error("Mutation did not fail with the expected rollback", { cause: writerError }));
          } else if (writerError) failures.push(writerError);
          if (merging) {
            const mergeError = await merging;
            if (mergeError) failures.push(mergeError);
          }
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures, "Thread mutation overlap failed");
          const definition = await withTransaction(runtime, (client) =>
            getRelationDefinitionByPropertyId(client, initialProperty.property.id),
          );
          if (!definition) throw new Error("Missing mutation definition");
          const retained = await withTransaction(runtime, (client) =>
            listRelationsForItem(client, definition.id, pair.winningItem),
          );
          expect(retained.map((entry) => entry.metadata)).toEqual(
            mutation === "delete" ? [] : [{ version: mutation === "rollback" ? "original" : "updated" }],
          );
          expect(await withTransaction(runtime, (client) => resolveMergedThreadId(client, pair.loser))).toBe(
            pair.winner,
          );
        }
      });
    } catch (error) {
      allFailures.push(error);
    }
    startForeign();
    const foreign = await foreignOutcome;
    if (!foreign.ok && !allFailures.includes(foreign.error)) allFailures.push(foreign.error);
    if (allFailures.length === 1) throw allFailures[0];
    if (allFailures.length > 1) throw new AggregateError(allFailures, "Cross-tenant overlap or cleanup failed");
  });
});
