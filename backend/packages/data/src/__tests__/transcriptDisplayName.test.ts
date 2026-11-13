import "../domainWriteHooks.js";
import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { writeComputed } from "../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../systemSettings.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { transcriptionSourceLink, TRANSCRIPTION_OWNER_PROCESS } from "../transcription/transcriptionJob.js";
import {
  createTranscriptDetailRouteHandler,
  createTranscriptListRouteHandler,
} from "../transcription/transcriptionRouteHandlers.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;

/** 14 October 2024, 13:52 in Prague (UTC+2). */
const RECORDED_AT = "2024-10-14T11:52:00.000Z";
const FILENAME = "IMG_0042.m4a";
const SEGMENTS = [
  { speaker: "SPEAKER_00", text: "Good morning everyone.", startsAt: 0, endsAt: 2 },
  { speaker: "SPEAKER_01", text: "Let us review the pricing.", startsAt: 2, endsAt: 5 },
];
const NOTES = {
  title: "Pricing review with {SPEAKER_00}",
  summary: "{SPEAKER_01} presents the pricing.",
  shortSummary: "Pricing reviewed.",
  decisions: [],
  actionItems: [],
};

const readSchema = z.object({ displayName: z.string().nullable(), suggestedName: z.string().nullable() });
const listSchema = z.object({ transcripts: z.array(readSchema.extend({ id: z.uuid() })) });

describe("the display name and the suggested name of a transcript (issue #1830)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
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
    /** The Files item an upload leaves, named after the uploaded file. */
    const file = async (name = FILENAME) => (await cp.createItem({ databaseId: db("files"), properties: { name } })).id;
    /** A transcript as the create step leaves it: no `name` of its own, unless the upload gave one. */
    const transcript = (input: {
      status: "processing" | "done";
      name?: string;
      notes?: boolean;
      sourceFileId?: string;
    }) =>
      withTransaction(runtime, async (client) => {
        const item = await createItemWithClient(
          client,
          {
            databaseId: db("transcripts"),
            properties: {
              status: input.status,
              date: RECORDED_AT,
              ...(input.name === undefined ? {} : { name: input.name }),
              ...(input.sourceFileId === undefined ? {} : { link: transcriptionSourceLink(input.sourceFileId) }),
            },
          },
          { allowedSystemKeys: ["status", "date", "link"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
        );
        if (input.notes) {
          await writeComputed(client, db("transcripts"), item.id, "segments", SEGMENTS);
          await writeComputed(client, db("transcripts"), item.id, "durationSeconds", 5);
          await writeComputed(client, db("transcripts"), item.id, "meetingNotes", NOTES);
        }
        return item.id;
      });
    const linkEvent = (transcriptId: string, eventId: string) =>
      withTransaction(runtime, (client) =>
        createRelationWithClient(client, {
          relationPropertyId: propertyId("event"),
          callerItemId: transcriptId,
          targetItemId: eventId,
        }),
      );
    const event = async (name: string) =>
      (await cp.createItem({ databaseId: db("events"), properties: { name, date: "2024-10-14" } })).id;
    const rename = (databaseId: string, itemId: string, name: string) =>
      cp.updateItem({ databaseId, itemId, propertiesPatch: { name } });
    const setZone = async (timezone: string) => {
      const settings = await withTransaction(runtime, async (client) => ({
        databaseId: await getSystemSettingsDatabaseId(client),
        itemId: await getSystemSettingsItemId(client),
      }));
      await cp.updateItem({ ...settings, propertiesPatch: { timezone } });
    };
    /** What the detail endpoint and the list endpoint each say about one transcript, in `locale`. */
    const read = async (transcriptId: string, locale = "en") => {
      const identity = { user: { locale } };
      const detail = readSchema.parse(
        (await createTranscriptDetailRouteHandler(runtime)({ params: { id: transcriptId }, identity })).body,
      );
      const listed = listSchema
        .parse((await createTranscriptListRouteHandler(runtime)({ req: { url: "/api/transcripts" }, identity })).body)
        .transcripts.find((row) => row.id === transcriptId);
      if (!listed) throw new Error("The list does not contain the transcript");
      expect({ displayName: listed.displayName, suggestedName: listed.suggestedName }).toEqual(detail);
      return detail;
    };
    return { cp, db, file, transcript, linkEvent, event, rename, setZone, read };
  }

  it("shows the linked Event's current name, also after a rename, and a name typed by the user wins", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const eventId = await f.event("Sprint planning");
      const transcriptId = await f.transcript({ status: "done", notes: true });
      await f.linkEvent(transcriptId, eventId);

      expect(await f.read(transcriptId)).toEqual({ displayName: "Sprint planning", suggestedName: null });
      await f.rename(f.db("events"), eventId, "Sprint planning, moved");
      expect(await f.read(transcriptId)).toEqual({ displayName: "Sprint planning, moved", suggestedName: null });
      await f.rename(f.db("transcripts"), transcriptId, "Our own title");
      expect(await f.read(transcriptId)).toEqual({ displayName: "Our own title", suggestedName: null });
    });
  });

  it("shows 'Recording D. M. HH:MM' and the generated title as the suggestion for a finished recording without an Event, and leaves Files.name alone", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const fileId = await f.file();
      const transcriptId = await f.transcript({ status: "done", notes: true, sourceFileId: fileId });
      const person = await f.cp.createItem({ databaseId: f.db("people"), properties: { name: "Alice Novak" } });
      const speakers = (await f.cp.listProperties(f.db("transcripts"))).find((p) => p.key === "speakers");
      if (!speakers) throw new Error("Missing Transcripts.speakers");
      await withTransaction(runtime, (client) =>
        createRelationWithClient(client, {
          relationPropertyId: speakers.id,
          callerItemId: transcriptId,
          targetItemId: person.id,
          metadata: { speaker: "SPEAKER_00" },
        }),
      );

      expect(await f.read(transcriptId)).toEqual({
        displayName: "Recording 14. 10. 13:52",
        suggestedName: "Pricing review with Alice",
      });
      expect(await f.read(transcriptId, "cs")).toMatchObject({ displayName: "Nahrávka 14. 10. 13:52" });
      const stored = await runtime.query<{ name: string }>(
        "SELECT properties ->> 'name' AS name FROM items WHERE id = $1",
        [fileId],
      );
      expect(stored.rows).toEqual([{ name: FILENAME }]);
    });
  });

  it("shows the name the user saves from the suggestion and no suggestion afterwards", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const transcriptId = await f.transcript({ status: "done", notes: true });
      const before = await f.read(transcriptId);
      expect(before.suggestedName).toBe("Pricing review with Speaker 1");

      await f.rename(f.db("transcripts"), transcriptId, before.suggestedName ?? "");

      expect(await f.read(transcriptId)).toEqual({
        displayName: "Pricing review with Speaker 1",
        suggestedName: null,
      });
      await f.rename(f.db("transcripts"), transcriptId, "An edited name");
      expect(await f.read(transcriptId)).toEqual({ displayName: "An edited name", suggestedName: null });
    });
  });

  it("shows the same 'Recording D. M. HH:MM' for a processing recording, imported or made in the app", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const imported = await f.transcript({ status: "processing", sourceFileId: await f.file() });
      const recordedInApp = await f.transcript({ status: "processing", sourceFileId: await f.file("Recording.m4a") });

      expect(await f.read(imported)).toEqual({ displayName: "Recording 14. 10. 13:52", suggestedName: null });
      expect(await f.read(recordedInApp)).toEqual({ displayName: "Recording 14. 10. 13:52", suggestedName: null });
    });
  });

  it("reads the time in the tenant's zone", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      await f.setZone("America/New_York");
      const transcriptId = await f.transcript({ status: "processing" });

      expect(await f.read(transcriptId)).toMatchObject({ displayName: "Recording 14. 10. 07:52" });
    });
  });

  it("falls back to the recording date, and offers the title, when the linked Event is in the Trash", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const eventId = await f.event("Sprint planning");
      const transcriptId = await f.transcript({ status: "done", notes: true });
      await f.linkEvent(transcriptId, eventId);
      await f.cp.softDeleteItem(f.db("events"), eventId);

      expect(await f.read(transcriptId)).toEqual({
        displayName: "Recording 14. 10. 13:52",
        suggestedName: "Pricing review with Speaker 1",
      });
    });
  });

  it("offers no suggestion for a recording that has no notes yet", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const transcriptId = await f.transcript({ status: "done" });

      expect(await f.read(transcriptId)).toEqual({ displayName: "Recording 14. 10. 13:52", suggestedName: null });
    });
  });
});
