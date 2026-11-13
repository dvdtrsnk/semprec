import type { PoolClient } from "pg";
import type { ModuleCatalogs } from "@semprec/module-registry";
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

/** One side of a change: the stored value and the labels it is shown with. */
export interface ProposalChangeSide {
  /**
   * The stored value: the item ids and `{ ref }` targets of a relation (an empty array when the step names none),
   * the canonical key of a select, the raw value otherwise (`null` when the step names none).
   */
  value: unknown;
  /**
   * Display labels in the caller's locale, one per entry of `value` for a relation (a current item name, or the title
   * the referenced step would create) and for a select or multi-select (the localized option label). Empty for any
   * other property.
   */
  labels: string[];
}

/** What an active `update` step changes in one property or relation of its item (issue #2028). */
export interface ProposalChange {
  /** The `ref` of the step that makes the change. */
  ref: string;
  itemId: string;
  /** The item's title-property value; the item id when the item cannot be read or has no title. */
  itemLabel: string;
  /** The canonical key of the changed property or relation property. */
  field: string;
  fieldLabel: string;
  from: ProposalChangeSide;
  to: ProposalChangeSide;
}

type UpdateStep = ProposalStep & { op: "update"; itemId: string };

type RelationTarget = string | { ref: string };

let catalogResolverPromise: Promise<CatalogResolver> | undefined;

/**
 * The catalog resolver the field and option labels are read through, built once per process from the module registry
 * that `loadFullModuleRegistry` builds, as the other readers that hold only a client do. A failed load is not cached,
 * so the next call retries.
 */
function getCatalogResolver(): Promise<CatalogResolver> {
  catalogResolverPromise ??= loadFullModuleRegistry()
    .then((registry) => createCatalogResolver(registry))
    .catch((error: unknown) => {
      catalogResolverPromise = undefined;
      throw error;
    });
  return catalogResolverPromise;
}

/** An `update` step that names the item it changes; validation refuses one that does not, so it is the only kind there is. */
function isUpdateStep(step: ProposalStep): step is UpdateStep {
  return step.op === "update" && step.itemId !== undefined;
}

/** The keys of two records, the first one's first, each once. */
function unionKeys(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): string[] {
  return [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])];
}

/** The database a step writes into, by key: a `create` step names it, `fileFromAttachment` writes the Files database. */
function stepDatabaseKey(step: ProposalStep): string | undefined {
  if (step.op === "create") return step.databaseKey;
  return step.op === "fileFromAttachment" ? FILES_MODULE_ID : undefined;
}

/** The shape of an id the items lookup can cast; the stored envelope only requires a non-empty string for most of them. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ids a card's update steps name that have to be read: the items they change and the relation targets on both
 * sides. Only well-formed UUIDs are listed: the lookup casts the list with `::uuid[]`, so one malformed id (a name in
 * `before.relations`, which validation does not refuse) would fail the read of every card. An id left out is labelled
 * by itself, as an id that cannot be read is.
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

/** What was read for a page of cards, and the locale and catalogs the labels are resolved with. */
interface PageReads {
  items: ItemRow[];
  databasesById: ReadonlyMap<string, DatabaseRow>;
  databasesByKey: ReadonlyMap<string, DatabaseRow>;
  propertiesByDatabaseId: Map<string, PropertyRow[]>;
  /** The catalogs of the module that owns each database of `items`; absent for a database that has none. */
  catalogsByDatabaseId: Map<string, ModuleCatalogs>;
  locale: ManifestLocale;
}

/** The labels of a page of cards, resolved from what was read once for the whole page. */
class LabelResolver {
  private readonly itemsById: Map<string, ItemRow>;
  private readonly resolvedByDatabaseId = new Map<string, Map<string, ResolvedProperty>>();

  constructor(private readonly reads: PageReads) {
    this.itemsById = new Map(reads.items.map((item) => [item.id, item]));
  }

  item(itemId: string): ItemRow | undefined {
    return this.itemsById.get(itemId);
  }

  /** The value of the `title` property of a database in `properties`, or `null` when it declares none or the value is blank. */
  private titleIn(databaseId: string, properties: Record<string, unknown>): string | null {
    const titleProperty = this.reads.propertiesByDatabaseId
      .get(databaseId)
      ?.find((property) => property.type === "title");
    const value = titleProperty ? properties[titleProperty.key] : undefined;
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  /** The current name of an item, its id when it cannot be read (not in this tenant, or gone for good) or has no title. */
  itemLabel(itemId: string): string {
    const item = this.itemsById.get(itemId);
    return (item && this.titleIn(item.databaseId, item.properties)) ?? itemId;
  }

  /**
   * The label of a relation target that is a step of the same proposal: the title the step would create, the current
   * name of the item an `update` or `link` step points at, or the `ref` itself when the step is not among the active
   * ones or has no title.
   */
  refLabel(stepsByRef: ReadonlyMap<string, ProposalStep>, ref: string): string {
    const step = stepsByRef.get(ref);
    if (!step) return ref;
    if (step.itemId !== undefined) return this.itemLabel(step.itemId);
    const key = stepDatabaseKey(step);
    const database = key === undefined ? undefined : this.reads.databasesByKey.get(key);
    return (database && this.titleIn(database.id, step.properties ?? {})) ?? ref;
  }

  /** The projection of the property `key` of the database `databaseId`, labelled in the reader's locale; `undefined` when it has no such property. */
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

/** The side of a property change: the stored value, and the option labels when the property is a select or multi-select. */
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
 * Describes what the active `update` steps of a page of cards change (issue #2028), one entry per changed key, keyed
 * by the caller's card id. `activeSteps` are the active steps of each card's effective envelope, as
 * `selectActiveSteps` returns them, so a disabled or skipped step is never described. A card that has no `update` step,
 * or whose update steps change no key, is absent from the result.
 *
 * Everything is read for the whole page at once (the items, the databases, the properties of both), so the number of
 * queries does not grow with the number of cards. Labels are resolved on read and never stored: a field and a select
 * option through the catalog of the module that owns the item's database, an item by the value of its title property,
 * a `{ ref }` target by the title the referenced step would create.
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
