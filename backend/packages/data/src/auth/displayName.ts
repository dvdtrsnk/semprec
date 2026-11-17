import { ValidationError } from "../errors.js";

/** Counted in code points after trimming. */
export const DISPLAY_NAME_MAX_LENGTH = 80;

/** NUL is rejected because Postgres `text` cannot store it. */
export function normalizeDisplayName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new ValidationError("'displayName' must be a string", { field: "displayName" });
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ValidationError("'displayName' must not be blank", { field: "displayName" });
  }
  if (trimmed.includes("\u0000")) {
    throw new ValidationError("'displayName' must not contain NUL characters", { field: "displayName" });
  }
  if (Array.from(trimmed).length > DISPLAY_NAME_MAX_LENGTH) {
    throw new ValidationError(`'displayName' must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`, {
      field: "displayName",
    });
  }
  return trimmed;
}
