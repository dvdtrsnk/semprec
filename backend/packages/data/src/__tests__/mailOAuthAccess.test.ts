import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getDecryptedCredential, storeCredential } from "../credentials/externalCredentialsStore.js";
import { logger } from "../mail/logger.js";
import { refreshAndPersistAccessToken } from "../mail/mailOAuthAccess.js";
import { MailReauthorizationRequiredError } from "../mail/providerTypes.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";

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

    const first = await refreshAndPersistAccessToken(pool, { ...INPUT, mailboxItemId: itemId });
    expect(first.accessToken).toBe("access-for-rt-1");
    expect(first.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(await stored(itemId)).toBe("rt-2");

    const second = await refreshAndPersistAccessToken(pool, { ...INPUT, mailboxItemId: itemId });
    expect(second.accessToken).toBe("access-for-rt-2");
    expect(provider.presented).toEqual(["rt-1", "rt-2"]);
    expect(await stored(itemId)).toBe("rt-3");
  });

  it("leaves the stored token unchanged when the provider returns no new one", async () => {
    const itemId = await seed("rt-1");
    fakeProvider({});
    await refreshAndPersistAccessToken(pool, { ...INPUT, mailboxItemId: itemId });
    expect(await stored(itemId)).toBe("rt-1");
  });

  it("serializes concurrent refreshes so each token is presented exactly once", async () => {
    const itemId = await seed("rt-1");
    let n = 1;
    const provider = fakeProvider({ valid: new Set(["rt-1"]), rotate: () => `rt-${++n}`, delayMs: 50 });
    const results = await Promise.all([
      refreshAndPersistAccessToken(pool, { ...INPUT, mailboxItemId: itemId }),
      refreshAndPersistAccessToken(pool, { ...INPUT, mailboxItemId: itemId }),
    ]);
    expect([...provider.presented].sort()).toEqual(["rt-1", "rt-2"]);
    expect(results.map((r) => r.accessToken).sort()).toEqual(["access-for-rt-1", "access-for-rt-2"]);
    expect(await stored(itemId)).toBe("rt-3");
  });

  it.each([400, 401])("throws MailReauthorizationRequiredError on provider status %i", async (status) => {
    const itemId = await seed("rt-1");
    fakeProvider({ valid: new Set(), rejectStatus: status });
    const err: unknown = await refreshAndPersistAccessToken(pool, { ...INPUT, mailboxItemId: itemId }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MailReauthorizationRequiredError);
    if (err instanceof Error) expect(err.message).not.toContain("rt-1");
    expect(await stored(itemId)).toBe("rt-1");
  });

  it("throws when no credential is stored, without calling the provider", async () => {
    const provider = fakeProvider({});
    await expect(refreshAndPersistAccessToken(pool, { ...INPUT, mailboxItemId: randomUUID() })).rejects.toThrow(
      /No OAuth credential/,
    );
    expect(provider.presented).toEqual([]);
  });

  it("throws when persisting fails, keeps the old token, and leaks no token into the error or logs", async () => {
    const itemId = await seed("rt-old");
    fakeProvider({ rotate: () => "rt-new-secret" });
    failure.storeCredential = true;
    const logged: string[] = [];
    vi.spyOn(logger, "error").mockImplementation((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
    });

    const err: unknown = await refreshAndPersistAccessToken(pool, { ...INPUT, mailboxItemId: itemId }).catch(
      (e: unknown) => e,
    );
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
