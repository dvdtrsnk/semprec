// The three-way merge of a synced Event whose local change met a provider change: each field against the base, the
// provider's version the last sync or push left in `base_snapshot`.
import { isDeepStrictEqual } from "node:util";
import type { RemoteEventFields } from "./adapter.js";
import { REMOTE_EVENT_FIELD_KEYS } from "./calendarSyncApply.js";

export type RemoteEventFieldKey = (typeof REMOTE_EVENT_FIELD_KEYS)[number];

export interface EventMerge {
  fields: RemoteEventFields;
  /** Fields changed on both sides to different values: the provider's value won and the local one is lost. */
  overwritten: RemoteEventFieldKey[];
}

/**
 * A field the provider left as in `base` keeps the local value; a field changed only at the provider takes its
 * value; a field changed on both sides takes the provider's value. A base without a field counts it as `null`.
 */
export function mergeEventFields(
  base: Readonly<Record<string, unknown>>,
  local: RemoteEventFields,
  remote: RemoteEventFields,
): EventMerge {
  const fields: RemoteEventFields = { ...remote };
  const overwritten: RemoteEventFieldKey[] = [];
  for (const key of REMOTE_EVENT_FIELD_KEYS) {
    const baseValue = base[key] ?? null;
    const remoteChanged = !isDeepStrictEqual(remote[key], baseValue);
    const localChanged = !isDeepStrictEqual(local[key], baseValue);
    if (!remoteChanged) {
      assignField(fields, key, local[key]);
    } else if (localChanged && !isDeepStrictEqual(local[key], remote[key])) {
      overwritten.push(key);
    }
  }
  return { fields, overwritten };
}

function assignField<K extends RemoteEventFieldKey>(fields: RemoteEventFields, key: K, value: RemoteEventFields[K]) {
  fields[key] = value;
}

/** The fields whose value differs between the two versions. */
export function changedEventFields(from: RemoteEventFields, to: RemoteEventFields): RemoteEventFieldKey[] {
  return REMOTE_EVENT_FIELD_KEYS.filter((key) => !isDeepStrictEqual(from[key], to[key]));
}
