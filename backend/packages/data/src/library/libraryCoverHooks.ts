// Write rules of the Books/Movies cover properties. A pre-write transform, not an update hook, because setting
// `coverOverride` must add `coverRemoved: false` to the patch before the row is written.
import type { ItemPreWritePreparation, ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import type { ItemRow } from "../types.js";
import {
  COVER_OVERRIDE_KEY,
  COVER_REMOVED_KEY,
  COVER_SOURCE_KEY,
  LIBRARY_COVER_SOURCES,
} from "./libraryModuleContract.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isCoverSource(value: unknown): boolean {
  return LIBRARY_COVER_SOURCES.some((source) => source === value);
}

/** Blob existence in the tenant is checked by `blobReferenceWriteHook.ts`. */
function isBlobReference(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const blobId: unknown = Reflect.get(value, "blobId");
  return typeof blobId === "string" && UUID_RE.test(blobId);
}

/**
 * `stored` is the locked row on update, `null` on create. Cross-key rules are judged on the values after the write:
 * a non-null `coverOverride` needs a `coverSource` and clears a stored `coverRemoved: true`; `coverRemoved: true`
 * needs `coverOverride` null.
 */
function resolveCoverWrite(stored: ItemRow | null, patch: Record<string, unknown>): Record<string, unknown> {
  const names = (key: string): boolean => Object.hasOwn(patch, key);
  if (!names(COVER_OVERRIDE_KEY) && !names(COVER_REMOVED_KEY) && !names(COVER_SOURCE_KEY)) return patch;

  if (names(COVER_OVERRIDE_KEY) && patch[COVER_OVERRIDE_KEY] !== null && !isBlobReference(patch[COVER_OVERRIDE_KEY])) {
    throw new ValidationError(`${COVER_OVERRIDE_KEY} must be null or reference a blob`, { field: COVER_OVERRIDE_KEY });
  }
  if (names(COVER_SOURCE_KEY) && patch[COVER_SOURCE_KEY] !== null && !isCoverSource(patch[COVER_SOURCE_KEY])) {
    throw new ValidationError(`${COVER_SOURCE_KEY} must be one of ${LIBRARY_COVER_SOURCES.join(", ")}`, {
      field: COVER_SOURCE_KEY,
    });
  }
  if (names(COVER_REMOVED_KEY) && patch[COVER_REMOVED_KEY] !== null && typeof patch[COVER_REMOVED_KEY] !== "boolean") {
    throw new ValidationError(`${COVER_REMOVED_KEY} must be true or false`, { field: COVER_REMOVED_KEY });
  }

  const after = (key: string): unknown => (names(key) ? patch[key] : (stored?.properties[key] ?? null));
  // An override set by this write drops a stored removal, so the rules below judge the row without it.
  const clearsStoredRemoval =
    names(COVER_OVERRIDE_KEY) &&
    patch[COVER_OVERRIDE_KEY] !== null &&
    !names(COVER_REMOVED_KEY) &&
    stored?.properties[COVER_REMOVED_KEY] === true;
  if (after(COVER_OVERRIDE_KEY) !== null && after(COVER_SOURCE_KEY) === null) {
    throw new ValidationError(`${COVER_SOURCE_KEY} is required with ${COVER_OVERRIDE_KEY}`, {
      field: COVER_SOURCE_KEY,
    });
  }
  if (!clearsStoredRemoval && after(COVER_REMOVED_KEY) === true && after(COVER_OVERRIDE_KEY) !== null) {
    throw new ValidationError(`${COVER_REMOVED_KEY} cannot be true while ${COVER_OVERRIDE_KEY} is set`, {
      field: COVER_REMOVED_KEY,
    });
  }
  return clearsStoredRemoval ? { ...patch, [COVER_REMOVED_KEY]: false } : patch;
}

export const libraryCoverPreWriteTransform = (async ({ stored, patch }) =>
  resolveCoverWrite(stored, patch)) satisfies ItemPreWriteTransform;

/** Proposal-time form: same checks, same added value. */
export const prepareLibraryCoverWrite: ItemPreWritePreparation = async ({ stored, patch }) => ({
  patch: resolveCoverWrite(stored, patch),
  deferredKeys: [],
});
