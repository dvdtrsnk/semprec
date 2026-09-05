import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import type { ActionContext, ActionHandler } from "../scheduler/actions.js";
import * as itemsStore from "../chokePoint/itemsStore.js";

export const SEMPREC_TICK_ACTION_ID = "semprec.tick";

/** Graphile-worker queue affinity for `semprec.tick`: all Inbox ticks serialize against each other. */
export const SEMPREC_TICK_QUEUE_NAME = "semprec-tick";

export interface SemprecTickActionConfig {
  inboxDatabaseId: string;
}

/**
 * Registered as an `onItemEvent` ('create'/'update'/'delete') heartbeat action on the Inbox
 * database (issue #103): the dispatch step only. It re-reads the item by id at run time —
 * never trusting anything about its content from the job payload — so when several rapid
 * edits collapse onto one pending job (the heartbeat-fire job key's replace semantics), the
 * single tick that eventually runs reflects whatever state is current at that moment, not a
 * stale snapshot from whichever edit enqueued it. Fingerprinting and the actual proposal
 * computation are issue #223's scope, not this one's — a deleted (or since-deleted) item is
 * a legitimate no-op here, not an error.
 */
export function createSemprecTickAction(pool: Pool): ActionHandler {
  return async (actionConfig: Record<string, unknown>, context: ActionContext) => {
    if (!context.itemId) return;
    const config = actionConfig as unknown as SemprecTickActionConfig;
    await withTransaction(pool, async (client) => {
      const item = await itemsStore.getItemById(client, config.inboxDatabaseId, context.itemId as string);
      if (!item || item.deletedAt) return;
      // Issue #223 computes the actual processing proposal from `item` here.
    });
  };
}
