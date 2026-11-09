import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
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
import { createSemprecTickAction } from "../inbox/inboxTickAction.js";
import { confirmProposalWithClient } from "../inbox/proposalActions.js";
import { createInboxTypeWithClient, deleteInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import { getItemById, insertItem, softDeleteItem } from "../chokePoint/itemsStore.js";
import { PROCESSING_PROPOSALS_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { setInvalidationHook, type InvalidationEvent } from "../realtimeHook.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
const pendingRaceActors = new Set<Promise<unknown>>();

function trackRaceActor<T>(actor: Promise<T>): void {
  pendingRaceActors.add(actor);
  void actor.then(
    () => pendingRaceActors.delete(actor),
    () => pendingRaceActors.delete(actor),
  );
}

async function boundRace<T>(actor: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      actor,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Race actor did not settle")), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("Inbox type lock", () => {
  beforeEach(async () => {
    if (pendingRaceActors.size) throw new Error("A prior race actor remains unsettled");
    admin ??= getTestPool();
    pool ??= await createRuntimeRolePool(admin, "semprec_data");
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
  });
  afterAll(async () => {
    if (pendingRaceActors.size) throw new Error("A race actor remains unsettled; pools remain open");
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
    return { cp, edge, second: second.id, targets, cardId, proposals, inbox, types };
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

  it.each([
    ["proposed", false],
    ["confirmed", true],
  ] as const)(
    "returns a version conflict when a candidate card is reserved (%s, trashed=%s)",
    async (status, trashed) =>
      runInTenant(tenant, async () => {
        const { cp, edge, targets, cardId, proposals, inbox, types } = await fixture(status, trashed);
        if (!cardId) throw new Error("Missing proposal card");
        const jobsBefore = await admin.query<{ key: string | null }>(
          "SELECT key FROM graphile_worker.jobs ORDER BY key NULLS FIRST",
        );
        const invalidations: InvalidationEvent[] = [];
        setInvalidationHook((event) => invalidations.push(event));
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
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz) AS present",
            [identity.pid, identity.started],
          );
          expect(observed.rows).toEqual([{ present: true }]);
          await expect(cp.deleteRelation(edge)).rejects.toMatchObject({
            status: 409,
            code: "version_conflict",
            details: { field: "type" },
          });
          expect(await targets()).toEqual([edge.targetItemId]);
          await expect(
            withTransaction(pool, (client) =>
              deleteInboxTypeWithClient(client, {
                inboxDatabaseId: inbox,
                inboxItemTypesDatabaseId: types,
                processingProposalsDatabaseId: proposals,
                typeItemId: edge.targetItemId,
              }),
            ),
          ).rejects.toMatchObject({ status: 409, code: "version_conflict", details: { field: "type" } });
          expect(
            (
              await pool.query<{ deleted: boolean }>(
                "SELECT deleted_at IS NOT NULL AS deleted FROM items WHERE database_id = $1 AND id = $2",
                [types, edge.targetItemId],
              )
            ).rows,
          ).toEqual([{ deleted: false }]);
          expect(
            (await admin.query<{ key: string | null }>("SELECT key FROM graphile_worker.jobs ORDER BY key NULLS FIRST"))
              .rows,
          ).toEqual(jobsBefore.rows);
          expect(await targets()).toEqual([edge.targetItemId]);
          expect(invalidations).toEqual([]);
        } catch (error) {
          failure = { error };
        }
        release();
        const outcome = await holder;
        setInvalidationHook(() => {});
        if (!outcome.ok && failure)
          throw new AggregateError([failure.error, outcome.error], "Reservation test and holder failed", {
            cause: failure.error,
          });
        if (!outcome.ok) throw outcome.error;
        if (failure) throw failure.error;
        expect(await targets()).toEqual([edge.targetItemId]);
      }),
  );

  it("refuses a type change racing a real confirmation that holds the card", async () =>
    runInTenant(tenant, async () => {
      const { edge, targets, proposals, inbox, types } = await fixture();
      await createSemprecTickAction(pool, async () => ({ properties: { name: "Race task" } }))(
        { inboxDatabaseId: inbox, inboxItemTypesDatabaseId: types, processingProposalsDatabaseId: proposals },
        { heartbeatId: "hb", projectItemId: "proj", itemId: edge.callerItemId },
      );
      const sourceProperty = (await createChokePoint(pool).listProperties(proposals)).find(
        (p) => p.key === "sourceInbox",
      );
      if (!sourceProperty) throw new Error("Missing source relation");
      const cardId = await withTransaction(pool, async (client) => {
        const definition = await getRelationDefinitionByPropertyId(client, sourceProperty.id);
        if (!definition) throw new Error("Missing source relation definition");
        const edges = await listRelationsForItem(client, definition.id, edge.callerItemId);
        if (edges.length !== 1 || !edges[0]) throw new Error("Expected one proposal");
        return otherSide(edges[0], edge.callerItemId);
      });
      let release: (commit: boolean) => void = () => {};
      let signalReady: (identity: { pid: number; started: string }) => void = () => {};
      const gate = new Promise<boolean>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<{ pid: number; started: string }>((resolve) => {
        signalReady = resolve;
      });
      const cancelled = new Error("cancel confirmation");
      const confirmation = withTransaction(pool, async (client) => {
        const identity = await client.query<{ pid: number; started: string }>(
          "SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()",
        );
        if (!identity.rows[0]) throw new Error("Missing confirmer identity");
        await confirmProposalWithClient(client, { processingProposalsDatabaseId: proposals }, cardId);
        signalReady(identity.rows[0]);
        if (!(await gate)) throw cancelled;
      }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      trackRaceActor(confirmation);
      const invalidations: InvalidationEvent[] = [];
      let primary: { error: unknown } | undefined;
      let commit = false;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const confirmer = await Promise.race([
          ready,
          confirmation.then((outcome) => {
            throw outcome.ok ? new Error("Confirmation ended early") : outcome.error;
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Confirmation did not reach its commit gate")), 5000);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        const observed = await admin.query<{ present: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz) AS present",
          [confirmer.pid, confirmer.started],
        );
        expect(observed.rows).toEqual([{ present: true }]);
        let probeIdentity: { pid: number; started: string } | undefined;
        const probe = withTransaction(pool, async (client) => {
          const identity = await client.query<{ pid: number; started: string }>(
            "SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()",
          );
          probeIdentity = identity.rows[0];
          if (!probeIdentity) throw new Error("Missing probe identity");
          await client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE NOWAIT", [
            proposals,
            cardId,
          ]);
        }).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        trackRaceActor(probe);
        const probeOutcome = await boundRace(probe);
        if (probeOutcome.ok) throw new Error("Card reservation probe unexpectedly succeeded");
        expect(probeIdentity?.pid).not.toBe(confirmer.pid);
        expect(probeOutcome.error).toMatchObject({ code: "55P03" });
        const beforeCard = await withTransaction(pool, (client) => getItemById(client, proposals, cardId));
        const beforeSource = await withTransaction(pool, (client) => getItemById(client, inbox, edge.callerItemId));
        const jobs = await admin.query<{ id: string; key: string | null }>(
          "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
        );
        setInvalidationHook((event) => invalidations.push(event));
        const deletion = createChokePoint(pool)
          .deleteRelation(edge)
          .then(
            () => ({ ok: true as const }),
            (error: unknown) => ({ ok: false as const, error }),
          );
        trackRaceActor(deletion);
        const deletionOutcome = await boundRace(deletion);
        if (deletionOutcome.ok) throw new Error("Type deletion unexpectedly succeeded");
        expect(deletionOutcome.error).toMatchObject({
          status: 409,
          code: "version_conflict",
          details: { field: "type" },
        });
        expect(await targets()).toEqual([edge.targetItemId]);
        expect(await withTransaction(pool, (client) => getItemById(client, proposals, cardId))).toEqual(beforeCard);
        expect(await withTransaction(pool, (client) => getItemById(client, inbox, edge.callerItemId))).toEqual(
          beforeSource,
        );
        expect(
          (
            await admin.query<{ id: string; key: string | null }>(
              "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
            )
          ).rows,
        ).toEqual(jobs.rows);
        expect(invalidations).toEqual([]);
        commit = true;
      } catch (error) {
        primary = { error };
      }
      release(commit);
      let outcome: Awaited<typeof confirmation> | undefined;
      let cleanup: { error: unknown } | undefined;
      try {
        outcome = await boundRace(confirmation);
        await boundRace(Promise.allSettled([...pendingRaceActors]));
      } catch (error) {
        cleanup = { error };
      }
      if (!pendingRaceActors.size) setInvalidationHook(() => {});
      if (cleanup) {
        if (primary)
          throw new AggregateError([primary.error, cleanup.error], "Inbox type race cleanup failed", {
            cause: primary.error,
          });
        throw cleanup.error;
      }
      if (!outcome) throw new Error("Missing confirmation outcome");
      if (primary && !outcome.ok && outcome.error !== cancelled)
        throw new AggregateError([primary.error, outcome.error], "Inbox type race and confirmation failed", {
          cause: primary.error,
        });
      if (primary) throw primary.error;
      if (!outcome.ok) throw outcome.error;
      expect(await targets()).toEqual([edge.targetItemId]);
      expect((await withTransaction(pool, (client) => getItemById(client, proposals, cardId)))?.properties.status).toBe(
        "confirmed",
      );
    }));

  it("does not let another tenant delete an Inbox type edge", async () => {
    const own = await runInTenant(tenant, () => fixture("proposed"));
    const other = await createTestTenant(admin);
    await runInTenant(other, () => seedSystem(pool, createViewTypeRegistry()));
    const readError = (relationPropertyId: string) =>
      runInTenant(other, () =>
        own.cp.deleteRelation({ ...own.edge, relationPropertyId }).then(
          () => null,
          (caught: unknown) => caught,
        ),
      );
    const foreign = await readError(own.edge.relationPropertyId);
    const missing = await readError(randomUUID());
    expect(foreign).toMatchObject({ status: 400, code: "validation_failed", details: { field: "relationPropertyId" } });
    expect(missing).toMatchObject({ status: 400, code: "validation_failed", details: { field: "relationPropertyId" } });
    expect(await runInTenant(tenant, () => own.targets())).toEqual([own.edge.targetItemId]);
  });

  it.each([
    ["confirmed", false, true],
    ["rejected", false, true],
    ["confirmed", true, false],
    ["proposed", false, false],
  ] as const)("type deletion keeps decided live history for %s trashed=%s", async (status, trashed, retained) =>
    runInTenant(tenant, async () => {
      const { edge, targets, inbox, types, proposals } = await fixture(status, trashed);
      const removed = await withTransaction(pool, (client) =>
        deleteInboxTypeWithClient(client, {
          inboxDatabaseId: inbox,
          inboxItemTypesDatabaseId: types,
          processingProposalsDatabaseId: proposals,
          typeItemId: edge.targetItemId,
        }),
      );
      expect(removed?.id).toBe(edge.targetItemId);
      expect(await targets()).toEqual(retained ? [edge.targetItemId] : []);
      const type = await pool.query<{ deleted: boolean }>(
        "SELECT deleted_at IS NOT NULL AS deleted FROM items WHERE database_id = $1 AND id = $2",
        [types, edge.targetItemId],
      );
      expect(type.rows).toEqual([{ deleted: true }]);
    }),
  );
});
