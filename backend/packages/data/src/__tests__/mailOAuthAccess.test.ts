import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
import { runInTenant } from "@semprec/shared";
import { getDecryptedCredential, storeCredential } from "../credentials/externalCredentialsStore.js";
import { logger } from "../mail/logger.js";
import { refreshAndPersistAccessToken, type RefreshAndPersistAccessTokenInput } from "../mail/mailOAuthAccess.js";
import { MailReauthorizationRequiredError } from "../mail/providerTypes.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { createRuntimeRolePool, createTestTenant, getTenantZeroId } from "../testSupport/tenantFixtures.js";
import { withTransaction } from "../db/pool.js";

const failure = vi.hoisted(() => ({ storeCredential: false, remainingWrites: 0 }));

vi.mock("../credentials/externalCredentialsStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials/externalCredentialsStore.js")>();
  return {
    ...actual,
    storeCredential: (...args: Parameters<typeof actual.storeCredential>) => {
      if (failure.storeCredential || failure.remainingWrites > 0) {
        if (failure.remainingWrites > 0) failure.remainingWrites -= 1;
        const error = new Error("rt-new-secret csecret");
        error.name = "rt-old";
        return Promise.reject(error);
      }
      return actual.storeCredential(...args);
    },
  };
});

const INPUT = {
  tokenUrl: "https://idp.test/token",
  clientId: "cid",
  clientSecret: "csecret",
  purpose: "test_sync",
} as const;

let pool: Pool;

function refreshInTenant(pool: Pool, input: RefreshAndPersistAccessTokenInput) {
  return runInTenant(getTenantZeroId(), () => refreshAndPersistAccessToken(pool, input));
}

interface FakeProvider {
  presented: string[];
}

/**
 * Fake token endpoint recording every refresh token presented to it. `rotate` returns the token issued
 * in exchange (undefined = no rotation). With `valid` set, a presented token is single use and any
 * other token is rejected with `rejectStatus`.
 */
function fakeProvider(options: {
  rotate?: (presented: string) => string | undefined;
  valid?: Set<string>;
  rejectStatus?: number;
  delayMs?: number;
}): FakeProvider {
  const provider: FakeProvider = { presented: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: URLSearchParams }) => {
      const presented = init.body.get("refresh_token") ?? "";
      provider.presented.push(presented);
      if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      if (options.valid && !options.valid.has(presented)) {
        return new Response("invalid_grant", { status: options.rejectStatus ?? 400 });
      }
      options.valid?.delete(presented);
      const next = options.rotate?.(presented);
      if (next) options.valid?.add(next);
      return Response.json({
        access_token: `access-for-${presented}`,
        expires_in: 3600,
        ...(next ? { refresh_token: next } : {}),
      });
    }),
  );
  return provider;
}

async function stored(itemId: string): Promise<string | null> {
  return getDecryptedCredential(pool, { itemId, actorType: "sync_worker", purpose: "test_read" });
}

async function seed(token: string): Promise<string> {
  const itemId = randomUUID();
  await storeCredential(pool, { itemId, credentialType: "oauth2_refresh_token", plaintext: token });
  return itemId;
}

describe("refreshAndPersistAccessToken", () => {
  beforeAll(() => {
    pool = getTestPool();
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await resetDatabase(pool);
    failure.storeCredential = false;
    failure.remainingWrites = 0;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stores a rotated refresh token and the next refresh presents it", async () => {
    const itemId = await seed("rt-1");
    const provider = fakeProvider({ valid: new Set(["rt-1"]), rotate: (p) => (p === "rt-1" ? "rt-2" : "rt-3") });

    const first = await refreshInTenant(pool, { ...INPUT, mailboxItemId: itemId });
    expect(first.accessToken).toBe("access-for-rt-1");
    expect(first.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await stored(itemId)).toBe("rt-2");

    const second = await refreshInTenant(pool, { ...INPUT, mailboxItemId: itemId });
    expect(second.accessToken).toBe("access-for-rt-2");
    expect(provider.presented).toEqual(["rt-1", "rt-2"]);
    expect(await stored(itemId)).toBe("rt-3");
  });

  it("leaves the stored token unchanged when the provider returns no new one", async () => {
    const itemId = await seed("rt-1");
    fakeProvider({});
    await refreshInTenant(pool, { ...INPUT, mailboxItemId: itemId });
    expect(await stored(itemId)).toBe("rt-1");
  });

  it("serializes concurrent refreshes so each token is presented exactly once", async () => {
    const itemId = await seed("rt-1");
    let n = 1;
    const provider = fakeProvider({ valid: new Set(["rt-1"]), rotate: () => `rt-${++n}`, delayMs: 50 });
    const results = await Promise.all([
      refreshInTenant(pool, { ...INPUT, mailboxItemId: itemId }),
      refreshInTenant(pool, { ...INPUT, mailboxItemId: itemId }),
    ]);
    expect([...provider.presented].sort()).toEqual(["rt-1", "rt-2"]);
    expect(results.map((r) => r.accessToken).sort()).toEqual(["access-for-rt-1", "access-for-rt-2"]);
    expect(await stored(itemId)).toBe("rt-3");
  });

  it.each([400, 401])("throws MailReauthorizationRequiredError on provider status %i", async (status) => {
    const itemId = await seed("rt-1");
    fakeProvider({ valid: new Set(), rejectStatus: status });
    const err: unknown = await refreshInTenant(pool, { ...INPUT, mailboxItemId: itemId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MailReauthorizationRequiredError);
    if (err instanceof Error) expect(err.message).not.toContain("rt-1");
    expect(await stored(itemId)).toBe("rt-1");
  });

  it("throws when no credential is stored, without calling the provider", async () => {
    const provider = fakeProvider({});
    await expect(refreshInTenant(pool, { ...INPUT, mailboxItemId: randomUUID() })).rejects.toThrow(
      /No OAuth credential/,
    );
    expect(provider.presented).toEqual([]);
  });

  it("rejects an unscoped refresh before calling the provider", async () => {
    const provider = fakeProvider({});
    await expect(refreshAndPersistAccessToken(pool, { ...INPUT, mailboxItemId: randomUUID() })).rejects.toThrow(
      /tenant scope/,
    );
    expect(provider.presented).toEqual([]);
  });

  it("allows the owning tenant and refuses a foreign credential without a provider request", async () => {
    const otherTenant = await createTestTenant(pool);
    const runtimePool = await createRuntimeRolePool(pool, "semprec_data");
    const itemId = randomUUID();
    try {
      await runInTenant(otherTenant, () =>
        withTransaction(runtimePool, (client) =>
          storeCredential(client, { itemId, credentialType: "oauth2_refresh_token", plaintext: "owned-token" }),
        ),
      );
      const provider = fakeProvider({ rotate: () => "rotated-token" });
      await expect(
        runInTenant(getTenantZeroId(), () =>
          refreshAndPersistAccessToken(runtimePool, { ...INPUT, mailboxItemId: itemId }),
        ),
      ).rejects.toThrow(/No OAuth credential/);
      expect(provider.presented).toEqual([]);
      const result = await runInTenant(otherTenant, () =>
        refreshAndPersistAccessToken(runtimePool, { ...INPUT, mailboxItemId: itemId }),
      );
      expect(result.accessToken).toBe("access-for-owned-token");
      expect(provider.presented).toEqual(["owned-token"]);
      expect(
        await runInTenant(otherTenant, () =>
          withTransaction(runtimePool, (client) =>
            getDecryptedCredential(client, { itemId, actorType: "sync_worker", purpose: "test_read" }),
          ),
        ),
      ).toBe("rotated-token");
    } finally {
      await runtimePool.end();
    }
  });

  it.each(["A", "B"])("waits on the actual credential lock with caller %s starting first", async (firstLabel) => {
    const itemId = await seed("generation-1");
    const independentItem = await seed("independent-mailbox");
    const otherTenant = await createTestTenant(pool);
    const otherTenantItem = randomUUID();
    await runInTenant(otherTenant, () =>
      withTransaction(pool, (client) =>
        storeCredential(client, {
          itemId: otherTenantItem,
          credentialType: "oauth2_refresh_token",
          plaintext: "other-tenant",
        }),
      ),
    );
    const operationPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: "-c role=semprec_data",
    });
    const pids: Promise<{ pid: number } | { error: unknown }>[] = [];
    operationPool.on("acquire", (client) => {
      pids.push(
        client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid").then(
          (result) => result.rows[0] ?? { error: new Error("Missing operation backend PID") },
          (error: unknown) => ({ error }),
        ),
      );
    });
    let releaseProvider: () => void = () => {};
    let firstEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => (firstEntered = resolve));
    const held = new Promise<void>((resolve) => (releaseProvider = resolve));
    const presented: string[] = [];
    const callers: string[] = [];
    const fetchFor =
      (label: string): typeof fetch =>
      async (_url, init) => {
        const body = init?.body;
        if (!(body instanceof URLSearchParams)) throw new Error("Unexpected request body");
        const token = body.get("refresh_token");
        if (token === null) throw new Error("Missing refresh token");
        presented.push(token);
        callers.push(label);
        if (presented.length === 1) {
          firstEntered();
          await held;
        }
        return Response.json({
          access_token: "access",
          refresh_token: token === "generation-1" ? "generation-2" : "generation-3",
          expires_in: 60,
        });
      };
    const start = (label: string) =>
      runInTenant(getTenantZeroId(), () =>
        refreshAndPersistAccessToken(operationPool, { ...INPUT, mailboxItemId: itemId, fetchImpl: fetchFor(label) }),
      );
    const participants: Promise<unknown>[] = [];
    try {
      const first = start(firstLabel);
      participants.push(first);
      await Promise.race([
        entered,
        first.then(
          () => {
            throw new Error("Refresh completed before the provider barrier");
          },
          (error: unknown) => {
            throw error;
          },
        ),
      ]);
      const second = start(firstLabel === "A" ? "B" : "A");
      participants.push(second);
      const outcomes = Promise.allSettled(participants);
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (pids.length >= 2) {
          const [holder, waiter] = await Promise.all([pids[0], pids[1]]);
          if (!holder || !waiter) throw new Error("Missing operation PID observation");
          if ("error" in holder) throw holder.error;
          if ("error" in waiter) throw waiter.error;
          const result = await pool.query<{ blocked: boolean }>(
            "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
            [holder.pid, waiter.pid],
          );
          if (result.rows[0]?.blocked) {
            blocked = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      expect(presented).toEqual(["generation-1"]);
      const independentFetch: typeof fetch = async (_url, init) => {
        if (!(init?.body instanceof URLSearchParams)) throw new Error("Unexpected request body");
        return Response.json({ access_token: `access-${init.body.get("refresh_token")}`, expires_in: 60 });
      };
      const independent = await runInTenant(getTenantZeroId(), () =>
        refreshAndPersistAccessToken(operationPool, {
          ...INPUT,
          mailboxItemId: independentItem,
          fetchImpl: independentFetch,
        }),
      );
      const other = await runInTenant(otherTenant, () =>
        refreshAndPersistAccessToken(operationPool, {
          ...INPUT,
          mailboxItemId: otherTenantItem,
          fetchImpl: independentFetch,
        }),
      );
      expect(independent.accessToken).toBe("access-independent-mailbox");
      expect(other.accessToken).toBe("access-other-tenant");
      expect(presented).toEqual(["generation-1"]);
      releaseProvider();
      await expect(Promise.all(participants)).resolves.toHaveLength(2);
      await outcomes;
      expect(presented).toEqual(["generation-1", "generation-2"]);
      expect(callers).toEqual([firstLabel, firstLabel === "A" ? "B" : "A"]);
      expect(await stored(itemId)).toBe("generation-3");
    } finally {
      releaseProvider();
      await Promise.allSettled(participants);
      await Promise.all(pids);
      await operationPool.end();
    }
  });

  it.each([
    { configured: "0", expectedLock: "30s", expectedStatement: "1min" },
    { configured: "1s", expectedLock: "1s", expectedStatement: "1s" },
    { configured: "120s", expectedLock: "30s", expectedStatement: "1min" },
  ])("caps transaction-local waits while preserving configured $configured settings", async (scenario) => {
    const itemId = await seed("generation-1");
    const operationPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: `-c role=semprec_data -c lock_timeout=${scenario.configured} -c statement_timeout=${scenario.configured}`,
      max: 1,
    });
    let operationClient: PoolClient | undefined;
    operationPool.on("acquire", (client) => {
      operationClient = client;
    });
    let inside: { lock: string; statement: string } | undefined;
    const fetchImpl: typeof fetch = async () => {
      if (!operationClient) throw new Error("Missing refresh operation client");
      const result = await operationClient.query<{ lock: string; statement: string }>(
        "SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement",
      );
      inside = result.rows[0];
      return Response.json({ access_token: "access", expires_in: 60 });
    };
    try {
      await runInTenant(getTenantZeroId(), () =>
        refreshAndPersistAccessToken(operationPool, { ...INPUT, mailboxItemId: itemId, fetchImpl }),
      );
      expect(inside).toEqual({ lock: scenario.expectedLock, statement: scenario.expectedStatement });
      const client = await operationPool.connect();
      try {
        const after = await client.query<{ lock: string; statement: string }>(
          "SELECT current_setting('lock_timeout') AS lock, current_setting('statement_timeout') AS statement",
        );
        expect(after.rows[0]).toEqual({
          lock: scenario.configured === "120s" ? "2min" : scenario.configured,
          statement: scenario.configured === "120s" ? "2min" : scenario.configured,
        });
      } finally {
        client.release();
      }
    } finally {
      await operationPool.end();
    }
  });

  it("releases the actual credential lock to a waiter after the refresh deadline", async () => {
    const itemId = await seed("before-timeout");
    const operationPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: "-c role=semprec_data",
    });
    const pids: Promise<number>[] = [];
    operationPool.on("acquire", (client) => {
      pids.push(
        client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid").then((result) => {
          const pid = result.rows[0]?.pid;
          if (!pid) throw new Error("Missing operation PID");
          return pid;
        }),
      );
    });
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let aborted = false;
    const heldFetch: typeof fetch = async (_url, init) => {
      const signal = init?.signal;
      if (!signal) throw new Error("Missing refresh abort signal");
      entered();
      return new Promise<Response>((_resolve, reject) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            reject(new Error("fixture refresh aborted"));
          },
          { once: true },
        ),
      );
    };
    const succeedingFetch: typeof fetch = async () => Response.json({ access_token: "after-timeout", expires_in: 60 });
    const run = (fetchImpl: typeof fetch) =>
      runInTenant(getTenantZeroId(), () =>
        refreshAndPersistAccessToken(operationPool, { ...INPUT, mailboxItemId: itemId, fetchImpl }),
      );
    const first = run(heldFetch).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let second:
      | Promise<
          { ok: true; value: Awaited<ReturnType<typeof refreshAndPersistAccessToken>> } | { ok: false; error: unknown }
        >
      | undefined;
    const failures: unknown[] = [];
    try {
      await Promise.race([
        ready,
        first.then(() => {
          throw new Error("First refresh exited before provider barrier");
        }),
      ]);
      second = run(succeedingFetch).then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (pids.length >= 2) {
          const [holder, waiter] = await Promise.all([pids[0], pids[1]]);
          const state = await pool.query<{ blocked: boolean }>(
            "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
            [holder, waiter],
          );
          if (state.rows[0]?.blocked) {
            blocked = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      const firstResult = await first;
      expect(firstResult.ok).toBe(false);
      expect(aborted).toBe(true);
      const secondResult = await second;
      if (!secondResult.ok) throw secondResult.error;
      expect(secondResult.value.accessToken).toBe("after-timeout");
      expect(await stored(itemId)).toBe("before-timeout");
    } catch (error) {
      failures.push(error);
    }
    await first;
    if (second) {
      const result = await second;
      if (!result.ok && !failures.includes(result.error)) failures.push(result.error);
    }
    for (const result of await Promise.allSettled(pids)) {
      if (result.status === "rejected" && !failures.includes(result.reason)) failures.push(result.reason);
    }
    try {
      await operationPool.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "OAuth timeout waiter test and cleanup failed");
  }, 25_000);

  it("does not return an access token while the actual commit is blocked", async () => {
    const itemId = await seed("before-commit");
    const operationPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: "-c role=semprec_data",
    });
    const pidResults: Promise<{ pid: number } | { error: unknown }>[] = [];
    operationPool.on("acquire", (client) => {
      pidResults.push(
        client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid").then(
          (result) => result.rows[0] ?? { error: new Error("Missing operation backend PID") },
          (error: unknown) => ({ error }),
        ),
      );
    });
    let unblock: () => void = () => {};
    let notifyHeld: (pid: number) => void = () => {};
    const held = new Promise<number>((resolve) => (notifyHeld = resolve));
    const release = new Promise<void>((resolve) => (unblock = resolve));
    const participants: Promise<unknown>[] = [];
    let functionCreated = false;
    let triggerCreated = false;
    const failures: unknown[] = [];
    try {
      // A deferred trigger holds the real COMMIT; no production writer exposes this test barrier.
      await pool.query(`CREATE FUNCTION test_mail_oauth_commit_wait() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(421305121); RETURN NEW; END $$`);
      functionCreated = true;
      await pool.query(`CREATE CONSTRAINT TRIGGER test_mail_oauth_commit_wait AFTER UPDATE ON external_credentials
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_mail_oauth_commit_wait()`);
      triggerCreated = true;
      const blocker = withTransaction(pool, async (client) => {
        const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
        const row = rows[0];
        if (!row) throw new Error("Missing blocker PID");
        await client.query("SELECT pg_advisory_xact_lock(421305121)");
        notifyHeld(row.pid);
        await release;
      });
      participants.push(blocker);
      const blockerPid = await Promise.race([
        held,
        blocker.then(() => {
          throw new Error("Blocker exited early");
        }),
      ]);
      const fetchImpl: typeof fetch = async () =>
        Response.json({ access_token: "new-access", refresh_token: "after-commit", expires_in: 60 });
      const operation = runInTenant(getTenantZeroId(), () =>
        refreshAndPersistAccessToken(operationPool, { ...INPUT, mailboxItemId: itemId, fetchImpl }),
      );
      participants.push(operation);
      let returned = false;
      const operationObserved = operation.then(
        (value) => {
          returned = true;
          return { value };
        },
        (error: unknown) => ({ error }),
      );
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (pidResults[0]) {
          const observedPid = await pidResults[0];
          if ("error" in observedPid) throw observedPid.error;
          const state = await pool.query<{ blocked: boolean }>(
            "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
            [blockerPid, observedPid.pid],
          );
          if (state.rows[0]?.blocked) {
            blocked = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      expect(returned).toBe(false);
      expect(await stored(itemId)).toBe("before-commit");
      unblock();
      const result = await operationObserved;
      if ("error" in result) throw result.error;
      expect(result.value.accessToken).toBe("new-access");
      expect(await stored(itemId)).toBe("after-commit");
    } catch (error) {
      failures.push(error);
    }
    unblock();
    const settled = await Promise.allSettled(participants);
    for (const outcome of settled) if (outcome.status === "rejected") failures.push(outcome.reason);
    for (const pid of await Promise.all(pidResults)) if ("error" in pid) failures.push(pid.error);
    for (const cleanup of [
      async () => operationPool.end(),
      async () => {
        if (triggerCreated) await pool.query("DROP TRIGGER test_mail_oauth_commit_wait ON external_credentials");
      },
      async () => {
        if (functionCreated) await pool.query("DROP FUNCTION test_mail_oauth_commit_wait()");
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    const distinct = [...new Set(failures)];
    if (distinct.length === 1) throw distinct[0];
    if (distinct.length > 1) throw new AggregateError(distinct, "OAuth commit test had multiple failures");
  });

  it("does not return an access token when the actual commit rejects the rotation", async () => {
    const itemId = await seed("before-rejected-commit");
    const failures: unknown[] = [];
    let functionCreated = false;
    let triggerCreated = false;
    try {
      await pool.query(`CREATE FUNCTION test_mail_oauth_commit_reject() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'test deferred commit rejection'; END $$`);
      functionCreated = true;
      await pool.query(`CREATE CONSTRAINT TRIGGER test_mail_oauth_commit_reject AFTER UPDATE ON external_credentials
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION test_mail_oauth_commit_reject()`);
      triggerCreated = true;
      let returned = false;
      const fetchImpl: typeof fetch = async () =>
        Response.json({ access_token: "uncommitted-access", refresh_token: "uncommitted-refresh", expires_in: 60 });
      await expect(
        refreshInTenant(pool, { ...INPUT, mailboxItemId: itemId, fetchImpl }).then((value) => {
          returned = true;
          return value;
        }),
      ).rejects.toThrow("test deferred commit rejection");
      expect(returned).toBe(false);
      expect(await stored(itemId)).toBe("before-rejected-commit");
    } catch (error) {
      failures.push(error);
    }
    for (const cleanup of [
      async () => {
        if (triggerCreated) await pool.query("DROP TRIGGER test_mail_oauth_commit_reject ON external_credentials");
      },
      async () => {
        if (functionCreated) await pool.query("DROP FUNCTION test_mail_oauth_commit_reject()");
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "OAuth failed-commit test and cleanup failed");
    const provider = fakeProvider({ rotate: () => "after-retry" });
    await refreshInTenant(pool, { ...INPUT, mailboxItemId: itemId });
    expect(provider.presented).toEqual(["before-rejected-commit"]);
    expect(await stored(itemId)).toBe("after-retry");
  });

  it("rolls back a failed rotation and releases the credential lock to a waiting refresh", async () => {
    const itemId = await seed("rollback-generation");
    const operationPool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      options: "-c role=semprec_data",
    });
    const pids: Promise<{ pid: number } | { error: unknown }>[] = [];
    operationPool.on("acquire", (client) => {
      pids.push(
        client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid").then(
          (result) => result.rows[0] ?? { error: new Error("Missing operation PID") },
          (error: unknown) => ({ error }),
        ),
      );
    });
    let releaseProvider: () => void = () => {};
    let notifyEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => (notifyEntered = resolve));
    const held = new Promise<void>((resolve) => (releaseProvider = resolve));
    const presented: string[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      if (!(init?.body instanceof URLSearchParams)) throw new Error("Unexpected request body");
      const token = init.body.get("refresh_token");
      if (token === null) throw new Error("Missing refresh token");
      presented.push(token);
      if (presented.length === 1) {
        notifyEntered();
        await held;
      }
      return Response.json({ access_token: "access", refresh_token: "replacement", expires_in: 60 });
    };
    const start = () =>
      runInTenant(getTenantZeroId(), () =>
        refreshAndPersistAccessToken(operationPool, { ...INPUT, mailboxItemId: itemId, fetchImpl }),
      );
    const participants: Promise<unknown>[] = [];
    const failures: unknown[] = [];
    try {
      failure.remainingWrites = 1;
      const first = start();
      const observedFirst = first.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      participants.push(observedFirst);
      await Promise.race([
        entered,
        observedFirst.then(() => {
          throw new Error("First refresh exited before barrier");
        }),
      ]);
      const second = start();
      const observedSecond = second.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      participants.push(observedSecond);
      let blocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        if (pids.length >= 2) {
          const [holder, waiter] = await Promise.all([pids[0], pids[1]]);
          if (!holder || !waiter) throw new Error("Missing operation PID");
          if ("error" in holder) throw holder.error;
          if ("error" in waiter) throw waiter.error;
          const state = await pool.query<{ blocked: boolean }>(
            "SELECT $1::int = ANY(pg_blocking_pids($2::int)) AS blocked",
            [holder.pid, waiter.pid],
          );
          if (state.rows[0]?.blocked) {
            blocked = true;
            break;
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(blocked).toBe(true);
      releaseProvider();
      const firstResult = await observedFirst;
      const secondResult = await observedSecond;
      expect(firstResult).toHaveProperty("error");
      expect(firstResult).not.toHaveProperty("value");
      expect(secondResult).toMatchObject({ value: { accessToken: "access" } });
      expect(presented).toEqual(["rollback-generation", "rollback-generation"]);
      expect(await stored(itemId)).toBe("replacement");
    } catch (error) {
      failures.push(error);
    }
    releaseProvider();
    for (const result of await Promise.allSettled(participants))
      if (result.status === "rejected") failures.push(result.reason);
    for (const result of await Promise.all(pids)) if ("error" in result) failures.push(result.error);
    try {
      await operationPool.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "OAuth rollback test and cleanup failed");
  });

  it("retains persistence failure as the safe primary when its diagnostic throws", async () => {
    const itemId = await seed("rt-old");
    fakeProvider({ rotate: () => "rt-new-secret" });
    failure.storeCredential = true;
    const diagnostic = new Error("rt-new-secret csecret");
    const log = vi.spyOn(logger, "error").mockImplementation(() => {
      throw diagnostic;
    });
    const outcome = await refreshInTenant(pool, { ...INPUT, mailboxItemId: itemId }).then(
      () => null,
      (error: unknown) => error,
    );
    expect(log).toHaveBeenCalledOnce();
    expect(outcome).toBeInstanceOf(Error);
    if (!(outcome instanceof Error)) throw new Error("Missing persistence failure");
    expect(outcome.message).toContain("Persisting the rotated OAuth refresh token failed");
    expect(outcome).not.toHaveProperty("cause");
    expect(`${outcome.stack} ${JSON.stringify(outcome)}`).not.toContain("rt-new-secret");
    expect(`${outcome.stack} ${JSON.stringify(outcome)}`).not.toContain("csecret");
    expect(await stored(itemId)).toBe("rt-old");
  });

  it("throws when persisting fails, keeps the old token, and leaks no token into the error or logs", async () => {
    const itemId = await seed("rt-old");
    fakeProvider({ rotate: () => "rt-new-secret" });
    failure.storeCredential = true;
    const logged: string[] = [];
    const streamSymbol = Object.getOwnPropertySymbols(logger).find((symbol) => symbol.description === "pino.stream");
    if (!streamSymbol) throw new Error("Missing application logger stream");
    const originalStream: unknown = Reflect.get(logger, streamSymbol);
    if (
      !Reflect.set(logger, streamSymbol, {
        write: (line: string) => {
          logged.push(line);
          return true;
        },
      })
    ) {
      throw new Error("Could not capture application log stream");
    }
    let err: unknown;
    let restored: boolean;
    try {
      err = await refreshInTenant(pool, { ...INPUT, mailboxItemId: itemId }).catch((e: unknown) => e);
    } finally {
      restored = Reflect.set(logger, streamSymbol, originalStream);
    }
    if (!restored) throw new Error("Could not restore application log stream");
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? `${err.message} ${err.stack} ${JSON.stringify(err)}` : "";
    for (const secret of ["rt-old", "rt-new-secret", "access-for-rt-old", "csecret"]) {
      expect(message).not.toContain(secret);
      expect(logged.join("")).not.toContain(secret);
    }
    expect(logged).toHaveLength(1);
    const record: unknown = JSON.parse(logged[0] ?? "null");
    expect(record).toMatchObject({ msg: expect.stringContaining("Persisting") });
    expect(await stored(itemId)).toBe("rt-old");
    failure.storeCredential = false;
    const retry = await refreshInTenant(pool, { ...INPUT, mailboxItemId: itemId });
    expect(retry.accessToken).toBe("access-for-rt-old");
    expect(await stored(itemId)).toBe("rt-new-secret");
  });
});
