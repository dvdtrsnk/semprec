import "../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { writeComputed } from "../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { withTransaction } from "../db/pool.js";
import { rejectProposalWithClient, reviseProposalWithClient } from "../inbox/proposalActions.js";
import { ensureItemAutomation, recordItemAutomationFailure } from "../library/itemAutomationStore.js";
import { seedSystem } from "../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { matchTranscriptToEvent } from "../transcription/transcriptEventMatch.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import { createTranscriptListRouteHandler } from "../transcription/transcriptionRouteHandlers.js";
import { proposeSpeakerMappings } from "../transcription/transcriptSpeakerSuggestion.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const SEGMENTS = [
  { speaker: "SPEAKER_00", text: "Dobrý den, začneme.", startsAt: 0, endsAt: 2 },
  { speaker: "SPEAKER_01", text: "Ano, mám otázku k ceně.", startsAt: 2.5, endsAt: 5 },
  { speaker: "SPEAKER_00", text: "Pošlu ceník zítra.", startsAt: 5.5, endsAt: 8 },
];

const transcriptListBodySchema = z
  .object({
    transcripts: z.array(
      z
        .object({
          id: z.uuid(),
          displayName: z.string().nullable(),
          date: z.string().nullable(),
          durationSeconds: z.number().nullable(),
          status: z.string().nullable(),
          pairing: z.enum(["processing", "event", "awaitingEvent", "none"]),
          event: z.object({ id: z.uuid(), name: z.string().nullable() }).strict().nullable(),
          proposalId: z.uuid().nullable(),
          shortSummary: z.string().nullable(),
          openQuestions: z
            .object({
              count: z.number().int(),
              first: z
                .object({ proposalId: z.uuid(), speaker: z.string(), ordinal: z.number().int().nullable() })
                .strict()
                .nullable(),
            })
            .strict(),
          automation: z
            .object({
              status: z.string(),
              attempts: z.number().int(),
              lastAttemptAt: z.string().nullable(),
              errorCode: z.string().nullable(),
            })
            .strict()
            .nullable(),
        })
        .strict(),
    ),
    nextCursor: z.string().nullable(),
  })
  .strict();

/** Parses the handler body at the boundary, so every assertion reads a checked shape. */
function bodyOf(result: { status: number; body: unknown }) {
  expect(result.status).toBe(200);
  return transcriptListBodySchema.parse(JSON.parse(JSON.stringify(result.body)));
}

describe("GET /api/transcripts (issue #1636)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify transcript list role", () =>
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

  /** Databases, relation property ids and the pipeline-owner writes a transcript fixture is built from. */
  async function setup() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const row = databases.find((d) => d.ownerModuleId === key);
      if (!row) throw new Error(`Missing ${key}`);
      return row.id;
    };
    const transcriptProperties = await cp.listProperties(db("transcripts"));
    const propertyId = (key: string) => {
      const property = transcriptProperties.find((p) => p.key === key);
      if (!property) throw new Error(`Missing Transcripts.${key}`);
      return property.id;
    };
    /** Written with the transcription process's own system keys, as the pipeline writes them. */
    const transcript = (input: { name: string; date: string | null; status: string; segments?: boolean }) =>
      withTransaction(runtime, async (client) => {
        const item = await createItemWithClient(
          client,
          {
            databaseId: db("transcripts"),
            properties: { name: input.name, status: input.status, ...(input.date ? { date: input.date } : {}) },
          },
          { allowedSystemKeys: ["status", "date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        if (input.segments !== false) {
          await writeComputed(client, db("transcripts"), item.id, "segments", SEGMENTS);
          await writeComputed(client, db("transcripts"), item.id, "durationSeconds", 600);
        }
        await ensureItemAutomation(client, item.id);
        return item.id;
      });
    const relate = (key: string, transcriptId: string, targetId: string, metadata?: Record<string, unknown>) =>
      withTransaction(runtime, (client) =>
        createRelationWithClient(client, {
          relationPropertyId: propertyId(key),
          callerItemId: transcriptId,
          targetItemId: targetId,
          ...(metadata ? { metadata } : {}),
        }),
      );
    const item = async (moduleId: string, properties: Record<string, unknown>) =>
      (await cp.createItem({ databaseId: db(moduleId), properties })).id;
    /** The real event-match producer: no Event in the window, so it creates the transcript's pairing card. */
    const pairingCard = async (transcriptId: string) => {
      const outcome = await withTransaction(runtime, (client) =>
        matchTranscriptToEvent(client, { transcriptId, durationSeconds: 600 }),
      );
      expect(outcome).toBe("suggested");
      return cardsOf(transcriptId);
    };
    /** The real speaker-suggestion producer: one card per unmapped speaker. */
    const speakerCards = (transcriptId: string) =>
      withTransaction(runtime, (client) => proposeSpeakerMappings(client, { transcriptId, suggestions: [] }));
    const cardsOf = async (transcriptId: string) => {
      const { rows } = await runtime.query<{ id: string }>(
        `SELECT card.id FROM items card
         JOIN item_relations r ON r.tenant_id = card.tenant_id AND (r.item_a = card.id OR r.item_b = card.id)
         WHERE card.tenant_id = app_tenant_default() AND card.database_id = $1
           AND (r.item_a = $2 OR r.item_b = $2) AND card.properties->'context' IS NULL
         ORDER BY card.id`,
        [db("processingProposals"), transcriptId],
      );
      return rows.map((row) => row.id);
    };
    const reject = (proposalId: string) =>
      withTransaction(runtime, (client) =>
        rejectProposalWithClient(client, { processingProposalsDatabaseId: db("processingProposals") }, proposalId),
      );
    return { cp, db, transcript, relate, item, pairingCard, speakerCards, cardsOf, reject };
  }

  const list = (query = "", pool: Pool = runtime) =>
    createTranscriptListRouteHandler(pool)({ req: { url: `/api/transcripts${query}` } });

  /** A pool whose connections record every statement they run, to count what one list request issues. */
  function recordingPool(statements: string[]): Pool {
    return new Proxy(runtime, {
      get(target, property, receiver) {
        if (property !== "connect") {
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (): Promise<PoolClient> => {
          const client = await target.connect();
          return new Proxy(client, {
            get(connection, key, innerReceiver) {
              if (key !== "query") {
                const value: unknown = Reflect.get(connection, key, innerReceiver);
                return typeof value === "function" ? value.bind(connection) : value;
              }
              return async (...args: unknown[]) => {
                if (typeof args[0] === "string") statements.push(args[0]);
                const result: unknown = await Reflect.apply(connection.query.bind(connection), undefined, args);
                return result;
              };
            },
          });
        };
      },
    });
  }

  it("lists 50 transcripts with one SQL statement and returns no segments", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const event = await f.item("events", { name: "Klientská schůzka", date: "2026-10-16T08:00:00Z" });
      const ids: string[] = [];
      for (let index = 0; index < 50; index++) {
        const day = String((index % 28) + 1).padStart(2, "0");
        ids.push(await f.transcript({ name: `Part ${index}`, date: `2026-09-${day}T10:00:00.000Z`, status: "done" }));
      }
      // Rows of every joined kind: an event edge, a pairing card and speaker cards.
      await f.relate("event", ids[0]!, event);
      await f.pairingCard(ids[1]!);
      await f.speakerCards(ids[2]!);
      const statements: string[] = [];
      const body = bodyOf(await list("", recordingPool(statements)));
      const queries = statements.filter(
        (sql) => !/^\s*(BEGIN|COMMIT|ROLLBACK)\b/i.test(sql) && !sql.includes("set_config("),
      );
      expect(queries).toHaveLength(1);
      expect(body.transcripts).toHaveLength(50);
      expect(new Set(body.transcripts.map((row) => row.id))).toEqual(new Set(ids));
      expect(body.nextCursor).toBeNull();
      const text = JSON.stringify(body);
      expect(text).not.toContain("segments");
      expect(text).not.toContain("mám otázku");
      expect(body.transcripts.find((row) => row.id === ids[0])).toMatchObject({
        pairing: "event",
        event: { id: event },
      });
      expect(body.transcripts.find((row) => row.id === ids[2])?.openQuestions.count).toBe(2);
    });
  });

  it("derives event, awaitingEvent with its proposalId, processing and none, and none after a rejection", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const event = await f.item("events", { name: "Klientská schůzka", date: "2026-10-16T08:00:00Z" });
      const linked = await f.transcript({ name: "Linked", date: "2026-10-16T08:00:00Z", status: "done" });
      await f.relate("event", linked, event);
      const awaiting = await f.transcript({ name: "Awaiting", date: "2026-10-15T08:00:00Z", status: "done" });
      const [card] = await f.pairingCard(awaiting);
      const processing = await f.transcript({ name: "Processing", date: "2026-10-14T08:00:00Z", status: "processing" });
      // Processing wins over a live event edge.
      await f.relate("event", processing, await f.item("events", { name: "Other", date: "2026-10-14T08:00:00Z" }));
      const failed = await f.transcript({ name: "Failed", date: "2026-10-13T08:00:00Z", status: "error" });
      await f.relate("event", failed, await f.item("events", { name: "Third", date: "2026-10-13T08:00:00Z" }));
      await withTransaction(runtime, (client) =>
        recordItemAutomationFailure(client, failed, "provider detail never returned", "error", "providerFailed"),
      );
      const plain = await f.transcript({ name: "Plain", date: "2026-10-12T08:00:00Z", status: "done" });
      // A speaker card is an open question, never a pairing card.
      await f.speakerCards(plain);
      const rejected = await f.transcript({ name: "Rejected", date: "2026-10-11T08:00:00Z", status: "done" });
      const [rejectedCard] = await f.pairingCard(rejected);

      const before = bodyOf(await list());
      const pairing = (id: string) => before.transcripts.find((row) => row.id === id);
      expect(pairing(linked)).toMatchObject({
        pairing: "event",
        event: { id: event, name: "Klientská schůzka" },
        proposalId: null,
      });
      expect(pairing(awaiting)).toMatchObject({ pairing: "awaitingEvent", event: null, proposalId: card });
      expect(pairing(processing)).toMatchObject({ pairing: "processing", proposalId: null });
      expect(pairing(failed)).toMatchObject({
        pairing: "none",
        automation: { status: "error", errorCode: "providerFailed" },
      });
      expect(JSON.stringify(before)).not.toContain("provider detail never returned");
      expect(pairing(plain)).toMatchObject({ pairing: "none", proposalId: null, openQuestions: { count: 2 } });
      expect(pairing(rejected)).toMatchObject({ pairing: "awaitingEvent", proposalId: rejectedCard });

      await f.reject(rejectedCard!);
      const after = bodyOf(await list());
      expect(after.transcripts.find((row) => row.id === rejected)).toMatchObject({ pairing: "none", proposalId: null });
      expect(bodyOf(await list("?pairing=awaitingEvent")).transcripts.map((row) => row.id)).toEqual([awaiting]);
      expect(bodyOf(await list("?pairing=none")).transcripts.map((row) => row.id)).toEqual([failed, plain, rejected]);
    });
  });

  it("counts a relation envelope on event as awaiting, but not one on speakers", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const transcript = await f.transcript({ name: "Revised", date: "2026-10-10T08:00:00Z", status: "done" });
      const [card] = await f.pairingCard(transcript);
      const event = await f.item("events", { name: "Existing", date: "2026-01-01T08:00:00Z" });
      // The user corrects the card to link an existing Event: a `relation` envelope on `event`.
      await withTransaction(runtime, (client) =>
        reviseProposalWithClient(client, { processingProposalsDatabaseId: f.db("processingProposals") }, card!, {
          message: "Link the existing event",
          entityKind: "relation",
          target: event,
          properties: { propertyKey: "event" },
        }),
      );
      expect(bodyOf(await list()).transcripts).toEqual([
        expect.objectContaining({ id: transcript, pairing: "awaitingEvent", proposalId: card }),
      ]);
    });
  });

  it("pairs none while the event is in the trash and event again after its restore", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const event = await f.item("events", { name: "Trashed", date: "2026-10-09T08:00:00Z" });
      const transcript = await f.transcript({ name: "Edge", date: "2026-10-09T08:00:00Z", status: "done" });
      await f.relate("event", transcript, event);
      await f.cp.softDeleteItem(f.db("events"), event);
      expect(bodyOf(await list()).transcripts[0]).toMatchObject({ pairing: "none", event: null });
      expect(bodyOf(await list(`?eventId=${event}`)).transcripts).toEqual([]);
      await f.cp.restoreItem(f.db("events"), event);
      expect(bodyOf(await list()).transcripts[0]).toMatchObject({ pairing: "event", event: { id: event } });
    });
  });

  it("filters personId on speakers and eventId with the first part's open-question count in date order", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const petr = await f.item("people", { name: "Petr Novák" });
      const meeting = await f.item("events", { name: "Klientská schůzka", date: "2026-10-16T08:00:00Z" });
      const first = await f.transcript({ name: "Part 1", date: "2026-10-16T08:00:00Z", status: "done" });
      const second = await f.transcript({ name: "Part 2", date: "2026-10-16T09:00:00Z", status: "done" });
      const other = await f.transcript({ name: "Other", date: "2026-10-16T10:00:00Z", status: "done" });
      await f.relate("event", first, meeting);
      await f.relate("event", second, meeting);
      await f.relate("speakers", first, petr, { speaker: "SPEAKER_00" });
      // SPEAKER_01 of the first part stays unmapped: one open question, numbered by segment order.
      await f.speakerCards(first);
      expect(bodyOf(await list(`?personId=${petr}`)).transcripts.map((row) => row.id)).toEqual([first]);
      const parts = bodyOf(await list(`?eventId=${meeting}&order=asc`)).transcripts;
      expect(parts.map((row) => row.id)).toEqual([first, second]);
      expect(parts[0]?.openQuestions).toEqual({
        count: 1,
        first: { proposalId: expect.any(String), speaker: "SPEAKER_01", ordinal: 2 },
      });
      expect(parts[1]?.openQuestions).toEqual({ count: 0, first: null });
      expect(bodyOf(await list(`?eventId=${meeting}`)).transcripts.map((row) => row.id)).toEqual([second, first]);
      expect(other).toEqual(expect.any(String));
    });
  });

  it("orders by date descending with undated rows last, pages by keyset cursor and omits deleted transcripts", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const tieDate = "2026-10-05T08:00:00.000Z";
      const a = await f.transcript({ name: "Tie A", date: tieDate, status: "done" });
      const b = await f.transcript({ name: "Tie B", date: tieDate, status: "done" });
      const newest = await f.transcript({ name: "Newest", date: "2026-10-06T08:00:00.000Z", status: "done" });
      const oldest = await f.transcript({ name: "Oldest", date: "2026-10-01T08:00:00.000Z", status: "done" });
      const undated1 = await f.transcript({ name: "Undated 1", date: null, status: "recording", segments: false });
      const undated2 = await f.transcript({ name: "Undated 2", date: null, status: "recording", segments: false });
      const trashed = await f.transcript({ name: "Trashed", date: "2026-10-07T08:00:00.000Z", status: "done" });
      await f.cp.softDeleteItem(f.db("transcripts"), trashed);
      const tied = [a, b].sort().reverse();
      const undated = [undated1, undated2].sort().reverse();
      const expectedDesc = [newest, ...tied, oldest, ...undated];
      expect(bodyOf(await list()).transcripts.map((row) => row.id)).toEqual(expectedDesc);
      const pages: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 10; page++) {
        const body = bodyOf(await list(`?limit=2${cursor ? `&cursor=${cursor}` : ""}`));
        pages.push(...body.transcripts.map((row) => row.id));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      expect(pages).toEqual(expectedDesc);
      const asc = [oldest, ...[a, b].sort(), newest, ...[undated1, undated2].sort()];
      const ascPages: string[] = [];
      cursor = null;
      for (let page = 0; page < 10; page++) {
        const body = bodyOf(await list(`?order=asc&limit=3${cursor ? `&cursor=${cursor}` : ""}`));
        ascPages.push(...body.transcripts.map((row) => row.id));
        cursor = body.nextCursor;
        if (!cursor) break;
      }
      expect(ascPages).toEqual(asc);
      expect(pages).not.toContain(trashed);
    });
  });

  it("filters projectId on the live project edge only (issue #1581)", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const project = await f.item("projects", { name: "Web" });
      const other = await f.item("projects", { name: "Other" });
      const first = await f.transcript({ name: "Kickoff", date: "2026-10-01T08:00:00Z", status: "done" });
      const second = await f.transcript({ name: "Review", date: "2026-10-02T08:00:00Z", status: "done" });
      const elsewhere = await f.transcript({ name: "Elsewhere", date: "2026-10-03T08:00:00Z", status: "done" });
      await f.transcript({ name: "Unlinked", date: "2026-10-04T08:00:00Z", status: "done" });
      await f.relate("project", first, project);
      await f.relate("project", second, project);
      await f.relate("project", elsewhere, other);
      expect(bodyOf(await list(`?projectId=${project}`)).transcripts.map((row) => row.id)).toEqual([second, first]);
      expect(bodyOf(await list(`?projectId=${other}`)).transcripts.map((row) => row.id)).toEqual([elsewhere]);
      await f.cp.softDeleteItem(f.db("projects"), project);
      expect(bodyOf(await list(`?projectId=${project}`)).transcripts).toEqual([]);
    });
  });

  it("matches personId on a speaker or a participant who never spoke, once each (issue #1581)", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const jana = await f.item("people", { name: "Jana Kovářová" });
      const spoke = await f.transcript({ name: "Spoke", date: "2026-10-01T08:00:00Z", status: "done" });
      const attended = await f.transcript({ name: "Attended", date: "2026-10-02T08:00:00Z", status: "done" });
      const both = await f.transcript({ name: "Both", date: "2026-10-03T08:00:00Z", status: "done" });
      await f.transcript({ name: "Absent", date: "2026-10-04T08:00:00Z", status: "done" });
      await f.relate("speakers", spoke, jana, { speaker: "SPEAKER_01" });
      await f.relate("people", attended, jana);
      await f.relate("speakers", both, jana, { speaker: "SPEAKER_00" });
      await f.relate("people", both, jana);
      expect(bodyOf(await list(`?personId=${jana}`)).transcripts.map((row) => row.id)).toEqual([both, attended, spoke]);
      await f.cp.softDeleteItem(f.db("people"), jana);
      expect(bodyOf(await list(`?personId=${jana}`)).transcripts).toEqual([]);
    });
  });

  it("combines eventId with personId and projectId (issue #1581)", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const meeting = await f.item("events", { name: "Klientská schůzka", date: "2026-10-16T08:00:00Z" });
      const project = await f.item("projects", { name: "Web" });
      const petr = await f.item("people", { name: "Petr Novák" });
      const partOne = await f.transcript({ name: "Part 1", date: "2026-10-16T08:00:00Z", status: "done" });
      const partTwo = await f.transcript({ name: "Part 2", date: "2026-10-16T09:00:00Z", status: "done" });
      const otherMeeting = await f.transcript({ name: "Other", date: "2026-10-17T08:00:00Z", status: "done" });
      for (const id of [partOne, partTwo]) await f.relate("event", id, meeting);
      await f.relate("people", partTwo, petr);
      await f.relate("people", otherMeeting, petr);
      await f.relate("project", partOne, project);
      await f.relate("project", otherMeeting, project);
      expect(bodyOf(await list(`?eventId=${meeting}&personId=${petr}`)).transcripts.map((row) => row.id)).toEqual([
        partTwo,
      ]);
      expect(bodyOf(await list(`?eventId=${meeting}&projectId=${project}`)).transcripts.map((row) => row.id)).toEqual([
        partOne,
      ]);
    });
  });

  it("refuses an invalid limit, cursor, order, pairing or filter id with validation_failed", async () => {
    await runInTenant(tenant, async () => {
      for (const [query, field] of [
        ["?limit=0", "limit"],
        ["?limit=201", "limit"],
        ["?limit=abc", "limit"],
        ["?cursor=***", "cursor"],
        [`?cursor=${Buffer.from("{}").toString("base64url")}`, "cursor"],
        ["?order=up", "order"],
        ["?pairing=linked", "pairing"],
        ["?eventId=nope", "eventId"],
        ["?personId=nope", "personId"],
        ["?projectId=nope", "projectId"],
      ] as const) {
        await expect(list(query), query).rejects.toMatchObject({ code: "validation_failed", details: { field } });
      }
    });
  });

  it("never returns another tenant's transcripts and answers a foreign filter id with an empty list", async () => {
    const foreignIds = await runInTenant(foreign, async () => {
      const f = await setup();
      const person = await f.item("people", { name: "Foreign person" });
      const event = await f.item("events", { name: "Foreign event", date: "2026-10-01T08:00:00Z" });
      const project = await f.item("projects", { name: "Foreign project" });
      const transcript = await f.transcript({ name: "Foreign", date: "2026-10-01T08:00:00Z", status: "done" });
      await f.relate("event", transcript, event);
      await f.relate("speakers", transcript, person, { speaker: "SPEAKER_00" });
      await f.relate("project", transcript, project);
      return { person, event, project, transcript };
    });
    await runInTenant(tenant, async () => {
      const f = await setup();
      const own = await f.transcript({ name: "Own", date: "2026-10-02T08:00:00Z", status: "done" });
      const body = bodyOf(await list());
      expect(body.transcripts.map((row) => row.id)).toEqual([own]);
      expect(JSON.stringify(body)).not.toContain(foreignIds.transcript);
      expect(bodyOf(await list(`?eventId=${foreignIds.event}`))).toEqual({ transcripts: [], nextCursor: null });
      expect(bodyOf(await list(`?personId=${foreignIds.person}`))).toEqual({ transcripts: [], nextCursor: null });
      expect(bodyOf(await list(`?projectId=${foreignIds.project}`))).toEqual({ transcripts: [], nextCursor: null });
      expect(bodyOf(await list("?projectId=7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"))).toEqual({
        transcripts: [],
        nextCursor: null,
      });
    });
  });
});
