import "../../domainWriteHooks.js";
import { runInTenant } from "@semprec/shared";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createItemWithClient } from "../../chokePoint/itemWrites.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { runTranscriptNameBackfillCutoverMigration } from "../transcriptNameBackfillCutoverMigration.js";
import { transcriptionSourceLink, TRANSCRIPTION_OWNER_PROCESS } from "../transcriptionJob.js";

let admin: Pool;
let runtime: Pool;
let tenant: string;
let foreign: string;

const FILENAME = "IMG_0042.m4a";
const rowSchema = z.object({ id: z.uuid(), name: z.string().nullable(), updatedAt: z.string() });

describe("transcript name backfill (issue #1830)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
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

  async function databases() {
    const all = await createChokePoint(runtime).listDatabases();
    const id = (key: string) => {
      const row = all.find((database) => database.ownerModuleId === key);
      if (!row) throw new Error(`Missing ${key}`);
      return row.id;
    };
    return { files: id("files"), transcripts: id("transcripts") };
  }

  /** A Files item named `fileName`. */
  async function file(fileName: string): Promise<string> {
    const { files } = await databases();
    return (await createChokePoint(runtime).createItem({ databaseId: files, properties: { name: fileName } })).id;
  }

  /** A transcript as the old create step wrote it: `name` (when given) and the `link` to its source file. */
  async function transcript(input: { name?: string; sourceFileId?: string }): Promise<string> {
    const { transcripts } = await databases();
    return withTransaction(runtime, async (client) => {
      const item = await createItemWithClient(
        client,
        {
          databaseId: transcripts,
          properties: {
            status: "done",
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.sourceFileId === undefined ? {} : { link: transcriptionSourceLink(input.sourceFileId) }),
          },
        },
        { allowedSystemKeys: ["status", "link"], systemOwnerProcess: TRANSCRIPTION_OWNER_PROCESS },
      );
      return item.id;
    });
  }

  /** The `name` and `updated_at` of every given item, in the order of `ids`. */
  async function read(ids: string[]) {
    const { rows } = await runtime.query<Record<string, unknown>>(
      `SELECT id, properties ->> 'name' AS name, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS "updatedAt"
         FROM items WHERE tenant_id = app_tenant_default() AND id = ANY($1::uuid[])`,
      [ids],
    );
    const byId = new Map(rows.map((row) => [row.id, rowSchema.parse(row)]));
    return ids.map((id) => {
      const row = byId.get(id);
      if (!row) throw new Error(`Item ${id} not found`);
      return row;
    });
  }

  const run = (tenantId: string) => runInTenant(tenantId, () => runTranscriptNameBackfillCutoverMigration(runtime));

  it("clears a name that equals the source file's name and leaves every other transcript and the file as they are", async () => {
    await runInTenant(tenant, async () => {
      const fileId = await file(FILENAME);
      const otherFileId = await file("Other.m4a");
      const copied = await transcript({ name: FILENAME, sourceFileId: fileId });
      const renamed = await transcript({ name: "Pricing call", sourceFileId: fileId });
      const wrongFile = await transcript({ name: FILENAME, sourceFileId: otherFileId });
      const noLink = await transcript({ name: FILENAME });
      const missingSource = await transcript({
        name: FILENAME,
        sourceFileId: "00000000-0000-4000-8000-000000000000",
      });
      const unnamed = await transcript({ sourceFileId: fileId });
      const trashed = await transcript({ name: FILENAME, sourceFileId: fileId });
      await createChokePoint(runtime).softDeleteItem((await databases()).transcripts, trashed);
      const ids = [copied, renamed, wrongFile, noLink, missingSource, unnamed, trashed];
      const before = await read(ids);

      await run(tenant);

      const after = await read(ids);
      expect(after.map((row) => row.name)).toEqual([
        null,
        "Pricing call",
        FILENAME,
        FILENAME,
        FILENAME,
        null,
        FILENAME,
      ]);
      // Only the cleared transcript was written.
      expect(after.map((row, index) => row.updatedAt !== before[index]?.updatedAt)).toEqual([
        true,
        false,
        false,
        false,
        false,
        false,
        false,
      ]);
      expect((await read([fileId, otherFileId])).map((row) => row.name)).toEqual([FILENAME, "Other.m4a"]);
    });
  });

  it("changes nothing on a second run", async () => {
    await runInTenant(tenant, async () => {
      const fileId = await file(FILENAME);
      const copied = await transcript({ name: FILENAME, sourceFileId: fileId });
      const kept = await transcript({ name: "Pricing call", sourceFileId: fileId });
      await run(tenant);
      const first = await read([copied, kept]);

      await run(tenant);

      expect(await read([copied, kept])).toEqual(first);
      expect(first.map((row) => row.name)).toEqual([null, "Pricing call"]);
    });
  });

  it("clears more transcripts than one page holds", async () => {
    await runInTenant(tenant, async () => {
      const fileId = await file(FILENAME);
      const ids: string[] = [];
      for (let index = 0; index < 105; index++) ids.push(await transcript({ name: FILENAME, sourceFileId: fileId }));

      await run(tenant);

      expect((await read(ids)).filter((row) => row.name !== null)).toEqual([]);
    });
  });

  it("clears only the calling tenant's transcripts", async () => {
    const mine = await runInTenant(tenant, async () =>
      transcript({ name: FILENAME, sourceFileId: await file(FILENAME) }),
    );
    const theirs = await runInTenant(foreign, async () =>
      transcript({ name: FILENAME, sourceFileId: await file(FILENAME) }),
    );

    await run(tenant);

    expect(await runInTenant(tenant, () => read([mine]))).toMatchObject([{ name: null }]);
    expect(await runInTenant(foreign, () => read([theirs]))).toMatchObject([{ name: FILENAME }]);
    await run(foreign);
    expect(await runInTenant(foreign, () => read([theirs]))).toMatchObject([{ name: null }]);
  });

  it("does nothing for a tenant without Transcripts and Files databases", async () => {
    const bare = await createTestTenant(admin);

    await expect(run(bare)).resolves.toBeUndefined();
  });
});
