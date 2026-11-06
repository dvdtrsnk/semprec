import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { WebSocket } from "ws";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "@semprec/data/testSupport";
import { createUser, hashPassword, login, seedSystem } from "@semprec/data";
import { createSyncUpgradeHandler } from "../syncHandler.js";
import { createVoiceChannel, type VoiceChannel } from "../voiceChannel.js";
import { createVoiceSessionHandler } from "../voiceSessionHandler.js";

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
]);
type ChildMessage = z.infer<typeof childMessage>;
type OwnedChild = {
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
  let socket: WebSocket | undefined;
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
  function send(child: OwnedChild, type: string): void {
    if (!child.child.connected) throw new Error("Fixture child disconnected");
    child.child.send({ type });
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
    worker = await startChild(
      workerPath,
      {
        ...common,
        BATCH32_GATEWAY_PORT: String(ready.port),
        FILES_STORAGE_DIR: directory,
        MAIL_ATTACHMENTS_DIR: directory,
      },
      "worker",
    );
    sync = await createSyncUpgradeHandler(pool);
    voice = createVoiceChannel(pool, {
      handler: createVoiceSessionHandler(pool, { port: ready.port, token: "batch32-test-token" }, sync),
    });
    server = createServer();
    server.on("upgrade", (req, stream, head) => voice.handleUpgrade(req, stream, head));
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing voice listener");
    url = `ws://127.0.0.1:${address.port}/api/voice`;
  }, 90_000);
  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    socket?.terminate();
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
      if (!owned.settled && owned.child.connected) send(owned, "stop");
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          owned.exit,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("Fixture stop timed out")), 20_000);
          }),
        ]);
        if (result.error || result.code !== 0 || result.signal !== null)
          throw result.error ?? new Error("Fixture child failed");
        process.stderr.write(`voice fixture exit=${result.code} signal=${result.signal}\n`);
      } catch (error) {
        failures.push(error);
        if (!owned.settled) {
          owned.child.kill("SIGKILL");
          await owned.exit;
        }
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
    await stop(worker);
    await stop(gateway);
    if (pool) await cleanup(() => pool.end());
    if (admin) await cleanup(() => admin.end());
    if ((!worker || worker.settled) && (!gateway || gateway.settled)) {
      if (blockDir) await cleanup(() => rm(blockDir, { recursive: true, force: true }));
      if (directory) await cleanup(() => rm(directory, { recursive: true, force: true }));
    } else failures.push(new Error("Child settlement unknown; fixture files retained"));
    if (failures.length) throw new AggregateError(failures, "Voice fixture cleanup failed", { cause: failures[0] });
  }, 60_000);
  it("stores a trusted voice turn and streams a real worker answer before native provider completion", async () => {
    if (!gateway || !worker) throw new Error("Missing fixture child");
    socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    socket.on("message", (data, binary) => {
      if (binary) {
        audioFrames++;
        return;
      }
      const value: unknown = JSON.parse(data.toString());
      frames.push(value);
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ type: "start", language: "en" }));
    await vi.waitFor(() => expect(frames).toContainEqual({ type: "ready" }), { timeout: 10_000 });
    await vi.waitFor(() => expect(gateway?.messages.some((entry) => entry.type === "sttReady")).toBe(true), {
      timeout: 10_000,
    });
    send(gateway, "holdModel");
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
    let assistantId = "";
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
          expect(audioFrames).toBeGreaterThan(0);
        },
        { timeout: 20_000 },
      );
    } catch (error) {
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
      throw error;
    }
    expect(assistantId).not.toBe("");
    send(gateway, "partial");
    await vi.waitFor(() => expect(frames).toContainEqual({ type: "speaking", state: "stopped" }));
    send(gateway, "releaseModel");
    await vi.waitFor(
      async () => {
        const result = await runInTenant(tenant, () =>
          pool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id=$1", [assistantId]),
        );
        expect(result.rows[0]?.status).toBe("done");
      },
      { timeout: 20_000 },
    );
    const closed = once(socket, "close");
    socket.close();
    await closed;
    await vi.waitFor(
      async () => {
        const calls = await runInTenant(tenant, () =>
          pool.query<{ count: string }>("SELECT count(*)::text AS count FROM ai_gateway_calls WHERE status='reserved'"),
        );
        expect(calls.rows[0]?.count).toBe("0");
      },
      { timeout: 10_000 },
    );
  }, 70_000);
});
