import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { getPropertyByKey } from "../../chokePoint/propertiesStore.js";
import { createRelationWithClient, deleteRelationWithClient } from "../../chokePoint/relationOps.js";
import { getRelationDefinitionByPropertyId, listRelationsForItem } from "../../chokePoint/relationsStore.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { sendSempMessage } from "../../sempThreads/sempThreadsStore.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let other: string;

describe("Inbox thread association reservations", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:association-role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenant = await createTestTenant(admin);
    other = await createTestTenant(admin);
    for (const tenantId of [tenant, other]) {
      await createUser(admin, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
      await runInTenant(tenantId, () => seedSystem(pool));
    }
  });
  afterAll(async () => {
    const results = await Promise.allSettled([pool.end(), admin.end()]);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Association test cleanup failed", { cause: errors[0] });
  });

  it("holds an absent association stable through send and observes a committed removal before the next send", async () => {
    const fixture = await runInTenant(tenant, async () => {
      const dbs = await withTransaction(pool, async (client) => ({
        inbox: await getDatabaseByModuleId(client, "inbox"),
        proposals: await getDatabaseByModuleId(client, "processingProposals"),
      }));
      if (!dbs.inbox || !dbs.proposals) throw new Error("Missing Inbox databases");
      const proposals = dbs.proposals;
      const source = await createChokePoint(pool).createItem({
        databaseId: dbs.inbox.id,
        properties: { date: "2026-01-01", time: "12:00", text: "source" },
      });
      const card = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          {
            databaseId: proposals.id,
            properties: { kind: "inbox", fingerprint: randomUUID(), proposal: {}, history: [], status: "pending" },
          },
          { allowedSystemKeys: ["kind", "fingerprint", "proposal", "history", "status"] },
        ),
      );
      const relation = await withTransaction(pool, async (client) => {
        const property = await getPropertyByKey(client, proposals.id, "sourceInbox");
        if (!property) throw new Error("Missing sourceInbox property");
        const definition = await getRelationDefinitionByPropertyId(client, property.id);
        if (!definition) throw new Error("Missing sourceInbox definition");
        return { propertyId: property.id, definitionId: definition.id };
      });
      return { sourceId: source.id, cardId: card.id, ...relation };
    });
    const edgeInput = {
      relationPropertyId: fixture.propertyId,
      callerItemId: fixture.cardId,
      targetItemId: fixture.sourceId,
    };
    const owner = { ownerProcess: "processingProposals" };
    const edges = () =>
      runInTenant(tenant, () =>
        withTransaction(pool, (client) => listRelationsForItem(client, fixture.definitionId, fixture.sourceId)),
      );
    const waitForLock = async (pid: number) => {
      const deadline = Date.now() + 5_000;
      let waiting = false;
      while (Date.now() < deadline) {
        const row = await admin.query<{ wait_event_type: string | null }>(
          "SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1",
          [pid],
        );
        if (row.rows[0]?.wait_event_type === "Lock") {
          waiting = true;
          break;
        }
        await sleep(25);
      }
      expect(waiting).toBe(true);
    };
    const foreign = await runInTenant(other, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, {
          subject: { inboxItemId: fixture.sourceId },
          text: "foreign",
          context: [],
          hasContext: false,
        }),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    const missing = await runInTenant(other, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, {
          subject: { inboxItemId: randomUUID() },
          text: "foreign",
          context: [],
          hasContext: false,
        }),
      ),
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(foreign).toMatchObject({ code: "validation_failed" });
    expect(missing).toMatchObject({ code: "validation_failed" });
    expect(await edges()).toEqual([]);
    let release!: () => void;
    let reserved!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reserved = resolve;
    });
    const send = runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const turn = await sendSempMessage(client, {
          subject: { inboxItemId: fixture.sourceId },
          text: "before edge",
          context: [],
          hasContext: false,
        });
        reserved();
        await gate;
        return turn;
      }),
    );
    let competingPid!: (pid: number) => void;
    const pid = new Promise<number>((resolve) => {
      competingPid = resolve;
    });
    let insert: Promise<unknown> | undefined;
    let turn: Awaited<typeof send> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      await Promise.race([
        ready,
        send.then(() => {
          throw new Error("Send ended before reservation");
        }),
      ]);
      insert = runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const identity = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          if (!identity.rows[0]) throw new Error("Missing backend identity");
          competingPid(identity.rows[0].pid);
          return createRelationWithClient(client, edgeInput, owner);
        }),
      );
      void insert.catch(() => {});
      await waitForLock(await pid);
      expect(await edges()).toEqual([]);
      release();
      turn = await send;
      await insert;
    } catch (error) {
      failure = { error };
    }
    release();
    const settled = await Promise.allSettled([send, ...(insert ? [insert] : [])]);
    const extra = settled.flatMap((result) =>
      result.status === "rejected" && (!failure || result.reason !== failure.error) ? [result.reason] : [],
    );
    if (extra.length)
      throw new AggregateError(failure ? [failure.error, ...extra] : extra, "Association insertion failed", {
        cause: failure?.error,
      });
    if (failure) throw failure.error;
    if (!turn) throw new Error("Missing sent turn");
    const sentTurn = turn;
    expect(await edges()).toHaveLength(1);

    let releaseDelete!: () => void;
    let deleteReady!: () => void;
    const deleteGate = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    const deleteStarted = new Promise<void>((resolve) => {
      deleteReady = resolve;
    });
    const deletion = runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        expect(await deleteRelationWithClient(client, edgeInput, owner)).not.toBeNull();
        deleteReady();
        await deleteGate;
      }),
    );
    let senderPid!: (pid: number) => void;
    const nextPid = new Promise<number>((resolve) => {
      senderPid = resolve;
    });
    let next: Promise<Awaited<typeof send>> | undefined;
    failure = undefined;
    try {
      await Promise.race([
        deleteStarted,
        deletion.then(() => {
          throw new Error("Deletion ended before reservation");
        }),
      ]);
      next = runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const identity = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          if (!identity.rows[0]) throw new Error("Missing backend identity");
          senderPid(identity.rows[0].pid);
          return sendSempMessage(client, {
            threadId: sentTurn.threadId,
            text: "after removal",
            context: [],
            hasContext: false,
          });
        }),
      );
      void next.catch(() => {});
      await waitForLock(await nextPid);
      releaseDelete();
      await deletion;
      expect((await next).threadId).toBe(turn.threadId);
    } catch (error) {
      failure = { error };
    }
    releaseDelete();
    const finished = await Promise.allSettled([deletion, ...(next ? [next] : [])]);
    const cleanup = finished.flatMap((result) =>
      result.status === "rejected" && (!failure || result.reason !== failure.error) ? [result.reason] : [],
    );
    if (cleanup.length)
      throw new AggregateError(failure ? [failure.error, ...cleanup] : cleanup, "Association removal failed", {
        cause: failure?.error,
      });
    if (failure) throw failure.error;
    expect(await edges()).toEqual([]);
    const messages = await runInTenant(tenant, () =>
      pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_messages WHERE thread_id = $1", [
        turn.threadId,
      ]),
    );
    expect(messages.rows).toEqual([{ count: 4 }]);
  }, 60_000);

  it("uses live associations rather than a stale decided thread hint", async () => {
    const fixture = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const inbox = await getDatabaseByModuleId(client, "inbox");
        const proposals = await getDatabaseByModuleId(client, "processingProposals");
        if (!inbox || !proposals) throw new Error("Missing Inbox databases");
        const property = await getPropertyByKey(client, proposals.id, "sourceInbox");
        if (!property) throw new Error("Missing sourceInbox property");
        const source = await createItemWithClient(client, {
          databaseId: inbox.id,
          properties: { date: "2026-01-01", time: "13:00", text: "stale hint" },
        });
        const card = await createItemWithClient(
          client,
          {
            databaseId: proposals.id,
            properties: { kind: "inbox", fingerprint: randomUUID(), proposal: {}, history: [], status: "pending" },
          },
          { allowedSystemKeys: ["kind", "fingerprint", "proposal", "history", "status"] },
        );
        const edge = { relationPropertyId: property.id, callerItemId: card.id, targetItemId: source.id };
        await createRelationWithClient(client, edge, { ownerProcess: "processingProposals" });
        const turn = await sendSempMessage(client, {
          subject: { inboxItemId: source.id, proposalId: card.id },
          text: "first",
          context: [],
          hasContext: false,
        });
        return {
          sourceId: source.id,
          cardId: card.id,
          proposalsId: proposals.id,
          propertyId: property.id,
          edge,
          threadId: turn.threadId,
        };
      }),
    );
    await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        expect(
          await deleteRelationWithClient(client, fixture.edge, { ownerProcess: "processingProposals" }),
        ).not.toBeNull();
        await updateItemWithClient(
          client,
          { databaseId: fixture.proposalsId, itemId: fixture.cardId, propertiesPatch: { status: "confirmed" } },
          { allowedSystemKeys: ["status"] },
        );
      }),
    );
    const stale = await runInTenant(tenant, () =>
      pool.query<{ subject_proposal_id: string | null }>("SELECT subject_proposal_id FROM semp_threads WHERE id = $1", [
        fixture.threadId,
      ]),
    );
    expect(stale.rows).toEqual([{ subject_proposal_id: fixture.cardId }]);
    const sent = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { threadId: fixture.threadId, text: "after unlink", context: [], hasContext: false }),
      ),
    );
    expect(sent.threadId).toBe(fixture.threadId);
    await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const rejected = await createItemWithClient(
          client,
          {
            databaseId: fixture.proposalsId,
            properties: { kind: "inbox", fingerprint: randomUUID(), proposal: {}, history: [], status: "rejected" },
          },
          { allowedSystemKeys: ["kind", "fingerprint", "proposal", "history", "status"] },
        );
        await createRelationWithClient(
          client,
          { relationPropertyId: fixture.propertyId, callerItemId: rejected.id, targetItemId: fixture.sourceId },
          { ownerProcess: "processingProposals" },
        );
      }),
    );
    await expect(
      runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          sendSempMessage(client, {
            threadId: fixture.threadId,
            text: "after rejection",
            context: [],
            hasContext: false,
          }),
        ),
      ),
    ).rejects.toMatchObject({ code: "proposal_locked" });
    const messages = await runInTenant(tenant, () =>
      pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_messages WHERE thread_id = $1", [
        fixture.threadId,
      ]),
    );
    expect(messages.rows).toEqual([{ count: 4 }]);
  });

  it("ignores a trashed card and refuses unrelated, foreign, deleted and unknown hints without writes", async () => {
    const createCard = (tenantId: string) =>
      runInTenant(tenantId, () =>
        withTransaction(pool, async (client) => {
          const inbox = await getDatabaseByModuleId(client, "inbox");
          const proposals = await getDatabaseByModuleId(client, "processingProposals");
          if (!inbox || !proposals) throw new Error("Missing Inbox databases");
          const property = await getPropertyByKey(client, proposals.id, "sourceInbox");
          if (!property) throw new Error("Missing sourceInbox property");
          const source = await createItemWithClient(client, {
            databaseId: inbox.id,
            properties: { date: "2026-01-01", time: "14:00", text: "trashed card" },
          });
          const card = await createItemWithClient(
            client,
            {
              databaseId: proposals.id,
              properties: { kind: "inbox", fingerprint: randomUUID(), proposal: {}, history: [], status: "confirmed" },
            },
            { allowedSystemKeys: ["kind", "fingerprint", "proposal", "history", "status"] },
          );
          await createRelationWithClient(
            client,
            { relationPropertyId: property.id, callerItemId: card.id, targetItemId: source.id },
            { ownerProcess: "processingProposals" },
          );
          return { sourceId: source.id, cardId: card.id, databaseId: proposals.id };
        }),
      );
    const own = await createCard(tenant);
    const unrelated = await createCard(tenant);
    const foreign = await createCard(other);
    await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        itemDeleteWithClient(client, own.databaseId, own.cardId, { queueAffinity: createActionQueueAffinity() }),
      ),
    );
    const send = (proposalId?: string) =>
      runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          sendSempMessage(client, {
            subject: { inboxItemId: own.sourceId, ...(proposalId ? { proposalId } : {}) },
            text: "question",
            context: [],
            hasContext: false,
          }),
        ),
      );
    const accepted = await send();
    const counts = () =>
      runInTenant(tenant, () =>
        pool.query<{ messages: number; jobs: number }>(
          `SELECT (SELECT count(*)::int FROM semp_messages WHERE thread_id = $1) AS messages,
                  (SELECT count(*)::int FROM graphile_worker.jobs WHERE key LIKE 'sempMessage:%') AS jobs`,
          [accepted.threadId],
        ),
      );
    const before = (await counts()).rows;
    for (const id of [own.cardId, unrelated.cardId, foreign.cardId, randomUUID()]) {
      await expect(send(id)).rejects.toMatchObject({ code: "validation_failed" });
      expect((await counts()).rows).toEqual(before);
    }
    expect(before[0]?.messages).toBe(2);
    const decidedId = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const property = await getPropertyByKey(client, own.databaseId, "sourceInbox");
        if (!property) throw new Error("Missing sourceInbox property");
        let rejectedId: string | undefined;
        for (const status of ["pending", "rejected"]) {
          const card = await createItemWithClient(
            client,
            {
              databaseId: own.databaseId,
              properties: { kind: "inbox", fingerprint: randomUUID(), proposal: {}, history: [], status },
            },
            { allowedSystemKeys: ["kind", "fingerprint", "proposal", "history", "status"] },
          );
          await createRelationWithClient(
            client,
            { relationPropertyId: property.id, callerItemId: card.id, targetItemId: own.sourceId },
            { ownerProcess: "processingProposals" },
          );
          if (status === "rejected") rejectedId = card.id;
        }
        if (!rejectedId) throw new Error("Missing decided proposal");
        return rejectedId;
      }),
    );
    let release!: () => void;
    let reserved!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      reserved = resolve;
    });
    const holder = runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        await updateItemWithClient(
          client,
          { databaseId: own.databaseId, itemId: decidedId, propertiesPatch: { status: "rejected" } },
          { allowedSystemKeys: ["status"] },
        );
        reserved();
        await gate;
      }),
    );
    let failure: { error: unknown } | undefined;
    try {
      await Promise.race([
        ready,
        holder.then(() => {
          throw new Error("Proposal reservation ended early");
        }),
      ]);
      await expect(send()).rejects.toMatchObject({ code: "version_conflict" });
      expect((await counts()).rows).toEqual(before);
    } catch (error) {
      failure = { error };
    }
    release();
    try {
      await holder;
    } catch (error) {
      if (failure)
        throw new AggregateError([failure.error, error], "Proposal contention cleanup failed", {
          cause: failure.error,
        });
      throw error;
    }
    if (failure) throw failure.error;
    await expect(send()).rejects.toMatchObject({ code: "proposal_locked" });
    expect((await counts()).rows).toEqual(before);
  });
});
