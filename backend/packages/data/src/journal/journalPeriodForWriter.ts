import type { PoolClient } from "pg";
import { assertWriterDatabaseAccess } from "../agentGrants/agentDatabaseAccess.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { computeJournalPeriodKey, parseJournalPeriodKey, type JournalPeriodType } from "./journalPeriods.js";
import { ensureJournalPeriodDoc } from "./journalStore.js";

/** Exactly one of the two is given. */
export interface JournalPeriodSelector {
  date?: string | undefined;
  period?: string | undefined;
}

/**
 * An agent writer's `write` access is checked before anything is created or validated. A `date` is read in the
 * system time zone and mapped to the containing period's key. An existing live entry is returned, never duplicated.
 */
export async function ensureJournalPeriodForWriter(
  client: PoolClient,
  type: JournalPeriodType,
  selector: JournalPeriodSelector,
  writer: Pick<WriterIdentity, "agentProjectItemId">,
) {
  const journal = await getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
  if (!journal) throw new NotFoundError("Journal database not found");
  await assertWriterDatabaseAccess(client, writer, journal.id, "write");
  const { date, period } = selector;
  if (period !== undefined && date === undefined) return ensureJournalPeriodDoc(client, type, period);
  if (date !== undefined && period === undefined) {
    const { reference } = parseJournalPeriodKey("day", date, await getSystemTimezone(client));
    return ensureJournalPeriodDoc(client, type, computeJournalPeriodKey(type, reference));
  }
  throw new ValidationError("Exactly one of date and period is required", { field: "period" });
}
