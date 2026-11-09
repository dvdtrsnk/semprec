import "../domainWriteHooks.js";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { listRelationsForItem, getRelationDefinitionByPropertyId, otherSide } from "../chokePoint/relationsStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import { insertItem, softDeleteItem } from "../chokePoint/itemsStore.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;

describe("Inbox type lock", () => {
  beforeEach(async () => {
    admin ??= getTestPool();
    pool ??= await createRuntimeRolePool(admin, "semprec_data");
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  async function fixture(status?: string, trash = false) {
    const cp = createChokePoint(pool);
    const ids = await pool.query<{ id: string; owner_module_id: string }>(
      "SELECT id, owner_module_id FROM databases WHERE owner_module_id = ANY($1::text[])",
      [["inbox", "inboxItemTypes", "processingProposals"]],
    );
    const id = (key: string) => {
      const row = ids.rows.find((entry) => entry.owner_module_id === key);
      if (!row) throw new Error("Missing seeded database");
      return row.id;
    };
    const inbox = id("inbox"),
      types = id("inboxItemTypes"),
      proposals = id("processingProposals");
    const makeType = (name: string) =>
      withTransaction(pool, (client) =>
        createInboxTypeWithClient(client, {
          inboxItemTypesDatabaseId: types,
          name,
          emoji: "x",
          processingMethod: "database",
          targetDatabase: "tasks",
        }),
      );
    const first = await makeType("First");
    const second = await makeType("Second");
    const item = await withTransaction(pool, (client) =>
      createInboxItemWithClient(client, { inboxDatabaseId: inbox, date: "2026-10-01", time: "10:00", type: first.id }),
    );
    const type = (await cp.listProperties(inbox)).find((p) => p.key === "type");
    const source = (await cp.listProperties(proposals)).find((p) => p.key === "sourceInbox");
    if (!type || !source) throw new Error("Missing seeded relation");
    let cardId: string | undefined;
    if (status) {
      // Synthetic historical card: the public API cannot create a card directly in a decided state.
      const card = await withTransaction(pool, (client) =>
        insertItem(client, {
          databaseId: proposals,
          properties: { kind: "inbox", fingerprint: "test", proposal: {}, history: [], status },
        }),
      );
      cardId = card.id;
      await withTransaction(pool, (client) =>
        createRelationWithClient(
          client,
          { relationPropertyId: source.id, callerItemId: card.id, targetItemId: item.id },
          { ownerProcess: PROCESSING_PROPOSALS_MODULE_ID },
        ),
      );
      if (trash) await withTransaction(pool, (client) => softDeleteItem(client, proposals, card.id));
    }
    const edge = { relationPropertyId: type.id, callerItemId: item.id, targetItemId: first.id };
    const targets = () =>
      withTransaction(pool, async (client) => {
        const definition = await getRelationDefinitionByPropertyId(client, type.id);
        if (!definition) throw new Error("Missing type definition");
        return (await listRelationsForItem(client, definition.id, item.id)).map((relation) =>
          otherSide(relation, item.id),
        );
      });
    return { cp, edge, second: second.id, targets, cardId, proposals };
  }

  it("refuses a second type without changing the first edge", async () =>
    runInTenant(tenant, async () => {
      const { cp, edge, second, targets } = await fixture();
      await expect(cp.createRelation({ ...edge, targetItemId: second })).rejects.toMatchObject({
        status: 409,
        code: "cardinality_violation",
      });
      expect(await targets()).toEqual([edge.targetItemId]);
    }));

  it.each(["confirmed", "rejected"])("preserves the edge for a %s card", async (status) =>
    runInTenant(tenant, async () => {
      const { cp, edge, second, targets } = await fixture(status);
      await expect(cp.deleteRelation(edge)).rejects.toMatchObject({ status: 409, code: "proposal_locked" });
      await expect(cp.createRelation({ ...edge, targetItemId: second })).rejects.toMatchObject({
        status: 409,
        code: "proposal_locked",
      });
      expect(await targets()).toEqual([edge.targetItemId]);
    }),
  );

  it.each([
    [undefined, false],
    ["proposed", false],
    ["confirmed", true],
  ] as const)("allows a type change for status %s trashed=%s", async (status, trash) =>
    runInTenant(tenant, async () => {
      const { cp, edge, second, targets } = await fixture(status, trash);
      expect(await cp.deleteRelation(edge)).not.toBeNull();
      expect((await cp.createRelation({ ...edge, targetItemId: second })).itemB).toBe(second);
      expect(await targets()).toEqual([second]);
    }),
  );

  it("returns a version conflict without changing the edge when a candidate card is reserved", async () =>
    runInTenant(tenant, async () => {
      const { cp, edge, targets, cardId, proposals } = await fixture("proposed");
      if (!cardId) throw new Error("Missing proposal card");
      let release = () => {};
      let signalReady: (identity: { pid: number; started: string }) => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<{ pid: number; started: string }>((resolve) => {
        signalReady = resolve;
      });
      const holder = withTransaction(pool, async (client) => {
        await client.query("SET LOCAL lock_timeout = '5s'");
        const identity = await client.query<{ pid: number; started: string }>(
          "SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()",
        );
        if (!identity.rows[0]) throw new Error("Missing holder identity");
        await client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE", [proposals, cardId]);
        signalReady(identity.rows[0]);
        await gate;
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let failure: { error: unknown } | undefined;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const identity = await Promise.race([
          ready,
          holder.then((outcome) => {
            throw outcome.ok ? new Error("Holder ended early") : outcome.error;
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Holder did not reserve card")), 5000);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        const observed = await admin.query<{ present: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start::text = $2) AS present",
          [identity.pid, identity.started],
        );
        expect(observed.rows).toEqual([{ present: true }]);
        await expect(cp.deleteRelation(edge)).rejects.toMatchObject({
          status: 409,
          code: "version_conflict",
          details: { field: "type" },
        });
        expect(await targets()).toEqual([edge.targetItemId]);
      } catch (error) {
        failure = { error };
      }
      release();
      const outcome = await holder;
      if (!outcome.ok && failure)
        throw new AggregateError([failure.error, outcome.error], "Reservation test and holder failed", {
          cause: failure.error,
        });
      if (!outcome.ok) throw outcome.error;
      if (failure) throw failure.error;
      expect(await targets()).toEqual([edge.targetItemId]);
    }));

  it("does not let another tenant delete an Inbox type edge", async () => {
    const own = await runInTenant(tenant, () => fixture("proposed"));
    const other = await createTestTenant(admin);
    await runInTenant(other, () => seedSystem(pool, createViewTypeRegistry()));
    const error = await runInTenant(other, () =>
      own.cp.deleteRelation(own.edge).then(
        () => null,
        (caught: unknown) => caught,
      ),
    );
    expect(error).toMatchObject({ status: 404 });
    expect(await runInTenant(tenant, () => own.targets())).toEqual([own.edge.targetItemId]);
  });
});
