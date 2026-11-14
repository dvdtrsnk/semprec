import {
  resolveCatalogLabel,
  type ModuleCatalogs,
  type ModuleRegistry,
  type EditorFieldCondition,
  type EditorFieldControl,
  type EditorFieldDescriptor,
  type EditorFieldInputType,
} from "@semprec/module-registry";
import { dateWithoutTimeOfDay } from "../calendar/eventTime.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { fieldOverridesOf, type UserOverrides } from "./proposalOverrides.js";
import { selectActiveSteps } from "./proposalStepGraph.js";

/** What `resolveEditorSchema` reads from the module registry: the declarations and the catalogs of the declaring module. */
export type EditorSchemaRegistry = Pick<ModuleRegistry, "getEditorSchemas" | "getCatalogs">;

/**
 * One control of a card editor as the card list returns it (issue #1825): the declaration with its
 * catalog keys resolved to text for the caller. Attributes the declaration does not set are absent.
 * `options` are the static values of a `seg` control as declared; they are not translated.
 */
export interface ResolvedEditorField {
  key: string;
  control: EditorFieldControl;
  inputType?: EditorFieldInputType;
  label: string;
  placeholder?: string;
  required?: boolean;
  when?: EditorFieldCondition;
  timeHiddenWhen?: EditorFieldCondition;
  optionsSource?: string;
  options?: string[];
  /** The rendered sentence of a read-only `info` row. */
  info?: string;
}

export interface ResolvedEditorGroup {
  key: string;
  fields: ResolvedEditorField[];
}

export interface ResolvedEditorSchema {
  baseKind: string;
  groups: ResolvedEditorGroup[];
}

/** `{name}` placeholders of an info sentence are filled with the declared parameter through a replacer function, so `$` in a value stays literal. */
function renderInfo(template: string, params: EditorFieldDescriptor["params"]): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, name: string) => {
    const value = params !== undefined && Object.hasOwn(params, name) ? params[name] : undefined;
    return value === undefined ? placeholder : String(value);
  });
}

function resolveField(field: EditorFieldDescriptor, catalog: (key: string) => string): ResolvedEditorField {
  return {
    key: field.key,
    control: field.control,
    ...(field.inputType === undefined ? {} : { inputType: field.inputType }),
    label: catalog(field.labelKey),
    ...(field.placeholderKey === undefined ? {} : { placeholder: catalog(field.placeholderKey) }),
    ...(field.required === undefined ? {} : { required: field.required }),
    ...(field.when === undefined ? {} : { when: field.when }),
    ...(field.timeHiddenWhen === undefined ? {} : { timeHiddenWhen: field.timeHiddenWhen }),
    ...(field.optionsSource === undefined ? {} : { optionsSource: field.optionsSource }),
    ...(field.options === undefined ? {} : { options: field.options }),
    ...(field.infoKey === undefined ? {} : { info: renderInfo(catalog(field.infoKey), field.params) }),
  };
}

const NO_CATALOGS: ModuleCatalogs = { cs: {}, en: {} };

/**
 * The editor schema of cards of `baseKind`, localized for `locale` (the caller's `users.locale`; any locale
 * but `cs` reads the English catalog), or `null` when no active module declares one. Labels, placeholders
 * and info sentences come from the catalogs of the module that declares the schema, through
 * `resolveCatalogLabel`: the requested locale, then English, then the catalog key itself. The registry hands out
 * a deep copy of each declaration, so nothing in the result is shared with the declaration it holds.
 */
export async function resolveEditorSchema(
  registry: EditorSchemaRegistry,
  baseKind: string,
  locale: string,
): Promise<ResolvedEditorSchema | null> {
  const declaration = (await registry.getEditorSchemas()).find((candidate) => candidate.baseKind === baseKind);
  if (!declaration) return null;
  const catalogs = (await registry.getCatalogs(declaration.moduleId)) ?? NO_CATALOGS;
  const catalog = (key: string): string =>
    resolveCatalogLabel(null, catalogs[toManifestLocale(locale)], catalogs.en, key);
  return {
    baseKind,
    groups: declaration.schema.groups.map((group) => ({
      key: group.key,
      fields: group.fields.map((field) => resolveField(field, catalog)),
    })),
  };
}

/**
 * The values of one step of a card: its `properties` overlaid with the pseudo field values the user set. A
 * single-step card has the one step `primary`; a multi-step card lists its active steps, the primary one first.
 */
export interface EditorStepValues {
  ref: string;
  /**
   * Set on the one synthetic step of an envelope that has no `operations`: its `primary` ref is not a step the
   * client addresses, so a missing field is reported without a `ref`. A step of an envelope with `operations` never
   * has it, even when it is the only active one, because its real ref is what a `set` must name.
   */
  synthetic?: true;
  values: Readonly<Record<string, unknown>>;
}

/** The part of a field the rules read. Both the declaration and the resolved field have it. */
export interface EditorRuleField {
  key: string;
  required?: boolean;
  when?: EditorFieldCondition;
  timeHiddenWhen?: EditorFieldCondition;
}

/** The part of a schema the rules read: the declaration of a module and the localized schema a card carries both fit. */
export interface EditorRuleSchema {
  groups: ReadonlyArray<{ fields: ReadonlyArray<EditorRuleField> }>;
}

/** A visible required field that has no value, with the ref of the step it is reported on when the card has several. */
export interface MissingRequiredField {
  ref?: string;
  field: string;
}

/** The value of the field `key`: the first step that has the key wins, so the primary step's value is the card's. */
function valueOfField(values: readonly EditorStepValues[], key: string): unknown {
  return values.find((step) => Object.hasOwn(step.values, key))?.values[key];
}

/** A value counts as empty when it is `undefined`, `null`, an empty or whitespace-only string, or an empty array. */
function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  return Array.isArray(value) && value.length === 0;
}

/** Whether the field a condition names (of any step) has, or for `notEquals` does not have, the declared value. A field with no value at all is not equal to anything. */
function conditionHolds(condition: EditorFieldCondition, values: readonly EditorStepValues[]): boolean {
  const actual = valueOfField(values, condition.field);
  return "equals" in condition ? actual === condition.equals : actual !== condition.notEquals;
}

/**
 * Whether a field applies to the card, given the card's values: always without a `when`, else whether its
 * condition holds (`conditionHolds`). `timeHiddenWhen` hides only the time part of a field and is not read here.
 */
export function isFieldVisible(field: Pick<EditorRuleField, "when">, values: readonly EditorStepValues[]): boolean {
  return field.when === undefined || conditionHolds(field.when, values);
}

/**
 * The visible required fields of `schema` that have no value, in schema order. A hidden field is not required. A
 * missing field of a card with more than one step is reported on its first (primary) step, because a schema field
 * does not name a step; a single-step card reports no `ref`.
 */
export function findMissingRequired(
  schema: EditorRuleSchema,
  values: readonly EditorStepValues[],
): MissingRequiredField[] {
  const [first] = values;
  const ref = first?.synthetic ? undefined : first?.ref;
  return schema.groups
    .flatMap((group) => group.fields)
    .filter((field) => field.required === true && isFieldVisible(field, values))
    .filter((field) => isEmptyValue(valueOfField(values, field.key)))
    .map((field) => (ref === undefined ? { field: field.key } : { ref, field: field.key }));
}

/** The keys of the fields of `schema` that are visible for `values`, in schema order. */
export function visibleKeys(schema: EditorRuleSchema, values: readonly EditorStepValues[]): string[] {
  return schema.groups
    .flatMap((group) => group.fields)
    .filter((field) => isFieldVisible(field, values))
    .map((field) => field.key);
}

/** The required-field warning `PATCH /api/proposals/:id/values` returns for a field the saved card still lacks. */
export interface ProposalWarning extends MissingRequiredField {
  code: "required";
}

/**
 * The values the schema's rules are evaluated against (issue #1928): each active step's properties overlaid with
 * the user's field values for its ref (not its relation lists or step switch), primary step first, so a pseudo
 * value set by the user is seen. A single-step
 * envelope is the one step `primary`. A `pageContent` envelope also answers `page` and `day` with its target, the
 * page the card writes to, because nothing else holds them. A disabled step, or an optional one that nothing active
 * refers to, has no values, so its fields are not read.
 */
export function buildEditorValues(envelope: ProposalEnvelope, userOverrides: UserOverrides): EditorStepValues[] {
  if (!envelope.operations) {
    const target = envelope.entityKind === "pageContent" ? { page: envelope.target, day: envelope.target } : {};
    return [
      {
        ref: "primary",
        synthetic: true,
        values: { ...target, ...envelope.properties, ...fieldOverridesOf(userOverrides, "primary") },
      },
    ];
  }
  const active = selectActiveSteps(envelope.operations);
  return [...active.filter((step) => step.role === "primary"), ...active.filter((step) => step.role !== "primary")].map(
    (step) => ({
      ref: step.ref,
      values: { ...step.properties, ...step.after?.properties, ...fieldOverridesOf(userOverrides, step.ref) },
    }),
  );
}

/** The required fields the card still lacks, as the warnings of a values edit. */
export function toProposalWarnings(schema: EditorRuleSchema, values: readonly EditorStepValues[]): ProposalWarning[] {
  return findMissingRequired(schema, values).map((missing) => ({ ...missing, code: "required" }));
}

/** The properties of the card's destination that a time part maps to (`datetime` fields with `timeHiddenWhen`). */
const TIME_PART_KEYS = ["timeFrom", "timeTo"] as const;

/**
 * What the editor shows is what confirm writes (issue #1934): the envelope properties without the ones the schema
 * hides for the card's effective values. A property is dropped when a field with that key is hidden by its `when`
 * (`isFieldVisible`) and the destination has a property of that key (`targetProperties`); a key the destination
 * does not have is a pseudo field, which never reaches an item. A `datetime` field whose `timeHiddenWhen` holds
 * hides its time part, which is the destination's `timeFrom` and `timeTo`: they are dropped too, or, for a
 * destination whose empty time is an explicit null (`hiddenTimeIsNull`, the Events), set to null whether or not
 * the envelope carried them. A destination without those two properties is left as it is.
 *
 * The time part is also the time of day inside the field's own value: a string with one (`2026-12-01T10:00`, or
 * with an offset) is reduced to its calendar date, because the Events write transform would otherwise read the time
 * out of it and store it again as `timeFrom` and `timeTo`. An instant is read in `zone`, the tenant time zone, and
 * is a `ValidationError` on the field without one; a value that is not a readable date is left as it is. The
 * envelope is not changed; nothing is added for a field the envelope does not carry, apart from that null.
 */
export function normalizeHiddenFields(
  schema: EditorRuleSchema,
  effectiveValues: readonly EditorStepValues[],
  envelopeProperties: Readonly<Record<string, unknown>>,
  targetProperties: ReadonlySet<string>,
  hiddenTimeIsNull: boolean,
  zone?: string,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...envelopeProperties };
  for (const field of schema.groups.flatMap((group) => group.fields)) {
    if (!isFieldVisible(field, effectiveValues) && targetProperties.has(field.key)) delete normalized[field.key];
    if (field.timeHiddenWhen === undefined || !conditionHolds(field.timeHiddenWhen, effectiveValues)) continue;
    const value = normalized[field.key];
    if (typeof value === "string" && targetProperties.has(field.key)) {
      normalized[field.key] = dateWithoutTimeOfDay(value, zone, field.key) ?? value;
    }
    for (const key of TIME_PART_KEYS) {
      if (!targetProperties.has(key)) continue;
      if (hiddenTimeIsNull) normalized[key] = null;
      else delete normalized[key];
    }
  }
  return normalized;
}
