import { describe, expect, it } from "vitest";
import type { ModuleRegistry, ModuleWorkerProjection } from "@semprec/module-registry";
import {
  createModuleWorkerInstanceReconciler,
  deriveDesiredWorkerInstances,
  workerInstanceId,
  type WorkerActiveRowIdsSource,
  type WorkerInstanceIdentity,
  type WorkerSupervisorPort,
} from "../moduleWorkers.js";

function fakeRegistry(workers: ModuleWorkerProjection[]): ModuleRegistry {
  return { getWorkers: async () => workers } as unknown as ModuleRegistry;
}

const mailSyncWorker: ModuleWorkerProjection = {
  moduleId: "mail-sync",
  name: "semprec-mailsync",
  handlerExport: "runMailSyncWorker",
};

const singletonWorker: ModuleWorkerProjection = {
  moduleId: "library",
  name: "semprec-library",
  handlerExport: "runLibraryWorker",
};

describe("workerInstanceId", () => {
  it("is just the worker name for a singleton", () => {
    expect(workerInstanceId({ workerName: "semprec-library", rowId: null })).toBe("semprec-library");
  });

  it("suffixes the worker name with the row id for a per-row instance", () => {
    expect(workerInstanceId({ workerName: "semprec-mailsync", rowId: "mailbox-1" })).toBe("semprec-mailsync@mailbox-1");
  });
});

describe("deriveDesiredWorkerInstances", () => {
  it("derives one instance per active row for a per-row worker", async () => {
    const registry = fakeRegistry([mailSyncWorker]);
    const getActiveRowIds: WorkerActiveRowIdsSource = async () => ["mailbox-1", "mailbox-2"];

    const desired = await deriveDesiredWorkerInstances(registry, getActiveRowIds);

    expect([...desired.keys()].sort()).toEqual(["semprec-mailsync@mailbox-1", "semprec-mailsync@mailbox-2"]);
    expect(desired.get("semprec-mailsync@mailbox-1")).toEqual({
      moduleId: "mail-sync",
      workerName: "semprec-mailsync",
      handlerExport: "runMailSyncWorker",
      rowId: "mailbox-1",
    });
  });

  it("derives exactly one singleton instance when the row source returns null", async () => {
    const registry = fakeRegistry([singletonWorker]);
    const getActiveRowIds: WorkerActiveRowIdsSource = async () => null;

    const desired = await deriveDesiredWorkerInstances(registry, getActiveRowIds);

    expect([...desired.keys()]).toEqual(["semprec-library"]);
    expect(desired.get("semprec-library")).toEqual({
      moduleId: "library",
      workerName: "semprec-library",
      handlerExport: "runLibraryWorker",
      rowId: null,
    });
  });

  it("produces no instances for an inactive module, since getWorkers() already excludes it", async () => {
    const registry = fakeRegistry([]);
    const desired = await deriveDesiredWorkerInstances(registry, async () => ["mailbox-1"]);
    expect(desired.size).toBe(0);
  });

  it("rejects a blank row id", async () => {
    const registry = fakeRegistry([mailSyncWorker]);
    await expect(deriveDesiredWorkerInstances(registry, async () => ["  "])).rejects.toThrow(/blank row id/);
  });

  it("rejects a duplicate row id for the same worker", async () => {
    const registry = fakeRegistry([mailSyncWorker]);
    await expect(deriveDesiredWorkerInstances(registry, async () => ["mailbox-1", "mailbox-1"])).rejects.toThrow(
      /Duplicate worker instance id/,
    );
  });

  it("scopes row sources per worker, mixing singleton and per-row workers", async () => {
    const registry = fakeRegistry([mailSyncWorker, singletonWorker]);
    const getActiveRowIds: WorkerActiveRowIdsSource = async (worker) =>
      worker.name === "semprec-mailsync" ? ["mailbox-1"] : null;

    const desired = await deriveDesiredWorkerInstances(registry, getActiveRowIds);

    expect([...desired.keys()].sort()).toEqual(["semprec-library", "semprec-mailsync@mailbox-1"]);
  });
});

function fakeSupervisor(): WorkerSupervisorPort & {
  started: WorkerInstanceIdentity[];
  stopped: WorkerInstanceIdentity[];
} {
  const started: WorkerInstanceIdentity[] = [];
  const stopped: WorkerInstanceIdentity[] = [];
  return {
    started,
    stopped,
    async start(instance) {
      started.push(instance);
    },
    async stop(instance) {
      stopped.push(instance);
    },
  };
}

describe("createModuleWorkerInstanceReconciler", () => {
  it("starts exactly the newly desired instance when a row is activated", async () => {
    let rowIds = ["mailbox-1"];
    const registry = fakeRegistry([mailSyncWorker]);
    const supervisor = fakeSupervisor();
    const reconciler = createModuleWorkerInstanceReconciler(registry, () => rowIds, supervisor);

    await reconciler.reconcileOnce();
    expect(supervisor.started.map((i) => i.id)).toEqual(["semprec-mailsync@mailbox-1"]);
    expect(reconciler.getHostedInstanceIds()).toEqual(new Set(["semprec-mailsync@mailbox-1"]));

    rowIds = ["mailbox-1", "mailbox-2"];
    await reconciler.reconcileOnce();
    expect(supervisor.started.map((i) => i.id)).toEqual(["semprec-mailsync@mailbox-1", "semprec-mailsync@mailbox-2"]);
    expect(supervisor.stopped).toEqual([]);
  });

  it("stops exactly the deactivated row's instance and nothing else", async () => {
    let rowIds = ["mailbox-1", "mailbox-2"];
    const registry = fakeRegistry([mailSyncWorker]);
    const supervisor = fakeSupervisor();
    const reconciler = createModuleWorkerInstanceReconciler(registry, () => rowIds, supervisor);
    await reconciler.reconcileOnce();

    rowIds = ["mailbox-1"];
    await reconciler.reconcileOnce();

    expect(supervisor.stopped.map((i) => i.id)).toEqual(["semprec-mailsync@mailbox-2"]);
    expect(reconciler.getHostedInstanceIds()).toEqual(new Set(["semprec-mailsync@mailbox-1"]));
  });

  it("is idempotent: reconciling twice against an unchanged desired set issues no further calls", async () => {
    const registry = fakeRegistry([mailSyncWorker]);
    const supervisor = fakeSupervisor();
    const reconciler = createModuleWorkerInstanceReconciler(registry, () => ["mailbox-1"], supervisor);

    await reconciler.reconcileOnce();
    await reconciler.reconcileOnce();

    expect(supervisor.started).toHaveLength(1);
    expect(supervisor.stopped).toHaveLength(0);
  });

  it("produces no worker instances once the owning module goes inactive, stopping every hosted instance", async () => {
    let workers = [mailSyncWorker];
    const registry = { getWorkers: async () => workers } as unknown as ModuleRegistry;
    const supervisor = fakeSupervisor();
    const reconciler = createModuleWorkerInstanceReconciler(registry, () => ["mailbox-1"], supervisor);
    await reconciler.reconcileOnce();

    workers = [];
    await reconciler.reconcileOnce();

    expect(supervisor.stopped.map((i) => i.id)).toEqual(["semprec-mailsync@mailbox-1"]);
    expect(reconciler.getHostedInstanceIds().size).toBe(0);
  });
});
