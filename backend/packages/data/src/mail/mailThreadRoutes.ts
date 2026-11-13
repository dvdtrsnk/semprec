import type { Pool } from "pg";
import { z } from "zod";
import { lockItemForObservedMailFlags, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { NotFoundError, ValidationError } from "../errors.js";
import { createActionQueueAffinity } from "../scheduler/actions.js";
import { parseMailSearchQuery } from "./search.js";
import { hasInvalidMailSearchDate, listMailThreads, parseMailThreadListCursor } from "./mailThreadListQuery.js";
import { getMailThreadDetail } from "./mailThreadDetail.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { READ_PROPERTY_KEY } from "./messageFlags.js";
import {
  announceMailThreadChanged,
  listMailThreadActionMessages,
  readMailThreadUnread,
  resolveMailThreadForAction,
} from "./mailThreadActions.js";
import { readMailThreadFacets, type MailThreadFacets } from "./mailThreadsFacetsStore.js";

export function createMailThreadListRouteHandler(pool: Pool) {
  return async (ctx: { req: { url?: string } }) => {
    const url = new URL(ctx.req.url ?? "/", "http://localhost");
    const rawLimit = url.searchParams.get("limit");
    if (rawLimit !== null && !/^[0-9]{1,3}$/.test(rawLimit))
      throw new ValidationError("Invalid limit", { field: "limit" });
    const limit = rawLimit === null ? 50 : Number(rawLimit);
    if (limit < 1 || limit > 200) throw new ValidationError("Invalid limit", { field: "limit" });
    const rawCursor = url.searchParams.get("cursor");
    const cursor = rawCursor === null ? null : parseMailThreadListCursor(rawCursor);
    const box = url.searchParams.get("box") ?? "inbox";
    if (box !== "inbox" && box !== "flagged" && box !== "sempDrafts")
      throw new ValidationError("Invalid box", { field: "box" });
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
    if (search && hasInvalidMailSearchDate(search)) throw new ValidationError("Invalid search date", { field: "q" });
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

/**
 * `GET /api/mail/threads/facets[?areaId=<uuid>][&projectId=<uuid>]` (issue gh-1747): the thread counts
 * of the mailbox filter bar, per area and per project, from one statement (`readMailThreadFacets`).
 * The selected project narrows the area counts and the selected area narrows the project counts. A
 * value that is not a UUID is a 400 naming its parameter. An id that names no project or area of the
 * caller's tenant selects no thread and is no error.
 */
export function createMailThreadFacetsRouteHandler(pool: Pool) {
  return async (ctx: { req: { url?: string } }): Promise<{ status: number; body: MailThreadFacets }> => {
    const url = new URL(ctx.req.url ?? "/", "http://localhost");
    const selected = (field: "areaId" | "projectId"): string | null => {
      const value = url.searchParams.get(field);
      if (value !== null && !z.uuid().safeParse(value).success)
        throw new ValidationError(`Invalid ${field}`, { field });
      return value;
    };
    const selection = { areaId: selected("areaId"), projectId: selected("projectId") };
    return { status: 200, body: await withTransaction(pool, (client) => readMailThreadFacets(client, selection)) };
  };
}

const readBodySchema = z.object({ read: z.boolean() }).strict();

/**
 * `POST /api/mail/threads/:threadId/read` with the body `{ read: boolean }` (issue gh-1865): marks the
 * conversation read or unread in one transaction and answers `{ threadId, unread }`, the thread id after
 * the translation of a merged id (issue #1493) and the thread's unread state once the writes are done
 * (`readMailThreadUnread`, the value the thread detail reports). A thread id that is no UUID and a body that is anything but that object
 * are 400s; an unknown id, another tenant's id and a thread without a live message are the same 404.
 *
 * `read: true` sets `read` on every incoming copy of the thread, in every mailbox. `read: false` sets it
 * on the copies of the last incoming message only (`listMailThreadActionMessages`). A copy that is not
 * incoming (the user's own mail, anything in Sent or Drafts) is never written. The server loads the
 * versions, so a request carries none and the last write wins.
 *
 * The transaction starts with the tenant's mail-thread guard (`resolveMailThreadForAction`, see
 * [[2026-11-13-mail-thread-actions-take-the-thread-guard-before-their-item-locks]]). Each copy is locked, in
 * item id order, and written only when the locked row's `read` differs from the
 * requested value; the write is `updateItemWithClient` as the session's user, so the Emails flag hook
 * records the desired state and queues the mailbox sync (issue #1494). After the commit the route sends
 * one `mailThread` invalidation, also when every copy already matched; a rolled-back request sends none.
 */
export function createMailThreadReadRouteHandler(pool: Pool) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: {
    params: Record<string, string>;
    body: unknown;
    identity: { user: { id: string } };
  }): Promise<{ status: number; body: { threadId: string; unread: boolean } }> => {
    const requested = z.uuid().safeParse(ctx.params.threadId);
    if (!requested.success) throw new ValidationError("Invalid threadId", { field: "threadId" });
    const body = readBodySchema.safeParse(ctx.body);
    if (!body.success) throw new ValidationError("The body must be { read: boolean }", { field: "read" });
    const { read } = body.data;
    const userId = ctx.identity.user.id;

    return withTransaction(pool, async (client) => {
      const threadId = await resolveMailThreadForAction(client, requested.data);
      const { messages, lastIncomingMessageId } = await listMailThreadActionMessages(client, threadId);
      if (messages.length === 0) throw new NotFoundError("Thread not found");
      const { emailsDatabaseId } = await resolveMailModuleIds(client);
      const targets = messages.filter(
        (message) => message.incoming && (read || message.messageId === lastIncomingMessageId),
      );
      // The guard `resolveMailThreadForAction` took serializes this request with a reconcile pass and with every
      // other thread action, so the copies, locked in item id order, are never locked against another order.
      for (const target of targets) {
        const locked = await lockItemForObservedMailFlags(client, emailsDatabaseId, target.itemId);
        if (locked === null || locked.deletedAt !== null || (locked.properties[READ_PROPERTY_KEY] === true) === read)
          continue;
        await updateItemWithClient(
          client,
          { databaseId: emailsDatabaseId, itemId: target.itemId, propertiesPatch: { [READ_PROPERTY_KEY]: read } },
          { queueAffinity, writer: { writerKind: "user" }, actingUserId: userId, humanWriterUserId: userId },
        );
      }
      const unread = await readMailThreadUnread(client, threadId);
      announceMailThreadChanged(client, threadId);
      return { status: 200, body: { threadId, unread } };
    });
  };
}
