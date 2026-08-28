import { z } from "zod";
import { ValidationError } from "../errors.js";
import { filterNodeSchema, type FilterNode } from "./filterTree.js";
import { sortSpecSchema, type SortSpec } from "./sortSpec.js";

// `.catchall(unknown)` lets a module-registered custom view type carry its own extra
// config fields (issue #22, point 4) without this schema knowing about them in advance.
const viewConfigSchema = z
  .object({
    propertyOrder: z.array(z.string()).optional(),
    visibility: z.record(z.string(), z.boolean()).optional(),
    widths: z.record(z.string(), z.number()).optional(),
    filter: filterNodeSchema.optional(),
    sort: z.array(sortSpecSchema).optional(),
    groupBy: z.string().optional(),
    membership: z.literal("manual").optional(),
  })
  .catchall(z.unknown());

export interface ViewConfig {
  propertyOrder?: string[];
  visibility?: Record<string, boolean>;
  widths?: Record<string, number>;
  filter?: FilterNode;
  sort?: SortSpec[];
  groupBy?: string;
  membership?: "manual";
  [key: string]: unknown;
}

export function parseViewConfig(raw: unknown): ViewConfig {
  const result = viewConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`Invalid view config: ${result.error.message}`, { field: "config", issues: result.error.issues });
  }
  return result.data as ViewConfig;
}

/** Projects an item's properties per the view's `visibility`/`propertyOrder` — hides, then reorders (named keys first, in order given, then any remainder). */
export function projectProperties(properties: Record<string, unknown>, config: ViewConfig): Record<string, unknown> {
  const visible = config.visibility ? Object.keys(properties).filter((key) => config.visibility?.[key] !== false) : Object.keys(properties);
  const ordered = config.propertyOrder
    ? [...config.propertyOrder.filter((key) => visible.includes(key)), ...visible.filter((key) => !config.propertyOrder?.includes(key))]
    : visible;

  const result: Record<string, unknown> = {};
  for (const key of ordered) result[key] = properties[key];
  return result;
}
