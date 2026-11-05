import { requireSingleRow } from "../db/pool.js";
import type { ItemRow } from "../types.js";
import type { ItemPreWritePreparation, ItemPreWriteTransform } from "../chokePoint/hooks.js";
import { ValidationError } from "../errors.js";
import { today } from "../calendarTime.js";
import { getSystemTimezone } from "../systemSettings.js";
import { PROJECTS_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import { deleteKeptDate, getKeptDate, upsertKeptDate } from "./projectKeptDateStore.js";

export const PROJECTS_OWNER_PROCESS = PROJECTS_MODULE_ID;

/** Prepares terminal status, deadline and pinned-order changes without allocating or writing. */
export const prepareProjectWrite: ItemPreWritePreparation = async ({ stored, patch: original }) => {
  let patch = unpinTerminalProject(stored, original);
  const oldStatus = stored?.properties.status;
  const status = Object.hasOwn(patch, "status") ? patch.status : oldStatus;
  if (status === "longTerm" && Object.hasOwn(patch, "date") && patch.date != null) {
    throw new ValidationError("Long-term projects have no deadline", { field: "date" });
  }
  const entering = status === "longTerm" && oldStatus !== "longTerm";
  const restoring = oldStatus === "longTerm" && status !== "longTerm" && !Object.hasOwn(patch, "date");
  if (entering && !Object.hasOwn(patch, "date")) patch = { ...patch, date: null };
  const deferredKeys = restoring ? ["date"] : [];
  const pinned = Object.hasOwn(patch, "pinned") ? patch.pinned : stored?.properties.pinned;
  if (pinned !== true) {
    return {
      patch:
        Object.hasOwn(patch, "pinnedOrder") || stored?.properties.pinnedOrder != null
          ? { ...patch, pinnedOrder: null }
          : patch,
      deferredKeys,
    };
  }
  if (Object.hasOwn(patch, "pinnedOrder") || stored?.properties.pinnedOrder != null) return { patch, deferredKeys };
  return { patch, deferredKeys: [...deferredKeys, "pinnedOrder"] };
};

export const projectWriteTransform: ItemPreWriteTransform = async (context) => {
  const prepared = await prepareProjectWrite(context);
  let patch = prepared.patch;
  const stored = context.stored;
  const status = Object.hasOwn(context.patch, "status") ? context.patch.status : stored?.properties.status;
  const wasTerminal = stored?.properties.status === "done" || stored?.properties.status === "archived";
  const terminal = status === "done" || status === "archived";
  if (terminal && !wasTerminal) patch = { ...patch, completedAt: today(await getSystemTimezone(context.client)) };
  if (wasTerminal && (status === "inProgress" || status === "longTerm")) patch = { ...patch, completedAt: null };
  if (
    stored &&
    status === "longTerm" &&
    stored.properties.status !== "longTerm" &&
    !Object.hasOwn(context.patch, "date") &&
    stored.properties.date != null
  ) {
    await upsertKeptDate(context.client, stored.id, stored.properties.date);
  }
  if (stored && stored.properties.status === "longTerm" && status !== "longTerm") {
    if (prepared.deferredKeys.includes("date"))
      patch = { ...patch, date: await getKeptDate(context.client, stored.id) };
    await deleteKeptDate(context.client, stored.id);
  }
  if (!prepared.deferredKeys.includes("pinnedOrder")) return patch;
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
