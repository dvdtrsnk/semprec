import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { CORE_TASK_NAMES, registerTask, runOnce } from "@semprec/queue";
import { withTransaction } from "../../db/pool.js";
import { runTenantCutoverMigrations } from "../../db/tenantCutoverMigrations.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { writeComputed } from "../../chokePoint/itemsStore.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import {
  ensureItemAutomation,
  getItemAutomation,
  markItemAutomationDone,
  markItemAutomationError,
  setItemAutomationLocked,
} from "../../library/itemAutomationStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { FILES_MODULE_ID, PEOPLE_MODULE_ID, TRANSCRIPTS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTenantZeroId } from "../../testSupport/tenantFixtures.js";
import { getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  MEETING_NOTES_BACKFILL_BATCH_SIZE,
  runMeetingNotesBackfillCutoverMigration,
} from "../meetingNotesBackfillCutoverMigration.js";
import {
  TRANSCRIPTION_OWNER_PROCESS,
  transcriptionJobKey,
  transcriptionJobPayloadSchema,
  transcriptionSourceLink,
} from "../transcriptionJob.js";

const SEGMENTS = [{ speaker: "SPEAKER_00", text: "Hello.", startsAt: 0, endsAt: 1 }];
const NOTES = {
  title: "Greeting",
  summary: "A greeting.",
  shortSummary: "A greeting.",
  decisions: [],
  actionItems: [],
};

/** One Transcripts row; the defaults are the shape the backfill selects: finished before issue #1695. */
interface TranscriptFixture {
  status?: "processing" | "done" | "error";
  segments?: boolean;
  notes?: boolean;
  automation?: "done" | "error" | "locked" | "pending" | "none";
  /** The item the `link` names, instead of a live source file created in the transcript's own tenant. */
  fileItemId?: string;
}

let adminPool: Pool;
/** The role production runs the tenant cutovers as; row-level security applies to it. */
let dataPool: Pool;
let zero: string;

async function moduleDatabaseId(tenantId: string, moduleId: string): Promise<string> {
  const database = await runInTenant(tenantId, () =>
    withTransaction(dataPool, (client) => getDatabaseByModuleId(client, moduleId)),
  );
  if (!database) throw new Error(`The '${moduleId}' database was not seeded`);
  return database.id;
}

function transcriptsDatabaseId(tenantId: string): Promise<string> {
  return moduleDatabaseId(tenantId, TRANSCRIPTS_MODULE_ID);
}

/** Creates a live item named `recording` in a system database of `tenantId`, through the choke point. */
async function createItemIn(tenantId: string, moduleId: string): Promise<string> {
  const databaseId = await moduleDatabaseId(tenantId, moduleId);
  const item = await runInTenant(tenantId, () =>
    withTransaction(dataPool, (client) =>
      createItemWithClient(client, { databaseId, properties: { name: "recording" } }),
    ),
  );
  return item.id;
}

/** Creates a live Files item in `tenantId`, a transcript's source file. */
function createSourceFile(tenantId: string): Promise<string> {
  return createItemIn(tenantId, FILES_MODULE_ID);
}

/** Moves a transcript's source file to the Trash on its own, as a user deleting the Files item does. */
async function trashSourceFile(tenantId: string, fileItemId: string): Promise<void> {
  const databaseId = await moduleDatabaseId(tenantId, FILES_MODULE_ID);
  const trashed = await runInTenant(tenantId, () => createChokePoint(dataPool).softDeleteItem(databaseId, fileItemId));
  expect(trashed?.deletedAt).toEqual(expect.any(String));
}

/**
 * Creates one transcript in `tenantId` through production writes (the choke point, `writeComputed`, the
 * automation store), with a live source file unless the fixture names another item.
 */
async function createTranscript(
  tenantId: string,
  fixture: TranscriptFixture = {},
): Promise<{ transcriptId: string; fileItemId: string }> {
  const databaseId = await transcriptsDatabaseId(tenantId);
  const fileItemId = fixture.fileItemId ?? (await createSourceFile(tenantId));
  const automation = fixture.automation ?? "done";
  const transcriptId = await runInTenant(tenantId, () =>
    withTransaction(dataPool, async (client) => {
      const item = await createItemWithClient(
        client,
        {
          databaseId,
          properties: {
            name: "recording",
            status: fixture.status ?? "done",
            link: transcriptionSourceLink(fileItemId),
          },
        },
        { allowedSystemKeys: ["status", "link"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      if (fixture.segments !== false) await writeComputed(client, databaseId, item.id, "segments", SEGMENTS);
      if (fixture.notes === true) await writeComputed(client, databaseId, item.id, "meetingNotes", NOTES);
      if (automation !== "none") await ensureItemAutomation(client, item.id);
      if (automation === "done") await markItemAutomationDone(client, item.id);
      if (automation === "error") await markItemAutomationError(client, item.id, "simulated failure", "providerFailed");
      if (automation === "locked") await setItemAutomationLocked(client, item.id, true);
      return item.id;
    }),
  );
  return { transcriptId, fileItemId };
}

/** Replaces a transcript's system-owned `link`, as its owner process; `null` leaves it without one. */
async function setLink(tenantId: string, transcriptId: string, link: string | null): Promise<void> {
  const databaseId = await transcriptsDatabaseId(tenantId);
  await runInTenant(tenantId, () =>
    withTransaction(dataPool, (client) =>
      updateItemWithClient(
        client,
        { databaseId, itemId: transcriptId, propertiesPatch: { link } },
        { allowedSystemKeys: ["link"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      ),
    ),
  );
}

function runBackfill(tenantId: string): Promise<void> {
  return runInTenant(tenantId, () => runMeetingNotesBackfillCutoverMigration(dataPool));
}

/** Code-unit order, which for canonical lowercase uuid text is the bytewise order Postgres sorts `uuid` values in. */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface QueuedJob {
  key: string;
  queue_name: string | null;
  attempts: number;
}

/** The queued transcription jobs in key order, read through graphile-worker's public `jobs` view. */
async function readJobs(): Promise<QueuedJob[]> {
  const { rows } = await adminPool.query<QueuedJob>(
    `SELECT COALESCE(key, '') AS key, queue_name, attempts FROM graphile_worker.jobs WHERE task_identifier = $1`,
    [CORE_TASK_NAMES.TRANSCRIPTION_JOB],
  );
  return rows.sort((a, b) => byCodeUnit(a.key, b.key));
}

function expectedJob(tenantId: string, fileItemId: string): QueuedJob {
  return { key: transcriptionJobKey(fileItemId), queue_name: `transcription:${tenantId}`, attempts: 0 };
}

beforeAll(async () => {
  adminPool = getTestPool();
  dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  const role = await dataPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
});

beforeEach(async () => {
  await resetDatabase(adminPool);
  zero = getTenantZeroId();
  await runInTenant(zero, () => seedSystem(dataPool, createViewTypeRegistry()));
});

afterAll(async () => {
  await dataPool?.end();
  await adminPool?.end();
});

describe("meeting notes backfill cutover (issue #1712)", () => {
  it("enqueues a done transcript without notes once, under its original key in its tenant's lane", async () => {
    const { transcriptId, fileItemId } = await createTranscript(zero);

    await runBackfill(zero);

    expect(await readJobs()).toEqual([expectedJob(zero, fileItemId)]);
    const { rows } = await adminPool.query<{ max_attempts: number }>(
      "SELECT max_attempts FROM graphile_worker.jobs WHERE key = $1",
      [transcriptionJobKey(fileItemId)],
    );
    expect(rows).toEqual([{ max_attempts: 3 }]);
    // The cutover writes nothing but the job: the row's automation is still settled.
    const automation = await runInTenant(zero, () =>
      withTransaction(dataPool, (client) => getItemAutomation(client, transcriptId)),
    );
    expect(automation).toMatchObject({ status: "done", attempts: 0 });
  });

  it.each<[string, TranscriptFixture]>([
    ["already has meeting notes", { notes: true }],
    ["has item_automation in error", { automation: "error" }],
    ["has item_automation locked", { automation: "locked" }],
    ["has item_automation pending", { automation: "pending" }],
    ["has no item_automation row", { automation: "none" }],
    ["is still processing", { status: "processing" }],
    ["has status error", { status: "error" }],
    ["has no segments", { segments: false }],
  ])("does not enqueue a transcript that %s", async (_label, fixture) => {
    await createTranscript(zero, fixture);
    // A transcript the backfill does select, so the absence above is not an idle run.
    const selected = await createTranscript(zero);

    await runBackfill(zero);

    expect(await readJobs()).toEqual([expectedJob(zero, selected.fileItemId)]);
  });

  it("does not enqueue a transcript in the Trash", async () => {
    const trashed = await createTranscript(zero);
    const selected = await createTranscript(zero);
    const databaseId = await transcriptsDatabaseId(zero);
    await runInTenant(zero, () => createChokePoint(dataPool).softDeleteItem(databaseId, trashed.transcriptId));

    await runBackfill(zero);

    expect(await readJobs()).toEqual([expectedJob(zero, selected.fileItemId)]);
  });

  it("does not enqueue a transcript whose source file is in the Trash, and enqueues it once the file is restored", async () => {
    const trashed = await createTranscript(zero);
    const selected = await createTranscript(zero);
    await trashSourceFile(zero, trashed.fileItemId);

    await runBackfill(zero);

    expect(await readJobs()).toEqual([expectedJob(zero, selected.fileItemId)]);
    // The transcript itself is live and its automation is still settled: nothing was written for it.
    const automation = await runInTenant(zero, () =>
      withTransaction(dataPool, (client) => getItemAutomation(client, trashed.transcriptId)),
    );
    expect(automation).toMatchObject({ status: "done", attempts: 0 });

    const filesDatabaseId = await moduleDatabaseId(zero, FILES_MODULE_ID);
    const restored = await runInTenant(zero, () =>
      createChokePoint(dataPool).restoreItem(filesDatabaseId, trashed.fileItemId),
    );
    expect(restored?.deletedAt).toBeNull();
    await runBackfill(zero);

    expect(await readJobs()).toEqual(
      [expectedJob(zero, selected.fileItemId), expectedJob(zero, trashed.fileItemId)].sort((a, b) =>
        byCodeUnit(a.key, b.key),
      ),
    );
  });

  it("does not enqueue a transcript whose source file was purged from the Trash", async () => {
    const purged = await createTranscript(zero);
    const selected = await createTranscript(zero);
    await trashSourceFile(zero, purged.fileItemId);
    // Any cutoff after the moment the file was trashed makes it eligible; no wall-clock wait is involved.
    const result = await runInTenant(zero, () =>
      createChokePoint(dataPool).purgeExpiredTrashSubtree(purged.fileItemId, new Date(Date.now() + 60_000)),
    );
    expect(result.purgedItemIds).toEqual([purged.fileItemId]);

    await runBackfill(zero);

    expect(await readJobs()).toEqual([expectedJob(zero, selected.fileItemId)]);
  });

  it("does not enqueue a transcript whose link names a live item outside the Files database", async () => {
    await createTranscript(zero, { fileItemId: await createItemIn(zero, PEOPLE_MODULE_ID) });
    const selected = await createTranscript(zero);

    await runBackfill(zero);

    expect(await readJobs()).toEqual([expectedJob(zero, selected.fileItemId)]);
  });

  it("enqueues the same transcript again only while its notes are still missing", async () => {
    const { transcriptId, fileItemId } = await createTranscript(zero);
    const databaseId = await transcriptsDatabaseId(zero);

    await runBackfill(zero);
    await runBackfill(zero);
    // The repeat collapsed onto the one job under the key.
    expect(await readJobs()).toEqual([expectedJob(zero, fileItemId)]);

    // Stands in for the transcription pipeline, which lives in semprec-transcribe: the job stores the notes.
    const handled: string[] = [];
    const task = registerTask(CORE_TASK_NAMES.TRANSCRIPTION_JOB, async (payload) => {
      const job = transcriptionJobPayloadSchema.parse(payload);
      handled.push(job.fileItemId);
      await withTransaction(dataPool, (client) =>
        writeComputed(client, databaseId, transcriptId, "meetingNotes", NOTES),
      );
    });
    await runOnce({ pgPool: adminPool, taskList: { [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: task } });
    expect(handled).toEqual([fileItemId]);
    expect(await readJobs()).toEqual([]);

    await runBackfill(zero);

    expect(await readJobs()).toEqual([]);
  });

  it("skips a transcript whose link is not a Files item link and still enqueues the rest", async () => {
    const [first, second] = [await createTranscript(zero), await createTranscript(zero)].sort((a, b) =>
      byCodeUnit(a.transcriptId, b.transcriptId),
    );
    if (!first || !second) throw new Error("expected two transcripts");
    // The lower id is selected first, so the skip is followed by a transcript that must still be enqueued.
    await setLink(zero, first.transcriptId, "https://example.test/not-a-source");

    await runBackfill(zero);

    expect(await readJobs()).toEqual([expectedJob(zero, second.fileItemId)]);
  });

  it("enqueues at most one batch per run, in id order, and the rest on a later run", async () => {
    const created: Array<{ transcriptId: string; fileItemId: string }> = [];
    for (let index = 0; index <= MEETING_NOTES_BACKFILL_BATCH_SIZE; index += 1) {
      created.push(await createTranscript(zero));
    }
    created.sort((a, b) => byCodeUnit(a.transcriptId, b.transcriptId));
    const firstBatch = created.slice(0, MEETING_NOTES_BACKFILL_BATCH_SIZE);
    const last = created[MEETING_NOTES_BACKFILL_BATCH_SIZE];
    if (!last) throw new Error("expected one transcript beyond the batch");
    const keysOf = (rows: Array<{ fileItemId: string }>) =>
      rows.map((row) => transcriptionJobKey(row.fileItemId)).sort(byCodeUnit);

    await runBackfill(zero);
    expect((await readJobs()).map((job) => job.key)).toEqual(keysOf(firstBatch));

    // The first batch's jobs stored their notes, so the next run selects what is left.
    const databaseId = await transcriptsDatabaseId(zero);
    await runInTenant(zero, () =>
      withTransaction(dataPool, async (client) => {
        for (const row of firstBatch) await writeComputed(client, databaseId, row.transcriptId, "meetingNotes", NOTES);
      }),
    );
    await runBackfill(zero);

    expect((await readJobs()).map((job) => job.key)).toEqual(keysOf(created));
  });

  it("counts a link that is not a Files item link towards the batch, and a source file in the Trash not", async () => {
    const created: Array<{ transcriptId: string; fileItemId: string }> = [];
    for (let index = 0; index < MEETING_NOTES_BACKFILL_BATCH_SIZE + 3; index += 1) {
      created.push(await createTranscript(zero));
    }
    created.sort((a, b) => byCodeUnit(a.transcriptId, b.transcriptId));
    // The three lowest ids are the first the selection reaches; a full batch of live sources follows them.
    const [trashed, otherLink, noLink, ...rest] = created;
    if (!trashed || !otherLink || !noLink) throw new Error("expected three leading transcripts");
    expect(rest).toHaveLength(MEETING_NOTES_BACKFILL_BATCH_SIZE);
    await trashSourceFile(zero, trashed.fileItemId);
    await setLink(zero, otherLink.transcriptId, "https://example.test/not-a-source");
    await setLink(zero, noLink.transcriptId, null);

    await runBackfill(zero);

    // The batch holds the two transcripts skipped for their link and the next ones up to its size;
    // the transcript with the trashed source file is not in it.
    const enqueued = rest.slice(0, MEETING_NOTES_BACKFILL_BATCH_SIZE - 2);
    expect((await readJobs()).map((job) => job.key)).toEqual(
      enqueued.map((row) => transcriptionJobKey(row.fileItemId)).sort(byCodeUnit),
    );
  });

  it("is a no-op for a tenant without a Transcripts database", async () => {
    const empty = await createTestTenant(adminPool);

    await expect(runBackfill(empty)).resolves.toBeUndefined();

    expect(await readJobs()).toEqual([]);
  });

  describe("two tenants", () => {
    let other: string;

    beforeEach(async () => {
      other = await createTestTenant(adminPool);
      await runInTenant(other, () => seedSystem(dataPool, createViewTypeRegistry()));
    });

    it("never enqueues another tenant's transcript", async () => {
      const foreign = await createTranscript(other);

      await runBackfill(zero);
      expect(await readJobs()).toEqual([]);

      const own = await createTranscript(zero);
      await runBackfill(zero);
      const jobs = await readJobs();
      expect(jobs).toEqual([expectedJob(zero, own.fileItemId)]);
      expect(jobs.map((job) => job.key)).not.toContain(transcriptionJobKey(foreign.fileItemId));
    });

    it("does not take another tenant's Files item for a transcript's source file", async () => {
      const foreignFileItemId = await createSourceFile(other);
      await createTranscript(zero, { fileItemId: foreignFileItemId });
      const own = await createTranscript(zero);

      await runBackfill(zero);

      expect(await readJobs()).toEqual([expectedJob(zero, own.fileItemId)]);
    });

    it("runs for every tenant through runTenantCutoverMigrations, each transcript in its own tenant's lane and scope", async () => {
      const inZero = await createTranscript(zero);
      const inOther = await createTranscript(other);

      await runAsSystem("test cutover", () => runTenantCutoverMigrations(dataPool));

      expect(await readJobs()).toEqual(
        [expectedJob(zero, inZero.fileItemId), expectedJob(other, inOther.fileItemId)].sort((a, b) =>
          byCodeUnit(a.key, b.key),
        ),
      );

      // Each job runs in the tenant that enqueued it: under row-level security it finds its own transcript only.
      const seen: Array<{ fileItemId: string; links: string[] }> = [];
      const task = registerTask(CORE_TASK_NAMES.TRANSCRIPTION_JOB, async (payload) => {
        const job = transcriptionJobPayloadSchema.parse(payload);
        const { rows } = await withTransaction(dataPool, (client) =>
          client.query<{ link: string }>(
            `SELECT i.properties ->> 'link' AS link FROM items i JOIN databases d ON d.id = i.database_id
             WHERE d.owner_module_id = $1 ORDER BY i.id`,
            [TRANSCRIPTS_MODULE_ID],
          ),
        );
        seen.push({ fileItemId: job.fileItemId, links: rows.map((row) => row.link) });
      });
      await runOnce({ pgPool: adminPool, taskList: { [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: task } });
      expect(seen.sort((a, b) => byCodeUnit(a.fileItemId, b.fileItemId))).toEqual(
        [inZero, inOther]
          .map((row) => ({ fileItemId: row.fileItemId, links: [transcriptionSourceLink(row.fileItemId)] }))
          .sort((a, b) => byCodeUnit(a.fileItemId, b.fileItemId)),
      );
    });
  });
});
