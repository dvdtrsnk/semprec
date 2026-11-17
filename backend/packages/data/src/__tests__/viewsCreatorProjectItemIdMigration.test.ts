import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { ForbiddenError } from "../errors.js";

let pool: Pool;
let chokePoint: ChokePoint;

describe("views.creator_project_item_id", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint = createChokePoint(pool);
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("a view row without a creator project item stays creator_project_item_id = NULL and remains readable and adoptable", async () => {
    const db = await chokePoint.createDatabase({ name: "Tasks" });
    // A raw insert that never names creator_project_item_id, like code written before the column existed.
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
      await chokePoint.patchView({
        id: legacyViewId,
        actor: { type: "ai_agent", agentProjectItemId: agent.id },
        name: "x",
      });
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
