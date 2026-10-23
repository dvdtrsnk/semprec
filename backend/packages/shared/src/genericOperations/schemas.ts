import { z } from "zod";
import { PROPERTY_TYPES, type PropertyType } from "./rows.js";
import { filterNodeSchema, sortSpecSchema } from "./filterSort.js";
import type { GenericOperationName } from "./operationNames.js";

/**
 * Strict Zod input schemas for the 29-operation catalog (issue #252), extracted from #37's
 * domain-command validators into transport-independent shape. Every schema below is a strict
 * object: an unrecognized key — including a spoofed `actor`/`userId`/`agentProjectItemId` or a
 * server-derived/protected field like `system`, `schemaLocked`, `ownerProjectItemId`,
 * `ownerModuleId`, `owner`, `ownerProcess`, `locked`, `createdBy`, or `creatorProjectItemId` —
 * fails validation rather than being silently dropped. The sole exception is
 * `PropertyCreateInputSchema`'s relation branch, whose `locked` fields are required inputs.
 */

const cursor = z.string().optional();
/** Bounds `limit` at 200 and defaults to 50 when omitted, per issue #252's Task. */
const limit = z.number().int().min(1).max(200).default(50);

const jsonObject = z.record(z.string(), z.unknown());

export const DatabaseListInputSchema = z.object({ cursor, limit }).strict();
export type DatabaseListInput = z.infer<typeof DatabaseListInputSchema>;

export const DatabaseGetInputSchema = z.object({ databaseId: z.string() }).strict();
export type DatabaseGetInput = z.infer<typeof DatabaseGetInputSchema>;

export const DatabaseCreateInputSchema = z
  .object({
    name: z.string().min(1),
    parentItemId: z.string().optional(),
  })
  .strict();
export type DatabaseCreateInput = z.infer<typeof DatabaseCreateInputSchema>;

export const DatabasePatchInputSchema = z
  .object({
    databaseId: z.string(),
    patch: z.object({ name: z.string().min(1).optional() }).strict(),
  })
  .strict();
export type DatabasePatchInput = z.infer<typeof DatabasePatchInputSchema>;

export const DatabaseArchiveInputSchema = z.object({ databaseId: z.string() }).strict();
export type DatabaseArchiveInput = z.infer<typeof DatabaseArchiveInputSchema>;

export const DatabaseRestoreInputSchema = z.object({ databaseId: z.string() }).strict();
export type DatabaseRestoreInput = z.infer<typeof DatabaseRestoreInputSchema>;

export const PropertyListInputSchema = z.object({ databaseId: z.string() }).strict();
export type PropertyListInput = z.infer<typeof PropertyListInputSchema>;

export const PropertyGetInputSchema = z.object({ propertyId: z.string() }).strict();
export type PropertyGetInput = z.infer<typeof PropertyGetInputSchema>;

/** Key lookup within one database (issue #432), optionally narrowed to one property type. */
export const PropertyGetByKeyInputSchema = z
  .object({
    databaseId: z.string(),
    key: z.string(),
    type: z.enum(PROPERTY_TYPES).optional(),
  })
  .strict();
export type PropertyGetByKeyInput = z.infer<typeof PropertyGetByKeyInputSchema>;

const NON_RELATION_PROPERTY_TYPES = PROPERTY_TYPES.filter((type) => type !== "relation");
const nonRelationPropertyTypeSchema = z.enum(
  NON_RELATION_PROPERTY_TYPES as [Exclude<PropertyType, "relation">, ...Exclude<PropertyType, "relation">[]],
);

const relationCardinalitySchema = z.enum(["one_to_one", "one_to_many", "many_to_many"]);

const relationPropertySideInputSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    locked: z.boolean(),
  })
  .strict();

/**
 * The relation branch is the sole exception to the ban on external `locked` — its source and
 * inverse `locked` booleans are required inputs, not server-derived.
 */
export const PropertyCreateInputSchema = z.union([
  z
    .object({
      databaseId: z.string(),
      key: z.string().min(1),
      name: z.string().min(1),
      type: nonRelationPropertyTypeSchema,
      config: jsonObject.optional(),
    })
    .strict(),
  z
    .object({
      databaseId: z.string(),
      key: z.string().min(1),
      name: z.string().min(1),
      type: z.literal("relation"),
      targetDatabaseId: z.string(),
      cardinality: relationCardinalitySchema,
      locked: z.boolean(),
      inverse: relationPropertySideInputSchema.optional(),
    })
    .strict(),
]);
export type PropertyCreateInput = z.infer<typeof PropertyCreateInputSchema>;

/**
 * Supersedes the broader shorthand: `type` here excludes `'relation'`, so a non-relation
 * property cannot transition to relation through patch — a relation-definition change is #82's
 * protected path and stays outside this catalog.
 */
export const PropertyPatchInputSchema = z
  .object({
    propertyId: z.string(),
    patch: z
      .object({
        name: z.string().min(1).optional(),
        type: nonRelationPropertyTypeSchema.optional(),
        config: jsonObject.optional(),
      })
      .strict(),
  })
  .strict();
export type PropertyPatchInput = z.infer<typeof PropertyPatchInputSchema>;

export const PropertyDeleteInputSchema = z.object({ propertyId: z.string() }).strict();
export type PropertyDeleteInput = z.infer<typeof PropertyDeleteInputSchema>;

export const ViewListInputSchema = z.object({ cursor, limit }).strict();
export type ViewListInput = z.infer<typeof ViewListInputSchema>;

export const ViewGetInputSchema = z.object({ viewId: z.string() }).strict();
export type ViewGetInput = z.infer<typeof ViewGetInputSchema>;

export const ViewCreateInputSchema = z
  .object({
    databaseId: z.string().nullable().optional(),
    type: z.string().min(1),
    name: z.string().min(1),
    config: jsonObject.optional(),
    isDefault: z.boolean().optional(),
  })
  .strict();
export type ViewCreateInput = z.infer<typeof ViewCreateInputSchema>;

export const ViewPatchInputSchema = z
  .object({
    viewId: z.string(),
    patch: z
      .object({
        name: z.string().min(1).optional(),
        config: jsonObject.optional(),
        isDefault: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();
export type ViewPatchInput = z.infer<typeof ViewPatchInputSchema>;

export const ViewDeleteInputSchema = z.object({ viewId: z.string() }).strict();
export type ViewDeleteInput = z.infer<typeof ViewDeleteInputSchema>;

/** Bounds sort-spec fan-out the same way `MAX_FILTER_NODES_PER_LEVEL` bounds filter fan-out. */
const MAX_SORT_SPECS = 10;

const queryFields = {
  cursor,
  limit,
  filter: filterNodeSchema.optional(),
  sort: z.array(sortSpecSchema).max(MAX_SORT_SPECS).optional(),
  inTrash: z.boolean().optional(),
};

export const ViewQueryInputSchema = z.object({ viewId: z.string(), ...queryFields }).strict();
export type ViewQueryInput = z.infer<typeof ViewQueryInputSchema>;

export const DatabaseQueryInputSchema = z.object({ databaseId: z.string(), ...queryFields }).strict();
export type DatabaseQueryInput = z.infer<typeof DatabaseQueryInputSchema>;

/** Matches the `view_items.position` `integer` (int4) column's range. */
const viewItemPosition = z.number().int().min(0).max(2147483647);

/** `position` is optional (issue #37 specifies no request body for this route): omitting it appends a new item to the end, or leaves an already-present item's position unchanged — see `viewItemsStore.addViewItem`. */
export const ViewItemAddInputSchema = z
  .object({ viewId: z.string(), itemId: z.string(), position: viewItemPosition.optional() })
  .strict();
export type ViewItemAddInput = z.infer<typeof ViewItemAddInputSchema>;

export const ViewItemRemoveInputSchema = z.object({ viewId: z.string(), itemId: z.string() }).strict();
export type ViewItemRemoveInput = z.infer<typeof ViewItemRemoveInputSchema>;

export const ViewItemReorderInputSchema = z
  .object({ viewId: z.string(), itemId: z.string(), position: viewItemPosition })
  .strict();
export type ViewItemReorderInput = z.infer<typeof ViewItemReorderInputSchema>;

export const ItemGetInputSchema = z.object({ itemId: z.string() }).strict();
export type ItemGetInput = z.infer<typeof ItemGetInputSchema>;

/** Omitting `idempotencyKey` preserves #21/#37's non-retry create behavior; supplying one activates dedup. */
export const ItemCreateInputSchema = z
  .object({
    databaseId: z.string(),
    properties: jsonObject,
    idempotencyKey: z.string().optional(),
  })
  .strict();
export type ItemCreateInput = z.infer<typeof ItemCreateInputSchema>;

/** `ifVersion` is required here — #37 defines optimistic concurrency only for item property patches; metadata patches (database/property/view) carry no `ifVersion` at all. */
export const ItemPatchInputSchema = z
  .object({
    itemId: z.string(),
    properties: jsonObject,
    ifVersion: z.string(),
  })
  .strict();
export type ItemPatchInput = z.infer<typeof ItemPatchInputSchema>;

export const ItemDeleteInputSchema = z.object({ itemId: z.string() }).strict();
export type ItemDeleteInput = z.infer<typeof ItemDeleteInputSchema>;

export const ItemRestoreInputSchema = z.object({ itemId: z.string() }).strict();
export type ItemRestoreInput = z.infer<typeof ItemRestoreInputSchema>;

/** #82's `CreateRelationInput` — idempotent create/full metadata replacement. */
export const RelationPutInputSchema = z
  .object({
    relationPropertyId: z.string(),
    callerItemId: z.string(),
    targetItemId: z.string(),
    metadata: jsonObject.optional(),
  })
  .strict();
export type RelationPutInput = z.infer<typeof RelationPutInputSchema>;

/** Same endpoints as `RelationPutInputSchema`, without metadata — idempotent unlink. */
export const RelationDeleteInputSchema = z
  .object({
    relationPropertyId: z.string(),
    callerItemId: z.string(),
    targetItemId: z.string(),
  })
  .strict();
export type RelationDeleteInput = z.infer<typeof RelationDeleteInputSchema>;

/** Exhaustive mapped type over the 29 literal operation names — see the `_assertInputByOperationExhaustive` check below. */
export interface InputByOperation {
  "database.list": DatabaseListInput;
  "database.get": DatabaseGetInput;
  "database.create": DatabaseCreateInput;
  "database.patch": DatabasePatchInput;
  "database.archive": DatabaseArchiveInput;
  "database.restore": DatabaseRestoreInput;
  "property.list": PropertyListInput;
  "property.get": PropertyGetInput;
  "property.getByKey": PropertyGetByKeyInput;
  "property.create": PropertyCreateInput;
  "property.patch": PropertyPatchInput;
  "property.delete": PropertyDeleteInput;
  "view.list": ViewListInput;
  "view.get": ViewGetInput;
  "view.create": ViewCreateInput;
  "view.patch": ViewPatchInput;
  "view.delete": ViewDeleteInput;
  "view.query": ViewQueryInput;
  "viewItem.add": ViewItemAddInput;
  "viewItem.remove": ViewItemRemoveInput;
  "viewItem.reorder": ViewItemReorderInput;
  "item.get": ItemGetInput;
  "item.create": ItemCreateInput;
  "item.patch": ItemPatchInput;
  "item.delete": ItemDeleteInput;
  "item.restore": ItemRestoreInput;
  "database.query": DatabaseQueryInput;
  "relation.put": RelationPutInput;
  "relation.delete": RelationDeleteInput;
}

/** Fails to compile if `InputByOperation`'s keys and `GenericOperationName`'s literals ever diverge in either direction. */
type AssertSameKeys<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const _assertInputByOperationExhaustive: AssertSameKeys<keyof InputByOperation, GenericOperationName> = true;
void _assertInputByOperationExhaustive;
