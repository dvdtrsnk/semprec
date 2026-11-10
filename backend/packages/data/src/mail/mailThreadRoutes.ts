import type { Pool } from "pg";
import { z } from "zod";
import { withTransaction } from "../db/pool.js";
import { ValidationError } from "../errors.js";
import { parseMailSearchQuery } from "./search.js";
import { listMailThreads } from "./mailThreadListQuery.js";
import { getMailThreadDetail } from "./mailThreadDetail.js";

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
    const box = url.searchParams.get("box") ?? "inbox";
    if (box !== "inbox" && box !== "flagged") throw new ValidationError("Invalid box", { field: "box" });
    const uuidParam = (field: string) => {
      const value = url.searchParams.get(field);
      if (value !== null && !z.uuid().safeParse(value).success)
        throw new ValidationError(`Invalid ${field}`, { field });
      return value;
    };
    const folderId = uuidParam("folderId");
    const mailboxId = uuidParam("mailboxId");
    const projectId = uuidParam("projectId");
    const areaId = uuidParam("areaId");
    const personId = uuidParam("personId");
    const rawUnread = url.searchParams.get("unread");
    if (rawUnread !== null && rawUnread !== "true" && rawUnread !== "false")
      throw new ValidationError("Invalid unread", { field: "unread" });
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length > 1000) throw new ValidationError("Invalid q", { field: "q" });
    const search = q ? parseMailSearchQuery(q, true) : undefined;
    for (const date of [search?.before, search?.after]) {
      if (
        date !== undefined &&
        !z.iso.date().safeParse(date).success &&
        !z.iso.datetime({ offset: true }).safeParse(date).success
      )
        throw new ValidationError("Invalid search date", { field: "q" });
    }
    const rows = await withTransaction(pool, (client) =>
      listMailThreads(client, limit, cursor, {
        box,
        folderId,
        mailboxId,
        projectId,
        areaId,
        personId,
        unread: rawUnread === "true",
        search,
      }),
    );
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

/**
 * `GET /api/mail/threads/:threadId[?allowRemoteImages=true]` (issue #1632). Remote images are an
 * explicit opt-in: only `true` allows them, `false` or no parameter keeps them stripped, anything
 * else is a 400.
 */
export function createMailThreadDetailRouteHandler(pool: Pool) {
  return async (ctx: { req: { url?: string }; params: Record<string, string> }) => {
    const threadId = z.uuid().safeParse(ctx.params.threadId);
    if (!threadId.success) throw new ValidationError("Invalid threadId", { field: "threadId" });
    const raw = new URL(ctx.req.url ?? "/", "http://localhost").searchParams.get("allowRemoteImages");
    if (raw !== null && raw !== "true" && raw !== "false")
      throw new ValidationError("Invalid allowRemoteImages", { field: "allowRemoteImages" });
    const body = await withTransaction(pool, (client) => getMailThreadDetail(client, threadId.data, raw === "true"), {
      isolation: "repeatable_read",
    });
    return { status: 200, body };
  };
}
