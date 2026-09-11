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

/**
 * `defaultViewType`, when present, names the view type a database's default (system-created)
 * view uses instead of the generic `"table"` type — e.g. Journal's `temporal-switcher`
 * (issue #24). Absent means the database's default view is a plain table.
 */
export interface ModuleDatabaseDescriptor {
  key: string;
  name: string;
  defaultViewType?: string;
}

/**
 * A manifest-declared resumable data migration (issue #111) for one `from_version` ->
 * `to_version` transition of `databaseKey`'s items, distinct from the plain-string
 * `migrations` field above (that one names the module's own structural/DDL files applied
 * by the forward-only runner, issue #224). `converterExport` names a function of shape
 * `(properties) => properties` the module data migration runner calls once per item.
 */
export interface ModuleDataMigrationDescriptor {
  databaseKey: string;
  fromVersion: string;
  toVersion: string;
  converterExport: string;
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

/**
 * The two, and only two, reasons a custom route (issue #239) is allowed to exist outside the
 * generic REST surface: `transactional-semantics` covers an action with its own transactional
 * shape a generic item write/read can't express (a cross-database write in one transaction, an
 * aggregate read outside the item model, a binary upload); `single-consumer-read` covers a read
 * shortcut shaped for exactly one consumer. Never CRUD over module data — that always goes
 * through the generic resource endpoints instead. `moduleManifestSchema` rejects any entry
 * missing one of these two values, satisfying the issue's "every manifest entry must state which
 * justification applies" rule structurally, with no extra runtime check needed.
 */
export const CUSTOM_ROUTE_JUSTIFICATIONS = ["transactional-semantics", "single-consumer-read"] as const;
export type CustomRouteJustification = (typeof CUSTOM_ROUTE_JUSTIFICATIONS)[number];

export const CUSTOM_ROUTE_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type CustomRouteMethod = (typeof CUSTOM_ROUTE_METHODS)[number];

/**
 * A named custom route (issue #239) a module mounts into the flat `/api` namespace at startup,
 * through the `semprec-api` REST adapter (#238) — shared auth, validation, status mapping, and
 * serialization, with no private auth or error path of its own. `path` is matched exactly
 * (`:param`-style segments become path parameters); `handlerExport` names an export of this same
 * module file, resolved by the registry the same way every other manifest export is.
 */
export interface ModuleCustomRouteDescriptor {
  name: string;
  method: CustomRouteMethod;
  path: string;
  handlerExport: string;
  justification: CustomRouteJustification;
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
  dataMigrations?: ModuleDataMigrationDescriptor[];
  customRoutes?: ModuleCustomRouteDescriptor[];
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
  defaultViewType: z.string().min(1).optional(),
});

const moduleDataMigrationDescriptorSchema = z.object({
  databaseKey: z.string().min(1),
  fromVersion: z.string().min(1),
  toVersion: z.string().min(1),
  converterExport: z.string().min(1),
});

const moduleAgentToolDescriptorSchema = z.object({
  name: z.string().min(1),
  handlerExport: z.string().min(1),
  capability: z.string().min(1).optional(),
});

/** `path` must live under the flat `/api` namespace the issue's Task requires every custom route to mount into. */
const moduleCustomRouteDescriptorSchema = z.object({
  name: z.string().min(1),
  method: z.enum(CUSTOM_ROUTE_METHODS),
  path: z.string().regex(/^\/api\/\S*$/, 'must be a path starting with "/api/"'),
  handlerExport: z.string().min(1),
  justification: z.enum(CUSTOM_ROUTE_JUSTIFICATIONS),
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
  dataMigrations: z.array(moduleDataMigrationDescriptorSchema).optional(),
  customRoutes: z.array(moduleCustomRouteDescriptorSchema).optional(),
});
