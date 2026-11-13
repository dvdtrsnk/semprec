import { createServer, type Server } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolClient } from "pg";
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
  claimSempMessage,
  createAgentRun,
  createUser,
  finishSempMessageTurn,
  getMessageSpeech,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  sendSempMessage,
  startSempMessageTurn,
  storeMessageSpeech,
  withMessageSpeechGuard,
  withTransaction,
} from "@semprec/data";
import { createDispatcher } from "../app.js";
import { MESSAGE_SPEECH_VOICES } from "../sempSpeechHandler.js";
import { logger } from "../logger.js";

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

type QueryDescriptors = Map<PoolClient, PropertyDescriptor | undefined>;

function watchQueryReleases(pool: Pool, active: QueryDescriptors) {
  const errors: unknown[] = [];
  const retirements: Promise<void>[] = [];
  const onRelease = (_error: Error | undefined, client: PoolClient): void => {
    if (!active.has(client)) return;
    const descriptor = active.get(client);
    try {
      if (descriptor) Object.defineProperty(client, "query", descriptor);
      else if (!Reflect.deleteProperty(client, "query")) throw new Error("Cannot restore query descriptor");
      active.delete(client);
    } catch (error) {
      errors.push(error);
      // A public end() immediately retires this client; observe its actual settlement.
      try {
        const retirement = client.end().then(
          () => {
            active.delete(client);
          },
          (endError: unknown) => {
            errors.push(endError);
          },
        );
        retirements.push(retirement);
      } catch (endError) {
        errors.push(endError);
      }
    }
  };
  pool.on("release", onRelease);
  return { errors, retirements, onRelease };
}

async function finishQueryObserver(
  pool: Pool,
  active: QueryDescriptors,
  instrument: (client: PoolClient) => void,
  observedQueries: Promise<unknown>[],
  releaseObserver: ReturnType<typeof watchQueryReleases>,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await Promise.all(observedQueries);
  } catch (error) {
    errors.push(error);
  }
  try {
    await vi.waitFor(() => expect(active.size).toBe(0), { timeout: 5000 });
  } catch (error) {
    errors.push(error);
  }
  if (active.size === 0) {
    pool.off("acquire", instrument);
    pool.off("release", releaseObserver.onRelease);
  }
  try {
    await Promise.all(releaseObserver.retirements);
  } catch (error) {
    errors.push(error);
  }
  errors.push(...releaseObserver.errors);
  if (errors.length) throw new AggregateError(errors, "Query observer restoration failed", { cause: errors[0] });
}

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
      if (blockDir) {
        const ownedBlockDir = blockDir;
        await cleanup(() => rm(ownedBlockDir, { recursive: true, force: true }));
      }
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
  async function attribution() {
    return runInTenant(tenant, () =>
      pool.query<{ id: string; status: string; agent_run_id: string | null; semp_message_id: string | null }>(
        "SELECT id::text, status, agent_run_id, semp_message_id FROM ai_gateway_calls WHERE operation = 'voice_synthesize' ORDER BY id",
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
        // The action failure remains primary; retain the caught cleanup failure in errors.
        // eslint-disable-next-line preserve-caught-error
        throw new AggregateError([outcome.error, error], "Speech test and cleanup failed", { cause: outcome.error });
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

  it("attributes the speech row of a read-aloud answer to the answer and the run that produced it, and a cache hit adds none", async () => {
    const run = await runInTenant(tenant, () => createAgentRun(pool, { triggeredBy: "user", task: "read aloud" }));
    const value = await turn("A question that has an answer");
    await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        expect(await claimSempMessage(client, value.threadId, value.assistantMessageId)).toBe(true);
        await startSempMessageTurn(client, value.assistantMessageId, run.id, "1");
        expect(
          await finishSempMessageTurn(client, value.assistantMessageId, {
            status: "done",
            text: "The answer that is read aloud.",
            lastEventId: "2",
          }),
        ).toBe(true);
      }),
    );
    const before = await attribution();

    const first = await post(value.threadId, value.assistantMessageId);
    expect(first.status).toBe(200);
    await first.arrayBuffer();

    const created = (await attribution()).rows.filter((row) => !before.rows.some((old) => old.id === row.id));
    expect(created).toMatchObject([
      { status: "settled", agent_run_id: run.id, semp_message_id: value.assistantMessageId },
    ]);
    const cached = await post(value.threadId, value.assistantMessageId);
    expect(cached.status).toBe(200);
    await cached.arrayBuffer();
    expect((await attribution()).rows).toHaveLength(before.rows.length + 1);
  });

  it("attributes the speech row of a message that belongs to no run to that message alone", async () => {
    const value = await turn("A question read aloud as it is");
    const before = await attribution();

    const response = await post(value.threadId, value.messageId);
    expect(response.status).toBe(200);
    await response.arrayBuffer();

    const created = (await attribution()).rows.filter((row) => !before.rows.some((old) => old.id === row.id));
    expect(created).toMatchObject([{ status: "settled", agent_run_id: null, semp_message_id: value.messageId }]);
  });

  it("synthesizes an uncached 4000-unit message exactly once through the real gateway", async () => {
    const value = await turn("x".repeat(4000));
    const before = await accounting();
    const calls = providerCalls();
    const response = await post(value.threadId, value.messageId);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.alloc(480, 1));
    const after = await accounting();
    const created = after.rows.filter((row) => !before.rows.some((old) => old.id === row.id));
    expect(created).toHaveLength(1);
    expect(created[0]?.status).toBe("settled");
    await vi.waitFor(() => expect(providerCalls()).toBe(calls + 1), { timeout: 5000 });
    const cached = await post(value.threadId, value.messageId);
    expect(cached.status).toBe(200);
    await cached.arrayBuffer();
    expect((await accounting()).rows).toEqual(after.rows);
    expect(providerCalls()).toBe(calls + 1);
  });

  it("restores the exact query descriptor before a runtime client is reused", async () => {
    const owned = await createRuntimeRolePool(admin, "semprec_data");
    const active: QueryDescriptors = new Map();
    const observedQueries: Promise<unknown>[] = [];
    const releaseObserver = watchQueryReleases(owned, active);
    let originalDescriptor: PropertyDescriptor | undefined;
    let originalQuery: PoolClient["query"] | undefined;
    const instrument = (client: PoolClient) => {
      if (active.has(client)) return;
      originalDescriptor = Object.getOwnPropertyDescriptor(client, "query");
      /* eslint-disable @typescript-eslint/unbound-method */
      originalQuery = client.query;
      active.set(client, originalDescriptor);
      client.query = new Proxy(client.query, {
        apply(target, receiver, args: unknown[]) {
          const result: unknown = Reflect.apply(target, receiver, args);
          if (result instanceof Promise)
            observedQueries.push(
              result.then(
                () => undefined,
                () => undefined,
              ),
            );
          return result;
        },
      });
      /* eslint-enable @typescript-eslint/unbound-method */
    };
    owned.on("acquire", instrument);
    let first: PoolClient | undefined;
    let firstReleased = false;
    let second: PoolClient | undefined;
    let failure: unknown;
    let failed = false;
    const cleanup: unknown[] = [];
    try {
      first = await runInTenant(tenant, () => owned.connect());
      expect((await first.query<{ value: number }>("SELECT 1::int AS value")).rows).toEqual([{ value: 1 }]);
      firstReleased = true;
      first.release();
      await vi.waitFor(() => expect(active.size).toBe(0), { timeout: 5000 });
      await finishQueryObserver(owned, active, instrument, observedQueries, releaseObserver);
      second = await runInTenant(tenant, () => owned.connect());
      expect(second).toBe(first);
      expect(Object.getOwnPropertyDescriptor(second, "query")).toEqual(originalDescriptor);
      /* eslint-disable @typescript-eslint/unbound-method */
      expect(second.query).toBe(originalQuery);
      /* eslint-enable @typescript-eslint/unbound-method */
      expect((await second.query<{ value: number }>("SELECT 2::int AS value")).rows).toEqual([{ value: 2 }]);
      const last = second;
      second = undefined;
      last.release();
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      if (first && !firstReleased) first.release(true);
    } catch (error) {
      cleanup.push(error);
    }
    try {
      second?.release(true);
    } catch (error) {
      cleanup.push(error);
    }
    try {
      await owned.end();
    } catch (error) {
      cleanup.push(error);
    }
    if (failed || cleanup.length)
      throw new AggregateError([...(failed ? [failure] : []), ...cleanup], "Observer reuse test or cleanup failed", {
        cause: failed ? failure : cleanup[0],
      });
  });

  it("coalesces two overlapping requests through the real API, guard and gateway", async () => {
    const value = await turn("Concurrent speech");
    const before = await accounting();
    const calls = providerCalls();
    await setMode("hold");
    const originals = new Map<PoolClient, PropertyDescriptor | undefined>();
    const observedQueries: Promise<unknown>[] = [];
    const releaseObserver = watchQueryReleases(pool, originals);
    const guardClients = new Set<PoolClient>();
    const instrument = (client: PoolClient) => {
      if (originals.has(client)) return;
      // The observer delegates every real query and is restored before the pool closes.
      /* eslint-disable @typescript-eslint/unbound-method */
      originals.set(client, Object.getOwnPropertyDescriptor(client, "query"));
      client.query = new Proxy(client.query, {
        apply(target, receiver, args: unknown[]) {
          const result: unknown = Reflect.apply(target, receiver, args);
          if (result instanceof Promise)
            observedQueries.push(
              result.then(
                () => undefined,
                () => undefined,
              ),
            );
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
    let settled: Promise<PromiseSettledResult<Response>[]> = Promise.allSettled([first]);
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
      await finishQueryObserver(pool, originals, instrument, observedQueries, releaseObserver);
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
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

  it("uniformly refuses an own message paired with the wrong thread without effects", async () => {
    const first = await turn("First thread");
    const second = await turn("Second thread");
    const beforeCalls = await accounting();
    const beforeProvider = providerCalls();
    const before = await runInTenant(tenant, async () => ({
      blobs: (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM blobs")).rows,
      cache: (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_message_speech")).rows,
    }));
    const wrong = await post(first.threadId, second.messageId);
    const missing = await post(first.threadId, randomUUID());
    expect(wrong.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(await wrong.json()).toEqual(await missing.json());
    expect(providerCalls()).toBe(beforeProvider);
    expect((await accounting()).rows).toEqual(beforeCalls.rows);
    const after = await runInTenant(tenant, async () => ({
      blobs: (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM blobs")).rows,
      cache: (await pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_message_speech")).rows,
    }));
    expect(after).toEqual(before);
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

  it("returns failure when provider and owned filesystem cleanup both fail", async () => {
    const value = await turn("Provider and cleanup failure");
    const before = await accounting();
    const calls = providerCalls();
    const blobDirectory = join(directory, tenant, "blobs");
    await mkdir(blobDirectory, { recursive: true });
    const originalMode = (await stat(blobDirectory)).mode & 0o777;
    await setMode("fail");
    const observedLog = vi.spyOn(logger, "error");
    await withCleanup(
      async () => {
        await chmod(blobDirectory, 0);
        await expect(readdir(blobDirectory)).rejects.toMatchObject({ code: "EACCES" });
        const response = await post(value.threadId, value.messageId);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: { code: "internal_error" } });
        expect(observedLog).toHaveBeenCalledWith({ errorName: "AggregateError" }, "Speech request failed");
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
      async () => {
        observedLog.mockRestore();
        const failures: unknown[] = [];
        try {
          await chmod(blobDirectory, originalMode);
        } catch (error) {
          failures.push(error);
        }
        try {
          await setMode("normal");
        } catch (error) {
          failures.push(error);
        }
        if (failures.length)
          throw new AggregateError(failures, "Speech fixture restoration failed", { cause: failures[0] });
      },
    );
  });

  it("rolls back a late final callback after a synthetic deadline signal", async () => {
    const value = await turn("Late speech");
    const beforeBlobs = await runInTenant(tenant, () =>
      pool.query<{ count: number }>("SELECT count(*)::int AS count FROM blobs"),
    );
    const beforeFiles = (await readdir(directory, { recursive: true })).sort();
    const deadline = new AbortController();
    const originalTimeout = AbortSignal.timeout.bind(AbortSignal);
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockImplementation((milliseconds) =>
        milliseconds === 300_000 ? deadline.signal : originalTimeout(milliseconds),
      );
    const originals = new Map<PoolClient, PropertyDescriptor | undefined>();
    const observedQueries: Promise<unknown>[] = [];
    const releaseObserver = watchQueryReleases(pool, originals);
    let release!: () => void;
    const proceed = new Promise<void>((resolve) => {
      release = resolve;
    });
    let intercepted = false;
    let observed = false;
    const instrument = (client: PoolClient) => {
      if (originals.has(client)) return;
      /* eslint-disable @typescript-eslint/unbound-method */
      originals.set(client, Object.getOwnPropertyDescriptor(client, "query"));
      client.query = new Proxy(client.query, {
        apply(target, receiver, args: unknown[]) {
          const result: unknown = Reflect.apply(target, receiver, args);
          if (result instanceof Promise)
            observedQueries.push(
              result.then(
                () => undefined,
                () => undefined,
              ),
            );
          if (intercepted || typeof args[0] !== "string" || !args[0].includes("INSERT INTO semp_message_speech"))
            return result;
          intercepted = true;
          return Promise.resolve(result).then(async (actual: unknown) => {
            observed = true;
            await proceed;
            return actual;
          });
        },
      });
      /* eslint-enable @typescript-eslint/unbound-method */
    };
    pool.on("acquire", instrument);
    const request = post(value.threadId, value.messageId, "", originalTimeout(10_000));
    const settled = Promise.allSettled([request]);
    let failure: unknown;
    let failed = false;
    try {
      await vi.waitFor(() => expect(observed).toBe(true), { timeout: 5000 });
      deadline.abort(new Error("Synthetic deadline"));
      release();
      const outcomes = await settled;
      const response = outcomes[0];
      if (!response || response.status === "rejected") throw new Error("Speech request did not return");
      expect(response.value.status).toBe(500);
      await response.value.arrayBuffer();
      const rows = await runInTenant(tenant, () =>
        pool.query<{ count: number }>("SELECT count(*)::int AS count FROM semp_message_speech WHERE message_id = $1", [
          value.messageId,
        ]),
      );
      expect(rows.rows).toEqual([{ count: 0 }]);
      expect(
        (await runInTenant(tenant, () => pool.query<{ count: number }>("SELECT count(*)::int AS count FROM blobs")))
          .rows,
      ).toEqual(beforeBlobs.rows);
      expect((await readdir(directory, { recursive: true })).sort()).toEqual(beforeFiles);
    } catch (error) {
      failed = true;
      failure = error;
    }
    const cleanup: unknown[] = [];
    try {
      release();
      await settled;
    } catch (error) {
      cleanup.push(error);
    }
    try {
      await finishQueryObserver(pool, originals, instrument, observedQueries, releaseObserver);
    } catch (error) {
      cleanup.push(error);
    }
    try {
      timeoutSpy.mockRestore();
    } catch (error) {
      cleanup.push(error);
    }
    if (failed || cleanup.length)
      throw new AggregateError([...(failed ? [failure] : []), ...cleanup], "Deadline test or cleanup failed", {
        cause: failed ? failure : cleanup[0],
      });
  });

  it("retains committed audio after a synthetic lost COMMIT acknowledgement", async () => {
    const value = await turn("Lost acknowledgement");
    const calls = providerCalls();
    const originals = new Map<PoolClient, PropertyDescriptor | undefined>();
    const observedQueries: Promise<unknown>[] = [];
    const releaseObserver = watchQueryReleases(pool, originals);
    const writers = new Set<PoolClient>();
    let injected = false;
    const instrument = (client: PoolClient) => {
      if (originals.has(client)) return;
      /* eslint-disable @typescript-eslint/unbound-method */
      originals.set(client, Object.getOwnPropertyDescriptor(client, "query"));
      client.query = new Proxy(client.query, {
        apply(target, receiver, args: unknown[]) {
          const result: unknown = Reflect.apply(target, receiver, args);
          if (result instanceof Promise)
            observedQueries.push(
              result.then(
                () => undefined,
                () => undefined,
              ),
            );
          if (typeof args[0] !== "string") return result;
          if (args[0].includes("INSERT INTO semp_message_speech")) {
            return Promise.resolve(result).then((actual: unknown) => {
              writers.add(client);
              return actual;
            });
          }
          if (!injected && writers.has(client) && args[0] === "COMMIT") {
            injected = true;
            return Promise.resolve(result).then(() => {
              throw new Error("Synthetic lost COMMIT acknowledgement");
            });
          }
          return result;
        },
      });
      /* eslint-enable @typescript-eslint/unbound-method */
    };
    pool.on("acquire", instrument);
    let failure: unknown;
    let failed = false;
    try {
      const response = await post(value.threadId, value.messageId);
      expect(response.status).toBe(500);
      await response.arrayBuffer();
      expect(injected).toBe(true);
      const blob = await runInTenant(tenant, () =>
        withTransaction(pool, (client) => getMessageSpeech(client, value.messageId, "alloy")),
      );
      if (!blob) throw new Error("Committed cache was not retained");
      expect(await readFile(join(directory, blob.storageKey))).toEqual(Buffer.alloc(480, 1));
      const cached = await post(value.threadId, value.messageId);
      expect(cached.status).toBe(200);
      expect(Buffer.from(await cached.arrayBuffer())).toEqual(Buffer.alloc(480, 1));
      await vi.waitFor(() => expect(providerCalls()).toBe(calls + 1), { timeout: 5000 });
    } catch (error) {
      failed = true;
      failure = error;
    }
    let cleanup: { error: unknown } | undefined;
    try {
      await finishQueryObserver(pool, originals, instrument, observedQueries, releaseObserver);
    } catch (error) {
      cleanup = { error };
    }
    if (failed || cleanup)
      throw new AggregateError(
        [...(failed ? [failure] : []), ...(cleanup ? [cleanup.error] : [])],
        "Lost-ack test or cleanup failed",
        { cause: failed ? failure : cleanup?.error },
      );
  });

  it.each(["acquisition acknowledgement", "unlock acknowledgement"] as const)(
    "discards a plain pooled session after synthetic loss of the %s",
    async (fault) => {
      const databaseUrl = z.object({ connectionString: z.string() }).parse(pool.options).connectionString;
      const guardPool = new Pool({ connectionString: databaseUrl, max: 3 });
      const messageId = randomUUID();
      const key = `semp-message-speech:v1:${tenant.toLowerCase()}:${messageId}:alloy`;
      let guardPid: number | undefined;
      let releases = 0;
      let faulted = false;
      let worked = false;
      const instrument = (client: PoolClient) => {
        /* eslint-disable @typescript-eslint/unbound-method */
        client.release = new Proxy(client.release, {
          apply(target, receiver, args: unknown[]) {
            releases += 1;
            return Reflect.apply(target, receiver, args);
          },
        });
        client.query = new Proxy(client.query, {
          apply(target, receiver, args: unknown[]) {
            const result: unknown = Reflect.apply(target, receiver, args);
            const targetSql = fault === "acquisition acknowledgement" ? "pg_try_advisory_lock" : "pg_advisory_unlock";
            if (faulted || typeof args[0] !== "string" || !args[0].includes(targetSql)) return result;
            faulted = true;
            return Promise.resolve(result).then(async (actual: unknown) => {
              const expected = fault === "acquisition acknowledgement" ? "acquired" : "released";
              const parsed = z.object({ rows: z.array(z.record(z.string(), z.unknown())) }).parse(actual);
              expect(parsed.rows[0]?.[expected]).toBe(true);
              const pid = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
              guardPid = pid.rows[0]?.pid;
              throw new Error(`Synthetic lost ${fault}`);
            });
          },
        });
        /* eslint-enable @typescript-eslint/unbound-method */
      };
      /* eslint-disable @typescript-eslint/unbound-method */
      const originalConnect = guardPool.connect;
      guardPool.connect = new Proxy(originalConnect, {
        apply(target, receiver, args: unknown[]) {
          const result: Promise<PoolClient> = Reflect.apply(target, receiver, args);
          return Promise.resolve(result).then((client: PoolClient) => {
            instrument(client);
            return client;
          });
        },
      });
      /* eslint-enable @typescript-eslint/unbound-method */
      let failure: unknown;
      let failed = false;
      try {
        await expect(
          runInTenant(tenant, () =>
            withMessageSpeechGuard(guardPool, messageId, "alloy", AbortSignal.timeout(5000), async () => {
              worked = true;
            }),
          ),
        ).rejects.toThrow(`Synthetic lost ${fault}`);
        expect(faulted).toBe(true);
        expect(worked).toBe(fault === "unlock acknowledgement");
        expect(releases).toBe(1);
        if (guardPid === undefined) throw new Error("Missing observed guard PID");
        const pid = guardPid;
        const observer = await runInTenant(tenant, () => pool.connect());
        try {
          await vi.waitFor(
            async () => {
              const result = await observer.query<{ alive: boolean }>(
                "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE pid = $1) AS alive",
                [pid],
              );
              expect(result.rows[0]?.alive).toBe(false);
            },
            { timeout: 5000 },
          );
          const acquired = await observer.query<{ locked: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS locked",
            [key],
          );
          expect(acquired.rows[0]?.locked).toBe(true);
          const unlocked = await observer.query<{ unlocked: boolean }>(
            "SELECT pg_advisory_unlock(hashtextextended($1::text, 0)) AS unlocked",
            [key],
          );
          expect(unlocked.rows[0]?.unlocked).toBe(true);
        } finally {
          observer.release();
        }
      } catch (error) {
        failed = true;
        failure = error;
      }
      guardPool.connect = originalConnect;
      let cleanupFailure: unknown;
      try {
        await guardPool.end();
      } catch (error) {
        cleanupFailure = error;
      }
      if (failed && cleanupFailure !== undefined)
        throw new AggregateError([failure, cleanupFailure], "Guard fault and cleanup failed", { cause: failure });
      if (failed) throw failure instanceof Error ? failure : new Error("Guard fault test failed", { cause: failure });
      if (cleanupFailure !== undefined)
        throw cleanupFailure instanceof Error
          ? cleanupFailure
          : new Error("Guard pool cleanup failed", { cause: cleanupFailure });
    },
  );

  it.each([
    { fails: true, primary: undefined },
    { fails: true, primary: false },
    { fails: true, primary: 0 },
    { fails: false, primary: undefined },
  ])("preserves synthetic work and cleanup failure order: %s", async ({ fails, primary }) => {
    const databaseUrl = z.object({ connectionString: z.string() }).parse(pool.options).connectionString;
    const guardPool = new Pool({ connectionString: databaseUrl, max: 2 });
    const unlockFailure = new Error("Synthetic unlock failure");
    const releaseFailure = new Error("Synthetic release failure");
    let releases = 0;
    let listenersSettled = false;
    /* eslint-disable @typescript-eslint/unbound-method */
    const originalConnect = guardPool.connect;
    guardPool.connect = new Proxy(originalConnect, {
      apply(target, receiver, args: unknown[]) {
        const result: Promise<PoolClient> = Reflect.apply(target, receiver, args);
        return Promise.resolve(result).then((client: PoolClient) => {
          const errorListeners = client.listenerCount("error");
          const endListeners = client.listenerCount("end");
          client.query = new Proxy(client.query, {
            apply(query, queryReceiver, queryArgs: unknown[]) {
              const actual: unknown = Reflect.apply(query, queryReceiver, queryArgs);
              if (typeof queryArgs[0] !== "string" || !queryArgs[0].includes("pg_advisory_unlock")) return actual;
              return Promise.resolve(actual).then(() => {
                throw unlockFailure;
              });
            },
          });
          client.release = new Proxy(client.release, {
            apply(release, releaseReceiver, releaseArgs: unknown[]) {
              releases += 1;
              listenersSettled =
                client.listenerCount("error") === errorListeners && client.listenerCount("end") === endListeners;
              Reflect.apply(release, releaseReceiver, releaseArgs);
              throw releaseFailure;
            },
          });
          return client;
        });
      },
    });
    /* eslint-enable @typescript-eslint/unbound-method */
    try {
      let caught: unknown;
      try {
        await runInTenant(tenant, () =>
          withMessageSpeechGuard(guardPool, randomUUID(), "alloy", AbortSignal.timeout(5000), async () => {
            // Synthetic faults exercise preservation of non-Error thrown values.
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            if (fails) throw primary;
          }),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AggregateError);
      if (!(caught instanceof AggregateError)) throw new Error("Missing aggregate failure");
      expect(caught.errors).toEqual(fails ? [primary, unlockFailure, releaseFailure] : [unlockFailure, releaseFailure]);
      expect(caught.cause).toBe(fails ? primary : unlockFailure);
      expect(releases).toBe(1);
      expect(listenersSettled).toBe(true);
      guardPool.connect = originalConnect;
      await runInTenant(tenant, () =>
        withMessageSpeechGuard(guardPool, randomUUID(), "alloy", AbortSignal.timeout(5000), async () => undefined),
      );
    } finally {
      guardPool.connect = originalConnect;
      await guardPool.end();
    }
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
      const calls = providerCalls();
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
      expect(providerCalls()).toBe(calls);
    }
    for (const text of ["x".repeat(4001), `${"x".repeat(3999)}😀`]) {
      const original = "x".repeat(4000);
      const value = await turn(original);
      const cached = await cache(value.threadId, value.messageId, original, "alloy");
      // Synthetic historical state: only this source text changes after its real cache is created.
      await runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const updated = await client.query<{ id: string }>(
            "UPDATE semp_messages SET text = $1 WHERE id = $2 AND thread_id = $3 AND role = 'user' RETURNING id",
            [text, value.messageId, value.threadId],
          );
          expect(updated.rows).toEqual([{ id: value.messageId }]);
          expect(updated.rowCount).toBe(1);
        }),
      );
      const snapshot = () =>
        runInTenant(tenant, () =>
          withTransaction(pool, async (client) => ({
            blobs: (await client.query<{ row: unknown }>("SELECT to_jsonb(b) AS row FROM blobs b ORDER BY id")).rows,
            cache: (
              await client.query<{ row: unknown }>(
                "SELECT to_jsonb(s) AS row FROM semp_message_speech s ORDER BY message_id, voice",
              )
            ).rows,
            calls: (
              await client.query<{ row: unknown }>("SELECT to_jsonb(c) AS row FROM ai_gateway_calls c ORDER BY id")
            ).rows,
          })),
        );
      const before = await snapshot();
      const calls = providerCalls();
      const bytes = await readFile(join(directory, cached.blob.storageKey));
      const files = (await readdir(directory, { recursive: true })).sort();
      const response = await post(value.threadId, value.messageId);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: { code: "validation_failed", details: { field: "messageId" } } });
      expect(await snapshot()).toEqual(before);
      expect(providerCalls()).toBe(calls);
      expect(await readFile(join(directory, cached.blob.storageKey))).toEqual(bytes);
      expect((await readdir(directory, { recursive: true })).sort()).toEqual(files);
    }
  });
});
