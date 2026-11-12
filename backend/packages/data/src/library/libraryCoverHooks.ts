// The write rules of the user-owned cover properties of Books and Movies (issue #1793), registered through
// ../domainWriteHooks.ts as a pre-write transform of both databases' modules. It is a transform, not an item update
// hook, because the one rule that adds a value (setting `coverOverride` clears `coverRemoved`) must change the patch
// before the row is written, and an update hook runs after it; see
// docs/adr/2026-10-29-item-pre-write-transforms-per-module-registry.md.
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

/** Whether `value` is `{ blobId }` with a UUID. That the blob exists in the tenant is checked by `blobReferenceWriteHook.ts`. */
function isBlobReference(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const blobId: unknown = Reflect.get(value, "blobId");
  return typeof blobId === "string" && UUID_RE.test(blobId);
}

/**
 * The checks and the one added value of a write to the cover properties. `stored` is the locked current row on update
 * and `null` on create. Only the keys the patch names are checked on their own; the rules between them are judged on
 * the values the row would hold after the write. A patch that names none of the three keys is returned as it is.
 *
 * - `coverOverride` is `null` or `{ blobId }` with a UUID, and a non-null one needs a `coverSource` after the write.
 *   That the blob exists in the caller's tenant is the check of `blobReferenceWriteHook.ts`, which runs on every
 *   `image` property after the write and rolls it back with a 400 on `coverOverride`.
 * - `coverSource` is `null` or one of `LIBRARY_COVER_SOURCES`; `coverRemoved` is a boolean or `null`.
 * - A non-null `coverOverride` clears a stored `coverRemoved: true` by adding `coverRemoved: false` to the patch.
 * - `coverRemoved: true` needs `coverOverride` to be `null` after the write.
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
  // The override this write sets drops a stored removal, so the rules below judge the row with it already gone.
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

/** Pre-write transform of the Books and Movies modules, on create and on update. */
export const libraryCoverPreWriteTransform = (async ({ stored, patch }) =>
  resolveCoverWrite(stored, patch)) satisfies ItemPreWriteTransform;

/** The proposal-time form of the transform, for a write an agent proposes: the same checks and the same added value. */
export const prepareLibraryCoverWrite: ItemPreWritePreparation = async ({ stored, patch }) => ({
  patch: resolveCoverWrite(stored, patch),
  deferredKeys: [],
});
