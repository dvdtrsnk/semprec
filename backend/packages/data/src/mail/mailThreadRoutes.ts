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
import { FLAGGED_PROPERTY_KEY, READ_PROPERTY_KEY } from "./messageFlags.js";
import {
  announceMailThreadChanged,
  applyMailThreadMoves,
  listMailThreadActionMessages,
  listMailThreadMoveCopies,
  planMailThreadMoves,
  readMailThreadFlagged,
  readMailThreadUnread,
  resolveMailThreadForAction,
  selectMailThreadArchiveMoves,
  selectMailThreadRestoreMoves,
  selectMailThreadTrashMoves,
  type MailThreadMoveCopy,
  type MailThreadMoveSelection,
} from "./mailThreadActions.js";
import { readMailThreadFacets, type MailThreadFacets } from "./mailThreadsFacetsStore.js";
import type { CustomRouteResult, RouteParams, RouteUrl } from "../customRoute.js";
import { requestUrl } from "../customRoute.js";

export function createMailThreadListRouteHandler(pool: Pool) {
  return async (ctx: RouteUrl) => {
    const url = requestUrl(ctx.req);
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

/** Remote images are an explicit opt-in: only `true` allows them, anything other than `false` or absent is a 400. */
export function createMailThreadDetailRouteHandler(pool: Pool) {
  return async (ctx: RouteParams & RouteUrl) => {
    const threadId = z.uuid().safeParse(ctx.params.threadId);
    if (!threadId.success) throw new ValidationError("Invalid threadId", { field: "threadId" });
    const raw = requestUrl(ctx.req).searchParams.get("allowRemoteImages");
    if (raw !== null && raw !== "true" && raw !== "false")
      throw new ValidationError("Invalid allowRemoteImages", { field: "allowRemoteImages" });
    const body = await withTransaction(pool, (client) => getMailThreadDetail(client, threadId.data, raw === "true"), {
      isolation: "repeatable_read",
    });
    return { status: 200, body };
  };
}

/**
 * Thread counts of the mailbox filter bar in one statement. The selected project narrows the area
 * counts and the selected area narrows the project counts. An id of no project or area in the caller's
 * tenant selects no thread and is no error.
 */
export function createMailThreadFacetsRouteHandler(pool: Pool) {
  return async (ctx: RouteUrl): Promise<CustomRouteResult<MailThreadFacets>> => {
    const url = requestUrl(ctx.req);
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
 * `read: true` sets `read` on every incoming copy in every mailbox; `read: false` only on the copies of
 * the last incoming message. Non-incoming copies (own mail, Sent, Drafts) are never written. The server
 * loads the versions, so the last write wins.
 *
 * The transaction starts with the tenant's mail-thread guard; each copy is then locked in item id order
 * and written as the session's user only when its `read` differs, so the Emails flag hook queues the
 * mailbox sync. One `mailThread` invalidation is sent after commit, none on rollback.
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
      // The thread guard serializes this with reconcile and every other thread action, so the item-id-ordered
      // copy locks never meet another lock order.
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

const flagBodySchema = z.object({ flagged: z.boolean() }).strict();

/**
 * `flagged: true` flags the copies of the last incoming message (nothing to flag without one);
 * `flagged: false` clears every live copy, own mail, Sent and Drafts included. Locking, writing and
 * invalidation follow the read route.
 */
export function createMailThreadFlagRouteHandler(pool: Pool) {
  const queueAffinity = createActionQueueAffinity();
  return async (ctx: {
    params: Record<string, string>;
    body: unknown;
    identity: { user: { id: string } };
  }): Promise<{ status: number; body: { threadId: string; flagged: boolean } }> => {
    const requested = z.uuid().safeParse(ctx.params.threadId);
    if (!requested.success) throw new ValidationError("Invalid threadId", { field: "threadId" });
    const body = flagBodySchema.safeParse(ctx.body);
    if (!body.success) throw new ValidationError("The body must be { flagged: boolean }", { field: "flagged" });
    const { flagged } = body.data;
    const userId = ctx.identity.user.id;

    return withTransaction(pool, async (client) => {
      const threadId = await resolveMailThreadForAction(client, requested.data);
      const { messages, lastIncomingMessageId } = await listMailThreadActionMessages(client, threadId);
      if (messages.length === 0) throw new NotFoundError("Thread not found");
      const { emailsDatabaseId } = await resolveMailModuleIds(client);
      const targets = messages.filter(
        (message) => !flagged || (message.incoming && message.messageId === lastIncomingMessageId),
      );
      // Same guard and lock order as the read route.
      for (const target of targets) {
        const locked = await lockItemForObservedMailFlags(client, emailsDatabaseId, target.itemId);
        if (
          locked === null ||
          locked.deletedAt !== null ||
          (locked.properties[FLAGGED_PROPERTY_KEY] === true) === flagged
        )
          continue;
        await updateItemWithClient(
          client,
          { databaseId: emailsDatabaseId, itemId: target.itemId, propertiesPatch: { [FLAGGED_PROPERTY_KEY]: flagged } },
          { queueAffinity, writer: { writerKind: "user" }, actingUserId: userId, humanWriterUserId: userId },
        );
      }
      const threadFlagged = await readMailThreadFlagged(client, threadId);
      announceMailThreadChanged(client, threadId);
      return { status: 200, body: { threadId, flagged: threadFlagged } };
    });
  };
}

/**
 * One thread move in one transaction under the tenant's mail-thread guard. Every 409 is decided before
 * the first write, so a refused call changes nothing. One `mailThread` invalidation after commit.
 */
async function moveMailThread(
  pool: Pool,
  threadParam: string | undefined,
  select: (copies: readonly MailThreadMoveCopy[]) => MailThreadMoveSelection[],
): Promise<{ status: number; body: { threadId: string; moved: number } }> {
  const requested = z.uuid().safeParse(threadParam);
  if (!requested.success) throw new ValidationError("Invalid threadId", { field: "threadId" });
  return withTransaction(pool, async (client) => {
    const threadId = await resolveMailThreadForAction(client, requested.data);
    const copies = await listMailThreadMoveCopies(client, threadId);
    if (copies.length === 0) throw new NotFoundError("Thread not found");
    const plans = await planMailThreadMoves(client, select(copies));
    const moved = await applyMailThreadMoves(client, plans);
    announceMailThreadChanged(client, threadId);
    return { status: 200, body: { threadId, moved } };
  });
}

/**
 * Moves the copies in an Inbox to their own mailbox's Archive (a Gmail API mailbox's synthetic one).
 * A mailbox without an Archive fails the whole call with 409 `mail_archive_folder_missing`. Moves are
 * recorded as pending and synced later; nothing is deleted.
 */
export function createMailThreadArchiveRouteHandler(pool: Pool) {
  return (ctx: RouteParams) => moveMailThread(pool, ctx.params.threadId, selectMailThreadArchiveMoves);
}

/**
 * Moves every counted copy not yet in Trash to its mailbox's Trash; drafts stay. 409
 * `mail_thread_already_trashed` when all counted copies are in Trash or Junk, 409
 * `mail_trash_folder_missing` when a mailbox has no Trash.
 */
export function createMailThreadTrashRouteHandler(pool: Pool) {
  return (ctx: RouteParams) => moveMailThread(pool, ctx.params.threadId, selectMailThreadTrashMoves);
}

/**
 * Moves copies in Archive or Trash back: incoming ones to Inbox, the user's own to Sent; Junk and drafts
 * stay. 409 `mail_thread_not_archived_or_trashed`, `mail_inbox_folder_missing` or
 * `mail_sent_folder_missing`, each changing nothing.
 */
export function createMailThreadRestoreRouteHandler(pool: Pool) {
  return (ctx: RouteParams) => moveMailThread(pool, ctx.params.threadId, selectMailThreadRestoreMoves);
}
