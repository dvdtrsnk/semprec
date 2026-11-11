import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import {
  createTaskRecurrenceClearRouteHandler,
  createTaskRecurrenceSetRouteHandler,
} from "../tasks/taskRecurrenceRoutes.js";
import { createTaskSeriesPatchRouteHandler } from "../tasks/taskSeriesRoutes.js";
import { createSeriesOccurrence } from "../testSupport/taskSeriesFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let cp: ChokePoint;
let tasksId: string;
const identity = { user: { id: randomUUID() } };
const WAIT_MS = 10_000;

const seriesBody = z.object({
  seriesId: z.string(),
  template: z.record(z.string(), z.unknown()),
  recurrence: z.unknown(),
  currentInstanceId: z.string(),
});

function patchSeries(seriesId: string, body: unknown) {
  return runInTenant(tenant, () => createTaskSeriesPatchRouteHandler(pool)({ params: { seriesId }, body, identity }));
}

async function stored(id: string): Promise<{ properties: Record<string, unknown>; updatedAt: string }> {
  const item = await runInTenant(tenant, () => cp.getItem(tasksId, id));
  if (!item) throw new Error(`Task ${id} missing`);
  return { properties: item.properties, updatedAt: item.updatedAt };
}

async function template(seriesId: string): Promise<unknown> {
  return runInTenant(tenant, async () => {
    const { rows } = await pool.query<{ template: unknown }>(
      "SELECT template FROM task_recurrence WHERE series_id = $1::uuid",
      [seriesId],
    );
    return rows[0]?.template;
  });
}

/** A daily series started through the recurrence route on a task dated 16 October. */
async function series(): Promise<{ seriesId: string; currentId: string }> {
  const created = await runInTenant(tenant, () =>
    cp.createItem({ databaseId: tasksId, properties: { name: "Stretch", date: "2026-10-16" } }),
  );
  const response = await runInTenant(tenant, () =>
    createTaskRecurrenceSetRouteHandler(pool)({ params: { id: created.id }, body: { preset: "daily" }, identity }),
  );
  const seriesId = response.item.properties.seriesId;
  if (typeof seriesId !== "string") throw new Error("No series id");
  return { seriesId, currentId: created.id };
}

/** A materialized occurrence of the series (synthetic: the #1720 materialization that creates them is not built). */
function occurrence(seriesId: string, occurrenceDate: string, status: string): Promise<string> {
  return runInTenant(tenant, () =>
    createSeriesOccurrence(pool, { databaseId: tasksId, seriesId, occurrenceDate, status }),
  );
}

async function refusal(write: Promise<unknown>): Promise<ValidationError> {
  const error: unknown = await write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ValidationError)) throw new Error(`Expected a ValidationError, got ${String(error)}`);
  return error;
}

describe("PATCH /api/tasks/series/:seriesId (issue #1667)", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });

  beforeEach(async () => {
    await resetDatabase(admin);
    tenant = await createTestTenant(admin);
    await runInTenant(tenant, () => seedSystem(pool, createViewTypeRegistry()));
    cp = createChokePoint(pool);
    tasksId = await runInTenant(tenant, async () => {
      const { rows } = await pool.query<{ id: string }>(
        "SELECT id FROM databases WHERE system AND owner_module_id = 'tasks'",
      );
      if (!rows[0]) throw new Error("Tasks not seeded");
      return rows[0].id;
    });
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it("changes the template, the current open occurrence and an open materialized future one to 08:00", async () => {
    const { seriesId, currentId } = await series();
    const future = await occurrence(seriesId, "2026-10-18", "notDone");
    const response = await patchSeries(seriesId, { timeFrom: "08:00" });
    expect(response.status).toBe(200);
    const body = seriesBody.parse(response.body);
    expect(body).toMatchObject({ seriesId, currentInstanceId: currentId });
    expect(body.template).toEqual({
      name: "Stretch",
      timeFrom: "08:00",
      timeTo: null,
      notifications: false,
      flagged: false,
      description: null,
    });
    expect(body.recurrence).toEqual({
      preset: "daily",
      mode: "fixed",
      rule: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
    });
    expect(await template(seriesId)).toMatchObject({ timeFrom: "08:00" });
    expect((await stored(currentId)).properties).toMatchObject({ timeFrom: "08:00", time: "08:00" });
    expect((await stored(future)).properties).toMatchObject({ timeFrom: "08:00", date: "2026-10-18" });
  });

  it("reaches the open materialized occurrences for a series id sent in upper case, and answers with the stored id", async () => {
    let started = await series();
    // Nearly every random UUID has a letter; a series whose id has none is left in the tenant and another is started.
    for (let attempt = 0; attempt < 5 && started.seriesId.toUpperCase() === started.seriesId; attempt += 1) {
      started = await series();
    }
    const { seriesId, currentId } = started;
    expect(seriesId.toUpperCase()).not.toBe(seriesId);
    const future = await occurrence(seriesId, "2026-10-18", "notDone");
    const response = await patchSeries(seriesId.toUpperCase(), { timeFrom: "08:00" });
    expect(response.status).toBe(200);
    expect((await stored(future)).properties).toMatchObject({ timeFrom: "08:00", date: "2026-10-18" });
    expect((await stored(currentId)).properties).toMatchObject({ timeFrom: "08:00" });
    expect(await template(seriesId)).toMatchObject({ timeFrom: "08:00" });
    expect(seriesBody.parse(response.body)).toMatchObject({ seriesId, currentInstanceId: currentId });
  });

  it("keeps a done, a wontDo and a missed occurrence and an open one before the current occurrence unchanged", async () => {
    const { seriesId } = await series();
    const untouched = [
      await occurrence(seriesId, "2026-10-17", "done"),
      await occurrence(seriesId, "2026-10-19", "wontDo"),
      await occurrence(seriesId, "2026-10-20", "missed"),
      await occurrence(seriesId, "2026-10-15", "notDone"),
    ];
    const before = await Promise.all(untouched.map(stored));
    await patchSeries(seriesId, { timeFrom: "08:00" });
    expect(await Promise.all(untouched.map(stored))).toEqual(before);
  });

  it("does not move an open occurrence whose date was moved on its own", async () => {
    const { seriesId } = await series();
    const moved = await occurrence(seriesId, "2026-10-18", "notDone");
    await runInTenant(tenant, () =>
      cp.updateItem({ databaseId: tasksId, itemId: moved, propertiesPatch: { date: "2026-10-21" } }),
    );
    await patchSeries(seriesId, { timeFrom: "08:00" });
    expect((await stored(moved)).properties).toMatchObject({
      date: "2026-10-21",
      occurrenceDate: "2026-10-18",
      timeFrom: "08:00",
    });
  });

  it("supplemental proxy for the absent #1720 occurrence endpoint: a generic PATCH of one occurrence changes neither the template nor the others", async () => {
    const { seriesId, currentId } = await series();
    const future = await occurrence(seriesId, "2026-10-18", "notDone");
    await patchSeries(seriesId, { timeFrom: "08:00" });
    const templateBefore = await template(seriesId);
    const futureBefore = await stored(future);
    await runInTenant(tenant, () =>
      cp.updateItem({ databaseId: tasksId, itemId: currentId, propertiesPatch: { timeFrom: "09:30" } }),
    );
    expect(await template(seriesId)).toEqual(templateBefore);
    expect(await stored(future)).toEqual(futureBefore);
  });

  it.each([
    ["date", { date: "2026-10-20" }],
    ["status", { status: "done" }],
    ["occurrenceDate", { occurrenceDate: "2026-10-20" }],
    ["completedOn", { completedOn: "2026-10-16" }],
    ["every", { every: 2 }],
    // Issue #2009 removed the Tasks property; the legacy template field is refused like any other unknown key.
    ["persistent", { persistent: true }],
  ])("refuses a patch of %s with 400 on that field and changes nothing", async (field, body) => {
    const { seriesId, currentId } = await series();
    const before = [await template(seriesId), await stored(currentId)];
    expect((await refusal(patchSeries(seriesId, body))).details).toEqual({ field });
    expect([await template(seriesId), await stored(currentId)]).toEqual(before);
  });

  it.each([
    ["a blank name", { name: " " }, "name"],
    ["an unreadable start", { timeFrom: "25:99" }, "timeFrom"],
    ["an end before the start", { timeFrom: "10:00", timeTo: "09:00" }, "timeTo"],
    ["an end without a start", { timeTo: "09:00" }, "timeTo"],
    ["a checkbox that is no boolean", { flagged: "yes" }, "flagged"],
    ["a description that is no text", { description: 5 }, "description"],
    ["a body that is no object", [], "body"],
  ])("refuses %s like the item write, with 400 on the field", async (_label, body, field) => {
    const { seriesId, currentId } = await series();
    const before = [await template(seriesId), await stored(currentId)];
    expect((await refusal(patchSeries(seriesId, body))).details).toEqual({ field });
    expect([await template(seriesId), await stored(currentId)]).toEqual(before);
  });

  it("answers an unknown and a turned-off series with not found, and a malformed id with 400", async () => {
    await expect(patchSeries(randomUUID(), { timeFrom: "08:00" })).rejects.toBeInstanceOf(NotFoundError);
    const { seriesId, currentId } = await series();
    await runInTenant(tenant, () =>
      createTaskRecurrenceClearRouteHandler(pool)({ params: { id: currentId }, body: undefined, identity }),
    );
    await expect(patchSeries(seriesId, { timeFrom: "08:00" })).rejects.toBeInstanceOf(NotFoundError);
    expect((await refusal(patchSeries("nope", { timeFrom: "08:00" }))).details).toEqual({ field: "seriesId" });
  });

  it("writes nothing for an empty patch", async () => {
    const { seriesId, currentId } = await series();
    const before = [await template(seriesId), await stored(currentId)];
    const response = await patchSeries(seriesId, {});
    expect(seriesBody.parse(response.body).currentInstanceId).toBe(currentId);
    expect([await template(seriesId), await stored(currentId)]).toEqual(before);
  });

  it("refuses with 409 when the series advanced while the edit waited for its current occurrence", async () => {
    const { seriesId, currentId } = await series();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holder: (pid: number) => void = () => undefined;
    const holderPid = new Promise<number>((resolve) => {
      holder = resolve;
    });
    // Completing the current occurrence advances the series; its transaction stays open until the edit waits on it.
    const completion = runInTenant(tenant, () =>
      withTransaction(pool, async (client: PoolClient) => {
        await updateItemWithClient(client, {
          databaseId: tasksId,
          itemId: currentId,
          propertiesPatch: { status: "done" },
        });
        holder((await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid);
        await held;
      }),
    );
    const asError = (error: unknown): Error =>
      error instanceof Error ? error : new Error("A transaction failed with a non-Error value", { cause: error });
    const completionOutcome: Promise<Error | null> = completion.then(
      () => null,
      (error: unknown) => asError(error),
    );
    let edit: Promise<unknown> | undefined;
    let waitFailure: Error | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const pid = await Promise.race([
        holderPid,
        completionOutcome.then((error) => Promise.reject(error ?? new Error("The completion ended before holding"))),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("The completion did not start")), WAIT_MS);
        }),
      ]);
      // Started only once the completion holds the occurrence, so the edit is the one that waits.
      edit = patchSeries(seriesId, { timeFrom: "08:00" }).then(
        () => undefined,
        (error: unknown) => error,
      );
      const deadline = Date.now() + WAIT_MS;
      for (;;) {
        const { rows } = await admin.query<{ waiting: boolean }>(
          "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))) AS waiting",
          [pid],
        );
        if (rows[0]?.waiting === true) break;
        if (Date.now() > deadline) throw new Error("The edit never waited on the completion");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } catch (error) {
      waitFailure = asError(error);
    } finally {
      clearTimeout(timer);
      release();
    }
    // Both transactions settle before any failure is reported; the completion's own error comes first.
    const completionError = await completionOutcome;
    const error = edit === undefined ? undefined : await edit;
    if (completionError !== null) throw completionError;
    if (waitFailure !== null) throw waitFailure;
    expect(error).toBeInstanceOf(ConflictError);
    expect(await template(seriesId)).toMatchObject({ timeFrom: null });
  });
});
