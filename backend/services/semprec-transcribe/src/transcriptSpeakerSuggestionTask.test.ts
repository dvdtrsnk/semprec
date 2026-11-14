import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, ensureQueueSchema, grantQueueSchemaPrivileges, registerTask, runOnce } from "@semprec/queue";
import { runInTenant } from "@semprec/shared";
import type { AiGatewayClientPort, AiGatewayCompletionInput, AiGatewayCompletionResult } from "@semprec/shared";
import { AiGatewayFailedError } from "@semprec/shared";
import {
  createChokePoint,
  createItemWithClient,
  createRelationWithClient,
  ensureItemAutomation,
  getItemAutomation,
  itemDeleteWithClient,
  createActionQueueAffinity,
  matchTranscriptToEvent,
  proposeSpeakerMappings,
  seedSystem,
  TRANSCRIPTION_OWNER_PROCESS,
  transcriptionSourceLink,
  withTransaction,
  writeComputed,
} from "@semprec/data";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createTranscriptSpeakerSuggestionTask } from "./transcriptSpeakerSuggestionTask.js";

/** Captures the service's log output, as `transcriptionTask.test.ts` does, to prove the task logs no recording text. */
const observedLogs = vi.hoisted(() => ({
  chunks: [] as string[],
  restores: [] as Array<() => void>,
  streams: new WeakSet<object>(),
  level: process.env.LOG_LEVEL,
}));
vi.mock("@semprec/shared", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/shared")>();
  process.env.LOG_LEVEL = "info";
  return {
    ...actual,
    createLogger(name: string) {
      const logger = actual.createLogger(name);
      const symbol = Reflect.ownKeys(logger).find(
        (key) => typeof key === "symbol" && key.description === "pino.stream",
      );
      if (typeof symbol !== "symbol") throw new Error("Pino logger destination is unavailable");
      const stream: unknown = Reflect.get(logger, symbol);
      if (typeof stream !== "object" || stream === null) throw new Error("Invalid Pino logger destination");
      if (!observedLogs.streams.has(stream)) {
        const original: unknown = Reflect.get(stream, "write");
        if (typeof original !== "function") throw new Error("Invalid Pino destination writer");
        const descriptor = Object.getOwnPropertyDescriptor(stream, "write");
        if (
          !Reflect.set(stream, "write", function (this: unknown, ...args: unknown[]) {
            if (typeof args[0] === "string") observedLogs.chunks.push(args[0]);
            return Reflect.apply(original, this, args);
          })
        )
          throw new Error("Cannot observe Pino destination");
        observedLogs.streams.add(stream);
        observedLogs.restores.push(() => {
          if (descriptor) Object.defineProperty(stream, "write", descriptor);
          else Reflect.deleteProperty(stream, "write");
        });
      }
      return logger;
    },
  };
});
afterAll(() => {
  for (const restore of observedLogs.restores.reverse()) restore();
  if (observedLogs.level === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = observedLogs.level;
});

const RECORDING_START = "2024-03-01T12:00:00.000Z";
const SEGMENTS = [
  { speaker: "SPEAKER_00", text: "Thanks for coming, Bob. Zebediah sends greetings.", startsAt: 0, endsAt: 2 },
  { speaker: "SPEAKER_01", text: "Happy to be here, Alice.", startsAt: 2, endsAt: 4 },
];

type SpeakerMapping = { speaker: string; personId: string | null; reason: string };

/** A fake `AiGatewayClientPort`: answers every speaker-suggestion request with `mappings` and counts the calls. */
class FakeSpeakerGateway implements AiGatewayClientPort {
  calls: AiGatewayCompletionInput[] = [];
  mappings: SpeakerMapping[] = [];
  failure: Error | null = null;

  async complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult> {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    return { content: { mappings: this.mappings }, usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

const cardSchema = z.looseObject({
  status: z.string(),
  proposal: z.looseObject({ entityKind: z.string(), target: z.string() }).nullable(),
  aiVersion: z.number(),
  context: z.looseObject({
    role: z.literal("speaker"),
    speaker: z.string(),
    alternatives: z.array(z.looseObject({ personId: z.string() })),
  }),
  history: z.array(z.looseObject({ author: z.string(), kind: z.string().optional() })).default([]),
});
type Card = z.infer<typeof cardSchema>;

let adminPool: Pool;
let dataPool: Pool;
let tenant: string;
let gateway: FakeSpeakerGateway;

const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenant, fn);

async function databaseId(moduleId: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    "SELECT id FROM databases WHERE owner_module_id = $1 AND system AND tenant_id = $2",
    [moduleId, tenant],
  );
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

function createIn(moduleId: string, properties: Record<string, unknown>): Promise<string> {
  return inTenant(async () => {
    const item = await withTransaction(dataPool, async (client) =>
      createItemWithClient(client, { databaseId: await databaseId(moduleId), properties }),
    );
    return item.id;
  });
}

async function propertyId(moduleId: string, key: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
    [await databaseId(moduleId), key],
  );
  if (!rows[0]) throw new Error(`Property '${key}' was not seeded`);
  return rows[0].id;
}

function link(moduleId: string, key: string, callerItemId: string, targetItemId: string) {
  return inTenant(async () => {
    const relationPropertyId = await propertyId(moduleId, key);
    await withTransaction(dataPool, (client) =>
      createRelationWithClient(client, { relationPropertyId, callerItemId, targetItemId }),
    );
  });
}

interface Recording {
  transcriptId: string;
  fileItemId: string;
}

/** A finished transcript with two speakers, its source Files item and its `item_automation` row, as the pipeline leaves them. */
function createRecording(options: { status?: "done" | "processing"; segments?: boolean } = {}): Promise<Recording> {
  return inTenant(async () => {
    const fileItemId = await createIn("files", { name: "recording.m4a" });
    const transcriptsId = await databaseId("transcripts");
    const transcriptId = await withTransaction(dataPool, async (client) => {
      const item = await createItemWithClient(
        client,
        {
          databaseId: transcriptsId,
          properties: {
            name: "Weekly sync",
            status: options.status ?? "done",
            link: transcriptionSourceLink(fileItemId),
            date: RECORDING_START,
          },
        },
        { allowedSystemKeys: ["status", "link", "date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      if (options.segments !== false) await writeComputed(client, transcriptsId, item.id, "segments", SEGMENTS);
      await ensureItemAutomation(client, item.id);
      return item.id;
    });
    return { transcriptId, fileItemId };
  });
}

function runTask(transcriptId: string): Promise<void> {
  return inTenant(() => createTranscriptSpeakerSuggestionTask(dataPool, gateway)({ transcriptId }));
}

/**
 * Runs the queued jobs with the task registered, as the runner of `semprec-transcribe` does. Jobs of a tenant share one
 * lane, so one `runOnce` takes one of them; it is repeated until no job is left, at most once per job expected.
 */
async function drainQueue(): Promise<void> {
  const taskList = {
    [CORE_TASK_NAMES.TRANSCRIPT_SPEAKER_SUGGESTION]: registerTask(
      CORE_TASK_NAMES.TRANSCRIPT_SPEAKER_SUGGESTION,
      createTranscriptSpeakerSuggestionTask(dataPool, gateway),
    ),
  };
  for (let round = 0; round < 5 && (await speakerJobKeys()).length > 0; round++)
    await runOnce({ pgPool: dataPool, taskList });
  expect(await speakerJobKeys()).toEqual([]);
}

async function speakerJobKeys(): Promise<string[]> {
  const { rows } = await adminPool.query<{ key: string }>(
    "SELECT key FROM graphile_worker.jobs WHERE task_identifier = 'transcriptSpeakerSuggestion' ORDER BY key",
  );
  return rows.map((row) => row.key);
}

async function cardsOf(transcriptId: string): Promise<Map<string, Card & { id: string }>> {
  return inTenant(async () => {
    const { rows } = await dataPool.query<{ id: string; properties: unknown }>(
      `SELECT i.id, i.properties FROM items i
         JOIN item_relations r ON (r.item_a = i.id AND r.item_b = $2) OR (r.item_b = i.id AND r.item_a = $2)
        WHERE i.database_id = $1 AND i.properties ->> 'kind' = 'transcript'`,
      [await databaseId("processingProposals"), transcriptId],
    );
    return new Map(
      rows.map((row) => {
        const card = cardSchema.parse(row.properties);
        return [card.context.speaker, { ...card, id: row.id }];
      }),
    );
  });
}

async function checkpointOf(fileItemId: string): Promise<unknown> {
  const { rows } = await adminPool.query<{ checkpoint: unknown }>(
    "SELECT computed -> 'suggestSpeakers' AS checkpoint FROM items WHERE id = $1",
    [fileItemId],
  );
  return rows[0]?.checkpoint ?? null;
}

async function automationAttempts(transcriptId: string): Promise<number | undefined> {
  return inTenant(
    async () => (await withTransaction(dataPool, (client) => getItemAutomation(client, transcriptId)))?.attempts,
  );
}

beforeAll(async () => {
  adminPool = getTestPool();
  dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  await ensureQueueSchema(adminPool);
  await grantQueueSchemaPrivileges(adminPool);
});

beforeEach(async () => {
  await resetDatabase(adminPool);
  tenant = await createTestTenant(adminPool);
  await runInTenant(tenant, () => seedSystem(dataPool));
  gateway = new FakeSpeakerGateway();
  observedLogs.chunks.length = 0;
});

afterAll(async () => {
  await dataPool?.end();
  await adminPool?.end();
});

describe("transcriptSpeakerSuggestion task (issue gh-1942)", () => {
  /** The pipeline already ran: it asked nothing (no Event) and left a clarification card for each speaker. */
  async function finishedRecordingWithoutEvent() {
    const recording = await createRecording();
    await runTask(recording.transcriptId);
    expect(gateway.calls).toHaveLength(0);
    return recording;
  }

  async function eventWithParticipants(...names: string[]) {
    const eventId = await createIn("events", { name: "Weekly sync", date: "2024-03-01" });
    const people: string[] = [];
    for (const name of names) {
      const personId = await createIn("people", { name });
      await link("events", "people", eventId, personId);
      people.push(personId);
    }
    return { eventId, people };
  }

  it("suggests the speakers of a finished transcript linked to an Event afterwards, once, without touching its automation", async () => {
    const recording = await finishedRecordingWithoutEvent();
    const attempts = await automationAttempts(recording.transcriptId);
    const before = await cardsOf(recording.transcriptId);
    expect([...before.values()].map((card) => card.status)).toEqual(["needsClarification", "needsClarification"]);
    expect(await checkpointOf(recording.fileItemId)).toEqual({
      proposedSpeakers: ["SPEAKER_00", "SPEAKER_01"],
      eventId: null,
      candidateIds: [],
    });
    const { eventId, people } = await eventWithParticipants("Alice", "Bob");
    const [aliceId, bobId] = people;
    if (!aliceId || !bobId) throw new Error("Missing participants");
    await link("transcripts", "event", recording.transcriptId, eventId);
    expect(await speakerJobKeys()).toEqual([`transcript-speaker-suggestion:${recording.transcriptId}`]);
    gateway.mappings = [
      { speaker: "SPEAKER_00", personId: aliceId, reason: "Is greeted as Alice." },
      { speaker: "SPEAKER_01", personId: null, reason: "Unclear." },
    ];

    await drainQueue();

    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0]).toMatchObject({ projectItemId: null, operation: "transcript_speaker_suggestion" });
    const cards = await cardsOf(recording.transcriptId);
    expect(cards.size).toBe(2);
    expect(cards.get("SPEAKER_00")).toMatchObject({
      status: "proposed",
      proposal: { entityKind: "relation", target: aliceId },
      aiVersion: 2,
      id: before.get("SPEAKER_00")?.id,
    });
    expect(cards.get("SPEAKER_00")?.history.at(-1)).toMatchObject({ author: "ai", kind: "recompute" });
    expect(cards.get("SPEAKER_01")).toMatchObject({ status: "needsClarification", proposal: null });
    expect(
      cards
        .get("SPEAKER_01")
        ?.context.alternatives.map((alternative) => alternative.personId)
        .sort(),
    ).toEqual([aliceId, bobId].sort());
    expect(await checkpointOf(recording.fileItemId)).toEqual({
      proposedSpeakers: ["SPEAKER_00", "SPEAKER_01"],
      eventId,
      candidateIds: [aliceId, bobId].sort(),
    });
    expect(await automationAttempts(recording.transcriptId)).toBe(attempts);
  });

  it("asks again about the still unmapped speakers when a participant is added", async () => {
    const recording = await finishedRecordingWithoutEvent();
    const { eventId, people } = await eventWithParticipants("Alice");
    await link("transcripts", "event", recording.transcriptId, eventId);
    await drainQueue();
    expect(gateway.calls).toHaveLength(1);
    const carolId = await createIn("people", { name: "Carol" });
    await link("events", "people", eventId, carolId);
    expect(await speakerJobKeys()).toEqual([`transcript-speaker-suggestion:${recording.transcriptId}`]);
    gateway.mappings = [{ speaker: "SPEAKER_01", personId: carolId, reason: "Introduced as Carol." }];

    await drainQueue();

    expect(gateway.calls).toHaveLength(2);
    expect(JSON.stringify(gateway.calls[1]?.messages)).toContain(carolId);
    expect(JSON.stringify(gateway.calls[1]?.messages)).toContain("SPEAKER_01");
    expect((await cardsOf(recording.transcriptId)).get("SPEAKER_01")).toMatchObject({
      status: "proposed",
      proposal: { target: carolId },
    });
    expect(await checkpointOf(recording.fileItemId)).toMatchObject({
      eventId,
      candidateIds: [people[0], carolId].sort(),
    });
  });

  it("asks again when a participant is removed, and not when nothing changed", async () => {
    const recording = await finishedRecordingWithoutEvent();
    const { eventId, people } = await eventWithParticipants("Alice", "Bob");
    await link("transcripts", "event", recording.transcriptId, eventId);
    await drainQueue();
    expect(gateway.calls).toHaveLength(1);

    // The same Event and candidates: no second paid call, however often the job runs.
    await runTask(recording.transcriptId);
    await runTask(recording.transcriptId);
    expect(gateway.calls).toHaveLength(1);

    const removedId = people[1];
    if (!removedId) throw new Error("Missing participant");
    await inTenant(async () =>
      createChokePoint(dataPool).deleteRelation({
        relationPropertyId: await propertyId("events", "people"),
        callerItemId: eventId,
        targetItemId: removedId,
      }),
    );
    expect(await speakerJobKeys()).toEqual([`transcript-speaker-suggestion:${recording.transcriptId}`]);
    await drainQueue();

    expect(gateway.calls).toHaveLength(2);
    expect(JSON.stringify(gateway.calls[1]?.messages)).not.toContain(people[1]);
  });

  it("handles two transcripts that share the Event", async () => {
    const first = await createRecording();
    const second = await createRecording();
    const { eventId } = await eventWithParticipants("Alice");
    await link("transcripts", "event", first.transcriptId, eventId);
    await link("transcripts", "event", second.transcriptId, eventId);
    await drainQueue();
    expect(gateway.calls).toHaveLength(2);

    const bobId = await createIn("people", { name: "Bob" });
    await link("events", "people", eventId, bobId);

    expect(await speakerJobKeys()).toEqual(
      [first.transcriptId, second.transcriptId].map((id) => `transcript-speaker-suggestion:${id}`).sort(),
    );
    await drainQueue();
    expect(gateway.calls).toHaveLength(4);
    for (const recording of [first, second]) {
      expect(await checkpointOf(recording.fileItemId)).toMatchObject({ eventId });
      expect((await cardsOf(recording.transcriptId)).size).toBe(2);
    }
  });

  it("counts an old checkpoint without the binding as different and writes the binding", async () => {
    const recording = await createRecording();
    const { eventId, people } = await eventWithParticipants("Alice");
    await link("transcripts", "event", recording.transcriptId, eventId);
    await inTenant(async () =>
      withTransaction(dataPool, async (client) =>
        writeComputed(client, await databaseId("files"), recording.fileItemId, "suggestSpeakers", {
          proposedSpeakers: ["SPEAKER_00"],
        }),
      ),
    );

    await runTask(recording.transcriptId);

    expect(gateway.calls).toHaveLength(1);
    expect(await checkpointOf(recording.fileItemId)).toEqual({
      proposedSpeakers: ["SPEAKER_00", "SPEAKER_01"],
      eventId,
      candidateIds: [people[0]],
    });
  });

  it("does nothing for a transcript without segments, and a later run with them asks as usual", async () => {
    const recording = await createRecording({ status: "processing", segments: false });
    const { eventId, people } = await eventWithParticipants("Alice");
    await link("transcripts", "event", recording.transcriptId, eventId);

    await drainQueue();

    expect(gateway.calls).toHaveLength(0);
    expect(await checkpointOf(recording.fileItemId)).toBeNull();
    expect((await cardsOf(recording.transcriptId)).size).toBe(0);

    // The pipeline's diarization writes the segments later: the run that follows asks as usual.
    await inTenant(async () =>
      withTransaction(dataPool, async (client) =>
        writeComputed(client, await databaseId("transcripts"), recording.transcriptId, "segments", SEGMENTS),
      ),
    );
    gateway.mappings = [{ speaker: "SPEAKER_00", personId: people[0] ?? "", reason: "Greets the group." }];
    await runTask(recording.transcriptId);

    expect(gateway.calls).toHaveLength(1);
    expect(await checkpointOf(recording.fileItemId)).toEqual({
      proposedSpeakers: ["SPEAKER_00", "SPEAKER_01"],
      eventId,
      candidateIds: [people[0]],
    });
    expect((await cardsOf(recording.transcriptId)).get("SPEAKER_00")).toMatchObject({
      status: "proposed",
      proposal: { target: people[0] },
    });
  });

  it("does nothing when every speaker is mapped already", async () => {
    const recording = await createRecording();
    const { eventId, people } = await eventWithParticipants("Alice", "Bob");
    await link("transcripts", "event", recording.transcriptId, eventId);
    await inTenant(async () => {
      const relationPropertyId = await propertyId("transcripts", "speakers");
      for (const [index, speaker] of ["SPEAKER_00", "SPEAKER_01"].entries()) {
        await withTransaction(dataPool, (client) =>
          createRelationWithClient(client, {
            relationPropertyId,
            callerItemId: recording.transcriptId,
            targetItemId: people[index] ?? "",
            metadata: { speaker },
          }),
        );
      }
    });

    await runTask(recording.transcriptId);

    expect(gateway.calls).toHaveLength(0);
    expect(await checkpointOf(recording.fileItemId)).toBeNull();
  });

  it("does nothing for a transcript a user locked, one in the Trash and one that does not exist", async () => {
    const locked = await createRecording();
    const trashed = await createRecording();
    const { eventId } = await eventWithParticipants("Alice");
    await link("transcripts", "event", locked.transcriptId, eventId);
    await link("transcripts", "event", trashed.transcriptId, eventId);
    // The user's lock: its own route is not exported to this service's tests.
    await adminPool.query("UPDATE item_automation SET status = 'locked' WHERE item_id = $1", [locked.transcriptId]);
    await inTenant(async () =>
      withTransaction(dataPool, async (client) =>
        itemDeleteWithClient(client, await databaseId("transcripts"), trashed.transcriptId, {
          queueAffinity: createActionQueueAffinity(),
        }),
      ),
    );

    await runTask(locked.transcriptId);
    await runTask(trashed.transcriptId);
    await runTask(randomUUID());

    expect(gateway.calls).toHaveLength(0);
    expect(await checkpointOf(locked.fileItemId)).toBeNull();
    expect(await checkpointOf(trashed.fileItemId)).toBeNull();
  });

  it("does nothing for a transcript whose source Files item is gone", async () => {
    const recording = await createRecording();
    const { eventId } = await eventWithParticipants("Alice");
    await link("transcripts", "event", recording.transcriptId, eventId);
    await inTenant(async () =>
      withTransaction(dataPool, async (client) =>
        itemDeleteWithClient(client, await databaseId("files"), recording.fileItemId, {
          queueAffinity: createActionQueueAffinity(),
        }),
      ),
    );

    await runTask(recording.transcriptId);

    expect(gateway.calls).toHaveLength(0);
  });

  it("fails the attempt with a code only, a budget refusal included, and leaves no card or checkpoint", async () => {
    const recording = await createRecording();
    const { eventId } = await eventWithParticipants("Alice");
    await link("transcripts", "event", recording.transcriptId, eventId);

    gateway.failure = new AiGatewayFailedError("budget_exceeded");
    await expect(runTask(recording.transcriptId)).rejects.toMatchObject({
      name: "TranscriptSpeakerSuggestionError",
      message: "Transcript speaker suggestion failed",
      code: "budgetExceeded",
    });
    gateway.failure = new AiGatewayFailedError("http");
    await expect(runTask(recording.transcriptId)).rejects.toMatchObject({
      name: "TranscriptSpeakerSuggestionError",
      message: "Transcript speaker suggestion failed",
      code: "providerFailed",
    });
    gateway.failure = new Error("Zebediah leaked into an error");
    await expect(runTask(recording.transcriptId)).rejects.toMatchObject({ code: "unknown" });

    expect(await checkpointOf(recording.fileItemId)).toBeNull();
    expect((await cardsOf(recording.transcriptId)).size).toBe(0);
    expect(observedLogs.chunks.join("")).not.toContain("Zebediah");
  });

  it("logs ids and an outcome, never the recording", async () => {
    const recording = await createRecording();
    const { eventId } = await eventWithParticipants("Alice");
    await link("transcripts", "event", recording.transcriptId, eventId);

    await runTask(recording.transcriptId);

    const logged = observedLogs.chunks.join("");
    expect(logged).toContain("Transcript speaker suggestion finished");
    expect(logged).toContain(recording.transcriptId);
    for (const secret of ["Zebediah", "Thanks for coming", "Weekly sync"]) expect(logged).not.toContain(secret);
  });

  it("is enqueued for the edge the match step writes", async () => {
    const recording = await createRecording({ status: "processing" });
    await createIn("events", {
      name: "Weekly sync",
      type: "meeting",
      date: "2024-03-01",
      timeFrom: "13:00",
      timeTo: "14:00",
    });
    expect(await speakerJobKeys()).toEqual([]);

    const outcome = await inTenant(() =>
      withTransaction(dataPool, (client) =>
        matchTranscriptToEvent(client, { transcriptId: recording.transcriptId, durationSeconds: 3600 }),
      ),
    );

    expect(outcome).toBe("linked");
    expect(await speakerJobKeys()).toEqual([`transcript-speaker-suggestion:${recording.transcriptId}`]);
  });

  it("is not enqueued by the speaker cards the task itself writes", async () => {
    const recording = await createRecording();

    await inTenant(() =>
      withTransaction(dataPool, (client) =>
        proposeSpeakerMappings(client, { transcriptId: recording.transcriptId, suggestions: [] }),
      ),
    );

    expect(await speakerJobKeys()).toEqual([]);
  });
});
