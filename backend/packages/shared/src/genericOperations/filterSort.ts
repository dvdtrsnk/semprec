import { z } from "zod";

/**
 * `view.query`/`database.query`'s filter/sort tree (issue #252, extracted from #37 via
 * `packages/data/src/views/filterTree.ts` and `sortSpec.ts`). Kept as a standalone copy rather
 * than an import: `packages/shared` must not depend on `packages/data`. The condition set and
 * tree shape must stay identical to the data-layer compiler's — issue #219 rebases that compiler
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
  "in",
  "relation_contains",
  "relation_not_contains",
] as const;
export type FilterConditionType = (typeof FILTER_CONDITION_TYPES)[number];

export type FilterCondition =
  | { type: "equals" | "not_equals"; property: string; value: string | number | boolean }
  | { type: "contains" | "not_contains" | "starts_with" | "ends_with"; property: string; value: string }
  | { type: "is_empty" | "is_not_empty"; property: string }
  | { type: "before" | "after" | "on_or_before" | "on_or_after"; property: string; value: string }
  | { type: "date_range"; property: string; value: { from: string; to: string } }
  | { type: "in"; property: string; value: string[] }
  /** `value` must be a UUID string — `filterConditionSchema` validates it with `z.uuid()`. */
  | { type: "relation_contains" | "relation_not_contains"; property: string; value: string };

export type FilterNode =
  | FilterCondition
  | { type: "and"; nodes: FilterNode[] }
  | { type: "or"; nodes: FilterNode[] }
  | { type: "not"; node: FilterNode };

const filterProperty = z.string().min(1);
const filterScalarValue = z.union([z.string(), z.number(), z.boolean()]);

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
  z.object({ type: z.literal("in"), property: filterProperty, value: z.array(z.string()).min(1) }).strict(),
  z
    .object({ type: z.enum(["relation_contains", "relation_not_contains"]), property: filterProperty, value: z.uuid() })
    .strict(),
]);

/** Recursive tree: zod needs an explicit `z.ZodType` annotation plus `z.lazy` to type-check a self-referential schema. */
export const filterNodeSchema: z.ZodType<FilterNode> = z.lazy(() =>
  z.union([
    filterConditionSchema,
    z.object({ type: z.literal("and"), nodes: z.array(filterNodeSchema).min(1) }).strict(),
    z.object({ type: z.literal("or"), nodes: z.array(filterNodeSchema).min(1) }).strict(),
    z.object({ type: z.literal("not"), node: filterNodeSchema }).strict(),
  ]),
);

export const sortSpecSchema = z
  .object({
    property: z.string().min(1),
    direction: z.enum(["asc", "desc"]),
  })
  .strict();
export type SortSpec = z.infer<typeof sortSpecSchema>;
