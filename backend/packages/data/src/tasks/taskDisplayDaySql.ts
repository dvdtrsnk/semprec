/** A non-empty string property of row `i`, else `NULL`. */
const filled = (key: string): string =>
  `CASE WHEN jsonb_typeof(i.properties->'${key}') = 'string' AND i.properties->>'${key}' <> '' THEN i.properties->>'${key}' END`;

/**
 * SQL form of `taskDisplayDay` (`occurrenceDate`, `done` `completedOn`, `effectiveDate`, `date`), first ten
 * characters, for statements aliasing the `items` row as `i`.
 */
export const TASK_DISPLAY_DAY_SQL = `left(coalesce(${filled("occurrenceDate")},
                                            CASE WHEN i.properties->>'status' = 'done' THEN ${filled("completedOn")} END,
                                            ${filled("effectiveDate")},
                                            ${filled("date")}), 10)`;
