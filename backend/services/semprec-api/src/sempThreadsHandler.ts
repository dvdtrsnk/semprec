import type { Pool } from "pg";
import { getSempThread, listSempThreadMessages, NotFoundError, ValidationError, withTransaction } from "@semprec/data";
import { assertUuid, requireUuidParam } from "./adapter/requestValidation.js";
import type { RouteDefinition } from "./adapter/routeTable.js";

function parseCursor(value: string | null): { createdAt: string; id: string } | null {
  if (value === null) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error("Invalid cursor");
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new Error("Invalid cursor");
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !("createdAt" in parsed) ||
      !("id" in parsed)
    )
      throw new Error("Invalid cursor");
    const { createdAt, id } = parsed;
    if (
      typeof createdAt !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(createdAt) ||
      createdAt.startsWith("0000-") ||
      !Number.isFinite(Date.parse(createdAt)) ||
      new Date(createdAt).toISOString() !== `${createdAt.slice(0, 23)}Z` ||
      typeof id !== "string"
    )
      throw new Error("Invalid cursor");
    return { createdAt, id: assertUuid(id, "before") };
  } catch {
    throw new ValidationError("Invalid 'before' cursor", { field: "before" });
  }
}

export function createSempThreadRoutes(pool: Pool): RouteDefinition[] {
  return [
    {
      method: "GET",
      path: "/api/semp/threads/:id",
      handler: async (ctx) => {
        const id = requireUuidParam(ctx.params, "id");
        const thread = await withTransaction(pool, (client) => getSempThread(client, id));
        if (!thread) throw new NotFoundError("Thread not found");
        return { status: 200, body: thread };
      },
    },
    {
      method: "GET",
      path: "/api/semp/threads/:id/messages",
      handler: async (ctx) => {
        const id = requireUuidParam(ctx.params, "id");
        const query = new URL(ctx.req.url ?? "/", "http://localhost").searchParams;
        const rawLimit = query.get("limit");
        if (rawLimit !== null && (!/^[1-9]\d*$/.test(rawLimit) || Number(rawLimit) > 100))
          throw new ValidationError("'limit' must be an integer between 1 and 100", { field: "limit" });
        const limit = rawLimit === null ? 50 : Number(rawLimit);
        const before = parseCursor(query.get("before"));
        const result = await withTransaction(pool, async (client) => {
          if (!(await getSempThread(client, id))) throw new NotFoundError("Thread not found");
          return listSempThreadMessages(client, id, limit, before);
        });
        return { status: 200, body: result };
      },
    },
  ];
}
