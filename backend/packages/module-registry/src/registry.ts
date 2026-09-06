import { moduleManifestSchema, type ModuleManifest } from "./manifest.js";

export interface ModuleDatabaseProjection {
  moduleId: string;
  key: string;
  name: string;
  defaultViewType?: string;
}

export interface ModuleAgentToolProjection {
  moduleId: string;
  name: string;
  handlerExport: string;
}

export interface ModuleTaskProjection {
  moduleId: string;
  name: string;
  payloadSchemaExport: string;
  handlerExport: string;
}

export interface ModuleWorkerProjection {
  moduleId: string;
  name: string;
  handlerExport: string;
}

export interface ModuleMigrationProjection {
  moduleId: string;
  migration: string;
}

export interface ModuleDataMigrationProjection {
  moduleId: string;
  databaseKey: string;
  fromVersion: string;
  toVersion: string;
  converterExport: string;
}

/**
 * A module task's payload schema and handler resolved to the actual imported values (not
 * just the export names `ModuleTaskProjection` carries) — what a queue-registration consumer
 * needs to actually validate a payload and run the job.
 */
export interface ModuleTaskDefinition {
  moduleId: string;
  name: string;
  payloadSchema: { parse: (raw: unknown) => unknown };
  handler: (...args: unknown[]) => unknown;
}

/**
 * A module heartbeat rule kind's schema and next-fire calculator resolved to the actual
 * imported values, for the scheduler to dispatch against.
 */
export interface ModuleHeartbeatRuleKindDefinition {
  moduleId: string;
  kind: string;
  schema: { safeParse: (raw: unknown) => { success: boolean; data?: unknown; error?: { message: string } } };
  nextFireAt: (rule: unknown, timezone: string, after: Date) => Date | null;
}

/**
 * A module data migration's converter resolved to the actual imported function, for the
 * module data migration runner (issue #111) to call once per item's `properties`.
 */
export interface ModuleDataMigrationDefinition {
  moduleId: string;
  databaseKey: string;
  fromVersion: string;
  toVersion: string;
  converter: (properties: Record<string, unknown>) => Record<string, unknown>;
}

export interface ModuleRegistryOptions {
  /**
   * Task names core itself owns (`CORE_TASK_NAMES` from `@semprec/queue`). A module declaring
   * one of these fails to load — a module extends the task namespace, it never shadows core.
   */
  reservedTaskNames?: ReadonlySet<string>;
  /** Heartbeat rule kinds core itself owns (`dailyTime`, `weekly`, ...) — same override rejection as `reservedTaskNames`. */
  reservedHeartbeatRuleKinds?: ReadonlySet<string>;
}

/**
 * Resolves which module ids are currently active (`modules.active`), evaluated fresh on every
 * projection call rather than cached at load time — so deactivating a module takes effect
 * immediately without reloading anything. The actual source (system settings, env, ...) is a
 * later module-contract issue; this package only consumes it.
 */
export type ActiveModuleIdsSource = () => ReadonlySet<string> | Promise<ReadonlySet<string>>;

interface LoadedModule {
  manifest: ModuleManifest;
  exports: Record<string, unknown>;
}

/**
 * Loads modules from explicit, caller-supplied paths (never a directory scan — that's a later
 * module-contract issue) and exposes only narrow, typed, activation-filtered projections of
 * each manifest aspect. No method here returns a `ModuleManifest` itself: a consumer that
 * wants a project's databases gets database projections, one that wants agent tools gets tool
 * projections, and so on — never the raw manifest.
 */
export class ModuleRegistry {
  private readonly modulesById = new Map<string, LoadedModule>();
  private readonly moduleIdByName = new Map<string, string>();
  private readonly databaseKeyOwners = new Map<string, string>();
  private readonly taskNameOwners = new Map<string, string>();
  private readonly agentToolNameOwners = new Map<string, string>();
  private readonly workerNameOwners = new Map<string, string>();
  private readonly heartbeatRuleKindOwners = new Map<string, string>();
  private readonly reservedTaskNames: ReadonlySet<string>;
  private readonly reservedHeartbeatRuleKinds: ReadonlySet<string>;

  constructor(
    private readonly getActiveModuleIds: ActiveModuleIdsSource,
    options: ModuleRegistryOptions = {},
  ) {
    this.reservedTaskNames = options.reservedTaskNames ?? new Set();
    this.reservedHeartbeatRuleKinds = options.reservedHeartbeatRuleKinds ?? new Set();
  }

  /**
   * Imports exactly the module at `path`, validates its manifest's shape and every named
   * handler/schema export it references, and registers it. Throws synchronously on any
   * problem — a bad module must fail startup loudly, not degrade silently at runtime — and
   * never partially registers a rejected module's identifiers. Returns only the loaded
   * module's id, never the manifest itself: a caller that wants the loaded aspects reads them
   * back through the narrow projection getters below.
   */
  async loadModule(path: string): Promise<string> {
    const imported = (await import(path)) as Record<string, unknown>;
    const rawManifest = imported.manifest;
    if (rawManifest === undefined) {
      throw new Error(`Module at "${path}" does not export a "manifest"`);
    }

    const parsed = moduleManifestSchema.safeParse(rawManifest);
    if (!parsed.success) {
      throw new Error(`Module at "${path}" has an invalid manifest: ${parsed.error.message}`);
    }
    const manifest = parsed.data;

    if (this.modulesById.has(manifest.id)) {
      throw new Error(`Duplicate module id "${manifest.id}" loading "${path}"`);
    }
    const existingIdForName = this.moduleIdByName.get(manifest.name);
    if (existingIdForName !== undefined) {
      throw new Error(`Duplicate module name "${manifest.name}" loading "${path}" (already used by module "${existingIdForName}")`);
    }

    this.assertExportsExist(path, manifest, imported);
    this.assertDataMigrationsReferenceOwnDatabases(path, manifest);
    this.claimCrossModuleIdentifiers(path, manifest);

    this.modulesById.set(manifest.id, { manifest, exports: imported });
    this.moduleIdByName.set(manifest.name, manifest.id);
    return manifest.id;
  }

  private assertExportsExist(path: string, manifest: ModuleManifest, imported: Record<string, unknown>): void {
    for (const tool of manifest.agentTools) {
      this.requireFunctionExport(imported, tool.handlerExport, path, `agent tool "${tool.name}"`);
    }
    for (const task of manifest.taskNames ?? []) {
      this.requireExport(imported, task.payloadSchemaExport, path, `task "${task.name}"`);
      this.requireFunctionExport(imported, task.handlerExport, path, `task "${task.name}"`);
    }
    for (const worker of manifest.workers ?? []) {
      this.requireFunctionExport(imported, worker.handlerExport, path, `worker "${worker.name}"`);
    }
    for (const ruleKind of manifest.heartbeatRuleKinds ?? []) {
      this.requireSchemaExport(imported, ruleKind.schemaExport, path, `heartbeat rule kind "${ruleKind.kind}"`);
      this.requireFunctionExport(imported, ruleKind.nextFireAtExport, path, `heartbeat rule kind "${ruleKind.kind}"`);
    }
    for (const dataMigration of manifest.dataMigrations ?? []) {
      const label = `data migration "${dataMigration.databaseKey}" (${dataMigration.fromVersion} -> ${dataMigration.toVersion})`;
      this.requireFunctionExport(imported, dataMigration.converterExport, path, label);
    }
  }

  /**
   * A data migration's `databaseKey` must name one of this same manifest's own databases —
   * a module has no business declaring a data migration for a database it doesn't own.
   * Checked separately from `claimCrossModuleIdentifiers` (which only ever compares against
   * *other* modules' claims) since this is a same-manifest, internal-consistency check.
   */
  private assertDataMigrationsReferenceOwnDatabases(path: string, manifest: ModuleManifest): void {
    const ownDatabaseKeys = new Set(manifest.databases.map((db) => db.key));
    const seen = new Set<string>();
    for (const dataMigration of manifest.dataMigrations ?? []) {
      if (!ownDatabaseKeys.has(dataMigration.databaseKey)) {
        throw new Error(
          `Data migration loading "${path}" targets database key "${dataMigration.databaseKey}", which this manifest does not declare in "databases"`,
        );
      }
      const key = `${dataMigration.databaseKey}:${dataMigration.fromVersion}:${dataMigration.toVersion}`;
      if (seen.has(key)) {
        throw new Error(
          `Duplicate data migration for database key "${dataMigration.databaseKey}" (${dataMigration.fromVersion} -> ${dataMigration.toVersion}) loading "${path}"`,
        );
      }
      seen.add(key);
    }
  }

  private requireExport(imported: Record<string, unknown>, exportName: string, path: string, context: string): unknown {
    if (!(exportName in imported) || imported[exportName] === undefined) {
      throw new Error(`Module at "${path}" ${context} references missing export "${exportName}"`);
    }
    return imported[exportName];
  }

  private requireFunctionExport(imported: Record<string, unknown>, exportName: string, path: string, context: string): void {
    const value = this.requireExport(imported, exportName, path, context);
    if (typeof value !== "function") {
      throw new Error(`Module at "${path}" ${context} export "${exportName}" is not a function`);
    }
  }

  /**
   * A `schemaExport` must structurally look like a zod-style schema (a `safeParse` method) —
   * checked here, at load time, so a module that points `schemaExport` at the wrong export
   * fails startup loudly instead of surfacing as a confusing `TypeError` deep inside
   * `parseHeartbeatRule` the first time a rule of that kind is actually validated.
   */
  private requireSchemaExport(imported: Record<string, unknown>, exportName: string, path: string, context: string): void {
    const value = this.requireExport(imported, exportName, path, context);
    if (typeof value !== "object" || value === null || typeof (value as { safeParse?: unknown }).safeParse !== "function") {
      throw new Error(`Module at "${path}" ${context} export "${exportName}" is not a schema (missing a "safeParse" method)`);
    }
  }

  /**
   * Checks every identifier this manifest would claim against every owner map *before*
   * mutating any of them, then commits all claims together — so a module that collides on,
   * say, its second database key never leaves its first database key registered as owned by
   * a module that was ultimately rejected and never added to `modulesById`.
   */
  private claimCrossModuleIdentifiers(path: string, manifest: ModuleManifest): void {
    const claims: Array<{ owners: Map<string, string>; key: string; label: string; reserved?: ReadonlySet<string> }> = [
      ...manifest.databases.map((db) => ({ owners: this.databaseKeyOwners, key: db.key, label: "database key" })),
      ...manifest.agentTools.map((tool) => ({ owners: this.agentToolNameOwners, key: tool.name, label: "agent tool name" })),
      ...(manifest.taskNames ?? []).map((task) => ({
        owners: this.taskNameOwners,
        key: task.name,
        label: "task name",
        reserved: this.reservedTaskNames,
      })),
      ...(manifest.workers ?? []).map((worker) => ({ owners: this.workerNameOwners, key: worker.name, label: "worker name" })),
      ...(manifest.heartbeatRuleKinds ?? []).map((ruleKind) => ({
        owners: this.heartbeatRuleKindOwners,
        key: ruleKind.kind,
        label: "heartbeat rule kind",
        reserved: this.reservedHeartbeatRuleKinds,
      })),
    ];

    // Two entries of the same kind declared twice within this one manifest (e.g. two
    // databases with the same key) collide with each other, not with any prior module — the
    // owner maps alone can't see that until something is actually committed.
    const seenInThisManifest = new Set<string>();
    for (const { owners, key, label, reserved } of claims) {
      if (reserved?.has(key)) {
        throw new Error(`${label} "${key}" loading "${path}" collides with a core-reserved ${label}`);
      }
      const existingOwner = owners.get(key);
      if (existingOwner !== undefined) {
        throw new Error(`Duplicate ${label} "${key}" loading "${path}" (already claimed by module "${existingOwner}")`);
      }
      const seenKey = `${label}:${key}`;
      if (seenInThisManifest.has(seenKey)) {
        throw new Error(`Duplicate ${label} "${key}" loading "${path}" (declared twice in the same manifest)`);
      }
      seenInThisManifest.add(seenKey);
    }

    for (const { owners, key } of claims) {
      owners.set(key, manifest.id);
    }
  }

  private async getActiveModules(): Promise<LoadedModule[]> {
    const activeIds = await this.getActiveModuleIds();
    return [...this.modulesById.values()].filter((loaded) => activeIds.has(loaded.manifest.id));
  }

  listModuleIds(): string[] {
    return [...this.modulesById.keys()];
  }

  async listActiveModuleIds(): Promise<string[]> {
    return (await this.getActiveModules()).map((loaded) => loaded.manifest.id);
  }

  isRemovable(moduleId: string): boolean {
    return this.modulesById.get(moduleId)?.manifest.removable ?? false;
  }

  async getDatabases(): Promise<ModuleDatabaseProjection[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) =>
      loaded.manifest.databases.map((db) => ({
        moduleId: loaded.manifest.id,
        key: db.key,
        name: db.name,
        ...(db.defaultViewType !== undefined ? { defaultViewType: db.defaultViewType } : {}),
      })),
    );
  }

  async getCapabilities(): Promise<string[]> {
    const active = await this.getActiveModules();
    return [...new Set(active.flatMap((loaded) => loaded.manifest.capabilities))];
  }

  /**
   * `grantedCapabilities` is the set of capabilities actually granted in the current context
   * (a later module-contract issue wires this to real grants). A tool whose `capability` isn't
   * in that set is filtered out entirely, never returned in a denied state.
   */
  async getAgentTools(grantedCapabilities: ReadonlySet<string>): Promise<ModuleAgentToolProjection[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) =>
      loaded.manifest.agentTools
        .filter((tool) => tool.capability === undefined || grantedCapabilities.has(tool.capability))
        .map((tool) => ({ moduleId: loaded.manifest.id, name: tool.name, handlerExport: tool.handlerExport })),
    );
  }

  async getViewTypes(): Promise<string[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) => loaded.manifest.viewTypes ?? []);
  }

  async getHeartbeatActions(): Promise<string[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) => loaded.manifest.heartbeatActions ?? []);
  }

  async getHeartbeatRuleKinds(): Promise<string[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) => (loaded.manifest.heartbeatRuleKinds ?? []).map((ruleKind) => ruleKind.kind));
  }

  /**
   * Resolves each active module's declared heartbeat rule kinds to their actual imported
   * schema/next-fire-calculator values, for the scheduler to validate and dispatch against.
   */
  async getHeartbeatRuleKindDefinitions(): Promise<ModuleHeartbeatRuleKindDefinition[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) =>
      (loaded.manifest.heartbeatRuleKinds ?? []).map((ruleKind) => ({
        moduleId: loaded.manifest.id,
        kind: ruleKind.kind,
        schema: loaded.exports[ruleKind.schemaExport] as ModuleHeartbeatRuleKindDefinition["schema"],
        nextFireAt: loaded.exports[ruleKind.nextFireAtExport] as ModuleHeartbeatRuleKindDefinition["nextFireAt"],
      })),
    );
  }

  async getTasks(): Promise<ModuleTaskProjection[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) => (loaded.manifest.taskNames ?? []).map((task) => ({ moduleId: loaded.manifest.id, ...task })));
  }

  /**
   * Resolves each active module's declared tasks to their actual imported payload-schema/handler
   * values, for the queue to register and dispatch against.
   */
  async getTaskDefinitions(): Promise<ModuleTaskDefinition[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) =>
      (loaded.manifest.taskNames ?? []).map((task) => ({
        moduleId: loaded.manifest.id,
        name: task.name,
        payloadSchema: loaded.exports[task.payloadSchemaExport] as ModuleTaskDefinition["payloadSchema"],
        handler: loaded.exports[task.handlerExport] as ModuleTaskDefinition["handler"],
      })),
    );
  }

  async getWorkers(): Promise<ModuleWorkerProjection[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) => (loaded.manifest.workers ?? []).map((worker) => ({ moduleId: loaded.manifest.id, ...worker })));
  }

  async getMigrations(): Promise<ModuleMigrationProjection[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) => (loaded.manifest.migrations ?? []).map((migration) => ({ moduleId: loaded.manifest.id, migration })));
  }

  async getDataMigrations(): Promise<ModuleDataMigrationProjection[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) =>
      (loaded.manifest.dataMigrations ?? []).map((dataMigration) => ({ moduleId: loaded.manifest.id, ...dataMigration })),
    );
  }

  /**
   * Resolves each active module's declared data migrations to their actual imported
   * converter function, for the module data migration runner (issue #111) to execute.
   */
  async getDataMigrationDefinitions(): Promise<ModuleDataMigrationDefinition[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) =>
      (loaded.manifest.dataMigrations ?? []).map((dataMigration) => ({
        moduleId: loaded.manifest.id,
        databaseKey: dataMigration.databaseKey,
        fromVersion: dataMigration.fromVersion,
        toVersion: dataMigration.toVersion,
        converter: loaded.exports[dataMigration.converterExport] as ModuleDataMigrationDefinition["converter"],
      })),
    );
  }

  async getSystemProjectModuleIds(): Promise<string[]> {
    const active = await this.getActiveModules();
    return active.filter((loaded) => loaded.manifest.systemProject).map((loaded) => loaded.manifest.id);
  }
}
