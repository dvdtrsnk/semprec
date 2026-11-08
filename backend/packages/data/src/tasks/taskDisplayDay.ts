import type { ItemRow } from "../types.js";

/** Returns the day on which the task is displayed, without changing its properties. */
export function taskDisplayDay(task: Pick<ItemRow, "properties">): string | null {
  const { occurrenceDate, status, completedOn, effectiveDate, date } = task.properties;
  if (typeof occurrenceDate === "string" && occurrenceDate !== "") return occurrenceDate;
  if (status === "done" && typeof completedOn === "string" && completedOn !== "") return completedOn;
  if (typeof effectiveDate === "string" && effectiveDate !== "") return effectiveDate;
  return typeof date === "string" && date !== "" ? date : null;
}
