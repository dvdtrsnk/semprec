import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, enqueueJob, runOnce } from "@semprec/queue";
import type { Pool, PoolClient } from "pg";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createRuntimeRolePool, createTestTenant, getTenantZeroId } from "../../testSupport/tenantFixtures.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createBlob, getBlob } from "../../blobs/blobsStore.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { purgeExpiredTrash } from "../../trash/purgeExpiredTrash.js";
import type { ItemRow } from "../../types.js";
import { createInboxItemWithClient } from "../inboxStore.js";
import { insertInboxAttachments as insertWithClient, listInboxAttachments } from "../inboxAttachmentsStore.js";
import { LocalFsBlobStorageWriter } from "../../mail/blobStorage.js";
import { ingestUploadedBlob } from "../../blobs/fileUploadStore.js";
import { createApiCoreTaskList } from "../../worker.js";
import { createActionRegistry } from "../../scheduler/actions.js";
import { resolveMailModuleIds } from "../../mail/mailModuleIds.js";
import { ingestEmailMessage } from "../../mail/ingest.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";

function insertInboxAttachments(owner: Pool, itemId: string, attachments: Parameters<typeof insertWithClient>[2]) {
  return withTransaction(owner, (client) => insertWithClient(client, itemId, attachments));
}

// Issue #1564: an attachment keeps its blob's bytes while it exists, and the trash purge of its Inbox
// item releases the blob only when nothing else names it.

/** Captures the backend on the very client that issues the matched production statement. */
function observeStatementPid(runtime: Pool, statement: RegExp) {
  let resolvePid!: (pid: number) => void;
  const pid = new Promise<number>((resolve) => {
    resolvePid = resolve;
  });
  const wrapped = new Map<PoolClient, PoolClient["query"]>();
  let captured = false;
  const instrument = (client: PoolClient) => {
    if (wrapped.has(client)) return;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    wrapped.set(client, client.query);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    client.query = new Proxy(client.query, {
      apply(target, receiver, args: unknown[]) {
        if (captured || typeof args[0] !== "string" || !statement.test(args[0])) {
          return Reflect.apply(target, receiver, args);
        }
        captured = true;
        return (async () => {
          const result = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
          const actual = result.rows[0]?.pid;
          if (actual === undefined) throw new Error("missing competing backend pid");
          resolvePid(actual);
          return Reflect.apply(target, receiver, args);
        })();
      },
    });
  };
  runtime.on("acquire", instrument);
  return {
    pid,
    restore() {
      runtime.off("acquire", instrument);
      for (const [client, query] of wrapped) client.query = query;
    },
  };
}

let pool: Pool;
let chokePoint: ChokePoint;

async function bounded<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("barrier timed out")), 5000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** A storage double whose only exercised method is `delete`; the purge never reads or writes bytes. */
function fakeStorage() {
  const deleteMock = vi.fn(async (_storageKey: string) => {});
  const storage: BlobStorageWriter = {
    writeStream: () => Promise.reject(new Error("not used by the purge")),
    readStream: () => {
      throw new Error("not used by the purge");
    },
    delete: deleteMock,
  };
  return { storage, deleteMock };
}

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function createInboxItem(text: string): Promise<ItemRow> {
  const inboxDatabaseId = await databaseIdFor("inbox");
  return withTransaction(pool, (client) =>
    createInboxItemWithClient(client, {
      inboxDatabaseId,
      date: "2026-08-28",
      time: "09:00",
      text,
    }),
  );
}

/** Backdates a trashed item's `deleted_at` past the 30-day retention, the way real trash ages over time. */
async function ageDeletion(itemId: string, databaseId: string): Promise<void> {
  await pool.query(`UPDATE items SET deleted_at = now() - interval '31 days' WHERE id = $1 AND database_id = $2`, [
    itemId,
    databaseId,
  ]);
}

async function countRows(sql: string, params: unknown[]): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${sql}`, params);
  return Number(rows[0]?.count);
}

/** A Files item whose `properties.file.blobId` names `blobId`. Raw update, as `purgeExpiredTrash.test.ts` does, to name a blob from a Files item. */
async function makeFilesItem(blobId: string): Promise<ItemRow> {
  const { id: databaseId } = await chokePoint.createDatabase({ name: `Files ${blobId}` });
  const item = await chokePoint.createItem({ databaseId, properties: {} });
  await pool.query(
    `UPDATE items SET properties = jsonb_build_object('file', jsonb_build_object('blobId', $2::text)) WHERE id = $1`,
    [item.id, blobId],
  );
  return item;
}

describe("Inbox attachments as counted blob references (issue #1564)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    await seedSystem(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("removes standalone Files-root bytes through the real API purge task", async () => {
    const directory = await mkdtemp(join(tmpdir(), "semprec-dual-root-"));
    const filesDir = join(directory, "files");
    const mailDir = join(directory, "mail");
    const files = new LocalFsBlobStorageWriter(filesDir);
    const mail = new LocalFsBlobStorageWriter(mailDir);
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      const blob = await runInTenant(getTenantZeroId(), () =>
        ingestUploadedBlob(runtime, {
          mimeType: "image/png",
          source: Readable.from([Buffer.from("standalone content")]),
          maxBytes: 1024,
          storage: files,
        }),
      );
      const item = await createInboxItem("dual root");
      await insertInboxAttachments(pool, item.id, [{ blobId: blob.blob.id, source: "camera" }]);
      await chokePoint.softDeleteItem(item.databaseId, item.id);
      await ageDeletion(item.id, item.databaseId);
      await access(join(filesDir, blob.blob.storageKey));
      const tasks = createApiCoreTaskList(
        runtime,
        createActionRegistry(),
        undefined,
        undefined,
        mail,
        undefined,
        undefined,
        undefined,
        undefined,
        files,
        { files: filesDir, mailAttachments: mailDir },
      );
      const handler = tasks[CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP];
      if (!handler) throw new Error("missing API purge handler");
      await runAsSystem("test trash purge", () => enqueueJob(pool, CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP, {}));
      await runOnce({ pgPool: pool, taskList: { [CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP]: handler } });
      expect(await getBlob(pool, blob.blob.id)).toBeNull();
      expect(await listInboxAttachments(pool, [item.id])).toEqual([]);
      await expect(access(join(filesDir, blob.blob.storageKey))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await runtime.end();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    [CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP, "files-first", "retains the surviving mail reference"],
    [CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP, "mail-first", "retains the surviving mail reference"],
    [CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP, "files-first", "deletes after fixture-only mail reference removal"],
    [CORE_TASK_NAMES.ITEM_TRASH_PURGE_SWEEP, "mail-first", "deletes after fixture-only mail reference removal"],
    [CORE_TASK_NAMES.TRASH_PURGE, "files-first", "retains the surviving mail reference"],
    [CORE_TASK_NAMES.TRASH_PURGE, "mail-first", "retains the surviving mail reference"],
    [CORE_TASK_NAMES.TRASH_PURGE, "files-first", "deletes after fixture-only mail reference removal"],
    [CORE_TASK_NAMES.TRASH_PURGE, "mail-first", "deletes after fixture-only mail reference removal"],
  ] as const)(
    "%s / %s: %s through the API purge task",
    async (taskName, order, scenario) => {
      const directory = await mkdtemp(join(tmpdir(), "semprec-dual-origin-"));
      const filesDir = join(directory, "files");
      const mailDir = join(directory, "mail");
      const files = new LocalFsBlobStorageWriter(filesDir);
      const mail = new LocalFsBlobStorageWriter(mailDir);
      const runtime = await createRuntimeRolePool(pool, "semprec_data");
      try {
        const ids = await withTransaction(pool, (client) => resolveMailModuleIds(client));
        const emails = await databaseIdFor("emails");
        const folders = await databaseIdFor("folders");
        const properties = await chokePoint.listProperties(emails);
        const folderProperty = properties.find((p) => p.key === "folder");
        const attachmentsProperty = properties.find((p) => p.key === "attachments");
        if (!folderProperty || !attachmentsProperty) throw new Error("missing mail properties");
        const folder = await withTransaction(pool, (client) =>
          createItemWithClient(
            client,
            { databaseId: folders, properties: { name: "INBOX" } },
            { allowedSystemKeys: ["name"] },
          ),
        );
        const content = Buffer.from("shared attachment bytes");
        const upload = () =>
          runInTenant(getTenantZeroId(), () =>
            ingestUploadedBlob(runtime, {
              mimeType: "image/png",
              source: Readable.from([content]),
              maxBytes: 1024,
              storage: files,
            }),
          );
        const ingest = () =>
          runInTenant(getTenantZeroId(), () =>
            withTransaction(runtime, (client) =>
              ingestEmailMessage(client, {
                emailsDatabaseId: emails,
                filesDatabaseId: ids.filesDatabaseId,
                folderRelationPropertyId: folderProperty.id,
                attachmentsRelationPropertyId: attachmentsProperty.id,
                folderItemId: folder.id,
                mailboxItemId: randomUUID(),
                messageId: `<${order}@example.test>`,
                envelope: {},
                attachments: [
                  {
                    filename: "shared.bin",
                    contentType: "application/octet-stream",
                    contentId: null,
                    disposition: "attachment",
                    openStream: () => Readable.from([content]),
                  },
                ],
                storage: mail,
                storageKeyPrefix: "mailbox",
              }),
            ),
          );
        const firstUpload = order === "files-first" ? await upload() : undefined;
        const message = await ingest();
        const uploadResult = firstUpload ?? (await upload());
        const refs = await pool.query<{ id: string; storage_key: string }>(
          "SELECT b.id, b.storage_key FROM mail_attachments a JOIN blobs b ON b.id = a.blob_id WHERE a.message_item_id = $1",
          [message.itemId],
        );
        expect(refs.rows).toHaveLength(1);
        const blob = refs.rows[0];
        if (!blob) throw new Error("missing mail blob");
        expect(blob.id).toBe(uploadResult.blob.id);
        expect(uploadResult.created).toBe(order === "files-first");
        const actualRoot = order === "files-first" ? filesDir : mailDir;
        await access(join(actualRoot, blob.storage_key));
        const fileItems = await pool.query<{ id: string }>(
          "SELECT id FROM items WHERE database_id = $1 AND properties->'file'->>'blobId' = $2",
          [ids.filesDatabaseId, blob.id],
        );
        expect(fileItems.rows).toHaveLength(1);
        await chokePoint.softDeleteItem(emails, message.itemId);
        await ageDeletion(message.itemId, emails);
        for (const item of fileItems.rows) {
          await chokePoint.softDeleteItem(ids.filesDatabaseId, item.id);
          await ageDeletion(item.id, ids.filesDatabaseId);
        }
        if (scenario === "deletes after fixture-only mail reference removal") {
          // Fixture only: production email purge does not remove this reference.
          const released = await runInTenant(getTenantZeroId(), () =>
            withTransaction(runtime, (client) =>
              client.query(
                "DELETE FROM mail_attachments WHERE tenant_id = app_tenant_default() AND message_item_id = $1 AND blob_id = $2",
                [message.itemId, blob.id],
              ),
            ),
          );
          expect(released.rowCount).toBe(1);
        }
        const tasks = createApiCoreTaskList(
          runtime,
          createActionRegistry(),
          undefined,
          undefined,
          mail,
          undefined,
          undefined,
          undefined,
          undefined,
          files,
          { files: filesDir, mailAttachments: mailDir },
        );
        const handler = tasks[taskName];
        if (!handler) throw new Error("missing API purge handler");
        await runAsSystem("test trash purge", () => enqueueJob(pool, taskName, {}));
        await runOnce({ pgPool: pool, taskList: { [taskName]: handler } });
        const remainingItems = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM items WHERE id = ANY($1::uuid[])",
          [[message.itemId, ...fileItems.rows.map((item) => item.id)]],
        );
        expect(remainingItems.rows[0]?.count).toBe(0);
        const otherRefs = await pool.query<{ count: number }>(
          `SELECT ((SELECT count(*) FROM items WHERE tenant_id = $1 AND properties->'file'->>'blobId' = $2) +
                   (SELECT count(*) FROM inbox_attachments WHERE tenant_id = $1 AND blob_id = $2::uuid))::int AS count`,
          [getTenantZeroId(), blob.id],
        );
        expect(otherRefs.rows[0]?.count).toBe(0);
        const remainingReferences = await pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM mail_attachments WHERE tenant_id = $1 AND message_item_id = $2 AND blob_id = $3",
          [getTenantZeroId(), message.itemId, blob.id],
        );
        if (scenario === "retains the surviving mail reference") {
          expect(remainingReferences.rows[0]?.count).toBe(1);
          expect(await getBlob(pool, blob.id)).not.toBeNull();
          await access(join(actualRoot, blob.storage_key));
        } else {
          expect(remainingReferences.rows[0]?.count).toBe(0);
          expect(await getBlob(pool, blob.id)).toBeNull();
          await expect(access(join(actualRoot, blob.storage_key))).rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        await runtime.end();
        await rm(directory, { recursive: true, force: true });
      }
    },
    20000,
  );

  it("attempts both distinct roots after commit even if the first delete fails", async () => {
    const item = await createInboxItem("two roots");
    const blob = await createBlob(pool, { mimeType: "image/png", byteSize: 1, storageKey: "t/blobs/two-roots" });
    await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "camera" }]);
    await chokePoint.softDeleteItem(item.databaseId, item.id);
    await ageDeletion(item.id, item.databaseId);
    const first = fakeStorage();
    const second = fakeStorage();
    first.deleteMock.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { code: "EIO" }));
    expect(await purgeExpiredTrash(pool, first.storage, 30, second.storage)).toBe(1);
    expect(await getBlob(pool, blob.id)).toBeNull();
    expect(first.deleteMock).toHaveBeenCalledExactlyOnceWith(blob.storageKey);
    expect(second.deleteMock).toHaveBeenCalledExactlyOnceWith(blob.storageKey);
  });

  it("does not delete the same root object twice", async () => {
    const item = await createInboxItem("one root");
    const blob = await createBlob(pool, { mimeType: "image/png", byteSize: 1, storageKey: "t/blobs/one-root" });
    await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "camera" }]);
    await chokePoint.softDeleteItem(item.databaseId, item.id);
    await ageDeletion(item.id, item.databaseId);
    const root = fakeStorage();
    expect(await purgeExpiredTrash(pool, root.storage, 30, root.storage)).toBe(1);
    expect(root.deleteMock).toHaveBeenCalledExactlyOnceWith(blob.storageKey);
  });

  it("rejects a purge without a tenant scope before looking up its root", async () => {
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    try {
      await expect(
        runAsSystem("test missing purge tenant", () =>
          createChokePoint(runtime).purgeExpiredTrashSubtree(randomUUID(), new Date()),
        ),
      ).rejects.toThrow("Tenant scope is required for trash purge");
    } finally {
      await runtime.end();
    }
  });

  it("keeps rows and physical bytes after rollback, then removes them on retry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "semprec-purge-rollback-"));
    const files = new LocalFsBlobStorageWriter(join(directory, "files"));
    const mail = new LocalFsBlobStorageWriter(join(directory, "mail"));
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const originals = new Map<PoolClient, PoolClient["query"]>();
    let injected = false;
    const instrument = (client: PoolClient) => {
      if (originals.has(client)) return;
      // The proxy forwards the original receiver and the method is restored before the pool closes.
      /* eslint-disable @typescript-eslint/unbound-method */
      originals.set(client, client.query);
      client.query = new Proxy(client.query, {
        apply(target, receiver, args: unknown[]) {
          const result: unknown = Reflect.apply(target, receiver, args);
          if (injected || typeof args[0] !== "string" || !args[0].startsWith("DELETE FROM inbox_attachments"))
            return result;
          injected = true;
          return Promise.resolve(result).then(() => {
            throw new Error("injected purge rollback");
          });
        },
      });
      /* eslint-enable @typescript-eslint/unbound-method */
    };
    try {
      const upload = await runInTenant(getTenantZeroId(), () =>
        ingestUploadedBlob(runtime, {
          mimeType: "image/png",
          source: Readable.from([Buffer.from("rollback bytes")]),
          maxBytes: 1024,
          storage: files,
        }),
      );
      const item = await createInboxItem("rollback");
      await insertInboxAttachments(pool, item.id, [{ blobId: upload.blob.id, source: "camera" }]);
      await chokePoint.softDeleteItem(item.databaseId, item.id);
      await ageDeletion(item.id, item.databaseId);
      runtime.on("acquire", instrument);
      expect(await runInTenant(getTenantZeroId(), () => purgeExpiredTrash(runtime, mail, 30, files))).toBe(0);
      expect(injected).toBe(true);
      expect(await getBlob(pool, upload.blob.id)).not.toBeNull();
      expect(await listInboxAttachments(pool, [item.id])).toHaveLength(1);
      await access(join(directory, "files", upload.blob.storageKey));
      runtime.off("acquire", instrument);
      for (const [client, original] of originals) client.query = original;
      expect(await runInTenant(getTenantZeroId(), () => purgeExpiredTrash(runtime, mail, 30, files))).toBe(1);
      expect(await getBlob(pool, upload.blob.id)).toBeNull();
      await expect(access(join(directory, "files", upload.blob.storageKey))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      runtime.off("acquire", instrument);
      for (const [client, original] of originals) client.query = original;
      await runtime.end();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["first", "second"] as const)(
    "serializes mixed multi-item purges with %s root first while another tenant progresses",
    async (order) => {
      const first = await createInboxItem("first root");
      const second = await createInboxItem("second root");
      const a = await createBlob(pool, { mimeType: "image/png", byteSize: 1, storageKey: "t/blobs/a" });
      const b = await createBlob(pool, { mimeType: "image/png", byteSize: 1, storageKey: "t/blobs/b" });
      await insertInboxAttachments(pool, first.id, [
        { blobId: a.id, source: "camera" },
        { blobId: b.id, source: "camera" },
      ]);
      await insertInboxAttachments(pool, second.id, [
        { blobId: b.id, source: "camera" },
        { blobId: a.id, source: "camera" },
      ]);
      const inline = await chokePoint.createInlineDatabase({ name: "Nested files", parentItemId: first.id });
      await chokePoint.createProperty({ databaseId: inline.id, key: "file", name: "File", type: "file" });
      const child = await chokePoint.createItem({ databaseId: inline.id, properties: { file: { blobId: a.id } } });
      for (const item of [first, second]) {
        await chokePoint.softDeleteItem(item.databaseId, item.id);
        await ageDeletion(item.id, item.databaseId);
      }
      await ageDeletion(child.id, inline.id);
      const rootX = order === "first" ? first : second;
      const rootY = order === "first" ? second : first;
      const otherTenant = await createTestTenant(pool);
      const one = await createRuntimeRolePool(pool, "semprec_data");
      const two = await createRuntimeRolePool(pool, "semprec_data");
      const three = await createRuntimeRolePool(pool, "semprec_data");
      const competing = observeStatementPid(two, /pg_advisory_xact_lock/i);
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      let signal!: () => void;
      const acquired = new Promise<void>((resolve) => {
        signal = resolve;
      });
      const originals = new Map<PoolClient, PoolClient["query"]>();
      let ownerPid = 0;
      const instrument = (client: PoolClient) => {
        if (originals.has(client)) return;
        // The proxy forwards the original receiver and the method is restored before releasing the pool.
        /* eslint-disable @typescript-eslint/unbound-method */
        originals.set(client, client.query);
        client.query = new Proxy(client.query, {
          apply(target, receiver, args: unknown[]) {
            const result: unknown = Reflect.apply(target, receiver, args);
            if (typeof args[0] !== "string" || !args[0].includes("pg_advisory_xact_lock")) return result;
            return Promise.resolve(result).then(async (value: unknown) => {
              ownerPid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid ?? 0;
              signal();
              await hold;
              return value;
            });
          },
        });
        /* eslint-enable @typescript-eslint/unbound-method */
      };
      one.on("acquire", instrument);
      const x = runInTenant(getTenantZeroId(), () =>
        createChokePoint(one).purgeExpiredTrashSubtree(rootX.id, new Date()),
      );
      const xSettled = Promise.allSettled([x]);
      let y: ReturnType<ChokePoint["purgeExpiredTrashSubtree"]> | undefined;
      let ySettled: Promise<PromiseSettledResult<Awaited<typeof y>>[]> | undefined;
      try {
        await bounded(
          Promise.race([
            acquired,
            x.then(() => {
              throw new Error("first purge ended before barrier");
            }),
          ]),
        );
        y = runInTenant(getTenantZeroId(), () => createChokePoint(two).purgeExpiredTrashSubtree(rootY.id, new Date()));
        ySettled = Promise.allSettled([y]);
        const competitorPid = await bounded(competing.pid);
        let blocked = false;
        for (let i = 0; i < 100 && !blocked; i++) {
          blocked =
            (
              await pool.query<{ blocked: boolean }>("SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked", [
                ownerPid,
                competitorPid,
              ])
            ).rows[0]?.blocked === true;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
        const other = await bounded(
          runInTenant(otherTenant, () => createChokePoint(three).purgeExpiredTrashSubtree(randomUUID(), new Date())),
        );
        expect(other.purgedItemIds).toEqual([]);
        release();
        const xIds = (await bounded(x)).purgedItemIds;
        const yIds = (await bounded(y)).purgedItemIds;
        expect(xIds).toHaveLength(rootX.id === first.id ? 2 : 1);
        expect(yIds).toHaveLength(rootY.id === first.id ? 2 : 1);
        expect([...xIds, ...yIds].sort()).toEqual([first.id, second.id, child.id].sort());
        expect(await getBlob(pool, a.id)).toBeNull();
        expect(await getBlob(pool, b.id)).toBeNull();
      } finally {
        release();
        await xSettled;
        if (ySettled !== undefined) await ySettled;
        competing.restore();
        one.off("acquire", instrument);
        for (const [client, original] of originals) client.query = original;
        await Promise.all([one.end(), two.end(), three.end()]);
      }
    },
    15000,
  );

  it("removes an Inbox item's attachment rows on permanent delete and deletes a blob nothing else uses, with its bytes", async () => {
    const item = await createInboxItem("receipt photo");
    const blob = await createBlob(pool, { mimeType: "image/jpeg", byteSize: 3, storageKey: "t/blobs/receipt" });
    await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "camera" }]);
    await chokePoint.softDeleteItem(item.databaseId, item.id);
    await ageDeletion(item.id, item.databaseId);

    const { storage, deleteMock } = fakeStorage();
    expect(await purgeExpiredTrash(pool, storage)).toBe(1);

    expect(await listInboxAttachments(pool, [item.id])).toEqual([]);
    expect(await getBlob(pool, blob.id)).toBeNull();
    expect(deleteMock.mock.calls).toEqual([["t/blobs/receipt"]]);
  });

  it("keeps a blob a Files item still uses when the Inbox item holding it is permanently deleted", async () => {
    const item = await createInboxItem("scanned page");
    const blob = await createBlob(pool, { mimeType: "image/png", byteSize: 3, storageKey: "t/blobs/scan" });
    await makeFilesItem(blob.id);
    await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "scan" }]);
    await chokePoint.softDeleteItem(item.databaseId, item.id);
    await ageDeletion(item.id, item.databaseId);

    const { storage, deleteMock } = fakeStorage();
    expect(await purgeExpiredTrash(pool, storage)).toBe(1);

    expect(await listInboxAttachments(pool, [item.id])).toEqual([]);
    expect(await getBlob(pool, blob.id)).not.toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("keeps a blob an Inbox attachment names when a Files item with the same bytes is purged", async () => {
    const item = await createInboxItem("shared photo");
    const blob = await createBlob(pool, { mimeType: "image/jpeg", byteSize: 3, storageKey: "t/blobs/shared" });
    await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "photoLibrary" }]);
    const file = await makeFilesItem(blob.id);
    await chokePoint.softDeleteItem(file.databaseId, file.id);
    await ageDeletion(file.id, file.databaseId);

    const { storage, deleteMock } = fakeStorage();
    expect(await purgeExpiredTrash(pool, storage)).toBe(1);

    expect(await getBlob(pool, blob.id)).not.toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
    expect(await countRows("inbox_attachments WHERE blob_id = $1", [blob.id])).toBe(1);
  });

  it("keeps a trashed Inbox item's attachments and their blob until the item is permanently deleted", async () => {
    const item = await createInboxItem("trashed capture");
    const blob = await createBlob(pool, { mimeType: "image/jpeg", byteSize: 3, storageKey: "t/blobs/trashed" });
    await insertInboxAttachments(pool, item.id, [{ blobId: blob.id, source: "files" }]);
    await chokePoint.softDeleteItem(item.databaseId, item.id);

    const { storage, deleteMock } = fakeStorage();
    expect(await purgeExpiredTrash(pool, storage)).toBe(0);

    expect(await listInboxAttachments(pool, [item.id])).toHaveLength(1);
    expect(await getBlob(pool, blob.id)).not.toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
  });

  it("releases a blob named by two attachments of one item once, deleting its bytes once", async () => {
    const item = await createInboxItem("two copies");
    const blob = await createBlob(pool, { mimeType: "image/jpeg", byteSize: 3, storageKey: "t/blobs/twice" });
    await insertInboxAttachments(pool, item.id, [
      { blobId: blob.id, source: "camera" },
      { blobId: blob.id, source: "camera" },
    ]);
    await chokePoint.softDeleteItem(item.databaseId, item.id);
    await ageDeletion(item.id, item.databaseId);

    const { storage, deleteMock } = fakeStorage();
    expect(await purgeExpiredTrash(pool, storage)).toBe(1);

    expect(await getBlob(pool, blob.id)).toBeNull();
    expect(deleteMock.mock.calls).toEqual([["t/blobs/twice"]]);
  });

  it("keeps a blob another live Inbox item still attaches when one Inbox item is permanently deleted", async () => {
    const purged = await createInboxItem("deleted capture");
    const live = await createInboxItem("live capture");
    const blob = await createBlob(pool, { mimeType: "image/jpeg", byteSize: 3, storageKey: "t/blobs/both" });
    await insertInboxAttachments(pool, purged.id, [{ blobId: blob.id, source: "share" }]);
    await insertInboxAttachments(pool, live.id, [{ blobId: blob.id, source: "share" }]);
    await chokePoint.softDeleteItem(purged.databaseId, purged.id);
    await ageDeletion(purged.id, purged.databaseId);

    const { storage, deleteMock } = fakeStorage();
    expect(await purgeExpiredTrash(pool, storage)).toBe(1);

    expect(await listInboxAttachments(pool, [purged.id])).toEqual([]);
    expect((await listInboxAttachments(pool, [live.id])).map((row) => row.blobId)).toEqual([blob.id]);
    expect(await getBlob(pool, blob.id)).not.toBeNull();
    expect(deleteMock).not.toHaveBeenCalled();
  });
});
