// A file's company link ends with its Event attachment. The file inherits its project from the Event and its company
// from that project; removing the attachment keeps the project, so the link rules alone would keep the company
// following it. The project and company edges stay and read as the file's own values afterwards.
// Must run before `linkRuleEdgeHook`, which deletes the `projects` link when the Event was its last source; this hook
// must read that link first to tell an inherited project from the file's own.
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import type { RelationEdgeChangedHook } from "../chokePoint/hooks.js";
import { lockItemById } from "../chokePoint/itemsStore.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { getRelationDefinitionByPropertyId } from "../chokePoint/relationsStore.js";
import {
  deleteEmptyValueLink,
  listValueLinkSourcesByLinkIds,
  lockValueLink,
  removeValueLinkItemSource,
  type ValueLinkRow,
} from "../chokePoint/valueLinksStore.js";
import { runAfterCommit } from "../db/pool.js";
import { notifyInvalidation } from "../realtimeHook.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";

const PROJECTS_PROPERTY_KEY = "projects";
const COMPANIES_PROPERTY_KEY = "companies";
const PROJECTS_RULE_KEY = "fileProjectsFromEvents";
const COMPANIES_RULE_KEY = "fileCompaniesFromProjects";

interface FileEventRelation {
  filesDatabaseId: string;
  definitionId: string;
}

async function loadFileEventRelation(client: PoolClient): Promise<FileEventRelation | null> {
  const files = await getDatabaseByModuleId(client, FILES_MODULE_ID);
  const property = files && (await getPropertyByKey(client, files.id, "events"));
  const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
  if (!files || !property || !definition) return null;
  return { filesDatabaseId: files.id, definitionId: definition.id };
}

async function itemSourceIds(client: PoolClient, link: ValueLinkRow): Promise<string[]> {
  const sources = await listValueLinkSourcesByLinkIds(client, [link.id]);
  return sources.flatMap((source) => (source.kind === "item" ? [source.sourceItemId] : []));
}

/** A link that still keeps a source fails the caller's transaction. */
async function deleteLinkWithSources(client: PoolClient, link: ValueLinkRow, what: string): Promise<void> {
  for (const source of await listValueLinkSourcesByLinkIds(client, [link.id])) {
    if (source.kind === "item")
      await removeValueLinkItemSource(client, link.id, source.sourceItemId, source.sourcePropertyKey);
  }
  if (!(await deleteEmptyValueLink(client, link.id)))
    throw new Error(`File ${what} link kept a source during its release`);
}

/**
 * Lock order: file row, `projects` link, `companies` link.
 *
 * - Removed Event was the only source of the rule's `projects` link: delete it and the rule's `companies` link.
 * - Other Events remain: drop this source when the link is not `on`, or when the file is trashed (the engine's hook
 *   skips trashed targets). A live `on` link is left to the engine's hook. `companies` stays.
 * - Otherwise nothing changes, so a company following the file's own project keeps following it.
 */
export const eventAttachmentLinkReleaseEdgeChangedHook: RelationEdgeChangedHook = async (context) => {
  if (context.op !== "delete") return;
  const { client } = context;
  const relation = await loadFileEventRelation(client);
  if (!relation || relation.definitionId !== context.relationDefinitionId) return;
  // Whichever side is a Files row is the file.
  const file =
    (await lockItemById(client, relation.filesDatabaseId, context.itemA)) ??
    (await lockItemById(client, relation.filesDatabaseId, context.itemB));
  if (!file) return;
  const eventId = file.id === context.itemA ? context.itemB : context.itemA;
  const projectsLink = await lockValueLink(client, file.id, PROJECTS_PROPERTY_KEY);
  if (!projectsLink || projectsLink.ruleKey !== PROJECTS_RULE_KEY) return;
  const sourceIds = await itemSourceIds(client, projectsLink);
  if (!sourceIds.includes(eventId)) return;

  if (sourceIds.every((sourceId) => sourceId === eventId)) {
    await deleteLinkWithSources(client, projectsLink, "projects");
    const companiesLink = await lockValueLink(client, file.id, COMPANIES_PROPERTY_KEY);
    if (companiesLink && companiesLink.ruleKey === COMPANIES_RULE_KEY)
      await deleteLinkWithSources(client, companiesLink, "companies");
  } else if (projectsLink.state !== "on" || file.deletedAt) {
    // `linkRuleEdgeHook` skips trashed targets, so only this hook can drop the source for them.
    for (const source of await listValueLinkSourcesByLinkIds(client, [projectsLink.id])) {
      if (source.kind === "item" && source.sourceItemId === eventId)
        await removeValueLinkItemSource(client, projectsLink.id, eventId, source.sourcePropertyKey);
    }
  } else {
    return;
  }
  runAfterCommit(client, () =>
    notifyInvalidation({
      scope: "item",
      databaseId: file.databaseId,
      itemId: file.id,
      op: "update",
      updatedAt: file.updatedAt,
    }),
  );
};
