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

async function request(options: Required<Pick<HttpGenericOperationsOptions, "baseUrl">> & { fetchImpl: typeof fetch }, path: string, init?: RequestInit): Promise<unknown> {
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

  try {
    return await response.json();
  } catch (error) {
    throw new OperationError("retryable", error instanceof Error ? error.message : String(error));
  }
}

export function createHttpGenericOperations(options: HttpGenericOperationsOptions): GenericOperations {
  const config = { baseUrl: options.baseUrl.replace(/\/$/, ""), fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis) };

  const post = (path: string, body: unknown) => request(config, path, { method: "POST", body: JSON.stringify(body) });

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
  };
}
