import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createImapConnectionLimiter,
  HOST_IMAP_CONNECTION_LIMIT,
  HOST_IMAP_LOGINS_PER_MINUTE,
  type ImapConnectionTarget,
} from "../mail/imapConnectionLimiter.js";

const HOST = "imap.example.test";

function work(accountId: string, accountLimit: number, host = HOST): ImapConnectionTarget {
  return { accountId, accountLimit, host, kind: "work" };
}

/** Resolves once pending microtasks (a granted waiter's continuation) settled, without advancing real time. */
const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A task that holds its slot until released, recording how many run at once per key. */
function holders() {
  const active = new Map<string, number>();
  const maxActive = new Map<string, number>();
  const releases: Array<() => void> = [];
  return {
    maxActive,
    releases,
    active: (key: string) => active.get(key) ?? 0,
    task: (key: string) => async () => {
      active.set(key, (active.get(key) ?? 0) + 1);
      maxActive.set(key, Math.max(maxActive.get(key) ?? 0, active.get(key)!));
      await new Promise<void>((resolve) => releases.push(resolve));
      active.set(key, active.get(key)! - 1);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("IMAP connection limiter, per account", () => {
  it("bounds each account's concurrency by its own limit, never another account's", async () => {
    const limiter = createImapConnectionLimiter();
    const active = new Map<string, number>();
    const maxActive = new Map<string, number>();
    const task = (accountId: string, limit: number) =>
      limiter.run({ accountId, accountLimit: limit, host: `${accountId}.example.test`, kind: "work" }, async () => {
        active.set(accountId, (active.get(accountId) ?? 0) + 1);
        maxActive.set(accountId, Math.max(maxActive.get(accountId) ?? 0, active.get(accountId)!));
        await new Promise((resolve) => setTimeout(resolve, 10));
        active.set(accountId, active.get(accountId)! - 1);
      });

    await Promise.all([
      ...Array.from({ length: 3 }, () => task("account-a", 1)),
      ...Array.from({ length: 5 }, () => task("account-b", 3)),
    ]);

    expect(Object.fromEntries(maxActive)).toEqual({ "account-a": 1, "account-b": 3 });
  });

  it("wakes a queued task immediately when a later call raises the account's limit", async () => {
    const limiter = createImapConnectionLimiter();
    let releaseFirst: () => void = () => {};
    const first = limiter.run(work("account-raise", 1), () => new Promise<void>((resolve) => (releaseFirst = resolve)));

    let secondStarted = false;
    const second = limiter.run(work("account-raise", 1), async () => {
      secondStarted = true;
    });
    await flushMicrotasks();
    expect(secondStarted).toBe(false);

    await limiter.run(work("account-raise", 2), async () => {});
    expect(secondStarted).toBe(true);

    releaseFirst();
    await Promise.all([first, second]);
  });

  it("bounds a limit raise's wake-up to the capacity that actually freed up, not every queued waiter", async () => {
    const limiter = createImapConnectionLimiter();
    const held = holders();
    const results = [1, 1, 1, 1].map((limit) => limiter.run(work("account-bounded", limit), held.task("a")));
    await flushMicrotasks();
    expect(held.active("a")).toBe(1);

    const raised = limiter.run(work("account-bounded", 3), held.task("a"));
    await flushMicrotasks();
    expect(held.active("a")).toBe(3);

    for (let i = 0; i < 10 && held.releases.length > 0; i++) {
      held.releases.splice(0).forEach((release) => release());
      await flushMicrotasks();
      expect(held.active("a")).toBeLessThanOrEqual(3);
    }
    await Promise.all([...results, raised]);
    expect(held.maxActive.get("a")).toBe(3);
  });

  it("rejects a queued task that waits past three minutes instead of hanging on a stalled connection", async () => {
    vi.useFakeTimers();
    const limiter = createImapConnectionLimiter();
    void limiter.run(work("account-stalled", 1), () => new Promise<void>(() => {}));
    const queued = limiter.run(work("account-stalled", 1), async () => {});
    const expectation = expect(queued).rejects.toThrow(/Timed out after 180000ms waiting for an IMAP connection slot/);

    await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 1);
    await expectation;
  });

  it("ends a queued wait when the caller's signal aborts, and the slot then goes to the next caller", async () => {
    const limiter = createImapConnectionLimiter();
    const held = holders();
    const first = limiter.run(work("account-abort", 1), held.task("a"));
    const controller = new AbortController();
    const reason = new Error("stopped");
    const aborted = limiter.run(work("account-abort", 1), held.task("a"), controller.signal);
    const third = limiter.run(work("account-abort", 1), held.task("a"));
    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);

    held.releases.shift()!();
    await first;
    await flushMicrotasks();
    expect(held.active("a")).toBe(1);
    held.releases.shift()!();
    await third;
  });
});

describe("IMAP connection limiter, per server host", () => {
  it("holds the host's work connections across two accounts on the same host at the host limit", async () => {
    const limiter = createImapConnectionLimiter();
    const held = holders();
    // Each account's own budget is not the bound: both together exceed the host's.
    const tasks = [
      ...Array.from({ length: HOST_IMAP_CONNECTION_LIMIT }, () =>
        limiter.run(work("account-a", HOST_IMAP_CONNECTION_LIMIT), held.task(HOST)),
      ),
      ...Array.from({ length: 4 }, () => limiter.run(work("account-b", HOST_IMAP_CONNECTION_LIMIT), held.task(HOST))),
    ];
    // Another host is not held up by this one.
    let otherHostRan = false;
    await limiter.run(work("account-c", 1, "imap.other.test"), async () => {
      otherHostRan = true;
    });
    await flushMicrotasks();
    expect(otherHostRan).toBe(true);
    expect(held.active(HOST)).toBe(HOST_IMAP_CONNECTION_LIMIT);

    while (held.releases.length > 0) {
      held.releases.splice(0).forEach((release) => release());
      await flushMicrotasks();
      expect(held.active(HOST)).toBeLessThanOrEqual(HOST_IMAP_CONNECTION_LIMIT);
    }
    await Promise.all(tasks);
    expect(held.maxActive.get(HOST)).toBe(HOST_IMAP_CONNECTION_LIMIT);
  });

  it("counts an IDLE connection against its account and never against the host", async () => {
    const limiter = createImapConnectionLimiter();
    const held = holders();
    const idle = Array.from({ length: HOST_IMAP_CONNECTION_LIMIT + 5 }, (_, index) =>
      limiter.run({ accountId: `idle-${index}`, accountLimit: 1, host: HOST, kind: "idle" }, held.task("idle")),
    );
    await flushMicrotasks();
    expect(held.active("idle")).toBe(HOST_IMAP_CONNECTION_LIMIT + 5);

    // The host's work slots are all free; the IDLE account's own budget of one is not.
    let workRan = false;
    await limiter.run(work("other-account", 1), async () => {
      workRan = true;
    });
    expect(workRan).toBe(true);
    let sameAccountRan = false;
    const sameAccount = limiter.run(work("idle-0", 1), async () => {
      sameAccountRan = true;
    });
    await flushMicrotasks();
    expect(sameAccountRan).toBe(false);

    held.releases.splice(0).forEach((release) => release());
    await Promise.all([...idle, sameAccount]);
    expect(sameAccountRan).toBe(true);
  });

  it("asks an unused kept connection to give its slot up as soon as another caller has to wait for it", async () => {
    const limiter = createImapConnectionLimiter();
    const kept = await limiter.acquire(work("account-kept", 1));
    const reclaim = vi.fn(() => kept.release());
    kept.markIdle(reclaim);
    expect(reclaim).not.toHaveBeenCalled();

    await limiter.run(work("account-kept", 1), async () => {});
    expect(reclaim).toHaveBeenCalledTimes(1);

    // A busy connection is not asked; it gives the slot up when it is released.
    const busy = await limiter.acquire(work("account-busy", 1));
    const busyReclaim = vi.fn();
    busy.markIdle(busyReclaim);
    busy.markBusy();
    let ran = false;
    const waiting = limiter.run(work("account-busy", 1), async () => {
      ran = true;
    });
    await flushMicrotasks();
    expect(busyReclaim).not.toHaveBeenCalled();
    expect(ran).toBe(false);
    // Marked unused while the caller still waits: asked at once.
    busy.markIdle(() => busy.release());
    await waiting;
    expect(ran).toBe(true);
  });

  it("asks a kept connection holding a host slot to give way to another account on the host", async () => {
    const limiter = createImapConnectionLimiter();
    const kept = await Promise.all(
      Array.from({ length: HOST_IMAP_CONNECTION_LIMIT }, (_, index) => limiter.acquire(work(`account-${index}`, 1))),
    );
    const reclaims = kept.map((lease) => {
      const reclaim = vi.fn(() => lease.release());
      lease.markIdle(reclaim);
      return reclaim;
    });
    await limiter.run(work("account-new", 1), async () => {});
    expect(reclaims.filter((reclaim) => reclaim.mock.calls.length > 0)).toHaveLength(1);
    kept.forEach((lease) => lease.release());
  });
});

describe("IMAP login rate per server host", () => {
  it("admits a burst of logins at once, then one per interval in arrival order, per host", async () => {
    vi.useFakeTimers();
    const limiter = createImapConnectionLimiter();
    const intervalMs = 60_000 / HOST_IMAP_LOGINS_PER_MINUTE;
    for (let login = 0; login < HOST_IMAP_LOGINS_PER_MINUTE; login++) await limiter.admitLogin(HOST);

    const admitted: number[] = [];
    const waiting = [0, 1].map((index) => limiter.admitLogin(HOST).then(() => admitted.push(index)));
    // Another host has its own budget.
    await limiter.admitLogin("imap.other.test");
    await vi.advanceTimersByTimeAsync(intervalMs - 1);
    expect(admitted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(admitted).toEqual([0]);
    await vi.advanceTimersByTimeAsync(intervalMs);
    expect(admitted).toEqual([0, 1]);
    await Promise.all(waiting);

    // A full minute without logins restores the whole burst.
    await vi.advanceTimersByTimeAsync(60_000);
    for (let login = 0; login < HOST_IMAP_LOGINS_PER_MINUTE; login++) await limiter.admitLogin(HOST);
  });

  it("ends a login wait when the caller's signal aborts or after three minutes", async () => {
    vi.useFakeTimers();
    const limiter = createImapConnectionLimiter();
    for (let login = 0; login < HOST_IMAP_LOGINS_PER_MINUTE; login++) await limiter.admitLogin(HOST);

    const controller = new AbortController();
    const reason = new Error("stopped");
    const aborted = limiter.admitLogin(HOST, controller.signal);
    controller.abort(reason);
    await expect(aborted).rejects.toBe(reason);

    // Three minutes of backlog at one login per interval: the waiters beyond it are refused at their deadline.
    const queued = Array.from({ length: 70 }, () => limiter.admitLogin(HOST));
    const settled = Promise.allSettled(queued);
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000 + 1);
    const outcomes = await settled;
    expect(outcomes.slice(0, 59).every((outcome) => outcome.status === "fulfilled")).toBe(true);
    expect(outcomes.slice(60)).toEqual(
      Array.from({ length: 10 }, () => ({
        status: "rejected",
        reason: new Error("Timed out after 180000ms waiting for an IMAP login slot of the server"),
      })),
    );
  });
});
