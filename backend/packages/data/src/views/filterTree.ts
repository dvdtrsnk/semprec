import { z } from "zod";
import { ValidationError } from "../errors.js";

/** Closed condition set; keep the types, path tuples and UUID validation identical to shared/genericOperations/filterSort.ts. */
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
  "date_relative",
  "lt",
  "lte",
  "gt",
  "gte",
  "in",
  // Relation-valued conditions (issue #96): relation values live in `item_relations`, not
  // in `properties`, so they need their own condition types rather than a `value` on the
  // scalar ones. Generic over any relation property — Emails->Folders is only this issue's
  // first caller.
  "relation_contains",
  "relation_not_contains",
  "relation_path_contains",
  "relation_is_empty",
  "relation_is_not_empty",
] as const;
export type FilterConditionType = (typeof FILTER_CONDITION_TYPES)[number];

export const DATE_RELATIVE_PRESETS = [
  "today",
  "tomorrow",
  "thisWeek",
  "nextWeek",
  "thisMonth",
  "upcoming",
  "past",
  "onOrBeforeToday",
  "last7",
  "last30",
  "thisYear",
  "olderThan30",
  "beforeNow",
] as const;
export type DateRelativePresetName = (typeof DATE_RELATIVE_PRESETS)[number];
/** Days relative to today, inclusive; negative is the past; no `toDays` means no upper bound. */
export type DateRelativeRange = { fromDays: number; toDays?: number };
export type DateRelativePreset = DateRelativePresetName | DateRelativeRange;

export type FilterCondition =
  | { type: "equals" | "not_equals"; property: string; value: string | number | boolean }
  | { type: "contains" | "not_contains" | "starts_with" | "ends_with"; property: string; value: string }
  | { type: "is_empty" | "is_not_empty"; property: string }
  | { type: "before" | "after" | "on_or_before" | "on_or_after"; property: string; value: string }
  | { type: "date_range"; property: string; value: { from: string; to: string } }
  | { type: "date_relative"; property: string; endProperty?: string; preset: DateRelativePreset }
  | { type: "lt" | "lte" | "gt" | "gte"; property: string; value: number }
  | { type: "in"; property: string; value: string[] }
  | { type: "relation_contains" | "relation_not_contains"; property: string; value: string }
  | { type: "relation_path_contains"; path: [string, string]; value: string }
  | { type: "relation_is_empty" | "relation_is_not_empty"; property: string };

export type FilterNode =
  | FilterCondition
  | { type: "and"; nodes: FilterNode[] }
  | { type: "or"; nodes: FilterNode[] }
  | { type: "not"; node: FilterNode };

const property = z.string().min(1);
const scalarValue = z.union([z.string(), z.number(), z.boolean()]);

const RELATIVE_DAYS_LIMIT = 36500;
const relativeDays = z.number().int().min(-RELATIVE_DAYS_LIMIT).max(RELATIVE_DAYS_LIMIT);
const dateRelativePreset = z.union([
  z.enum(DATE_RELATIVE_PRESETS),
  z
    .object({ fromDays: relativeDays, toDays: relativeDays.optional() })
    .strict()
    .refine((range) => range.toDays === undefined || range.fromDays <= range.toDays, {
      message: "fromDays must not exceed toDays",
    }),
]);

const filterConditionSchema = z.union([
  z.object({ type: z.enum(["equals", "not_equals"]), property, value: scalarValue }),
  z.object({ type: z.enum(["contains", "not_contains", "starts_with", "ends_with"]), property, value: z.string() }),
  z.object({ type: z.enum(["is_empty", "is_not_empty"]), property }),
  z.object({ type: z.enum(["before", "after", "on_or_before", "on_or_after"]), property, value: z.string() }),
  z.object({ type: z.literal("date_range"), property, value: z.object({ from: z.string(), to: z.string() }) }),
  z
    .object({
      type: z.literal("date_relative"),
      property,
      endProperty: property.optional(),
      preset: dateRelativePreset,
    })
    .strict(),
  z.object({ type: z.enum(["lt", "lte", "gt", "gte"]), property, value: z.number().finite() }),
  z.object({ type: z.literal("in"), property, value: z.array(z.string()).min(1) }),
  // The value is a target *item id*, so it is validated as a uuid here rather than reaching
  // the compiled `$N::uuid` cast, where a malformed id would surface as a raw Postgres cast
  // error instead of a ValidationError naming the offending field.
  z.object({ type: z.enum(["relation_contains", "relation_not_contains"]), property, value: z.uuid() }),
  z
    .object({ type: z.literal("relation_path_contains"), path: z.tuple([property, property]), value: z.uuid() })
    .strict(),
  z.object({ type: z.enum(["relation_is_empty", "relation_is_not_empty"]), property }).strict(),
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
    throw new ValidationError(`Invalid filter tree: ${result.error.message}`, {
      field: "filter",
      issues: result.error.issues,
    });
  }
  return result.data;
}
