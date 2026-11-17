import "../../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { writeComputed } from "../../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";
import { TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY } from "../transcriptionComputedKeys.js";
import { createTranscriptDetailRouteHandler, createTranscriptListRouteHandler } from "../transcriptionRouteHandlers.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;

const SEGMENTS = [
  { speaker: "SPEAKER_00", text: "Začneme.", startsAt: 0, endsAt: 2 },
  { speaker: "SPEAKER_01", text: "Dobře.", startsAt: 2.5, endsAt: 4 },
  { speaker: "SPEAKER_02", text: "Pošlu smlouvu zítra.", startsAt: 4.5, endsAt: 7 },
];

/** The notes step 5 stored for the recording (the pipeline's own production is covered in semprec-transcribe). */
const STORED_NOTES = {
  title: "Smlouva",
  summary: "{SPEAKER_02} pošle smlouvu, {SPEAKER_00} ji schválí.",
  shortSummary: "{SPEAKER_02} pošle smlouvu.",
  decisions: ["{SPEAKER_00} schvaluje"],
  actionItems: [{ text: "{SPEAKER_02} pošle smlouvu", ownerSpeaker: "SPEAKER_02", due: "2026-10-17", startsAt: 4.5 }],
};

const renderedSchema = z
  .object({
    title: z.string(),
    summary: z.string(),
    shortSummary: z.string(),
    decisions: z.array(z.string()),
    actionItems: z.array(
      z.object({
        id: z.number(),
        text: z.string(),
        ownerSpeaker: z.string().nullable(),
        ownerLabel: z.string().nullable(),
        due: z.string().nullable(),
        startsAt: z.number().nullable(),
      }),
    ),
  })
  .nullable();

describe("meeting notes rendered at read time (issue #1695)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify notes rendering role", () =>
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

  async function setup(notes: unknown) {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const row = databases.find((d) => d.ownerModuleId === key);
      if (!row) throw new Error(`Missing ${key}`);
      return row.id;
    };
    const transcript = await withTransaction(runtime, async (client) => {
      const item = await createItemWithClient(
        client,
        {
          databaseId: db("transcripts"),
          properties: { name: "Schůzka", status: "done", date: "2026-10-16T08:00:00Z" },
        },
        { allowedSystemKeys: ["status", "date"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      await writeComputed(client, db("transcripts"), item.id, "segments", SEGMENTS);
      if (notes !== undefined)
        await writeComputed(client, db("transcripts"), item.id, TRANSCRIPT_MEETING_NOTES_COMPUTED_KEY, notes);
      return item.id;
    });
    const speakersProperty = (await cp.listProperties(db("transcripts"))).find((p) => p.key === "speakers");
    if (!speakersProperty) throw new Error("Missing speakers");
    const map = async (speaker: string, name: string) => {
      const person = await cp.createItem({ databaseId: db("people"), properties: { name } });
      await withTransaction(runtime, (client) =>
        createRelationWithClient(client, {
          relationPropertyId: speakersProperty.id,
          callerItemId: transcript,
          targetItemId: person.id,
          metadata: { speaker },
        }),
      );
    };
    return { transcript, map };
  }

  const detail = async (id: string, locale = "en") => {
    const result = await createTranscriptDetailRouteHandler(runtime)({
      params: { id },
      identity: { user: { locale } },
    });
    const body = z.object({ meetingNotes: z.unknown() }).parse(result.body);
    return renderedSchema.parse(body.meetingNotes);
  };
  const listed = async (locale = "en") => {
    const result = await createTranscriptListRouteHandler(runtime)({
      req: { url: "/api/transcripts" },
      identity: { user: { locale } },
    });
    return z
      .object({ transcripts: z.array(z.object({ id: z.string(), shortSummary: z.string().nullable() })) })
      .parse(result.body).transcripts;
  };

  it("shows SPEAKER_02 as Jana in the text and Jana Kovářová as owner once mapped after the notes were written", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup(STORED_NOTES);
      await f.map("SPEAKER_00", "Petr Novák");
      const before = await detail(f.transcript);
      expect(before?.summary).toBe("Speaker 3 pošle smlouvu, Petr ji schválí.");
      expect(before?.actionItems[0]).toMatchObject({ id: 0, ownerSpeaker: "SPEAKER_02", ownerLabel: "Speaker 3" });
      expect((await listed())[0]?.shortSummary).toBe("Speaker 3 pošle smlouvu.");

      await f.map("SPEAKER_02", "Jana Kovářová");

      const after = await detail(f.transcript);
      expect(after).toEqual({
        title: "Smlouva",
        summary: "Jana pošle smlouvu, Petr ji schválí.",
        shortSummary: "Jana pošle smlouvu.",
        decisions: ["Petr schvaluje"],
        actionItems: [
          {
            id: 0,
            text: "Jana pošle smlouvu",
            ownerSpeaker: "SPEAKER_02",
            ownerLabel: "Jana Kovářová",
            due: "2026-10-17",
            startsAt: 4.5,
          },
        ],
      });
      expect((await listed())[0]?.shortSummary).toBe("Jana pošle smlouvu.");
      // The stored notes keep the tokens: the names exist only in what is read.
      const stored = await runtime.query<{ notes: unknown }>(
        "SELECT computed->'meetingNotes' AS notes FROM items WHERE tenant_id = app_tenant_default() AND id = $1",
        [f.transcript],
      );
      expect(stored.rows[0]?.notes).toEqual(STORED_NOTES);
    });
  });

  it("renders the Czech label for an unmapped speaker", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup(STORED_NOTES);
      expect((await detail(f.transcript, "cs"))?.actionItems[0]?.ownerLabel).toBe("Mluvčí 3");
      expect((await listed("cs"))[0]?.shortSummary).toBe("Mluvčí 3 pošle smlouvu.");
    });
  });

  it("answers null notes and a null short summary for a transcript without meetingNotes", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup(undefined);
      expect(await detail(f.transcript)).toBeNull();
      expect(await listed()).toEqual([{ id: f.transcript, shortSummary: null }]);
    });
  });
});
