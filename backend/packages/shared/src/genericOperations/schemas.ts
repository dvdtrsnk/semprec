import { z } from "zod";
import { PROPERTY_TYPES, type Item, type PropertyType } from "./rows.js";
import { filterNodeSchema, sortSpecSchema } from "./filterSort.js";
import type { GenericOperationName } from "./operationNames.js";

/**
 * Strict Zod input schemas for the generic-operation catalog. Every schema is a strict object: an unrecognized key (a
 * spoofed `actor`/`userId`/`agentProjectItemId`, or a server-derived field such as `system`, `schemaLocked`,
 * `ownerProjectItemId`, `locked` or `createdBy`) fails validation instead of being dropped. The one exception is
 * `PropertyCreateInputSchema`'s relation branch, whose `locked` fields are required inputs.
 */

const cursor = z.string().optional();
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

/** `title` is added by the operation itself; other types are added afterwards through the property operations. */
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
        overviewHidden: z.boolean().optional(),
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
 * The number-filter part of a `number` property's `config`: `filterPresets` are named thresholds compared with `lte` or
 * `gte` (never equality), `emptyPreset` the optional "no value" choice, which also matches 0 when `matchZero` is set. A
 * literal `label` wins over `labelKey`. Validate the picked `{ filterPresets, emptyPreset }` pair, not the whole
 * config.
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
 * `type` excludes `'relation'`: a property cannot become a relation through patch; relation-definition changes stay
 * outside this catalog.
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

const PROPERTY_OPTION_LABEL_MAX_LENGTH = 60;

/**
 * Whether `text` can be a string inside a Postgres `jsonb` value. U+0000 and unpaired UTF-16 surrogates (what cutting
 * in the middle of an emoji leaves) cannot: `JSON.stringify` writes them as `\uXXXX` escapes that the `jsonb` input
 * function refuses. With the `u` flag a surrogate pair is one character, so only an unpaired surrogate matches.
 */
function isStorableInJsonb(text: string): boolean {
  return !text.includes("\u0000") && !/\p{Surrogate}/u.test(text);
}

/** Option label: trimmed, 1 to 60 UTF-16 code units, and storable in `jsonb` (`isStorableInJsonb`). */
export const PropertyOptionLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROPERTY_OPTION_LABEL_MAX_LENGTH)
  .refine(isStorableInJsonb, "label must not hold U+0000 or a surrogate without its pair");

/** The operation derives the option key from `label`. */
export const PropertyOptionAddInputSchema = z
  .object({
    propertyId: canonicalUuid,
    label: PropertyOptionLabelSchema,
    color: DatabaseColorSchema.optional(),
  })
  .strict();
export type PropertyOptionAddInput = z.infer<typeof PropertyOptionAddInputSchema>;

/** The option key itself never changes. An input with neither `label` nor `color` is refused by the operation. */
export const PropertyOptionUpdateInputSchema = z
  .object({
    propertyId: canonicalUuid,
    key: z.string().min(1),
    label: PropertyOptionLabelSchema.optional(),
    color: DatabaseColorSchema.optional(),
  })
  .strict();
export type PropertyOptionUpdateInput = z.infer<typeof PropertyOptionUpdateInputSchema>;

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

export const SEARCH_MAX_QUERY_LENGTH = 200;

/**
 * Free text that narrows one database's rows together with the filter, using the global search's text match. Query
 * syntax characters carry no meaning.
 */
const itemSearchText = z.string().min(1).max(SEARCH_MAX_QUERY_LENGTH);

const queryFields = {
  include: includeField,
  cursor,
  limit,
  filter: filterNodeSchema.optional(),
  sort: z.array(sortSpecSchema).max(MAX_SORT_SPECS).optional(),
  inTrash: z.boolean().optional(),
  includeCount: z.boolean().optional(),
  q: itemSearchText.optional(),
};

export const ViewQueryInputSchema = z.object({ viewId: z.string(), ...queryFields }).strict();
export type ViewQueryInput = z.infer<typeof ViewQueryInputSchema>;

export const DatabaseQueryInputSchema = z.object({ databaseId: z.string(), ...queryFields }).strict();
export type DatabaseQueryInput = z.infer<typeof DatabaseQueryInputSchema>;

const ITEM_COUNT_MAX_ENTRIES = 20;

/**
 * Up to 20 counts in one call, each counting one database's items under `filter`. `groupBy` names a relation or select
 * property to split by (groupability is checked by the operation); `collection: true` also applies the manifest's
 * collection filter; `q` is ANDed with the filter and applies to every group.
 */
export const ItemCountInputSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            databaseId: canonicalUuid,
            filter: filterNodeSchema.optional(),
            groupBy: z.string().min(1).optional(),
            collection: z.boolean().optional(),
            q: itemSearchText.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(ITEM_COUNT_MAX_ENTRIES),
  })
  .strict();
export type ItemCountInput = z.infer<typeof ItemCountInputSchema>;

const DATABASE_FACETS_MAX_FACETS = 20;

const facetKey = z.string().min(1);

/**
 * Each facet is a property key of the database or `{ path: [relationKey, relationKey] }` (a relation, then a relation
 * of the items it reaches). `extra.open` is a second filter tree. Facet validity is decided by the operation.
 */
export const DatabaseFacetsInputSchema = z
  .object({
    databaseId: canonicalUuid,
    filter: filterNodeSchema.optional(),
    facets: z
      .array(
        z.union([
          facetKey,
          // Explicit length also supplies minItems/maxItems to the input JSON Schema.
          z.object({ path: z.tuple([facetKey, facetKey]).check(z.length(2)) }).strict(),
        ]),
      )
      .min(1)
      .max(DATABASE_FACETS_MAX_FACETS),
    extra: z.object({ open: filterNodeSchema }).strict().optional(),
  })
  .strict();
export type DatabaseFacetsInput = z.infer<typeof DatabaseFacetsInputSchema>;

/**
 * Search groups in their fixed order. `contact` holds People and Companies; `mail` holds one entry per mail thread;
 * `chat` holds a person's Semp threads and is never given to an agent actor.
 */
export const SEARCH_GROUP_TYPES = ["task", "event", "project", "contact", "journal", "file", "mail", "chat"] as const;
export type SearchGroupType = (typeof SEARCH_GROUP_TYPES)[number];

/** The groups whose results are items, in the order of `SEARCH_GROUP_TYPES`; the others are threads and carry a `threadId`. */
export const SEARCH_ITEM_GROUP_TYPES = ["task", "event", "project", "contact", "journal", "file"] as const;
export type SearchItemGroupType = (typeof SEARCH_ITEM_GROUP_TYPES)[number];
const SEARCH_NON_JOURNAL_ITEM_GROUP_TYPES = ["task", "event", "project", "contact", "file"] as const;
const SEARCH_THREAD_GROUP_TYPES = ["mail", "chat"] as const;

/** The Journal period types a subpage can be created under; mirrors the data package's `JOURNAL_PERIOD_TYPES`. */
const JOURNAL_PERIOD_TYPE_VALUES = ["year", "quarter", "month", "week", "day"] as const;

export const SEARCH_SUBTITLE_KINDS = [
  "date",
  "time",
  "timeRange",
  "place",
  "recurrence",
  "project",
  "people",
  "phone",
  "relationship",
  "status",
  "sender",
  "movedFrom",
  "missedInEvent",
] as const;
export type SearchSubtitleKind = (typeof SEARCH_SUBTITLE_KINDS)[number];

const SEARCH_DEFAULT_PER_GROUP_LIMIT = 4;
const SEARCH_MAX_PER_GROUP_LIMIT = 50;
/** An opaque keyset token is far shorter; the cap only keeps an absurd value out of the decoder. */
const SEARCH_MAX_CURSOR_LENGTH = 512;

/**
 * `scope` defaults to every group; `cursor` continues one group's `nextCursor`, so it requires exactly one scope type.
 * The cursor's content is checked by the operation.
 */
export const SearchInputSchema = z
  .object({
    q: z.string().min(1).max(SEARCH_MAX_QUERY_LENGTH),
    scope: z
      .array(z.enum(SEARCH_GROUP_TYPES))
      .min(1)
      .max(SEARCH_GROUP_TYPES.length)
      .refine((scope) => new Set(scope).size === scope.length, "scope must not repeat a type")
      .default([...SEARCH_GROUP_TYPES]),
    perGroupLimit: z.number().int().min(1).max(SEARCH_MAX_PER_GROUP_LIMIT).default(SEARCH_DEFAULT_PER_GROUP_LIMIT),
    cursor: z.string().min(1).max(SEARCH_MAX_CURSOR_LENGTH).optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.cursor !== undefined && input.scope.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["cursor"], message: "cursor requires a scope of exactly one type" });
    }
  });
export type SearchInput = z.infer<typeof SearchInputSchema>;

/**
 * One structured piece of a result's subtitle. The client composes the text (relative words such as "today" depend on
 * the clock and time zone, and MCP clients need no text), so `value` is canonical: a `YYYY-MM-DD` date, an `HH:mm`
 * time, `HH:mm-HH:mm` for a `timeRange`, a stored key for `recurrence`, `relationship` and `status`, a decimal integer
 * for `count`, and the stored title of the linked item for the kinds that carry `itemId`.
 */
const SearchSubtitlePartSchema = z
  .object({ kind: z.enum(SEARCH_SUBTITLE_KINDS), value: z.string(), itemId: canonicalUuid.optional() })
  .strict();
export type SearchSubtitlePart = z.infer<typeof SearchSubtitlePartSchema>;

const searchResultFields = {
  title: z.string(),
  subtitleParts: z.array(SearchSubtitlePartSchema),
  /**
   * An excerpt of at most 160 characters of plain text from the stored text of the item that matched the query (its
   * page and, for a Journal day, its Inbox entries). It is `null` for a result found through anything else, and for the
   * `chat` group. A `mail` result carries the matching fragment of a message, or the preview of the last message.
   */
  snippet: z.string().nullable(),
};

const searchItemResultFields = {
  itemId: canonicalUuid,
  databaseId: canonicalUuid,
  databaseKey: z.string().min(1),
  ...searchResultFields,
};

const SearchItemResultSchema = z.object(searchItemResultFields).strict();
export type SearchItemResult = z.infer<typeof SearchItemResultSchema>;

/**
 * The Journal period of a `journal` result: canonical `type` and `period` (`2026-10-16`, `2026-W42`, `2026-08`,
 * `2026-Q3`, `2026`); clients localise the label.
 */
const SearchJournalPeriodSchema = z
  .object({ type: z.enum(JOURNAL_PERIOD_TYPE_VALUES), period: z.string().min(1) })
  .strict();

const SearchJournalResultSchema = z.object({ ...searchItemResultFields, journal: SearchJournalPeriodSchema }).strict();
export type SearchJournalResult = z.infer<typeof SearchJournalResultSchema>;

const SearchThreadResultSchema = z.object({ threadId: canonicalUuid, ...searchResultFields }).strict();
export type SearchThreadResult = z.infer<typeof SearchThreadResultSchema>;

/** A `mail` entry: the thread plus the Emails item of its last message, which is what a client opens. */
const SearchMailResultSchema = z
  .object({
    threadId: canonicalUuid,
    itemId: canonicalUuid,
    databaseId: canonicalUuid,
    databaseKey: z.string().min(1),
    ...searchResultFields,
  })
  .strict();
export type SearchMailResult = z.infer<typeof SearchMailResultSchema>;

/** `total` counts every match of the group, not only the listed ones. */
const SearchGroupSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.enum(SEARCH_NON_JOURNAL_ITEM_GROUP_TYPES),
      total: z.number().int().min(0),
      items: z.array(SearchItemResultSchema),
      nextCursor: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.literal("journal"),
      total: z.number().int().min(0),
      items: z.array(SearchJournalResultSchema),
      nextCursor: z.string().min(1).nullable(),
    })
    .strict(),
  z
    .object({
      type: z.enum(SEARCH_THREAD_GROUP_TYPES),
      total: z.number().int().min(0),
      items: z.array(z.union([SearchMailResultSchema, SearchThreadResultSchema])),
      nextCursor: z.string().min(1).nullable(),
    })
    .strict(),
]);
export type SearchGroup = z.infer<typeof SearchGroupSchema>;
export type SearchItemGroup = Extract<SearchGroup, { type: SearchItemGroupType }>;

/** A group without a match is omitted. */
export const SearchOutputSchema = z.object({ groups: z.array(SearchGroupSchema) }).strict();
export type SearchOutput = z.infer<typeof SearchOutputSchema>;

/** Range of the int4 `view_items.position` column. */
const viewItemPosition = z.number().int().min(0).max(2147483647);

/** Omitting `position` appends a new item, or leaves an already-present item where it is. */
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

/** Supplying `idempotencyKey` activates dedup. */
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

/** `ifVersion` is required: only item property patches use optimistic concurrency. */
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

/** Idempotent create or full metadata replacement. */
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

/** Every live edge of `itemId`, optionally narrowed to one of the item's relation properties. */
export const RelationListInputSchema = z
  .object({
    itemId: canonicalUuid,
    relationPropertyId: canonicalUuid.optional(),
  })
  .strict();
export type RelationListInput = z.infer<typeof RelationListInputSchema>;

export const RelationRelatedInputSchema = z.object({ itemId: canonicalUuid }).strict();
export type RelationRelatedInput = z.infer<typeof RelationRelatedInputSchema>;

export const PageEnsureInputSchema = z.object({ itemId: canonicalUuid }).strict();
export type PageEnsureInput = z.infer<typeof PageEnsureInputSchema>;

/**
 * Ensures the Journal entry and page of a period, named by its canonical `period` key or any `date` inside it; exactly
 * one of the two is given. Key validity is checked by the operation.
 */
export const PageEnsureJournalPeriodInputSchema = z
  .object({
    type: z.enum(JOURNAL_PERIOD_TYPE_VALUES),
    date: z.iso.date().optional(),
    period: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.date === undefined) === (value.period === undefined)) {
      ctx.addIssue({ code: "custom", path: ["date"], message: "Exactly one of date and period is required" });
    }
  });
export type PageEnsureJournalPeriodInput = z.infer<typeof PageEnsureJournalPeriodInputSchema>;

/** Merges the duplicate Journal entries of one period; key validity is checked by the operation. */
export const PageMergeJournalDuplicatesInputSchema = z
  .object({ type: z.enum(JOURNAL_PERIOD_TYPE_VALUES), period: z.string().min(1) })
  .strict();
export type PageMergeJournalDuplicatesInput = z.infer<typeof PageMergeJournalDuplicatesInputSchema>;

export const PageGetInputSchema = z
  .object({
    itemId: canonicalUuid,
    format: z.enum(["summary", "markdown"]).default("summary"),
    /** Bounds `blocks` of the summary; the Markdown format returns the whole page and ignores it. */
    limit: z.number().int().nonnegative().optional(),
  })
  .strict();
export type PageGetInput = z.infer<typeof PageGetInputSchema>;

/** Most blocks one conversion may name; it bounds the Pages items and documents one transaction creates. */
const PAGE_CREATE_SUBPAGE_MAX_FROM_BLOCKS = 200;

/**
 * Creates a subpage under an item's page or a Journal period's page (entry created when missing). `afterBlockId` places
 * the `page` block (end when absent). With `fromBlockIds` the named non-page blocks are converted in place into one
 * empty subpage each, and `afterBlockId` and `title` are ignored.
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

/** Duplicates the subpage with every page nested in it. Tree size and Pages membership are checked by the operation. */
export const PageDuplicateInputSchema = z.object({ pageItemId: canonicalUuid }).strict();
export type PageDuplicateInput = z.infer<typeof PageDuplicateInputSchema>;

/** The operation normalizes `title` and refuses one that is too long, so no length here. */
export const PageRenameInputSchema = z.object({ pageItemId: canonicalUuid, title: z.string() }).strict();
export type PageRenameInput = z.infer<typeof PageRenameInputSchema>;

/** Every block type of the block model except `page`. */
export const PAGE_CONVERT_TARGET_TYPES = [
  "text",
  "h1",
  "h2",
  "h3",
  "bullet",
  "number",
  "todo",
  "quote",
  "toggle",
] as const;
export type PageConvertTargetType = (typeof PAGE_CONVERT_TARGET_TYPES)[number];

/**
 * Restyles a `page` block into `type`, moving its subpage tree to the Trash. `confirmedPageCount` is the number of
 * pages the person was shown (at least 1); the operation refuses it when it is no longer current.
 */
export const PageConvertToBlockInputSchema = z
  .object({
    parentItemId: canonicalUuid,
    blockId: z.string().min(1),
    type: z.enum(PAGE_CONVERT_TARGET_TYPES),
    confirmedPageCount: z.number().int().min(1).max(2147483647),
  })
  .strict();
export type PageConvertToBlockInput = z.infer<typeof PageConvertToBlockInputSchema>;

/** Most blocks one insert may name by id; bounds the array the edge accepts. */
const PAGE_INSERT_MAX_BLOCK_IDS = 10_000;
/** Longest Markdown body one insert accepts, in UTF-16 units (the REST adapter's own body cap is tighter in bytes). */
const PAGE_INSERT_MAX_MARKDOWN_LENGTH = 1_000_000;

/**
 * Inserts Markdown at `"start"`, `"end"` or after `afterBlockId`. `blockIds` optionally names the new blocks, one per
 * parsed block in order; their validity is checked by the operation.
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

/** A page version is a 43-character base64url SHA-256; this only bounds the edge. */
const PAGE_REPLACE_MAX_ETAG_LENGTH = 128;

/**
 * Replaces the page body when it still has version `expectedEtag` (from `page.get` with `format: "markdown"`). Token
 * currency and page-link validity are checked by the operation.
 */
export const PageReplaceInputSchema = z
  .object({
    itemId: canonicalUuid,
    markdown: z.string().max(PAGE_INSERT_MAX_MARKDOWN_LENGTH),
    expectedEtag: z.string().min(1).max(PAGE_REPLACE_MAX_ETAG_LENGTH),
  })
  .strict();
export type PageReplaceInput = z.infer<typeof PageReplaceInputSchema>;

/** Also the default when `limit` is omitted. */
const PAGE_CHANGES_MAX_LIMIT = 500;
const PAGE_CHANGES_DEFAULT_LIMIT = 100;

/**
 * Writes to the page since `since` (ISO 8601 with offset) by one stored author (default: the assistant), oldest first.
 * A future or unretained `since` is refused by the operation.
 */
export const PageChangesInputSchema = z
  .object({
    itemId: canonicalUuid,
    since: z.iso.datetime({ offset: true }),
    by: z.enum(["user", "ai_agent", "system"]).default("ai_agent"),
    limit: z.number().int().min(1).max(PAGE_CHANGES_MAX_LIMIT).default(PAGE_CHANGES_DEFAULT_LIMIT),
  })
  .strict();
export type PageChangesInput = z.infer<typeof PageChangesInputSchema>;

export const ValueLinkInputSchema = z.object({ itemId: canonicalUuid, propertyKey: z.string().min(1) }).strict();
export type ValueLinkInput = z.infer<typeof ValueLinkInputSchema>;

/** A future or unretained `at` is refused by the operation. */
export const PageRestoreVersionInputSchema = z
  .object({
    itemId: canonicalUuid,
    at: z.iso.datetime({ offset: true }),
  })
  .strict();
export type PageRestoreVersionInput = z.infer<typeof PageRestoreVersionInputSchema>;

/** Mapped type over every operation name; exhaustiveness is checked by `_assertInputByOperationExhaustive` below. */
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
  "property.option.add": PropertyOptionAddInput;
  "property.option.update": PropertyOptionUpdateInput;
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
  "relation.related": RelationRelatedInput;
  "page.restoreVersion": PageRestoreVersionInput;
  "link.unlink": ValueLinkInput;
  "link.relink": ValueLinkInput;
  "page.get": PageGetInput;
  "page.ensure": PageEnsureInput;
  "page.ensureJournalPeriod": PageEnsureJournalPeriodInput;
  "page.mergeJournalDuplicates": PageMergeJournalDuplicatesInput;
  "page.createSubpage": PageCreateSubpageInput;
  "page.insert": PageInsertInput;
  "page.replace": PageReplaceInput;
  "page.changes": PageChangesInput;
  "item.count": ItemCountInput;
  "page.duplicate": PageDuplicateInput;
  "page.rename": PageRenameInput;
  "page.convertToBlock": PageConvertToBlockInput;
  "database.facets": DatabaseFacetsInput;
  search: SearchInput;
}

/** Fails to compile if `InputByOperation`'s keys and `GenericOperationName`'s literals ever diverge in either direction. */
type AssertSameKeys<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const _assertInputByOperationExhaustive: AssertSameKeys<keyof InputByOperation, GenericOperationName> = true;
void _assertInputByOperationExhaustive;
