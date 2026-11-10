import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { listRelationsForItem, getRelationDefinitionByPropertyId, otherSide } from "../chokePoint/relationsStore.js";
import { createRelationWithClient, deleteRelationWithClient } from "../chokePoint/relationOps.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { reserveInboxTypeCards } from "../inbox/inboxTypeCardReservation.js";
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

type RaceOutcome = { ok: true } | { ok: false; error: unknown };
type RaceActor = {
  actor: Promise<RaceOutcome>;
  consumed: boolean;
  ignored?: { value: unknown };
  label: string;
  status: "pending" | "fulfilled" | "rejected";
  outcome?: RaceOutcome;
  error?: unknown;
};
const retainedRaceCases: Array<{ primary?: { error: unknown }; records: RaceActor[] }> = [];
function raceDiagnostic(): AggregateError | undefined {
  if (!retainedRaceCases.length && !pendingRaceActors.size) return undefined;
  const errors: unknown[] = [];
  for (const item of retainedRaceCases) {
    if (item.primary) errors.push(item.primary.error);
    for (const record of item.records) {
      if (record.status === "pending") errors.push(new Error(`${record.label} remains pending`));
      else if (record.status === "rejected" && !record.consumed) errors.push(record.error);
      else if (
        record.outcome &&
        !record.outcome.ok &&
        !record.consumed &&
        (!record.ignored || record.outcome.error !== record.ignored.value)
      )
        errors.push(record.outcome.error);
    }
  }
  return new AggregateError(errors, "Prior Inbox race remains unsafe; resources remain reserved");
}

function trackRaceActor(records: RaceActor[], actor: Promise<RaceOutcome>): RaceActor {
  const record: RaceActor = { actor, consumed: false, label: `Inbox actor ${records.length + 1}`, status: "pending" };
  records.push(record);
  pendingRaceActors.add(actor);
  void actor.then(
    (outcome) => {
      record.status = "fulfilled";
      record.outcome = outcome;
      pendingRaceActors.delete(actor);
    },
    (error: unknown) => {
      record.status = "rejected";
      record.error = error;
      pendingRaceActors.delete(actor);
    },
  );
  return record;
}

async function finishRaceActors(records: RaceActor[], primary?: { error: unknown }): Promise<void> {
  const errors: unknown[] = primary ? [primary.error] : [];
  let timedOut = false;
  for (const record of records) {
    try {
      const outcome = await boundRace(record.actor);
      if (!outcome.ok && !record.consumed && (!record.ignored || outcome.error !== record.ignored.value)) {
        errors.push(outcome.error);
        record.consumed = true;
      }
    } catch (error) {
      if (record.status === "pending") timedOut = true;
      else record.consumed = true;
      errors.push(error);
    }
  }
  if (timedOut) retainedRaceCases.push({ primary, records });
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(errors, "Inbox race actor failures", { cause: primary ? primary.error : errors[0] });
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
    const unsafe = raceDiagnostic();
    if (unsafe) throw unsafe;
    admin ??= getTestPool();
    pool ??= await createRuntimeRolePool(admin, "semprec_data");
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
  });
  afterAll(async () => {
    const unsafe = raceDiagnostic();
    if (unsafe) throw unsafe;
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

  it("reserves every associated card in sorted order before filtering trashed cards", async () =>
    runInTenant(tenant, async () => {
      const { cp, edge, cardId, proposals } = await fixture("proposed");
      if (!cardId) throw new Error("Missing first card");
      const source = (await cp.listProperties(proposals)).find((property) => property.key === "sourceInbox");
      if (!source) throw new Error("Missing sourceInbox property");
      const ids = [cardId];
      for (const status of ["proposed", "confirmed"]) {
        // Synthetic card state: public APIs do not insert decided cards directly.
        const card = await withTransaction(pool, (client) =>
          insertItem(client, {
            databaseId: proposals,
            properties: { kind: "inbox", fingerprint: randomUUID(), proposal: {}, history: [], status },
          }),
        );
        ids.push(card.id);
        await withTransaction(pool, (client) =>
          createRelationWithClient(
            client,
            {
              relationPropertyId: source.id,
              callerItemId: card.id,
              targetItemId: edge.callerItemId,
            },
            { ownerProcess: PROCESSING_PROPOSALS_MODULE_ID },
          ),
        );
        if (status === "confirmed") await withTransaction(pool, (client) => softDeleteItem(client, proposals, card.id));
      }
      await withTransaction(pool, async (client) => {
        const spy = vi.spyOn(client, "query");
        try {
          const cards = await reserveInboxTypeCards(client, edge.callerItemId);
          const calls: unknown[][] = spy.mock.calls;
          const observed: string[] = [];
          for (const [statement, parameters] of calls) {
            if (typeof statement === "string" && statement.includes("FOR UPDATE NOWAIT")) {
              if (!Array.isArray(parameters) || typeof parameters[1] !== "string")
                throw new Error("Invalid lock arguments");
              observed.push(parameters[1]);
            }
          }
          expect(observed).toEqual([...ids].sort());
          expect(cards.map((card) => card.id)).toEqual(ids.slice(0, 2).sort());
        } finally {
          spy.mockRestore();
        }
      });
    }));

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

  it.each([false, true])("preserves a reservation error when savepoint cleanup fails=%s", async (cleanupFails) =>
    runInTenant(tenant, async () => {
      const { edge, targets, proposals } = await fixture("proposed");
      const before = await targets();
      const jobs = await admin.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id");
      const events: InvalidationEvent[] = [];
      const primary = new Error("injected reservation failure");
      const cleanup = new Error("injected savepoint cleanup failure");
      setInvalidationHook((event) => events.push(event));
      try {
        const caught = await withTransaction(pool, async (client) => {
          const query = client.query.bind(client);
          const spy = vi.spyOn(client, "query");
          const forward = async (sql: string, values?: unknown[]) => {
            if (sql.includes("FOR UPDATE NOWAIT") && values?.[0] === proposals) throw primary;
            if (cleanupFails && sql.startsWith("ROLLBACK TO SAVEPOINT inbox_type_card")) throw cleanup;
            return query(sql, values);
          };
          // The exercised calls use pg's promise overload.
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          spy.mockImplementation(forward as typeof client.query);
          try {
            await deleteRelationWithClient(client, edge);
          } finally {
            spy.mockRestore();
          }
        }).then(() => null, (error: unknown) => error);
        if (cleanupFails) {
          expect(caught).toBeInstanceOf(AggregateError);
          if (!(caught instanceof AggregateError)) throw new Error("Expected cleanup aggregate");
          expect(caught.cause).toBe(primary);
          expect(caught.errors).toEqual([primary, cleanup]);
        } else expect(caught).toBe(primary);
      } finally {
        setInvalidationHook(() => {});
      }
      expect(await targets()).toEqual(before);
      expect((await admin.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id")).rows).toEqual(jobs.rows);
      expect(events).toEqual([]);
    }));

  it("cannot commit a caught post-change refusal for a decided card", async () =>
    runInTenant(tenant, async () => {
      const { edge, targets } = await fixture("confirmed");
      const before = await targets();
      const jobs = await admin.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id");
      const events: InvalidationEvent[] = [];
      setInvalidationHook((event) => events.push(event));
      try {
        await expect(withTransaction(pool, async (client) => {
          try {
            await deleteRelationWithClient(client, edge);
          } catch (error) {
            expect(error).toMatchObject({ status: 409, code: "proposal_locked" });
          }
        })).rejects.toMatchObject({ status: 409, code: "proposal_locked" });
      } finally {
        setInvalidationHook(() => {});
      }
      expect(await targets()).toEqual(before);
      expect((await admin.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id")).rows).toEqual(jobs.rows);
      expect(events).toEqual([]);
    }));

  it.each(["proposed", "confirmed", "rejected"] as const)(
    "replaces the existing type edge metadata only while the card is %s",
    async (status) =>
      runInTenant(tenant, async () => {
        const { cp, edge } = await fixture(status);
        const read = () =>
          withTransaction(pool, async (client) => {
            const definition = await getRelationDefinitionByPropertyId(client, edge.relationPropertyId);
            if (!definition) throw new Error("Missing type definition");
            return listRelationsForItem(client, definition.id, edge.callerItemId);
          });
        const before = await read();
        expect(before).toHaveLength(1);
        const jobsBefore = await admin.query<{ id: string; key: string | null }>(
          "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
        );
        const invalidations: InvalidationEvent[] = [];
        setInvalidationHook((event) => invalidations.push(event));
        try {
          if (status === "proposed") {
            const updated = await cp.createRelation({ ...edge, metadata: { source: "replacement" } });
            expect(updated.metadata).toEqual({ source: "replacement" });
            expect((await read()).map((relation) => relation.metadata)).toEqual([{ source: "replacement" }]);
          } else {
            await expect(cp.createRelation({ ...edge, metadata: { source: "replacement" } })).rejects.toMatchObject({
              status: 409,
              code: "proposal_locked",
            });
            expect(await read()).toEqual(before);
            expect(
              (
                await admin.query<{ id: string; key: string | null }>(
                  "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
                )
              ).rows,
            ).toEqual(jobsBefore.rows);
            expect(invalidations).toEqual([]);
          }
        } finally {
          setInvalidationHook(() => {});
        }
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
        const records: RaceActor[] = [];
        const holderRecord = trackRaceActor(records, holder);
        let readyReceived = false;
        let failure: { error: unknown } | undefined;
        try {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const identity = await Promise.race([
            ready,
            holder.then((outcome) => {
              if (!outcome.ok && !readyReceived) holderRecord.consumed = true;
              throw outcome.ok ? new Error("Holder ended early") : outcome.error;
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Holder did not reserve card")), 5000);
            }),
          ]).finally(() => {
            if (timer) clearTimeout(timer);
          });
          readyReceived = true;
          const observed = await admin.query<{ present: boolean }>(
            "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz) AS present",
            [identity.pid, identity.started],
          );
          expect(observed.rows).toEqual([{ present: true }]);
          await expect(cp.deleteRelation(edge)).rejects.toMatchObject({
            status: 409,
            code: "version_conflict",
            message: "Inbox proposal is busy",
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
          ).rejects.toMatchObject({ status: 409, code: "version_conflict", message: "Inbox proposal is busy", details: { field: "type" } });
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
        setInvalidationHook(() => {});
        await finishRaceActors(records, failure);
        expect(await targets()).toEqual([edge.targetItemId]);
      }),
  );

  it("rolls back an earlier source edge when a later source card is busy", async () =>
    runInTenant(tenant, async () => {
      const { cp, edge, cardId, proposals, inbox, types } = await fixture("proposed");
      if (!cardId) throw new Error("Missing first card");
      const second = await withTransaction(pool, (client) => createInboxItemWithClient(client, {
        inboxDatabaseId: inbox, date: "2026-10-02", time: "10:30", type: edge.targetItemId,
      }));
      const sourceProperty = (await cp.listProperties(proposals)).find((property) => property.key === "sourceInbox");
      if (!sourceProperty) throw new Error("Missing sourceInbox property");
      const card = await withTransaction(pool, (client) => insertItem(client, {
        databaseId: proposals, properties: { kind: "inbox", fingerprint: randomUUID(), proposal: {}, history: [], status: "proposed" },
      }));
      await withTransaction(pool, (client) => createRelationWithClient(client, {
        relationPropertyId: sourceProperty.id, callerItemId: card.id, targetItemId: second.id,
      }, { ownerProcess: PROCESSING_PROPOSALS_MODULE_ID }));
      const sources = [edge.callerItemId, second.id].sort();
      const laterCard = sources[1] === second.id ? card.id : cardId;
      const state = () => pool.query<{ id: string; database_id: string; properties: unknown; deleted_at: Date | null }>(
        "SELECT id, database_id, properties, deleted_at FROM items WHERE id = ANY($1::uuid[]) ORDER BY id",
        [[...sources, cardId, card.id, edge.targetItemId]],
      );
      const relations = () => pool.query<{ id: string; item_a: string; item_b: string; metadata: unknown }>(
        "SELECT id, item_a, item_b, metadata FROM item_relations WHERE item_a = ANY($1::uuid[]) OR item_b = ANY($1::uuid[]) ORDER BY id",
        [sources],
      );
      const before = await state();
      const edgesBefore = await relations();
      const jobs = await admin.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id");
      let release = () => {};
      let signalReady: (identity: { pid: number; started: string }) => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const ready = new Promise<{ pid: number; started: string }>((resolve) => { signalReady = resolve; });
      const actors: RaceActor[] = [];
      const holder = withTransaction(pool, async (client) => {
        const identity = await client.query<{ pid: number; started: string }>(
          "SELECT pg_backend_pid() AS pid, backend_start::text AS started FROM pg_stat_activity WHERE pid = pg_backend_pid()",
        );
        if (!identity.rows[0]) throw new Error("Missing holder identity");
        await client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE", [proposals, laterCard]);
        signalReady(identity.rows[0]);
        await gate;
      }).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error }));
      const holderRecord = trackRaceActor(actors, holder);
      let readyReceived = false;
      let primary: { error: unknown } | undefined;
      const deletedSources: string[] = [];
      const events: InvalidationEvent[] = [];
      try {
        const identity = await boundRace(Promise.race([ready, holder.then((outcome) => {
          if (!outcome.ok && !readyReceived) holderRecord.consumed = true;
          throw outcome.ok ? new Error("Holder ended early") : outcome.error;
        })]));
        readyReceived = true;
        expect((await admin.query<{ present: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz) AS present",
          [identity.pid, identity.started],
        )).rows).toEqual([{ present: true }]);
        setInvalidationHook((event) => events.push(event));
        await expect(withTransaction(pool, async (client) => {
          const query = client.query.bind(client);
          const spy = vi.spyOn(client, "query");
          const forward = async (sql: string, values?: unknown[]) => {
            const result = await query(sql, values);
            if (sql.startsWith("DELETE FROM item_relations") && result.rowCount && typeof values?.[1] === "string") deletedSources.push(values[1]);
            return result;
          };
          // The exercised calls use pg's promise overload.
          // eslint-disable-next-line @typescript-eslint/no-misused-promises
          spy.mockImplementation(forward as typeof client.query);
          try {
            await deleteInboxTypeWithClient(client, { inboxDatabaseId: inbox, inboxItemTypesDatabaseId: types, processingProposalsDatabaseId: proposals, typeItemId: edge.targetItemId });
          } finally { spy.mockRestore(); }
        })).rejects.toMatchObject({ status: 409, code: "version_conflict", message: "Inbox proposal is busy" });
        expect(deletedSources).toEqual([sources[0]]);
        expect((await state()).rows).toEqual(before.rows);
        expect((await relations()).rows).toEqual(edgesBefore.rows);
        expect((await admin.query<{ id: string; key: string | null }>("SELECT id, key FROM graphile_worker.jobs ORDER BY id")).rows).toEqual(jobs.rows);
        expect(events).toEqual([]);
      } catch (error) { primary = { error }; }
      release();
      try { await finishRaceActors(actors, primary); }
      finally { if (!pendingRaceActors.size) setInvalidationHook(() => {}); }
    }));

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
      const actors: RaceActor[] = [];
      const confirmationRecord = trackRaceActor(actors, confirmation);
      const invalidations: InvalidationEvent[] = [];
      let primary: { error: unknown } | undefined;
      let commit = false;
      let readyReceived = false;
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const confirmer = await Promise.race([
          ready,
          confirmation.then((outcome) => {
            if (!readyReceived) confirmationRecord.consumed = true;
            throw outcome.ok ? new Error("Confirmation ended early") : outcome.error;
          }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Confirmation did not reach its commit gate")), 5000);
          }),
        ]).finally(() => {
          if (timer) clearTimeout(timer);
        });
        readyReceived = true;
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
        const probeRecord = trackRaceActor(actors, probe);
        const probeOutcome = await boundRace(probe);
        if (probeOutcome.ok) throw new Error("Card reservation probe unexpectedly succeeded");
        expect(probeIdentity?.pid).not.toBe(confirmer.pid);
        expect(probeOutcome.error).toMatchObject({ code: "55P03" });
        probeRecord.consumed = true;
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
        const deletionRecord = trackRaceActor(actors, deletion);
        const deletionOutcome = await boundRace(deletion);
        if (deletionOutcome.ok) throw new Error("Type deletion unexpectedly succeeded");
        expect(deletionOutcome.error).toMatchObject({
          status: 409,
          code: "version_conflict",
          details: { field: "type" },
        });
        deletionRecord.consumed = true;
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
      if (!commit) confirmationRecord.ignored = { value: cancelled };
      release(commit);
      let failure: { error: unknown } | undefined;
      try {
        await finishRaceActors(actors, primary);
      } catch (error) {
        failure = { error };
      }
      if (!pendingRaceActors.size) setInvalidationHook(() => {});
      if (failure) throw failure.error;
      expect(await targets()).toEqual([edge.targetItemId]);
      expect((await withTransaction(pool, (client) => getItemById(client, proposals, cardId)))?.properties.status).toBe(
        "confirmed",
      );
    }));

  it("retains synthetic late actor failures in launch order with a falsy primary", async () => {
    const actors: RaceActor[] = [];
    const firstError = new Error("first late failure");
    const secondError = new Error("second late failure");
    let first: (outcome: RaceOutcome) => void = () => {};
    let second: (outcome: RaceOutcome) => void = () => {};
    let third: (outcome: RaceOutcome) => void = () => {};
    trackRaceActor(
      actors,
      new Promise<RaceOutcome>((resolve) => {
        first = resolve;
      }),
    );
    trackRaceActor(
      actors,
      new Promise<RaceOutcome>((resolve) => {
        second = resolve;
      }),
    );
    trackRaceActor(
      actors,
      new Promise<RaceOutcome>((resolve) => {
        third = resolve;
      }),
    );
    second({ ok: false, error: secondError });
    third({ ok: true });
    first({ ok: false, error: firstError });
    const failure = await finishRaceActors(actors, { error: 0 }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected aggregate failure");
    expect(failure.cause).toBe(0);
    expect(failure.errors).toEqual([0, firstError, secondError]);
    expect(failure.errors[1]).toBe(firstError);
    expect(failure.errors[2]).toBe(secondError);
    expect(pendingRaceActors.size).toBe(0);
  });

  it.each([
    "missing",
    "foreign",
    "module",
    "property",
    "definition",
    "no-edges",
    "property-type",
    "target",
    "config-definition",
  ] as const)("fails closed on %s Processing proposals configuration without effects", async (scenario) => {
    let foreignId: string | undefined;
    if (scenario === "foreign") {
      const other = await createTestTenant(admin);
      await runInTenant(other, () => seedSystem(pool, createViewTypeRegistry()));
      const result = await admin.query<{ id: string }>(
        "SELECT id FROM databases WHERE tenant_id = $1 AND owner_module_id = $2",
        [other, PROCESSING_PROPOSALS_MODULE_ID],
      );
      foreignId = result.rows[0]?.id;
      if (!foreignId) throw new Error("Missing foreign proposals database");
    }
    await runInTenant(tenant, async () => {
      const { cp, edge, targets, inbox, types, proposals } = await fixture();
      if (scenario === "no-edges") await cp.deleteRelation(edge);
      const originalTargets = await targets();
      const originalType = await withTransaction(pool, (client) => getItemById(client, types, edge.targetItemId));
      const originalSource = await withTransaction(pool, (client) => getItemById(client, inbox, edge.callerItemId));
      const sourceProperty = (await cp.listProperties(proposals)).find((p) => p.key === "sourceInbox");
      if (!sourceProperty) throw new Error("Missing sourceInbox property");
      const definition = await withTransaction(pool, (client) =>
        getRelationDefinitionByPropertyId(client, sourceProperty.id),
      );
      if (!definition) throw new Error("Missing sourceInbox definition");
      let supplied = proposals;
      if (scenario === "missing" || scenario === "no-edges") supplied = randomUUID();
      if (scenario === "foreign") {
        if (!foreignId) throw new Error("Missing foreign proposals database");
        supplied = foreignId;
      }
      // Synthetic malformed schema: production APIs do not permit these catalog mutations.
      if (scenario === "module") {
        const changed = await admin.query(
          "UPDATE databases SET owner_module_id = $3 WHERE tenant_id = $1 AND id = $2",
          [tenant, proposals, "brokenProcessingProposals"],
        );
        expect(changed.rowCount).toBe(1);
      }
      if (scenario === "property") {
        const changed = await admin.query("UPDATE properties SET key = $3 WHERE tenant_id = $1 AND id = $2", [
          tenant,
          sourceProperty.id,
          "brokenSourceInbox",
        ]);
        expect(changed.rowCount).toBe(1);
      }
      if (scenario === "property-type") {
        const changed = await admin.query("UPDATE properties SET type = 'text' WHERE tenant_id = $1 AND id = $2", [
          tenant,
          sourceProperty.id,
        ]);
        expect(changed.rowCount).toBe(1);
      }
      if (scenario === "target" || scenario === "config-definition") {
        const key = scenario === "target" ? "targetDatabaseId" : "relationDefinitionId";
        const changed = await admin.query(
          "UPDATE properties SET config = jsonb_set(config, ARRAY[$3]::text[], to_jsonb($4::text)) WHERE tenant_id = $1 AND id = $2",
          [tenant, sourceProperty.id, key, randomUUID()],
        );
        expect(changed.rowCount).toBe(1);
      }
      if (scenario === "definition") {
        const changed = await admin.query("DELETE FROM relation_definitions WHERE tenant_id = $1 AND id = $2", [
          tenant,
          definition.id,
        ]);
        expect(changed.rowCount).toBe(1);
      }
      const jobs = await admin.query<{ id: string; key: string | null }>(
        "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
      );
      const events: InvalidationEvent[] = [];
      const message =
        scenario === "property"
          ? "Processing proposals sourceInbox property not found"
          : ["definition", "property-type", "target", "config-definition"].includes(scenario)
            ? "Processing proposals sourceInbox relation not found"
            : "Processing proposals configuration not found";
      const expected = { status: 404, code: "not_found", message };
      setInvalidationHook((event) => events.push(event));
      try {
        await expect(
          withTransaction(pool, async (client) => {
            try {
              await deleteInboxTypeWithClient(client, {
                inboxDatabaseId: inbox,
                inboxItemTypesDatabaseId: types,
                processingProposalsDatabaseId: supplied,
                typeItemId: edge.targetItemId,
              });
            } catch (error) {
              expect(error).toMatchObject(expected);
            }
          }),
        ).rejects.toMatchObject(expected);
        if (scenario === "module" || scenario === "property" || scenario === "definition")
          await expect(cp.deleteRelation(edge)).rejects.toMatchObject(expected);
        expect(await targets()).toEqual(originalTargets);
        expect(await withTransaction(pool, (client) => getItemById(client, types, edge.targetItemId))).toEqual(
          originalType,
        );
        expect(await withTransaction(pool, (client) => getItemById(client, inbox, edge.callerItemId))).toEqual(
          originalSource,
        );
        expect(
          (
            await admin.query<{ id: string; key: string | null }>(
              "SELECT id, key FROM graphile_worker.jobs ORDER BY id",
            )
          ).rows,
        ).toEqual(jobs.rows);
        expect(events).toEqual([]);
      } finally {
        setInvalidationHook(() => {});
      }
    });
  });

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
