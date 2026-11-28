import "../../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runInTenant } from "@alldots/shared";
import { createUser } from "../../auth/usersStore.js";
import { createChokePoint } from "../../chokePoint/chokePoint.js";
import { getDatabaseByModuleId } from "../../chokePoint/databasesStore.js";
import { withTransaction } from "../../db/pool.js";
import { seedSystem } from "../../seed/seedSystem.js";
import { EVENTS_MODULE_ID, PEOPLE_MODULE_ID, PROJECTS_MODULE_ID, TASKS_MODULE_ID } from "../../seed/tenDatabaseKeys.js";
import { startTaskSeries } from "../../testSupport/taskSeriesFixtures.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../../testSupport/testDb.js";
import { readCalendarTimeline } from "../timelineRead.js";

const USER = { writerKind: "user" } as const;
const WEEK = { from: "2026-10-12", to: "2026-10-18" } as const;
/** What the read of `WEEK` takes. It does not grow with the number of items, as each source reads in batches. */
const MAX_STATEMENTS = 39;

let adminPool: Pool;
let dataPool: Pool;
let tenantId: string;

/** The text of every statement sent through the returned client, which forwards everything else unchanged. */
function observed(client: PoolClient, statements: string[]): PoolClient {
  return new Proxy(client, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver);
      if (property !== "query" || typeof value !== "function") return value;
      return (...args: unknown[]): unknown => {
        const [query] = args;
        statements.push(typeof query === "string" ? query : "");
        return Reflect.apply(value, target, args);
      };
    },
  });
}

describe("the calendar timeline of one week", () => {
  beforeAll(async () => {
    // Midweek, so the Tasks before today leave traces and those after it are planned.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-15T10:00:00Z"));
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "alldots_data");
    await resetDatabase(adminPool);
    tenantId = await createTestTenant(adminPool);
    await createUser(adminPool, {
      tenantId,
      email: `${randomUUID()}@example.com`,
      passwordHash: "unused",
      locale: "cs",
    });
    await runInTenant(tenantId, () => seedSystem(dataPool));
    await runInTenant(tenantId, async () => {
      const chokePoint = createChokePoint(dataPool);
      const ids = await withTransaction(dataPool, async (client) => {
        const byModule = async (moduleId: string) => {
          const database = await getDatabaseByModuleId(client, moduleId);
          if (!database) throw new Error(`No ${moduleId} database`);
          return database.id;
        };
        return {
          events: await byModule(EVENTS_MODULE_ID),
          tasks: await byModule(TASKS_MODULE_ID),
          people: await byModule(PEOPLE_MODULE_ID),
          projects: await byModule(PROJECTS_MODULE_ID),
        };
      });
      const create = async (databaseId: string, properties: Record<string, unknown>) =>
        (await chokePoint.createItem({ databaseId, properties }, undefined, undefined, USER)).id;
      const link = async (databaseId: string, key: string, itemId: string, targetItemId: string) => {
        const property = (await chokePoint.listProperties(databaseId)).find((entry) => entry.key === key);
        if (!property) throw new Error(`No ${key} property`);
        await chokePoint.createRelation({ relationPropertyId: property.id, callerItemId: itemId, targetItemId }, USER);
      };
      const project = await create(ids.projects, { name: "Garden" });
      const person = await create(ids.people, { name: "Eva", birthday: "1990-10-14" });
      for (let day = 12; day <= 18; day++) {
        const date = `2026-10-${day}`;
        const event = await create(ids.events, { name: `Meeting ${day}`, date, timeFrom: "09:00", timeTo: "10:00" });
        await link(ids.events, "project", event, project);
        await link(ids.events, "people", event, person);
        const task = await create(ids.tasks, { name: `Task ${day}`, date });
        await link(ids.tasks, "project", task, project);
      }
      await create(ids.events, {
        name: "Standup",
        date: "2026-10-12",
        timeFrom: "08:00",
        timeTo: "08:15",
        recurrence: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri"] },
      });
      const first = await create(ids.tasks, { name: "Water plants", date: "2026-10-12", timeFrom: "07:00" });
      await startTaskSeries(dataPool, {
        databaseId: ids.tasks,
        itemId: first,
        mode: "fixed",
        rule: { kind: "weekdays", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] },
      });
    });
  });

  afterAll(async () => {
    vi.useRealTimers();
    await dataPool?.end();
    await adminPool?.end();
  });

  it("reads a seeded week in a bounded number of statements, each shared lookup once", async () => {
    const statements: string[] = [];
    const timeline = await runInTenant(tenantId, () =>
      withTransaction(dataPool, (client) =>
        readCalendarTimeline(observed(client, statements), { ...WEEK, shape: "full" }),
      ),
    );

    // Every source has something to show: the week's Events and Tasks, the occurrences of both series, a birthday.
    const kinds = timeline.items.map((item) => item.kind);
    expect(kinds.filter((kind) => kind === "event")).toHaveLength(7 + 5);
    expect(kinds.filter((kind) => kind === "task")).toHaveLength(7 + 7);
    expect(kinds.filter((kind) => kind === "birthday")).toHaveLength(1);
    const count = (pattern: RegExp): number => statements.filter((sql) => pattern.test(sql)).length;
    expect(count(/\bschema_locked\b[\s\S]*\bFROM databases\b/)).toBe(1);
    expect(count(/\bAS is_default\b/)).toBe(1);
    expect(count(/\bFROM users\b/)).toBe(1);
    expect(count(/\bFROM relation_definitions\s+WHERE property_id_a = \$1/)).toBe(2);
    expect(statements.length, statements.join("\n----\n")).toBeLessThanOrEqual(MAX_STATEMENTS);
  });
});
