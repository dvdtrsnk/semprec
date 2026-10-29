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

const WALL_CLOCK_TIME_PATTERN = /^(\d{1,2}):(\d{2})$/;

export interface WallClockTimeOptions {
  /** Accepts `24:00`, the end of the day. Only an end time may use it. */
  allow2400?: boolean;
  /** The property the `ValidationError` names when the value is rejected. */
  field: string;
}

/**
 * Normalizes a caller-supplied wall-clock time to the zero-padded `HH:MM` form. Accepts `H:MM` and `HH:MM`.
 * `""`, `null` and `undefined` mean no time and return `null`. `24:00` is accepted only when `allow2400` is
 * true. Any other value, including `25:99` and `abc`, throws `ValidationError` naming `options.field`.
 */
export function normalizeWallClockTime(value: unknown, options: WallClockTimeOptions): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const match = WALL_CLOCK_TIME_PATTERN.exec(value);
    if (match) {
      const hours = Number(match[1]);
      const minutes = Number(match[2]);
      if (hours <= 23 && minutes <= 59) return `${match[1]!.padStart(2, "0")}:${match[2]!}`;
      if (options.allow2400 && hours === 24 && minutes === 0) return "24:00";
    }
  }
  throw new ValidationError(
    `Property '${options.field}' must be a wall-clock time HH:MM${options.allow2400 ? " or 24:00" : ""}`,
    { field: options.field },
  );
}
