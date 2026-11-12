import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { hardDeleteItem, lockItemById, writeComputed } from "../../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { ChokePointError } from "../../errors.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { setSelfPersonId } from "../../selfPerson.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { listTranscriptActionItems } from "../transcriptActionItems.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";
import {
  TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY,
  TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
} from "../transcriptionComputedKeys.js";
import {
  createEventTranscriptActionItemsRouteHandler,
  createTranscriptActionItemStateRouteHandler,
  createTranscriptActionItemTaskRemoveRouteHandler,
  createTranscriptActionItemTaskRouteHandler,
  createTranscriptDetailRouteHandler,
} from "../transcriptionRouteHandlers.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const USER_ID = "7c0e2f6a-58a1-4d0e-9d55-2f1c6f7c9b01";
const WAIT_MS = 10_000;

const SEGMENTS = [
  { speaker: "SPEAKER_00", text: "Let us start.", startsAt: 0, endsAt: 2 },
  { speaker: "SPEAKER_01", text: "I will send the offer.", startsAt: 2.5, endsAt: 5 },
  { speaker: "SPEAKER_02", text: "I will call the supplier.", startsAt: 5.5, endsAt: 7 },
];

/**
 * Item 0 is owned by SPEAKER_01 (the tenant's own person once mapped), item 1 has no owner, item 2 is
 * owned by SPEAKER_00 (another person once mapped) and item 3 by SPEAKER_02, who stays unmapped.
 */
const NOTES = {
  title: "Offer",
  summary: "{SPEAKER_01} sends the offer.",
  shortSummary: "{SPEAKER_01} sends the offer.",
  decisions: [],
  actionItems: [
    { text: "Send the revised offer", ownerSpeaker: "SPEAKER_01", due: "2026-10-23", startsAt: 2.5 },
    { text: "Book the room", ownerSpeaker: null, due: null, startsAt: null },
    { text: "Review the budget", ownerSpeaker: "SPEAKER_00", due: null, startsAt: 1 },
    { text: "Call the supplier", ownerSpeaker: "SPEAKER_02", due: null, startsAt: 5.5 },
  ],
};

const detailActionItemSchema = z
  .object({
    id: z.number(),
    text: z.string(),
    ownerSpeaker: z.string().nullable(),
    ownerLabel: z.string().nullable(),
    due: z.string().nullable(),
    startsAt: z.number().nullable(),
    state: z.enum(["open", "added", "noted", "dismissed"]),
    taskId: z.string().nullable(),
    isMine: z.boolean(),
  })
  .strict();

const proposalSchema = z
  .object({
    transcriptId: z.string(),
    actionItemId: z.number(),
    text: z.string(),
    ownerSpeaker: z.string().nullable(),
    ownerLabel: z.string().nullable(),
    due: z.string().nullable(),
    startsAt: z.number().nullable(),
    state: z.literal("open"),
  })
  .strict();

const taskAnswerSchema = z.object({ taskId: z.string() }).strict();
interface World {
  /** The tenant's own person, mapped to SPEAKER_01. */
  me: string;
  /** Another person, mapped to SPEAKER_00. */
  other: string;
  project: string;
  event: string;
  transcript: string;
}

async function databaseId(moduleId: string): Promise<string> {
  const database = (await createChokePoint(runtime).listDatabases()).find((row) => row.ownerModuleId === moduleId);
  if (!database) throw new Error(`Missing ${moduleId}`);
  return database.id;
}

async function propertyId(moduleId: string, key: string): Promise<string> {
  const property = (await createChokePoint(runtime).listProperties(await databaseId(moduleId))).find(
    (row) => row.key === key,
  );
  if (!property) throw new Error(`Missing ${moduleId}.${key}`);
  return property.id;
}

async function createItem(moduleId: string, properties: Record<string, unknown>): Promise<string> {
  return (await createChokePoint(runtime).createItem({ databaseId: await databaseId(moduleId), properties })).id;
}

/** A user-written edge, the way the generic relation endpoint writes it. */
async function link(
  moduleId: string,
  key: string,
  callerItemId: string,
  targetItemId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  const relationPropertyId = await propertyId(moduleId, key);
  await withTransaction(runtime, async (client) => {
    await createRelationWithClient(client, { relationPropertyId, callerItemId, targetItemId, metadata });
  });
}

/** A transcript of the tenant in scope with segments and, unless `notes` is `null`, stored meeting notes. */
async function createTranscript(notes: unknown = NOTES, date?: string): Promise<string> {
  const transcripts = await databaseId("transcripts");
  return withTransaction(runtime, async (client) => {
    // The recording `date` is owned by the transcription process, which writes it on intake.
    const item = await createItemWithClient(
      client,
      { databaseId: transcripts, properties: { name: "Meeting", ...(date === undefined ? {} : { date }) } },
      { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
    );
    await writeComputed(client, transcripts, item.id, TRANSCRIPT_SEGMENTS_COMPUTED_KEY, SEGMENTS);
    if (notes !== null) await writeComputed(client, transcripts, item.id, TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY, notes);
    return item.id;
  });
}

async function mapSpeaker(transcriptId: string, speaker: string, personId: string): Promise<void> {
  await link("transcripts", "speakers", transcriptId, personId, { speaker });
}

/**
 * The tenant in scope with its own person, another person, a project, an Event of that project and a
 * transcript linked to the Event whose SPEAKER_01 is the own person and SPEAKER_00 the other person.
 */
async function buildWorld(): Promise<World> {
  const me = await createItem("people", { name: "Zdenek Own" });
  const other = await createItem("people", { name: "Petr Other" });
  await withTransaction(runtime, (client) => setSelfPersonId(client, me));
  const project = await createItem("projects", { name: "Web for client" });
  const event = await createItem("events", { name: "Offer meeting", date: "2026-10-16" });
  await link("events", "project", event, project);
  const transcript = await createTranscript();
  await link("transcripts", "event", transcript, event);
  await mapSpeaker(transcript, "SPEAKER_01", me);
  await mapSpeaker(transcript, "SPEAKER_00", other);
  return { me, other, project, event, transcript };
}

const identity = { user: { id: USER_ID, locale: "en" } };

function postTask(transcriptId: string, actionItemId: string, body: unknown = {}) {
  return createTranscriptActionItemTaskRouteHandler(runtime)({
    params: { id: transcriptId, actionItemId },
    body,
    identity,
  });
}

function removeTask(transcriptId: string, actionItemId: string) {
  return createTranscriptActionItemTaskRemoveRouteHandler(runtime)({
    params: { id: transcriptId, actionItemId },
    body: undefined,
    identity,
  });
}

function follow(transcriptId: string, actionItemId: string, state: "noted" | null) {
  return createTranscriptActionItemStateRouteHandler(runtime)({
    params: { id: transcriptId, actionItemId },
    body: { state },
  });
}

function proposals(eventId: string) {
  return createEventTranscriptActionItemsRouteHandler(runtime)({ params: { id: eventId }, identity });
}

/** The task a successful `POST` answered with: its status and id, the body parsed at the boundary. */
async function addTask(transcriptId: string, actionItemId: number, body: unknown = {}) {
  const answer = await postTask(transcriptId, String(actionItemId), body);
  return { status: answer.status, taskId: taskAnswerSchema.parse(JSON.parse(JSON.stringify(answer.body))).taskId };
}

/** The action items of the transcript detail, read through the route as a client reads them. */
async function detailItems(transcriptId: string) {
  const answer = await createTranscriptDetailRouteHandler(runtime)({ params: { id: transcriptId }, identity });
  const body = z
    .object({ meetingNotes: z.object({ actionItems: z.array(detailActionItemSchema) }).passthrough() })
    .passthrough()
    .parse(JSON.parse(JSON.stringify(answer.body)));
  return body.meetingNotes.actionItems;
}

async function proposalList(eventId: string) {
  const answer = await proposals(eventId);
  expect(answer.status).toBe(200);
  return z.array(proposalSchema).parse(JSON.parse(JSON.stringify(answer.body)));
}

interface TaskRow {
  id: string;
  properties: Record<string, unknown>;
  deleted_at: string | null;
}

/** Every Tasks item of the tenant in scope, the Trash included, read through the runtime role. */
async function allTasks(): Promise<TaskRow[]> {
  const { rows } = await runtime.query<TaskRow>(
    "SELECT id, properties, deleted_at::text AS deleted_at FROM items WHERE database_id = $1 ORDER BY id",
    [await databaseId("tasks")],
  );
  return rows;
}

async function taskRow(taskId: string): Promise<TaskRow> {
  const row = (await allTasks()).find((task) => task.id === taskId);
  if (!row) throw new Error(`Missing task ${taskId}`);
  return row;
}

async function related(moduleId: string, key: string, itemId: string): Promise<string[]> {
  const edges = await createChokePoint(runtime).listItemRelations(itemId, await propertyId(moduleId, key));
  return (edges ?? []).map((edge) => edge.targetItemId).sort();
}

interface StoredState {
  transcript_item_id: string;
  action_item_id: number;
  state: string;
  task_item_id: string | null;
  owner_person_id: string | null;
}

async function storedStates(): Promise<StoredState[]> {
  const { rows } = await runtime.query<StoredState>(
    `SELECT transcript_item_id, action_item_id, state, task_item_id, owner_person_id
       FROM transcript_action_item_states ORDER BY transcript_item_id, action_item_id`,
  );
  return rows;
}

/** The `ChokePointError` a call was refused with: its status, code and details. Any other outcome fails the test. */
async function refusal(call: Promise<unknown>): Promise<{ status: number; code: string; details: unknown }> {
  try {
    await call;
  } catch (error) {
    if (error instanceof ChokePointError) return { status: error.status, code: error.code, details: error.details };
    throw error;
  }
  throw new Error("Expected the call to be refused");
}

function actionItemNotFound(transcriptId: string, actionItemId: number) {
  return {
    status: 404,
    code: "not_found",
    details: { resource: "transcriptActionItem", transcriptId, actionItemId },
  };
}

function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not happen within ${WAIT_MS} ms`)), WAIT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Polls, bounded, until `count` backends wait for a lock; read on the superuser pool. A backend that
 * queues behind another waiter for the same row is blocked by that waiter, not by the holder, so the
 * count is of every waiting backend. The embedded server of the run serves this test file alone.
 */
async function untilBlocked(count: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const { rows } = await admin.query<{ blocked: number }>(
      "SELECT count(*)::int AS blocked FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0",
    );
    if ((rows[0]?.blocked ?? 0) >= count) return;
    if (Date.now() > deadline) throw new Error(`Fewer than ${count} backends were waiting for a lock`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Holds the row lock of the transcript's item in an open transaction until `whileHeld` has finished,
 * then commits it. The gate opens on every path and the holder is awaited before this returns.
 */
async function holdingTranscriptLock(transcriptId: string, whileHeld: () => Promise<void>): Promise<void> {
  const transcripts = await databaseId("transcripts");
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  let announce: () => void = () => {};
  const announced = new Promise<void>((resolve) => (announce = resolve));
  const holder = withTransaction(runtime, async (client) => {
    await lockItemById(client, transcripts, transcriptId);
    announce();
    await gate;
  });
  const failedEarly = holder.then((): never => {
    throw new Error("The holding transaction ended before it was released");
  });
  try {
    await within(Promise.race([announced, failedEarly]), "the holding lock");
    await whileHeld();
  } finally {
    open();
    await Promise.allSettled([holder, failedEarly]);
  }
  await holder;
}

describe("transcript action items (issue #1767)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify action item tasks role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) await runInTenant(id, () => seedSystem(runtime));
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  describe("POST /api/transcripts/:id/action-items/:actionItemId/task", () => {
    it("creates the task with the item's text and due date, linked to the Event, with the Event's project", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();

        const created = await addTask(world.transcript, 0);

        expect(created.status).toBe(201);
        const tasks = await allTasks();
        expect(tasks.map((task) => task.id)).toEqual([created.taskId]);
        expect(tasks[0]).toMatchObject({
          properties: { name: "Send the revised offer", date: "2026-10-23", status: "notDone" },
          deleted_at: null,
        });
        expect(await related("tasks", "sourceEvents", created.taskId)).toEqual([world.event]);
        // The project is the Event's, inherited by the link rules of issue #1724 and not copied by the route.
        expect(await related("tasks", "project", created.taskId)).toEqual([world.project]);
        expect(await storedStates()).toEqual([
          {
            transcript_item_id: world.transcript,
            action_item_id: 0,
            state: "added",
            task_item_id: created.taskId,
            owner_person_id: world.me,
          },
        ]);
      });
    });

    it("names the task and dates it from the body instead of the item's text and due date", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();

        const created = await addTask(world.transcript, 0, { name: "Offer to the client", date: "2026-11-02" });

        expect(created.status).toBe(201);
        expect((await taskRow(created.taskId)).properties).toMatchObject({
          name: "Offer to the client",
          date: "2026-11-02",
        });
      });
    });

    it("creates a task without a date for an item without a due date and without a date in the body", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();

        const created = await addTask(world.transcript, 1);

        const { properties } = await taskRow(created.taskId);
        expect(properties).toMatchObject({ name: "Book the room", status: "notDone" });
        expect(properties).not.toHaveProperty("date");
        expect(await storedStates()).toMatchObject([{ action_item_id: 1, state: "added", owner_person_id: null }]);
      });
    });

    it("stores no owner person for an item whose owner speaker is unmapped", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();

        await addTask(world.transcript, 3);

        expect(await storedStates()).toMatchObject([{ action_item_id: 3, state: "added", owner_person_id: null }]);
      });
    });

    it("creates the task without an Event link for a transcript without a linked Event", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();

        const created = await addTask(transcript, 0);

        expect(created.status).toBe(201);
        expect(await related("tasks", "sourceEvents", created.taskId)).toEqual([]);
        expect(await related("tasks", "project", created.taskId)).toEqual([]);
        expect(await storedStates()).toMatchObject([
          { action_item_id: 0, state: "added", task_item_id: created.taskId },
        ]);
      });
    });

    it("creates the task without an Event link when the linked Event is in the Trash", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createChokePoint(runtime).softDeleteItem(await databaseId("events"), world.event);

        const created = await addTask(world.transcript, 0);

        expect(created.status).toBe(201);
        expect(await related("tasks", "sourceEvents", created.taskId)).toEqual([]);
      });
    });

    it("answers the same task with 200 and creates no second one when the route is called again", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const first = await addTask(world.transcript, 0);
        const stored = await storedStates();

        const second = await addTask(world.transcript, 0, { name: "A different name" });

        expect(second).toEqual({ status: 200, taskId: first.taskId });
        expect((await allTasks()).map((task) => task.id)).toEqual([first.taskId]);
        expect((await taskRow(first.taskId)).properties).toMatchObject({ name: "Send the revised offer" });
        expect(await storedStates()).toEqual(stored);
      });
    });

    it("creates one task for two identical calls that run at the same time", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        let calls: ReturnType<typeof addTask>[] = [];

        // Both calls queue behind the transcript's row lock, so neither can have read the state before the other wrote it.
        await holdingTranscriptLock(world.transcript, async () => {
          calls = [addTask(world.transcript, 0), addTask(world.transcript, 0)];
          // A failure is reported by the `Promise.all` below; this only keeps it from being unhandled while the lock is held.
          for (const call of calls) call.catch(() => {});
          await untilBlocked(2);
          expect(await allTasks()).toEqual([]);
        });
        const answers = await Promise.all(calls);

        expect(answers.map((answer) => answer.status).sort()).toEqual([200, 201]);
        expect(answers[0]?.taskId).toBe(answers[1]?.taskId);
        expect((await allTasks()).map((task) => task.id)).toEqual([answers[0]?.taskId]);
        expect(await storedStates()).toHaveLength(1);
      });
    });

    it("reads the item as open and creates a new task when the task was moved to the Trash elsewhere", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const first = await addTask(world.transcript, 0);
        await createChokePoint(runtime).softDeleteItem(await databaseId("tasks"), first.taskId);

        expect(await detailItems(world.transcript)).toMatchObject([
          { id: 0, state: "open", taskId: null },
          { id: 1, state: "open", taskId: null },
          { id: 2, state: "open", taskId: null },
          { id: 3, state: "open", taskId: null },
        ]);
        const second = await addTask(world.transcript, 0);

        expect(second.status).toBe(201);
        expect(second.taskId).not.toBe(first.taskId);
        expect(await related("tasks", "sourceEvents", second.taskId)).toEqual([world.event]);
        expect(await storedStates()).toMatchObject([
          { action_item_id: 0, state: "added", task_item_id: second.taskId },
        ]);
        expect((await taskRow(first.taskId)).deleted_at).not.toBeNull();
        expect((await detailItems(world.transcript))[0]).toMatchObject({ state: "added", taskId: second.taskId });
      });
    });

    it("reads the item as open and creates a new task when the task was purged elsewhere", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const first = await addTask(world.transcript, 0);
        const tasks = await databaseId("tasks");
        await createChokePoint(runtime).softDeleteItem(tasks, first.taskId);
        expect(await withTransaction(runtime, (client) => hardDeleteItem(client, tasks, first.taskId))).toBe(true);

        expect((await detailItems(world.transcript))[0]).toMatchObject({ state: "open", taskId: null });
        const second = await addTask(world.transcript, 0);

        expect(second.status).toBe(201);
        expect(second.taskId).not.toBe(first.taskId);
        expect((await allTasks()).map((task) => task.id)).toEqual([second.taskId]);
      });
    });

    it("answers the restored task with 200 when the task taken back is restored from the Trash", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const first = await addTask(world.transcript, 0);
        await removeTask(world.transcript, "0");
        await createChokePoint(runtime).restoreItem(await databaseId("tasks"), first.taskId);
        expect(await storedStates()).toEqual([]);

        const again = await addTask(world.transcript, 0);

        expect(again).toEqual({ status: 200, taskId: first.taskId });
        expect((await allTasks()).map((task) => task.id)).toEqual([first.taskId]);
        expect(await storedStates()).toMatchObject([{ action_item_id: 0, state: "added", task_item_id: first.taskId }]);
      });
    });

    it("replaces the followed state when a followed item is added", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        expect(await follow(world.transcript, "0", "noted")).toMatchObject({ status: 200 });
        expect(await detailItems(world.transcript)).toMatchObject([
          { id: 0, state: "noted", taskId: null },
          {},
          {},
          {},
        ]);

        const created = await addTask(world.transcript, 0);

        expect(created.status).toBe(201);
        expect(await storedStates()).toEqual([
          {
            transcript_item_id: world.transcript,
            action_item_id: 0,
            state: "added",
            task_item_id: created.taskId,
            owner_person_id: world.me,
          },
        ]);
      });
    });

    it("leaves the states of the transcript's other items as they are", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await follow(world.transcript, "1", "noted");

        const created = await addTask(world.transcript, 0);

        expect(await storedStates()).toMatchObject([
          { action_item_id: 0, state: "added", task_item_id: created.taskId },
          { action_item_id: 1, state: "noted", task_item_id: null },
        ]);
      });
    });

    it.each([
      ["a transcript id that is not a UUID", "not-a-uuid", "0", {}, "id"],
      ["an action item id that is not a number", "", "abc", {}, "actionItemId"],
      ["a negative action item id", "", "-1", {}, "actionItemId"],
      ["a fractional action item id", "", "1.5", {}, "actionItemId"],
      ["an action item id beyond the integer column", "", "2147483648", {}, "actionItemId"],
      ["a numeric name", "", "0", { name: 5 }, "name"],
      ["a date that is not a calendar date", "", "0", { date: "2026-13-45" }, "date"],
      ["a date with a time", "", "0", { date: "2026-10-23T10:00:00Z" }, "date"],
      ["a body that is a string", "", "0", "task", "body"],
      ["a body that is null", "", "0", null, "body"],
      ["a body that is an array", "", "0", [], "body"],
    ])("refuses %s with validation_failed and writes nothing", async (_label, id, actionItemId, body, field) => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();

        expect(await refusal(postTask(id === "" ? world.transcript : id, actionItemId, body))).toEqual({
          status: 400,
          code: "validation_failed",
          details: { field },
        });

        expect(await allTasks()).toEqual([]);
        expect(await storedStates()).toEqual([]);
      });
    });

    it("answers 404 for an unknown transcript, an item the notes do not have and a transcript without notes", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const withoutNotes = await createTranscript(null);
        const unknown = randomUUID();

        expect(await refusal(postTask(unknown, "0"))).toEqual(actionItemNotFound(unknown, 0));
        expect(await refusal(postTask(world.transcript, "4"))).toEqual(actionItemNotFound(world.transcript, 4));
        expect(await refusal(postTask(withoutNotes, "0"))).toEqual(actionItemNotFound(withoutNotes, 0));

        expect(await allTasks()).toEqual([]);
        expect(await storedStates()).toEqual([]);
      });
    });

    it("answers 404 for a transcript in the Trash", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await createChokePoint(runtime).softDeleteItem(await databaseId("transcripts"), world.transcript);

        expect(await refusal(postTask(world.transcript, "0"))).toEqual(actionItemNotFound(world.transcript, 0));

        expect(await allTasks()).toEqual([]);
        expect(await storedStates()).toEqual([]);
      });
    });

    it("answers another tenant's transcript like an unknown one and creates nothing in either tenant", async () => {
      let foreignTranscript = "";
      await runInTenant(foreign, async () => {
        foreignTranscript = (await buildWorld()).transcript;
      });
      await runInTenant(tenant, async () => {
        await buildWorld();
        const unknown = randomUUID();

        const asForeign = await refusal(postTask(foreignTranscript, "0"));
        const asUnknown = await refusal(postTask(unknown, "0"));

        expect(asForeign).toEqual(actionItemNotFound(foreignTranscript, 0));
        expect({ ...asForeign, details: undefined }).toEqual({ ...asUnknown, details: undefined });
        expect(await allTasks()).toEqual([]);
        expect(await storedStates()).toEqual([]);
      });
      await runInTenant(foreign, async () => {
        expect(await allTasks()).toEqual([]);
        expect(await storedStates()).toEqual([]);
      });
    });
  });

  describe("DELETE /api/transcripts/:id/action-items/:actionItemId/task", () => {
    it("moves the task to the Trash, clears the state and keeps the task restorable", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const created = await addTask(world.transcript, 0);

        const answer = await removeTask(world.transcript, "0");

        expect(answer).toEqual({ status: 200, body: { actionItemId: 0, state: null } });
        expect((await taskRow(created.taskId)).deleted_at).not.toBeNull();
        expect(await storedStates()).toEqual([]);
        expect((await detailItems(world.transcript))[0]).toMatchObject({ state: "open", taskId: null });
        await createChokePoint(runtime).restoreItem(await databaseId("tasks"), created.taskId);
        expect((await taskRow(created.taskId)).deleted_at).toBeNull();
      });
    });

    it("changes nothing on a repeated undo", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const created = await addTask(world.transcript, 0);
        await removeTask(world.transcript, "0");
        const trashed = await taskRow(created.taskId);

        const again = await removeTask(world.transcript, "0");

        expect(again).toEqual({ status: 200, body: { actionItemId: 0, state: null } });
        expect(await taskRow(created.taskId)).toEqual(trashed);
        expect(await storedStates()).toEqual([]);
      });
    });

    it("creates a new task when the item is added again after the undo", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const first = await addTask(world.transcript, 0);
        await removeTask(world.transcript, "0");

        const second = await addTask(world.transcript, 0);

        expect(second.status).toBe(201);
        expect(second.taskId).not.toBe(first.taskId);
        expect((await taskRow(first.taskId)).deleted_at).not.toBeNull();
        expect((await taskRow(second.taskId)).deleted_at).toBeNull();
      });
    });

    it("clears the state and leaves the task in the Trash when the task was trashed elsewhere", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const created = await addTask(world.transcript, 0);
        await createChokePoint(runtime).softDeleteItem(await databaseId("tasks"), created.taskId);
        const trashed = await taskRow(created.taskId);

        expect(await removeTask(world.transcript, "0")).toEqual({
          status: 200,
          body: { actionItemId: 0, state: null },
        });

        expect(await taskRow(created.taskId)).toEqual(trashed);
        expect(await storedStates()).toEqual([]);
      });
    });

    it("clears the state when the task was purged elsewhere", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const created = await addTask(world.transcript, 0);
        const tasks = await databaseId("tasks");
        await createChokePoint(runtime).softDeleteItem(tasks, created.taskId);
        await withTransaction(runtime, (client) => hardDeleteItem(client, tasks, created.taskId));

        expect(await removeTask(world.transcript, "0")).toEqual({
          status: 200,
          body: { actionItemId: 0, state: null },
        });

        expect(await allTasks()).toEqual([]);
        expect(await storedStates()).toEqual([]);
      });
    });

    it("changes nothing for a followed item and answers its state", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await follow(world.transcript, "0", "noted");
        const stored = await storedStates();

        expect(await removeTask(world.transcript, "0")).toEqual({
          status: 200,
          body: { actionItemId: 0, state: "noted" },
        });

        expect(await storedStates()).toEqual(stored);
        expect(await allTasks()).toEqual([]);
      });
    });

    it("changes nothing for an open item and answers state null", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const created = await addTask(world.transcript, 0);

        expect(await removeTask(world.transcript, "1")).toEqual({
          status: 200,
          body: { actionItemId: 1, state: null },
        });

        expect((await taskRow(created.taskId)).deleted_at).toBeNull();
        expect(await storedStates()).toMatchObject([{ action_item_id: 0, state: "added" }]);
      });
    });

    it("leaves the tasks of the transcript's other items alone", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const first = await addTask(world.transcript, 0);
        const second = await addTask(world.transcript, 1);

        await removeTask(world.transcript, "0");

        expect((await taskRow(first.taskId)).deleted_at).not.toBeNull();
        expect((await taskRow(second.taskId)).deleted_at).toBeNull();
        expect(await storedStates()).toMatchObject([
          { action_item_id: 1, state: "added", task_item_id: second.taskId },
        ]);
      });
    });

    it("waits for the transcript's row lock and then undoes the addition that held it", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const created = await addTask(world.transcript, 0);
        let undo: ReturnType<typeof removeTask> | undefined;

        await holdingTranscriptLock(world.transcript, async () => {
          undo = removeTask(world.transcript, "0");
          undo.catch(() => {});
          await untilBlocked(1);
          expect((await taskRow(created.taskId)).deleted_at).toBeNull();
        });
        if (!undo) throw new Error("The undo was not started");

        expect(await undo).toEqual({ status: 200, body: { actionItemId: 0, state: null } });
        expect((await taskRow(created.taskId)).deleted_at).not.toBeNull();
      });
    });

    it.each([
      ["a transcript id that is not a UUID", "not-a-uuid", "0", "id"],
      ["an action item id that is not a number", "", "abc", "actionItemId"],
      ["a negative action item id", "", "-1", "actionItemId"],
    ])("refuses %s with validation_failed", async (_label, id, actionItemId, field) => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await addTask(world.transcript, 0);

        expect(await refusal(removeTask(id === "" ? world.transcript : id, actionItemId))).toEqual({
          status: 400,
          code: "validation_failed",
          details: { field },
        });

        expect(await storedStates()).toMatchObject([{ action_item_id: 0, state: "added" }]);
      });
    });

    it("answers 404 for an unknown transcript, an item the notes do not have and a transcript in the Trash", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const created = await addTask(world.transcript, 0);
        const unknown = randomUUID();
        const trashed = await createTranscript();
        await createChokePoint(runtime).softDeleteItem(await databaseId("transcripts"), trashed);

        expect(await refusal(removeTask(unknown, "0"))).toEqual(actionItemNotFound(unknown, 0));
        expect(await refusal(removeTask(world.transcript, "4"))).toEqual(actionItemNotFound(world.transcript, 4));
        expect(await refusal(removeTask(trashed, "0"))).toEqual(actionItemNotFound(trashed, 0));

        expect((await taskRow(created.taskId)).deleted_at).toBeNull();
        expect(await storedStates()).toMatchObject([{ action_item_id: 0, state: "added" }]);
      });
    });

    it("answers another tenant's transcript like an unknown one and leaves that tenant's task and state alone", async () => {
      let foreignTranscript = "";
      let foreignTask = "";
      await runInTenant(foreign, async () => {
        const world = await buildWorld();
        foreignTranscript = world.transcript;
        foreignTask = (await addTask(world.transcript, 0)).taskId;
      });
      await runInTenant(tenant, async () => {
        await buildWorld();
        const unknown = randomUUID();

        const asForeign = await refusal(removeTask(foreignTranscript, "0"));
        const asUnknown = await refusal(removeTask(unknown, "0"));

        expect(asForeign).toEqual(actionItemNotFound(foreignTranscript, 0));
        expect({ ...asForeign, details: undefined }).toEqual({ ...asUnknown, details: undefined });
      });
      await runInTenant(foreign, async () => {
        expect((await taskRow(foreignTask)).deleted_at).toBeNull();
        expect(await storedStates()).toMatchObject([{ action_item_id: 0, state: "added", task_item_id: foreignTask }]);
      });
    });
  });

  describe("the action items of the transcript detail", () => {
    it("carries each item's state, live task and whether it is the reader's own", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const created = await addTask(world.transcript, 0);
        await follow(world.transcript, "2", "noted");

        expect(await detailItems(world.transcript)).toEqual([
          {
            id: 0,
            text: "Send the revised offer",
            ownerSpeaker: "SPEAKER_01",
            ownerLabel: "Zdenek Own",
            due: "2026-10-23",
            startsAt: 2.5,
            state: "added",
            taskId: created.taskId,
            isMine: true,
          },
          {
            id: 1,
            text: "Book the room",
            ownerSpeaker: null,
            ownerLabel: null,
            due: null,
            startsAt: null,
            state: "open",
            taskId: null,
            isMine: false,
          },
          {
            id: 2,
            text: "Review the budget",
            ownerSpeaker: "SPEAKER_00",
            ownerLabel: "Petr Other",
            due: null,
            startsAt: 1,
            state: "noted",
            taskId: null,
            isMine: false,
          },
          {
            id: 3,
            text: "Call the supplier",
            ownerSpeaker: "SPEAKER_02",
            ownerLabel: expect.any(String),
            due: null,
            startsAt: 5.5,
            state: "open",
            taskId: null,
            isMine: false,
          },
        ]);
      });
    });

    it("marks no item as the reader's own in a tenant without an own person", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        await mapSpeaker(transcript, "SPEAKER_01", await createItem("people", { name: "Zdenek Own" }));

        expect((await detailItems(transcript)).map((item) => item.isMine)).toEqual([false, false, false, false]);
      });
    });

    it("lists no items for an unknown transcript, a transcript in the Trash and a transcript without notes", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const withoutNotes = await createTranscript(null);
        await createChokePoint(runtime).softDeleteItem(await databaseId("transcripts"), world.transcript);
        const list = (id: string) => withTransaction(runtime, (client) => listTranscriptActionItems(client, id, "en"));

        expect(await list(randomUUID())).toEqual([]);
        expect(await list(world.transcript)).toEqual([]);
        expect(await list(withoutNotes)).toEqual([]);
      });
    });

    it("lists the items of a transcript only in the tenant that owns it", async () => {
      let foreignTranscript = "";
      await runInTenant(foreign, async () => {
        foreignTranscript = (await buildWorld()).transcript;
      });
      await runInTenant(tenant, async () => {
        const list = (id: string) => withTransaction(runtime, (client) => listTranscriptActionItems(client, id, "en"));

        expect(await list(foreignTranscript)).toEqual([]);
      });
      await runInTenant(foreign, async () => {
        expect(
          await withTransaction(runtime, (client) => listTranscriptActionItems(client, foreignTranscript, "en")),
        ).toHaveLength(4);
      });
    });
  });

  describe("GET /api/events/:id/transcript-action-items", () => {
    it("offers the open items that are mine or have no owner and no one else's", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();

        expect(await proposalList(world.event)).toEqual([
          {
            transcriptId: world.transcript,
            actionItemId: 0,
            text: "Send the revised offer",
            ownerSpeaker: "SPEAKER_01",
            ownerLabel: "Zdenek Own",
            due: "2026-10-23",
            startsAt: 2.5,
            state: "open",
          },
          {
            transcriptId: world.transcript,
            actionItemId: 1,
            text: "Book the room",
            ownerSpeaker: null,
            ownerLabel: null,
            due: null,
            startsAt: null,
            state: "open",
          },
        ]);
      });
    });

    it("leaves out an item that has a live task and a followed item", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        await addTask(world.transcript, 0);
        await follow(world.transcript, "1", "noted");

        expect(await proposalList(world.event)).toEqual([]);
      });
    });

    it("offers an item again after its task was moved to the Trash or taken back", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const first = await addTask(world.transcript, 0);
        await addTask(world.transcript, 1);
        await createChokePoint(runtime).softDeleteItem(await databaseId("tasks"), first.taskId);
        expect((await proposalList(world.event)).map((item) => item.actionItemId)).toEqual([0]);

        await removeTask(world.transcript, "1");

        expect((await proposalList(world.event)).map((item) => item.actionItemId)).toEqual([0, 1]);
      });
    });

    it("orders the items by the transcript's date and then by item id, with an undated transcript last", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const later = await createTranscript(NOTES, "2026-10-17T09:00:00Z");
        const earlier = await createTranscript(NOTES, "2026-10-15T09:00:00Z");
        for (const transcript of [later, earlier]) {
          await link("transcripts", "event", transcript, world.event);
          await mapSpeaker(transcript, "SPEAKER_01", world.me);
        }

        expect((await proposalList(world.event)).map((item) => [item.transcriptId, item.actionItemId])).toEqual([
          [earlier, 0],
          [earlier, 1],
          [later, 0],
          [later, 1],
          [world.transcript, 0],
          [world.transcript, 1],
        ]);
      });
    });

    it("leaves out the items of a transcript in the Trash", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const second = await createTranscript(NOTES, "2026-10-15T09:00:00Z");
        await link("transcripts", "event", second, world.event);
        await createChokePoint(runtime).softDeleteItem(await databaseId("transcripts"), second);

        expect(new Set((await proposalList(world.event)).map((item) => item.transcriptId))).toEqual(
          new Set([world.transcript]),
        );
      });
    });

    it("leaves out the items of a transcript that is linked to another Event", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const otherEvent = await createItem("events", { name: "Other meeting", date: "2026-10-18" });
        const otherTranscript = await createTranscript();
        await link("transcripts", "event", otherTranscript, otherEvent);
        await mapSpeaker(otherTranscript, "SPEAKER_01", world.me);

        expect(new Set((await proposalList(world.event)).map((item) => item.transcriptId))).toEqual(
          new Set([world.transcript]),
        );
        expect((await proposalList(otherEvent)).map((item) => item.transcriptId)).toEqual([
          otherTranscript,
          otherTranscript,
        ]);
      });
    });

    it("answers an empty list for an Event without a transcript", async () => {
      await runInTenant(tenant, async () => {
        await buildWorld();
        const lonely = await createItem("events", { name: "Lonely", date: "2026-10-19" });

        expect(await proposalList(lonely)).toEqual([]);
      });
    });

    it("offers no item as mine in a tenant without an own person, only the items without an owner", async () => {
      await runInTenant(tenant, async () => {
        const event = await createItem("events", { name: "Offer meeting", date: "2026-10-16" });
        const transcript = await createTranscript();
        await link("transcripts", "event", transcript, event);
        await mapSpeaker(transcript, "SPEAKER_01", await createItem("people", { name: "Zdenek Own" }));

        expect((await proposalList(event)).map((item) => item.actionItemId)).toEqual([1]);
      });
    });

    it("answers 404 for an unknown Event and an Event in the Trash", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();
        const unknown = randomUUID();
        await createChokePoint(runtime).softDeleteItem(await databaseId("events"), world.event);

        expect(await refusal(proposals(unknown))).toMatchObject({ status: 404, code: "not_found" });
        expect(await refusal(proposals(world.event))).toMatchObject({ status: 404, code: "not_found" });
      });
    });

    it("answers 404 for an item of another database than Events", async () => {
      await runInTenant(tenant, async () => {
        const world = await buildWorld();

        expect(await refusal(proposals(world.project))).toMatchObject({ status: 404, code: "not_found" });
      });
    });

    it("answers another tenant's Event exactly like an unknown one", async () => {
      let foreignEvent = "";
      await runInTenant(foreign, async () => {
        foreignEvent = (await buildWorld()).event;
      });
      await runInTenant(tenant, async () => {
        await buildWorld();

        const asForeign = await refusal(proposals(foreignEvent));
        const asUnknown = await refusal(proposals(randomUUID()));

        expect(asForeign).toEqual(asUnknown);
        expect(asForeign).toMatchObject({ status: 404, code: "not_found" });
      });
      await runInTenant(foreign, async () => {
        // The foreign tenant reads its own Event, so the 404 above is a refusal and not an empty fixture.
        expect(await proposalList(foreignEvent)).toHaveLength(2);
      });
    });

    it("refuses an Event id that is not a UUID with validation_failed", async () => {
      await runInTenant(tenant, async () => {
        expect(await refusal(proposals("not-a-uuid"))).toEqual({
          status: 400,
          code: "validation_failed",
          details: { field: "id" },
        });
      });
    });
  });
});
