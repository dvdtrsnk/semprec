import { ValidationError } from "../errors.js";

/** The longest display name the account routes accept, counted in code points after trimming. */
export const DISPLAY_NAME_MAX_LENGTH = 80;

/**
 * Validates the optional `displayName` of an account-creation request: `POST /api/setup` and
 * invitation acceptance (issue #1513). An absent or `null` value gives `null`, which is stored as NULL.
 * A string is trimmed, and the trimmed value must be 1 to `DISPLAY_NAME_MAX_LENGTH` code points long and
 * must not contain a NUL character, which Postgres `text` cannot store. Anything else throws a
 * `ValidationError` whose `details.field` is `'displayName'`. Length counts code points rather than
 * UTF-16 units, so a character outside the Basic Multilingual Plane counts once.
 */
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
