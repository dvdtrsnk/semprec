import type { Pool, PoolClient } from "pg";
import { createProjectAgentGuidanceService, type ProjectAgentGuidanceService } from "@semprec/application";
import { createPoolClientTransactionRunner, guidanceReferenceStore, projectAgentGuidanceStore } from "@semprec/data";
import type { GuidanceHeartbeatStore } from "@semprec/shared";

/**
 * Issue #85 delivers the real `core.agentGuidanceDrift` heartbeat store (its unique index and
 * exact persisted fields). Until then, this documented no-op is what the service's transaction
 * calls — so `upsertProjectAgentGuidance`/`transferProjectAgentGuidance` already perform the
 * heartbeat upsert call inside the same transaction as the guidance write, ready for #85 to
 * swap in a real implementation without touching the service or its transaction boundaries.
 */
export const noopGuidanceHeartbeatStore: GuidanceHeartbeatStore<PoolClient> = {
  async upsertDriftHeartbeat() {
    // Intentional no-op — see this file's header comment.
  },
};

/** Composes the real `ProjectAgentGuidanceService` from this process's concrete `@semprec/data` stores. */
export function createProjectAgentGuidanceServiceForApi(pool: Pool): ProjectAgentGuidanceService {
  return createProjectAgentGuidanceService<PoolClient>({
    store: projectAgentGuidanceStore,
    references: guidanceReferenceStore,
    heartbeats: noopGuidanceHeartbeatStore,
    transactions: createPoolClientTransactionRunner(pool),
  });
}
