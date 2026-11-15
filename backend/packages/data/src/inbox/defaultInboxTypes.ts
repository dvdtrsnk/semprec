import type { PoolClient } from "pg";
import { z } from "zod";
import { resolveCatalogLabel } from "@semprec/module-registry";
import { getTenantUserLocale } from "../auth/usersStore.js";
import { createItemWithClient, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import { INBOX_ITEM_TYPES_MODULE_ID, INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { EVENTS_MODULE_ID, PEOPLE_MODULE_ID, TASKS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemSettingsDatabaseId, getSystemSettingsItemId } from "../systemSettings.js";
import { getInboxCatalogs } from "./inboxCatalogs.js";
import type { InboxTypeTargetDatabase } from "./inboxTypeTargets.js";
import type { ProcessingMethod } from "./inboxTypesStore.js";

/**
 * The key of the System settings property that lists the defaults already seeded (issue gh-1977). It is a system-owned
 * `json` property of the Inbox module, written only by `seedDefaultInboxItemTypes`: `seedSystem.ts` declares it with
 * an empty list for a fresh tenant and `defaultInboxTypesCutoverMigration.ts` adds it to a populated one.
 */
export const SEEDED_DEFAULT_INBOX_TYPES_KEY = "seededDefaultInboxTypes";
export const SEEDED_DEFAULT_INBOX_TYPES_NAME = "Seeded default Inbox types";

export interface DefaultInboxTypeSpec {
  /** A stable English camelCase identifier of the default. Only the marker stores it; the type itself does not. */
  key: string;
  emoji: string;
  processingMethod: ProcessingMethod;
  /** Set exactly when `processingMethod` is `database`. */
  targetDatabase?: InboxTypeTargetDatabase;
}

/**
 * The starting set of Inbox item types (issue gh-1977), in the order they are created. The name of each comes from the
 * Inbox catalog under `seed.inboxTypes.<key>.name`. The targets of `idea`, `thought` and `mood` are product proposals; a
 * type is changed later through the type write path, never here. A module that brings its own default type appends one
 * row: a tenant seeded before it receives that one type at the next run and nothing else. The decision and the contract
 * for a module that adds a row are in
 * `docs/adr/2026-11-15-default-inbox-types-are-seeded-once-per-default-under-the-settings-row-lock.md`.
 */
export const DEFAULT_INBOX_TYPES: readonly DefaultInboxTypeSpec[] = [
  { key: "idea", emoji: "\u{1F4A1}", processingMethod: "pageContent" },
  { key: "task", emoji: "✅", processingMethod: "database", targetDatabase: TASKS_MODULE_ID },
  { key: "event", emoji: "\u{1F4C5}", processingMethod: "database", targetDatabase: EVENTS_MODULE_ID },
  { key: "thought", emoji: "\u{1F4AD}", processingMethod: "journal" },
  { key: "mood", emoji: "\u{1F60A}", processingMethod: "journal" },
  { key: "note", emoji: "\u{1F4DD}", processingMethod: "pageContent" },
  { key: "contact", emoji: "\u{1F464}", processingMethod: "database", targetDatabase: PEOPLE_MODULE_ID },
];

const seededKeysSchema = z.array(z.string());

/**
 * Creates the default Inbox item types that the tenant has not been given yet and records their keys, in the caller's
 * open transaction. Resolves to the keys it created, in table order.
 *
 * The System settings item is locked first (the ADR names it the serialization point), so two concurrent seeders (a
 * deploy cutover and a provisioning) take turns and the second one reads the keys the first recorded. A default whose
 * key is in the marker is never created again, whether or not its type still exists, so a type the user deleted or
 * renamed does not come back. A default whose
 * target database does not exist in the tenant is skipped and not recorded, so the first run after that database exists
 * creates it. Each type is created through the choke point, so the Inbox type write hook validates it, as it does a
 * type a user creates. The names are in the language of the tenant's user, Czech while the tenant has no user, and the
 * language is fixed when the type is created. The marker is written only when a type was created.
 *
 * `defaults` is the table the run reads; production passes none, a test passes a table with one more row to show what a
 * later module's default does.
 *
 * Does nothing when the tenant has no Inbox item types database. Throws when the tenant has the System settings
 * database without the marker property (the cutover adds it, or the seed declares it) or when the marker holds
 * anything but a list of strings.
 */
export async function seedDefaultInboxItemTypes(
  client: PoolClient,
  defaults: readonly DefaultInboxTypeSpec[] = DEFAULT_INBOX_TYPES,
): Promise<string[]> {
  const typesDatabase = await getDatabaseByModuleId(client, INBOX_ITEM_TYPES_MODULE_ID);
  if (!typesDatabase) return [];

  const settingsDatabaseId = await getSystemSettingsDatabaseId(client);
  const markerProperty = await propertiesStore.getPropertyByKey(
    client,
    settingsDatabaseId,
    SEEDED_DEFAULT_INBOX_TYPES_KEY,
  );
  if (!markerProperty) {
    throw new Error(`The System settings database has no '${SEEDED_DEFAULT_INBOX_TYPES_KEY}' property`);
  }
  const settingsItemId = await getSystemSettingsItemId(client);
  const settingsItem = await itemsStore.lockItemById(client, settingsDatabaseId, settingsItemId);
  if (!settingsItem) throw new Error("The System settings row disappeared while it was being read");
  const stored = settingsItem.properties[SEEDED_DEFAULT_INBOX_TYPES_KEY];
  const seededKeys = seededKeysSchema.parse(stored === undefined || stored === null ? [] : stored);

  const missing = defaults.filter((spec) => !seededKeys.includes(spec.key));
  if (missing.length === 0) return [];

  const catalogs = await getInboxCatalogs();
  const locale = toManifestLocale((await getTenantUserLocale(client)) ?? "cs");
  const created: string[] = [];
  for (const spec of missing) {
    if (spec.targetDatabase !== undefined && !(await getDatabaseByModuleId(client, spec.targetDatabase))) continue;
    await createItemWithClient(client, {
      databaseId: typesDatabase.id,
      properties: {
        name: resolveCatalogLabel(null, catalogs[locale], catalogs.en, `seed.inboxTypes.${spec.key}.name`),
        emoji: spec.emoji,
        status: "active",
        processingMethod: spec.processingMethod,
        ...(spec.targetDatabase !== undefined ? { targetDatabase: spec.targetDatabase } : {}),
      },
    });
    created.push(spec.key);
  }
  if (created.length === 0) return [];

  await updateItemWithClient(
    client,
    {
      databaseId: settingsDatabaseId,
      itemId: settingsItemId,
      propertiesPatch: { [SEEDED_DEFAULT_INBOX_TYPES_KEY]: [...seededKeys, ...created] },
    },
    { allowedSystemKeys: [SEEDED_DEFAULT_INBOX_TYPES_KEY], systemOwnerProcess: INBOX_MODULE_ID },
  );
  return created;
}
