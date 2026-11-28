import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import {
  createServer as createTcpServer,
  connect as connectTcp,
  type Server as TcpServer,
  type Socket,
} from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { WebSocket, type RawData } from "ws";
import { z } from "zod";
import { AiGatewayFailedError, currentTenantScope, runAsSystem, runInTenant } from "@alldots/shared";
import { SpeechSynthesisCapacityError, synthesizeSpeech } from "@alldots/ai-gateway-client";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "@alldots/data/testSupport";
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
} from "@alldots/data";
import { createDispatcher } from "../app.js";
import { createSyncUpgradeHandler } from "../syncHandler.js";
import { createVoiceChannel, type VoiceChannel } from "../voiceChannel.js";
import { createVoiceSessionHandler, VoiceTextState } from "../voiceSessionHandler.js";

/** No test module declares a heartbeat rule kind. */
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
const gatewayPath = join(backend, "services/alldots-ai-gateway/dist/__tests__/fixtures/liveVoiceGateway.js");
const workerPath = join(backend, "services/alldots-agents/dist/__tests__/fixtures/liveVoiceWorker.js");
const GATEWAY_TOKEN = "batch32-test-token";
const AUDIO_FRAME = Buffer.concat([Buffer.from([1]), Buffer.alloc(640)]);
const sequence = z.number().int().min(1).max(100);
const childMessage = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), port: z.number().int().min(1).max(65535).optional() }),
  z.strictObject({ type: z.literal("sttReady") }),
  z.strictObject({ type: z.literal("audioAccepted") }),
  z.strictObject({ type: z.literal("speechCall"), sequence }),
  z.strictObject({ type: z.literal("modelCall"), sequence }),
  z.strictObject({ type: z.literal("firstTextArmed") }),
  z.strictObject({ type: z.literal("firstTextHeld"), sequence }),
  z.strictObject({ type: z.literal("firstTextReleased"), sequence, request: sequence }),
  z.strictObject({ type: z.literal("firstTextDisarmed"), request: sequence }),
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
const finalTranscript = z.object({ type: z.literal("transcript"), final: z.literal(true), text: z.string() });
const countOf = (owned: OwnedChild, type: ChildMessage["type"]) =>
  owned.messages.filter((entry) => entry.type === type).length;
const isFrame = (frame: unknown, type: string): boolean =>
  typeof frame === "object" && frame !== null && "type" in frame && frame.type === type;

/** Runs one cleanup step and keeps its failure, so every later step still runs. */
async function attempt(errors: unknown[], step: () => unknown): Promise<void> {
  try {
    await step();
  } catch (error) {
    errors.push(error);
  }
}
/** Rethrows the case's own failure, joined with every cleanup failure so none hides it. */
function settle(primary: { error: unknown } | undefined, cleanup: unknown[], message: string): void {
  if (cleanup.length)
    throw new AggregateError(primary ? [primary.error, ...cleanup] : cleanup, message, {
      cause: primary ? primary.error : cleanup[0],
    });
  if (primary) throw primary.error;
}
async function terminate(ws: WebSocket | undefined): Promise<void> {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, "close");
  ws.terminate();
  await closed;
}
async function listen(server: TcpServer): Promise<number> {
  await new Promise<void>((resolveListen, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing listener address");
  return address.port;
}
async function closeServer(server: TcpServer | undefined): Promise<void> {
  if (server?.listening)
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
}
function restoreProperty(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else if (!Reflect.deleteProperty(target, key)) throw new Error(`Cannot restore ${key}`);
}
async function exited(owned: OwnedChild, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      owned.exit.then(() => true),
      new Promise<false>((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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
  /** Asks the fixture child to stop, then kills it if it does not exit, and checks its exit. */
  async function stopChild(owned: OwnedChild): Promise<void> {
    const errors: unknown[] = [];
    await attempt(errors, () => {
      if (!owned.settled && owned.child.connected) send(owned, "stop");
    });
    let settled = await exited(owned, 20_000);
    if (!settled) {
      await attempt(errors, () => {
        if (!owned.child.kill("SIGKILL")) throw new Error(`Unable to signal fixture ${owned.kind}`);
      });
      settled = await exited(owned, 5000);
    }
    if (!settled) errors.push(new Error(`Fixture ${owned.kind} pid=${owned.pid} exit not observed`));
    else {
      const result = await owned.exit;
      if (result.error || result.code !== 0 || result.signal !== null)
        errors.push(result.error ?? new Error(`Fixture ${owned.kind} pid=${owned.pid} failed`));
      else process.stderr.write(`voice fixture kind=${owned.kind} pid=${owned.pid} exit=${result.code}\n`);
    }
    if (errors.length) throw new AggregateError(errors, `Fixture ${owned.kind} cleanup failed`, { cause: errors[0] });
  }
  function send(child: OwnedChild, type: string, extra: Record<string, string | number> = {}): void {
    if (!child.child.connected) throw new Error("Fixture child disconnected");
    child.child.send({ type, ...extra });
  }
  /** Sends a control message to the gateway and waits for its delivery acknowledgement. */
  async function control(type: string, extra: Record<string, string | number> = {}): Promise<void> {
    const owned = gateway;
    if (!owned?.child.connected) throw new Error("Fixture gateway disconnected");
    await new Promise<void>((resolveSend, reject) => {
      const timer = setTimeout(() => reject(new Error("Fixture control acknowledgement timed out")), 5000);
      try {
        owned.child.send({ type, ...extra }, (error) => {
          clearTimeout(timer);
          if (error) reject(error);
          else resolveSend();
        });
      } catch (error) {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error("Fixture control failed", { cause: error }));
      }
    });
  }
  function ownedGateway(): OwnedChild {
    if (!gateway) throw new Error("Missing fixture gateway");
    return gateway;
  }
  function gatewayPort(): number {
    const ready = ownedGateway().messages.find((entry) => entry.type === "ready");
    if (!ready || ready.type !== "ready" || !ready.port) throw new Error("Missing gateway port");
    return ready.port;
  }
  const handlerFor = (port = gatewayPort()) =>
    createVoiceSessionHandler(pool, { port, token: GATEWAY_TOKEN }, sync, CORE_RULES_ONLY);

  /** A voice client of its own, recording what it receives. */
  function openPeer(port: number) {
    const peer = {
      ws: new WebSocket(`ws://127.0.0.1:${port}/api/voice`, { headers: { Authorization: `Bearer ${token}` } }),
      frames: [] as unknown[],
      audio: 0,
      closed: false,
      error: undefined as Error | undefined,
    };
    peer.ws.on("message", (data, binary) => {
      if (binary) peer.audio++;
      else peer.frames.push(JSON.parse(messageText(data)) as unknown);
    });
    peer.ws.on("error", (error) => {
      peer.error ??= error;
    });
    peer.ws.on("close", () => {
      peer.closed = true;
    });
    return peer;
  }
  /** Opens the suite's client: its frames go to `frames`, its audio to `audioFrames`. */
  async function connect(): Promise<WebSocket> {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    socket = ws;
    ws.on("message", (data, binary) => {
      if (binary) audioFrames++;
      else frames.push(JSON.parse(messageText(data)) as unknown);
    });
    await once(ws, "open");
    return ws;
  }
  /** Starts the session and waits until the speech-to-text provider has accepted audio. */
  async function streamAudio(ws: WebSocket, received: unknown[]): Promise<void> {
    const owned = ownedGateway();
    const sttBefore = countOf(owned, "sttReady");
    const audioBefore = countOf(owned, "audioAccepted");
    ws.send(JSON.stringify({ type: "start", language: "en" }));
    await vi.waitFor(() => expect(received).toContainEqual({ type: "ready" }), { timeout: 10_000 });
    ws.send(AUDIO_FRAME);
    await vi.waitFor(
      () => {
        expect(countOf(owned, "sttReady")).toBe(sttBefore + 1);
        expect(countOf(owned, "audioAccepted")).toBe(audioBefore + 1);
      },
      { timeout: 10_000 },
    );
  }
  /** Replaces the sync handler's voice subscription; the returned function restores it. */
  function overrideSubscribe(
    wrap: (original: typeof sync.subscribeVoice) => (input: Parameters<typeof sync.subscribeVoice>[0]) => unknown,
  ): () => void {
    const descriptor = Object.getOwnPropertyDescriptor(sync, "subscribeVoice");
    if (!descriptor || typeof descriptor.value !== "function") throw new Error("Missing voice subscription descriptor");
    const original = descriptor.value as typeof sync.subscribeVoice;
    Object.defineProperty(sync, "subscribeVoice", { ...descriptor, value: wrap(original.bind(sync)) });
    return () => Object.defineProperty(sync, "subscribeVoice", descriptor);
  }
  const count = (sql: string, params: unknown[] = []) =>
    runInTenant(tenant, async () => (await pool.query<{ count: number }>(sql, params)).rows[0]?.count);
  const threadIds = async () =>
    (await runInTenant(tenant, () => pool.query<{ id: string }>("SELECT id FROM semp_threads ORDER BY id"))).rows.map(
      (row) => row.id,
    );
  /** Waits for the one thread created since `prior`. */
  const newThreadId = (prior: string[]) =>
    vi.waitFor(async () => {
      const fresh = (await threadIds()).filter((id) => !prior.includes(id));
      expect(fresh).toHaveLength(1);
      return fresh[0]!;
    });
  const turnCounts = async (threadId: string) =>
    (
      await runInTenant(tenant, () =>
        pool.query<{ users: number; assistants: number }>(
          "SELECT count(*) FILTER (WHERE role='user')::int AS users, count(*) FILTER (WHERE role='assistant')::int AS assistants FROM semp_messages WHERE thread_id=$1",
          [threadId],
        ),
      )
    ).rows[0];
  const userMessageIds = async (text: string) =>
    (
      await runInTenant(tenant, () =>
        pool.query<{ id: string }>("SELECT id FROM semp_messages WHERE role = 'user' AND text = $1", [text]),
      )
    ).rows.map((row) => row.id);
  /** Waits for the one user message with this text stored since `prior`. */
  const newUserMessage = (text: string, prior: string[]) =>
    vi.waitFor(
      async () => {
        const result = await runInTenant(tenant, () =>
          pool.query<{ id: string; thread_id: string }>(
            "SELECT id, thread_id FROM semp_messages WHERE role = 'user' AND text = $1 AND NOT (id = ANY($2::uuid[]))",
            [text, prior],
          ),
        );
        expect(result.rows).toHaveLength(1);
        return result.rows[0]!;
      },
      { timeout: 10_000 },
    );
  const assistantFor = (userMessageId: string) =>
    runInTenant(tenant, () =>
      pool.query<{ id: string; status: string; error_code: string | null; agent_run_id: string | null }>(
        "SELECT id, status, error_code, agent_run_id FROM semp_messages WHERE reply_to_message_id = $1 AND role = 'assistant'",
        [userMessageId],
      ),
    );
  const replyDone = (userMessageId: string) =>
    vi.waitFor(async () => expect((await assistantFor(userMessageId)).rows[0]?.status).toBe("done"), {
      timeout: 30_000,
    });
  const errorFrames = () => frames.filter((frame) => isFrame(frame, "error"));

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "alldots-voice-test-"));
    blockDir = await mkdtemp(join(blockRoot, "node_modules/.batch09-"));
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "alldots_data");
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
      [gatewayPath, join(backend, "services/alldots-ai-gateway/src/__tests__/fixtures/liveVoiceGateway.ts")],
      [workerPath, join(backend, "services/alldots-agents/src/__tests__/fixtures/liveVoiceWorker.ts")],
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
    await startChild(gatewayPath, common, "gateway");
    workerEnvironment = {
      ...common,
      BATCH32_GATEWAY_PORT: String(gatewayPort()),
      FILES_STORAGE_DIR: directory,
      MAIL_ATTACHMENTS_DIR: directory,
    };
    await startChild(workerPath, workerEnvironment, "worker");
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
    url = `ws://127.0.0.1:${await listen(server)}/api/voice`;
  }, 90_000);
  beforeEach(async () => {
    if (fixtureUnsafe) throw new Error("Prior voice fixture settlement failed", { cause: fixtureUnsafe.error });
    frames.length = 0;
    audioFrames = 0;
    voice = createVoiceChannel(pool, { handler: handlerFor() });
    const prior = await runInTenant(tenant, () =>
      pool.query<{ id: string }>("SELECT id::text FROM semp_messages WHERE role='assistant'"),
    );
    priorAssistantIds = prior.rows.map((row) => row.id);
  });
  afterEach(async () => {
    const failures: unknown[] = [];
    await attempt(failures, () => terminate(socket));
    socket = undefined;
    await attempt(failures, () => voice?.close());
    await attempt(failures, () =>
      vi.waitFor(
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
      ),
    );
    if (failures.length) {
      const error = new AggregateError(failures, "Voice case settlement failed", { cause: failures[0] });
      fixtureUnsafe = { error };
      throw error;
    }
  });
  afterAll(async () => {
    const failures: unknown[] = [];
    await attempt(failures, () => socket?.terminate());
    if (voice) await attempt(failures, () => voice.close());
    if (sync) await attempt(failures, () => sync.close());
    await attempt(failures, () => closeServer(server));
    if (worker) await attempt(failures, () => stopChild(worker!));
    if (!worker || worker.settled) {
      if (gateway) await attempt(failures, () => stopChild(gateway!));
    } else failures.push(new Error("Gateway retained because worker settlement was not observed"));
    if (pool) await attempt(failures, () => pool.end());
    if (admin) await attempt(failures, () => admin.end());
    if ((!worker || worker.settled) && (!gateway || gateway.settled)) {
      if (blockDir) await attempt(failures, () => rm(blockDir, { recursive: true, force: true }));
      if (directory) await attempt(failures, () => rm(directory, { recursive: true, force: true }));
    } else failures.push(new Error("Child settlement unknown; fixture files retained"));
    if (failures.length) throw new AggregateError(failures, "Voice fixture cleanup failed", { cause: failures[0] });
  }, 60_000);

  it.each(["normal", "peer", "tenant", "server"] as const)(
    "settles an actual gated gateway upgrade after %s",
    async (ending) => {
      const port = gatewayPort();
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
      // Relays the gateway connection but holds its first answer until the case releases it.
      const relay = createTcpServer((incoming) => {
        if (downstream) {
          incoming.destroy();
          return;
        }
        downstream = incoming;
        upstream = connectTcp({ host: "127.0.0.1", port });
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
      const releaseGate = () => {
        released = true;
        if (retained && downstream && upstream && !downstream.destroyed && !upstream.destroyed) {
          downstream.write(retained);
          retained = undefined;
          upstream.pipe(downstream);
          upstream.resume();
        }
      };
      const localServer = createServer();
      let channel: VoiceChannel | undefined;
      let peer: ReturnType<typeof openPeer> | undefined;
      let primary: { error: unknown } | undefined;
      const cleanup: unknown[] = [];
      let shutdown: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      try {
        const actualHandler = handlerFor(await listen(relay));
        let startSignal: AbortSignal | undefined;
        let startFailure: { error: unknown; aborted: boolean } | undefined;
        let closedSessions = 0;
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
        const observations = async () => ({
          messages: await count("SELECT count(*)::int AS count FROM semp_messages"),
          jobs: await count("SELECT count(*)::int AS count FROM graphile_worker.jobs"),
          calls: await count("SELECT count(*)::int AS count FROM ai_gateway_calls"),
        });
        const before = await observations();
        const current = openPeer(await listen(localServer));
        peer = current;
        await vi.waitFor(() => expect(current.ws.readyState).toBe(WebSocket.OPEN), { timeout: 5000 });
        current.ws.send(JSON.stringify({ type: "start", language: "en" }));
        await vi.waitFor(() => expect(seen).toBe(true), { timeout: 5000 });
        expect(current.frames).toEqual([]);
        if (ending === "normal") {
          releaseGate();
          await vi.waitFor(() => expect(current.frames).toContainEqual({ type: "ready" }), { timeout: 5000 });
          current.ws.close();
        } else {
          if (ending === "peer") current.ws.close();
          else if (ending === "tenant") actualChannel.closeTenant(tenant);
          else
            shutdown = actualChannel.close().then(
              () => ({ ok: true as const }),
              (error: unknown) => ({ ok: false as const, error }),
            );
          await vi.waitFor(() => expect(current.closed).toBe(true), { timeout: 5000 });
          expect(startSignal?.aborted).toBe(true);
          await vi.waitFor(
            () => {
              expect(downstreamClosed).toBe(true);
              expect(upstreamClosed).toBe(true);
            },
            { timeout: 5000 },
          );
          releaseGate();
          expect(current.frames).toEqual([]);
        }
        await vi.waitFor(() => expect(current.closed).toBe(true), { timeout: 5000 });
        await vi.waitFor(() => expect(closedSessions).toBe(1), { timeout: 5000 });
        if (ending === "server") {
          expect(startFailure?.aborted).toBe(true);
          const error = startFailure?.error;
          expect(error).toBeInstanceOf(AiGatewayFailedError);
          if (!(error instanceof AiGatewayFailedError)) throw new Error("Missing gateway rejection");
          expect(error.reason).toBe("http");
        }
        expect(await observations()).toEqual(before);
      } catch (error) {
        primary = { error };
      }
      await attempt(cleanup, () => peer?.ws.terminate());
      await attempt(cleanup, () => {
        downstream?.destroy();
        upstream?.destroy();
      });
      await attempt(cleanup, async () => {
        if (!shutdown) return channel?.close();
        const outcome = await shutdown;
        if (ending !== "server") {
          if (!outcome.ok) throw outcome.error;
          return;
        }
        expect(outcome.ok).toBe(false);
        if (outcome.ok || !(outcome.error instanceof AggregateError)) throw new Error("Missing shutdown aggregate");
        expect(outcome.error.errors).toHaveLength(1);
        const member: unknown = outcome.error.errors[0];
        expect(member).toBeInstanceOf(Error);
        if (!(member instanceof Error)) throw new Error("Invalid shutdown member");
        expect(member.message).toBe("Voice handler operation failed");
      });
      await attempt(cleanup, () =>
        vi.waitFor(
          () => {
            if (downstream) expect(downstreamClosed).toBe(true);
            if (upstream) expect(upstreamClosed).toBe(true);
          },
          { timeout: 5000 },
        ),
      );
      await attempt(cleanup, () => {
        if (ending !== "normal" && seen) expect(peer?.frames ?? []).toEqual([]);
      });
      for (const owned of [localServer, relay]) await attempt(cleanup, () => closeServer(owned));
      if (relayError) cleanup.push(relayError);
      if (peer?.error) cleanup.push(peer.error);
      settle(primary, cleanup, "Gated start or cleanup failed");
    },
  );

  it("settles actual pending voice registrations after peer, tenant and server close before model work", async () => {
    if (!worker) throw new Error("Missing owned voice fixtures");
    const gatewayChild = ownedGateway();
    const port = gatewayPort();
    const modelCalls = () => countOf(gatewayChild, "modelCall");
    await stopChild(worker);
    worker = undefined;
    let primary: { error: unknown } | undefined;
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
        const localServer = createServer();
        let peer: ReturnType<typeof openPeer> | undefined;
        let shutdown: Promise<void> | undefined;
        let abortConfirmed = false;
        let gateHeld = false;
        let held: Extract<ChildMessage, { type: "gateHeld" }> | undefined;
        const initialCalls = modelCalls();
        let releaseSql!: () => void;
        const sqlGate = new Promise<void>((resolveGate) => {
          releaseSql = resolveGate;
        });
        let sqlReached = false;
        let sqlClaimed = false;
        let sqlParameters: unknown[] | undefined;
        const pendingQueries: Promise<unknown>[] = [];
        // Holds the session's first read of the run's events until the session has been closed.
        const descriptor = Object.getOwnPropertyDescriptor(pool, "query");
        /* eslint-disable @typescript-eslint/unbound-method */
        pool.query = new Proxy(pool.query, {
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
            pendingQueries.push(work.catch(() => undefined));
            return work;
          },
        });
        /* eslint-enable @typescript-eslint/unbound-method */
        let casePrimary: { error: unknown } | undefined;
        const caseCleanup: unknown[] = [];
        try {
          send(isolated, "arm");
          await vi.waitFor(() => expect(isolated.messages).toContainEqual({ type: "gateArmed" }), { timeout: 5000 });
          let senderSignal: AbortSignal | undefined;
          let closedCount = 0;
          const actual = handlerFor(port);
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
          localServer.on("upgrade", (req, stream, head) => actualChannel.handleUpgrade(req, stream, head));
          const current = openPeer(await listen(localServer));
          peer = current;
          await vi.waitFor(() => expect(current.ws.readyState).toBe(WebSocket.OPEN), { timeout: 5000 });
          await streamAudio(current.ws, current.frames);
          send(gatewayChild, "final");
          await vi.waitFor(
            () => expect(current.frames.some((frame) => finalTranscript.safeParse(frame).success)).toBe(true),
            { timeout: 5000 },
          );
          await vi.waitFor(() => expect(countOf(isolated, "gateHeld")).toBeGreaterThan(0), { timeout: 5000 });
          gateHeld = true;
          const gate = isolated.messages.find((entry) => entry.type === "gateHeld");
          if (!gate || gate.type !== "gateHeld") throw new Error("Missing worker gate identity");
          held = gate;
          expect(gate.tenantId).toBe(tenant);
          await vi.waitFor(() => expect(sqlReached).toBe(true), { timeout: 5000 });
          expect(sqlParameters?.[0]).toBe(gate.runId);
          expect(sqlParameters?.[3]).toBe(gate.messageId);
          const rows = await runInTenant(tenant, () =>
            pool.query<{ thread_id: string; event_id: string; kind: string; source: string | null }>(
              `SELECT a.thread_id, e.id::text AS event_id, e.kind, u.source FROM semp_messages a
             JOIN semp_messages u ON u.tenant_id = a.tenant_id AND a.reply_to_message_id = u.id AND u.role = 'user'
             JOIN agent_run_events e ON e.tenant_id = a.tenant_id AND e.agent_run_id = a.agent_run_id AND e.id = a.event_from_id
             JOIN agent_runs r ON r.tenant_id = a.tenant_id AND r.id = a.agent_run_id
             WHERE a.id = $1 AND a.role = 'assistant' AND a.agent_run_id = $2 AND e.id = $3::bigint`,
              [gate.messageId, gate.runId, gate.eventId],
            ),
          );
          expect(rows.rows).toHaveLength(1);
          expect(rows.rows[0]).toMatchObject({ event_id: gate.eventId, kind: "user_message", source: "voice" });
          expect(sqlParameters?.[2]).toBe(rows.rows[0]?.thread_id);
          const beforeClose = current.frames.length;
          if (ending === "peer") current.ws.close();
          else if (ending === "tenant") actualChannel.closeTenant(tenant);
          else {
            shutdown = actualChannel.close();
            void shutdown.catch(() => {});
          }
          await vi.waitFor(() => expect(current.closed).toBe(true), { timeout: 5000 });
          expect(senderSignal?.aborted).toBe(true);
          releaseSql();
          await vi.waitFor(() => expect(closedCount).toBe(1), { timeout: 5000 });
          expect(current.frames).toHaveLength(beforeClose);
          send(isolated, "abort");
          await vi.waitFor(() => expect(countOf(isolated, "gateAborted")).toBeGreaterThan(0), { timeout: 5000 });
          const abort = isolated.messages.find((entry) => entry.type === "gateAborted");
          if (!abort || abort.type !== "gateAborted" || abort.count < 1)
            throw new Error("Worker cohort abort not established");
          abortConfirmed = true;
          send(isolated, "release");
          await vi.waitFor(() => expect(isolated.messages).toContainEqual({ type: "gateReleased" }), { timeout: 5000 });
          expect(
            await count("SELECT count(*)::int AS count FROM ai_gateway_calls WHERE agent_run_id = $1", [gate.runId]),
          ).toBe(0);
          expect(modelCalls()).toBe(initialCalls);
        } catch (error) {
          casePrimary = { error };
        }
        releaseSql();
        await attempt(caseCleanup, () => Promise.all(pendingQueries));
        await attempt(caseCleanup, () => {
          restoreProperty(pool, "query", descriptor);
          expect(Object.getOwnPropertyDescriptor(pool, "query")).toEqual(descriptor);
        });
        await attempt(caseCleanup, () => peer?.ws.terminate());
        await attempt(caseCleanup, () => (shutdown ? shutdown : channel?.close()));
        await attempt(caseCleanup, () => closeServer(localServer));
        if (gateHeld && !abortConfirmed)
          caseCleanup.push(new Error("Worker gate retained without positive cohort abort"));
        await attempt(caseCleanup, () => stopChild(isolated));
        await attempt(caseCleanup, async () => {
          if (!abortConfirmed || !isolated.settled || !held) return;
          const finalState = await runInTenant(tenant, () =>
            pool.query<{ status: string; error_code: string | null }>(
              "SELECT status, error_code FROM semp_messages WHERE id = $1",
              [held.messageId],
            ),
          );
          expect(finalState.rows).toEqual([{ status: "error", error_code: "interrupted" }]);
          expect(
            await count("SELECT count(*)::int AS count FROM ai_gateway_calls WHERE agent_run_id = $1", [held.runId]),
          ).toBe(0);
          expect(modelCalls()).toBe(initialCalls);
        });
        if (peer?.error) caseCleanup.push(peer.error);
        settle(casePrimary, caseCleanup, "Registration case or cleanup failed");
      }
    } catch (error) {
      primary = { error };
    }
    if (lastIsolated?.settled) worker = undefined;
    const cleanup: unknown[] = [];
    if (!primary && !worker) await attempt(cleanup, () => startChild(workerPath, workerEnvironment, "worker"));
    settle(primary, cleanup, "Registration suite or cleanup failed");
  });

  it.each([
    { name: "admits two quick initial finals into one thread before delivery finishes", count: 2, overflow: false },
    { name: "admits sixteen outstanding voice turns and refuses the seventeenth", count: 16, overflow: true },
  ])(
    "$name",
    async ({ count: turns, overflow }) => {
      const owned = ownedGateway();
      let held = false;
      let primary: { error: unknown } | undefined;
      let socketError: Error | undefined;
      const cleanup: unknown[] = [];
      try {
        const ws = await connect();
        ws.on("error", (error) => {
          socketError ??= error;
        });
        await streamAudio(ws, frames);
        held = true;
        await control("holdModel");
        const prior = await threadIds();
        const priorModelCalls = countOf(owned, "modelCall");
        send(owned, "final");
        if (!overflow) send(owned, "finalSecond");
        const threadId = await newThreadId(prior);
        await vi.waitFor(() => expect(countOf(owned, "modelCall")).toBe(priorModelCalls + 1));
        for (let i = 1; i < turns; i++) {
          if (overflow) send(owned, "finalSecond");
          await vi.waitFor(async () => expect(await turnCounts(threadId)).toEqual({ users: i + 1, assistants: i + 1 }));
        }
        const rows = await runInTenant(tenant, () =>
          pool.query<{ role: string; source: string | null; status: string | null }>(
            "SELECT role, source, status FROM semp_messages WHERE thread_id=$1 ORDER BY created_at, id",
            [threadId],
          ),
        );
        expect(rows.rows).toHaveLength(turns * 2);
        for (let i = 0; i < turns; i++) {
          expect(rows.rows[i * 2]).toMatchObject({ role: "user", source: "voice" });
          expect(rows.rows[i * 2 + 1]).toMatchObject({ role: "assistant" });
        }
        expect(countOf(owned, "modelCall")).toBe(priorModelCalls + 1);
        const assistants = rows.rows.filter((row) => row.role === "assistant");
        expect(assistants.filter((row) => row.status === "running")).toHaveLength(1);
        expect(assistants.filter((row) => row.status === "queued")).toHaveLength(turns - 1);
        expect((await threadIds()).filter((id) => !prior.includes(id))).toEqual([threadId]);
        if (overflow) {
          send(owned, "finalSecond");
          await vi.waitFor(() => expect(frames).toContainEqual({ type: "error", code: "overloaded" }));
          expect(await count("SELECT count(*)::int AS count FROM semp_messages WHERE thread_id=$1", [threadId])).toBe(
            turns * 2,
          );
        }
      } catch (error) {
        primary = { error };
      }
      if (held) await attempt(cleanup, () => control("releaseModel"));
      await attempt(cleanup, () => terminate(socket));
      if (socketError) cleanup.push(socketError);
      settle(primary, cleanup, "Voice admission test cleanup failed");
    },
    70_000,
  );

  it.each(["fault", "server-close"] as const)(
    "settles a real second voice admission with a synthetic %s boundary",
    async (mode) => {
      const owned = ownedGateway();
      const handler = handlerFor();
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
        const record = (outcome: NonNullable<typeof observation.outcome>) => {
          observation.outcome = outcome;
          observation.settled = true;
          unsettledCloseCalls--;
        };
        result.then(
          (value) => record({ status: "fulfilled", value }),
          (reason: unknown) => record({ status: "rejected", reason }),
        );
        return result;
      };
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
      let peer: ReturnType<typeof openPeer> | undefined;
      let replacement: ReturnType<typeof openPeer> | undefined;
      let closeWork: Promise<PromiseSettledResult<void>> | undefined;
      let held = false;
      let primary: { error: unknown } | undefined;
      const cleanup: unknown[] = [];
      // A client whose query proxy cannot be restored is ended rather than returned to the pool.
      const endClient = (client: PoolClient, error: unknown) => {
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
      };
      const onRelease = (_error: Error | undefined, client: PoolClient) => {
        if (!active.has(client)) return;
        try {
          restoreProperty(client, "query", active.get(client));
          active.delete(client);
        } catch (error) {
          endClient(client, error);
        }
      };
      // The statement also sets the search vector of the text; it is told by its start and its user role.
      const isSecondUserInsert = (args: unknown[]): boolean => {
        const scope = currentTenantScope();
        const values: unknown = args[1];
        return (
          typeof args[0] === "string" &&
          args[0].startsWith(
            "INSERT INTO semp_messages (thread_id, role, text, search_vector, context, created_at, source)",
          ) &&
          args[0].includes("VALUES ($1, 'user', $2::text,") &&
          scope?.kind === "tenant" &&
          scope.tenantId === tenant &&
          Array.isArray(values) &&
          values.length === 5 &&
          values[0] === selectedThread &&
          values[1] === "A second question." &&
          values[2] === "[]" &&
          (values[3] instanceof Date || typeof values[3] === "string") &&
          values[4] === "voice"
        );
      };
      const onAcquire = (client: PoolClient) => {
        if (active.has(client)) return;
        try {
          active.set(client, Object.getOwnPropertyDescriptor(client, "query"));
          /* eslint-disable @typescript-eslint/unbound-method */
          client.query = new Proxy(client.query, {
            apply(target, receiver, args: unknown[]) {
              if (reached || !isSecondUserInsert(args)) {
                const result: unknown = Reflect.apply(target, receiver, args);
                if (client === selectedClient && args[0] === "ROLLBACK" && result instanceof Promise)
                  pending.push(
                    result.then(
                      () => {
                        rollback = true;
                      },
                      (error: unknown) => {
                        observerErrors.push(error);
                      },
                    ),
                  );
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
          endClient(client, error);
        }
      };
      try {
        const port = await listen(localServer);
        const current = openPeer(port);
        peer = current;
        await once(current.ws, "open");
        await streamAudio(current.ws, current.frames);
        held = true;
        send(owned, "holdModel");
        const before = await threadIds();
        const modelBefore = countOf(owned, "modelCall");
        send(owned, "final");
        selectedThread = await newThreadId(before);
        await vi.waitFor(() => expect(countOf(owned, "modelCall")).toBe(modelBefore + 1));
        const firstAssistant = await runInTenant(tenant, () =>
          pool.query<{ id: string }>("SELECT id FROM semp_messages WHERE thread_id=$1 AND role='assistant'", [
            selectedThread,
          ]),
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
        if (job.queue_name === null) throw new Error("Missing Semp job queue");
        const snapshotJobs = async () =>
          (
            await runInTenant(tenant, () =>
              pool.query<{ id: string; key: string | null }>(
                "SELECT id::text, key FROM graphile_worker.jobs WHERE queue_name=$1 AND task_identifier=$2 ORDER BY id",
                [job.queue_name, job.task_identifier],
              ),
            )
          ).rows;
        const beforeJobs = await snapshotJobs();
        expect(beforeJobs).toContainEqual({ id: job.id, key: firstKey });
        pool.on("release", onRelease);
        pool.on("acquire", onAcquire);
        send(owned, "finalSecond");
        await vi.waitFor(() => expect(reached).toBe(true));
        let framesAtClose = 0;
        let audioAtClose = 0;
        if (mode === "server-close") {
          send(owned, "finalSecond");
          await vi.waitFor(() =>
            expect(current.frames.filter((entry) => finalTranscript.safeParse(entry).success)).toHaveLength(3),
          );
          closeWork = channel.close().then(
            () => ({ status: "fulfilled" as const, value: undefined }),
            (reason: unknown) => ({ status: "rejected" as const, reason }),
          );
          framesAtClose = current.frames.length;
          audioAtClose = current.audio;
          releaseGate();
        } else {
          await vi.waitFor(() => expect(rollback).toBe(true));
          await vi.waitFor(() => expect(current.frames).toContainEqual({ type: "error", code: "unavailable" }));
        }
        await Promise.all(pending);
        if (mode === "server-close") {
          if (!closeWork) throw new Error("Missing server close outcome");
          expect((await closeWork).status).toBe("fulfilled");
          expect(closeCalls).toBe(1);
          expect(closeObservations).toHaveLength(1);
          expect(closeObservations[0]).toMatchObject({
            settled: true,
            outcome: { status: "fulfilled" },
            identity: { tenantId: tenant },
          });
          expect(current.frames).toHaveLength(framesAtClose);
          expect(current.audio).toBe(audioAtClose);
        } else {
          expect(await snapshotJobs()).toEqual(beforeJobs);
          await vi.waitFor(() => expect(closeObservations[0]?.settled).toBe(true));
          expect(closeCalls).toBe(1);
          const observed = closeObservations[0];
          if (!observed || observed.outcome?.status !== "fulfilled" || !observed.outcome.value)
            throw new Error("Expected fulfilled handler operation outcome");
          expect(observed.identity.tenantId).toBe(tenant);
          expect(observed.outcome.value.operationFailures).toHaveLength(1);
          expect(observed.outcome.value.operationFailures[0]).toBe(fault);
          // The failed admission ended its session; a new session of the same user starts normally.
          const next = openPeer(port);
          replacement = next;
          await once(next.ws, "open");
          next.ws.send(JSON.stringify({ type: "start", language: "en" }));
          await vi.waitFor(() => expect(next.frames).toContainEqual({ type: "ready" }));
          const replacementClosed = once(next.ws, "close");
          next.ws.close();
          await replacementClosed;
          await vi.waitFor(() => expect(closeCalls).toBe(2));
          await vi.waitFor(() => expect(unsettledCloseCalls).toBe(0));
          expect(closeObservations[1]).toMatchObject({
            identity: { userId: observed.identity.userId, tenantId: observed.identity.tenantId },
            outcome: { status: "fulfilled" },
          });
          closeWork = channel.close().then(
            () => ({ status: "fulfilled" as const, value: undefined }),
            (reason: unknown) => ({ status: "rejected" as const, reason }),
          );
          expect((await closeWork).status).toBe("fulfilled");
        }
        const turns = mode === "fault" ? 1 : 2;
        expect(await turnCounts(selectedThread)).toEqual({ users: turns, assistants: turns });
      } catch (error) {
        primary = { error };
      }
      releaseGate();
      await attempt(cleanup, () => {
        if (held) send(owned, "releaseModel");
      });
      await attempt(cleanup, async () => {
        if (!closeWork) return channel.close();
        const result = await closeWork;
        if (result.status === "rejected") throw result.reason;
      });
      await attempt(cleanup, () => {
        if (unsettledCloseCalls !== 0) throw new Error("Handler close observation unsettled");
        restoreProperty(handler, "onClose", closeDescriptor);
        expect(Object.getOwnPropertyDescriptor(handler, "onClose")).toEqual(closeDescriptor);
      });
      await attempt(cleanup, () => Promise.all(pending));
      pool.off("acquire", onAcquire);
      await attempt(cleanup, () => vi.waitFor(() => expect(active.size).toBe(0), { timeout: 5000 }));
      if (!active.size) pool.off("release", onRelease);
      cleanup.push(...observerErrors);
      await attempt(cleanup, () => terminate(replacement?.ws));
      await attempt(cleanup, () => terminate(peer?.ws));
      await attempt(cleanup, () => closeServer(localServer));
      for (const client of [peer, replacement]) if (client?.error) cleanup.push(client.error);
      settle(primary, cleanup, "Voice admission boundary cleanup failed");
    },
    70_000,
  );

  it("stores a trusted voice turn and streams a real worker answer before native provider completion", async () => {
    if (!worker) throw new Error("Missing fixture child");
    const owned = ownedGateway();
    let watchSocket: WebSocket | undefined;
    const watchServer = createServer();
    let primary: { error: unknown } | undefined;
    const holds = { releaseFirstText: false, releaseSpeech: false, releaseModel: false };
    type Subscription = Parameters<typeof sync.subscribeVoice>[0];
    type ObservedSubscription = Pick<
      Subscription,
      "tenantId" | "threadId" | "sempMessageId" | "runId" | "userId" | "signal"
    > & { state: "pending" | "fulfilled" | "rejected"; error?: unknown };
    const recorded: ObservedSubscription[] = [];
    const observers: Promise<void>[] = [];
    let restoreSubscribe: (() => void) | undefined;
    let releaseRequest = 0;
    /** Releases the held first text and waits until the gateway has answered that very request. */
    async function releaseFirstText(): Promise<void> {
      const request = ++releaseRequest;
      await control("releaseFirstText", { request });
      await vi.waitFor(() =>
        expect(
          owned.messages.some(
            (entry) =>
              (entry.type === "firstTextReleased" || entry.type === "firstTextDisarmed") && entry.request === request,
          ),
        ).toBe(true),
      );
    }
    try {
      restoreSubscribe = overrideSubscribe((original) => (input) => {
        const result = original(input);
        const { tenantId, threadId, sempMessageId, runId, userId, signal } = input;
        const observed: ObservedSubscription = {
          tenantId,
          threadId,
          sempMessageId,
          runId,
          userId,
          signal,
          state: "pending",
        };
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
      });
      const cp = createChokePoint(pool);
      const database = await runInTenant(tenant, () => cp.createDatabase({ name: "Voice approval fixture" }));
      const target = await runInTenant(tenant, () => cp.createItem({ databaseId: database.id, properties: {} }));
      await control("approvalTarget", { itemId: target.id });
      await vi.waitFor(() => expect(countOf(owned, "approvalReady")).toBeGreaterThan(0));
      const ws = await connect();
      await streamAudio(ws, frames);
      holds.releaseSpeech = true;
      await control("holdSpeech");
      holds.releaseModel = true;
      await control("holdModel");
      const armedBefore = countOf(owned, "firstTextArmed");
      const heldBefore = countOf(owned, "firstTextHeld");
      const releasedBefore = countOf(owned, "firstTextReleased");
      holds.releaseFirstText = true;
      await control("holdFirstText");
      await vi.waitFor(() => expect(countOf(owned, "firstTextArmed")).toBe(armedBefore + 1));
      send(owned, "partial");
      await vi.waitFor(() =>
        expect(frames).toContainEqual({ type: "transcript", text: "A spoken question.", final: false }),
      );
      send(owned, "final");
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
          expect(recorded).toHaveLength(1);
          expect(recorded[0]).toMatchObject({
            state: "fulfilled",
            tenantId: tenant,
            threadId: source.thread_id,
            sempMessageId: rows.rows[0]?.id,
            runId: rows.rows[0]?.run_id,
            userId: rows.rows[0]?.actor_user_id,
          });
          expect(recorded[0]?.signal?.aborted).toBe(false);
          expect(socket?.readyState).toBe(WebSocket.OPEN);
          const held = owned.messages.filter((entry) => entry.type === "firstTextHeld");
          expect(held).toHaveLength(heldBefore + 1);
          return held.at(-1)!;
        },
        { timeout: 20_000 },
      );
      await Promise.all(observers);
      expect(recorded).toHaveLength(1);
      restoreSubscribe();
      restoreSubscribe = undefined;
      await releaseFirstText();
      await vi.waitFor(() => {
        const released = owned.messages.filter((entry) => entry.type === "firstTextReleased");
        expect(released).toHaveLength(releasedBefore + 1);
        expect(released.at(-1)).toEqual({
          type: "firstTextReleased",
          sequence: targetTurn.sequence,
          request: releaseRequest,
        });
      });
      holds.releaseFirstText = false;
      const first = await vi.waitFor(
        async () => {
          const row = (await assistantFor(source.id)).rows[0];
          expect(row).toMatchObject({ status: "running", agent_run_id: expect.any(String) });
          expect(audioFrames).toBeGreaterThan(0);
          return { id: row!.id, run: row!.agent_run_id! };
        },
        { timeout: 20_000 },
      );
      const assistantSource = await runInTenant(tenant, () =>
        pool.query<{ source: string | null }>("SELECT source FROM semp_messages WHERE id=$1", [first.id]),
      );
      expect(assistantSource.rows).toEqual([{ source: null }]);
      expect(frames).toContainEqual({ type: "speaking", state: "started" });
      const watchedFrames: unknown[] = [];
      let watchInvalid = false;
      watchServer.on("upgrade", (req, stream, head) => sync.handleUpgrade(req, stream, head));
      watchSocket = new WebSocket(`ws://127.0.0.1:${await listen(watchServer)}/api/sync`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      watchSocket.on("error", () => {
        watchInvalid = true;
      });
      watchSocket.on("message", (data, binary) => {
        if (binary) return;
        try {
          const text = messageText(data);
          if (Buffer.byteLength(text) > 256 * 1024 || watchedFrames.length >= 1024) watchInvalid = true;
          else watchedFrames.push(JSON.parse(text) as unknown);
        } catch {
          watchInvalid = true;
        }
      });
      await once(watchSocket, "open");
      watchSocket.send(JSON.stringify({ type: "agent:watch", runId: first.run, afterEventId: "0" }));
      await vi.waitFor(() => expect(watchedFrames.some((frame) => isFrame(frame, "agent:event"))).toBe(true));
      send(owned, "partial");
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "speaking", state: "stopped" }));
      const audioAfterBargeIn = audioFrames;
      send(owned, "finalSecond");
      await vi.waitFor(() =>
        expect(frames).toContainEqual({ type: "transcript", text: "A second question.", final: true }),
      );
      const second = await vi.waitFor(async () => {
        const result = await runInTenant(tenant, () =>
          pool.query<{ source: string | null; assistant_id: string; status: string }>(
            `SELECT u.source, a.id AS assistant_id, a.status
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
      const status = async (id: string) =>
        (
          await runInTenant(tenant, () =>
            pool.query<{ status: string; agent_run_id: string | null }>(
              "SELECT status, agent_run_id FROM semp_messages WHERE id=$1",
              [id],
            ),
          )
        ).rows[0];
      expect((await status(first.id))?.status).toBe("running");
      await control("releaseSpeech");
      holds.releaseSpeech = false;
      await control("releaseModel");
      holds.releaseModel = false;
      await vi.waitFor(async () => expect((await status(first.id))?.status).toBe("done"), { timeout: 20_000 });
      const approval = await vi.waitFor(async () => {
        const result = await runInTenant(tenant, () =>
          pool.query<{ id: string; status: string }>(
            "SELECT id, status FROM approval_requests WHERE agent_run_id=$1 AND tool_call_id=$2",
            [first.run, "voice-approval-call"],
          ),
        );
        expect(result.rows).toMatchObject([{ status: "pending" }]);
        return result.rows[0]!;
      });
      await vi.waitFor(() => {
        expect(watchInvalid).toBe(false);
        expect(watchedFrames).toContainEqual(
          expect.objectContaining({
            type: "notification",
            notification: expect.objectContaining({ sourceId: approval.id }),
          }),
        );
        expect(watchedFrames).toContainEqual(
          expect.objectContaining({
            type: "agent:event",
            event: expect.objectContaining({
              payload: expect.objectContaining({ toolCallId: "voice-approval-call" }),
            }),
          }),
        );
      });
      const history = await fetch(
        `${url.replace("ws://", "http://").replace("/api/voice", "")}/api/semp/threads/${source.thread_id}/messages`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      expect(history.status).toBe(200);
      expect(await history.json()).toMatchObject({
        rows: expect.arrayContaining([expect.objectContaining({ id: first.id, agentRunId: first.run })]),
      });
      const targetState = await runInTenant(tenant, () =>
        pool.query<{ deleted_at: Date | null }>("SELECT deleted_at FROM items WHERE id=$1", [target.id]),
      );
      expect(targetState.rows).toEqual([{ deleted_at: null }]);
      await vi.waitFor(
        async () => expect(await status(second.assistant_id)).toEqual({ status: "done", agent_run_id: first.run }),
        { timeout: 20_000 },
      );
      const modelCalls = await runInTenant(tenant, () =>
        pool.query<{ semp_message_id: string; status: string }>(
          "SELECT semp_message_id, status FROM ai_gateway_calls WHERE agent_run_id=$1 AND operation='agent_turn' ORDER BY at, id",
          [first.run],
        ),
      );
      expect(modelCalls.rows).toEqual([
        { semp_message_id: first.id, status: "settled" },
        { semp_message_id: first.id, status: "settled" },
        { semp_message_id: second.assistant_id, status: "settled" },
      ]);
      const closed = once(ws, "close");
      ws.close();
      await closed;
      await vi.waitFor(
        async () =>
          expect(await count("SELECT count(*)::int AS count FROM ai_gateway_calls WHERE status='reserved'")).toBe(0),
        { timeout: 10_000 },
      );
    } catch (error) {
      primary = { error };
    }
    const cleanup: unknown[] = [];
    for (const [type, held] of Object.entries(holds))
      if (held) await attempt(cleanup, () => (type === "releaseFirstText" ? releaseFirstText() : control(type)));
    if (restoreSubscribe && primary) await attempt(cleanup, () => terminate(socket));
    await attempt(cleanup, async () => {
      await Promise.all(observers);
      for (const observed of recorded) if (observed.state === "rejected") cleanup.push(observed.error);
    });
    if (restoreSubscribe) await attempt(cleanup, restoreSubscribe);
    await attempt(cleanup, () => terminate(watchSocket));
    await attempt(cleanup, () => closeServer(watchServer));
    settle(primary, cleanup, "Voice model watch cleanup failed");
  }, 70_000);

  it("settles the exact real STT reservation after socket close", async () => {
    const callIds = async () =>
      (
        await runInTenant(tenant, () =>
          pool.query<{ id: string; status: string }>(
            "SELECT id::text, status FROM ai_gateway_calls WHERE operation='voice_transcribe_stream'",
          ),
        )
      ).rows;
    const priorIds = new Set((await callIds()).map((row) => row.id));
    const ws = await connect();
    await streamAudio(ws, frames);
    const id = await vi.waitFor(async () => {
      const added = (await callIds()).filter((row) => !priorIds.has(row.id));
      expect(added).toMatchObject([{ status: "reserved" }]);
      return added[0]!.id;
    });
    const closed = once(ws, "close");
    ws.close();
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
    const owned = ownedGateway();
    const priorProvider = countOf(owned, "sttReady");
    const state = async () => ({
      messages: await count("SELECT count(*)::int AS count FROM semp_messages"),
      calls: await count("SELECT count(*)::int AS count FROM ai_gateway_calls"),
    });
    const before = await state();
    const priorBudget = await admin.query<{ daily: number | null; monthly: number | null; exact: boolean }>(
      `SELECT daily_cap_usd::float8 AS daily, monthly_cap_usd::float8 AS monthly,
        (daily_cap_usd IS NULL OR daily_cap_usd=(daily_cap_usd::float8)::numeric)
        AND (monthly_cap_usd IS NULL OR monthly_cap_usd=(monthly_cap_usd::float8)::numeric) AS exact
       FROM tenant_ai_budgets WHERE tenant_id=$1`,
      [tenant],
    );
    expect(priorBudget.rows).toMatchObject([{ exact: true }]);
    const prior = priorBudget.rows[0]!;
    let primary: { error: unknown } | undefined;
    try {
      await setTenantAiBudget(admin, tenant, { dailyCapUsd: 0, monthlyCapUsd: 0 });
      const ws = await connect();
      ws.send(JSON.stringify({ type: "start", language: "en" }));
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "ready" }));
      const closed = once(ws, "close");
      ws.send(AUDIO_FRAME);
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "error", code: "budgetExceeded" }));
      expect((await closed)[0]).toBe(1008);
      expect(countOf(owned, "sttReady")).toBe(priorProvider);
      expect(await state()).toEqual(before);
    } catch (error) {
      primary = { error };
    }
    const cleanup: unknown[] = [];
    await attempt(cleanup, () =>
      setTenantAiBudget(admin, tenant, { dailyCapUsd: prior.daily, monthlyCapUsd: prior.monthly }),
    );
    settle(primary, cleanup, "Budget test and restoration failed");
  }, 30_000);

  it("classifies real gateway TTS saturation without an extra provider call or reservation", async () => {
    const owned = ownedGateway();
    const options = { port: gatewayPort(), token: GATEWAY_TOKEN };
    const priorCalls = countOf(owned, "speechCall");
    const synthesizeIds = async () =>
      (
        await runInTenant(tenant, () =>
          pool.query<{ id: string; status: string }>(
            "SELECT id::text, status FROM ai_gateway_calls WHERE operation='voice_synthesize' ORDER BY id",
          ),
        )
      ).rows;
    const previous = (await synthesizeIds()).map((row) => row.id);
    const controllers: AbortController[] = [];
    const streams: AsyncIterable<Uint8Array>[] = [];
    let drained = false;
    let primary: { error: unknown } | undefined;
    const cleanup: unknown[] = [];
    send(owned, "holdSpeech");
    try {
      for (let i = 0; i < 4; i++) {
        const controller = new AbortController();
        controllers.push(controller);
        streams.push(
          await runInTenant(tenant, () =>
            synthesizeSpeech(options, { text: `Fixture ${i}.`, voice: "alloy", signal: controller.signal }),
          ),
        );
      }
      await vi.waitFor(() => expect(countOf(owned, "speechCall")).toBe(priorCalls + 4));
      const held = (await synthesizeIds()).filter((row) => !previous.includes(row.id));
      expect(held).toHaveLength(4);
      expect(held.every((row) => row.status === "reserved")).toBe(true);
      const ids = held.map((row) => row.id);
      const error = await runInTenant(tenant, () =>
        synthesizeSpeech(options, { text: "Overflow.", voice: "alloy" }),
      ).catch((value: unknown) => value);
      expect(error).toBeInstanceOf(SpeechSynthesisCapacityError);
      expect(countOf(owned, "speechCall")).toBe(priorCalls + 4);
      expect(await synthesizeIds()).toHaveLength(previous.length + 4);
      send(owned, "releaseSpeech");
      let bytes = 0;
      for (const stream of streams) for await (const chunk of stream) bytes += chunk.length;
      drained = true;
      expect(bytes).toBeGreaterThan(0);
      await vi.waitFor(async () => {
        const result = await runInTenant(tenant, () =>
          pool.query<{ status: string }>("SELECT status FROM ai_gateway_calls WHERE id=ANY($1::bigint[])", [ids]),
        );
        expect(result.rows).toEqual(Array(4).fill({ status: "settled" }));
      });
    } catch (error) {
      primary = { error };
    }
    await attempt(cleanup, () => {
      if (owned.child.connected) send(owned, "releaseSpeech");
    });
    for (const controller of controllers) controller.abort();
    if (!drained) {
      const results = await Promise.allSettled(
        streams.map(async (stream) => {
          for await (const chunk of stream) void chunk;
        }),
      );
      for (const result of results) if (result.status === "rejected") cleanup.push(result.reason);
    }
    settle(primary, cleanup, "TTS capacity test and cleanup failed");
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
    const ids = [turn.messageId, turn.assistantMessageId];
    const rows = await runInTenant(tenant, () =>
      pool.query<{ source: string | null }>("SELECT source FROM semp_messages WHERE id=ANY($1::uuid[])", [ids]),
    );
    expect(rows.rows).toEqual([{ source: null }, { source: null }]);
    const insert = (sql: string) =>
      runInTenant(tenant, () =>
        withTransaction(pool, (client) => client.query<{ source: string | null }>(sql, [turn.threadId])),
      );
    // An insert that omits the column exercises the additive schema.
    expect(
      (
        await insert(
          "INSERT INTO semp_messages (thread_id, role, text) VALUES ($1, 'user', 'legacy fixture') RETURNING source",
        )
      ).rows,
    ).toEqual([{ source: null }]);
    await expect(
      insert(
        "INSERT INTO semp_messages (thread_id, role, text, source) VALUES ($1, 'user', 'invalid fixture', 'invalid')",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    const foreign = await createTestTenant(admin);
    const invisible = await runInTenant(foreign, () =>
      pool.query<{ id: string }>("SELECT id FROM semp_messages WHERE id=ANY($1::uuid[])", [ids]),
    );
    expect(invisible.rows).toEqual([]);
  }, 30_000);

  /** Opens the suite's client with a session whose speech-to-text provider has accepted audio. */
  async function openSession(): Promise<void> {
    await streamAudio(await connect(), frames);
  }

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

    /** Waits until the session has sent the transcript back to the client. */
    async function say(text: string): Promise<void> {
      send(ownedGateway(), "finalText", { text });
      await vi.waitFor(() => expect(frames).toContainEqual({ type: "transcript", text, final: true }), {
        timeout: 10_000,
      });
    }
    function release(hold: "model" | "speech"): void {
      if (hold === "model") {
        send(ownedGateway(), "releaseModel");
        modelHeld = false;
      } else {
        send(ownedGateway(), "releaseSpeech");
        speechHeld = false;
      }
    }
    const userTexts = async (threadId: string) =>
      (
        await runInTenant(tenant, () =>
          pool.query<{ id: string; text: string; source: string | null }>(
            "SELECT id, text, source FROM semp_messages WHERE thread_id = $1 AND role = 'user' ORDER BY created_at, id",
            [threadId],
          ),
        )
      ).rows;
    const replyCancelled = (userMessageId: string, assistantId: string) =>
      vi.waitFor(
        async () =>
          expect((await assistantFor(userMessageId)).rows).toMatchObject([
            { id: assistantId, status: "error", error_code: "cancelled" },
          ]),
        { timeout: 20_000 },
      );
    const runningReply = (userMessageId: string, agentRunId: unknown) =>
      vi.waitFor(
        async () => {
          const result = await assistantFor(userMessageId);
          expect(result.rows[0]).toMatchObject({ status: "running", agent_run_id: agentRunId });
          return result.rows[0]!;
        },
        { timeout: 20_000 },
      );
    /** The session goes on after the command: the next utterance is a new turn that is answered. */
    async function answersNextQuestion(): Promise<void> {
      const prior = await userMessageIds("A second question.");
      send(ownedGateway(), "finalSecond");
      await replyDone((await newUserMessage("A second question.", prior)).id);
      expect(errorFrames()).toEqual([]);
      expect(socket?.readyState).toBe(WebSocket.OPEN);
    }

    /**
     * Returns once the turn is running and its first sentence is being spoken. The model's first
     * text is held until the session watches the run: text deltas are live only, so one sent before
     * the watch exists would never be spoken.
     */
    async function startHeldTurn() {
      const owned = ownedGateway();
      const prior = await userMessageIds("A spoken question.");
      await openSession();
      let subscription: Promise<unknown> | undefined;
      restoreSubscribe = overrideSubscribe((original) => (input) => (subscription = original(input)));
      send(owned, "holdSpeech");
      speechHeld = true;
      send(owned, "holdModel");
      modelHeld = true;
      const armedBefore = countOf(owned, "firstTextArmed");
      const heldBefore = countOf(owned, "firstTextHeld");
      send(owned, "holdFirstText");
      await vi.waitFor(() => expect(countOf(owned, "firstTextArmed")).toBe(armedBefore + 1));
      await say("A spoken question.");
      const source = await newUserMessage("A spoken question.", prior);
      await vi.waitFor(() => expect(countOf(owned, "firstTextHeld")).toBe(heldBefore + 1), { timeout: 20_000 });
      const assistant = await runningReply(source.id, expect.any(String));
      await vi.waitFor(() => expect(subscription).toBeDefined(), { timeout: 10_000 });
      await subscription;
      const request = ++releaseRequest;
      send(owned, "releaseFirstText", { request });
      await vi.waitFor(() =>
        expect(
          owned.messages.some(
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
        const { source, assistant } = await startHeldTurn();
        const stopped = () =>
          frames.filter((frame) => JSON.stringify(frame) === '{"type":"speaking","state":"stopped"}');
        const stoppedBefore = stopped().length;
        const messagesBefore = await userTexts(source.thread_id);

        await say(command);

        await replyCancelled(source.id, assistant.id);
        await vi.waitFor(() => expect(stopped()).toHaveLength(stoppedBefore + 1));
        const audioAtStop = audioFrames;
        expect(await userTexts(source.thread_id)).toEqual(messagesBefore);
        expect(
          await count("SELECT count(*)::int AS count FROM semp_messages WHERE lower(text) = lower($1)", [command]),
        ).toBe(0);
        expect(cancels).toEqual([{ tenantId: tenant, assistantMessageId: assistant.id }]);
        const run = await runInTenant(tenant, () =>
          pool.query<{ status: string; error_code: string | null }>(
            "SELECT status, error_code FROM agent_runs WHERE id = $1",
            [assistant.agent_run_id],
          ),
        );
        expect(run.rows).toEqual([{ status: "error", error_code: "cancelled" }]);

        // The session survives the command: the next utterance is answered and spoken.
        release("model");
        release("speech");
        await answersNextQuestion();
        await vi.waitFor(() => expect(audioFrames).toBeGreaterThan(audioAtStop), { timeout: 10_000 });
        expect(cancels).toHaveLength(1);
      },
      70_000,
    );

    it("stores a sentence that only contains a stop word as a message and cancels nothing", async () => {
      const { source, assistant } = await startHeldTurn();

      await say("stop the music");

      const stored = await vi.waitFor(async () => {
        const messages = await userTexts(source.thread_id);
        expect(messages.map((row) => row.text)).toEqual(["A spoken question.", "stop the music"]);
        return messages[1]!;
      });
      expect(stored.source).toBe("voice");
      expect((await assistantFor(stored.id)).rows).toMatchObject([{ status: "queued" }]);
      // The running turn is untouched and finishes once the model answers.
      expect((await assistantFor(source.id)).rows).toMatchObject([{ id: assistant.id, status: "running" }]);
      release("model");
      release("speech");
      await replyDone(source.id);
      await replyDone(stored.id);
      expect(cancels).toEqual([]);
    }, 70_000);

    it("ends the turn quietly when the command lands before the turn has a run, and the session goes on", async () => {
      const prior = await userMessageIds("A spoken question.");
      await openSession();
      // The turn handler reads the system settings between claiming the reply and starting its run,
      // so with the table locked the reply stays `running` without a run.
      const lock = await admin.connect();
      let locked = false;
      let source: { id: string };
      let assistant: { id: string };
      try {
        await lock.query("BEGIN");
        await lock.query("LOCK TABLE databases IN ACCESS EXCLUSIVE MODE");
        locked = true;
        send(ownedGateway(), "final");
        source = await newUserMessage("A spoken question.", prior);
        assistant = await runningReply(source.id, null);

        await say("Stop");

        await vi.waitFor(() => expect(cancels).toEqual([{ tenantId: tenant, assistantMessageId: assistant.id }]), {
          timeout: 10_000,
        });
      } finally {
        if (locked) await lock.query("ROLLBACK");
        else await lock.query("ROLLBACK").catch(() => undefined);
        lock.release();
      }
      await replyCancelled(source.id, assistant.id);
      expect((await assistantFor(source.id)).rows[0]?.agent_run_id).toBeNull();

      await answersNextQuestion();
      expect(cancels).toHaveLength(1);
    }, 70_000);

    it("ends the turn quietly when the command lands before the run watch starts, and the session goes on", async () => {
      const prior = await userMessageIds("A spoken question.");
      await openSession();
      let reached = false;
      let openWatch!: () => void;
      const watchOpen = new Promise<void>((resolveWatch) => {
        openWatch = resolveWatch;
      });
      // The session has found the run of the reply and is about to watch it: the watch waits here for the command.
      restoreSubscribe = overrideSubscribe((original) => async (input) => {
        reached = true;
        await watchOpen;
        return original(input);
      });
      send(ownedGateway(), "holdModel");
      modelHeld = true;
      try {
        send(ownedGateway(), "final");
        const source = await newUserMessage("A spoken question.", prior);
        const assistant = await runningReply(source.id, expect.any(String));
        await vi.waitFor(() => expect(reached).toBe(true), { timeout: 10_000 });

        await say("Stop");

        await replyCancelled(source.id, assistant.id);
        expect(cancels).toEqual([{ tenantId: tenant, assistantMessageId: assistant.id }]);
      } finally {
        openWatch();
      }

      release("model");
      await answersNextQuestion();
    }, 70_000);

    it.each([
      {
        cause: "the reply ends as an error other than a cancellation",
        fail: async (_assistantId: string) => {
          send(ownedGateway(), "failModel");
          modelHeld = false;
        },
        reply: (assistantId: string) => ({
          id: assistantId,
          status: "error",
          error_code: expect.stringMatching(/^(?!cancelled$)/),
        }),
        cancelled: false,
      },
      {
        // Another cause of a cancellation, such as a deactivated tenant: the notification comes from outside the session.
        cause: "the turn is cancelled and this session did not ask for it",
        fail: (assistantId: string) =>
          runInTenant(tenant, () =>
            withTransaction(pool, (client) =>
              requestSempTurnCancel(client, { tenantId: tenant, assistantMessageId: assistantId }),
            ),
          ),
        reply: (assistantId: string) => ({ id: assistantId, status: "error", error_code: "cancelled" }),
        cancelled: true,
      },
    ])(
      "fails the session as unavailable when $cause",
      async ({ fail, reply, cancelled }) => {
        const { source, assistant } = await startHeldTurn();
        const closed = once(socket!, "close");

        await fail(assistant.id);

        await vi.waitFor(
          async () => expect((await assistantFor(source.id)).rows).toMatchObject([reply(assistant.id)]),
          {
            timeout: 20_000,
          },
        );
        await vi.waitFor(() => expect(errorFrames()).toEqual([{ type: "error", code: "unavailable" }]), {
          timeout: 10_000,
        });
        await closed;
        expect(cancels).toEqual(cancelled ? [{ tenantId: tenant, assistantMessageId: assistant.id }] : []);
      },
      70_000,
    );

    it("fails the session as unavailable when the lookup of the running turn fails, and cancels nothing", async () => {
      const prior = await userMessageIds("A spoken question.");
      await openSession();
      send(ownedGateway(), "final");
      await replyDone((await newUserMessage("A spoken question.", prior)).id);
      // The runtime role reads `semp_messages` through `alldots_side`, which loses the privilege
      // for the length of the command, making the stop command's lookup fail; no other case runs
      // meanwhile.
      await admin.query("REVOKE SELECT ON semp_messages FROM alldots_side");
      try {
        const privilege = await admin.query<{ allowed: boolean }>(
          "SELECT has_table_privilege('alldots_data', 'semp_messages', 'SELECT') AS allowed",
        );
        expect(privilege.rows).toEqual([{ allowed: false }]);
        const closed = once(socket!, "close");

        await say("Stop");

        await vi.waitFor(() => expect(frames).toContainEqual({ type: "error", code: "unavailable" }), {
          timeout: 10_000,
        });
        await closed;
      } finally {
        await admin.query("GRANT SELECT ON semp_messages TO alldots_side");
      }
      expect(cancels).toEqual([]);
    });

    it("does nothing for a stop command when no turn is running: before the first message and after a finished turn", async () => {
      const messagesBefore = await count("SELECT count(*)::int AS count FROM semp_messages");
      const prior = await userMessageIds("A spoken question.");
      await openSession();

      await say("Stop");
      send(ownedGateway(), "final");
      const source = await newUserMessage("A spoken question.", prior);
      await replyDone(source.id);
      await say("zruš");
      send(ownedGateway(), "finalSecond");
      await vi.waitFor(
        async () =>
          expect((await userTexts(source.thread_id)).map((row) => row.text)).toEqual([
            "A spoken question.",
            "A second question.",
          ]),
        { timeout: 10_000 },
      );

      // A session's admissions run in order, so both commands were handled before the second
      // question was stored.
      expect(cancels).toEqual([]);
      // Two user messages and their two replies: nothing for either command.
      expect((await count("SELECT count(*)::int AS count FROM semp_messages"))! - messagesBefore!).toBe(4);
      await vi.waitFor(
        async () => {
          const replies = await runInTenant(tenant, () =>
            pool.query<{ status: string }>(
              "SELECT status FROM semp_messages WHERE thread_id = $1 AND role = 'assistant'",
              [source.thread_id],
            ),
          );
          expect(replies.rows).toEqual([{ status: "done" }, { status: "done" }]);
        },
        { timeout: 30_000 },
      );
    }, 70_000);
  });

  describe("speech attribution", () => {
    const speechCalls = async () =>
      (
        await runInTenant(tenant, () =>
          pool.query<{
            id: string;
            operation: string;
            status: string;
            agent_run_id: string | null;
            semp_message_id: string | null;
          }>(
            `SELECT id::text, operation, status, agent_run_id, semp_message_id FROM ai_gateway_calls
           WHERE operation IN ('voice_transcribe_stream', 'voice_synthesize') ORDER BY id`,
          ),
        )
      ).rows;

    it("attributes the speech-to-text rows of a spoken question and the text-to-speech rows of its answer to the turn, and the reply's usage includes them", async () => {
      const priorCalls = new Set((await speechCalls()).map((row) => row.id));
      const prior = await userMessageIds("A spoken question.");
      await openSession();

      send(ownedGateway(), "final");
      const source = await newUserMessage("A spoken question.", prior);
      const assistant = await vi.waitFor(
        async () => {
          const result = await assistantFor(source.id);
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

      const added = (await speechCalls()).filter((row) => !priorCalls.has(row.id));
      const spoken = added.filter((row) => row.operation === "voice_synthesize");
      const heard = added.filter((row) => row.operation === "voice_transcribe_stream");
      expect(spoken.length).toBeGreaterThan(0);
      // The answer carries the run and the assistant message; the question carries the message alone.
      for (const row of spoken) expect(row).toMatchObject({ agent_run_id: runId, semp_message_id: assistant.id });
      expect(heard).toMatchObject([{ agent_run_id: null, semp_message_id: assistant.id }]);

      const usage = await runInTenant(tenant, () =>
        withTransaction(pool, (client) => getAgentRunUsage(client, runId, "en", assistant.id)),
      );
      const counted = await count(
        "SELECT count(*)::int AS count FROM ai_gateway_calls WHERE semp_message_id = $1 AND status <> 'failed'",
        [assistant.id],
      );
      expect(counted).toBeGreaterThanOrEqual(spoken.length + heard.length + 1);
      expect(usage.perModel.reduce((sum, model) => sum + model.callCount, 0)).toBe(counted);
      expect(usage.perModel.map((model) => model.model)).toEqual(
        expect.arrayContaining(["gpt-4o-transcribe", "gpt-4o-mini-tts"]),
      );
    }, 70_000);

    it("leaves the speech-to-text row of speech that never becomes a message unattributed, and speaks nothing", async () => {
      const priorCalls = new Set((await speechCalls()).map((row) => row.id));
      const messagesBefore = await count("SELECT count(*)::int AS count FROM semp_messages");
      await openSession();

      // The stop command is handled on the session's admission queue; a second final that follows it is stored last.
      for (const text of ["Stop", "zruš"]) {
        send(ownedGateway(), "finalText", { text });
        await vi.waitFor(() => expect(frames).toContainEqual({ type: "transcript", text, final: true }), {
          timeout: 10_000,
        });
      }

      const added = (await speechCalls()).filter((row) => !priorCalls.has(row.id));
      expect(added).toMatchObject([
        { operation: "voice_transcribe_stream", agent_run_id: null, semp_message_id: null },
      ]);
      expect(await count("SELECT count(*)::int AS count FROM semp_messages")).toBe(messagesBefore);
    }, 30_000);
  });
});
