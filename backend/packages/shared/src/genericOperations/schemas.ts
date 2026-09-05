import { filterNodeSchema, PROPERTY_TYPES, sortSpecSchema, type PropertyType } from "@semprec/data";
import { z } from "zod";

/**
 * Every schema here is a strict object: an unknown key is a validation error, not a silently
 * ignored one. That is what keeps identity (`actor`, `userId`, `agentProjectItemId`) and
 * server-derived ownership fields (`system`, `schemaLocked`, `ownerProjectItemId`,
 * `ownerModuleId`, `owner`, `ownerProcess`, `locked`, `createdBy`, `creatorProjectItemId`)
 * out of external input — they can never reach the service, and therefore never influence
 * authorization, no matter which transport the call arrives on.
 */

const id = z.string().min(1);

/** #37's keyset pagination: default 50, hard maximum 200. */
const cursor = z.string().min(1).optional();
const limit = z.number().int().positive().max(200).default(50);

/** #37's typed query body: the filter/sort tree plus the explicit trash opt-in. */
const queryShape = {
  filter: filterNodeSchema.optional(),
  sort: z.array(sortSpecSchema).optional(),
  inTrash: z.boolean().default(false),
  cursor,
  limit,
};

type NonRelationPropertyType = Exclude<PropertyType, "relation">;
const NON_RELATION_PROPERTY_TYPES = PROPERTY_TYPES.filter(
  (type): type is NonRelationPropertyType => type !== "relation",
) as [NonRelationPropertyType, ...NonRelationPropertyType[]];
const nonRelationPropertyType = z.enum(NON_RELATION_PROPERTY_TYPES);

const propertyConfig = z.record(z.string(), z.unknown());
const itemProperties = z.record(z.string(), z.unknown());

// ---- databases ----

export const DatabaseListInputSchema = z.strictObject({ cursor, limit });
export const DatabaseGetInputSchema = z.strictObject({ databaseId: id });
export const DatabaseCreateInputSchema = z.strictObject({ name: z.string().min(1), parentItemId: id.optional() });
export const DatabasePatchInputSchema = z.strictObject({
  databaseId: id,
  patch: z.strictObject({ name: z.string().min(1).optional() }),
});
export const DatabaseArchiveInputSchema = z.strictObject({ databaseId: id });
export const DatabaseRestoreInputSchema = z.strictObject({ databaseId: id });
export const DatabaseQueryInputSchema = z.strictObject({ databaseId: id, ...queryShape });

// ---- properties ----

/**
 * The relation branch is the sole external input that carries `locked`: a relation property's
 * source and inverse lock state is part of the relation definition itself, not ownership
 * metadata the server derives.
 */
export const PropertyCreateInputSchema = z.union([
  z.strictObject({
    databaseId: id,
    key: z.string().min(1),
    name: z.string().min(1),
    type: nonRelationPropertyType,
    config: propertyConfig.optional(),
  }),
  z.strictObject({
    databaseId: id,
    key: z.string().min(1),
    name: z.string().min(1),
    type: z.literal("relation"),
    targetDatabaseId: id,
    cardinality: z.enum(["one_to_one", "one_to_many", "many_to_many"]),
    locked: z.boolean(),
    inverse: z.strictObject({ key: z.string().min(1), name: z.string().min(1), locked: z.boolean() }).optional(),
  }),
]);
export const PropertyListInputSchema = z.strictObject({ databaseId: id });
export const PropertyGetInputSchema = z.strictObject({ propertyId: id });
/**
 * `type` excludes `relation`: a non-relation property cannot become a relation through a
 * patch, and changing an existing relation definition goes through #82's protected path.
 */
export const PropertyPatchInputSchema = z.strictObject({
  propertyId: id,
  patch: z.strictObject({
    name: z.string().min(1).optional(),
    type: nonRelationPropertyType.optional(),
    config: propertyConfig.optional(),
  }),
});
export const PropertyDeleteInputSchema = z.strictObject({ propertyId: id });

// ---- views ----

export const ViewListInputSchema = z.strictObject({ cursor, limit });
export const ViewGetInputSchema = z.strictObject({ viewId: id });
/** `databaseId: null` is a curated view, whose members can come from several databases. */
export const ViewCreateInputSchema = z.strictObject({
  databaseId: id.nullable().optional(),
  type: z.string().min(1),
  name: z.string().min(1),
  config: propertyConfig.optional(),
  isDefault: z.boolean().optional(),
});
export const ViewPatchInputSchema = z.strictObject({
  viewId: id,
  patch: z.strictObject({
    name: z.string().min(1).optional(),
    config: propertyConfig.optional(),
    isDefault: z.boolean().optional(),
  }),
});
export const ViewDeleteInputSchema = z.strictObject({ viewId: id });
export const ViewQueryInputSchema = z.strictObject({ viewId: id, ...queryShape });

// ---- view membership ----

export const ViewItemAddInputSchema = z.strictObject({ viewId: id, itemId: id, position: z.number() });
export const ViewItemRemoveInputSchema = z.strictObject({ viewId: id, itemId: id });
export const ViewItemReorderInputSchema = z.strictObject({ viewId: id, itemId: id, position: z.number() });

// ---- items ----

export const ItemGetInputSchema = z.strictObject({ itemId: id });
/** Omitting `idempotencyKey` preserves #21/#37's non-retry create; supplying one activates dedup. */
export const ItemCreateInputSchema = z.strictObject({
  databaseId: id,
  properties: itemProperties,
  idempotencyKey: z.string().min(1).optional(),
});
/** `ifVersion` is the `updatedAt` the caller last held; metadata commands have no equivalent. */
export const ItemPatchInputSchema = z.strictObject({ itemId: id, properties: itemProperties, ifVersion: z.string().min(1) });
export const ItemDeleteInputSchema = z.strictObject({ itemId: id });
export const ItemRestoreInputSchema = z.strictObject({ itemId: id });

// ---- relations ----

/** #82's `CreateRelationInput`: idempotent create that replaces the edge's metadata in full. */
export const RelationPutInputSchema = z.strictObject({
  relationPropertyId: id,
  callerItemId: id,
  targetItemId: id,
  metadata: z.record(z.string(), z.unknown()).optional(),
});
/** The same edge identity without metadata; the delete underneath it is idempotent. */
export const RelationDeleteInputSchema = z.strictObject({
  relationPropertyId: id,
  callerItemId: id,
  targetItemId: id,
});

export type DatabaseListInput = z.infer<typeof DatabaseListInputSchema>;
export type DatabaseGetInput = z.infer<typeof DatabaseGetInputSchema>;
export type DatabaseCreateInput = z.infer<typeof DatabaseCreateInputSchema>;
export type DatabasePatchInput = z.infer<typeof DatabasePatchInputSchema>;
export type DatabaseArchiveInput = z.infer<typeof DatabaseArchiveInputSchema>;
export type DatabaseRestoreInput = z.infer<typeof DatabaseRestoreInputSchema>;
export type DatabaseQueryInput = z.infer<typeof DatabaseQueryInputSchema>;
export type PropertyCreateInput = z.infer<typeof PropertyCreateInputSchema>;
export type PropertyListInput = z.infer<typeof PropertyListInputSchema>;
export type PropertyGetInput = z.infer<typeof PropertyGetInputSchema>;
export type PropertyPatchInput = z.infer<typeof PropertyPatchInputSchema>;
export type PropertyDeleteInput = z.infer<typeof PropertyDeleteInputSchema>;
export type ViewListInput = z.infer<typeof ViewListInputSchema>;
export type ViewGetInput = z.infer<typeof ViewGetInputSchema>;
export type ViewCreateInput = z.infer<typeof ViewCreateInputSchema>;
export type ViewPatchInput = z.infer<typeof ViewPatchInputSchema>;
export type ViewDeleteInput = z.infer<typeof ViewDeleteInputSchema>;
export type ViewQueryInput = z.infer<typeof ViewQueryInputSchema>;
export type ViewItemAddInput = z.infer<typeof ViewItemAddInputSchema>;
export type ViewItemRemoveInput = z.infer<typeof ViewItemRemoveInputSchema>;
export type ViewItemReorderInput = z.infer<typeof ViewItemReorderInputSchema>;
export type ItemGetInput = z.infer<typeof ItemGetInputSchema>;
export type ItemCreateInput = z.infer<typeof ItemCreateInputSchema>;
export type ItemPatchInput = z.infer<typeof ItemPatchInputSchema>;
export type ItemDeleteInput = z.infer<typeof ItemDeleteInputSchema>;
export type ItemRestoreInput = z.infer<typeof ItemRestoreInputSchema>;
export type RelationPutInput = z.infer<typeof RelationPutInputSchema>;
export type RelationDeleteInput = z.infer<typeof RelationDeleteInputSchema>;
