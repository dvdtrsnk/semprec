import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-editor-duplicate",
  version: "1.0.0",
  name: "Fixture Editor Duplicate",
  removable: true,
  systemProject: false,
  databases: [{ key: "fixtureEditorDuplicateItems", name: "Fixture Editor Duplicate Items" }],
  capabilities: [],
  agentTools: [],
  editorSchemas: {
    mcp: {
      groups: [
        {
          key: "server",
          fields: [{ key: "name", control: "text", labelKey: "fixture.editor.name.label" }],
        },
      ],
    },
  },
};
