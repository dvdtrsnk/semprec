import type { PoolClient } from "pg";
import { assertWriterDatabaseAccess } from "../agentGrants/agentDatabaseAccess.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { parseJournalPeriodKey, type JournalPeriodType } from "./journalPeriods.js";
import { mergeJournalDuplicates } from "./mergeJournalDuplicates.js";

/** The period `page.mergeJournalDuplicates` (issue #2017) works on, named as the operation's input names it. */
export interface JournalMergePeriod {
  type: JournalPeriodType;
  period: string;
}

/** The entries one approved merge was shown to the user for. */
export interface ApprovedJournalPair {
  survivorId: string;
  mergedItemId: string;
}

/** What `page.mergeJournalDuplicates` returns: the two entries, or `{ merged: false }` when the period had no two live entries. */
export type JournalMergeOutcome = ApprovedJournalPair | { merged: false };

/**
 * The Journal database of the tenant, after the checks every use of the operation shares and in this order: the writer
 * that carries an `agentProjectItemId` needs `write` access to it (so a malformed period is a 403 for a read-only
 * project, as for `page.ensureJournalPeriod`), then `period` has to be a canonical, existing key of `type` in the system
 * time zone (`ValidationError` on `period`, 400).
 */
export async function requireJournalForMerge(
  client: PoolClient,
  period: JournalMergePeriod,
  writer: Pick<WriterIdentity, "agentProjectItemId">,
) {
  const journal = await getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
  if (!journal) throw new NotFoundError("Journal database not found");
  await assertWriterDatabaseAccess(client, writer, journal.id, "write");
  parseJournalPeriodKey(period.type, period.period, await getSystemTimezone(client));
  return journal;
}

/**
 * `page.mergeJournalDuplicates` (issue #2017) in the caller's `withTransaction`: merges the two live entries of the
 * period that were created first through `mergeJournalDuplicates` (issue #1726), or answers `{ merged: false }` when
 * the period has fewer than two. Nothing here asks for approval: a person's own call is their decision, and the generic
 * operation gateway, which every agent call passes through, holds an agent's call for approval and replays it here.
 *
 * With `approved` the merge also has to be the one the user was shown: it has to take exactly the approved pair, or
 * find no pair when the approval named none. Any other result throws a `ConflictError` (409) after the merge ran, so
 * a caller that lets it escape its `withTransaction` rolls the merge back. A period for which the approval named no pair and which
 * still has none answers `{ merged: false }`.
 */
export async function mergeJournalDuplicatesForWriter(
  client: PoolClient,
  period: JournalMergePeriod,
  writer: Pick<WriterIdentity, "agentProjectItemId">,
  approved?: ApprovedJournalPair | null,
): Promise<JournalMergeOutcome> {
  await requireJournalForMerge(client, period, writer);
  const merged = await mergeJournalDuplicates(client, { periodType: period.type, period: period.period });
  if (
    approved !== undefined &&
    (merged?.survivorId !== approved?.survivorId || merged?.mergedItemId !== approved?.mergedItemId)
  ) {
    throw new ConflictError("The Journal period changed after the merge was approved", {
      type: period.type,
      period: period.period,
    });
  }
  return merged ? { survivorId: merged.survivorId, mergedItemId: merged.mergedItemId } : { merged: false };
}
