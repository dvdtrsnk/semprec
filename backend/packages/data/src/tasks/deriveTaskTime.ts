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
