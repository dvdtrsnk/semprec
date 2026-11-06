import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "@semprec/data/testSupport";
import {
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  sendSempMessage,
  storeMessageSpeech,
  withTransaction,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import { MESSAGE_SPEECH_VOICES } from "../sempSpeechHandler.js";

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const blockRoot = resolve(backend, "../shared/block-model");
const gatewayFixture = join(backend, "services/semprec-ai-gateway/dist/__tests__/fixtures/messageSpeechGateway.js");
const gatewaySource = join(backend, "services/semprec-ai-gateway/src/__tests__/fixtures/messageSpeechGateway.ts");
const fixtureMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("ready"), port: z.number().int().min(1).max(65535) }),
  z.strictObject({ type: z.literal("providerCall"), sequence: z.number().int().min(1).max(100) }),
  z.strictObject({ type: z.literal("mode"), mode: z.enum(["normal", "hold", "fail"]) }),
  z.strictObject({ type: z.literal("released") }),
]);

describe("message speech HTTP", () => {
  let admin: Pool;
  let pool: Pool;
  let server: Server;
  let directory: string;
  let storage: LocalFsBlobStorageWriter;
  let baseUrl: string;
  let tenant: string;
  let token: string;
  let child: ChildProcess | undefined;
  let childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }> | undefined;
  let childSettled = false;
  let blockDir: string | undefined;
  const messages: z.infer<typeof fixtureMessageSchema>[] = [];
  let invalidFrame = false;
  let outputBytes = 0;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "semprec-speech-test-"));
    storage = new LocalFsBlobStorageWriter(directory);
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:speech-role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenant = await createTestTenant(admin);
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: 100, monthlyCapUsd: 100 });
    const email = `${randomUUID()}@example.test`;
    await createUser(admin, { tenantId: tenant, email, passwordHash: await hashPassword("speech-password") });
    token = (await login(admin, { email, password: "speech-password", platform: "ios", ip: "127.0.0.1" })).token;
    if ((await stat(gatewayFixture)).mtimeMs < (await stat(gatewaySource)).mtimeMs)
      throw new Error("Stale speech gateway fixture build");
    blockDir = await mkdtemp(join(blockRoot, "node_modules/.batch09-"));
    const compilerArgs = [
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
    const compiled = spawnSync(process.execPath, compilerArgs, { cwd: backend, timeout: 25_000, maxBuffer: 1_000_000 });
    process.stderr.write(
      `speech block compiler pid=${compiled.pid} status=${compiled.status} signal=${compiled.signal} argv=${JSON.stringify([process.execPath, ...compilerArgs])}\n`,
    );
    if (compiled.error) throw compiled.error;
    if (compiled.status !== 0) throw new Error("Speech fixture block-model build failed");
    const blockEntry = join(blockDir, "index.js");
    const artifactHash = createHash("sha256")
      .update(await readFile(gatewayFixture))
      .digest("hex");
    const blockHash = createHash("sha256")
      .update(await readFile(blockEntry))
      .digest("hex");
    const databaseUrl = z.object({ connectionString: z.string() }).parse(pool.options).connectionString;
    child = spawn(process.execPath, [gatewayFixture], {
      cwd: backend,
      detached: true,
      env: { ...process.env, BATCH09_BLOCK_MODEL_ENTRY: blockEntry, BATCH32_GATEWAY_DATABASE_URL: databaseUrl },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const processOwner = child;
    if (!processOwner.pid) throw new Error("Speech gateway child did not start");
    childExit = new Promise((resolveExit) => {
      let processError: Error | undefined;
      processOwner.on("error", (error) => {
        processError = error;
      });
      processOwner.once("close", (code, signal) => {
        childSettled = true;
        resolveExit({ code, signal, ...(processError ? { error: processError } : {}) });
      });
    });
    const pgid = Number(
      execFileSync("ps", ["-o", "pgid=", "-p", String(processOwner.pid)], { encoding: "utf8" }).trim(),
    );
    if (pgid !== processOwner.pid) throw new Error("Unexpected speech gateway process group");
    process.stderr.write(
      `speech gateway argv=${JSON.stringify([process.execPath, gatewayFixture])} pid=${processOwner.pid} pgid=${pgid} sha256=${artifactHash} blockSha256=${blockHash}\n`,
    );
    for (const output of [processOwner.stdout, processOwner.stderr])
      output?.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > 100_000) invalidFrame = true;
      });
    processOwner.on("message", (message: unknown) => {
      const parsed = fixtureMessageSchema.safeParse(message);
      if (!parsed.success || messages.length >= 200 || JSON.stringify(message).length > 512) invalidFrame = true;
      else messages.push(parsed.data);
    });
    await vi.waitFor(
      () => {
        expect(invalidFrame).toBe(false);
        expect(messages.some((message) => message.type === "ready")).toBe(true);
      },
      { timeout: 10_000 },
    );
    const ready = messages.find((message) => message.type === "ready");
    if (!ready || ready.type !== "ready") throw new Error("Missing speech gateway readiness");
    const dispatch = await createDispatcher(pool, {
      passwordResetMailer: { async sendPasswordResetEmail() {} },
      appBaseUrl: "https://example.test",
      setupToken: "test",
      moduleRegistry: await loadFullModuleRegistry(),
      blobStorage: storage,
      maxFileSizeBytes: 1024,
      speechGateway: { port: ready.port, token: "batch32-test-token" },
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(async () => {
    const failures: unknown[] = [];
    const cleanup = async (action: () => Promise<void>) => {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    };
    if (server)
      await cleanup(
        () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
      );
    const waitForExit = async () => {
      if (!childExit) return;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          childExit,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Gateway child stop timed out")), 10_000);
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    };
    if (child && childExit && !childSettled) {
      try {
        child.send?.({ type: "stop" });
        await waitForExit();
      } catch (error) {
        failures.push(error);
        try {
          child.kill("SIGKILL");
        } catch (killError) {
          failures.push(killError);
        }
        await cleanup(waitForExit);
      }
    }
    if (childExit && childSettled) {
      const exit = await childExit;
      if (exit.error || exit.code !== 0 || exit.signal !== null)
        failures.push(exit.error ?? new Error("Speech gateway fixture failed"));
      process.stderr.write(`speech gateway exit=${exit.code} signal=${exit.signal}\n`);
    }
    if (pool) await cleanup(() => pool.end());
    if (admin) await cleanup(() => admin.end());
    if (!child || childSettled) {
      if (blockDir) await cleanup(() => rm(blockDir, { recursive: true, force: true }));
      if (directory) await cleanup(() => rm(directory, { recursive: true, force: true }));
    } else failures.push(new Error("Gateway child settlement unknown; fixture files retained"));
    if (failures.length) throw new AggregateError(failures, "Speech fixture cleanup failed");
  });

  async function turn(text: string) {
    return runInTenant(tenant, () =>
      withTransaction(pool, (client) => sendSempMessage(client, { text, context: [], hasContext: false })),
    );
  }
  async function cache(threadId: string, messageId: string, text: string, voice: string) {
    const storageKey = `${tenant}/blobs/${randomUUID()}`;
    await storage.writeStream(storageKey, Readable.from([Buffer.from("AB")]), { maxBytes: 2 });
    return runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        storeMessageSpeech(client, { threadId, messageId, text, voice, storageKey, byteSize: 2 }),
      ),
    );
  }
  function post(threadId: string, messageId: string, query = "", signal?: AbortSignal) {
    return fetch(`${baseUrl}/api/semp/threads/${threadId}/messages/${messageId}/speech${query}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      ...(signal ? { signal } : {}),
    });
  }
  function providerCalls(): number {
    return messages.filter((message) => message.type === "providerCall").length;
  }
  async function setMode(mode: "normal" | "hold" | "fail"): Promise<void> {
    if (!child?.connected) throw new Error("Speech gateway child unavailable");
    const position = messages.length;
    child.send({ type: "mode", mode });
    await vi.waitFor(
      () => {
        expect(invalidFrame).toBe(false);
        expect(messages.slice(position)).toContainEqual({ type: "mode", mode });
      },
      { timeout: 5000 },
    );
  }
  async function accounting() {
    return runInTenant(tenant, () =>
      pool.query<{ id: string; status: string; audio_seconds: string | null }>(
        "SELECT id::text, status, audio_seconds FROM ai_gateway_calls WHERE operation = 'voice_synthesize' ORDER BY id",
      ),
    );
  }
  async function withCleanup(action: () => Promise<void>, cleanup: () => Promise<void>): Promise<void> {
    let outcome: { ok: true } | { ok: false; error: unknown };
    try {
      await action();
      outcome = { ok: true };
    } catch (error) {
      outcome = { ok: false, error };
    }
    try {
      await cleanup();
    } catch (error) {
      if (!outcome.ok)
        throw new AggregateError([outcome.error, error], "Speech test and cleanup failed", { cause: error });
      throw error;
    }
    if (!outcome.ok)
      throw outcome.error instanceof Error ? outcome.error : new Error("Speech test failed", { cause: outcome.error });
  }

  it("uses the real gateway accounting on a miss and makes no new call on a cache hit", async () => {
    const value = await turn("First speech request");
    const before = await accounting();
    const priorCalls = providerCalls();
    const first = await post(value.threadId, value.messageId);
    expect(first.status).toBe(200);
    expect(Buffer.from(await first.arrayBuffer())).toEqual(Buffer.alloc(480, 1));
    const after = await accounting();
    const newRows = after.rows.filter((row) => !before.rows.some((old) => old.id === row.id));
    expect(newRows).toHaveLength(1);
    expect(newRows[0]?.status).toBe("settled");
    expect(Number(newRows[0]?.audio_seconds)).toBeCloseTo(0.01, 6);
    await vi.waitFor(() => expect(providerCalls()).toBe(priorCalls + 1), { timeout: 5000 });
    const second = await post(value.threadId, value.messageId, "?voice=alloy");
    expect(second.status).toBe(200);
    expect(Buffer.from(await second.arrayBuffer())).toEqual(Buffer.alloc(480, 1));
    expect((await accounting()).rows).toEqual(after.rows);
    expect(providerCalls()).toBe(priorCalls + 1);
  });

  it("coalesces two overlapping requests through the real API, guard and gateway", async () => {
    const value = await turn("Concurrent speech");
    const before = await accounting();
    const calls = providerCalls();
    await setMode("hold");
    const originals = new Map<PoolClient, PoolClient["query"]>();
    const guardClients = new Set<PoolClient>();
    const instrument = (client: PoolClient) => {
      if (originals.has(client)) return;
      // The observer delegates every real query and is restored before the pool closes.
      /* eslint-disable @typescript-eslint/unbound-method */
      originals.set(client, client.query);
      client.query = new Proxy(client.query, {
        apply(target, receiver, args: unknown[]) {
          const result: unknown = Reflect.apply(target, receiver, args);
          if (typeof args[0] !== "string" || !args[0].includes("pg_try_advisory_lock")) return result;
          return Promise.resolve(result).then((value: unknown) => {
            guardClients.add(client);
            return value;
          });
        },
      });
      /* eslint-enable @typescript-eslint/unbound-method */
    };
    pool.on("acquire", instrument);
    const signal = AbortSignal.timeout(10_000);
    const first = post(value.threadId, value.messageId, "", signal);
    let second: Promise<Response> | undefined;
    let settled = Promise.allSettled([first]);
    let failure: unknown;
    let failed = false;
    try {
      await vi.waitFor(() => expect(providerCalls()).toBe(calls + 1), { timeout: 5000 });
      second = post(value.threadId, value.messageId, "", signal);
      settled = Promise.allSettled([first, second]);
      await vi.waitFor(() => expect(guardClients.size).toBe(2), { timeout: 5000 });
      await vi.waitFor(() => expect(providerCalls()).toBe(calls + 1), { timeout: 5000 });
      if (!child?.connected) throw new Error("Speech gateway child unavailable");
      child.send({ type: "release" });
      const outcomes = await settled;
      for (const outcome of outcomes) {
        if (outcome.status === "rejected")
          throw outcome.reason instanceof Error
            ? outcome.reason
            : new Error("Speech request failed", { cause: outcome.reason });
        expect(outcome.value.status).toBe(200);
        expect(Buffer.from(await outcome.value.arrayBuffer())).toEqual(Buffer.alloc(480, 1));
      }
      const after = await accounting();
      const newRows = after.rows.filter((row) => !before.rows.some((old) => old.id === row.id));
      expect(newRows).toHaveLength(1);
      expect(newRows[0]?.status).toBe("settled");
      expect(providerCalls()).toBe(calls + 1);
    } catch (error) {
      failed = true;
      failure = error;
    }
    const cleanupFailures: unknown[] = [];
    try {
      if (child?.connected) child.send({ type: "release" });
      await settled;
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      pool.off("acquire", instrument);
      for (const [client, query] of originals) client.query = query;
      await setMode("normal");
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (failed || cleanupFailures.length)
      throw new AggregateError(
        [...(failed ? [failure] : []), ...cleanupFailures],
        "Concurrent speech test or cleanup failed",
      );
  });

  it("maps the real gateway budget refusal without a provider call or cache entry", async () => {
    const value = await turn("Budget refusal");
    const before = await accounting();
    const calls = providerCalls();
    await setTenantAiBudget(admin, tenant, { dailyCapUsd: 0, monthlyCapUsd: 0 });
    await withCleanup(
      async () => {
        const response = await post(value.threadId, value.messageId);
        expect(response.status).toBe(403);
        expect(await response.json()).toEqual({ error: { code: "budget_exceeded" } });
        expect(providerCalls()).toBe(calls);
        expect((await accounting()).rows).toEqual(before.rows);
        const cacheRows = await runInTenant(tenant, () =>
          pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM semp_message_speech WHERE message_id = $1",
            [value.messageId],
          ),
        );
        expect(cacheRows.rows).toEqual([{ count: 0 }]);
      },
      () => setTenantAiBudget(admin, tenant, { dailyCapUsd: 100, monthlyCapUsd: 100 }),
    );
  });

  it("does not mislabel a provider failure as budget exhaustion or cache success", async () => {
    const value = await turn("Provider failure");
    const before = await accounting();
    const calls = providerCalls();
    await setMode("fail");
    await withCleanup(
      async () => {
        const response = await post(value.threadId, value.messageId);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: { code: "internal_error" } });
        await vi.waitFor(() => expect(providerCalls()).toBe(calls + 1), { timeout: 5000 });
        const after = await accounting();
        const newRows = after.rows.filter((row) => !before.rows.some((old) => old.id === row.id));
        expect(newRows).toHaveLength(1);
        expect(newRows[0]?.status).toBe("failed");
        const cacheRows = await runInTenant(tenant, () =>
          pool.query<{ count: number }>(
            "SELECT count(*)::int AS count FROM semp_message_speech WHERE message_id = $1",
            [value.messageId],
          ),
        );
        expect(cacheRows.rows).toEqual([{ count: 0 }]);
      },
      () => setMode("normal"),
    );
  });

  it("serves each pinned voice and treats absent voice as the same cached alloy", async () => {
    const value = await turn("Hello");
    for (const voice of MESSAGE_SPEECH_VOICES) await cache(value.threadId, value.messageId, "Hello", voice);
    for (const voice of MESSAGE_SPEECH_VOICES) {
      const response = await post(value.threadId, value.messageId, `?voice=${voice}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("audio/x-raw; format=S16LE; rate=24000; channels=1");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from("AB"));
    }
    const defaultVoice = await post(value.threadId, value.messageId);
    expect(defaultVoice.status).toBe(200);
    expect(Buffer.from(await defaultVoice.arrayBuffer())).toEqual(Buffer.from("AB"));
    const count = await runInTenant(tenant, () =>
      pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM semp_message_speech WHERE message_id = $1 AND voice = 'alloy'",
        [value.messageId],
      ),
    );
    expect(count.rows).toEqual([{ count: 1 }]);
  });

  it("rejects empty, unknown, case-changed and repeated voices without cache effects", async () => {
    const value = await turn("Hello");
    for (const query of ["?voice=", "?voice=unknown", "?voice=Alloy", "?voice=alloy&voice=alloy"]) {
      const response = await post(value.threadId, value.messageId, query);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "validation_failed", details: { field: "voice" } } });
    }
    const count = await runInTenant(tenant, () =>
      pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_message_speech WHERE message_id = $1", [
        value.messageId,
      ]),
    );
    expect(count.rows).toEqual([{ count: 0 }]);
  });

  it("accepts 3999 and 4000 UTF-16 units and rejects 4001 before cache effects", async () => {
    for (const text of ["x".repeat(3999), "x".repeat(4000), `${"x".repeat(3998)}😀`]) {
      const value = await turn(text);
      await cache(value.threadId, value.messageId, text, "alloy");
      const response = await post(value.threadId, value.messageId);
      expect(response.status).toBe(200);
      await response.arrayBuffer();
    }
    for (const text of ["x".repeat(4001), `${"x".repeat(3999)}😀`]) {
      const value = await turn(text);
      const effects = () =>
        runInTenant(tenant, async () => ({
          blobs: (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM blobs")).rows,
          calls: (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM ai_gateway_calls")).rows,
        }));
      const before = await effects();
      const response = await post(value.threadId, value.messageId);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "validation_failed", details: { field: "messageId" } } });
      const count = await runInTenant(tenant, () =>
        pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_message_speech WHERE message_id = $1", [
          value.messageId,
        ]),
      );
      expect(count.rows).toEqual([{ count: 0 }]);
      expect(await effects()).toEqual(before);
    }
  });
});
