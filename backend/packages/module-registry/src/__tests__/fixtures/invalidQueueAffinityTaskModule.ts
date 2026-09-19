export const manifest = {
  id: "fixture-invalid-queue-affinity",
  version: "1.0.0",
  name: "Fixture Invalid Queue Affinity",
  removable: true,
  systemProject: false,
  databases: [],
  capabilities: [],
  agentTools: [],
  taskNames: [
    // "worker" isn't a valid queueAffinity ("api" | "agents") — must fail ModuleRegistry load.
    {
      name: "fixtureInvalidAffinity.doThing",
      payloadSchemaExport: "payloadSchema",
      handlerExport: "handleTask",
      queueAffinity: "worker",
    },
  ],
};

export const payloadSchema = { parse: (value: unknown) => value };

export function handleTask(): void {}
