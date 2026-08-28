import { z } from "zod";
import { ValidationError } from "../errors.js";

/** The V1 closed condition set (issue #22, point 2) — extending it is always a code migration of this list, never a data change. */
export const FILTER_CONDITION_TYPES = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "starts_with",
  "ends_with",
  "is_empty",
  "is_not_empty",
  "before",
  "after",
  "on_or_before",
  "on_or_after",
  "date_range",
  "in",
] as const;
export type FilterConditionType = (typeof FILTER_CONDITION_TYPES)[number];

export type FilterCondition =
  | { type: "equals" | "not_equals"; property: string; value: string | number | boolean }
  | { type: "contains" | "not_contains" | "starts_with" | "ends_with"; property: string; value: string }
  | { type: "is_empty" | "is_not_empty"; property: string }
  | { type: "before" | "after" | "on_or_before" | "on_or_after"; property: string; value: string }
  | { type: "date_range"; property: string; value: { from: string; to: string } }
  | { type: "in"; property: string; value: string[] };

export type FilterNode =
  | FilterCondition
  | { type: "and"; nodes: FilterNode[] }
  | { type: "or"; nodes: FilterNode[] }
  | { type: "not"; node: FilterNode };

const property = z.string().min(1);
const scalarValue = z.union([z.string(), z.number(), z.boolean()]);

const filterConditionSchema = z.union([
  z.object({ type: z.enum(["equals", "not_equals"]), property, value: scalarValue }),
  z.object({ type: z.enum(["contains", "not_contains", "starts_with", "ends_with"]), property, value: z.string() }),
  z.object({ type: z.enum(["is_empty", "is_not_empty"]), property }),
  z.object({ type: z.enum(["before", "after", "on_or_before", "on_or_after"]), property, value: z.string() }),
  z.object({ type: z.literal("date_range"), property, value: z.object({ from: z.string(), to: z.string() }) }),
  z.object({ type: z.literal("in"), property, value: z.array(z.string()).min(1) }),
]);

/** Recursive tree: zod needs an explicit `z.ZodType` annotation plus `z.lazy` to type-check a self-referential schema. */
export const filterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    filterConditionSchema,
    z.object({ type: z.literal("and"), nodes: z.array(filterNodeSchema).min(1) }),
    z.object({ type: z.literal("or"), nodes: z.array(filterNodeSchema).min(1) }),
    z.object({ type: z.literal("not"), node: filterNodeSchema }),
  ]),
);

export function parseFilterNode(raw: unknown): FilterNode {
  const result = filterNodeSchema.safeParse(raw);
  if (!result.success) {
    throw new ValidationError(`Invalid filter tree: ${result.error.message}`, { field: "filter", issues: result.error.issues });
  }
  return result.data;
}
