import "../../domainWriteHooks.js";
import { runAsSystem, runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { createBlob } from "../../blobs/blobsStore.js";
import { createItemWithClient, updateItemWithClient } from "../../chokePoint/itemWrites.js";
import { writeComputed } from "../../chokePoint/itemsStore.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import { withTransaction } from "../../db/pool.js";
import { ensureItemAutomation, recordItemAutomationFailure } from "../../library/itemAutomationStore.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { createTranscriptDetailRouteHandler } from "../transcriptionRouteHandlers.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;
describe("transcript detail", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("verify transcript detail role", () =>
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
  async function setup() {
    const cp = createChokePoint(runtime);
    const databases = await cp.listDatabases();
    const db = (key: string) => {
      const row = databases.find((d) => d.ownerModuleId === key);
      if (!row) throw new Error(`Missing ${key}`);
      return row.id;
    };
    const transcript = await withTransaction(runtime, (client) =>
      createItemWithClient(client, { databaseId: db("transcripts"), properties: { name: "Meeting" } }),
    );
    return { cp, db, transcript };
  }
  const handler = () => createTranscriptDetailRouteHandler(runtime);
  it("returns all segments and reflects speaker mappings without reprocessing", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const segments = [
        { speaker: "SPEAKER_00", text: "Hello", startsAt: 0, endsAt: 1 },
        { speaker: "SPEAKER_01", text: "Hi", startsAt: 2, endsAt: 3 },
      ];
      await withTransaction(runtime, async (client) => {
        await writeComputed(client, f.db("transcripts"), f.transcript.id, "segments", segments);
        await writeComputed(client, f.db("transcripts"), f.transcript.id, "durationSeconds", 3);
        await writeComputed(client, f.db("transcripts"), f.transcript.id, "finalizedAt", "2026-01-01T12:00:00Z");
        await writeComputed(client, f.db("transcripts"), f.transcript.id, "language", "cs");
        await updateItemWithClient(client, {
          databaseId: f.db("transcripts"),
          itemId: f.transcript.id,
          propertiesPatch: { notes: "Personal notes" },
        });
      });
      const person = await f.cp.createItem({ databaseId: f.db("people"), properties: { name: "Alice" } });
      const otherPerson = await f.cp.createItem({ databaseId: f.db("people"), properties: { name: "Bob" } });
      const property = (await f.cp.listProperties(f.db("transcripts"))).find((p) => p.key === "speakers");
      if (!property) throw new Error("Missing speakers property");
      const map = (speaker: string, personId: string) =>
        withTransaction(runtime, (client) =>
          createRelationWithClient(client, {
            relationPropertyId: property.id,
            callerItemId: f.transcript.id,
            targetItemId: personId,
            metadata: { speaker },
          }),
        );
      await map("SPEAKER_00", otherPerson.id);
      const first = await handler()({ params: { id: f.transcript.id }, identity: { user: { locale: "en" } } });
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({
        speakerCount: 2,
        displayName: "Meeting",
        durationSeconds: 3,
        finalizedAt: "2026-01-01T12:00:00Z",
        language: "cs",
        notes: "Personal notes",
        speakers: [
          { speaker: "SPEAKER_00", label: "Bob", firstStartsAt: 0 },
          { speaker: "SPEAKER_01", label: "Speaker 2", firstStartsAt: 2 },
        ],
      });
      await map("SPEAKER_01", person.id);
      const second = await handler()({ params: { id: f.transcript.id }, identity: { user: { locale: "en" } } });
      expect(second.body).toMatchObject({
        speakers: expect.arrayContaining([
          expect.objectContaining({ speaker: "SPEAKER_01", label: "Alice", personId: person.id }),
        ]),
        segments: expect.arrayContaining([expect.objectContaining({ index: 1, label: "Alice" })]),
      });
    });
  });
  it("reads live event, speaker questions and a sanitized permanent failure", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const event = await f.cp.createItem({
        databaseId: f.db("events"),
        properties: { name: "Meeting", date: "2026-01-01T10:00:00Z" },
      });
      const person = await f.cp.createItem({ databaseId: f.db("people"), properties: { name: "Alice" } });
      const transcriptProperties = await f.cp.listProperties(f.db("transcripts"));
      const eventProperty = transcriptProperties.find((p) => p.key === "event");
      const sourceProperty = (await f.cp.listProperties(f.db("processingProposals"))).find(
        (p) => p.key === "sourceTranscript",
      );
      if (!eventProperty || !sourceProperty) throw new Error("Missing relation property");
      await withTransaction(runtime, async (client) => {
        await writeComputed(client, f.db("transcripts"), f.transcript.id, "segments", [
          { speaker: "SPEAKER_00", text: "Hello", startsAt: 0, endsAt: 1 },
          { speaker: "SPEAKER_01", text: "Hi", startsAt: 2, endsAt: 3 },
        ]);
        await createRelationWithClient(client, {
          relationPropertyId: eventProperty.id,
          callerItemId: f.transcript.id,
          targetItemId: event.id,
        });
        for (const speaker of ["SPEAKER_01", "SPEAKER_00"]) {
          const proposal = {
            entityKind: "relation",
            target: person.id,
            properties: { propertyKey: "speakers", metadata: { speaker } },
          };
          const card = await createItemWithClient(
            client,
            {
              databaseId: f.db("processingProposals"),
              properties: { kind: "transcript", status: "proposed", proposal },
            },
            { allowedSystemKeys: ["kind", "status", "proposal"] },
          );
          await createRelationWithClient(
            client,
            { relationPropertyId: sourceProperty.id, callerItemId: card.id, targetItemId: f.transcript.id },
            { ownerProcess: "processingProposals" },
          );
        }
        await ensureItemAutomation(client, f.transcript.id);
        expect(
          await recordItemAutomationFailure(
            client,
            f.transcript.id,
            "private provider error",
            "error",
            "providerFailed",
          ),
        ).toBe(true);
      });
      const request = () => handler()({ params: { id: f.transcript.id }, identity: { user: { locale: "en" } } });
      const detail = await request();
      expect(detail.body).toMatchObject({
        event: { id: event.id, name: "Meeting" },
        automation: { status: "error", errorCode: "providerFailed" },
        openQuestions: { count: 2, first: { speaker: "SPEAKER_00", ordinal: 1 } },
      });
      expect(JSON.stringify(detail.body)).not.toContain("private provider error");
      await f.cp.softDeleteItem(f.db("events"), event.id);
      expect((await request()).body).toMatchObject({ event: null });
    });
  });
  it("reads playback from the original linked Files item", async () => {
    await runInTenant(tenant, async () => {
      const f = await setup();
      const blob = await withTransaction(runtime, (client) =>
        createBlob(client, { mimeType: "audio/mpeg", byteSize: 8, storageKey: `${tenant}/fixture/audio` }),
      );
      const file = await f.cp.createItem({
        databaseId: f.db("files"),
        properties: { name: "Audio", file: { blobId: blob.id } },
      });
      await withTransaction(runtime, (client) =>
        updateItemWithClient(
          client,
          {
            databaseId: f.db("transcripts"),
            itemId: f.transcript.id,
            propertiesPatch: { link: `semprec://items/${file.id}` },
          },
          { allowedSystemKeys: ["link"], systemOwnerProcess: "transcribe" },
        ),
      );
      const detail = await handler()({ params: { id: f.transcript.id }, identity: { user: { locale: "en" } } });
      expect(detail.body).toMatchObject({ playback: { blobId: blob.id, mimeType: "audio/mpeg" } });
    });
  });
  it("returns an empty processing transcript and hides foreign and unknown ids", async () => {
    const foreignId = await runInTenant(foreign, async () => (await setup()).transcript.id);
    await runInTenant(tenant, async () => {
      const f = await setup();
      const request = (id: string) => handler()({ params: { id }, identity: { user: { locale: "en" } } });
      expect((await request(f.transcript.id)).body).toMatchObject({
        speakerCount: 0,
        speakers: [],
        segments: [],
        meetingNotes: null,
      });
      await expect(request("not-a-uuid")).rejects.toMatchObject({ status: 400, details: { field: "id" } });
      await f.cp.softDeleteItem(f.db("transcripts"), f.transcript.id);
      await expect(request(f.transcript.id)).rejects.toMatchObject({ status: 404, message: "Transcript not found" });
      await expect(request(foreignId)).rejects.toMatchObject({ status: 404, message: "Transcript not found" });
      await expect(request("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
        status: 404,
        message: "Transcript not found",
      });
    });
  });
});
