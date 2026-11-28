import type { ModuleRegistry, ModuleWorkerProjection } from "@alldots/module-registry";

/**
 * One worker process that should exist: one per active row (e.g. `alldots-mailsync@<mailboxId>`), or exactly one
 * with `rowId: null` for a singleton.
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
 * The active rows a worker scales over, or `null` for a singleton. Supplied by the composition root, which alone
 * knows which rows are active (e.g. non-deleted Mailboxes rows).
 */
export type WorkerActiveRowIdsSource = (
  worker: ModuleWorkerProjection,
) => Promise<readonly string[] | null> | readonly string[] | null;

/**
 * Keyed by instance id so the result does not depend on iteration order. Inactive modules contribute nothing
 * because `getWorkers()` already excludes them.
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

/** Start/stop intents only; hosting the process (systemd, a Runner, ...) is the composition root's job. */
export interface WorkerSupervisorPort {
  start(instance: WorkerInstanceIdentity): Promise<void>;
  stop(instance: WorkerInstanceIdentity): Promise<void>;
}

export interface ModuleWorkerInstanceReconciler {
  /**
   * Diffs the desired set against what is believed hosted, by id, so an unchanged set issues no calls. Passes are
   * serialized (a call waits for the previous pass to settle) so no id is started twice; each call's promise settles
   * with its own pass's outcome.
   */
  reconcileOnce(): Promise<void>;
  /** For tests and introspection. */
  getHostedInstanceIds(): ReadonlySet<string>;
}

export function createModuleWorkerInstanceReconciler(
  moduleRegistry: ModuleRegistry,
  getActiveRowIds: WorkerActiveRowIdsSource,
  supervisor: WorkerSupervisorPort,
): ModuleWorkerInstanceReconciler {
  const hosted = new Map<string, DesiredWorkerInstance>();
  let queue: Promise<void> = Promise.resolve();

  async function runOnce(): Promise<void> {
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
  }

  return {
    reconcileOnce() {
      const pass = queue.then(runOnce);
      queue = pass.then(
        () => undefined,
        () => undefined,
      );
      return pass;
    },
    getHostedInstanceIds() {
      return new Set(hosted.keys());
    },
  };
}
