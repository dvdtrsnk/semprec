/**
 * For a write that changes `date`; a patch not naming a different `date` captures nothing. `firstPlannedDay` is
 * the same rule for writers that change the effective day instead.
 */
export function taskSinceRule(
  stored: Record<string, unknown>,
  patch: Record<string, unknown>,
  today: string,
): Record<string, unknown> {
  const currentDate = typeof stored.date === "string" ? stored.date : null;
  if (!Object.hasOwn(patch, "date") || patch.date === currentDate) return {};
  return firstPlannedDay(stored, today);
}

/**
 * Applies when the task is `notDone`, its effective day (`effectiveDate`, else `date`) is before `today`, and
 * `since` is empty; otherwise `{}`. `sinceTime` is set only while the effective day is the task's own `date`.
 */
export function firstPlannedDay(stored: Record<string, unknown>, today: string): Record<string, unknown> {
  const currentDate = typeof stored.date === "string" ? stored.date : null;
  const effectiveDate =
    typeof stored.effectiveDate === "string" && stored.effectiveDate !== "" ? stored.effectiveDate : currentDate;
  if (
    stored.status !== "notDone" ||
    !effectiveDate ||
    effectiveDate >= today ||
    (stored.since != null && stored.since !== "")
  )
    return {};
  const result: Record<string, unknown> = { since: effectiveDate };
  if (stored.sinceTime == null && effectiveDate === currentDate && (stored.timeFrom != null || stored.timeTo != null)) {
    result.sinceTime = { from: stored.timeFrom ?? null, to: stored.timeTo ?? null };
  }
  return result;
}
