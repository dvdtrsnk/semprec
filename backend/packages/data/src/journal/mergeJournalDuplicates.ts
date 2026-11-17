import { parseMarkdown, serializeBlocks, serializeInline } from "@semprec/block-model";
import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { itemDeleteWithClient } from "../chokePoint/itemTrash.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { moveRelationEdgesWithClient, type RefusedRelationEdge } from "../chokePoint/relationOps.js";
import { SYSTEM_WRITER } from "../chokePoint/writerKind.js";
import { requireManagedTransaction, runAfterCommit } from "../db/pool.js";
import { insertPageMarkdown, readPageMarkdown } from "../docs/pageMarkdown.js";
import { NotFoundError } from "../errors.js";
import { moveJournalDayEdges } from "../inbox/moveJournalDayEdges.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { syncJournalEventLinks } from "./journalEventLinks.js";
import type { JournalPeriodType } from "./journalPeriods.js";
import { lockJournalDuplicatePair } from "./journalStore.js";
import { logger } from "./logger.js";

export interface MergeJournalDuplicatesInput {
  periodType: JournalPeriodType;
  period: string;
}

export interface MergeJournalDuplicatesResult {
  /** Created first; stays live and receives the content and the edges. */
  survivorId: string;
  mergedItemId: string;
  /** Edges the choke point refused for the survivor; they stay on the merged entry in the Trash. */
  refusedEdges: RefusedRelationEdge[];
}

const HEADING_TYPES: ReadonlySet<string> = new Set(["h1", "h2", "h3"]);

/** Drops the duplicate's leading heading when the survivor's page starts with the same one. */
function withoutRepeatedHeading(duplicateMarkdown: string, survivorMarkdown: string): string {
  const [heading, ...rest] = parseMarkdown(duplicateMarkdown);
  const [survivorHeading] = parseMarkdown(survivorMarkdown);
  if (!heading || !survivorHeading || !HEADING_TYPES.has(heading.type) || heading.type !== survivorHeading.type) {
    return duplicateMarkdown;
  }
  if (serializeInline(heading.text ?? []) !== serializeInline(survivorHeading.text ?? [])) return duplicateMarkdown;
  return serializeBlocks(rest);
}

/**
 * Merges the two oldest live entries of a period: the newer one's page is appended to the survivor's, its edges
 * move over and it goes to the Trash. Returns `null` (writing nothing) with fewer than two live entries; more
 * duplicates take one call each. Must run inside the caller's `withTransaction`, so any failure leaves both entries
 * unchanged.
 *
 * System-owned `events` is not moved but re-derived from the merged page by `syncJournalEventLinks`. Edges the
 * choke point refuses for the survivor (trashed other item, derived `area`) stay on the duplicate and are reported
 * in `refusedEdges` and logged after commit with ids, code and `field` only, never names or content.
 */
export async function mergeJournalDuplicates(
  client: PoolClient,
  input: MergeJournalDuplicatesInput,
): Promise<MergeJournalDuplicatesResult | null> {
  requireManagedTransaction(client);
  const journal = await getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
  if (!journal) throw new NotFoundError("Journal database not found");
  const pair = await lockJournalDuplicatePair(client, {
    journalDatabaseId: journal.id,
    type: input.periodType,
    period: input.period,
  });
  if (!pair) return null;
  const { survivorId, duplicateId } = pair;

  const duplicatePage = await readPageMarkdown(client, duplicateId);
  const survivorPage = await readPageMarkdown(client, survivorId);
  await insertPageMarkdown(client, survivorId, {
    placement: "end",
    markdown: withoutRepeatedHeading(duplicatePage.markdown, survivorPage.markdown),
    origin: "system",
  });

  const refusedEdges: RefusedRelationEdge[] = [];
  for (const property of await propertiesStore.listPropertiesByDatabase(client, journal.id)) {
    if (property.type !== "relation" || property.owner !== "user") continue;
    const { refused } = await moveRelationEdgesWithClient(client, {
      relationPropertyId: property.id,
      side: "caller",
      fromItemId: duplicateId,
      toItemId: survivorId,
    });
    refusedEdges.push(...refused);
  }
  await syncJournalEventLinks(client, survivorId, (await readPageMarkdown(client, survivorId)).markdown);
  refusedEdges.push(...(await moveJournalDayEdges(client, { fromDayItemId: duplicateId, toDayItemId: survivorId })));

  const trashed = await itemDeleteWithClient(client, journal.id, duplicateId, {
    queueAffinity: createActionQueueAffinity(),
    writer: SYSTEM_WRITER,
  });
  // Locked since `lockJournalDuplicatePair`, so a missing row means the lock was not held.
  if (!trashed) throw new Error(`Journal entry ${duplicateId} disappeared during its merge`);
  // Logged after commit, so a rolled-back merge logs nothing.
  for (const { relationPropertyId, otherItemId, code, field } of refusedEdges) {
    runAfterCommit(client, () =>
      logger.info(
        { survivorId, mergedItemId: duplicateId, relationPropertyId, otherItemId, code, field },
        "Journal duplicate merge left a refused edge on the merged entry",
      ),
    );
  }
  return { survivorId, mergedItemId: duplicateId, refusedEdges };
}
