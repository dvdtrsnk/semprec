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
