import {
  OperationError,
  countSchema,
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
}

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
  const config = { baseUrl: options.baseUrl.replace(/\/$/, ""), fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis) };

  const post = (path: string, body: unknown) => request(config, path, { method: "POST", body: JSON.stringify(body) });
  const id = encodeURIComponent;
  // The relation endpoints address the relation by its *property key* on the item's own
  // database; the backend resolves the key to the relation property (and its definition) —
  // the client never learns a property id, exactly as it never learns a table name.
  const relationPath = (databaseId: string, itemId: string, relationKey: string) =>
    `/databases/${id(databaseId)}/items/${id(itemId)}/relations/${id(relationKey)}`;

  return {
    async listItems(databaseId, listRequest: ListItemsRequest = {}) {
      return itemPageSchema.parse(await post(`/databases/${encodeURIComponent(databaseId)}/items/query`, listRequest));
    },

    async countItems(databaseId, listRequest = {}) {
      return countSchema.parse(await post(`/databases/${encodeURIComponent(databaseId)}/items/count`, listRequest)).count;
    },

    async getItem(databaseId, itemId) {
      try {
        return itemSchema.parse(await request(config, `/databases/${encodeURIComponent(databaseId)}/items/${encodeURIComponent(itemId)}`));
      } catch (error) {
        // A missing item is an ordinary outcome of reading a list that has moved on, not a
        // failure state for the whole pane.
        if (error instanceof OperationError && error.status === 404) return null;
        throw error;
      }
    },

    async getView(viewId) {
      return viewSchema.parse(await request(config, `/views/${encodeURIComponent(viewId)}`));
    },

    async updateItem(databaseId, itemId, propertiesPatch) {
      return itemSchema.parse(
        await request(config, `/databases/${id(databaseId)}/items/${id(itemId)}`, {
          method: "PATCH",
          body: JSON.stringify({ properties: propertiesPatch }),
        }),
      );
    },

    async linkItem(databaseId, itemId, relationKey, targetItemId) {
      await request(config, relationPath(databaseId, itemId, relationKey), { method: "POST", body: JSON.stringify({ targetItemId }) }, { discardBody: true });
    },

    async unlinkItem(databaseId, itemId, relationKey, targetItemId) {
      await request(
        config,
        `${relationPath(databaseId, itemId, relationKey)}/${id(targetItemId)}`,
        { method: "DELETE" },
        { discardBody: true },
      );
    },
  };
}
