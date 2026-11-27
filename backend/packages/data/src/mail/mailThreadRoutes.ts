import type { Pool } from "pg";
import { z } from "zod";
import { lockItemForObservedMailFlags, updateItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";
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
import {
  encodeMailThreadChangesCursor,
  listMailThreadsChangedSince,
  MAIL_THREAD_CHANGES_LIMIT,
  mailThreadChangesCursorIsStale,
  parseMailThreadChangesCursor,
  readMailThreadChangePoint,
} from "./mailThreadChanges.js";
import type { CustomRouteResult, RouteParams, RouteUrl } from "../customRoute.js";
import { requestUrl } from "../customRoute.js";

type MailThreadViewFilters = Pick<
  NonNullable<Parameters<typeof listMailThreads>[3]>,
  "box" | "folderId" | "mailboxId" | "projectId" | "areaId" | "personId" | "unread"
>;

/** The filters naming one list view: the list's and the delta's query parameters. */
function parseMailThreadViewFilters(url: URL): MailThreadViewFilters {
  const box = url.searchParams.get("box") ?? "inbox";
  if (box !== "inbox" && box !== "flagged" && box !== "sempDrafts")
    throw new ValidationError("Invalid box", { field: "box" });
  const uuidParam = (field: string) => {
    const value = url.searchParams.get(field);
    if (value !== null && !z.uuid().safeParse(value).success) throw new ValidationError(`Invalid ${field}`, { field });
    return value;
  };
  const rawUnread = url.searchParams.get("unread");
  if (rawUnread !== null && rawUnread !== "true" && rawUnread !== "false")
    throw new ValidationError("Invalid unread", { field: "unread" });
  return {
    box,
    folderId: uuidParam("folderId"),
    mailboxId: uuidParam("mailboxId"),
    projectId: uuidParam("projectId"),
    areaId: uuidParam("areaId"),
    personId: uuidParam("personId"),
    unread: rawUnread === "true",
  };
}

/**
 * One page of the view, newest first. `changesCursor` is the tenant's mail change point read in the page's own
 * snapshot, so `GET /api/mail/threads/changes?since=` from it lists exactly the changes the page does not show.
 */
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
    const filters = parseMailThreadViewFilters(url);
    const q = (url.searchParams.get("q") ?? "").trim();
    if (q.length > 1000) throw new ValidationError("Invalid q", { field: "q" });
    const search = q ? parseMailSearchQuery(q, true) : undefined;
    if (search && hasInvalidMailSearchDate(search)) throw new ValidationError("Invalid search date", { field: "q" });
    const { rows, point } = await withTransaction(
      pool,
      async (client) => {
        const point = await readMailThreadChangePoint(client);
        return { rows: await listMailThreads(client, limit, cursor, { ...filters, search }), point };
      },
      { isolation: "repeatable_read" },
    );
    const hasMore = rows.length > limit;
    const threads = rows.slice(0, limit);
    const last = threads.at(-1);
    const nextCursor =
      hasMore && last
        ? Buffer.from(JSON.stringify({ at: last.lastMessageAt, id: last.threadId })).toString("base64url")
        : null;
    return { status: 200, body: { threads, nextCursor, changesCursor: encodeMailThreadChangesCursor(point) } };
  };
}

/**
 * `GET /api/mail/threads/changes?since=` with the list's view filters (no `q`: search results are not a view).
 * Answers the rows of the threads stamped after `since` that are in the view (`threads`, as the list shapes them) and
 * the ids of those that are not, or no longer exist (`removed`), all read in one snapshot with the `cursor` to ask
 * from next. `reset: true` (with no rows) when `since` belongs to another counter, names a step the tenant never
 * reached, lies before a change of every row, or more than `MAIL_THREAD_CHANGES_LIMIT` threads changed since: the
 * client then reads the view's first page again. A malformed `since` is a 400.
 */
export function createMailThreadChangesRouteHandler(pool: Pool) {
  return async (ctx: RouteUrl) => {
    const url = requestUrl(ctx.req);
    const rawSince = url.searchParams.get("since");
    if (rawSince === null) throw new ValidationError("Missing since", { field: "since" });
    const since = parseMailThreadChangesCursor(rawSince);
    if (url.searchParams.has("q")) throw new ValidationError("Search results have no changes", { field: "q" });
    const filters = parseMailThreadViewFilters(url);
    const body = await withTransaction(
      pool,
      async (client) => {
        const point = await readMailThreadChangePoint(client);
        const cursor = encodeMailThreadChangesCursor(point);
        const reset = { cursor, threads: [], removed: [], reset: true };
        if (mailThreadChangesCursorIsStale(since, point)) return reset;
        const changed = await listMailThreadsChangedSince(client, since.seq, MAIL_THREAD_CHANGES_LIMIT);
        if (changed === null) return reset;
        const threads =
          changed.length === 0
            ? []
            : await listMailThreads(client, changed.length, null, { ...filters, changedThreadIds: changed });
        const shown = new Set(threads.map((thread) => thread.threadId));
        return { cursor, threads, removed: changed.filter((threadId) => !shown.has(threadId)), reset: false };
      },
      { isolation: "repeatable_read" },
    );
    return { status: 200, body };
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

/** Refuses a change the thread has no received message for, so a 200 never stands for a write that did not happen. */
function noReceivedMessage(): ConflictError {
  return new ConflictError(
    "The thread has no received message to change",
    undefined,
    "mail_thread_no_received_message",
  );
}

/**
 * `read: true` sets `read` on every received copy in every mailbox (mail to oneself delivered to an Inbox included);
 * `read: false` only on the copies of the last received message, and is refused with 409
 * `mail_thread_no_received_message` when there is none. Copies that are not received (the user's own Sent copies,
 * Drafts) are never written. The server loads the versions, so the last write wins.
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
      if (!read && lastIncomingMessageId === null) throw noReceivedMessage();
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
 * `flagged: true` flags the copies of the last received message, and is refused with 409
 * `mail_thread_no_received_message` when there is none; `flagged: false` clears every live copy, own mail, Sent and
 * Drafts included. Locking, writing and invalidation follow the read route.
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
      if (flagged && lastIncomingMessageId === null) throw noReceivedMessage();
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
 * Moves the copies in an Inbox to their own mailbox's Archive (a Gmail API mailbox's synthetic one). The Sent copy an
 * IMAP server keeps of mail to oneself stays in Sent, as it does for the trash route.
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
 * Moves copies in Archive or Trash back: received ones (mail to oneself included) to Inbox, the user's own to Sent;
 * Junk and drafts stay. 409 `mail_thread_not_archived_or_trashed`, `mail_inbox_folder_missing` or
 * `mail_sent_folder_missing`, each changing nothing.
 */
export function createMailThreadRestoreRouteHandler(pool: Pool) {
  return (ctx: RouteParams) => moveMailThread(pool, ctx.params.threadId, selectMailThreadRestoreMoves);
}
