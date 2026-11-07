import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Socket } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
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
const wireChunks: Buffer[] = [];
let expectedCloseFailure = false;
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
  server.on("upgrade", (req, socket, head) => {
    socket.on("data", (chunk: Buffer) => wireChunks.push(Buffer.from(chunk)));
    voice.handleUpgrade(req, socket, head);
  });
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
    wireChunks.length = 0;
    expectedCloseFailure = false;
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await voice?.close();
    } catch (error) {
      if (!expectedCloseFailure) throw error;
    }
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
    expect(
      z
        .object({ type: z.literal("ready") })
        .strict()
        .parse(JSON.parse(await ready) as unknown),
    ).toEqual({ type: "ready" });
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
  it("closes with the typed asynchronous budget failure and cleans up exactly once", async () => {
    const user = await identity();
    let sender: VoiceSender | undefined;
    let closes = 0;
    await start({
      handler: {
        ...handler,
        onStart(_identity, _frame, value) {
          sender = value;
          value.sendControl({ type: "ready" });
        },
        onClose() {
          closes += 1;
        },
      },
    });
    const ws = await connect(user.session.token);
    const ready = message(ws);
    ws.send(JSON.stringify({ type: "start", language: "en" }));
    expect(
      z
        .object({ type: z.literal("ready") })
        .strict()
        .parse(JSON.parse(await ready) as unknown),
    ).toEqual({ type: "ready" });
    if (!sender) throw new Error("Missing voice sender");
    const error = message(ws);
    const ended = closed(ws);
    await Promise.resolve().then(() => {
      sender?.fail("budgetExceeded");
      sender?.fail("budgetExceeded");
    });
    expect(
      z
        .object({ type: z.literal("error"), code: z.literal("budgetExceeded") })
        .strict()
        .parse(JSON.parse(await error) as unknown),
    ).toEqual({ type: "error", code: "budgetExceeded" });
    expect(await ended).toBe(1008);
    await vi.waitFor(() => expect(closes).toBe(1));
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
    expectedCloseFailure = true;
    await expect(first).rejects.toThrow("Voice shutdown did not settle cleanly");
    expect(Date.now() - startTime).toBeLessThan(3000);
    expect(await ended).toBe(1006);
    closeSpy.mockRestore();
  });
  it("waits for handler cleanup without allowing it to block shutdown indefinitely", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await start({ handler: { ...handler, onClose: () => pending } });
    const user = await identity(),
      ws = await connect(user.session.token);
    const ended = closed(ws),
      first = voice.close();
    await ended;
    let finished = false;
    void first.then(() => {
      finished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(finished).toBe(false);
    release?.();
    await first;
    expect(finished).toBe(true);
  });
  it("bounds shutdown even when handler cleanup remains pending", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await start({ handler: { ...handler, onClose: () => pending } });
    const user = await identity(),
      ws = await connect(user.session.token);
    const ended = closed(ws),
      started = Date.now(),
      first = voice.close();
    expect(voice.close()).toBe(first);
    expect(await ended).toBe(1012);
    expectedCloseFailure = true;
    await expect(first).rejects.toThrow("Voice shutdown did not settle cleanly");
    expect(Date.now() - started).toBeLessThan(3000);
    release?.();
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
  it("admits only one user when two real authentications complete together", async () => {
    let release: (() => void) | undefined;
    let entered = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await start({
      handler,
      authenticate: async (req) => {
        const i = await authenticateRequest(pool, req);
        entered++;
        await gate;
        return { tenantId: i.tenantId, userId: i.user.id, sessionId: i.session.id };
      },
    });
    const user = await identity();
    const first = connect(user.session.token),
      second = connect(user.session.token);
    await vi.waitFor(() => expect(entered).toBe(2));
    release?.();
    const [a, b] = await Promise.all([first, second]);
    const refusedOne = await Promise.race([
      closed(a).then((code) => ({ ws: a, code })),
      closed(b).then((code) => ({ ws: b, code })),
    ]);
    expect(refusedOne.code).toBe(1008);
    expect(JSON.parse(await message(refusedOne.ws))).toEqual({ type: "error", code: "sessionLimit" });
    const winner = refusedOne.ws === a ? b : a;
    expect(winner.readyState).toBe(WebSocket.OPEN);
    const winnerClosed = closed(winner);
    winner.close();
    await winnerClosed;
    const replacement = await connect(user.session.token),
      done = closed(replacement);
    replacement.close();
    await done;
  });
  it("accepts two coalesced audio frames with a synchronous handler", async () => {
    await start({ handler });
    const user = await identity(),
      ws = await connect(user.session.token);
    const ready = message(ws);
    ws.send(JSON.stringify({ type: "start", language: "en" }));
    await ready;
    wireChunks.length = 0;
    const socket: unknown = Reflect.get(ws, "_socket");
    if (!(socket instanceof Socket)) throw new Error("Missing client TCP socket");
    const packet = Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]);
    socket.cork();
    ws.send(packet);
    ws.send(packet);
    socket.uncork();
    await vi.waitFor(() => expect(audio).toHaveLength(2));
    expect(wireChunks.some((chunk) => chunk.length >= 2 * (packet.length + 8))).toBe(true);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    const done = closed(ws);
    ws.close();
    await done;
  });
  it("closes genuine pending and explicitly declined audio without queueing", async () => {
    let release: (() => void) | undefined, entered: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await start({
      handler: {
        ...handler,
        onAudio() {
          entered?.();
          return gate;
        },
      },
    });
    const user = await identity(),
      ws = await connect(user.session.token);
    const ready = message(ws);
    ws.send(JSON.stringify({ type: "start", language: "cs" }));
    await ready;
    ws.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]));
    await seen;
    const code = closed(ws);
    ws.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]));
    expect(await code).toBe(1013);
    release?.();
  });
  it.each([
    ["start", "peer"],
    ["start", "tenant"],
    ["start", "shutdown"],
    ["audio", "tenant"],
    ["control", "shutdown"],
  ] as const)("settles an active %s before cleanup after %s", async (kind, ending) => {
    let release: (() => void) | undefined;
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const target = await identity(),
      other = await identity();
    let targetSender: VoiceSender | undefined,
      cleanupCount = 0;
    let lateResults: boolean[] | undefined;
    const hold = () => {
      entered = true;
      return gate;
    };
    let shutdown: Promise<void> | undefined;
    try {
      await start({
        handler: {
          onStart(identity, _frame, sender) {
            if (identity.userId !== target.user.id) {
              sender.sendControl({ type: "ready" });
              return;
            }
            targetSender = sender;
            if (kind === "start")
              return hold().then(() => {
                lateResults = [sender.sendControl({ type: "ready" }), sender.sendAudio(Buffer.alloc(2))];
              });
            sender.sendControl({ type: "ready" });
          },
          onAudio(identity) {
            if (identity.userId === target.user.id && kind === "audio") return hold();
          },
          onControl(identity) {
            if (identity.userId === target.user.id && kind === "control") return hold();
          },
          onClose(identity) {
            if (identity.userId === target.user.id) cleanupCount++;
          },
        },
      });
      const ws = await connect(target.session.token);
      const ready = kind === "start" ? null : message(ws);
      ws.send(JSON.stringify({ type: "start", language: "en" }));
      if (ready) await ready;
      if (kind === "audio") ws.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]));
      if (kind === "control") ws.send(JSON.stringify({ type: "stop" }));
      await vi.waitFor(() => expect(entered).toBe(true), { timeout: 5000 });
      const otherWs = await connect(other.session.token),
        otherClosed = closed(otherWs);
      otherWs.close();
      await otherClosed;
      const closedTarget = closed(ws);
      if (ending === "peer") ws.close();
      else if (ending === "tenant") voice.closeTenant(target.tenantId);
      else shutdown = voice.close();
      await closedTarget;
      expect(cleanupCount).toBe(0);
      if (!targetSender) throw new Error("Missing sender");
      await vi.waitFor(() => expect(targetSender?.signal.aborted).toBe(true));
      expect(targetSender.sendControl({ type: "ready" })).toBe(false);
      expect(targetSender.sendAudio(Buffer.alloc(2))).toBe(false);
      if (ending !== "shutdown") {
        const duplicate = await connect(target.session.token),
          denied = message(duplicate),
          deniedCode = closed(duplicate);
        const deniedFrame: unknown = JSON.parse(await denied);
        expect(
          z.strictObject({ type: z.literal("error"), code: z.literal("sessionLimit") }).parse(deniedFrame),
        ).toEqual({
          type: "error",
          code: "sessionLimit",
        });
        expect(await deniedCode).toBe(1008);
      }
      release?.();
      await vi.waitFor(() => expect(cleanupCount).toBe(1));
      if (kind === "start") expect(lateResults).toEqual([false, false]);
      if (shutdown) await shutdown;
      else {
        const replacement = await connect(target.session.token),
          done = closed(replacement);
        replacement.close();
        await done;
      }
    } finally {
      release?.();
      if (shutdown) await shutdown;
    }
  });
  it("keeps admission until delayed cleanup settles after peer close", async () => {
    const user = await identity();
    let release: (() => void) | undefined,
      cleanupStarted = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await start({
      handler: {
        ...handler,
        onClose() {
          cleanupStarted++;
          return gate;
        },
      },
    });
    const ws = await connect(user.session.token),
      done = closed(ws);
    ws.close();
    await done;
    await vi.waitFor(() => expect(cleanupStarted).toBe(1));
    const duplicate = await connect(user.session.token),
      denied = message(duplicate),
      deniedCode = closed(duplicate);
    expect(JSON.parse(await denied)).toEqual({ type: "error", code: "sessionLimit" });
    expect(await deniedCode).toBe(1008);
    release?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const replacement = await connect(user.session.token),
      replacementClosed = closed(replacement);
    replacement.close();
    await replacementClosed;
  });
  it("reports a hung operation without concurrent cleanup and cleans up after late completion", async () => {
    const user = await identity();
    let release: (() => void) | undefined,
      entered: (() => void) | undefined,
      closes = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    await start({
      handler: {
        ...handler,
        onStart(_identity, _frame, sender) {
          lastSender = sender;
          entered?.();
          return gate;
        },
        onClose() {
          closes++;
        },
      },
    });
    const ws = await connect(user.session.token);
    ws.send(JSON.stringify({ type: "start", language: "en" }));
    await seen;
    const closedSocket = closed(ws),
      first = voice.close();
    expectedCloseFailure = true;
    expect(await closedSocket).toBe(1012);
    await expect(first).rejects.toThrow("Voice shutdown did not settle cleanly");
    expect(closes).toBe(0);
    if (!lastSender) throw new Error("Missing sender");
    expect(lastSender.sendControl({ type: "ready" })).toBe(false);
    release?.();
    await vi.waitFor(() => expect(closes).toBe(1));
  });
  it("reports operation and cleanup failures together", async () => {
    const user = await identity();
    let rejectOperation: ((error: Error) => void) | undefined, entered: (() => void) | undefined;
    const gate = new Promise<void>((_resolve, reject) => {
      rejectOperation = reject;
    });
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let closes = 0;
    await start({
      handler: {
        ...handler,
        onStart() {
          entered?.();
          return gate;
        },
        onClose() {
          closes++;
          throw new Error("private cleanup");
        },
      },
    });
    const ws = await connect(user.session.token);
    ws.send(JSON.stringify({ type: "start", language: "en" }));
    await seen;
    const done = closed(ws),
      first = voice.close();
    expectedCloseFailure = true;
    await done;
    rejectOperation?.(new Error("private operation"));
    const error: unknown = await first.catch((value: unknown) => value);
    if (!(error instanceof AggregateError)) throw new Error("Expected aggregate error");
    expect(error.errors.map((value: unknown) => (value instanceof Error ? value.message : "invalid"))).toEqual([
      "Voice handler operation failed",
      "Voice handler cleanup failed",
    ]);
    expect(closes).toBe(1);
  });
  it("closes when a handler declines audio", async () => {
    await start({ handler: { ...handler, onAudio: () => false } });
    const user = await identity(),
      ws = await connect(user.session.token);
    const ready = message(ws);
    ws.send(JSON.stringify({ type: "start", language: "en" }));
    await ready;
    const done = closed(ws);
    ws.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]));
    expect(await done).toBe(1013);
  });
  it("retains admission after rejected cleanup and reports shutdown failure", async () => {
    const user = await identity(),
      other = await identity();
    let closes = 0;
    await start({
      handler: {
        ...handler,
        onClose(identity) {
          if (identity.userId === user.user.id) {
            closes++;
            throw new Error("private cleanup detail");
          }
        },
      },
    });
    const ws = await connect(user.session.token),
      done = closed(ws);
    ws.close();
    await done;
    await vi.waitFor(() => expect(closes).toBe(1));
    const duplicate = await connect(user.session.token),
      denied = message(duplicate),
      deniedCode = closed(duplicate);
    expect(JSON.parse(await denied)).toEqual({ type: "error", code: "sessionLimit" });
    expect(await deniedCode).toBe(1008);
    const independent = await connect(other.session.token),
      independentClosed = closed(independent);
    independent.close();
    await independentClosed;
    expectedCloseFailure = true;
    await expect(voice.close()).rejects.toThrow("Voice shutdown did not settle cleanly");
    expect(closes).toBe(1);
  });
  it("closes a real paused reader at the voice buffer bound", async () => {
    const user = await identity(),
      other = await identity();
    const senders = new Map<string, VoiceSender>();
    await start({
      handler: {
        ...handler,
        onStart(identity, _frame, sender) {
          senders.set(identity.userId, sender);
          sender.sendControl({ type: "ready" });
        },
      },
    });
    const ws = await connect(user.session.token),
      otherWs = await connect(other.session.token);
    let received = 0;
    otherWs.on("message", (_data, binary) => {
      if (binary) received++;
    });
    const otherReady = message(otherWs);
    otherWs.send(JSON.stringify({ type: "start", language: "en" }));
    expect(JSON.parse((await otherReady).toString())).toMatchObject({ type: "ready" });
    const ready = message(ws);
    ws.send(JSON.stringify({ type: "start", language: "en" }));
    await ready;
    const slowSender = senders.get(user.user.id),
      healthySender = senders.get(other.user.id);
    if (!slowSender || !healthySender) throw new Error("Missing sender");
    const done = closed(ws);
    ws.pause();
    const chunk = Buffer.alloc(4800),
      deadline = Date.now() + 3000;
    let sent = 0,
      refused = false;
    while (sent < 4000 && Date.now() < deadline) {
      if (!slowSender.sendAudio(chunk)) {
        refused = true;
        break;
      }
      expect(healthySender.sendAudio(chunk)).toBe(true);
      sent++;
      if (sent % 4 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    ws.resume();
    expect(refused, `pressure not reached after ${sent} frames`).toBe(true);
    expect(await done).toBe(1013);
    expect(otherWs.readyState).toBe(WebSocket.OPEN);
    await vi.waitFor(() => expect(received).toBe(sent));
    const otherClosed = closed(otherWs);
    otherWs.close();
    await otherClosed;
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
