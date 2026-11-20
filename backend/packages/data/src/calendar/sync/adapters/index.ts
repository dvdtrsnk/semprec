import type { CalendarSyncAdapterRegistry } from "../adapter.js";
import { createCalDavAdapter } from "./caldav/caldavAdapter.js";

/** The production adapter of each sync mode; a mode without one fails its passes with status `error`. */
export const CALENDAR_SYNC_ADAPTERS: CalendarSyncAdapterRegistry = Object.freeze({
  imap: (account) => createCalDavAdapter(account),
});
