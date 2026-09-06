import { z } from "zod";

/**
 * A single scheduled/queued unit of work a module contributes. Deliberately just these three
 * fields (issue #108) — affinity-safe runtime ownership (which worker process may run it) is
 * added later by #91, and actually registering it with the queue is out of scope here too.
 */
export interface ModuleTaskDescriptor {
  name: string;
  payloadSchemaExport: string;
  handlerExport: string;
}

export interface ModuleWorkerDescriptor {
  name: string;
  handlerExport: string;
}

/**
 * Lets a module add its own heartbeat trigger kind (issue #109) without patching core's
 * `heartbeatRuleSchema` discriminated union: `schemaExport` validates a rule of this kind's
 * shape, `nextFireAtExport` computes its next occurrence — both dispatched to by core's
 * scheduler once the kind's owning module is active.
 */
export interface ModuleHeartbeatRuleKindDescriptor {
  kind: string;
  schemaExport: string;
  nextFireAtExport: string;
}

export interface ModuleDatabaseDescriptor {
  key: string;
  name: string;
}

/**
 * `capability`, when present, names an entry that must be granted at runtime (see
 * `ModuleRegistry.getAgentTools`) for the tool to appear in a projection at all — an
 * ungranted tool is absent, never present-but-denied.
 */
export interface ModuleAgentToolDescriptor {
  name: string;
  handlerExport: string;
  capability?: string;
}

export interface ModuleManifest {
  id: string;
  version: string;
  name: string;
  removable: boolean;
  systemProject: boolean;
  databases: ModuleDatabaseDescriptor[];
  capabilities: string[];
  agentTools: ModuleAgentToolDescriptor[];
  viewTypes?: string[];
  heartbeatActions?: string[];
  heartbeatRuleKinds?: ModuleHeartbeatRuleKindDescriptor[];
  taskNames?: ModuleTaskDescriptor[];
  workers?: ModuleWorkerDescriptor[];
  migrations?: string[];
}

const moduleTaskDescriptorSchema = z.object({
  name: z.string().min(1),
  payloadSchemaExport: z.string().min(1),
  handlerExport: z.string().min(1),
});

const moduleWorkerDescriptorSchema = z.object({
  name: z.string().min(1),
  handlerExport: z.string().min(1),
});

const moduleHeartbeatRuleKindDescriptorSchema = z.object({
  kind: z.string().min(1),
  schemaExport: z.string().min(1),
  nextFireAtExport: z.string().min(1),
});

const moduleDatabaseDescriptorSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
});

const moduleAgentToolDescriptorSchema = z.object({
  name: z.string().min(1),
  handlerExport: z.string().min(1),
  capability: z.string().min(1).optional(),
});

export const moduleManifestSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  name: z.string().min(1),
  removable: z.boolean(),
  systemProject: z.boolean(),
  databases: z.array(moduleDatabaseDescriptorSchema),
  capabilities: z.array(z.string().min(1)),
  agentTools: z.array(moduleAgentToolDescriptorSchema),
  viewTypes: z.array(z.string().min(1)).optional(),
  heartbeatActions: z.array(z.string().min(1)).optional(),
  heartbeatRuleKinds: z.array(moduleHeartbeatRuleKindDescriptorSchema).optional(),
  taskNames: z.array(moduleTaskDescriptorSchema).optional(),
  workers: z.array(moduleWorkerDescriptorSchema).optional(),
  migrations: z.array(z.string().min(1)).optional(),
});
