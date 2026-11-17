import { DateTime } from "luxon";
import { ValidationError } from "./errors.js";

/**
 * Luxon silently yields an invalid `DateTime` for an unknown IANA zone instead of throwing, so caller-supplied zones
 * must be validated up front or they surface later as corrupt values (e.g. `toISODate()` stringifying to `"null"`).
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
  /** The property the `ValidationError` names. */
  field: string;
}

/**
 * Normalizes `H:MM`/`HH:MM` to zero-padded `HH:MM`. Empty, `null` and `undefined` return `null`; `24:00` only with
 * `allow2400`. Anything else throws `ValidationError` naming `options.field`.
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
