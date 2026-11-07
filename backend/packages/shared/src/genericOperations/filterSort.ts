import { z } from "zod";

/**
 * `view.query`/`database.query`'s filter/sort tree (issue #252, extracted from #37 via
 * `packages/data/src/views/filterTree.ts` and `sortSpec.ts`). Kept as a standalone copy rather
 * than an import: `packages/shared` must not depend on `packages/data`. The condition set and
 * tree shape (including two-key relation paths and UUID validation) must stay identical to the data-layer compiler's — issue #219 rebases that compiler
 * onto these schemas.
 */
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
  /** `value` must be a UUID string — `filterConditionSchema` validates it with `z.uuid()`. */
  | { type: "relation_contains" | "relation_not_contains"; property: string; value: string }
  | { type: "relation_path_contains"; path: [string, string]; value: string }
  | { type: "relation_is_empty" | "relation_is_not_empty"; property: string };

export type FilterNode =
  | FilterCondition
  | { type: "and"; nodes: FilterNode[] }
  | { type: "or"; nodes: FilterNode[] }
  | { type: "not"; node: FilterNode };

const filterProperty = z.string().min(1);
const filterScalarValue = z.union([z.string(), z.number(), z.boolean()]);

const relationPathConditionSchema = z
  .object({
    type: z.literal("relation_path_contains"),
    // Explicit length also supplies minItems/maxItems to the input JSON Schema.
    path: z.tuple([filterProperty, filterProperty]).check(z.length(2)),
    value: z.uuid(),
  })
  .strict();

// Keep the strict input visible to JSON Schema generation while attributing malformed
// paths to filter. `when` also runs the marker check after aborting tuple/type issues,
// but only for this condition, preserving other union members' error fields (AC5).
const relationPathCondition = relationPathConditionSchema.refine(() => false, {
  when: ({ value, issues }) =>
    issues.length > 0 &&
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "relation_path_contains",
  message: "Invalid relation path filter",
  params: { relationPathFilter: true },
});

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
  z.object({ type: z.enum(["equals", "not_equals"]), property: filterProperty, value: filterScalarValue }).strict(),
  z
    .object({
      type: z.enum(["contains", "not_contains", "starts_with", "ends_with"]),
      property: filterProperty,
      value: z.string(),
    })
    .strict(),
  z.object({ type: z.enum(["is_empty", "is_not_empty"]), property: filterProperty }).strict(),
  z
    .object({
      type: z.enum(["before", "after", "on_or_before", "on_or_after"]),
      property: filterProperty,
      value: z.string(),
    })
    .strict(),
  z
    .object({
      type: z.literal("date_range"),
      property: filterProperty,
      value: z.object({ from: z.string(), to: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("date_relative"),
      property: filterProperty,
      endProperty: filterProperty.optional(),
      preset: dateRelativePreset,
    })
    .strict(),
  z.object({ type: z.enum(["lt", "lte", "gt", "gte"]), property: filterProperty, value: z.number().finite() }).strict(),
  z.object({ type: z.literal("in"), property: filterProperty, value: z.array(z.string()).min(1) }).strict(),
  z
    .object({ type: z.enum(["relation_contains", "relation_not_contains"]), property: filterProperty, value: z.uuid() })
    .strict(),
  relationPathCondition,
  z.object({ type: z.enum(["relation_is_empty", "relation_is_not_empty"]), property: filterProperty }).strict(),
]);

/**
 * A `z.lazy` self-reference has no depth bound: a payload nesting `not`/`and`/`or` a few
 * thousand levels deep recurses the validator down the JS call stack until it overflows and
 * crashes the process. Instead of `z.lazy`, unroll the recursion into `MAX_FILTER_DEPTH` concrete
 * schema levels — parsing a tree deeper than that fails validation (400) rather than overflowing
 * the stack. `nodes` is also capped to bound `and`/`or` fan-out at each level.
 */
const MAX_FILTER_DEPTH = 8;
const MAX_FILTER_NODES_PER_LEVEL = 20;

function buildFilterNodeSchema(remainingDepth: number): z.ZodType<FilterNode> {
  if (remainingDepth <= 0) {
    return filterConditionSchema;
  }
  const child = buildFilterNodeSchema(remainingDepth - 1);
  return z.union([
    filterConditionSchema,
    z.object({ type: z.literal("and"), nodes: z.array(child).min(1).max(MAX_FILTER_NODES_PER_LEVEL) }).strict(),
    z.object({ type: z.literal("or"), nodes: z.array(child).min(1).max(MAX_FILTER_NODES_PER_LEVEL) }).strict(),
    z.object({ type: z.literal("not"), node: child }).strict(),
  ]);
}

export const filterNodeSchema: z.ZodType<FilterNode> = buildFilterNodeSchema(MAX_FILTER_DEPTH);

const sortDirection = z.enum(["asc", "desc"]);

/**
 * A property sort key, or an item system timestamp (`createdAt`/`updatedAt`, issue #1594) in its own
 * `system` namespace. Both variants are strict, so a spec naming both `property` and `system` matches
 * neither. `packages/data/src/views/sortSpec.ts` accepts the same two variants.
 */
export const sortSpecSchema = z.union([
  z.object({ property: z.string().min(1), direction: sortDirection }).strict(),
  z.object({ system: z.enum(["createdAt", "updatedAt"]), direction: sortDirection }).strict(),
]);
export type SortSpec = z.infer<typeof sortSpecSchema>;
