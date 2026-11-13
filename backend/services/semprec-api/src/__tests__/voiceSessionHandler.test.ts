import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createServer as createTcpServer, connect as connectTcp, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { WebSocket, type RawData } from "ws";
import { z } from "zod";
import { AiGatewayFailedError, currentTenantScope, runAsSystem, runInTenant } from "@semprec/shared";
import { SpeechSynthesisCapacityError, synthesizeSpeech } from "@semprec/ai-gateway-client";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  getAgentRunUsage,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  requestSempTurnCancel,
  seedSystem,
  startSempTurnCancelListener,
  withTransaction,
  type SempTurnCancelRequest,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import { createSyncUpgradeHandler } from "../syncHandler.js";
import { createVoiceChannel, type VoiceChannel } from "../voiceChannel.js";
import { createVoiceSessionHandler, VoiceTextState } from "../voiceSessionHandler.js";

/** Thread details resolve only core heartbeat rule kinds here; no test module declares one. */
const CORE_RULES_ONLY = async () => new Map();

describe("voice text state (component only)", () => {
  it("drains a long answer and splits an admissible multi-sentence delta before applying the sentence bound", () => {
    const state = new VoiceTextState();
    const first = `${"a".repeat(2100)}. `;
    const second = `${"b".repeat(2100)}.`;
    state.beginTurn();
    state.pushDelta(first + second);
    expect(state.takeSentence()).toBe(first);
    expect(state.takeSentence()).toBe(second);
    state.finishMessage(first + second);
    expect(state.takeSentence()).toBeUndefined();
    state.pushDelta(first);
    expect(state.takeSentence()).toBe(first);
    state.pushDelta(second);
    expect(state.takeSentence()).toBe(second);
    state.finishMessage(first + second);
    expect(state.hasSentences).toBe(false);
  });
  it("enforces per-sentence and undrained queue bounds without truncation", () => {
    const exact = new VoiceTextState();
    exact.pushDelta("x".repeat(4000));
    exact.finishMessage("x".repeat(4000));
    expect(exact.takeSentence()).toHaveLength(4000);
    expect(() => new VoiceTextState().pushDelta("x".repeat(4001))).toThrow("sentence exceeds");
    const queue = new VoiceTextState();
    expect(() => queue.pushDelta("A. ".repeat(33))).toThrow("queue exceeds");
    expect(Array.from({ length: 32 }, () => queue.takeSentence())).toEqual(Array(32).fill("A. "));
    expect(queue.takeSentence()).toBeUndefined();
  });
  it("compares UTF-16 prefixes, including split surrogate pairs, and resets each durable message", () => {
    const state = new VoiceTextState();
    state.pushDelta("Hi \ud83d");
    state.pushDelta("\ude00");
    state.finishMessage("Hi 😀. More.");
    expect(state.takeSentence()).toBe("Hi 😀. ");
    expect(state.takeSentence()).toBe("More.");
    state.finishMessage("New sentence.");
    expect(state.takeSentence()).toBe("New sentence.");
    state.finishMessage(undefined);
    state.pushDelta("abc");
    expect(() => state.finishMessage("ab")).toThrow("mismatch");
    const mismatch = new VoiceTextState();
    mismatch.pushDelta("abc");
    expect(() => mismatch.finishMessage("abd.")).toThrow("mismatch");
    const missing = new VoiceTextState();
    missing.pushDelta("abc");
    expect(() => missing.finishMessage(undefined)).toThrow("mismatch");
  });
  it("keeps barge-in suppression across message resets until the next turn", () => {
    const state = new VoiceTextState();
    state.pushDelta("Old sentence.");
    state.interrupt();
    state.pushDelta("Ignored delta.");
    state.finishMessage("Different completion.");
    state.finishMessage(undefined);
    expect(state.hasSentences).toBe(false);
    state.beginTurn();
    state.finishMessage("Fresh sentence.");
    expect(state.takeSentence()).toBe("Fresh sentence.");
  });
});

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const blockRoot = resolve(backend, "../shared/block-model");
const gatewayPath = join(backend, "services/semprec-ai-gateway/dist/__tests__/fixtures/liveVoiceGateway.js");
const workerPath = join(backend, "services/semprec-agents/dist/__tests__/fixtures/liveVoiceWorker.js");
const childMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), port: z.number().int().min(1).max(65535).optional() }),
  z.strictObject({ type: z.literal("sttReady") }),
  z.strictObject({ type: z.literal("audioAccepted") }),
  z.strictObject({ type: z.literal("speechCall"), sequence: z.number().int().min(1).max(100) }),
  z.strictObject({ type: z.literal("modelCall"), sequence: z.number().int().min(1).max(100) }),
  z.strictObject({ type: z.literal("firstTextArmed") }),
  z.strictObject({ type: z.literal("firstTextHeld"), sequence: z.number().int().min(1).max(100) }),
  z.strictObject({
    type: z.literal("firstTextReleased"),
    sequence: z.number().int().min(1).max(100),
    request: z.number().int().min(1).max(100),
  }),
  z.strictObject({ type: z.literal("firstTextDisarmed"), request: z.number().int().min(1).max(100) }),
  z.strictObject({ type: z.literal("approvalReady") }),
  z.strictObject({ type: z.literal("gateArmed") }),
  z.strictObject({
    type: z.literal("gateHeld"),
    tenantId: z.string().uuid(),
    messageId: z.string().uuid(),
    runId: z.string().uuid(),
    eventId: z.string().regex(/^[1-9][0-9]*$/),
  }),
  z.strictObject({ type: z.literal("gateAborted"), count: z.number().int().nonnegative() }),
  z.strictObject({ type: z.literal("gateReleased") }),
]);
type ChildMessage = z.infer<typeof childMessage>;
function messageText(data: RawData): string {
  return (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString(
    "utf8",
  );
}
type OwnedChild = {
  kind: "gateway" | "worker";
  pid: number;
  child: ChildProcess;
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>;
  settled: boolean;
  messages: ChildMessage[];
  invalid: boolean;
  bytes: number;
};

describe("voice session through the real gateway and registered worker", () => {
  let admin: Pool, pool: Pool, server: Server, voice: VoiceChannel;
  let sync: Awaited<ReturnType<typeof createSyncUpgradeHandler>>;
  let directory: string, blockDir: string, tenant: string, token: string, url: string;
  let gateway: OwnedChild | undefined, worker: OwnedChild | undefined;
  let workerEnvironment: NodeJS.ProcessEnv;
  let socket: WebSocket | undefined;
  let priorAssistantIds: string[] = [];
  let fixtureUnsafe: { error: unknown } | undefined;
  const frames: unknown[] = [];
  let audioFrames = 0;

  async function startChild(path: string, extra: NodeJS.ProcessEnv, kind: "gateway" | "worker"): Promise<OwnedChild> {
    const artifact = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
    const child = spawn(process.execPath, [path], {
      cwd: backend,
      detached: true,
      env: { ...process.env, ...extra },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    if (!child.pid) throw new Error("Fixture child did not start");
    const owned: OwnedChild = {
      kind,
      pid: child.pid,
      child,
      settled: false,
      messages: [],
      invalid: false,
      bytes: 0,
      exit: Promise.resolve({ code: null, signal: null }),
    };
    if (kind === "gateway") gateway = owned;
    else worker = owned;
    owned.exit = new Promise((resolveExit) => {
      let error: Error | undefined;
      child.on("error", (value) => {
        error = value;
      });
      child.once("close", (code, signal) => {
        owned.settled = true;
        resolveExit({ code, signal, ...(error ? { error } : {}) });
      });
    });
    const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(child.pid)], { encoding: "utf8" }).trim());
    if (pgid !== child.pid) throw new Error("Unexpected fixture process group");
    process.stderr.write(
      `voice fixture argv=${JSON.stringify([process.execPath, path])} pid=${child.pid} pgid=${pgid} sha256=${artifact}\n`,
    );
    for (const output of [child.stdout, child.stderr])
      output?.on("data", (chunk: Buffer) => {
        owned.bytes += chunk.length;
        if (owned.bytes > 100_000) owned.invalid = true;
      });
    child.on("message", (value: unknown) => {
      const parsed = childMessage.safeParse(value);
      if (!parsed.success || JSON.stringify(value).length > 256 || owned.messages.length >= 400) owned.invalid = true;
      else owned.messages.push(parsed.data);
    });
    await vi.waitFor(
      () => {
        expect(owned.invalid).toBe(false);
        expect(owned.messages.some((m) => m.type === "ready")).toBe(true);
      },
      { timeout: 15_000 },
    );
    return owned;
  }
  function send(child: OwnedChild, type: string, extra: Record<string, string | number> = {}): void {
    if (!child.child.connected) throw new Error("Fixture child disconnected");
    child.child.send({ type, ...extra });
  }
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "semprec-voice-test-"));
    blockDir = await mkdtemp(join(blockRoot, "node_modules/.batch09-"));
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:voice-role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenant = await createTestTenant(admin);
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: 100, monthlyCapUsd: 100 });
    const email = `${randomUUID()}@example.test`;
    await createUser(admin, { tenantId: tenant, email, passwordHash: await hashPassword("voice-test-password") });
    token = (await login(admin, { email, password: "voice-test-password", platform: "ios", ip: "127.0.0.1" })).token;
    await runInTenant(tenant, () => seedSystem(pool));
    for (const [built, source] of [
      [gatewayPath, join(backend, "services/semprec-ai-gateway/src/__tests__/fixtures/liveVoiceGateway.ts")],
      [workerPath, join(backend, "services/semprec-agents/src/__tests__/fixtures/liveVoiceWorker.ts")],
    ] as const)
      if ((await stat(built)).mtimeMs < (await stat(source)).mtimeMs) throw new Error("Stale voice fixture build");
    const args = [
      join(backend, "node_modules/typescript/bin/tsc"),
      "-p",
      join(blockRoot, "tsconfig.json"),
      "--noEmit",
      "false",
      "--declaration",
      "false",
      "--incremental",
      "false",
      "--outDir",
      blockDir,
    ];
    const built = spawnSync(process.execPath, args, { cwd: backend, timeout: 25_000, maxBuffer: 1_000_000 });
    process.stderr.write(
      `voice block compiler pid=${built.pid} status=${built.status} signal=${built.signal} argv=${JSON.stringify([process.execPath, ...args])}\n`,
    );
    if (built.error) throw built.error;
    if (built.status !== 0) throw new Error("Voice block-model build failed");
    const blockEntry = join(blockDir, "index.js");
    process.stderr.write(
      `voice block sha256=${createHash("sha256")
        .update(await readFile(blockEntry))
        .digest("hex")}\n`,
    );
    const databaseUrl = z.object({ connectionString: z.string() }).parse(pool.options).connectionString;
    const common = { BATCH09_BLOCK_MODEL_ENTRY: blockEntry, BATCH32_GATEWAY_DATABASE_URL: databaseUrl };
    gateway = await startChild(gatewayPath, common, "gateway");
    const ready = gateway.messages.find((message) => message.type === "ready");
    if (!ready || ready.type !== "ready" || !ready.port) throw new Error("Missing gateway port");
    workerEnvironment = {
      ...common,
      BATCH32_GATEWAY_PORT: String(ready.port),
      FILES_STORAGE_DIR: directory,
      MAIL_ATTACHMENTS_DIR: directory,
    };
    worker = await startChild(workerPath, workerEnvironment, "worker");
    sync = await createSyncUpgradeHandler(pool);
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: { async sendPasswordResetEmail() {} },
      appBaseUrl: "https://example.test",
      setupToken: "test",
      moduleRegistry: await loadFullModuleRegistry(),
      blobStorage: new LocalFsBlobStorageWriter(directory),
      maxFileSizeBytes: 1024,
    });
    server = createServer(dispatch);
    server.on("upgrade", (req, stream, head) => voice.handleUpgrade(req, stream, head));
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing voice listener");
    url = `ws://127.0.0.1:${address.port}/api/voice`;
  }, 90_000);
  beforeEach(async () => {
    if (fixtureUnsafe) throw new Error("Prior voice fixture settlement failed", { cause: fixtureUnsafe.error });
    frames.length = 0;
    audioFrames = 0;
    const ready = gateway?.messages.find((entry) => entry.type === "ready");
    if (!ready || ready.type !== "ready" || !ready.port) throw new Error("Missing gateway port");
    voice = createVoiceChannel(pool, {
      handler: createVoiceSessionHandler(
        pool,
        { port: ready.port, token: "batch32-test-token" },
        sync,
        CORE_RULES_ONLY,
      ),
    });
    const prior = await runInTenant(tenant, () =>
      pool.query<{ id: string }>("SELECT id::text FROM semp_messages WHERE role='assistant'"),
    );
    priorAssistantIds = prior.rows.map((row) => row.id);
  });

  it.each(["normal", "peer", "tenant", "server"] as const)(
    "settles an actual gated gateway upgrade after %s",
    async (ending) => {
      const ready = gateway?.messages.find((entry) => entry.type === "ready");
      if (!ready || ready.type !== "ready" || !ready.port) throw new Error("Missing owned gateway port");
      const gatewayPort = ready.port;
      let downstream: Socket | undefined;
      let upstream: Socket | undefined;
      let seen = false;
      let released = false;
      let retained: Buffer | undefined;
      let downstreamClosed = false;
      let upstreamClosed = false;
      let relayError: unknown;
      const onSocketError = (error: Error) => {
        relayError ??= error;
      };
      const relay = createTcpServer((incoming) => {
        if (downstream) {
          incoming.destroy();
          return;
        }
        downstream = incoming;
        upstream = connectTcp({ host: "127.0.0.1", port: gatewayPort });
        const outgoing = upstream;
        incoming.on("error", onSocketError);
        outgoing.on("error", onSocketError);
        incoming.once("close", () => {
          downstreamClosed = true;
          outgoing.destroy();
        });
        outgoing.once("close", () => {
          upstreamClosed = true;
          incoming.destroy();
        });
        incoming.pipe(outgoing);
        outgoing.once("data", (bytes: Buffer) => {
          outgoing.pause();
          if (bytes.length > 64 * 1024) {
            relayError = new Error("Relay byte bound exceeded");
            incoming.destroy();
            outgoing.destroy();
            return;
          }
          retained = bytes;
          seen = true;
          if (released && !incoming.destroyed) {
            incoming.write(bytes);
            retained = undefined;
            outgoing.pipe(incoming);
            outgoing.resume();
          }
        });
      });
      const localServer = createServer();
      let channel: VoiceChannel | undefined;
      let ws: WebSocket | undefined;
      let failure: unknown;
      let failed = false;
      const cleanupErrors: unknown[] = [];
      const received: unknown[] = [];
      let shutdown: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      try {
        const listen = (owned: ReturnType<typeof createTcpServer>) =>
          new Promise<void>((resolveListen, reject) => {
            const onError = (error: Error) => reject(error);
            owned.once("error", onError);
            owned.listen(0, "127.0.0.1", () => {
              owned.off("error", onError);
              resolveListen();
            });
          });
        await listen(relay);
        const relayAddress = relay.address();
        if (!relayAddress || typeof relayAddress === "string") throw new Error("Missing relay address");
        let startSignal: AbortSignal | undefined;
        let startFailure: { error: unknown; aborted: boolean } | undefined;
        let closedSessions = 0;
        const actualHandler = createVoiceSessionHandler(
          pool,
          { port: relayAddress.port, token: "batch32-test-token" },
          sync,
          CORE_RULES_ONLY,
        );
        channel = createVoiceChannel(pool, {
          handler: {
            ...actualHandler,
            onStart(identity, frame, sender) {
              startSignal = sender.signal;
              return Promise.resolve(actualHandler.onStart(identity, frame, sender)).catch((error: unknown) => {
                startFailure = { error, aborted: sender.signal.aborted };
                throw error;
              });
            },
            async onClose(identity) {
              await actualHandler.onClose(identity);
              closedSessions++;
            },
          },
        });
        const actualChannel = channel;
        localServer.on("upgrade", (req, stream, head) => actualChannel.handleUpgrade(req, stream, head));
        await listen(localServer);
        const address = localServer.address();
        if (!address || typeof address === "string") throw new Error("Missing gated voice address");
        const observations = () =>
          runInTenant(tenant, async () => ({
            messages: (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_messages")).rows,
            jobs: (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM graphile_worker.jobs")).rows,
            calls: (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM ai_gateway_calls")).rows,
          }));
        const before = await observations();
        ws = new WebSocket(`ws://127.0.0.1:${address.port}/api/voice`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const peer = ws;
        ws.on("message", (data, binary) => {
          if (!binary) received.push(JSON.parse(messageText(data)) as unknown);
        });
        ws.on("error", onSocketError);
        let peerClosed = false;
        ws.on("close", () => {
          peerClosed = true;
        });
        const releaseGate = () => {
          released = true;
          if (retained && downstream && upstream && !downstream.destroyed && !upstream.destroyed) {
            downstream.write(retained);
            retained = undefined;
            upstream.pipe(downstream);
            upstream.resume();
          }
        };
        await vi.waitFor(() => expect(peer.readyState).toBe(WebSocket.OPEN), { timeout: 5000 });
        peer.send(JSON.stringify({ type: "start", language: "en" }));
        await vi.waitFor(() => expect(seen).toBe(true), { timeout: 5000 });
        expect(received).toEqual([]);
        if (ending === "normal") {
          releaseGate();
          await vi.waitFor(() => expect(received).toContainEqual({ type: "ready" }), { timeout: 5000 });
          peer.close();
        } else {
          if (ending === "peer") peer.close();
          else if (ending === "tenant") actualChannel.closeTenant(tenant);
          else {
            shutdown = actualChannel.close().then(
              () => ({ ok: true as const }),
              (error: unknown) => ({ ok: false as const, error }),
            );
          }
          await vi.waitFor(() => expect(peerClosed).toBe(true), { timeout: 5000 });
          expect(startSignal?.aborted).toBe(true);
          await vi.waitFor(
            () => {
              expect(downstreamClosed).toBe(true);
              expect(upstreamClosed).toBe(true);
            },
            { timeout: 5000 },
          );
          releaseGate();
          expect(received).toEqual([]);
        }
        await vi.waitFor(() => expect(peerClosed).toBe(true), { timeout: 5000 });
        await vi.waitFor(() => expect(closedSessions).toBe(1), { timeout: 5000 });
        if (ending === "server") {
          expect(startFailure?.aborted).toBe(true);
          expect(startFailure?.error).toBeInstanceOf(AiGatewayFailedError);
          if (!(startFailure?.error instanceof AiGatewayFailedError)) throw new Error("Missing gateway rejection");
          expect(startFailure.error.reason).toBe("http");
        }
        expect(await observations()).toEqual(before);
      } catch (error) {
        failed = true;
        failure = error;
      }
      try {
        ws?.terminate();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        downstream?.destroy();
        upstream?.destroy();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (shutdown) {
          const outcome = await shutdown;
          if (ending === "server") {
            expect(outcome.ok).toBe(false);
            if (outcome.ok || !(outcome.error instanceof AggregateError)) throw new Error("Missing shutdown aggregate");
            expect(outcome.error.errors).toHaveLength(1);
            const member: unknown = outcome.error.errors[0];
            expect(member).toBeInstanceOf(Error);
            if (!(member instanceof Error)) throw new Error("Invalid shutdown member");
            expect(member.message).toBe("Voice handler operation failed");
          } else if (!outcome.ok) throw outcome.error;
        } else if (channel) await channel.close();
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        await vi.waitFor(
          () => {
            if (downstream) expect(downstreamClosed).toBe(true);
            if (upstream) expect(upstreamClosed).toBe(true);
          },
          { timeout: 5000 },
        );
      } catch (error) {
        cleanupErrors.push(error);
      }
      if (downstreamClosed) downstream?.off("error", onSocketError);
      if (upstreamClosed) upstream?.off("error", onSocketError);
      if (ws?.readyState === WebSocket.CLOSED) ws.off("error", onSocketError);
      try {
        if (ending !== "normal" && seen) expect(received).toEqual([]);
      } catch (error) {
        cleanupErrors.push(error);
      }
      for (const owned of [localServer, relay]) {
        try {
          if (owned.listening)
            await new Promise<void>((resolveClose, reject) =>
              owned.close((error) => (error ? reject(error) : resolveClose())),
            );
        } catch (error) {
          cleanupErrors.push(error);
        }
      }
      if (relayError) cleanupErrors.push(relayError);
      if (failed || cleanupErrors.length)
        throw new AggregateError([...(failed ? [failure] : []), ...cleanupErrors], "Gated start or cleanup failed", {
          cause: failed ? failure : cleanupErrors[0],
        });
    },
  );

  it("settles actual pending voice registrations after peer, tenant and server close before model work", async () => {
    const gatewayReady = gateway?.messages.find((entry) => entry.type === "ready");
    if (!gateway || !gatewayReady || gatewayReady.type !== "ready" || !gatewayReady.port || !worker)
      throw new Error("Missing owned voice fixtures");
    const gatewayChild = gateway;
    const gatewayPort = gatewayReady.port;
    const modelCalls = () => gatewayChild.messages.filter((entry) => entry.type === "modelCall").length;
    const waitExit = async (owned: OwnedChild, milliseconds: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          owned.exit.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), milliseconds);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const stopOwned = async (owned: OwnedChild) => {
      const errors: unknown[] = [];
      try {
        if (!owned.settled && owned.child.connected) send(owned, "stop");
      } catch (error) {
        errors.push(error);
      }
      let settled = await waitExit(owned, 20_000);
      if (!settled) {
        try {
          if (!owned.child.kill("SIGKILL")) errors.push(new Error("Unable to signal worker"));
        } catch (error) {
          errors.push(error);
        }
        settled = await waitExit(owned, 5000);
      }
      if (!settled) errors.push(new Error("Worker exit not observed"));
      else {
        const result = await owned.exit;
        if (result.error || result.code !== 0 || result.signal !== null)
          errors.push(result.error ?? new Error("Worker failed"));
      }
      if (errors.length) throw new AggregateError(errors, "Worker cleanup failed", { cause: errors[0] });
    };
    const initial = worker;
    await stopOwned(initial);
    worker = undefined;
    let failed = false;
    let failure: unknown;
    const cleanupErrors: unknown[] = [];
    let lastIsolated: OwnedChild | undefined;
    try {
      for (const ending of ["peer", "tenant", "server"] as const) {
        const isolated = await startChild(
          workerPath,
          { ...workerEnvironment, BATCH32_REGISTRATION_GATE: "1" },
          "worker",
        );
        lastIsolated = isolated;
        let channel: VoiceChannel | undefined;
        let localServer: Server | undefined;
        let peer: WebSocket | undefined;
        let shutdown: Promise<void> | undefined;
        let abortConfirmed = false;
        let gateHeld = false;
        let heldRunId: string | undefined;
        let heldMessageId: string | undefined;
        const initialCalls = modelCalls();
        let releaseSql!: () => void;
        const sqlGate = new Promise<void>((resolveGate) => {
          releaseSql = resolveGate;
        });
        let sqlReached = false;
        let sqlClaimed = false;
        let sqlParameters: unknown[] | undefined;
        const pendingQueries: Promise<unknown>[] = [];
        const descriptor = Object.getOwnPropertyDescriptor(pool, "query");
        /* eslint-disable @typescript-eslint/unbound-method */
        const original = pool.query;
        pool.query = new Proxy(original, {
          apply(target, receiver, args: unknown[]) {
            const result: unknown = Reflect.apply(target, receiver, args);
            if (
              sqlClaimed ||
              typeof args[0] !== "string" ||
              !args[0].includes("FROM agent_run_events e") ||
              !args[0].includes("LIMIT $5") ||
              !Array.isArray(args[1])
            )
              return result;
            sqlClaimed = true;
            sqlParameters = args[1];
            const work = Promise.resolve(result).then(async (actual: unknown) => {
              sqlReached = true;
              await sqlGate;
              return actual;
            });
            pendingQueries.push(
              work.then(
                () => undefined,
                () => undefined,
              ),
            );
            return work;
          },
        });
        /* eslint-enable @typescript-eslint/unbound-method */
        let caseFailed = false;
        let caseFailure: unknown;
        let peerError: unknown;
        const caseCleanup: unknown[] = [];
        try {
          send(isolated, "arm");
          await vi.waitFor(() => expect(isolated.messages).toContainEqual({ type: "gateArmed" }), { timeout: 5000 });
          let senderSignal: AbortSignal | undefined;
          let closedCount = 0;
          const actual = createVoiceSessionHandler(
            pool,
            { port: gatewayPort, token: "batch32-test-token" },
            sync,
            CORE_RULES_ONLY,
          );
          channel = createVoiceChannel(pool, {
            handler: {
              ...actual,
              onStart(identity, frame, sender) {
                senderSignal = sender.signal;
                return actual.onStart(identity, frame, sender);
              },
              async onClose(identity) {
                await actual.onClose(identity);
                closedCount++;
              },
            },
          });
          const actualChannel = channel;
          localServer = createServer();
          localServer.on("upgrade", (req, stream, head) => actualChannel.handleUpgrade(req, stream, head));
          await new Promise<void>((resolveListen) => localServer!.listen(0, "127.0.0.1", resolveListen));
          const address = localServer.address();
          if (!address || typeof address === "string") throw new Error("Missing registration voice listener");
          peer = new WebSocket(`ws://127.0.0.1:${address.port}/api/voice`, {
            headers: { authorization: `Bearer ${token}` },
          });
          const current = peer;
          const received: unknown[] = [];
          current.on("message", (data, binary) => {
            if (!binary) received.push(JSON.parse(messageText(data)) as unknown);
          });
          current.on("error", (error) => {
            peerError ??= error;
          });
          let closed = false;
          current.on("close", () => {
            closed = true;
          });
          await vi.waitFor(() => expect(current.readyState).toBe(WebSocket.OPEN), { timeout: 5000 });
          current.send(JSON.stringify({ type: "start", language: "en" }));
          await vi.waitFor(() => expect(received).toContainEqual({ type: "ready" }), { timeout: 5000 });
          const gatewayPosition = gatewayChild.messages.length;
          current.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]));
          await vi.waitFor(
            () =>
              expect(gatewayChild.messages.slice(gatewayPosition).some((entry) => entry.type === "audioAccepted")).toBe(
                true,
              ),
            { timeout: 5000 },
          );
          send(gatewayChild, "final");
          await vi.waitFor(
            () =>
              expect(
                received.some(
                  (frame) =>
                    z
                      .object({ type: z.literal("transcript"), final: z.literal(true), text: z.string() })
                      .safeParse(frame).success,
                ),
              ).toBe(true),
            { timeout: 5000 },
          );
          await vi.waitFor(() => expect(isolated.messages.some((entry) => entry.type === "gateHeld")).toBe(true), {
            timeout: 5000,
          });
          gateHeld = true;
          const held = isolated.messages.find((entry) => entry.type === "gateHeld");
          if (!held || held.type !== "gateHeld") throw new Error("Missing worker gate identity");
          heldRunId = held.runId;
          heldMessageId = held.messageId;
          expect(held.tenantId).toBe(tenant);
          await vi.waitFor(() => expect(sqlReached).toBe(true), { timeout: 5000 });
          expect(sqlParameters?.[0]).toBe(held.runId);
          expect(sqlParameters?.[3]).toBe(held.messageId);
          const rows = await runInTenant(tenant, () =>
            pool.query<{ thread_id: string; user_id: string; event_id: string; kind: string; source: string | null }>(
              `SELECT a.thread_id, u.id AS user_id, e.id::text AS event_id, e.kind, u.source FROM semp_messages a
             JOIN semp_messages u ON u.tenant_id = a.tenant_id AND a.reply_to_message_id = u.id AND u.role = 'user'
             JOIN agent_run_events e ON e.tenant_id = a.tenant_id AND e.agent_run_id = a.agent_run_id AND e.id = a.event_from_id
             JOIN agent_runs r ON r.tenant_id = a.tenant_id AND r.id = a.agent_run_id
             WHERE a.id = $1 AND a.role = 'assistant' AND a.agent_run_id = $2 AND e.id = $3::bigint`,
              [held.messageId, held.runId, held.eventId],
            ),
          );
          expect(rows.rows).toHaveLength(1);
          expect(rows.rows[0]).toMatchObject({ event_id: held.eventId, kind: "user_message", source: "voice" });
          expect(sqlParameters?.[2]).toBe(rows.rows[0]?.thread_id);
          const beforeClose = received.length;
          if (ending === "peer") current.close();
          else if (ending === "tenant") actualChannel.closeTenant(tenant);
          else {
            shutdown = actualChannel.close();
            void shutdown.catch(() => {});
          }
          await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5000 });
          expect(senderSignal?.aborted).toBe(true);
          releaseSql();
          await vi.waitFor(() => expect(closedCount).toBe(1), { timeout: 5000 });
          expect(received).toHaveLength(beforeClose);
          send(isolated, "abort");
          await vi.waitFor(() => expect(isolated.messages.some((entry) => entry.type === "gateAborted")).toBe(true), {
            timeout: 5000,
          });
          const abort = isolated.messages.find((entry) => entry.type === "gateAborted");
          if (!abort || abort.type !== "gateAborted" || abort.count < 1)
            throw new Error("Worker cohort abort not established");
          abortConfirmed = true;
          send(isolated, "release");
          await vi.waitFor(() => expect(isolated.messages).toContainEqual({ type: "gateReleased" }), { timeout: 5000 });
          const calls = await runInTenant(tenant, () =>
            pool.query<{ count: number }>(
              "SELECT count(*)::int AS count FROM ai_gateway_calls WHERE agent_run_id = $1",
              [held.runId],
            ),
          );
          expect(calls.rows).toEqual([{ count: 0 }]);
          expect(modelCalls()).toBe(initialCalls);
        } catch (error) {
          caseFailed = true;
          caseFailure = error;
        }
        releaseSql();
        try {
          await Promise.all(pendingQueries);
        } catch (error) {
          caseCleanup.push(error);
        }
        try {
          if (descriptor) Object.defineProperty(pool, "query", descriptor);
          else if (!Reflect.deleteProperty(pool, "query"))
            throw new Error("Cannot restore registration query descriptor");
          expect(Object.getOwnPropertyDescriptor(pool, "query")).toEqual(descriptor);
        } catch (error) {
          caseCleanup.push(error);
        }
        try {
          peer?.terminate();
        } catch (error) {
          caseCleanup.push(error);
        }
        try {
          if (shutdown) await shutdown;
          else if (channel) await channel.close();
        } catch (error) {
          caseCleanup.push(error);
        }
        try {
          if (localServer?.listening)
            await new Promise<void>((resolveClose, reject) =>
              localServer.close((error) => (error ? reject(error) : resolveClose())),
            );
        } catch (error) {
          caseCleanup.push(error);
        }
        if (gateHeld && !abortConfirmed)
          caseCleanup.push(new Error("Worker gate retained without positive cohort abort"));
        try {
          await stopOwned(isolated);
        } catch (error) {
          caseCleanup.push(error);
        }
        try {
          if (abortConfirmed && isolated.settled && heldRunId && heldMessageId) {
            const finalState = await runInTenant(tenant, () =>
              pool.query<{ status: string; error_code: string | null }>(
                "SELECT status, error_code FROM semp_messages WHERE id = $1",
                [heldMessageId],
              ),
            );
            expect(finalState.rows).toEqual([{ status: "error", error_code: "interrupted" }]);
            const calls = await runInTenant(tenant, () =>
              pool.query<{ count: number }>(
                "SELECT count(*)::int AS count FROM ai_gateway_calls WHERE agent_run_id = $1",
                [heldRunId],
              ),
            );
            expect(calls.rows).toEqual([{ count: 0 }]);
            expect(modelCalls()).toBe(initialCalls);
          }
        } catch (error) {
          caseCleanup.push(error);
        }
        if (peerError) caseCleanup.push(peerError);
        if (caseFailed || caseCleanup.length)
          throw new AggregateError(
            [...(caseFailed ? [caseFailure] : []), ...caseCleanup],
            "Registration case or cleanup failed",
            { cause: caseFailed ? caseFailure : caseCleanup[0] },
          );
      }
    } catch (error) {
      failed = true;
      failure = error;
    }
    if (lastIsolated?.settled) worker = undefined;
    if (!failed && !worker) {
      try {
        worker = await startChild(workerPath, workerEnvironment, "worker");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (failed || cleanupErrors.length)
      throw new AggregateError(
        [...(failed ? [failure] : []), ...cleanupErrors],
        "Registration suite or cleanup failed",
        { cause: failed ? failure : cleanupErrors[0] },
      );
  });
  afterEach(async () => {
    const failures: unknown[] = [];
    try {
      if (socket && socket.readyState !== WebSocket.CLOSED) {
        const closed = once(socket, "close");
        socket.terminate();
        await closed;
      }
    } catch (error) {
      failures.push(error);
    }
    socket = undefined;
    try {
      if (voice) await voice.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await vi.waitFor(
        async () => {
          const state = await runInTenant(tenant, async () => {
            const assistants = await pool.query<{ id: string; status: string | null }>(
              "SELECT id::text, status FROM semp_messages WHERE role='assistant' AND NOT (id=ANY($1::uuid[]))",
              [priorAssistantIds],
            );
            const jobs = await pool.query<{ key: string | null }>(
              "SELECT key FROM graphile_worker.jobs WHERE key=ANY($1::text[])",
              [assistants.rows.map((row) => `sempMessage:${row.id}`)],
            );
            const calls = await pool.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM ai_gateway_calls WHERE status='reserved'",
            );
            return { assistants: assistants.rows, jobs: jobs.rows, calls: calls.rows };
          });
          expect(state.assistants.every((row) => row.status === "done" || row.status === "error")).toBe(true);
          expect(state.jobs).toEqual([]);
          expect(state.calls).toEqual([{ count: "0" }]);
        },
        { timeout: 30_000 },
      );
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      const error = new AggregateError(failures, "Voice case settlement failed", { cause: failures[0] });
      fixtureUnsafe = { error };
      throw error;
    }
  });
  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    await cleanup(async () => {
      socket?.terminate();
    });
    if (voice) await cleanup(() => voice.close());
    if (sync) await cleanup(() => sync.close());
    if (server)
      await cleanup(
        () =>
          new Promise<void>((resolveClose, reject) =>
            server.close((error) => (error ? reject(error) : resolveClose())),
          ),
      );
    async function stop(owned: OwnedChild | undefined): Promise<void> {
      if (!owned) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!owned.settled && owned.child.connected) send(owned, "stop");
        const result = await Promise.race([
          owned.exit,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`Fixture ${owned.kind} pid=${owned.pid} stop timed out`)),
              20_000,
            );
          }),
        ]);
        if (result.error || result.code !== 0 || result.signal !== null)
          throw result.error ?? new Error(`Fixture ${owned.kind} pid=${owned.pid} failed`);
        process.stderr.write(
          `voice fixture kind=${owned.kind} pid=${owned.pid} exit=${result.code} signal=${result.signal}\n`,
        );
      } catch (error) {
        failures.push(error);
        if (!owned.settled) {
          try {
            if (!owned.child.kill("SIGKILL")) failures.push(new Error("Unable to signal owned fixture child"));
          } catch (signalError) {
            failures.push(signalError);
          }
          let exitTimer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              owned.exit,
              new Promise<never>((_, reject) => {
                exitTimer = setTimeout(
                  () => reject(new Error(`Fixture ${owned.kind} pid=${owned.pid} exit not observed`)),
                  5000,
                );
              }),
            ]);
          } catch (exitError) {
            failures.push(exitError);
          } finally {
            if (exitTimer) clearTimeout(exitTimer);
          }
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    await stop(worker);
    if (!worker || worker.settled) await stop(gateway);
    else failures.push(new Error("Gateway retained because worker settlement was not observed"));
    if (pool) await cleanup(() => pool.end());
    if (admin) await cleanup(() => admin.end());
    if ((!worker || worker.settled) && (!gateway || gateway.settled)) {
      if (blockDir) await cleanup(() => rm(blockDir, { recursive: true, force: true }));
      if (directory) await cleanup(() => rm(directory, { recursive: true, force: true }));
    } else failures.push(new Error("Child settlement unknown; fixture files retained"));
    if (failures.length) throw new AggregateError(failures, "Voice fixture cleanup failed", { cause: failures[0] });
  }, 60_000);
  it.each([
    { name: "admits two quick initial finals into one thread before delivery finishes", count: 2, overflow: false },
    { name: "admits sixteen outstanding voice turns and refuses the seventeenth", count: 16, overflow: true },
  ])(
    "$name",
    async ({ count, overflow }) => {
      if (!gateway) throw new Error("Missing fixture gateway");
      const ownedGateway = gateway;
      let held = false;
      let failure: { error: unknown } | undefined;
      let socketError: { error: Error } | undefined;
      const cleanup: unknown[] = [];
      const control = async (type: "holdModel" | "releaseModel") => {
        if (!ownedGateway.child.connected) throw new Error("Fixture gateway disconnected");
        await new Promise<void>((resolveSend, reject) => {
          const timer = setTimeout(() => reject(new Error("Fixture control acknowledgement timed out")), 5000);
          try {
            ownedGateway.child.send({ type }, (error) => {
              clearTimeout(timer);
              if (error) reject(error);
              else resolveSend();
            });
          } catch (error) {
            clearTimeout(timer);
            reject(error instanceof Error ? error : new Error("Fixture control failed", { cause: error }));
          }
        });
      };
      try {
        socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
        socket.on("message", (data, binary) => {
          if (binary) audioFrames++;
          else frames.push(JSON.parse(messageText(data)) as unknown);
        });
        await once(socket, "open");
        socket.on("error", (error) => {
          socketError ??= { error };
        });
        socket.send(JSON.stringify({ type: "start", language: "en" }));
        await vi.waitFor(() => expect(frames).toContainEqual({ type: "ready" }));
        const sttBefore = ownedGateway.messages.filter((entry) => entry.type === "sttReady").length;
        const audioBefore = ownedGateway.messages.filter((entry) => entry.type === "audioAccepted").length;
        socket.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]));
        await vi.waitFor(() => {
          expect(ownedGateway.messages.filter((entry) => entry.type === "sttReady")).toHaveLength(sttBefore + 1);
          expect(ownedGateway.messages.filter((entry) => entry.type === "audioAccepted")).toHaveLength(audioBefore + 1);
        });
        held = true;
        await control("holdModel");
        const prior = await runInTenant(tenant, () =>
          pool.query<{ id: string }>("SELECT id FROM semp_threads ORDER BY id"),
        );
        const priorModelCalls = ownedGateway.messages.filter((entry) => entry.type === "modelCall").length;
        send(ownedGateway, "final");
        if (!overflow) send(ownedGateway, "finalSecond");
        const threadId = await vi.waitFor(async () => {
          const threads = await runInTenant(tenant, () =>
            pool.query<{ id: string }>("SELECT id FROM semp_threads ORDER BY id"),
          );
          const fresh = threads.rows.filter((row) => !prior.rows.some((old) => old.id === row.id));
          expect(fresh).toHaveLength(1);
          return fresh[0]!.id;
        });
        await vi.waitFor(() =>
          expect(ownedGateway.messages.filter((entry) => entry.type === "modelCall")).toHaveLength(priorModelCalls + 1),
        );
        for (let i = 1; i < count; i++) {
          if (overflow) send(ownedGateway, "finalSecond");
          await vi.waitFor(async () => {
            const rows = await runInTenant(tenant, () =>
              pool.query<{ users: string; assistants: string }>(
                "SELECT count(*) FILTER (WHERE role='user')::text AS users, count(*) FILTER (WHERE role='assistant')::text AS assistants FROM semp_messages WHERE thread_id=$1",
                [threadId],
              ),
            );
            expect(rows.rows).toEqual([{ users: String(i + 1), assistants: String(i + 1) }]);
          });
        }
        const rows = await runInTenant(tenant, () =>
          pool.query<{ role: string; source: string | null; status: string | null }>(
            "SELECT role, source, status FROM semp_messages WHERE thread_id=$1 ORDER BY created_at, id",
            [threadId],
          ),
        );
        expect(rows.rows).toHaveLength(count * 2);
        for (let i = 0; i < count; i++) {
          expect(rows.rows[i * 2]).toMatchObject({ role: "user", source: "voice" });
          expect(rows.rows[i * 2 + 1]).toMatchObject({ role: "assistant" });
        }
        expect(ownedGateway.messages.filter((entry) => entry.type === "modelCall")).toHaveLength(priorModelCalls + 1);
        expect(rows.rows.filter((row) => row.role === "assistant" && row.status === "running")).toHaveLength(1);
        expect(rows.rows.filter((row) => row.role === "assistant" && row.status === "queued")).toHaveLength(count - 1);
        const allThreads = await runInTenant(tenant, () =>
          pool.query<{ id: string }>("SELECT id FROM semp_threads ORDER BY id"),
        );
        expect(allThreads.rows.filter((row) => !prior.rows.some((old) => old.id === row.id))).toEqual([
          { id: threadId },
        ]);
        if (overflow) {
          send(ownedGateway, "finalSecond");
          await vi.waitFor(() => expect(frames).toContainEqual({ type: "error", code: "overloaded" }));
          const after = await runInTenant(tenant, () =>
            pool.query<{ count: string }>("SELECT count(*)::text AS count FROM semp_messages WHERE thread_id=$1", [
              threadId,
            ]),
          );
          expect(after.rows).toEqual([{ count: String(count * 2) }]);
        }
      } catch (error) {
        failure = { error };
      } finally {
        if (held) {
          try {
            await control("releaseModel");
          } catch (error) {
            cleanup.push(error);
          }
        }
        if (socket && socket.readyState !== WebSocket.CLOSED) {
          try {
            const closed = once(socket, "close");
            socket.terminate();
            await closed;
          } catch (error) {
            cleanup.push(error);
          }
        }
      }
      if (socketError) cleanup.push(socketError.error);
      if (cleanup.length)
        throw new AggregateError(
          failure ? [failure.error, ...cleanup] : cleanup,
          "Voice admission test cleanup failed",
          { cause: failure ? failure.error : cleanup[0] },
        );
      if (failure) throw failure.error;
    },
    70_000,
  );

  it.each(["fault", "server-close"] as const)(
    "settles a real second voice admission with a synthetic %s boundary",
    async (mode) => {
      if (!gateway) throw new Error("Missing fixture gateway");
      const ownedGateway = gateway;
      const ready = ownedGateway.messages.find((entry) => entry.type === "ready");
      if (!ready || ready.type !== "ready" || !ready.port) throw new Error("Missing gateway port");
      const handler = createVoiceSessionHandler(
        pool,
        { port: ready.port, token: "batch32-test-token" },
        sync,
        CORE_RULES_ONLY,
      );
      const closeDescriptor = Object.getOwnPropertyDescriptor(handler, "onClose");
      /* eslint-disable-next-line @typescript-eslint/unbound-method */
      const originalClose = handler.onClose;
      const closeObservations: Array<{
        identity: { tenantId: string; userId: string; sessionId: string };
        settled: boolean;
        outcome?: PromiseSettledResult<void | { readonly operationFailures: readonly unknown[] }>;
      }> = [];
      let closeCalls = 0;
      let unsettledCloseCalls = 0;
      handler.onClose = function (identity) {
        const result = originalClose.call(this, identity);
        if (!(result instanceof Promise)) throw new Error("Voice handler close did not return a promise");
        const observation: (typeof closeObservations)[number] = { identity, settled: false };
        closeCalls++;
        unsettledCloseCalls++;
        if (closeObservations.length < 2) closeObservations.push(observation);
        result.then(
          (value) => {
            observation.outcome = { status: "fulfilled", value };
            observation.settled = true;
            unsettledCloseCalls--;
          },
          (reason: unknown) => {
            observation.outcome = { status: "rejected", reason };
            observation.settled = true;
            unsettledCloseCalls--;
          },
        );
        return result;
      };
      function restoreClose(): void {
        if (unsettledCloseCalls !== 0) throw new Error("Handler close observation unsettled");
        if (closeDescriptor) Object.defineProperty(handler, "onClose", closeDescriptor);
        else if (!Reflect.deleteProperty(handler, "onClose"))
          throw new Error("Cannot restore handler close descriptor");
        expect(Object.getOwnPropertyDescriptor(handler, "onClose")).toEqual(closeDescriptor);
      }
      const channel = createVoiceChannel(pool, { handler });
      const localServer = createServer();
      localServer.on("upgrade", (req, stream, head) => channel.handleUpgrade(req, stream, head));
      const active = new Map<PoolClient, PropertyDescriptor | undefined>();
      const pending: Promise<void>[] = [];
      const observerErrors: unknown[] = [];
      const fault = new Error("Synthetic second voice admission fault");
      let releaseGate!: () => void;
      const gate = new Promise<void>((resolveGate) => {
        releaseGate = resolveGate;
      });
      let reached = false;
      let rollback = false;
      let selectedClient: PoolClient | undefined;
      let selectedThread: string | undefined;
      let peer: WebSocket | undefined;
      let replacement: WebSocket | undefined;
      let closeWork: Promise<PromiseSettledResult<void>> | undefined;
      let held = false;
      let audioCount = 0;
      let frameCountAtClose = 0;
      let audioCountAtClose = 0;
      let failed: { error: unknown } | undefined;
      let socketError: { error: Error } | undefined;
      const cleanup: unknown[] = [];
      // The statement also sets the search vector of the text (#1783); it is told by its start and its user role.
      const isUserMessageInsert = (statement: unknown): boolean =>
        typeof statement === "string" &&
        statement.startsWith(
          "INSERT INTO semp_messages (thread_id, role, text, search_vector, context, created_at, source)",
        ) &&
        statement.includes("VALUES ($1, 'user', $2::text,");
      const onRelease = (_error: Error | undefined, client: PoolClient) => {
        if (!active.has(client)) return;
        const descriptor = active.get(client);
        try {
          if (descriptor) Object.defineProperty(client, "query", descriptor);
          else if (!Reflect.deleteProperty(client, "query")) throw new Error("Cannot restore query descriptor");
          active.delete(client);
        } catch (error) {
          observerErrors.push(error);
          try {
            pending.push(
              client.end().then(
                () => {
                  active.delete(client);
                },
                (endError: unknown) => {
                  observerErrors.push(endError);
                },
              ),
            );
          } catch (endError) {
            observerErrors.push(endError);
          }
        }
      };
      const onAcquire = (client: PoolClient) => {
        if (active.has(client)) return;
        try {
          active.set(client, Object.getOwnPropertyDescriptor(client, "query"));
          /* eslint-disable @typescript-eslint/unbound-method */
          client.query = new Proxy(client.query, {
            apply(target, receiver, args: unknown[]) {
              const scope = currentTenantScope();
              const values: unknown = args[1];
              const match =
                !reached &&
                isUserMessageInsert(args[0]) &&
                scope?.kind === "tenant" &&
                scope.tenantId === tenant &&
                Array.isArray(values) &&
                values.length === 5 &&
                values[0] === selectedThread &&
                values[1] === "A second question." &&
                values[2] === "[]" &&
                (values[3] instanceof Date || typeof values[3] === "string") &&
                values[4] === "voice";
              if (!match) {
                const result: unknown = Reflect.apply(target, receiver, args);
                if (client === selectedClient && args[0] === "ROLLBACK" && result instanceof Promise) {
                  const observed = result.then(
                    () => {
                      rollback = true;
                    },
                    (error: unknown) => {
                      observerErrors.push(error);
                    },
                  );
                  pending.push(observed);
                }
                return result;
              }
              reached = true;
              selectedClient = client;
              const operation =
                mode === "fault"
                  ? Promise.reject(fault)
                  : gate.then(() => Reflect.apply(target, receiver, args) as unknown);
              pending.push(
                operation.then(
                  () => undefined,
                  () => undefined,
                ),
              );
              return operation;
            },
          });
          /* eslint-enable @typescript-eslint/unbound-method */
        } catch (error) {
          observerErrors.push(error);
          try {
            pending.push(
              client.end().then(
                () => {
                  active.delete(client);
                },
                (endError: unknown) => {
                  observerErrors.push(endError);
                },
              ),
            );
          } catch (endError) {
            observerErrors.push(endError);
          }
        }
      };
      try {
        await new Promise<void>((resolveListen) => localServer.listen(0, "127.0.0.1", resolveListen));
        const address = localServer.address();
        if (!address || typeof address === "string") throw new Error("Missing local listener");
        peer = new WebSocket(`ws://127.0.0.1:${address.port}/api/voice`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const received: unknown[] = [];
        peer.on("message", (data, binary) => {
          if (binary) audioCount++;
          else received.push(JSON.parse(messageText(data)) as unknown);
        });
        await once(peer, "open");
        peer.on("error", (error) => {
          socketError ??= { error };
        });
        peer.send(JSON.stringify({ type: "start", language: "en" }));
        await vi.waitFor(() => expect(received).toContainEqual({ type: "ready" }));
        const sttBefore = ownedGateway.messages.filter((entry) => entry.type === "sttReady").length;
        const audioBefore = ownedGateway.messages.filter((entry) => entry.type === "audioAccepted").length;
        peer.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]));
        await vi.waitFor(() => {
          expect(ownedGateway.messages.filter((entry) => entry.type === "sttReady")).toHaveLength(sttBefore + 1);
          expect(ownedGateway.messages.filter((entry) => entry.type === "audioAccepted")).toHaveLength(audioBefore + 1);
        });
        held = true;
        send(ownedGateway, "holdModel");
        const before = await runInTenant(tenant, () =>
          pool.query<{ id: string }>("SELECT id FROM semp_threads ORDER BY id"),
        );
        const modelBefore = ownedGateway.messages.filter((entry) => entry.type === "modelCall").length;
        send(ownedGateway, "final");
        selectedThread = await vi.waitFor(async () => {
          const result = await runInTenant(tenant, () =>
            pool.query<{ id: string }>("SELECT id FROM semp_threads ORDER BY id"),
          );
          const added = result.rows.filter((row) => !before.rows.some((old) => old.id === row.id));
          expect(added).toHaveLength(1);
          return added[0]!.id;
        });
        await vi.waitFor(() =>
          expect(ownedGateway.messages.filter((entry) => entry.type === "modelCall")).toHaveLength(modelBefore + 1),
        );
        const firstAssistant = await runInTenant(tenant, () =>
          pool.query<{ id: string }>(
            "SELECT id FROM semp_messages WHERE thread_id=$1 AND role='assistant' ORDER BY created_at, id",
            [selectedThread],
          ),
        );
        expect(firstAssistant.rows).toHaveLength(1);
        const firstKey = `sempMessage:${firstAssistant.rows[0]!.id}`;
        const firstJob = await runInTenant(tenant, () =>
          pool.query<{ id: string; key: string | null; queue_name: string | null; task_identifier: string }>(
            "SELECT id::text, key, queue_name, task_identifier FROM graphile_worker.jobs WHERE key=$1",
            [firstKey],
          ),
        );
        expect(firstJob.rows).toHaveLength(1);
        const job = firstJob.rows[0]!;
        expect(job).toMatchObject({ key: firstKey, task_identifier: "sempMessage" });
        expect(job.queue_name).toEqual(expect.any(String));
        if (job.queue_name === null) throw new Error("Missing Semp job queue");
        const snapshotJobs = () =>
          runInTenant(tenant, () =>
            pool.query<{ id: string; key: string | null }>(
              "SELECT id::text, key FROM graphile_worker.jobs WHERE queue_name=$1 AND task_identifier=$2 ORDER BY id",
              [job.queue_name, job.task_identifier],
            ),
          );
        const beforeJobs = await snapshotJobs();
        expect(beforeJobs.rows).toContainEqual({ id: job.id, key: firstKey });
        pool.on("release", onRelease);
        pool.on("acquire", onAcquire);
        send(ownedGateway, "finalSecond");
        await vi.waitFor(() => expect(reached).toBe(true));
        if (mode === "server-close") {
          send(ownedGateway, "finalSecond");
          await vi.waitFor(() =>
            expect(
              received.filter(
                (entry) =>
                  typeof entry === "object" &&
                  entry !== null &&
                  "type" in entry &&
                  entry.type === "transcript" &&
                  "final" in entry &&
                  entry.final === true,
              ),
            ).toHaveLength(3),
          );
          closeWork = channel.close().then(
            () => ({ status: "fulfilled" as const, value: undefined }),
            (reason: unknown) => ({ status: "rejected" as const, reason }),
          );
          frameCountAtClose = received.length;
          audioCountAtClose = audioCount;
          releaseGate();
        } else {
          await vi.waitFor(() => expect(rollback).toBe(true));
          await vi.waitFor(() => expect(received).toContainEqual({ type: "error", code: "unavailable" }));
        }
        await Promise.all(pending);
        if (mode === "server-close") {
          if (!closeWork) throw new Error("Missing server close outcome");
          const close = await closeWork;
          expect(close.status).toBe("fulfilled");
          expect(closeCalls).toBe(1);
          expect(closeObservations).toHaveLength(1);
          expect(closeObservations[0]?.settled).toBe(true);
          expect(closeObservations[0]?.outcome?.status).toBe("fulfilled");
          expect(closeObservations[0]?.identity.tenantId).toBe(tenant);
          expect(received).toHaveLength(frameCountAtClose);
          expect(audioCount).toBe(audioCountAtClose);
        }
        if (mode === "fault") {
          const afterJobs = await snapshotJobs();
          expect(afterJobs.rows).toEqual(beforeJobs.rows);
          await vi.waitFor(() => expect(closeObservations[0]?.settled).toBe(true));
          expect(closeCalls).toBe(1);
          const observed = closeObservations[0];
          if (!observed || observed.outcome?.status !== "fulfilled" || !observed.outcome.value)
            throw new Error("Expected fulfilled handler operation outcome");
          expect(observed.identity.tenantId).toBe(tenant);
          expect(observed.outcome.value.operationFailures).toHaveLength(1);
          expect(observed.outcome.value.operationFailures[0]).toBe(fault);
          replacement = new WebSocket(`ws://127.0.0.1:${address.port}/api/voice`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          const replacementFrames: unknown[] = [];
          replacement.on("error", (error) => {
            socketError ??= { error };
          });
          replacement.on("message", (data, binary) => {
            if (!binary) replacementFrames.push(JSON.parse(messageText(data)) as unknown);
          });
          await once(replacement, "open");
          replacement.send(JSON.stringify({ type: "start", language: "en" }));
          await vi.waitFor(() => expect(replacementFrames).toContainEqual({ type: "ready" }));
          const replacementClosed = once(replacement, "close");
          replacement.close();
          await replacementClosed;
          await vi.waitFor(() => expect(closeCalls).toBe(2));
          await vi.waitFor(() => expect(unsettledCloseCalls).toBe(0));
          expect(closeObservations[1]?.identity.userId).toBe(observed.identity.userId);
          expect(closeObservations[1]?.identity.tenantId).toBe(observed.identity.tenantId);
          expect(closeObservations[1]?.outcome?.status).toBe("fulfilled");
          closeWork = channel.close().then(
            () => ({ status: "fulfilled" as const, value: undefined }),
            (reason: unknown) => ({ status: "rejected" as const, reason }),
          );
          expect((await closeWork).status).toBe("fulfilled");
        }
        const rows = await runInTenant(tenant, () =>
          pool.query<{ users: string; assistants: string }>(
            "SELECT count(*) FILTER (WHERE role='user')::text AS users, count(*) FILTER (WHERE role='assistant')::text AS assistants FROM semp_messages WHERE thread_id=$1",
            [selectedThread],
          ),
        );
        expect(rows.rows).toEqual([{ users: mode === "fault" ? "1" : "2", assistants: mode === "fault" ? "1" : "2" }]);
      } catch (error) {
        failed = { error };
      } finally {
        releaseGate();
        try {
          if (held) send(ownedGateway, "releaseModel");
        } catch (error) {
          cleanup.push(error);
        }
        try {
          if (closeWork) {
            const result = await closeWork;
            if (result.status === "rejected") cleanup.push(result.reason);
          } else await channel.close();
        } catch (error) {
          cleanup.push(error);
        }
        try {
          restoreClose();
        } catch (error) {
          cleanup.push(error);
        }
        try {
          await Promise.all(pending);
        } catch (error) {
          cleanup.push(error);
        }
        pool.off("acquire", onAcquire);
        try {
          await vi.waitFor(() => expect(active.size).toBe(0), { timeout: 5000 });
        } catch (error) {
          cleanup.push(error);
        }
        if (!active.size) pool.off("release", onRelease);
        cleanup.push(...observerErrors);
        try {
          if (replacement && replacement.readyState !== WebSocket.CLOSED) {
            const closed = once(replacement, "close");
            replacement.terminate();
            await closed;
          }
        } catch (error) {
          cleanup.push(error);
        }
        try {
          if (peer && peer.readyState !== WebSocket.CLOSED) {
            const closed = once(peer, "close");
            peer.terminate();
            await closed;
          }
        } catch (error) {
          cleanup.push(error);
        }
        try {
          if (localServer.listening)
            await new Promise<void>((resolveClose, reject) =>
              localServer.close((error) => (error ? reject(error) : resolveClose())),
            );
        } catch (error) {
          cleanup.push(error);
        }
      }
      if (socketError) cleanup.push(socketError.error);
      if (cleanup.length)
        throw new AggregateError(
          failed ? [failed.error, ...cleanup] : cleanup,
          "Voice admission boundary cleanup failed",
          { cause: failed ? failed.error : cleanup[0] },
        );
      if (failed) throw failed.error;
    },
    70_000,
  );

  it("stores a trusted voice turn and streams a real worker answer before native provider completion", async () => {
    if (!gateway || !worker) throw new Error("Missing fixture child");
    let watchSocket: WebSocket | undefined;
    let watchServer: Server | undefined;
    let primary: { error: unknown } | undefined;
    let speechHeld = false;
    let modelHeld = false;
    let firstTextHeld = false;
    const ownedGateway = gateway;
    const descriptor = Object.getOwnPropertyDescriptor(sync, "subscribeVoice");
    if (!descriptor || typeof descriptor.value !== "function") throw new Error("Missing voice subscription descriptor");
    const originalSubscribe = descriptor.value as typeof sync.subscribeVoice;
    type Subscription = Parameters<typeof originalSubscribe>[0];
    type ObservedSubscription = Pick<
      Subscription,
      "tenantId" | "threadId" | "sempMessageId" | "runId" | "userId" | "signal"
    > & {
      state: "pending" | "fulfilled" | "rejected";
      error?: unknown;
    };
    let subscription: ObservedSubscription | undefined;
    let additionalSubscription = false;
    const recorded: ObservedSubscription[] = [];
    const observers: Promise<void>[] = [];
    let installed = false;
    let releaseRequest = 0;
    async function control(
      type: "holdSpeech" | "holdModel" | "releaseSpeech" | "releaseModel" | "holdFirstText" | "releaseFirstText",
    ): Promise<void> {
      if (!ownedGateway.child.connected) throw new Error("Fixture gateway disconnected");
      const request = type === "releaseFirstText" ? ++releaseRequest : undefined;
      await new Promise<void>((resolveSend, reject) => {
        const timer = setTimeout(() => reject(new Error("Fixture control acknowledgement timed out")), 5000);
        try {
          ownedGateway.child.send(request === undefined ? { type } : { type, request }, (error) => {
            clearTimeout(timer);
            if (error) reject(error);
            else resolveSend();
          });
        } catch (error) {
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error("Fixture control failed", { cause: error }));
        }
      });
      if (request !== undefined)
        await vi.waitFor(() =>
          expect(
            ownedGateway.messages.some(
              (entry) =>
                (entry.type === "firstTextReleased" || entry.type === "firstTextDisarmed") && entry.request === request,
            ),
          ).toBe(true),
        );
    }
    try {
      Object.defineProperty(sync, "subscribeVoice", {
        ...descriptor,
        value: function (this: typeof sync, input: Subscription) {
          const result = originalSubscribe.call(this, input);
          const observed: ObservedSubscription = {
            tenantId: input.tenantId,
            threadId: input.threadId,
            sempMessageId: input.sempMessageId,
            runId: input.runId,
            userId: input.userId,
            signal: input.signal,
            state: "pending",
          };
          if (subscription) additionalSubscription = true;
          else subscription = observed;
          recorded.push(observed);
          observers.push(
            result.then(
              () => {
                observed.state = "fulfilled";
              },
              (error: unknown) => {
                observed.state = "rejected";
                observed.error = error;
              },
            ),
          );
          return result;
        },
      });
      installed = true;
      const cp = createChokePoint(pool);
      const database = await runInTenant(tenant, () => cp.createDatabase({ name: "Voice approval fixture" }));
      const target = await runInTenant(tenant, () => cp.createItem({ databaseId: database.id, properties: {} }));
      if (!ownedGateway.child.connected) throw new Error("Fixture gateway disconnected");
      await new Promise<void>((resolveSend, reject) =>
        ownedGateway.child.send({ type: "approvalTarget", itemId: target.id }, (error) =>
          error ? reject(error) : resolveSend(),
        ),
      );
      await vi.waitFor(() => expect(gateway?.messages.some((entry) => entry.type === "approvalReady")).toBe(true));
      socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      socket.on("message", (data, binary) => {
        if (binary) {
          audioFrames++;
          return;
        }
        const value: unknown = JSON.parse(messageText(data));
        frames.push(value);
      });
      await once(socket, "open");
      socket.send(JSON.stringify({ type: "start", language: "en" }));
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "ready" }), { timeout: 10_000 });
      const sttBefore = ownedGateway.messages.filter((entry) => entry.type === "sttReady").length;
      const audioBefore = ownedGateway.messages.filter((entry) => entry.type === "audioAccepted").length;
      socket.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]));
      await vi.waitFor(
        () => {
          expect(ownedGateway.messages.filter((entry) => entry.type === "sttReady")).toHaveLength(sttBefore + 1);
          expect(ownedGateway.messages.filter((entry) => entry.type === "audioAccepted")).toHaveLength(audioBefore + 1);
        },
        { timeout: 10_000 },
      );
      speechHeld = true;
      await control("holdSpeech");
      modelHeld = true;
      await control("holdModel");
      const armedBefore = ownedGateway.messages.filter((entry) => entry.type === "firstTextArmed").length;
      const heldBefore = ownedGateway.messages.filter((entry) => entry.type === "firstTextHeld").length;
      const releasedBefore = ownedGateway.messages.filter((entry) => entry.type === "firstTextReleased").length;
      firstTextHeld = true;
      await control("holdFirstText");
      await vi.waitFor(() =>
        expect(ownedGateway.messages.filter((entry) => entry.type === "firstTextArmed")).toHaveLength(armedBefore + 1),
      );
      send(gateway, "partial");
      await vi.waitFor(() =>
        expect(frames).toContainEqual({ type: "transcript", text: "A spoken question.", final: false }),
      );
      send(gateway, "final");
      await vi.waitFor(() =>
        expect(frames).toContainEqual({ type: "transcript", text: "A spoken question.", final: true }),
      );
      const source = await vi.waitFor(async () => {
        const result = await runInTenant(tenant, () =>
          pool.query<{ thread_id: string; id: string; source: string | null }>(
            "SELECT thread_id, id, source FROM semp_messages WHERE role='user' ORDER BY created_at DESC LIMIT 1",
          ),
        );
        expect(result.rows[0]?.source).toBe("voice");
        return result.rows[0]!;
      });
      const targetTurn = await vi.waitFor(
        async () => {
          const rows = await runInTenant(tenant, () =>
            pool.query<{ id: string; run_id: string; actor_user_id: string }>(
              `SELECT m.id, m.agent_run_id AS run_id, r.actor_user_id
             FROM semp_messages m JOIN agent_runs r ON r.id=m.agent_run_id AND r.tenant_id=m.tenant_id
             WHERE m.thread_id=$1 AND m.role='assistant' AND m.reply_to_message_id=$2 AND m.status='running'`,
              [source.thread_id, source.id],
            ),
          );
          expect(rows.rows).toHaveLength(1);
          expect(additionalSubscription).toBe(false);
          expect(subscription?.state).toBe("fulfilled");
          expect(subscription?.tenantId).toBe(tenant);
          expect(subscription?.threadId).toBe(source.thread_id);
          expect(subscription?.sempMessageId).toBe(rows.rows[0]?.id);
          expect(subscription?.runId).toBe(rows.rows[0]?.run_id);
          expect(subscription?.userId).toBe(rows.rows[0]?.actor_user_id);
          expect(subscription?.signal?.aborted).toBe(false);
          expect(socket?.readyState).toBe(WebSocket.OPEN);
          const held = ownedGateway.messages.filter((entry) => entry.type === "firstTextHeld");
          expect(held).toHaveLength(heldBefore + 1);
          return held.at(-1)!;
        },
        { timeout: 20_000 },
      );
      await Promise.all(observers);
      expect(additionalSubscription).toBe(false);
      Object.defineProperty(sync, "subscribeVoice", descriptor);
      installed = false;
      await control("releaseFirstText");
      await vi.waitFor(() => {
        const released = ownedGateway.messages.filter((entry) => entry.type === "firstTextReleased");
        expect(released).toHaveLength(releasedBefore + 1);
        expect(released.at(-1)).toEqual({
          type: "firstTextReleased",
          sequence: targetTurn.sequence,
          request: releaseRequest,
        });
      });
      firstTextHeld = false;
      let assistantId = "";
      let assistantRun = "";
      try {
        await vi.waitFor(
          async () => {
            const result = await runInTenant(tenant, () =>
              pool.query<{ id: string; status: string; agent_run_id: string | null; source: string | null }>(
                "SELECT id, status, agent_run_id, source FROM semp_messages WHERE thread_id=$1 AND role='assistant' AND reply_to_message_id=$2",
                [source.thread_id, source.id],
              ),
            );
            const row = result.rows[0];
            expect(row?.source).toBeNull();
            expect(row?.status).toBe("running");
            expect(row?.agent_run_id).toBeTruthy();
            assistantId = row?.id ?? "";
            assistantRun = row?.agent_run_id ?? "";
            expect(audioFrames).toBeGreaterThan(0);
          },
          { timeout: 20_000 },
        );
      } catch (error) {
        try {
          const state = await runInTenant(tenant, () =>
            pool.query<{ status: string; has_run: boolean; source: string | null }>(
              "SELECT status, agent_run_id IS NOT NULL AS has_run, source FROM semp_messages WHERE thread_id=$1 AND role='assistant' AND reply_to_message_id=$2",
              [source.thread_id, source.id],
            ),
          );
          const calls = await runInTenant(tenant, () =>
            pool.query<{ operation: string; status: string }>(
              "SELECT operation, status FROM ai_gateway_calls WHERE semp_message_id=(SELECT id FROM semp_messages WHERE thread_id=$1 AND role='assistant' AND reply_to_message_id=$2) ORDER BY at",
              [source.thread_id, source.id],
            ),
          );
          process.stderr.write(
            `voice target observation ${JSON.stringify({ state: state.rows, calls: calls.rows, providerModelCalls: gateway.messages.filter((entry) => entry.type === "modelCall").length, audioFrames })}\n`,
          );
        } catch (diagnosticError) {
          throw new AggregateError([error, diagnosticError], "Voice target observation failed", {
            // The original assertion remains primary; the diagnostic failure is retained separately.
            // eslint-disable-next-line preserve-caught-error
            cause: error,
          });
        }
        throw error;
      }
      expect(assistantId).not.toBe("");
      expect(assistantRun).not.toBe("");
      expect(frames).toContainEqual({ type: "speaking", state: "started" });
      const watchedFrames: unknown[] = [];
      let watchInvalid = false;
      watchServer = createServer();
      watchServer.on("upgrade", (req, stream, head) => sync.handleUpgrade(req, stream, head));
      await new Promise<void>((resolveListen) => watchServer!.listen(0, "127.0.0.1", resolveListen));
      const watchAddress = watchServer.address();
      if (!watchAddress || typeof watchAddress === "string") throw new Error("Missing sync listener");
      watchSocket = new WebSocket(`ws://127.0.0.1:${watchAddress.port}/api/sync`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      watchSocket.on("error", () => {
        watchInvalid = true;
      });
      watchSocket.on("message", (data, binary) => {
        if (!binary) {
          try {
            const text = messageText(data);
            if (Buffer.byteLength(text) > 256 * 1024 || watchedFrames.length >= 1024) {
              watchInvalid = true;
              return;
            }
            const value: unknown = JSON.parse(text);
            watchedFrames.push(value);
          } catch {
            watchInvalid = true;
          }
        }
      });
      await once(watchSocket, "open");
      watchSocket.send(JSON.stringify({ type: "agent:watch", runId: assistantRun, afterEventId: "0" }));
      await vi.waitFor(() =>
        expect(
          watchedFrames.some(
            (frame) => typeof frame === "object" && frame !== null && "type" in frame && frame.type === "agent:event",
          ),
        ).toBe(true),
      );
      send(gateway, "partial");
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "speaking", state: "stopped" }));
      const audioAfterBargeIn = audioFrames;
      send(gateway, "finalSecond");
      await vi.waitFor(() =>
        expect(frames).toContainEqual({ type: "transcript", text: "A second question.", final: true }),
      );
      const second = await vi.waitFor(async () => {
        const result = await runInTenant(tenant, () =>
          pool.query<{ user_id: string; source: string | null; assistant_id: string; status: string }>(
            `SELECT u.id AS user_id, u.source, a.id AS assistant_id, a.status
         FROM semp_messages u JOIN semp_messages a ON a.tenant_id = u.tenant_id AND a.reply_to_message_id = u.id
         WHERE u.thread_id = $1 AND u.role = 'user' AND u.text = $2 AND a.role = 'assistant'`,
            [source.thread_id, "A second question."],
          ),
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({ source: "voice", status: "queued" });
        return result.rows[0]!;
      });
      expect(audioFrames).toBe(audioAfterBargeIn);
      const firstStillRunning = await runInTenant(tenant, () =>
        pool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id=$1", [assistantId]),
      );
      expect(firstStillRunning.rows).toEqual([{ status: "running" }]);
      await control("releaseSpeech");
      speechHeld = false;
      await control("releaseModel");
      modelHeld = false;
      await vi.waitFor(
        async () => {
          const result = await runInTenant(tenant, () =>
            pool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id=$1", [assistantId]),
          );
          expect(result.rows[0]?.status).toBe("done");
        },
        { timeout: 20_000 },
      );
      const approval = await vi.waitFor(async () => {
        const result = await runInTenant(tenant, () =>
          pool.query<{ id: string; status: string; agent_run_id: string; tool_call_id: string }>(
            "SELECT id, status, agent_run_id, tool_call_id FROM approval_requests WHERE agent_run_id=$1 AND tool_call_id=$2",
            [assistantRun, "voice-approval-call"],
          ),
        );
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]).toMatchObject({
          status: "pending",
          agent_run_id: assistantRun,
          tool_call_id: "voice-approval-call",
        });
        return result.rows[0]!;
      });
      await vi.waitFor(() => {
        expect(watchInvalid).toBe(false);
        expect(
          watchedFrames.some(
            (frame) =>
              typeof frame === "object" &&
              frame !== null &&
              "type" in frame &&
              frame.type === "notification" &&
              "notification" in frame &&
              typeof frame.notification === "object" &&
              frame.notification !== null &&
              "sourceId" in frame.notification &&
              frame.notification.sourceId === approval.id,
          ),
        ).toBe(true);
        expect(
          watchedFrames.some(
            (frame) =>
              typeof frame === "object" &&
              frame !== null &&
              "type" in frame &&
              frame.type === "agent:event" &&
              "event" in frame &&
              typeof frame.event === "object" &&
              frame.event !== null &&
              "payload" in frame.event &&
              typeof frame.event.payload === "object" &&
              frame.event.payload !== null &&
              "toolCallId" in frame.event.payload &&
              frame.event.payload.toolCallId === "voice-approval-call",
          ),
        ).toBe(true);
      });
      const apiAddress = server.address();
      if (!apiAddress || typeof apiAddress === "string") throw new Error("Missing API listener");
      const history = await fetch(`http://127.0.0.1:${apiAddress.port}/api/semp/threads/${source.thread_id}/messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(history.status).toBe(200);
      const historyBody: unknown = await history.json();
      expect(historyBody).toMatchObject({
        rows: expect.arrayContaining([expect.objectContaining({ id: assistantId, agentRunId: assistantRun })]),
      });
      const targetState = await runInTenant(tenant, () =>
        pool.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM items WHERE id=$1", [target.id]),
      );
      expect(targetState.rows).toEqual([{ deleted_at: null }]);
      await vi.waitFor(
        async () => {
          const result = await runInTenant(tenant, () =>
            pool.query<{ status: string; agent_run_id: string | null }>(
              "SELECT status, agent_run_id FROM semp_messages WHERE id=$1",
              [second.assistant_id],
            ),
          );
          expect(result.rows).toEqual([{ status: "done", agent_run_id: assistantRun }]);
        },
        { timeout: 20_000 },
      );
      const modelCalls = await runInTenant(tenant, () =>
        pool.query<{ semp_message_id: string; status: string }>(
          "SELECT semp_message_id, status FROM ai_gateway_calls WHERE agent_run_id=$1 AND operation='agent_turn' ORDER BY at, id",
          [assistantRun],
        ),
      );
      expect(modelCalls.rows).toEqual([
        { semp_message_id: assistantId, status: "settled" },
        { semp_message_id: assistantId, status: "settled" },
        { semp_message_id: second.assistant_id, status: "settled" },
      ]);
      const closed = once(socket, "close");
      socket.close();
      await closed;
      await vi.waitFor(
        async () => {
          const calls = await runInTenant(tenant, () =>
            pool.query<{ count: string }>(
              "SELECT count(*)::text AS count FROM ai_gateway_calls WHERE status='reserved'",
            ),
          );
          expect(calls.rows[0]?.count).toBe("0");
        },
        { timeout: 10_000 },
      );
    } catch (error) {
      primary = { error };
    }
    const cleanup: unknown[] = [];
    for (const [held, type] of [
      [firstTextHeld, "releaseFirstText"],
      [speechHeld, "releaseSpeech"],
      [modelHeld, "releaseModel"],
    ] as const) {
      if (!held) continue;
      try {
        await control(type);
      } catch (error) {
        cleanup.push(error);
      }
    }
    if (installed && primary && socket && socket.readyState !== WebSocket.CLOSED) {
      try {
        const closed = once(socket, "close");
        socket.terminate();
        await closed;
      } catch (error) {
        cleanup.push(error);
      }
    }
    try {
      await Promise.all(observers);
      for (const observed of recorded) if (observed.state === "rejected") cleanup.push(observed.error);
    } catch (error) {
      cleanup.push(error);
    }
    if (installed) {
      try {
        Object.defineProperty(sync, "subscribeVoice", descriptor);
      } catch (error) {
        cleanup.push(error);
      }
    }
    try {
      if (watchSocket && watchSocket.readyState !== WebSocket.CLOSED) {
        const closed = once(watchSocket, "close");
        watchSocket.terminate();
        await closed;
      }
    } catch (error) {
      cleanup.push(error);
    }
    try {
      const ownedWatchServer = watchServer;
      if (ownedWatchServer?.listening)
        await new Promise<void>((resolveClose, reject) =>
          ownedWatchServer.close((error) => (error ? reject(error) : resolveClose())),
        );
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length)
      throw new AggregateError(primary ? [primary.error, ...cleanup] : cleanup, "Voice model watch cleanup failed", {
        cause: primary ? primary.error : cleanup[0],
      });
    if (primary) throw primary.error;
  }, 70_000);

  it("settles the exact real STT reservation after socket close", async () => {
    if (!gateway) throw new Error("Missing fixture gateway");
    const priorAudio = gateway.messages.filter((entry) => entry.type === "audioAccepted").length;
    const priorStt = gateway.messages.filter((entry) => entry.type === "sttReady").length;
    const priorCalls = await runInTenant(tenant, () =>
      pool.query<{ id: string }>("SELECT id::text FROM ai_gateway_calls WHERE operation='voice_transcribe_stream'"),
    );
    const priorIds = new Set(priorCalls.rows.map((row) => row.id));
    socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    socket.on("message", (data, binary) => {
      if (!binary) frames.push(JSON.parse(messageText(data)) as unknown);
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "start", language: "en" }));
    await vi.waitFor(() => expect(frames).toContainEqual({ type: "ready" }));
    socket.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]));
    await vi.waitFor(() =>
      expect(gateway?.messages.filter((entry) => entry.type === "audioAccepted").length).toBe(priorAudio + 1),
    );
    await vi.waitFor(() =>
      expect(gateway?.messages.filter((entry) => entry.type === "sttReady")).toHaveLength(priorStt + 1),
    );
    const id = await vi.waitFor(async () => {
      const result = await runInTenant(tenant, () =>
        pool.query<{ id: string; status: string }>(
          "SELECT id::text, status FROM ai_gateway_calls WHERE operation='voice_transcribe_stream'",
        ),
      );
      const added = result.rows.filter((row) => !priorIds.has(row.id));
      expect(added).toHaveLength(1);
      expect(added[0]?.status).toBe("reserved");
      return added[0]!.id;
    });
    const closed = once(socket, "close");
    socket.close();
    await closed;
    await vi.waitFor(
      async () => {
        const result = await runInTenant(tenant, () =>
          pool.query<{ status: string; audio_seconds: string | null }>(
            "SELECT status, audio_seconds::text FROM ai_gateway_calls WHERE id=$1",
            [id],
          ),
        );
        expect(result.rows[0]?.status).toBe("settled");
        expect(Number(result.rows[0]?.audio_seconds)).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
  }, 30_000);

  it("maps an actual STT budget refusal without opening the provider or creating a turn", async () => {
    if (!gateway) throw new Error("Missing fixture gateway");
    const priorProvider = gateway.messages.filter((entry) => entry.type === "sttReady").length;
    const before = await runInTenant(tenant, async () => ({
      messages: await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM semp_messages"),
      calls: await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM ai_gateway_calls"),
    }));
    const priorBudget = await admin.query<{ daily: number | null; monthly: number | null; exact: boolean }>(
      `SELECT daily_cap_usd::float8 AS daily, monthly_cap_usd::float8 AS monthly,
        (daily_cap_usd IS NULL OR daily_cap_usd=(daily_cap_usd::float8)::numeric)
        AND (monthly_cap_usd IS NULL OR monthly_cap_usd=(monthly_cap_usd::float8)::numeric) AS exact
       FROM tenant_ai_budgets WHERE tenant_id=$1`,
      [tenant],
    );
    expect(priorBudget.rows).toHaveLength(1);
    expect(priorBudget.rows[0]?.exact).toBe(true);
    const prior = priorBudget.rows[0]!;
    const combineFailures = (original: unknown, cleanup: unknown) =>
      new AggregateError([original, cleanup], "Budget test and restoration failed", { cause: original });
    let primary: { error: unknown } | undefined;
    try {
      await setTenantAiBudget(admin, tenant, { dailyCapUsd: 0, monthlyCapUsd: 0 });
      socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      socket.on("message", (data, binary) => {
        if (!binary) frames.push(JSON.parse(messageText(data)) as unknown);
      });
      await once(socket, "open");
      socket.send(JSON.stringify({ type: "start", language: "en" }));
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "ready" }));
      const closed = once(socket, "close");
      socket.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]));
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "error", code: "budgetExceeded" }));
      expect((await closed)[0]).toBe(1008);
      expect(gateway.messages.filter((entry) => entry.type === "sttReady")).toHaveLength(priorProvider);
      const state = await runInTenant(tenant, async () => ({
        messages: await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM semp_messages"),
        calls: await pool.query<{ count: string }>("SELECT count(*)::text AS count FROM ai_gateway_calls"),
      }));
      expect(state.messages.rows).toEqual(before.messages.rows);
      expect(state.calls.rows).toEqual(before.calls.rows);
    } catch (error) {
      primary = { error };
    }
    try {
      await setTenantAiBudget(admin, tenant, { dailyCapUsd: prior.daily, monthlyCapUsd: prior.monthly });
    } catch (error) {
      if (primary) throw combineFailures(primary.error, error);
      throw error;
    }
    if (primary) throw primary.error;
  }, 30_000);

  it("classifies real gateway TTS saturation without an extra provider call or reservation", async () => {
    if (!gateway) throw new Error("Missing fixture gateway");
    const ready = gateway.messages.find((entry) => entry.type === "ready");
    if (!ready || ready.type !== "ready" || !ready.port) throw new Error("Missing gateway port");
    const gatewayPort = ready.port;
    const priorCalls = gateway.messages.filter((entry) => entry.type === "speechCall").length;
    const previous = await runInTenant(tenant, () =>
      pool.query<{ id: string }>("SELECT id::text FROM ai_gateway_calls WHERE operation='voice_synthesize'"),
    );
    const controllers: AbortController[] = [];
    const streams: AsyncIterable<Uint8Array>[] = [];
    let drained = false;
    let failed = false;
    let failure: unknown;
    const cleanup: unknown[] = [];
    send(gateway, "holdSpeech");
    try {
      for (let i = 0; i < 4; i++) {
        const controller = new AbortController();
        controllers.push(controller);
        streams.push(
          await runInTenant(tenant, () =>
            synthesizeSpeech(
              { port: gatewayPort, token: "batch32-test-token" },
              { text: `Fixture ${i}.`, voice: "alloy", signal: controller.signal },
            ),
          ),
        );
      }
      await vi.waitFor(() =>
        expect(gateway?.messages.filter((entry) => entry.type === "speechCall").length).toBe(priorCalls + 4),
      );
      const held = await runInTenant(tenant, () =>
        pool.query<{ id: string; status: string }>(
          "SELECT id::text, status FROM ai_gateway_calls WHERE operation='voice_synthesize' ORDER BY id",
        ),
      );
      const ids = held.rows.filter((row) => !previous.rows.some((old) => old.id === row.id)).map((row) => row.id);
      expect(ids).toHaveLength(4);
      expect(held.rows.filter((row) => ids.includes(row.id)).every((row) => row.status === "reserved")).toBe(true);
      const error = await runInTenant(tenant, () =>
        synthesizeSpeech({ port: gatewayPort, token: "batch32-test-token" }, { text: "Overflow.", voice: "alloy" }),
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(SpeechSynthesisCapacityError);
      expect(gateway.messages.filter((entry) => entry.type === "speechCall")).toHaveLength(priorCalls + 4);
      const after = await runInTenant(tenant, () =>
        pool.query<{ id: string }>(
          "SELECT id::text FROM ai_gateway_calls WHERE operation='voice_synthesize' ORDER BY id",
        ),
      );
      expect(after.rows).toHaveLength(previous.rows.length + 4);
      send(gateway, "releaseSpeech");
      let bytes = 0;
      for (const stream of streams) for await (const chunk of stream) bytes += chunk.length;
      drained = true;
      expect(bytes).toBeGreaterThan(0);
      await vi.waitFor(async () => {
        const result = await runInTenant(tenant, () =>
          pool.query<{ status: string }>("SELECT status FROM ai_gateway_calls WHERE id=ANY($1::bigint[])", [ids]),
        );
        expect(result.rows).toHaveLength(4);
        expect(result.rows.every((row) => row.status === "settled")).toBe(true);
      });
    } catch (error) {
      failed = true;
      failure = error;
    } finally {
      try {
        if (gateway.child.connected) send(gateway, "releaseSpeech");
      } catch (error) {
        cleanup.push(error);
      }
      for (const controller of controllers) controller.abort();
      if (!drained) {
        const results = await Promise.allSettled(
          streams.map(async (stream) => {
            for await (const chunk of stream) void chunk;
          }),
        );
        for (const result of results) if (result.status === "rejected") cleanup.push(result.reason);
      }
    }
    if (failed && cleanup.length)
      throw new AggregateError([failure, ...cleanup], "TTS capacity test and cleanup failed", { cause: failure });
    if (failed) throw failure instanceof Error ? failure : new Error("TTS capacity test failed", { cause: failure });
    if (cleanup.length) throw new AggregateError(cleanup, "TTS capacity cleanup failed", { cause: cleanup[0] });
  }, 30_000);

  it("keeps HTTP source untrusted and enforces the additive stored source constraint", async () => {
    const response = await fetch(url.replace("ws://", "http://").replace("/api/voice", "/api/semp/threads"), {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ text: "ordinary message", source: "voice" }),
    });
    expect(response.status).toBe(202);
    const turn = z
      .object({ threadId: z.string().uuid(), messageId: z.string().uuid(), assistantMessageId: z.string().uuid() })
      .parse(await response.json());
    const rows = await runInTenant(tenant, () =>
      pool.query<{ id: string; source: string | null }>(
        "SELECT id, source FROM semp_messages WHERE id=ANY($1::uuid[]) ORDER BY id",
        [[turn.messageId, turn.assistantMessageId]],
      ),
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.source === null)).toBe(true);
    // Synthetic omitted-column insert exercises the additive schema, not an old deployed binary.
    const legacy = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        client.query<{ source: string | null }>(
          "INSERT INTO semp_messages (thread_id, role, text) VALUES ($1, 'user', 'legacy fixture') RETURNING source",
          [turn.threadId],
        ),
      ),
    );
    expect(legacy.rows).toEqual([{ source: null }]);
    await expect(
      runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          client.query<Record<string, never>>(
            "INSERT INTO semp_messages (thread_id, role, text, source) VALUES ($1, 'user', 'invalid fixture', 'invalid')",
            [turn.threadId],
          ),
        ),
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const foreign = await createTestTenant(admin);
    const invisible = await runInTenant(foreign, () =>
      pool.query<{ id: string }>("SELECT id FROM semp_messages WHERE id=ANY($1::uuid[])", [
        [turn.messageId, turn.assistantMessageId],
      ]),
    );
    expect(invisible.rows).toEqual([]);
  }, 30_000);

  describe("stop commands", () => {
    let cancels: SempTurnCancelRequest[];
    let cancelListener: Awaited<ReturnType<typeof startSempTurnCancelListener>> | undefined;
    let speechHeld: boolean;
    let modelHeld: boolean;
    let releaseRequest = 0;
    let restoreSubscribe: (() => void) | undefined;

    beforeEach(async () => {
      cancels = [];
      speechHeld = false;
      modelHeld = false;
      // Observes the requests the session sends, as the process that runs the turn would receive them.
      cancelListener = await startSempTurnCancelListener(pool, (request) => cancels.push(request));
    });
    afterEach(async () => {
      // A held fixture response would keep a turn open past the case.
      if (gateway?.child.connected) {
        if (speechHeld) send(gateway, "releaseSpeech");
        if (modelHeld) send(gateway, "releaseModel");
      }
      restoreSubscribe?.();
      restoreSubscribe = undefined;
      await cancelListener?.close();
      cancelListener = undefined;
    });

    /** Opens a session whose speech-to-text provider has accepted audio, so a scripted transcript can be delivered. */
    async function openSession(): Promise<void> {
      if (!gateway) throw new Error("Missing fixture gateway");
      const ownedGateway = gateway;
      const sttBefore = ownedGateway.messages.filter((entry) => entry.type === "sttReady").length;
      const audioBefore = ownedGateway.messages.filter((entry) => entry.type === "audioAccepted").length;
      socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      socket.on("message", (data, binary) => {
        if (binary) {
          audioFrames++;
          return;
        }
        frames.push(JSON.parse(messageText(data)) as unknown);
      });
      await once(socket, "open");
      socket.send(JSON.stringify({ type: "start", language: "en" }));
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "ready" }), { timeout: 10_000 });
      socket.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]));
      await vi.waitFor(
        () => {
          expect(ownedGateway.messages.filter((entry) => entry.type === "sttReady")).toHaveLength(sttBefore + 1);
          expect(ownedGateway.messages.filter((entry) => entry.type === "audioAccepted")).toHaveLength(audioBefore + 1);
        },
        { timeout: 10_000 },
      );
    }

    /** Delivers `text` as a final transcript and waits until the session has sent it back to the client. */
    async function say(text: string): Promise<void> {
      if (!gateway) throw new Error("Missing fixture gateway");
      send(gateway, "finalText", { text });
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "transcript", text, final: true }), {
        timeout: 10_000,
      });
    }

    const userMessages = (threadId: string) =>
      runInTenant(tenant, () =>
        pool.query<{ id: string; text: string; source: string | null }>(
          "SELECT id, text, source FROM semp_messages WHERE thread_id = $1 AND role = 'user' ORDER BY created_at, id",
          [threadId],
        ),
      );
    const assistantFor = (userMessageId: string) =>
      runInTenant(tenant, () =>
        pool.query<{ id: string; status: string; error_code: string | null; agent_run_id: string | null }>(
          "SELECT id, status, error_code, agent_run_id FROM semp_messages WHERE reply_to_message_id = $1 AND role = 'assistant'",
          [userMessageId],
        ),
      );

    /**
     * Says the first question while the model and the speech are held, and returns once the turn is running and its
     * first sentence is being spoken. The model's first text is held until the session watches the run: the text
     * deltas are live only, so a delta sent before the watch exists would never be spoken.
     */
    async function startHeldTurn() {
      if (!gateway) throw new Error("Missing fixture gateway");
      const ownedGateway = gateway;
      await openSession();
      const descriptor = Object.getOwnPropertyDescriptor(sync, "subscribeVoice");
      if (!descriptor || typeof descriptor.value !== "function")
        throw new Error("Missing voice subscription descriptor");
      const originalSubscribe = descriptor.value as typeof sync.subscribeVoice;
      let subscription: ReturnType<typeof originalSubscribe> | undefined;
      Object.defineProperty(sync, "subscribeVoice", {
        ...descriptor,
        value: function (this: typeof sync, input: Parameters<typeof originalSubscribe>[0]) {
          subscription = originalSubscribe.call(this, input);
          return subscription;
        },
      });
      restoreSubscribe = () => Object.defineProperty(sync, "subscribeVoice", descriptor);
      send(ownedGateway, "holdSpeech");
      speechHeld = true;
      send(ownedGateway, "holdModel");
      modelHeld = true;
      const armedBefore = ownedGateway.messages.filter((entry) => entry.type === "firstTextArmed").length;
      const heldBefore = ownedGateway.messages.filter((entry) => entry.type === "firstTextHeld").length;
      send(ownedGateway, "holdFirstText");
      await vi.waitFor(() =>
        expect(ownedGateway.messages.filter((entry) => entry.type === "firstTextArmed")).toHaveLength(armedBefore + 1),
      );
      await say("A spoken question.");
      const source = await vi.waitFor(async () => {
        const result = await runInTenant(tenant, () =>
          pool.query<{ id: string; thread_id: string }>(
            "SELECT id, thread_id FROM semp_messages WHERE role = 'user' AND text = 'A spoken question.' ORDER BY created_at DESC, id DESC LIMIT 1",
          ),
        );
        expect(result.rows).toHaveLength(1);
        return result.rows[0]!;
      });
      await vi.waitFor(
        () =>
          expect(ownedGateway.messages.filter((entry) => entry.type === "firstTextHeld")).toHaveLength(heldBefore + 1),
        { timeout: 20_000 },
      );
      const assistant = await vi.waitFor(
        async () => {
          const result = await assistantFor(source.id);
          expect(result.rows[0]).toMatchObject({ status: "running", agent_run_id: expect.any(String) });
          return result.rows[0]!;
        },
        { timeout: 20_000 },
      );
      await vi.waitFor(() => expect(subscription).toBeDefined(), { timeout: 10_000 });
      await subscription;
      const request = ++releaseRequest;
      send(ownedGateway, "releaseFirstText", { request });
      await vi.waitFor(() =>
        expect(
          ownedGateway.messages.some(
            (entry) =>
              (entry.type === "firstTextReleased" || entry.type === "firstTextDisarmed") && entry.request === request,
          ),
        ).toBe(true),
      );
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "speaking", state: "started" }), {
        timeout: 20_000,
      });
      return { source, assistant };
    }

    it.each(["Stop", "zruš."])(
      "cancels the running turn on the command %j, stops speaking and stores no message for it",
      async (command) => {
        if (!gateway) throw new Error("Missing fixture gateway");
        const { source, assistant } = await startHeldTurn();
        const stoppedBefore = frames.filter(
          (frame) => JSON.stringify(frame) === '{"type":"speaking","state":"stopped"}',
        );
        const messagesBefore = await userMessages(source.thread_id);

        await say(command);

        await vi.waitFor(
          async () => {
            expect(await assistantFor(source.id)).toMatchObject({
              rows: [{ id: assistant.id, status: "error", error_code: "cancelled" }],
            });
          },
          { timeout: 20_000 },
        );
        await vi.waitFor(() =>
          expect(
            frames.filter((frame) => JSON.stringify(frame) === '{"type":"speaking","state":"stopped"}'),
          ).toHaveLength(stoppedBefore.length + 1),
        );
        const audioAtStop = audioFrames;
        expect(await userMessages(source.thread_id)).toEqual(messagesBefore);
        const stored = await runInTenant(tenant, () =>
          pool.query("SELECT 1 FROM semp_messages WHERE lower(text) = lower($1)", [command]),
        );
        expect(stored.rowCount).toBe(0);
        expect(cancels).toEqual([{ tenantId: tenant, assistantMessageId: assistant.id }]);
        const run = await runInTenant(tenant, () =>
          pool.query<{ status: string; error_code: string | null }>(
            "SELECT status, error_code FROM agent_runs WHERE id = $1",
            [assistant.agent_run_id],
          ),
        );
        expect(run.rows).toEqual([{ status: "error", error_code: "cancelled" }]);

        // The session survives the command: the next utterance is a new turn that is answered and spoken.
        send(gateway, "releaseModel");
        modelHeld = false;
        send(gateway, "releaseSpeech");
        speechHeld = false;
        send(gateway, "finalSecond");
        const second = await vi.waitFor(
          async () => {
            const result = await runInTenant(tenant, () =>
              pool.query<{ id: string }>(
                "SELECT id FROM semp_messages WHERE thread_id = $1 AND role = 'user' AND text = 'A second question.'",
                [source.thread_id],
              ),
            );
            expect(result.rows).toHaveLength(1);
            return result.rows[0]!;
          },
          { timeout: 10_000 },
        );
        await vi.waitFor(async () => expect((await assistantFor(second.id)).rows[0]?.status).toBe("done"), {
          timeout: 20_000,
        });
        await vi.waitFor(() => expect(audioFrames).toBeGreaterThan(audioAtStop), { timeout: 10_000 });
        expect(
          frames.filter(
            (frame) => typeof frame === "object" && frame !== null && "type" in frame && frame.type === "error",
          ),
        ).toEqual([]);
        expect(socket?.readyState).toBe(WebSocket.OPEN);
        expect(cancels).toHaveLength(1);
      },
      70_000,
    );

    it("stores a sentence that only contains a stop word as a message and cancels nothing", async () => {
      if (!gateway) throw new Error("Missing fixture gateway");
      const { source, assistant } = await startHeldTurn();

      await say("stop the music");

      const stored = await vi.waitFor(async () => {
        const messages = await userMessages(source.thread_id);
        expect(messages.rows.map((row) => row.text)).toEqual(["A spoken question.", "stop the music"]);
        return messages.rows[1]!;
      });
      expect(stored.source).toBe("voice");
      expect((await assistantFor(stored.id)).rows).toMatchObject([{ status: "queued" }]);
      // The running turn is untouched and finishes once the model answers.
      expect((await assistantFor(source.id)).rows).toMatchObject([{ id: assistant.id, status: "running" }]);
      send(gateway, "releaseModel");
      modelHeld = false;
      send(gateway, "releaseSpeech");
      speechHeld = false;
      await vi.waitFor(
        async () => {
          expect((await assistantFor(source.id)).rows[0]?.status).toBe("done");
          expect((await assistantFor(stored.id)).rows[0]?.status).toBe("done");
        },
        { timeout: 30_000 },
      );
      expect(cancels).toEqual([]);
    }, 70_000);

    it("ends the turn quietly when the command lands before the turn has a run, and the session goes on", async () => {
      if (!gateway) throw new Error("Missing fixture gateway");
      const priorQuestions = await runInTenant(tenant, () =>
        pool.query<{ id: string }>("SELECT id FROM semp_messages WHERE role = 'user' AND text = 'A spoken question.'"),
      );
      await openSession();
      // The turn handler reads the system settings between the claim of the reply and the start of its run. With the
      // table locked, the reply stays `running` without a run for as long as the lock is held.
      const lock = await admin.connect();
      let locked = false;
      let assistantId: string;
      let sourceId: string;
      try {
        await lock.query("BEGIN");
        await lock.query("LOCK TABLE databases IN ACCESS EXCLUSIVE MODE");
        locked = true;
        send(gateway, "final");
        const source = await vi.waitFor(async () => {
          const result = await runInTenant(tenant, () =>
            pool.query<{ id: string }>(
              "SELECT id FROM semp_messages WHERE role = 'user' AND text = 'A spoken question.' AND NOT (id = ANY($1::uuid[])) ORDER BY created_at DESC, id DESC LIMIT 1",
              [priorQuestions.rows.map((row) => row.id)],
            ),
          );
          expect(result.rows).toHaveLength(1);
          return result.rows[0]!;
        });
        sourceId = source.id;
        const assistant = await vi.waitFor(
          async () => {
            const result = await assistantFor(sourceId);
            expect(result.rows[0]).toMatchObject({ status: "running", agent_run_id: null });
            return result.rows[0]!;
          },
          { timeout: 20_000 },
        );
        assistantId = assistant.id;

        await say("Stop");

        await vi.waitFor(() => expect(cancels).toEqual([{ tenantId: tenant, assistantMessageId: assistantId }]), {
          timeout: 10_000,
        });
      } finally {
        if (locked) await lock.query("ROLLBACK");
        else await lock.query("ROLLBACK").catch(() => undefined);
        lock.release();
      }
      await vi.waitFor(
        async () => {
          expect(await assistantFor(sourceId)).toMatchObject({
            rows: [{ id: assistantId, status: "error", error_code: "cancelled", agent_run_id: null }],
          });
        },
        { timeout: 20_000 },
      );

      // The cancellation answered the command: the session reports no error and takes the next utterance.
      send(gateway, "finalSecond");
      const second = await vi.waitFor(
        async () => {
          const result = await runInTenant(tenant, () =>
            pool.query<{ id: string }>(
              "SELECT id FROM semp_messages WHERE role = 'user' AND text = 'A second question.' ORDER BY created_at DESC, id DESC LIMIT 1",
            ),
          );
          expect(result.rows).toHaveLength(1);
          return result.rows[0]!;
        },
        { timeout: 10_000 },
      );
      await vi.waitFor(async () => expect((await assistantFor(second.id)).rows[0]?.status).toBe("done"), {
        timeout: 30_000,
      });
      expect(
        frames.filter(
          (frame) => typeof frame === "object" && frame !== null && "type" in frame && frame.type === "error",
        ),
      ).toEqual([]);
      expect(socket?.readyState).toBe(WebSocket.OPEN);
      expect(cancels).toHaveLength(1);
    }, 70_000);

    it("ends the turn quietly when the command lands before the run watch starts, and the session goes on", async () => {
      if (!gateway) throw new Error("Missing fixture gateway");
      const ownedGateway = gateway;
      const priorQuestions = await runInTenant(tenant, () =>
        pool.query<{ id: string }>("SELECT id FROM semp_messages WHERE role = 'user' AND text = 'A spoken question.'"),
      );
      await openSession();
      const descriptor = Object.getOwnPropertyDescriptor(sync, "subscribeVoice");
      if (!descriptor || typeof descriptor.value !== "function")
        throw new Error("Missing voice subscription descriptor");
      const originalSubscribe = descriptor.value as typeof sync.subscribeVoice;
      let reached = false;
      let openWatch!: () => void;
      const watchOpen = new Promise<void>((resolveWatch) => {
        openWatch = resolveWatch;
      });
      // The session has found the run of the reply and is about to watch it: the watch waits here for the command.
      Object.defineProperty(sync, "subscribeVoice", {
        ...descriptor,
        value: async function (this: typeof sync, input: Parameters<typeof originalSubscribe>[0]) {
          reached = true;
          await watchOpen;
          return originalSubscribe.call(this, input);
        },
      });
      restoreSubscribe = () => Object.defineProperty(sync, "subscribeVoice", descriptor);
      send(ownedGateway, "holdModel");
      modelHeld = true;
      try {
        send(ownedGateway, "final");
        const source = await vi.waitFor(async () => {
          const result = await runInTenant(tenant, () =>
            pool.query<{ id: string }>(
              "SELECT id FROM semp_messages WHERE role = 'user' AND text = 'A spoken question.' AND NOT (id = ANY($1::uuid[])) ORDER BY created_at DESC, id DESC LIMIT 1",
              [priorQuestions.rows.map((row) => row.id)],
            ),
          );
          expect(result.rows).toHaveLength(1);
          return result.rows[0]!;
        });
        const assistant = await vi.waitFor(
          async () => {
            const result = await assistantFor(source.id);
            expect(result.rows[0]).toMatchObject({ status: "running", agent_run_id: expect.any(String) });
            return result.rows[0]!;
          },
          { timeout: 20_000 },
        );
        await vi.waitFor(() => expect(reached).toBe(true), { timeout: 10_000 });

        await say("Stop");

        await vi.waitFor(
          async () => {
            expect(await assistantFor(source.id)).toMatchObject({
              rows: [{ id: assistant.id, status: "error", error_code: "cancelled" }],
            });
          },
          { timeout: 20_000 },
        );
        expect(cancels).toEqual([{ tenantId: tenant, assistantMessageId: assistant.id }]);
      } finally {
        openWatch();
      }

      // The cancellation answered the command: the session reports no error and takes the next utterance.
      send(ownedGateway, "releaseModel");
      modelHeld = false;
      send(ownedGateway, "finalSecond");
      const second = await vi.waitFor(
        async () => {
          const result = await runInTenant(tenant, () =>
            pool.query<{ id: string }>(
              "SELECT id FROM semp_messages WHERE role = 'user' AND text = 'A second question.' ORDER BY created_at DESC, id DESC LIMIT 1",
            ),
          );
          expect(result.rows).toHaveLength(1);
          return result.rows[0]!;
        },
        { timeout: 10_000 },
      );
      await vi.waitFor(async () => expect((await assistantFor(second.id)).rows[0]?.status).toBe("done"), {
        timeout: 30_000,
      });
      expect(
        frames.filter(
          (frame) => typeof frame === "object" && frame !== null && "type" in frame && frame.type === "error",
        ),
      ).toEqual([]);
      expect(socket?.readyState).toBe(WebSocket.OPEN);
    }, 70_000);

    const errorFrames = () =>
      frames.filter(
        (frame) => typeof frame === "object" && frame !== null && "type" in frame && frame.type === "error",
      );

    it("fails the session as unavailable when the reply ends as an error other than a cancellation", async () => {
      if (!gateway) throw new Error("Missing fixture gateway");
      const { source, assistant } = await startHeldTurn();
      const closed = once(socket!, "close");

      send(gateway, "failModel");
      modelHeld = false;

      await vi.waitFor(
        async () => {
          const reply = (await assistantFor(source.id)).rows[0];
          expect(reply).toMatchObject({ id: assistant.id, status: "error" });
          expect(reply?.error_code).not.toBeNull();
          expect(reply?.error_code).not.toBe("cancelled");
        },
        { timeout: 20_000 },
      );
      await vi.waitFor(() => expect(errorFrames()).toEqual([{ type: "error", code: "unavailable" }]), {
        timeout: 10_000,
      });
      await closed;
      expect(cancels).toEqual([]);
    }, 70_000);

    it("fails the session as unavailable when the turn is cancelled and this session did not ask for it", async () => {
      const { source, assistant } = await startHeldTurn();
      const closed = once(socket!, "close");

      // Another cause of a cancellation, such as a deactivated tenant: the notification comes from outside the session.
      await runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          requestSempTurnCancel(client, { tenantId: tenant, assistantMessageId: assistant.id }),
        ),
      );

      await vi.waitFor(
        async () => {
          expect(await assistantFor(source.id)).toMatchObject({
            rows: [{ id: assistant.id, status: "error", error_code: "cancelled" }],
          });
        },
        { timeout: 20_000 },
      );
      await vi.waitFor(() => expect(errorFrames()).toEqual([{ type: "error", code: "unavailable" }]), {
        timeout: 10_000,
      });
      await closed;
      expect(cancels).toEqual([{ tenantId: tenant, assistantMessageId: assistant.id }]);
    }, 70_000);

    it("fails the session as unavailable when the lookup of the running turn fails, and cancels nothing", async () => {
      if (!gateway) throw new Error("Missing fixture gateway");
      const priorQuestions = await runInTenant(tenant, () =>
        pool.query<{ id: string }>("SELECT id FROM semp_messages WHERE role = 'user' AND text = 'A spoken question.'"),
      );
      await openSession();
      send(gateway, "final");
      const source = await vi.waitFor(async () => {
        const result = await runInTenant(tenant, () =>
          pool.query<{ id: string }>(
            "SELECT id FROM semp_messages WHERE role = 'user' AND text = 'A spoken question.' AND NOT (id = ANY($1::uuid[])) ORDER BY created_at DESC, id DESC LIMIT 1",
            [priorQuestions.rows.map((row) => row.id)],
          ),
        );
        expect(result.rows).toHaveLength(1);
        return result.rows[0]!;
      });
      await vi.waitFor(async () => expect((await assistantFor(source.id)).rows[0]?.status).toBe("done"), {
        timeout: 30_000,
      });
      // With the turn over, the lookup of the stop command is the next use of the table by this session. The runtime
      // role holds its privilege on the table through `semprec_side`, which loses the read privilege for the length of
      // the command; no other case runs meanwhile.
      await admin.query("REVOKE SELECT ON semp_messages FROM semprec_side");
      try {
        const privilege = await admin.query<{ allowed: boolean }>(
          "SELECT has_table_privilege('semprec_data', 'semp_messages', 'SELECT') AS allowed",
        );
        expect(privilege.rows).toEqual([{ allowed: false }]);
        const closed = once(socket!, "close");

        await say("Stop");

        await vi.waitFor(() => expect(frames).toContainEqual({ type: "error", code: "unavailable" }), {
          timeout: 10_000,
        });
        await closed;
      } finally {
        await admin.query("GRANT SELECT ON semp_messages TO semprec_side");
      }
      expect(cancels).toEqual([]);
    });

    it("does nothing for a stop command when no turn is running: before the first message and after a finished turn", async () => {
      if (!gateway) throw new Error("Missing fixture gateway");
      const messagesBefore = await runInTenant(tenant, () =>
        pool.query<{ count: string }>("SELECT count(*)::text AS count FROM semp_messages"),
      );
      const priorQuestions = await runInTenant(tenant, () =>
        pool.query<{ id: string }>("SELECT id FROM semp_messages WHERE role = 'user' AND text = 'A spoken question.'"),
      );
      await openSession();

      await say("Stop");
      send(gateway, "final");
      const source = await vi.waitFor(
        async () => {
          const result = await runInTenant(tenant, () =>
            pool.query<{ id: string; thread_id: string }>(
              "SELECT id, thread_id FROM semp_messages WHERE role = 'user' AND text = 'A spoken question.' AND NOT (id = ANY($1::uuid[])) ORDER BY created_at DESC LIMIT 1",
              [priorQuestions.rows.map((row) => row.id)],
            ),
          );
          expect(result.rows).toHaveLength(1);
          return result.rows[0]!;
        },
        { timeout: 10_000 },
      );
      await vi.waitFor(async () => expect((await assistantFor(source.id)).rows[0]?.status).toBe("done"), {
        timeout: 30_000,
      });
      await say("zruš");
      send(gateway, "finalSecond");
      await vi.waitFor(
        async () => {
          expect((await userMessages(source.thread_id)).rows.map((row) => row.text)).toEqual([
            "A spoken question.",
            "A second question.",
          ]);
        },
        { timeout: 10_000 },
      );

      // The admissions of a session run in order, so both commands were handled before the second question was stored.
      expect(cancels).toEqual([]);
      const messagesAfter = await runInTenant(tenant, () =>
        pool.query<{ count: string }>("SELECT count(*)::text AS count FROM semp_messages"),
      );
      // Two user messages and their two replies: nothing for either command.
      expect(Number(messagesAfter.rows[0]?.count) - Number(messagesBefore.rows[0]?.count)).toBe(4);
      await vi.waitFor(
        async () => {
          const replies = await runInTenant(tenant, () =>
            pool.query<{ status: string }>(
              "SELECT status FROM semp_messages WHERE thread_id = $1 AND role = 'assistant'",
              [source.thread_id],
            ),
          );
          expect(replies.rows.map((row) => row.status)).toEqual(["done", "done"]);
        },
        { timeout: 30_000 },
      );
    }, 70_000);
  });

  describe("speech attribution (issue #2020)", () => {
    interface SpeechCall {
      id: string;
      operation: string;
      status: string;
      agent_run_id: string | null;
      semp_message_id: string | null;
    }

    const speechCalls = () =>
      runInTenant(tenant, () =>
        pool.query<SpeechCall>(
          `SELECT id::text, operation, status, agent_run_id, semp_message_id FROM ai_gateway_calls
           WHERE operation IN ('voice_transcribe_stream', 'voice_synthesize') ORDER BY id`,
        ),
      );

    /** Opens a session whose speech-to-text provider has accepted audio, so a scripted transcript can be delivered. */
    async function openSession(): Promise<void> {
      if (!gateway) throw new Error("Missing fixture gateway");
      const ownedGateway = gateway;
      const sttBefore = ownedGateway.messages.filter((entry) => entry.type === "sttReady").length;
      const audioBefore = ownedGateway.messages.filter((entry) => entry.type === "audioAccepted").length;
      socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
      socket.on("message", (data, binary) => {
        if (binary) {
          audioFrames++;
          return;
        }
        frames.push(JSON.parse(messageText(data)) as unknown);
      });
      await once(socket, "open");
      socket.send(JSON.stringify({ type: "start", language: "en" }));
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "ready" }), { timeout: 10_000 });
      socket.send(Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]));
      await vi.waitFor(
        () => {
          expect(ownedGateway.messages.filter((entry) => entry.type === "sttReady")).toHaveLength(sttBefore + 1);
          expect(ownedGateway.messages.filter((entry) => entry.type === "audioAccepted")).toHaveLength(audioBefore + 1);
        },
        { timeout: 10_000 },
      );
    }

    it("attributes the speech-to-text rows of a spoken question and the text-to-speech rows of its answer to the turn, and the reply's usage includes them", async () => {
      if (!gateway) throw new Error("Missing fixture gateway");
      const priorCalls = new Set((await speechCalls()).rows.map((row) => row.id));
      const priorQuestions = await runInTenant(tenant, () =>
        pool.query<{ id: string }>("SELECT id FROM semp_messages WHERE role = 'user' AND text = 'A spoken question.'"),
      );
      await openSession();

      send(gateway, "final");
      const source = await vi.waitFor(
        async () => {
          const result = await runInTenant(tenant, () =>
            pool.query<{ id: string }>(
              "SELECT id FROM semp_messages WHERE role = 'user' AND text = 'A spoken question.' AND NOT (id = ANY($1::uuid[]))",
              [priorQuestions.rows.map((row) => row.id)],
            ),
          );
          expect(result.rows).toHaveLength(1);
          return result.rows[0]!;
        },
        { timeout: 10_000 },
      );
      const assistant = await vi.waitFor(
        async () => {
          const result = await runInTenant(tenant, () =>
            pool.query<{ id: string; status: string; agent_run_id: string | null }>(
              "SELECT id, status, agent_run_id FROM semp_messages WHERE reply_to_message_id = $1 AND role = 'assistant'",
              [source.id],
            ),
          );
          expect(result.rows[0]).toMatchObject({ status: "done", agent_run_id: expect.any(String) });
          return result.rows[0]!;
        },
        { timeout: 30_000 },
      );
      const runId = assistant.agent_run_id!;
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "speaking", state: "stopped" }), {
        timeout: 20_000,
      });
      expect(audioFrames).toBeGreaterThan(0);

      const added = (await speechCalls()).rows.filter((row) => !priorCalls.has(row.id));
      const spoken = added.filter((row) => row.operation === "voice_synthesize");
      const heard = added.filter((row) => row.operation === "voice_transcribe_stream");
      expect(spoken.length).toBeGreaterThan(0);
      // The answer carries the run and the assistant message; the question carries the message alone.
      for (const row of spoken) expect(row).toMatchObject({ agent_run_id: runId, semp_message_id: assistant.id });
      expect(heard).toHaveLength(1);
      expect(heard[0]).toMatchObject({ agent_run_id: null, semp_message_id: assistant.id });

      const usage = await runInTenant(tenant, () =>
        withTransaction(pool, (client) => getAgentRunUsage(client, runId, "en", assistant.id)),
      );
      const counted = await runInTenant(tenant, () =>
        pool.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM ai_gateway_calls WHERE semp_message_id = $1 AND status <> 'failed'",
          [assistant.id],
        ),
      );
      expect(counted.rows[0]?.count).toBeGreaterThanOrEqual(spoken.length + heard.length + 1);
      expect(usage.perModel.reduce((sum, model) => sum + model.callCount, 0)).toBe(counted.rows[0]?.count);
      expect(usage.perModel.map((model) => model.model)).toEqual(
        expect.arrayContaining(["gpt-4o-transcribe", "gpt-4o-mini-tts"]),
      );
    }, 70_000);

    it("leaves the speech-to-text row of speech that never becomes a message unattributed, and speaks nothing", async () => {
      if (!gateway) throw new Error("Missing fixture gateway");
      const priorCalls = new Set((await speechCalls()).rows.map((row) => row.id));
      const messagesBefore = await runInTenant(tenant, () =>
        pool.query<{ count: string }>("SELECT count(*)::text AS count FROM semp_messages"),
      );
      await openSession();

      send(gateway, "finalText", { text: "Stop" });
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "transcript", text: "Stop", final: true }), {
        timeout: 10_000,
      });
      // The stop command is handled on the session's admission queue; a second final that follows it is stored last.
      send(gateway, "finalText", { text: "zruš" });
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "transcript", text: "zruš", final: true }), {
        timeout: 10_000,
      });

      const added = (await speechCalls()).rows.filter((row) => !priorCalls.has(row.id));
      expect(added).toMatchObject([
        { operation: "voice_transcribe_stream", agent_run_id: null, semp_message_id: null },
      ]);
      const messagesAfter = await runInTenant(tenant, () =>
        pool.query<{ count: string }>("SELECT count(*)::text AS count FROM semp_messages"),
      );
      expect(messagesAfter.rows).toEqual(messagesBefore.rows);
    }, 30_000);
  });
});
