import { beforeAll, describe, expect, it } from "vitest";
import { ModuleRegistry, type EditorSchemaDescriptor, type ModuleCatalogs } from "@semprec/module-registry";
import {
  buildEditorValues,
  findMissingRequired,
  isFieldVisible,
  normalizeHiddenFields,
  resolveEditorSchema,
  toProposalWarnings,
  visibleKeys,
  type EditorRuleSchema,
  type EditorSchemaRegistry,
  type EditorStepValues,
} from "../editorSchema.js";
import type { ProposalEnvelope, ProposalStep } from "../proposalEnvelope.js";

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

describe("editor schema rules (issue #1928)", () => {
  /** One step `primary` holding `values`. */
  const single = (values: Record<string, unknown>): EditorStepValues[] => [{ ref: "primary", synthetic: true, values }];

  describe("isFieldVisible", () => {
    it("shows a field that declares no condition", () => {
      expect(isFieldVisible({}, single({}))).toBe(true);
    });

    it("shows a field whose `equals` condition holds and hides it when it does not", () => {
      const field = { when: { field: "followupTask", equals: true } } as const;
      expect(isFieldVisible(field, single({ followupTask: true }))).toBe(true);
      expect(isFieldVisible(field, single({ followupTask: false }))).toBe(false);
    });

    it("shows a field whose `notEquals` condition holds and hides it when it does not", () => {
      const field = { when: { field: "status", notEquals: "longTerm" } } as const;
      expect(isFieldVisible(field, single({ status: "active" }))).toBe(true);
      expect(isFieldVisible(field, single({ status: "longTerm" }))).toBe(false);
    });

    it("treats a condition field that has no value as not equal to anything", () => {
      expect(isFieldVisible({ when: { field: "followupTask", equals: true } }, single({}))).toBe(false);
      expect(isFieldVisible({ when: { field: "status", notEquals: "longTerm" } }, single({}))).toBe(true);
    });

    it("reads the condition field from any step, the first step that has it winning", () => {
      const field = { when: { field: "followupTask", equals: true } } as const;
      const steps: EditorStepValues[] = [
        { ref: "primary", values: {} },
        { ref: "followup", values: { followupTask: true } },
      ];
      expect(isFieldVisible(field, steps)).toBe(true);
      expect(isFieldVisible(field, [{ ref: "primary", values: { followupTask: false } }, ...steps.slice(1)])).toBe(
        false,
      );
    });
  });

  describe("findMissingRequired", () => {
    const SCHEMA_RULES: EditorRuleSchema = {
      groups: [
        {
          fields: [
            { key: "name", required: true },
            { key: "note" },
            { key: "followupTask" },
            { key: "followDate", required: true, when: { field: "followupTask", equals: true } },
          ],
        },
        { fields: [{ key: "area", required: true }] },
      ],
    };

    it("lists the visible required fields without a value in schema order", () => {
      expect(findMissingRequired(SCHEMA_RULES, single({ followupTask: true }))).toEqual([
        { field: "name" },
        { field: "followDate" },
        { field: "area" },
      ]);
    });

    it("does not list a field that has a value, nor an optional one", () => {
      expect(findMissingRequired(SCHEMA_RULES, single({ name: "Milk", area: "a1" }))).toEqual([]);
    });

    it("does not list a required field that a condition hides", () => {
      expect(findMissingRequired(SCHEMA_RULES, single({ name: "x", area: "a", followupTask: false }))).toEqual([]);
    });

    it.each([
      ["undefined", undefined],
      ["null", null],
      ["an empty string", ""],
      ["a whitespace-only string", " \t\n "],
      ["an empty array", []],
    ])("counts %s as no value", (_label, value) => {
      expect(findMissingRequired(SCHEMA_RULES, single({ name: value, area: "a" }))).toEqual([{ field: "name" }]);
    });

    it.each([
      ["false", false],
      ["zero", 0],
      ["a non-empty array", ["a"]],
      ["a string with text", " x "],
    ])("counts %s as a value", (_label, value) => {
      expect(findMissingRequired(SCHEMA_RULES, single({ name: value, area: "a" }))).toEqual([]);
    });

    it("reports a missing field of a card with several steps on its first step, and none for a single step", () => {
      const steps: EditorStepValues[] = [
        { ref: "company", values: {} },
        { ref: "person", values: { name: "Jane" } },
      ];
      expect(findMissingRequired(SCHEMA_RULES, steps)).toEqual([{ ref: "company", field: "area" }]);
      expect(findMissingRequired(SCHEMA_RULES, single({}))[0]).toEqual({ field: "name" });
    });

    it("reports the real ref of a card whose envelope has operations even when only one step is active", () => {
      expect(findMissingRequired(SCHEMA_RULES, [{ ref: "file", values: { area: "a" } }])).toEqual([
        { ref: "file", field: "name" },
      ]);
      // A real step may be named `primary`: it is still addressed by that ref, unlike the synthetic step.
      expect(findMissingRequired(SCHEMA_RULES, [{ ref: "primary", values: { area: "a" } }])).toEqual([
        { ref: "primary", field: "name" },
      ]);
    });

    it("finds a required field's value in a later step", () => {
      const steps: EditorStepValues[] = [
        { ref: "company", values: { area: "a" } },
        { ref: "person", values: { name: "Jane" } },
      ];
      expect(findMissingRequired(SCHEMA_RULES, steps)).toEqual([]);
    });
  });

  describe("visibleKeys", () => {
    const SCHEMA_RULES: EditorRuleSchema = {
      groups: [
        { fields: [{ key: "followupTask" }, { key: "followDate", when: { field: "followupTask", equals: true } }] },
        { fields: [{ key: "name" }] },
      ],
    };

    it("lists the keys of the visible fields in schema order", () => {
      expect(visibleKeys(SCHEMA_RULES, single({ followupTask: true }))).toEqual(["followupTask", "followDate", "name"]);
    });

    it("leaves out the key of a hidden field", () => {
      expect(visibleKeys(SCHEMA_RULES, single({ followupTask: false }))).toEqual(["followupTask", "name"]);
    });
  });

  describe("toProposalWarnings", () => {
    it("adds the code `required` to every missing field and none when nothing is missing", () => {
      const schema: EditorRuleSchema = { groups: [{ fields: [{ key: "name", required: true }] }] };
      expect(toProposalWarnings(schema, single({}))).toEqual([{ field: "name", code: "required" }]);
      expect(toProposalWarnings(schema, single({ name: "x" }))).toEqual([]);
    });
  });

  describe("buildEditorValues", () => {
    const TARGET = "00000000-0000-4000-8000-000000000001";
    const database = (properties: Record<string, unknown>): ProposalEnvelope => ({
      entityKind: "database",
      target: TARGET,
      properties,
    });
    const step = (ref: string, role: "primary" | "secondary", extra: Partial<ProposalStep> = {}): ProposalStep => ({
      ref,
      op: "create",
      databaseKey: "tasks",
      role,
      properties: { name: ref },
      ...extra,
    });

    it("lays the user's values for `primary` over the properties of a single-step envelope", () => {
      expect(
        buildEditorValues(database({ name: "Milk", date: "2026-11-13" }), {
          primary: { date: "2026-11-14", allDay: true },
        }),
      ).toEqual([{ ref: "primary", synthetic: true, values: { name: "Milk", date: "2026-11-14", allDay: true } }]);
    });

    it("ignores the user's values of a ref a single-step envelope does not have", () => {
      expect(buildEditorValues(database({ name: "Milk" }), { other: { allDay: true } })).toEqual([
        { ref: "primary", synthetic: true, values: { name: "Milk" } },
      ]);
    });

    it("answers `page` and `day` with the target of a pageContent envelope, below its own properties", () => {
      const envelope: ProposalEnvelope = {
        entityKind: "pageContent",
        target: TARGET,
        properties: { markdown: "Text", placement: "end" },
      };
      expect(buildEditorValues(envelope, {})).toEqual([
        {
          ref: "primary",
          synthetic: true,
          values: { page: TARGET, day: TARGET, markdown: "Text", placement: "end" },
        },
      ]);
      expect(buildEditorValues(envelope, { primary: { page: "other" } })[0]?.values.page).toBe("other");
    });

    it("lists the active steps of a multi-step envelope, the primary one first, with the user's values", () => {
      const envelope: ProposalEnvelope = {
        ...database({ name: "main" }),
        operations: [step("followup", "secondary", { properties: { name: "followup" } }), step("main", "primary")],
      };
      expect(buildEditorValues(envelope, { followup: { followDate: "2026-12-01" }, main: { allDay: false } })).toEqual([
        { ref: "main", values: { name: "main", allDay: false } },
        { ref: "followup", values: { name: "followup", followDate: "2026-12-01" } },
      ]);
    });

    it("keeps the real ref of the one active step of an envelope with operations, so a missing field names it", () => {
      const envelope: ProposalEnvelope = {
        ...database({ name: "main" }),
        operations: [step("file", "primary"), step("off", "secondary", { enabled: false })],
      };
      const values = buildEditorValues(envelope, {});
      expect(values).toEqual([{ ref: "file", values: { name: "file" } }]);
      expect(findMissingRequired({ groups: [{ fields: [{ key: "area", required: true }] }] }, values)).toEqual([
        { ref: "file", field: "area" },
      ]);
    });

    it("leaves out a disabled step and the properties an update step writes are read from `after`", () => {
      const envelope: ProposalEnvelope = {
        ...database({ name: "main" }),
        operations: [
          step("main", "primary"),
          step("off", "secondary", { enabled: false }),
          step("upd", "secondary", {
            op: "update",
            itemId: "00000000-0000-4000-8000-000000000009",
            properties: { name: "before" },
            after: { properties: { name: "after" } },
          }),
        ],
      };
      expect(
        buildEditorValues(envelope, { off: { allDay: true } }).map((entry) => [entry.ref, entry.values.name]),
      ).toEqual([
        ["main", "main"],
        ["upd", "after"],
      ]);
    });
  });
});

describe("normalizeHiddenFields (issue #1934)", () => {
  const single = (values: Record<string, unknown>): EditorStepValues[] => [{ ref: "primary", synthetic: true, values }];

  /** The shape of the task, event and project schemas: a date whose time part allDay hides, and a date a status hides. */
  const SCHEMA: EditorRuleSchema = {
    groups: [
      {
        fields: [
          { key: "name", required: true },
          { key: "date", timeHiddenWhen: { field: "allDay", equals: true } },
          { key: "allDay" },
          { key: "dueDate", when: { field: "status", notEquals: "longTerm" } },
          { key: "followDate", when: { field: "followupTask", equals: true } },
        ],
      },
    ],
  };
  const TASKS = new Set(["name", "date", "dueDate", "timeFrom", "timeTo"]);
  const NO_TIME = new Set(["name", "date", "dueDate"]);
  const PROPERTIES = { name: "Send it", date: "2026-12-01", dueDate: "2026-12-24", timeFrom: "09:00", timeTo: "10:00" };

  it("drops the time part of a field whose timeHiddenWhen holds and keeps the date", () => {
    expect(normalizeHiddenFields(SCHEMA, single({ allDay: true }), PROPERTIES, TASKS, false)).toEqual({
      name: "Send it",
      date: "2026-12-01",
      dueDate: "2026-12-24",
    });
  });

  it("keeps the time part while timeHiddenWhen does not hold", () => {
    expect(normalizeHiddenFields(SCHEMA, single({ allDay: false }), PROPERTIES, TASKS, false)).toEqual(PROPERTIES);
    expect(normalizeHiddenFields(SCHEMA, single({}), PROPERTIES, TASKS, false)).toEqual(PROPERTIES);
  });

  it("sets the time part to null instead of dropping it when the destination stores an empty time as null", () => {
    expect(normalizeHiddenFields(SCHEMA, single({ allDay: true }), PROPERTIES, TASKS, true)).toEqual({
      name: "Send it",
      date: "2026-12-01",
      dueDate: "2026-12-24",
      timeFrom: null,
      timeTo: null,
    });
  });

  it("sets the time part to null on a destination whose envelope carried no times", () => {
    const { timeFrom, timeTo, ...withoutTimes } = PROPERTIES;
    expect(timeFrom).toBeDefined();
    expect(timeTo).toBeDefined();

    expect(normalizeHiddenFields(SCHEMA, single({ allDay: true }), withoutTimes, TASKS, true)).toEqual({
      ...withoutTimes,
      timeFrom: null,
      timeTo: null,
    });
  });

  it("leaves a card whose envelope has no times unchanged, and adds nothing for a destination that drops the time", () => {
    const { timeFrom, timeTo, ...withoutTimes } = PROPERTIES;
    expect(timeFrom).toBeDefined();
    expect(timeTo).toBeDefined();

    expect(normalizeHiddenFields(SCHEMA, single({ allDay: true }), withoutTimes, TASKS, false)).toEqual(withoutTimes);
  });

  it("leaves a destination without timeFrom and timeTo alone, whether it drops or nulls the time", () => {
    for (const hiddenTimeIsNull of [false, true]) {
      expect(normalizeHiddenFields(SCHEMA, single({ allDay: true }), PROPERTIES, NO_TIME, hiddenTimeIsNull)).toEqual(
        PROPERTIES,
      );
    }
  });

  describe("a date that carries a time of day", () => {
    const withDate = (date: string): Record<string, unknown> => ({ ...PROPERTIES, date });

    it("reduces a wall-clock date to its calendar date while timeHiddenWhen holds, whatever the destination does with the times", () => {
      for (const hiddenTimeIsNull of [false, true]) {
        const normalized = normalizeHiddenFields(
          SCHEMA,
          single({ allDay: true }),
          withDate("2026-12-01T10:00:30"),
          TASKS,
          hiddenTimeIsNull,
        );

        expect(normalized.date).toBe("2026-12-01");
      }
    });

    it("reads an instant in the given zone", () => {
      const read = (zone: string) =>
        normalizeHiddenFields(SCHEMA, single({ allDay: true }), withDate("2026-12-01T23:30:00Z"), TASKS, true, zone)
          .date;

      expect(read("Europe/Prague")).toBe("2026-12-02");
      expect(read("America/New_York")).toBe("2026-12-01");
    });

    it("refuses an instant without a zone with a validation error on the field", () => {
      expect(() =>
        normalizeHiddenFields(SCHEMA, single({ allDay: true }), withDate("2026-12-01T09:00+01:00"), TASKS, true),
      ).toThrow(expect.objectContaining({ details: { field: "date" } }));
    });

    it("leaves the date alone while timeHiddenWhen does not hold, a date-only date and a value that is not a date", () => {
      expect(
        normalizeHiddenFields(SCHEMA, single({ allDay: false }), withDate("2026-12-01T10:00"), TASKS, true).date,
      ).toBe("2026-12-01T10:00");
      expect(normalizeHiddenFields(SCHEMA, single({ allDay: true }), withDate("2026-12-01"), TASKS, true).date).toBe(
        "2026-12-01",
      );
      expect(
        normalizeHiddenFields(SCHEMA, single({ allDay: true }), withDate("2026-12-01T25:00"), TASKS, true).date,
      ).toBe("2026-12-01T25:00");
    });
  });

  it("drops the property of a field its condition hides, and keeps it while the condition holds", () => {
    expect(normalizeHiddenFields(SCHEMA, single({ status: "longTerm" }), PROPERTIES, TASKS, false)).toEqual({
      name: "Send it",
      date: "2026-12-01",
      timeFrom: "09:00",
      timeTo: "10:00",
    });
    expect(normalizeHiddenFields(SCHEMA, single({ status: "inProgress" }), PROPERTIES, TASKS, false)).toEqual(
      PROPERTIES,
    );
  });

  it("reads the condition from the card's effective values, not from the envelope properties", () => {
    // The envelope's own `status` is not an effective value: only `values` decide.
    const properties = { ...PROPERTIES, status: "longTerm" };
    expect(normalizeHiddenFields(SCHEMA, single({}), properties, new Set([...TASKS, "status"]), false)).toEqual(
      properties,
    );
  });

  it("keeps a hidden field's key when the destination has no property of that name, because it is a pseudo field", () => {
    const properties = { name: "Send it", followDate: "2026-12-05" };

    expect(normalizeHiddenFields(SCHEMA, single({ followupTask: false }), properties, TASKS, false)).toEqual(
      properties,
    );
  });

  it("changes nothing in the envelope properties it was given", () => {
    const properties = { ...PROPERTIES };

    normalizeHiddenFields(SCHEMA, single({ allDay: true, status: "longTerm" }), properties, TASKS, true);

    expect(properties).toEqual(PROPERTIES);
  });
});
