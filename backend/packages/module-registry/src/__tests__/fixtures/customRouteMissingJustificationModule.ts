export const manifest = {
  id: "fixture-custom-route-missing-justification",
  version: "1.0.0",
  name: "Fixture Custom Route Missing Justification",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  customRoutes: [
    {
      name: "fixtureMissingJustification.thing",
      method: "GET",
      path: "/api/fixture-missing-justification/thing",
      handlerExport: "handleThing",
      // "justification" deliberately omitted — the registry must reject this manifest.
    },
  ],
};

export function handleThing(): void {}
