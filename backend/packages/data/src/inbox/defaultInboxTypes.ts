import type { PoolClient } from "pg";
import { z } from "zod";
import { resolveCatalogLabel } from "@alldots/module-registry";
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

/** System-owned `json` settings property listing the defaults already seeded; only `seedDefaultInboxItemTypes` writes it. */
export const SEEDED_DEFAULT_INBOX_TYPES_KEY = "seededDefaultInboxTypes";
export const SEEDED_DEFAULT_INBOX_TYPES_NAME = "Seeded default Inbox types";

export interface DefaultInboxTypeSpec {
  /** Stored only in the marker, not on the type. */
  key: string;
  emoji: string;
  processingMethod: ProcessingMethod;
  targetDatabase?: InboxTypeTargetDatabase;
}

/**
 * In creation order; names come from `seed.inboxTypes.<key>.name`. A module bringing its own default appends one row:
 * an already-seeded tenant receives just that type at the next run.
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
 * Runs in the caller's transaction and resolves to the keys it created.
 *
 * The System settings item is locked first as the serialization point, so concurrent seeders of one tenant take turns
 * and the second reads the first one's marker. A key in the marker is never created again, so a type the user deleted
 * or renamed does not come back. A default whose target database is missing is skipped and not recorded, so a later
 * run creates it. Types go through the choke point so the Inbox type write hook validates them. Names use the tenant
 * user's language (Czech with no user), fixed at creation.
 *
 * `defaults` exists for tests. Throws when the settings database lacks the marker property or the marker is not a
 * list of strings.
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
