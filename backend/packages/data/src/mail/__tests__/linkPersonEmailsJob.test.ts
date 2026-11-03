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
  async function claim(addresses: string): Promise<void> {
    await runInTenant(tenant(), async () => {
      await withTransaction(runtime, (client) =>
        updateItemWithClient(client, {
          databaseId: peopleId,
          itemId: personId,
          propertiesPatch: { emails: addresses },
        }),
      );
      await createPersonEmailReindexAction(runtime)(
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
  async function drain(): Promise<void> {
    const tasks = createCoreTaskList(runtime, new Map());
    await runOnce({
      pgPool: admin,
      taskList: { [CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS]: tasks[CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS]! },
    });
  }
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
    let release!: () => void;
    let ready!: (pid: number) => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const shared = runInTenant(tenant(), () =>
      withTransaction(runtime, async (client) => {
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
    const failures: unknown[] = [];
    let worker: Promise<void> | undefined;
    try {
      const timer = setTimeout(() => release(), 5_000);
      let blocker: number;
      try {
        blocker = await Promise.race([
          acquired,
          shared.then(() => {
            throw new Error("Shared linker finished before acquiring the barrier");
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      worker = drain().catch((error: unknown) => {
        failures.push(error);
      });
      let blocked = false;
      for (let i = 0; i < 100; i++) {
        const { rows } = await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))",
          [blocker],
        );
        if (rows.length > 0) {
          blocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
    } catch (error) {
      failures.push(error);
    }
    release();
    for (const operation of [shared, worker]) {
      if (!operation) continue;
      try {
        await operation;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Overlap test or settlement failed");
    expect(await edges(message)).toEqual(["senderPeople"]);
  });
  it("a claim during a held worker pass triggers a new pass from the beginning", async () => {
    const messages = [
      await ingest({ from: { address: "first@example.com" }, to: [{ address: "later@example.com" }] }),
      await ingest({ from: { address: "first@example.com" }, to: [{ address: "later@example.com" }] }),
    ].sort();
    const older = messages[0]!;
    const later = messages[1]!;
    await claim("first@example.com");
    let release!: () => void;
    let ready!: (pid: number) => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const holder = runInTenant(tenant(), () =>
      withTransaction(runtime, async (client) => {
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE", [emailsId, later]);
        ready(rows[0]!.pid);
        await held;
      }),
    );
    const failures: unknown[] = [];
    let worker: Promise<void> | undefined;
    try {
      const blocker = await Promise.race([
        acquired,
        holder.then(() => {
          throw new Error("Holder ended early");
        }),
      ]);
      worker = drain().catch((error: unknown) => {
        failures.push(error);
      });
      let workerPid: number | undefined;
      for (let i = 0; i < 100; i++) {
        const { rows } = await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))",
          [blocker],
        );
        if (rows[0]) {
          workerPid = rows[0].pid;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(workerPid).toBeDefined();
      await claim("first@example.com\nlater@example.com");
    } catch (error) {
      failures.push(error);
    }
    release();
    for (const operation of [holder, worker]) {
      if (!operation) continue;
      try {
        await operation;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Running claim test or settlement failed");
    await drain();
    expect(await edges(later)).toEqual(["recipientsPeople", "senderPeople"]);
    expect(await edges(older)).toEqual(["recipientsPeople", "senderPeople"]);
  });
  it("holds index ownership until its page commits before a release can finish", async () => {
    const message = await ingest({ from: { address: "held@example.com" } });
    await claim("held@example.com");
    let release!: () => void;
    let ready!: (pid: number) => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const holder = runInTenant(tenant(), () =>
      withTransaction(runtime, async (client) => {
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        await client.query("SELECT id FROM items WHERE database_id = $1 AND id = $2 FOR UPDATE", [emailsId, message]);
        ready(rows[0]!.pid);
        await held;
      }),
    );
    const failures: unknown[] = [];
    let worker: Promise<void> | undefined;
    let removal: Promise<void> | undefined;
    try {
      const blocker = await Promise.race([
        acquired,
        holder.then(() => {
          throw new Error("Holder ended early");
        }),
      ]);
      worker = drain().catch((error: unknown) => {
        failures.push(error);
      });
      let workerPid: number | undefined;
      for (let i = 0; i < 100; i++) {
        const { rows } = await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))",
          [blocker],
        );
        if (rows[0]) {
          workerPid = rows[0].pid;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (workerPid === undefined) throw new Error("Worker did not block on message");
      removal = claim("").catch((error: unknown) => {
        failures.push(error);
      });
      let releaseBlocked = false;
      for (let i = 0; i < 100; i++) {
        const { rows } = await admin.query<{ pid: number }>(
          "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND $1 = ANY(pg_blocking_pids(pid))",
          [workerPid],
        );
        if (rows.length > 0) {
          releaseBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(releaseBlocked).toBe(true);
    } catch (error) {
      failures.push(error);
    }
    release();
    for (const operation of [holder, worker, removal]) {
      if (!operation) continue;
      try {
        await operation;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Index ownership test or settlement failed");
    expect(await edges(message)).toEqual(["senderPeople"]);
  });
  it("removed or conflicting claims do not authorize an old pending job", async () => {
    const oldPerson = personId;
    const message = await ingest({ from: { address: "removed@example.com" } });
    await claim("removed@example.com");
    await claim("");
    await drain();
    expect(await edges(message)).toEqual([]);
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
      admin.query<{ key: string | null }>(
        `SELECT j.key FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
       WHERE t.identifier = $1 ORDER BY j.key`,
        [CORE_TASK_NAMES.MAIL_LINK_PERSON_EMAILS],
      );
    const beforeConflict = (await queued()).rows;
    personId = oldPerson;
    await claim("removed@example.com");
    expect((await queued()).rows).toEqual(beforeConflict);
    await drain();
    expect(await edges(message)).toEqual([]);
    personId = owner;
    expect(await edges(message)).toEqual(["senderPeople"]);
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
