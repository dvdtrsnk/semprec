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

const flagBodySchema = z.object({ flagged: z.boolean() }).strict();

/**
 * `POST /api/mail/threads/:threadId/flag` with the body `{ flagged: boolean }` (issue gh-1893): flags or unflags
 * the conversation in one transaction and answers `{ threadId, flagged }`, the thread id after the translation of a
 * merged id (issue #1493) and whether the thread is flagged once the writes are done (`readMailThreadFlagged`, the
 * value the thread detail reports). A thread id that is no UUID and a body that is anything but that object are 400s;
 * an unknown id, another tenant's id and a thread without a live message are the same 404.
 *
 * `flagged: true` sets `flagged` on the copies of the last incoming message (`listMailThreadActionMessages`): that
 * message in every mailbox it was delivered to. A thread without an incoming message has nothing to flag, so the call
 * writes nothing and answers the state the thread already had. `flagged: false` clears `flagged` on every live copy of the thread,
 * the user's own mail, Sent and Drafts included. The server loads the versions, so a request carries none and the
 * last write wins.
 *
 * Like the read route, the transaction starts with the tenant's mail-thread guard (`resolveMailThreadForAction`).
 * Each copy is locked, in item id order, and written only when the locked row's `flagged` differs from the requested
 * value; the write is `updateItemWithClient` as the session's user, so the Emails flag hook records the desired state
 * and queues the mailbox sync (issue #1494). After the commit the route sends one `mailThread` invalidation, also when
 * every copy already matched; a rolled-back request sends none.
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
      // The guard `resolveMailThreadForAction` took serializes this request with a reconcile pass and with every
      // other thread action, so the copies, locked in item id order, are never locked against another order.
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
 * Runs one thread move in one transaction and answers `{ threadId, moved }`: the thread id after the translation of a
 * merged id (issue #1493) and the number of copies moved. `select` chooses the copies and, for each, the purpose of the
 * folder it moves to in its own mailbox. The transaction starts with the tenant's mail-thread guard
 * (`resolveMailThreadForAction`); the 409 cases of `select`, of the target folders and of the sources of the moves are decided
 * before the first write, so a refused call changes nothing. After the commit it sends one `mailThread` invalidation, also when
 * nothing needed to move; a rolled-back request sends none.
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
 * `POST /api/mail/threads/:threadId/archive` (issue gh-1917): moves the conversation's copies that are in an Inbox
 * folder to the Archive folder of their own mailbox (for a Gmail API mailbox its synthetic Archive), in every account,
 * and answers `{ threadId, moved }`. Copies in any other folder and drafts stay where they are, and a thread with no
 * copy in an Inbox answers `moved: 0`. A mailbox that holds such a copy and has no Archive folder fails the whole
 * call with 409 `mail_archive_folder_missing` and nothing changes. A thread id that is no UUID is a 400; an unknown id,
 * another tenant's id and a thread without a live message are the same 404. For each moved copy the move is recorded
 * as a pending move and its mailbox sync is enqueued (`applyMailThreadMoves`); nothing is deleted.
 */
export function createMailThreadArchiveRouteHandler(pool: Pool) {
  return (ctx: { params: Record<string, string> }) =>
    moveMailThread(pool, ctx.params.threadId, selectMailThreadArchiveMoves);
}

/**
 * `POST /api/mail/threads/:threadId/trash` (issue gh-1917): moves every counted copy of the conversation that is not
 * already in Trash to the Trash folder of its own mailbox, in every account, and answers `{ threadId, moved }`. Drafts
 * stay where they are. A thread whose counted copies are all in Trash or Junk fails with 409
 * `mail_thread_already_trashed`, a mailbox that holds a copy to move and has no Trash folder with 409
 * `mail_trash_folder_missing`, and in both cases nothing changes. The status codes for a bad, unknown or foreign thread
 * id, the recording of the moves and the invalidation are those of the archive route; nothing is deleted permanently.
 */
export function createMailThreadTrashRouteHandler(pool: Pool) {
  return (ctx: { params: Record<string, string> }) =>
    moveMailThread(pool, ctx.params.threadId, selectMailThreadTrashMoves);
}

/**
 * `POST /api/mail/threads/:threadId/restore` (issue gh-2033): moves the conversation's copies that are in an Archive or
 * Trash folder back, in every account: an incoming copy to the Inbox folder of its own mailbox, the user's own copy to
 * its Sent folder (`selectMailThreadRestoreMoves`), and answers `{ threadId, moved }`. Copies in any other folder, Junk
 * included, and drafts stay where they are. A thread with no copy in Archive or Trash fails with 409
 * `mail_thread_not_archived_or_trashed`, a mailbox without the folder a copy needs with 409
 * `mail_inbox_folder_missing` or `mail_sent_folder_missing`, and in each case nothing changes. The status codes for a
 * bad, unknown or foreign thread id, the recording of the moves (desired purpose `inbox` or `sent`) and the
 * invalidation are those of the archive route.
 */
export function createMailThreadRestoreRouteHandler(pool: Pool) {
  return (ctx: { params: Record<string, string> }) =>
    moveMailThread(pool, ctx.params.threadId, selectMailThreadRestoreMoves);
}
