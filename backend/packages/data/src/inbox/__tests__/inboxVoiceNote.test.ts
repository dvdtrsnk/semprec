import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, ensureQueueSchema, grantQueueSchemaPrivileges } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { runInTenant } from "@semprec/shared";
import { createBlob } from "../../blobs/blobsStore.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { itemDeleteWithClient } from "../../chokePoint/itemTrash.js";
import { withTransaction } from "../../db/pool.js";
import { createActionQueueAffinity } from "../../scheduler/actions.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../../testSupport/testDb.js";
import {
  deleteInboxAttachment,
  insertInboxAttachments,
  recordInboxAttachmentMetadata,
} from "../inboxAttachmentsStore.js";
import type { InboxAttachmentMetadata } from "../inboxAttachmentMetadata.js";
import {
  enqueueInboxVoiceNoteTranscribe,
  inboxVoiceNoteJobKey,
  inboxVoiceNoteTranscribePayloadSchema,
  INBOX_TRANSCRIBED_TEXT_KEY,
  readInboxVoiceNotes,
  recordInboxTranscribedText,
} from "../inboxVoiceNote.js";

// Issue gh-1980: the two store functions of the voice note transcription and its job's key, on the runtime role pool
// with a second tenant. The handler that runs them is tested in `semprec-transcribe`'s `inboxVoiceNoteTranscribe.test.ts`.

let adminPool: Pool;
let runtimePool: Pool;
let tenantA: string;
let tenantB: string;
let previousScope: string | undefined;

const VOICE_NOTE: InboxAttachmentMetadata = { durationSeconds: 30, audioKind: "voiceNote", pages: null };

beforeAll(async () => {
  previousScope = process.env.SEMPREC_TENANT_SCOPE;
  process.env.SEMPREC_TENANT_SCOPE = "strict";
  adminPool = getTestPool();
  runtimePool = await createRuntimeRolePool(adminPool, "semprec_data");
});

beforeEach(async () => {
  await resetDatabase(adminPool);
  await ensureQueueSchema(adminPool);
  await grantQueueSchemaPrivileges(adminPool);
  tenantA = await createTestTenant(adminPool);
  tenantB = await createTestTenant(adminPool);
  await runInTenant(tenantA, () => seedSystem(runtimePool));
  await runInTenant(tenantB, () => seedSystem(runtimePool));
});

afterAll(async () => {
  await runtimePool?.end();
  await adminPool?.end();
  if (previousScope === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
  else process.env.SEMPREC_TENANT_SCOPE = previousScope;
});

/** Runs `fn` in one transaction of `tenant`, as the runtime role in that tenant's scope. */
function inTenant<T>(tenant: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenant, () => withTransaction(runtimePool, fn));
}

async function inboxDatabaseId(client: PoolClient): Promise<string> {
  const inbox = await getDatabaseByModuleId(client, "inbox");
  if (!inbox) throw new Error("The Inbox database was not seeded");
  return inbox.id;
}

async function newItem(tenant: string, text = "Typed by hand"): Promise<string> {
  return inTenant(tenant, async (client) => {
    const item = await createItemWithClient(client, {
      databaseId: await inboxDatabaseId(client),
      properties: { date: "2026-11-02", time: "10:15", text },
    });
    return item.id;
  });
}

interface AudioOptions {
  /** `null` is an attachment whose metadata job has not run yet. */
  metadata?: InboxAttachmentMetadata | null;
  mimeType?: string;
  byteSize?: number;
}

/** Attaches a blob to `itemId` the way a capture does, and records `metadata` the way the metadata job does. */
async function attach(tenant: string, itemId: string, options: AudioOptions = {}): Promise<string> {
  const { metadata = VOICE_NOTE, mimeType = "audio/mp4", byteSize = 1000 } = options;
  return inTenant(tenant, async (client) => {
    const blob = await createBlob(client, { mimeType, byteSize, storageKey: `${tenant}/blobs/${randomUUID()}` });
    const [attachmentId] = await insertInboxAttachments(client, itemId, [{ blobId: blob.id, source: "files" }]);
    if (attachmentId === undefined) throw new Error("No attachment was inserted");
    if (metadata !== null) {
      await recordInboxAttachmentMetadata(client, { attachmentId, metadata, thumbnail: null, reduced: null });
    }
    return attachmentId;
  });
}

function readNotes(tenant: string, itemId: string) {
  return inTenant(tenant, (client) => readInboxVoiceNotes(client, itemId));
}

function record(tenant: string, input: Parameters<typeof recordInboxTranscribedText>[1]) {
  return inTenant(tenant, (client) => recordInboxTranscribedText(client, input));
}

async function readProperties(tenant: string, itemId: string): Promise<Record<string, unknown>> {
  return runInTenant(tenant, () =>
    withTenantTransaction(runtimePool, tenant, async (client) => {
      const { rows } = await client.query<{ properties: Record<string, unknown> }>(
        "SELECT properties FROM items WHERE id = $1",
        [itemId],
      );
      if (!rows[0]) throw new Error(`Item ${itemId} not found`);
      return rows[0].properties;
    }),
  );
}

/** The whole stored row, to compare before and after a call that must change nothing. */
async function itemRow(tenant: string, itemId: string): Promise<string> {
  return runInTenant(tenant, () =>
    withTenantTransaction(runtimePool, tenant, async (client) => {
      const { rows } = await client.query<{ row: string }>("SELECT i::text AS row FROM items i WHERE id = $1", [
        itemId,
      ]);
      return rows[0]?.row ?? "missing";
    }),
  );
}

const tickJobSchema = z.object({ payload: z.object({ heartbeatId: z.string(), itemId: z.string() }) });

/** The `onItemEvent` heartbeat jobs queued for `itemId`: a write of the item announces itself through them. */
async function heartbeatJobsFor(itemId: string): Promise<number> {
  const raw = await readJobPayloadsByIdentifier(adminPool, CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE);
  return raw.map((entry) => tickJobSchema.parse(entry).payload).filter((payload) => payload.itemId === itemId).length;
}

/** Drops the heartbeat jobs the fixture's own writes queued, so only the ones the call under test queues are seen. */
async function clearHeartbeatJobs(): Promise<void> {
  await adminPool.query(
    "SELECT graphile_worker.remove_job(key) FROM graphile_worker.jobs WHERE task_identifier = $1 AND key IS NOT NULL",
    [CORE_TASK_NAMES.HEARTBEAT_FIRE_CORE],
  );
}

describe("the job of the voice note transcription (issue gh-1980)", () => {
  it("keys one job per Inbox item", () => {
    const id = randomUUID();
    expect(inboxVoiceNoteJobKey(id)).toBe(`inbox-voice-note:${id}`);
  });

  it("accepts an item id as its payload and refuses anything else", () => {
    const id = randomUUID();
    expect(inboxVoiceNoteTranscribePayloadSchema.parse({ inboxItemId: id })).toEqual({ inboxItemId: id });
    expect(inboxVoiceNoteTranscribePayloadSchema.safeParse({ inboxItemId: "not-a-uuid" }).success).toBe(false);
    expect(inboxVoiceNoteTranscribePayloadSchema.safeParse({}).success).toBe(false);
  });

  it("queues one job in the lane of the tenant, and a repeat enqueue for the same item replaces it", async () => {
    const itemId = await newItem(tenantA);
    const otherId = await newItem(tenantA);

    await inTenant(tenantA, (client) => enqueueInboxVoiceNoteTranscribe(client, itemId));
    await inTenant(tenantA, (client) => enqueueInboxVoiceNoteTranscribe(client, itemId));
    await inTenant(tenantA, (client) => enqueueInboxVoiceNoteTranscribe(client, otherId));

    const { rows } = await adminPool.query<{ key: string; queue_name: string | null; max_attempts: number }>(
      "SELECT key, queue_name, max_attempts FROM graphile_worker.jobs WHERE task_identifier = $1 ORDER BY key",
      [CORE_TASK_NAMES.INBOX_VOICE_NOTE_TRANSCRIBE],
    );
    expect(rows).toEqual(
      [itemId, otherId]
        .map((id) => ({ key: inboxVoiceNoteJobKey(id), queue_name: `inbox-voice-note:${tenantA}`, max_attempts: 3 }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    );
  });
});

describe("readInboxVoiceNotes (issue gh-1980)", () => {
  it("lists the voice notes in position order with where their bytes are and how long they are", async () => {
    const itemId = await newItem(tenantA);
    const longer = await attach(tenantA, itemId, {
      metadata: { durationSeconds: 90.5, audioKind: "voiceNote", pages: null },
      mimeType: "audio/mpeg",
      byteSize: 2048,
    });
    const shorter = await attach(tenantA, itemId, { metadata: { ...VOICE_NOTE, durationSeconds: 12 } });

    const notes = await readNotes(tenantA, itemId);

    expect(notes?.map((note) => note.attachmentId)).toEqual([longer, shorter]);
    expect(notes?.map((note) => [note.durationSeconds, note.mimeType, note.byteSize])).toEqual([
      [90.5, "audio/mpeg", 2048],
      [12, "audio/mp4", 1000],
    ]);
    for (const note of notes ?? []) {
      expect(note.storageKey).toMatch(new RegExp(`^${tenantA}/blobs/`));
      expect(note.name).toBeNull();
    }
  });

  it.each<[string, AudioOptions]>([
    ["a recording of exactly 120 seconds", { metadata: { durationSeconds: 120, audioKind: "recording", pages: null } }],
    ["an audio file the metadata job could not read", { metadata: { error: "mediaUnreadable", pages: null } }],
    ["an attachment whose metadata job has not run", { metadata: null }],
    ["a photo", { metadata: { width: 640, height: 480, pages: null }, mimeType: "image/jpeg" }],
    ["a voice note of zero length", { metadata: { durationSeconds: 0, audioKind: "voiceNote", pages: null } }],
    ["a voice note without a length", { metadata: { audioKind: "voiceNote", pages: null } }],
  ])("leaves out %s", async (_name, excluded) => {
    const itemId = await newItem(tenantA);
    await attach(tenantA, itemId, excluded);
    const kept = await attach(tenantA, itemId);

    const notes = await readNotes(tenantA, itemId);

    expect(notes?.map((note) => note.attachmentId)).toEqual([kept]);
  });

  it("returns an empty list for an item without a voice note", async () => {
    const itemId = await newItem(tenantA);

    expect(await readNotes(tenantA, itemId)).toEqual([]);
  });

  it("returns null for an item in the Trash, an id that names no item and an item that is not an Inbox item", async () => {
    const trashed = await newItem(tenantA);
    await attach(tenantA, trashed);
    await inTenant(tenantA, async (client) => {
      await itemDeleteWithClient(client, await inboxDatabaseId(client), trashed, {
        queueAffinity: createActionQueueAffinity(),
      });
    });
    const task = await inTenant(tenantA, async (client) => {
      const tasks = await getDatabaseByModuleId(client, "tasks");
      if (!tasks) throw new Error("The Tasks database was not seeded");
      return (await createItemWithClient(client, { databaseId: tasks.id, properties: { name: "A task" } })).id;
    });

    expect(await readNotes(tenantA, trashed)).toBeNull();
    expect(await readNotes(tenantA, randomUUID())).toBeNull();
    expect(await readNotes(tenantA, task)).toBeNull();
  });

  it("returns null for an item of another tenant, and for a tenant without an Inbox database", async () => {
    const itemId = await newItem(tenantA);
    await attach(tenantA, itemId);
    const unseeded = await createTestTenant(adminPool);

    expect(await readNotes(tenantB, itemId)).toBeNull();
    expect(await readNotes(unseeded, itemId)).toBeNull();
    expect(await readNotes(tenantA, itemId)).toHaveLength(1);
  });
});

describe("recordInboxTranscribedText (issue gh-1980)", () => {
  it("writes the text through the choke point, leaves the person's text alone and announces the update", async () => {
    const itemId = await newItem(tenantA, "Typed by hand");
    const note = await attach(tenantA, itemId);
    await clearHeartbeatJobs();

    const outcome = await record(tenantA, { inboxItemId: itemId, attachmentIds: [note], text: "At the doctor." });

    expect(outcome).toBe("written");
    expect(await readProperties(tenantA, itemId)).toMatchObject({
      text: "Typed by hand",
      date: "2026-11-02",
      time: "10:15",
      [INBOX_TRANSCRIBED_TEXT_KEY]: "At the doctor.",
    });
    expect(await heartbeatJobsFor(itemId)).toBeGreaterThan(0);
  });

  it("writes a text that differs from the stored one, and nothing at all for the same text", async () => {
    const itemId = await newItem(tenantA);
    const note = await attach(tenantA, itemId);
    await record(tenantA, { inboxItemId: itemId, attachmentIds: [note], text: "First version." });
    const written = await itemRow(tenantA, itemId);
    await clearHeartbeatJobs();

    const same = await record(tenantA, { inboxItemId: itemId, attachmentIds: [note], text: "First version." });

    expect(same).toBe("unchanged");
    expect(await itemRow(tenantA, itemId)).toBe(written);
    expect(await heartbeatJobsFor(itemId)).toBe(0);

    const changed = await record(tenantA, { inboxItemId: itemId, attachmentIds: [note], text: "Second version." });

    expect(changed).toBe("written");
    expect(await readProperties(tenantA, itemId)).toMatchObject({ [INBOX_TRANSCRIBED_TEXT_KEY]: "Second version." });
  });

  it("counts a missing value as the empty text: the empty text writes nothing, and replaces a stored text", async () => {
    const itemId = await newItem(tenantA);
    const note = await attach(tenantA, itemId);
    const before = await itemRow(tenantA, itemId);

    expect(await record(tenantA, { inboxItemId: itemId, attachmentIds: [note], text: "" })).toBe("unchanged");
    expect(await itemRow(tenantA, itemId)).toBe(before);

    await record(tenantA, { inboxItemId: itemId, attachmentIds: [note], text: "Something." });
    expect(await record(tenantA, { inboxItemId: itemId, attachmentIds: [note], text: "" })).toBe("written");
    expect(await readProperties(tenantA, itemId)).toMatchObject({ [INBOX_TRANSCRIBED_TEXT_KEY]: "" });
  });

  it("writes nothing when the voice notes are no longer the ones the text was made from", async () => {
    const itemId = await newItem(tenantA);
    const first = await attach(tenantA, itemId);
    const second = await attach(tenantA, itemId);
    const before = await itemRow(tenantA, itemId);

    const added = await record(tenantA, { inboxItemId: itemId, attachmentIds: [first], text: "Only the first." });
    await inTenant(tenantA, (client) => deleteInboxAttachment(client, second));
    const deleted = await record(tenantA, {
      inboxItemId: itemId,
      attachmentIds: [first, second],
      text: "Both of them.",
    });
    const replaced = await record(tenantA, {
      inboxItemId: itemId,
      attachmentIds: [randomUUID()],
      text: "Some other note.",
    });

    expect([added, deleted, replaced]).toEqual(["stale", "stale", "stale"]);
    expect(await itemRow(tenantA, itemId)).toBe(before);
  });

  it("writes nothing for an item in the Trash, an id that names no item and, from another tenant, an item that is not its own", async () => {
    const trashed = await newItem(tenantA);
    const trashedNote = await attach(tenantA, trashed);
    await inTenant(tenantA, async (client) => {
      await itemDeleteWithClient(client, await inboxDatabaseId(client), trashed, {
        queueAffinity: createActionQueueAffinity(),
      });
    });
    const theirs = await newItem(tenantA);
    const theirsNote = await attach(tenantA, theirs);
    const trashedBefore = await itemRow(tenantA, trashed);
    const theirsBefore = await itemRow(tenantA, theirs);

    expect(await record(tenantA, { inboxItemId: trashed, attachmentIds: [trashedNote], text: "Late." })).toBe("gone");
    expect(await record(tenantA, { inboxItemId: randomUUID(), attachmentIds: [], text: "Nobody." })).toBe("gone");
    expect(await record(tenantB, { inboxItemId: theirs, attachmentIds: [theirsNote], text: "Theirs." })).toBe("gone");

    expect(await itemRow(tenantA, trashed)).toBe(trashedBefore);
    expect(await itemRow(tenantA, theirs)).toBe(theirsBefore);
  });

  it("writes nothing for a tenant without an Inbox database", async () => {
    const unseeded = await createTestTenant(adminPool);

    expect(await record(unseeded, { inboxItemId: randomUUID(), attachmentIds: [], text: "Nowhere." })).toBe("gone");
  });
});
