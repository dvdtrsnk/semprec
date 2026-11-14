import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, ensureQueueSchema, grantQueueSchemaPrivileges, registerTask, runOnce } from "@semprec/queue";
import { runInTenant } from "@semprec/shared";
import type { AiGatewayClientPort, AiGatewayCompletionInput, AiGatewayCompletionResult } from "@semprec/shared";
import { AiGatewayFailedError } from "@semprec/shared";
import {
  appendHistoryEntry,
  createItemWithClient,
  createRelationWithClient,
  createTranscriptEventCard,
  itemDeleteWithClient,
  createActionQueueAffinity,
  matchTranscriptToEvent,
  proposeSpeakerMappings,
  seedSystem,
  TRANSCRIPTION_OWNER_PROCESS,
  updateItemWithClient,
  withTransaction,
  writeComputed,
} from "@semprec/data";
import {
  confirmProposalWithClient,
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  reviseProposalWithClient,
  updateProposalValuesWithClient,
} from "@semprec/data/testSupport";
import { createTranscriptCardRecomputeTask } from "./transcriptCardRecompute.js";

/** Captures what the service writes to its log, as `transcriptionTask.test.ts` does, to prove no content reaches it. */
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
const DURATION_SECONDS = 3600;
const SEGMENTS = [
  { speaker: "SPEAKER_00", text: "Hello everyone.", startsAt: 0, endsAt: 2 },
  { speaker: "SPEAKER_01", text: "Let us plan the next sprint for iOS today.", startsAt: 2, endsAt: 6 },
  { speaker: "SPEAKER_00", text: "Sounds good to me, I will take the login screen.", startsAt: 6, endsAt: 9 },
];
const NOTES = {
  title: "Sprint planning",
  summary: "{SPEAKER_01} plans the iOS sprint, {SPEAKER_00} takes the login screen.",
  shortSummary: "iOS sprint planned.",
  decisions: [],
  actionItems: [],
};
/** Phrases of the recording that must never reach a log line or a history entry the task writes. */
const TRANSCRIPT_PHRASES = ["Let us plan the next sprint for iOS today", "I will take the login screen"];
const FIRST_ATTEMPT = { job: { attempts: 1, max_attempts: 3 } };
const LAST_ATTEMPT = { job: { attempts: 3, max_attempts: 3 } };

/** A fake `AiGatewayClientPort`: a deterministic transport that answers with whatever `respond` returns and counts calls. */
class FakeCardGateway implements AiGatewayClientPort {
  calls: AiGatewayCompletionInput[] = [];
  failure: Error | null = null;
  respond: (input: AiGatewayCompletionInput) => unknown = () => {
    throw new Error("The test prepared no answer");
  };

  async complete(input: AiGatewayCompletionInput): Promise<AiGatewayCompletionResult> {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    return { content: await this.respond(input), usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

const historyEntrySchema = z.looseObject({
  id: z.string().optional(),
  author: z.enum(["ai", "user"]),
  message: z.string(),
  kind: z.string().optional(),
  instructionEntryId: z.string().optional(),
  keys: z.array(z.string()).optional(),
});
const envelopeSchema = z.looseObject({
  entityKind: z.string(),
  target: z.string(),
  properties: z.record(z.string(), z.unknown()),
});
const cardSchema = z.looseObject({
  status: z.string(),
  proposal: envelopeSchema.nullable(),
  aiProposal: envelopeSchema.nullable(),
  aiVersion: z.number(),
  userOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  userEditedKeys: z.array(z.string()).optional(),
  invalidReason: z.unknown().optional(),
  context: z.looseObject({ role: z.enum(["event", "speaker"]) }),
  // A speaker card is created without a history.
  history: z.array(historyEntrySchema).default([]),
});
type Card = z.infer<typeof cardSchema>;

let adminPool: Pool;
let dataPool: Pool;
let tenant: string;
let gateway: FakeCardGateway;

const inTenant = <T>(fn: () => Promise<T>): Promise<T> => runInTenant(tenant, fn);

async function databaseId(moduleId: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    "SELECT id FROM databases WHERE owner_module_id = $1 AND system AND tenant_id = $2",
    [moduleId, tenant],
  );
  if (!rows[0]) throw new Error(`Database '${moduleId}' was not seeded`);
  return rows[0].id;
}

async function propertyId(moduleId: string, key: string): Promise<string> {
  const { rows } = await adminPool.query<{ id: string }>(
    "SELECT id FROM properties WHERE database_id = $1 AND key = $2",
    [await databaseId(moduleId), key],
  );
  if (!rows[0]) throw new Error(`Property '${key}' was not seeded`);
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

function link(moduleId: string, key: string, callerItemId: string, targetItemId: string) {
  return inTenant(async () => {
    const relationPropertyId = await propertyId(moduleId, key);
    await withTransaction(dataPool, (client) =>
      createRelationWithClient(client, { relationPropertyId, callerItemId, targetItemId }),
    );
  });
}

/** The recording 13:00-14:00 Prague time with the computed values the pipeline's steps 1, 4 and 5 store. */
function createRecording(): Promise<string> {
  return inTenant(async () => {
    const transcriptsId = await databaseId("transcripts");
    return withTransaction(dataPool, async (client) => {
      const item = await createItemWithClient(
        client,
        { databaseId: transcriptsId, properties: { name: "Planning call", date: RECORDING_START } },
        { allowedSystemKeys: ["date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      await writeComputed(client, transcriptsId, item.id, "segments", SEGMENTS);
      await writeComputed(client, transcriptsId, item.id, "durationSeconds", DURATION_SECONDS);
      await writeComputed(client, transcriptsId, item.id, "meetingNotes", NOTES);
      return item.id;
    });
  });
}

interface EventScenario {
  transcriptId: string;
  cardId: string;
  sprintId: string;
  accountantId: string;
  eventsDatabaseId: string;
}

/** Two Events overlap the recording, so its card proposes a new meeting, as the match step leaves it without a recommendation. */
async function eventCardScenario(): Promise<EventScenario> {
  const sprintId = await createIn("events", {
    name: "Sprint planning",
    type: "meeting",
    date: "2024-03-01",
    timeFrom: "13:00",
    timeTo: "13:45",
  });
  const accountantId = await createIn("events", {
    name: "Accountant call",
    type: "standup",
    date: "2024-03-01",
    timeFrom: "13:30",
    timeTo: "14:00",
  });
  const transcriptId = await createRecording();
  const cardId = await inTenant(() =>
    withTransaction(dataPool, async (client) => {
      const matched = await matchTranscriptToEvent(client, { transcriptId, durationSeconds: DURATION_SECONDS });
      if (typeof matched === "string") throw new Error(`Expected an ambiguous match, got '${matched}'`);
      return (
        await createTranscriptEventCard(client, { transcriptId, candidates: matched.candidates, recommendation: null })
      ).cardId;
    }),
  );
  return { transcriptId, cardId, sprintId, accountantId, eventsDatabaseId: await databaseId("events") };
}

interface SpeakerScenario {
  transcriptId: string;
  /** The card proposing Alice for SPEAKER_00. */
  proposedCardId: string;
  /** The card for SPEAKER_01, which asks for clarification. */
  clarificationCardId: string;
  aliceId: string;
  bobId: string;
}

/** A transcript linked to an Event with two participants: SPEAKER_00 gets a proposal (Alice), SPEAKER_01 none. */
async function speakerCardScenario(): Promise<SpeakerScenario> {
  const eventId = await createIn("events", { name: "Sync", date: "2024-03-01" });
  const aliceId = await createIn("people", { name: "Alice" });
  const bobId = await createIn("people", { name: "Bob" });
  await link("events", "people", eventId, aliceId);
  await link("events", "people", eventId, bobId);
  const transcriptId = await createRecording();
  await link("transcripts", "event", transcriptId, eventId);
  await inTenant(() =>
    withTransaction(dataPool, (client) =>
      proposeSpeakerMappings(client, {
        transcriptId,
        suggestions: [{ speaker: "SPEAKER_00", personId: aliceId, reason: "Greets the group." }],
      }),
    ),
  );
  const cards = await inTenant(async () => {
    const { rows } = await dataPool.query<{ id: string; speaker: string }>(
      `SELECT id, properties -> 'context' ->> 'speaker' AS speaker FROM items
        WHERE database_id = $1 AND properties ->> 'kind' = 'transcript'`,
      [await databaseId("processingProposals")],
    );
    return rows;
  });
  const proposedCardId = cards.find((card) => card.speaker === "SPEAKER_00")?.id;
  const clarificationCardId = cards.find((card) => card.speaker === "SPEAKER_01")?.id;
  if (!proposedCardId || !clarificationCardId) throw new Error("Expected one card per speaker");
  return { transcriptId, proposedCardId, clarificationCardId, aliceId, bobId };
}

function readCard(cardId: string): Promise<Card> {
  return inTenant(async () => {
    const { rows } = await dataPool.query<{ properties: unknown }>("SELECT properties FROM items WHERE id = $1", [
      cardId,
    ]);
    if (!rows[0]) throw new Error(`Card ${cardId} not found`);
    return cardSchema.parse(rows[0].properties);
  });
}

/** The card without its history: what the task leaves as it is when it only answers the instruction. */
function stateOf(card: Card): Record<string, unknown> {
  return Object.fromEntries(Object.entries(card).filter(([key]) => key !== "history"));
}

async function cardState(cardId: string): Promise<Record<string, unknown>> {
  return stateOf(await readCard(cardId));
}

async function proposalsConfig() {
  return { processingProposalsDatabaseId: await databaseId("processingProposals") };
}

/** The user's instruction through the revise path (a message without an envelope), which records it and enqueues the job. */
async function instruct(cardId: string, message: string): Promise<{ proposalId: string; instructionEntryId: string }> {
  const config = await proposalsConfig();
  await inTenant(() =>
    withTransaction(dataPool, (client) => reviseProposalWithClient(client, config, cardId, { message })),
  );
  const entry = (await readCard(cardId)).history.at(-1);
  if (entry?.id === undefined) throw new Error("The instruction was recorded without an id");
  return { proposalId: cardId, instructionEntryId: entry.id };
}

/** The reject route's own write (its function is not exported to this service's tests). */
function rejectCard(cardId: string): Promise<void> {
  return inTenant(async () =>
    withTransaction(dataPool, async (client) => {
      await updateItemWithClient(
        client,
        {
          databaseId: await databaseId("processingProposals"),
          itemId: cardId,
          propertiesPatch: { status: "rejected" },
        },
        { allowedSystemKeys: ["status"] },
      );
    }),
  );
}

function runTask(
  payload: { proposalId: string; instructionEntryId: string },
  helpers: { job: { attempts: number; max_attempts: number } } = FIRST_ATTEMPT,
): Promise<void> {
  return inTenant(() => createTranscriptCardRecomputeTask(dataPool, gateway)(payload, helpers));
}

function answerEntries(card: Card, instructionEntryId: string) {
  return card.history.filter(
    (entry) => entry.kind === "threadRevision" && entry.instructionEntryId === instructionEntryId,
  );
}

function relationAnswer(target: string, properties: Record<string, unknown>, reason = "Done.") {
  return { entityKind: "relation", target, properties, explicitlyChangedKeys: [], reason };
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
  gateway = new FakeCardGateway();
  observedLogs.chunks.length = 0;
});

afterAll(async () => {
  await dataPool?.end();
  await adminPool?.end();
});

describe("transcriptCardRecompute task: an Event card (issue gh-1940)", () => {
  it("switches the proposal to a relation to the named candidate and appends a threadRevision entry", async () => {
    const scenario = await eventCardScenario();
    const before = await readCard(scenario.cardId);
    expect(before.proposal).toMatchObject({ entityKind: "database", target: scenario.eventsDatabaseId });
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    gateway.respond = () =>
      relationAnswer(scenario.accountantId, { propertyKey: "event" }, "The user named the accountant call.");

    await runTask(payload);

    const after = await readCard(scenario.cardId);
    const relation = { entityKind: "relation", target: scenario.accountantId, properties: { propertyKey: "event" } };
    expect(after).toMatchObject({ status: "proposed", proposal: relation, aiProposal: relation, aiVersion: 2 });
    expect(after.context.role).toBe("event");
    const [answer, ...others] = answerEntries(after, payload.instructionEntryId);
    expect(others).toEqual([]);
    expect(answer).toMatchObject({ author: "ai", message: "The user named the accountant call." });
    expect(after.history).toHaveLength(before.history.length + 2);
    expect(gateway.calls).toHaveLength(1);
    const [request] = gateway.calls;
    expect(request).toMatchObject({ projectItemId: null, operation: "transcript_card_recompute", temperature: 0 });
    const prompt = JSON.stringify(request?.messages);
    for (const expected of ["it is the accountant call", scenario.accountantId, scenario.sprintId, "Planning call"])
      expect(prompt).toContain(expected);
  });

  it("runs from the job the revise enqueued, through the queue", async () => {
    const scenario = await eventCardScenario();
    const { proposalId, instructionEntryId } = await instruct(scenario.cardId, "it is the accountant call");
    gateway.respond = () => relationAnswer(scenario.accountantId, { propertyKey: "event" });

    await runOnce({
      pgPool: dataPool,
      taskList: {
        [CORE_TASK_NAMES.TRANSCRIPT_CARD_RECOMPUTE]: registerTask(
          CORE_TASK_NAMES.TRANSCRIPT_CARD_RECOMPUTE,
          createTranscriptCardRecomputeTask(dataPool, gateway),
        ),
      },
    });

    expect(gateway.calls).toHaveLength(1);
    const after = await readCard(proposalId);
    expect(after.proposal).toMatchObject({ entityKind: "relation", target: scenario.accountantId });
    expect(answerEntries(after, instructionEntryId)).toHaveLength(1);
  });

  it("keeps a new-meeting start the user edited when the instruction does not mention it", async () => {
    const scenario = await eventCardScenario();
    const config = await proposalsConfig();
    await inTenant(() =>
      withTransaction(dataPool, (client) =>
        updateProposalValuesWithClient(client, config, scenario.cardId, { set: { primary: { timeFrom: "13:10" } } }),
      ),
    );
    const before = await readCard(scenario.cardId);
    expect(before).toMatchObject({
      userOverrides: { primary: { timeFrom: "13:10" } },
      userEditedKeys: ["primary.timeFrom"],
    });
    const payload = await instruct(scenario.cardId, "call it the accountant sync");
    // The answer wrongly repeats the assistant's own start, which the instruction did not mention.
    gateway.respond = () => ({
      entityKind: "database",
      target: scenario.eventsDatabaseId,
      properties: { ...before.proposal?.properties, name: "Accountant sync", timeFrom: "13:00" },
      explicitlyChangedKeys: [],
      reason: "Renamed the meeting.",
    });

    await runTask(payload);

    const after = await readCard(scenario.cardId);
    expect(after.proposal?.properties).toMatchObject({ name: "Accountant sync", timeFrom: "13:10" });
    expect(after.aiProposal?.properties).toMatchObject({ name: "Accountant sync", timeFrom: "13:00" });
    expect(after).toMatchObject({
      userOverrides: { primary: { timeFrom: "13:10" } },
      userEditedKeys: ["primary.timeFrom"],
      aiVersion: 2,
      status: "proposed",
    });
    expect(answerEntries(after, payload.instructionEntryId)).toHaveLength(1);
    expect(JSON.stringify(gateway.calls[0]?.messages)).toContain("timeFrom");
  });

  it("changes a user-edited start the instruction names and keeps it marked as user-edited", async () => {
    const scenario = await eventCardScenario();
    const config = await proposalsConfig();
    await inTenant(() =>
      withTransaction(dataPool, (client) =>
        updateProposalValuesWithClient(client, config, scenario.cardId, { set: { primary: { timeFrom: "13:10" } } }),
      ),
    );
    const before = await readCard(scenario.cardId);
    const payload = await instruct(scenario.cardId, "start the meeting at 13:20");
    gateway.respond = () => ({
      entityKind: "database",
      target: scenario.eventsDatabaseId,
      properties: { ...before.proposal?.properties, timeFrom: "13:20" },
      explicitlyChangedKeys: ["timeFrom"],
      reason: "Moved the start to 13:20.",
    });

    await runTask(payload);

    const after = await readCard(scenario.cardId);
    expect(after.proposal?.properties).toMatchObject({ timeFrom: "13:20" });
    expect(after.aiProposal?.properties).toMatchObject({ timeFrom: "13:00" });
    expect(after).toMatchObject({
      userOverrides: { primary: { timeFrom: "13:20" } },
      userEditedKeys: ["primary.timeFrom"],
    });
  });

  it("drops the manual values and lists them in a reset entry when the instruction switches to a candidate", async () => {
    const scenario = await eventCardScenario();
    const config = await proposalsConfig();
    await inTenant(() =>
      withTransaction(dataPool, (client) =>
        updateProposalValuesWithClient(client, config, scenario.cardId, { set: { primary: { timeFrom: "13:10" } } }),
      ),
    );
    const payload = await instruct(scenario.cardId, "it was the sprint planning");
    gateway.respond = () => relationAnswer(scenario.sprintId, { propertyKey: "event" });

    await runTask(payload);

    const after = await readCard(scenario.cardId);
    expect(after).toMatchObject({
      proposal: { entityKind: "relation", target: scenario.sprintId },
      userOverrides: {},
      userEditedKeys: [],
    });
    expect(after.history.at(-1)).toMatchObject({ kind: "reset", keys: ["primary.timeFrom"] });
  });

  it.each([
    [
      "a target that is not one of the candidates",
      (_s: EventScenario) => relationAnswer(randomUUID(), { propertyKey: "event" }),
    ],
    [
      "a new item in place of the relation",
      (s: EventScenario) => ({
        entityKind: "database",
        target: s.eventsDatabaseId,
        properties: { name: "Other" },
        explicitlyChangedKeys: [],
        reason: "x",
      }),
    ],
    [
      "a role switch to a speaker mapping",
      (s: EventScenario) =>
        relationAnswer(s.accountantId, { propertyKey: "speakers", metadata: { speaker: "SPEAKER_00" } }),
    ],
    ["an answer of the wrong shape", (_s: EventScenario) => ({ unexpected: true })],
    [
      "an answer that names a target without a kind",
      (s: EventScenario) => ({
        entityKind: null,
        target: s.accountantId,
        properties: {},
        explicitlyChangedKeys: [],
        reason: "x",
      }),
    ],
  ])("leaves the proposal unchanged and says so when the model gives %s", async (_name, answer) => {
    const scenario = await eventCardScenario();
    // Start from a relation proposal so that "a new item in place of the relation" is a refusal of its own.
    const config = await proposalsConfig();
    await inTenant(() =>
      withTransaction(dataPool, (client) =>
        reviseProposalWithClient(client, config, scenario.cardId, {
          entityKind: "relation",
          target: scenario.sprintId,
          properties: { propertyKey: "event" },
        }),
      ),
    );
    const before = await cardState(scenario.cardId);
    const payload = await instruct(scenario.cardId, "make it so");
    gateway.respond = () => answer(scenario);

    await runTask(payload);

    const after = await readCard(scenario.cardId);
    expect(await cardState(scenario.cardId)).toEqual(before);
    const [entry, ...others] = answerEntries(after, payload.instructionEntryId);
    expect(others).toEqual([]);
    expect(entry?.message).toMatch(/^The instruction could not be applied/);
    expect(gateway.calls).toHaveLength(1);
  });

  it("says the instruction changed nothing when the model finds it cannot be satisfied", async () => {
    const scenario = await eventCardScenario();
    const before = await cardState(scenario.cardId);
    const payload = await instruct(scenario.cardId, "it was a call with someone else");
    gateway.respond = () => ({
      entityKind: null,
      target: null,
      properties: {},
      explicitlyChangedKeys: [],
      reason: "None of the listed Events fits.",
    });

    await runTask(payload);

    expect(await cardState(scenario.cardId)).toEqual(before);
    const [entry] = answerEntries(await readCard(scenario.cardId), payload.instructionEntryId);
    expect(entry?.message).toBe("The instruction changed nothing. None of the listed Events fits.");
  });

  it("says the instruction changed nothing when the answer equals the card's proposal", async () => {
    const scenario = await eventCardScenario();
    const before = await readCard(scenario.cardId);
    const payload = await instruct(scenario.cardId, "keep it as it is");
    gateway.respond = () => ({
      entityKind: "database",
      target: scenario.eventsDatabaseId,
      properties: before.proposal?.properties,
      explicitlyChangedKeys: [],
      reason: "",
    });

    await runTask(payload);

    const after = await readCard(scenario.cardId);
    expect(after.aiVersion).toBe(before.aiVersion);
    expect(after.proposal).toEqual(before.proposal);
    expect(answerEntries(after, payload.instructionEntryId).map((entry) => entry.message)).toEqual([
      "The instruction changed nothing.",
    ]);
  });
});

describe("transcriptCardRecompute task: a speaker card (issue gh-1940)", () => {
  it("changes the proposed person and keeps the card a speaker card", async () => {
    const scenario = await speakerCardScenario();
    const before = await readCard(scenario.proposedCardId);
    expect(before.proposal).toMatchObject({ entityKind: "relation", target: scenario.aliceId });
    const payload = await instruct(scenario.proposedCardId, "no, that is Bob");
    const speakerMapping = { propertyKey: "speakers", metadata: { speaker: "SPEAKER_00" } };
    gateway.respond = () => relationAnswer(scenario.bobId, speakerMapping, "The user says it is Bob.");

    await runTask(payload);

    const after = await readCard(scenario.proposedCardId);
    expect(after).toMatchObject({
      status: "proposed",
      proposal: { entityKind: "relation", target: scenario.bobId, properties: speakerMapping },
      aiVersion: 2,
    });
    expect(after.context).toMatchObject({ role: "speaker", speaker: "SPEAKER_00" });
    expect(answerEntries(after, payload.instructionEntryId)).toHaveLength(1);
    const prompt = JSON.stringify(gateway.calls[0]?.messages);
    expect(prompt).toContain(scenario.bobId);
    expect(prompt).toContain("SPEAKER_00");
  });

  it("proposes a person for a card that asked for clarification", async () => {
    const scenario = await speakerCardScenario();
    const before = await readCard(scenario.clarificationCardId);
    expect(before).toMatchObject({ status: "needsClarification", proposal: null });
    const payload = await instruct(scenario.clarificationCardId, "it is Alice");
    gateway.respond = () =>
      relationAnswer(scenario.aliceId, { propertyKey: "speakers", metadata: { speaker: "SPEAKER_01" } });

    await runTask(payload);

    const after = await readCard(scenario.clarificationCardId);
    expect(after).toMatchObject({
      status: "proposed",
      proposal: { entityKind: "relation", target: scenario.aliceId },
      aiVersion: 2,
    });
    expect(after.context.role).toBe("speaker");
  });

  it.each([
    ["an Event-shaped relation", (s: SpeakerScenario) => relationAnswer(s.aliceId, { propertyKey: "event" })],
    [
      "a person who is not an alternative",
      (_s: SpeakerScenario) =>
        relationAnswer(randomUUID(), { propertyKey: "speakers", metadata: { speaker: "SPEAKER_00" } }),
    ],
    [
      "a speaker key of another speaker",
      (s: SpeakerScenario) => relationAnswer(s.bobId, { propertyKey: "speakers", metadata: { speaker: "SPEAKER_01" } }),
    ],
  ])("leaves the speaker card unchanged when the model gives %s", async (_name, answer) => {
    const scenario = await speakerCardScenario();
    const before = await cardState(scenario.proposedCardId);
    const payload = await instruct(scenario.proposedCardId, "that is Bob");
    gateway.respond = () => answer(scenario);

    await runTask(payload);

    expect(await cardState(scenario.proposedCardId)).toEqual(before);
    expect(answerEntries(await readCard(scenario.proposedCardId), payload.instructionEntryId)).toHaveLength(1);
  });
});

describe("transcriptCardRecompute task: guards (issue gh-1940)", () => {
  it("makes no second model call and adds no second entry when the job is retried after the write", async () => {
    const scenario = await eventCardScenario();
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    gateway.respond = () => relationAnswer(scenario.accountantId, { propertyKey: "event" });

    await runTask(payload);
    const written = await readCard(scenario.cardId);
    await runTask(payload, { job: { attempts: 2, max_attempts: 3 } });

    expect(gateway.calls).toHaveLength(1);
    const retried = await readCard(scenario.cardId);
    expect(retried).toEqual(written);
    expect(answerEntries(retried, payload.instructionEntryId)).toHaveLength(1);
  });

  it("leaves a confirmed card untouched", async () => {
    const scenario = await eventCardScenario();
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    const config = await proposalsConfig();
    // A confirm of the new-meeting proposal creates the Event, which the Events rules accept for this recording.
    await inTenant(() =>
      withTransaction(dataPool, (client) => confirmProposalWithClient(client, config, scenario.cardId)),
    );
    const before = await readCard(scenario.cardId);
    expect(before.status).toBe("confirmed");
    gateway.respond = () => relationAnswer(scenario.accountantId, { propertyKey: "event" });

    await runTask(payload);

    expect(gateway.calls).toHaveLength(0);
    expect(await readCard(scenario.cardId)).toEqual(before);
  });

  it("leaves a rejected card untouched", async () => {
    const scenario = await eventCardScenario();
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    // The reject route's own write: only its function is not exported to this service's tests.
    await inTenant(async () =>
      withTransaction(dataPool, async (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: await databaseId("processingProposals"),
            itemId: scenario.cardId,
            propertiesPatch: { status: "rejected" },
          },
          { allowedSystemKeys: ["status"] },
        ),
      ),
    );
    const before = await readCard(scenario.cardId);
    gateway.respond = () => relationAnswer(scenario.accountantId, { propertyKey: "event" });

    await runTask(payload);

    expect(gateway.calls).toHaveLength(0);
    expect(await readCard(scenario.cardId)).toEqual(before);
  });

  it("leaves a card whose source was deleted untouched", async () => {
    const scenario = await eventCardScenario();
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    await inTenant(async () =>
      withTransaction(dataPool, async (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: await databaseId("processingProposals"),
            itemId: scenario.cardId,
            propertiesPatch: {
              status: "invalid",
              invalidReason: { code: "sourceDeleted", field: "", itemId: randomUUID(), label: "Gone" },
            },
          },
          { allowedSystemKeys: ["status", "invalidReason"] },
        ),
      ),
    );
    const before = await readCard(scenario.cardId);
    gateway.respond = () => relationAnswer(scenario.accountantId, { propertyKey: "event" });

    await runTask(payload);

    expect(gateway.calls).toHaveLength(0);
    expect(await readCard(scenario.cardId)).toEqual(before);
  });

  it("reopens a card that is invalid for a reason a revise can repair", async () => {
    const scenario = await eventCardScenario();
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    await inTenant(async () =>
      withTransaction(dataPool, async (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: await databaseId("processingProposals"),
            itemId: scenario.cardId,
            propertiesPatch: {
              status: "invalid",
              invalidReason: { code: "targetArchived", field: "project", itemId: randomUUID(), label: "Old" },
            },
          },
          { allowedSystemKeys: ["status", "invalidReason"] },
        ),
      ),
    );
    gateway.respond = () => relationAnswer(scenario.accountantId, { propertyKey: "event" });

    await runTask(payload);

    const after = await readCard(scenario.cardId);
    expect(after).toMatchObject({ status: "proposed", invalidReason: null });
    expect(after.proposal).toMatchObject({ target: scenario.accountantId });
  });

  it("leaves a card in the Trash untouched", async () => {
    const scenario = await eventCardScenario();
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    await inTenant(async () =>
      withTransaction(dataPool, async (client) =>
        itemDeleteWithClient(client, await databaseId("processingProposals"), scenario.cardId, {
          queueAffinity: createActionQueueAffinity(),
        }),
      ),
    );
    gateway.respond = () => relationAnswer(scenario.accountantId, { propertyKey: "event" });

    await runTask(payload);

    expect(gateway.calls).toHaveLength(0);
    const { rows } = await adminPool.query<{ properties: unknown }>("SELECT properties FROM items WHERE id = $1", [
      scenario.cardId,
    ]);
    expect(cardSchema.parse(rows[0]?.properties).proposal).toMatchObject({ entityKind: "database" });
  });

  it("never touches a card of another kind", async () => {
    const proposalsId = await inTenant(() => databaseId("processingProposals"));
    const entryId = randomUUID();
    const cardId = await inTenant(async () => {
      const card = await withTransaction(dataPool, (client) =>
        createItemWithClient(
          client,
          {
            databaseId: proposalsId,
            properties: {
              kind: "inbox",
              status: "proposed",
              history: appendHistoryEntry([], "fix it", "user", { id: entryId }),
            },
          },
          { allowedSystemKeys: ["kind", "status", "history"] },
        ),
      );
      return card.id;
    });
    const read = async () =>
      (
        await adminPool.query<{ properties: unknown; updated_at: Date }>(
          "SELECT properties, updated_at FROM items WHERE id = $1",
          [cardId],
        )
      ).rows;
    const before = await read();

    await runTask({ proposalId: cardId, instructionEntryId: entryId });

    expect(gateway.calls).toHaveLength(0);
    expect(await read()).toEqual(before);
  });

  it("does nothing for a card that does not exist", async () => {
    await runTask({ proposalId: randomUUID(), instructionEntryId: randomUUID() });

    expect(gateway.calls).toHaveLength(0);
  });

  it("fails the attempt, writing nothing, when the card's aiVersion moved while the model was asked, and the retry applies it", async () => {
    const scenario = await eventCardScenario();
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    const config = await proposalsConfig();
    gateway.respond = async () => {
      // Another writer revises the assistant's proposal while the call is out.
      await inTenant(() =>
        withTransaction(dataPool, (client) =>
          reviseProposalWithClient(client, config, scenario.cardId, {
            entityKind: "relation",
            target: scenario.sprintId,
            properties: { propertyKey: "event" },
          }),
        ),
      );
      return relationAnswer(scenario.accountantId, { propertyKey: "event" });
    };

    await expect(runTask(payload)).rejects.toMatchObject({ name: "TranscriptCardRecomputeError", code: "cardChanged" });

    const moved = await readCard(scenario.cardId);
    expect(moved.proposal).toMatchObject({ target: scenario.sprintId });
    expect(answerEntries(moved, payload.instructionEntryId)).toEqual([]);

    gateway.respond = () => relationAnswer(scenario.accountantId, { propertyKey: "event" });
    await runTask(payload, { job: { attempts: 2, max_attempts: 3 } });

    const after = await readCard(scenario.cardId);
    expect(after.proposal).toMatchObject({ target: scenario.accountantId });
    expect(after.aiVersion).toBe(moved.aiVersion + 1);
    expect(answerEntries(after, payload.instructionEntryId)).toHaveLength(1);
    expect(gateway.calls).toHaveLength(2);
  });

  it("fails an attempt that is not the last with a code only and writes nothing", async () => {
    const scenario = await eventCardScenario();
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    const before = await readCard(scenario.cardId);
    gateway.failure = new AiGatewayFailedError("http");

    await expect(runTask(payload)).rejects.toMatchObject({
      name: "TranscriptCardRecomputeError",
      message: "Transcript card recompute failed",
      code: "providerFailed",
    });

    expect(await readCard(scenario.cardId)).toEqual(before);
  });

  it("leaves the card as it was and adds an entry that the instruction could not be applied when its last attempt fails", async () => {
    const scenario = await eventCardScenario();
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    const before = await readCard(scenario.cardId);
    gateway.failure = new AiGatewayFailedError("timeout");

    await expect(runTask(payload, LAST_ATTEMPT)).rejects.toMatchObject({ code: "providerFailed" });

    const after = await readCard(scenario.cardId);
    expect(stateOf(after)).toEqual(stateOf(before));
    const [entry] = answerEntries(after, payload.instructionEntryId);
    expect(entry?.message).toBe("The instruction could not be applied: the recomputation failed.");
    expect(after.history).toHaveLength(before.history.length + 1);
  });

  it("ends the job at once, with the entry, when the gateway refuses it for the budget", async () => {
    const scenario = await eventCardScenario();
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    gateway.failure = new AiGatewayFailedError("budget_exceeded");

    await expect(runTask(payload, FIRST_ATTEMPT)).resolves.toBeUndefined();

    const after = await readCard(scenario.cardId);
    expect(answerEntries(after, payload.instructionEntryId).map((entry) => entry.message)).toEqual([
      "The instruction could not be applied: the recomputation failed.",
    ]);
    expect(after.proposal).toMatchObject({ entityKind: "database" });
  });

  it("writes nothing when the card was rejected while the model was asked, though the model answers", async () => {
    const scenario = await eventCardScenario();
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    gateway.respond = async () => {
      await rejectCard(scenario.cardId);
      return relationAnswer(scenario.accountantId, { propertyKey: "event" });
    };
    const before = await readCard(scenario.cardId);

    await runTask(payload);

    expect(gateway.calls).toHaveLength(1);
    const after = await readCard(scenario.cardId);
    expect(after.status).toBe("rejected");
    expect(after).toEqual({ ...before, status: "rejected" });
    expect(after.history.filter((entry) => entry.kind === "threadRevision")).toEqual([]);
  });

  it("writes nothing when the card was confirmed while the model was asked, though the model answers", async () => {
    const scenario = await eventCardScenario();
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    const config = await proposalsConfig();
    let confirmed: Card | null = null;
    gateway.respond = async () => {
      await inTenant(() =>
        withTransaction(dataPool, (client) => confirmProposalWithClient(client, config, scenario.cardId)),
      );
      confirmed = await readCard(scenario.cardId);
      return relationAnswer(scenario.accountantId, { propertyKey: "event" });
    };

    await runTask(payload);

    expect(gateway.calls).toHaveLength(1);
    expect(confirmed).not.toBeNull();
    const after = await readCard(scenario.cardId);
    expect(after.status).toBe("confirmed");
    expect(after).toEqual(confirmed);
    expect(answerEntries(after, payload.instructionEntryId)).toEqual([]);
  });

  it("adds no second entry when a competing write answered the same instruction while the model was asked", async () => {
    const scenario = await eventCardScenario();
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    gateway.respond = async () => {
      await inTenant(async () =>
        withTransaction(dataPool, async (client) => {
          const card = await readCard(scenario.cardId);
          await updateItemWithClient(
            client,
            {
              databaseId: await databaseId("processingProposals"),
              itemId: scenario.cardId,
              propertiesPatch: {
                history: appendHistoryEntry(card.history, "Answered elsewhere.", "ai", {
                  kind: "threadRevision",
                  instructionEntryId: payload.instructionEntryId,
                }),
              },
            },
            { allowedSystemKeys: ["history"] },
          );
        }),
      );
      return relationAnswer(scenario.accountantId, { propertyKey: "event" });
    };

    await runTask(payload);

    expect(gateway.calls).toHaveLength(1);
    const after = await readCard(scenario.cardId);
    expect(answerEntries(after, payload.instructionEntryId).map((entry) => entry.message)).toEqual([
      "Answered elsewhere.",
    ]);
    expect(after.proposal).toMatchObject({ entityKind: "database" });
    expect(after.status).toBe("proposed");
  });

  it("adds no failure entry to a card that was locked while its last attempt failed, and still fails the job", async () => {
    const scenario = await eventCardScenario();
    const payload = await instruct(scenario.cardId, "it is the accountant call");
    gateway.respond = async () => {
      // The user rejects the card while the call is out; the reject route's own write is not exported to this service's tests.
      await inTenant(async () =>
        withTransaction(dataPool, async (client) =>
          updateItemWithClient(
            client,
            {
              databaseId: await databaseId("processingProposals"),
              itemId: scenario.cardId,
              propertiesPatch: { status: "rejected" },
            },
            { allowedSystemKeys: ["status"] },
          ),
        ),
      );
      throw new AiGatewayFailedError("http");
    };

    await expect(runTask(payload, LAST_ATTEMPT)).rejects.toMatchObject({ code: "providerFailed" });

    const after = await readCard(scenario.cardId);
    expect(after.status).toBe("rejected");
    expect(answerEntries(after, payload.instructionEntryId)).toEqual([]);
  });
});

describe("transcriptCardRecompute task: what it logs (issue gh-1940)", () => {
  it("logs neither the instruction nor the transcript, and the history gains no transcript text", async () => {
    const scenario = await eventCardScenario();
    const instruction = "it is the accountant call, said Zebediah";
    const payload = await instruct(scenario.cardId, instruction);
    gateway.respond = () => relationAnswer(scenario.accountantId, { propertyKey: "event" }, "The user named the call.");
    await runTask(payload);
    const failing = await instruct(scenario.cardId, "and tell Zebediah about it");
    gateway.failure = new AiGatewayFailedError("http");
    await expect(runTask(failing, LAST_ATTEMPT)).rejects.toBeInstanceOf(Error);

    const logged = observedLogs.chunks.join("");
    expect(logged).toContain("Transcript card recompute finished");
    expect(logged).toContain("Transcript card recompute failed for good");
    expect(logged).toContain(payload.instructionEntryId);
    for (const secret of [instruction, "Zebediah", ...TRANSCRIPT_PHRASES, "Planning call", "Sprint planning"])
      expect(logged).not.toContain(secret);
    const history = JSON.stringify((await readCard(scenario.cardId)).history.filter((entry) => entry.author === "ai"));
    for (const phrase of TRANSCRIPT_PHRASES) expect(history).not.toContain(phrase);
  });
});
