import type { PoolClient } from "pg";
import { assertWriterDatabaseAccess } from "../agentGrants/agentDatabaseAccess.js";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import type { WriterIdentity } from "../chokePoint/writerKind.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { computeJournalPeriodKey, parseJournalPeriodKey, type JournalPeriodType } from "./journalPeriods.js";
import { ensureJournalPeriodDoc } from "./journalStore.js";

/** A Journal period named by its canonical key or by a calendar day (`YYYY-MM-DD`) inside it; exactly one of the two is given. */
export interface JournalPeriodSelector {
  date?: string | undefined;
  period?: string | undefined;
}

/**
 * `page.ensureJournalPeriod` (issue #1861) in the caller's transaction: the Journal entry of the period and its page,
 * created when the period has none (`ensureJournalPeriodDoc`, the lazy creation behind `PUT /api/journal/periods/:type/:period/doc`).
 *
 * A writer that carries an `agentProjectItemId` needs `write` access to the Journal database, checked before anything is
 * created or validated, like every other write of an agent (docs/adr/2026-11-12-per-database-agent-grants.md). A `date`
 * is read as a calendar day of the system time zone and turned into the key of the period of `type` that contains it
 * (the week containing 2026-10-16 is `2026-W42`); a `period` is validated by `ensureJournalPeriodDoc`, a malformed or
 * non-existent key being a `ValidationError` on `period`; naming both or neither is a `ValidationError` on `period`. An
 * existing live entry is returned, never duplicated.
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
