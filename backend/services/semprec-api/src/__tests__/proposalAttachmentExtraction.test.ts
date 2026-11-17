import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  resetDatabase,
  createInboxItemWithClient,
  withTenantTransaction,
} from "@semprec/data/testSupport";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import {
  AiGatewayFailedError,
  runInTenant,
  type AiGatewayClientPort,
  type AiGatewayCompletionInput,
  type AiGatewayCompletionResult,
} from "@semprec/shared";
import {
  LocalFsBlobStorageWriter,
  createBlob,
  createChokePoint,
  createSemprecTickAction,
  getDatabaseByModuleId,
  getItemById,
  insertInboxAttachments,
  listInboxAttachments,
  openBlobFromRoots,
  recordInboxAttachmentMetadata,
  seedSystem,
  withTransaction,
  type InboxAttachmentMetadata,
  type ItemRow,
} from "@semprec/data";
import type { AresClient } from "../aresClient.js";
import { createProposalComputation } from "../proposalComputation.js";
import { resolveAttachmentDocuments } from "../proposalAttachmentExtraction.js";

// The proposal computation reads an Inbox item's attached photos before its own model call and caches the result on
// the attachment; the tick waits for a photo whose metadata job has not run.

const EXTRACTION_OPERATION = "inbox_attachment_extraction";
const PROPOSAL_OPERATION = "inbox_proposal";
const NO_FIELDS = {
  documentType: null,
  supplier: null,
  ico: null,
  amount: null,
  currency: null,
  issueDate: null,
  dueDate: null,
  suggestedFileName: null,
  suggestedFileType: null,
};
const INVOICE_ANSWER = { amount: 4820, currency: "CZK", dueDate: "2026-10-23" };
const INVOICE_STORED = { ...NO_FIELDS, ...INVOICE_ANSWER };

let pool: Pool;
let storageDir: string;
let storage: LocalFsBlobStorageWriter;
let emptyStorage: LocalFsBlobStorageWriter;

beforeAll(async () => {
  pool = getTestPool();
  storageDir = await mkdtemp(join(tmpdir(), "semprec-extraction-"));
  storage = new LocalFsBlobStorageWriter(join(storageDir, "files"));
  emptyStorage = new LocalFsBlobStorageWriter(join(storageDir, "mail"));
});

afterAll(async () => {
  try {
    await rm(storageDir, { recursive: true, force: true });
  } finally {
    await pool?.end();
  }
});

/** As the composition root does: the files root first, then the mail attachments root. */
const openBlob = (storageKey: string) => openBlobFromRoots({ primary: storage, alternate: emptyStorage, storageKey });

/** Seen from an unrelated connection. */
async function openTransactionCount(): Promise<number> {
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM pg_stat_activity
     WHERE datname = current_database() AND pid <> pg_backend_pid() AND state LIKE 'idle in transaction%'`,
  );
  return Number(rows[0]!.count);
}

interface StubGateway extends AiGatewayClientPort {
  calls: AiGatewayCompletionInput[];
  openTransactionsDuringCall: number[];
  extractionCalls(): AiGatewayCompletionInput[];
  proposalCalls(): AiGatewayCompletionInput[];
}

/** A throwing `extraction` is a failed call; a proposal answers `{ properties: { name } }`. */
function stubGateway(extraction: (callNumber: number) => unknown): StubGateway {
  const stub: StubGateway = {
    calls: [],
    openTransactionsDuringCall: [],
    extractionCalls: () => stub.calls.filter((call) => call.operation === EXTRACTION_OPERATION),
    proposalCalls: () => stub.calls.filter((call) => call.operation === PROPOSAL_OPERATION),
    async complete(input): Promise<AiGatewayCompletionResult> {
      stub.calls.push(input);
      stub.openTransactionsDuringCall.push(await openTransactionCount());
      const content =
        input.operation === EXTRACTION_OPERATION
          ? extraction(stub.extractionCalls().length)
          : { properties: { name: "Faktura za obklady" } };
      return { content, usage: { inputTokens: 1, outputTokens: 1 } };
    },
  };
  return stub;
}

const bytesOf = (label: string) => Buffer.from(`\xff\xd8\xff reduced copy ${label}`, "latin1");

const knowsNoCompany: AresClient = {
  async lookupCompanyByIco() {
    return null;
  },
};

describe("the proposal computation reads the photos of an Inbox item (issue gh-1970)", () => {
  let semprecProjectId: string;
  let config: { inboxDatabaseId: string; inboxItemTypesDatabaseId: string; processingProposalsDatabaseId: string };
  let tasksDatabaseId: string;

  async function databaseIdFor(moduleId: string): Promise<string> {
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
      moduleId,
    ]);
    if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
    return rows[0].id;
  }

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedSystem(pool);
    config = {
      inboxDatabaseId: await databaseIdFor("inbox"),
      inboxItemTypesDatabaseId: await databaseIdFor("inboxItemTypes"),
      processingProposalsDatabaseId: await databaseIdFor("processingProposals"),
    };
    tasksDatabaseId = await databaseIdFor("tasks");
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1 LIMIT 1", [
      await databaseIdFor("projects"),
    ]);
    semprecProjectId = rows[0]!.id;
  });

  async function createTaskItem(text: string): Promise<{ itemId: string; typeId: string }> {
    const chokePoint = createChokePoint(pool);
    const type = await chokePoint.createItem({
      databaseId: config.inboxItemTypesDatabaseId,
      properties: { name: "Task", emoji: "☑️", processingMethod: "database", targetDatabase: "tasks" },
    });
    const item = await chokePoint.createItem({
      databaseId: config.inboxDatabaseId,
      properties: { text, date: "2026-10-16", time: "08:12" },
    });
    const typeProperty = await pool.query<{ id: string }>(
      "SELECT id FROM properties WHERE database_id = $1 AND key = 'type'",
      [config.inboxDatabaseId],
    );
    await chokePoint.createRelation({
      relationPropertyId: typeProperty.rows[0]!.id,
      callerItemId: item.id,
      targetItemId: type.id,
    });
    return { itemId: item.id, typeId: type.id };
  }

  /** `metadata: null` is a file the metadata job has not run on; a reduced copy is stored only for `reducedBytes`. */
  async function attach(
    itemId: string,
    options: { mimeType: string; metadata: InboxAttachmentMetadata | null; reducedBytes?: Buffer },
  ): Promise<string> {
    return inTenantZero(() =>
      withTransaction(pool, async (client) => {
        const blob = await createBlob(client, {
          mimeType: options.mimeType,
          byteSize: 1,
          storageKey: `${getTenantZeroId()}/blobs/${randomUUID()}`,
        });
        const [attachmentId] = await insertInboxAttachments(client, itemId, [{ blobId: blob.id, source: "camera" }]);
        if (attachmentId === undefined) throw new Error("No attachment was inserted");
        if (options.metadata !== null)
          await recordMetadata(client, attachmentId, options.metadata, options.reducedBytes);
        return attachmentId;
      }),
    );
  }

  async function recordMetadata(
    client: PoolClient,
    attachmentId: string,
    metadata: InboxAttachmentMetadata,
    reducedBytes: Buffer | undefined,
  ): Promise<void> {
    let reduced = null;
    if (reducedBytes) {
      const storageKey = `${getTenantZeroId()}/inbox-attachments/${randomUUID()}.jpg`;
      const written = await storage.writeStream(storageKey, Readable.from([reducedBytes]));
      reduced = { mimeType: "image/jpeg", byteSize: written.byteSize, storageKey, contentHash: written.contentHash };
    }
    await recordInboxAttachmentMetadata(client, { attachmentId, metadata, thumbnail: null, reduced });
  }

  const photo = (label: string) => ({
    mimeType: "image/jpeg",
    metadata: { width: 100, height: 80, pages: null },
    reducedBytes: bytesOf(label),
  });

  async function runTick(gateway: AiGatewayClientPort, itemId: string): Promise<void> {
    const handler = createSemprecTickAction(
      pool,
      createProposalComputation({ pool, gateway, openBlob, aresClient: knowsNoCompany }),
    );
    await inTenantZero(() => handler(config, { heartbeatId: "hb", projectItemId: semprecProjectId, itemId }));
  }

  async function proposalCards(): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool.query<{ properties: Record<string, unknown> }>(
      "SELECT properties FROM items WHERE database_id = $1",
      [config.processingProposalsDatabaseId],
    );
    return rows.map((row) => row.properties);
  }

  async function storedExtractions(itemId: string): Promise<unknown[]> {
    return (await inTenantZero(() => withTransaction(pool, (client) => listInboxAttachments(client, [itemId])))).map(
      (row) => row.extraction,
    );
  }

  function attachmentDocumentsOf(call: AiGatewayCompletionInput | undefined) {
    const message = z.string().parse(call?.messages[0]?.content);
    const prefix = "Attachment documents (JSON): ";
    const line = message.split("\n").find((entry) => entry.startsWith(prefix));
    return line === undefined ? null : (JSON.parse(line.slice(prefix.length)) as unknown);
  }

  it("sends the image and the person's text to the gateway and puts what the photo says into the proposal request", async () => {
    const { itemId } = await createTaskItem("Faktura za obklady, zaplatit do pátku");
    const attachmentId = await attach(itemId, photo("invoice"));
    // Raw SQL: the zone is read from the settings item and this test needs a non-default zone.
    await pool.query(
      `UPDATE items SET properties = properties || '{"timezone":"Europe/Lisbon"}'::jsonb
        WHERE database_id = (SELECT id FROM databases WHERE owner_module_id = 'systemSettings')`,
    );
    const gateway = stubGateway(() => INVOICE_ANSWER);

    await runTick(gateway, itemId);

    expect(gateway.calls.map((call) => call.operation)).toEqual([EXTRACTION_OPERATION, PROPOSAL_OPERATION]);
    const [extraction, proposal] = gateway.calls;
    expect(extraction).toMatchObject({ projectItemId: semprecProjectId, temperature: 0 });
    const blocks = z
      .array(
        z.discriminatedUnion("type", [
          z.object({ type: z.literal("text"), text: z.string() }),
          z.object({ type: z.literal("image"), mimeType: z.string(), data: z.string() }),
        ]),
      )
      .parse(extraction?.messages[0]?.content);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toEqual({ type: "image", mimeType: "image/jpeg", data: bytesOf("invoice").toString("base64") });
    const text = blocks[0]?.type === "text" ? blocks[0].text : "";
    expect(text).toContain("Faktura za obklady, zaplatit do pátku");
    expect(text).toContain("Capture date: 2026-10-16");
    expect(text).toContain("Capture time: 08:12");
    expect(text).toContain("Time zone: Europe/Lisbon");

    expect(attachmentDocumentsOf(proposal)).toEqual([{ attachmentId, extraction: INVOICE_STORED }]);
    expect(proposal?.system).toContain("document data read from the item's attached photos");
    expect(await storedExtractions(itemId)).toEqual([INVOICE_STORED]);
    expect(await proposalCards()).toEqual([expect.objectContaining({ status: "proposed" })]);
    // Neither model call runs with a transaction open.
    expect(gateway.openTransactionsDuringCall).toEqual([0, 0]);
  });

  it("makes no gateway call for an extraction that is already stored, and still hands it to the proposal request", async () => {
    const { itemId, typeId } = await createTaskItem("Faktura za obklady");
    await attach(itemId, photo("invoice"));
    const gateway = stubGateway(() => INVOICE_ANSWER);
    const compute = createProposalComputation({ pool, gateway, openBlob, aresClient: knowsNoCompany });
    const item = await inTenantZero(() =>
      withTransaction(pool, (client) => getItemById(client, config.inboxDatabaseId, itemId)),
    );
    const type = await inTenantZero(() =>
      withTransaction(pool, (client) => getItemById(client, config.inboxItemTypesDatabaseId, typeId)),
    );
    if (!item || !type) throw new Error("Missing fixture item");
    const input = {
      sourceItem: item,
      type,
      entityKind: "database" as const,
      targetDatabaseId: tasksDatabaseId,
      targetModuleId: "tasks",
      locale: "cs",
      projectItemId: semprecProjectId,
    };

    await inTenantZero(() => compute(input));
    await inTenantZero(() => compute(input));

    expect(gateway.extractionCalls()).toHaveLength(1);
    expect(gateway.proposalCalls()).toHaveLength(2);
    expect(attachmentDocumentsOf(gateway.proposalCalls()[1])).toEqual(
      attachmentDocumentsOf(gateway.proposalCalls()[0]),
    );
    expect(attachmentDocumentsOf(gateway.proposalCalls()[1])).toEqual([
      expect.objectContaining({ extraction: INVOICE_STORED }),
    ]);
  });

  it("records a gateway failure of the extraction on the card, caches nothing and sends no proposal request", async () => {
    const { itemId } = await createTaskItem("Faktura za obklady");
    await attach(itemId, photo("invoice"));
    const refusing = stubGateway(() => {
      throw new AiGatewayFailedError("budget_exceeded");
    });

    await runTick(refusing, itemId);

    expect(refusing.proposalCalls()).toEqual([]);
    expect(await storedExtractions(itemId)).toEqual([null]);
    expect(await proposalCards()).toEqual([expect.objectContaining({ status: "computeFailed", fingerprint: null })]);

    const working = stubGateway(() => INVOICE_ANSWER);
    await runTick(working, itemId);

    expect(working.extractionCalls()).toHaveLength(1);
    expect(await storedExtractions(itemId)).toEqual([INVOICE_STORED]);
    expect(await proposalCards()).toEqual([expect.objectContaining({ status: "proposed" })]);
  });

  it("rethrows a failed extraction that the queue retries, with nothing cached and no card written", async () => {
    const { itemId } = await createTaskItem("Faktura za obklady");
    await attach(itemId, photo("invoice"));
    const timingOut = stubGateway(() => {
      throw new AiGatewayFailedError("timeout");
    });

    await expect(runTick(timingOut, itemId)).rejects.toMatchObject({ reason: "timeout" });

    expect(timingOut.proposalCalls()).toEqual([]);
    expect(await storedExtractions(itemId)).toEqual([null]);
    expect(await proposalCards()).toEqual([]);
  });

  it("treats an answer that is not an extraction as a failed call: nothing cached, nothing proposed", async () => {
    const { itemId } = await createTaskItem("Faktura za obklady");
    await attach(itemId, photo("invoice"));
    const gateway = stubGateway(() => ({ amount: "four thousand", dueDate: "tomorrow" }));

    await expect(runTick(gateway, itemId)).rejects.toMatchObject({ reason: "invalid_response" });

    expect(gateway.proposalCalls()).toEqual([]);
    expect(await storedExtractions(itemId)).toEqual([null]);
    expect(await proposalCards()).toEqual([]);
  });

  it("proposes nothing from a half-extracted item, keeps the first photo's extraction and reads only the second again", async () => {
    const { itemId } = await createTaskItem("Dvě faktury");
    await attach(itemId, photo("first"));
    await attach(itemId, photo("second"));
    const failingSecond = stubGateway((callNumber) => {
      if (callNumber === 2) throw new AiGatewayFailedError("timeout");
      return INVOICE_ANSWER;
    });

    await expect(runTick(failingSecond, itemId)).rejects.toMatchObject({ reason: "timeout" });

    expect(failingSecond.extractionCalls()).toHaveLength(2);
    expect(failingSecond.proposalCalls()).toEqual([]);
    expect(await storedExtractions(itemId)).toEqual([INVOICE_STORED, null]);
    expect(await proposalCards()).toEqual([]);

    const working = stubGateway(() => ({ ...INVOICE_ANSWER, amount: 99 }));
    await runTick(working, itemId);

    expect(working.extractionCalls()).toHaveLength(1);
    expect(await storedExtractions(itemId)).toEqual([INVOICE_STORED, { ...INVOICE_STORED, amount: 99 }]);
    expect(attachmentDocumentsOf(working.proposalCalls()[0])).toEqual([
      expect.objectContaining({ extraction: INVOICE_STORED }),
      expect.objectContaining({ extraction: { ...INVOICE_STORED, amount: 99 } }),
    ]);
  });

  it("makes no extraction call for a PDF, for audio or for an image the metadata job could not read", async () => {
    const { itemId } = await createTaskItem("Dokumenty");
    await attach(itemId, { mimeType: "application/pdf", metadata: { pages: null } });
    await attach(itemId, {
      mimeType: "audio/mpeg",
      metadata: { pages: null, durationSeconds: 30, audioKind: "voiceNote" },
    });
    await attach(itemId, { mimeType: "image/png", metadata: { pages: null, error: "mediaUnreadable" } });
    const gateway = stubGateway(() => INVOICE_ANSWER);

    await runTick(gateway, itemId);

    expect(gateway.extractionCalls()).toEqual([]);
    expect(gateway.proposalCalls()).toHaveLength(1);
    expect(attachmentDocumentsOf(gateway.proposalCalls()[0])).toBeNull();
    expect(gateway.proposalCalls()[0]?.system).not.toContain("document data read from");
    expect(await storedExtractions(itemId)).toEqual([null, null, null]);
    expect(await proposalCards()).toEqual([expect.objectContaining({ status: "proposed" })]);
  });

  it("extracts the first four photos by position and leaves the fifth alone", async () => {
    const { itemId } = await createTaskItem("Pět fotek");
    for (const label of ["p1", "p2", "p3", "p4", "p5"]) await attach(itemId, photo(label));
    const gateway = stubGateway((callNumber) => ({ ...INVOICE_ANSWER, amount: callNumber }));

    await runTick(gateway, itemId);

    const images = gateway.extractionCalls().map((call) => {
      const content = call.messages[0]?.content;
      if (!content || typeof content === "string") throw new Error("Expected content blocks");
      return content[1];
    });
    expect(images).toEqual(
      ["p1", "p2", "p3", "p4"].map((label) => ({
        type: "image",
        mimeType: "image/jpeg",
        data: bytesOf(label).toString("base64"),
      })),
    );
    expect(
      (await storedExtractions(itemId)).map(
        (stored) => z.object({ amount: z.number() }).nullable().parse(stored)?.amount ?? null,
      ),
    ).toEqual([1, 2, 3, 4, null]);
    expect(
      z
        .array(z.object({ extraction: z.object({ amount: z.number() }) }))
        .parse(attachmentDocumentsOf(gateway.proposalCalls()[0]))
        .map((entry) => entry.extraction.amount),
    ).toEqual([1, 2, 3, 4]);
  });

  it("waits for a photo whose metadata job has not run, then runs again once the job has written", async () => {
    const { itemId } = await createTaskItem("Faktura za obklady");
    const attachmentId = await attach(itemId, { mimeType: "image/jpeg", metadata: null });
    const gateway = stubGateway(() => INVOICE_ANSWER);

    await runTick(gateway, itemId);

    expect(gateway.calls).toEqual([]);
    expect(await proposalCards()).toEqual([]);

    // Creating the item already enqueued heartbeat jobs under the keys the metadata write uses, which would hide a
    // missing announcement, so they are taken out first.
    const announcedFor = async (): Promise<number> =>
      (await readJobPayloadsByIdentifier(pool, "heartbeatFireCore")).filter(
        (payload) =>
          z.object({ payload: z.object({ itemId: z.string() }) }).safeParse(payload).data?.payload.itemId === itemId,
      ).length;
    await pool.query(
      `DELETE FROM graphile_worker._private_jobs jobs
        USING graphile_worker._private_tasks tasks
        WHERE tasks.id = jobs.task_id AND tasks.identifier = 'heartbeatFireCore'
          AND jobs.payload -> 'payload' ->> 'itemId' = $1`,
      [itemId],
    );
    expect(await announcedFor()).toBe(0);

    // The metadata job's write announces an update of the item to its heartbeats.
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        recordMetadata(client, attachmentId, { width: 100, height: 80, pages: null }, bytesOf("late")),
      ),
    );
    expect(await announcedFor()).toBeGreaterThan(0);

    await runTick(gateway, itemId);

    expect(gateway.calls.map((call) => call.operation)).toEqual([EXTRACTION_OPERATION, PROPOSAL_OPERATION]);
    expect(await storedExtractions(itemId)).toEqual([INVOICE_STORED]);
    expect(await proposalCards()).toEqual([expect.objectContaining({ status: "proposed" })]);
  });

  it("waits while any one of several photos still has no metadata, even when another is ready", async () => {
    const { itemId } = await createTaskItem("Dvě fotky");
    await attach(itemId, photo("ready"));
    await attach(itemId, { mimeType: "image/jpeg", metadata: null });
    const gateway = stubGateway(() => INVOICE_ANSWER);

    await runTick(gateway, itemId);

    expect(gateway.calls).toEqual([]);
    expect(await storedExtractions(itemId)).toEqual([null, null]);
  });
});

describe("resolveAttachmentDocuments across tenants (issue gh-1970)", () => {
  let runtimePool: Pool;

  beforeAll(async () => {
    await resetDatabase(pool);
    runtimePool = await createRuntimeRolePool(pool, "semprec_data");
  });

  afterAll(async () => {
    await runtimePool?.end();
  });

  async function tenantWithPhoto(label: string): Promise<{ tenantId: string; item: ItemRow; attachmentId: string }> {
    const tenantId = await createTestTenant(pool);
    await runInTenant(tenantId, () => seedSystem(runtimePool));
    const storageKey = `${tenantId}/inbox-attachments/${randomUUID()}.jpg`;
    const written = await storage.writeStream(storageKey, Readable.from([bytesOf(label)]));
    return withTenantTransaction(runtimePool, tenantId, async (client) => {
      const inbox = await getDatabaseByModuleId(client, "inbox");
      if (!inbox) throw new Error("Missing Inbox database");
      const item = await createInboxItemWithClient(client, {
        inboxDatabaseId: inbox.id,
        date: "2026-10-16",
        time: "08:12",
        text: label,
      });
      const blob = await createBlob(client, {
        mimeType: "image/jpeg",
        byteSize: 1,
        storageKey: `${tenantId}/blobs/${randomUUID()}`,
        contentHash: createHash("sha256").update(label).digest("hex"),
      });
      const [attachmentId] = await insertInboxAttachments(client, item.id, [{ blobId: blob.id, source: "camera" }]);
      if (attachmentId === undefined) throw new Error("No attachment was inserted");
      await recordInboxAttachmentMetadata(client, {
        attachmentId,
        metadata: { width: 10, height: 10, pages: null },
        thumbnail: null,
        reduced: { mimeType: "image/jpeg", byteSize: written.byteSize, storageKey, contentHash: written.contentHash },
      });
      return { tenantId, item, attachmentId };
    });
  }

  it("reads and stores the photo of the tenant in scope, and nothing of another tenant's Inbox item", async () => {
    const a = await tenantWithPhoto("tenant-a");
    const b = await tenantWithPhoto("tenant-b");
    const gateway = stubGateway(() => INVOICE_ANSWER);
    const ports = { gateway, openBlob };

    const crossTenant = await runInTenant(a.tenantId, () =>
      resolveAttachmentDocuments(runtimePool, ports, b.item, randomUUID()),
    );

    expect(crossTenant).toEqual([]);
    expect(gateway.calls).toEqual([]);
    const untouched = await withTenantTransaction(runtimePool, b.tenantId, (client) =>
      listInboxAttachments(client, [b.item.id]),
    );
    expect(untouched.map((row) => row.extraction)).toEqual([null]);

    // Proves the refusal above came from the tenant, not a broken fixture.
    const own = await runInTenant(b.tenantId, () =>
      resolveAttachmentDocuments(runtimePool, ports, b.item, randomUUID()),
    );

    expect(own).toEqual([{ attachmentId: b.attachmentId, extraction: INVOICE_STORED }]);
    expect(gateway.extractionCalls()).toHaveLength(1);
    const stored = await withTenantTransaction(runtimePool, b.tenantId, (client) =>
      listInboxAttachments(client, [b.item.id]),
    );
    expect(stored.map((row) => row.extraction)).toEqual([INVOICE_STORED]);
    const other = await withTenantTransaction(runtimePool, a.tenantId, (client) =>
      listInboxAttachments(client, [a.item.id]),
    );
    expect(other.map((row) => row.extraction)).toEqual([null]);
  });
});
