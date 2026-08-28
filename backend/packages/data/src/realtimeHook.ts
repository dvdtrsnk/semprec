/**
 * Realtime channel invalidation (LISTEN/NOTIFY fan-out to WS clients) is out of scope
 * for this issue — "just ensure the write hook exists/is callable." This is that hook;
 * a later issue wires `setInvalidationHook` to an actual publisher.
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
