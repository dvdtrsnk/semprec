// The one producer path onto the per-tenant `item-search-index` lane
// (docs/adr/2026-11-08-search-lane-enqueues-flush-in-order-under-a-tenant-lock-before-commit.md): the
// search fan-out, the backfill and the page-text debounce queue their jobs only through this module.
import type { PoolClient } from "pg";
import { prepareJob, type PreparedJobOptions, type SearchTaskIdentifier } from "@semprec/queue";
import { registerSearchJob } from "../db/pool.js";
import { tenantLane } from "../tenancy/tenantLane.js";

const SEARCH_LANE = "item-search-index";

/**
 * Queues one item-search job in the caller's managed transaction: it is prepared now (envelope,
 * tenant, trace, lane and options captured) and added at that transaction's pre-commit flush, so it
 * exists only if the transaction commits.
 */
export function enqueueSearchLaneJob(
  client: PoolClient,
  identifier: SearchTaskIdentifier,
  payload: Record<string, unknown>,
  options: Omit<PreparedJobOptions, "queueName">,
): void {
  registerSearchJob(client, prepareJob(identifier, payload, { ...options, queueName: tenantLane(SEARCH_LANE) }));
}
