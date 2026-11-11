import type { ModuleRegistry } from "@semprec/module-registry";
import type { DatabaseRow } from "../types.js";

/** Client-facing presentation metadata of one database (issue #1407). */
export interface CollectionMetadata {
  icon: string | null;
  color: string | null;
  overviewOrder: number | null;
  switcherOrder: number | null;
  clientVisible: boolean;
}

/** Appearance of a user-created database without a stored pick; applied when reading, never written (issue #1528). */
export const DEFAULT_DATABASE_ICON = "database";
export const DEFAULT_DATABASE_COLOR = "#FF9500";

export interface CollectionMetadataResolver {
  resolve(
    database: Pick<DatabaseRow, "key" | "system"> & Partial<Pick<DatabaseRow, "icon" | "color">>,
  ): CollectionMetadata;
  /**
   * The filter tree of the items that belong in the database's collection, as its module manifest declares
   * it (issue #1647). `undefined` for a user-created database and for a system database without one.
   */
  collectionFilter(database: Pick<DatabaseRow, "key" | "system">): Record<string, unknown> | undefined;
}

const NO_METADATA: CollectionMetadata = {
  icon: null,
  color: null,
  overviewOrder: null,
  switcherOrder: null,
  clientVisible: false,
};

/**
 * Reads `getDatabases()` once and resolves a database row to its declared metadata. A system
 * database without a descriptor is not client-visible; a user-created database is client-visible
 * with its stored or default icon and color and no order.
 */
export async function createCollectionMetadataResolver(
  moduleRegistry: ModuleRegistry,
): Promise<CollectionMetadataResolver> {
  const descriptors = new Map((await moduleRegistry.getDatabases()).map((db) => [db.key, db]));
  return {
    resolve(database) {
      if (!database.system) {
        return {
          ...NO_METADATA,
          icon: database.icon ?? DEFAULT_DATABASE_ICON,
          color: database.color ?? DEFAULT_DATABASE_COLOR,
          clientVisible: true,
        };
      }
      const descriptor = database.key === null ? undefined : descriptors.get(database.key);
      if (descriptor === undefined) return { ...NO_METADATA };
      const overviewOrder = descriptor.overviewOrder ?? null;
      const switcherOrder = descriptor.switcherOrder ?? null;
      return {
        icon: descriptor.icon ?? null,
        color: descriptor.color ?? null,
        overviewOrder,
        switcherOrder,
        clientVisible: overviewOrder !== null || switcherOrder !== null || descriptor.clientVisible === true,
      };
    },
    collectionFilter(database) {
      if (!database.system || database.key === null) return undefined;
      const declared = descriptors.get(database.key)?.collectionFilter;
      return declared === undefined ? undefined : structuredClone(declared);
    },
  };
}

/** One database with its resolved display name and orders, as sorted by `compareCollections`. */
export interface OrderableCollection {
  id: string;
  name: string;
  switcherOrder: number | null;
  overviewOrder: number | null;
}

const nameCollator = new Intl.Collator(undefined, { sensitivity: "accent", usage: "sort" });

function orderGroup(c: OrderableCollection): number {
  return c.switcherOrder !== null ? 0 : c.overviewOrder !== null ? 1 : 2;
}

/** Rows with a `switcherOrder` ascending, then rows with only an `overviewOrder` ascending, then the rest by name (case-insensitive), ties by id. */
export function compareCollections(a: OrderableCollection, b: OrderableCollection): number {
  const groupA = orderGroup(a);
  const groupB = orderGroup(b);
  if (groupA !== groupB) return groupA - groupB;
  const diff =
    groupA === 0
      ? a.switcherOrder! - b.switcherOrder!
      : groupA === 1
        ? a.overviewOrder! - b.overviewOrder!
        : nameCollator.compare(a.name, b.name);
  if (diff !== 0) return diff;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
