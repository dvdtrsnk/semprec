export const manifest = {
  id: "fixture-custom-route-invalid-path",
  version: "1.0.0",
  name: "Fixture Custom Route Invalid Path",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  customRoutes: [
    {
      name: "fixtureInvalidPath.thing",
      method: "GET",
      path: "/not-under-api/thing",
      handlerExport: "handleThing",
      justification: "single-consumer-read",
    },
  ],
};

export function handleThing(): void {}
