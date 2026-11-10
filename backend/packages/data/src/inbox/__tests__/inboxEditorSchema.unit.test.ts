import { beforeAll, describe, expect, it } from "vitest";
import { ModuleRegistry } from "@semprec/module-registry";

const INBOX_MANIFEST_PATH = new URL("../inboxModuleManifest.js", import.meta.url).href;
const INBOX_MODULE_ID = "inboxPipeline";

describe("Inbox MCP card editor schema (issue #1417)", () => {
  // Warms the manifest's cold module-graph import once, so the first test's cost does not depend on
  // order or `-t` filtering (#1237, as in `libraryMailInboxModuleManifests.unit.test.ts`).
  beforeAll(async () => {
    await import(INBOX_MANIFEST_PATH);
  }, 30_000);

  it("declares the six MCP server card fields under base kind mcp, owned by the Inbox module", async () => {
    const registry = new ModuleRegistry(() => new Set([INBOX_MODULE_ID]));
    await registry.loadModule(INBOX_MANIFEST_PATH);

    const schemas = await registry.getEditorSchemas();
    expect(schemas.map((schema) => [schema.moduleId, schema.baseKind])).toEqual([[INBOX_MODULE_ID, "mcp"]]);

    const fields = schemas.flatMap((schema) => schema.schema.groups.flatMap((group) => group.fields));
    expect(fields).toEqual([
      {
        key: "name",
        control: "text",
        labelKey: "editor.mcp.name.label",
        placeholderKey: "editor.mcp.name.placeholder",
        required: true,
      },
      { key: "transport", control: "seg", options: ["http", "stdio"], labelKey: "editor.mcp.transport.label" },
      {
        key: "url",
        control: "text",
        inputType: "url",
        labelKey: "editor.mcp.url.label",
        placeholderKey: "editor.mcp.url.placeholder",
        required: true,
        when: { field: "transport", equals: "http" },
      },
      {
        key: "command",
        control: "text",
        labelKey: "editor.mcp.command.label",
        placeholderKey: "editor.mcp.command.placeholder",
        required: true,
        when: { field: "transport", equals: "stdio" },
      },
      {
        key: "credential",
        control: "secret",
        labelKey: "editor.mcp.credential.label",
        placeholderKey: "editor.mcp.credential.placeholder",
        required: true,
        when: { field: "transport", equals: "http" },
      },
      {
        key: "mcpProjects",
        control: "multi",
        labelKey: "editor.mcp.mcpProjects.label",
        optionsSource: "mcpProjects",
      },
    ]);
  });

  it("has a cs and en catalog entry for every label and placeholder the MCP declaration names", async () => {
    const registry = new ModuleRegistry(() => new Set([INBOX_MODULE_ID]));
    await registry.loadModule(INBOX_MANIFEST_PATH);

    const [mcp] = await registry.getEditorSchemas();
    const keys = (mcp?.schema.groups ?? [])
      .flatMap((group) => group.fields)
      .flatMap((field) => [field.labelKey, field.placeholderKey, field.infoKey])
      .filter((key): key is string => key !== undefined);
    expect(keys.length).toBeGreaterThan(0);

    const catalogs = await registry.getCatalogs(INBOX_MODULE_ID);
    for (const key of keys) {
      expect(catalogs?.cs[key], `missing or empty "cs" entry "${key}"`).toBeTypeOf("string");
      expect((catalogs?.cs[key] ?? "").length, `empty "cs" entry "${key}"`).toBeGreaterThan(0);
      expect(catalogs?.en[key], `missing or empty "en" entry "${key}"`).toBeTypeOf("string");
      expect((catalogs?.en[key] ?? "").length, `empty "en" entry "${key}"`).toBeGreaterThan(0);
    }
  });
});
