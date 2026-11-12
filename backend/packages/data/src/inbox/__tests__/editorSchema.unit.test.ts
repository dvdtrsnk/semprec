import { beforeAll, describe, expect, it } from "vitest";
import { ModuleRegistry, type EditorSchemaDescriptor, type ModuleCatalogs } from "@semprec/module-registry";
import { resolveEditorSchema, type EditorSchemaRegistry } from "../editorSchema.js";

const SYSTEM_DATABASES_MANIFEST_PATH = new URL("../../seed/systemDatabasesModuleManifest.js", import.meta.url).href;
const INBOX_MANIFEST_PATH = new URL("../inboxModuleManifest.js", import.meta.url).href;
const ACTIVE_MODULE_IDS = new Set(["systemDatabases", "inboxPipeline"]);

/** A registry that holds one declaration of `moduleId` and the given catalogs (`undefined` for a module without any). */
function stubRegistry(
  schema: EditorSchemaDescriptor,
  catalogs: ModuleCatalogs | undefined,
  baseKind = "widget",
): EditorSchemaRegistry {
  return {
    getEditorSchemas: async () => [{ moduleId: "widgets", baseKind, schema: structuredClone(schema) }],
    getCatalogs: async (moduleId) => (moduleId === "widgets" ? catalogs : undefined),
  };
}

const CATALOGS: ModuleCatalogs = {
  cs: { "editor.widget.name.label": "Název", "editor.widget.name.placeholder": "Zadejte název" },
  en: {
    "editor.widget.name.label": "Name",
    "editor.widget.name.placeholder": "Enter a name",
    "editor.widget.size.label": "Size",
    "editor.widget.note.label": "Note",
    "editor.widget.note.info": "Up to {limit} characters, {unit} included. Price: {price}.",
  },
};

const SCHEMA: EditorSchemaDescriptor = {
  groups: [
    {
      key: "main",
      fields: [
        {
          key: "name",
          control: "text",
          inputType: "text",
          labelKey: "editor.widget.name.label",
          placeholderKey: "editor.widget.name.placeholder",
          required: true,
          when: { field: "size", notEquals: "none" },
        },
        { key: "size", control: "seg", options: ["small", "large"], labelKey: "editor.widget.size.label" },
      ],
    },
  ],
};

describe("resolveEditorSchema (issue #1825)", () => {
  it("returns null when no module declares a schema for the base kind", async () => {
    expect(await resolveEditorSchema(stubRegistry(SCHEMA, CATALOGS), "gadget", "en")).toBeNull();
  });

  it("resolves the label and placeholder in the locale of the caller and keeps the other attributes", async () => {
    expect(await resolveEditorSchema(stubRegistry(SCHEMA, CATALOGS), "widget", "cs")).toStrictEqual({
      baseKind: "widget",
      groups: [
        {
          key: "main",
          fields: [
            {
              key: "name",
              control: "text",
              inputType: "text",
              label: "Název",
              placeholder: "Zadejte název",
              required: true,
              when: { field: "size", notEquals: "none" },
            },
            // The Czech catalog has no entry for it, so the English one answers.
            { key: "size", control: "seg", label: "Size", options: ["small", "large"] },
          ],
        },
      ],
    });
  });

  it("resolves English for the locale en and for a locale without a catalog", async () => {
    for (const locale of ["en", "de", ""]) {
      const resolved = await resolveEditorSchema(stubRegistry(SCHEMA, CATALOGS), "widget", locale);
      expect(resolved?.groups[0]?.fields[0]).toMatchObject({ label: "Name", placeholder: "Enter a name" });
    }
  });

  it("falls back to the catalog key when neither catalog has the entry, or the module has no catalogs", async () => {
    const withoutEntries = await resolveEditorSchema(stubRegistry(SCHEMA, { cs: {}, en: {} }), "widget", "cs");
    const withoutCatalogs = await resolveEditorSchema(stubRegistry(SCHEMA, undefined), "widget", "cs");

    for (const resolved of [withoutEntries, withoutCatalogs]) {
      expect(resolved?.groups[0]?.fields[0]).toMatchObject({
        label: "editor.widget.name.label",
        placeholder: "editor.widget.name.placeholder",
      });
    }
  });

  it("sets no attribute that the declaration leaves out", async () => {
    const resolved = await resolveEditorSchema(
      stubRegistry(
        { groups: [{ key: "main", fields: [{ key: "size", control: "toggle", labelKey: "k" }] }] },
        CATALOGS,
      ),
      "widget",
      "en",
    );

    expect(resolved?.groups[0]?.fields[0]).toStrictEqual({ key: "size", control: "toggle", label: "k" });
  });

  it("renders an info row from its catalog entry and parameters, leaving a placeholder without a parameter and a $ as typed", async () => {
    const schema: EditorSchemaDescriptor = {
      groups: [
        {
          key: "main",
          fields: [
            {
              key: "note",
              control: "info",
              labelKey: "editor.widget.note.label",
              infoKey: "editor.widget.note.info",
              params: { limit: 280, price: "$&5" },
            },
          ],
        },
      ],
    };

    const resolved = await resolveEditorSchema(stubRegistry(schema, CATALOGS), "widget", "en");

    expect(resolved?.groups[0]?.fields[0]).toMatchObject({
      label: "Note",
      info: "Up to 280 characters, {unit} included. Price: $&5.",
    });
  });

  it("renders an info row that declares no parameters", async () => {
    const schema: EditorSchemaDescriptor = {
      groups: [
        {
          key: "main",
          fields: [
            { key: "note", control: "info", labelKey: "editor.widget.note.label", infoKey: "editor.widget.note.info" },
          ],
        },
      ],
    };

    const resolved = await resolveEditorSchema(stubRegistry(schema, CATALOGS), "widget", "en");

    expect(resolved?.groups[0]?.fields[0]).toMatchObject({
      info: "Up to {limit} characters, {unit} included. Price: {price}.",
    });
  });
});

describe("the editor schemas the modules declare (issue #1825)", () => {
  let registry: ModuleRegistry;

  // Warms the cold module-graph import once, so the first test's cost does not depend on order.
  beforeAll(async () => {
    registry = new ModuleRegistry(() => ACTIVE_MODULE_IDS);
    await registry.loadModule(SYSTEM_DATABASES_MANIFEST_PATH);
    await registry.loadModule(INBOX_MANIFEST_PATH);
  }, 60_000);

  it("declares the ten card kinds of the system databases and the MCP server card, each once", async () => {
    const declared = (await registry.getEditorSchemas()).map((schema) => `${schema.moduleId}:${schema.baseKind}`);

    expect([...declared].sort()).toEqual(
      [
        "inboxPipeline:mcp",
        ...["task", "event", "project", "area", "company", "person", "file", "health", "journal", "page"].map(
          (baseKind) => `systemDatabases:${baseKind}`,
        ),
      ].sort(),
    );
  });

  it("gives a task name as a required field and the date a time hidden by allDay", async () => {
    const task = await resolveEditorSchema(registry, "task", "en");
    const fields = task?.groups.flatMap((group) => group.fields) ?? [];

    expect(fields.find((field) => field.key === "name")).toMatchObject({ required: true });
    expect(fields.find((field) => field.key === "date")).toMatchObject({
      control: "datetime",
      timeHiddenWhen: { field: "allDay", equals: true },
    });
    expect(fields.find((field) => field.key === "followDate")).toMatchObject({
      required: true,
      when: { field: "followupTask", equals: true },
    });
  });

  it("gives a file a required file field and the same follow-up fields as a task", async () => {
    const file = await resolveEditorSchema(registry, "file", "en");
    const fields = file?.groups.flatMap((group) => group.fields) ?? [];

    expect(fields.map((field) => [field.key, field.required === true])).toEqual([
      ["file", true],
      ["name", false],
      ["type", false],
      ["date", false],
      ["followupTask", false],
      ["followDate", true],
    ]);
  });

  it("gives the journal and page cards a required Markdown field, and a page its required target", async () => {
    const journal = await resolveEditorSchema(registry, "journal", "en");
    const page = await resolveEditorSchema(registry, "page", "en");

    expect(
      journal?.groups.flatMap((group) => group.fields).map((field) => [field.key, field.required === true]),
    ).toEqual([
      ["day", true],
      ["markdown", true],
    ]);
    expect(page?.groups.flatMap((group) => group.fields).map((field) => [field.key, field.required === true])).toEqual([
      ["page", true],
      ["placement", false],
      ["heading", false],
      ["markdown", true],
    ]);
  });

  it("resolves different labels for cs and en and an English label for an unknown locale", async () => {
    const labelOf = async (locale: string): Promise<string | undefined> =>
      (await resolveEditorSchema(registry, "person", locale))?.groups[0]?.fields.find((field) => field.key === "name")
        ?.label;

    expect(await labelOf("cs")).toBe("Název");
    expect(await labelOf("en")).toBe("Name");
    expect(await labelOf("sk")).toBe("Name");
  });

  it("returns null for the base kinds no module declares", async () => {
    for (const baseKind of ["approval", "clarify", "invalid", "speaker", "transcriptEvent", "recording"]) {
      expect(await resolveEditorSchema(registry, baseKind, "en"), baseKind).toBeNull();
    }
  });

  it("has every catalog key a declaration references in both catalogs of the declaring module", async () => {
    const missing: string[] = [];
    for (const { moduleId, baseKind, schema } of await registry.getEditorSchemas()) {
      const catalogs = await registry.getCatalogs(moduleId);
      for (const field of schema.groups.flatMap((group) => group.fields)) {
        for (const key of [field.labelKey, field.placeholderKey, field.infoKey]) {
          if (key === undefined) continue;
          for (const locale of ["cs", "en"] as const) {
            const entry = catalogs?.[locale][key];
            if (typeof entry !== "string" || entry.trim() === "")
              missing.push(`${baseKind}.${field.key} ${key} (${locale})`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
