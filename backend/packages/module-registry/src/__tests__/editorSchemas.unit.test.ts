import { describe, expect, it } from "vitest";
import { moduleManifestSchema } from "../manifest.js";

const baseManifest = {
  id: "editorFixture",
  version: "1.0.0",
  name: "Editor Fixture",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
};

/** A manifest declaring one base kind whose only group holds the given fields. */
function withFields(...fields: unknown[]): unknown {
  return { ...baseManifest, editorSchemas: { widget: { groups: [{ key: "main", fields }] } } };
}

function withGroups(groups: unknown[]): unknown {
  return { ...baseManifest, editorSchemas: { widget: { groups } } };
}

describe("module manifest editorSchemas", () => {
  it("accepts a manifest without editorSchemas", () => {
    expect(moduleManifestSchema.safeParse(baseManifest).success).toBe(true);
  });

  it("accepts a valid declaration covering the control, condition and info shapes", () => {
    const declaration = withGroups([
      {
        key: "main",
        fields: [
          { key: "title", control: "text", inputType: "email", labelKey: "f.title", required: true },
          { key: "due", control: "datetime", labelKey: "f.due", timeHiddenWhen: { field: "allDay", equals: true } },
          { key: "allDay", control: "toggle", labelKey: "f.allDay" },
          {
            key: "transport",
            control: "seg",
            options: ["http", "stdio"],
            labelKey: "f.transport",
            placeholderKey: "f.transport.placeholder",
          },
          { key: "url", control: "text", labelKey: "f.url", when: { field: "transport", notEquals: "stdio" } },
          { key: "projects", control: "multi", labelKey: "f.projects", optionsSource: "projects" },
          { key: "note", control: "info", labelKey: "f.note", infoKey: "f.note.info", params: { count: 2 } },
        ],
      },
      { key: "secondary", fields: [{ key: "secret", control: "secret", labelKey: "f.secret" }] },
    ]);

    expect(moduleManifestSchema.safeParse(declaration).success).toBe(true);
  });

  it("rejects timeHiddenWhen on a text control", () => {
    const manifest = withFields({
      key: "title",
      control: "text",
      labelKey: "f.title",
      timeHiddenWhen: { field: "allDay", equals: true },
    });

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it.each(["date", "select", "seg"])("rejects timeHiddenWhen on a %s control", (control) => {
    const manifest = withFields({
      key: "due",
      control,
      labelKey: "f.due",
      timeHiddenWhen: { field: "allDay", equals: true },
    });

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("accepts timeHiddenWhen on a datetime control", () => {
    const manifest = withFields({
      key: "due",
      control: "datetime",
      labelKey: "f.due",
      timeHiddenWhen: { field: "allDay", equals: true },
    });

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it.each(["date", "secret", "area"])("rejects inputType on a %s control", (control) => {
    const manifest = withFields({ key: "value", control, labelKey: "f.value", inputType: "url" });

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("accepts inputType on a text control", () => {
    const manifest = withFields({ key: "url", control: "text", labelKey: "f.url", inputType: "url" });

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("rejects an empty group", () => {
    const manifest = withGroups([{ key: "empty", fields: [] }]);

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it.each(["select", "text"])("rejects options on a %s control", (control) => {
    const manifest = withFields({ key: "choice", control, labelKey: "f.choice", options: ["a", "b"] });

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("accepts options on a seg control", () => {
    const manifest = withFields({ key: "transport", control: "seg", labelKey: "f.t", options: ["http", "stdio"] });

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("rejects an info row without infoKey", () => {
    const manifest = withFields({ key: "note", control: "info", labelKey: "f.note" });

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("accepts an info row with infoKey", () => {
    const manifest = withFields({ key: "note", control: "info", labelKey: "f.note", infoKey: "f.note.info" });

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it.each([
    ["neither equals nor notEquals", { field: "transport" }],
    ["both equals and notEquals", { field: "transport", equals: "http", notEquals: "stdio" }],
  ])("rejects a condition with %s", (_label, condition) => {
    const manifest = withFields({ key: "url", control: "text", labelKey: "f.url", when: condition });

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("rejects an unknown control", () => {
    const manifest = withFields({ key: "value", control: "dropdown", labelKey: "f.value" });

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("rejects a misspelled field attribute instead of silently dropping it", () => {
    const manifest = withFields({ key: "name", control: "text", labelKey: "f.name", requierd: true });

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it("rejects an empty base kind key", () => {
    const manifest = { ...baseManifest, editorSchemas: { "": { groups: [] } } };

    expect(moduleManifestSchema.safeParse(manifest).success).toBe(false);
  });
});
