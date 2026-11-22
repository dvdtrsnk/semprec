import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  provisionTenant,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import { CLIENT_IP_THROTTLE_LIMITS, createClientIpThrottle } from "../clientIpThrottle.js";

/**
 * The history upload routes through the production composition (the real dispatcher, the REST adapter's body cap and
 * the per-user limiter) on a runtime-role pool. Every mailbox id is random, so a request the cap and the limiter let
 * through ends at the handler's 404 or 400.
 */

const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();
const blobStorage = new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-blobs-mail-history-${randomUUID()}`));
const originalScopeMode = process.env.SEMPREC_TENANT_SCOPE;
const MIB = 1024 * 1024;

let adminPool: Pool;
let pool: Pool;
let server: Server;
let baseUrl: string;
let alice: Record<string, string>;
let bob: Record<string, string>;
let carol: Record<string, string>;

async function post(path: string, user: Record<string, string>, body: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { method: "POST", headers: { ...user, "Content-Type": "application/json" }, body });
}

const errorBody = z.object({ error: z.object({ code: z.string() }) });

async function codeOf(response: Response): Promise<string> {
  return errorBody.parse(await response.json()).error.code;
}

async function signUp(tenantId: string): Promise<Record<string, string>> {
  const email = `${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  const passwordHash = await hashPassword(password);
  // `users` is a global identity table, written outside any tenant as account creation does.
  await runAsSystem("test-fixture-create-user", () => createUser(adminPool, { email, passwordHash, tenantId }));
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, platform: "ios" }),
  });
  expect(login.status).toBe(200);
  const { token } = z.object({ token: z.string() }).parse(await login.json());
  return { Authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  process.env.SEMPREC_TENANT_SCOPE = "strict";
  adminPool = getTestPool();
  await resetDatabase(adminPool);
  pool = await createRuntimeRolePool(adminPool, "semprec_data");
  const dispatch = await createDispatcher(pool, {
    passwordResetMailer: noopMailer,
    appBaseUrl: "https://app.example.test",
    setupToken: "mail-history-setup-token",
    moduleRegistry,
    blobStorage,
    maxFileSizeBytes: MIB,
    customRouteDependencies: { throttle: createClientIpThrottle() },
  });
  server = createServer(dispatch);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const newUser = async () => {
    const tenantId = await createTestTenant(adminPool);
    await provisionTenant(pool, tenantId);
    return signUp(tenantId);
  };
  alice = await newUser();
  bob = await newUser();
  carol = await newUser();
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await pool?.end();
  await adminPool?.end();
  if (originalScopeMode === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
  else process.env.SEMPREC_TENANT_SCOPE = originalScopeMode;
});

describe("mail history upload over HTTP", () => {
  it("limits each user's claims and uploads, and not another user's", async () => {
    const { maxEvents } = CLIENT_IP_THROTTLE_LIMITS.mailHistoryUpload;
    const claimPath = () => `/api/mail/mailboxes/${randomUUID()}/history-index/claim`;
    for (let request = 0; request < maxEvents; request++) {
      const answer = await post(claimPath(), bob, "{}");
      expect(answer.status).toBe(404);
      await answer.body?.cancel();
    }

    const refused = await post(claimPath(), bob, "{}");
    expect(refused.status).toBe(429);
    expect(await codeOf(refused)).toBe("rate_limited");
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    const upload = await post(`/api/mail/mailboxes/${randomUUID()}/history-index`, bob, "{}");
    expect(upload.status).toBe(429);
    await upload.body?.cancel();

    const other = await post(claimPath(), carol, "{}");
    expect(other.status).toBe(404);
    await other.body?.cancel();
  }, 120_000);

  // Last: a body refused unread leaves its connection to be reset.
  it("reads an upload body up to 8 MiB, and no other route's past the default 1 MiB", async () => {
    const mailboxId = randomUUID();
    const padded = (bytes: number) => JSON.stringify({ pad: "x".repeat(bytes) });

    const over = await post(`/api/mail/mailboxes/${mailboxId}/history-index`, alice, padded(8 * MIB));
    expect(over.status).toBe(413);
    expect(await codeOf(over)).toBe("payload_too_large");

    // Past the default cap, inside the route's own: the handler reads it and refuses the unknown field.
    const inside = await post(`/api/mail/mailboxes/${mailboxId}/history-index`, alice, padded(2 * MIB));
    expect(inside.status).toBe(400);
    expect(await codeOf(inside)).toBe("validation_failed");

    const claim = await post(`/api/mail/mailboxes/${mailboxId}/history-index/claim`, alice, padded(2 * MIB));
    expect(claim.status).toBe(413);
  });
});
