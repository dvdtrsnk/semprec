import type {
  EditorFieldControl,
  EditorFieldDescriptor,
  EditorGroupDescriptor,
  EditorSchemaDescriptor,
} from "@alldots/module-registry";

/**
 * Inbox card editor schemas of the system databases, keyed by the card's base kind; labels and
 * placeholders are in `seed/i18n/{cs,en}.json`.
 *
 * A field `key` is the owning database's property key where one exists; otherwise a pseudo key
 * (`allDay`, `followupTask`, `followDate`, `day`, `page`, `placement`, `heading`, `markdown`).
 * `required`, `when` and `timeHiddenWhen` are not evaluated yet.
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

/** The follow-up task switch and its date, on cards whose proposal may carry a follow-up task. */
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
      fields: [field("task", "project", "select", { optionsSource: "project" })],
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
      field("project", "tags", "multi"),
    ],
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
