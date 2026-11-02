import { DatabaseError, type PoolClient } from "pg";
import {
  assertManagedTransactionCommittable,
  markManagedTransactionRollbackOnly,
  requireManagedTransaction,
} from "../db/pool.js";
import { ValueLinkBusyError } from "../errors.js";
import * as relationsStore from "./relationsStore.js";
import { assertValueLinkHandoff } from "./valueLinkWrites.js";

export async function runValueLinkAdmissionLock<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DatabaseError && error.code === "55P03") throw new ValueLinkBusyError();
    throw error;
  }
}

export async function withValueLinkRelationAdmission<T>(
  client: PoolClient,
  input: {
    definitionId: string;
    itemA: string;
    itemB: string;
    callerItemId: string;
    propertyKey: string;
    insert: boolean;
  },
  hooks: () => Promise<void>,
  body: () => Promise<T>,
): Promise<T> {
  requireManagedTransaction(client);
  try {
    await hooks();
  } catch (error) {
    if (error instanceof ValueLinkBusyError) markManagedTransactionRollbackOnly(client, error);
    throw error;
  }
  try {
    if (input.insert && !(await relationsStore.tryLockRelationDefinition(client, input.definitionId))) {
      throw new ValueLinkBusyError();
    }
    await relationsStore.lockExistingRelationNowait(client, input.definitionId, input.itemA, input.itemB);
  } catch (error) {
    const result = error instanceof DatabaseError && error.code === "55P03" ? new ValueLinkBusyError() : error;
    if (result instanceof ValueLinkBusyError) markManagedTransactionRollbackOnly(client, result);
    throw result;
  }

  let previous: string;
  try {
    const { rows } = await client.query<{ setting: string }>("SELECT current_setting('lock_timeout') AS setting");
    if (typeof rows[0]?.setting !== "string") throw new Error("Missing lock timeout setting");
    previous = rows[0].setting;
    await client.query<{ set_config: string }>("SELECT set_config('lock_timeout', $1, true)", ["1ms"]);
  } catch (error) {
    markManagedTransactionRollbackOnly(client, error);
    throw error;
  }
  let result: T;
  try {
    await assertValueLinkHandoff(client, {
      itemId: input.callerItemId,
      propertyKey: input.propertyKey,
      lockMode: "nowait",
    });
    result = await body();
    assertManagedTransactionCommittable(client);
  } catch (error) {
    const failure = error instanceof DatabaseError && error.code === "55P03" ? new ValueLinkBusyError() : error;
    markManagedTransactionRollbackOnly(client, failure);
    throw failure;
  }
  try {
    await client.query<{ set_config: string }>("SELECT set_config('lock_timeout', $1, true)", [previous]);
  } catch (error) {
    markManagedTransactionRollbackOnly(client, error);
    throw error;
  }
  return result;
}
