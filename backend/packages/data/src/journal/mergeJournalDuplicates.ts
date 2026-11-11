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
  /** The canonical period key, as stored in the entries' `period` property. */
  period: string;
}

export interface MergeJournalDuplicatesResult {
  /** The entry that was created first; it stays live and receives the content and the edges. */
  survivorId: string;
  /** The entry that was merged into the survivor and moved to the Trash. */
  mergedItemId: string;
  /**
   * The relation edges of the merged entry that the survivor did not take, because the choke point refuses them for
   * it. Each one is still stored on the merged entry, in the Trash with it. Empty when the survivor took every edge.
   */
  refusedEdges: RefusedRelationEdge[];
}

const HEADING_TYPES: ReadonlySet<string> = new Set(["h1", "h2", "h3"]);

/**
 * The duplicate's page as it is appended to the survivor's: its canonical Markdown, without its first block when that
 * block is a heading and the survivor's page starts with a heading of the same level and the same inline content.
 */
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
 * Merges the two live Journal entries of one period that were created first (issue #1726): the older one survives, the
 * newer one is merged into it and moved to the Trash. Returns their ids and the edges the survivor did not take, or
 * `null` when the period has fewer than two live entries; a repeated call reads that and writes nothing. A period with
 * more live entries takes one call per duplicate. It must run on the client of the caller's `withTransaction`: every
 * step below is part of that transaction, so a failure of any of them leaves both entries as they were.
 *
 * 1. `lockJournalDuplicatePair` takes the period reservation, row-locks both entries and points the reservation at the
 *    survivor.
 * 2. The duplicate's page is appended to the end of the survivor's page through `insertPageMarkdown`, authored
 *    `system`, in block order, without the duplicate's leading heading when the survivor's page starts with the same
 *    one. The duplicate keeps its own page. What that insertion refuses fails the merge with its error: a page with a
 *    subpage block, or with a link to an item that is not live.
 * 3. The edges of every user-owned relation property of the Journal database move from the duplicate to the survivor
 *    (`moveRelationEdgesWithClient`): an edge the survivor already has is not written twice, and an edge the choke
 *    point would refuse for the survivor (its other item is in the Trash, or the survivor's `area` is derived from its
 *    project) stays on the duplicate. A system-owned relation property is not written here: `events` is made equal
 *    to the event links of the merged page by its owner, `syncJournalEventLinks`.
 * 4. The Inbox module moves the `journalDay` edges of the duplicate's live Inbox items (`moveJournalDayEdges`); the
 *    edge of an Inbox item in the Trash stays on the duplicate.
 * 5. The duplicate is moved to the Trash through the choke point's `itemDeleteWithClient`, as the system writer.
 *
 * A merge that leaves edges on the duplicate in steps 3 and 4 still succeeds, and says so: every such edge is in
 * `refusedEdges` of the result, and one log line per edge, ids and the refusal's code only, is written once the
 * caller's transaction has committed.
 *
 * See docs/adr/2026-11-10-journal-duplicate-merge-locks-the-reservation-before-both-entries.md.
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
  // The row is locked since step 1, so the trash finds it; a missing row would mean the lock was not held.
  if (!trashed) throw new Error(`Journal entry ${duplicateId} disappeared during its merge`);
  // The edges are left behind by design, so the merge goes on; the log is what lets an operator see it. It follows the
  // commit, so a merge that is rolled back logs nothing.
  for (const { relationPropertyId, otherItemId, code } of refusedEdges) {
    runAfterCommit(client, () =>
      logger.info(
        { survivorId, mergedItemId: duplicateId, relationPropertyId, otherItemId, code },
        "Journal duplicate merge left a refused edge on the merged entry",
      ),
    );
  }
  return { survivorId, mergedItemId: duplicateId, refusedEdges };
}
