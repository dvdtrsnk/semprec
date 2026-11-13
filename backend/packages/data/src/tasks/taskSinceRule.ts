/**
 * Captures the first planned day and time of an open task that is about to move on, for a write that changes
 * its `date`. A patch that does not name a different `date` captures nothing; `firstPlannedDay` is the same rule
 * for a writer whose change is the task's effective day and not its `date`.
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
 * The `since` (and `sinceTime`) a task takes when its effective day moves on: the task is `notDone`, its current
 * effective day (a nonempty `effectiveDate`, else `date`) is before `today`, and its `since` is empty. `sinceTime`
 * is the task's time only while the effective day is the task's own `date` and a time exists. Returns `{}` when
 * the conditions do not hold.
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
