import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runInTenant, type SempMessageRef } from "@semprec/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { writeComputed } from "../../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { readSempRefContext } from "../../semp/sempRefReadContext.js";
import { validateSempMessageRefs } from "../../semp/sempMessageRefs.js";
import { listSempThreadMessages, sendSempMessage } from "../../sempThreads/sempThreadsStore.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import {
  expandTranscriptSegmentRef,
  labelTranscriptSegmentRefs,
  validateTranscriptSegmentRef,
  validateTranscriptSegmentRefs,
} from "../transcriptSegmentRef.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";

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

/** 250 segments of two seconds, 0 to 500 s: more segments than a range may span, in a short time. */
const DENSE_SEGMENTS = Array.from({ length: 250 }, (_, index) => ({
  speaker: "SPEAKER_00",
  text: `Dense ${index}.`,
  startsAt: index * 2,
  endsAt: index * 2 + 2,
}));

const segmentRef = (itemId: string, startsAt: number, endsAt: number) =>
  ({ kind: "transcriptSegment", itemId, startsAt, endsAt }) as const;

describe("transcriptSegment message refs (issue #1834)", () => {
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  /** What one tenant's tests build on: its databases and the writes a transcript fixture needs. */
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
      const speakersProperty = properties.find((entry) => entry.key === "speakers");
      if (!speakersProperty) throw new Error("Missing Transcripts.speakers");
      /** A transcript as the pipeline leaves it. */
      const transcript = (input: { segments?: typeof SEGMENTS; name?: string; date?: string | null } = {}) =>
        withTransaction(runtime, async (client) => {
          const date = input.date === undefined ? RECORDED_AT : input.date;
          const item = await createItemWithClient(
            client,
            {
              databaseId: db("transcripts"),
              properties: {
                status: "done",
                ...(date === null ? {} : { date }),
                ...(input.name ? { name: input.name } : {}),
              },
            },
            { allowedSystemKeys: ["status", "date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
          );
          await writeComputed(client, db("transcripts"), item.id, "segments", input.segments ?? SEGMENTS);
          return item.id;
        });
      const mapSpeaker = async (transcriptId: string, speaker: string, name: string) => {
        const person = await cp.createItem({ databaseId: db("people"), properties: { name } });
        await withTransaction(runtime, (client) =>
          createRelationWithClient(client, {
            relationPropertyId: speakersProperty.id,
            callerItemId: transcriptId,
            targetItemId: person.id,
            metadata: { speaker },
          }),
        );
      };
      return { cp, db, transcript, mapSpeaker };
    });
  }

  const validate = async (tenantId: string, ref: Parameters<typeof expandTranscriptSegmentRef>[1]) => {
    const [accepted] = await runInTenant(tenantId, () =>
      withTransaction(runtime, (client) => validateTranscriptSegmentRefs(client, [ref])),
    );
    return accepted;
  };
  const expand = (tenantId: string, ref: Parameters<typeof expandTranscriptSegmentRef>[1]) =>
    runInTenant(tenantId, () => withTransaction(runtime, (client) => expandTranscriptSegmentRef(client, ref)));
  const label = async (tenantId: string, ref: Parameters<typeof expandTranscriptSegmentRef>[1]) => {
    const [text] = await runInTenant(tenantId, () =>
      withTransaction(runtime, (client) => labelTranscriptSegmentRefs(client, [ref])),
    );
    return text;
  };
  /** The statements `work` sends on its client, counted per call, with the value it returns. */
  const countStatements = async <T>(tenantId: string, work: (client: PoolClient) => Promise<T>) => {
    let statements = 0;
    const value = await runInTenant(tenantId, () =>
      withTransaction(runtime, async (client) => {
        const original = Object.getOwnPropertyDescriptor(client, "query");
        /* eslint-disable @typescript-eslint/unbound-method */
        client.query = new Proxy(client.query, {
          apply(target, receiver, args: unknown[]) {
            statements += 1;
            return Reflect.apply(target, receiver, args);
          },
        });
        /* eslint-enable @typescript-eslint/unbound-method */
        try {
          return await work(client);
        } finally {
          if (original) Object.defineProperty(client, "query", original);
          else Reflect.deleteProperty(client, "query");
        }
      }),
    );
    return { value, statements };
  };

  describe("validation", () => {
    it("accepts a range inside a live transcript, up to both limits, and one reaching past the end of the recording", async () => {
      const f = await setup(tenant);
      const id = await runInTenant(tenant, () => f.transcript());
      expect(await validate(tenant, segmentRef(id, 120, 150))).toBe(true);
      expect(await validate(tenant, segmentRef(id, 0, 900))).toBe(true);
      expect(await validate(tenant, segmentRef(id, 1490, 2000))).toBe(true);
      expect(await validate(tenant, segmentRef(id, 5000, 5100))).toBe(true);
    });

    it("refuses an item that is not a transcript and an unknown id", async () => {
      const f = await setup(tenant);
      const task = await runInTenant(tenant, () => f.cp.createItem({ databaseId: f.db("tasks"), properties: {} }));
      expect(await validate(tenant, segmentRef(task.id, 0, 10))).toBe(false);
      expect(await validate(tenant, segmentRef(randomUUID(), 0, 10))).toBe(false);
    });

    it("refuses another tenant's transcript exactly as it refuses an unknown id", async () => {
      const own = await setup(tenant);
      const other = await setup(foreign);
      const foreignId = await runInTenant(foreign, () => other.transcript());
      const ownId = await runInTenant(tenant, () => own.transcript());
      expect(await validate(tenant, segmentRef(foreignId, 0, 10))).toBe(false);
      expect(await validate(foreign, segmentRef(ownId, 0, 10))).toBe(false);
      expect(await validate(foreign, segmentRef(foreignId, 0, 10))).toBe(true);
    });

    it("refuses an inverted range, a range of no length and a negative or non-finite start", async () => {
      const f = await setup(tenant);
      const id = await runInTenant(tenant, () => f.transcript());
      expect(await validate(tenant, segmentRef(id, 60, 30))).toBe(false);
      expect(await validate(tenant, segmentRef(id, 30, 30))).toBe(false);
      expect(await validate(tenant, segmentRef(id, -1, 30))).toBe(false);
      expect(await validate(tenant, segmentRef(id, 0, Number.POSITIVE_INFINITY))).toBe(false);
      expect(await validate(tenant, segmentRef(id, Number.NaN, 30))).toBe(false);
    });

    it("refuses a range longer than 15 minutes and one that spans more than 200 segments", async () => {
      const f = await setup(tenant);
      const id = await runInTenant(tenant, () => f.transcript());
      const dense = await runInTenant(tenant, () => f.transcript({ segments: DENSE_SEGMENTS }));
      expect(await validate(tenant, segmentRef(id, 0, 901))).toBe(false);
      expect(await validate(tenant, segmentRef(dense, 0, 400))).toBe(true);
      expect(await validate(tenant, segmentRef(dense, 0, 402))).toBe(false);
    });

    it("accepts a transcript in the Trash", async () => {
      const f = await setup(tenant);
      const id = await runInTenant(tenant, () => f.transcript());
      await runInTenant(tenant, () => f.cp.softDeleteItem(f.db("transcripts"), id));
      expect(await validate(tenant, segmentRef(id, 0, 30))).toBe(true);
    });

    it("decides one ref over the stored segments of its transcript, and refuses when there are none to read", () => {
      const segments = SEGMENTS;
      expect(validateTranscriptSegmentRef(segmentRef("t", 120, 150), segments)).toBe(true);
      expect(validateTranscriptSegmentRef(segmentRef("t", 0, 901), segments)).toBe(false);
      expect(validateTranscriptSegmentRef(segmentRef("t", 60, 30), segments)).toBe(false);
      expect(validateTranscriptSegmentRef(segmentRef("t", 0, 10), undefined)).toBe(false);
    });

    it("reads the segments of every transcript the refs name in one statement, however many refs there are", async () => {
      const f = await setup(tenant);
      const [first, second, third] = await runInTenant(tenant, async () => [
        await f.transcript(),
        await f.transcript({ segments: DENSE_SEGMENTS }),
        await f.transcript(),
      ]);
      const task = await runInTenant(tenant, () => f.cp.createItem({ databaseId: f.db("tasks"), properties: {} }));
      if (!first || !second || !third) throw new Error("Missing fixture transcripts");
      const one = await countStatements(tenant, (client) =>
        validateTranscriptSegmentRefs(client, [segmentRef(first, 0, 30)]),
      );
      const many = await countStatements(tenant, (client) =>
        validateTranscriptSegmentRefs(client, [
          ...Array.from({ length: 6 }, (_, index) => segmentRef(first, index * 10, index * 10 + 30)),
          ...Array.from({ length: 6 }, (_, index) => segmentRef(second, index * 10, index * 10 + 30)),
          segmentRef(third, 0, 901),
          segmentRef(task.id, 0, 10),
          segmentRef(randomUUID(), 0, 10),
          segmentRef(first, 30, 20),
        ]),
      );
      expect(one).toEqual({ value: [true], statements: 1 });
      expect(many.statements).toBe(1);
      expect(many.value).toEqual([...Array(12).fill(true), false, false, false, false]);
      const none = await countStatements(tenant, (client) => validateTranscriptSegmentRefs(client, []));
      expect(none).toEqual({ value: [], statements: 0 });
      // A ref that cannot name a stretch is refused without a read.
      const unusable = await countStatements(tenant, (client) =>
        validateTranscriptSegmentRefs(client, [segmentRef(first, -1, 5), segmentRef(first, 0, Number.NaN)]),
      );
      expect(unusable).toEqual({ value: [false, false], statements: 0 });
    });

    it("names the offending ref's index in the refusal and keeps the first of two equal refs", async () => {
      const f = await setup(tenant);
      const id = await runInTenant(tenant, () => f.transcript());
      const task = await runInTenant(tenant, () => f.cp.createItem({ databaseId: f.db("tasks"), properties: {} }));
      const run = (refs: SempMessageRef[]) =>
        runInTenant(tenant, () => withTransaction(runtime, (client) => validateSempMessageRefs(client, refs)));
      const good = segmentRef(id, 0, 30);
      expect(await run([good, good])).toEqual([good]);
      for (const bad of [segmentRef(task.id, 0, 10), segmentRef(id, 0, 901), segmentRef(randomUUID(), 0, 10)]) {
        await expect(run([good, bad])).rejects.toMatchObject({
          code: "validation_failed",
          details: { field: "context[1]" },
        });
      }
    });
  });

  describe("expansion", () => {
    it("gives the segments of the range and three on each side, with the speakers' names", async () => {
      const f = await setup(tenant);
      const id = await runInTenant(tenant, async () => {
        const created = await f.transcript({ name: "Client meeting" });
        await f.mapSpeaker(created, "SPEAKER_00", "Alice Novak");
        return created;
      });

      const expansion = await expand(tenant, segmentRef(id, 100, 130));

      expect(expansion?.label).toBe("Client meeting 1:40-2:10");
      expect(expansion?.state).toBe("active");
      expect(expansion?.details).toMatchObject({
        transcriptId: id,
        startsAt: 100,
        endsAt: 130,
        from: 10,
        to: 12,
        speakers: [
          { speaker: "SPEAKER_00", label: "Alice Novak" },
          { speaker: "SPEAKER_01", label: "Speaker 2" },
        ],
      });
      const segments = expansion?.details.segments ?? [];
      expect(segments.map((segment) => segment.index)).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15]);
      expect(segments.map((segment) => segment.isContext)).toEqual([
        true,
        true,
        true,
        false,
        false,
        false,
        true,
        true,
        true,
      ]);
      expect(segments[3]).toEqual({
        index: 10,
        speaker: "SPEAKER_00",
        label: "Alice Novak",
        text: "Sentence number 10.",
        startsAt: 100,
        endsAt: 110,
        isContext: false,
      });
      expect(segments[4]?.label).toBe("Speaker 2");
    });

    it("clamps a range past the end of the recording and gives no segment for one entirely past it", async () => {
      const f = await setup(tenant);
      const id = await runInTenant(tenant, () => f.transcript({ name: "Recording" }));

      const past = await expand(tenant, segmentRef(id, 1490, 1600));
      expect(past?.details.from).toBe(149);
      expect(past?.details.to).toBe(149);
      expect(past?.details.segments.map((segment) => segment.index)).toEqual([146, 147, 148, 149]);

      const beyond = await expand(tenant, segmentRef(id, 5000, 5100));
      expect(beyond?.details).toMatchObject({ from: null, to: null, segments: [] });
      expect(beyond?.label).toBe("Recording 1:23:20-1:25:00");
    });

    it("is null for an item that is no transcript, another tenant's transcript and a range over the limits", async () => {
      const own = await setup(tenant);
      const other = await setup(foreign);
      const id = await runInTenant(tenant, () => own.transcript());
      const task = await runInTenant(tenant, () => own.cp.createItem({ databaseId: own.db("tasks"), properties: {} }));
      expect(await expand(tenant, segmentRef(task.id, 0, 10))).toBeNull();
      expect(await expand(foreign, segmentRef(id, 0, 10))).toBeNull();
      expect(await expand(tenant, segmentRef(randomUUID(), 0, 10))).toBeNull();
      // A stored ref that passed validation once and no longer fits the limits of the tool.
      expect(await expand(tenant, segmentRef(id, 0, 1000))).toBeNull();
      const foreignId = await runInTenant(foreign, () => other.transcript());
      expect(await expand(tenant, segmentRef(foreignId, 0, 10))).toBeNull();
    });

    it("reads a transcript in the Trash with its state and no speaker names", async () => {
      const f = await setup(tenant);
      const id = await runInTenant(tenant, async () => {
        const created = await f.transcript({ name: "Old call" });
        await f.mapSpeaker(created, "SPEAKER_00", "Alice Novak");
        return created;
      });
      await runInTenant(tenant, () => f.cp.softDeleteItem(f.db("transcripts"), id));

      const expansion = await expand(tenant, segmentRef(id, 0, 20));

      expect(expansion).toMatchObject({ label: "Old call 0:00-0:20", state: "trashed" });
      expect(expansion?.details.speakers).toEqual([]);
      expect(expansion?.details.segments.map((segment) => [segment.index, segment.label, segment.isContext])).toEqual([
        [0, "SPEAKER_00", false],
        [1, "SPEAKER_01", false],
        [2, "SPEAKER_00", true],
        [3, "SPEAKER_01", true],
        [4, "SPEAKER_00", true],
      ]);
    });

    it("is what readSempRefContext hands the turn builder for the kind", async () => {
      const f = await setup(tenant);
      const id = await runInTenant(tenant, () => f.transcript({ name: "Client meeting" }));
      const ref = segmentRef(id, 100, 130);
      const context = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) => readSempRefContext(client, ref)),
      );
      const expansion = await expand(tenant, ref);
      expect(context).toEqual({ ...expansion, blob: null });
      const missing = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) => readSempRefContext(client, segmentRef(randomUUID(), 0, 10))),
      );
      expect(missing).toBeNull();
    });

    it("keeps the expanded text out of the stored message and out of every log", async () => {
      const f = await setup(tenant);
      const id = await runInTenant(tenant, () => f.transcript({ name: "Client meeting" }));
      const ref = segmentRef(id, 100, 130);
      const written: string[] = [];
      const capture = (chunk: unknown) => {
        written.push(typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : "");
        return true;
      };
      vi.spyOn(process.stdout, "write").mockImplementation(capture);
      vi.spyOn(process.stderr, "write").mockImplementation(capture);
      for (const method of ["log", "info", "warn", "error", "debug"] as const)
        vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
          written.push(args.map(String).join(" "));
        });

      const sent = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) =>
          sendSempMessage(client, {
            text: "What was decided here?",
            context: await validateSempMessageRefs(client, [ref]),
            hasContext: true,
          }),
        ),
      );
      const expansion = await expand(tenant, ref);
      const history = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) => listSempThreadMessages(client, sent.threadId, 50, null)),
      );
      const stored = await runInTenant(tenant, () =>
        runtime.query<{ context: unknown }>("SELECT context FROM semp_messages WHERE id = $1", [sent.messageId]),
      );

      // The expansion does carry the text; nothing that is stored, returned by the history or logged does.
      expect(JSON.stringify(expansion?.details)).toContain("Sentence number 10.");
      expect(stored.rows).toEqual([{ context: [ref] }]);
      expect(JSON.stringify(history.rows)).not.toContain("Sentence number");
      expect(written.join("\n")).not.toContain("Sentence number");
    });
  });

  describe("label and history", () => {
    const read = (tenantId: string, threadId: string, messageId: string) =>
      runInTenant(tenantId, async () => {
        const page = await withTransaction(runtime, (client) => listSempThreadMessages(client, threadId, 50, null));
        return page.rows.find((row) => row.id === messageId)?.context;
      });
    const send = (tenantId: string, ref: SempMessageRef) =>
      runInTenant(tenantId, () =>
        withTransaction(runtime, (client) =>
          sendSempMessage(client, { text: "Question", context: [ref], hasContext: true }),
        ),
      );

    it("is the display name with the stretch, and the stretch alone for a transcript without a name or date", async () => {
      const f = await setup(tenant);
      const named = await runInTenant(tenant, () => f.transcript({ name: "Client meeting" }));
      const anonymous = await runInTenant(tenant, () => f.transcript({ date: null }));
      const recorded = await runInTenant(tenant, () => f.transcript());
      expect(await label(tenant, segmentRef(named, 312, 390))).toBe("Client meeting 5:12-6:30");
      expect(await label(tenant, segmentRef(named, 3725, 3800))).toBe("Client meeting 1:02:05-1:03:20");
      expect(await label(tenant, segmentRef(named, 5.9, 8.4))).toBe("Client meeting 0:05-0:08");
      expect(await label(tenant, segmentRef(anonymous, 312, 390))).toBe("5:12-6:30");
      // Without a name or an Event the display name is the recording's start in the system time zone (CEST here).
      expect(await label(tenant, segmentRef(recorded, 0, 30))).toBe("Recording 14. 10. 13:52 0:00-0:30");
    });

    it("is null for an item that is no transcript and for another tenant's transcript", async () => {
      const f = await setup(tenant);
      const other = await setup(foreign);
      const task = await runInTenant(tenant, () => f.cp.createItem({ databaseId: f.db("tasks"), properties: {} }));
      const foreignId = await runInTenant(foreign, () => other.transcript({ name: "Private" }));
      expect(await label(tenant, segmentRef(task.id, 0, 10))).toBeNull();
      expect(await label(tenant, segmentRef(foreignId, 0, 10))).toBeNull();
    });

    it("shows the new name after the transcript is renamed", async () => {
      const f = await setup(tenant);
      const id = await runInTenant(tenant, () => f.transcript({ name: "Client meeting" }));
      const ref = segmentRef(id, 312, 390);
      const sent = await send(tenant, ref);

      expect(await read(tenant, sent.threadId, sent.messageId)).toEqual([
        { ...ref, resolved: { label: "Client meeting 5:12-6:30", databaseKey: "transcripts", state: "active" } },
      ]);

      await runInTenant(tenant, () =>
        f.cp.updateItem({ databaseId: f.db("transcripts"), itemId: id, propertiesPatch: { name: "Renamed call" } }),
      );

      expect(await read(tenant, sent.threadId, sent.messageId)).toEqual([
        { ...ref, resolved: { label: "Renamed call 5:12-6:30", databaseKey: "transcripts", state: "active" } },
      ]);
    });

    it("shows a trashed transcript as recoverable under its name and a purged one as gone", async () => {
      const f = await setup(tenant);
      const id = await runInTenant(tenant, () => f.transcript({ name: "Client meeting" }));
      const ref = segmentRef(id, 312, 390);
      const sent = await send(tenant, ref);

      await runInTenant(tenant, () => f.cp.softDeleteItem(f.db("transcripts"), id));
      expect(await read(tenant, sent.threadId, sent.messageId)).toEqual([
        { ...ref, resolved: { label: "Client meeting 5:12-6:30", databaseKey: "transcripts", state: "trashed" } },
      ]);

      await runInTenant(tenant, () => f.cp.purgeExpiredTrashSubtree(id, new Date("9999-01-01T00:00:00Z")));
      expect(await read(tenant, sent.threadId, sent.messageId)).toEqual([
        { ...ref, resolved: { label: null, databaseKey: null, state: "purged" } },
      ]);
    });

    it("names a transcript by its live Event, in the Trash and after a restore as well as while it is live", async () => {
      const f = await setup(tenant);
      const id = await runInTenant(tenant, () => f.transcript());
      const named = await runInTenant(tenant, () => f.transcript({ name: "Own name" }));
      const eventProperty = (await runInTenant(tenant, () => f.cp.listProperties(f.db("transcripts")))).find(
        (entry) => entry.key === "event",
      );
      if (!eventProperty) throw new Error("Missing Transcripts.event");
      const event = await runInTenant(tenant, () =>
        f.cp.createItem({
          databaseId: f.db("events"),
          properties: { name: "Weekly sync", date: "2024-10-14T11:00:00Z" },
        }),
      );
      for (const transcriptId of [id, named]) {
        await runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            createRelationWithClient(client, {
              relationPropertyId: eventProperty.id,
              callerItemId: transcriptId,
              targetItemId: event.id,
            }),
          ),
        );
      }
      const ref = segmentRef(id, 312, 390);
      expect(await label(tenant, ref)).toBe("Weekly sync 5:12-6:30");
      // The user's own name still comes first.
      expect(await label(tenant, segmentRef(named, 312, 390))).toBe("Own name 5:12-6:30");

      await runInTenant(tenant, () => f.cp.softDeleteItem(f.db("transcripts"), id));
      expect(await label(tenant, ref)).toBe("Weekly sync 5:12-6:30");
      expect((await expand(tenant, ref))?.label).toBe("Weekly sync 5:12-6:30");

      await runInTenant(tenant, () => f.cp.restoreItem(f.db("transcripts"), id));
      expect(await label(tenant, ref)).toBe("Weekly sync 5:12-6:30");
      expect((await expand(tenant, ref))?.label).toBe("Weekly sync 5:12-6:30");

      // A trashed Event is no Event: the label falls back to the recording's date.
      await runInTenant(tenant, () => f.cp.softDeleteItem(f.db("events"), event.id));
      expect(await label(tenant, ref)).toBe("Recording 14. 10. 13:52 5:12-6:30");
    });

    it("labels many refs over several transcripts with the same statements as one", async () => {
      const f = await setup(tenant);
      const ids = await runInTenant(tenant, async () => [
        await f.transcript({ name: "First" }),
        await f.transcript({ name: "Second" }),
        await f.transcript(),
      ]);
      const task = await runInTenant(tenant, () => f.cp.createItem({ databaseId: f.db("tasks"), properties: {} }));
      const [first, second, third] = ids;
      if (!first || !second || !third) throw new Error("Missing fixture transcripts");
      const one = await countStatements(tenant, (client) =>
        labelTranscriptSegmentRefs(client, [segmentRef(first, 0, 10)]),
      );
      const refs = [
        ...Array.from({ length: 8 }, (_, index) => segmentRef(first, index, index + 5)),
        ...Array.from({ length: 8 }, (_, index) => segmentRef(second, index, index + 5)),
        segmentRef(third, 0, 30),
        segmentRef(task.id, 0, 10),
        segmentRef(randomUUID(), 0, 10),
      ];
      const many = await countStatements(tenant, (client) => labelTranscriptSegmentRefs(client, refs));
      expect(many.statements).toBe(one.statements);
      expect(many.value).toEqual([
        ...Array.from({ length: 8 }, (_, index) => `First 0:0${index}-0:${String(index + 5).padStart(2, "0")}`),
        ...Array.from({ length: 8 }, (_, index) => `Second 0:0${index}-0:${String(index + 5).padStart(2, "0")}`),
        "Recording 14. 10. 13:52 0:00-0:30",
        null,
        null,
      ]);
      const none = await countStatements(tenant, (client) => labelTranscriptSegmentRefs(client, []));
      expect(none).toEqual({ value: [], statements: 0 });
    });

    it("reads a history page of many segment refs with the same statements as a page of one", async () => {
      const f = await setup(tenant);
      const ids = await runInTenant(tenant, async () => [
        await f.transcript({ name: "First" }),
        await f.transcript({ name: "Second" }),
        await f.transcript({ name: "Third" }),
      ]);
      const sendMany = (refs: SempMessageRef[], threadId?: string) =>
        runInTenant(tenant, () =>
          withTransaction(runtime, (client) =>
            sendSempMessage(client, { threadId, text: "Question", context: refs, hasContext: true }),
          ),
        );
      const single = await sendMany([segmentRef(ids[0] ?? "", 0, 10)]);
      const crowded = await sendMany(
        Array.from({ length: 6 }, (_, index) => segmentRef(ids[index % 3] ?? "", index, index + 20)),
      );
      for (let index = 0; index < 5; index += 1) {
        await sendMany(
          Array.from({ length: 6 }, (_, ref) => segmentRef(ids[(index + ref) % 3] ?? "", ref, ref + 20)),
          crowded.threadId,
        );
      }
      const page = (threadId: string) =>
        countStatements(tenant, (client) => listSempThreadMessages(client, threadId, 50, null));
      const small = await page(single.threadId);
      const large = await page(crowded.threadId);
      expect(small.value.rows).toHaveLength(2);
      expect(large.value.rows.length).toBeGreaterThanOrEqual(12);
      expect(large.statements).toBe(small.statements);
      const labels = large.value.rows.flatMap((row) =>
        Array.isArray(row.context)
          ? row.context.map((entry: { resolved?: { label: string } }) => entry.resolved?.label)
          : [],
      );
      expect(labels.length).toBeGreaterThanOrEqual(36);
      expect(labels).toContain("First 0:00-0:20");
      expect(labels.every((text) => typeof text === "string")).toBe(true);
    });

    it("does not name another tenant's transcript in a history it reads", async () => {
      const other = await setup(foreign);
      const foreignId = await runInTenant(foreign, () => other.transcript({ name: "Private" }));
      const ref = segmentRef(foreignId, 0, 10);
      // Stored without validation, as a historical message could be: the history must still not resolve it.
      const sent = await send(tenant, ref);
      expect(await read(tenant, sent.threadId, sent.messageId)).toEqual([
        { ...ref, resolved: { label: null, databaseKey: null, state: "purged" } },
      ]);
    });
  });
});
