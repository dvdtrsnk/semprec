import { requireSingleRow } from "../db/pool.js";
import type { ItemRow } from "../types.js";
import type { ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";

/** Applies the terminal-status rule before assigning or clearing the pinned project order. */
export const projectWriteTransform: ItemPreWriteTransform = async (context) => {
  const patch = unpinTerminalProject(context.stored, context.patch);
  const pinned = Object.hasOwn(patch, "pinned") ? patch.pinned : context.stored?.properties.pinned;
  if (pinned !== true) {
    return Object.hasOwn(patch, "pinnedOrder") || context.stored?.properties.pinnedOrder != null
      ? { ...patch, pinnedOrder: null }
      : patch;
  }
  if (Object.hasOwn(patch, "pinnedOrder")) return patch;
  if (context.stored?.properties.pinnedOrder != null) return patch;
  await context.client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('projects-pinned-order:' || $1::text, 0))",
    [context.database.id],
  );
  const { rows } = await context.client.query<{ next_order: number }>(
    `SELECT COALESCE(MAX(CASE WHEN jsonb_typeof(properties->'pinnedOrder') = 'number'
      THEN (properties->>'pinnedOrder')::double precision END), 0) + 1 AS next_order
     FROM items WHERE database_id=$1 AND deleted_at IS NULL AND properties->'pinned'='true'::jsonb`,
    [context.database.id],
  );
  const position = requireSingleRow(rows, "next pinned project order").next_order;
  return { ...patch, pinnedOrder: position };
};

function unpinTerminalProject(stored: ItemRow | null, patch: Record<string, unknown>): Record<string, unknown> {
  const status = Object.hasOwn(patch, "status") ? patch.status : stored?.properties.status;
  if (status !== "done" && status !== "archived") return patch;
  if (patch.pinned === true) {
    throw new ValidationError("A finished or archived project cannot be pinned", { field: "pinned" });
  }
  if (!Object.hasOwn(patch, "status")) return patch;
  const pinned = stored?.properties.pinned === true;
  return pinned ? { ...patch, pinned: false } : patch;
}
