import type { PoolClient } from "pg";
import { runAfterCommit } from "./db/pool.js";
import type { CreatedBy } from "./types.js";

/**
 * Realtime invalidation, published over Postgres NOTIFY by `@semprec/realtime` (`wireRealtimeHooks`).
 *
 * Always thin, never a full row: the event says "something changed" and the client refetches over REST.
 * `scope: "item"` carries `updatedAt` so a client can skip a stale echo; `scope: "schema"` names only the
 * database, since databases/properties/views have no `updated_at` to compare.
 *
 * Delivery: `approvalRequest`, `agentRuns`, `notificationPreferences`, `badgeCounts` and `account` go only to
 * the sockets of `userId`. `projectAgent`, `sempStatus`, `overview` and `mcpServers` go to every socket of the
 * publisher's tenant regardless of `userId`. Other scopes narrow to `userId` when present and otherwise reach
 * the whole tenant (a background write has no acting user); never another tenant, because the NOTIFY
 * envelope carries the tenant Postgres computed from the publisher's scope.
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
 * Like `notifyInvalidation`, but rejects when sending failed, for a caller whose bookkeeping depends on
 * the message having gone out. The fire-and-forget hook swallows failures; this one hands them to the
 * caller, which then owns logging them.
 */
export type InvalidationPublisher = (event: InvalidationEvent) => Promise<void>;

/** Until a process wires a publisher, events go to the fire-and-forget hook. */
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
 * Fired on every Yjs update written to `doc_updates`. Carries only `updateId`: the update is already
 * committed and a raw Yjs update is unbounded, so it never fits a NOTIFY payload (~8000 bytes).
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
 * Fired once per newly written `notifications` row, never for a deduped replay. Delivered only to
 * `userId`'s sockets. `@semprec/realtime` fetches the full row and broadcasts it, because
 * `notifications.title` is pre-rendered text with no second enforcement layer.
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

/** Fired when notifications become read, so the user's other sessions converge their unread badge. */
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
 * Fired when a session is revoked (logout, device revocation, password-reset cascade). `WS /api/sync`
 * closes only that session's sockets, with code 4401.
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

/** Fired for a committed agent-run event; `@semprec/realtime` fetches the row before delivering it to an authorized watcher. */
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
 * Ephemeral typing update of an agent run, delivered as the `delta` of an `agent:delta` frame; never stored or
 * replayed. Payload types live in `@semprec/realtime` (`protocolV1.ts`).
 */
export interface AgentRunDeltaEvent {
  agentRunId: string;
  delta: unknown;
}

/**
 * Resolves once the delta has been handed on, so a caller can order it before its next step. The wired hook logs a
 * failure instead of rejecting (a lost typing update must never fail the write); an unwired process drops it.
 */
export type AgentRunDeltaHook = (event: AgentRunDeltaEvent) => Promise<void>;

let agentRunDeltaHook: AgentRunDeltaHook = async () => {};

export function setAgentRunDeltaHook(next: AgentRunDeltaHook): void {
  agentRunDeltaHook = next;
}

export function notifyAgentRunDelta(event: AgentRunDeltaEvent): Promise<void> {
  return agentRunDeltaHook(event);
}

/** Fired after commit of a write that changed a Semp thread; best effort to `tenantId`'s sockets, no replay. */
export interface SempThreadInvalidationEvent {
  tenantId: string;
  threadId: string;
}

export type SempThreadInvalidationHook = (event: SempThreadInvalidationEvent) => void;

let sempThreadInvalidationHook: SempThreadInvalidationHook = () => {};

export function setSempThreadInvalidationHook(next: SempThreadInvalidationHook): void {
  sempThreadInvalidationHook = next;
}

/** Publishes after the transaction on `client` commits; a rollback publishes nothing. */
export function publishSempThreadInvalidation(client: PoolClient, tenantId: string, threadId: string): void {
  runAfterCommit(client, () => sempThreadInvalidationHook({ tenantId, threadId }));
}

/**
 * Fired after commit of a change to one Processing proposals card. `op` is `closed` when the card left the
 * stack. Names the card only; delivered to the publisher's tenant, narrowed to `userId` when present.
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
