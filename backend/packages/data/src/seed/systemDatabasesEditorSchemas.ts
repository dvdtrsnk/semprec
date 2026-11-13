import type {
  EditorFieldControl,
  EditorFieldDescriptor,
  EditorGroupDescriptor,
  EditorSchemaDescriptor,
} from "@semprec/module-registry";

/**
 * The Inbox card editor schemas of the system databases (issue #1825), keyed by the base kind of the card
 * (`docs/adr/2026-10-25-server-driven-inbox-editor-schema.md`). The `systemDatabases` manifest carries them
 * as its `editorSchemas`, and their label and placeholder keys are in `seed/i18n/cs.json` and `en.json`.
 *
 * A field `key` is a property key of the owning database where one exists. Where none does, it is a pseudo
 * field: `allDay`, `followupTask`, `followDate`, `day`, `page`, `placement` and `heading` come from the ADR's
 * list of pseudo keys, and `area` (the area choice of the task card, which Tasks has no property for) and
 * `markdown` (the page content of a `pageContent` envelope, on the two page cards) are appended to that list by
 * `docs/adr/2026-11-12-inbox-editor-schema-pseudo-keys-area-and-markdown.md`. Nothing evaluates `required`,
 * `when` or `timeHiddenWhen` before issues #1928 and #1934.
 */

const labelKeyOf = (baseKind: string, key: string): string => `editor.${baseKind}.${key}.label`;
const placeholderKeyOf = (baseKind: string, key: string): string => `editor.${baseKind}.${key}.placeholder`;

type FieldExtras = Omit<EditorFieldDescriptor, "key" | "control" | "labelKey" | "placeholderKey"> & {
  /** Declares the catalog entry `editor.<baseKind>.<key>.placeholder`. */
  placeholder?: true;
};

function field(
  baseKind: string,
  key: string,
  control: EditorFieldControl,
  extras: FieldExtras = {},
): EditorFieldDescriptor {
  const { placeholder, ...rest } = extras;
  return {
    key,
    control,
    labelKey: labelKeyOf(baseKind, key),
    ...(placeholder ? { placeholderKey: placeholderKeyOf(baseKind, key) } : {}),
    ...rest,
  };
}

function schema(...groups: EditorGroupDescriptor[]): EditorSchemaDescriptor {
  return { groups };
}

const ALL_DAY_HIDES_TIME = { field: "allDay", equals: true } as const;
const FOLLOWUP_IS_ON = { field: "followupTask", equals: true } as const;

/** The follow-up step switch and its date, shown on the cards whose proposal may carry a follow-up task. */
function followupGroup(baseKind: string): EditorGroupDescriptor {
  return {
    key: "followup",
    fields: [
      field(baseKind, "followupTask", "toggle"),
      field(baseKind, "followDate", "date", { required: true, when: FOLLOWUP_IS_ON }),
    ],
  };
}

export const SYSTEM_DATABASES_EDITOR_SCHEMAS: Record<string, EditorSchemaDescriptor> = {
  task: schema(
    {
      key: "main",
      fields: [
        field("task", "name", "text", { required: true, placeholder: true }),
        field("task", "date", "datetime", { timeHiddenWhen: ALL_DAY_HIDES_TIME }),
        field("task", "allDay", "toggle"),
        field("task", "status", "select"),
      ],
    },
    {
      key: "links",
      fields: [
        field("task", "project", "select", { optionsSource: "project" }),
        field("task", "area", "select", { optionsSource: "area" }),
      ],
    },
    followupGroup("task"),
  ),
  event: schema({
    key: "main",
    fields: [
      field("event", "name", "text", { required: true, placeholder: true }),
      field("event", "date", "datetime", { timeHiddenWhen: ALL_DAY_HIDES_TIME }),
      field("event", "allDay", "toggle"),
      field("event", "type", "seg"),
    ],
  }),
  project: schema({
    key: "main",
    fields: [
      field("project", "name", "text", { required: true, placeholder: true }),
      field("project", "status", "seg"),
      field("project", "date", "date", { when: { field: "status", notEquals: "longTerm" } }),
      field("project", "color", "color"),
    ],
  }),
  area: schema({
    key: "main",
    fields: [field("area", "name", "text", { required: true, placeholder: true }), field("area", "color", "color")],
  }),
  company: schema({
    key: "main",
    fields: [field("company", "name", "text", { required: true, placeholder: true })],
  }),
  person: schema({
    key: "main",
    fields: [
      field("person", "name", "text", { required: true, placeholder: true }),
      field("person", "contact", "select"),
    ],
  }),
  file: schema(
    {
      key: "main",
      fields: [
        field("file", "file", "tile", { required: true }),
        field("file", "name", "text", { placeholder: true }),
        field("file", "type", "select"),
        field("file", "date", "date"),
      ],
    },
    followupGroup("file"),
  ),
  health: schema({
    key: "main",
    fields: [
      field("health", "name", "text", { required: true, placeholder: true }),
      field("health", "date", "date"),
      field("health", "status", "select"),
    ],
  }),
  journal: schema({
    key: "main",
    fields: [
      field("journal", "day", "date", { required: true }),
      field("journal", "markdown", "area", { required: true, placeholder: true }),
    ],
  }),
  page: schema({
    key: "main",
    fields: [
      field("page", "page", "select", { required: true, optionsSource: "page" }),
      field("page", "placement", "seg", { options: ["start", "end"] }),
      field("page", "heading", "text", { placeholder: true }),
      field("page", "markdown", "area", { required: true, placeholder: true }),
    ],
  }),
};
