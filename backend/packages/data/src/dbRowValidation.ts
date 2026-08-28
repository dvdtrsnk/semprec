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
