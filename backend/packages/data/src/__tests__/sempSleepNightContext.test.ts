import type { Pool, PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runInTenant, type SempMessageRef } from "@semprec/shared";
import { setAgentDatabaseGrant } from "../agentGrants/agentDatabaseGrantsAdminStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { ForbiddenError } from "../errors.js";
import { seedSystem } from "../seed/seedSystem.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { resolveSempHistoryContexts } from "../semp/sempRefHistory.js";
import { listSleepNightReadItemIds } from "../semp/sempSleepNightContext.js";
import { readSempRefContext, type SempRefContext } from "../semp/sempRefReadContext.js";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  withTenantTransaction,
} from "../testSupport/testDb.js";

// A seeded tenant has the settings item (prepReminder 30 minutes before bed), the weekdays plan (mon to fri, 23:00 to
// 06:45, alarm) and the weekend plan (sat and sun, 00:00 to 08:30, no alarm), in Europe/Prague. 2026-10-16 is a
// Friday, so the night belongs to the Saturday morning and the weekend plan.

const USER = { writerKind: "user" } as const;
const NIGHT = "2026-10-16";

interface SleepTenant {
  tenantId: string;
  settingsDatabaseId: string;
  plansDatabaseId: string;
  nightsDatabaseId: string;
  /** The Projects item of the Semprec project, the agent project of a Semp turn. */
  projectItemId: string;
  settingsItemId: string;
  weekdays: { id: string; name: string };
  weekend: { id: string; name: string };
}

let adminPool: Pool;
let dataPool: Pool;
let tenant: SleepTenant;

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

async function seededTenant(): Promise<SleepTenant> {
  const tenantId = await createTestTenant(adminPool);
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  const database = async (moduleId: string) => {
    const found = await inTenant(tenantId, (client) => databasesStore.getDatabaseByModuleId(client, moduleId));
    if (!found) throw new Error(`The tenant has no ${moduleId} database`);
    return found;
  };
  const settings = await database(SLEEP_SETTINGS_MODULE_ID);
  const plans = await database(SLEEP_PLANS_MODULE_ID);
  const nights = await database(SLEEP_NIGHTS_MODULE_ID);
  const inbox = await database("inbox");
  if (!inbox.ownerProjectItemId) throw new Error("Missing Semprec project");
  const planRows = await inTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ id: string; properties: { name: string; wakeDays: string[] } }>(
      "SELECT id, properties FROM items WHERE database_id = $1 AND deleted_at IS NULL",
      [plans.id],
    );
    return rows;
  });
  const plan = (day: string) => {
    const found = planRows.find((row) => row.properties.wakeDays.includes(day));
    if (!found) throw new Error(`No seeded plan wakes on ${day}`);
    return { id: found.id, name: found.properties.name };
  };
  const settingsItems = await inTenant(tenantId, async (client) => {
    const { rows } = await client.query<{ id: string }>("SELECT id FROM items WHERE database_id = $1", [settings.id]);
    return rows;
  });
  return {
    tenantId,
    settingsDatabaseId: settings.id,
    plansDatabaseId: plans.id,
    nightsDatabaseId: nights.id,
    projectItemId: inbox.ownerProjectItemId,
    settingsItemId: settingsItems[0]?.id ?? "",
    weekdays: plan("mon"),
    weekend: plan("sat"),
  };
}

function create(t: SleepTenant, databaseId: string, properties: Record<string, unknown>): Promise<string> {
  return runInTenant(t.tenantId, async () => {
    const item = await createChokePoint(dataPool).createItem({ databaseId, properties }, undefined, undefined, USER);
    return item.id;
  });
}

function trash(t: SleepTenant, databaseId: string, itemId: string): Promise<unknown> {
  return runInTenant(t.tenantId, () => createChokePoint(dataPool).softDeleteItem(databaseId, itemId, undefined, USER));
}

/** Gives the Semprec project the access on the three sleep databases of the tenant. */
async function grantSleep(t: SleepTenant, access: "none" | "read" | "write", only?: readonly string[]): Promise<void> {
  const ids = only ?? [t.settingsDatabaseId, t.plansDatabaseId, t.nightsDatabaseId];
  await inTenant(t.tenantId, async (client) => {
    for (const databaseId of ids)
      await setAgentDatabaseGrant(client, { projectItemId: t.projectItemId, databaseId, access });
  });
}

interface ReadOptions {
  /** The agent project the night is read for; the default is the Semprec project, `null` is no project. */
  project?: string | null;
  attachedThisTurn?: boolean;
  night?: string;
}

/** Reads the ref like the expander does: in a REPEATABLE READ transaction, with the options of one reader. */
function readNight(t: SleepTenant, options: ReadOptions = {}): Promise<SempRefContext | null> {
  const ref: SempMessageRef = { kind: "sleepNight", night: options.night ?? NIGHT };
  const project = options.project === undefined ? t.projectItemId : options.project;
  return runInTenant(t.tenantId, () =>
    withTransaction(
      dataPool,
      (client) =>
        readSempRefContext(client, ref, project === null ? undefined : { agentProjectItemId: project }, {
          attachedThisTurn: options.attachedThisTurn === true,
        }),
      { isolation: "repeatable_read" },
    ),
  );
}

describe("a sleepNight reference read (issue #1853)", () => {
  beforeAll(async () => {
    adminPool = getTestPool();
    dataPool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    tenant = await seededTenant();
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  describe("what the night contains", () => {
    it("is the weekend plan from 00:00 to 08:30 without an alarm, with the plan id and no exception id", async () => {
      const context = await readNight(tenant, { attachedThisTurn: true });

      expect(context).toEqual({
        label: NIGHT,
        state: "active",
        details: {
          night: NIGHT,
          planName: tenant.weekend.name,
          bedTime: "00:00",
          wakeTime: "08:30",
          alarm: false,
          changed: false,
          durationMinutes: 510,
          prepReminderAt: "2026-10-16T23:30:00+02:00",
          planItemId: tenant.weekend.id,
          exceptionItemId: null,
        },
        blob: null,
      });
    });

    it("applies the exception of the night and names its item", async () => {
      const exceptionId = await create(tenant, tenant.nightsDatabaseId, {
        night: NIGHT,
        bedTime: "01:15",
        alarm: true,
      });

      const context = await readNight(tenant, { attachedThisTurn: true });

      expect(context?.details).toMatchObject({
        night: NIGHT,
        planName: tenant.weekend.name,
        bedTime: "01:15",
        wakeTime: "08:30",
        alarm: true,
        changed: true,
        planItemId: tenant.weekend.id,
        exceptionItemId: exceptionId,
      });
    });

    it("leaves out an exception that was trashed and one of another night", async () => {
      const trashed = await create(tenant, tenant.nightsDatabaseId, { night: NIGHT, bedTime: "03:00" });
      await trash(tenant, tenant.nightsDatabaseId, trashed);
      await create(tenant, tenant.nightsDatabaseId, { night: "2026-10-17", bedTime: "04:00" });

      const context = await readNight(tenant, { attachedThisTurn: true });

      expect(context?.details).toMatchObject({ bedTime: "00:00", changed: false, exceptionItemId: null });
    });

    it("renders that no sleep is planned for a night without a plan and without an exception", async () => {
      await trash(tenant, tenant.plansDatabaseId, tenant.weekend.id);

      const context = await readNight(tenant, { attachedThisTurn: true });

      expect(context).toEqual({
        label: NIGHT,
        state: "active",
        details: { night: NIGHT, note: "no sleep planned for this night", planItemId: null, exceptionItemId: null },
        blob: null,
      });
    });

    it("is unavailable (null) when the settings item is gone", async () => {
      // The seeded settings item is protected from deletion by the choke point, so the fixture trashes it as the table owner.
      await withTenantTransaction(adminPool, tenant.tenantId, async (client) => {
        await client.query("UPDATE items SET deleted_at = now() WHERE id = $1", [tenant.settingsItemId]);
      });

      expect(await readNight(tenant, { attachedThisTurn: true })).toBeNull();
    });

    it("reads only the rows of its own tenant", async () => {
      const other = await seededTenant();
      await create(other, other.nightsDatabaseId, { night: NIGHT, bedTime: "05:05" });
      await trash(other, other.plansDatabaseId, other.weekend.id);

      const own = await readNight(tenant, { attachedThisTurn: true });
      const foreign = await readNight(other, { attachedThisTurn: true });

      expect(own?.details).toMatchObject({ planName: tenant.weekend.name, bedTime: "00:00", changed: false });
      expect(foreign?.details).toMatchObject({ planName: null, bedTime: "05:05", changed: true });
    });
  });

  describe("who may read it", () => {
    it("refuses without a grant and without the attachment, naming no sleep content", async () => {
      const failure = await readNight(tenant).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(ForbiddenError);
      expect(JSON.stringify(failure instanceof ForbiddenError ? failure.details : null)).not.toContain(
        tenant.weekend.name,
      );
    });

    it("refuses when no agent project is known and the turn did not attach it", async () => {
      await expect(readNight(tenant, { project: null })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("refuses a project whose grant on the sleep databases is none", async () => {
      await grantSleep(tenant, "none");

      await expect(readNight(tenant)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it.each([
      { name: "the settings", granted: (t: SleepTenant) => [t.plansDatabaseId, t.nightsDatabaseId] },
      { name: "the plans", granted: (t: SleepTenant) => [t.settingsDatabaseId, t.nightsDatabaseId] },
      { name: "the nights", granted: (t: SleepTenant) => [t.settingsDatabaseId, t.plansDatabaseId] },
    ])("refuses a project that may read all sleep databases but $name", async ({ granted }) => {
      await grantSleep(tenant, "read", granted(tenant));

      await expect(readNight(tenant)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it.each(["read", "write"] as const)("reads with a %s grant on all three sleep databases", async (access) => {
      await grantSleep(tenant, access);

      const context = await readNight(tenant);

      expect(context?.details).toMatchObject({ planName: tenant.weekend.name, bedTime: "00:00", wakeTime: "08:30" });
    });

    it("reads without a grant when the turn attached the ref, also for a project with grant none", async () => {
      const withoutRow = await readNight(tenant, { attachedThisTurn: true });
      await grantSleep(tenant, "none");
      const withNone = await readNight(tenant, { attachedThisTurn: true });
      const withoutProject = await readNight(tenant, { project: null, attachedThisTurn: true });

      for (const context of [withoutRow, withNone, withoutProject]) {
        expect(context?.details).toMatchObject({ planName: tenant.weekend.name });
      }
    });

    it("does not carry a grant of another tenant's project over", async () => {
      const other = await seededTenant();
      await grantSleep(other, "read");

      await expect(readNight(tenant, { project: other.projectItemId })).rejects.toBeInstanceOf(ForbiddenError);
    });

    it("refuses to read outside a REPEATABLE READ transaction", async () => {
      await expect(
        inTenant(tenant.tenantId, (client) =>
          readSempRefContext(client, { kind: "sleepNight", night: NIGHT }, undefined, { attachedThisTurn: true }),
        ),
      ).rejects.toThrow("REPEATABLE READ");
    });
  });

  describe("the history of a thread", () => {
    it("resolves a stored night, labeled or not, as an active virtual ref with no label and no database", async () => {
      const labeled = { kind: "sleepNight", night: NIGHT, label: "Saved" };
      const unlabeled = { kind: "sleepNight", night: "2026-10-17" };

      const resolved = await inTenant(tenant.tenantId, (client) =>
        resolveSempHistoryContexts(client, [[labeled, unlabeled]]),
      );

      const virtual = { label: null, databaseKey: null, state: "active" };
      expect(resolved).toEqual([
        [
          { ...labeled, resolved: virtual },
          { ...unlabeled, resolved: virtual },
        ],
      ]);
    });
  });

  describe("the items a sleepNight reference opens for one turn", () => {
    const idsOf = (t: SleepTenant, nights: readonly string[]) =>
      inTenant(t.tenantId, (client) => listSleepNightReadItemIds(client, nights));

    it("lists the settings item, every plan and the exception of the night, and no other item", async () => {
      const exceptionId = await create(tenant, tenant.nightsDatabaseId, { night: NIGHT, bedTime: "01:00" });
      await create(tenant, tenant.nightsDatabaseId, { night: "2026-10-17", bedTime: "02:00" });
      const unrelated = await runInTenant(tenant.tenantId, async () => {
        const projects = await inTenant(tenant.tenantId, (client) =>
          databasesStore.getDatabaseByModuleId(client, "projects"),
        );
        if (!projects) throw new Error("Missing projects database");
        return (
          await createChokePoint(dataPool).createItem(
            { databaseId: projects.id, properties: { name: "Unrelated" } },
            undefined,
            undefined,
            USER,
          )
        ).id;
      });

      const ids = await idsOf(tenant, [NIGHT]);

      expect([...ids].sort()).toEqual(
        [tenant.settingsItemId, tenant.weekdays.id, tenant.weekend.id, exceptionId].sort(),
      );
      expect(ids).not.toContain(unrelated);
    });

    it("lists the exceptions of several nights and leaves out a trashed plan, a trashed exception and another tenant's rows", async () => {
      const first = await create(tenant, tenant.nightsDatabaseId, { night: NIGHT, bedTime: "01:00" });
      const second = await create(tenant, tenant.nightsDatabaseId, { night: "2026-10-17", bedTime: "02:00" });
      const gone = await create(tenant, tenant.nightsDatabaseId, { night: "2026-10-18", bedTime: "03:00" });
      await trash(tenant, tenant.nightsDatabaseId, gone);
      await trash(tenant, tenant.plansDatabaseId, tenant.weekdays.id);
      const other = await seededTenant();
      const foreign = await create(other, other.nightsDatabaseId, { night: NIGHT, bedTime: "04:00" });

      const ids = await idsOf(tenant, [NIGHT, "2026-10-17", "2026-10-18"]);

      expect([...ids].sort()).toEqual([tenant.settingsItemId, tenant.weekend.id, first, second].sort());
      expect(ids).not.toContain(foreign);
    });

    it("lists nothing, and reads nothing, for no night", async () => {
      expect(await idsOf(tenant, [])).toEqual([]);
    });
  });
});
