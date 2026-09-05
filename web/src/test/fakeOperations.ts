import type { FilterNode, GenericOperations, Item, ListItemsRequest, View } from "../api/genericOperations.js";

/**
 * An in-memory stand-in for the backend's generic operations, evaluating the same filter
 * trees the real ones compile to SQL — including `relation_contains` over a relation edge
 * list. Tests therefore exercise the actual request the client makes, rather than a
 * hand-stubbed answer per call.
 */
export interface FakeItem {
  id: string;
  databaseId: string;
  properties: Record<string, unknown>;
}

export interface FakeRelationEdge {
  property: string;
  itemId: string;
  targetItemId: string;
}

export interface FakeBackend {
  items: FakeItem[];
  relations: FakeRelationEdge[];
  views: View[];
}

function toItem(item: FakeItem): Item {
  return { id: item.id, databaseId: item.databaseId, properties: item.properties, computed: {}, updatedAt: "2026-01-01T00:00:00.000Z", deletedAt: null };
}

function matches(backend: FakeBackend, item: FakeItem, filter: FilterNode | undefined): boolean {
  if (!filter) return true;
  switch (filter.type) {
    case "and":
      return filter.nodes.every((node) => matches(backend, item, node));
    case "or":
      return filter.nodes.some((node) => matches(backend, item, node));
    case "not":
      return !matches(backend, item, filter.node);
    case "relation_contains":
    case "relation_not_contains": {
      const linked = backend.relations.some(
        (edge) => edge.property === filter.property && edge.itemId === item.id && edge.targetItemId === filter.value,
      );
      return filter.type === "relation_contains" ? linked : !linked;
    }
    case "equals":
      return item.properties[filter.property] === filter.value;
    case "not_equals":
      return item.properties[filter.property] !== filter.value;
    case "is_empty":
      return item.properties[filter.property] === undefined || item.properties[filter.property] === "";
    case "is_not_empty":
      return item.properties[filter.property] !== undefined && item.properties[filter.property] !== "";
  }
}

function select(backend: FakeBackend, databaseId: string, request: ListItemsRequest = {}): FakeItem[] {
  const rows = backend.items.filter((item) => item.databaseId === databaseId && matches(backend, item, request.filter));
  const [sort] = request.sort ?? [];
  if (!sort) return rows;
  return [...rows].sort((a, b) => {
    const left = String(a.properties[sort.property] ?? "");
    const right = String(b.properties[sort.property] ?? "");
    return sort.direction === "asc" ? left.localeCompare(right) : right.localeCompare(left);
  });
}

export function createFakeOperations(backend: FakeBackend): GenericOperations {
  return {
    async listItems(databaseId, request) {
      const rows = select(backend, databaseId, request);
      return { items: rows.map(toItem), nextCursor: null };
    },
    async countItems(databaseId, request) {
      return select(backend, databaseId, request).length;
    },
    async getItem(databaseId, itemId) {
      const row = backend.items.find((item) => item.databaseId === databaseId && item.id === itemId);
      return row ? toItem(row) : null;
    },
    async getView(viewId) {
      const view = backend.views.find((candidate) => candidate.id === viewId);
      if (!view) throw new Error(`View ${viewId} not found`);
      return view;
    },
  };
}
