/**
 * The Tasks data migration from 1.2.0 to 1.3.0 (issue #1780): gives every task that has a `date` and no
 * `effectiveDate` the `effectiveDate` of a task with no host event, its `date`. A task that already has an
 * `effectiveDate`, a task whose `date` is not a nonempty string and every other property stay as they are. The
 * function is pure and idempotent: applied to its own result it returns that result again. The migration runner
 * writes a row only when the converted properties differ from the stored ones, so such a row keeps its `updated_at`.
 */
export function backfillTaskEffectiveDate(properties: Record<string, unknown>): Record<string, unknown> {
  const effectiveDate = properties.effectiveDate;
  const empty = effectiveDate === undefined || effectiveDate === null || effectiveDate === "";
  if (!empty || typeof properties.date !== "string" || properties.date === "") return properties;
  return { ...properties, effectiveDate: properties.date };
}
