import { describe, expect, it } from "vitest";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";

describe("Semp settlement observation", () => {
  it("retains active and late failures until consumed and isolates shutdown abort", async () => {
    const runs = createInFlightAgentRuns();
    const general = new AbortController();
    const semp = new AbortController();
    runs.register("tenant", general);
    runs.register("tenant", semp, true);
    let rejectFirst!: (reason: unknown) => void;
    const first = runs.trackSemp(
      () =>
        new Promise<void>((_, reject) => {
          rejectFirst = reject;
        }),
    );
    void first.catch(() => {});
    await Promise.resolve();
    const settle = runs.observeSempSettlement();
    const late = runs.trackSemp(async () => {
      // The shutdown contract retains non-Error and falsy rejection reasons.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw null;
    });
    void late.catch(() => {});
    expect(runs.abortSemp()).toBe(1);
    expect(semp.signal.reason).toBe("shutdown");
    expect(general.signal.aborted).toBe(false);
    const later = new AbortController();
    runs.register("tenant", later, true);
    expect(later.signal.reason).toBe("shutdown");
    rejectFirst(false);
    const failures = await settle.wait();
    expect(failures).toHaveLength(2);
    expect(failures).toContain(null);
    expect(failures).toContain(false);
  });

  it("snapshots observed failures without treating active work as settled", async () => {
    const runs = createInFlightAgentRuns();
    const observation = runs.observeSempSettlement();
    const failed = runs.trackSemp(async () => {
      // The shutdown contract retains non-Error and falsy rejection reasons.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw false;
    });
    await failed.catch(() => {});
    let rejectLate!: (reason: unknown) => void;
    const late = runs.trackSemp(
      () =>
        new Promise<void>((_, reject) => {
          rejectLate = reject;
        }),
    );
    void late.catch(() => {});
    await Promise.resolve();
    expect(observation.snapshotAndDispose()).toEqual([false]);
    expect(observation.snapshotAndDispose()).toEqual([]);
    rejectLate(null);
    await late.catch(() => {});
    await expect(observation.wait()).rejects.toThrow("observation was disposed");
  });
});

const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";

describe("createInFlightAgentRuns", () => {
  it("aborts only the given tenant's controllers and counts them", () => {
    const runs = createInFlightAgentRuns();
    const a = new AbortController();
    const b = new AbortController();
    runs.register(TENANT_A, a);
    runs.register(TENANT_B, b);

    expect(runs.abortTenant(TENANT_B)).toBe(1);

    expect(b.signal.aborted).toBe(true);
    expect(a.signal.aborted).toBe(false);
  });

  it("aborts every controller of a tenant that has several", () => {
    const runs = createInFlightAgentRuns();
    const first = new AbortController();
    const second = new AbortController();
    runs.register(TENANT_B, first);
    runs.register(TENANT_B, second);

    expect(runs.abortTenant(TENANT_B)).toBe(2);

    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it("no longer counts or aborts a registration after its unregister function ran", () => {
    const runs = createInFlightAgentRuns();
    const controller = new AbortController();
    const unregister = runs.register(TENANT_B, controller);

    unregister();

    expect(runs.abortTenant(TENANT_B)).toBe(0);
    expect(controller.signal.aborted).toBe(false);
  });

  it("keeps a tenant's other registrations when one unregisters", () => {
    const runs = createInFlightAgentRuns();
    const unregisterFirst = runs.register(TENANT_B, new AbortController());
    const second = new AbortController();
    runs.register(TENANT_B, second);

    unregisterFirst();

    expect(runs.abortTenant(TENANT_B)).toBe(1);
    expect(second.signal.aborted).toBe(true);
  });

  it("returns 0 for a tenant with nothing registered", () => {
    expect(createInFlightAgentRuns().abortTenant(TENANT_A)).toBe(0);
  });

  it("tolerates a second call of the same unregister function", () => {
    const runs = createInFlightAgentRuns();
    const unregister = runs.register(TENANT_B, new AbortController());
    unregister();
    expect(() => unregister()).not.toThrow();
  });
});
