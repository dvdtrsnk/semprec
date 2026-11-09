import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { runInTenant, type SempMessageRef } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createSeriesOccurrence, startTaskSeries } from "../testSupport/taskSeriesFixtures.js";
import {
  createChokePoint,
  getDatabaseByModuleId,
  readSempRefContext,
  seedSystem,
  validateSempMessageRefs,
  withTransaction,
} from "../index.js";
import { resolveSempHistoryContexts } from "../semp/sempRefHistory.js";

/** A tenant with a recurring task, its project, person and attachment, and one plain (non-Tasks) item. */
interface Fixture {
  tenant: string;
  tasksId: string;
  task: { id: string };
  seriesId: string;
  materialized: { id: string };
  deletedTask: { id: string };
  plain: { id: string; databaseId: string };
}

describe("Semp task references (issue #1771)", () => {
  let admin: Pool;
  let runtime: Pool;
  let cp: ReturnType<typeof createChokePoint>;
  let a: Fixture;
  let b: Fixture;

  async function moduleDatabaseId(tenant: string, moduleId: string): Promise<string> {
    const database = await runInTenant(tenant, () =>
      withTransaction(runtime, (client) => getDatabaseByModuleId(client, moduleId)),
    );
    if (!database) throw new Error(`Missing ${moduleId} database`);
    return database.id;
  }

  async function relate(tenant: string, databaseId: string, key: string, callerItemId: string, targetItemId: string) {
    const property = (await runInTenant(tenant, () => cp.listProperties(databaseId))).find((p) => p.key === key);
    if (!property) throw new Error(`Missing relation ${key}`);
    await runInTenant(tenant, () => cp.createRelation({ relationPropertyId: property.id, callerItemId, targetItemId }));
  }

  async function fixture(): Promise<Fixture> {
    const tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(runtime));
    const tasksId = await moduleDatabaseId(tenant, "tasks");
    const create = (databaseId: string, properties: Record<string, unknown>) =>
      runInTenant(tenant, () => cp.createItem({ databaseId, properties }));
    const task = await create(tasksId, {
      name: "Weekly review",
      date: "2026-11-02",
      timeFrom: "09:00",
      timeTo: "09:30",
      description: "Check the plan",
    });
    const project = await create(await moduleDatabaseId(tenant, "projects"), { name: "Apollo" });
    const person = await create(await moduleDatabaseId(tenant, "people"), { name: "Marie" });
    const file = await create(await moduleDatabaseId(tenant, "files"), { name: "agenda.pdf" });
    await relate(tenant, tasksId, "project", task.id, project.id);
    await relate(tenant, tasksId, "people", task.id, person.id);
    await relate(tenant, tasksId, "files", task.id, file.id);
    const seriesId = await runInTenant(tenant, () =>
      startTaskSeries(runtime, {
        databaseId: tasksId,
        itemId: task.id,
        mode: "fixed",
        rule: { kind: "weekdays", days: ["mon"] },
      }),
    );
    const materializedId = await runInTenant(tenant, () =>
      createSeriesOccurrence(runtime, {
        databaseId: tasksId,
        seriesId,
        occurrenceDate: "2026-11-09",
        status: "notDone",
      }),
    );
    const deletedTask = await create(tasksId, { name: "Deleted later", date: "2026-11-03" });
    const plain = await create(await moduleDatabaseId(tenant, "projects"), { name: "Not a task" });
    return {
      tenant,
      tasksId,
      task,
      seriesId,
      materialized: { id: materializedId },
      deletedTask,
      plain: { id: plain.id, databaseId: plain.databaseId },
    };
  }

  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    cp = createChokePoint(runtime);
    a = await fixture();
    b = await fixture();
    await runInTenant(a.tenant, () => cp.softDeleteItem(a.tasksId, a.deletedTask.id));
  });
  afterAll(async () => {
    const results = await Promise.allSettled([runtime?.end(), admin?.end()]);
    const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (errors.length) throw new AggregateError(errors, "Pool cleanup failed", { cause: errors[0] });
  });

  const inA = <T>(fn: (client: Parameters<Parameters<typeof withTransaction>[1]>[0]) => Promise<T>) =>
    runInTenant(a.tenant, () => withTransaction(runtime, fn));

  const occurrence = (seriesId: string, occurrenceDate = "2026-11-16"): SempMessageRef => ({
    kind: "taskOccurrence",
    seriesId,
    occurrenceDate,
  });
  const trace = (itemId: string, databaseId: string, traceDay = "2026-11-02"): SempMessageRef => ({
    kind: "taskTrace",
    itemId,
    databaseId,
    traceDay,
  });

  describe("validation", () => {
    it("accepts an occurrence of an own series and a trace of an own live task, without any item id on the occurrence", async () => {
      const refs = [occurrence(a.seriesId), trace(a.task.id, a.tasksId)];
      expect(await inA((client) => validateSempMessageRefs(client, refs))).toEqual(refs);
    });

    it("refuses another tenant's series and an unknown one with the same error, and nothing else differs", async () => {
      const error = async (ref: SempMessageRef) =>
        inA((client) => validateSempMessageRefs(client, [ref])).then(
          () => null,
          (caught: unknown) => caught,
        );
      const foreign = await error(occurrence(b.seriesId));
      const unknown = await error(occurrence(randomUUID()));
      const notUuid = await error(occurrence("not-a-uuid"));
      expect(foreign).toMatchObject({ code: "validation_failed", details: { field: "context[0]" } });
      for (const other of [unknown, notUuid]) {
        expect(other).toMatchObject({ code: "validation_failed", details: { field: "context[0]" } });
        expect(JSON.stringify(other)).toBe(JSON.stringify(foreign));
      }
    });

    it("refuses a trace whose item is not a Tasks item, is deleted, belongs to another tenant or names the wrong database", async () => {
      const attempts: SempMessageRef[] = [
        trace(a.plain.id, a.plain.databaseId),
        trace(a.deletedTask.id, a.tasksId),
        trace(b.task.id, b.tasksId),
        trace(a.task.id, a.plain.databaseId),
        trace(randomUUID(), a.tasksId),
      ];
      for (const ref of attempts) {
        await expect(inA((client) => validateSempMessageRefs(client, [ref]))).rejects.toMatchObject({
          code: "validation_failed",
          details: { field: "context[0]" },
        });
      }
    });

    it("stores first-occurrence deduplicated refs, distinguishing days and trace days", async () => {
      const refs = [
        occurrence(a.seriesId, "2026-11-16"),
        occurrence(a.seriesId, "2026-11-16"),
        occurrence(a.seriesId, "2026-11-23"),
        trace(a.task.id, a.tasksId, "2026-11-02"),
        trace(a.task.id, a.tasksId, "2026-11-02"),
        trace(a.task.id, a.tasksId, "2026-11-03"),
      ];
      expect(await inA((client) => validateSempMessageRefs(client, refs))).toEqual([
        refs[0],
        refs[2],
        refs[3],
        refs[5],
      ]);
    });
  });

  describe("expansion context", () => {
    const read = (ref: SempMessageRef) => inA((client) => readSempRefContext(client, ref));

    it("gives a non-materialized occurrence the series template, the day and the series' relations", async () => {
      const context = await read(occurrence(a.seriesId, "2026-11-16"));
      expect(context).toMatchObject({
        label: "Weekly review",
        state: "active",
        details: {
          series: {
            seriesId: a.seriesId,
            mode: "fixed",
            rule: { kind: "weekdays", days: ["mon"] },
            anchorDate: "2026-11-02",
          },
          template: {
            name: "Weekly review",
            timeFrom: "09:00",
            timeTo: "09:30",
            notifications: false,
            flagged: false,
            description: "Check the plan",
          },
          occurrenceDate: "2026-11-16",
          relations: {
            project: { names: ["Apollo"], truncated: false },
            people: { names: ["Marie"], truncated: false },
            files: { names: ["agenda.pdf"], truncated: false },
          },
        },
      });
      // The legacy `persistent` flag of a stored template is never shown.
      expect(JSON.stringify(context)).not.toContain("persistent");
    });

    it("gives a materialized occurrence's day the same series context", async () => {
      const context = await read(occurrence(a.seriesId, "2026-11-09"));
      expect(context).toMatchObject({ label: "Weekly review", details: { occurrenceDate: "2026-11-09" } });
      expect(a.materialized.id).toEqual(expect.any(String));
    });

    it("gives a trace the task with its relations and the trace day", async () => {
      const context = await read(trace(a.task.id, a.tasksId, "2026-11-02"));
      expect(context).toMatchObject({
        label: "Weekly review",
        state: "active",
        details: {
          properties: { name: "Weekly review", date: "2026-11-02", timeFrom: "09:00", description: "Check the plan" },
          relations: { project: { names: ["Apollo"] }, people: { names: ["Marie"] }, files: { names: ["agenda.pdf"] } },
          traceDay: "2026-11-02",
        },
      });
    });

    it("includes a task item ref's attachments by name, and keeps other databases to the common relations", async () => {
      const context = await read({ kind: "item", itemId: a.task.id, databaseId: a.tasksId });
      expect(context).toMatchObject({
        details: {
          relations: { project: { names: ["Apollo"] }, people: { names: ["Marie"] }, files: { names: ["agenda.pdf"] } },
        },
      });
    });

    it("is unavailable for a series or a task that is gone, another tenant's, or not a task", async () => {
      await runInTenant(a.tenant, () =>
        withTransaction(runtime, (client) =>
          client.query("DELETE FROM task_recurrence WHERE series_id = $1", [a.seriesId]),
        ),
      );
      expect(await read(occurrence(a.seriesId))).toBeNull();
      expect(await read(occurrence(randomUUID()))).toBeNull();
      expect(await read(occurrence("not-a-uuid"))).toBeNull();
      expect(await read(occurrence(b.seriesId))).toBeNull();
      expect(await read(trace(a.deletedTask.id, a.tasksId))).toBeNull();
      expect(await read(trace(b.task.id, b.tasksId))).toBeNull();
      expect(await read(trace(a.plain.id, a.plain.databaseId))).toBeNull();
      expect(await read(trace(a.task.id, a.plain.databaseId))).toBeNull();
    });
  });

  describe("history labels", () => {
    it("resolves both kinds by their current names and purges a missing series or task", async () => {
      const contexts = [
        [
          { ...occurrence(b.seriesId), label: "Saved" },
          { ...occurrence(randomUUID()), label: "Gone" },
          { ...occurrence("not-a-uuid"), label: "Odd" },
          { ...trace(b.task.id, b.tasksId), label: "Saved trace" },
          { ...trace(randomUUID(), b.tasksId), label: "Gone trace" },
        ],
      ];
      const resolved = await runInTenant(b.tenant, () =>
        withTransaction(runtime, (client) => resolveSempHistoryContexts(client, contexts)),
      );
      expect(resolved).toEqual([
        [
          { ...contexts[0]?.[0], resolved: { label: "Weekly review", databaseKey: "tasks", state: "active" } },
          { ...contexts[0]?.[1], resolved: { label: null, databaseKey: null, state: "purged" } },
          { ...contexts[0]?.[2], resolved: { label: null, databaseKey: null, state: "purged" } },
          { ...contexts[0]?.[3], resolved: { label: "Weekly review", databaseKey: "tasks", state: "active" } },
          { ...contexts[0]?.[4], resolved: { label: null, databaseKey: null, state: "purged" } },
        ],
      ]);
    });
  });
});
