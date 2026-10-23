import { DateTime } from "luxon";
import { ValidationError } from "./errors.js";

/**
 * Luxon accepts any string and silently produces an invalid `DateTime` for an unrecognized
 * IANA zone rather than throwing — every caller that takes a caller-supplied timezone and
 * feeds it into date arithmetic must validate up front, or an invalid zone surfaces much
 * later as a corrupted value (e.g. a Postgres "Invalid time value", or `toISODate()`
 * returning `null` and silently stringifying to `"null"`).
 */
export function assertValidTimezone(timezone: string): void {
  if (!DateTime.local().setZone(timezone).isValid) {
    throw new ValidationError(`Invalid IANA timezone: '${timezone}'`, { field: "timezone" });
  }
}
