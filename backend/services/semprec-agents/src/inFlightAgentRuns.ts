export interface InFlightAgentRuns {
  /** Tracks `controller` under `tenantId`; the returned function stops tracking it. */
  register(tenantId: string, controller: AbortController): () => void;
  /** Aborts every controller registered for `tenantId` and returns how many it aborted. */
  abortTenant(tenantId: string): number;
}

/** The agent runs executing in this process, by tenant, so a deactivated tenant's can be aborted. */
export function createInFlightAgentRuns(): InFlightAgentRuns {
  const byTenant = new Map<string, Set<AbortController>>();

  return {
    register(tenantId, controller) {
      let controllers = byTenant.get(tenantId);
      if (!controllers) {
        controllers = new Set();
        byTenant.set(tenantId, controllers);
      }
      controllers.add(controller);
      return () => {
        const current = byTenant.get(tenantId);
        if (!current) return;
        current.delete(controller);
        if (current.size === 0) byTenant.delete(tenantId);
      };
    },
    abortTenant(tenantId) {
      const controllers = byTenant.get(tenantId);
      if (!controllers) return 0;
      for (const controller of controllers) controller.abort();
      return controllers.size;
    },
  };
}
