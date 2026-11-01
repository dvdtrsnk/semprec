import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { runOnce, CORE_TASK_NAMES } from "@semprec/queue";
import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { getTenantZeroId, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createViewTypeRegistry, type ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../seed/seedSystem.js";
import { withTransaction } from "../db/pool.js";
import { createBlob, getBlob } from "../blobs/blobsStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { deleteItemDependents } from "../chokePoint/itemTrash.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import { createInboxItemWithClient } from "../inbox/inboxStore.js";
import { createInboxTypeWithClient } from "../inbox/inboxTypesStore.js";
import { insertInboxAttachments, listInboxAttachments } from "../inbox/inboxAttachmentsStore.js";
import { createSemprecTickAction, type ComputeSemprecProposalFn, type ProposalStep } from "../inbox/inboxTickAction.js";
import { confirmProposalWithClient } from "../inbox/proposalActions.js";
import { executeProposalSteps } from "../inbox/proposalSteps.js";
import {
  createFilesTranscriptionTriggerAction,
  FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
} from "../transcription/transcriptionActions.js";
import { createActionRegistry } from "../scheduler/actions.js";
import { createCoreTaskList } from "../worker.js";
import { transcriptionJobKey } from "../transcription/transcriptionJob.js";
import type { ItemRow } from "../types.js";

// Issue #1703: confirming a `fileFromAttachment` step moves an Inbox attachment into Files. These tests
// run the real confirm path against the seeded database, through the runtime that owns the tables.
// Every envelope has a Task as its primary step: a file step is never primary (see the ADR).

let pool: Pool;
let viewTypeRegistry: ViewTypeRegistry;
let inboxId: string;
let typesId: string;
let proposalsId: string;
let filesId: string;
let tasksId: string;
let projectsId: string;
let taskType: ItemRow;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function jobExists(key: string): Promise<boolean> {
  const { rows } = await pool.query(`SELECT 1 FROM graphile_worker.jobs WHERE key = $1`, [key]);
  return rows.length > 0;
}

/** Polls until a confirm is blocked on the blob row lock (`SELECT ... FROM blobs ... FOR UPDATE`); fails after two seconds. */
async function waitForBlobLockWait(holderPid: number, competitorPid: number): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ waiting: boolean }>(
      `SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS waiting`,
      [holderPid, competitorPid],
    );
    if (rows[0]?.waiting) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("No transaction waited on the blob row lock");
}

/** A settled outcome instead of a promise, so a rejected concurrent confirm is never an unhandled rejection. */
type Outcome<T> = { value: T } | { error: unknown };
function settle<T>(run: Promise<T>): Promise<Outcome<T>> {
  return run.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
}

async function newBlob(mimeType: string): Promise<string> {
  return withTransaction(pool, async (client) => {
    const blob = await createBlob(client, { mimeType, byteSize: 2048, storageKey: `blobs/${randomUUID()}` });
    return blob.id;
  });
}

/** Appends an attachment naming `blobId` to an Inbox item and returns the new attachment's id. */
async function attach(inboxItemId: string, blobId: string): Promise<string> {
  return withTransaction(pool, async (client) => {
    await insertInboxAttachments(client, inboxItemId, [{ blobId, source: "camera" }]);
    const rows = await listInboxAttachments(client, [inboxItemId]);
    return rows[rows.length - 1]!.attachmentId;
  });
}

async function plainInboxItem(text: string): Promise<string> {
  const item = await withTransaction(pool, (client) =>
    createInboxItemWithClient(client, {
      inboxDatabaseId: inboxId,
      date: "2026-10-29",
      time: "09:00",
      text,
    }),
  );
  return item.id;
}

/** A Task-typed Inbox item and the Processing proposal the tick computes for it. */
async function inboxItemWithCard(text: string): Promise<{ inboxItemId: string; cardId: string }> {
  const item = await withTransaction(pool, (client) =>
    createInboxItemWithClient(client, {
      inboxDatabaseId: inboxId,
      date: "2026-10-29",
      time: "09:00",
      text,
      type: taskType.id,
    }),
  );
  const compute: ComputeSemprecProposalFn = async () => ({ properties: { name: text } });
  const tick = createSemprecTickAction(pool, compute);
  await tick(
    { inboxDatabaseId: inboxId, inboxItemTypesDatabaseId: typesId, processingProposalsDatabaseId: proposalsId },
    { heartbeatId: "hb", projectItemId: "proj", itemId: item.id },
  );
  return { inboxItemId: item.id, cardId: await cardOf(item.id) };
}

async function cardOf(inboxItemId: string): Promise<string> {
  return withTransaction(pool, async (client) => {
    const property = await propertiesStore.getPropertyByKey(client, proposalsId, "sourceInbox");
    const definition = await relationsStore.getRelationDefinitionByPropertyId(client, property!.id);
    const [edge] = await relationsStore.listRelationsForItem(client, definition!.id, inboxItemId);
    return relationsStore.otherSide(edge!, inboxItemId);
  });
}

/** Stores a multi-step envelope on a card the way the tick would: a system-owned `proposal` property, targeting Tasks. */
async function storeSteps(cardId: string, steps: ProposalStep[]): Promise<void> {
  const primary = steps.find((step) => step.role === "primary")!;
  await withTransaction(pool, (client) =>
    updateItemWithClient(
      client,
      {
        databaseId: proposalsId,
        itemId: cardId,
        propertiesPatch: {
          proposal: {
            entityKind: "database",
            target: tasksId,
            properties: primary.properties ?? {},
            operations: steps,
          },
        },
      },
      { allowedSystemKeys: ["proposal"] },
    ),
  );
}

/** The primary step of every envelope here: a Task, which the file step can run before or after. */
function taskPrimary(name = "Podepsat do 30. 10."): ProposalStep {
  return { ref: "task", op: "create", databaseKey: "tasks", role: "primary", properties: { name } };
}

function fileStep(attachmentId: string, extra: Partial<ProposalStep> = {}): ProposalStep {
  return {
    ref: "file",
    op: "fileFromAttachment",
    role: "secondary",
    properties: { attachmentId, name: "Scan", date: "2026-10-29" },
    ...extra,
  };
}

const confirm = (cardId: string): Promise<ItemRow> =>
  withTransaction(pool, (client) =>
    confirmProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId),
  );

async function cardStatus(cardId: string): Promise<unknown> {
  const { rows } = await pool.query<{ status: unknown }>(
    "SELECT properties->'status' AS status FROM items WHERE id = $1",
    [cardId],
  );
  return rows[0]?.status;
}

/** Live Files items whose `file` names the blob. */
async function filesItemsFor(blobId: string): Promise<Array<{ id: string; properties: Record<string, unknown> }>> {
  const { rows } = await pool.query<{ id: string; properties: Record<string, unknown> }>(
    `SELECT id, properties FROM items WHERE database_id = $1 AND deleted_at IS NULL AND properties -> 'file' ->> 'blobId' = $2`,
    [filesId, blobId],
  );
  return rows;
}

async function attachmentCount(inboxItemId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM inbox_attachments WHERE inbox_item_id = $1",
    [inboxItemId],
  );
  return rows[0]!.n;
}

async function attachmentRowCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM inbox_attachments");
  return rows[0]!.n;
}

async function blobCount(): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM blobs");
  return rows[0]!.n;
}

async function countItems(databaseId: string): Promise<number> {
  const { rows } = await pool.query<{ n: number }>("SELECT count(*)::int AS n FROM items WHERE database_id = $1", [
    databaseId,
  ]);
  return rows[0]!.n;
}

async function originRowsFor(itemId: string) {
  const { rows } = await pool.query<{
    item_id: string;
    proposal_id: string;
    inbox_item_id: string | null;
    capture_channel: string;
  }>("SELECT item_id, proposal_id, inbox_item_id, capture_channel FROM item_origins WHERE item_id = $1", [itemId]);
  return rows;
}

async function edgeExists(a: string, b: string): Promise<boolean> {
  const { rows } = await pool.query(
    "SELECT 1 FROM item_relations WHERE (item_a = $1 AND item_b = $2) OR (item_a = $2 AND item_b = $1)",
    [a, b],
  );
  return rows.length === 1;
}

async function createIn(databaseId: string, properties: Record<string, unknown>): Promise<string> {
  return withTransaction(pool, async (client) => (await createItemWithClient(client, { databaseId, properties })).id);
}

describe("file from attachment on confirm (issue #1703)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    viewTypeRegistry = createViewTypeRegistry();
    await resetDatabase(pool);
    await seedSystem(pool, viewTypeRegistry);
    inboxId = await databaseIdFor("inbox");
    typesId = await databaseIdFor("inboxItemTypes");
    proposalsId = await databaseIdFor("processingProposals");
    filesId = await databaseIdFor("files");
    tasksId = await databaseIdFor("tasks");
    projectsId = await databaseIdFor("projects");
    taskType = await withTransaction(pool, (client) =>
      createInboxTypeWithClient(client, {
        inboxItemTypesDatabaseId: typesId,
        name: "Task",
        emoji: "☑️",
        processingMethod: "database",
        targetDatabase: "tasks",
      }),
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("moves a photo into Files: one item on the same blob with the project, its origin and type jpg; the attachment row goes and no blob is added", async () => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Scan of the contract");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    const projectId = await createIn(projectsId, { name: "Home" });
    const blobsBefore = await blobCount();
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId, { relations: { projects: [projectId] } })]);

    const confirmed = await confirm(cardId);

    const files = await filesItemsFor(blobId);
    expect(files).toHaveLength(1);
    const [fileItem] = files;
    expect(confirmed.properties.status).toBe("confirmed");
    expect(fileItem!.properties).toMatchObject({ name: "Scan", type: "jpg", date: "2026-10-29", file: { blobId } });
    expect(await edgeExists(fileItem!.id, projectId)).toBe(true);
    expect(await originRowsFor(fileItem!.id)).toEqual([
      { item_id: fileItem!.id, proposal_id: cardId, inbox_item_id: inboxItemId, capture_channel: "inbox" },
    ]);
    expect(await attachmentCount(inboxItemId)).toBe(0);
    expect(await blobCount()).toBe(blobsBefore);
  });

  it("returns the moved attachment and the Files item in the step result, and lists the item as created", async () => {
    const inboxItemId = await plainInboxItem("Receipt");
    const blobId = await newBlob("application/pdf");
    const attachmentId = await attach(inboxItemId, blobId);

    const executed = await withTransaction(pool, (client) =>
      executeProposalSteps(client, [taskPrimary(), fileStep(attachmentId)], {
        writer: { writerKind: "user" },
        sourceInboxItemId: inboxItemId,
      }),
    );

    const [files] = await filesItemsFor(blobId);
    expect(files!.properties).toMatchObject({ type: "pdf" });
    expect(executed.fileFromAttachments).toEqual([
      { ref: "file", fileItemId: files!.id, movedAttachmentId: attachmentId, created: true },
    ]);
    expect(executed.createdItemIds).toContain(files!.id);
    expect(executed.primaryItemId).not.toBe(files!.id);
  });

  it("leaves out the type when the blob's mime type has no Files type", async () => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Archive");
    const blobId = await newBlob("application/zip");
    const attachmentId = await attach(inboxItemId, blobId);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);

    await confirm(cardId);

    const [fileItem] = await filesItemsFor(blobId);
    expect(fileItem!.properties).not.toHaveProperty("type");
    expect(fileItem!.properties).toMatchObject({ name: "Scan", file: { blobId } });
  });

  it("resolves to the Files item that already names the blob: no second item, that item unchanged, no origin row", async () => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Photo again");
    const blobId = await newBlob("image/jpeg");
    const existingId = await createIn(filesId, { name: "Existing", file: { blobId } });
    const before = await pool.query("SELECT properties, updated_at FROM items WHERE id = $1", [existingId]);
    const attachmentId = await attach(inboxItemId, blobId);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);

    const confirmed = await confirm(cardId);

    expect(confirmed.properties.status).toBe("confirmed");
    expect(await filesItemsFor(blobId)).toHaveLength(1);
    const after = await pool.query("SELECT properties, updated_at FROM items WHERE id = $1", [existingId]);
    expect(after.rows).toEqual(before.rows);
    expect(await originRowsFor(existingId)).toEqual([]);
    expect(await attachmentCount(inboxItemId)).toBe(0);
  });

  it("returns the existing Files ID and moved attachment ID with created false", async () => {
    const source = await plainInboxItem("Existing photo");
    const blobId = await newBlob("image/jpeg");
    const existingId = await createIn(filesId, { name: "Existing", file: { blobId } });
    const attachmentId = await attach(source, blobId);
    const result = await withTransaction(pool, (client) =>
      executeProposalSteps(client, [taskPrimary(), fileStep(attachmentId)], {
        writer: { writerKind: "user" },
        sourceInboxItemId: source,
      }),
    );
    expect(result.fileFromAttachments).toEqual([
      { ref: "file", fileItemId: existingId, movedAttachmentId: attachmentId, created: false },
    ]);
    expect(result.createdItemIds).not.toContain(existingId);
    expect(await attachmentCount(source)).toBe(0);
  });

  it.each([
    ["another Inbox item's attachment", "foreign"],
    ["an attachment id that does not exist", "unknown"],
  ] as const)("refuses %s with 400 and writes nothing", async (_label, kind) => {
    const { cardId } = await inboxItemWithCard("Scan");
    const blobId = await newBlob("image/jpeg");
    let attachmentId: string;
    if (kind === "foreign") {
      const otherInboxItemId = await plainInboxItem("Someone else's scan");
      attachmentId = await attach(otherInboxItemId, blobId);
    } else {
      attachmentId = randomUUID();
    }
    const attachmentRowsBefore = await attachmentRowCount();
    const blobsBefore = await blobCount();
    const tasksBefore = await countItems(tasksId);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);

    await expect(confirm(cardId)).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { ref: "file", field: "attachmentId" },
    });
    expect(await filesItemsFor(blobId)).toHaveLength(0);
    expect(await attachmentRowCount()).toBe(attachmentRowsBefore);
    expect(await blobCount()).toBe(blobsBefore);
    expect(await countItems(tasksId)).toBe(tasksBefore);
    expect(await cardStatus(cardId)).toBe("proposed");
  });

  it("refuses every attachment when the proposal has no source Inbox item", async () => {
    const inboxItemId = await plainInboxItem("Receipt");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);

    await expect(
      withTransaction(pool, (client) =>
        executeProposalSteps(client, [taskPrimary(), fileStep(attachmentId)], {
          writer: { writerKind: "user" },
          sourceInboxItemId: null,
        }),
      ),
    ).rejects.toMatchObject({ status: 400, details: { ref: "file", field: "attachmentId" } });
    expect(await filesItemsFor(blobId)).toHaveLength(0);
    expect(await attachmentCount(inboxItemId)).toBe(1);
  });

  it.each<[string, (attachmentId: string, blobId: string) => Partial<ProposalStep>]>([
    ["a file property", (attachmentId, blobId) => ({ properties: { attachmentId, name: "Scan", file: { blobId } } })],
    ["a type", (attachmentId) => ({ properties: { attachmentId, name: "Scan", type: "jpg" } })],
    ["an unrelated property", (attachmentId) => ({ properties: { attachmentId, name: "Scan", untrusted: true } })],
    ["an empty name", (attachmentId) => ({ properties: { attachmentId, name: "   " } })],
    ["no attachment", () => ({ properties: { name: "Scan" } })],
    ["an attachment id that is not a UUID", () => ({ properties: { attachmentId: "not-a-uuid", name: "Scan" } })],
    ["a database key", () => ({ databaseKey: "tasks" })],
    ["an item id", () => ({ itemId: randomUUID() })],
    ["a relation that is not a relation property", () => ({ relations: { name: [randomUUID()] } })],
  ])("refuses a step with %s with 400 and writes nothing", async (_label, override) => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Scan");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId, override(attachmentId, blobId))]);

    await expect(confirm(cardId)).rejects.toMatchObject({ status: 400, code: "validation_failed" });
    expect(await filesItemsFor(blobId)).toHaveLength(0);
    expect(await attachmentCount(inboxItemId)).toBe(1);
    expect(await cardStatus(cardId)).toBe("proposed");
  });

  it.each([
    // The Files `type` select of a tenant seeded before #1410 has no `png` option.
    [
      "an option the select lacks",
      "UPDATE properties SET config = jsonb_set(config, '{options}', (SELECT coalesce(jsonb_agg(o), '[]'::jsonb) FROM jsonb_array_elements(config -> 'options') AS o WHERE o ->> 'key' <> 'png')) WHERE database_id = $1 AND key = 'type'",
      "image/png",
    ],
    // A `type` select without any options offers no value at all.
    [
      "a select with no options",
      "UPDATE properties SET config = '{}'::jsonb WHERE database_id = $1 AND key = 'type'",
      "image/jpeg",
    ],
  ])("leaves out the type when the Files type select does not offer it: %s", async (_label, sql, mimeType) => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Photo");
    // A raw update, because no route can produce a Files `type` select in these shapes; it only changes Files options.
    await pool.query(sql, [filesId]);
    const blobId = await newBlob(mimeType);
    const attachmentId = await attach(inboxItemId, blobId);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);

    await confirm(cardId);

    const [fileItem] = await filesItemsFor(blobId);
    expect(fileItem!.properties).not.toHaveProperty("type");
  });

  it("reports a missing Files database as not found and writes nothing", async () => {
    const inboxItemId = await plainInboxItem("Receipt");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    // A raw update inside the rolled-back transaction: the seed always creates the Files database, so this state is unreachable in a real tenant.
    await expect(
      withTransaction(pool, async (client) => {
        await client.query("UPDATE databases SET owner_module_id = NULL WHERE id = $1", [filesId]);
        return executeProposalSteps(client, [taskPrimary(), fileStep(attachmentId)], {
          writer: { writerKind: "user" },
          sourceInboxItemId: inboxItemId,
        });
      }),
    ).rejects.toMatchObject({ status: 404, code: "not_found" });
    expect(await attachmentCount(inboxItemId)).toBe(1);
    expect(await countItems(tasksId)).toBe(0);
  });

  it("refuses a file step as the primary step with 400", async () => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Scan only");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    const primaryFile = fileStep(attachmentId, { role: "primary" });
    await storeSteps(cardId, [primaryFile]);

    await expect(confirm(cardId)).rejects.toMatchObject({
      status: 400,
      code: "validation_failed",
      details: { ref: "file", field: "op" },
    });
    expect(await filesItemsFor(blobId)).toHaveLength(0);
    expect(await attachmentCount(inboxItemId)).toBe(1);
  });

  it("rolls the move back when a later step fails: no Files item, no Task, the attachment stays, the card stays proposed", async () => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Scan and task");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    const blobsBefore = await blobCount();
    const tasksBefore = await countItems(tasksId);
    await storeSteps(cardId, [
      taskPrimary(),
      fileStep(attachmentId),
      // A wrong value type passes envelope validation and fails only in the choke point's write, after the move ran.
      { ref: "broken", op: "create", databaseKey: "tasks", role: "secondary", properties: { name: 42 } },
    ]);

    await expect(confirm(cardId)).rejects.toMatchObject({ status: 400, details: { ref: "broken" } });
    expect(await filesItemsFor(blobId)).toHaveLength(0);
    expect(await attachmentCount(inboxItemId)).toBe(1);
    expect(await blobCount()).toBe(blobsBefore);
    expect(await countItems(tasksId)).toBe(tasksBefore);
    expect(await cardStatus(cardId)).toBe("proposed");
  });

  it("an audio attachment filed by confirm enqueues no transcription, while an audio file made in Files directly is transcribed", async () => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Voice note");
    const blobId = await newBlob("audio/mpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);
    await confirm(cardId);
    const [fileItem] = await filesItemsFor(blobId);

    const emailsId = await databaseIdFor("emails");
    const attachmentsProperty = await withTransaction(pool, (client) =>
      propertiesStore.getPropertyByKey(client, emailsId, "attachments"),
    );
    const handler = createFilesTranscriptionTriggerAction(pool);
    const config = { filesDatabaseId: filesId, attachmentsRelationPropertyId: attachmentsProperty!.id };
    await handler(config, { heartbeatId: "hb", projectItemId: "proj", itemId: fileItem!.id });
    expect(await jobExists(transcriptionJobKey(fileItem!.id))).toBe(false);

    // The contrast: the same trigger still enqueues a recording that has no Inbox origin.
    const recordingBlobId = await newBlob("audio/mpeg");
    const recording = await createIn(filesId, { name: "Recording", file: { blobId: recordingBlobId } });
    await handler(config, { heartbeatId: "hb", projectItemId: "proj", itemId: recording });
    expect(await jobExists(transcriptionJobKey(recording))).toBe(true);
  });

  it("the queued Files heartbeat skips an audio attachment after confirm", async () => {
    const { fileItemId, fireKey } = await runInTenant(getTenantZeroId(), async () => {
      const { inboxItemId, cardId } = await inboxItemWithCard("Voice note");
      const blobId = await newBlob("audio/mpeg");
      const attachmentId = await attach(inboxItemId, blobId);
      await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);
      await confirm(cardId);
      const [fileItem] = await filesItemsFor(blobId);
      if (!fileItem) throw new Error("Expected a filed audio item");
      const heartbeat = await pool.query<{ id: string }>("SELECT id FROM project_heartbeats WHERE action_id = $1", [
        FILES_TRANSCRIPTION_TRIGGER_ACTION_ID,
      ]);
      if (heartbeat.rows.length !== 1 || !heartbeat.rows[0]) throw new Error("Expected a Files heartbeat");
      const fireKey = `heartbeat-fire:${heartbeat.rows[0].id}:${fileItem.id}`;
      expect(await jobExists(fireKey)).toBe(true);
      return { fileItemId: fileItem.id, fireKey };
    });
    const registry = createActionRegistry();
    registry.set(FILES_TRANSCRIPTION_TRIGGER_ACTION_ID, createFilesTranscriptionTriggerAction(pool));
    const heartbeatTask = createCoreTaskList(pool, registry)[CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE];
    if (!heartbeatTask) throw new Error("Missing core heartbeat task");
    await runOnce({ pgPool: pool, taskList: { [CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE]: heartbeatTask } });
    expect(await jobExists(fireKey)).toBe(false);
    expect(await jobExists(transcriptionJobKey(fileItemId))).toBe(false);
    const { rows } = await pool.query<{ last_error: string | null }>(
      "SELECT last_error FROM project_heartbeats WHERE action_id = $1",
      [FILES_TRANSCRIPTION_TRIGGER_ACTION_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.last_error).toBeNull();
  });

  it("deleting the Files item of a move keeps the bytes an unconfirmed attachment still names", async () => {
    const { inboxItemId, cardId } = await inboxItemWithCard("Scan");
    const otherInboxItemId = await plainInboxItem("Second copy, not confirmed");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(inboxItemId, blobId);
    await attach(otherInboxItemId, blobId);
    await storeSteps(cardId, [taskPrimary(), fileStep(attachmentId)]);
    await confirm(cardId);
    const [fileItem] = await filesItemsFor(blobId);

    const released = await withTransaction(pool, async (client) => {
      const row = await itemsStore.getItemById(client, filesId, fileItem!.id);
      return deleteItemDependents(client, row!);
    });

    expect(released.blobStorageKeys).toEqual([]);
    expect(await withTransaction(pool, (client) => getBlob(client, blobId))).not.toBeNull();
    expect(await attachmentCount(otherInboxItemId)).toBe(1);
  });

  it("two confirms that file the same bytes make one Files item: the second waits for the blob lock and reuses the item", async () => {
    const first = await inboxItemWithCard("First scan");
    const second = await inboxItemWithCard("Second scan");
    const blobId = await newBlob("image/jpeg");
    const firstAttachment = await attach(first.inboxItemId, blobId);
    const secondAttachment = await attach(second.inboxItemId, blobId);
    await storeSteps(first.cardId, [taskPrimary("First task"), fileStep(firstAttachment)]);
    await storeSteps(second.cardId, [taskPrimary("Second task"), fileStep(secondAttachment)]);

    const holder = await pool.connect();
    const competitor = await pool.connect();
    let waiting: Promise<Outcome<ItemRow>> | undefined;
    try {
      await holder.query("BEGIN");
      await confirmProposalWithClient(holder, { processingProposalsDatabaseId: proposalsId }, first.cardId);
      await competitor.query("BEGIN");
      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      const competitorPid = (await competitor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      if (!holderPid || !competitorPid) throw new Error("Missing backend PID");
      waiting = settle(
        (async () => {
          try {
            const result = await confirmProposalWithClient(
              competitor,
              { processingProposalsDatabaseId: proposalsId },
              second.cardId,
            );
            await competitor.query("COMMIT");
            return result;
          } catch (error) {
            await competitor.query("ROLLBACK");
            throw error;
          }
        })(),
      );
      await waitForBlobLockWait(holderPid, competitorPid);
      await holder.query("COMMIT");
      const outcome = await waiting;
      if (!("value" in outcome)) throw outcome.error;
      expect(outcome.value.properties.status).toBe("confirmed");
    } catch (error) {
      await holder.query("ROLLBACK");
      await waiting;
      throw error;
    } finally {
      holder.release();
      competitor.release(true);
    }

    const [fileItem] = await filesItemsFor(blobId);
    expect(await filesItemsFor(blobId)).toHaveLength(1);
    expect(await attachmentCount(first.inboxItemId)).toBe(0);
    expect(await attachmentCount(second.inboxItemId)).toBe(0);
    expect(await originRowsFor(fileItem!.id)).toHaveLength(1);
  });

  it("a second move of the same attachment waits for the first, then refuses with 409 and writes nothing", async () => {
    const source = await plainInboxItem("Scan");
    const blobId = await newBlob("image/jpeg");
    const attachmentId = await attach(source, blobId);
    const steps = [taskPrimary(), fileStep(attachmentId)];
    const options = { writer: { writerKind: "user" as const }, sourceInboxItemId: source };

    const holder = await pool.connect();
    const competitor = await pool.connect();
    let waiting: Promise<Outcome<unknown>> | undefined;
    try {
      await holder.query("BEGIN");
      await executeProposalSteps(holder, steps, options);
      await competitor.query("BEGIN");
      const holderPid = (await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      const competitorPid = (await competitor.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid;
      if (!holderPid || !competitorPid) throw new Error("Missing backend PID");
      waiting = settle(
        (async () => {
          try {
            const result = await executeProposalSteps(competitor, steps, options);
            await competitor.query("COMMIT");
            return result;
          } catch (error) {
            await competitor.query("ROLLBACK");
            throw error;
          }
        })(),
      );
      await waitForBlobLockWait(holderPid, competitorPid);
      await holder.query("COMMIT");
      const outcome = await waiting;
      expect(outcome).toMatchObject({ error: { status: 409, code: "version_conflict" } });
    } catch (error) {
      await holder.query("ROLLBACK");
      await waiting;
      throw error;
    } finally {
      holder.release();
      competitor.release(true);
    }

    expect(await filesItemsFor(blobId)).toHaveLength(1);
    expect(await attachmentCount(source)).toBe(0);
  });
});
