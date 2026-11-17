import type { PoolClient } from "pg";
import { assertWriterDatabaseAccess } from "../agentGrants/agentDatabaseAccess.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { ConflictError, NotFoundError } from "../errors.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { parseJournalPeriodKey, type JournalPeriodType } from "./journalPeriods.js";
import { mergeJournalDuplicates } from "./mergeJournalDuplicates.js";

export interface JournalMergePeriod {
  type: JournalPeriodType;
  period: string;
}

export interface ApprovedJournalPair {
  survivorId: string;
  mergedItemId: string;
}

export type JournalMergeOutcome = ApprovedJournalPair | { merged: false };

/**
 * Access is checked before the period key, so a malformed period is a 403 for a read-only project (as for
 * `page.ensureJournalPeriod`).
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
 * No approval is asked here: a person's own call is their decision, and the operation gateway holds an agent's call
 * for approval and replays it here.
 *
 * With `approved`, the merge must take exactly the approved pair (or find none when none was approved); otherwise a
 * 409 is thrown after the merge ran, so escaping the caller's `withTransaction` rolls it back.
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
