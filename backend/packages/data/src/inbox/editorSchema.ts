import {
  resolveCatalogLabel,
  type ModuleCatalogs,
  type ModuleRegistry,
  type EditorFieldCondition,
  type EditorFieldControl,
  type EditorFieldDescriptor,
  type EditorFieldInputType,
} from "@semprec/module-registry";
import { toManifestLocale } from "../manifest/catalogResolution.js";

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
