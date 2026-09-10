import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ForbiddenError } from "../errors.js";

const MIGRATION_SQL = await readFile(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "../db/migrations/0037_views_creator_project_item_id.sql"),
  "utf8",
);

let pool: Pool;
let chokePoint: ChokePoint;

describe("0037_views_creator_project_item_id migration", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("is purely additive (expand-only) — no DROP, RENAME, or NOT NULL on an existing column", () => {
    const statements = MIGRATION_SQL.toUpperCase();
    expect(statements).not.toMatch(/DROP\s+(COLUMN|TABLE)/);
    expect(statements).not.toMatch(/RENAME/);
    expect(statements).not.toMatch(/SET\s+NOT\s+NULL/);
    expect(statements).toContain("ADD COLUMN CREATOR_PROJECT_ITEM_ID");
  });

  it("a view row provisioned before this migration existed stays creator_project_item_id = NULL and remains readable and adoptable", async () => {
    const db = await chokePoint.createDatabase({ name: "Tasks" });
    // Simulates a pre-#87 'ai_agent' row: the column already exists in this schema (migrations
    // run once, globally, before any test — see testSupport/globalSetup.ts), so "provisioned
    // before this migration" is modeled the same way every other migration test in this suite
    // models pre-existing data — a raw insert that never names the new column, the same shape
    // pre-migration application code would have written.
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO views (database_id, type, name, config, is_default, owner_module_id, created_by)
       VALUES ($1, 'table', 'Legacy agent view', '{}'::jsonb, false, NULL, 'ai_agent')
       RETURNING id`,
      [db.id],
    );
    const legacyViewId = rows[0]!.id;

    const view = await chokePoint.getView(legacyViewId);
    expect(view).not.toBeNull();
    expect(view!.createdBy).toBe("ai_agent");
    expect(view!.creatorProjectItemId).toBeNull();

    const { rows: columnRows } = await pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'views' AND column_name = 'creator_project_item_id'`,
    );
    expect(columnRows[0]?.is_nullable).toBe("YES");

    // Legacy safety end to end: unwritable by any agent, but a user may still adopt it.
    const projectsDb = await chokePoint.createDatabase({
      name: null,
      key: "projects",
      system: true,
      ownerModuleId: "projects",
    });
    const agent = await chokePoint.createItem({ databaseId: projectsDb.id, properties: {} });
    try {
      await chokePoint.patchView({ id: legacyViewId, actor: { type: "ai_agent", agentProjectItemId: agent.id }, name: "x" });
      expect.unreachable("expected ForbiddenError");
    } catch (err) {
      expect(err).toBeInstanceOf(ForbiddenError);
      expect((err as ForbiddenError).code).toBe("owner_violation");
      expect((err as ForbiddenError).details).toEqual({
        field: "creatorProjectItemId",
        viewId: legacyViewId,
        reason: "legacy_creator_unknown",
      });
    }
    const adopted = await chokePoint.patchView({ id: legacyViewId, actor: { type: "user" }, name: "Adopted" });
    expect(adopted.createdBy).toBe("user");
    expect(adopted.creatorProjectItemId).toBeNull();
  });
});
