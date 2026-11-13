import type { PoolClient } from "pg";
import { runAfterCommit } from "./db/pool.js";
import type { CreatedBy } from "./types.js";

/**
 * Realtime channel invalidation (LISTEN/NOTIFY fan-out to WS clients). This hook is
 * wired to an actual Postgres NOTIFY publisher by `@semprec/realtime` (issue #23) —
 * see `wireRealtimeHooks` there.
 *
 * Always thin — never a full row (issue #161): `scope: "item"` names one item that
 * changed (create/update/delete) and its current `updatedAt`, so a client can compare
 * against its cached copy and skip a stale echo; `scope: "schema"` names only the
 * database whose properties/views changed, since databases/properties/views carry no
 * `updated_at` column to compare against. Either way the API refetches the durable row
 * over REST — this event only says "something changed", never what changed to.
 *
 * `userId`, when present, is the user whose write caused this event — `@semprec/realtime`
 * narrows delivery to that user's own sockets inside the tenant, the same as
 * `NotificationCreatedEvent` below. It is absent for a system/background-triggered write (a rollup
 * recompute, a mail-sync job, ...) that has no single acting user to attribute; those reach every
 * socket of the publisher's tenant and never another tenant's, because the NOTIFY envelope carries
 * the tenant computed by Postgres from the publisher's scope.
 *
 * `scope: "approvalRequest"` names one approval request whose state changed (created, decided or
 * finished executing); the client refetches it over REST. Its `userId` is the owner of the request
 * (the actor user of its run), and `@semprec/realtime` delivers the frame to that user's sockets
 * only, never to the rest of the tenant.
 *
 * `scope: "mailThread"` names one mail thread (a group of Emails items) that changed, for example
 * because a message arrived in it; the client refetches the thread, the mailbox counts and the overview.
 * Without a `userId` it reaches every socket of the publisher's tenant, as the other scopes do.
 *
 * `scope: "agentRuns"` names one agent run whose existence, status or approval state changed and the
 * project it belongs to (`null` for a run without a project); the client refetches the run lists.
 * Its `userId` is the actor user of the run, and `@semprec/realtime` delivers the frame to that user's
 * sockets only.
 *
 * `scope: "projectAgent"` names one project whose agent setup (guidance, tool grants, user heartbeats,
 * guidance drift findings) changed; the client refetches the project's agent summary. Its publishers
 * pass no `userId` (the writes that cause it include background ones with no acting user), and
 * `@semprec/realtime` delivers the frame to every socket of the publisher's tenant whatever the event
 * says: the field exists only because every variant of this union has it.
 *
 * `scope: "sempStatus"` says that the tenant's Semp status (its problems and the services derived from
 * them) changed and names nothing else, so it carries no problem text; the client refetches the status.
 * It is delivered to every socket of the publisher's tenant, as `projectAgent` is.
 *
 * `scope: "notificationPreferences"` and `scope: "badgeCounts"` say that one user's stored notification
 * preferences, or the number of decisions pending for that user, changed, and name nothing else; the client
 * refetches the preferences or the counts. Both are per user: they carry the `userId` they concern and
 * `@semprec/realtime` delivers them to that user's sockets only, never to the rest of the tenant.
 *
 * `scope: "account"` says that the profile of `userId` (its display name or language) changed and names nothing
 * else, so it carries neither; the client rereads the profile. It is delivered to that user's sockets only.
 *
 * `scope: "overview"` says that the numbers of the Overview changed without a write that announces it (the
 * nightly rollover of the tasks of a day) and names nothing else. It is delivered to every socket of the
 * publisher's tenant, as `sempStatus` is.
 *
 * `scope: "mcpServers"` says that the effective tools of the projects that have grants on an MCP server may
 * have changed (a server switched on or off, a successful tool synchronization) and names no server and no
 * project; the client refreshes the project summaries it has open. It is delivered to every socket of the
 * publisher's tenant, as `sempStatus` is.
 */
export type InvalidationEvent =
  | {
      scope: "item";
      databaseId: string;
      itemId: string;
      op: "create" | "update" | "delete";
      updatedAt: string;
      userId?: string;
    }
  | {
      scope: "relation";
      databaseId: string;
      itemId: string;
      propertyKey: string | null;
      op: "put" | "delete" | "metadata";
      userId?: string;
    }
  | { scope: "schema"; databaseId: string; userId?: string }
  | { scope: "approvalRequest"; approvalRequestId: string; userId?: string }
  | { scope: "mailThread"; threadId: string; userId?: string }
  | { scope: "agentRuns"; projectItemId: string | null; agentRunId: string; userId?: string }
  | { scope: "projectAgent"; projectItemId: string; userId?: string }
  | { scope: "sempStatus"; userId?: string }
  | { scope: "notificationPreferences"; userId: string }
  | { scope: "badgeCounts"; userId: string }
  | { scope: "account"; userId: string }
  | { scope: "overview"; userId?: string }
  | { scope: "mcpServers"; userId?: string };

export type InvalidationHook = (event: InvalidationEvent) => void;

let hook: InvalidationHook = () => {};

export function setInvalidationHook(next: InvalidationHook): void {
  hook = next;
}

export function notifyInvalidation(event: InvalidationEvent): void {
  hook(event);
}

/**
 * Publishes an invalidation and reports the outcome: it resolves once the realtime message has been sent
 * and rejects when sending it failed. For a caller whose own bookkeeping depends on the message having
 * gone out, such as the AI gateway releasing a window it could not announce. The fire-and-forget hook
 * above, which the write path uses, swallows a failure by design; this one hands it to the caller, which
 * then owns logging it.
 */
export type InvalidationPublisher = (event: InvalidationEvent) => Promise<void>;

/** Until a process wires a publisher, this one hands the event to the fire-and-forget hook of the moment. */
let publisher: InvalidationPublisher = async (event) => {
  hook(event);
};

export function setInvalidationPublisher(next: InvalidationPublisher): void {
  publisher = next;
}

export function publishInvalidation(event: InvalidationEvent): Promise<void> {
  return publisher(event);
}

/**
 * Fired on every binary Yjs update written to `doc_updates` — the CRDT-frame
 * counterpart to `InvalidationEvent`, riding the same realtime fan-out distinguished
 * only by message type (issue #23, point 8). Carries only `updateId` (issue #161) —
 * the update itself is already durably committed to `doc_updates` by the time this
 * fires, and a raw Yjs update has no bound on size, so it never belongs in a NOTIFY
 * payload capped at ~8000 bytes. Resuming doc sync off this reference is a later
 * realtime-v1 sibling issue (#162); until then this event exists only so `updateId`
 * is available end to end.
 */
export interface DocUpdateEvent {
  docId: string;
  updateId: string;
  createdBy: CreatedBy;
}

export type DocUpdateHook = (event: DocUpdateEvent) => void;

let docUpdateHook: DocUpdateHook = () => {};

export function setDocUpdateHook(next: DocUpdateHook): void {
  docUpdateHook = next;
}

export function notifyDocUpdate(event: DocUpdateEvent): void {
  docUpdateHook(event);
}

/**
 * Fired once per newly written `notifications` row (issue #152) — never for a replayed, deduped
 * write. Unlike `InvalidationEvent`/`DocUpdateEvent`, this carries a `userId`: `@semprec/realtime`
 * uses it to fan this frame out only to that user's own connected sockets, never to every client.
 *
 * Carries only `notificationId` (issue #161) — unlike item/schema invalidations, the API is
 * expected to fetch the full row (`getNotificationById`) and broadcast it complete over WS, since
 * `notifications.title` is pre-rendered text with no second enforcement layer to fall back on. That
 * fetch-and-broadcast step lives in `@semprec/realtime`, not here, so this event itself stays thin.
 */
export interface NotificationCreatedEvent {
  userId: string;
  notificationId: string;
}

export type NotificationCreatedHook = (event: NotificationCreatedEvent) => void;

let notificationCreatedHook: NotificationCreatedHook = () => {};

export function setNotificationCreatedHook(next: NotificationCreatedHook): void {
  notificationCreatedHook = next;
}

export function notifyNotificationCreated(event: NotificationCreatedEvent): void {
  notificationCreatedHook(event);
}

/**
 * Fired when one or more of a user's notifications transition to read (issue #152's visit-and-read
 * and mark-all-read), so every other active session for that user can converge its unread badge
 * without re-fetching. Same user-scoped fan-out as `NotificationCreatedEvent`.
 */
export interface NotificationReadStateEvent {
  userId: string;
  notificationIds: string[];
}

export type NotificationReadStateHook = (event: NotificationReadStateEvent) => void;

let notificationReadStateHook: NotificationReadStateHook = () => {};

export function setNotificationReadStateHook(next: NotificationReadStateHook): void {
  notificationReadStateHook = next;
}

export function notifyNotificationReadState(event: NotificationReadStateEvent): void {
  notificationReadStateHook(event);
}

/**
 * Fired whenever a session is actually revoked — logout, remote device revocation, or a
 * password reset's "kick every other session" cascade (issue #160). `WS /api/sync` uses this to
 * close every socket authenticated as that exact session with close code 4401, leaving every
 * other session's sockets untouched.
 */
export interface SessionRevokedEvent {
  sessionId: string;
}

export type SessionRevokedHook = (event: SessionRevokedEvent) => void;

let sessionRevokedHook: SessionRevokedHook = () => {};

export function setSessionRevokedHook(next: SessionRevokedHook): void {
  sessionRevokedHook = next;
}

export function notifySessionRevoked(event: SessionRevokedEvent): void {
  sessionRevokedHook(event);
}

/**
 * Fired for a committed durable agent-run event. It carries only the run and event identifiers:
 * `@semprec/realtime` fetches the durable row before delivering it to an authorized watcher.
 */
export interface AgentRunEventNotification {
  agentRunId: string;
  eventId: string;
}

export type AgentRunEventHook = (event: AgentRunEventNotification) => void;

let agentRunEventHook: AgentRunEventHook = () => {};

export function setAgentRunEventHook(next: AgentRunEventHook): void {
  agentRunEventHook = next;
}

export function notifyAgentRunEvent(event: AgentRunEventNotification): void {
  agentRunEventHook(event);
}

/**
 * Fired after the commit of a write that changed a Semp thread (a message, a state change, a title,
 * a tick run). It names the thread and its tenant only; delivery is best effort, to sockets of
 * `tenantId`, with no replay, and the client refetches the thread.
 */
export interface SempThreadInvalidationEvent {
  tenantId: string;
  threadId: string;
}

export type SempThreadInvalidationHook = (event: SempThreadInvalidationEvent) => void;

let sempThreadInvalidationHook: SempThreadInvalidationHook = () => {};

export function setSempThreadInvalidationHook(next: SempThreadInvalidationHook): void {
  sempThreadInvalidationHook = next;
}

/**
 * Publishes a `sempThread` invalidation once the transaction on `client` has committed; a rollback
 * publishes nothing. Usable from `semprec-api` and `semprec-agents` writes alike: both processes
 * wire the hook through `wireRealtimeHooks`, and the message travels over `semprec_events`.
 */
export function publishSempThreadInvalidation(client: PoolClient, tenantId: string, threadId: string): void {
  runAfterCommit(client, () => sempThreadInvalidationHook({ tenantId, threadId }));
}

/**
 * Fired after the commit of a write that changed one card of the Processing proposals stack (a
 * proposal created, rewritten or closed by a decision). `op` is `closed` when the card left the
 * stack, `created` for a new card and `updated` otherwise. It names the card only, never its
 * content: `@semprec/realtime` delivers it to the sockets of the publisher's tenant, and a client
 * re-reads the card list and its count. `userId`, when present, only narrows delivery to that
 * user's sockets inside the tenant.
 */
export interface InboxCardsInvalidationEvent {
  op: "created" | "updated" | "closed";
  cardId: string;
  userId?: string;
}

export type InboxCardsInvalidationHook = (event: InboxCardsInvalidationEvent) => void;

let inboxCardsInvalidationHook: InboxCardsInvalidationHook = () => {};

export function setInboxCardsInvalidationHook(next: InboxCardsInvalidationHook): void {
  inboxCardsInvalidationHook = next;
}

export function notifyInboxCardsInvalidation(event: InboxCardsInvalidationEvent): void {
  inboxCardsInvalidationHook(event);
}
