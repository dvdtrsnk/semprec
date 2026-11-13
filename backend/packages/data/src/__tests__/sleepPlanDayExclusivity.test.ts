import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DatabaseError, type Pool, type PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { updateItemWithClient } from "../chokePoint/itemWrites.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { SLEEP_PLANS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

const USER = { writerKind: "user" } as const;

interface PlanTenant {
  tenantId: string;
  plansId: string;
}

interface StoredPlan {
  id: string;
  wakeDays: unknown;
  /** The seconds since the epoch of the row's `updated_at`. */
  updatedAt: number;
}

interface PlanRow {
  id: string;
  wake_days: unknown;
  updated_at: number;
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

let adminPool: Pool;
let dataPool: Pool;
let tenant: PlanTenant;
let other: PlanTenant;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

function deferred(): Deferred {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A new tenant seeded as production seeds one: a weekday plan (mon to fri) and a weekend plan (sat, sun). */
async function seededTenant(): Promise<PlanTenant> {
  const tenantId = await createTestTenant(adminPool);
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  const database = await inTenant(tenantId, (client) =>
    databasesStore.getDatabaseByModuleId(client, SLEEP_PLANS_MODULE_ID),
  );
  if (!database) throw new Error("The tenant has no sleepPlans database");
  return { tenantId, plansId: database.id };
}

function chokePoint(t: PlanTenant) {
  return {
    create: (properties: Record<string, unknown>) =>
      runInTenant(t.tenantId, () =>
        createChokePoint(dataPool).createItem({ databaseId: t.plansId, properties }, undefined, undefined, USER),
      ),
    patch: (itemId: string, propertiesPatch: Record<string, unknown>) =>
      runInTenant(t.tenantId, () =>
        createChokePoint(dataPool).updateItem(
          { databaseId: t.plansId, itemId, propertiesPatch },
          undefined,
          undefined,
          USER,
        ),
      ),
    trash: (itemId: string) =>
      runInTenant(t.tenantId, () => createChokePoint(dataPool).softDeleteItem(t.plansId, itemId, undefined, USER)),
  };
}

/** A plan with the two required times; `position` is left to the caller's `extra`. */
function planProperties(name: string, wakeDays: string[], extra: Record<string, unknown> = {}) {
  return { name, wakeDays, bedTime: "23:00", wakeTime: "07:00", alarm: true, ...extra };
}

/** Every plan of the database, trashed ones included, by id. */
async function storedPlans(t: PlanTenant): Promise<StoredPlan[]> {
  return inTenant(t.tenantId, async (client) => {
    const { rows } = await client.query<PlanRow>(
      `SELECT id, properties -> 'wakeDays' AS wake_days, extract(epoch FROM updated_at)::float8 AS updated_at
         FROM items WHERE database_id = $1 ORDER BY id`,
      [t.plansId],
    );
    return rows.map((row) => ({ id: row.id, wakeDays: row.wake_days, updatedAt: row.updated_at }));
  });
}

async function plan(t: PlanTenant, planId: string): Promise<StoredPlan> {
  const found = (await storedPlans(t)).find((candidate) => candidate.id === planId);
  if (!found) throw new Error(`Plan ${planId} is not stored`);
  return found;
}

/** The seeded plan that holds the day. */
async function seededPlanHolding(t: PlanTenant, day: string): Promise<StoredPlan> {
  const found = (await storedPlans(t)).find(
    (candidate) => Array.isArray(candidate.wakeDays) && candidate.wakeDays.includes(day),
  );
  if (!found) throw new Error(`No plan holds ${day}`);
  return found;
}

/** The ids of the live plans that hold the day. */
async function plansHolding(t: PlanTenant, day: string): Promise<string[]> {
  return inTenant(t.tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM items WHERE database_id = $1 AND deleted_at IS NULL AND properties -> 'wakeDays' ? $2 ORDER BY id",
      [t.plansId, day],
    );
    return rows.map((row) => row.id);
  });
}

/**
 * Writes the plan through the choke point's update inside a transaction that stays open until `release` is called:
 * `written` resolves once the write and its hooks ran, `done` settles when the transaction has ended.
 */
function holdPlanWriteOpen(t: PlanTenant, planId: string, wakeDays: string[]) {
  const written = deferred();
  const released = deferred();
  const done = inTenant(t.tenantId, async (client) => {
    await updateItemWithClient(
      client,
      { databaseId: t.plansId, itemId: planId, propertiesPatch: { wakeDays } },
      { writer: USER },
    );
    written.resolve();
    await released.promise;
  });
  return { written: written.promise, release: released.resolve, done };
}

/**
 * Waits until a transaction waits for a row lock. `pg_locks` is the server's own view of that wait, so no timing
 * guess stands in for it.
 */
async function waitForRowLockWaiter(): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await adminPool.query<{ waiting: number }>(
      "SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype IN ('transactionid', 'tuple') AND NOT granted",
    );
    if ((rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("No transaction waited for a row lock");
}

function asDays(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error("wakeDays is not a list");
  return value.map((day) => String(day));
}

async function refusal(write: Promise<unknown>): Promise<unknown> {
  return write.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
}

beforeAll(async () => {
  adminPool = getTestPool();
  dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  const role = await dataPool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
  );
  expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
});

beforeEach(async () => {
  await resetDatabase(adminPool);
  tenant = await seededTenant();
  other = await seededTenant();
});

afterAll(async () => {
  await dataPool?.end();
  await adminPool?.end();
});

describe("a wake day is in at most one sleep plan (issue gh-1799)", () => {
  it("takes fri from the weekday plan when the weekend plan is patched to fri, sat and sun", async () => {
    const weekday = await seededPlanHolding(tenant, "mon");
    const weekend = await seededPlanHolding(tenant, "sat");
    expect(weekday.wakeDays).toEqual(["mon", "tue", "wed", "thu", "fri"]);

    await chokePoint(tenant).patch(weekend.id, { wakeDays: ["fri", "sat", "sun"] });

    const weekdayAfter = await plan(tenant, weekday.id);
    const weekendAfter = await plan(tenant, weekend.id);
    expect(weekdayAfter.wakeDays).toEqual(["mon", "tue", "wed", "thu"]);
    expect(weekendAfter.wakeDays).toEqual(["fri", "sat", "sun"]);
    expect(weekdayAfter.updatedAt).toBeGreaterThan(weekday.updatedAt);
    expect(weekendAfter.updatedAt).toBeGreaterThan(weekend.updatedAt);
  });

  it("makes the removal in the write's own transaction: visible inside it, rolled back with it", async () => {
    const weekday = await seededPlanHolding(tenant, "mon");
    const weekend = await seededPlanHolding(tenant, "sat");
    const rollback = new Error("roll the transaction back");

    const thrown = await refusal(
      inTenant(tenant.tenantId, async (client) => {
        await updateItemWithClient(
          client,
          { databaseId: tenant.plansId, itemId: weekend.id, propertiesPatch: { wakeDays: ["fri", "sat", "sun"] } },
          { writer: USER },
        );
        const { rows } = await client.query<{ wake_days: unknown }>(
          "SELECT properties -> 'wakeDays' AS wake_days FROM items WHERE id = $1",
          [weekday.id],
        );
        expect(rows).toEqual([{ wake_days: ["mon", "tue", "wed", "thu"] }]);
        // Another connection does not see the removal before the commit.
        expect(
          (
            await adminPool.query<{ wake_days: unknown }>(
              "SELECT properties -> 'wakeDays' AS wake_days FROM items WHERE id = $1",
              [weekday.id],
            )
          ).rows,
        ).toEqual([{ wake_days: ["mon", "tue", "wed", "thu", "fri"] }]);
        throw rollback;
      }),
    );

    expect(thrown).toBe(rollback);
    expect((await plan(tenant, weekday.id)).wakeDays).toEqual(["mon", "tue", "wed", "thu", "fri"]);
    expect((await plan(tenant, weekend.id)).wakeDays).toEqual(["sat", "sun"]);
  });

  it("takes the days of a plan that is created with them", async () => {
    const weekday = await seededPlanHolding(tenant, "mon");
    const weekend = await seededPlanHolding(tenant, "sat");

    const created = await chokePoint(tenant).create(planProperties("Night shift", ["wed", "sun"]));

    expect((await plan(tenant, created.id)).wakeDays).toEqual(["wed", "sun"]);
    expect((await plan(tenant, weekday.id)).wakeDays).toEqual(["mon", "tue", "thu", "fri"]);
    expect((await plan(tenant, weekend.id)).wakeDays).toEqual(["sat"]);
  });

  it("takes days from several plans in one write", async () => {
    const weekday = await seededPlanHolding(tenant, "mon");
    const weekend = await seededPlanHolding(tenant, "sat");
    const spare = await chokePoint(tenant).create(planProperties("Spare", []));

    await chokePoint(tenant).patch(spare.id, { wakeDays: ["fri", "sat"] });

    expect((await plan(tenant, spare.id)).wakeDays).toEqual(["fri", "sat"]);
    expect((await plan(tenant, weekday.id)).wakeDays).toEqual(["mon", "tue", "wed", "thu"]);
    expect((await plan(tenant, weekend.id)).wakeDays).toEqual(["sun"]);
  });

  it("keeps a plan that lost all its days with wakeDays [] and does not delete it", async () => {
    const weekend = await seededPlanHolding(tenant, "sat");
    const spare = await chokePoint(tenant).create(planProperties("Spare", []));

    await chokePoint(tenant).patch(spare.id, { wakeDays: ["sun", "sat"] });

    expect((await plan(tenant, weekend.id)).wakeDays).toEqual([]);
    expect(await plansHolding(tenant, "sat")).toEqual([spare.id]);
    const live = await inTenant(tenant.tenantId, (client) =>
      client.query<{ deleted_at: string | null }>("SELECT deleted_at FROM items WHERE id = $1", [weekend.id]),
    );
    expect(live.rows).toEqual([{ deleted_at: null }]);
  });

  it("stores a plan that is saved with wakeDays [] and leaves the other plans alone", async () => {
    const weekday = await seededPlanHolding(tenant, "mon");
    const weekend = await seededPlanHolding(tenant, "sat");

    const created = await chokePoint(tenant).create(planProperties("Floating", []));
    await chokePoint(tenant).patch(weekend.id, { wakeDays: [] });

    expect((await plan(tenant, created.id)).wakeDays).toEqual([]);
    expect((await plan(tenant, weekend.id)).wakeDays).toEqual([]);
    expect((await plan(tenant, weekday.id)).wakeDays).toEqual(["mon", "tue", "wed", "thu", "fri"]);
  });

  it("does not touch a plan that holds none of the days", async () => {
    const weekday = await seededPlanHolding(tenant, "mon");
    const weekend = await seededPlanHolding(tenant, "sat");

    const created = await chokePoint(tenant).create(planProperties("Spare", []));
    await chokePoint(tenant).patch(created.id, { name: "Renamed" });

    expect(await plan(tenant, weekday.id)).toEqual(weekday);
    expect(await plan(tenant, weekend.id)).toEqual(weekend);
  });

  it("does not touch a plan in the trash", async () => {
    const weekday = await seededPlanHolding(tenant, "mon");
    const weekend = await seededPlanHolding(tenant, "sat");
    await chokePoint(tenant).trash(weekday.id);
    const trashed = await plan(tenant, weekday.id);

    await chokePoint(tenant).patch(weekend.id, { wakeDays: ["fri", "sat", "sun"] });

    expect(await plan(tenant, weekday.id)).toEqual(trashed);
    expect(trashed.wakeDays).toEqual(["mon", "tue", "wed", "thu", "fri"]);
  });

  it("does not touch the plans of another tenant that hold the same days", async () => {
    const otherBefore = await storedPlans(other);
    const weekend = await seededPlanHolding(tenant, "sat");

    await chokePoint(tenant).patch(weekend.id, { wakeDays: ["fri", "sat", "sun"] });

    expect(await storedPlans(other)).toEqual(otherBefore);
    expect((await seededPlanHolding(other, "fri")).wakeDays).toEqual(["mon", "tue", "wed", "thu", "fri"]);
  });

  it("does not cascade: a plan that lost days does not take its other days from a third plan", async () => {
    const weekday = await seededPlanHolding(tenant, "mon");
    const weekend = await seededPlanHolding(tenant, "sat");
    const taker = await chokePoint(tenant).create(planProperties("Taker", []));
    const loser = await chokePoint(tenant).create(planProperties("Loser", []));
    // A restore from the trash can leave one day in two plans, which no write produces (the issue's decision): the
    // loser holds mon and sat, and sat is also held by the weekend plan.
    await inTenant(tenant.tenantId, (client) =>
      client.query("UPDATE items SET properties = jsonb_set(properties, '{wakeDays}', $2::jsonb) WHERE id = $1", [
        loser.id,
        JSON.stringify(["mon", "sat"]),
      ]),
    );

    await chokePoint(tenant).patch(taker.id, { wakeDays: ["mon"] });

    expect((await plan(tenant, taker.id)).wakeDays).toEqual(["mon"]);
    expect((await plan(tenant, loser.id)).wakeDays).toEqual(["sat"]);
    expect((await plan(tenant, weekend.id)).wakeDays).toEqual(["sat", "sun"]);
    expect((await plan(tenant, weekday.id)).wakeDays).toEqual(["tue", "wed", "thu", "fri"]);
  });
});

describe("a wake day is in at most one sleep plan: concurrent writes (issue gh-1799)", () => {
  async function plansForTakingSat() {
    const weekend = await seededPlanHolding(tenant, "sat");
    const first = await chokePoint(tenant).create(planProperties("First", []));
    const second = await chokePoint(tenant).create(planProperties("Second", []));
    return { weekend, first, second };
  }

  it("leaves sat in exactly one plan when two writes take it from the weekend plan together", async () => {
    const { weekend, first, second } = await plansForTakingSat();

    await Promise.all([
      chokePoint(tenant).patch(first.id, { wakeDays: ["sat"] }),
      chokePoint(tenant).patch(second.id, { wakeDays: ["sat"] }),
    ]);

    expect(await plansHolding(tenant, "sat")).toHaveLength(1);
    expect((await plan(tenant, weekend.id)).wakeDays).toEqual(["sun"]);
  });

  it("leaves sat in the later writer when it waited for the first one to commit the day away", async () => {
    const { weekend, first, second } = await plansForTakingSat();
    const firstWrite = holdPlanWriteOpen(tenant, first.id, ["sat"]);
    try {
      await firstWrite.written;
      // The second write sees the weekend plan with sat, as committed, and waits for the first write's lock on it.
      const secondWrite = chokePoint(tenant).patch(second.id, { wakeDays: ["sat"] });
      await waitForRowLockWaiter();

      firstWrite.release();
      await firstWrite.done;
      await secondWrite;

      // The first write committed sat into its plan after the second one's statement began, so the second one had
      // to look again to take it from there.
      expect(await plansHolding(tenant, "sat")).toEqual([second.id]);
      expect((await plan(tenant, first.id)).wakeDays).toEqual([]);
      expect((await plan(tenant, weekend.id)).wakeDays).toEqual(["sun"]);
    } finally {
      firstWrite.release();
      await firstWrite.done.catch(() => undefined);
    }
  });

  it("ends one of two cross moves with 409, and the repeated request succeeds", async () => {
    const weekday = await seededPlanHolding(tenant, "mon");
    const left = await chokePoint(tenant).create(planProperties("Left", ["mon"]));
    const right = await chokePoint(tenant).create(planProperties("Right", ["tue"]));
    const leftLocked = deferred();
    const rightLocked = deferred();
    // Each move first holds its own plan's row lock (the update takes it too) and writes only when the other one
    // holds its own, so the two statements that lock the other's plan wait for each other.
    const move = (ownId: string, own: Deferred, otherSide: Deferred, wakeDays: string[]) =>
      inTenant(tenant.tenantId, async (client) => {
        await client.query<{ id: string }>("SELECT id FROM items WHERE id = $1 FOR UPDATE", [ownId]);
        own.resolve();
        await otherSide.promise;
        await updateItemWithClient(
          client,
          { databaseId: tenant.plansId, itemId: ownId, propertiesPatch: { wakeDays } },
          { writer: USER },
        );
      });

    const outcomes = await Promise.allSettled([
      move(left.id, leftLocked, rightLocked, ["mon", "tue"]),
      move(right.id, rightLocked, leftLocked, ["tue", "mon"]),
    ]);

    const rejected = outcomes.flatMap((outcome, index) => (outcome.status === "rejected" ? [{ index, outcome }] : []));
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const failure = rejected[0]?.outcome.reason;
    expect(failure).toBeInstanceOf(ConflictError);
    expect(failure).toMatchObject({ status: 409 });
    // The winner holds both days, the loser none; the failed move left nothing behind.
    const winnerId = rejected[0]?.index === 0 ? right.id : left.id;
    const loserId = rejected[0]?.index === 0 ? left.id : right.id;
    expect([...asDays((await plan(tenant, winnerId)).wakeDays)].sort()).toEqual(["mon", "tue"]);
    expect((await plan(tenant, loserId)).wakeDays).toEqual([]);
    expect((await plan(tenant, weekday.id)).wakeDays).toEqual(["wed", "thu", "fri"]);

    // The same request, repeated, now succeeds and takes both days back.
    await chokePoint(tenant).patch(loserId, { wakeDays: ["mon", "tue"] });

    expect((await plan(tenant, loserId)).wakeDays).toEqual(["mon", "tue"]);
    expect((await plan(tenant, winnerId)).wakeDays).toEqual([]);
    expect(await plansHolding(tenant, "mon")).toEqual([loserId]);
    expect(await plansHolding(tenant, "tue")).toEqual([loserId]);
  });

  it("lets two moves that do not cross both succeed, the second while the first is still open", async () => {
    const weekday = await seededPlanHolding(tenant, "mon");
    const weekend = await seededPlanHolding(tenant, "sat");
    const fromWeekday = await chokePoint(tenant).create(planProperties("From weekday", []));
    const fromWeekend = await chokePoint(tenant).create(planProperties("From weekend", []));
    const firstMove = holdPlanWriteOpen(tenant, fromWeekday.id, ["mon"]);
    try {
      await firstMove.written;

      // Resolves while the first transaction still holds its locks: the two moves touch different plans.
      await chokePoint(tenant).patch(fromWeekend.id, { wakeDays: ["sat"] });
      firstMove.release();
      await firstMove.done;
    } finally {
      firstMove.release();
      await firstMove.done.catch(() => undefined);
    }

    expect(await plansHolding(tenant, "mon")).toEqual([fromWeekday.id]);
    expect(await plansHolding(tenant, "sat")).toEqual([fromWeekend.id]);
    expect((await plan(tenant, weekday.id)).wakeDays).toEqual(["tue", "wed", "thu", "fri"]);
    expect((await plan(tenant, weekend.id)).wakeDays).toEqual(["sun"]);
  });

  it("does not hold a move in another tenant behind the open transaction", async () => {
    const weekend = await seededPlanHolding(tenant, "sat");
    const spare = await chokePoint(tenant).create(planProperties("Spare", []));
    const otherWeekend = await seededPlanHolding(other, "sat");
    const otherSpare = await chokePoint(other).create(planProperties("Spare", []));
    const move = holdPlanWriteOpen(tenant, spare.id, ["sat"]);
    try {
      await move.written;

      await chokePoint(other).patch(otherSpare.id, { wakeDays: ["sat"] });

      expect(await plansHolding(other, "sat")).toEqual([otherSpare.id]);
      expect((await plan(other, otherWeekend.id)).wakeDays).toEqual(["sun"]);
    } finally {
      move.release();
      await move.done;
    }
    expect((await plan(tenant, weekend.id)).wakeDays).toEqual(["sun"]);
  });

  it("passes a lock failure other than a deadlock on unchanged, and keeps the plans", async () => {
    const weekend = await seededPlanHolding(tenant, "sat");
    const spare = await chokePoint(tenant).create(planProperties("Spare", []));
    const holder = deferred();
    const holderDone = deferred();
    const holding = inTenant(tenant.tenantId, async (client) => {
      await client.query<{ id: string }>("SELECT id FROM items WHERE id = $1 FOR UPDATE", [weekend.id]);
      holder.resolve();
      await holderDone.promise;
    });
    try {
      await holder.promise;

      const thrown = await refusal(
        inTenant(tenant.tenantId, async (client) => {
          await client.query("SET LOCAL lock_timeout = '300ms'");
          await updateItemWithClient(
            client,
            { databaseId: tenant.plansId, itemId: spare.id, propertiesPatch: { wakeDays: ["sat"] } },
            { writer: USER },
          );
        }),
      );

      expect(thrown).toBeInstanceOf(DatabaseError);
      expect(thrown).toMatchObject({ code: "55P03" });
      expect(thrown).not.toBeInstanceOf(ConflictError);
    } finally {
      holderDone.resolve();
      await holding;
    }
    expect((await plan(tenant, spare.id)).wakeDays).toEqual([]);
    expect((await plan(tenant, weekend.id)).wakeDays).toEqual(["sat", "sun"]);
  });
});
