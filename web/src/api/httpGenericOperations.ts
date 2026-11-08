import { z } from "zod";
import {
  OperationError,
  itemPageSchema,
  itemSchema,
  viewSchema,
  type GenericOperations,
  type ListItemsRequest,
} from "./genericOperations.js";

/**
 * The HTTP binding of the generic operations. It is a thin, schema-validating adapter: it
 * knows the shape of the generic endpoints and nothing about any module — a mailbox request
 * and a task-board request leave this file identical apart from their arguments.
 *
 * Status handling is what decides which state the UI shows: 401/403/404/501 mean the view or
 * database is not there for this client, or not readable by it (an `unavailable` state with
 * no retry — repeating the request only repeats the same answer), while everything else —
 * 5xx, a network failure, an unparseable body — is `retryable`.
 */
export interface HttpGenericOperationsOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

const UNAVAILABLE_STATUSES = new Set([401, 403, 404, 501]);

interface RequestOptions {
  /** A write whose answer the client does not read: the response body is not parsed, so a `204 No Content` is as valid as a JSON one. */
  discardBody?: boolean;
  /**
   * A 404 whose JSON body matches this schema is an expected outcome, not a failure: the
   * request resolves `undefined`. Any other 404 body (another resource, non-JSON, none) keeps
   * the ordinary `unavailable` classification.
   */
  notFoundBody?: z.ZodType;
}

/** The backend's answer to deleting a relation edge that is not there. */
const absentRelationEdgeSchema = z.object({
  error: z.object({
    code: z.literal("not_found"),
    details: z.object({ resource: z.literal("relationEdge") }),
  }),
});

/** The largest page the backend's query route serves. */
const COUNT_PAGE_LIMIT = 200;

async function request(
  options: Required<Pick<HttpGenericOperationsOptions, "baseUrl">> & { fetchImpl: typeof fetch },
  path: string,
  init?: RequestInit,
  requestOptions: RequestOptions = {},
): Promise<unknown> {
  let response: Response;
  try {
    response = await options.fetchImpl(`${options.baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
      credentials: "same-origin",
    });
  } catch (error) {
    throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
  }

  if (!response.ok) {
    if (response.status === 404 && requestOptions.notFoundBody) {
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        // An unparseable 404 body is not the expected answer; it falls through to the
        // ordinary `unavailable` rejection below, which is the failure being reported.
        body = undefined;
      }
      if (requestOptions.notFoundBody.safeParse(body).success) return undefined;
    }
    throw new OperationError(
      UNAVAILABLE_STATUSES.has(response.status) ? "unavailable" : "retryable",
      `Request to ${path} failed with ${response.status}`,
      response.status,
    );
  }

  if (requestOptions.discardBody) return undefined;

  try {
    return await response.json();
  } catch (error) {
    throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
  }
}

export function createHttpGenericOperations(options: HttpGenericOperationsOptions): GenericOperations {
  const config = {
    baseUrl: options.baseUrl.replace(/\/$/, ""),
    fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
  };

  const post = (path: string, body: unknown) => request(config, path, { method: "POST", body: JSON.stringify(body) });
  const id = encodeURIComponent;
  // The relation routes address the relation by its *property key*; the backend resolves it
  // against the item's own database, so the client sends no database id and never learns a
  // property id.
  const edgePath = (itemId: string, relationKey: string, targetItemId: string) =>
    `/items/${id(itemId)}/relations/${id(relationKey)}/${id(targetItemId)}`;

  // The backend serves items by id alone; the port is database-scoped, so an item that
  // belongs to another database reads as absent.
  const readItem = async (databaseId: string, itemId: string) => {
    try {
      const item = itemSchema.parse(await request(config, `/items/${id(itemId)}`));
      return item.databaseId === databaseId ? item : null;
    } catch (error) {
      // A missing item is an ordinary outcome of reading a list that has moved on, not a
      // failure state for the whole pane.
      if (error instanceof OperationError && error.status === 404) return null;
      throw error;
    }
  };

  return {
    async listItems(databaseId, listRequest: ListItemsRequest = {}) {
      return itemPageSchema.parse(await post(`/databases/${id(databaseId)}/query`, listRequest));
    },

    async countItems(databaseId, listRequest = {}) {
      // The backend has no count route: page through the query and sum the pages.
      let count = 0;
      let cursor: string | undefined;
      do {
        const page = itemPageSchema.parse(
          await post(`/databases/${id(databaseId)}/query`, {
            filter: listRequest.filter,
            limit: COUNT_PAGE_LIMIT,
            ...(cursor === undefined ? {} : { cursor }),
          }),
        );
        count += page.items.length;
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      return count;
    },

    getItem: readItem,

    async getView(viewId) {
      return viewSchema.parse(await request(config, `/views/${id(viewId)}`));
    },

    async updateItem(databaseId, itemId, propertiesPatch) {
      const current = await readItem(databaseId, itemId);
      if (current === null) {
        throw new OperationError("unavailable", `Item ${itemId} not found in database ${databaseId}`, 404);
      }
      return itemSchema.parse(
        await request(config, `/items/${id(itemId)}`, {
          method: "PATCH",
          body: JSON.stringify({ properties: propertiesPatch, ifVersion: current.updatedAt }),
        }),
      );
    },

    async linkItem(_databaseId, itemId, relationKey, targetItemId) {
      await request(config, edgePath(itemId, relationKey, targetItemId), { method: "PUT" }, { discardBody: true });
    },

    async callOperation(operationId, input) {
      // Addressed by operation id alone: which module owns it, and which databases/properties
      // it touches, are the backend's business — the client only names the operation.
      return post(`/operations/${id(operationId)}`, input);
    },

    async unlinkItem(_databaseId, itemId, relationKey, targetItemId) {
      await request(
        config,
        edgePath(itemId, relationKey, targetItemId),
        { method: "DELETE" },
        { discardBody: true, notFoundBody: absentRelationEdgeSchema },
      );
    },
  };
}
