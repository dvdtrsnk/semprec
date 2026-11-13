/**
 * A string property of the row `i` that is not empty, `NULL` for anything else: the SQL form of the checks of
 * `taskDisplayDay`.
 */
const filled = (key: string): string =>
  `CASE WHEN jsonb_typeof(i.properties->'${key}') = 'string' AND i.properties->>'${key}' <> '' THEN i.properties->>'${key}' END`;

/**
 * The first ten characters of the day a Task row `i` is displayed on, `NULL` when it has none: `taskDisplayDay`
 * (issue #1544) written as the same four steps, `occurrenceDate`, `completedOn` of a `done` Task, `effectiveDate`,
 * `date`. A statement that selects Tasks by their display day embeds it, where the row of `items` is aliased `i`.
 */
export const TASK_DISPLAY_DAY_SQL = `left(coalesce(${filled("occurrenceDate")},
                                            CASE WHEN i.properties->>'status' = 'done' THEN ${filled("completedOn")} END,
                                            ${filled("effectiveDate")},
                                            ${filled("date")}), 10)`;
