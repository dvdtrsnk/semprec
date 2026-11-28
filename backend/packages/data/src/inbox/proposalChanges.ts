import type { PoolClient } from "pg";
import type { ModuleCatalogs } from "@alldots/module-registry";
import { listAllDatabases } from "../chokePoint/databasesStore.js";
import { getItemsByIdsIncludingDeleted } from "../chokePoint/itemsStore.js";
import { listPropertiesByDatabases } from "../chokePoint/propertiesStore.js";
import {
  createCatalogResolver,
  resolveProperty,
  toManifestLocale,
  type CatalogResolver,
  type ManifestLocale,
  type ResolvedProperty,
} from "../manifest/catalogResolution.js";
import { loadFullModuleRegistry } from "../manifest/fullModuleRegistry.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { DatabaseRow, ItemRow, PropertyRow } from "../types.js";
import type { ProposalStep } from "./proposalEnvelope.js";

export interface ProposalChangeSide {
  /** Relation: item ids and `{ ref }` targets (empty when none); select: canonical key; otherwise the raw value or `null`. */
  value: unknown;
  /** Display labels in the caller's locale, one per relation target or select option; empty for other properties. */
  labels: string[];
}

export interface ProposalChange {
  ref: string;
  itemId: string;
  /** The item's title, or its id when it cannot be read or has no title. */
  itemLabel: string;
  field: string;
  fieldLabel: string;
  from: ProposalChangeSide;
  to: ProposalChangeSide;
}

type UpdateStep = ProposalStep & { op: "update"; itemId: string };

type RelationTarget = string | { ref: string };

let catalogResolverPromise: Promise<CatalogResolver> | undefined;

/** Built once per process from `loadFullModuleRegistry`; a failed load is not cached, so the next call retries. */
function getCatalogResolver(): Promise<CatalogResolver> {
  catalogResolverPromise ??= loadFullModuleRegistry()
    .then((registry) => createCatalogResolver(registry))
    .catch((error: unknown) => {
      catalogResolverPromise = undefined;
      throw error;
    });
  return catalogResolverPromise;
}

/** Validation guarantees every `update` step names its item. */
function isUpdateStep(step: ProposalStep): step is UpdateStep {
  return step.op === "update" && step.itemId !== undefined;
}

function unionKeys(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): string[] {
  return [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
}

function stepDatabaseKey(step: ProposalStep): string | undefined {
  if (step.op === "create") return step.databaseKey;
  return step.op === "fileFromAttachment" ? FILES_MODULE_ID : undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ids the update steps name that must be read. Only well-formed UUIDs: the lookup casts with `::uuid[]`, so one
 * malformed id (allowed in `before.relations`) would fail the read for every card. Omitted ids label as themselves.
 */
function idsToRead(steps: readonly ProposalStep[]): string[] {
  const ids: string[] = [];
  for (const step of steps) if (step.itemId !== undefined) ids.push(step.itemId);
  for (const step of steps.filter(isUpdateStep)) {
    for (const list of Object.values(step.before?.relations ?? {})) ids.push(...list);
    for (const list of Object.values(step.after?.relations ?? {})) {
      for (const target of list) if (typeof target === "string") ids.push(target);
    }
  }
  return ids.filter((id) => UUID_RE.test(id));
}

interface PageReads {
  items: ItemRow[];
  databasesById: ReadonlyMap<string, DatabaseRow>;
  databasesByKey: ReadonlyMap<string, DatabaseRow>;
  propertiesByDatabaseId: Map<string, PropertyRow[]>;
  catalogsByDatabaseId: Map<string, ModuleCatalogs>;
  locale: ManifestLocale;
}

class LabelResolver {
  private readonly itemsById: Map<string, ItemRow>;
  private readonly resolvedByDatabaseId = new Map<string, Map<string, ResolvedProperty>>();

  constructor(private readonly reads: PageReads) {
    this.itemsById = new Map(reads.items.map((item) => [item.id, item]));
  }

  item(itemId: string): ItemRow | undefined {
    return this.itemsById.get(itemId);
  }

  private titleIn(databaseId: string, properties: Record<string, unknown>): string | null {
    const titleProperty = this.reads.propertiesByDatabaseId
      .get(databaseId)
      ?.find((property) => property.type === "title");
    const value = titleProperty ? properties[titleProperty.key] : undefined;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  /** The current name of an item, or its id when it cannot be read or has no title. */
  itemLabel(itemId: string): string {
    const item = this.itemsById.get(itemId);
    return (item && this.titleIn(item.databaseId, item.properties)) ?? itemId;
  }

  /** A `{ ref }` target's label: the title its step would create, the name of the item it points at, or the `ref`. */
  refLabel(stepsByRef: ReadonlyMap<string, ProposalStep>, ref: string): string {
    const step = stepsByRef.get(ref);
    if (!step) return ref;
    if (step.itemId !== undefined) return this.itemLabel(step.itemId);
    const key = stepDatabaseKey(step);
    const database = key === undefined ? undefined : this.reads.databasesByKey.get(key);
    return (database && this.titleIn(database.id, step.properties ?? {})) ?? ref;
  }

  property(databaseId: string, key: string): ResolvedProperty | undefined {
    let resolved = this.resolvedByDatabaseId.get(databaseId);
    if (!resolved) {
      const dbKey = this.reads.databasesById.get(databaseId)?.key ?? null;
      const catalogs = this.reads.catalogsByDatabaseId.get(databaseId);
      resolved = new Map(
        (this.reads.propertiesByDatabaseId.get(databaseId) ?? []).map((property) => [
          property.key,
          resolveProperty(property, dbKey, catalogs, this.reads.locale),
        ]),
      );
      this.resolvedByDatabaseId.set(databaseId, resolved);
    }
    return resolved.get(key);
  }
}

function propertySide(resolved: ResolvedProperty | undefined, value: unknown): ProposalChangeSide {
  const options = resolved?.options;
  if (!options) return { value, labels: [] };
  const keys = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string"
      ? [value]
      : [];
  return { value, labels: keys.map((key) => options.find((option) => option.key === key)?.label ?? key) };
}

function describeStep(
  step: UpdateStep,
  stepsByRef: ReadonlyMap<string, ProposalStep>,
  labels: LabelResolver,
): ProposalChange[] {
  const item = labels.item(step.itemId);
  const propertyOf = (key: string): ResolvedProperty | undefined =>
    item ? labels.property(item.databaseId, key) : undefined;
  const common = { ref: step.ref, itemId: step.itemId, itemLabel: labels.itemLabel(step.itemId) };
  const changes: ProposalChange[] = [];
  for (const key of unionKeys(step.before?.properties, step.after?.properties)) {
    const resolved = propertyOf(key);
    changes.push({
      ...common,
      field: key,
      fieldLabel: resolved?.name ?? key,
      from: propertySide(resolved, step.before?.properties?.[key] ?? null),
      to: propertySide(resolved, step.after?.properties?.[key] ?? null),
    });
  }
  for (const key of unionKeys(step.before?.relations, step.after?.relations)) {
    const side = (targets: readonly RelationTarget[] | undefined): ProposalChangeSide => {
      const value = [...(targets ?? [])];
      return {
        value,
        labels: value.map((target) =>
          typeof target === "string" ? labels.itemLabel(target) : labels.refLabel(stepsByRef, target.ref),
        ),
      };
    };
    changes.push({
      ...common,
      field: key,
      fieldLabel: propertyOf(key)?.name ?? key,
      from: side(step.before?.relations?.[key]),
      to: side(step.after?.relations?.[key]),
    });
  }
  return changes;
}

/**
 * Describes what the active `update` steps of a page of cards change, one entry per changed key, keyed by card id.
 * Cards without changes are absent. Everything is read once for the whole page so query count does not grow with
 * cards; labels are resolved on read, never stored.
 */
export async function describeUpdateSteps(
  client: PoolClient,
  activeSteps: ReadonlyMap<string, readonly ProposalStep[]>,
  locale: string,
): Promise<Map<string, ProposalChange[]>> {
  const described = new Map<string, ProposalChange[]>();
  const withUpdates = [...activeSteps].filter(([, steps]) => steps.some(isUpdateStep));
  if (withUpdates.length === 0) return described;

  const items = await getItemsByIdsIncludingDeleted(client, [...new Set(withUpdates.flatMap(([, s]) => idsToRead(s)))]);
  const databases = await listAllDatabases(client);
  const databasesById = new Map(databases.map((database) => [database.id, database] as const));
  const databasesByKey = new Map(
    databases.flatMap((database) => (database.key ? [[database.key, database] as const] : [])),
  );
  const databaseIds = new Set(items.map((item) => item.databaseId));
  for (const [, steps] of withUpdates) {
    for (const step of steps) {
      const key = stepDatabaseKey(step);
      const created = key === undefined ? undefined : databasesByKey.get(key);
      if (created) databaseIds.add(created.id);
    }
  }
  const propertiesByDatabaseId = await listPropertiesByDatabases(client, [...databaseIds]);

  const catalogResolver = await getCatalogResolver();
  const catalogsByDatabaseId = new Map<string, ModuleCatalogs>();
  for (const item of items) {
    const catalogs = await catalogResolver.getCatalogsForDbKey(databasesById.get(item.databaseId)?.key ?? null);
    if (catalogs) catalogsByDatabaseId.set(item.databaseId, catalogs);
  }
  const labels = new LabelResolver({
    items,
    databasesById,
    databasesByKey,
    propertiesByDatabaseId,
    catalogsByDatabaseId,
    locale: toManifestLocale(locale),
  });

  for (const [cardId, steps] of withUpdates) {
    const stepsByRef = new Map(steps.map((step) => [step.ref, step] as const));
    const changes = steps.filter(isUpdateStep).flatMap((step) => describeStep(step, stepsByRef, labels));
    if (changes.length > 0) described.set(cardId, changes);
  }
  return described;
}
