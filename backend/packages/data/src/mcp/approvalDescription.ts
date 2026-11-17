// Builds the snapshotted, localisable description of a new approval request.
//
// Template contract (web catalog `approval.*` keys in English and Czech; push notifications render the same keys):
// - `key` is an English camelCase template key; `params` are names and counts taken at request time. Never
//   rendered text and never changed later.
// - Names are display names, never ids. `databaseKey` is the canonical key (null for a user-created database) so
//   the client picks the word and its grammatical form; the backend knows no declension.
// - Argument values (restored instants, Markdown, recipients, subject, body, page content) are never included.
// - `breaksLinks`/`endsInheritance` are added by `approvalBreaksLink.ts` only when value links would end.
// Templates and params:
//   approval.itemPatch        {itemName, databaseKey, databaseName}
//   approval.relationPut      {fromItemName, fromDatabaseKey, toItemName, toDatabaseKey}
//   approval.relationSet      {fromItemName, fromDatabaseKey, propertyName}
//   approval.itemDelete       {itemName, databaseKey, databaseName, projectName?, linkedCount, restorableDays, seriesInstanceCount?, attachmentCount?, hostEventCount?}   (the optional counts are the module's delete impact, omitted when it reports none)
//   approval.propertyDelete   {propertyName, databaseKey, databaseName, affectedCount}
//   approval.databaseArchive  {databaseName, affectedCount}
//   approval.viewDelete       {viewName, databaseName}
//   approval.relationDelete   {fromItemName, fromDatabaseKey, toItemName, toDatabaseKey}
//   approval.pageRestore      {itemName, databaseKey, databaseName}
//   approval.pageReplace      {itemName, databaseKey, databaseName}
//   approval.pageConvertToBlock {pageName, blockType, pageCount}   (pageCount includes the page itself)
//   approval.journalMerge     {periodType, period, survivorName, mergedName}   (names `null` when the period has no two live entries)
//   approval.mcpInvoke        {serverName, toolName}
//   approval.moduleTool       {toolName}   (the module agent tool's manifest name)
//   approval.emailSend        {mailboxName, recipientCount}   (`mail/mailSendApproval.ts`)
//   approval.heartbeatCreate      {heartbeatName, projectName, rule, task}   (`scheduler/heartbeatApprovalDescription.ts`; task is a cut JSON string)
//   approval.heartbeatUpdate      {heartbeatName, projectName, changes}   (each changed field with its new value)
//   approval.heartbeatSetEnabled  {heartbeatName, projectName, state}
//   approval.changesSeries    {taskName, fromRule, toRule}
//   approval.breaksLink       {itemName, databaseKey, propertyName, sourceItemName, sourceDatabaseKey, newValueName}
import type { PoolClient } from "pg";
import { z } from "zod";
import type { ItemDeleteImpact } from "../chokePoint/hooks.js";
import type { DestructiveOperationCheck } from "../chokePoint/destructiveProjection.js";
import type { PageRestoreCheck } from "../docs/docPageRestore.js";
import type { PageConvertCheck } from "../docs/pageConvertApproval.js";
import type { PageReplaceCheck } from "../docs/pageReplaceApproval.js";
import type { JournalMergeCheck } from "../journal/journalMergeApproval.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as itemsStore from "../chokePoint/itemsStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import * as relationsStore from "../chokePoint/relationsStore.js";
import * as viewsStore from "../chokePoint/viewsStore.js";
import { NotFoundError } from "../errors.js";
import { RETENTION_DAYS } from "../trash/purgeExpiredTrash.js";
import type { BreakingValueLinks } from "../chokePoint/valueLinkApproval.js";
import { describeBreakingLinks, isLinkDeferralOperation } from "./approvalBreaksLink.js";
import type { ApprovalDescription } from "./approvalRequestsStore.js";

type DescriptionParams = ApprovalDescription["params"];

const itemDeleteImpactSchema = z
  .object({
    seriesInstanceCount: z.number().int(),
    attachmentCount: z.number().int(),
    hostEventCount: z.number().int(),
  })
  .strict();

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

/** A system database without a name override falls back to its key. */
function databaseDisplayName(database: { name: string | null; key: string | null }): string {
  return database.name ?? database.key ?? "";
}

async function requireItem(client: PoolClient, id: string) {
  const [item] = await itemsStore.getItemsByIds(client, [id]);
  if (!item) throw new NotFoundError(`Item ${id} not found`);
  return item;
}

/** With a `propertyKey`, only items holding a non-null value for it. */
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
 * Read on the request insert's client, so in the same transaction. When `valueLinks` would end, an
 * `item.patch`, `relation.put`, `relation.set` or `link.unlink` becomes `approval.breaksLink`, unless the owning
 * module supplied its own description through the projection.
 */
export async function buildDestructiveApprovalDescription(
  client: PoolClient,
  check: DestructiveOperationCheck | PageRestoreCheck | PageReplaceCheck | PageConvertCheck | JournalMergeCheck,
  currentResource?: unknown,
  valueLinks?: BreakingValueLinks,
): Promise<ApprovalDescription> {
  if (
    check.operation === "page.restoreVersion" ||
    check.operation === "page.replace" ||
    check.operation === "page.convertToBlock" ||
    check.operation === "page.mergeJournalDuplicates" ||
    valueLinks === undefined ||
    valueLinks.links.length === 0
  ) {
    if (check.operation === "link.unlink") throw new Error("A link.unlink request is described by the link it ends");
    return buildOperationDescription(client, check, currentResource);
  }
  const breaks = await describeBreakingLinks(client, check, valueLinks);
  const lists = { breaksLinks: breaks.breaksLinks, endsInheritance: breaks.endsInheritance };
  if (check.operation === "link.unlink") return { ...breaks.description, ...lists };
  const ownDescription =
    !isLinkDeferralOperation(check.operation) || hasModuleDescription(currentResource)
      ? await buildOperationDescription(client, check, currentResource)
      : breaks.description;
  return { ...ownDescription, ...lists };
}

/**
 * `null` when the module reports none. These are the counts the snapshot covers, so the description matches what
 * the approver is asked about.
 */
function itemDeleteImpactOf(currentResource: unknown): ItemDeleteImpact | null {
  if (typeof currentResource !== "object" || currentResource === null || !("impact" in currentResource)) return null;
  const parsed = itemDeleteImpactSchema.safeParse(currentResource.impact);
  if (!parsed.success) throw new Error("Invalid item delete impact in the approval projection");
  return parsed.data;
}

function hasModuleDescription(currentResource: unknown): boolean {
  return (
    typeof currentResource === "object" &&
    currentResource !== null &&
    "approvalDescription" in currentResource &&
    currentResource.approvalDescription !== undefined
  );
}

async function buildOperationDescription(
  client: PoolClient,
  check:
    | Exclude<DestructiveOperationCheck, { operation: "link.unlink" }>
    | PageRestoreCheck
    | PageReplaceCheck
    | PageConvertCheck
    | JournalMergeCheck,
  currentResource?: unknown,
): Promise<ApprovalDescription> {
  if (typeof currentResource === "object" && currentResource !== null && "approvalDescription" in currentResource) {
    const candidate: unknown = currentResource.approvalDescription;
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "key" in candidate &&
      typeof candidate.key === "string" &&
      "params" in candidate &&
      typeof candidate.params === "object" &&
      candidate.params !== null &&
      !Array.isArray(candidate.params)
    ) {
      const params: Record<string, string | number | null> = {};
      const entries: Array<[string, unknown]> = Object.entries(candidate.params);
      for (const [key, value] of entries) {
        if (typeof value !== "string" && typeof value !== "number" && value !== null)
          throw new Error("Invalid approval description parameter");
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
    case "page.replace": {
      const item = await requireItem(client, check.input.itemId);
      const database = await requireDatabase(client, item.databaseId);
      return {
        key: "approval.pageReplace",
        params: {
          itemName: await nameOf(client, item),
          databaseKey: database.key,
          databaseName: databaseDisplayName(database),
        },
      };
    }
    case "page.convertToBlock":
      // Described by its projection, which read the page's title and the page count (`computePageConvertProjection`).
      throw new Error("A page.convertToBlock request is described by its projection");
    case "page.mergeJournalDuplicates":
      // Described by its projection, which read the two entries' titles (`computeJournalMergeProjection`).
      throw new Error("A page.mergeJournalDuplicates request is described by its projection");
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
        restorableDays: RETENTION_DAYS,
      };
      if (database.ownerProjectItemId) {
        const [project] = await itemsStore.getItemsByIds(client, [database.ownerProjectItemId]);
        const projectName = project ? await nameOf(client, project) : null;
        if (projectName !== null) params.projectName = projectName;
      }
      const impact = itemDeleteImpactOf(currentResource);
      if (impact !== null) Object.assign(params, impact);
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

/** Never argument values. */
export function buildMcpInvokeApprovalDescription(serverName: string | null, toolName: string): ApprovalDescription {
  return { key: "approval.mcpInvoke", params: { serverName, toolName } };
}

/** Never argument values. */
export function buildModuleToolApprovalDescription(toolName: string): ApprovalDescription {
  return { key: "approval.moduleTool", params: { toolName } };
}
