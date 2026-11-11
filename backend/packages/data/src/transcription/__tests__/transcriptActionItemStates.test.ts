import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { deleteItemDependents } from "../../chokePoint/itemTrash.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { getItemById, hardDeleteItem, writeComputed } from "../../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { ChokePointError } from "../../errors.js";
import type { BlobStorageWriter } from "../../mail/blobStorage.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { purgeExpiredTrash } from "../../trash/purgeExpiredTrash.js";
import { clearActionItemState, listActionItemStates, setActionItemState } from "../transcriptActionItemStates.js";
import {
  TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY,
  TRANSCRIPT_SEGMENTS_COMPUTED_KEY,
} from "../transcriptionComputedKeys.js";
import { createTranscriptActionItemStateRouteHandler } from "../transcriptionRouteHandlers.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;

const SEGMENTS = [
  { speaker: "SPEAKER_00", text: "Let us start.", startsAt: 0, endsAt: 2 },
  { speaker: "SPEAKER_01", text: "I will send the contract.", startsAt: 2.5, endsAt: 5 },
];

/** Stored notes with an owned action item (id 0) and one without an owner (id 1). */
const NOTES = {
  title: "Contract",
  summary: "{SPEAKER_01} sends the contract.",
  shortSummary: "{SPEAKER_01} sends the contract.",
  decisions: [],
  actionItems: [
    { text: "{SPEAKER_01} sends the contract", ownerSpeaker: "SPEAKER_01", due: "2026-10-17", startsAt: 2.5 },
    { text: "Book the room", ownerSpeaker: null, due: null, startsAt: null },
  ],
};

const FOLLOW = { state: "noted" };
const OPEN = { state: null };
const WAIT_MS = 10_000;

interface StoredState {
  transcript_item_id: string;
  action_item_id: number;
  state: string;
  task_item_id: string | null;
  owner_person_id: string | null;
  updated_at: string;
  /** The row version: it changes whenever the row is rewritten, even with equal values. */
  version: string;
}

/** Every state row the scope can see, read without a tenant predicate so row-level security alone confines it. */
async function storedStates(pool: Pool = runtime): Promise<StoredState[]> {
  const { rows } = await pool.query<StoredState>(
    `SELECT transcript_item_id, action_item_id, state, task_item_id, owner_person_id,
            updated_at::text AS updated_at, xmin::text AS version
       FROM transcript_action_item_states ORDER BY transcript_item_id, action_item_id`,
  );
  return rows;
}

async function databaseId(moduleId: string): Promise<string> {
  const database = (await createChokePoint(runtime).listDatabases()).find((row) => row.ownerModuleId === moduleId);
  if (!database) throw new Error(`Missing ${moduleId}`);
  return database.id;
}

/** A transcript of the tenant in scope with segments and, unless `notes` is `null`, stored meeting notes. */
async function createTranscript(notes: unknown = NOTES): Promise<string> {
  const transcripts = await databaseId("transcripts");
  return withTransaction(runtime, async (client) => {
    const item = await createItemWithClient(client, { databaseId: transcripts, properties: { name: "Meeting" } });
    await writeComputed(client, transcripts, item.id, TRANSCRIPT_SEGMENTS_COMPUTED_KEY, SEGMENTS);
    if (notes !== null) {
      await writeComputed(client, transcripts, item.id, TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY, notes);
    }
    return item.id;
  });
}

/** Creates a person and maps `speaker` of the transcript to them through a `speakers` edge; returns the person's id. */
async function mapSpeaker(transcriptId: string, speaker: string, name: string): Promise<string> {
  const cp = createChokePoint(runtime);
  const property = (await cp.listProperties(await databaseId("transcripts"))).find((row) => row.key === "speakers");
  if (!property) throw new Error("Missing speakers");
  const person = await cp.createItem({ databaseId: await databaseId("people"), properties: { name } });
  await withTransaction(runtime, (client) =>
    createRelationWithClient(client, {
      relationPropertyId: property.id,
      callerItemId: transcriptId,
      targetItemId: person.id,
      metadata: { speaker },
    }),
  );
  return person.id;
}

function put(transcriptId: string, actionItemId: string, body: unknown) {
  return createTranscriptActionItemStateRouteHandler(runtime)({ params: { id: transcriptId, actionItemId }, body });
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

function notFound(transcriptId: string, actionItemId: number) {
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

async function backendPid(client: PoolClient): Promise<number> {
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  const pid = rows[0]?.pid;
  if (pid === undefined) throw new Error("No backend pid");
  return pid;
}

/** Polls, bounded, until a backend waits for a lock `holderPid` holds; read on the superuser pool. */
async function untilBlockedBy(holderPid: number): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    const { rows } = await admin.query<{ blocked: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS blocked",
      [holderPid],
    );
    if (rows[0]?.blocked === true) return;
    if (Date.now() > deadline) throw new Error(`No backend was blocked by ${holderPid}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Runs `write` in a transaction that stays open until `whileHeld` has finished, then commits it.
 * `whileHeld` receives the holder's backend pid. The gate opens on every path and the holder is
 * awaited before this returns, so a failing case leaves no open transaction behind.
 */
async function holding(
  write: (client: PoolClient) => Promise<unknown>,
  whileHeld: (holderPid: number) => Promise<void>,
): Promise<void> {
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  let announce: (pid: number) => void = () => {};
  const announced = new Promise<number>((resolve) => (announce = resolve));
  const holder = withTransaction(runtime, async (client) => {
    await write(client);
    announce(await backendPid(client));
    await gate;
  });
  const failedEarly = holder.then((): never => {
    throw new Error("The holding transaction ended before it was released");
  });
  try {
    await whileHeld(await within(Promise.race([announced, failedEarly]), "the holding write"));
  } finally {
    open();
    await Promise.allSettled([holder, failedEarly]);
  }
  await holder;
}

const noted = (transcriptId: string, actionItemId: number) => ({
  transcriptId,
  actionItemId,
  state: "noted" as const,
  taskItemId: null,
  ownerPersonId: null,
});

describe("transcript action item states (issue #1754)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify action item state role", () =>
      runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  describe("PUT /api/transcripts/:id/action-items/:actionItemId/state", () => {
    it("follows an action item and records the person its owner speaker is mapped to", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        const owner = await mapSpeaker(transcript, "SPEAKER_01", "Jana Novak");
        await mapSpeaker(transcript, "SPEAKER_00", "Petr Svoboda");

        expect(await put(transcript, "0", FOLLOW)).toEqual({ status: 200, body: { actionItemId: 0, state: "noted" } });

        expect(await storedStates()).toMatchObject([
          {
            transcript_item_id: transcript,
            action_item_id: 0,
            state: "noted",
            task_item_id: null,
            owner_person_id: owner,
          },
        ]);
        expect(await storedStates()).toHaveLength(1);
      });
    });

    it("changes nothing and answers the same on a second identical follow", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        await mapSpeaker(transcript, "SPEAKER_01", "Jana Novak");
        const first = await put(transcript, "0", FOLLOW);
        const stored = await storedStates();
        expect(stored).toHaveLength(1);

        expect(await put(transcript, "0", FOLLOW)).toEqual(first);

        // Same values, same `updated_at` and the same row version: the row was not rewritten.
        expect(await storedStates()).toEqual(stored);
      });
    });

    it("stores no owner person for an item whose owner speaker is unmapped", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        await mapSpeaker(transcript, "SPEAKER_00", "Petr Svoboda");

        await put(transcript, "0", FOLLOW);

        expect(await storedStates()).toMatchObject([{ action_item_id: 0, state: "noted", owner_person_id: null }]);
      });
    });

    it("stores no owner person for an item without an owner speaker", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        await mapSpeaker(transcript, "SPEAKER_01", "Jana Novak");

        expect(await put(transcript, "1", FOLLOW)).toEqual({ status: 200, body: { actionItemId: 1, state: "noted" } });

        expect(await storedStates()).toMatchObject([{ action_item_id: 1, state: "noted", owner_person_id: null }]);
      });
    });

    it("stores the newly mapped owner when a followed item is followed again", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        const first = await put(transcript, "0", FOLLOW);
        const [before] = await storedStates();
        expect(before).toMatchObject({ state: "noted", owner_person_id: null });
        const owner = await mapSpeaker(transcript, "SPEAKER_01", "Jana Novak");

        expect(await put(transcript, "0", FOLLOW)).toEqual(first);

        const after = await storedStates();
        expect(after).toMatchObject([{ action_item_id: 0, state: "noted", owner_person_id: owner }]);
        expect(after[0]?.version).not.toBe(before?.version);
      });
    });

    it("clears a followed item, answers state null and keeps the transcript's other state", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        await put(transcript, "0", FOLLOW);
        await put(transcript, "1", FOLLOW);

        expect(await put(transcript, "0", OPEN)).toEqual({ status: 200, body: { actionItemId: 0, state: null } });

        expect(await storedStates()).toMatchObject([{ transcript_item_id: transcript, action_item_id: 1 }]);
        expect(await storedStates()).toHaveLength(1);
        // The item is followable again.
        expect(await put(transcript, "0", FOLLOW)).toEqual({ status: 200, body: { actionItemId: 0, state: "noted" } });
        expect((await storedStates()).map((row) => row.action_item_id)).toEqual([0, 1]);
      });
    });

    it("writes nothing and answers state null when an open item is cleared", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        await put(transcript, "1", FOLLOW);
        const stored = await storedStates();

        expect(await put(transcript, "0", OPEN)).toEqual({ status: 200, body: { actionItemId: 0, state: null } });
        expect(await put(transcript, "0", OPEN)).toEqual({ status: 200, body: { actionItemId: 0, state: null } });

        expect(await storedStates()).toEqual(stored);
      });
    });

    it("answers 404 for an unknown transcript id and writes nothing", async () => {
      await runInTenant(tenant, async () => {
        await createTranscript();
        const unknown = randomUUID();

        expect(await refusal(put(unknown, "0", FOLLOW))).toEqual(notFound(unknown, 0));
        expect(await refusal(put(unknown, "0", OPEN))).toEqual(notFound(unknown, 0));

        expect(await storedStates()).toEqual([]);
      });
    });

    it("answers another tenant's transcript like an unknown id and leaves its states as they are", async () => {
      const other = await createTestTenant(admin);
      await runInTenant(other, () => seedSystem(runtime));
      const foreign = await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        await put(transcript, "0", FOLLOW);
        return { transcript, stored: await storedStates() };
      });
      expect(foreign.stored).toHaveLength(1);

      await runInTenant(other, async () => {
        const own = await createTranscript();
        // The other tenant's own transcript is followable, so the refusals below are about the foreign id.
        expect(await put(own, "0", FOLLOW)).toEqual({ status: 200, body: { actionItemId: 0, state: "noted" } });
        const unknown = randomUUID();
        // `null` would delete the foreign row and `noted` on item 1 would add one.
        for (const [actionItemId, body] of [
          ["0", OPEN],
          ["1", FOLLOW],
        ] as const) {
          const id = Number(actionItemId);
          expect(await refusal(put(foreign.transcript, actionItemId, body))).toEqual(notFound(foreign.transcript, id));
          expect(await refusal(put(unknown, actionItemId, body))).toEqual(notFound(unknown, id));
        }
        expect((await storedStates()).map((row) => row.transcript_item_id)).toEqual([own]);
      });

      expect(await runInTenant(tenant, () => storedStates())).toEqual(foreign.stored);
    });

    it("answers 404 for an action item id the notes do not have", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();

        expect(await refusal(put(transcript, "2", FOLLOW))).toEqual(notFound(transcript, 2));
        expect(await refusal(put(transcript, "2", OPEN))).toEqual(notFound(transcript, 2));
        // The largest id the column holds is a valid id, so it is looked up rather than rejected.
        expect(await refusal(put(transcript, "2147483647", FOLLOW))).toEqual(notFound(transcript, 2_147_483_647));

        expect(await storedStates()).toEqual([]);
      });
    });

    it("answers 404 for a transcript without meeting notes", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript(null);

        expect(await refusal(put(transcript, "0", FOLLOW))).toEqual(notFound(transcript, 0));

        expect(await storedStates()).toEqual([]);
      });
    });

    it("answers 404 for a transcript in the Trash and leaves its states as they are", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        await put(transcript, "0", FOLLOW);
        const stored = await storedStates();
        await createChokePoint(runtime).softDeleteItem(await databaseId("transcripts"), transcript);

        expect(await refusal(put(transcript, "0", OPEN))).toEqual(notFound(transcript, 0));
        expect(await refusal(put(transcript, "1", FOLLOW))).toEqual(notFound(transcript, 1));

        expect(await storedStates()).toEqual(stored);
      });
    });

    it("answers 404 in a tenant that has no Transcripts database", async () => {
      const unseeded = await createTestTenant(admin);
      await runInTenant(unseeded, async () => {
        const unknown = randomUUID();
        expect(await refusal(put(unknown, "0", FOLLOW))).toEqual(notFound(unknown, 0));
      });
    });

    it("refuses a transcript id that is not a UUID with validation_failed on id", async () => {
      await runInTenant(tenant, async () => {
        expect(await refusal(put("not-a-uuid", "0", FOLLOW))).toEqual({
          status: 400,
          code: "validation_failed",
          details: { field: "id" },
        });
      });
    });

    it.each(["abc", "-1", "1.5", "01", "1e2", " 1", "", "2147483648", "99999999999"])(
      "refuses the action item id %j with validation_failed on actionItemId",
      async (actionItemId) => {
        await runInTenant(tenant, async () => {
          const transcript = await createTranscript();

          expect(await refusal(put(transcript, actionItemId, FOLLOW))).toEqual({
            status: 400,
            code: "validation_failed",
            details: { field: "actionItemId" },
          });

          expect(await storedStates()).toEqual([]);
        });
      },
    );

    it.each([
      ["no body", undefined],
      ["a null body", null],
      ["a body without state", {}],
      ["state added", { state: "added" }],
      ["state dismissed", { state: "dismissed" }],
      ["a numeric state", { state: 1 }],
      ["a bare string", "noted"],
    ])("refuses %s with validation_failed on state", async (_label, body) => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();

        expect(await refusal(put(transcript, "0", body))).toEqual({
          status: 400,
          code: "validation_failed",
          details: { field: "state" },
        });

        expect(await storedStates()).toEqual([]);
      });
    });

    it("refuses to follow or clear an item whose state is added and leaves the row as it is", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        const task = await createChokePoint(runtime).createItem({
          databaseId: await databaseId("tasks"),
          properties: { name: "Send the contract" },
        });
        await withTransaction(runtime, (client) =>
          setActionItemState(client, {
            transcriptId: transcript,
            actionItemId: 0,
            state: "added",
            taskItemId: task.id,
            ownerPersonId: null,
          }),
        );
        const stored = await storedStates();
        expect(stored).toMatchObject([{ action_item_id: 0, state: "added", task_item_id: task.id }]);
        const alreadyAdded = {
          status: 400,
          code: "validation_failed",
          details: { field: "state", reason: "alreadyAdded" },
        };

        expect(await refusal(put(transcript, "0", FOLLOW))).toEqual(alreadyAdded);
        expect(await refusal(put(transcript, "0", OPEN))).toEqual(alreadyAdded);

        expect(await storedStates()).toEqual(stored);
        // The transcript's other item is not affected by the refusal.
        expect(await put(transcript, "1", FOLLOW)).toEqual({ status: 200, body: { actionItemId: 1, state: "noted" } });
      });
    });

    it("refuses a follow that waited behind a transaction storing added for the item", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        const task = await createChokePoint(runtime).createItem({
          databaseId: await databaseId("tasks"),
          properties: { name: "Send the contract" },
        });
        let follow: Promise<unknown> | undefined;
        try {
          await holding(
            (client) =>
              setActionItemState(client, {
                transcriptId: transcript,
                actionItemId: 0,
                state: "added",
                taskItemId: task.id,
                ownerPersonId: null,
              }),
            async (holderPid) => {
              follow = put(transcript, "0", FOLLOW);
              follow.catch(() => {});
              await untilBlockedBy(holderPid);
            },
          );
          if (!follow) throw new Error("The follow was not started");

          expect(await within(refusal(follow), "the waiting follow")).toEqual({
            status: 400,
            code: "validation_failed",
            details: { field: "state", reason: "alreadyAdded" },
          });
        } finally {
          await Promise.allSettled([follow]);
        }

        expect(await storedStates()).toMatchObject([{ action_item_id: 0, state: "added", task_item_id: task.id }]);
      });
    });
  });

  describe("the store", () => {
    it("lists a transcript's states by action item id with their task and owner", async () => {
      await runInTenant(tenant, async () => {
        const [transcript, other] = [await createTranscript(), await createTranscript()];
        const [task, person] = [randomUUID(), randomUUID()];
        const written = await withTransaction(runtime, async (client) => {
          await setActionItemState(client, noted(other, 0));
          await setActionItemState(client, noted(transcript, 1));
          return setActionItemState(client, {
            transcriptId: transcript,
            actionItemId: 0,
            state: "added",
            taskItemId: task,
            ownerPersonId: person,
          });
        });

        const listed = await withTransaction(runtime, (client) => listActionItemStates(client, transcript));

        expect(listed).toEqual([
          { actionItemId: 0, state: "added", taskItemId: task, ownerPersonId: person, updatedAt: written.updatedAt },
          { actionItemId: 1, state: "noted", taskItemId: null, ownerPersonId: null, updatedAt: expect.any(String) },
        ]);
        expect(new Date(written.updatedAt).toISOString()).toBe(written.updatedAt);
      });
    });

    it("returns the stored row from a repeated set without rewriting it", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        const first = await withTransaction(runtime, (client) => setActionItemState(client, noted(transcript, 0)));
        const stored = await storedStates();

        const second = await withTransaction(runtime, (client) => setActionItemState(client, noted(transcript, 0)));

        expect(second).toEqual(first);
        expect(await storedStates()).toEqual(stored);
      });
    });

    it("refuses to set or clear a state of a transcript that has no item row", async () => {
      await runInTenant(tenant, async () => {
        const unknown = randomUUID();
        const missing = { status: 404, code: "not_found", details: { resource: "item", itemId: unknown } };

        expect(
          await refusal(withTransaction(runtime, (client) => setActionItemState(client, noted(unknown, 0)))),
        ).toEqual(missing);
        expect(await refusal(withTransaction(runtime, (client) => clearActionItemState(client, unknown, 0)))).toEqual(
          missing,
        );

        expect(await storedStates()).toEqual([]);
      });
    });

    it("refuses to set a state in a tenant that has no Transcripts database", async () => {
      const unseeded = await createTestTenant(admin);
      await runInTenant(unseeded, async () => {
        const unknown = randomUUID();

        expect(
          await refusal(withTransaction(runtime, (client) => setActionItemState(client, noted(unknown, 0)))),
        ).toEqual({ status: 404, code: "not_found", details: { resource: "item", itemId: unknown } });

        expect(await storedStates()).toEqual([]);
      });
    });

    it("clears exactly the named state", async () => {
      await runInTenant(tenant, async () => {
        const [transcript, other] = [await createTranscript(), await createTranscript()];
        await withTransaction(runtime, async (client) => {
          await setActionItemState(client, noted(transcript, 0));
          await setActionItemState(client, noted(transcript, 1));
          await setActionItemState(client, noted(other, 0));
        });

        await withTransaction(runtime, (client) => clearActionItemState(client, transcript, 0));

        expect((await storedStates()).map((row) => [row.transcript_item_id, row.action_item_id])).toEqual(
          [
            [transcript, 1],
            [other, 0],
          ].sort(),
        );
      });
    });

    it("throws when it is asked to clear an item that has no state", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        await withTransaction(runtime, (client) => setActionItemState(client, noted(transcript, 1)));
        const stored = await storedStates();

        await expect(withTransaction(runtime, (client) => clearActionItemState(client, transcript, 0))).rejects.toThrow(
          /to affect at least one row, got 0/,
        );

        expect(await storedStates()).toEqual(stored);
      });
    });

    it("makes a writer of the same transcript wait for an open writer, and no writer of another transcript", async () => {
      await runInTenant(tenant, async () => {
        const [transcript, other] = [await createTranscript(), await createTranscript()];
        let waiting: Promise<unknown> | undefined;
        try {
          await holding(
            (client) => setActionItemState(client, noted(transcript, 0)),
            async (holderPid) => {
              // Another transcript's row lock is free, so its writer commits while the holder is open.
              await within(
                withTransaction(runtime, (client) => setActionItemState(client, noted(other, 0))),
                "the write to another transcript",
              );
              // Another action item of the held transcript: no row of the table conflicts, only the transcript lock.
              waiting = withTransaction(runtime, (client) => setActionItemState(client, noted(transcript, 1)));
              waiting.catch(() => {});
              await untilBlockedBy(holderPid);
              expect((await storedStates()).map((row) => row.transcript_item_id)).toEqual([other]);
            },
          );
          if (!waiting) throw new Error("The waiting write was not started");
          await within(waiting, "the waiting write");
        } finally {
          await Promise.allSettled([waiting]);
        }

        expect((await storedStates()).filter((row) => row.transcript_item_id === transcript)).toMatchObject([
          { action_item_id: 0, state: "noted" },
          { action_item_id: 1, state: "noted" },
        ]);
      });
    });
  });

  describe("a writer racing the permanent purge", () => {
    it("is refused once the purge it waited for has removed the transcript, and leaves no state behind", async () => {
      await runInTenant(tenant, async () => {
        const transcript = await createTranscript();
        const transcripts = await databaseId("transcripts");
        await withTransaction(runtime, (client) => setActionItemState(client, noted(transcript, 0)));
        await createChokePoint(runtime).softDeleteItem(transcripts, transcript);
        let waiting: Promise<unknown> | undefined;
        try {
          await holding(
            // What `purgeExpiredTrashSubtree` runs for one row, held open before its commit.
            async (client) => {
              const row = await getItemById(client, transcripts, transcript);
              if (!row) throw new Error("Missing transcript");
              expect(await hardDeleteItem(client, transcripts, transcript)).toBe(true);
              await deleteItemDependents(client, row);
            },
            async (holderPid) => {
              waiting = withTransaction(runtime, (client) => setActionItemState(client, noted(transcript, 1)));
              waiting.catch(() => {});
              await untilBlockedBy(holderPid);
            },
          );
          if (!waiting) throw new Error("The waiting write was not started");

          expect(await within(refusal(waiting), "the waiting write")).toEqual({
            status: 404,
            code: "not_found",
            details: { resource: "item", itemId: transcript },
          });
        } finally {
          await Promise.allSettled([waiting]);
        }

        expect(await storedStates()).toEqual([]);
      });
    });
  });

  describe("tenant isolation and grants", () => {
    it("hides a tenant's states from another tenant on the runtime role", async () => {
      const other = await createTestTenant(admin);
      const transcript = await runInTenant(tenant, async () => {
        const id = await createTranscript();
        await put(id, "0", FOLLOW);
        return id;
      });
      const stored = await runInTenant(tenant, () => storedStates());
      expect(stored).toHaveLength(1);

      await runInTenant(other, async () => {
        expect(await withTransaction(runtime, (client) => listActionItemStates(client, transcript))).toEqual([]);
        // None of the statements below names a tenant: row-level security alone confines them.
        expect(await storedStates()).toEqual([]);
        const update = await runtime.query("UPDATE transcript_action_item_states SET state = 'dismissed'");
        expect(update.rowCount).toBe(0);
        const remove = await runtime.query("DELETE FROM transcript_action_item_states");
        expect(remove.rowCount).toBe(0);
        await expect(
          runtime.query(
            `INSERT INTO transcript_action_item_states (tenant_id, transcript_item_id, action_item_id, state)
             VALUES ($1, $2, 1, 'noted')`,
            [tenant, transcript],
          ),
        ).rejects.toMatchObject({ code: "42501" });
      });

      expect(await runInTenant(tenant, () => storedStates())).toEqual(stored);
    });

    it("lets semprec_side read the states and refuses its writes", async () => {
      const side = await createRuntimeRolePool(admin, "semprec_side");
      try {
        await runInTenant(tenant, async () => {
          const transcript = await createTranscript();
          await put(transcript, "0", FOLLOW);
          const stored = await storedStates();

          expect(await storedStates(side)).toEqual(stored);
          // The role's missing privilege, not row-level security: both would raise SQLSTATE 42501.
          const denied = /permission denied for table transcript_action_item_states/;
          await expect(
            side.query(
              "INSERT INTO transcript_action_item_states (transcript_item_id, action_item_id, state) VALUES ($1, 1, 'noted')",
              [transcript],
            ),
          ).rejects.toThrow(denied);
          await expect(side.query("UPDATE transcript_action_item_states SET state = 'dismissed'")).rejects.toThrow(
            denied,
          );
          await expect(side.query("DELETE FROM transcript_action_item_states")).rejects.toThrow(denied);

          expect(await storedStates()).toEqual(stored);
        });
      } finally {
        await side.end();
      }
    });
  });

  describe("permanent purge", () => {
    it("deletes the states of a purged transcript and keeps another transcript's", async () => {
      await runInTenant(tenant, async () => {
        const [purged, kept] = [await createTranscript(), await createTranscript()];
        await put(purged, "0", FOLLOW);
        await put(purged, "1", FOLLOW);
        await put(kept, "0", FOLLOW);
        const transcripts = await databaseId("transcripts");
        await createChokePoint(runtime).softDeleteItem(transcripts, purged);
        // Raw SQL because the choke point stamps `deleted_at = now()` and cannot trash an item in the past.
        const aged = await runtime.query(
          "UPDATE items SET deleted_at = now() - interval '31 days' WHERE database_id = $1 AND id = $2",
          [transcripts, purged],
        );
        expect(aged.rowCount).toBe(1);
        // The purge deletes no bytes here: the transcripts have no blob.
        const storage: BlobStorageWriter = {
          writeStream: () => Promise.reject(new Error("not used by the purge")),
          readStream: () => {
            throw new Error("not used by the purge");
          },
          delete: () => Promise.reject(new Error("no blob is expected to be deleted")),
        };

        expect(await purgeExpiredTrash(runtime, storage)).toBe(1);

        expect(await storedStates()).toMatchObject([{ transcript_item_id: kept, action_item_id: 0, state: "noted" }]);
        expect(await storedStates()).toHaveLength(1);
        const items = await runtime.query<{ id: string }>("SELECT id FROM items WHERE id = ANY($1::uuid[])", [
          [purged, kept],
        ]);
        expect(items.rows).toEqual([{ id: kept }]);
      });
    });
  });
});
