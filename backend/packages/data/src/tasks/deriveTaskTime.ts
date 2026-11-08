/** Formats the Tasks display-time derived from its optional start/end source values. */
export function deriveTaskTime(timeFrom: string | null, timeTo: string | null): string | null {
  if (timeFrom !== null && timeTo !== null) return `${formatTaskTime(timeFrom)}–${formatTaskTime(timeTo)}`;
  if (timeFrom !== null) return formatTaskTime(timeFrom);
  if (timeTo !== null) return formatTaskTime(timeTo);
  return null;
}

/** Converts a persisted wall-clock value into the canonical zero-padded 24-hour display form. */
function formatTaskTime(value: string): string {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value);
  if (!match) return value;
  return `${match[1]!.padStart(2, "0")}:${match[2]!.padStart(2, "0")}`;
}

/** Manifest data-migration converter: corrects only a stale derived Tasks time value. */
export function backfillTaskTimeProperties(properties: Record<string, unknown>): Record<string, unknown> {
  const timeFrom = typeof properties.timeFrom === "string" ? properties.timeFrom : null;
  const timeTo = typeof properties.timeTo === "string" ? properties.timeTo : null;
  const time = deriveTaskTime(timeFrom, timeTo);
  if ((properties.time ?? null) === time) return properties;
  return { ...properties, time };
}
