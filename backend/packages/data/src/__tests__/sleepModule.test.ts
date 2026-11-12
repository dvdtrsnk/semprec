import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { createUser, updateUserLocale } from "../auth/usersStore.js";
import { createChokePoint } from "../chokePoint/chokePoint.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import { getItemById } from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabase } from "../chokePoint/propertiesStore.js";
import { listViewsByDatabase } from "../chokePoint/viewsStore.js";
import { createViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { withTransaction } from "../db/pool.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { generateSchemaProjection } from "../manifest/schemaProjection.js";
import { seedSystem } from "../seed/seedSystem.js";
import { SLEEP_NIGHTS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_SETTINGS_MODULE_ID } from "../seed/sleepModuleKeys.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { provisionTenant } from "../tenancy/provisionTenant.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

// Each test builds one or more tenants with their couple of dozen system databases.
const SEEDING_TEST_TIMEOUT_MS = 90_000;

const SLEEP_KEYS = [SLEEP_SETTINGS_MODULE_ID, SLEEP_PLANS_MODULE_ID, SLEEP_NIGHTS_MODULE_ID] as const;
type SleepKey = (typeof SLEEP_KEYS)[number];

const USER = { writerKind: "user" } as const;

let adminPool: Pool;
let dataPool: Pool;

function property(key: string, type: string, config: Record<string, unknown> = {}) {
  return { key, name: null, type, owner: "user", ownerProcess: null, locked: false, config };
}

function database(key: string, viewName: string, properties: unknown[]) {
  return {
    database: { key, name: null, system: true, schemaLocked: true, ownerModuleId: key, archivedAt: null },
    properties,
    views: [{ type: "table", name: viewName, isDefault: true, createdBy: "system", ownerModuleId: null, config: {} }],
  };
}

/** What issue #1776 seeds, without ids. Properties are in the order the store lists them: by key. */
const EXPECTED_SHAPE = {
  project: { name: "Sleep", systemActive: true, deletedAt: null },
  sleepSettings: database("sleepSettings", "Sleep settings", [
    property("alarmSnooze", "checkbox"),
    property("alarmSound", "select", {
      options: [{ key: "morning" }, { key: "birds" }, { key: "piano" }, { key: "vibrateOnly" }],
    }),
    property("enabled", "checkbox"),
    property("goalMinutes", "number"),
    property("muteSemp", "checkbox"),
    property("name", "title"),
    property("prepReminder", "checkbox"),
    property("prepReminderMinutes", "number"),
    property("showInCalendar", "checkbox"),
    { ...property("systemActive", "checkbox"), owner: "system", locked: true },
  ]),
  sleepPlans: database("sleepPlans", "Sleep plans", [
    property("alarm", "checkbox"),
    property("bedTime", "time"),
    property("name", "title"),
    property("position", "number"),
    property("wakeDays", "multi_select", {
      options: [
        { key: "mon" },
        { key: "tue" },
        { key: "wed" },
        { key: "thu" },
        { key: "fri" },
        { key: "sat" },
        { key: "sun" },
      ],
    }),
    property("wakeTime", "time"),
  ]),
  sleepNights: database("sleepNights", "Sleep nights", [
    property("alarm", "checkbox"),
    property("bedTime", "time"),
    property("night", "date"),
    property("wakeTime", "time"),
  ]),
};

const EXPECTED_SETTINGS = {
  enabled: true,
  prepReminder: true,
  muteSemp: true,
  alarmSnooze: true,
  showInCalendar: true,
  goalMinutes: 480,
  prepReminderMinutes: 30,
  alarmSound: "morning",
  systemActive: true,
};

function expectedPlans(weekdays: string, weekend: string) {
  return [
    {
      name: weekdays,
      wakeDays: ["mon", "tue", "wed", "thu", "fri"],
      bedTime: "23:00",
      wakeTime: "06:45",
      alarm: true,
      position: 0,
    },
    { name: weekend, wakeDays: ["sat", "sun"], bedTime: "00:00", wakeTime: "08:30", alarm: false, position: 1 },
  ];
}

function inTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return runInTenant(tenantId, () => withTransaction(dataPool, fn));
}

/** Creates a tenant, gives it a user of `locale` unless `locale` is null, and seeds it. Returns the tenant and user ids. */
async function seededTenant(locale: string | null): Promise<{ tenantId: string; userId: string | null }> {
  const tenantId = await createTestTenant(adminPool);
  const user =
    locale === null
      ? null
      : await createUser(adminPool, {
          tenantId,
          email: `${randomUUID()}@example.test`,
          passwordHash: "unused",
          locale,
        });
  await runInTenant(tenantId, () => seedSystem(dataPool, createViewTypeRegistry()));
  return { tenantId, userId: user?.id ?? null };
}

async function databaseId(tenantId: string, key: SleepKey): Promise<string> {
  const found = await inTenant(tenantId, (client) => databasesStore.getDatabaseByModuleId(client, key));
  if (!found) throw new Error(`The tenant has no ${key} database`);
  return found.id;
}

/** The live items of one sleep database of `tenantId`, read through the choke point as the runtime role. */
async function items(tenantId: string, key: SleepKey) {
  const id = await databaseId(tenantId, key);
  return runInTenant(tenantId, async () => (await createChokePoint(dataPool).listItems(id, { limit: 50 })).items);
}

async function planNames(tenantId: string): Promise<unknown[]> {
  return (await items(tenantId, SLEEP_PLANS_MODULE_ID)).map((plan) => plan.properties.name).sort();
}

/** The three sleep databases of `tenantId` and the project that owns them, as the runtime role sees them in that tenant's scope. */
async function sleepShape(tenantId: string) {
  return inTenant(tenantId, async (client) => {
    const projects = await databasesStore.getDatabaseByModuleId(client, PROJECTS_MODULE_ID);
    if (!projects) throw new Error("The tenant has no Projects database");
    const owners = new Set<string | null>();
    const shape = async (key: SleepKey) => {
      const found = await databasesStore.getDatabaseByModuleId(client, key);
      if (!found) throw new Error(`The tenant has no ${key} database`);
      owners.add(found.ownerProjectItemId);
      return {
        database: {
          key: found.key,
          name: found.name,
          system: found.system,
          schemaLocked: found.schemaLocked,
          ownerModuleId: found.ownerModuleId,
          archivedAt: found.archivedAt,
        },
        properties: (await listPropertiesByDatabase(client, found.id)).map((row) => ({
          key: row.key,
          name: row.name,
          type: row.type,
          owner: row.owner,
          ownerProcess: row.ownerProcess,
          locked: row.locked,
          config: row.config,
        })),
        views: (await listViewsByDatabase(client, found.id)).map((view) => ({
          type: view.type,
          name: view.name,
          isDefault: view.isDefault,
          createdBy: view.createdBy,
          ownerModuleId: view.ownerModuleId,
          config: view.config,
        })),
      };
    };
    const sleepSettings = await shape(SLEEP_SETTINGS_MODULE_ID);
    const sleepPlans = await shape(SLEEP_PLANS_MODULE_ID);
    const sleepNights = await shape(SLEEP_NIGHTS_MODULE_ID);
    // One project owns all three.
    expect(owners.size).toBe(1);
    const [projectItemId] = [...owners];
    const project = projectItemId ? await getItemById(client, projects.id, projectItemId) : null;
    return {
      project: project && {
        name: project.properties.name,
        systemActive: project.properties.systemActive,
        deletedAt: project.deletedAt,
      },
      sleepSettings,
      sleepPlans,
      sleepNights,
    };
  });
}

describe("sleep system module (issue #1776)", () => {
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
  });

  afterAll(async () => {
    await dataPool?.end();
    await adminPool?.end();
  });

  it(
    "gives a newly provisioned tenant exactly the three locked sleep databases with their properties, a default table view each and one owning system project",
    async () => {
      const tenantId = await createTestTenant(adminPool, { status: "provisioning" });

      await expect(provisionTenant(dataPool, tenantId)).resolves.toBe("created");

      expect(await sleepShape(tenantId)).toEqual(EXPECTED_SHAPE);
      // Exactly three databases belong to the Sleep project, and exactly one live project is named Sleep.
      const owned = await inTenant(tenantId, async (client) => {
        const settings = await databasesStore.getDatabaseByModuleId(client, SLEEP_SETTINGS_MODULE_ID);
        const { rows } = await client.query<{ key: string | null }>(
          "SELECT key FROM databases WHERE owner_project_item_id = $1 ORDER BY key",
          [settings?.ownerProjectItemId],
        );
        const projects = await client.query<{ id: string }>(
          `SELECT i.id FROM items i JOIN databases d ON d.id = i.database_id
            WHERE d.owner_module_id = $1 AND i.properties->>'name' = 'Sleep' AND i.deleted_at IS NULL`,
          [PROJECTS_MODULE_ID],
        );
        return { keys: rows.map((row) => row.key), projects: projects.rows.length };
      });
      expect(owned).toEqual({ keys: ["sleepNights", "sleepPlans", "sleepSettings"], projects: 1 });
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "seeds one settings item with every checkbox true and the default values, the two default plans and no night",
    async () => {
      const { tenantId } = await seededTenant("cs");

      const settings = await items(tenantId, SLEEP_SETTINGS_MODULE_ID);
      expect(settings.map((item) => item.properties)).toEqual([EXPECTED_SETTINGS]);
      const plans = await items(tenantId, SLEEP_PLANS_MODULE_ID);
      expect(plans.map((item) => item.properties).sort((a, b) => Number(a.position) - Number(b.position))).toEqual(
        expectedPlans("Pracovní dny", "Víkend"),
      );
      expect(await items(tenantId, SLEEP_NIGHTS_MODULE_ID)).toEqual([]);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "names the plans in Czech for a Czech tenant and for a tenant seeded before any user exists, and in English for an English tenant",
    async () => {
      const czech = await seededTenant("cs");
      const withoutUser = await seededTenant(null);
      const english = await seededTenant("en");

      expect(await planNames(czech.tenantId)).toEqual(["Pracovní dny", "Víkend"]);
      expect(await planNames(withoutUser.tenantId)).toEqual(["Pracovní dny", "Víkend"]);
      expect(await planNames(english.tenantId)).toEqual(["Weekdays", "Weekend"]);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "keeps the stored plan names when the user's locale changes afterwards, while the labels follow the new locale",
    async () => {
      const { tenantId, userId } = await seededTenant("cs");
      if (!userId) throw new Error("The tenant has no user");
      const registry = await loadFullModuleRegistry();
      const plansName = async (locale: "cs" | "en") => {
        const projection = await inTenant(tenantId, (client) => generateSchemaProjection(client, registry, { locale }));
        return projection.databases.find((entry) => entry.key === SLEEP_PLANS_MODULE_ID)?.name;
      };
      const before = await items(tenantId, SLEEP_PLANS_MODULE_ID);
      expect(await plansName("cs")).toBe("Plány spánku");

      const updated = await runInTenant(tenantId, () => updateUserLocale(dataPool, userId, "en"));

      expect(updated?.locale).toBe("en");
      expect(await planNames(tenantId)).toEqual(["Pracovní dny", "Víkend"]);
      expect(await items(tenantId, SLEEP_PLANS_MODULE_ID)).toEqual(before);
      expect(await plansName("en")).toBe("Sleep plans");
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "projects the alarmSound and wakeDays options with Czech labels for cs and English labels for en",
    async () => {
      const { tenantId } = await seededTenant("cs");
      const registry = await loadFullModuleRegistry();
      const optionLabels = async (locale: "cs" | "en", key: SleepKey, propertyKey: string) => {
        const projection = await inTenant(tenantId, (client) => generateSchemaProjection(client, registry, { locale }));
        const found = projection.databases.find((entry) => entry.key === key);
        return found?.properties.find((entry) => entry.key === propertyKey)?.options;
      };

      expect(await optionLabels("cs", SLEEP_SETTINGS_MODULE_ID, "alarmSound")).toEqual([
        { key: "morning", label: "Ráno" },
        { key: "birds", label: "Ptáci" },
        { key: "piano", label: "Klavír" },
        { key: "vibrateOnly", label: "Pouze vibrace" },
      ]);
      expect(await optionLabels("en", SLEEP_SETTINGS_MODULE_ID, "alarmSound")).toEqual([
        { key: "morning", label: "Morning" },
        { key: "birds", label: "Birds" },
        { key: "piano", label: "Piano" },
        { key: "vibrateOnly", label: "Vibrate only" },
      ]);
      expect((await optionLabels("cs", SLEEP_PLANS_MODULE_ID, "wakeDays"))?.map((option) => option.label)).toEqual([
        "Pondělí",
        "Úterý",
        "Středa",
        "Čtvrtek",
        "Pátek",
        "Sobota",
        "Neděle",
      ]);
      expect((await optionLabels("en", SLEEP_PLANS_MODULE_ID, "wakeDays"))?.map((option) => option.label)).toEqual([
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
        "Saturday",
        "Sunday",
      ]);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "refuses to delete the settings item with field systemActive and leaves it live, and moves a plan and a night to the trash",
    async () => {
      const { tenantId } = await seededTenant("cs");
      const settingsId = await databaseId(tenantId, SLEEP_SETTINGS_MODULE_ID);
      const plansId = await databaseId(tenantId, SLEEP_PLANS_MODULE_ID);
      const nightsId = await databaseId(tenantId, SLEEP_NIGHTS_MODULE_ID);
      const [settings] = await items(tenantId, SLEEP_SETTINGS_MODULE_ID);
      const [plan, otherPlan] = await items(tenantId, SLEEP_PLANS_MODULE_ID);
      if (!settings || !plan || !otherPlan) throw new Error("The seed left no settings item or plan");
      const chokePoint = createChokePoint(dataPool);

      await runInTenant(tenantId, async () => {
        await expect(chokePoint.softDeleteItem(settingsId, settings.id)).rejects.toMatchObject({
          status: 403,
          details: { field: "systemActive" },
        });
        expect(await chokePoint.getItem(settingsId, settings.id)).toEqual(settings);

        const night = await chokePoint.createItem(
          { databaseId: nightsId, properties: { night: "2026-10-16", wakeTime: "07:30" } },
          undefined,
          undefined,
          USER,
        );
        const trashedPlan = await chokePoint.softDeleteItem(plansId, plan.id);
        const trashedNight = await chokePoint.softDeleteItem(nightsId, night.id);

        expect(trashedPlan?.deletedAt).not.toBeNull();
        expect(trashedNight?.deletedAt).not.toBeNull();
      });
      expect((await items(tenantId, SLEEP_SETTINGS_MODULE_ID)).map((item) => item.id)).toEqual([settings.id]);
      expect((await items(tenantId, SLEEP_PLANS_MODULE_ID)).map((item) => item.id)).toEqual([otherPlan.id]);
      expect(await items(tenantId, SLEEP_NIGHTS_MODULE_ID)).toEqual([]);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "accepts a user write of a settings value and refuses a user write of systemActive, which stays true",
    async () => {
      const { tenantId } = await seededTenant("cs");
      const settingsId = await databaseId(tenantId, SLEEP_SETTINGS_MODULE_ID);
      const [settings] = await items(tenantId, SLEEP_SETTINGS_MODULE_ID);
      if (!settings) throw new Error("The seed left no settings item");
      const chokePoint = createChokePoint(dataPool);
      const patch = (propertiesPatch: Record<string, unknown>) =>
        chokePoint.updateItem(
          { databaseId: settingsId, itemId: settings.id, propertiesPatch },
          undefined,
          undefined,
          USER,
        );

      await runInTenant(tenantId, async () => {
        const allowed = await patch({ enabled: false, alarmSound: "birds" });
        expect(allowed.properties).toEqual({ ...EXPECTED_SETTINGS, enabled: false, alarmSound: "birds" });

        await expect(patch({ systemActive: false })).rejects.toMatchObject({
          status: 403,
          code: "owner_violation",
          details: { field: "systemActive" },
        });
      });
      expect((await items(tenantId, SLEEP_SETTINGS_MODULE_ID)).map((item) => item.properties)).toEqual([
        { ...EXPECTED_SETTINGS, enabled: false, alarmSound: "birds" },
      ]);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );

  it(
    "shows no sleep database and no sleep item of one tenant to another tenant",
    async () => {
      const owner = await seededTenant("cs");
      const other = await seededTenant("en");
      const chokePoint = createChokePoint(dataPool);

      for (const key of SLEEP_KEYS) {
        const ownerDatabase = await databaseId(owner.tenantId, key);
        const otherDatabase = await databaseId(other.tenantId, key);
        expect(otherDatabase).not.toBe(ownerDatabase);
        const ownerIds = (await items(owner.tenantId, key)).map((item) => item.id);
        const otherIds = (await items(other.tenantId, key)).map((item) => item.id);
        expect(otherIds.filter((id) => ownerIds.includes(id))).toEqual([]);

        await runInTenant(other.tenantId, async () => {
          expect(await chokePoint.getDatabase(ownerDatabase)).toBeNull();
          for (const id of ownerIds) expect(await chokePoint.getItem(ownerDatabase, id)).toBeNull();
        });
      }
      // The owner's own items are still there for the owner.
      expect(await items(owner.tenantId, SLEEP_SETTINGS_MODULE_ID)).toHaveLength(1);
      expect(await items(owner.tenantId, SLEEP_PLANS_MODULE_ID)).toHaveLength(2);
    },
    SEEDING_TEST_TIMEOUT_MS,
  );
});
