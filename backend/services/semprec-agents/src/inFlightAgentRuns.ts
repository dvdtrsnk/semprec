export interface SempSettlementObservation {
  wait(): Promise<unknown[]>;
  snapshotAndDispose(): unknown[];
}

export interface InFlightAgentRuns {
  /** Tracks `controller` under `tenantId`; the returned function stops tracking it. */
  register(tenantId: string, controller: AbortController, semp?: boolean): () => void;
  /** Aborts every controller registered for `tenantId` and returns how many it aborted. */
  abortTenant(tenantId: string): number;
  /**
   * Tracks `controller` under the assistant message `assistantMessageId` of `tenantId`, so that one turn can be aborted
   * by `abortTurn`; the returned function stops tracking it. Independent of `register`, which tracks the same job per tenant.
   */
  registerTurn(tenantId: string, assistantMessageId: string, controller: AbortController): () => void;
  /** Aborts the controllers registered for that turn of that tenant; `false` when this process runs no such turn. */
  abortTurn(tenantId: string, assistantMessageId: string): boolean;
  abortSemp(): number;
  trackSemp<T>(work: () => Promise<T>): Promise<T>;
  observeSempSettlement(): SempSettlementObservation;
}

/** The agent runs executing in this process, by tenant, so a deactivated tenant's can be aborted. */
export function createInFlightAgentRuns(): InFlightAgentRuns {
  const byTenant = new Map<string, Set<AbortController>>();
  const sempControllers = new Set<AbortController>();
  // Keyed by both ids: a turn is found only under the tenant that runs it, so a message id of another tenant matches nothing.
  const byTurn = new Map<string, Set<AbortController>>();
  const turnKey = (tenantId: string, assistantMessageId: string) => `${tenantId}/${assistantMessageId}`;
  let sempAborted = false;
  const active = new Set<Promise<void>>();
  let observer: { failures: unknown[]; disposed: boolean } | undefined;

  return {
    trackSemp(work) {
      const result = Promise.resolve().then(work);
      const observed = result.then(
        () => {},
        (error: unknown) => {
          observer?.failures.push(error);
        },
      );
      active.add(observed);
      void observed.then(() => {
        active.delete(observed);
      });
      return result;
    },
    observeSempSettlement() {
      if (observer) throw new Error("Semp settlement is already being observed");
      const current: { failures: unknown[]; disposed: boolean } = { failures: [], disposed: false };
      observer = current;
      const dispose = () => {
        if (current.disposed) return [];
        current.disposed = true;
        if (observer === current) observer = undefined;
        return current.failures.slice();
      };
      return {
        async wait() {
          while (active.size > 0) {
            await Promise.all([...active]);
            if (current.disposed) throw new Error("Semp settlement observation was disposed");
          }
          if (current.disposed) throw new Error("Semp settlement observation was disposed");
          return dispose();
        },
        snapshotAndDispose: dispose,
      };
    },
    register(tenantId, controller, semp = false) {
      let controllers = byTenant.get(tenantId);
      if (!controllers) {
        controllers = new Set();
        byTenant.set(tenantId, controllers);
      }
      controllers.add(controller);
      if (semp) {
        sempControllers.add(controller);
        if (sempAborted) controller.abort("shutdown");
      }
      return () => {
        sempControllers.delete(controller);
        const current = byTenant.get(tenantId);
        if (!current) return;
        current.delete(controller);
        if (current.size === 0) byTenant.delete(tenantId);
      };
    },
    registerTurn(tenantId, assistantMessageId, controller) {
      const key = turnKey(tenantId, assistantMessageId);
      let controllers = byTurn.get(key);
      if (!controllers) {
        controllers = new Set();
        byTurn.set(key, controllers);
      }
      controllers.add(controller);
      return () => {
        const current = byTurn.get(key);
        if (!current) return;
        current.delete(controller);
        if (current.size === 0) byTurn.delete(key);
      };
    },
    abortTurn(tenantId, assistantMessageId) {
      const controllers = byTurn.get(turnKey(tenantId, assistantMessageId));
      if (!controllers) return false;
      for (const controller of controllers) controller.abort();
      return true;
    },
    abortTenant(tenantId) {
      const controllers = byTenant.get(tenantId);
      if (!controllers) return 0;
      for (const controller of controllers) controller.abort();
      return controllers.size;
    },
    abortSemp() {
      sempAborted = true;
      for (const controller of sempControllers) controller.abort("shutdown");
      return sempControllers.size;
    },
  };
}
