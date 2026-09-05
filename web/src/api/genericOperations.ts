import { z } from "zod";

/**
 * The generic backend operations the web client is allowed to call. These mirror the
 * choke-point's own generic surface (`listItems`/`countItems`/`getItem`/`getView`, plus
 * `updateItem` and the relation link/unlink pair) one to one — deliberately: a view renderer
 * reads and writes its data through these and nothing else, so no view can grow a private
 * path of its own into a specific module's tables.
 */

export const itemSchema = z.object({
  id: z.string(),
  databaseId: z.string(),
  properties: z.record(z.string(), z.unknown()),
  computed: z.record(z.string(), z.unknown()).default({}),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().default(null),
});

export type Item = z.infer<typeof itemSchema>;

export const itemPageSchema = z.object({
  items: z.array(itemSchema),
  nextCursor: z.string().nullable().default(null),
});

export type ItemPage = z.infer<typeof itemPageSchema>;

export const countSchema = z.object({ count: z.number().int().nonnegative() });

export const viewSchema = z.object({
  id: z.string(),
  databaseId: z.string().nullable(),
  type: z.string(),
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
  /** The registered view type's opaque renderer id; absent when the view type registers none. */
  clientComponent: z.string().optional(),
});

export type View = z.infer<typeof viewSchema>;

/** The filter tree the backend's views/filterTree.ts validates; passed through as data. */
export type FilterNode =
  | { type: "and" | "or"; nodes: FilterNode[] }
  | { type: "not"; node: FilterNode }
  | { type: "relation_contains" | "relation_not_contains"; property: string; value: string }
  | { type: "not_equals" | "equals"; property: string; value: string | number | boolean }
  | { type: "is_empty" | "is_not_empty"; property: string };

export interface SortSpec {
  property: string;
  direction: "asc" | "desc";
}

export interface ListItemsRequest {
  filter?: FilterNode;
  sort?: SortSpec[];
  limit?: number;
  cursor?: string;
}

export interface GenericOperations {
  listItems(databaseId: string, request?: ListItemsRequest): Promise<ItemPage>;
  countItems(databaseId: string, request?: Pick<ListItemsRequest, "filter">): Promise<number>;
  getItem(databaseId: string, itemId: string): Promise<Item | null>;
  getView(viewId: string): Promise<View>;
  /** Patches user-owned scalar properties of one item; the backend rejects anything else. */
  updateItem(databaseId: string, itemId: string, propertiesPatch: Record<string, unknown>): Promise<Item>;
  /** Adds one edge on the named relation property. Linking an already-linked pair is a no-op, not a failure. */
  linkItem(databaseId: string, itemId: string, relationKey: string, targetItemId: string): Promise<void>;
  /** Removes one edge on the named relation property; removing an absent edge is likewise a no-op. */
  unlinkItem(databaseId: string, itemId: string, relationKey: string, targetItemId: string): Promise<void>;
}

/**
 * How a failed operation is presented. `unavailable` is a state the user cannot retry out of
 * (the module/view is not there, or this client is not allowed to read it); `retryable` is
 * everything else — a transport blip, a timeout, a 5xx — where offering "try again" is honest.
 */
export type OperationFailureKind = "unavailable" | "retryable";

export class OperationError extends Error {
  readonly kind: OperationFailureKind;
  readonly status?: number;

  constructor(kind: OperationFailureKind, message: string, status?: number) {
    super(message);
    this.name = "OperationError";
    this.kind = kind;
    this.status = status;
  }
}

/** Anything thrown out of an operation is normalized here — an unknown failure is retryable. */
export function toOperationError(error: unknown): OperationError {
  if (error instanceof OperationError) return error;
  return new OperationError("retryable", error instanceof Error ? error.message : String(error));
}
