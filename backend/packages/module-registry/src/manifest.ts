import { z } from "zod";
import { RISK_CLASSES, type RiskClass } from "@semprec/shared";

/**
 * Which long-lived runtime (issue #91's two graphile-worker composition roots) a module task
 * runs under: `'api'` for deterministic/data/mail/library-style handlers, `'agents'` only for a
 * handler that starts or continues an agent session. Mirrors `@semprec/queue`'s own
 * `TaskAffinity` values — kept as a local literal type rather than an import so this package
 * doesn't gain a dependency on `@semprec/queue` just for one string union.
 */
export const MODULE_TASK_AFFINITIES = ["api", "agents", "transcribe"] as const;
export type ModuleTaskAffinity = (typeof MODULE_TASK_AFFINITIES)[number];

/**
 * A single scheduled/queued unit of work a module contributes (issue #108). `queueAffinity`
 * (issue #221) is mandatory for every active module task — it names which runtime may run it;
 * actually registering it with the queue is a later composition-root concern (#91).
 */
export interface ModuleTaskDescriptor {
  name: string;
  payloadSchemaExport: string;
  handlerExport: string;
  queueAffinity: ModuleTaskAffinity;
}

export interface ModuleWorkerDescriptor {
  name: string;
  handlerExport: string;
}

/**
 * Lets a module add its own heartbeat trigger kind (issue #109) without patching core's
 * `heartbeatRuleSchema` discriminated union: `schemaExport` validates a rule of this kind's
 * shape, `nextFireAtExport` computes its next occurrence — both dispatched to by core's
 * scheduler once the kind's owning module is active.
 */
export interface ModuleHeartbeatRuleKindDescriptor {
  kind: string;
  schemaExport: string;
  nextFireAtExport: string;
}

export interface ModuleRelatedOrderDescriptor {
  order: string[];
  omit?: string[];
}

/** The slot of an area filter template that is replaced by the id of the area being filtered for. */
export interface AreaFilterAreaValue {
  areaValue: true;
}

/**
 * How one database's items are filtered by an area (issue #1597), declared as data: a filter-tree
 * template over the relation conditions an area filter needs, with `{ areaValue: true }` in every value
 * position that takes the area id. A client substitutes the id and sends the resulting tree as an
 * ordinary filter; `expandAreaFilter` in `@semprec/data` does the same on the server.
 */
export type AreaFilterTemplate =
  | { type: "relation_contains"; property: string; value: AreaFilterAreaValue }
  | { type: "relation_path_contains"; path: [string, string]; value: AreaFilterAreaValue }
  | { type: "relation_is_empty"; property: string }
  | { type: "and"; nodes: AreaFilterTemplate[] }
  | { type: "or"; nodes: AreaFilterTemplate[] };

/**
 * `defaultViewType`, when present, names the view type a database's default (system-created)
 * view uses instead of the generic `"table"` type — e.g. Journal's `temporal-switcher`
 * (issue #24). Absent means the database's default view is a plain table.
 */
export interface ModuleDatabaseDescriptor {
  key: string;
  name: string;
  defaultViewType?: string;
  /** Searchable property keys; absent uses the generic text and select-label rule. Unknown keys are ignored. */
  searchFields?: string[];
  /** Related collection ordering for this record type; consumers apply fallback ordering. */
  relatedOrder?: ModuleRelatedOrderDescriptor;
  /** Icon name, lowercase kebab-case. Absent means the database declares no icon. */
  icon?: string;
  /** Color as `#RRGGBB`. Absent means the database declares no color. */
  color?: string;
  /** 1-based position in the client overview; `null` or absent means not in that list. */
  overviewOrder?: number | null;
  /** 1-based position in the client collection switcher; `null` or absent means not in that list. */
  switcherOrder?: number | null;
  /** Shows a database in neither list to clients anyway; only `true` has an effect. */
  clientVisible?: boolean;
  /** How this database's items are filtered by an area; absent means the database is not area-filterable. */
  areaFilter?: AreaFilterTemplate;
  /** The collection screen's quick-filter chips, in display order (issue #1647); absent means none. */
  quickFilters?: ModuleQuickFilterDescriptor[];
  /** The order a collection opens with when no chip sorts it (issue #1647). */
  defaultSort?: ModuleSortDescriptor;
  /** Catalog keys of the labels a date-grouped collection shows for past and undated items (issue #1647). */
  dateLabels?: { pastLabelKey: string; noDateLabelKey: string };
  /** The items that belong in the collection; an opaque filter tree the data package parses (issue #1647). */
  collectionFilter?: ModuleOpaqueFilter;
  /** The items a picker for this database offers by default; an opaque filter tree (issue #1647). */
  pickerFilter?: ModuleOpaqueFilter;
}

/**
 * A filter tree declared by a manifest. The filter grammar belongs to the data package, so this package
 * only requires a bounded JSON object (`isOpaqueJsonObject`) and never interprets it; the data package's
 * own tests parse every declaration with its filter schema (issue #1647).
 */
export type ModuleOpaqueFilter = Record<string, unknown>;

/** One sort key of a quick filter or default sort: a property of the database, ascending or descending. */
export interface ModuleSortDescriptor {
  property: string;
  direction: "asc" | "desc";
}

/**
 * One quick-filter chip (issue #1647). `labelKey` is a catalog key of the owning module; `filter` absent
 * means the chip shows every item ("All"); `sort` absent leaves the database's order. At most one chip of a
 * database is `isDefault`, and keys are unique within the database.
 */
export interface ModuleQuickFilterDescriptor {
  key: string;
  labelKey: string;
  filter?: ModuleOpaqueFilter;
  sort?: ModuleSortDescriptor[];
  isDefault?: boolean;
}

/**
 * A manifest-declared resumable data migration (issue #111) for one `from_version` ->
 * `to_version` transition of `databaseKey`'s items, distinct from the plain-string
 * `migrations` field above (that one names the module's own structural/DDL files applied
 * by the forward-only runner, issue #224). `converterExport` names a `ModuleDataMigrationConverter`
 * (`registry.ts`) of shape `(properties, context) => properties` that the module data migration
 * runner calls once per item; a converter that needs no context may declare only `properties`.
 */
export interface ModuleDataMigrationDescriptor {
  databaseKey: string;
  fromVersion: string;
  toVersion: string;
  converterExport: string;
}

/**
 * `capability`, when present, names an entry that must be granted at runtime (see
 * `ModuleRegistry.getAgentTools`) for the tool to appear in a projection at all — an
 * ungranted tool is absent, never present-but-denied.
 */
export interface ModuleAgentToolDescriptor {
  name: string;
  handlerExport: string;
  argumentSchemaExport: string;
  capability?: string;
  approval: "none" | "always" | "unlessProjectPermitted";
  riskClass?: RiskClass;
  projectPermission?: string;
}

/**
 * The two, and only two, reasons a custom route (issue #239) is allowed to exist outside the
 * generic REST surface: `transactional-semantics` covers an action with its own transactional
 * shape a generic item write/read can't express (a cross-database write in one transaction, an
 * aggregate read outside the item model, a binary upload); `single-consumer-read` covers a read
 * shortcut shaped for exactly one consumer. Never CRUD over module data — that always goes
 * through the generic resource endpoints instead. `moduleManifestSchema` rejects any entry
 * missing one of these two values, satisfying the issue's "every manifest entry must state which
 * justification applies" rule structurally, with no extra runtime check needed.
 */
export const CUSTOM_ROUTE_JUSTIFICATIONS = ["transactional-semantics", "single-consumer-read"] as const;
export type CustomRouteJustification = (typeof CUSTOM_ROUTE_JUSTIFICATIONS)[number];

export const CUSTOM_ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type CustomRouteMethod = (typeof CUSTOM_ROUTE_METHODS)[number];

/**
 * A named custom route (issue #239) a module mounts into the flat `/api` namespace at startup,
 * through the `semprec-api` REST adapter (#238) — shared auth, validation, status mapping, and
 * serialization, with no private auth or error path of its own. `path` is matched exactly
 * (`:param`-style segments become path parameters); `handlerExport` names an export of this same
 * module file, resolved by the registry the same way every other manifest export is.
 */
export interface ModuleCustomRouteDescriptor {
  name: string;
  method: CustomRouteMethod;
  path: string;
  handlerExport: string;
  justification: CustomRouteJustification;
}

/** One end of a link rule: a property of a database. */
export interface ModuleLinkRuleEndpoint {
  databaseKey: string;
  propertyKey: string;
}

/**
 * Copies `source.propertyKey` of a source item to `target.propertyKey` of a target item along
 * the relation property `via.relationKey` of `via.databaseKey`. `via.databaseKey` is the
 * target's or the source's database and the relation leads to the other one. `key` is unique
 * across all modules.
 *
 * `valueFilter.omit` names a relation property of a singleton system database, such as System
 * settings `selfPerson`: the items that relation points to are left out of the copied values.
 * `omit.databaseKey` is that database's owner module id (`systemSettings`), because the System
 * settings database has no `databases.key` and no manifest declares it.
 */
export interface ModuleLinkRuleDescriptor {
  key: string;
  source: ModuleLinkRuleEndpoint;
  target: ModuleLinkRuleEndpoint;
  via: { databaseKey: string; relationKey: string };
  valueFilter?: { omit: ModuleLinkRuleEndpoint };
}

/**
 * The controls a card editor field may declare. The server owns the editor schema so that
 * required-ness and conditions can be enforced on confirm (#1928, #1934) with the same rules the
 * client renders (`docs/adr/2026-10-25-server-driven-inbox-editor-schema.md`).
 */
export const EDITOR_FIELD_CONTROLS = [
  "text",
  "area",
  "date",
  "datetime",
  "select",
  "multi",
  "toggle",
  "seg",
  "color",
  "secret",
  "info",
  "choice",
  "tile",
] as const;
export type EditorFieldControl = (typeof EDITOR_FIELD_CONTROLS)[number];

/** The `inputType` of a `text` editor control. */
export const EDITOR_FIELD_INPUT_TYPES = ["text", "email", "url", "tel"] as const;
export type EditorFieldInputType = (typeof EDITOR_FIELD_INPUT_TYPES)[number];

/** A static option value, a value a condition compares against, or an info parameter. */
export type EditorFieldValue = string | number | boolean;

/**
 * `{ field, equals }` or `{ field, notEquals }`: holds when the named field of the same card has
 * (or does not have) the value. `when` declares the condition under which a field applies, and
 * `timeHiddenWhen` the one under which only the time part of a `datetime` field is hidden. Nothing
 * evaluates either until #1928 and #1934.
 */
export type EditorFieldCondition =
  { field: string; equals: EditorFieldValue } | { field: string; notEquals: EditorFieldValue };

/**
 * One editor control of a card. `key` is a property key, a relation key, or a pseudo field key;
 * the manifest schema checks only that it is non-empty. `labelKey`, `placeholderKey` and `infoKey`
 * are catalog keys of the declaring module's own `i18n` catalogs. `options` lists the static values
 * of a `seg` control; `optionsSource` names the field whose options come from the options route.
 */
export interface EditorFieldDescriptor {
  key: string;
  control: EditorFieldControl;
  inputType?: EditorFieldInputType;
  labelKey: string;
  placeholderKey?: string;
  required?: boolean;
  when?: EditorFieldCondition;
  timeHiddenWhen?: EditorFieldCondition;
  optionsSource?: string;
  options?: string[];
  infoKey?: string;
  params?: Record<string, EditorFieldValue>;
}

export interface EditorGroupDescriptor {
  key: string;
  fields: EditorFieldDescriptor[];
}

export interface EditorSchemaDescriptor {
  groups: EditorGroupDescriptor[];
}

export interface ModuleManifest {
  id: string;
  version: string;
  name: string;
  removable: boolean;
  systemProject: boolean;
  databases: ModuleDatabaseDescriptor[];
  capabilities: string[];
  agentTools: ModuleAgentToolDescriptor[];
  viewTypes?: string[];
  heartbeatActions?: string[];
  heartbeatRuleKinds?: ModuleHeartbeatRuleKindDescriptor[];
  taskNames?: ModuleTaskDescriptor[];
  workers?: ModuleWorkerDescriptor[];
  migrations?: string[];
  dataMigrations?: ModuleDataMigrationDescriptor[];
  customRoutes?: ModuleCustomRouteDescriptor[];
  linkRules?: ModuleLinkRuleDescriptor[];
  /**
   * Editor schemas of the cards this module declares, keyed by base kind (the kind of thing the
   * card creates). Two loaded modules may not declare the same base kind.
   */
  editorSchemas?: Record<string, EditorSchemaDescriptor>;
}

const moduleTaskDescriptorSchema = z.object({
  name: z.string().min(1),
  payloadSchemaExport: z.string().min(1),
  handlerExport: z.string().min(1),
  queueAffinity: z.enum(MODULE_TASK_AFFINITIES),
});

const moduleWorkerDescriptorSchema = z.object({
  name: z.string().min(1),
  handlerExport: z.string().min(1),
});

const moduleHeartbeatRuleKindDescriptorSchema = z.object({
  kind: z.string().min(1),
  schemaExport: z.string().min(1),
  nextFireAtExport: z.string().min(1),
});

const moduleRelatedOrderSchema = z
  .object({
    order: z.array(z.string().min(1)),
    omit: z.array(z.string().min(1)).optional(),
  })
  .superRefine(({ order, omit }, ctx) => {
    const seen = new Set<string>();
    for (const [field, keys] of [
      ["order", order],
      ["omit", omit ?? []],
    ] as const) {
      keys.forEach((key, index) => {
        if (seen.has(key)) {
          ctx.addIssue({ code: "custom", message: `Duplicate related database key "${key}"`, path: [field, index] });
        }
        seen.add(key);
      });
    }
  });

/** Bounds the template's nesting and fan-out; the declared trees are at most three levels deep. */
const MAX_AREA_FILTER_DEPTH = 4;
const MAX_AREA_FILTER_NODES_PER_LEVEL = 8;

const areaFilterPropertyKey = z.string().min(1);
const areaFilterAreaValueSchema = z.strictObject({ areaValue: z.literal(true) });

/**
 * Strict at every level, so a misspelled field is rejected rather than ignored, and a
 * `relation_path_contains` path is exactly two non-empty property keys (the two-hop condition of #1363).
 */
function buildAreaFilterTemplateSchema(remainingDepth: number): z.ZodType<AreaFilterTemplate> {
  const relationContains = z.strictObject({
    type: z.literal("relation_contains"),
    property: areaFilterPropertyKey,
    value: areaFilterAreaValueSchema,
  });
  const relationPathContains = z.strictObject({
    type: z.literal("relation_path_contains"),
    path: z.tuple([areaFilterPropertyKey, areaFilterPropertyKey]),
    value: areaFilterAreaValueSchema,
  });
  const relationIsEmpty = z.strictObject({ type: z.literal("relation_is_empty"), property: areaFilterPropertyKey });
  if (remainingDepth <= 1) return z.union([relationContains, relationPathContains, relationIsEmpty]);
  const child = buildAreaFilterTemplateSchema(remainingDepth - 1);
  const nodes = z.array(child).min(1).max(MAX_AREA_FILTER_NODES_PER_LEVEL);
  return z.union([
    relationContains,
    relationPathContains,
    relationIsEmpty,
    z.strictObject({ type: z.literal("and"), nodes }),
    z.strictObject({ type: z.literal("or"), nodes }),
  ]);
}

function hasAreaValueSlot(node: AreaFilterTemplate): boolean {
  if (node.type === "and" || node.type === "or") return node.nodes.some(hasAreaValueSlot);
  return node.type !== "relation_is_empty";
}

/** A template that never takes the area id would filter every area the same way, so it is refused. */
const areaFilterTemplateSchema = buildAreaFilterTemplateSchema(MAX_AREA_FILTER_DEPTH).refine(hasAreaValueSlot, {
  message: "An area filter needs at least one { areaValue: true } slot",
});

/** The deepest nesting of objects and arrays an opaque filter may have; its root object is level 1. */
const MAX_OPAQUE_FILTER_DEPTH = 32;

/** The most values an opaque filter may hold: every object, array and scalar, the root included, per occurrence. */
const MAX_OPAQUE_FILTER_VALUES = 1024;

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * The values held by a JSON container, or `undefined` when `container` is not one: a plain object (prototype
 * `Object.prototype` or `null`) with only string-keyed, enumerable data properties, or an array with the
 * `Array` prototype, no holes and no property other than its indices and `length`. Property descriptors are
 * read, never the properties themselves, so no accessor runs. `budget` is the number of values the caller can
 * still accept; a container holding more is refused before any of its descriptors is read.
 */
function jsonContainerValues(container: object, budget: number): unknown[] | undefined {
  const keys = Reflect.ownKeys(container);
  if (Array.isArray(container)) {
    if (Object.getPrototypeOf(container) !== Array.prototype) return undefined;
    // Every index plus `length`: a hole or an extra property makes the counts differ.
    if (keys.length !== container.length + 1 || container.length > budget) return undefined;
    const values: unknown[] = [];
    for (let index = 0; index < container.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(container, String(index));
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
      values.push(descriptor.value);
    }
    return values;
  }
  if (!isPlainJsonObject(container) || keys.length > budget) return undefined;
  const values: unknown[] = [];
  for (const key of keys) {
    if (typeof key === "symbol") return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(container, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return undefined;
    values.push(descriptor.value);
  }
  return values;
}

/**
 * Whether `root` is a JSON object this package can hold as an opaque filter (issue #1647): a plain object
 * (`isPlainJsonObject`) holding only plain objects, arrays, strings, booleans, `null` and finite numbers
 * (`jsonContainerValues`). `undefined`, functions, symbols, bigints, non-finite numbers, class instances such
 * as a `Date`, and accessors are refused. A container reached again inside itself (a cycle) is refused; the
 * same acyclic value reached on two paths is accepted and counted on each. Nesting deeper than
 * `MAX_OPAQUE_FILTER_DEPTH` containers or holding more than `MAX_OPAQUE_FILTER_VALUES` values is refused. The
 * walk is iterative, so these bounds, not the call stack, are what stop it.
 */
function isOpaqueJsonObject(root: unknown): root is ModuleOpaqueFilter {
  if (!isPlainJsonObject(root)) return false;
  type Step = { enter: unknown; depth: number } | { leave: object };
  const steps: Step[] = [{ enter: root, depth: 1 }];
  // The containers on the path from the root to the value being visited.
  const ancestors = new Set<object>();
  // Values counted so far: each is counted when it is scheduled, so no container is expanded past the bound.
  let counted = 1;
  for (let step = steps.pop(); step !== undefined; step = steps.pop()) {
    if ("leave" in step) {
      ancestors.delete(step.leave);
      continue;
    }
    const value = step.enter;
    if (value === null || typeof value === "string" || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return false;
      continue;
    }
    if (typeof value !== "object") return false;
    if (step.depth > MAX_OPAQUE_FILTER_DEPTH || ancestors.has(value)) return false;
    const children = jsonContainerValues(value, MAX_OPAQUE_FILTER_VALUES - counted);
    if (children === undefined) return false;
    counted += children.length;
    ancestors.add(value);
    steps.push({ leave: value });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      steps.push({ enter: children[index], depth: step.depth + 1 });
    }
  }
  return true;
}

/** A bounded JSON object (`isOpaqueJsonObject`), never an array or a scalar; its grammar is the data package's to validate. */
const opaqueFilterSchema = z.custom<ModuleOpaqueFilter>(isOpaqueJsonObject, {
  message: `must be a JSON object of at most ${MAX_OPAQUE_FILTER_DEPTH} nested levels and ${MAX_OPAQUE_FILTER_VALUES} values`,
});

const moduleSortDescriptorSchema = z.strictObject({
  property: z.string().min(1),
  direction: z.enum(["asc", "desc"]),
});

const moduleQuickFilterDescriptorSchema = z.strictObject({
  key: z.string().min(1),
  labelKey: z.string().min(1),
  filter: opaqueFilterSchema.optional(),
  sort: z.array(moduleSortDescriptorSchema).optional(),
  isDefault: z.boolean().optional(),
});

const moduleDatabaseDescriptorSchema = z
  .object({
    key: z.string().min(1),
    name: z.string().min(1),
    defaultViewType: z.string().min(1).optional(),
    searchFields: z.array(z.string().min(1)).max(1000).optional(),
    relatedOrder: moduleRelatedOrderSchema.optional(),
    icon: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
      .optional(),
    color: z
      .string()
      .regex(/^#[0-9A-Fa-f]{6}$/)
      .optional(),
    overviewOrder: z.number().int().positive().nullable().optional(),
    switcherOrder: z.number().int().positive().nullable().optional(),
    clientVisible: z.boolean().optional(),
    areaFilter: areaFilterTemplateSchema.optional(),
    quickFilters: z.array(moduleQuickFilterDescriptorSchema).optional(),
    defaultSort: moduleSortDescriptorSchema.optional(),
    dateLabels: z.strictObject({ pastLabelKey: z.string().min(1), noDateLabelKey: z.string().min(1) }).optional(),
    collectionFilter: opaqueFilterSchema.optional(),
    pickerFilter: opaqueFilterSchema.optional(),
  })
  .superRefine((database, ctx) => {
    const quickFilters = database.quickFilters ?? [];
    const seen = new Set<string>();
    quickFilters.forEach((quickFilter, index) => {
      if (seen.has(quickFilter.key)) {
        ctx.addIssue({
          code: "custom",
          path: ["quickFilters", index, "key"],
          message: `Duplicate quick filter key '${quickFilter.key}'`,
        });
      }
      seen.add(quickFilter.key);
    });
    if (quickFilters.filter((quickFilter) => quickFilter.isDefault === true).length > 1) {
      ctx.addIssue({ code: "custom", path: ["quickFilters"], message: "At most one quick filter may be the default" });
    }
  });

const moduleDataMigrationDescriptorSchema = z.object({
  databaseKey: z.string().min(1),
  fromVersion: z.string().min(1),
  toVersion: z.string().min(1),
  converterExport: z.string().min(1),
});

const moduleAgentToolDescriptorSchema = z
  .object({
    name: z.string().min(1),
    handlerExport: z.string().min(1),
    argumentSchemaExport: z.string().min(1),
    capability: z.string().min(1).optional(),
    approval: z.enum(["none", "always", "unlessProjectPermitted"]),
    riskClass: z.enum(RISK_CLASSES).optional(),
    projectPermission: z.string().min(1).optional(),
  })
  .superRefine((tool, ctx) => {
    if (
      tool.approval === "none" &&
      tool.riskClass !== undefined &&
      tool.riskClass !== "read" &&
      tool.riskClass !== "write"
    )
      ctx.addIssue({ code: "custom", message: "Unsafe risk class cannot use approval none", path: ["riskClass"] });
    if (tool.approval === "unlessProjectPermitted" && !tool.projectPermission)
      ctx.addIssue({ code: "custom", message: "Project permission is required", path: ["projectPermission"] });
  });

/** `path` must live under the flat `/api` namespace the issue's Task requires every custom route to mount into. */
const moduleCustomRouteDescriptorSchema = z.object({
  name: z.string().min(1),
  method: z.enum(CUSTOM_ROUTE_METHODS),
  path: z.string().regex(/^\/api\/\S*$/, 'must be a path starting with "/api/"'),
  handlerExport: z.string().min(1),
  justification: z.enum(CUSTOM_ROUTE_JUSTIFICATIONS),
});

const moduleLinkRuleEndpointSchema = z.strictObject({
  databaseKey: z.string().min(1),
  propertyKey: z.string().min(1),
});

const moduleLinkRuleDescriptorSchema = z.strictObject({
  key: z.string().min(1),
  source: moduleLinkRuleEndpointSchema,
  target: moduleLinkRuleEndpointSchema,
  via: z.strictObject({ databaseKey: z.string().min(1), relationKey: z.string().min(1) }),
  valueFilter: z.strictObject({ omit: moduleLinkRuleEndpointSchema }).optional(),
});

export const editorFieldValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const editorConditionSchema = z.union([
  z.strictObject({ field: z.string().min(1), equals: editorFieldValueSchema }),
  z.strictObject({ field: z.string().min(1), notEquals: editorFieldValueSchema }),
]);

/**
 * An attribute that applies to one control only (`timeHiddenWhen` on `datetime`, `inputType` on
 * `text`, `options` on `seg`), and the `infoKey` every `info` row needs, are checked here, so a
 * declaration that pairs an attribute with a control it does not apply to, or an `info` row without
 * `infoKey`, fails at load time.
 */
export const editorFieldDescriptorSchema = z
  .strictObject({
    key: z.string().min(1),
    control: z.enum(EDITOR_FIELD_CONTROLS),
    inputType: z.enum(EDITOR_FIELD_INPUT_TYPES).optional(),
    labelKey: z.string().min(1),
    placeholderKey: z.string().min(1).optional(),
    required: z.boolean().optional(),
    when: editorConditionSchema.optional(),
    timeHiddenWhen: editorConditionSchema.optional(),
    optionsSource: z.string().min(1).optional(),
    options: z.array(z.string().min(1)).min(1).optional(),
    infoKey: z.string().min(1).optional(),
    params: z.record(z.string().min(1), editorFieldValueSchema).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.timeHiddenWhen !== undefined && field.control !== "datetime") {
      ctx.addIssue({
        code: "custom",
        path: ["timeHiddenWhen"],
        message: 'timeHiddenWhen is only valid on a "datetime" control',
      });
    }
    if (field.inputType !== undefined && field.control !== "text") {
      ctx.addIssue({ code: "custom", path: ["inputType"], message: 'inputType is only valid on a "text" control' });
    }
    if (field.options !== undefined && field.control !== "seg") {
      ctx.addIssue({ code: "custom", path: ["options"], message: 'options is only valid on a "seg" control' });
    }
    if (field.control === "info" && field.infoKey === undefined) {
      ctx.addIssue({ code: "custom", path: ["infoKey"], message: 'an "info" control requires infoKey' });
    }
  });

export const editorGroupDescriptorSchema = z.strictObject({
  key: z.string().min(1),
  fields: z.array(editorFieldDescriptorSchema).min(1),
});

export const editorSchemaDescriptorSchema = z.strictObject({
  groups: z.array(editorGroupDescriptorSchema),
});

export const moduleManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  removable: z.boolean(),
  systemProject: z.boolean(),
  databases: z.array(moduleDatabaseDescriptorSchema),
  capabilities: z.array(z.string().min(1)),
  agentTools: z.array(moduleAgentToolDescriptorSchema),
  viewTypes: z.array(z.string().min(1)).optional(),
  heartbeatActions: z.array(z.string().min(1)).optional(),
  heartbeatRuleKinds: z.array(moduleHeartbeatRuleKindDescriptorSchema).optional(),
  taskNames: z.array(moduleTaskDescriptorSchema).optional(),
  workers: z.array(moduleWorkerDescriptorSchema).optional(),
  migrations: z.array(z.string().min(1)).optional(),
  dataMigrations: z.array(moduleDataMigrationDescriptorSchema).optional(),
  customRoutes: z.array(moduleCustomRouteDescriptorSchema).optional(),
  linkRules: z.array(moduleLinkRuleDescriptorSchema).optional(),
  editorSchemas: z.record(z.string().min(1), editorSchemaDescriptorSchema).optional(),
});
