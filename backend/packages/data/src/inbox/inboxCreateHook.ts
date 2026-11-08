// The choke point's item-create hook for the Inbox database (registered by `../domainWriteHooks.ts`):
// every Inbox item, whichever writer creates it, must carry a calendar `date` and a 24-hour `time`
// as the user's wall clock, and is linked to the Journal day of that date. The hook runs inside the
// create's transaction after the insert, so a refusal rolls the row back, and it does not run on an
// idempotency replay, so a replayed create keeps the one edge it already has.
// See docs/adr/2026-10-09-item-create-domain-hooks.md.
import { DateTime } from "luxon";
import type { ItemCreateHook } from "../chokePoint/hooks.js";
import * as databasesStore from "../chokePoint/databasesStore.js";
import * as propertiesStore from "../chokePoint/propertiesStore.js";
import { createRelationWithClient } from "../chokePoint/relationOps.js";
import type { SystemRelationWriteContext } from "../chokePoint/relationEdgeContext.js";
import { getOrCreateJournalItem } from "../journal/journalStore.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { INBOX_MODULE_ID } from "../seed/inboxPipelineKeys.js";
import { JOURNAL_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { getSystemTimezone } from "../systemSettings.js";
import { assertValidTimezone } from "../timezone.js";
import { enqueueJournalInboxRecompute } from "./journalInboxCompute.js";

const INBOX_RELATION_CONTEXT: SystemRelationWriteContext = { ownerProcess: INBOX_MODULE_ID };

/** `YYYY-MM-DD` only: Luxon also parses `2026` and `2026-W35`, which are not a capture date. */
const CALENDAR_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;
/** `HH:mm` on a 24-hour clock, `00:00` to `23:59`. */
const WALL_CLOCK_TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

function isCalendarDate(value: unknown): value is string {
  // Validity is checked in UTC: whether `2026-02-30` exists does not depend on the zone.
  return (
    typeof value === "string" && CALENDAR_DATE_FORMAT.test(value) && DateTime.fromISO(value, { zone: "utc" }).isValid
  );
}

function isWallClockTime(value: unknown): value is string {
  return typeof value === "string" && WALL_CLOCK_TIME_FORMAT.test(value);
}

export const inboxItemCreateHook: ItemCreateHook = async ({ client, database, item, properties }) => {
  if (database.ownerModuleId !== INBOX_MODULE_ID) return;

  const { date, time } = properties;
  if (!isCalendarDate(date)) {
    throw new ValidationError("Inbox items require a valid calendar date 'YYYY-MM-DD' for 'date'", { field: "date" });
  }
  if (!isWallClockTime(time)) {
    throw new ValidationError("Inbox items require a valid time 'HH:mm' for 'time'", { field: "time" });
  }

  const timezone = await getSystemTimezone(client);
  assertValidTimezone(timezone);
  const journal = await databasesStore.getDatabaseByModuleId(client, JOURNAL_MODULE_ID);
  if (!journal) throw new NotFoundError(`No system database is owned by module '${JOURNAL_MODULE_ID}'`);
  const journalDayProperty = await propertiesStore.getPropertyByKey(client, database.id, "journalDay");
  if (!journalDayProperty)
    throw new NotFoundError(`Inbox database ${database.id} has no 'journalDay' relation property`);

  const referenceDate = DateTime.fromISO(date, { zone: timezone }).toJSDate();
  const journalDay = await getOrCreateJournalItem(client, journal.id, "day", referenceDate, timezone);
  await createRelationWithClient(
    client,
    { relationPropertyId: journalDayProperty.id, callerItemId: item.id, targetItemId: journalDay.id },
    INBOX_RELATION_CONTEXT,
  );
  // Issue #106: a capture is one of the triggers that invalidates the day's cached Inbox-item list.
  await enqueueJournalInboxRecompute(client, journalDay.id);
};
