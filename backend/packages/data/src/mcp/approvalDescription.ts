// Builds the snapshotted, localisable description of a new approval request (issue #1683).
//
// Template contract (read by the web catalog `web/src/i18n/messages.ts`, `approval.*` keys, in
// English and Czech; push notifications render the same keys):
// - The stored `key` is an English camelCase template key and `params` hold names and counts taken
//   at the moment of the request. The description is never rendered text and never changes later.
// - Names are display names, never ids. `databaseKey` is the canonical database key (null for a
//   user-created database) so a client can choose the word and its grammatical form; the backend
//   does not know singular forms or declension of a database name.
// - A description never carries argument values (an MCP request only names its server and tool).
// - `endsInheritance` is omitted here; the value-link work (#1713, #1791) fills it later.
// Templates and params:
//   approval.itemPatch        {itemName, databaseKey, databaseName}
//   approval.relationPut      {fromItemName, fromDatabaseKey, toItemName, toDatabaseKey}
//   approval.relationSet      {fromItemName, fromDatabaseKey, propertyName}
//   approval.itemDelete       {itemName, databaseKey, databaseName, projectName?, linkedCount, restorableDays}
//   approval.propertyDelete   {propertyName, databaseKey, databaseName, affectedCount}
//   approval.databaseArchive  {databaseName, affectedCount}
//   approval.viewDelete       {viewName, databaseName}
//   approval.relationDelete   {fromItemName, fromDatabaseKey, toItemName, toDatabaseKey}
//   approval.pageRestore      {itemName, databaseKey, databaseName}   (issue #1617; the restored instant is an argument value, so it is not in the description)
//   approval.mcpInvoke        {serverName, toolName}
// Constrained by: docs/adr/2026-09-18-exactly-once-execution-of-approved-destructive-operations.md
import type { PoolClient } from "pg";
import type { DestructiveOperationCheck } from "../chokePoint/destructiveProjection.js";
import type { PageRestoreCheck } from "../docs/docPageRestore.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import { NotFoundError } from "../errors.js";
import { TRASH_RETENTION_DAYS } from "../trash/purgeExpiredTrash.js";
import type { ApprovalDescription } from "./approvalRequestsStore.js";

type DescriptionParams = ApprovalDescription["params"];

async function nameOf(
  client: PoolClient,
  item: { databaseId: string; properties: Record<string, unknown> },
): Promise<string | null> {
  const [label] = await databasesStore.listDatabaseLabelsByIds(client, [item.databaseId]);
  const title = label?.titlePropertyKey ? item.properties[label.titlePropertyKey] : undefined;
  if (typeof title === "string") return title;
  return typeof item.properties.name === "string" ? item.properties.name : null;
}

async function requireDatabase(client: PoolClient, id: string) {
  const database = await databasesStore.getDatabase(client, id);
  if (!database) throw new NotFoundError(`Database ${id} not found`);
  return database;
}

/** The database's display name; a system database without a name override falls back to its key. */
function databaseDisplayName(database: { name: string | null; key: string | null }): string {
  return database.name ?? database.key ?? "";
}

async function requireItem(client: PoolClient, id: string) {
  const [item] = await itemsStore.getItemsByIds(client, [id]);
  if (!item) throw new NotFoundError(`Item ${id} not found`);
  return item;
}

/** Live items of a database; with a `propertyKey`, only those holding a non-null value for it. */
async function countLiveItems(client: PoolClient, databaseId: string, propertyKey: string | null): Promise<number> {
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*) AS count FROM items
      WHERE database_id = $1 AND deleted_at IS NULL
        AND ($2::text IS NULL OR COALESCE(jsonb_typeof(properties -> $2::text), 'null') <> 'null')`,
    [databaseId, propertyKey],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * The description of a generic operation, read on the same client (and
 * so in the same transaction) as the request insert that stores it.
 */
export async function buildDestructiveApprovalDescription(
  client: PoolClient,
  check: DestructiveOperationCheck | PageRestoreCheck,
  currentResource?: unknown,
): Promise<ApprovalDescription> {
  if (typeof currentResource === "object" && currentResource !== null && "approvalDescription" in currentResource) {
    const candidate: unknown = currentResource.approvalDescription;
    if (typeof candidate === "object" && candidate !== null && "key" in candidate && typeof candidate.key === "string" && "params" in candidate && typeof candidate.params === "object" && candidate.params !== null && !Array.isArray(candidate.params)) {
      const params: Record<string, string | number | null> = {};
      for (const [key, value] of Object.entries(candidate.params)) {
        if (typeof value !== "string" && typeof value !== "number" && value !== null) throw new Error("Invalid approval description parameter");
        params[key] = value;
      }
      return { key: candidate.key, params };
    }
    if (candidate !== undefined) throw new Error("Invalid approval description");
  }
  switch (check.operation) {
    case "item.patch": {
      const item = await requireItem(client, check.input.itemId);
      const database = await requireDatabase(client, item.databaseId);
      return {
        key: "approval.itemPatch",
        params: {
          itemName: await nameOf(client, item),
          databaseKey: database.key,
          databaseName: databaseDisplayName(database),
        },
      };
    }
    case "relation.put": {
      const from = await requireItem(client, check.input.callerItemId);
      const to = await requireItem(client, check.input.targetItemId);
      const [fromDatabase, toDatabase] = await Promise.all([
        requireDatabase(client, from.databaseId),
        requireDatabase(client, to.databaseId),
      ]);
      return {
        key: "approval.relationPut",
        params: {
          fromItemName: await nameOf(client, from),
          fromDatabaseKey: fromDatabase.key,
          toItemName: await nameOf(client, to),
          toDatabaseKey: toDatabase.key,
        },
      };
    }
    case "relation.set": {
      const from = await requireItem(client, check.input.callerItemId);
      const database = await requireDatabase(client, from.databaseId);
      const property = await propertiesStore.getProperty(client, check.input.relationPropertyId);
      if (!property) throw new NotFoundError(`Property ${check.input.relationPropertyId} not found`);
      return {
        key: "approval.relationSet",
        params: {
          fromItemName: await nameOf(client, from),
          fromDatabaseKey: database.key,
          propertyName: property.name ?? property.key,
        },
      };
    }
    case "page.restoreVersion": {
      const item = await requireItem(client, check.input.itemId);
      const database = await requireDatabase(client, item.databaseId);
      return {
        key: "approval.pageRestore",
        params: {
          itemName: await nameOf(client, item),
          databaseKey: database.key,
          databaseName: databaseDisplayName(database),
        },
      };
    }
    case "item.delete": {
      const item = await requireItem(client, check.input.itemId);
      const database = await requireDatabase(client, item.databaseId);
      const params: DescriptionParams = {
        itemName: await nameOf(client, item),
        databaseKey: database.key,
        databaseName: databaseDisplayName(database),
        linkedCount: new Set(
          (await relationsStore.listAllRelationsForItem(client, item.id)).map((relation) =>
            relationsStore.otherSide(relation, item.id),
          ),
        ).size,
        restorableDays: TRASH_RETENTION_DAYS,
      };
      if (database.ownerProjectItemId) {
        const [project] = await itemsStore.getItemsByIds(client, [database.ownerProjectItemId]);
        const projectName = project ? await nameOf(client, project) : null;
        if (projectName !== null) params.projectName = projectName;
      }
      return { key: "approval.itemDelete", params };
    }
    case "property.delete": {
      const property = await propertiesStore.getProperty(client, check.input.propertyId);
      if (!property) throw new NotFoundError(`Property ${check.input.propertyId} not found`);
      const database = await requireDatabase(client, property.databaseId);
      return {
        key: "approval.propertyDelete",
        params: {
          propertyName: property.name ?? property.key,
          databaseKey: database.key,
          databaseName: databaseDisplayName(database),
          affectedCount: await countLiveItems(client, database.id, property.key),
        },
      };
    }
    case "database.archive": {
      const database = await requireDatabase(client, check.input.databaseId);
      return {
        key: "approval.databaseArchive",
        params: {
          databaseName: databaseDisplayName(database),
          affectedCount: await countLiveItems(client, database.id, null),
        },
      };
    }
    case "view.delete": {
      const view = await viewsStore.getView(client, check.input.viewId);
      if (!view) throw new NotFoundError(`View ${check.input.viewId} not found`);
      const database = view.databaseId ? await requireDatabase(client, view.databaseId) : null;
      return {
        key: "approval.viewDelete",
        params: { viewName: view.name, databaseName: database ? databaseDisplayName(database) : null },
      };
    }
    case "relation.delete": {
      const from = await requireItem(client, check.input.callerItemId);
      const to = await requireItem(client, check.input.targetItemId);
      const [fromDatabase, toDatabase] = await Promise.all([
        requireDatabase(client, from.databaseId),
        requireDatabase(client, to.databaseId),
      ]);
      return {
        key: "approval.relationDelete",
        params: {
          fromItemName: await nameOf(client, from),
          fromDatabaseKey: fromDatabase.key,
          toItemName: await nameOf(client, to),
          toDatabaseKey: toDatabase.key,
        },
      };
    }
  }
}

/** The description of a deferred MCP tool call: only the server and tool names, never argument values. */
export function buildMcpInvokeApprovalDescription(serverName: string | null, toolName: string): ApprovalDescription {
  return { key: "approval.mcpInvoke", params: { serverName, toolName } };
}
