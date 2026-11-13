/**
 * The Tasks data migration from 1.3.0 to 1.4.0 (issue sp-9cf1be65): gives every task whose `status` is missing, `null`
 * or not a string with at least one character the status `notDone`, the property's own default. A task with a status
 * and every other property stay as they are, and the same object is returned for it. The function is pure and
 * idempotent: applied to its own result it returns that result again. The migration runner writes a row only when the
 * converted properties differ from the stored ones, so a row that keeps its status keeps its `updated_at`.
 * See docs/adr/2026-11-13-a-task-always-has-a-status.md.
 */
export function backfillTaskStatus(properties: Record<string, unknown>): Record<string, unknown> {
  const status = properties.status;
  if (typeof status === "string" && status !== "") return properties;
  return { ...properties, status: "notDone" };
}
