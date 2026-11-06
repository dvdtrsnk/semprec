import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { Pool } from "pg";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import {
  createChokePoint,
  createDocStore,
  createRelationWithClient,
  getDatabaseByModuleId,
  listPropertiesByDatabase,
  ingestUploadedBlob,
  LocalFsBlobStorageWriter,
  primaryRootForBlob,
  readSempRefContext,
  seedSystem,
  withTransaction,
  writeComputed,
} from "../index.js";

describe("Semp reference turn reads", () => {
  let admin: Pool;
  let runtime: Pool;
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("reads a real page and sibling blocks while refusing foreign, mismatched and random refs without effects", async () => {
    const tenant = await createTestTenant(admin);
    const foreign = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    const database = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    const foreignDatabase = await runInTenant(foreign, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "tasks")),
    );
    if (!database || !foreignDatabase) throw new Error("Missing tasks database");
    const cp = createChokePoint(runtime);
    const item = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: database.id, properties: { name: "Page" } }),
    );
    const privateItem = await runInTenant(foreign, () =>
      cp.createItem({ databaseId: foreignDatabase.id, properties: { name: "Private" } }),
    );
    const parent = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    await runInTenant(tenant, async () => {
      const docs = createDocStore(runtime);
      await docs.putBlock(item.id, { id: first, flavour: "paragraph", fields: { text: "First" } }, "user");
      await docs.putBlock(item.id, { id: second, flavour: "paragraph", fields: { text: "Second" } }, "user");
      await docs.putBlock(item.id, { id: parent, flavour: "page", children: [first, second] }, "user");
    });
    const read = (ref: Parameters<typeof readSempRefContext>[1]) =>
      runInTenant(tenant, () => withTransaction(runtime, (client) => readSempRefContext(client, ref)));
    const before = await runInTenant(tenant, () =>
      runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM doc_updates"),
    );
    const block = await read({ kind: "block", itemId: item.id, blockId: first });
    expect(block).toMatchObject({
      label: "Page",
      state: "active",
      details: {
        block: {
          block: { "sys:id": first },
          parent: { "sys:id": parent },
          siblings: [{ "sys:id": first }, { "sys:id": second }],
        },
      },
    });
    await expect(read({ kind: "block", itemId: item.id, blockId: randomUUID() })).resolves.toBeNull();
    await expect(read({ kind: "item", itemId: privateItem.id, databaseId: foreignDatabase.id })).resolves.toBeNull();
    await expect(read({ kind: "item", itemId: item.id, databaseId: foreignDatabase.id })).resolves.toBeNull();
    await expect(read({ kind: "item", itemId: randomUUID(), databaseId: database.id })).resolves.toBeNull();
    const after = await runInTenant(tenant, () =>
      runtime.query<{ count: number }>("SELECT count(*)::int AS count FROM doc_updates"),
    );
    expect(after.rows).toEqual(before.rows);
    await runInTenant(tenant, () => cp.softDeleteItem(database.id, item.id));
    await expect(read({ kind: "item", itemId: item.id, databaseId: database.id })).resolves.toMatchObject({
      state: "trashed",
      label: "Page",
    });
  });

  it("returns the tenant-owned blob ID for a Files reference and refuses foreign references", async () => {
    const tenant = await createTestTenant(admin);
    const foreign = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    await runInTenant(foreign, () => seedSystem(runtime));
    const root = await mkdtemp(join(tmpdir(), "semp-ref-blob-"));
    try {
      const storage = new LocalFsBlobStorageWriter(root);
      const upload = await runInTenant(tenant, () =>
        ingestUploadedBlob(runtime, {
          mimeType: "image/png",
          source: Readable.from([Buffer.from("image fixture")]),
          maxBytes: 100,
          storage,
        }),
      );
      const files = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) => getDatabaseByModuleId(client, "files")),
      );
      if (!files) throw new Error("Missing Files database");
      const item = await runInTenant(tenant, () =>
        createChokePoint(runtime).createItem({
          databaseId: files.id,
          properties: { name: "Image", file: { blobId: upload.blob.id } },
        }),
      );
      const ref = { kind: "item" as const, itemId: item.id, databaseId: files.id };
      const resolved = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const value = await readSempRefContext(client, ref);
          return { value, root: value?.blob ? await primaryRootForBlob(client, value.blob.id) : null };
        }),
      );
      expect(resolved.value?.blob).toMatchObject({ id: upload.blob.id, storageKey: upload.blob.storageKey });
      expect(resolved.root).toBe("files");
      await expect(
        runInTenant(foreign, () => withTransaction(runtime, (client) => readSempRefContext(client, ref))),
      ).resolves.toBeNull();
      await expect(
        runInTenant(tenant, () =>
          withTransaction(runtime, (client) => readSempRefContext(client, { ...ref, itemId: randomUUID() })),
        ),
      ).resolves.toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads a transcript segment with three neighbors and the current speaker name", async () => {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    const transcriptDatabase = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "transcripts")),
    );
    const peopleDatabase = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, "people")),
    );
    if (!transcriptDatabase || !peopleDatabase) throw new Error("Missing transcript or people database");
    const cp = createChokePoint(runtime);
    const transcript = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: transcriptDatabase.id, properties: { name: "Recording" } }),
    );
    const person = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: peopleDatabase.id, properties: { name: "Speaker" } }),
    );
    const segments = Array.from({ length: 9 }, (_, index) => ({
      speaker: "SPEAKER_00",
      text: `Segment ${index}`,
      startsAt: index,
      endsAt: index + 1,
    }));
    await runInTenant(tenant, () =>
      withTransaction(runtime, async (client) => {
        await writeComputed(client, transcriptDatabase.id, transcript.id, "segments", segments);
        const property = (await listPropertiesByDatabase(client, transcriptDatabase.id)).find(
          (entry) => entry.key === "speakers",
        );
        if (!property) throw new Error("Missing speakers relation");
        await createRelationWithClient(client, {
          relationPropertyId: property.id,
          callerItemId: transcript.id,
          targetItemId: person.id,
          metadata: { speaker: "SPEAKER_00" },
        });
      }),
    );
    const ref = { kind: "transcriptSegment" as const, itemId: transcript.id, startsAt: 4, endsAt: 5 };
    const resolved = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => readSempRefContext(client, ref)),
    );
    expect(resolved).toMatchObject({
      label: "Recording",
      state: "active",
      details: {
        segments: segments.slice(1, 8),
        speakers: [{ speaker: "SPEAKER_00", person: { id: person.id, name: "Speaker" } }],
      },
    });
    await expect(
      runInTenant(tenant, () =>
        withTransaction(runtime, (client) => readSempRefContext(client, { ...ref, startsAt: 40, endsAt: 41 })),
      ),
    ).resolves.toBeNull();
  });
});
