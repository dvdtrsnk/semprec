export const manifest = {
  id: "fixture-missing-queue-affinity",
  version: "1.0.0",
  name: "Fixture Missing Queue Affinity",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  taskNames: [
    // Missing "queueAffinity" — must fail ModuleRegistry load.
    { name: "fixtureMissingAffinity.doThing", payloadSchemaExport: "payloadSchema", handlerExport: "handleTask" },
  ],
};

export const payloadSchema = { parse: (value: unknown) => value };

export function handleTask(): void {}
