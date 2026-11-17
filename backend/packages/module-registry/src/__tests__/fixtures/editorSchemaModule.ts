import type { ModuleManifest } from "../../manifest.js";

export const manifest: ModuleManifest = {
  id: "fixture-editor",
  version: "1.0.0",
  name: "Fixture Editor",
  removable: true,
  systemProject: false,
  databases: [{ key: "fixtureEditorItems", name: "Fixture Editor Items" }],
  capabilities: [],
  agentTools: [],
  editorSchemas: {
    mcp: {
      groups: [
        {
          key: "server",
          fields: [{ key: "name", control: "text", labelKey: "fixture.editor.name.label", required: true }],
        },
      ],
    },
  },
};
