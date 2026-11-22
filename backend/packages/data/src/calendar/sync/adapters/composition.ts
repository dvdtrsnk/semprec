// What the composition root needs from the calendar sync adapters: the CalDAV check of the password connect route
// and the runtime bindings of the OAuth adapters.
export {
  verifyCalDavServer,
  type CalDavVerification,
  type VerifyCalDavServerInput,
} from "./caldav/caldavConnectVerification.js";
export { setGoogleCalendarSyncRuntime, type GoogleCalendarSyncRuntime } from "./google/googleCalendarAdapter.js";
export { setGraphCalendarSyncRuntime, type GraphCalendarSyncRuntime } from "./graph/graphCalendarAdapter.js";
