import { loadModuleCatalogs, type ModuleCatalogs } from "./catalog.js";
import { z } from "zod";
import { CAPABILITY_IDS, type RiskClass } from "@semprec/shared";
import {
  moduleManifestSchema,
  type CustomRouteMethod,
  type EditorSchemaDescriptor,
  type ModuleDatabaseDescriptor,
  type ModuleLinkRuleDescriptor,
  type ModuleResolverLinkRuleDescriptor,
  type ModuleManifest,
  type ModuleRelatedOrderDescriptor,
  type ModuleTaskAffinity,
} from "./manifest.js";

export interface ModuleLinkRuleProjection extends ModuleLinkRuleDescriptor {
  moduleId: string;
}

/** A resolver rule of an active module. `resolver` is checked only to be an object; the caller that runs it validates its shape. */
export interface ModuleLinkResolverRuleProjection {
  moduleId: string;
  key: string;
  target: ModuleLinkRuleDescriptor["target"];
  resolver: object;
}

function isViaLinkRule(
  rule: ModuleLinkRuleDescriptor | ModuleResolverLinkRuleDescriptor,
): rule is ModuleLinkRuleDescriptor {
  return "via" in rule;
}

/** A module's editor schema for one base kind, of an active module. */
export interface ModuleEditorSchemaProjection {
  moduleId: string;
  baseKind: string;
  schema: EditorSchemaDescriptor;
}

export interface ModuleDatabaseProjection {
  moduleId: string;
  key: string;
  name: string;
  defaultViewType?: string;
  searchFields?: string[];
  relatedOrder?: ModuleRelatedOrderDescriptor;
  icon?: string;
  color?: string;
  overviewOrder?: number | null;
  switcherOrder?: number | null;
  clientVisible?: boolean;
  overviewHideable?: boolean;
  quickFilters?: ModuleDatabaseDescriptor["quickFilters"];
  defaultSort?: ModuleDatabaseDescriptor["defaultSort"];
  dateLabels?: ModuleDatabaseDescriptor["dateLabels"];
  collectionFilter?: ModuleDatabaseDescriptor["collectionFilter"];
  pickerFilter?: ModuleDatabaseDescriptor["pickerFilter"];
  facetBarProperty?: ModuleDatabaseDescriptor["facetBarProperty"];
}

export interface ModuleAgentToolProjection {
  moduleId: string;
  name: string;
  handlerExport: string;
}

export interface ModuleAgentToolDefinition {
  moduleId: string;
  name: string;
  /** The declared capability; absent for a tool that needs none. */
  capability?: string;
  handler: unknown;
  /** Set for a tool declared with `mcp`: the resolved `humanHandlerExport`, untyped like `handler`. */
  mcp?: { humanHandler: unknown };
  argumentSchema: Record<string, unknown>;
  parseArguments: (value: unknown) => { success: true; data: unknown } | { success: false };
  /** `true` for a tool declared with `requiresApproval`; such a tool is returned only on request. */
  requiresApproval?: boolean;
  /** The declared risk class; absent when the manifest declares none. */
  riskClass?: RiskClass;
  /** Set with `requiresApproval`: the resolved `snapshotExport`, untyped like `handler`; absent when none is declared. */
  snapshot?: unknown;
}

export interface ModuleTaskProjection {
  moduleId: string;
  name: string;
  payloadSchemaExport: string;
  handlerExport: string;
  queueAffinity: ModuleTaskAffinity;
}

export interface ModuleWorkerProjection {
  moduleId: string;
  name: string;
  handlerExport: string;
}

/**
 * A custom route with its `handlerExport` resolved, left `unknown`: `semprec-api` casts it to its
 * own handler-factory shape, so this package does not depend on its HTTP types.
 */
export interface ModuleCustomRouteDefinition {
  moduleId: string;
  name: string;
  method: CustomRouteMethod;
  path: string;
  handler: unknown;
  maxBodyBytes?: number;
}

export interface ModuleMigrationProjection {
  moduleId: string;
  migration: string;
}

/** A module task's payload schema and handler resolved to the imported values. */
export interface ModuleTaskDefinition {
  moduleId: string;
  name: string;
  payloadSchema: { parse: (raw: unknown) => unknown };
  handler: (...args: unknown[]) => unknown;
  queueAffinity: ModuleTaskAffinity;
}

/** A module heartbeat rule kind's schema and next-fire calculator resolved to the imported values. */
export interface ModuleHeartbeatRuleKindDefinition {
  moduleId: string;
  kind: string;
  schema: { safeParse: (raw: unknown) => { success: boolean; data?: unknown; error?: { message: string } } };
  nextFireAt: (rule: unknown, timezone: string, after: Date) => Date | null;
}

export interface ModuleRegistryOptions {
  /** Task names core owns (`CORE_TASK_NAMES`); a module declaring one fails to load. */
  reservedTaskNames?: ReadonlySet<string>;
  /** Heartbeat rule kinds core owns (`dailyTime`, `weekly`, ...); same rejection as `reservedTaskNames`. */
  reservedHeartbeatRuleKinds?: ReadonlySet<string>;
}

/**
 * Resolves the active module ids, evaluated on every projection call rather than cached, so
 * deactivating a module takes effect immediately.
 */
export type ActiveModuleIdsSource = () => ReadonlySet<string> | Promise<ReadonlySet<string>>;

interface LoadedModule {
  manifest: ModuleManifest;
  exports: Record<string, unknown>;
}

/**
 * Loads modules from explicit paths (never a directory scan) and exposes only narrow,
 * activation-filtered projections of each manifest aspect, never a `ModuleManifest` itself.
 */
export class ModuleRegistry {
  private readonly modulesById = new Map<string, LoadedModule>();
  private readonly moduleIdByName = new Map<string, string>();
  private readonly databaseKeyOwners = new Map<string, string>();
  private readonly taskNameOwners = new Map<string, string>();
  private readonly agentToolNameOwners = new Map<string, string>();
  private readonly workerNameOwners = new Map<string, string>();
  private readonly heartbeatRuleKindOwners = new Map<string, string>();
  /** Keyed by `"<method> <path>"`. */
  private readonly customRouteOwners = new Map<string, string>();
  /** Keyed by a card's base kind; one owner per base kind across every loaded module. */
  private readonly editorSchemaBaseKindOwners = new Map<string, string>();
  private readonly linkRuleKeyOwners = new Map<string, string>();
  private readonly catalogsById = new Map<string, ModuleCatalogs>();
  private readonly catalogKeyOwners = new Map<string, string>();
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
   * Imports the module at `path`, validates its manifest and every export it references, and
   * registers it. Throws on any problem so a bad module fails startup, and never partially
   * registers a rejected module's identifiers. Returns only the module id.
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
      throw new Error(
        `Duplicate module name "${manifest.name}" loading "${path}" (already used by module "${existingIdForName}")`,
      );
    }

    this.assertExportsExist(path, manifest, imported);

    const catalogs = await loadModuleCatalogs(path);

    this.assertCatalogKeysAvailable(path, catalogs);
    this.assertCustomRoutesAvailable(path, manifest);
    this.assertEditorSchemaBaseKindsAvailable(path, manifest);
    this.claimCrossModuleIdentifiers(path, manifest);
    this.commitCatalogKeys(manifest.id, catalogs);
    this.commitCustomRoutes(manifest);
    this.commitEditorSchemaBaseKinds(manifest);

    this.modulesById.set(manifest.id, { manifest, exports: imported });
    this.moduleIdByName.set(manifest.name, manifest.id);
    this.catalogsById.set(manifest.id, catalogs);
    return manifest.id;
  }

  private assertExportsExist(path: string, manifest: ModuleManifest, imported: Record<string, unknown>): void {
    for (const tool of manifest.agentTools) {
      this.requireFunctionExport(imported, tool.handlerExport, path, `agent tool "${tool.name}"`);
      if (tool.snapshotExport !== undefined)
        this.requireFunctionExport(imported, tool.snapshotExport, path, `agent tool "${tool.name}" snapshot`);
      const schema = this.requireExport(imported, tool.argumentSchemaExport, path, `agent tool "${tool.name}"`);
      if (!(schema instanceof z.ZodType))
        throw new Error(`Module at "${path}" agent tool "${tool.name}" has invalid argument schema`);
      z.toJSONSchema(schema);
      if (tool.mcp !== undefined)
        this.requireFunctionExport(
          imported,
          tool.mcp.humanHandlerExport,
          path,
          `agent tool "${tool.name}" human handler`,
        );
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
    for (const route of manifest.customRoutes ?? []) {
      this.requireFunctionExport(imported, route.handlerExport, path, `custom route "${route.name}"`);
    }
    for (const rule of manifest.linkRules ?? []) {
      if (isViaLinkRule(rule)) continue;
      const resolver = this.requireExport(imported, rule.resolverExport, path, `link rule "${rule.key}"`);
      if (typeof resolver !== "object" || resolver === null)
        throw new Error(`Module at "${path}" link rule "${rule.key}" export "${rule.resolverExport}" is not an object`);
    }
  }

  /**
   * A custom route's `method`+`path` may be claimed once across all loaded modules, checked
   * before anything commits. Separate from `claimCrossModuleIdentifiers` so the error names both
   * owning module ids.
   */
  private assertCustomRoutesAvailable(path: string, manifest: ModuleManifest): void {
    const seenInThisManifest = new Map<string, string>();
    for (const route of manifest.customRoutes ?? []) {
      const key = `${route.method} ${route.path}`;
      const existingOwner = this.customRouteOwners.get(key);
      if (existingOwner !== undefined) {
        throw new Error(
          `Duplicate custom route "${key}" loading "${path}": module "${manifest.id}" and module "${existingOwner}" both register it`,
        );
      }
      const seenName = seenInThisManifest.get(key);
      if (seenName !== undefined) {
        throw new Error(
          `Duplicate custom route "${key}" declared twice in module "${manifest.id}" (routes "${seenName}" and "${route.name}")`,
        );
      }
      seenInThisManifest.set(key, route.name);
    }
  }

  private commitCustomRoutes(manifest: ModuleManifest): void {
    for (const route of manifest.customRoutes ?? []) {
      this.customRouteOwners.set(`${route.method} ${route.path}`, manifest.id);
    }
  }

  /**
   * A base kind may be declared by one loaded module only, active or not; checked before anything
   * commits so a rejected module never leaves a base kind claimed.
   */
  private assertEditorSchemaBaseKindsAvailable(path: string, manifest: ModuleManifest): void {
    for (const baseKind of Object.keys(manifest.editorSchemas ?? {})) {
      const existingOwner = this.editorSchemaBaseKindOwners.get(baseKind);
      if (existingOwner !== undefined) {
        throw new Error(
          `Duplicate editor schema base kind "${baseKind}" loading "${path}": module "${manifest.id}" and module "${existingOwner}" both declare it`,
        );
      }
    }
  }

  private commitEditorSchemaBaseKinds(manifest: ModuleManifest): void {
    for (const baseKind of Object.keys(manifest.editorSchemas ?? {})) {
      this.editorSchemaBaseKindOwners.set(baseKind, manifest.id);
    }
  }

  /**
   * A catalog key may be claimed by one module only, checked against every loaded module's
   * `cs`/`en` catalogs before anything about this module is committed.
   */
  private assertCatalogKeysAvailable(path: string, catalogs: ModuleCatalogs): void {
    for (const key of new Set([...Object.keys(catalogs.cs), ...Object.keys(catalogs.en)])) {
      const existingOwner = this.catalogKeyOwners.get(key);
      if (existingOwner !== undefined) {
        throw new Error(
          `Duplicate i18n catalog key "${key}" loading "${path}" (already claimed by module "${existingOwner}")`,
        );
      }
    }
  }

  private commitCatalogKeys(moduleId: string, catalogs: ModuleCatalogs): void {
    for (const key of new Set([...Object.keys(catalogs.cs), ...Object.keys(catalogs.en)])) {
      this.catalogKeyOwners.set(key, moduleId);
    }
  }

  private requireExport(imported: Record<string, unknown>, exportName: string, path: string, context: string): unknown {
    if (!(exportName in imported) || imported[exportName] === undefined) {
      throw new Error(`Module at "${path}" ${context} references missing export "${exportName}"`);
    }
    return imported[exportName];
  }

  private requireFunctionExport(
    imported: Record<string, unknown>,
    exportName: string,
    path: string,
    context: string,
  ): void {
    const value = this.requireExport(imported, exportName, path, context);
    if (typeof value !== "function") {
      throw new Error(`Module at "${path}" ${context} export "${exportName}" is not a function`);
    }
  }

  /**
   * A `schemaExport` must look like a zod schema (a `safeParse` method), so a wrong export fails at
   * load instead of as a `TypeError` inside `parseHeartbeatRule` later.
   */
  private requireSchemaExport(
    imported: Record<string, unknown>,
    exportName: string,
    path: string,
    context: string,
  ): void {
    const value = this.requireExport(imported, exportName, path, context);
    if (
      typeof value !== "object" ||
      value === null ||
      typeof (value as { safeParse?: unknown }).safeParse !== "function"
    ) {
      throw new Error(
        `Module at "${path}" ${context} export "${exportName}" is not a schema (missing a "safeParse" method)`,
      );
    }
  }

  /**
   * Checks every identifier this manifest would claim against every owner map before mutating any,
   * then commits all claims together, so a rejected module leaves nothing registered.
   */
  private claimCrossModuleIdentifiers(path: string, manifest: ModuleManifest): void {
    const claims: Array<{ owners: Map<string, string>; key: string; label: string; reserved?: ReadonlySet<string> }> = [
      ...manifest.databases.map((db) => ({ owners: this.databaseKeyOwners, key: db.key, label: "database key" })),
      ...manifest.agentTools.map((tool) => ({
        owners: this.agentToolNameOwners,
        key: tool.name,
        label: "agent tool name",
      })),
      ...(manifest.taskNames ?? []).map((task) => ({
        owners: this.taskNameOwners,
        key: task.name,
        label: "task name",
        reserved: this.reservedTaskNames,
      })),
      ...(manifest.workers ?? []).map((worker) => ({
        owners: this.workerNameOwners,
        key: worker.name,
        label: "worker name",
      })),
      ...(manifest.heartbeatRuleKinds ?? []).map((ruleKind) => ({
        owners: this.heartbeatRuleKindOwners,
        key: ruleKind.kind,
        label: "heartbeat rule kind",
        reserved: this.reservedHeartbeatRuleKinds,
      })),
      ...(manifest.linkRules ?? []).map((rule) => ({
        owners: this.linkRuleKeyOwners,
        key: rule.key,
        label: "link rule key",
      })),
    ];

    // Duplicates within this one manifest collide with each other, which the owner maps cannot see before commit.
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
        ...(db.searchFields !== undefined ? { searchFields: [...db.searchFields] } : {}),
        ...(db.relatedOrder !== undefined ? { relatedOrder: structuredClone(db.relatedOrder) } : {}),
        ...(db.icon !== undefined ? { icon: db.icon } : {}),
        ...(db.color !== undefined ? { color: db.color } : {}),
        ...(db.overviewOrder !== undefined ? { overviewOrder: db.overviewOrder } : {}),
        ...(db.switcherOrder !== undefined ? { switcherOrder: db.switcherOrder } : {}),
        ...(db.clientVisible !== undefined ? { clientVisible: db.clientVisible } : {}),
        ...(db.overviewHideable !== undefined ? { overviewHideable: db.overviewHideable } : {}),
        ...(db.quickFilters !== undefined ? { quickFilters: structuredClone(db.quickFilters) } : {}),
        ...(db.defaultSort !== undefined ? { defaultSort: structuredClone(db.defaultSort) } : {}),
        ...(db.dateLabels !== undefined ? { dateLabels: structuredClone(db.dateLabels) } : {}),
        ...(db.collectionFilter !== undefined ? { collectionFilter: structuredClone(db.collectionFilter) } : {}),
        ...(db.pickerFilter !== undefined ? { pickerFilter: structuredClone(db.pickerFilter) } : {}),
        ...(db.facetBarProperty !== undefined ? { facetBarProperty: db.facetBarProperty } : {}),
      })),
    );
  }

  /** Declared related order of an active database, retaining only known, active database keys. */
  async getRelatedOrder(databaseKey: string): Promise<Required<ModuleRelatedOrderDescriptor> | undefined> {
    const databases = await this.getDatabases();
    const declared = databases.find((db) => db.key === databaseKey)?.relatedOrder;
    if (declared === undefined) return undefined;
    const activeKeys = new Set(databases.map((db) => db.key));
    return {
      order: declared.order.filter((key) => activeKeys.has(key)),
      omit: (declared.omit ?? []).filter((key) => activeKeys.has(key)),
    };
  }

  /** Via link rules of active modules, in load order then manifest order. A rule without a `valueFilter` has no such key. */
  async getLinkRules(): Promise<ModuleLinkRuleProjection[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) =>
      (loaded.manifest.linkRules ?? []).filter(isViaLinkRule).map((rule) => ({
        moduleId: loaded.manifest.id,
        key: rule.key,
        source: { ...rule.source },
        target: { ...rule.target },
        via: { ...rule.via },
        ...(rule.valueFilter ? { valueFilter: { omit: { ...rule.valueFilter.omit } } } : {}),
      })),
    );
  }

  /** Resolver link rules of active modules, in load order then manifest order. */
  async getLinkResolverRules(): Promise<ModuleLinkResolverRuleProjection[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) =>
      (loaded.manifest.linkRules ?? []).flatMap((rule) => {
        if (isViaLinkRule(rule)) return [];
        const resolver = loaded.exports[rule.resolverExport];
        if (typeof resolver !== "object" || resolver === null)
          throw new Error(`Link rule "${rule.key}" resolver export is not an object`);
        return [{ moduleId: loaded.manifest.id, key: rule.key, target: { ...rule.target }, resolver }];
      }),
    );
  }

  /**
   * Validates all loaded modules' link rules together (active or not), since a rule may name
   * another module's database. Throws on an unknown database key, a `via` database that is neither
   * the source's nor the target's, or a cycle in the property graph (node per
   * `databaseKey.propertyKey`, edge per via rule). A resolver rule is checked for its target only.
   * `valueFilter` keys name a singleton system database no manifest declares, so only the manifest
   * schema and `@semprec/data`'s seeded-schema drift check cover them.
   */
  validateLinkRules(): void {
    const allRules = [...this.modulesById.values()].flatMap((loaded) => loaded.manifest.linkRules ?? []);
    for (const rule of allRules) {
      if (!isViaLinkRule(rule) && !this.databaseKeyOwners.has(rule.target.databaseKey))
        throw new Error(`Link rule "${rule.key}" target names unknown database key "${rule.target.databaseKey}"`);
    }
    const rules = allRules.filter(isViaLinkRule);
    for (const rule of rules) {
      for (const [role, databaseKey] of [
        ["source", rule.source.databaseKey],
        ["target", rule.target.databaseKey],
        ["via", rule.via.databaseKey],
      ] as const) {
        if (!this.databaseKeyOwners.has(databaseKey)) {
          throw new Error(`Link rule "${rule.key}" ${role} names unknown database key "${databaseKey}"`);
        }
      }
      if (rule.via.databaseKey !== rule.source.databaseKey && rule.via.databaseKey !== rule.target.databaseKey) {
        throw new Error(
          `Link rule "${rule.key}" via database "${rule.via.databaseKey}" is neither its source database "${rule.source.databaseKey}" nor its target database "${rule.target.databaseKey}"`,
        );
      }
    }

    const nodeOf = (endpoint: { databaseKey: string; propertyKey: string }): string =>
      `${endpoint.databaseKey}.${endpoint.propertyKey}`;
    const outgoing = new Map<string, Array<{ rule: string; to: string }>>();
    for (const rule of rules) {
      const from = nodeOf(rule.source);
      const edges = outgoing.get(from) ?? [];
      edges.push({ rule: rule.key, to: nodeOf(rule.target) });
      outgoing.set(from, edges);
    }

    const done = new Set<string>();
    const stack: Array<{ node: string; viaRule: string }> = [];
    const visit = (node: string, viaRule: string): void => {
      const onStackAt = stack.findIndex((entry) => entry.node === node);
      if (onStackAt !== -1) {
        const cycleRules = [...stack.slice(onStackAt + 1).map((entry) => entry.viaRule), viaRule];
        throw new Error(`Link rules form a cycle: ${cycleRules.map((key) => `"${key}"`).join(" -> ")}`);
      }
      if (done.has(node)) return;
      stack.push({ node, viaRule });
      for (const edge of outgoing.get(node) ?? []) visit(edge.to, edge.rule);
      stack.pop();
      done.add(node);
    };
    for (const node of outgoing.keys()) visit(node, "");
  }

  async getCapabilities(): Promise<string[]> {
    const active = await this.getActiveModules();
    return [...new Set(active.flatMap((loaded) => loaded.manifest.capabilities))];
  }

  async getModuleCapabilityDeclarations(): Promise<
    { moduleId: string; capabilities: string[]; databaseKeys: string[] }[]
  > {
    const active = await this.getActiveModules();
    return active.map(({ manifest }) => ({
      moduleId: manifest.id,
      capabilities: [...manifest.capabilities],
      databaseKeys: manifest.databases.map((db) => db.key),
    }));
  }

  async getActiveAgentToolNames(): Promise<string[]> {
    const active = await this.getActiveModules();
    return active.flatMap(({ manifest }) => manifest.agentTools.map((tool) => tool.name));
  }

  /**
   * The agent tools of active modules whose capability is granted. `requiresApproval` tools are
   * left out unless `options.includeApprovalGated`, so a caller that cannot defer a call to an
   * approval request never runs one directly. Other tools are returned when `approval` is `none`.
   */
  async getAgentToolDefinitions(
    grantedCapabilities: ReadonlySet<string>,
    options: { includeApprovalGated?: boolean } = {},
  ): Promise<ModuleAgentToolDefinition[]> {
    const active = await this.getActiveModules();
    return active.flatMap(({ manifest, exports }) =>
      manifest.agentTools
        .filter(
          (tool) =>
            (tool.requiresApproval === true ? options.includeApprovalGated === true : tool.approval === "none") &&
            (tool.capability === undefined ||
              (grantedCapabilities.has(tool.capability) &&
                (manifest.capabilities.includes(tool.capability) ||
                  CAPABILITY_IDS.some((id) => id === tool.capability)))),
        )
        .map((tool) => {
          const schema = exports[tool.argumentSchemaExport];
          const handler = exports[tool.handlerExport];
          const snapshot = tool.snapshotExport === undefined ? undefined : exports[tool.snapshotExport];
          const humanHandler = tool.mcp === undefined ? undefined : exports[tool.mcp.humanHandlerExport];
          if (!(schema instanceof z.ZodType) || typeof handler !== "function")
            throw new Error(`Invalid agent tool exports for ${tool.name}`);
          if (tool.mcp !== undefined && typeof humanHandler !== "function")
            throw new Error(`Invalid agent tool human handler for ${tool.name}`);
          return {
            moduleId: manifest.id,
            name: tool.name,
            ...(tool.capability === undefined ? {} : { capability: tool.capability }),
            ...(tool.mcp === undefined ? {} : { mcp: { humanHandler } }),
            handler,
            argumentSchema: z.toJSONSchema(schema),
            parseArguments: (value: unknown) => {
              const result = schema.safeParse(value);
              return result.success ? { success: true as const, data: result.data } : { success: false as const };
            },
            ...(tool.riskClass === undefined ? {} : { riskClass: tool.riskClass }),
            ...(tool.requiresApproval === true
              ? { requiresApproval: true as const, ...(snapshot === undefined ? {} : { snapshot }) }
              : {}),
          };
        }),
    );
  }

  /** A tool whose `capability` is not in `grantedCapabilities` is left out entirely, never returned denied. */
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
    return active.flatMap((loaded) =>
      (loaded.manifest.taskNames ?? []).map((task) => ({ moduleId: loaded.manifest.id, ...task })),
    );
  }

  async getTaskDefinitions(): Promise<ModuleTaskDefinition[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) =>
      (loaded.manifest.taskNames ?? []).map((task) => ({
        moduleId: loaded.manifest.id,
        name: task.name,
        payloadSchema: loaded.exports[task.payloadSchemaExport] as ModuleTaskDefinition["payloadSchema"],
        handler: loaded.exports[task.handlerExport] as ModuleTaskDefinition["handler"],
        queueAffinity: task.queueAffinity,
      })),
    );
  }

  async getWorkers(): Promise<ModuleWorkerProjection[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) =>
      (loaded.manifest.workers ?? []).map((worker) => ({ moduleId: loaded.manifest.id, ...worker })),
    );
  }

  async getMigrations(): Promise<ModuleMigrationProjection[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) =>
      (loaded.manifest.migrations ?? []).map((migration) => ({ moduleId: loaded.manifest.id, migration })),
    );
  }

  async getCustomRouteDefinitions(): Promise<ModuleCustomRouteDefinition[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) =>
      (loaded.manifest.customRoutes ?? []).map((route) => ({
        moduleId: loaded.manifest.id,
        name: route.name,
        method: route.method,
        path: route.path,
        handler: loaded.exports[route.handlerExport],
        ...(route.maxBodyBytes !== undefined ? { maxBodyBytes: route.maxBodyBytes } : {}),
      })),
    );
  }

  /** Editor schemas of active modules, in load then declaration order, as deep copies. */
  async getEditorSchemas(): Promise<ModuleEditorSchemaProjection[]> {
    const active = await this.getActiveModules();
    return active.flatMap((loaded) =>
      Object.entries(loaded.manifest.editorSchemas ?? {}).map(([baseKind, schema]) => ({
        moduleId: loaded.manifest.id,
        baseKind,
        schema: structuredClone(schema),
      })),
    );
  }

  async getSystemProjectModuleIds(): Promise<string[]> {
    const active = await this.getActiveModules();
    return active.filter((loaded) => loaded.manifest.systemProject).map((loaded) => loaded.manifest.id);
  }

  /** An active module's `cs`/`en` catalogs (`{ cs: {}, en: {} }` without `i18n/`); `undefined` for an inactive or unknown id. */
  async getCatalogs(moduleId: string): Promise<ModuleCatalogs | undefined> {
    const active = await this.getActiveModules();
    if (!active.some((loaded) => loaded.manifest.id === moduleId)) return undefined;
    return this.catalogsById.get(moduleId);
  }
}
