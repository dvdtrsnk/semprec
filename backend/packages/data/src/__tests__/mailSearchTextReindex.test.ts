import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, enqueueJob, runOnce, runWorker } from "@semprec/queue";
import "../domainWriteHooks.js";
import { ingestUploadedFile } from "../blobs/fileUploadStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { LocalFsBlobStorageWriter } from "../mail/blobStorage.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { enqueueMailSearchTextReindex, handleMailSearchTextReindexTask } from "../mail/mailSearchTextReindexJob.js";
import { reindexItemSearch, searchItems } from "../mail/search.js";
import { createApiCoreTaskList } from "../worker.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let directory: string;
beforeAll(async () => {
  admin = getTestPool();
  pool = await createRuntimeRolePool(admin, "semprec_data");
  directory = await mkdtemp(join(tmpdir(), "mail-search-index-"));
});
beforeEach(async () => {
  await resetDatabase(admin);
  tenant = getTenantZeroId();
  await runInTenant(tenant, () => seedSystem(pool));
});
afterAll(async () => {
  await pool.end();
  await admin.end();
  await rm(directory, { recursive: true, force: true });
});

function pdf(text: string): Buffer {
  const objects = [
    "",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 300 300] /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 24 Tf 20 100 Td (${text}) Tj ET`;
  objects.push(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`);
  let body = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(body, "latin1");
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body, "latin1");
  body += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) body += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  return Buffer.from(`${body}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`, "latin1");
}

async function docx(text: string): Promise<Buffer> {
  const zip = new ZipFile();
  zip.addBuffer(
    Buffer.from(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ),
    "[Content_Types].xml",
  );
  zip.addBuffer(
    Buffer.from(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    ),
    "_rels/.rels",
  );
  zip.addBuffer(
    Buffer.from(
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    ),
    "word/document.xml",
  );
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) {
    if (!Buffer.isBuffer(chunk)) throw new Error("Unexpected ZIP chunk");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

describe("mail search text rebuild", () => {
  it("queues and serializes a successor when a real worker is already running the fixed key", async () => {
    const production = createApiCoreTaskList(pool, createActionRegistry());
    const name = CORE_TASK_NAMES.MAIL_SEARCH_TEXT_REINDEX;
    const handler = production[name];
    if (!handler) throw new Error("Missing mail rebuild task");
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const events: string[] = [];
    const runner = await runWorker({
      pgPool: admin,
      concurrency: 2,
      noHandleSignals: true,
      taskList: {
        [CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP]: async () => {
          events.push("probe");
        },
        [name]: async (payload, helpers) => {
          const number = events.filter((event) => event.startsWith("start")).length + 1;
          events.push(`start${number}`);
          if (number === 1) {
            started();
            await held;
          }
          await handler(payload, helpers);
          events.push(`end${number}`);
        },
      },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await runAsSystem("test mail enqueue", () => enqueueMailSearchTextReindex(admin));
      await Promise.race([
        firstStarted,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Worker did not start")), 10000);
        }),
      ]);
      await runAsSystem("test mail successor", () => enqueueMailSearchTextReindex(admin));
      const queued = await admin.query<{
        key: string | null;
        running: boolean;
        due: boolean;
        queue_name: string | null;
        queue_locked: boolean;
      }>(
        `SELECT j.key, j.locked_at IS NOT NULL AS running, j.run_at <= now() AS due, q.queue_name,
                q.locked_at IS NOT NULL AS queue_locked
           FROM graphile_worker._private_jobs j JOIN graphile_worker._private_tasks t ON t.id = j.task_id
           LEFT JOIN graphile_worker._private_job_queues q ON q.id = j.job_queue_id
          WHERE t.identifier = $1 ORDER BY j.id`,
        [name],
      );
      await runAsSystem("test free worker probe", () =>
        enqueueJob(admin, CORE_TASK_NAMES.MAIL_SEARCH_REINDEX_SWEEP, {}),
      );
      await vi.waitFor(() => expect(events).toContain("probe"), { timeout: 10000 });
      expect(events).not.toContain("start2");
      expect(queued.rows).toEqual([
        expect.objectContaining({
          key: null,
          running: true,
          queue_name: "mail-search-text-reindex",
          queue_locked: true,
        }),
        expect.objectContaining({
          key: "mail-search-text-reindex",
          running: false,
          due: true,
          queue_name: "mail-search-text-reindex",
          queue_locked: true,
        }),
      ]);
      release();
      await vi.waitFor(
        () => expect(events.filter((event) => event !== "probe")).toEqual(["start1", "end1", "start2", "end2"]),
        { timeout: 15000 },
      );
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await runner.stop();
    }
  });

  it("rebuilds a deduplicated attachment stored in the Files root through the real worker", async () => {
    const filesRoot = join(directory, "cross-root-files"),
      mailRoot = join(directory, "cross-root-mail");
    const filesStorage = new LocalFsBlobStorageWriter(filesRoot),
      mailStorage = new LocalFsBlobStorageWriter(mailRoot);
    const foreignTenant = await createTestTenant(admin);
    await runInTenant(foreignTenant, () => seedSystem(pool));
    const makeFixture = async (tenantId: string, marker: string) =>
      runInTenant(tenantId, async () => {
        const db = async (key: string) => {
          const row = await withTransaction(pool, (client) => getDatabaseByModuleId(client, key));
          if (!row) throw new Error(`Missing ${key}`);
          return row.id;
        };
        const emails = await db("emails"),
          files = await db("files"),
          folders = await db("folders");
        const properties = await createChokePoint(pool).listProperties(emails);
        const folderProperty = properties.find((p) => p.key === "folder"),
          attachmentProperty = properties.find((p) => p.key === "attachments");
        if (!folderProperty || !attachmentProperty) throw new Error("Missing relations");
        const folder = await withTransaction(pool, (client) =>
          createItemWithClient(
            client,
            { databaseId: folders, properties: { name: "INBOX" } },
            { allowedSystemKeys: ["name"] },
          ),
        );
        const bytes = pdf(marker);
        const uploaded = await ingestUploadedFile(pool, {
          filesDatabaseId: files,
          filename: "invoice.pdf",
          contentType: "application/pdf",
          source: Readable.from(bytes),
          storageKeyPrefix: "files",
          maxBytes: 1024 * 1024,
          storage: filesStorage,
        });
        const mail = await withTransaction(pool, (client) =>
          ingestEmailMessage(client, {
            emailsDatabaseId: emails,
            filesDatabaseId: files,
            folderRelationPropertyId: folderProperty.id,
            attachmentsRelationPropertyId: attachmentProperty.id,
            folderItemId: folder.id,
            mailboxItemId: randomUUID(),
            storage: mailStorage,
            storageKeyPrefix: "mail",
            messageId: "<crossroot@example.test>",
            subject: "Cross root",
            envelope: {},
            attachments: [
              {
                filename: "invoice.pdf",
                contentType: "application/pdf",
                contentId: null,
                disposition: "attachment",
                openStream: () => Readable.from(bytes),
              },
            ],
          }),
        );
        const attached = await withTransaction(pool, (client) =>
          client.query<{ blob_id: string }>("SELECT blob_id FROM mail_attachments WHERE message_item_id = $1", [
            mail.itemId,
          ]),
        );
        expect(attached.rows).toEqual([{ blob_id: uploaded.blob.id }]);
        expect(await readFile(join(filesRoot, uploaded.blob.storageKey))).toEqual(bytes);
        await expect(readFile(join(mailRoot, uploaded.blob.storageKey))).rejects.toMatchObject({ code: "ENOENT" });
        const search = async (query: string) =>
          (await withTransaction(pool, (client) => searchItems(client, { databaseId: emails, query }))).map(
            (row) => row.itemId,
          );
        expect(await search(marker)).toContain(mail.itemId);
        await withTransaction(pool, (client) =>
          reindexItemSearch(client, {
            itemId: mail.itemId,
            databaseId: emails,
            text: "stale fixture",
          }),
        );
        expect(await search(marker)).not.toContain(mail.itemId);
        return { itemId: mail.itemId, search };
      });
    const fixture = await makeFixture(tenant, "Crossrootneedle");
    const foreign = await makeFixture(foreignTenant, "Foreigncrossneedle");
    const tasks = createApiCoreTaskList(
      pool,
      createActionRegistry(),
      undefined,
      undefined,
      mailStorage,
      undefined,
      undefined,
      undefined,
      undefined,
      filesStorage,
    );
    const handler = tasks[CORE_TASK_NAMES.MAIL_SEARCH_TEXT_REINDEX];
    if (!handler) throw new Error("Missing task");
    await runAsSystem("test cross-root enqueue", () => enqueueMailSearchTextReindex(admin));
    await runOnce({ pgPool: admin }, { [CORE_TASK_NAMES.MAIL_SEARCH_TEXT_REINDEX]: handler });
    expect(await runInTenant(tenant, () => fixture.search("Crossrootneedle"))).toContain(fixture.itemId);
    expect(await runInTenant(tenant, () => fixture.search("Foreigncrossneedle"))).toEqual([]);
    expect(await runInTenant(foreignTenant, () => foreign.search("Foreigncrossneedle"))).toContain(foreign.itemId);
    expect(await runInTenant(foreignTenant, () => foreign.search("Crossrootneedle"))).toEqual([]);
  });

  it("rebuilds an active tenant while a populated suspended tenant remains unchanged", async () => {
    const other = await createTestTenant(admin, { status: "suspended" });
    await runInTenant(other, () => seedSystem(pool));
    const make = async (id: string, subject: string) =>
      runInTenant(id, async () => {
        const database = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "emails"));
        if (!database) throw new Error("Missing emails database");
        const item = await withTransaction(pool, (client) =>
          createItemWithClient(
            client,
            { databaseId: database.id, properties: { name: subject } },
            { allowedSystemKeys: ["name"] },
          ),
        );
        await withTransaction(pool, (client) =>
          reindexItemSearch(client, { itemId: item.id, databaseId: database.id, text: "stale fixture" }),
        );
        const read = async () =>
          (
            await withTransaction(pool, (client) =>
              client.query<{ vector: string; updated_at: string; xmin: string }>(
                "SELECT search_vector::text AS vector, updated_at::text, xmin::text AS xmin FROM item_search_index WHERE item_id = $1",
                [item.id],
              ),
            )
          ).rows;
        return { itemId: item.id, read, before: await read() };
      });
    const active = await make(tenant, "Active rebuild marker");
    const suspended = await make(other, "Suspended retained marker");
    await handleMailSearchTextReindexTask(
      pool,
      new LocalFsBlobStorageWriter(directory),
      new LocalFsBlobStorageWriter(directory),
    );
    const activeAfter = await runInTenant(tenant, active.read);
    expect(activeAfter).toHaveLength(1);
    expect(activeAfter).not.toEqual(active.before);
    expect(activeAfter[0]?.vector).toContain("active");
    expect(await runInTenant(other, suspended.read)).toEqual(suspended.before);
  });

  it("rebuilds live mail from stored PDF bytes, preserves deleted rows and repeats without changes", async () => {
    const storage = new LocalFsBlobStorageWriter(directory);
    const fixture = await runInTenant(tenant, async () => {
      const cp = createChokePoint(pool);
      const db = async (key: string): Promise<string> => {
        const row = await withTransaction(pool, (client) => getDatabaseByModuleId(client, key));
        if (!row) throw new Error(`Missing database ${key}`);
        return row.id;
      };
      const emails = await db("emails");
      const folders = await db("folders");
      const files = await db("files");
      const props = await cp.listProperties(emails);
      const folderProperty = props.find((p) => p.key === "folder");
      const attachmentsProperty = props.find((p) => p.key === "attachments");
      if (!folderProperty || !attachmentsProperty) throw new Error("Missing email relations");
      const folder = await withTransaction(pool, (client) =>
        createItemWithClient(
          client,
          { databaseId: folders, properties: { name: "INBOX" } },
          { allowedSystemKeys: ["name"] },
        ),
      );
      const common = {
        emailsDatabaseId: emails,
        filesDatabaseId: files,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentsProperty.id,
        folderItemId: folder.id,
        mailboxItemId: randomUUID(),
        storage,
        storageKeyPrefix: "rebuild",
      };
      const docxBytes = await docx("Rebuilddocxneedle");
      const ingest = (id: string, word: string) =>
        withTransaction(pool, (client) =>
          ingestEmailMessage(client, {
            ...common,
            messageId: `<${id}@example.test>`,
            subject: id,
            bodyHtml: "<p>Bodycontent</p>",
            envelope: { from: { name: "Petr Novák", address: "petr@example.com" } },
            attachments: [
              {
                filename: "invoice.pdf",
                contentType: "application/pdf",
                contentId: null,
                disposition: "attachment",
                openStream: () => Readable.from(pdf(word)),
              },
              {
                filename: "note.docx",
                contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                contentId: null,
                disposition: "attachment",
                openStream: () => Readable.from(docxBytes),
              },
            ],
          }),
        );
      const live = await ingest("liverebuild", "Rebuildpdfneedle");
      const deleted = await ingest("deletedrebuild", "Deletedpdfneedle");
      const missing = await ingest("missingrebuild", "Missingpdfneedle");
      const { rows: attachments } = await withTransaction(pool, (client) =>
        client.query<{ storage_key: string }>(
          `SELECT b.storage_key FROM mail_attachments a JOIN blobs b ON b.id = a.blob_id WHERE a.message_item_id = $1 AND a.content_type = 'application/pdf'`,
          [missing.itemId],
        ),
      );
      const key = attachments[0]?.storage_key;
      if (!key) throw new Error("Missing attachment fixture");
      await storage.delete(key);
      // An older search projection omitted the sender and cannot be produced by current ingest.
      await withTransaction(pool, (client) =>
        reindexItemSearch(client, { itemId: live.itemId, databaseId: emails, text: "stale" }),
      );
      await cp.softDeleteItem(emails, deleted.itemId);
      const index = async () =>
        (
          await withTransaction(pool, (client) =>
            client.query<{ item_id: string; vector: string; updated_at: string; xmin: string }>(
              "SELECT item_id, search_vector::text AS vector, updated_at::text, xmin::text AS xmin FROM item_search_index WHERE item_id = ANY($1::uuid[]) ORDER BY item_id",
              [[live.itemId, deleted.itemId, missing.itemId]],
            ),
          )
        ).rows;
      return {
        emails,
        live: live.itemId,
        deleted: deleted.itemId,
        missing: missing.itemId,
        index,
        before: await index(),
      };
    });
    await handleMailSearchTextReindexTask(pool, storage, storage);
    await runInTenant(tenant, async () => {
      const after = await fixture.index();
      const changed = after.find((row) => row.item_id === fixture.live);
      const stale = fixture.before.find((row) => row.item_id === fixture.live);
      if (!changed || !stale) throw new Error("Missing live index row");
      expect(changed.vector).not.toBe(stale.vector);
      expect(changed.xmin).not.toBe(stale.xmin);
      expect(new Date(changed.updated_at).getTime()).toBeGreaterThan(new Date(stale.updated_at).getTime());
      expect(after.find((row) => row.item_id === fixture.deleted)).toEqual(
        fixture.before.find((row) => row.item_id === fixture.deleted),
      );
      const search = async (query: string) =>
        (await withTransaction(pool, (client) => searchItems(client, { databaseId: fixture.emails, query }))).map(
          (row) => row.itemId,
        );
      expect(await search("novak")).toContain(fixture.live);
      expect(await search("Rebuildpdfneedle")).toEqual([fixture.live]);
      expect(await search("Rebuilddocxneedle")).toContain(fixture.live);
      expect(await search("Deletedpdfneedle")).toEqual([]);
      expect(await search("missingrebuild")).toContain(fixture.missing);
      fixture.before = after;
    });
    await handleMailSearchTextReindexTask(pool, storage, storage);
    await runInTenant(tenant, async () => {
      expect(await fixture.index()).toEqual(fixture.before);
      await createChokePoint(pool).restoreItem(fixture.emails, fixture.deleted);
      const restored = await withTransaction(pool, (client) =>
        searchItems(client, { databaseId: fixture.emails, query: "Deletedpdfneedle" }),
      );
      expect(restored.map((row) => row.itemId)).toEqual([fixture.deleted]);
    });
  });
});
