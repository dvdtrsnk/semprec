import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { setAgentDatabaseGrant } from "../../agentGrants/agentDatabaseGrantsAdminStore.js";
import type { AgentDatabaseAccess } from "../../agentGrants/agentDatabaseGrantsStore.js";
import { allowItemsForTurn } from "../../agentGrants/agentRunReadAllowancesStore.js";
import { createAgentRun } from "../../agentRuns/agentRunsStore.js";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { writeComputed } from "../../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import {
  createRuntimeRolePool,
  createTestProjectItem,
  createTestTenant,
  getTestPool,
  resetDatabase,
} from "../../testSupport/testDb.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";
import {
  createTranscriptGetTool,
  createTranscriptSegmentGetTool,
  TRANSCRIPT_SEGMENT_RANGE_MAX_SEGMENTS,
  TRANSCRIPT_SEGMENT_RANGE_MAX_SECONDS,
  type TranscriptAgentToolResult,
} from "../transcriptAgentTools.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const RECORDED_AT = "2024-10-14T11:52:00.000Z";

/** 150 segments of ten seconds, 0 to 1500 s: the even ones by SPEAKER_00, the odd ones by SPEAKER_01. */
const SEGMENTS = Array.from({ length: 150 }, (_, index) => ({
  speaker: index % 2 === 0 ? "SPEAKER_00" : "SPEAKER_01",
  text: `Sentence number ${index}.`,
  startsAt: index * 10,
  endsAt: index * 10 + 10,
}));

const NOTES = {
  title: "Pricing review",
  summary: "{SPEAKER_00} presents the pricing and {SPEAKER_01} asks about the discount.",
  shortSummary: "Pricing reviewed.",
  decisions: ["{SPEAKER_00} will send the price list."],
  actionItems: [
    { text: "Send the price list", ownerSpeaker: "SPEAKER_00", due: "2024-10-18", startsAt: 12 },
    { text: "Ask about the discount", ownerSpeaker: null, due: null, startsAt: null },
  ],
};

const errorSchema = z.object({ error: z.string(), reason: z.string().optional(), message: z.string() }).passthrough();
const getResultSchema = z.object({
  transcriptId: z.uuid(),
  displayName: z.string().nullable(),
  date: z.string().nullable(),
  durationSeconds: z.number().nullable(),
  language: z.string().nullable(),
  speakers: z.array(z.object({ speaker: z.string(), label: z.string() })),
  summary: z.string().nullable(),
  decisions: z.array(z.string()),
  actionItems: z.array(
    z.object({ id: z.number(), text: z.string(), ownerLabel: z.string().nullable(), due: z.string().nullable() }),
  ),
  event: z.object({ id: z.uuid(), name: z.string().nullable(), date: z.string().nullable() }).nullable(),
  segmentCount: z.number(),
  speakerCount: z.number(),
});
const segmentResultSchema = z.object({
  transcriptId: z.uuid(),
  from: z.number().nullable(),
  to: z.number().nullable(),
  segments: z.array(
    z.object({
      index: z.number(),
      speaker: z.string(),
      label: z.string(),
      text: z.string(),
      startsAt: z.number(),
      endsAt: z.number(),
      isContext: z.boolean(),
    }),
  ),
});

describe("transcript read tools for Semp (issue #1832)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    foreign = await createTestTenant(admin);
    for (const id of [tenant, foreign]) {
      await createUser(admin, {
        tenantId: id,
        email: `${randomUUID()}@example.test`,
        passwordHash: "unused",
        locale: "en",
      });
      await runInTenant(id, () => seedSystem(runtime));
    }
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /** What one tenant's tests build on: its databases, a run, and the writes a transcript fixture needs. */
  async function setup(tenantId: string) {
    return runInTenant(tenantId, async () => {
      const cp = createChokePoint(runtime);
      const databases = await cp.listDatabases();
      const db = (key: string) => {
        const row = databases.find((database) => database.ownerModuleId === key);
        if (!row) throw new Error(`Missing ${key}`);
        return row.id;
      };
      const properties = await cp.listProperties(db("transcripts"));
      const propertyId = (key: string) => {
        const property = properties.find((entry) => entry.key === key);
        if (!property) throw new Error(`Missing Transcripts.${key}`);
        return property.id;
      };
      const inbox = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "inbox"));
      if (!inbox?.ownerProjectItemId) throw new Error("Missing the system project");
      const run = await createAgentRun(runtime, {
        projectItemId: inbox.ownerProjectItemId,
        triggeredBy: "user",
        task: "What did we promise the client?",
      });
      /** A transcript as the pipeline leaves it; `segments: null` leaves the segments and the notes out. */
      const transcript = (input: { segments?: typeof SEGMENTS | null; notes?: boolean; name?: string } = {}) =>
        withTransaction(runtime, async (client) => {
          const item = await createItemWithClient(
            client,
            {
              databaseId: db("transcripts"),
              properties: { status: "done", date: RECORDED_AT, ...(input.name ? { name: input.name } : {}) },
            },
            { allowedSystemKeys: ["status", "date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
          );
          if (input.segments !== null) {
            const segments = input.segments ?? SEGMENTS;
            await writeComputed(client, db("transcripts"), item.id, "segments", segments);
            await writeComputed(client, db("transcripts"), item.id, "durationSeconds", segments.length * 10);
            if (input.notes !== false) await writeComputed(client, db("transcripts"), item.id, "meetingNotes", NOTES);
          }
          return item.id;
        });
      const mapSpeaker = async (transcriptId: string, speaker: string, name: string) => {
        const person = await cp.createItem({ databaseId: db("people"), properties: { name } });
        await withTransaction(runtime, (client) =>
          createRelationWithClient(client, {
            relationPropertyId: propertyId("speakers"),
            callerItemId: transcriptId,
            targetItemId: person.id,
            metadata: { speaker },
          }),
        );
      };
      return { cp, db, propertyId, runId: run.id, transcript, mapSpeaker };
    });
  }

  const get = (tenantId: string, runId: string, args: unknown) =>
    runInTenant(tenantId, () => createTranscriptGetTool(runtime)(runId, args));
  const segmentGet = (tenantId: string, runId: string, args: unknown) =>
    runInTenant(tenantId, () => createTranscriptSegmentGetTool(runtime)(runId, args));

  function ok(result: TranscriptAgentToolResult): unknown {
    expect(result.error).toBe(false);
    return JSON.parse(result.result);
  }

  function failure(result: TranscriptAgentToolResult) {
    expect(result.error).toBe(true);
    return errorSchema.parse(JSON.parse(result.result));
  }

  /** Every observable row a read could change: the items with their versions, the edges and the runs. */
  async function digest(): Promise<string> {
    const { rows } = await admin.query<{ digest: string }>(
      `SELECT md5(
         coalesce((SELECT string_agg(id::text || updated_at::text || properties::text || computed::text, ',' ORDER BY id) FROM items), '') ||
         coalesce((SELECT string_agg(id::text, ',' ORDER BY id) FROM item_relations), '') ||
         coalesce((SELECT string_agg(id::text || status::text, ',' ORDER BY id) FROM agent_runs), '') ||
         coalesce((SELECT string_agg(item_id::text, ',' ORDER BY item_id) FROM item_automation), '')
       ) AS digest`,
    );
    return rows[0]?.digest ?? "";
  }

  describe("transcript.get", () => {
    it("returns the notes and action items with the speakers' names instead of SPEAKER_xx", async () => {
      const f = await setup(tenant);
      const transcriptId = await runInTenant(tenant, async () => {
        const id = await f.transcript({ name: "Pricing call" });
        await f.mapSpeaker(id, "SPEAKER_00", "Alice Novak");
        return id;
      });

      const body = getResultSchema.parse(ok(await get(tenant, f.runId, { transcriptId })));

      expect(body).toEqual({
        transcriptId,
        displayName: "Pricing call",
        date: RECORDED_AT,
        durationSeconds: 1500,
        language: null,
        speakers: [
          { speaker: "SPEAKER_00", label: "Alice Novak" },
          { speaker: "SPEAKER_01", label: "Speaker 2" },
        ],
        summary: "Alice presents the pricing and Speaker 2 asks about the discount.",
        decisions: ["Alice will send the price list."],
        actionItems: [
          { id: 0, text: "Send the price list", ownerLabel: "Alice Novak", due: "2024-10-18" },
          { id: 1, text: "Ask about the discount", ownerLabel: null, due: null },
        ],
        event: null,
        segmentCount: 150,
        speakerCount: 2,
      });
      expect(JSON.stringify([body.summary, body.decisions, body.actionItems])).not.toContain("SPEAKER_");
    });

    it("returns the Event of the transcript and, without a name of its own, the display name derived from it", async () => {
      const f = await setup(tenant);
      const { transcriptId, eventId } = await runInTenant(tenant, async () => {
        const id = await f.transcript();
        const event = await f.cp.createItem({
          databaseId: f.db("events"),
          properties: { name: "Sprint planning", date: "2024-10-14" },
        });
        await withTransaction(runtime, (client) =>
          createRelationWithClient(client, {
            relationPropertyId: f.propertyId("event"),
            callerItemId: id,
            targetItemId: event.id,
          }),
        );
        return { transcriptId: id, eventId: event.id };
      });

      const body = getResultSchema.parse(ok(await get(tenant, f.runId, { transcriptId })));

      expect(body.displayName).toBe("Sprint planning");
      expect(body.event).toEqual({ id: eventId, name: "Sprint planning", date: "2024-10-14" });
    });

    it("returns no summary, no decisions and no action items for a transcript without notes, and counts no segments", async () => {
      const f = await setup(tenant);
      const withoutNotes = await runInTenant(tenant, () => f.transcript({ notes: false }));
      const withoutSegments = await runInTenant(tenant, () => f.transcript({ segments: null }));

      expect(getResultSchema.parse(ok(await get(tenant, f.runId, { transcriptId: withoutNotes })))).toMatchObject({
        summary: null,
        decisions: [],
        actionItems: [],
        segmentCount: 150,
        displayName: "Recording 14. 10. 13:52",
      });
      expect(getResultSchema.parse(ok(await get(tenant, f.runId, { transcriptId: withoutSegments })))).toMatchObject({
        summary: null,
        decisions: [],
        actionItems: [],
        speakers: [],
        segmentCount: 0,
        speakerCount: 0,
      });
    });

    it("answers a foreign tenant's transcript, an unknown id and a trashed transcript with the same error result", async () => {
      const f = await setup(tenant);
      const other = await setup(foreign);
      const theirs = await runInTenant(foreign, () => other.transcript());
      const trashed = await runInTenant(tenant, async () => {
        const id = await f.transcript();
        await f.cp.softDeleteItem(f.db("transcripts"), id);
        return id;
      });

      const results = [
        await get(tenant, f.runId, { transcriptId: theirs }),
        await get(tenant, f.runId, { transcriptId: randomUUID() }),
        await get(tenant, f.runId, { transcriptId: trashed }),
      ];

      expect(failure(results[0]!)).toMatchObject({ error: "not_found" });
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
    });

    it("refuses arguments that name a tenant or a project, a malformed id and a missing id with validation_failed", async () => {
      const f = await setup(tenant);
      const transcriptId = await runInTenant(tenant, () => f.transcript());

      for (const args of [
        { transcriptId, tenantId: foreign },
        { transcriptId, projectItemId: randomUUID() },
        { transcriptId: "not-a-uuid" },
        {},
        null,
      ]) {
        expect(failure(await get(tenant, f.runId, args))).toMatchObject({
          error: "validation_failed",
          reason: "invalidArguments",
        });
      }
    });

    it("answers a call without a run of the tenant in scope, and without a tenant scope, as run_not_found", async () => {
      const f = await setup(tenant);
      const other = await setup(foreign);
      const transcriptId = await runInTenant(tenant, () => f.transcript());

      for (const result of [
        await get(tenant, other.runId, { transcriptId }),
        await get(tenant, randomUUID(), { transcriptId }),
        await get(tenant, "not-a-run-id", { transcriptId }),
        await createTranscriptGetTool(runtime)(f.runId, { transcriptId }),
      ]) {
        expect(failure(result)).toMatchObject({ error: "run_not_found" });
      }
    });
  });

  describe("transcript.segment.get", () => {
    it("returns the segments of 5:12 to 6:30 plus three on each side, with the speakers' names", async () => {
      const f = await setup(tenant);
      const transcriptId = await runInTenant(tenant, async () => {
        const id = await f.transcript();
        await f.mapSpeaker(id, "SPEAKER_00", "Alice Novak");
        return id;
      });

      const body = segmentResultSchema.parse(
        ok(await segmentGet(tenant, f.runId, { transcriptId, startsAt: 312, endsAt: 390 })),
      );

      expect(body.from).toBe(31);
      expect(body.to).toBe(38);
      expect(body.segments.map((segment) => segment.index)).toEqual(Array.from({ length: 14 }, (_, i) => 28 + i));
      expect(body.segments.map((segment) => segment.isContext)).toEqual([
        true,
        true,
        true,
        ...Array.from({ length: 8 }, () => false),
        true,
        true,
        true,
      ]);
      expect(body.segments[0]).toEqual({
        index: 28,
        speaker: "SPEAKER_00",
        label: "Alice Novak",
        text: "Sentence number 28.",
        startsAt: 280,
        endsAt: 290,
        isContext: true,
      });
      expect(body.segments[3]).toMatchObject({ index: 31, speaker: "SPEAKER_01", label: "Speaker 2" });
    });

    it("returns the same stretch when it is named by segment indexes", async () => {
      const f = await setup(tenant);
      const transcriptId = await runInTenant(tenant, () => f.transcript());

      const byTime = ok(await segmentGet(tenant, f.runId, { transcriptId, startsAt: 312, endsAt: 390 }));
      const byIndex = ok(await segmentGet(tenant, f.runId, { transcriptId, fromIndex: 31, toIndex: 38 }));

      expect(byIndex).toEqual(byTime);
    });

    it("adds the requested number of context segments, clips it at the ends of the recording and takes none for 0", async () => {
      const f = await setup(tenant);
      const transcriptId = await runInTenant(tenant, () => f.transcript());
      const indexes = async (args: Record<string, unknown>) =>
        segmentResultSchema
          .parse(ok(await segmentGet(tenant, f.runId, { transcriptId, ...args })))
          .segments.map((segment) => `${segment.index}${segment.isContext ? "c" : ""}`);

      expect(await indexes({ fromIndex: 10, toIndex: 11, context: 1 })).toEqual(["9c", "10", "11", "12c"]);
      expect(await indexes({ fromIndex: 10, toIndex: 11, context: 0 })).toEqual(["10", "11"]);
      expect(await indexes({ fromIndex: 0, toIndex: 1 })).toEqual(["0", "1", "2c", "3c", "4c"]);
      expect(await indexes({ fromIndex: 148, toIndex: 200 })).toEqual(["145c", "146c", "147c", "148", "149"]);
    });

    it("refuses a range of 20 minutes with validation_failed and the reason rangeTooLarge", async () => {
      const f = await setup(tenant);
      const transcriptId = await runInTenant(tenant, () => f.transcript());

      for (const args of [
        { startsAt: 0, endsAt: 1200 },
        { fromIndex: 0, toIndex: 119 },
      ]) {
        expect(failure(await segmentGet(tenant, f.runId, { transcriptId, ...args }))).toMatchObject({
          error: "validation_failed",
          reason: "rangeTooLarge",
        });
      }
    });

    it("accepts a range of exactly 15 minutes and refuses one second more", async () => {
      const f = await setup(tenant);
      const transcriptId = await runInTenant(tenant, () => f.transcript());

      const atLimit = segmentResultSchema.parse(
        ok(
          await segmentGet(tenant, f.runId, {
            transcriptId,
            startsAt: 0,
            endsAt: TRANSCRIPT_SEGMENT_RANGE_MAX_SECONDS,
          }),
        ),
      );
      expect([atLimit.from, atLimit.to]).toEqual([0, 89]);
      expect(
        failure(
          await segmentGet(tenant, f.runId, {
            transcriptId,
            startsAt: 0,
            endsAt: TRANSCRIPT_SEGMENT_RANGE_MAX_SECONDS + 1,
          }),
        ),
      ).toMatchObject({ reason: "rangeTooLarge" });
    });

    it("limits a range to 200 segments, by index and by time", async () => {
      const f = await setup(tenant);
      // 300 one-second segments: 200 of them fit in 15 minutes, so only the segment count can refuse.
      const many = Array.from({ length: 300 }, (_, index) => ({
        speaker: "SPEAKER_00",
        text: "Short.",
        startsAt: index,
        endsAt: index + 1,
      }));
      const transcriptId = await runInTenant(tenant, () => f.transcript({ segments: many }));
      const limit = TRANSCRIPT_SEGMENT_RANGE_MAX_SEGMENTS;

      const atLimit = segmentResultSchema.parse(
        ok(await segmentGet(tenant, f.runId, { transcriptId, fromIndex: 0, toIndex: limit - 1, context: 0 })),
      );
      expect(atLimit.segments).toHaveLength(limit);
      expect(
        segmentResultSchema.parse(
          ok(await segmentGet(tenant, f.runId, { transcriptId, startsAt: 0, endsAt: limit, context: 0 })),
        ).segments,
      ).toHaveLength(limit);
      for (const args of [
        { fromIndex: 0, toIndex: limit },
        { startsAt: 0, endsAt: limit + 1 },
      ]) {
        expect(failure(await segmentGet(tenant, f.runId, { transcriptId, ...args }))).toMatchObject({
          reason: "rangeTooLarge",
        });
      }
    });

    it("adds the context on top of the limit", async () => {
      const f = await setup(tenant);
      const many = Array.from({ length: 300 }, (_, index) => ({
        speaker: "SPEAKER_00",
        text: "Short.",
        startsAt: index,
        endsAt: index + 1,
      }));
      const transcriptId = await runInTenant(tenant, () => f.transcript({ segments: many }));

      const body = segmentResultSchema.parse(
        ok(await segmentGet(tenant, f.runId, { transcriptId, fromIndex: 50, toIndex: 249 })),
      );

      expect(body.segments).toHaveLength(206);
    });

    it.each([
      ["neither pair", {}],
      ["both pairs", { fromIndex: 1, toIndex: 2, startsAt: 0, endsAt: 20 }],
      ["half an index pair", { fromIndex: 1 }],
      ["half a time pair", { endsAt: 20 }],
      ["one of each pair", { fromIndex: 1, endsAt: 20 }],
    ])("refuses %s with the reason rangeRequired", async (_label, range) => {
      const f = await setup(tenant);
      const transcriptId = await runInTenant(tenant, () => f.transcript());

      expect(failure(await segmentGet(tenant, f.runId, { transcriptId, ...range }))).toMatchObject({
        error: "validation_failed",
        reason: "rangeRequired",
      });
    });

    it.each([
      ["an index range that ends before it starts", { fromIndex: 5, toIndex: 4 }],
      ["a time range that ends before it starts", { startsAt: 20, endsAt: 10 }],
      ["a time range of no length", { startsAt: 20, endsAt: 20 }],
    ])("refuses %s with the reason rangeInverted", async (_label, range) => {
      const f = await setup(tenant);
      const transcriptId = await runInTenant(tenant, () => f.transcript());

      expect(failure(await segmentGet(tenant, f.runId, { transcriptId, ...range }))).toMatchObject({
        reason: "rangeInverted",
      });
    });

    it.each([
      ["a context above 3", { context: 4 }],
      ["a negative index", { fromIndex: -1, toIndex: 2 }],
      ["a fractional index", { fromIndex: 1.5, toIndex: 2 }],
      ["a tenant", { fromIndex: 0, toIndex: 1, tenantId: randomUUID() }],
    ])("refuses %s with the reason invalidArguments", async (_label, extra) => {
      const f = await setup(tenant);
      const transcriptId = await runInTenant(tenant, () => f.transcript());
      const range = { fromIndex: 0, toIndex: 1 };

      expect(failure(await segmentGet(tenant, f.runId, { transcriptId, ...range, ...extra }))).toMatchObject({
        error: "validation_failed",
        reason: "invalidArguments",
      });
    });

    it("returns no segment for a transcript without segments, for a range past the end and for a time range in a silence", async () => {
      const f = await setup(tenant);
      const empty = await runInTenant(tenant, () => f.transcript({ segments: null }));
      const gap = await runInTenant(tenant, () =>
        f.transcript({
          segments: [
            { speaker: "SPEAKER_00", text: "First.", startsAt: 0, endsAt: 5 },
            { speaker: "SPEAKER_00", text: "Second.", startsAt: 60, endsAt: 65 },
          ],
        }),
      );
      const full = await runInTenant(tenant, () => f.transcript());

      const none = { transcriptId: expect.any(String), from: null, to: null, segments: [] };
      expect(ok(await segmentGet(tenant, f.runId, { transcriptId: empty, fromIndex: 0, toIndex: 5 }))).toEqual({
        ...none,
        transcriptId: empty,
      });
      expect(ok(await segmentGet(tenant, f.runId, { transcriptId: empty, startsAt: 0, endsAt: 30 }))).toEqual({
        ...none,
        transcriptId: empty,
      });
      expect(ok(await segmentGet(tenant, f.runId, { transcriptId: gap, startsAt: 10, endsAt: 50 }))).toEqual({
        ...none,
        transcriptId: gap,
      });
      expect(ok(await segmentGet(tenant, f.runId, { transcriptId: full, fromIndex: 150, toIndex: 160 }))).toEqual({
        ...none,
        transcriptId: full,
      });
    });

    it("answers a foreign tenant's transcript, an unknown id and a trashed transcript with the same error result", async () => {
      const f = await setup(tenant);
      const other = await setup(foreign);
      const theirs = await runInTenant(foreign, () => other.transcript());
      const trashed = await runInTenant(tenant, async () => {
        const id = await f.transcript();
        await f.cp.softDeleteItem(f.db("transcripts"), id);
        return id;
      });
      const range = { fromIndex: 0, toIndex: 5 };

      const results = [
        await segmentGet(tenant, f.runId, { transcriptId: theirs, ...range }),
        await segmentGet(tenant, f.runId, { transcriptId: randomUUID(), ...range }),
        await segmentGet(tenant, f.runId, { transcriptId: trashed, ...range }),
      ];

      expect(failure(results[0]!)).toMatchObject({ error: "not_found" });
      expect(results[1]).toEqual(results[0]);
      expect(results[2]).toEqual(results[0]);
      // The not-found answer of the two tools is the same too.
      expect(await get(tenant, f.runId, { transcriptId: theirs })).toEqual(results[0]);
    });

    it("answers a call without a run of the tenant in scope as run_not_found", async () => {
      const f = await setup(tenant);
      const other = await setup(foreign);
      const transcriptId = await runInTenant(tenant, () => f.transcript());
      const range = { transcriptId, fromIndex: 0, toIndex: 5 };

      expect(failure(await segmentGet(tenant, other.runId, range))).toMatchObject({ error: "run_not_found" });
      expect(failure(await createTranscriptSegmentGetTool(runtime)(f.runId, range))).toMatchObject({
        error: "run_not_found",
      });
    });
  });

  describe("a transcript linked to a sensitive record (issue #1999)", () => {
    const FORBIDDEN_ANSWER = { error: "forbidden", message: "The agent's project may not read this transcript" };

    /** A linked and an unlinked transcript, and runs of projects with the given decision on Health records. */
    async function linkedSetup() {
      const f = await setup(tenant);
      const health = f.db("healthRecords");
      // A fixture the API cannot produce: the schemas of the system databases are locked, and Transcripts has no
      // relation to Health records yet. The superuser pool unlocks them so the relation is created as a user would.
      await admin.query("UPDATE databases SET schema_locked = false WHERE id = ANY($1::uuid[])", [
        [f.db("transcripts"), health],
      ]);
      return runInTenant(tenant, async () => {
        const property = (
          await f.cp.createRelationProperty({
            sourceDatabaseId: f.db("transcripts"),
            key: "diagnoses",
            name: "Diagnoses",
            targetDatabaseId: health,
          })
        ).property;
        const linked = await f.transcript({ name: "Doctor visit" });
        const free = await f.transcript({ name: "Team meeting" });
        const record = await f.cp.createItem({ databaseId: health, properties: { name: "Private diagnosis" } });
        await f.cp.createRelation({
          relationPropertyId: property.id,
          callerItemId: linked,
          targetItemId: record.id,
        });
        /** A run of a fresh project; `access` is its decision on Health records, none stored when omitted. */
        const runOf = async (access?: AgentDatabaseAccess) => {
          const projectItemId = await createTestProjectItem(runtime);
          if (access !== undefined) {
            await withTransaction(runtime, (client) =>
              setAgentDatabaseGrant(client, { projectItemId, databaseId: health, access }),
            );
          }
          const run = await createAgentRun(runtime, { projectItemId, triggeredBy: "user", task: "Doctor visit" });
          return run.id;
        };
        return {
          linked,
          free,
          runOf,
          record,
          unlinkRecord: () =>
            f.cp.deleteRelation({ relationPropertyId: property.id, callerItemId: linked, targetItemId: record.id }),
        };
      });
    }

    const calls = (transcriptId: string) =>
      [
        ["transcript.get", (runId: string) => get(tenant, runId, { transcriptId })],
        [
          "transcript.segment.get",
          (runId: string) => segmentGet(tenant, runId, { transcriptId, fromIndex: 0, toIndex: 3 }),
        ],
      ] as const;

    it("refuses both tools to a project without the access, whatever the transcript says, and marks nothing", async () => {
      const f = await linkedSetup();
      const runId = await runInTenant(tenant, () => f.runOf());
      for (const [name, call] of calls(f.linked)) {
        const result = await runInTenant(tenant, () => call(runId));
        expect(failure(result), name).toMatchObject(FORBIDDEN_ANSWER);
        expect(result.result, name).not.toContain("Doctor visit");
        expect(result.result, name).not.toContain("Sentence number");
        expect(result, name).not.toHaveProperty("sensitive");
      }
      const closed = await runInTenant(tenant, () => f.runOf("none"));
      expect(failure(await get(tenant, closed, { transcriptId: f.linked }))).toMatchObject(FORBIDDEN_ANSWER);
    });

    it("reads a linked transcript with a read grant on the record's database and marks the answer sensitive", async () => {
      const f = await linkedSetup();
      const runId = await runInTenant(tenant, () => f.runOf("read"));
      const detail = await get(tenant, runId, { transcriptId: f.linked });
      expect(getResultSchema.parse(ok(detail))).toMatchObject({ displayName: "Doctor visit", segmentCount: 150 });
      expect(detail.sensitive).toBe(true);
      const segments = await segmentGet(tenant, runId, { transcriptId: f.linked, fromIndex: 0, toIndex: 3 });
      expect(segmentResultSchema.parse(ok(segments)).segments.length).toBeGreaterThan(0);
      expect(segments.sensitive).toBe(true);
    });

    it("reads a transcript that is not linked without any grant and marks nothing, and reads the linked one again once the link is gone", async () => {
      const f = await linkedSetup();
      const runId = await runInTenant(tenant, () => f.runOf());
      for (const [name, call] of calls(f.free)) {
        const result = await runInTenant(tenant, () => call(runId));
        expect(result.error, name).toBe(false);
        expect(result, name).not.toHaveProperty("sensitive");
      }
      await runInTenant(tenant, () => f.unlinkRecord());
      for (const [name, call] of calls(f.linked)) {
        const result = await runInTenant(tenant, () => call(runId));
        expect(result.error, name).toBe(false);
        expect(result, name).not.toHaveProperty("sensitive");
      }
    });

    it("opens a linked transcript to the run that holds a read allowance for it, as item.get does", async () => {
      const f = await linkedSetup();
      const runId = await runInTenant(tenant, () => f.runOf());
      await runInTenant(tenant, async () => {
        await withTransaction(runtime, (client) => allowItemsForTurn(client, runId, [f.linked]));
        const attached = await createTranscriptGetTool(runtime)(runId, { transcriptId: f.linked });
        expect(attached.error).toBe(false);
        expect(attached.sensitive).toBe(true);
      });
    });

    it("refuses a linked transcript to a run with no project and reads an unlinked one", async () => {
      const f = await linkedSetup();
      const run = await runInTenant(tenant, () =>
        createAgentRun(runtime, { projectItemId: null, triggeredBy: "user", task: "No project" }),
      );
      expect(failure(await get(tenant, run.id, { transcriptId: f.linked }))).toMatchObject(FORBIDDEN_ANSWER);
      expect(
        failure(await segmentGet(tenant, run.id, { transcriptId: f.linked, fromIndex: 0, toIndex: 3 })),
      ).toMatchObject(FORBIDDEN_ANSWER);
      expect((await get(tenant, run.id, { transcriptId: f.free })).error).toBe(false);
    });
  });

  it("changes no data", async () => {
    const f = await setup(tenant);
    const transcriptId = await runInTenant(tenant, async () => {
      const id = await f.transcript();
      await f.mapSpeaker(id, "SPEAKER_00", "Alice Novak");
      return id;
    });
    const before = await digest();

    ok(await get(tenant, f.runId, { transcriptId }));
    ok(await segmentGet(tenant, f.runId, { transcriptId, startsAt: 312, endsAt: 390 }));
    failure(await segmentGet(tenant, f.runId, { transcriptId, startsAt: 0, endsAt: 1200 }));

    expect(await digest()).toBe(before);
  });
});
