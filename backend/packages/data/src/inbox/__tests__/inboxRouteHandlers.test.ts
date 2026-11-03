import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { setInvalidationHook, type InvalidationEvent } from "../../realtimeHook.js";
import { getTenantZeroId, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createPool, withTransaction } from "../../db/pool.js";
import { runInTenant } from "@semprec/shared";
import { renameDatabase } from "../../chokePoint/databasesStore.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { createInboxTypeWithClient, type CreateInboxTypeInput } from "../inboxTypesStore.js";
import { createSemprecTickAction, type ComputeSemprecProposalFn } from "../inboxTickAction.js";
import { createConfirmProposalRouteHandler, createInboxTypesRouteHandler } from "../inboxRouteHandlers.js";
import { NotFoundError, ValidationError } from "../../errors.js";
import type { ItemRow } from "../../types.js";

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

/**
 * Issue #239's `inboxPipeline`-owned custom-route handler factories, exercised directly against
 * the real functions they thinly wrap (#105's `confirmProposalWithClient`, #101's
 * `listActiveInboxTypes`) — the HTTP-level auth/mounting mechanics these are cast into an
 * `AdapterHandler` for are covered separately by `customRouteMount.test.ts` and
 * `routeMatrix.test.ts` in `semprec-api`.
 */
describe("inbox custom route handlers (issue #239)", () => {
  let inboxId: string;
  let typesId: string;
  let proposalsId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function createDatabaseProposal(text: string): Promise<string> {
    const type = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, {
        inboxDatabaseId: inboxId,
        date: "2026-08-28",
        time: "09:00",
        text,
        type: type.id,
      }),
    );
    const computeProposal: ComputeSemprecProposalFn = async () => ({ properties: { name: text } });
    const handler = createSemprecTickAction(pool, computeProposal);
    await handler(
      { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
      { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
    );
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM items WHERE database_id = $1 ORDER BY updated_at DESC LIMIT 1`,
      [proposalsId],
    );
    return rows[0]!.id;
  }

  describe("createConfirmProposalRouteHandler", () => {
    it("attributes a confirmed page block to the user through the runtime role", async () => {
      const dataPool = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
      try {
        await runInTenant(getTenantZeroId(), async () => {
          const type = await withTransaction(dataPool, (client) =>
            createInboxTypeWithClient(client, {
              inboxItemTypesDatabaseId: typesId,
              name: "Note",
              emoji: "N",
              processingMethod: "pageContent",
            }),
          );
          const source = await withTransaction(dataPool, (client) =>
            createInboxItemWithClient(client, {
              inboxDatabaseId: inboxId,
              date: "2026-08-28",
              time: "09:00",
              text: "A thought",
              type: type.id,
            }),
          );
          const tick = createSemprecTickAction(dataPool, async () => ({
            target: type.id,
            properties: { flavour: "paragraph", fields: { content: "A thought" } },
          }));
          await tick(
            { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
            { heartbeatId: "hb", projectItemId: "proj", itemId: source.id },
          );
          const proposal = await withTransaction(dataPool, async (client) => {
            const { rows } = await client.query<{ id: string }>(
              "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL",
              [proposalsId],
            );
            expect(rows).toHaveLength(1);
            return rows[0]!.id;
          });
          const response = await createConfirmProposalRouteHandler(dataPool)({ params: { id: proposal }, body: {} });
          expect(response.status).toBe(200);
          const updates = await withTransaction(dataPool, async (client) => {
            const { rows } = await client.query<{ created_by: string }>(
              "SELECT u.created_by FROM doc_updates u JOIN docs d ON d.id = u.doc_id WHERE d.item_id = $1",
              [type.id],
            );
            return rows;
          });
          expect(updates).toEqual([{ created_by: "user" }]);
        });
      } finally {
        await dataPool.end();
      }
    });
    it("confirms a pending proposal, a thin mapping onto confirmProposalWithClient", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const handler = createConfirmProposalRouteHandler(pool);

      const result = await handler({ params: { id: proposalId }, body: {} });

      expect(result.status).toBe(200);
      expect("item" in result && result.item.properties.status).toBe("confirmed");
      expect("item" in result && typeof result.item.properties.resultItemId).toBe("string");
    });

    it("addresses realtime invalidation to the authenticated user", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const handler = createConfirmProposalRouteHandler(pool);
      const userId = randomUUID();
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await handler({ params: { id: proposalId }, body: {}, identity: { user: { id: userId } } });
      } finally {
        setInvalidationHook(() => {});
      }
      const itemEvents = events.filter((event) => event.scope === "item");
      expect(itemEvents.length).toBeGreaterThanOrEqual(2);
      expect(itemEvents.every((event) => event.userId === userId)).toBe(true);
    });

    it("rejects a request with no `id` path parameter", async () => {
      const handler = createConfirmProposalRouteHandler(pool);
      await expect(handler({ params: {}, body: {} })).rejects.toThrow(ValidationError);
    });

    it("rejects an unknown proposal id", async () => {
      const handler = createConfirmProposalRouteHandler(pool);
      await expect(handler({ params: { id: "00000000-0000-0000-0000-000000000000" }, body: {} })).rejects.toThrow(
        NotFoundError,
      );
    });

    it("rejects a credential missing a plaintext", async () => {
      const proposalId = await createDatabaseProposal("Buy milk");
      const handler = createConfirmProposalRouteHandler(pool);

      await expect(
        handler({ params: { id: proposalId }, body: { credential: { credentialType: "bearer_token" } } }),
      ).rejects.toThrow(ValidationError);
    });
  });

  describe("createInboxTypesRouteHandler (issue #1439)", () => {
    /** The adapter always supplies the caller; this handler reads only its locale. */
    const callerIn = (locale: string) => ({ identity: { user: { locale } } });

    async function createActiveType(
      name: string,
      processing: Pick<CreateInboxTypeInput, "processingMethod" | "targetDatabase">,
    ): Promise<ItemRow> {
      return withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name,
          emoji: "☑️",
          status: "active",
          ...processing,
        }),
      );
    }

    /**
     * A raw UPDATE: since issue #1436 the choke point refuses an unknown target, so this is the stored
     * state an older write could leave behind.
     */
    async function storeTargetDirectly(itemId: string, target: string): Promise<void> {
      const { rows } = await pool.query<{ id: string }>(
        `UPDATE items SET properties = jsonb_set(properties, '{targetDatabase}', to_jsonb($3::text))
         WHERE database_id = $1 AND id = $2
         RETURNING id`,
        [typesId, itemId, target],
      );
      if (rows.length !== 1) throw new Error(`Inbox item type ${itemId} was not found`);
    }

    it("lists an active database type with its method, target key and label in cs and en", async () => {
      const type = await createActiveType("Task", { processingMethod: "database", targetDatabase: "tasks" });
      const handler = createInboxTypesRouteHandler(pool);

      expect(await handler(callerIn("cs"))).toEqual({
        status: 200,
        body: {
          types: [
            {
              id: type.id,
              emoji: "☑️",
              label: "Task",
              processingMethod: "database",
              targetDatabaseKey: "tasks",
              targetLabel: "Úkoly",
            },
          ],
        },
      });
      expect(await handler(callerIn("en"))).toEqual({
        status: 200,
        body: {
          types: [
            {
              id: type.id,
              emoji: "☑️",
              label: "Task",
              processingMethod: "database",
              targetDatabaseKey: "tasks",
              targetLabel: "Tasks",
            },
          ],
        },
      });
    });

    it("returns a pageContent type with method pageContent and null target key and label", async () => {
      const type = await createActiveType("Note", { processingMethod: "pageContent" });

      expect(await createInboxTypesRouteHandler(pool)(callerIn("cs"))).toEqual({
        status: 200,
        body: {
          types: [
            {
              id: type.id,
              emoji: "☑️",
              label: "Note",
              processingMethod: "pageContent",
              targetDatabaseKey: null,
              targetLabel: null,
            },
          ],
        },
      });
    });

    it("returns the key itself as the label of a stored target the catalog does not know, without failing the list", async () => {
      const unknown = await createActiveType("Old", { processingMethod: "database", targetDatabase: "tasks" });
      await storeTargetDirectly(unknown.id, "nonsense");
      const known = await createActiveType("Task", { processingMethod: "database", targetDatabase: "tasks" });

      expect(await createInboxTypesRouteHandler(pool)(callerIn("en"))).toEqual({
        status: 200,
        body: {
          types: expect.arrayContaining([
            {
              id: unknown.id,
              emoji: "☑️",
              label: "Old",
              processingMethod: "database",
              targetDatabaseKey: "nonsense",
              targetLabel: "nonsense",
            },
            {
              id: known.id,
              emoji: "☑️",
              label: "Task",
              processingMethod: "database",
              targetDatabaseKey: "tasks",
              targetLabel: "Tasks",
            },
          ]),
        },
      });
    });

    it("labels every type that shares a target with that target's label", async () => {
      const first = await createActiveType("Task", { processingMethod: "database", targetDatabase: "tasks" });
      const second = await createActiveType("Errand", { processingMethod: "database", targetDatabase: "tasks" });

      expect(await createInboxTypesRouteHandler(pool)(callerIn("cs"))).toEqual({
        status: 200,
        body: {
          types: expect.arrayContaining([
            {
              id: first.id,
              emoji: "☑️",
              label: "Task",
              processingMethod: "database",
              targetDatabaseKey: "tasks",
              targetLabel: "Úkoly",
            },
            {
              id: second.id,
              emoji: "☑️",
              label: "Errand",
              processingMethod: "database",
              targetDatabaseKey: "tasks",
              targetLabel: "Úkoly",
            },
          ]),
        },
      });
    });

    it("uses a target database's own name over its catalog label", async () => {
      const tasksId = await databaseIdFor("tasks");
      await withTransaction(pool, (client) => renameDatabase(client, tasksId, "My tasks"));
      const type = await createActiveType("Task", { processingMethod: "database", targetDatabase: "tasks" });

      expect(await createInboxTypesRouteHandler(pool)(callerIn("cs"))).toEqual({
        status: 200,
        body: {
          types: [
            {
              id: type.id,
              emoji: "☑️",
              label: "Task",
              processingMethod: "database",
              targetDatabaseKey: "tasks",
              targetLabel: "My tasks",
            },
          ],
        },
      });
    });

    it("excludes archived types, and the list holds only the active one", async () => {
      const active = await createActiveType("Task", { processingMethod: "database", targetDatabase: "tasks" });
      await withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: typesId,
          name: "Old",
          emoji: "🗑️",
          status: "archived",
          processingMethod: "pageContent",
        }),
      );

      expect(await createInboxTypesRouteHandler(pool)(callerIn("en"))).toEqual({
        status: 200,
        body: {
          types: [
            {
              id: active.id,
              emoji: "☑️",
              label: "Task",
              processingMethod: "database",
              targetDatabaseKey: "tasks",
              targetLabel: "Tasks",
            },
          ],
        },
      });
    });
  });
});
