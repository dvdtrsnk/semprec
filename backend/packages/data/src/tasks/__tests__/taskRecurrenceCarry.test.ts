import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import "../../domainWriteHooks.js";
import { createChokePoint, type ChokePoint } from "../../chokePoint/chokePoint.js";
import { createRelationWithClient } from "../../chokePoint/relationOps.js";
import * as relationsStore from "../../chokePoint/relationsStore.js";
import {
  insertValueLink,
  listValueLinksByItemIds,
  listValueLinkSourcesByLinkIds,
} from "../../chokePoint/valueLinksStore.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { startTaskSeries } from "../../testSupport/taskSeriesFixtures.js";
import type { TaskRecurrenceRule } from "../taskRecurrenceRule.js";
import type { TaskRecurrenceTemplate } from "../taskRecurrenceStore.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let cp: ChokePoint;
let databases: Record<string, string>;

const TASKS_CONTEXT = { ownerProcess: TASKS_MODULE_ID };

async function propertyId(databaseKey: string, key: string): Promise<string> {
  const { rows } = await runInTenant(tenant, () =>
    pool.query<{ id: string }>("SELECT id FROM properties WHERE database_id = $1 AND key = $2", [
      databases[databaseKey],
      key,
    ]),
  );
  if (!rows[0]) throw new Error(`Property ${databaseKey}.${key} missing`);
  return rows[0].id;
}

async function link(
  propertyKey: [string, string],
  callerItemId: string,
  targetItemId: string,
  metadata?: Record<string, unknown>,
) {
  const relationPropertyId = await propertyId(...propertyKey);
  await runInTenant(tenant, () =>
    withTransaction(pool, (client) =>
      createRelationWithClient(client, { relationPropertyId, callerItemId, targetItemId, metadata }, TASKS_CONTEXT),
    ),
  );
}

/** Every edge of `itemId` as `<counterpart> <metadata>`, sorted, together with the Tasks-side property key. */
async function edgesOf(itemId: string): Promise<string[]> {
  return runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const edges = await relationsStore.listAllRelationsForItem(client, itemId);
      const out: string[] = [];
      for (const edge of edges) {
        const { rows } = await client.query<{ key: string }>(
          `SELECT p.key FROM relation_definitions r JOIN properties p
             ON p.id = CASE WHEN $2::boolean THEN r.property_id_a ELSE r.property_id_b END
           WHERE r.id = $1`,
          [edge.relationDefinitionId, edge.itemA === itemId],
        );
        const counterpart = edge.itemA === itemId ? edge.itemB : edge.itemA;
        out.push(`${rows[0]?.key ?? "(no task side)"} ${counterpart} ${JSON.stringify(edge.metadata)}`);
      }
      return out.sort();
    }),
  );
}

const nextOccurrenceId = async (seriesId: string, previousId: string): Promise<string> => {
  const { rows } = await runInTenant(tenant, () =>
    pool.query<Record<string, unknown>>(
      "SELECT id FROM items WHERE properties->>'seriesId' = $1 AND id <> $2 AND deleted_at IS NULL",
      [seriesId, previousId],
    ),
  );
  return z
    .array(z.object({ id: z.string() }))
    .length(1)
    .parse(rows)[0]!.id;
};

describe("carrying Tasks fields and relations to the next recurring instance (issue #1673)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool));
    cp = createChokePoint(pool);
    const { rows } = await runInTenant(tenant, () =>
      pool.query<{ id: string; owner_module_id: string }>("SELECT id, owner_module_id FROM databases"),
    );
    databases = Object.fromEntries(rows.map((row) => [row.owner_module_id, row.id]));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  const create = (databaseKey: string, properties: Record<string, unknown>) =>
    runInTenant(tenant, () => cp.createItem({ databaseId: databases[databaseKey]!, properties }));

  async function recurringTask() {
    const task = await create("tasks", {
      name: "Weekly review",
      date: "2026-10-12",
      flagged: true,
      description: "Check the open loops",
    });
    const seriesId = await runInTenant(tenant, () =>
      startTaskSeries(pool, {
        databaseId: databases.tasks!,
        itemId: task.id,
        mode: "fixed",
        rule: { kind: "weekdays", days: ["mon"] },
      }),
    );
    return { task, seriesId };
  }

  it("keeps flag, description, project, people and file, and drops action-item, host-event and completed-in-event edges", async () => {
    const { task, seriesId } = await recurringTask();
    const project = await create("projects", { name: "Household" });
    const alice = await create("people", { name: "Alice" });
    const bob = await create("people", { name: "Bob" });
    const file = await create("files", { name: "Checklist.pdf" });
    const standup = await create("events", { name: "Standup", date: "2026-10-16" });
    const workshop = await create("events", { name: "Workshop", date: "2026-10-16" });
    const retro = await create("events", { name: "Retro", date: "2026-10-16" });
    await link(["tasks", "project"], task.id, project.id);
    await link(["tasks", "people"], task.id, alice.id, { role: "owner" });
    await link(["tasks", "people"], task.id, bob.id);
    await link(["tasks", "files"], task.id, file.id);
    await link(["events", "actionItems"], standup.id, task.id);
    await link(["tasks", "hostEvents"], task.id, workshop.id);
    await link(["events", "completedTasks"], retro.id, task.id);

    await runInTenant(tenant, () =>
      cp.updateItem({ databaseId: databases.tasks!, itemId: task.id, propertiesPatch: { status: "done" } }),
    );
    const nextId = await nextOccurrenceId(seriesId, task.id);
    const next = await runInTenant(tenant, () => cp.getItem(databases.tasks!, nextId));
    expect(next?.properties).toMatchObject({ flagged: true, description: "Check the open loops", status: "notDone" });
    expect(await edgesOf(nextId)).toEqual(
      [
        `files ${file.id} {}`,
        `people ${alice.id} {"role":"owner"}`,
        `people ${bob.id} {}`,
        `project ${project.id} {}`,
      ].sort(),
    );
    // The completed instance keeps every edge it had.
    expect(await edgesOf(task.id)).toHaveLength(7);
  });

  it("defaults flag to false and description to null when the task has neither", async () => {
    const task = await create("tasks", { name: "Plain", date: "2026-10-12" });
    const seriesId = await runInTenant(tenant, () =>
      startTaskSeries(pool, {
        databaseId: databases.tasks!,
        itemId: task.id,
        mode: "fixed",
        rule: { kind: "weekdays", days: ["mon"] },
      }),
    );
    await runInTenant(tenant, () =>
      cp.updateItem({ databaseId: databases.tasks!, itemId: task.id, propertiesPatch: { status: "done" } }),
    );
    const next = await runInTenant(tenant, async () =>
      cp.getItem(databases.tasks!, await nextOccurrenceId(seriesId, task.id)),
    );
    expect(next?.properties).toMatchObject({ flagged: false, description: null });
  });

  it("takes flag and description from the completed occurrence after edits and leaves the template as it was", async () => {
    const weekly: TaskRecurrenceRule = { kind: "weekdays", days: ["mon"] };
    const start = async (properties: Record<string, unknown>, template?: Partial<TaskRecurrenceTemplate>) => {
      const task = await create("tasks", { name: "Review", date: "2026-10-12", ...properties });
      const seriesId = await runInTenant(tenant, () =>
        startTaskSeries(pool, { databaseId: databases.tasks!, itemId: task.id, mode: "fixed", rule: weekly, template }),
      );
      return { task, seriesId };
    };
    const patch = (itemId: string, propertiesPatch: Record<string, unknown>) =>
      runInTenant(tenant, () => cp.updateItem({ databaseId: databases.tasks!, itemId, propertiesPatch }));
    const templateOf = async (seriesId: string) => {
      const { rows } = await runInTenant(tenant, () =>
        pool.query<{ template: unknown }>("SELECT template FROM task_recurrence WHERE series_id = $1", [seriesId]),
      );
      return rows[0]?.template;
    };
    const nextOf = async (seriesId: string, previousId: string) =>
      (
        await runInTenant(tenant, async () =>
          cp.getItem(databases.tasks!, await nextOccurrenceId(seriesId, previousId)),
        )
      )?.properties;

    const edited = await start({ flagged: true, description: "Before" });
    const editedTemplate = await templateOf(edited.seriesId);
    await patch(edited.task.id, { flagged: false, description: "After" });
    await patch(edited.task.id, { status: "done" });
    expect(await nextOf(edited.seriesId, edited.task.id)).toMatchObject({ flagged: false, description: "After" });
    expect(editedTemplate).toMatchObject({ flagged: true, description: "Before" });
    expect(await templateOf(edited.seriesId)).toEqual(editedTemplate);

    const cleared = await start({ flagged: false, description: "Notes" });
    await patch(cleared.task.id, { flagged: true, description: null });
    await patch(cleared.task.id, { status: "done" });
    expect(await nextOf(cleared.seriesId, cleared.task.id)).toMatchObject({ flagged: true, description: null });

    const absent = await start({}, { flagged: true, description: "Template only" });
    const absentTask = await runInTenant(tenant, () => cp.getItem(databases.tasks!, absent.task.id));
    expect(absentTask?.properties.flagged).toBeUndefined();
    expect(absentTask?.properties.description).toBeUndefined();
    await patch(absent.task.id, { status: "done" });
    expect(await nextOf(absent.seriesId, absent.task.id)).toMatchObject({ flagged: false, description: null });
    expect(await templateOf(absent.seriesId)).toMatchObject({ flagged: true, description: "Template only" });
  });

  it("skips an edge whose counterpart is in the trash and still advances", async () => {
    const { task, seriesId } = await recurringTask();
    const alice = await create("people", { name: "Alice" });
    const bob = await create("people", { name: "Bob" });
    await link(["tasks", "people"], task.id, alice.id);
    await link(["tasks", "people"], task.id, bob.id);
    await runInTenant(tenant, () => cp.softDeleteItem(databases.people!, bob.id));

    await runInTenant(tenant, () =>
      cp.updateItem({ databaseId: databases.tasks!, itemId: task.id, propertiesPatch: { status: "done" } }),
    );
    expect(await edgesOf(await nextOccurrenceId(seriesId, task.id))).toEqual([`people ${alice.id} {}`]);
  });

  it("moves the value-link sources of the completed task to the next instance", async () => {
    const { task, seriesId } = await recurringTask();
    const file = await create("files", { name: "Checklist.pdf" });
    await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        insertValueLink(client, {
          itemId: file.id,
          propertyKey: "projects",
          ruleKey: "test.taskProjectToFiles",
          sources: [{ kind: "item", sourceItemId: task.id, sourcePropertyKey: "project" }],
        }),
      ),
    );
    await runInTenant(tenant, () =>
      cp.updateItem({ databaseId: databases.tasks!, itemId: task.id, propertiesPatch: { status: "done" } }),
    );
    const nextId = await nextOccurrenceId(seriesId, task.id);
    const sources = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const links = await listValueLinksByItemIds(client, [file.id]);
        expect(links.map((l) => [l.propertyKey, l.state])).toEqual([["projects", "on"]]);
        return listValueLinkSourcesByLinkIds(
          client,
          links.map((l) => l.id),
        );
      }),
    );
    expect(sources).toEqual([
      expect.objectContaining({ kind: "item", sourceItemId: nextId, sourcePropertyKey: "project" }),
    ]);
  });

  it("rolls back the completion and the new instance when the advance fails after creating it", async () => {
    const { task, seriesId } = await recurringTask();
    const project = await create("projects", { name: "Household" });
    await link(["tasks", "project"], task.id, project.id);
    // Fault injection: the series row move runs after the next instance was inserted. Each instrument is dropped
    // only when it was created, each drop is attempted on its own, and the test's own failure is reported first.
    let functionCreated = false;
    let triggerCreated = false;
    let failure: { error: unknown } | undefined;
    try {
      await admin.query(
        `CREATE FUNCTION test_fail_series_move() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'injected series move failure'; END $$`,
      );
      functionCreated = true;
      await admin.query(
        "CREATE TRIGGER test_fail_series_move BEFORE UPDATE OF item_id ON task_recurrence FOR EACH ROW EXECUTE FUNCTION test_fail_series_move()",
      );
      triggerCreated = true;
      await expect(
        runInTenant(tenant, () =>
          cp.updateItem({ databaseId: databases.tasks!, itemId: task.id, propertiesPatch: { status: "done" } }),
        ),
      ).rejects.toThrow(/injected series move failure/);
    } catch (error) {
      failure = { error };
    }
    const cleanup: unknown[] = [];
    if (triggerCreated) {
      try {
        await admin.query("DROP TRIGGER test_fail_series_move ON task_recurrence");
      } catch (error) {
        cleanup.push(error);
      }
    }
    if (functionCreated) {
      try {
        await admin.query("DROP FUNCTION test_fail_series_move()");
      } catch (error) {
        cleanup.push(error);
      }
    }
    if (failure && cleanup.length > 0) throw new AggregateError([failure.error, ...cleanup], "Test and cleanup failed");
    if (failure) throw failure.error;
    if (cleanup.length > 0) throw new AggregateError(cleanup, "Fault-injection cleanup failed");
    const { rows } = await runInTenant(tenant, () =>
      pool.query<{ id: string; status: string }>(
        "SELECT id, properties->>'status' AS status FROM items WHERE properties->>'seriesId' = $1",
        [seriesId],
      ),
    );
    expect(rows).toEqual([{ id: task.id, status: "notDone" }]);
    const { rows: series } = await runInTenant(tenant, () =>
      pool.query<{ item_id: string }>("SELECT item_id FROM task_recurrence WHERE series_id = $1", [seriesId]),
    );
    expect(series).toEqual([{ item_id: task.id }]);
    expect(await edgesOf(project.id)).toEqual([`tasks ${task.id} {}`]);
  });
});
