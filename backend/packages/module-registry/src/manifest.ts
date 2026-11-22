import { z } from "zod";
import { RISK_CLASSES, type RiskClass } from "@semprec/shared";

/**
 * The runtime a module task runs under: `'agents'` only for a handler that starts or continues an
 * agent session. Mirrors `@semprec/queue`'s `TaskAffinity`, kept local to avoid that dependency.
 */
export const MODULE_TASK_AFFINITIES = ["api", "agents", "transcribe"] as const;
export type ModuleTaskAffinity = (typeof MODULE_TASK_AFFINITIES)[number];

/** A queued unit of work a module contributes; `queueAffinity` names the runtime that may run it. */
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
 * Lets a module add its own heartbeat trigger kind without patching core's `heartbeatRuleSchema`:
 * `schemaExport` validates a rule of this kind, `nextFireAtExport` computes its next occurrence.
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
 * How one database's items are filtered by an area, declared as data: a filter-tree template with
 * `{ areaValue: true }` wherever the area id goes. A client substitutes the id and sends the tree as
 * an ordinary filter; `expandAreaFilter` in `@semprec/data` does the same on the server.
 */
export type AreaFilterTemplate =
  | { type: "relation_contains"; property: string; value: AreaFilterAreaValue }
  | { type: "relation_path_contains"; path: [string, string]; value: AreaFilterAreaValue }
  | { type: "relation_is_empty"; property: string }
  | { type: "and"; nodes: AreaFilterTemplate[] }
  | { type: "or"; nodes: AreaFilterTemplate[] };

/** `defaultViewType` names the view type of the database's default view (e.g. Journal's `temporal-switcher`); absent means `"table"`. */
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
  /** Lets the user hide this database from the client overview; only `true` has an effect. */
  overviewHideable?: boolean;
  /** How this database's items are filtered by an area; absent means the database is not area-filterable. */
  areaFilter?: AreaFilterTemplate;
  /** The collection screen's quick-filter chips, in display order; absent means none. */
  quickFilters?: ModuleQuickFilterDescriptor[];
  /** The order a collection opens with when no chip sorts it. */
  defaultSort?: ModuleSortDescriptor;
  /** Catalog keys of the labels a date-grouped collection shows for past and undated items. */
  dateLabels?: { pastLabelKey: string; noDateLabelKey: string };
  /** The items that belong in the collection; an opaque filter tree the data package parses. */
  collectionFilter?: ModuleOpaqueFilter;
  /** The items a picker for this database offers by default; an opaque filter tree. */
  pickerFilter?: ModuleOpaqueFilter;
}

/**
 * A filter tree declared by a manifest. Its grammar belongs to the data package, so this package
 * only requires a bounded JSON object (`isOpaqueJsonObject`) and never interprets it.
 */
export type ModuleOpaqueFilter = Record<string, unknown>;

/** One sort key of a quick filter or default sort: a property of the database, ascending or descending. */
export interface ModuleSortDescriptor {
  property: string;
  direction: "asc" | "desc";
}

/**
 * One quick-filter chip. `labelKey` is a catalog key of the owning module; no `filter` shows every
 * item, no `sort` keeps the database's order. At most one chip per database is `isDefault`; keys
 * are unique within the database.
 */
export interface ModuleQuickFilterDescriptor {
  key: string;
  labelKey: string;
  filter?: ModuleOpaqueFilter;
  sort?: ModuleSortDescriptor[];
  isDefault?: boolean;
}

/** An ungranted `capability` (see `ModuleRegistry.getAgentTools`) makes the tool absent from a projection, never present-but-denied. */
export interface ModuleAgentToolDescriptor {
  name: string;
  handlerExport: string;
  argumentSchemaExport: string;
  capability?: string;
  approval: "none" | "always" | "unlessProjectPermitted";
  riskClass?: RiskClass;
  projectPermission?: string;
  /**
   * When `true`, an agent session that calls the tool does not run it: the call creates an approval
   * request of kind `moduleTool` and the handler runs only after a person approves that request
   * (`handleApprovalRequestExecuteTask`). A tool that sets it is offered only to a caller that asks
   * for approval-gated tools (`ModuleRegistry.getAgentToolDefinitions`), whatever its `approval` is.
   */
  requiresApproval?: boolean;
  /**
   * Names an export of the module file with the shape of `handlerExport`: `(pool, ruleKinds)` returns
   * `(runId, args)`, which resolves to a JSON-serialisable snapshot of the source the call would
   * change. Its canonical JSON is hashed when the approval request is created and again before the
   * handler runs; a different hash is a conflict and the handler does not run. Allowed only together
   * with `requiresApproval: true`. A gated tool without it is never checked for a changed source.
   */
  snapshotExport?: string;
  /**
   * Offers the tool on `POST /mcp` although its capability is a module's own rather than a core
   * one; without it, only tools with no or a core capability are offered there, and only to a run
   * credential. With it, the tool is offered to a run credential whose project holds the capability
   * and whose own list names it, and to a human session whenever its module is active.
   * `humanHandlerExport` is a factory `(pool, dependencies)` returning `(userId, args)`, the handler
   * a human session runs, with `handlerExport`'s result shape; `dependencies` is the container given
   * to custom routes. Allowed only for a capability tool that is `approval: "none"` without
   * `requiresApproval`, or that has `requiresApproval`: then a run credential's call files a
   * `moduleTool` approval request while a human session runs the human handler directly.
   */
  mcp?: { humanHandlerExport: string };
}

/**
 * The only two reasons a custom route may exist outside the generic REST surface:
 * `transactional-semantics` (a transactional shape a generic item write/read cannot express) and
 * `single-consumer-read` (a read shortcut for exactly one consumer). Never CRUD over module data.
 */
export const CUSTOM_ROUTE_JUSTIFICATIONS = ["transactional-semantics", "single-consumer-read"] as const;
export type CustomRouteJustification = (typeof CUSTOM_ROUTE_JUSTIFICATIONS)[number];

export const CUSTOM_ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type CustomRouteMethod = (typeof CUSTOM_ROUTE_METHODS)[number];

/**
 * A custom route a module mounts into the flat `/api` namespace through the `semprec-api` REST
 * adapter (shared auth, validation, status mapping and serialization). `path` is matched exactly,
 * with `:param` segments as path parameters; `handlerExport` names an export of the module file.
 */
export interface ModuleCustomRouteDescriptor {
  name: string;
  method: CustomRouteMethod;
  path: string;
  handlerExport: string;
  justification: CustomRouteJustification;
  /** The largest request body the route reads, in bytes; the adapter's 1 MiB without it. */
  maxBodyBytes?: number;
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
 * A link rule whose value is computed by a module resolver instead of copied along a relation: the
 * target property of an item takes what the resolver returns for that item. `resolverExport` names an
 * object export of this same module file; its shape belongs to the code that runs the rule (the registry
 * only checks that the export is an object), so the manifest stays data. `key` is unique across all
 * modules, and `target` names the property the resolver's value is written to.
 */
export interface ModuleResolverLinkRuleDescriptor {
  key: string;
  target: ModuleLinkRuleEndpoint;
  resolverExport: string;
}

/**
 * The controls a card editor field may declare. The server owns the editor schema so required-ness
 * and conditions are enforced on confirm with the rules the client renders
 * (docs/architecture/domain-mail-and-inbox.md#editor-schemas).
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
 * `{ field, equals }` or `{ field, notEquals }` over another field of the same card. `when` gates
 * whether a field applies; `timeHiddenWhen` hides only the time part of a `datetime` field.
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
  customRoutes?: ModuleCustomRouteDescriptor[];
  linkRules?: Array<ModuleLinkRuleDescriptor | ModuleResolverLinkRuleDescriptor>;
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

/** Strict at every level, so a misspelled field is rejected; a `relation_path_contains` path is exactly two keys. */
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
 * The values of a JSON container, or `undefined` when `container` is not one: a plain object with
 * only string-keyed enumerable data properties, or a hole-free array with no extra properties.
 * Only descriptors are read, so no accessor runs. A container holding more than `budget` values is
 * refused before its descriptors are read.
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
 * Whether `root` is a plain JSON object holding only plain objects, arrays, strings, booleans,
 * `null` and finite numbers. Cycles are refused (a shared acyclic value is counted per path), as
 * is anything beyond `MAX_OPAQUE_FILTER_DEPTH` or `MAX_OPAQUE_FILTER_VALUES`. Iterative, so these
 * bounds rather than the stack stop the walk.
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
    overviewHideable: z.boolean().optional(),
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

const moduleAgentToolDescriptorSchema = z
  .object({
    name: z.string().min(1),
    handlerExport: z.string().min(1),
    argumentSchemaExport: z.string().min(1),
    capability: z.string().min(1).optional(),
    approval: z.enum(["none", "always", "unlessProjectPermitted"]),
    riskClass: z.enum(RISK_CLASSES).optional(),
    projectPermission: z.string().min(1).optional(),
    requiresApproval: z.boolean().optional(),
    snapshotExport: z.string().min(1).optional(),
    mcp: z.strictObject({ humanHandlerExport: z.string().min(1) }).optional(),
  })
  .superRefine((tool, ctx) => {
    if (tool.mcp !== undefined && tool.capability === undefined)
      ctx.addIssue({ code: "custom", message: "MCP exposure requires a capability", path: ["mcp"] });
    if (tool.mcp !== undefined && tool.requiresApproval !== true && tool.approval !== "none")
      ctx.addIssue({
        code: "custom",
        message: "MCP exposure requires approval none or requiresApproval",
        path: ["mcp"],
      });
    if (tool.snapshotExport !== undefined && tool.requiresApproval !== true)
      ctx.addIssue({
        code: "custom",
        message: "A snapshot export requires requiresApproval",
        path: ["snapshotExport"],
      });
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

/** `path` must live under the flat `/api` namespace. */
const moduleCustomRouteDescriptorSchema = z.object({
  name: z.string().min(1),
  method: z.enum(CUSTOM_ROUTE_METHODS),
  path: z.string().regex(/^\/api\/\S*$/, 'must be a path starting with "/api/"'),
  handlerExport: z.string().min(1),
  justification: z.enum(CUSTOM_ROUTE_JUSTIFICATIONS),
  maxBodyBytes: z.number().int().positive().optional(),
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

const moduleResolverLinkRuleDescriptorSchema = z.strictObject({
  key: z.string().min(1),
  target: moduleLinkRuleEndpointSchema,
  resolverExport: z.string().min(1),
});

export const editorFieldValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const editorConditionSchema = z.union([
  z.strictObject({ field: z.string().min(1), equals: editorFieldValueSchema }),
  z.strictObject({ field: z.string().min(1), notEquals: editorFieldValueSchema }),
]);

/**
 * Control-specific attributes (`timeHiddenWhen` on `datetime`, `inputType` on `text`, `options` on
 * `seg`) and the `infoKey` every `info` row needs are checked here, so a mismatch fails at load.
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
  customRoutes: z.array(moduleCustomRouteDescriptorSchema).optional(),
  linkRules: z.array(z.union([moduleLinkRuleDescriptorSchema, moduleResolverLinkRuleDescriptorSchema])).optional(),
  editorSchemas: z.record(z.string().min(1), editorSchemaDescriptorSchema).optional(),
});
