import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { listMailThreads } from "./mailThreadListQuery.js";

const cursorSchema = z.object({ at: z.iso.datetime({ precision: 6 }), id: z.uuid() }).strict();

export function createMailThreadListRouteHandler(pool: Pool) {
  return async (ctx: { req: { url?: string } }) => {
    const url = new URL(ctx.req.url ?? "/", "http://localhost");
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null && !/^[0-9]{1,3}$/.test(rawLimit))
      throw new ValidationError("Invalid limit", { field: "limit" });
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (limit < 1 || limit > 200) throw new ValidationError("Invalid limit", { field: "limit" });
    const rawCursor = url.searchParams.get("cursor");
    let cursor: z.infer<typeof cursorSchema> | null = null;
    if (rawCursor !== null) {
      if (rawCursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(rawCursor))
        throw new ValidationError("Invalid cursor", { field: "cursor" });
      let decoded: unknown;
      try {
        const bytes = Buffer.from(rawCursor, "base64url");
        if (bytes.toString("base64url") !== rawCursor) throw new Error("Invalid encoding");
        decoded = JSON.parse(bytes.toString("utf8"));
      } catch {
        throw new ValidationError("Invalid cursor", { field: "cursor" });
      }
      const parsed = cursorSchema.safeParse(decoded);
      if (!parsed.success) throw new ValidationError("Invalid cursor", { field: "cursor" });
      cursor = parsed.data;
    }
    const rows = await withTransaction(pool, (client) => listMailThreads(client, limit, cursor));
    const hasMore = rows.length > limit;
    const threads = rows.slice(0, limit);
    const last = threads.at(-1);
    const nextCursor =
      hasMore && last
        ? Buffer.from(JSON.stringify({ at: last.lastMessageAt, id: last.threadId })).toString("base64url")
        : null;
    return { status: 200, body: { threads, nextCursor } };
  };
}
