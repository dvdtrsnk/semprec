import {
  CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID,
  CALENDAR_INGEST_INVITATION_ACTION_ID,
} from "../calendar/invitationActionKeys.js";
import { MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID } from "../mail/personLinkingKeys.js";

/**
 * Deterministic `onItemEvent` actions on every new Email whose fires of one transaction share one job: a mail sync
 * batch creates many Emails at once, and for most of them these actions find nothing to do. Their handlers are
 * idempotent per item, as a queue retry already requires.
 */
export const ITEM_EVENT_BATCH_ACTION_IDS: ReadonlySet<string> = new Set([
  MAIL_LINK_EMAIL_TO_PEOPLE_ACTION_ID,
  CALENDAR_INGEST_INVITATION_ACTION_ID,
  CALENDAR_APPLY_INVITATION_REPLY_ACTION_ID,
]);
