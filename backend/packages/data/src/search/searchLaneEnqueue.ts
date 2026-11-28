// The only producer path onto the per-tenant `item-search-index` lane (see
// docs/architecture/tenancy-and-security.md#queue-lanes-and-job-keys).
import type { PoolClient } from "pg";
import { prepareJob, type PreparedJobOptions, type SearchTaskIdentifier } from "@alldots/queue";
import { registerSearchJob } from "../db/pool.js";
import { tenantLane } from "../tenancy/tenantLane.js";

const SEARCH_LANE = "item-search-index";

/** Captured now and added at the transaction's pre-commit flush, so the job exists only if it commits. */
export function enqueueSearchLaneJob(
  client: PoolClient,
  identifier: SearchTaskIdentifier,
  payload: Record<string, unknown>,
  options: Omit<PreparedJobOptions, "queueName">,
): void {
  registerSearchJob(client, prepareJob(identifier, payload, { ...options, queueName: tenantLane(SEARCH_LANE) }));
}
