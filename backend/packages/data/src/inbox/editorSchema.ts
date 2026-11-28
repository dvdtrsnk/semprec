import {
  resolveCatalogLabel,
  type ModuleCatalogs,
  type ModuleRegistry,
  type EditorFieldCondition,
  type EditorFieldControl,
  type EditorFieldDescriptor,
  type EditorFieldInputType,
} from "@alldots/module-registry";
import { dateWithoutTimeOfDay } from "../calendar/eventTime.js";
import { toManifestLocale } from "../manifest/catalogResolution.js";
import type { ProposalEnvelope } from "./proposalEnvelope.js";
import { fieldOverridesOf, type UserOverrides } from "./proposalOverrides.js";
import { selectActiveSteps } from "./proposalStepGraph.js";

export type EditorSchemaRegistry = Pick<ModuleRegistry, "getEditorSchemas" | "getCatalogs">;

/** Catalog keys resolved to text; `seg` `options` are passed through untranslated. */
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

/** Uses a replacer function so `$` in a value stays literal. */
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
 * `null` when no active module declares a schema. Any locale but `cs` reads English; labels fall back to English, then
 * to the catalog key. The registry returns a deep copy, so nothing in the result is shared with the declaration.
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

/** A step's `properties` overlaid with the user's pseudo field values; the primary step comes first. */
export interface EditorStepValues {
  ref: string;
  /**
   * Set only on the single synthetic `primary` step of an envelope without `operations`, so a missing field is
   * reported without a `ref`. A real step never has it, because a `set` must name its ref.
   */
  synthetic?: true;
  values: Readonly<Record<string, unknown>>;
}

export interface EditorRuleField {
  key: string;
  required?: boolean;
  when?: EditorFieldCondition;
  timeHiddenWhen?: EditorFieldCondition;
}

export interface EditorRuleSchema {
  groups: ReadonlyArray<{ fields: ReadonlyArray<EditorRuleField> }>;
}

export interface MissingRequiredField {
  ref?: string;
  field: string;
}

/** The first step with the key wins, so the primary step's value is the card's. */
function valueOfField(values: readonly EditorStepValues[], key: string): unknown {
  return values.find((step) => Object.hasOwn(step.values, key))?.values[key];
}

function isEmptyValue(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  return Array.isArray(value) && value.length === 0;
}

/** A field with no value is not equal to anything. */
function conditionHolds(condition: EditorFieldCondition, values: readonly EditorStepValues[]): boolean {
  const actual = valueOfField(values, condition.field);
  return "equals" in condition ? actual === condition.equals : actual !== condition.notEquals;
}

/** `timeHiddenWhen` hides only the time part and is not read here. */
export function isFieldVisible(field: Pick<EditorRuleField, "when">, values: readonly EditorStepValues[]): boolean {
  return field.when === undefined || conditionHolds(field.when, values);
}

/**
 * Hidden fields are not required. On a multi-step card a missing field is reported on the primary step, because a
 * schema field does not name a step.
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

export function visibleKeys(schema: EditorRuleSchema, values: readonly EditorStepValues[]): string[] {
  return schema.groups
    .flatMap((group) => group.fields)
    .filter((field) => isFieldVisible(field, values))
    .map((field) => field.key);
}

export interface ProposalWarning extends MissingRequiredField {
  code: "required";
}

/**
 * Overlays only field values, not relation lists or step switches. A `pageContent` envelope also answers `page` and
 * `day` with its target, because nothing else holds them. Disabled steps, and optional steps nothing active refers to,
 * contribute no values.
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

export function toProposalWarnings(schema: EditorRuleSchema, values: readonly EditorStepValues[]): ProposalWarning[] {
  return findMissingRequired(schema, values).map((missing) => ({ ...missing, code: "required" }));
}

const TIME_PART_KEYS = ["timeFrom", "timeTo"] as const;

/**
 * What the editor shows is what confirm writes: properties of fields hidden by `when` are dropped when the destination
 * has that property (other keys are pseudo fields that never reach an item). A `datetime` whose `timeHiddenWhen` holds
 * also drops `timeFrom`/`timeTo`, or sets them to null for a `hiddenTimeIsNull` destination (Events).
 *
 * The field's own value is reduced to its calendar date too, because the Events write transform would otherwise read
 * the time back out of it. An instant is read in `zone` and is a `ValidationError` without one; an unreadable date is
 * left as is. The envelope is not mutated.
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
