import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { withTransaction } from "../db/pool.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { seedSystem } from "../seed/seedSystem.js";

let pool: Pool;

describe("resolveMailModuleIds (issue #648)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("resolves each mail database id to the seeded database owned by its module", async () => {
    await seedSystem(pool);

    const ids = await withTransaction(pool, (client) => resolveMailModuleIds(client));

    const { rows } = await pool.query<{ id: string; owner_module_id: string }>(
      `SELECT id, owner_module_id FROM databases WHERE id = ANY($1::uuid[])`,
      [Object.values(ids)],
    );
    const ownerById = new Map(rows.map((row) => [row.id, row.owner_module_id]));
    expect(ownerById.get(ids.emailsDatabaseId)).toBe("emails");
    expect(ownerById.get(ids.filesDatabaseId)).toBe("files");
    expect(ownerById.get(ids.foldersDatabaseId)).toBe("folders");
    expect(ownerById.get(ids.mailboxesDatabaseId)).toBe("mailboxes");
    expect(ownerById.size).toBe(4);
  });

  it("throws naming every missing module id and the seed CLI on an unseeded database", async () => {
    await expect(withTransaction(pool, (client) => resolveMailModuleIds(client))).rejects.toThrow(
      "Mail module databases are not seeded (missing: emails, files, folders, mailboxes) — run packages/data/dist/db/runSeedCli.js",
    );
  });
});
