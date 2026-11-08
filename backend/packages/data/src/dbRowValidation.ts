/**
 * A DB CHECK constraint is the only thing keeping a string column's value inside its
 * declared set — nothing stops a direct DB write, or a future migration adding a new
 * enum value, from producing a row whose value TypeScript would happily (and wrongly)
 * widen to a union type via `as`. Every store mapping a raw row to its typed shape
 * should validate through here instead of casting narrow union-typed columns.
 */
export function assertKnownValue<T extends string>(allowed: readonly T[], value: string, label: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`Unknown ${label} in database row: '${value}'`);
  }
  return value as T;
}

/**
 * A `NOT NULL jsonb` column still isn't a type-checked one — a hand-written backfill or a future
 * migration bug can leave a row whose shape doesn't match what the store's read path assumes.
 * Validate the shape at the store boundary instead of casting it straight through: a malformed row
 * throws this domain error, not an unhandled `TypeError` three call frames away from where the bad
 * data actually was.
 */
export function assertShape(condition: boolean, label: string): void {
  if (!condition) {
    throw new Error(`Malformed ${label} in database row`);
  }
}
