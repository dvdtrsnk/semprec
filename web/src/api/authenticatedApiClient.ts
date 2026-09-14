import { z } from "zod";

const viewSchema = z.object({
  id: z.string(),
  databaseId: z.string().nullable(),
  type: z.string(),
  name: z.string(),
  config: z.record(z.string(), z.unknown()),
});

const propertySchema = z.object({
  id: z.string(),
  databaseId: z.string(),
  key: z.string(),
  name: z.string(),
  type: z.string(),
  config: z.record(z.string(), z.unknown()),
  locked: z.boolean(),
  owner: z.enum(["user", "system"]),
  ownerProcess: z.string().nullable(),
  migrationStatus: z.string(),
});

const itemSchema = z.object({
  id: z.string(),
  databaseId: z.string(),
  properties: z.record(z.string(), z.unknown()),
  computed: z.record(z.string(), z.unknown()).default({}),
  updatedAt: z.string(),
  deletedAt: z.string().nullable().default(null),
});

const viewQuerySchema = z.object({
  items: z.array(itemSchema),
  nextCursor: z.string().nullable(),
});

const queryErrorSchema = z.object({ error: z.object({ code: z.string() }) });

export type View = z.infer<typeof viewSchema>;
export type Property = z.infer<typeof propertySchema>;
export type Item = z.infer<typeof itemSchema>;
export type ViewQuery = z.infer<typeof viewQuerySchema>;
export interface QueryFailure {
  code: string;
}

export interface AuthenticatedApiClient {
  getView(viewId: string): Promise<View>;
  listProperties(databaseId: string): Promise<Property[]>;
  queryView(viewId: string, request: { cursor: string | null; limit: number }): Promise<ViewQuery | QueryFailure>;
  createItem(databaseId: string, properties: Record<string, unknown>): Promise<Item>;
}

export interface AuthenticatedApiClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export class ApiRequestError extends Error {
  constructor(readonly status: number) {
    super(`API request failed with ${status}`);
  }
}

function isQueryFailure(value: unknown): value is { error: QueryFailure } {
  const parsed = queryErrorSchema.safeParse(value);
  return parsed.success;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new ApiRequestError(response.status);
  }
}

export function createAuthenticatedApiClient(options: AuthenticatedApiClientOptions): AuthenticatedApiClient {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);

  async function request(path: string, init?: RequestInit): Promise<{ response: Response; body: unknown }> {
    const response = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    return { response, body: await readJson(response) };
  }

  return {
    async getView(viewId) {
      const { response, body } = await request(`/views/${encodeURIComponent(viewId)}`);
      if (!response.ok) throw new ApiRequestError(response.status);
      return viewSchema.parse(body);
    },

    async listProperties(databaseId) {
      const { response, body } = await request(`/databases/${encodeURIComponent(databaseId)}/properties`);
      if (!response.ok) throw new ApiRequestError(response.status);
      return z.array(propertySchema).parse(body);
    },

    async queryView(viewId, query) {
      const { response, body } = await request(`/views/${encodeURIComponent(viewId)}/query`, {
        method: "POST",
        body: JSON.stringify(query),
      });
      if (!response.ok) {
        if (isQueryFailure(body)) return body.error;
        throw new ApiRequestError(response.status);
      }
      return viewQuerySchema.parse(body);
    },

    async createItem(databaseId, properties) {
      const { response, body } = await request(`/databases/${encodeURIComponent(databaseId)}/items`, {
        method: "POST",
        body: JSON.stringify({ properties }),
      });
      if (!response.ok) throw new ApiRequestError(response.status);
      return itemSchema.parse(body);
    },
  };
}
