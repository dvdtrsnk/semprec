import { AsyncLocalStorage } from "node:async_hooks";
import type { PoolClient } from "pg";

const context = new AsyncLocalStorage<{ client: PoolClient; hop: number }>();

export function currentPropagationHop(client: PoolClient): number | null {
  const current = context.getStore();
  return current?.client === client ? current.hop : null;
}

export function withPropagationHop<T>(client: PoolClient, hop: number, work: () => Promise<T>): Promise<T> {
  return context.run({ client, hop }, work);
}
