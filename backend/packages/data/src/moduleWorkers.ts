import type { ModuleRegistry, ModuleWorkerProjection } from "@semprec/module-registry";

/**
 * One worker process that should currently exist (module-contract issue #110). A worker that
 * scales once per active database row (e.g. `semprec-mailsync@<mailboxId>`) gets one instance
 * per `rowId`; a singleton worker (no row concept) gets exactly one instance with `rowId: null`.
 */
export interface DesiredWorkerInstance {
  moduleId: string;
  workerName: string;
  handlerExport: string;
  rowId: string | null;
}

export interface WorkerInstanceIdentity extends DesiredWorkerInstance {
  /** `workerName` for a singleton, `${workerName}@${rowId}` for a per-row instance. */
  id: string;
}

export function workerInstanceId(instance: Pick<DesiredWorkerInstance, "workerName" | "rowId">): string {
  return instance.rowId === null ? instance.workerName : `${instance.workerName}@${instance.rowId}`;
}

/**
 * Names the active database rows a worker scales one instance per, or `null` if the worker is a
 * singleton (one instance for as long as its module is active, no row concept at all). Supplied
 * by the caller because only a real composition root knows which rows are "active" for a given
 * worker (e.g. non-deleted rows in a Mailboxes database) — this layer stays free of that and of
 * any systemd/queue Runner ownership, per issue #110's scope.
 */
export type WorkerActiveRowIdsSource = (
  worker: ModuleWorkerProjection,
) => Promise<readonly string[] | null> | readonly string[] | null;

/**
 * Derives the deterministic desired set of worker instance identities from the currently active
 * modules' `workers()` projection plus each worker's active rows. Keyed by instance id so the
 * result is stable regardless of the order `getWorkers()`/`getActiveRowIds` produce entries in.
 * A deactivated module never contributes here at all, since `ModuleRegistry.getWorkers()`
 * already excludes it — so "inactive modules produce no worker instances" holds by construction.
 */
export async function deriveDesiredWorkerInstances(
  moduleRegistry: ModuleRegistry,
  getActiveRowIds: WorkerActiveRowIdsSource,
): Promise<Map<string, DesiredWorkerInstance>> {
  const workers = await moduleRegistry.getWorkers();
  const desired = new Map<string, DesiredWorkerInstance>();

  for (const worker of workers) {
    const rowIds = await getActiveRowIds(worker);

    if (rowIds === null) {
      const instance: DesiredWorkerInstance = {
        moduleId: worker.moduleId,
        workerName: worker.name,
        handlerExport: worker.handlerExport,
        rowId: null,
      };
      desired.set(workerInstanceId(instance), instance);
      continue;
    }

    for (const rowId of rowIds) {
      if (rowId.trim().length === 0) {
        throw new Error(`Worker "${worker.name}" (module "${worker.moduleId}") produced a blank row id`);
      }
      const instance: DesiredWorkerInstance = {
        moduleId: worker.moduleId,
        workerName: worker.name,
        handlerExport: worker.handlerExport,
        rowId,
      };
      const id = workerInstanceId(instance);
      if (desired.has(id)) {
        throw new Error(
          `Duplicate worker instance id "${id}" for worker "${worker.name}" (module "${worker.moduleId}")`,
        );
      }
      desired.set(id, instance);
    }
  }

  return desired;
}

/**
 * The only thing a reconciler is allowed to do with a start/stop intent (issue #110) — actually
 * hosting the process (systemd, a graphile-worker Runner, ...) is deliberately a later
 * composition root's job, never this layer's.
 */
export interface WorkerSupervisorPort {
  start(instance: WorkerInstanceIdentity): Promise<void>;
  stop(instance: WorkerInstanceIdentity): Promise<void>;
}

export interface ModuleWorkerInstanceReconciler {
  /**
   * Re-derives the desired instance set and diffs it against what this reconciler already
   * believes is hosted, calling `supervisor.start` for every newly desired id and
   * `supervisor.stop` for every id no longer desired. Comparing by id membership (not by list
   * position) is what makes back-to-back calls with an unchanged desired set issue no further
   * start/stop calls, and makes the emitted intents independent of iteration order.
   */
  reconcileOnce(): Promise<void>;
  /** The instance ids this reconciler currently believes are hosted, for tests/introspection. */
  getHostedInstanceIds(): ReadonlySet<string>;
}

export function createModuleWorkerInstanceReconciler(
  moduleRegistry: ModuleRegistry,
  getActiveRowIds: WorkerActiveRowIdsSource,
  supervisor: WorkerSupervisorPort,
): ModuleWorkerInstanceReconciler {
  const hosted = new Map<string, DesiredWorkerInstance>();

  return {
    async reconcileOnce() {
      const desired = await deriveDesiredWorkerInstances(moduleRegistry, getActiveRowIds);

      for (const [id, instance] of desired) {
        if (hosted.has(id)) continue;
        await supervisor.start({ ...instance, id });
        hosted.set(id, instance);
      }

      for (const [id, instance] of [...hosted]) {
        if (desired.has(id)) continue;
        await supervisor.stop({ ...instance, id });
        hosted.delete(id);
      }
    },
    getHostedInstanceIds() {
      return new Set(hosted.keys());
    },
  };
}
