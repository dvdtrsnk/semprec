/** Captures the first planned day and time before an overdue open task moves. */
export function taskSinceRule(
  stored: Record<string, unknown>,
  patch: Record<string, unknown>,
  today: string,
): Record<string, unknown> {
  const currentDate = typeof stored.date === "string" ? stored.date : null;
  const effectiveDate =
    typeof stored.effectiveDate === "string" && stored.effectiveDate !== "" ? stored.effectiveDate : currentDate;
  if (
    !Object.hasOwn(patch, "date") ||
    patch.date === currentDate ||
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
