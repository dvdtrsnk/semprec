import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { WebSocket } from "ws";
import { runAsSystem } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  createUser,
  hashPassword,
  login,
  revokeSession,
  startTenantDeactivationListener,
  suspendAccount,
  withTransaction,
} from "@semprec/data";
import { authenticateRequest } from "../authHandler.js";
import {
  createVoiceChannel,
  type VoiceChannel,
  type VoiceIdentity,
  type VoiceSender,
  type VoiceSessionHandler,
} from "../voiceChannel.js";

let admin: Pool, pool: Pool, server: Server, voice: VoiceChannel, url: string;
let lastIdentity: VoiceIdentity | undefined;
let lastSender: VoiceSender | undefined;
const audio: Buffer[] = [];
const controls: string[] = [];
const handler: VoiceSessionHandler = {
  onStart(identity, _frame, sender) {
    lastIdentity = identity;
    lastSender = sender;
    sender.sendControl({ type: "ready" });
  },
  onAudio(_identity, pcm) {
    audio.push(Buffer.from(pcm));
  },
  onControl(_identity, frame) {
    controls.push(frame.type);
  },
  onClose() {},
};
async function start(options: Parameters<typeof createVoiceChannel>[1] = {}) {
  voice = createVoiceChannel(pool, options);
  server = createServer((_req, res) => {
    res.writeHead(404).end();
  });
  server.on("upgrade", (req, socket, head) => voice.handleUpgrade(req, socket, head));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  url = `ws://127.0.0.1:${address.port}/api/voice`;
}
async function identity() {
  const tenantId = await createTestTenant(admin);
  const email = `${randomUUID()}@example.test`;
  const user = await createUser(admin, { tenantId, email, passwordHash: await hashPassword("voice-test-password") });
  const session = await login(admin, { email, password: "voice-test-password", platform: "ios", ip: "127.0.0.1" });
  return { tenantId, user, session };
}
const messages = new WeakMap<WebSocket, string[]>();
const waiters = new WeakMap<WebSocket, Array<(value: string) => void>>();
const closeCodes = new WeakMap<WebSocket, number>();
async function connect(token?: string): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  messages.set(ws, []);
  waiters.set(ws, []);
  ws.on("message", (data) => {
    const value = (
      Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
    ).toString("utf8");
    const waiter = waiters.get(ws)?.shift();
    if (waiter) waiter(value);
    else messages.get(ws)?.push(value);
  });
  ws.on("close", (code) => closeCodes.set(ws, code));
  await once(ws, "open");
  return ws;
}
function closed(ws: WebSocket): Promise<number> {
  const code = closeCodes.get(ws);
  return code === undefined ? new Promise((resolve) => ws.once("close", resolve)) : Promise.resolve(code);
}
function message(ws: WebSocket): Promise<string> {
  const value = messages.get(ws)?.shift();
  return value === undefined ? new Promise((resolve) => waiters.get(ws)?.push(resolve)) : Promise.resolve(value);
}
async function refused(headers: Record<string, string>): Promise<number | undefined> {
  const ws = new WebSocket(url, { headers });
  return new Promise((resolve, reject) => {
    ws.once("unexpected-response", (_req, res) => {
      resolve(res.statusCode);
      res.resume();
    });
    ws.once("open", () => reject(new Error("Unexpected upgrade")));
    ws.once("error", reject);
  });
}

describe("voice channel", () => {
  beforeAll(async () => {
    admin = getTestPool();
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
  });
  beforeEach(async () => {
    await resetDatabase(admin);
    lastIdentity = undefined;
    lastSender = undefined;
    audio.length = 0;
    controls.length = 0;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await voice?.close();
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterAll(async () => {
    await pool.end();
    await admin.end();
  });
  it("rejects unauthenticated and foreign-origin upgrades before the handshake", async () => {
    await start({ handler });
    const user = await identity();
    expect(await refused({})).toBe(401);
    expect(await refused({ Authorization: `Bearer ${user.session.token}`, Origin: "https://evil.example" })).toBe(403);
  });
  it("uses authenticated identity, forwards the original controls and audio, and ends", async () => {
    await start({ handler });
    const user = await identity();
    const ws = await connect(user.session.token);
    const ready = message(ws);
    ws.send(JSON.stringify({ type: "start", language: "cs" }));
    expect(JSON.parse(await ready)).toEqual({ type: "ready" });
    expect(lastIdentity).toMatchObject({
      tenantId: user.tenantId,
      userId: user.user.id,
      sessionId: user.session.session.id,
    });
    ws.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]));
    await vi.waitFor(() => expect(audio).toHaveLength(1));
    expect(audio[0]?.length).toBe(640);
    ws.send(JSON.stringify({ type: "stop" }));
    await vi.waitFor(() => expect(controls).toEqual(["stop"]));
    const end = message(ws),
      close = closed(ws);
    ws.send(JSON.stringify({ type: "end" }));
    expect(JSON.parse(await end)).toEqual({ type: "end" });
    expect(await close).toBe(1000);
    expect(controls).toEqual(["stop", "end"]);
  });
  it("admits one session per user and releases admission after close", async () => {
    await start({ handler });
    const user = await identity();
    const first = await connect(user.session.token);
    const second = await connect(user.session.token);
    const limit = message(second);
    const code = closed(second);
    expect(JSON.parse(await limit)).toEqual({ type: "error", code: "sessionLimit" });
    expect(await code).toBe(1008);
    const firstClose = closed(first);
    first.close();
    await firstClose;
    const third = await connect(user.session.token);
    const thirdClose = closed(third);
    third.close();
    await thirdClose;
  });
  it("closes malformed, oversized and idle sessions", async () => {
    await start({ handler, idleTimeoutMs: 80 });
    const user = await identity();
    let ws = await connect(user.session.token);
    let ended = closed(ws);
    let errorFrame = message(ws);
    ws.send(JSON.stringify({ type: "mute" }));
    expect(JSON.parse(await errorFrame)).toEqual({ type: "error", code: "invalidFrame" });
    expect(await ended).toBe(1002);
    ws = await connect(user.session.token);
    ended = closed(ws);
    errorFrame = message(ws);
    ws.send("x".repeat(4097));
    expect(JSON.parse(await errorFrame)).toEqual({ type: "error", code: "invalidFrame" });
    expect(await ended).toBe(1009);
    ws = await connect(user.session.token);
    ended = closed(ws);
    expect(await ended).toBe(1008);
  });
  it("enforces duration and microphone frame direction", async () => {
    await start({ handler, sessionTimeoutMs: 100 });
    const user = await identity();
    let ws = await connect(user.session.token);
    const ready = message(ws);
    ws.send(JSON.stringify({ type: "start", language: "en" }));
    await ready;
    const invalid = closed(ws);
    ws.send(Buffer.concat([Buffer.from([2]), Buffer.alloc(640)]));
    expect(await invalid).toBe(1002);
    ws = await connect(user.session.token);
    const duration = closed(ws);
    const error = message(ws);
    expect(JSON.parse(await error)).toEqual({ type: "error", code: "durationLimit" });
    expect(await duration).toBe(1008);
  });
  it("revalidates only the revoked session and closes the matching tenant", async () => {
    await start({ handler, revalidateIntervalMs: 30 });
    const a = await identity(),
      b = await identity();
    const first = await connect(a.session.token),
      second = await connect(b.session.token);
    const firstClosed = closed(first);
    await revokeSession(admin, a.session.session.id);
    expect(await firstClosed).toBe(4401);
    expect(second.readyState).toBe(WebSocket.OPEN);
    const secondClosed = closed(second);
    voice.closeTenant(b.tenantId);
    expect(await secondClosed).toBe(4401);
  });
  it("closes a suspended tenant through the real deactivation listener", async () => {
    await start({ handler });
    const a = await identity(),
      b = await identity();
    const adminTenant = await createTestTenant(admin);
    const actor = await createUser(admin, {
      tenantId: adminTenant,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      role: "admin",
    });
    const listener = await startTenantDeactivationListener(pool, async (tenantId) => {
      voice.closeTenant(tenantId);
    });
    try {
      const first = await connect(a.session.token),
        second = await connect(b.session.token);
      const firstClosed = closed(first);
      await runAsSystem("test:suspend", () =>
        withTransaction(pool, (client) => suspendAccount(client, { actorUserId: actor.id, targetUserId: a.user.id })),
      );
      expect(await firstClosed).toBe(4401);
      expect(second.readyState).toBe(WebSocket.OPEN);
      const secondClosed = closed(second);
      second.close();
      await secondClosed;
    } finally {
      await listener.close();
    }
  });
  it("closes with backpressure when a pending send crosses 256 KiB", async () => {
    await start({ handler });
    const user = await identity(),
      ws = await connect(user.session.token);
    const ready = message(ws);
    ws.send(JSON.stringify({ type: "start", language: "en" }));
    await ready;
    if (!lastSender) throw new Error("Missing sender");
    const code = closed(ws);
    vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockReturnValue(256 * 1024);
    expect(lastSender.sendControl({ type: "ready" })).toBe(false);
    expect(await code).toBe(1013);
  });
  it("sends overload error when the failed pending frame leaves room", async () => {
    await start({ handler });
    const user = await identity(),
      ws = await connect(user.session.token);
    const ready = message(ws);
    ws.send(JSON.stringify({ type: "start", language: "cs" }));
    await ready;
    if (!lastSender) throw new Error("Missing sender");
    const error = message(ws),
      code = closed(ws);
    vi.spyOn(WebSocket.prototype, "bufferedAmount", "get").mockReturnValue(256 * 1024 - 80);
    expect(lastSender.sendControl({ type: "transcript", text: "x".repeat(200), final: true })).toBe(false);
    expect(JSON.parse(await error)).toEqual({ type: "error", code: "overloaded" });
    expect(await code).toBe(1013);
  });
  it("bounds shutdown when a live client does not complete the close handshake", async () => {
    await start({ handler });
    const user = await identity(),
      ws = await connect(user.session.token);
    const ended = closed(ws);
    const closeSpy = vi.spyOn(WebSocket.prototype, "close").mockImplementation(() => {});
    const startTime = Date.now();
    const first = voice.close();
    expect(voice.close()).toBe(first);
    await first;
    expect(Date.now() - startTime).toBeLessThan(3000);
    expect(await ended).toBe(1006);
    closeSpy.mockRestore();
  });
  it("sends a stable error and closes if no handler is configured", async () => {
    await start();
    const user = await identity();
    const ws = await connect(user.session.token);
    const error = message(ws),
      code = closed(ws);
    expect(JSON.parse(await error)).toEqual({ type: "error", code: "unavailable" });
    expect(await code).toBe(1011);
  });
  it("sends only correctly prefixed speech and rejects an oversized binary frame", async () => {
    await start({ handler });
    const user = await identity(),
      ws = await connect(user.session.token);
    const ready = message(ws);
    ws.send(JSON.stringify({ type: "start", language: "cs" }));
    await ready;
    if (!lastSender) throw new Error("Missing sender");
    const frame = new Promise<{ data: Buffer; binary: boolean }>((resolve) =>
      ws.once("message", (data, binary) => {
        if (!Buffer.isBuffer(data)) throw new Error("Expected buffer");
        resolve({ data, binary });
      }),
    );
    expect(lastSender.sendAudio(Buffer.alloc(4800))).toBe(true);
    const output = await frame;
    expect(output.binary).toBe(true);
    expect(output.data[0]).toBe(2);
    expect(output.data.length).toBe(4801);
    const code = closed(ws);
    ws.send(Buffer.alloc(16 * 1024 + 1));
    expect(await code).toBe(1009);
    expect(audio).toEqual([]);
  });
  it("bounds and repeats shutdown while authentication is pending", async () => {
    let entered: (() => void) | undefined, release: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await start({
      handler,
      authenticate: async (req) => {
        const i = await authenticateRequest(pool, req);
        entered?.();
        await gate;
        return { tenantId: i.tenantId, userId: i.user.id, sessionId: i.session.id };
      },
    });
    const user = await identity();
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${user.session.token}` } });
    const failure = new Promise<void>((resolve) => ws.once("error", () => resolve()));
    await waiting;
    const first = voice.close();
    expect(voice.close()).toBe(first);
    await first;
    await failure;
    release?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lastIdentity).toBeUndefined();
  });
  it("rejects authentication finishing after deactivation", async () => {
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await start({
      handler,
      authenticate: async (req) => {
        const i = await authenticateRequest(pool, req);
        entered?.();
        await gate;
        return { tenantId: i.tenantId, userId: i.user.id, sessionId: i.session.id };
      },
    });
    const user = await identity();
    const pending = refused({ Authorization: `Bearer ${user.session.token}` });
    await waiting;
    voice.closeTenant(user.tenantId);
    release?.();
    expect(await pending).toBe(401);
  });
});
