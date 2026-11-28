import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem } from "@alldots/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@alldots/data/testSupport";
import {
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  MailAuthFailedError,
  provisionTenant,
  type PasswordResetMailer,
} from "@alldots/data";
import { createDispatcher } from "../app.js";
import type { CustomRouteDependencies } from "../adapter/customRouteMount.js";
import { createClientIpThrottle } from "../clientIpThrottle.js";

/**
 * The password connect route's attempt limit through the production composition: the real dispatcher, the REST
 * adapter and its limiter on a runtime-role pool. The login verification is the one stand-in; a login absent from
 * its record opened no connection to a mail server.
 */

const REFUSED_PASSWORD = "throttle-refused-password";
const ACCEPTED_PASSWORD = "throttle-accepted-password";

const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();
const blobStorage = new LocalFsBlobStorageWriter(join(tmpdir(), `alldots-test-blobs-mailbox-throttle-${randomUUID()}`));
const originalScopeMode = process.env.ALLDOTS_TENANT_SCOPE;

let adminPool: Pool;
let pool: Pool;
const openServers: Server[] = [];

interface User {
  bearer: Record<string, string>;
}

/** Each user is the one user of a tenant of their own (`users_tenant_id_key`). */
let alice: User;
let bob: User;

interface Mount {
  baseUrl: string;
  verified: string[];
  advanceSeconds: (seconds: number) => void;
}

interface MountOptions {
  holdVerification?: Promise<void>;
  /** The route then counts in the limiter `createDispatcher` creates. */
  limiterOfDispatcher?: boolean;
}

/**
 * The verification refuses `REFUSED_PASSWORD` as a mail server would and accepts every other login. Unless
 * `limiterOfDispatcher` is set, the limiter has the production limits and a clock the test moves.
 */
async function serve(options: MountOptions = {}): Promise<Mount> {
  const verified: string[] = [];
  let nowMs = Date.parse("2026-11-12T08:00:00.000Z");
  const customRouteDependencies: CustomRouteDependencies = {
    mailServerClients: {
      verifyPassword: async (input) => {
        verified.push(input.address);
        await options.holdVerification;
        if (input.password === REFUSED_PASSWORD) throw new MailAuthFailedError();
        return {
          imap: { host: input.imapHost ?? "imap.mail.me.com", port: 993, security: "tls" },
          smtp: { host: input.smtpHost ?? "smtp.mail.me.com", port: 465, security: "tls" },
          folders: null,
        };
      },
    },
    ...(options.limiterOfDispatcher ? {} : { throttle: createClientIpThrottle({ now: () => nowMs }) }),
  };
  const dispatch = await createDispatcher(pool, {
    passwordResetMailer: noopMailer,
    appBaseUrl: "https://app.example.test",
    setupToken: "mailbox-throttle-setup-token",
    moduleRegistry,
    blobStorage,
    maxFileSizeBytes: 1024 * 1024,
    customRouteDependencies,
  });
  const server = createServer(dispatch);
  openServers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    verified,
    advanceSeconds: (seconds) => {
      nowMs += seconds * 1000;
    },
  };
}

async function send(mount: Mount, method: string, path: string, user: User | null, body?: unknown): Promise<Response> {
  return fetch(`${mount.baseUrl}${path}`, {
    method,
    headers: { ...(user?.bearer ?? {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

interface ConnectAnswer {
  status: number;
  /** `null` for the item envelope of a created mailbox. */
  code: string | null;
  body: unknown;
  retryAfter: string | null;
  address: string;
}

const refusalBody = z.object({ error: z.object({ code: z.string() }) });

async function connect(
  mount: Mount,
  user: User,
  overrides: { address?: string; password?: string } = {},
): Promise<ConnectAnswer> {
  const address = overrides.address ?? `${randomUUID()}@throttle.example.test`;
  const response = await send(mount, "POST", "/api/mail/mailboxes", user, {
    provider: "generic",
    address,
    password: overrides.password ?? ACCEPTED_PASSWORD,
    imapHost: "imap.throttle.example.test",
    smtpHost: "smtp.throttle.example.test",
  });
  const body: unknown = await response.json();
  const refusal = refusalBody.safeParse(body);
  return {
    status: response.status,
    code: refusal.success ? refusal.data.error.code : null,
    body,
    retryAfter: response.headers.get("retry-after"),
    address,
  };
}

async function refusedLogins(mount: Mount, user: User, count: number): Promise<void> {
  for (let attempt = 0; attempt < count; attempt += 1) {
    const answer = await connect(mount, user, { password: REFUSED_PASSWORD });
    expect({ status: answer.status, code: answer.code }).toEqual({ status: 400, code: "mail_auth_failed" });
  }
}

const mailboxList = z.object({ mailboxes: z.array(z.object({ id: z.string() })) });

async function mailboxIdsOf(mount: Mount, user: User): Promise<string[]> {
  const response = await send(mount, "GET", "/api/mail/mailboxes", user);
  expect(response.status).toBe(200);
  return mailboxList
    .parse(await response.json())
    .mailboxes.map((mailbox) => mailbox.id)
    .sort();
}

async function signUp(mount: Mount, tenantId: string): Promise<User> {
  const email = `${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  const passwordHash = await hashPassword(password);
  // `users` is a global identity table, written outside any tenant as account creation does.
  await runAsSystem("test-fixture-create-user", () => createUser(adminPool, { email, passwordHash, tenantId }));
  const login = await send(mount, "POST", "/api/auth/login", null, { email, password, platform: "ios" });
  expect(login.status).toBe(200);
  const { token } = z.object({ token: z.string() }).parse(await login.json());
  return { bearer: { Authorization: `Bearer ${token}` } };
}

async function closeOpenServers(): Promise<void> {
  for (const server of openServers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function withinTenSeconds<T>(work: Promise<T>, what: string): Promise<T> {
  const timeout = new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} did not happen within 10 s`)), 10_000);
    void work.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    );
  });
  return Promise.race([work, timeout]);
}

beforeAll(async () => {
  process.env.ALLDOTS_TENANT_SCOPE = "strict";
  adminPool = getTestPool();
  await resetDatabase(adminPool);
  pool = await createRuntimeRolePool(adminPool, "alldots_data");

  const signIn = await serve();
  const signUpInNewTenant = async (): Promise<User> => {
    const tenantId = await createTestTenant(adminPool);
    await provisionTenant(pool, tenantId);
    return signUp(signIn, tenantId);
  };
  alice = await signUpInNewTenant();
  bob = await signUpInNewTenant();
  await closeOpenServers();
}, 120_000);

afterEach(closeOpenServers);

afterAll(async () => {
  await pool?.end();
  await adminPool?.end();
  if (originalScopeMode === undefined) delete process.env.ALLDOTS_TENANT_SCOPE;
  else process.env.ALLDOTS_TENANT_SCOPE = originalScopeMode;
});

describe("POST /api/mail/mailboxes: the per-user limit of login verifications (issue gh-1750)", () => {
  it("answers the eleventh attempt of a user within 15 minutes with 429 rate_limited and Retry-After, and verifies no login for it", async () => {
    const mount = await serve();
    const created = await connect(mount, alice);
    expect(created.status).toBe(201);
    mount.advanceSeconds(60);
    await refusedLogins(mount, alice, 9);
    const mailboxesBefore = await mailboxIdsOf(mount, alice);

    const eleventh = await connect(mount, alice);

    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toEqual({ error: { code: "rate_limited" } });
    // The first attempt leaves the 900-second window 840 seconds from now.
    expect(eleventh.retryAfter).toBe("840");
    expect(mount.verified).toHaveLength(10);
    expect(mount.verified).not.toContain(eleventh.address);
    expect(await mailboxIdsOf(mount, alice)).toEqual(mailboxesBefore);
  });

  it("counts each user apart: one user at the limit leaves another user's ten attempts as they are", async () => {
    const mount = await serve();
    await refusedLogins(mount, alice, 10);
    expect((await connect(mount, alice)).status).toBe(429);

    const ofBob = await connect(mount, bob);

    expect(ofBob.status).toBe(201);
    expect(mount.verified.slice(10)).toEqual([ofBob.address]);
    expect((await connect(mount, alice)).status).toBe(429);
    await refusedLogins(mount, bob, 9);
    expect((await connect(mount, bob)).status).toBe(429);
    expect(mount.verified).toHaveLength(20);
  });

  it("counts no attempt for a request whose body is invalid", async () => {
    const mount = await serve();
    await refusedLogins(mount, alice, 9);

    for (let request = 0; request < 12; request += 1) {
      const invalid = await connect(mount, alice, { address: "not-an-address" });
      expect({ status: invalid.status, code: invalid.code }).toEqual({ status: 400, code: "validation_failed" });
    }

    await refusedLogins(mount, alice, 1);
    expect((await connect(mount, alice)).status).toBe(429);
    // The body is validated before the attempt is counted.
    const invalidAtTheLimit = await connect(mount, alice, { address: "not-an-address" });
    expect({ status: invalidAtTheLimit.status, code: invalidAtTheLimit.code }).toEqual({
      status: 400,
      code: "validation_failed",
    });
    expect(invalidAtTheLimit.retryAfter).toBeNull();
    expect(mount.verified).toHaveLength(10);
  });

  it("lets the user try again once the earliest counted attempts are 15 minutes old", async () => {
    const mount = await serve();
    await refusedLogins(mount, alice, 4);
    mount.advanceSeconds(300);
    await refusedLogins(mount, alice, 6);
    expect(await connect(mount, alice)).toMatchObject({ status: 429, retryAfter: "600" });

    mount.advanceSeconds(599);
    expect(await connect(mount, alice)).toMatchObject({ status: 429, retryAfter: "1" });

    mount.advanceSeconds(1);
    await refusedLogins(mount, alice, 4);
    expect(await connect(mount, alice)).toMatchObject({ status: 429, retryAfter: "300" });
    expect(mount.verified).toHaveLength(14);
  });

  it("counts no attempt for an address the tenant already holds, which is answered before any server is contacted", async () => {
    const mount = await serve();
    const held = await connect(mount, alice);
    expect(held.status).toBe(201);

    for (let request = 0; request < 10; request += 1) {
      const duplicate = await connect(mount, alice, { address: held.address });
      expect({ status: duplicate.status, code: duplicate.code }).toEqual({
        status: 409,
        code: "provider_account_already_connected",
      });
    }

    expect(mount.verified).toEqual([held.address]);
    await refusedLogins(mount, alice, 9);
    expect((await connect(mount, alice)).status).toBe(429);
  });

  it("lets ten of fifteen concurrent attempts of a user reach the verification and refuses the other five while those ten are in flight", async () => {
    let openGate: () => void = () => undefined;
    const holdVerification = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const mount = await serve({ holdVerification });
    let answered = 0;
    const requests = Array.from({ length: 15 }, () =>
      connect(mount, alice, { password: REFUSED_PASSWORD }).finally(() => {
        answered += 1;
      }),
    );
    const fiveRefused = new Promise<void>((resolve) => {
      let refused = 0;
      for (const request of requests) {
        void request.then(
          (answer) => {
            if (answer.status === 429) refused += 1;
            if (refused === 5) resolve();
          },
          () => undefined,
        );
      }
    });

    try {
      await withinTenSeconds(fiveRefused, "the refusal of five attempts");
      // The in-flight attempts already hold the window.
      expect(answered).toBe(5);
      expect(mount.verified).toHaveLength(10);
    } finally {
      openGate();
    }

    const answers = await Promise.all(requests);
    expect(answers.map((answer) => answer.status).sort()).toEqual([
      ...Array.from({ length: 10 }, () => 400),
      ...Array.from({ length: 5 }, () => 429),
    ]);
    expect(mount.verified).toHaveLength(10);
  });

  it("counts in the limiter createDispatcher creates, with the production limit, when the caller's container has none", async () => {
    const mount = await serve({ limiterOfDispatcher: true });
    await refusedLogins(mount, alice, 10);

    const eleventh = await connect(mount, alice);

    expect(eleventh.status).toBe(429);
    expect(eleventh.body).toEqual({ error: { code: "rate_limited" } });
    // That limiter runs on the real clock.
    expect(eleventh.retryAfter).toMatch(/^\d+$/);
    const seconds = Number(eleventh.retryAfter);
    expect(seconds).toBeGreaterThanOrEqual(1);
    expect(seconds).toBeLessThanOrEqual(900);
    expect(mount.verified).toHaveLength(10);
  });
});
