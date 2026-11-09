import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { serializeBlocks } from "@semprec/block-model";
import { loadModuleCatalogs, resolveCatalogLabel } from "@semprec/module-registry";
import { getTenantUserLocale, getUserById } from "../auth/usersStore.js";
import { getItemsByIds } from "../chokePoint/itemsStore.js";
import { insertPageMarkdown } from "../docs/pageMarkdown.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";

export async function insertInboxOriginNotes(
  client: PoolClient,
  itemIds: readonly string[],
  sourceId: string | null,
  actingUserId?: string,
): Promise<void> {
  if (!sourceId || itemIds.length === 0) return;
  const [source] = await getItemsByIds(client, [sourceId]);
  if (!source) throw new Error("Inbox origin source disappeared");
  const locale = actingUserId ? (await getUserById(client, actingUserId))?.locale : await getTenantUserLocale(client);
  const catalogs = await loadModuleCatalogs(new URL("../seed/systemDatabasesModuleManifest.js", import.meta.url).href);
  const label = resolveCatalogLabel(null, catalogs[toManifestLocale(locale ?? "cs")], catalogs.en, "inbox.originNote.prefix");
  const text = typeof source.properties.text === "string" ? source.properties.text : "";
  const markdown = serializeBlocks([{ id: randomUUID(), type: "text", indent: 0, text: [{ insert: `${label} ${text}` }] }]);
  for (const itemId of itemIds) await insertPageMarkdown(client, itemId, { markdown, placement: "start", origin: "user" });
}
