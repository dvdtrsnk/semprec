import { z } from "zod";
import { PROPERTY_TYPES, type Item, type PropertyType } from "./rows.js";
import { filterNodeSchema, sortSpecSchema } from "./filterSort.js";
import type { GenericOperationName } from "./operationNames.js";

/**
 * Strict Zod input schemas for the 38-operation catalog (issues #252, #1404, #1676, #1679), extracted from #37's
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

/** Lower-case kebab-case icon name; the clients own which names they can render. */
const DatabaseIconSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/, "icon must be lower-case kebab-case");
/** `#RRGGBB` in either case, normalized to upper case before it is stored. */
const DatabaseColorSchema = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/, "color must be #RRGGBB")
  .transform((color) => color.toUpperCase());

/** Property types a collection can be created with; `title` is added by the operation itself, the rest are added afterwards through the property operations. */
const DATABASE_CREATE_PROPERTY_TYPES = ["text", "number", "select", "date", "checkbox", "url", "file"] as const;
/** Key of the title property created together with `properties`. */
export const DATABASE_CREATE_TITLE_PROPERTY_KEY = "name";
const DATABASE_CREATE_MAX_PROPERTIES = 50;
const canonicalUuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Expected a UUID");

const DatabaseCreatePropertySchema = z.union([
  z
    .object({
      key: z.string().min(1),
      name: z.string().min(1),
      type: z.enum(DATABASE_CREATE_PROPERTY_TYPES),
      config: jsonObject.optional(),
    })
    .strict(),
  z
    .object({
      key: z.string().min(1),
      name: z.string().min(1),
      type: z.literal("relation"),
      targetDatabaseId: canonicalUuid,
      cardinality: z.enum(["one_to_one", "one_to_many", "many_to_many"]),
    })
    .strict(),
]);
export type DatabaseCreateProperty = z.infer<typeof DatabaseCreatePropertySchema>;

export const DatabaseCreateInputSchema = z
  .object({
    name: z.string().min(1),
    parentItemId: z.string().optional(),
    icon: DatabaseIconSchema.optional(),
    color: DatabaseColorSchema.optional(),
    titlePropertyName: z.string().min(1).optional(),
    properties: z.array(DatabaseCreatePropertySchema).max(DATABASE_CREATE_MAX_PROPERTIES).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    const seen = new Set<string>([DATABASE_CREATE_TITLE_PROPERTY_KEY]);
    (input.properties ?? []).forEach((property, index) => {
      if (seen.has(property.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["properties", index, "key"],
          message: `Duplicate property key '${property.key}'`,
        });
      }
      seen.add(property.key);
    });
  });
export type DatabaseCreateInput = z.infer<typeof DatabaseCreateInputSchema>;

export const DatabasePatchInputSchema = z
  .object({
    databaseId: z.string(),
    patch: z
      .object({
        name: z.string().min(1).optional(),
        icon: DatabaseIconSchema.nullable().optional(),
        color: DatabaseColorSchema.nullable().optional(),
      })
      .strict()
      .refine((patch) => Object.values(patch).some((value) => value !== undefined), {
        message: "Patch must include at least one field",
        params: { reason: "empty_patch" },
      })
      .meta({ minProperties: 1 }),
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

const nonEmptyString = z.string().min(1);

/**
 * The number-filter part of a `number` property's `config` (issue #1622): `filterPresets` are the named thresholds a
 * filter offers, compared with `lte` or `gte` (never equality), and `emptyPreset` the optional "no value" choice,
 * which also matches 0 when `matchZero` is set. `labelKey` is a full catalog key of the owning module; a literal
 * `label` wins over it. Validate the picked `{ filterPresets, emptyPreset }` pair, not the whole config, which keeps
 * its other keys. Unknown keys inside a preset are rejected.
 */
export const NumberFilterConfigSchema = z
  .object({
    filterPresets: z
      .array(
        z
          .object({
            value: z.number(),
            op: z.enum(["lte", "gte"]),
            labelKey: nonEmptyString,
            label: nonEmptyString.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(10),
    emptyPreset: z
      .object({ labelKey: nonEmptyString, label: nonEmptyString.optional(), matchZero: z.boolean() })
      .strict()
      .optional(),
  })
  .strict();
export type NumberFilterConfig = z.infer<typeof NumberFilterConfigSchema>;

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

/** Opt-in extras on an item read (issue #1403); a read without `include` returns exactly what it did before. */
export const RelationIncludeSchema = z
  .record(z.string().min(1), z.array(z.string().min(1)).max(10))
  .refine((relations) => Object.keys(relations).length <= 5, "At most five relation keys are allowed");
const includeField = z
  .union([
    z
      .object({
        links: z.boolean().optional(),
        derived: z.boolean().optional(),
        automation: z.boolean().optional(),
        relations: RelationIncludeSchema.optional(),
      })
      .strict(),
    z.array(z.enum(["links", "derived", "automation"])).max(3),
  ])
  .optional();
export type ItemReadInclude = z.infer<typeof includeField>;

const queryFields = {
  include: includeField,
  cursor,
  limit,
  filter: filterNodeSchema.optional(),
  sort: z.array(sortSpecSchema).max(MAX_SORT_SPECS).optional(),
  inTrash: z.boolean().optional(),
  includeCount: z.boolean().optional(),
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

export const ItemGetInputSchema = z.object({ itemId: z.string(), include: includeField }).strict();
export type ItemGetInput = z.infer<typeof ItemGetInputSchema>;

/** Omitting `idempotencyKey` preserves #21/#37's non-retry create behavior; supplying one activates dedup. */
export const ItemCreateInputSchema = z
  .object({
    databaseId: z.string(),
    properties: jsonObject,
    idempotencyKey: z.string().optional(),
    relations: z
      .array(z.object({ propertyKey: z.string(), targetItemIds: z.array(canonicalUuid).max(50) }).strict())
      .max(10)
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = value.relations?.map((relation) => relation.propertyKey) ?? [];
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({ code: "custom", path: ["relations"], message: "Duplicate relation property" });
  });
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

/** Item state after the patch, with the patched keys' values from its write transaction. */
export type ItemPatchOutput = Item & { previous: Record<string, unknown> };

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

export const RelationSetInputSchema = z
  .object({
    relationPropertyId: canonicalUuid,
    callerItemId: canonicalUuid,
    targetItemId: canonicalUuid.nullable(),
  })
  .strict();
export type RelationSetInput = z.infer<typeof RelationSetInputSchema>;

/** Same endpoints as `RelationPutInputSchema`, without metadata — idempotent unlink. */
export const RelationDeleteInputSchema = z
  .object({
    relationPropertyId: z.string(),
    callerItemId: z.string(),
    targetItemId: z.string(),
  })
  .strict();
export type RelationDeleteInput = z.infer<typeof RelationDeleteInputSchema>;

/** Every live edge of `itemId` (issue #1404), optionally narrowed to one of the item's own relation properties. */
export const RelationListInputSchema = z
  .object({
    itemId: canonicalUuid,
    relationPropertyId: canonicalUuid.optional(),
  })
  .strict();
export type RelationListInput = z.infer<typeof RelationListInputSchema>;

export const PageEnsureInputSchema = z.object({ itemId: canonicalUuid }).strict();
export type PageEnsureInput = z.infer<typeof PageEnsureInputSchema>;

export const PageGetInputSchema = z
  .object({
    itemId: canonicalUuid,
    format: z.enum(["summary", "markdown"]).default("summary"),
    /** Bounds `blocks` of the summary; the Markdown format returns the whole page and ignores it. */
    limit: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PageGetInput = z.infer<typeof PageGetInputSchema>;

/** The Journal period types a subpage can be created under; mirrors the data package's `JOURNAL_PERIOD_TYPES`. */
const JOURNAL_PERIOD_TYPE_VALUES = ["year", "quarter", "month", "week", "day"] as const;

/** Most blocks one conversion may name; it bounds the Pages items and documents one transaction creates. */
const PAGE_CREATE_SUBPAGE_MAX_FROM_BLOCKS = 200;

/**
 * Creates one new subpage under an item's page, or under a Journal period's page (issue #1676): the parent names a
 * live item or a Journal `{ type, period }` whose entry is created when missing. `afterBlockId` places the `page`
 * block after a block of the parent's document (the end when absent). With `fromBlockIds` (issue #2013) the named
 * non-page blocks of the parent are converted in place into one empty subpage each, and `afterBlockId` and `title` are
 * ignored. The period key itself is validated by the operation, not by this schema.
 */
export const PageCreateSubpageInputSchema = z
  .object({
    parent: z.union([
      z.object({ itemId: canonicalUuid }).strict(),
      z
        .object({
          journal: z.object({ type: z.enum(JOURNAL_PERIOD_TYPE_VALUES), period: z.string().min(1) }).strict(),
        })
        .strict(),
    ]),
    afterBlockId: z.string().min(1).optional(),
    title: z.string().optional(),
    fromBlockIds: z
      .array(z.string().min(1))
      .min(1)
      .max(PAGE_CREATE_SUBPAGE_MAX_FROM_BLOCKS)
      .refine((ids) => new Set(ids).size === ids.length, "fromBlockIds must not repeat an id")
      .optional(),
  })
  .strict();
export type PageCreateSubpageInput = z.infer<typeof PageCreateSubpageInputSchema>;

/** Most blocks one insert may name by id; bounds the array the edge accepts. */
const PAGE_INSERT_MAX_BLOCK_IDS = 10_000;
/** Longest Markdown body one insert accepts, in UTF-16 units (the REST adapter's own body cap is tighter in bytes). */
const PAGE_INSERT_MAX_MARKDOWN_LENGTH = 1_000_000;

/**
 * Inserts Markdown into the page of `itemId` at a placement (issue #1679): at the `"start"`, at the `"end"`, or right
 * after the block `afterBlockId`. `blockIds`, when given, names the new blocks, one id per parsed block in order;
 * otherwise the ids are generated. Whether the ids are well-formed and free is decided by the operation.
 */
export const PageInsertInputSchema = z
  .object({
    itemId: canonicalUuid,
    placement: z.union([z.enum(["start", "end"]), z.object({ afterBlockId: z.string().min(1) }).strict()]),
    markdown: z.string().max(PAGE_INSERT_MAX_MARKDOWN_LENGTH),
    blockIds: z.array(z.string().min(1)).max(PAGE_INSERT_MAX_BLOCK_IDS).optional(),
  })
  .strict();
export type PageInsertInput = z.infer<typeof PageInsertInputSchema>;

export const ValueLinkInputSchema = z.object({ itemId: canonicalUuid, propertyKey: z.string().min(1) }).strict();
export type ValueLinkInput = z.infer<typeof ValueLinkInputSchema>;

/** Restores the page of `itemId` to its state at `at` (issue #1617); a future or unretained `at` is refused by the operation, not by this schema. */
export const PageRestoreVersionInputSchema = z
  .object({
    itemId: canonicalUuid,
    at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type PageRestoreVersionInput = z.infer<typeof PageRestoreVersionInputSchema>;

/** Exhaustive mapped type over the 38 literal operation names — see the `_assertInputByOperationExhaustive` check below. */
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
  "relation.set": RelationSetInput;
  "relation.delete": RelationDeleteInput;
  "relation.list": RelationListInput;
  "page.restoreVersion": PageRestoreVersionInput;
  "link.unlink": ValueLinkInput;
  "link.relink": ValueLinkInput;
  "page.get": PageGetInput;
  "page.ensure": PageEnsureInput;
  "page.createSubpage": PageCreateSubpageInput;
  "page.insert": PageInsertInput;
}

/** Fails to compile if `InputByOperation`'s keys and `GenericOperationName`'s literals ever diverge in either direction. */
type AssertSameKeys<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const _assertInputByOperationExhaustive: AssertSameKeys<keyof InputByOperation, GenericOperationName> = true;
void _assertInputByOperationExhaustive;
