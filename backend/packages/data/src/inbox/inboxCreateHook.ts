// Every Inbox item, whichever writer creates it, must carry a calendar `date` and a 24-hour `time` (the user's wall
// clock) and is linked to that Journal day. Runs in the create's transaction after the insert, so a refusal rolls the
// row back; not run on an idempotency replay, so a replay keeps its one edge.
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
const WALL_CLOCK_TIME_FORMAT = /^([01]\d|2[0-3]):[0-5]\d$/;

function isCalendarDate(value: unknown): value is string {
  // Whether `2026-02-30` exists does not depend on the zone.
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
  // A capture invalidates the day's cached Inbox-item list.
  await enqueueJournalInboxRecompute(client, journalDay.id);
};
