/**
 * Only a CHECK constraint keeps a string column inside its declared set; a direct write or a new enum value would
 * slip past an `as` cast. Stores validate narrow union columns through here instead of casting.
 */
export function assertKnownValue<T extends string>(allowed: readonly T[], value: string, label: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Unknown ${label} in database row: '${value}'`);
  }
  return value as T;
}

/**
 * A `NOT NULL jsonb` column is not type-checked; validating at the store boundary throws this domain error instead
 * of a `TypeError` far from the bad data.
 */
export function assertShape(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`Malformed ${label} in database row`);
  }
}
