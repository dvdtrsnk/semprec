// Issue #1756: a file's company link ends together with its attachment to an Event. A file attached to an
// Event inherits its project from the Event (rule `fileProjectsFromEvents`) and its company from that project
// (rule `fileCompaniesFromProjects`). Removing the attachment keeps the file in Files with its project, so the
// link rules alone would keep the company following that project. The hook below ends the company link in the
// transaction that removes the `Files.events` edge; the project and company edges are not touched and read as
// the file's own values from then on.
// It runs before `linkRuleEdgeHook`, because the engine deletes the file's `projects` link when the removed Event
// was its last source, and the hook has to read that link first to tell this file from one whose project is its own.
// Registered in `../domainWriteHooks.ts`. Constrained by:
// docs/adr/2026-11-15-an-event-attachments-company-link-ends-with-the-attachment.md,
// docs/adr/2026-11-10-transcript-values-are-inherited-by-link-rules-whichever-process-writes-the-edge.md,
// docs/adr/2026-09-30-choke-point-domain-hooks-through-a-per-process-registry.md
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

/** The Files `events` relation of the caller's tenant, or `null` in a tenant without it. */
async function loadFileEventRelation(client: PoolClient): Promise<FileEventRelation | null> {
  const files = await getDatabaseByModuleId(client, FILES_MODULE_ID);
  const property = files && (await getPropertyByKey(client, files.id, "events"));
  const definition = property && (await getRelationDefinitionByPropertyId(client, property.id));
  if (!files || !property || !definition) return null;
  return { filesDatabaseId: files.id, definitionId: definition.id };
}

/** The item sources of a locked link, as the ids of the items they name. */
async function itemSourceIds(client: PoolClient, link: ValueLinkRow): Promise<string[]> {
  const sources = await listValueLinkSourcesByLinkIds(client, [link.id]);
  return sources.flatMap((source) => (source.kind === "item" ? [source.sourceItemId] : []));
}

/**
 * Deletes the caller-locked link with every item source it has. The final delete succeeds only when no source
 * row is left, so a link that keeps a source fails the caller's transaction.
 */
async function deleteLinkWithSources(client: PoolClient, link: ValueLinkRow, what: string): Promise<void> {
  for (const source of await listValueLinkSourcesByLinkIds(client, [link.id])) {
    if (source.kind === "item")
      await removeValueLinkItemSource(client, link.id, source.sourceItemId, source.sourcePropertyKey);
  }
  if (!(await deleteEmptyValueLink(client, link.id)))
    throw new Error(`File ${what} link kept a source during its release`);
}

/**
 * After a Files `events` edge was removed (issue #1530's hook), for the file, the edge's item that is a row of the
 * Files database, trashed or not: locks the file row, then its `projects` link row, then its `companies` link row,
 * and ends the links of the attachment.
 *
 * - When the `projects` link is the one of rule `fileProjectsFromEvents` and the removed Event is its only
 *   source, whatever the link's state, the hook deletes that link and the `companies` link of rule
 *   `fileCompaniesFromProjects`, whatever its state, with their source rows. The file is announced after the commit.
 * - When another Event still feeds that `projects` link, the hook removes the removed Event from the sources of a
 *   link that is not `on` and announces the file, and does the same for a link that is `on` while the file is in
 *   the Trash, because the link engine's hook, which runs after this one, skips a target in the Trash. A live
 *   link that is `on` is left to that hook, which removes the source and recomputes the projects. The
 *   `companies` link stays.
 * - Otherwise (the file has no `projects` link, the link is of another rule, or it does not name the removed
 *   Event) nothing changes, so a company that follows a project the file had on its own keeps following it.
 */
export const eventAttachmentLinkReleaseEdgeChangedHook: RelationEdgeChangedHook = async (context) => {
  if (context.op !== "delete") return;
  const { client } = context;
  const relation = await loadFileEventRelation(client);
  if (!relation || relation.definitionId !== context.relationDefinitionId) return;
  // The Files side of the edge is the one item that is a row of the Files database; the lock finds it and takes it.
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
    // The engine's hook leaves a target in the Trash alone (`linkRuleEdgeHook`), so for such a file this hook is the
    // only one that takes the removed Event out of the sources, whatever the link's state.
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
