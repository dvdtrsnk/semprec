import type { CreatedBy } from "./types.js";

/**
 * Realtime channel invalidation (LISTEN/NOTIFY fan-out to WS clients). This hook is
 * wired to an actual Postgres NOTIFY publisher by `@semprec/realtime` (issue #23) —
 * see `wireRealtimeHooks` there.
 */
export interface InvalidationEvent {
  databaseId: string;
  itemId: string;
  key: string;
}

export type InvalidationHook = (event: InvalidationEvent) => void;

let hook: InvalidationHook = () => {};

export function setInvalidationHook(next: InvalidationHook): void {
  hook = next;
}

export function notifyInvalidation(event: InvalidationEvent): void {
  hook(event);
}

/**
 * Fired on every binary Yjs update written to `doc_updates` — the CRDT-frame
 * counterpart to `InvalidationEvent`, riding the same realtime fan-out distinguished
 * only by message type (issue #23, point 8). `update` is the raw Yjs update, base64
 * encoded so this event stays plain-JSON-serializable end to end.
 */
export interface DocUpdateEvent {
  docId: string;
  update: string;
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
 */
export interface NotificationCreatedEvent {
  userId: string;
  notification: {
    id: string;
    kind: string;
    title: string;
    linkHref: string | null;
    sourceTable: string;
    sourceId: string;
    transitionInstance: string;
    payload: Record<string, unknown>;
    createdAt: string;
    readAt: string | null;
  };
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
