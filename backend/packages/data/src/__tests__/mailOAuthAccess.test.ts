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

const failure = vi.hoisted(() => ({ storeCredential: false }));

vi.mock("../credentials/externalCredentialsStore.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials/externalCredentialsStore.js")>();
  return {
    ...actual,
    storeCredential: (...args: Parameters<typeof actual.storeCredential>) => {
      if (failure.storeCredential) return Promise.reject(new Error("boom: write failed"));
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

  it("throws when persisting fails, keeps the old token, and leaks no token into the error or logs", async () => {
    const itemId = await seed("rt-old");
    fakeProvider({ rotate: () => "rt-new-secret" });
    failure.storeCredential = true;
    const logged: string[] = [];
    vi.spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    });

    const err: unknown = await refreshInTenant(pool, { ...INPUT, mailboxItemId: itemId }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = err instanceof Error ? err.message : "";
    for (const secret of ["rt-old", "rt-new-secret", "access-for-rt-old", "csecret"]) {
      expect(message).not.toContain(secret);
      expect(logged.join("")).not.toContain(secret);
    }
    expect(logged).toHaveLength(1);
    expect(await stored(itemId)).toBe("rt-old");
  });
});
