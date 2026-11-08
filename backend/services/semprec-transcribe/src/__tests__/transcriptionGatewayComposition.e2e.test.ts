import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import {
  createBlob,
  createItemWithClient,
  createUser,
  getDatabaseByModuleId,
  getItemById,
  hashPassword,
  LocalFsBlobStorageWriter,
  login,
  provisionTenant,
  setAgentRunEventHook,
  setDocUpdateHook,
  setInvalidationHook,
  setNotificationCreatedHook,
  setNotificationReadStateHook,
  setSempThreadInvalidationHook,
  setSessionRevokedHook,
  verifySessionToken,
  withTransaction,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTestPool,
  resetDatabase,
  setTenantAiBudget,
} from "@semprec/data/testSupport";
import { CORE_TASK_NAMES, enqueueJob, registerTask, runOnce } from "@semprec/queue";
import { createSyncServer, publishRealtimeMessage, wireRealtimeHooks } from "@semprec/realtime";
import { runAsSystem, runInTenant, type AiGatewayClientPort } from "@semprec/shared";
import { createHttpAudioGatewayClient } from "../audioGatewayClient.js";
import { createTranscriptionTask } from "../transcriptionTask.js";

const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const blockRoot = resolve(backend, "../shared/block-model");
const fixture = join(backend, "services/semprec-ai-gateway/dist/__tests__/fixtures/transcriptionLanguageGateway.js");
const token = "batch22-test-token";
const readySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), port: z.number().int().positive().max(65535) }).strict(),
  z.object({ type: z.literal("providerRequest"), language: z.string().nullable() }).strict(),
  z.object({ type: z.literal("diarize") }).strict(),
]);

describe("transcription gateway and realtime composition", () => {
  let admin: Pool;
  let runtime: Pool;
  beforeAll(async () => {
    admin = getTestPool();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
  });
  afterAll(async () => {
    await runtime.end();
    await admin.end();
  });

  it("runs the queued worker through the real gateway and sends transcript updates to another device", async () => {
    await resetDatabase(admin);
    const tenant = await createTestTenant(admin);
    const foreignTenant = await createTestTenant(admin);
    await provisionTenant(runtime, tenant);
    await provisionTenant(runtime, foreignTenant);
    await setTenantAiBudget(admin, tenant);
    const role = await runAsSystem("test:verify-runtime-role", () =>
      runtime.query<{ role_name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT current_user::text AS role_name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ role_name: "semprec_data", rolsuper: false, rolbypassrls: false }]);
    const passwordHash = await hashPassword("fixture-password");
    const owner = await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash });
    const outsider = await createUser(admin, {
      tenantId: foreignTenant,
      email: `${randomUUID()}@example.test`,
      passwordHash,
    });
    const first = await login(admin, {
      email: owner.email,
      password: "fixture-password",
      platform: "ios",
      ip: "127.0.0.1",
    });
    const second = await login(admin, {
      email: owner.email,
      password: "fixture-password",
      platform: "ios",
      ip: "127.0.0.1",
    });
    const foreign = await login(admin, {
      email: outsider.email,
      password: "fixture-password",
      platform: "ios",
      ip: "127.0.0.1",
    });
    const storageDir = await mkdtemp(join(tmpdir(), "batch22-composition-"));
    let blockDir: string | undefined;
    let child: ChildProcess | undefined;
    let childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let childSettled = true;
    let commandsSettled = true;
    let sync: Awaited<ReturnType<typeof createSyncServer>> | undefined;
    let server: ReturnType<typeof createServer> | undefined;
    const sockets: WebSocket[] = [];
    let testFailed = false;
    let testError: unknown;
    const cleanupErrors: unknown[] = [];
    function runFixtureCommand(command: string, args: string[], timeout: number, cwd?: string): void {
      const started = new Date().toISOString();
      const result = spawnSync(command, args, { cwd, timeout, stdio: "pipe" });
      if (result.pid > 0 && result.status === null && result.signal === null) commandsSettled = false;
      process.stderr.write(
        `batch22 fixture command start=${started} end=${new Date().toISOString()} argv=${JSON.stringify([command, ...args])} pid=${result.pid} status=${result.status} signal=${result.signal} error=${result.error?.name ?? "none"}\n`,
      );
      if (result.error) throw result.error;
      if (result.status !== 0)
        throw new Error(`Fixture command failed: status=${result.status} signal=${result.signal}`);
    }
    try {
      blockDir = await mkdtemp(join(blockRoot, "node_modules/.batch09-"));
      runFixtureCommand(
        process.execPath,
        [
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
        ],
        25_000,
        backend,
      );
      const url = z.object({ connectionString: z.string() }).parse(runtime.options).connectionString;
      const artifactHash = createHash("sha256")
        .update(await readFile(fixture))
        .digest("hex");
      const blockEntry = join(blockDir, "index.js");
      const blockHash = createHash("sha256")
        .update(await readFile(blockEntry))
        .digest("hex");
      child = spawn(process.execPath, [fixture], {
        cwd: backend,
        detached: true,
        env: {
          ...process.env,
          BATCH09_BLOCK_MODEL_ENTRY: blockEntry,
          BATCH22_GATEWAY_DATABASE_URL: url,
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const spawnedChild = child;
      childSettled = false;
      childExit = new Promise((resolveExit, reject) => {
        spawnedChild.once("error", reject);
        spawnedChild.once("exit", (code, signal) => resolveExit({ code, signal }));
      });
      const childPid = child.pid;
      if (!childPid) throw new Error("Gateway fixture did not start");
      const childPgid = Number(
        execFileSync("ps", ["-o", "pgid=", "-p", String(childPid)], { encoding: "utf8" }).trim(),
      );
      expect(childPgid).toBe(childPid);
      process.stderr.write(
        `batch22 gateway fixture start=${new Date().toISOString()} argv=${JSON.stringify([process.execPath, fixture])} pid=${childPid} pgid=${childPgid} sha256=${artifactHash} blockEntry=${blockEntry} blockSha256=${blockHash}\n`,
      );
      let childOutput = "";
      let outputExceeded = false;
      const collectOutput = (data: Buffer) => {
        if (childOutput.length + data.length > 100_000) {
          outputExceeded = true;
          return;
        }
        childOutput += data.toString("utf8");
      };
      child.stdout?.on("data", collectOutput);
      child.stderr?.on("data", collectOutput);
      const messages: z.infer<typeof readySchema>[] = [];
      let invalidMessage = false;
      child.on("message", (message: unknown) => {
        const parsed = readySchema.safeParse(message);
        if (!parsed.success || messages.length >= 100) invalidMessage = true;
        else messages.push(parsed.data);
      });
      await vi.waitFor(
        () => {
          expect(invalidMessage).toBe(false);
          expect(messages.some((message) => message.type === "ready")).toBe(true);
        },
        { timeout: 10_000 },
      );
      const ready = messages.find((message) => message.type === "ready");
      if (!ready || ready.type !== "ready") throw new Error("Missing gateway readiness");
      process.stderr.write(`batch22 gateway fixture ready=${new Date().toISOString()} pid=${childPid}\n`);
      const realAudioGateway = createHttpAudioGatewayClient({ port: ready.port, token });
      let reachedDiarize = false;
      let releaseDiarize = () => {};
      const diarizeAllowed = new Promise<void>((resolve) => {
        releaseDiarize = resolve;
      });
      const audioGateway = {
        transcribe: (request: Parameters<typeof realAudioGateway.transcribe>[0]) =>
          realAudioGateway.transcribe(request),
        async diarize(request: Parameters<typeof realAudioGateway.diarize>[0]) {
          reachedDiarize = true;
          await diarizeAllowed;
          return realAudioGateway.diarize(request);
        },
      };
      const probe = await runInTenant(tenant, () =>
        audioGateway.transcribe({
          audio: new Uint8Array([1]),
          filename: "probe.ogg",
          mimeType: "audio/ogg",
          audioSeconds: 1,
        }),
      );
      expect(probe.language).toBe("cs");
      const summary: AiGatewayClientPort = {
        async complete(input) {
          return {
            content:
              input.operation === "transcript_speaker_suggestion"
                ? { mappings: [] }
                : {
                    title: "Fixture",
                    summary: "fixture summary",
                    shortSummary: "fixture summary",
                    decisions: [],
                    actionItems: [],
                  },
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        },
      };
      wireRealtimeHooks(runtime);
      sync = await createSyncServer(runtime, {
        authenticate: async (req) => {
          const presented = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
          if (!presented) return null;
          const identity = await runAsSystem("test:sync-auth", () =>
            withTransaction(runtime, (client) => verifySessionToken(client, presented)),
          );
          return { tenantId: identity.tenantId, userId: identity.user.id, sessionId: identity.session.id };
        },
        revalidateSession: async () => true,
      });
      server = createServer();
      server.on("upgrade", (req, socket, head) => sync?.handleUpgrade(req, socket, head));
      const ownedServer = server;
      await new Promise<void>((resolveListen, reject) => {
        ownedServer.once("error", reject);
        ownedServer.listen(0, "127.0.0.1", () => {
          ownedServer.off("error", reject);
          resolveListen();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing sync address");
      const port = address.port;
      async function connect(sessionToken: string) {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=${encodeURIComponent(sessionToken)}`);
        sockets.push(socket);
        await new Promise<void>((resolveOpen, reject) => {
          const timeout = setTimeout(() => {
            socket.close();
            reject(new Error("Socket connection timed out"));
          }, 5000);
          socket.addEventListener(
            "open",
            () => {
              clearTimeout(timeout);
              resolveOpen();
            },
            { once: true },
          );
          socket.addEventListener(
            "error",
            () => {
              clearTimeout(timeout);
              reject(new Error("Socket connection failed"));
            },
            { once: true },
          );
        });
        return socket;
      }
      const device = await connect(second.token);
      const other = await connect(foreign.token);
      const frames: unknown[] = [];
      const foreignFrames: unknown[] = [];
      device.addEventListener("message", (event) => {
        if (typeof event.data === "string") frames.push(JSON.parse(event.data));
      });
      other.addEventListener("message", (event) => {
        if (typeof event.data === "string") foreignFrames.push(JSON.parse(event.data));
      });
      const audioPath = join(storageDir, "source.ogg");
      runFixtureCommand(
        "ffmpeg",
        [
          "-y",
          "-loglevel",
          "error",
          "-f",
          "lavfi",
          "-i",
          "anullsrc=r=16000:cl=mono",
          "-t",
          "1202",
          "-c:a",
          "libopus",
          "-b:a",
          "12k",
          audioPath,
        ],
        60_000,
      );
      const audio = await readFile(audioPath);
      const storage = new LocalFsBlobStorageWriter(storageDir);
      const state = await runInTenant(tenant, async () => {
        const files = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "files"));
        const transcripts = await withTransaction(runtime, (client) => getDatabaseByModuleId(client, "transcripts"));
        if (!files || !transcripts) throw new Error("Missing transcription databases");
        const key = `fixture/${randomUUID()}.ogg`;
        await storage.writeStream(key, Readable.from(audio));
        const file = await withTransaction(runtime, async (client) => {
          const blob = await createBlob(client, { mimeType: "audio/ogg", byteSize: audio.length, storageKey: key });
          return createItemWithClient(client, {
            databaseId: files.id,
            properties: { name: "Recording", file: { blobId: blob.id } },
          });
        });
        await enqueueJob(
          runtime,
          CORE_TASK_NAMES.TRANSCRIPTION_JOB,
          { fileItemId: file.id },
          { jobKey: `transcription-job:${file.id}`, maxAttempts: 3 },
        );
        return { files, transcripts, file };
      });
      const taskList = {
        [CORE_TASK_NAMES.TRANSCRIPTION_JOB]: registerTask(
          CORE_TASK_NAMES.TRANSCRIPTION_JOB,
          createTranscriptionTask(runtime, storage, audioGateway, summary),
        ),
      };
      const workerOutcome = runOnce({ pgPool: admin, taskList }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      let prepareFailure: { error: unknown } | undefined;
      try {
        await vi.waitFor(() => expect(reachedDiarize).toBe(true), { timeout: 45_000 });
        const preparedFile = await runInTenant(tenant, () =>
          withTransaction(runtime, (client) => getItemById(client, state.files.id, state.file.id)),
        );
        const preparedId = z.string().uuid().parse(preparedFile?.computed.create);
        const prepared = await runInTenant(tenant, () =>
          withTransaction(runtime, (client) => getItemById(client, state.transcripts.id, preparedId)),
        );
        if (!prepared) throw new Error("Missing prepared transcript");
        expect(prepared.computed.durationSeconds).toBeGreaterThan(1200);
        expect(prepared.computed.finalizedAt).toBeUndefined();
        await vi.waitFor(() =>
          expect(frames).toContainEqual(
            expect.objectContaining({
              type: "invalidate",
              scope: "item",
              databaseId: state.transcripts.id,
              itemId: preparedId,
              op: "update",
              updatedAt: prepared.updatedAt,
            }),
          ),
        );
      } catch (error) {
        prepareFailure = { error };
      } finally {
        releaseDiarize();
      }
      const workerResult = await workerOutcome;
      if (prepareFailure) {
        if (!workerResult.ok) console.error("Worker also failed after the prepare assertion");
        throw prepareFailure.error;
      }
      if (!workerResult.ok) throw workerResult.error;
      const file = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) => getItemById(client, state.files.id, state.file.id)),
      );
      const transcriptId = z.string().uuid().parse(file?.computed.create);
      const transcript = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) => getItemById(client, state.transcripts.id, transcriptId)),
      );
      if (!transcript?.computed.finalizedAt) {
        const diagnostic = await runInTenant(tenant, () =>
          runtime.query<{ error_code: string | null; category: string }>(
            `SELECT error_code, CASE
             WHEN error LIKE 'Gateway responded with HTTP 403%' THEN 'gateway_403'
             WHEN error LIKE 'Gateway responded with HTTP 500%' THEN 'gateway_500'
             WHEN error LIKE 'Gateway responded with HTTP %' THEN 'gateway_http'
             WHEN error LIKE 'Gateway request failed:%' THEN 'gateway_transport'
             WHEN error LIKE 'ffmpeg%' THEN 'ffmpeg'
             ELSE 'other' END AS category FROM item_automation WHERE item_id = $1`,
            [transcriptId],
          ),
        );
        const categories = [
          "permission denied",
          "statement timeout",
          "deadlock detected",
          "pool timeout",
          "Invalid URL",
          "Maximum call stack size exceeded",
          "validateBody",
        ].filter((pattern) => childOutput.includes(pattern));
        const errorKinds = [...childOutput.matchAll(/"type":"(TypeError|Error|DatabaseError|RangeError)"/g)].map(
          (match) => match[1],
        );
        const sqlstates = [...childOutput.matchAll(/"code":"([0-9A-Z]{5})"/g)].map((match) => match[1]);
        throw new Error(
          `Worker did not finalize: ${JSON.stringify(diagnostic.rows)}; provider calls=${messages.filter((message) => message.type === "providerRequest").length}; diarize calls=${messages.filter((message) => message.type === "diarize").length}; gateway categories=${categories.join(",")}; errorKinds=${errorKinds.join(",")}; sqlstates=${sqlstates.join(",")}; outputExceeded=${outputExceeded}`,
        );
      }
      expect(transcript?.computed.durationSeconds).toBeGreaterThan(1200);
      expect(transcript?.computed.finalizedAt).toEqual(expect.stringMatching(/Z$/));
      expect(transcript?.computed.language).toBe("cs");
      expect(
        z
          .object({ language: z.literal("cs") })
          .passthrough()
          .parse(file?.computed.asr).language,
      ).toBe("cs");
      expect(invalidMessage).toBe(false);
      const providerRequests = messages.filter((message) => message.type === "providerRequest");
      // The first call is the direct probe. The worker must detect the language
      // itself on its first chunk and supply it on a subsequent chunk.
      expect(providerRequests.slice(0, 3)).toEqual([
        { type: "providerRequest", language: null },
        { type: "providerRequest", language: null },
        { type: "providerRequest", language: "cs" },
      ]);
      await vi.waitFor(() =>
        expect(frames).toContainEqual(
          expect.objectContaining({
            type: "invalidate",
            scope: "item",
            itemId: transcriptId,
            databaseId: state.transcripts.id,
          }),
        ),
      );
      const workerEdges = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          client.query<{ source_id: string; source_database_id: string; target_id: string; property_key: string }>(
            `SELECT edge.item_a AS source_id, source.database_id AS source_database_id,
                    edge.item_b AS target_id, property.key AS property_key
             FROM item_relations edge
             JOIN relation_definitions definition ON definition.id = edge.relation_definition_id
             JOIN properties property ON property.id = definition.property_id_a
             JOIN items source ON source.id = edge.item_a
             WHERE property.key = 'sourceTranscript' AND edge.item_b = $1`,
            [transcriptId],
          ),
        ),
      );
      expect(workerEdges.rows).toHaveLength(2);
      expect(new Set(workerEdges.rows.map((edge) => edge.source_id)).size).toBe(2);
      const cards = await runInTenant(tenant, () =>
        withTransaction(runtime, async (client) => {
          const proposals = await getDatabaseByModuleId(client, "processingProposals");
          const events = await getDatabaseByModuleId(client, "events");
          if (!proposals || !events) throw new Error("Missing proposal or Events database");
          const cardSchema = z.discriminatedUnion("status", [
            z.object({
              kind: z.literal("transcript"),
              status: z.literal("proposed"),
              proposal: z.object({
                entityKind: z.literal("database"),
                target: z.uuid(),
                properties: z.record(z.string(), z.unknown()),
              }),
            }),
            z.object({
              kind: z.literal("transcript"),
              status: z.literal("needsClarification"),
              proposal: z.null(),
              context: z.object({ role: z.literal("speaker"), speaker: z.literal("SPEAKER_00") }),
            }),
          ]);
          const parsed = [];
          for (const edge of workerEdges.rows) {
            expect(edge.source_database_id).toBe(proposals.id);
            expect(edge.target_id).toBe(transcriptId);
            expect(edge.property_key).toBe("sourceTranscript");
            const card = await getItemById(client, proposals.id, edge.source_id);
            if (!card) throw new Error("Missing worker-created transcript card");
            parsed.push(cardSchema.parse(card.properties));
          }
          return { parsed, events };
        }),
      );
      expect(cards.parsed.map((card) => card.status).sort()).toEqual(["needsClarification", "proposed"]);
      const eventCard = cards.parsed.find((card) => card.status === "proposed");
      expect(eventCard?.proposal.target).toBe(cards.events.id);
      await vi.waitFor(() => {
        for (const edge of workerEdges.rows) {
          expect(frames).toContainEqual({
            type: "invalidate",
            scope: "relation",
            databaseId: edge.source_database_id,
            itemId: edge.source_id,
            propertyKey: "sourceTranscript",
            op: "put",
          });
        }
        expect(frames).toContainEqual({
          type: "invalidate",
          scope: "relation",
          databaseId: state.transcripts.id,
          itemId: transcriptId,
          propertyKey: null,
          op: "put",
        });
      });
      const marker = randomUUID();
      await runInTenant(foreignTenant, () =>
        publishRealtimeMessage(runtime, {
          type: "invalidation",
          scope: "schema",
          databaseId: marker,
          userId: outsider.id,
        }),
      );
      await vi.waitFor(() =>
        expect(foreignFrames).toContainEqual({ type: "invalidate", scope: "schema", databaseId: marker }),
      );
      expect(foreignFrames).toEqual([{ type: "invalidate", scope: "schema", databaseId: marker }]);
      expect(
        await runInTenant(foreignTenant, () =>
          withTransaction(runtime, (client) => getItemById(client, state.transcripts.id, transcriptId)),
        ),
      ).toBeNull();
      const prior = transcript?.computed;
      await runInTenant(tenant, () =>
        enqueueJob(
          runtime,
          CORE_TASK_NAMES.TRANSCRIPTION_JOB,
          { fileItemId: state.file.id },
          { jobKey: `transcription-job:${state.file.id}`, maxAttempts: 3 },
        ),
      );
      await runOnce({ pgPool: admin, taskList });
      expect(
        (
          await runInTenant(tenant, () =>
            withTransaction(runtime, (client) => getItemById(client, state.transcripts.id, transcriptId)),
          )
        )?.computed,
      ).toEqual(prior);
      expect(messages.filter((message) => message.type === "providerRequest")).toEqual(providerRequests);
      expect(first.token).not.toBe(second.token);
    } catch (error) {
      testFailed = true;
      testError = error;
    } finally {
      const cleanup = async (action: () => void | Promise<void>) => {
        try {
          await action();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };
      for (const socket of sockets) await cleanup(() => socket.close());
      if (sync) {
        const ownedSync = sync;
        await cleanup(() => ownedSync.close());
      }
      if (server?.listening) {
        const ownedServer = server;
        await cleanup(
          () =>
            new Promise<void>((resolveClose, reject) =>
              ownedServer.close((error) => (error ? reject(error) : resolveClose())),
            ),
        );
      }
      if (child && childExit) {
        const ownedChild = child;
        const exit = childExit;
        await cleanup(async () => {
          let sendFailure: { error: unknown } | undefined;
          try {
            if (ownedChild.connected) ownedChild.send("stop");
          } catch (error) {
            sendFailure = { error };
          }
          let timer: ReturnType<typeof setTimeout> | undefined;
          const settled = await Promise.race([
            exit,
            new Promise<null>((resolveTimeout) => {
              timer = setTimeout(() => resolveTimeout(null), 5000);
            }),
          ]).finally(() => clearTimeout(timer));
          if (!settled) {
            if (ownedChild.pid) process.kill(-ownedChild.pid, "SIGKILL");
            await exit;
            childSettled = true;
            throw new Error("Gateway fixture did not stop");
          }
          childSettled = true;
          process.stderr.write(
            `batch22 gateway fixture end=${new Date().toISOString()} pid=${ownedChild.pid} exit=${JSON.stringify(settled)}\n`,
          );
          expect(settled).toEqual({ code: 0, signal: null });
          if (sendFailure) throw sendFailure.error;
        });
      }
      if (commandsSettled) await cleanup(() => rm(storageDir, { recursive: true, force: true }));
      else cleanupErrors.push(new Error("Fixture command settlement was not established; temporary files retained"));
      if (blockDir) {
        const ownedBlockDir = blockDir;
        if (childSettled && commandsSettled) {
          await cleanup(async () => {
            await rm(ownedBlockDir, { recursive: true, force: true });
            const absent = await lstat(ownedBlockDir).then(
              () => false,
              (error: unknown) => {
                if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
                throw error;
              },
            );
            if (!absent) throw new Error("Owned block fixture directory remains");
            process.stderr.write(`batch22 block fixture removed=${ownedBlockDir}\n`);
          });
        } else {
          cleanupErrors.push(new Error("Gateway fixture settlement was not established; block output retained"));
        }
      }
      setInvalidationHook(() => {});
      setDocUpdateHook(() => {});
      setAgentRunEventHook(() => {});
      setNotificationCreatedHook(() => {});
      setNotificationReadStateHook(() => {});
      setSessionRevokedHook(() => {});
      setSempThreadInvalidationHook(() => {});
    }
    if (testFailed) {
      if (cleanupErrors.length > 0) console.error("Gateway composition cleanup also failed");
      throw testError;
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Gateway composition cleanup failed");
  }, 120_000);
});
