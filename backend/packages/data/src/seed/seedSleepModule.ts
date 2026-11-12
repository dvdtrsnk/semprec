import type { PoolClient } from "pg";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { getTenantUserLocale } from "../auth/usersStore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import type { ViewTypeRegistry } from "../chokePoint/viewTypeRegistry.js";
import { requireAffectedRows } from "../db/pool.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { SLEEP_DATABASE_DESCRIPTORS } from "../sleep/sleepModuleManifest.js";
import type { PropertyOwner, PropertyType } from "../types.js";

interface PropSpec {
  key: string;
  type: PropertyType;
  owner: PropertyOwner;
  locked?: true;
  config?: Record<string, unknown>;
}

function selectConfig(options: readonly string[]): Record<string, unknown> {
  return { options: options.map((key) => ({ key })) };
}

const SETTINGS_PROPERTIES: readonly PropSpec[] = [
  { key: "name", type: "title", owner: "user" },
  { key: "enabled", type: "checkbox", owner: "user" },
  { key: "prepReminder", type: "checkbox", owner: "user" },
  { key: "muteSemp", type: "checkbox", owner: "user" },
  { key: "alarmSnooze", type: "checkbox", owner: "user" },
  { key: "showInCalendar", type: "checkbox", owner: "user" },
  { key: "goalMinutes", type: "number", owner: "user" },
  { key: "prepReminderMinutes", type: "number", owner: "user" },
  {
    key: "alarmSound",
    type: "select",
    owner: "user",
    config: selectConfig(["morning", "birds", "piano", "vibrateOnly"]),
  },
  // True on the seeded settings item, which `chokePoint/itemTrash.ts` therefore refuses to delete.
  { key: "systemActive", type: "checkbox", owner: "system", locked: true },
];

const PLAN_PROPERTIES: readonly PropSpec[] = [
  { key: "name", type: "title", owner: "user" },
  {
    key: "wakeDays",
    type: "multi_select",
    owner: "user",
    config: selectConfig(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
  },
  { key: "bedTime", type: "time", owner: "user" },
  { key: "wakeTime", type: "time", owner: "user" },
  { key: "alarm", type: "checkbox", owner: "user" },
  { key: "position", type: "number", owner: "user" },
];

/** `night` is the calendar day of the evening, `YYYY-MM-DD`; an unset `bedTime`, `wakeTime` or `alarm` follows the plan. */
const NIGHT_PROPERTIES: readonly PropSpec[] = [
  { key: "night", type: "date", owner: "user" },
  { key: "bedTime", type: "time", owner: "user" },
  { key: "wakeTime", type: "time", owner: "user" },
  { key: "alarm", type: "checkbox", owner: "user" },
];

/** The two plans a tenant starts with; `catalogKey` names the label `seed.sleepPlans.<catalogKey>.name`. */
const DEFAULT_PLANS = [
  {
    catalogKey: "weekdays",
    wakeDays: ["mon", "tue", "wed", "thu", "fri"],
    bedTime: "23:00",
    wakeTime: "06:45",
    alarm: true,
    position: 0,
  },
  { catalogKey: "weekend", wakeDays: ["sat", "sun"], bedTime: "00:00", wakeTime: "08:30", alarm: false, position: 1 },
];

/** Creates one sleep database with its properties and its default `table` view, and returns its id. */
async function createSleepDatabase(
  client: PoolClient,
  descriptor: { key: string; name: string },
  properties: readonly PropSpec[],
  ownerProjectItemId: string,
  viewTypeRegistry: ViewTypeRegistry,
): Promise<string> {
  const database = await databasesStore.createDatabase(client, {
    name: null,
    key: descriptor.key,
    system: true,
    ownerModuleId: descriptor.key,
    ownerProjectItemId,
  });
  for (const spec of properties) {
    // `name` stays null: the label of each property comes from the module catalog.
    await propertiesStore.createProperty(client, {
      databaseId: database.id,
      key: spec.key,
      name: null,
      type: spec.type,
      owner: spec.owner,
      locked: spec.locked,
      config: spec.config,
    });
  }
  await viewsStore.createView(
    client,
    { databaseId: database.id, type: "table", name: descriptor.name, isDefault: true, createdBy: "system" },
    viewTypeRegistry,
  );
  return database.id;
}

/**
 * Seeds the sleep module (issue #1776) into the caller's open transaction: the system project item "Sleep" in
 * the Projects database; the system databases `sleepSettings`, `sleepPlans` and `sleepNights` it owns, each
 * with its properties and a default `table` view; the schema lock of the three; then one settings item and
 * the two default plans. No night item is seeded.
 *
 * The two plan names come from the sleep module catalog in the tenant user's language (`cs` while the tenant
 * has no user) and are stored as plain titles.
 *
 * Not idempotent on its own: `seedSystem` calls it once for a new tenant.
 */
export async function seedSleepModuleInTransaction(
  client: PoolClient,
  projectsDatabaseId: string,
  viewTypeRegistry: ViewTypeRegistry,
): Promise<void> {
  const locale = toManifestLocale((await getTenantUserLocale(client)) ?? "cs");
  const catalogs = await loadModuleCatalogs(new URL("../sleep/sleepModuleManifest.js", import.meta.url).href);

  const project = await itemsStore.insertItem(client, {
    databaseId: projectsDatabaseId,
    properties: { name: "Sleep", systemActive: true },
  });
  const create = (descriptor: { key: string; name: string }, properties: readonly PropSpec[]) =>
    createSleepDatabase(client, descriptor, properties, project.id, viewTypeRegistry);
  const settingsId = await create(SLEEP_DATABASE_DESCRIPTORS.settings, SETTINGS_PROPERTIES);
  const plansId = await create(SLEEP_DATABASE_DESCRIPTORS.plans, PLAN_PROPERTIES);
  const nightsId = await create(SLEEP_DATABASE_DESCRIPTORS.nights, NIGHT_PROPERTIES);
  for (const databaseId of [settingsId, plansId, nightsId]) {
    requireAffectedRows(
      await client.query("UPDATE databases SET schema_locked = true WHERE id = $1", [databaseId]),
      "sleep schema lock",
    );
  }

  await itemsStore.insertItem(client, {
    databaseId: settingsId,
    properties: {
      enabled: true,
      prepReminder: true,
      muteSemp: true,
      alarmSnooze: true,
      showInCalendar: true,
      goalMinutes: 480,
      prepReminderMinutes: 30,
      alarmSound: "morning",
      systemActive: true,
    },
  });
  for (const plan of DEFAULT_PLANS) {
    await itemsStore.insertItem(client, {
      databaseId: plansId,
      properties: {
        name: resolveCatalogLabel(null, catalogs[locale], catalogs.en, `seed.sleepPlans.${plan.catalogKey}.name`),
        wakeDays: plan.wakeDays,
        bedTime: plan.bedTime,
        wakeTime: plan.wakeTime,
        alarm: plan.alarm,
        position: plan.position,
      },
    });
  }
}
