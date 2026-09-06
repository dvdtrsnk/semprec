import { moduleManifestSchema, type ModuleManifest } from "./manifest.js";

export interface ModuleDatabaseProjection {
  moduleId: string;
  key: string;
  name: string;
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

  constructor(private readonly getActiveModuleIds: ActiveModuleIdsSource) {}

  /**
   * Imports exactly the module at `path`, validates its manifest's shape and every named
   * handler/schema export it references, and registers it. Throws synchronously on any
   * problem — a bad module must fail startup loudly, not degrade silently at runtime.
   */
  async loadModule(path: string): Promise<ModuleManifest> {
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
    this.claimCrossModuleIdentifiers(path, manifest);

    this.modulesById.set(manifest.id, { manifest, exports: imported });
    this.moduleIdByName.set(manifest.name, manifest.id);
    return manifest;
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

  private claimCrossModuleIdentifiers(path: string, manifest: ModuleManifest): void {
    for (const db of manifest.databases) {
      this.claim(this.databaseKeyOwners, db.key, "database key", manifest.id, path);
    }
    for (const tool of manifest.agentTools) {
      this.claim(this.agentToolNameOwners, tool.name, "agent tool name", manifest.id, path);
    }
    for (const task of manifest.taskNames ?? []) {
      this.claim(this.taskNameOwners, task.name, "task name", manifest.id, path);
    }
    for (const worker of manifest.workers ?? []) {
      this.claim(this.workerNameOwners, worker.name, "worker name", manifest.id, path);
    }
  }

  private claim(owners: Map<string, string>, key: string, label: string, moduleId: string, path: string): void {
    const existingOwner = owners.get(key);
    if (existingOwner !== undefined) {
      throw new Error(`Duplicate ${label} "${key}" loading "${path}" (already claimed by module "${existingOwner}")`);
    }
    owners.set(key, moduleId);
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
    return active.flatMap((loaded) => loaded.manifest.databases.map((db) => ({ moduleId: loaded.manifest.id, key: db.key, name: db.name })));
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
    return active.flatMap((loaded) => loaded.manifest.heartbeatRuleKinds ?? []);
  }

  async getTasks(): Promise<ModuleTaskProjection[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) => (loaded.manifest.taskNames ?? []).map((task) => ({ moduleId: loaded.manifest.id, ...task })));
  }

  async getWorkers(): Promise<ModuleWorkerProjection[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) => (loaded.manifest.workers ?? []).map((worker) => ({ moduleId: loaded.manifest.id, ...worker })));
  }

  async getMigrations(): Promise<ModuleMigrationProjection[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) => (loaded.manifest.migrations ?? []).map((migration) => ({ moduleId: loaded.manifest.id, migration })));
  }

  async getSystemProjectModuleIds(): Promise<string[]> {
    const active = await this.getActiveModules();
    return active.filter((loaded) => loaded.manifest.systemProject).map((loaded) => loaded.manifest.id);
  }
}
