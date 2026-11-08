import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { DateTime } from "luxon";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runAsSystem, runInTenant } from "@semprec/shared";
import { createChokePoint, type ChokePoint } from "../chokePoint/chokePoint.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getSystemTimezone } from "../systemSettings.js";
import { prepareTaskProposal } from "../tasks/taskPreWriteTransform.js";
import { createTaskRecurrenceSetRouteHandler } from "../tasks/taskRecurrenceRoutes.js";
import { createSeriesOccurrence } from "../testSupport/taskSeriesFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let cp: ChokePoint;
let tasksId: string;
/** The tenant's own today, read once per case: the rules compare with the day in the system time zone. */
let today: DateTime;

const USER: WriterIdentity = { writerKind: "user" };
const AGENT: WriterIdentity = { writerKind: "agent" };

const day = (offset: number): string => today.plus({ days: offset }).toFormat("yyyy-MM-dd");

function write(itemId: string, propertiesPatch: Record<string, unknown>, writer?: WriterIdentity) {
  return runInTenant(tenant, () =>
    cp.updateItem({ databaseId: tasksId, itemId, propertiesPatch }, undefined, undefined, writer),
  );
}

async function stored(itemId: string): Promise<Record<string, unknown>> {
  const item = await runInTenant(tenant, () => cp.getItem(tasksId, itemId));
  if (!item) throw new Error(`Task ${itemId} missing`);
  return item.properties;
}

/** A daily series started on the day five days ago through the recurrence route. */
async function dailySeries(): Promise<string> {
  const task = await runInTenant(tenant, () =>
    cp.createItem({ databaseId: tasksId, properties: { name: "Stretch", date: day(-5) } }),
  );
  const response = await runInTenant(tenant, () =>
    createTaskRecurrenceSetRouteHandler(pool)({
      params: { id: task.id },
      body: { preset: "daily" },
      identity: { user: { id: randomUUID() } },
    }),
  );
  const seriesId = response.item.properties.seriesId;
  if (typeof seriesId !== "string") throw new Error("No series id");
  return seriesId;
}

/** A done occurrence of the series on `date` (synthetic: the #1720 materialization that stores them is not built). */
function doneOccurrence(seriesId: string, date: string): Promise<string> {
  return runInTenant(tenant, () =>
    createSeriesOccurrence(pool, { databaseId: tasksId, seriesId, occurrenceDate: date, status: "done" }),
  );
}

async function refusal(promise: Promise<unknown>): Promise<ValidationError> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof ValidationError)) throw new Error(`Expected a ValidationError, got ${String(error)}`);
  return error;
}

describe("the missed status of Tasks (issue #1668)", () => {
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
    const zone = await runInTenant(tenant, () => withTransaction(pool, (client) => getSystemTimezone(client)));
    today = DateTime.now().setZone(zone).startOf("day");
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.end();
  });

  it.each([
    ["a user", USER],
    ["an agent", AGENT],
  ])("refuses %s writing status missed with 400 and keeps the row", async (_label, writer) => {
    const task = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasksId, properties: { name: "Call", date: day(0) } }),
    );
    const before = await stored(task.id);
    expect((await refusal(write(task.id, { status: "missed" }, writer))).details).toEqual({ field: "status" });
    expect(await stored(task.id)).toEqual(before);
  });

  it("lets the Tasks module and the nightly job, system writers, store missed", async () => {
    const task = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasksId, properties: { name: "Call", date: day(-1) } }),
    );
    await write(task.id, { status: "missed" });
    expect((await stored(task.id)).status).toBe("missed");
  });

  it("accepts a user moving a missed task to done, which records the completion as for any done", async () => {
    const task = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasksId, properties: { name: "Call", date: day(-1) } }),
    );
    await write(task.id, { status: "missed" });
    await write(task.id, { status: "done" }, USER);
    expect(await stored(task.id)).toMatchObject({
      status: "done",
      completedOn: day(0),
      completedAt: expect.any(String),
    });
  });

  it("stores missed with completedOn empty when a past daily occurrence is set back from done to notDone", async () => {
    const seriesId = await dailySeries();
    const past = await doneOccurrence(seriesId, day(-3));
    expect((await stored(past)).completedOn).toBe(day(0));
    await write(past, { status: "notDone" }, USER);
    expect(await stored(past)).toMatchObject({ status: "missed", completedOn: null, completedAt: null });
  });

  it("stores notDone when today's daily occurrence is set back from done", async () => {
    const seriesId = await dailySeries();
    const current = await doneOccurrence(seriesId, day(0));
    await write(current, { status: "notDone" }, USER);
    expect(await stored(current)).toMatchObject({ status: "notDone", completedOn: null });
  });

  it("stores notDone for a task without a series set back from done, however old", async () => {
    const task = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasksId, properties: { name: "Once", date: day(-10) } }),
    );
    await write(task.id, { status: "done" }, USER);
    await write(task.id, { status: "notDone" }, USER);
    expect((await stored(task.id)).status).toBe("notDone");
  });

  it("refuses a proposal that would set status missed", async () => {
    const task = await runInTenant(tenant, () =>
      cp.createItem({ databaseId: tasksId, properties: { name: "Call", date: day(0) } }),
    );
    expect((await refusal(prepareTaskProposal({ stored: task, patch: { status: "missed" } }))).details).toEqual({
      field: "status",
    });
  });
});
