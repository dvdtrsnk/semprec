import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, enqueueJob, runOnce } from "@semprec/queue";
import { createPool, withTransaction } from "../../db/pool.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { getPropertyByKey } from "../../chokePoint/propertiesStore.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createCoreTaskList } from "../../worker.js";
import { createTestTenant, getTestPool, getTenantZeroId, resetDatabase } from "../../testSupport/testDb.js";
import { ensureFolderItem } from "../folderDiscovery.js";
import { ingestEmailMessage } from "../ingest.js";
import { createPersonEmailReindexAction, linkEmailEnvelopeToPeople } from "../personLinkingActions.js";
import type { BlobStorageWriter } from "../blobStorage.js";
import type { MailEnvelope } from "../mailMessageMetaStore.js";

let admin: Pool;
let runtime: Pool;
const storage: BlobStorageWriter = {
  async writeStream() {
    throw new Error("Unexpected attachment write");
  },
  async delete() {
    throw new Error("Unexpected attachment delete");
  },
  readStream() {
    throw new Error("Unexpected attachment read");
  },
};

async function database(client: PoolClient, module: string): Promise<string> {
  const value = await getDatabaseByModuleId(client, module);
  if (!value) throw new Error(`Missing ${module} database`);
  return value.id;
}

describe("historical mail links for newly claimed addresses", () => {
  let currentTenant: string;
  const tenant = () => currentTenant;
  let personId: string;
  let peopleId: string;
  let emailsId: string;
  let filesId: string;
  let mailboxId: string;
  let inboxId: string;
  let folderPropertyId: string;
  let attachmentsPropertyId: string;

  beforeAll(async () => {
    admin = getTestPool();
    runtime = createPool(process.env.TEST_DATABASE_URL ?? "", { role: "semprec_data" });
    const role = await runtime.query<{ name: string; bypass: boolean; superuser: boolean }>(
      "SELECT current_user AS name, rolbypassrls AS bypass, rolsuper AS superuser FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ name: "semprec_data", bypass: false, superuser: false }]);
  });
  async function setup(): Promise<void> {
    await runInTenant(tenant(), () => seedSystem(runtime));
    await runInTenant(tenant(), () =>
      withTransaction(runtime, async (client) => {
        peopleId = await database(client, "people");
        emailsId = await database(client, "emails");
        filesId = await database(client, "files");
        const folders = await database(client, "folders");
        const mailboxes = await database(client, "mailboxes");
        const mailbox = await createItemWithClient(client, { databaseId: mailboxes, properties: { name: "Mail" } });
        mailboxId = mailbox.id;
        const mailboxProperty = await getPropertyByKey(client, folders, "mailbox");
        const folderProperty = await getPropertyByKey(client, emailsId, "folder");
        const attachmentsProperty = await getPropertyByKey(client, emailsId, "attachments");
        if (!mailboxProperty || !folderProperty || !attachmentsProperty) throw new Error("Missing mail relations");
        folderPropertyId = folderProperty.id;
        attachmentsPropertyId = attachmentsProperty.id;
        inboxId = await ensureFolderItem(client, {
          foldersDatabaseId: folders,
          mailboxItemId: mailbox.id,
          mailboxRelationPropertyId: mailboxProperty.id,
          providerId: "INBOX",
          name: "INBOX",
          behavior: "folder",
          specialPurpose: "inbox",
        });
        personId = (await createItemWithClient(client, { databaseId: peopleId, properties: { name: "Person" } })).id;
      }),
    );
  }
  beforeEach(async () => {
    await resetDatabase(admin);
    currentTenant = getTenantZeroId();
    await setup();
  });
  afterAll(async () => {
    const results = await Promise.allSettled([runtime.end(), admin.end()]);
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Pool settlement failed");
  });

  async function ingest(envelope: MailEnvelope): Promise<string> {
    return runInTenant(tenant(), () =>
      withTransaction(runtime, async (client) => {
        const message = await ingestEmailMessage(client, {
          emailsDatabaseId: emailsId,
          filesDatabaseId: filesId,
          folderRelationPropertyId: folderPropertyId,
          attachmentsRelationPropertyId: attachmentsPropertyId,
          folderItemId: inboxId,
          mailboxItemId: mailboxId,
          messageId: `<${randomUUID()}@example.test>`,
          subject: "Message",
          envelope,
          bodyText: "body",
          attachments: [],
          storage,
          storageKeyPrefix: "test",
        });
        return message.itemId;
      }),
    );
  }
  async function claim(addresses: string, businessPool: Pool = runtime): Promise<void> {
    await runInTenant(tenant(), async () => {
      await withTransaction(businessPool, (client) =>
        updateItemWithClient(client, {
          databaseId: peopleId,
          itemId: personId,
          propertiesPatch: { emails: addresses },
        }),
      );
      await createPersonEmailReindexAction(businessPool)(
        { peopleDatabaseId: peopleId },
        {
          heartbeatId: "test",
          projectItemId: "test",
          itemId: personId,
        },
      );
    });
  }
  async function edges(itemId: string): Promise<string[]> {
    return runInTenant(tenant(), async () => {
      const { rows } = await runtime.query<{ key: string }>(
        `SELECT p.key FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
         JOIN properties p ON p.id = d.property_id_a
         WHERE r.item_a = $1 AND r.item_b = $2 ORDER BY p.key`,
        [itemId, personId],
      );
      return rows.map((row) => row.key);
    });
  }
  async function drain(businessPool: Pool = runtime, queuePool: Pool = admin): Promise<void> {
    const tasks = createCoreTaskList(businessPool, new Map());
    await runOnce({
      pgPool: queuePool,
      taskList: { [CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS]: tasks[CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS]! },
    });
  }
  async function pendingDueJobs(): Promise<string[]> {
    const { rows } = await admin.query<{ id: string }>(
      `SELECT j.id::text FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
       WHERE t.identifier = $1 AND j.run_at <= now() ORDER BY j.id`,
      [CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS],
    );
    return rows.map((row) => row.id);
  }
  async function drainSuccess(businessPool: Pool = runtime, queuePool: Pool = admin): Promise<void> {
    const ids = await pendingDueJobs();
    expect(ids.length).toBeGreaterThan(0);
    await drain(businessPool, queuePool);
    const remaining = await admin.query<{ id: string; last_error: string | null }>(
      "SELECT id::text, last_error FROM graphile_worker._private_jobs WHERE id = ANY($1::bigint[])",
      [ids],
    );
    expect(remaining.rows).toEqual([]);
  }
  async function allSenders(itemId: string): Promise<string[]> {
    return runInTenant(tenant(), async () => {
      const { rows } = await runtime.query<{ target: string }>(
        `SELECT r.item_b AS target FROM item_relations r JOIN relation_definitions d ON d.id = r.relation_definition_id
         JOIN properties p ON p.id = d.property_id_a WHERE r.item_a = $1 AND p.key = 'senderPeople' ORDER BY r.item_b`,
        [itemId],
      );
      return rows.map((row) => row.target);
    });
  }

  function ownedPool(role: boolean): { pool: Pool; active: Set<PoolClient>; errors: unknown[] } {
    const pool = createPool(process.env.TEST_DATABASE_URL ?? "", {
      ...(role ? { role: "semprec_data" as const } : {}),
      statementTimeoutMs: 8000,
    });
    pool.options.max = role ? 1 : 3;
    const active = new Set<PoolClient>();
    const observed = new WeakSet<PoolClient>();
    const errors: unknown[] = [];
    pool.on("acquire", (client: PoolClient) => {
      active.add(client);
      if (!observed.has(client)) {
        observed.add(client);
        client.on("error", (error: unknown) => errors.push(error));
      }
    });
    pool.on("release", (_error: Error | undefined, client: PoolClient) => active.delete(client));
    return { pool, active, errors };
  }
  async function bounded<T>(promise: Promise<T>, ms = 10000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Owned overlap deadline exceeded")), ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function finishOwned(
    operations: Array<Promise<unknown>>,
    pools: Array<ReturnType<typeof ownedPool>>,
    failures: unknown[],
    firstDeadlineMs = 10000,
    ownedSession?: { pid: number; started: string; db: string; cancelled?: boolean },
  ): Promise<{ operationsSettled: boolean; poolsSettled: boolean; poolFailures: boolean }> {
    const settled = Promise.allSettled(operations);
    let outcomes: PromiseSettledResult<unknown>[] | undefined;
    let poolEnds: PromiseSettledResult<void>[] | undefined;
    let ending: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      outcomes = await bounded(settled, firstDeadlineMs);
    } catch (error) {
      failures.push(error);
      // end() closes admission first; only clients owned by these test pools are discarded.
      ending = Promise.allSettled(pools.map((owned) => owned.pool.end()));
      if (!ownedSession) failures.push(new Error("Unresolved owned backend identity after interruption"));
      if (ownedSession) {
        try {
          const cancelled = await admin.query<{ cancelled: boolean }>(
            "SELECT pg_cancel_backend(pid) AS cancelled FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz AND datname = $3",
            [ownedSession.pid, ownedSession.started, ownedSession.db],
          );
          if (cancelled.rows.length !== 1 || !cancelled.rows[0]?.cancelled)
            throw new Error("Owned backend cancellation was not confirmed", { cause: error });
          ownedSession.cancelled = true;
        } catch (cancelError) {
          failures.push(new AggregateError([cancelError], "Owned backend cancellation failed"));
        }
      }
      for (const owned of pools)
        for (const client of owned.active) {
          try {
            client.release(true);
          } catch (releaseError) {
            failures.push(releaseError);
          }
        }
      try {
        outcomes = await bounded(settled);
      } catch (settlementError) {
        failures.push(new AggregateError([settlementError], "Unresolved owned operations after interruption"));
      }
    }
    if (outcomes) for (const outcome of outcomes) if (outcome.status === "rejected") failures.push(outcome.reason);
    ending ??= Promise.allSettled(pools.map((owned) => owned.pool.end()));
    try {
      poolEnds = await bounded(ending);
    } catch (error) {
      failures.push(new AggregateError([error], "Unresolved owned pool settlement"));
    }
    if (poolEnds) for (const outcome of poolEnds) if (outcome.status === "rejected") failures.push(outcome.reason);
    for (const owned of pools) failures.push(...owned.errors);
    return {
      operationsSettled: outcomes !== undefined,
      poolsSettled: poolEnds !== undefined,
      poolFailures: poolEnds?.some((outcome) => outcome.status === "rejected") ?? false,
    };
  }
  async function backendPid(pool: Pool): Promise<number> {
    const { rows } = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    if (!rows[0]) throw new Error("Missing owned backend PID");
    return rows[0].pid;
  }
  async function assertBlocked(waiter: number, blocker: number): Promise<void> {
    for (let i = 0; i < 100; i++) {
      const { rows } = await admin.query<{ blocked: boolean }>(
        "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
        [blocker, waiter],
      );
      if (rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Owned backend ${waiter} did not block on ${blocker}`);
  }

  it("interrupts an owned in-flight query and observes backend and pool settlement", async () => {
    const owned = ownedPool(true);
    const primary = new Error("primary failure");
    const failures: unknown[] = [primary, undefined];
    let setupFailed = false;
    let ownedSession: { pid: number; started: string; db: string; cancelled?: boolean } | undefined;
    let settlement: Awaited<ReturnType<typeof finishOwned>> | undefined;
    let operation: Promise<unknown> | undefined;
    let ownedClient: PoolClient | undefined;
    try {
      const client = await owned.pool.connect();
      ownedClient = client;
      const ownedPid = await client.query<{ pid: number; db: string }>(
        "SELECT pg_backend_pid() AS pid, current_database() AS db",
      );
      if (!ownedPid.rows[0]) throw new Error("Missing checked-out backend PID");
      const identity = await admin.query<{ pid: number; started: string; db: string }>(
        "SELECT pid, backend_start::text AS started, datname AS db FROM pg_stat_activity WHERE pid = $1 AND datname = $2",
        [ownedPid.rows[0].pid, ownedPid.rows[0].db],
      );
      ownedSession = identity.rows[0];
      if (!ownedSession) throw new Error("Missing owned session identity");
      operation = client.query("SELECT pg_sleep(30)");
      void operation.catch(() => {});
      let observed = false;
      for (let i = 0; i < 100; i++) {
        const { rows } = await admin.query<{ active: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz
           AND datname = $3 AND state = 'active' AND wait_event = 'PgSleep') AS active`,
          [ownedSession.pid, ownedSession.started, ownedSession.db],
        );
        if (rows[0]?.active) {
          observed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!observed) {
        const state = await admin.query<{
          pid: number;
          started: string;
          db: string;
          state: string;
          wait: string | null;
        }>(
          "SELECT pid, backend_start::text AS started, datname AS db, state, wait_event AS wait FROM pg_stat_activity WHERE pid = $1",
          [ownedSession.pid],
        );
        throw new Error(`Owned query not observed: ${JSON.stringify({ ownedSession, state: state.rows })}`);
      }
    } catch (error) {
      setupFailed = true;
      failures.push(error);
      if (!operation && ownedClient) {
        try {
          ownedClient.release(true);
        } catch (releaseError) {
          failures.push(releaseError);
        }
      }
    } finally {
      settlement = await finishOwned(operation ? [operation] : [], [owned], failures, 30, ownedSession);
    }
    if (setupFailed) throw new AggregateError(failures, "Owned query setup failed");
    expect(failures[0]).toBe(primary);
    expect(failures[1]).toBeUndefined();
    expect(
      failures.some((error) => error instanceof Error && error.message === "Owned overlap deadline exceeded"),
    ).toBe(true);
    expect(failures.some((error) => error instanceof Error && error.message.includes("Unresolved owned"))).toBe(false);
    expect(
      failures.some((error) => error instanceof Error && error.message === "Owned backend cancellation failed"),
    ).toBe(false);
    expect(owned.active.size).toBe(0);
    expect(settlement).toEqual({ operationsSettled: true, poolsSettled: true, poolFailures: false });
    if (!ownedSession) throw new AggregateError(failures, "Missing owned session identity");
    let absent = false;
    for (let i = 0; i < 100; i++) {
      const after = await admin.query<{ active: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND backend_start = $2::timestamptz AND datname = $3) AS active",
        [ownedSession.pid, ownedSession.started, ownedSession.db],
      );
      if (after.rows[0]?.active === false) {
        absent = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(absent).toBe(true);
    expect(ownedSession.cancelled).toBe(true);
    expect(failures.length).toBeGreaterThanOrEqual(4);
    for (const error of failures.slice(2)) {
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("Unexpected non-error during forced settlement");
      expect(error.message).toMatch(
        /Owned overlap deadline exceeded|Connection terminated|canceling statement due to user request/i,
      );
    }
    console.info(
      "Owned backend cancellation and settlement",
      JSON.stringify({
        ...ownedSession,
        absent,
        settlement,
        failures: failures
          .slice(2)
          .map((error) => (error instanceof Error ? { name: error.name, message: error.message } : null)),
      }),
    );
  });

  it("installs the envelope containment index through the migration runner", async () => {
    const { rows } = await admin.query<{ definition: string }>(
      "SELECT indexdef AS definition FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'mail_message_meta_envelope_gin_idx'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.definition).toContain("USING gin (envelope jsonb_path_ops)");
  });

  it("reconciles two replaced wake-ups for sender, to and cc and leaves replay unchanged", async () => {
    const sender = await ingest({ from: { address: "First@Example.com" } });
    const recipient = await ingest({ to: [{ address: "second@example.com" }], cc: [{ address: "First@Example.com" }] });
    await claim("First@Example.com");
    await claim("First@Example.com\nsecond@example.com");
    const pending = await admin.query<{ payload: unknown }>(
      `SELECT j.payload FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
       WHERE t.identifier = $1`,
      [CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS],
    );
    expect(pending.rows).toHaveLength(1);
    expect(pending.rows[0]!.payload).toMatchObject({ payload: { personId, addresses: ["second@example.com"] } });
    await drain();
    expect(await edges(sender)).toEqual(["senderPeople"]);
    expect(await edges(recipient)).toEqual(["recipientsPeople"]);
    await claim("First@Example.com\nsecond@example.com");
    const repeated = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
       WHERE t.identifier = $1`,
      [CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS],
    );
    expect(repeated.rows[0]!.n).toBe(0);
    const snapshot = () =>
      runInTenant(tenant(), () =>
        runtime.query<{ id: string; version: string }>(
          "SELECT id, xmin::text AS version FROM item_relations WHERE item_b = $1 AND item_a = ANY($2::uuid[]) ORDER BY id",
          [personId, [sender, recipient]],
        ),
      );
    const beforeReplay = await snapshot();
    expect(beforeReplay.rows).toHaveLength(2);
    await runInTenant(tenant(), () =>
      withTransaction(runtime, (client) =>
        enqueueJob(client, CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS, { personId, addresses: ["first@example.com"] }),
      ),
    );
    await drain();
    expect((await snapshot()).rows).toEqual(beforeReplay.rows);
    expect(await edges(sender)).toEqual(["senderPeople"]);
    expect(await edges(recipient)).toEqual(["recipientsPeople"]);
  });
  it("retains a recorded sender after reassignment while linking an unlinked message and recipients", async () => {
    const original = personId;
    const earlier = await ingest({ from: { address: "owner@example.com" }, to: [{ address: "owner@example.com" }] });
    await claim("owner@example.com");
    await drain();
    expect(await edges(earlier)).toEqual(["recipientsPeople", "senderPeople"]);
    await claim("");
    const later = await ingest({ from: { address: "owner@example.com" } });
    personId = await runInTenant(tenant(), () =>
      withTransaction(
        runtime,
        async (client) =>
          (await createItemWithClient(client, { databaseId: peopleId, properties: { name: "New owner" } })).id,
      ),
    );
    await claim("owner@example.com");
    await drain();
    expect(await edges(earlier)).toEqual(["recipientsPeople"]);
    expect(await edges(later)).toEqual(["senderPeople"]);
    personId = original;
    expect(await edges(earlier)).toEqual(["recipientsPeople", "senderPeople"]);
  });

  it("rejects unmanaged and repeatable-read shared linking without writing an edge", async () => {
    const message = await ingest({ from: { address: "sender@example.com" } });
    const input = {
      itemId: message,
      envelope: { from: { address: "sender@example.com" } },
      emailsDatabaseId: emailsId,
      senderPeopleKey: "senderPeople",
      recipientsPeopleKey: "recipientsPeople",
    };
    const client = await runtime.connect();
    try {
      await expect(runInTenant(tenant(), () => linkEmailEnvelopeToPeople(client, input))).rejects.toThrow(
        /managed transaction/,
      );
    } finally {
      client.release();
    }
    await expect(
      runInTenant(tenant(), () =>
        withTransaction(runtime, (transaction) => linkEmailEnvelopeToPeople(transaction, input), {
          isolation: "repeatable_read",
        }),
      ),
    ).rejects.toThrow(/READ COMMITTED/);
    expect(await edges(message)).toEqual([]);
  });
  it("serializes an actual job behind a held shared linker for the same sender", async () => {
    const message = await ingest({ from: { address: "overlap@example.com" } });
    await claim("overlap@example.com");
    const workerPool = ownedPool(true);
    const holderPool = ownedPool(true);
    const queuePool = ownedPool(false);
    const failures: unknown[] = [];
    let release!: () => void;
    let ready!: (pid: number) => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const shared = runInTenant(tenant(), () =>
      withTransaction(holderPool.pool, async (client) => {
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await linkEmailEnvelopeToPeople(client, {
          itemId: message,
          envelope: { from: { address: "overlap@example.com" } },
          emailsDatabaseId: emailsId,
          senderPeopleKey: "senderPeople",
          recipientsPeopleKey: "recipientsPeople",
        });
        ready(rows[0]!.pid);
        await held;
      }),
    );
    let worker: Promise<void> | undefined;
    try {
      const blocker = await bounded(
        Promise.race([
          acquired,
          shared.then(() => {
            throw new Error("Shared linker ended early");
          }),
        ]),
      );
      const workerPid = await backendPid(workerPool.pool);
      worker = drainSuccess(workerPool.pool, queuePool.pool);
      void worker.catch(() => {});
      await assertBlocked(workerPid, blocker);
    } catch (error) {
      failures.push(error);
    } finally {
      release();
      await finishOwned([shared, ...(worker ? [worker] : [])], [workerPool, holderPool, queuePool], failures);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Overlap test or settlement failed");
    expect(await allSenders(message)).toEqual([personId]);
  });
  it("a claim during a held worker pass triggers a new pass from the beginning", async () => {
    const messages = [
      await ingest({ from: { address: "first@example.com" }, to: [{ address: "later@example.com" }] }),
      await ingest({ from: { address: "first@example.com" }, to: [{ address: "later@example.com" }] }),
    ].sort();
    const older = messages[0]!;
    const later = messages[1]!;
    await claim("first@example.com");
    const initialJobs = await pendingDueJobs();
    expect(initialJobs).toHaveLength(1);
    let laterJobId: string | undefined;
    const workerPool = ownedPool(true);
    const holderPool = ownedPool(true);
    const queuePool = ownedPool(false);
    const failures: unknown[] = [];
    let release!: () => void;
    let ready!: (pid: number) => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const holder = runInTenant(tenant(), () =>
      withTransaction(holderPool.pool, async (client) => {
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE", [emailsId, later]);
        ready(rows[0]!.pid);
        await held;
      }),
    );
    let worker: Promise<void> | undefined;
    try {
      const blocker = await bounded(
        Promise.race([
          acquired,
          holder.then(() => {
            throw new Error("Holder ended early");
          }),
        ]),
      );
      const workerPid = await backendPid(workerPool.pool);
      worker = drainSuccess(workerPool.pool, queuePool.pool);
      void worker.catch(() => {});
      await assertBlocked(workerPid, blocker);
      await claim("first@example.com\nlater@example.com");
      const laterJob = await admin.query<{ id: string }>(
        "SELECT id::text FROM graphile_worker._private_jobs WHERE key = $1",
        [`mail-link-person-emails:${personId}`],
      );
      expect(laterJob.rows).toHaveLength(1);
      laterJobId = laterJob.rows[0]!.id;
      expect(laterJobId).not.toBe(initialJobs[0]);
    } catch (error) {
      failures.push(error);
    } finally {
      release();
      await finishOwned([holder, ...(worker ? [worker] : [])], [workerPool, holderPool, queuePool], failures);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Running claim test or settlement failed");
    if (!laterJobId) throw new Error("Missing later owned job");
    const remaining = await admin.query<{ id: string }>(
      "SELECT id::text FROM graphile_worker._private_jobs WHERE id = $1",
      [laterJobId],
    );
    if (remaining.rows.length > 0) await drainSuccess();
    expect(
      (await admin.query("SELECT id FROM graphile_worker._private_jobs WHERE id = $1", [laterJobId])).rows,
    ).toEqual([]);
    expect(await edges(later)).toEqual(["recipientsPeople", "senderPeople"]);
    expect(await edges(older)).toEqual(["recipientsPeople", "senderPeople"]);
    expect(await allSenders(later)).toEqual([personId]);
  });
  it("holds index ownership until its page commits before a release can finish", async () => {
    const message = await ingest({ from: { address: "held@example.com" } });
    await claim("held@example.com");
    const workerPool = ownedPool(true);
    const holderPool = ownedPool(true);
    const releasePool = ownedPool(true);
    const queuePool = ownedPool(false);
    const failures: unknown[] = [];
    let release!: () => void;
    let ready!: (pid: number) => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const holder = runInTenant(tenant(), () =>
      withTransaction(holderPool.pool, async (client) => {
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE", [emailsId, message]);
        ready(rows[0]!.pid);
        await held;
      }),
    );
    let worker: Promise<void> | undefined;
    let removal: Promise<void> | undefined;
    try {
      const blocker = await bounded(
        Promise.race([
          acquired,
          holder.then(() => {
            throw new Error("Holder ended early");
          }),
        ]),
      );
      const workerPid = await backendPid(workerPool.pool);
      const removalPid = await backendPid(releasePool.pool);
      worker = drainSuccess(workerPool.pool, queuePool.pool);
      void worker.catch(() => {});
      await assertBlocked(workerPid, blocker);
      removal = claim("", releasePool.pool);
      void removal.catch(() => {});
      await assertBlocked(removalPid, workerPid);
    } catch (error) {
      failures.push(error);
    } finally {
      release();
      await finishOwned(
        [holder, ...(worker ? [worker] : []), ...(removal ? [removal] : [])],
        [workerPool, holderPool, releasePool, queuePool],
        failures,
      );
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Index ownership test or settlement failed");
    expect(await allSenders(message)).toEqual([personId]);
  });
  it("reconciles an old wake-up after reassignment and preserves recorded edges", async () => {
    const oldPerson = personId;
    const historical = await ingest({
      from: { address: "removed@example.com" },
      to: [{ address: "removed@example.com" }],
    });
    await claim("removed@example.com");
    await drain();
    expect(await edges(historical)).toEqual(["recipientsPeople", "senderPeople"]);
    await claim("");
    const message = await ingest({
      from: { address: "removed@example.com" },
      to: [{ address: "removed@example.com" }],
    });
    await claim("removed@example.com");
    const oldQueued = await admin.query<{ payload: unknown }>(
      "SELECT payload FROM graphile_worker._private_jobs WHERE key = $1",
      [`mail-link-person-emails:${oldPerson}`],
    );
    expect(oldQueued.rows).toHaveLength(1);
    expect(oldQueued.rows[0]?.payload).toEqual({
      traceId: expect.any(String),
      tenantId: tenant(),
      payload: { personId: oldPerson, addresses: ["removed@example.com"] },
    });
    await claim("");
    personId = await runInTenant(tenant(), () =>
      withTransaction(
        runtime,
        async (client) =>
          (await createItemWithClient(client, { databaseId: peopleId, properties: { name: "New owner" } })).id,
      ),
    );
    await claim("removed@example.com");
    const owner = personId;
    const queued = () =>
      admin.query<{ id: string; key: string }>(
        `SELECT j.id::text, j.key FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
       WHERE t.identifier = $1 ORDER BY j.key`,
        [CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS],
      );
    const jobs = (await queued()).rows;
    const oldJob = jobs.find((job) => job.key === `mail-link-person-emails:${oldPerson}`);
    const newJob = jobs.find((job) => job.key === `mail-link-person-emails:${owner}`);
    if (!oldJob || !newJob) throw new Error("Missing owned jobs");
    personId = oldPerson;
    await claim("removed@example.com");
    expect((await queued()).rows).toEqual(jobs);
    await admin.query("UPDATE graphile_worker._private_jobs SET run_at = now() + interval '1 hour' WHERE id = $1", [
      newJob.id,
    ]);
    await drainSuccess();
    expect((await queued()).rows).toEqual([newJob]);
    expect(await edges(message)).toEqual([]);
    expect(await edges(historical)).toEqual(["recipientsPeople", "senderPeople"]);
    await admin.query("UPDATE graphile_worker._private_jobs SET run_at = now() WHERE id = $1", [newJob.id]);
    await drainSuccess();
    expect((await queued()).rows).toEqual([]);
    personId = owner;
    expect(await edges(message)).toEqual(["recipientsPeople", "senderPeople"]);
    expect(await edges(historical)).toEqual(["recipientsPeople"]);
  });

  it("scopes worker ownership and mail to each tenant, refusing a foreign person hint", async () => {
    const a = { tenant: tenant(), person: personId };
    const first = await ingest({ from: { address: "same@example.com" } });
    await claim("same@example.com");
    currentTenant = await createTestTenant(admin);
    await setup();
    const b = { tenant: tenant(), person: personId };
    const second = await ingest({ from: { address: "same@example.com" } });
    await claim("same@example.com");
    await runInTenant(b.tenant, () =>
      withTransaction(runtime, (client) =>
        enqueueJob(client, CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS, {
          personId: a.person,
          addresses: ["same@example.com"],
        }),
      ),
    );
    await drain();
    expect(await edges(second)).toEqual(["senderPeople"]);
    personId = a.person;
    expect(await edges(second)).toEqual([]);
    currentTenant = a.tenant;
    personId = a.person;
    expect(await edges(first)).toEqual(["senderPeople"]);
    personId = b.person;
    expect(await edges(first)).toEqual([]);
  });
  it("continues beyond one mail page without losing matches", async () => {
    const messages: string[] = [];
    for (let i = 0; i < 101; i++) messages.push(await ingest({ to: [{ address: "page@example.com" }] }));
    await claim("page@example.com");
    await drain();
    for (const message of messages) expect(await edges(message)).toEqual(["recipientsPeople"]);
  });
  it("rejects a malformed queued payload and leaves mail unchanged", async () => {
    const message = await ingest({ from: { address: "invalid@example.com" } });
    await runInTenant(tenant(), () =>
      withTransaction(runtime, (client) =>
        enqueueJob(
          client,
          CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS,
          { personId, addresses: "invalid" },
          { maxAttempts: 3 },
        ),
      ),
    );
    await drain();
    expect(await edges(message)).toEqual([]);
    const { rows } = await admin.query<{ attempts: number; last_error: string | null }>(
      `SELECT j.attempts, j.last_error FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
       WHERE t.identifier = $1`,
      [CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attempts).toBe(1);
    expect(rows[0]!.last_error).toBeTruthy();
  });
});
