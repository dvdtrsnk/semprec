import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import "../../domainWriteHooks.js";
import { getTenantZeroId, getTestPool, inTenantZero, resetDatabase } from "../../testSupport/testDb.js";
import { createViewTypeRegistry } from "../../chokePoint/viewTypeRegistry.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { withTransaction } from "../../db/pool.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { ConflictError, ValidationError } from "../../errors.js";
import { appendHistoryEntry } from "../../inbox/proposalHistory.js";
import { reviseProposalWithClient } from "../../inbox/proposalActions.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";
import { matchTranscriptToEvent } from "../transcriptEventMatch.js";
import {
  enqueueTranscriptCardRecompute,
  transcriptCardRecomputeJobKey,
  transcriptCardRecomputePayloadSchema,
} from "../transcriptCardRecompute.js";

let pool: Pool;

async function databaseIdFor(moduleId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [moduleId]);
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

const jobRowSchema = z.object({
  key: z.string(),
  task_identifier: z.string(),
  queue_name: z.string().nullable(),
  max_attempts: z.number(),
});

const historyRowSchema = z.array(
  z.looseObject({ id: z.string().optional(), author: z.string(), message: z.string(), kind: z.string().optional() }),
);

/** Message-only revise enqueues the instruction's recompute job in its own transaction (issue gh-1940). */
describe("enqueueing the recompute of a transcript card (issue gh-1940)", () => {
  let proposalsId: string;
  let transcriptsId: string;
  let eventsId: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());
    proposalsId = await databaseIdFor("processingProposals");
    transcriptsId = await databaseIdFor("transcripts");
    eventsId = await databaseIdFor("events");
  });

  afterAll(async () => {
    await pool?.end();
  });

  /** A `kind = 'transcript'` card as the match step emits it when no Event overlaps the recording: a new-meeting proposal. */
  async function createTranscriptCard(): Promise<string> {
    const transcript = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: transcriptsId, properties: { name: "Weekly sync", date: "2024-03-01T12:00:00.000Z" } },
        { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      ),
    );
    await withTransaction(pool, (client) =>
      matchTranscriptToEvent(client, { transcriptId: transcript.id, durationSeconds: 3600 }),
    );
    const { rows } = await pool.query<{ id: string }>(
      "SELECT id FROM items WHERE database_id = $1 AND properties ->> 'kind' = 'transcript'",
      [proposalsId],
    );
    if (rows.length !== 1 || !rows[0]) throw new Error(`Expected one transcript card, found ${rows.length}`);
    return rows[0].id;
  }

  function reviseWith(cardId: string, input: Parameters<typeof reviseProposalWithClient>[3]) {
    return inTenantZero(() =>
      withTransaction(pool, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: proposalsId }, cardId, input),
      ),
    );
  }

  async function jobs() {
    const { rows } = await pool.query(
      `SELECT key, task_identifier, queue_name, max_attempts FROM graphile_worker.jobs
        WHERE task_identifier = 'transcriptCardRecompute' ORDER BY key`,
    );
    return z.array(jobRowSchema).parse(rows);
  }

  async function history(cardId: string) {
    const { rows } = await pool.query<{ history: unknown }>(
      "SELECT properties -> 'history' AS history FROM items WHERE id = $1",
      [cardId],
    );
    return historyRowSchema.parse(rows[0]?.history ?? []);
  }

  it("gives the instruction an id and enqueues one job for it, under the tenant's lane", async () => {
    const cardId = await createTranscriptCard();

    await reviseWith(cardId, { message: "it is the accountant call" });

    const entries = await history(cardId);
    const instruction = entries.at(-1);
    expect(instruction).toMatchObject({ author: "user", message: "it is the accountant call" });
    const instructionEntryId = z.uuid().parse(instruction?.id);
    // The payload `{ proposalId, instructionEntryId }` and the tenant stamp are proven by running the job in the worker's test.
    expect(await jobs()).toEqual([
      {
        key: `transcript-card-recompute:${cardId}:${instructionEntryId}`,
        task_identifier: "transcriptCardRecompute",
        queue_name: `transcript-card-recompute:${getTenantZeroId()}`,
        max_attempts: 3,
      },
    ]);
  });

  it("enqueues one job for each instruction", async () => {
    const cardId = await createTranscriptCard();

    await reviseWith(cardId, { message: "it is the accountant call" });
    await reviseWith(cardId, { message: "no, the sprint planning" });

    const ids = (await history(cardId)).flatMap((entry) => (entry.id ? [entry.id] : []));
    expect(ids).toHaveLength(2);
    expect((await jobs()).map((job) => job.key).sort()).toEqual(
      ids.map((id) => `transcript-card-recompute:${cardId}:${id}`).sort(),
    );
  });

  it("enqueues nothing for a revise that carries an envelope, and its entry has no id", async () => {
    const cardId = await createTranscriptCard();

    await reviseWith(cardId, {
      message: "Revised by user.",
      entityKind: "database",
      target: eventsId,
      properties: { name: "Weekly sync", type: "meeting", date: "2024-03-01", timeFrom: "13:00", timeTo: "14:00" },
    });

    expect(await jobs()).toEqual([]);
    expect((await history(cardId)).every((entry) => entry.id === undefined)).toBe(true);
  });

  it.each(["confirmed", "rejected"])("refuses an instruction to a %s card and enqueues nothing", async (status) => {
    const cardId = await createTranscriptCard();
    // The decision's own writer is not under test: the locked status is what the instruction meets.
    await withTransaction(pool, (client) =>
      updateItemWithClient(
        client,
        { databaseId: proposalsId, itemId: cardId, propertiesPatch: { status } },
        { allowedSystemKeys: ["status"] },
      ),
    );

    await expect(reviseWith(cardId, { message: "it is the accountant call" })).rejects.toBeInstanceOf(ValidationError);

    expect(await jobs()).toEqual([]);
    expect((await history(cardId)).filter((entry) => entry.author === "user")).toEqual([]);
  });

  it("refuses a message to a card of another kind and enqueues nothing", async () => {
    const inboxCard = await withTransaction(pool, (client) =>
      createItemWithClient(
        client,
        { databaseId: proposalsId, properties: { kind: "inbox", status: "proposed" } },
        { allowedSystemKeys: ["kind", "status"] },
      ),
    );

    await expect(reviseWith(inboxCard.id, { message: "fix it" })).rejects.toMatchObject({
      details: { field: "message" },
    });

    expect(await jobs()).toEqual([]);
  });

  it("enqueues nothing, and records nothing, when the card changed since the caller read it", async () => {
    const cardId = await createTranscriptCard();

    await expect(
      reviseWith(cardId, { message: "it is the accountant call", ifVersion: "2000-01-01T00:00:00.000000Z" }),
    ).rejects.toBeInstanceOf(ConflictError);

    expect(await jobs()).toEqual([]);
    expect((await history(cardId)).filter((entry) => entry.author === "user")).toEqual([]);
  });

  it("converges two enqueues of the same instruction onto one job", async () => {
    const cardId = await createTranscriptCard();
    const instructionEntryId = randomUUID();

    await runInTenant(getTenantZeroId(), async () => {
      await withTransaction(pool, (client) =>
        enqueueTranscriptCardRecompute(client, { proposalId: cardId, instructionEntryId }),
      );
      await withTransaction(pool, (client) =>
        enqueueTranscriptCardRecompute(client, { proposalId: cardId, instructionEntryId }),
      );
    });

    expect((await jobs()).map((job) => job.key)).toEqual([
      transcriptCardRecomputeJobKey({ proposalId: cardId, instructionEntryId }),
    ]);
  });

  it("keeps the instruction's id and the answer's reference to it through later history writes", async () => {
    const instructionEntryId = randomUUID();
    const first = appendHistoryEntry([], "it is the accountant call", "user", { id: instructionEntryId });
    const second = appendHistoryEntry(first, "Chose the accountant call.", "ai", {
      kind: "threadRevision",
      instructionEntryId,
    });

    const third = appendHistoryEntry(second, "Confirmed by user.", "user");

    expect(third).toMatchObject([
      { id: instructionEntryId, author: "user" },
      { kind: "threadRevision", instructionEntryId },
      { message: "Confirmed by user." },
    ]);
  });

  it("accepts a job payload of two uuids only", () => {
    const ids = { proposalId: randomUUID(), instructionEntryId: randomUUID() };

    expect(transcriptCardRecomputePayloadSchema.parse(ids)).toEqual(ids);
    expect(transcriptCardRecomputePayloadSchema.safeParse({ ...ids, instructionEntryId: "entry-1" }).success).toBe(
      false,
    );
    expect(transcriptCardRecomputePayloadSchema.safeParse({ proposalId: ids.proposalId }).success).toBe(false);
  });
});
