import type { AreaFilterTemplate, ModuleRegistry } from "@semprec/module-registry";
import type { DatabaseRow } from "../types.js";

export interface CollectionMetadata {
  icon: string | null;
  color: string | null;
  overviewOrder: number | null;
  switcherOrder: number | null;
  clientVisible: boolean;
  /** The orders and `clientVisible` do not depend on it. */
  overviewHidden: boolean;
}

/** For a user-created database without a stored pick; applied on read, never written. */
export const DEFAULT_DATABASE_ICON = "database";
export const DEFAULT_DATABASE_COLOR = "#FF9500";

export interface CollectionMetadataResolver {
  /** `overviewHidden` is false when no row is passed. */
  resolve(
    database: Pick<DatabaseRow, "key" | "system"> & Partial<Pick<DatabaseRow, "icon" | "color" | "overviewHidden">>,
  ): CollectionMetadata;
  /** Only system databases whose descriptor declares `overviewHideable: true`. */
  overviewHideable(database: Pick<DatabaseRow, "key" | "system">): boolean;
  /** As the module manifest declares it; `undefined` when none. */
  collectionFilter(database: Pick<DatabaseRow, "key" | "system">): Record<string, unknown> | undefined;
  /** Related-collection order and exclusions, active databases only; `undefined` when none declared. */
  relatedOrder?(database: Pick<DatabaseRow, "key" | "system">): { order: string[]; omit: string[] } | undefined;
  /** Per-area filter template; `undefined` when none declared. */
  areaFilter?(database: Pick<DatabaseRow, "key" | "system">): AreaFilterTemplate | undefined;
}

const NO_METADATA: Omit<CollectionMetadata, "overviewHidden"> = {
  icon: null,
  color: null,
  overviewOrder: null,
  switcherOrder: null,
  clientVisible: false,
};

/**
 * A system database without a descriptor is not client-visible; a user-created one is, with its
 * stored or default appearance and no order.
 */
export async function createCollectionMetadataResolver(
  moduleRegistry: ModuleRegistry,
): Promise<CollectionMetadataResolver> {
  const descriptors = new Map((await moduleRegistry.getDatabases()).map((db) => [db.key, db]));
  return {
    resolve(database) {
      const overviewHidden = database.overviewHidden ?? false;
      if (!database.system) {
        return {
          ...NO_METADATA,
          icon: database.icon ?? DEFAULT_DATABASE_ICON,
          color: database.color ?? DEFAULT_DATABASE_COLOR,
          clientVisible: true,
          overviewHidden,
        };
      }
      const descriptor = database.key === null ? undefined : descriptors.get(database.key);
      if (descriptor === undefined) return { ...NO_METADATA, overviewHidden };
      const overviewOrder = descriptor.overviewOrder ?? null;
      const switcherOrder = descriptor.switcherOrder ?? null;
      return {
        icon: descriptor.icon ?? null,
        color: descriptor.color ?? null,
        overviewOrder,
        switcherOrder,
        clientVisible: overviewOrder !== null || switcherOrder !== null || descriptor.clientVisible === true,
        overviewHidden,
      };
    },
    overviewHideable(database) {
      if (!database.system || database.key === null) return false;
      return descriptors.get(database.key)?.overviewHideable === true;
    },
    collectionFilter(database) {
      if (!database.system || database.key === null) return undefined;
      const declared = descriptors.get(database.key)?.collectionFilter;
      return declared === undefined ? undefined : structuredClone(declared);
    },
    relatedOrder(database) {
      if (!database.system || database.key === null) return undefined;
      const declared = descriptors.get(database.key)?.relatedOrder;
      if (declared === undefined) return undefined;
      const isActive = (key: string) => descriptors.has(key);
      return { order: declared.order.filter(isActive), omit: (declared.omit ?? []).filter(isActive) };
    },
    areaFilter(database) {
      if (!database.system || database.key === null) return undefined;
      const declared = descriptors.get(database.key)?.areaFilter;
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

/** `switcherOrder`, then `overviewOrder`, then name (case-insensitive), ties by id. */
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
