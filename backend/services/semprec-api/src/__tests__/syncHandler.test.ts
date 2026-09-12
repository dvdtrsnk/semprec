import { createServer, type ClientRequest, type IncomingMessage, type Server } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { WebSocket } from "ws";
import { getTestPool, resetDatabase } from "@semprec/data/testSupport";
import { createUser, hashPassword, type PasswordResetMailer, type UserRow } from "@semprec/data";
import { wireRealtimeHooks, type SyncServer } from "@semprec/realtime";
import { createAuthRequestListener, SESSION_COOKIE_NAME } from "../authHandler.js";
import { createSyncUpgradeHandler } from "../syncHandler.js";

let pool: Pool;

const PASSWORD = "s3cret-password";

const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};

async function makeUser(email = "person@example.com"): Promise<UserRow> {
  return createUser(pool, { email, passwordHash: await hashPassword(PASSWORD) });
}

function sessionCookieFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a Set-Cookie header");
  const match = setCookie.match(new RegExp(`${SESSION_COOKIE_NAME}=([^;]*)`));
  if (!match) throw new Error(`expected a ${SESSION_COOKIE_NAME} cookie`);
  return match[1]!;
}

/** Resolves once `client` opens, rejecting on `error` — a bad credential must reach the second branch instead. */
function waitForOpen(client: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
}

describe("WS /api/sync (issue #160)", () => {
  let server: Server;
  let syncServer: SyncServer;
  let baseUrl: string;
  let wsBaseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    wireRealtimeHooks(pool);

    const authListener = createAuthRequestListener(pool, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
    });
    syncServer = await createSyncUpgradeHandler(pool);

    server = createServer(authListener);
    server.on("upgrade", (req, socket, head) => {
      syncServer.handleUpgrade(req, socket, head);
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    wsBaseUrl = `ws://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await syncServer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reaches an open socket for a web session presented as a cookie", async () => {
    const user = await makeUser();
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "web" }),
    });
    const cookie = sessionCookieFrom(login);

    const client = new WebSocket(`${wsBaseUrl}/api/sync`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${cookie}` },
    });
    await waitForOpen(client);
    expect(client.readyState).toBe(client.OPEN);
    client.close();
  });

  it("reaches an open socket for a native session presented as Authorization: Bearer", async () => {
    const user = await makeUser();
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
    });
    const { token } = (await login.json()) as { token: string };

    const client = new WebSocket(`${wsBaseUrl}/api/sync`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    await waitForOpen(client);
    expect(client.readyState).toBe(client.OPEN);
    client.close();
  });

  it("rejects an upgrade with no credential with HTTP 401 and never opens a socket", async () => {
    const client = new WebSocket(`${wsBaseUrl}/api/sync`);
    const statusCode = await new Promise<number>((resolve) => {
      client.once("unexpected-response", (_req: ClientRequest, res: IncomingMessage) => resolve(res.statusCode ?? 0));
    });
    expect(statusCode).toBe(401);
    expect(client.readyState).not.toBe(client.OPEN);
  });

  it("rejects an upgrade bearing a garbage bearer token with HTTP 401 and never opens a socket", async () => {
    const client = new WebSocket(`${wsBaseUrl}/api/sync`, {
      headers: { Authorization: "Bearer not-a-real-session-token" },
    });
    const statusCode = await new Promise<number>((resolve) => {
      client.once("unexpected-response", (_req: ClientRequest, res: IncomingMessage) => resolve(res.statusCode ?? 0));
    });
    expect(statusCode).toBe(401);
  });

  it("closes exactly the revoked session's socket with 4401, leaving another session's socket open", async () => {
    const user = await makeUser();

    const revokedLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "web" }),
    });
    const revokedCookie = sessionCookieFrom(revokedLogin);

    const survivingLogin = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: user.email, password: PASSWORD, platform: "ios" }),
    });
    const { token: survivingToken } = (await survivingLogin.json()) as { token: string };

    const revokedClient = new WebSocket(`${wsBaseUrl}/api/sync`, {
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${revokedCookie}` },
    });
    const survivingClient = new WebSocket(`${wsBaseUrl}/api/sync`, {
      headers: { Authorization: `Bearer ${survivingToken}` },
    });
    await Promise.all([waitForOpen(revokedClient), waitForOpen(survivingClient)]);

    const revokedClosed = new Promise<number>((resolve) =>
      revokedClient.once("close", (code: number) => resolve(code)),
    );

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${revokedCookie}` },
    });
    expect(logout.status).toBe(200);

    expect(await revokedClosed).toBe(4401);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(survivingClient.readyState).toBe(survivingClient.OPEN);
    survivingClient.close();
  });
});
