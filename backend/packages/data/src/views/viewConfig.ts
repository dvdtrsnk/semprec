import { z } from "zod";
import { ValidationError } from "../errors.js";
import { filterNodeSchema, type FilterNode } from "./filterTree.js";
import { sortSpecSchema, type SortSpec } from "./sortSpec.js";

// `.catchall(unknown)` lets a custom view type carry its own config fields.
const viewConfigSchema = z
  .object({
    propertyOrder: z.array(z.string()).optional(),
    visibility: z.record(z.string(), z.boolean()).optional(),
    widths: z.record(z.string(), z.number()).optional(),
    filter: filterNodeSchema.optional(),
    sort: z.array(sortSpecSchema).optional(),
    groupBy: z.string().optional(),
    groupDirection: z.enum(["asc", "desc"]).optional(),
    membership: z.literal("manual").optional(),
    systemKey: z.string().min(1).optional(),
  })
  .catchall(z.unknown());

export interface ViewConfig {
  propertyOrder?: string[];
  visibility?: Record<string, boolean>;
  widths?: Record<string, number>;
  filter?: FilterNode;
  sort?: SortSpec[];
  groupBy?: string;
  /** Defaults to `asc`. */
  groupDirection?: "asc" | "desc";
  membership?: "manual";
  /**
   * Stable key of a system view (e.g. Tasks `today`), unique per database. A view with one is read-only for every
   * actor, and only the system writes it (`assertSystemKeyWritable`).
   */
  systemKey?: string;
  [key: string]: unknown;
}

export function parseViewConfig(raw: unknown): ViewConfig {
  const result = viewConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`Invalid view config: ${result.error.message}`, {
      field: "config",
      issues: result.error.issues,
    });
  }
  return result.data;
}

/** Hides per `visibility`, then puts `propertyOrder` keys first in order, then the rest. */
export function projectProperties(properties: Record<string, unknown>, config: ViewConfig): Record<string, unknown> {
  const visible = config.visibility
    ? Object.keys(properties).filter((key) => config.visibility?.[key] !== false)
    : Object.keys(properties);
  const ordered = config.propertyOrder
    ? [
        ...config.propertyOrder.filter((key) => visible.includes(key)),
        ...visible.filter((key) => !config.propertyOrder?.includes(key)),
      ]
    : visible;

  const result: Record<string, unknown> = {};
  for (const key of ordered) result[key] = properties[key];
  return result;
}
