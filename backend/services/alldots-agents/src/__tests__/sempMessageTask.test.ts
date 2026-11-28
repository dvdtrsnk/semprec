import { toolsOf } from "./transcriptContext.js";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client, type Pool, type PoolClient } from "pg";
import sharp from "sharp";
import { closeIdleThreadSessions, createBoundedSempHistory, SempConversation } from "@alldots/agent-runtime";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type TranscriptContext } from "@earendil-works/pi-ai";
import { runAsSystem, runInTenant } from "@alldots/shared";
import {
  claimSempMessage,
  createChokePoint,
  createAgentRun,
  createHeartbeat,
  createDocStore,
  createItemWithClient,
  createPendingApprovalRequest,
  createUser,
  decideAndEnqueueApprovalRequest,
  enqueueSempMessage,
  enqueueSempThreadTitleIfFirst,
  finishSempMessageTurn,
  getDatabaseByModuleId,
  insertAgentRunEvent,
  ingestUploadedBlob,
  loadFullModuleRegistry,
  listPropertiesByDatabase,
  LocalFsBlobStorageWriter,
  readSempRefContext,
  resolveMailModuleIds,
  seedSystem,
  sendSempMessage,
  startTenantDeactivationListener,
  startSempMessageTurn,
  suspendAccount,
  validateSempMessageRefs,
  withTransaction,
} from "@alldots/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  ensureFolderItem,
  getTestPool,
  ingestEmailMessage,
  resetDatabase,
  setTenantAiBudget,
} from "@alldots/data/testSupport";
import type { ModuleRegistry } from "@alldots/module-registry";
import { AGENT_TASK_NAMES, enqueueJob } from "@alldots/queue";
import { REALTIME_CHANNEL, publishRealtimeMessage, wireRealtimeHooks } from "@alldots/realtime";
import { createInFlightAgentRuns, type InFlightAgentRuns } from "../inFlightAgentRuns.js";
import { createAgentRunTask } from "../agentRunTasks.js";
import { createAgentSessionFactoryForRun } from "../agentSessionComposition.js";
import { createGatewayModel, type GatewayModel } from "../modelComposition.js";
import { createAgentsQueueRuntime, type AgentsQueueRuntime } from "../queueRuntime.js";
import { createSempMessageTask } from "../sempMessageTask.js";
import { createGracefulShutdown } from "../shutdown.js";
import { logger } from "../logger.js";

let admin: Pool;
let pool: Pool;
let tenant: string;
let userId: string;
let registry: ModuleRegistry;
let runtime: AgentsQueueRuntime | undefined;

type Faux = ReturnType<typeof fauxProvider>;
type StreamOptions = Parameters<GatewayModel["streamFn"]>[2];
type Turn = Awaited<ReturnType<typeof sendSempMessage>>;
type SempTask = ReturnType<typeof createSempMessageTask>;

function fauxGateway(faux: Faux, onStream?: (options: StreamOptions) => void): GatewayModel {
  return {
    model: faux.getModel(),
    streamFn: (model, context, options) => {
      onStream?.(options);
      return faux.provider.streamSimple(model, context, options);
    },
    isBudgetRefusal: () => false,
  };
}

const messageHeader = (options: StreamOptions) => options?.headers?.["x-alldots-semp-message-id"] ?? undefined;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise!: () => void;
  const promise = new Promise<void>((resolveFn) => {
    resolvePromise = resolveFn;
  });
  return { promise, resolve: resolvePromise };
}

/** A provider response that signals `entered` and then waits for the turn's abort signal. */
function abortableResponse(entered: () => void) {
  return (_context: unknown, options?: { signal?: AbortSignal }) => {
    const signal = options?.signal;
    if (!signal) throw new Error("Missing provider abort signal");
    entered();
    return new Promise<never>((_, reject) => {
      if (signal.aborted) reject(new Error("provider aborted"));
      else signal.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true });
    });
  };
}

async function startRuntime(
  gateway: GatewayModel,
  inFlight: InFlightAgentRuns = createInFlightAgentRuns(),
  runtimePool: Pool = pool,
): Promise<AgentsQueueRuntime> {
  const started = await createAgentsQueueRuntime(runtimePool, registry, {
    sempMessageTask: createSempMessageTask(runtimePool, registry, gateway, inFlight),
  });
  if (runtimePool === pool) runtime = started;
  return started;
}

async function stopRuntime(): Promise<void> {
  const active = runtime;
  runtime = undefined;
  await active?.stop();
}

function send(
  text: string,
  options: { threadId?: string; context?: unknown[]; tenantId?: string; db?: Pool } = {},
): Promise<Turn> {
  const context = options.context ?? [];
  return runInTenant(options.tenantId ?? tenant, () =>
    withTransaction(options.db ?? pool, (client) =>
      sendSempMessage(client, {
        ...(options.threadId ? { threadId: options.threadId } : {}),
        text,
        context,
        hasContext: context.length > 0,
      }),
    ),
  );
}

function runTask(task: SempTask, turn: { threadId: string; assistantMessageId: string }, tenantId = tenant) {
  return runInTenant(tenantId, () =>
    task({ threadId: turn.threadId, assistantMessageId: turn.assistantMessageId }, { job: { id: "test" } }),
  );
}

async function tenantRows<T extends object>(sql: string, params: unknown[], tenantId = tenant): Promise<T[]> {
  return (await runInTenant(tenantId, () => pool.query<T>(sql, params))).rows;
}

const statusOf = (id: string, tenantId = tenant) =>
  tenantRows<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [id], tenantId);

/** Re-reads until `done` holds or 15 s pass, then returns the last value for the caller to assert. */
async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, timeout = 15_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(50);
    value = await read();
  }
  return value;
}

const isFinal = (row: { status: string } | undefined) => row?.status !== "queued" && row?.status !== "running";

/** Runs `body`, then every cleanup, and rethrows the body failure with any cleanup failures. */
async function withCleanup(body: () => Promise<void>, ...cleanups: Array<() => unknown>): Promise<void> {
  let failure: { error: unknown } | undefined;
  try {
    await body();
  } catch (error) {
    failure = { error };
  }
  const errors: unknown[] = [];
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length)
    throw new AggregateError(failure ? [failure.error, ...errors] : errors, "Test cleanup failed", {
      cause: failure?.error,
    });
  if (failure) throw failure.error;
}

/**
 * Installs a trigger raising `message` when `condition` holds. `condition` may contain one `%L`, filled in by
 * Postgres `format` with the given UUID, so no value is interpolated into the DDL. Returns the removal.
 */
async function installFailureTrigger(input: {
  table: "semp_messages" | "agent_run_events" | "agent_runs";
  event: "UPDATE" | "INSERT";
  condition: string;
  id: string;
  message: string;
}): Promise<() => Promise<void>> {
  const name = `test_semp_fail_${randomUUID().replaceAll("-", "")}`;
  const { rows } = await admin.query<{ ddl: string }>(
    `SELECT format($fmt$CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $body$
       BEGIN IF ${input.condition} THEN RAISE EXCEPTION '${input.message}'; END IF; RETURN NEW; END
     $body$$fmt$, $1::uuid) AS ddl`,
    [input.id],
  );
  if (!rows[0]) throw new Error("Missing trigger DDL");
  await admin.query(rows[0].ddl);
  await admin.query(
    `CREATE TRIGGER ${name} BEFORE ${input.event} ON ${input.table} FOR EACH ROW EXECUTE FUNCTION ${name}()`,
  );
  return async () => {
    await admin.query(`DROP TRIGGER IF EXISTS ${name} ON ${input.table}`);
    await admin.query(`DROP FUNCTION IF EXISTS ${name}()`);
  };
}

function gracefulShutdown(
  queueRuntime: Parameters<typeof createGracefulShutdown>[0]["queueRuntime"],
  shutdownPool: Pool,
  inFlight: InFlightAgentRuns,
) {
  return createGracefulShutdown({
    queueRuntime,
    tenantDeactivationListener: { close: async () => {} },
    pool: shutdownPool,
    logger,
    closeIdleThreadSessions,
    abortSempTurns: () => {
      inFlight.abortSemp();
    },
    observeSempSettlement: () => inFlight.observeSempSettlement(),
  })("SIGTERM");
}

async function inboxProject(client: PoolClient): Promise<string> {
  const inbox = await getDatabaseByModuleId(client, "inbox");
  if (!inbox?.ownerProjectItemId) throw new Error("Missing Alldots project");
  return inbox.ownerProjectItemId;
}

/** A heartbeat with its tick thread and the heartbeat run on that thread. */
async function createTickThread(client: PoolClient, name: string) {
  const projectItemId = await inboxProject(client);
  const heartbeat = await createHeartbeat(client, {
    projectItemId,
    name,
    rule: { kind: "interval", minutes: 10 },
    actionId: "core.agentRun",
    actionConfig: { task: "Review" },
  });
  const thread = await client.query<{ id: string }>(
    "INSERT INTO semp_threads (kind, heartbeat_id) VALUES ('tick', $1) RETURNING id",
    [heartbeat.id],
  );
  const threadId = thread.rows[0]?.id;
  if (!threadId) throw new Error("Missing thread");
  const run = await createAgentRun(client, {
    projectItemId,
    heartbeatId: heartbeat.id,
    threadId,
    triggeredBy: "heartbeat",
    task: "Review",
  });
  return { threadId, runId: run.id, heartbeatId: heartbeat.id };
}

async function rejectApproval(client: PoolClient, agentRunId: string, toolName = "test", decidedByUserId = userId) {
  const request = await createPendingApprovalRequest(client, {
    agentRunId,
    toolName,
    riskClass: "unclassified",
    payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
    resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
  });
  const result = await decideAndEnqueueApprovalRequest(client, {
    approvalRequestId: request.id,
    decision: "rejected",
    decidedByUserId,
  });
  expect(result?.outcome).toBe("decided");
}

/** The queued acknowledgment reply to the thread's rejected-approval system message. */
async function acknowledgmentOf(client: PoolClient, threadId: string): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT reply.id FROM semp_messages reply
       JOIN semp_messages source ON source.tenant_id = reply.tenant_id AND source.id = reply.reply_to_message_id
      WHERE source.thread_id = $1 AND source.system_key = 'approval.outcome.rejected' AND reply.status = 'queued'`,
    [threadId],
  );
  if (!rows[0]) throw new Error("Missing queued acknowledgment");
  return rows[0].id;
}

async function createIsolatedQueueTenant(): Promise<{ tenant: string; userId: string }> {
  const isolated = await createTestTenant(admin);
  const user = await createUser(admin, {
    tenantId: isolated,
    email: `${randomUUID()}@example.test`,
    passwordHash: "unused",
  });
  await runInTenant(isolated, () => seedSystem(pool));
  return { tenant: isolated, userId: user.id };
}

async function expectIsolatedQueueJobs(messageIds: [string, ...string[]]): Promise<void> {
  const { rows } = await admin.query<{ key: string | null }>(
    `SELECT key FROM graphile_worker.jobs
      WHERE queue_name = (SELECT queue_name FROM graphile_worker.jobs WHERE key = $1)
      ORDER BY id`,
    [`sempMessage:${messageIds[0]}`],
  );
  expect(rows).toEqual(messageIds.map((id) => ({ key: `sempMessage:${id}` })));
}

type RefIdentity = { tenantId: string | null; agentRunId: string | null; sempMessageId: string | null };
type QuerySchemaObservation = {
  count: number;
  bytes: number;
  nestedDefinitions: boolean;
  rootDefinitions: boolean;
  refs: number;
  allResolved: boolean;
};
type RefFixtureMessage =
  | { type: "ready"; port: number }
  | ({ type: "gatewayArrival"; sequence: number } & RefIdentity)
  | ({ type: "gatewayRequest"; sequence: number; bodyBytes: number | null } & RefIdentity)
  | ({ type: "gatewayResult"; sequence: number; status: number } & RefIdentity)
  | {
      type: "observation";
      sequence: number;
      owner: boolean;
      foreign: boolean;
      mailFirst: boolean;
      mailReply: boolean;
      block: boolean;
      sibling: boolean;
      unavailable: boolean;
      imageCount: number;
      imageMimes: string[];
      providerSerializedBytes: number;
      querySchemas: { database: QuerySchemaObservation; view: QuerySchemaObservation; count: QuerySchemaObservation };
    };

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_BYTES = 4 * 1024 * 1024;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isInt = (value: unknown, min: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
const hasKeys = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).length === keys.length && keys.every((key) => key in value);
const isUuidOrNull = (value: unknown) => value === null || (typeof value === "string" && UUID.test(value));

function isQuerySchemaObservation(value: unknown): value is QuerySchemaObservation {
  return (
    isRecord(value) &&
    hasKeys(value, ["count", "bytes", "nestedDefinitions", "rootDefinitions", "refs", "allResolved"]) &&
    isInt(value.count, 0, 200) &&
    isInt(value.bytes, 0, MAX_BYTES) &&
    isInt(value.refs, 0, 100_000) &&
    typeof value.nestedDefinitions === "boolean" &&
    typeof value.rootDefinitions === "boolean" &&
    typeof value.allResolved === "boolean"
  );
}

/** Validates one IPC message of the reference gateway fixture process. */
function isRefFixtureMessage(value: unknown): value is RefFixtureMessage {
  if (!isRecord(value)) return false;
  if (value.type === "ready") return hasKeys(value, ["type", "port"]) && isInt(value.port, 1, 65535);
  const identity =
    isInt(value.sequence, 1, 20) &&
    isUuidOrNull(value.tenantId) &&
    isUuidOrNull(value.agentRunId) &&
    isUuidOrNull(value.sempMessageId);
  const identityKeys = ["type", "sequence", "tenantId", "agentRunId", "sempMessageId"];
  if (value.type === "gatewayArrival") return identity && hasKeys(value, identityKeys);
  if (value.type === "gatewayRequest")
    return (
      identity &&
      hasKeys(value, [...identityKeys, "bodyBytes"]) &&
      (value.bodyBytes === null || isInt(value.bodyBytes, 1, MAX_BYTES))
    );
  if (value.type === "gatewayResult")
    return identity && hasKeys(value, [...identityKeys, "status"]) && isInt(value.status, 100, 599);
  if (value.type !== "observation") return false;
  const flags = ["owner", "foreign", "mailFirst", "mailReply", "block", "sibling", "unavailable"];
  const schemas = value.querySchemas;
  return (
    hasKeys(value, [
      "type",
      "sequence",
      ...flags,
      "imageCount",
      "imageMimes",
      "providerSerializedBytes",
      "querySchemas",
    ]) &&
    isInt(value.sequence, 1, 20) &&
    flags.every((flag) => typeof value[flag] === "boolean") &&
    isInt(value.imageCount, 0, 100_000) &&
    Array.isArray(value.imageMimes) &&
    value.imageMimes.length <= 4 &&
    value.imageMimes.every((mime) => ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(String(mime))) &&
    isInt(value.providerSerializedBytes, 1, MAX_BYTES) &&
    isRecord(schemas) &&
    hasKeys(schemas, ["database", "view", "count"]) &&
    isQuerySchemaObservation(schemas.database) &&
    isQuerySchemaObservation(schemas.view) &&
    isQuerySchemaObservation(schemas.count)
  );
}

async function createCompanyItem(tenantId: string, name: string, ico?: string) {
  return runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const database = await getDatabaseByModuleId(client, "companies");
      if (!database) throw new Error("Missing companies database");
      const item = await createItemWithClient(client, {
        databaseId: database.id,
        properties: { name, ...(ico ? { ico } : {}) },
      });
      return { databaseId: database.id, itemId: item.id };
    }),
  );
}

/** Ingests a two-message mail thread and returns the first message. */
async function createMailThread(storage: LocalFsBlobStorageWriter) {
  return runInTenant(tenant, () =>
    withTransaction(pool, async (client) => {
      const mailIds = await resolveMailModuleIds(client);
      const emailProperties = await listPropertiesByDatabase(client, mailIds.emailsDatabaseId);
      const folderProperties = await listPropertiesByDatabase(client, mailIds.foldersDatabaseId);
      const attachments = emailProperties.find((property) => property.key === "attachments");
      const folder = emailProperties.find((property) => property.key === "folder");
      const mailbox = folderProperties.find((property) => property.key === "mailbox");
      if (!attachments || !folder || !mailbox) throw new Error("Missing mail fixture relations");
      const mailboxItem = await createItemWithClient(client, {
        databaseId: mailIds.mailboxesDatabaseId,
        properties: { name: "Reference mailbox" },
      });
      const folderItemId = await ensureFolderItem(client, {
        foldersDatabaseId: mailIds.foldersDatabaseId,
        mailboxItemId: mailboxItem.id,
        mailboxRelationPropertyId: mailbox.id,
        providerId: "INBOX",
        name: "Inbox",
        behavior: "folder",
        specialPurpose: "inbox",
      });
      const messageId = `<${randomUUID()}@example.test>`;
      const common = {
        emailsDatabaseId: mailIds.emailsDatabaseId,
        filesDatabaseId: mailIds.filesDatabaseId,
        folderRelationPropertyId: folder.id,
        attachmentsRelationPropertyId: attachments.id,
        folderItemId,
        mailboxItemId: mailboxItem.id,
        subject: "Reference thread",
        envelope: {},
        attachments: [],
        storage,
        storageKeyPrefix: "reference-worker",
      };
      const first = await ingestEmailMessage(client, {
        arrival: "live",
        contentState: "full",
        ...common,
        messageId,
        bodyText: "REF_MAIL_FIRST_SENTINEL_32",
      });
      const reply = await ingestEmailMessage(client, {
        arrival: "live",
        contentState: "full",
        ...common,
        messageId: `<${randomUUID()}@example.test>`,
        inReplyTo: messageId,
        references: [messageId],
        bodyText: "REF_MAIL_REPLY_SENTINEL_32",
      });
      const threads = await client.query<{ thread_id: string | null }>(
        "SELECT thread_id FROM mail_message_meta WHERE item_id = ANY($1::uuid[])",
        [[first.itemId, reply.itemId]],
      );
      expect(threads.rows).toHaveLength(2);
      expect(threads.rows[0]?.thread_id).toBeTruthy();
      expect(threads.rows[0]?.thread_id).toBe(threads.rows[1]?.thread_id);
      return { databaseId: mailIds.emailsDatabaseId, itemId: first.itemId };
    }),
  );
}

async function uploadImage(storage: LocalFsBlobStorageWriter, databaseId: string, name: string, color: string) {
  const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: color } })
    .png()
    .toBuffer();
  return runInTenant(tenant, async () => {
    const upload = await ingestUploadedBlob(pool, {
      mimeType: "image/png",
      source: Readable.from([bytes]),
      maxBytes: bytes.length + 1,
      storage,
    });
    const item = await createChokePoint(pool).createItem({
      databaseId,
      properties: { name, file: { blobId: upload.blob.id } },
    });
    return { ref: { kind: "item" as const, databaseId, itemId: item.id }, key: upload.blob.storageKey };
  });
}

async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe("queued Semp messages", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "alldots_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    ({ tenant, userId } = await createIsolatedQueueTenant());
    registry = await loadFullModuleRegistry();
  });

  afterAll(async () => {
    await withCleanup(
      () => stopRuntime(),
      () => pool?.end(),
      () => admin?.end(),
    );
  });

  it.each([
    {
      name: "expands tenant references through the registered worker and real gateway without persisting content",
      images: false,
    },
    { name: "replays fresh and continuing images through the registered worker and real gateway", images: true },
  ])(
    "$name",
    async ({ images }) => {
      await stopRuntime();
      const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
      const blockRoot = resolve(backend, "../shared/block-model");
      const fixture = join(backend, "services/alldots-ai-gateway/dist/__tests__/fixtures/refExpansionGateway.js");
      const fixtureSource = join(backend, "services/alldots-ai-gateway/src/__tests__/fixtures/refExpansionGateway.ts");
      if ((await stat(fixture)).mtimeMs < (await stat(fixtureSource)).mtimeMs)
        throw new Error("Stale reference gateway fixture build");
      const blockDir = await mkdtemp(join(blockRoot, "node_modules/.batch09-"));
      const mailRoot = await mkdtemp(join(tmpdir(), "semp-ref-worker-mail-"));
      const messages: RefFixtureMessage[] = [];
      let invalidOutput = false;
      let child: ReturnType<typeof spawn> | undefined;
      let childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
      const sendSpy = vi.spyOn(SempConversation.prototype, "send");
      let threadId = "";
      // The conversation instances that sent turns on this test's thread, in first-use order.
      const conversations = () => [
        ...new Set(
          sendSpy.mock.contexts.filter(
            (context, index): context is SempConversation =>
              context instanceof SempConversation && sendSpy.mock.calls[index]?.[1].threadId === threadId,
          ),
        ),
      ];
      const stopChild = async () => {
        if (!child || !childExit) return;
        const owned = child;
        try {
          await withTimeout(
            new Promise<void>((resolveSend, reject) =>
              owned.send({ type: "stop" }, (error) => (error ? reject(error) : resolveSend())),
            ).then(() => childExit),
            10_000,
            "Reference gateway stop timed out",
          );
        } catch (error) {
          owned.kill("SIGKILL");
          await withTimeout(childExit, 5000, "Reference gateway exit not observed");
          throw error;
        }
        const outcome = await childExit;
        if (outcome.code !== 0 || outcome.signal !== null) throw new Error("Reference gateway did not exit cleanly");
      };
      await withCleanup(
        async () => {
          const compiled = spawnSync(
            process.execPath,
            [
              join(backend, "node_modules/typescript/bin/tsc"),
              ...["-p", join(blockRoot, "tsconfig.json"), "--noEmit", "false", "--declaration", "false"],
              ...["--incremental", "false", "--outDir", blockDir],
            ],
            { cwd: backend, timeout: 25_000, maxBuffer: 1_000_000 },
          );
          if (compiled.error) throw compiled.error;
          if (compiled.status !== 0) throw new Error("Reference fixture block-model build failed");
          const databaseUrl = pool.options.connectionString;
          if (typeof databaseUrl !== "string") throw new Error("Missing runtime database URL");
          const owned = spawn(process.execPath, [fixture], {
            cwd: backend,
            env: {
              ...process.env,
              BATCH09_BLOCK_MODEL_ENTRY: join(blockDir, "index.js"),
              BATCH32_GATEWAY_DATABASE_URL: databaseUrl,
            },
            stdio: ["ignore", "pipe", "pipe", "ipc"],
          });
          child = owned;
          childExit = new Promise((resolveExit) =>
            owned.once("close", (code, signal) => resolveExit({ code, signal })),
          );
          let outputBytes = 0;
          for (const output of [owned.stdout, owned.stderr])
            output?.on("data", (chunk: Buffer) => {
              outputBytes += chunk.length;
              if (outputBytes > 100_000) invalidOutput = true;
            });
          owned.on("message", (value: unknown) => {
            // 768: an observation carries three schema observations of about a hundred characters each.
            if (!isRefFixtureMessage(value) || messages.length >= 50 || JSON.stringify(value).length > 768)
              invalidOutput = true;
            else messages.push(value);
          });
          await vi.waitFor(
            () => {
              expect(invalidOutput).toBe(false);
              expect(messages.some((entry) => entry.type === "ready")).toBe(true);
            },
            { timeout: 10_000 },
          );
          const ready = messages.find((entry) => entry.type === "ready");
          if (ready?.type !== "ready") throw new Error("Missing reference gateway readiness");
          const observations = () => messages.filter((entry) => entry.type === "observation");

          await setTenantAiBudget(admin, tenant, { dailyCapUsd: 100, monthlyCapUsd: 100 });
          const foreign = await createTestTenant(admin);
          await runInTenant(foreign, () => seedSystem(pool));
          const ids = await createCompanyItem(tenant, "Reference", "REF_OWNER_SENTINEL_32");
          const mailStorage = new LocalFsBlobStorageWriter(join(mailRoot, "mail"));
          const fileStorage = new LocalFsBlobStorageWriter(join(mailRoot, "files"));
          const mail = await createMailThread(mailStorage);
          const blockId = randomUUID();
          const siblingId = randomUUID();
          await runInTenant(tenant, async () => {
            const docs = createDocStore(pool);
            await docs.putBlock(
              ids.itemId,
              { id: blockId, flavour: "paragraph", fields: { text: "REF_BLOCK_SENTINEL_32" } },
              "user",
            );
            await docs.putBlock(
              ids.itemId,
              { id: siblingId, flavour: "paragraph", fields: { text: "REF_SIBLING_SENTINEL_32" } },
              "user",
            );
            await docs.putBlock(
              ids.itemId,
              { id: randomUUID(), flavour: "page", children: [blockId, siblingId] },
              "user",
            );
          });
          const imageRefs: Array<{ kind: "item"; databaseId: string; itemId: string }> = [];
          let unavailable: Awaited<ReturnType<typeof uploadImage>> | undefined;
          if (images) {
            const fileDatabase = await runInTenant(tenant, () =>
              withTransaction(pool, (client) => getDatabaseByModuleId(client, "files")),
            );
            if (!fileDatabase) throw new Error("Missing Files database");
            const availableKeys = new Set<string>();
            for (let index = 0; index < 10; index += 1) {
              const image = await uploadImage(fileStorage, fileDatabase.id, `Reference image ${index}`, "#2376af");
              availableKeys.add(image.key);
              imageRefs.push(image.ref);
            }
            unavailable = await uploadImage(fileStorage, fileDatabase.id, "Unavailable image", "#a34257");
            expect(availableKeys.has(unavailable.key)).toBe(false);
          }
          const foreignIds = await createCompanyItem(foreign, "REF_FOREIGN_SENTINEL_32");
          const refs = [
            { kind: "item" as const, ...ids },
            { kind: "item" as const, ...mail },
            { kind: "block" as const, itemId: ids.itemId, blockId },
            ...imageRefs.slice(0, 9),
            ...(unavailable ? [unavailable.ref] : []),
          ];
          await expect(
            withTransaction(pool, (client) => readSempRefContext(client, { kind: "item", ...ids })),
          ).rejects.toThrow();
          expect(observations()).toHaveLength(0);

          // A foreign or missing reference is refused at admission and expands to nothing.
          const countRows = async () => ({
            messages: await tenantRows<{ count: string }>("SELECT count(*)::text AS count FROM semp_messages", []),
            jobs: (await admin.query<{ count: string }>("SELECT count(*)::text AS count FROM graphile_worker.jobs"))
              .rows,
          });
          const beforeRefusal = await countRows();
          for (const ref of [
            { kind: "item" as const, ...foreignIds },
            { kind: "item" as const, databaseId: ids.databaseId, itemId: randomUUID() },
          ]) {
            await expect(
              runInTenant(tenant, () => withTransaction(pool, (client) => validateSempMessageRefs(client, [ref]))),
            ).rejects.toThrow();
            expect(
              await runInTenant(tenant, () => withTransaction(pool, (client) => readSempRefContext(client, ref))),
            ).toBeNull();
          }
          expect(await countRows()).toEqual(beforeRefusal);

          const sendValidated = (
            text: string,
            context: Parameters<typeof validateSempMessageRefs>[1],
            thread?: string,
          ) =>
            runInTenant(tenant, () =>
              withTransaction(pool, async (client) =>
                sendSempMessage(client, {
                  ...(thread ? { threadId: thread } : {}),
                  text,
                  context: context.length ? await validateSempMessageRefs(client, context) : [],
                  hasContext: context.length > 0,
                }),
              ),
            );
          const turn = await sendValidated("Question", refs);
          threadId = turn.threadId;
          // Synthetic unavailable bytes: remove only this fixture's unique owned object after admission.
          if (unavailable) await fileStorage.delete(unavailable.key);
          const gateway = createGatewayModel({
            AI_GATEWAY_BASE_URL: `http://127.0.0.1:${ready.port}/internal/pi`,
            AI_GATEWAY_INTERNAL_TOKEN: "batch32-ref-test-token",
            AGENT_MODEL: "claude-haiku-4-5",
          });
          const startImageRuntime = async () => {
            runtime = await createAgentsQueueRuntime(pool, registry, {
              sempMessageTask: createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns(), {
                files: fileStorage,
                mailAttachments: mailStorage,
              }),
            });
          };
          const awaitDone = (id: string) =>
            vi.waitFor(
              async () => {
                const [row] = await tenantRows<{ status: string; agent_run_id: string | null }>(
                  "SELECT status, agent_run_id FROM semp_messages WHERE id = $1",
                  [id],
                );
                expect(row?.status).toBe("done");
                if (!row?.agent_run_id) throw new Error("Missing reply run");
                return row.agent_run_id;
              },
              { timeout: 20_000 },
            );
          // Each gateway call reports its arrival, request and 200 result with the turn's identity.
          const expectGatewayCall = (sequence: number, agentRunId: string, sempMessageId: string) => {
            const identity = { sequence, tenantId: tenant, agentRunId, sempMessageId };
            expect(messages).toContainEqual({ type: "gatewayArrival", ...identity });
            expect(messages).toContainEqual({ type: "gatewayResult", status: 200, ...identity });
            const request = messages.find((entry) => entry.type === "gatewayRequest" && entry.sequence === sequence);
            expect(request).toMatchObject({ type: "gatewayRequest", ...identity, bodyBytes: expect.any(Number) });
          };
          const settledCalls = (agentRunId: string, sempMessageId: string) =>
            tenantRows<{ status: string; agent_run_id: string; semp_message_id: string }>(
              "SELECT status, agent_run_id, semp_message_id FROM ai_gateway_calls WHERE agent_run_id = $1 AND semp_message_id = $2",
              [agentRunId, sempMessageId],
            );
          const expectNoImageBytes = (value: unknown) => {
            expect(JSON.stringify(value)).not.toContain("image/jpeg");
            expect(JSON.stringify(value)).not.toContain("base64");
          };

          await startImageRuntime();
          const runId = await awaitDone(turn.assistantMessageId);
          const cold = conversations();
          if (images) expect(cold).toHaveLength(1);
          await vi.waitFor(
            () =>
              expect(observations()).toEqual([
                expect.objectContaining({
                  sequence: 1,
                  owner: true,
                  foreign: false,
                  mailFirst: true,
                  mailReply: true,
                  block: true,
                  sibling: true,
                  unavailable: images,
                  imageCount: images ? 9 : 0,
                  imageMimes: images ? ["image/jpeg"] : [],
                }),
              ]),
            { timeout: 5000 },
          );
          if (!images) {
            const [observation] = observations();
            if (observation?.type !== "observation") throw new Error("Missing provider observation");
            for (const schema of Object.values(observation.querySchemas)) {
              expect(schema).toMatchObject({
                count: 1,
                nestedDefinitions: true,
                rootDefinitions: false,
                allResolved: true,
              });
              expect(schema.bytes).toBeGreaterThan(0);
              expect(schema.bytes).toBeLessThan(20_000);
              expect(schema.refs).toBeGreaterThan(0);
            }
          }
          expect(messages.filter((entry) => entry.type === "gatewayRequest")).toHaveLength(1);
          expectGatewayCall(1, runId, turn.assistantMessageId);

          // The run, its events and the stored messages hold references and labels, never expanded content.
          const run = await tenantRows<{ task: string }>("SELECT task FROM agent_runs WHERE id = $1", [runId]);
          const events = await tenantRows<{ payload: unknown }>(
            "SELECT payload FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id",
            [runId],
          );
          const stored = await tenantRows<{ id: string; context: unknown; reply_to_message_id: string | null }>(
            "SELECT id, context, reply_to_message_id FROM semp_messages WHERE id = ANY($1::uuid[])",
            [[turn.messageId, turn.assistantMessageId]],
          );
          expect(run).toEqual([{ task: "Question" }]);
          expect(stored).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: turn.messageId, context: refs }),
              expect.objectContaining({ id: turn.assistantMessageId, reply_to_message_id: turn.messageId }),
            ]),
          );
          for (const sentinel of [
            "REF_OWNER_SENTINEL_32",
            "REF_FOREIGN_SENTINEL_32",
            "REF_MAIL_FIRST_SENTINEL_32",
            "REF_MAIL_REPLY_SENTINEL_32",
            "REF_BLOCK_SENTINEL_32",
            "REF_SIBLING_SENTINEL_32",
          ])
            expect(JSON.stringify([events, run, stored])).not.toContain(sentinel);
          expect(events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                payload: expect.objectContaining({
                  kind: "user_message",
                  context: expect.arrayContaining([
                    expect.objectContaining({ ...refs[0], label: "Reference" }),
                    expect.objectContaining({ ...refs[1], label: "Reference thread" }),
                    expect.objectContaining({ ...refs[2], label: "Reference" }),
                    ...imageRefs
                      .slice(0, 9)
                      .map((ref, index) => expect.objectContaining({ ...ref, label: `Reference image ${index}` })),
                    ...(unavailable
                      ? [expect.objectContaining({ ...unavailable.ref, label: "Unavailable image" })]
                      : []),
                  ]),
                }),
              }),
            ]),
          );
          expect(await settledCalls(runId, turn.assistantMessageId)).toEqual([
            { status: "settled", agent_run_id: runId, semp_message_id: turn.assistantMessageId },
          ]);
          expectNoImageBytes([events, stored]);
          expect(JSON.stringify([events, stored])).not.toContain("Attachment unavailable.");
          if (!images) return;

          // A continuing turn reuses the warm conversation and replays every image so far.
          const lastImage = imageRefs[9];
          if (!lastImage) throw new Error("Missing final image fixture");
          const continued = await sendValidated("Continue with an image", [lastImage], turn.threadId);
          expect(await awaitDone(continued.assistantMessageId)).toBe(runId);
          expect(conversations()).toEqual(cold);
          await vi.waitFor(
            () => {
              const observation = messages.find((entry) => entry.type === "observation" && entry.sequence === 2);
              expect(observation).toMatchObject({ imageCount: 10, imageMimes: ["image/jpeg"], unavailable: true });
              expectGatewayCall(2, runId, continued.assistantMessageId);
            },
            { timeout: 5000 },
          );
          expect(await settledCalls(runId, continued.assistantMessageId)).toEqual([
            { status: "settled", agent_run_id: runId, semp_message_id: continued.assistantMessageId },
          ]);

          // After the session closes, a new worker wakes the thread from stored history with the same images.
          await stopRuntime();
          cold[0]?.clear();
          expect((await closeIdleThreadSessions(pool)).closedRunIds).toContain(runId);
          await startImageRuntime();
          const wake = await sendValidated("Wake the image history", [], turn.threadId);
          const wakeRun = await awaitDone(wake.assistantMessageId);
          expect(wakeRun).not.toBe(runId);
          expect(conversations()).toHaveLength(2);
          expect(conversations()[1]).not.toBe(cold[0]);
          await vi.waitFor(
            () => {
              const observation = messages.find((entry) => entry.type === "observation" && entry.sequence === 3);
              expect(observation).toMatchObject({ imageCount: 10, imageMimes: ["image/jpeg"], unavailable: true });
              expectGatewayCall(3, wakeRun, wake.assistantMessageId);
            },
            { timeout: 5000 },
          );
          const runs = await tenantRows<{ id: string; task: string }>(
            "SELECT id, task FROM agent_runs WHERE id = ANY($1::uuid[])",
            [[runId, wakeRun]],
          );
          expect(runs).toHaveLength(2);
          expect(runs).toEqual(
            expect.arrayContaining([
              { id: runId, task: "Question" },
              { id: wakeRun, task: "Wake the image history" },
            ]),
          );
          expect(await settledCalls(wakeRun, wake.assistantMessageId)).toEqual([
            { status: "settled", agent_run_id: wakeRun, semp_message_id: wake.assistantMessageId },
          ]);
          const wakeEvents = await tenantRows<{ payload: unknown }>(
            "SELECT payload FROM agent_run_events WHERE agent_run_id = ANY($1::uuid[]) ORDER BY id",
            [[runId, wakeRun]],
          );
          const wakeMessages = await tenantRows<{ id: string; context: unknown }>(
            "SELECT id, context FROM semp_messages WHERE id = ANY($1::uuid[])",
            [[turn.messageId, continued.messageId, wake.messageId]],
          );
          expect(wakeMessages).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ id: turn.messageId, context: refs }),
              expect.objectContaining({ id: continued.messageId, context: [lastImage] }),
              expect.objectContaining({ id: wake.messageId, context: [] }),
            ]),
          );
          expectNoImageBytes([runs, wakeEvents, wakeMessages]);
        },
        () => stopRuntime(),
        () => {
          for (const conversation of conversations()) conversation.clear();
          sendSpy.mockRestore();
        },
        () => closeIdleThreadSessions(pool),
        stopChild,
        () => rm(blockDir, { recursive: true }),
        () => rm(mailRoot, { recursive: true }),
      );
    },
    60_000,
  );

  it("refuses Semp enqueue outside a tenant scope without creating a job", async () => {
    const payload = { threadId: randomUUID(), assistantMessageId: randomUUID() };
    const jobs = () =>
      admin.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
        `sempMessage:${payload.assistantMessageId}`,
      ]);
    await expect(
      runAsSystem("test:semp-enqueue", () => withTransaction(pool, (client) => enqueueSempMessage(client, payload))),
    ).rejects.toThrow("Semp message enqueue requires a tenant scope");
    expect((await jobs()).rows).toEqual([]);
  });

  it("ignores running, failed, missing and foreign messages without model or queue effects", async () => {
    await stopRuntime();
    const other = await createTestTenant(admin);
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("must not run")]);
    const task = createSempMessageTask(pool, registry, fauxGateway(faux), createInFlightAgentRuns());
    const turns = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const running = await sendSempMessage(client, { text: "running", context: [], hasContext: false });
        const failed = await sendSempMessage(client, { text: "failed", context: [], hasContext: false });
        expect(await claimSempMessage(client, running.threadId, running.assistantMessageId)).toBe(true);
        expect(await claimSempMessage(client, failed.threadId, failed.assistantMessageId)).toBe(true);
        expect(await finishSempMessageTurn(client, failed.assistantMessageId, { status: "error" })).toBe(true);
        return { running, failed };
      }),
    );
    const jobs = () =>
      admin.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key", [
        [turns.running, turns.failed].map((turn) => `sempMessage:${turn.assistantMessageId}`),
      ]);
    const before = (await jobs()).rows;
    expect(before).toHaveLength(2);
    await runTask(task, turns.running);
    await runTask(task, turns.failed);
    await runTask(task, { threadId: turns.running.threadId, assistantMessageId: randomUUID() });
    await runTask(task, turns.running, other);
    const states = await tenantRows<{ id: string; status: string }>(
      "SELECT id, status FROM semp_messages WHERE id = ANY($1::uuid[])",
      [[turns.running.assistantMessageId, turns.failed.assistantMessageId]],
    );
    expect(states).toHaveLength(2);
    expect(states).toEqual(
      expect.arrayContaining([
        { id: turns.running.assistantMessageId, status: "running" },
        { id: turns.failed.assistantMessageId, status: "error" },
      ]),
    );
    expect((await jobs()).rows).toEqual(before);
    expect(faux.getPendingResponseCount()).toBe(1);
  });

  it("runs two queued turns in their stored order through the real agents runtime", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
    const headers: (string | undefined)[] = [];
    await startRuntime(fauxGateway(faux, (options) => headers.push(messageHeader(options))));
    const ref = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const inbox = await getDatabaseByModuleId(client, "inbox");
        if (!inbox) throw new Error("Missing Inbox database");
        const item = await createItemWithClient(client, {
          databaseId: inbox.id,
          properties: { date: "2026-01-01", time: "12:00", text: "Referenced item" },
        });
        return { kind: "item" as const, itemId: item.id, databaseId: inbox.id, label: "Referenced item" };
      }),
    );
    const first = await send("first", { context: [ref] });
    const second = await send("second", { threadId: first.threadId });
    type Row = {
      id: string;
      text: string | null;
      status: string | null;
      agent_run_id: string | null;
      event_from_id: string | null;
      event_to_id: string | null;
    };
    const rows = await poll(
      () =>
        tenantRows<Row>(
          "SELECT id, text, status, agent_run_id, event_from_id, event_to_id FROM semp_messages WHERE id = ANY($1::uuid[]) ORDER BY created_at, id",
          [[first.assistantMessageId, second.assistantMessageId]],
        ),
      (current) => current.every((row) => row.status === "done"),
    );
    expect(rows.map((row) => [row.id, row.text, row.status])).toEqual([
      [first.assistantMessageId, "first answer", "done"],
      [second.assistantMessageId, "second answer", "done"],
    ]);
    for (const row of rows)
      expect(row).toMatchObject({
        agent_run_id: expect.any(String),
        event_from_id: expect.any(String),
        event_to_id: expect.any(String),
      });
    expect(rows[0]?.agent_run_id).toBe(rows[1]?.agent_run_id);
    expect(headers).toEqual([first.assistantMessageId, second.assistantMessageId]);
    expect(
      await tenantRows<{ payload: unknown }>(
        "SELECT payload FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'user_message' ORDER BY id",
        [rows[0]?.agent_run_id],
      ),
    ).toEqual([
      { payload: expect.objectContaining({ kind: "user_message", text: "first", context: [ref] }) },
      { payload: expect.objectContaining({ kind: "user_message", text: "second", context: [] }) },
    ]);
    const titles = await admin.query<{ key: string; max_attempts: number; task_identifier: string }>(
      "SELECT key, max_attempts, task_identifier FROM graphile_worker.jobs WHERE key = $1",
      [`sempThreadTitle:${first.threadId}`],
    );
    expect(titles.rows).toEqual([
      { key: `sempThreadTitle:${first.threadId}`, max_attempts: 1, task_identifier: "sempThreadTitle" },
    ]);
  });

  it("rolls back a title job observed in the same transaction as the done transition", async () => {
    await stopRuntime();
    const turn = await send("title rollback");
    const titleKey = `sempThreadTitle:${turn.threadId}`;
    const eventId = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        expect(await claimSempMessage(client, turn.threadId, turn.assistantMessageId)).toBe(true);
        const run = await createAgentRun(client, {
          triggeredBy: "user",
          unit: "session",
          task: "title rollback",
          threadId: turn.threadId,
        });
        const event = await insertAgentRunEvent(client, run.id, "message", { kind: "message", text: "answer" });
        await startSempMessageTurn(client, turn.assistantMessageId, run.id, event.id);
        return event.id;
      }),
    );
    await expect(
      runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          expect(
            await finishSempMessageTurn(client, turn.assistantMessageId, {
              status: "done",
              text: "answer",
              lastEventId: eventId,
            }),
          ).toBe(true);
          await enqueueSempThreadTitleIfFirst(client, turn.threadId, turn.assistantMessageId);
          const job = await client.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
            titleKey,
          ]);
          expect(job.rows).toEqual([{ key: titleKey }]);
          throw new Error("rollback sentinel");
        }),
      ),
    ).rejects.toThrow("rollback sentinel");
    expect(await statusOf(turn.assistantMessageId)).toEqual([{ status: "running" }]);
    expect(
      await tenantRows<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [titleKey]),
    ).toEqual([]);
  });

  it("stores a provider failure once, continues the thread and ignores redelivery of its completed reply", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider refused" }),
      fauxAssistantMessage("recovered"),
      fauxAssistantMessage("standalone answer"),
    ]);
    const headers: { messageId: string | undefined; runId: string | undefined }[] = [];
    const gateway = fauxGateway(faux, (options) =>
      headers.push({
        messageId: messageHeader(options),
        runId: options?.headers?.["x-alldots-agent-run-id"] ?? undefined,
      }),
    );
    const inFlight = createInFlightAgentRuns();
    await startRuntime(gateway, inFlight);
    const read = async (id: string) =>
      (
        await tenantRows<{ status: string; text: string | null }>(
          "SELECT status, text FROM semp_messages WHERE id = $1",
          [id],
        )
      )[0];
    const jobRows = (key: string) => admin.query("SELECT id FROM graphile_worker.jobs WHERE key = $1", [key]);

    const first = await send("fail");
    expect(
      await poll(
        () => read(first.assistantMessageId),
        (row) => row?.status === "error",
      ),
    ).toMatchObject({
      status: "error",
    });
    expect((await jobRows(`sempMessage:${first.assistantMessageId}`)).rows).toEqual([]);
    const second = await send("continue", { threadId: first.threadId });
    expect(
      await poll(
        () => read(second.assistantMessageId),
        (row) => row?.status === "done",
      ),
    ).toEqual({
      status: "done",
      text: "recovered",
    });
    const redeliveryKey = `redelivery:${randomUUID()}`;
    await runInTenant(tenant, () =>
      enqueueJob(
        pool,
        AGENT_TASK_NAMES.SEMP_MESSAGE,
        { threadId: second.threadId, assistantMessageId: second.assistantMessageId },
        { jobKey: redeliveryKey, maxAttempts: 1 },
      ),
    );
    expect(
      (
        await poll(
          () => jobRows(redeliveryKey),
          (job) => !job.rowCount,
        )
      ).rows,
    ).toEqual([]);
    expect(await read(second.assistantMessageId)).toEqual({ status: "done", text: "recovered" });
    expect(faux.getPendingResponseCount()).toBe(1);
    expect(headers.map((entry) => entry.messageId)).toEqual([first.assistantMessageId, second.assistantMessageId]);

    // A standalone run carries its run id and no Semp message attribution.
    const standalone = await runInTenant(tenant, async () => {
      const projectItemId = await withTransaction(pool, inboxProject);
      return createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "standalone" });
    });
    await runInTenant(tenant, () =>
      createAgentRunTask(
        pool,
        registry,
        gateway,
        inFlight,
      )({ agentRunId: standalone.id }, { job: { id: "standalone" } }),
    );
    expect(headers[2]).toEqual({ messageId: undefined, runId: standalone.id });
  });

  type SummaryRow = {
    status: string;
    steps: unknown;
    duration_ms: number | null;
    tokens: unknown;
    event_to_id: string | null;
    changes: unknown;
  };
  const awaitFinalSummary = async (id: string) =>
    poll(
      async () =>
        (
          await tenantRows<SummaryRow>(
            "SELECT status, steps, duration_ms, tokens, event_to_id, changes FROM semp_messages WHERE id = $1",
            [id],
          )
        )[0],
      isFinal,
    );

  it("stores the typed step summary with a done reply and with a reply that ends in an error", async () => {
    await stopRuntime();
    const faux = fauxProvider();
    const missingItemId = randomUUID();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("database_list", {}, { id: "summary-ok" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("Listed."),
      fauxAssistantMessage([fauxToolCall("item_get", { itemId: missingItemId }, { id: "summary-fail" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider refused" }),
    ]);
    await startRuntime(fauxGateway(faux));
    const first = await send("list");
    const done = await awaitFinalSummary(first.assistantMessageId);
    const failed = await awaitFinalSummary((await send("list", { threadId: first.threadId })).assistantMessageId);

    expect(done).toMatchObject({ status: "done", duration_ms: expect.any(Number), tokens: { input: 0, output: 0 } });
    expect(done?.steps).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "summary-ok",
        operation: "database.list",
        status: "ok",
        label: { key: "agentStep.title.operation.database.list", params: {} },
      }),
    ]);
    expect(failed).toMatchObject({ status: "error", event_to_id: null, duration_ms: expect.any(Number) });
    expect(failed?.steps).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "summary-fail",
        operation: "item.get",
        status: "error",
        errorCode: "not_found",
        detail: { key: "agentStep.summary.failed", params: {} },
      }),
    ]);
    expect(JSON.stringify(failed?.steps)).not.toContain(missingItemId);
  });

  it("stores the error state of a failed reply even when its step summary cannot be read, and logs the failed read", async () => {
    await stopRuntime();
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("database_list", {}, { id: "unread-1" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider refused" }),
    ]);
    await startRuntime(fauxGateway(faux));
    // Only the read of the events of a turn that stored no last event (a failed turn) fails.
    const queryTarget = Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
    const realQuery = queryTarget.query;
    let failedReads = 0;
    const querySpy = vi.spyOn(queryTarget, "query").mockImplementation(function (this: unknown, ...args: unknown[]) {
      const [sql, values] = args;
      if (
        typeof sql === "string" &&
        sql.includes("kind = ANY($4::text[])") &&
        Array.isArray(values) &&
        values[2] === null
      ) {
        failedReads++;
        return Promise.reject(new Error("events cannot be read"));
      }
      return Reflect.apply(realQuery, this, args);
    });
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    try {
      const sent = await send("list");
      const row = await awaitFinalSummary(sent.assistantMessageId);
      expect(failedReads).toBeGreaterThan(0);
      expect(row).toEqual({
        status: "error",
        steps: null,
        duration_ms: null,
        tokens: null,
        event_to_id: null,
        changes: null,
      });
      expect(errorSpy).toHaveBeenCalledWith(
        { threadId: sent.threadId, assistantMessageId: sent.assistantMessageId, errorName: "Error" },
        "Semp reply summary could not be built for a failed turn",
      );
    } finally {
      querySpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it("stores the items a reply changed with the previous value, and an empty list for a reply that changed nothing", async () => {
    await stopRuntime();
    const task = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const tasks = await getDatabaseByModuleId(client, "tasks");
        if (!tasks) throw new Error("Missing Tasks database");
        const created = await createItemWithClient(
          client,
          { databaseId: tasks.id, properties: { name: "Move me", date: "2026-11-02" } },
          { writer: { writerKind: "system" } },
        );
        return { id: created.id, databaseId: tasks.id, version: created.version };
      }),
    );
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall(
            "item_patch",
            { itemId: task.id, properties: { date: "2026-11-03" }, ifVersion: task.version },
            { id: "change-patch" },
          ),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("Moved."),
      fauxAssistantMessage("Nothing to change."),
    ]);
    await startRuntime(fauxGateway(faux));
    const moved = await send("move");
    const movedRow = await awaitFinalSummary(moved.assistantMessageId);
    const idleRow = await awaitFinalSummary((await send("move", { threadId: moved.threadId })).assistantMessageId);
    expect(movedRow).toMatchObject({
      status: "done",
      changes: [
        {
          itemId: task.id,
          databaseId: task.databaseId,
          change: "updated",
          changedKeys: ["date"],
          before: { date: "2026-11-02" },
        },
      ],
    });
    expect(idleRow).toMatchObject({ status: "done", changes: [] });
  });

  it("runs turns for different tenants concurrently on the dedicated runner", async () => {
    await stopRuntime();
    const { tenant: other } = await createIsolatedQueueTenant();
    const gate = deferred();
    const faux = fauxProvider();
    faux.setResponses(
      ["first tenant", "second tenant"].map((text) => async () => {
        await gate.promise;
        return fauxAssistantMessage(text);
      }),
    );
    await startRuntime(fauxGateway(faux));
    await withCleanup(
      async () => {
        const a = await send("first tenant");
        const b = await send("second tenant", { tenantId: other });
        await poll(
          async () => faux.state.callCount,
          (count) => count >= 2,
        );
        expect(faux.state.callCount).toBe(2);
        expect(await statusOf(a.assistantMessageId)).toEqual([{ status: "running" }]);
        expect(await statusOf(b.assistantMessageId, other)).toEqual([{ status: "running" }]);
      },
      () => gate.resolve(),
      () => stopRuntime(),
    );
  });

  it("aborts a deactivated tenant's real Semp turn while another tenant completes", async () => {
    await stopRuntime();
    const target = await createTestTenant(admin);
    const actorTenant = await createTestTenant(admin);
    const targetUser = await createUser(admin, {
      tenantId: target,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
    });
    const actor = await createUser(admin, {
      tenantId: actorTenant,
      email: `${randomUUID()}@example.test`,
      passwordHash: "unused",
      role: "admin",
    });
    await runInTenant(target, () => seedSystem(pool));
    const inFlight = createInFlightAgentRuns();
    const started = deferred();
    const faux = fauxProvider();
    faux.setResponses([abortableResponse(started.resolve), fauxAssistantMessage("other tenant completed")]);
    const listener = await startTenantDeactivationListener(pool, async (id) => {
      inFlight.abortTenant(id);
    });
    await withCleanup(
      async () => {
        await startRuntime(fauxGateway(faux), inFlight);
        const stopped = await send("target", { tenantId: target });
        await withTimeout(started.promise, 10_000, "Semp turn did not start");
        const allowed = await send("other");
        await runAsSystem("sempCancellationTest", () =>
          withTransaction(pool, (client) =>
            suspendAccount(client, { actorUserId: actor.id, targetUserId: targetUser.id }),
          ),
        );
        const states = await poll(
          async () => [await statusOf(stopped.assistantMessageId, target), await statusOf(allowed.assistantMessageId)],
          ([targetRows, otherRows]) => targetRows?.[0]?.status === "error" && otherRows?.[0]?.status === "done",
        );
        expect(states).toEqual([[{ status: "error" }], [{ status: "done" }]]);
        expect(await statusOf(stopped.assistantMessageId)).toEqual([]);
      },
      () => {
        inFlight.abortTenant(target);
        return stopRuntime();
      },
      () => listener.close(),
    );
  });

  it("refuses oversized stored history before a model call without writing a checkpoint", async () => {
    const turn = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const first = await sendSempMessage(client, { text: "earlier", context: [], hasContext: false });
        expect(await claimSempMessage(client, first.threadId, first.assistantMessageId)).toBe(true);
        const run = await createAgentRun(client, {
          triggeredBy: "user",
          unit: "session",
          task: "earlier",
          threadId: first.threadId,
        });
        const event = await insertAgentRunEvent(client, run.id, "message", {
          kind: "message",
          text: "ě".repeat(131_073),
        });
        await startSempMessageTurn(client, first.assistantMessageId, run.id, event.id);
        expect(
          await finishSempMessageTurn(client, first.assistantMessageId, {
            status: "done",
            text: "earlier answer",
            lastEventId: event.id,
          }),
        ).toBe(true);
        return first;
      }),
    );
    const next = await send("next", { threadId: turn.threadId });
    await expect(
      runInTenant(tenant, () => createBoundedSempHistory()(pool, { threadId: turn.threadId, projectItemId: "unused" })),
    ).rejects.toThrow("Semp conversation history exceeds replay limits");
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("must not run")]);
    await startRuntime(fauxGateway(faux));
    expect(
      await poll(
        () => statusOf(next.assistantMessageId),
        (rows) => rows[0]?.status === "error",
      ),
    ).toEqual([{ status: "error" }]);
    expect(faux.state.callCount).toBe(0);
    expect(
      await tenantRows<{ count: number }>(
        "SELECT count(*)::int AS count FROM agent_run_events e JOIN agent_runs r ON r.id = e.agent_run_id WHERE r.thread_id = $1 AND e.kind = 'compaction'",
        [turn.threadId],
      ),
    ).toEqual([{ count: 0 }]);
  });

  describe("graceful shutdown of an actual Semp turn", () => {
    async function shutdownScenario(
      response: (entered: () => void, gate: Promise<void>) => Parameters<Faux["setResponses"]>[0][number],
      body: (input: {
        shutdownPool: Pool;
        inFlight: InFlightAgentRuns;
        actual: AgentsQueueRuntime;
        turn: Turn;
        release: () => void;
        addCleanup: (cleanup: () => unknown) => void;
      }) => Promise<void>,
    ): Promise<void> {
      await stopRuntime();
      const shutdownPool = await createRuntimeRolePool(admin, "alldots_data");
      const inFlight = createInFlightAgentRuns();
      const gate = deferred();
      const started = deferred();
      const faux = fauxProvider();
      faux.setResponses([response(started.resolve, gate.promise)]);
      let actual: AgentsQueueRuntime | undefined;
      let closed = false;
      const extraCleanups: Array<() => unknown> = [];
      await withCleanup(
        async () => {
          actual = await startRuntime(fauxGateway(faux), inFlight, shutdownPool);
          const turn = await send("shutdown", { db: shutdownPool });
          await started.promise;
          await body({
            shutdownPool,
            inFlight,
            actual,
            turn,
            release: gate.resolve,
            addCleanup: (cleanup) => extraCleanups.push(cleanup),
          });
          closed = true;
        },
        () => gate.resolve(),
        async () => {
          if (closed) return;
          inFlight.abortSemp();
          await actual?.stop();
          await shutdownPool.end();
        },
        async () => {
          for (const cleanup of extraCleanups) await cleanup();
        },
      );
    }

    it("rejects shutdown when a real worker absorbs a terminal persistence failure", async () => {
      await shutdownScenario(
        (entered, gate) => async () => {
          entered();
          await gate;
          return fauxAssistantMessage("reply");
        },
        async ({ shutdownPool, inFlight, actual, turn, release, addCleanup }) => {
          addCleanup(
            await installFailureTrigger({
              table: "semp_messages",
              event: "UPDATE",
              condition: "NEW.id = %L::uuid AND NEW.status IN ('done', 'error')",
              id: turn.assistantMessageId,
              message: "terminal fixture failure",
            }),
          );
          let runnerStopped = false;
          const shutdown = gracefulShutdown(
            {
              stopForShutdown: () => {
                const attempt = actual.stopForShutdown();
                return {
                  general: attempt.general,
                  chat: attempt.chat.then((result) => {
                    if (result.status === "fulfilled") runnerStopped = true;
                    return result;
                  }),
                };
              },
            },
            shutdownPool,
            inFlight,
          );
          release();
          const error: unknown = await shutdown.catch((reason: unknown) => reason);
          expect(runnerStopped).toBe(true);
          if (!(error instanceof AggregateError)) throw new Error("Expected persistence failure", { cause: error });
          expect(error.errors).toHaveLength(2);
          expect(error.cause).toBe(error.errors[0]);
          expect(
            await tenantRows("SELECT status, error_code FROM semp_messages WHERE id = $1", [turn.assistantMessageId]),
          ).toEqual([{ status: "running", error_code: null }]);
        },
      );
    });

    it("preserves the turn and run-recovery failures through actual Semp settlement", async () => {
      await shutdownScenario(
        (entered, gate) => async () => {
          entered();
          await gate;
          return fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider fixture refused" });
        },
        async ({ shutdownPool, inFlight, actual, turn, release, addCleanup }) => {
          const [row] = await tenantRows<{ agent_run_id: string | null }>(
            "SELECT agent_run_id FROM semp_messages WHERE id = $1",
            [turn.assistantMessageId],
          );
          if (!row?.agent_run_id) throw new Error("Missing active Semp run");
          addCleanup(
            await installFailureTrigger({
              table: "agent_run_events",
              event: "INSERT",
              condition: "NEW.agent_run_id = %L::uuid AND NEW.kind = 'run_status' AND NEW.payload->>'status' = 'error'",
              id: row.agent_run_id,
              message: "run recovery fixture failure",
            }),
          );
          const shutdown = gracefulShutdown(actual, shutdownPool, inFlight);
          release();
          const error: unknown = await shutdown.catch((reason: unknown) => reason);
          if (!(error instanceof AggregateError)) throw new Error("Expected run recovery failure", { cause: error });
          expect(error.errors).toHaveLength(2);
          expect(error.cause).toBe(error.errors[0]);
          expect(error.errors[0]).toBeInstanceOf(Error);
          expect(error.errors[1]).toMatchObject({ message: "run recovery fixture failure" });
          expect(await statusOf(turn.assistantMessageId)).toEqual([{ status: "error" }]);
        },
      );
    });

    it("stores interrupted status when the Semp shutdown controller aborts actual work", async () => {
      await shutdownScenario(
        (entered) => abortableResponse(entered),
        async ({ shutdownPool, inFlight, actual, turn }) => {
          const shutdown = gracefulShutdown(actual, shutdownPool, inFlight);
          // Exercise the real deadline action without advancing or shortening the production timer.
          expect(inFlight.abortSemp()).toBe(1);
          await shutdown;
          expect(
            await tenantRows("SELECT status, error_code FROM semp_messages WHERE id = $1", [turn.assistantMessageId]),
          ).toEqual([{ status: "error", error_code: "interrupted" }]);
        },
      );
    });
  });

  it("wakes stored history after a real intervening approval outcome", async () => {
    const faux = fauxProvider();
    const prompts: string[] = [];
    faux.setResponses(
      ["first answer", "second answer"].map((text) => (context: { messages: unknown }) => {
        prompts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage(text);
      }),
    );
    const task = createSempMessageTask(pool, registry, fauxGateway(faux), createInFlightAgentRuns());
    await withCleanup(
      async () => {
        const first = await send("first question");
        await runTask(task, first);
        const [previous] = await tenantRows<{ agent_run_id: string | null; status: string }>(
          "SELECT agent_run_id, status FROM semp_messages WHERE id = $1",
          [first.assistantMessageId],
        );
        expect(previous?.status).toBe("done");
        const runId = previous?.agent_run_id;
        if (!runId) throw new Error("First reply has no run");
        await runInTenant(tenant, () => withTransaction(pool, (client) => rejectApproval(client, runId, "search_web")));
        expect(
          await tenantRows("SELECT system_key FROM semp_messages WHERE thread_id = $1 AND role = 'system'", [
            first.threadId,
          ]),
        ).toEqual([{ system_key: "approval.outcome.rejected" }]);
        const second = await send("second question", { threadId: first.threadId });
        await runTask(task, second);
        const [next] = await tenantRows<{ agent_run_id: string; status: string }>(
          "SELECT agent_run_id, status FROM semp_messages WHERE id = $1",
          [second.assistantMessageId],
        );
        expect(next?.status).toBe("done");
        expect(next?.agent_run_id).not.toBe(runId);
        for (const text of ["first question", "first answer", "second question"]) expect(prompts[1]).toContain(text);
      },
      () => closeIdleThreadSessions(pool),
    );
  });

  it("runs a rejected tick outcome without tools and restores tools for the next user turn", async () => {
    const faux = fauxProvider();
    const observed: Array<{ tools: string[]; messages: string }> = [];
    const observe = (context: TranscriptContext) =>
      observed.push({
        tools: toolsOf(context).map((tool) => tool.name),
        messages: JSON.stringify(context.messages),
      });
    const task = createSempMessageTask(pool, registry, fauxGateway(faux), createInFlightAgentRuns());
    const fixture = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => createTickThread(client, "Outcome test")),
    );
    faux.setResponses([
      (context) => {
        observe(context);
        return fauxAssistantMessage("before");
      },
      (context) => {
        observe(context);
        return fauxAssistantMessage(
          [fauxToolCall("heartbeat_trigger", { heartbeatId: fixture.heartbeatId }, { id: "forbidden-trigger" })],
          { stopReason: "toolUse" },
        );
      },
      () => fauxAssistantMessage("acknowledged"),
      (context) => {
        observe(context);
        return fauxAssistantMessage("after");
      },
    ]);
    await withCleanup(
      async () => {
        const first = await send("before", { threadId: fixture.threadId });
        await runTask(task, first);
        const sessionRun = await tenantRows<{
          id: string;
          unit: string;
          triggered_by: string;
          heartbeat_id: string | null;
        }>(
          "SELECT r.id, r.unit, r.triggered_by, r.heartbeat_id FROM agent_runs r JOIN semp_messages m ON m.tenant_id = r.tenant_id AND m.agent_run_id = r.id WHERE m.id = $1",
          [first.assistantMessageId],
        );
        expect(sessionRun).toEqual([
          { id: expect.any(String), unit: "session", triggered_by: "user", heartbeat_id: null },
        ]);
        const sessionRunId = sessionRun[0]?.id;
        if (!sessionRunId) throw new Error("Missing session run");
        const assistantMessageId = await runInTenant(tenant, () =>
          withTransaction(pool, async (client) => {
            await rejectApproval(client, sessionRunId);
            return acknowledgmentOf(client, fixture.threadId);
          }),
        );
        await runTask(task, { threadId: fixture.threadId, assistantMessageId });
        await runTask(task, await send("after", { threadId: fixture.threadId }));
        expect(observed[0]?.tools.length).toBeGreaterThan(0);
        expect(observed[1]?.tools).toEqual([]);
        expect(observed[1]?.messages).toContain("The action did not happen");
        expect(observed[2]?.tools.length).toBeGreaterThan(0);
        expect(await tenantRows("SELECT status, text FROM semp_messages WHERE id = $1", [assistantMessageId])).toEqual([
          { status: "done", text: "\nacknowledged" },
        ]);
        expect(
          await tenantRows("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
            `heartbeat-fire:manual:${fixture.heartbeatId}`,
          ]),
        ).toEqual([]);
      },
      () => closeIdleThreadSessions(pool),
    );
  });

  it.each(["pre", "post", "turn-and-cleanup"] as const)(
    "preserves real strict freshness failures at %s and recovers",
    async (mode) => {
      const faux = fauxProvider();
      faux.setResponses([fauxAssistantMessage("warm"), fauxAssistantMessage("ack"), fauxAssistantMessage("recovered")]);
      const task = createSempMessageTask(pool, registry, fauxGateway(faux), createInFlightAgentRuns());
      const fixture = await runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const tick = await createTickThread(client, "Freshness failure");
          const warm = await sendSempMessage(client, {
            threadId: tick.threadId,
            text: "warm",
            context: [],
            hasContext: false,
          });
          await rejectApproval(client, tick.runId);
          return { threadId: tick.threadId, warm, acknowledgment: await acknowledgmentOf(client, tick.threadId) };
        }),
      );
      await runTask(task, fixture.warm);
      const closeErrors: unknown[] = [];
      // Both originals are invoked with their actual receiver using .call below.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const originalFresh = SempConversation.prototype.ensureFresh;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const originalSend = SempConversation.prototype.send;
      const primary = new Error("injected turn failure after actual send");
      let calls = 0;
      let removeTrigger: (() => Promise<void>) | undefined;
      const freshSpy = vi.spyOn(SempConversation.prototype, "ensureFresh").mockImplementation(async function (
        this: SempConversation,
        threadId,
        frontier,
      ) {
        calls += 1;
        if (calls === (mode === "pre" ? 1 : 2))
          removeTrigger = await installFailureTrigger({
            table: "agent_runs",
            event: "UPDATE",
            condition: "NEW.tenant_id = %L::uuid AND NEW.status::text = 'done'",
            id: tenant,
            message: "injected strict close failure",
          });
        try {
          return await originalFresh.call(this, threadId, frontier);
        } catch (error) {
          closeErrors.push(error);
          throw error;
        }
      });
      const sendSpy = vi.spyOn(SempConversation.prototype, "send").mockImplementation(async function (
        this: SempConversation,
        text,
        thread,
        options,
      ) {
        const result = await originalSend.call(this, text, thread, options);
        if (mode === "turn-and-cleanup") throw primary;
        return result;
      });
      const restoreSpies = () => {
        freshSpy.mockRestore();
        sendSpy.mockRestore();
      };
      await withCleanup(
        async () => {
          const observed: unknown = await runTask(task, {
            threadId: fixture.threadId,
            assistantMessageId: fixture.acknowledgment,
          }).catch((error: unknown) => error);
          expect(closeErrors).toHaveLength(1);
          expect(String(closeErrors[0])).toContain("injected strict close failure");
          if (mode === "turn-and-cleanup") {
            if (!(observed instanceof AggregateError)) throw new Error("Missing aggregate", { cause: observed });
            expect(observed.cause).toBe(primary);
            expect(observed.errors).toEqual([primary, closeErrors[0]]);
          } else expect(observed).toBe(closeErrors[0]);
          expect(await statusOf(fixture.acknowledgment)).toEqual([{ status: "error" }]);
          await removeTrigger?.();
          restoreSpies();
          const later = await send("recovery", { threadId: fixture.threadId });
          await runTask(task, later);
          expect(await statusOf(later.assistantMessageId)).toEqual([{ status: "done" }]);
        },
        restoreSpies,
        () => removeTrigger?.(),
        () => closeIdleThreadSessions(pool),
      );
    },
  );

  it("executes an earlier queued user turn before the tick outcome through the real queue", async () => {
    await stopRuntime();
    // Direct-handler tests leave their jobs queued; this scenario owns a separate tenant FIFO lane.
    const isolated = await createIsolatedQueueTenant();
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("earlier answer"), fauxAssistantMessage("acknowledged")]);
    const headers: (string | undefined)[] = [];
    const fixture = await runInTenant(isolated.tenant, () =>
      withTransaction(pool, async (client) => {
        const tick = await createTickThread(client, "FIFO");
        const first = await sendSempMessage(client, {
          threadId: tick.threadId,
          text: "earlier",
          context: [],
          hasContext: false,
        });
        await rejectApproval(client, tick.runId, "test", isolated.userId);
        return { first: first.assistantMessageId, later: await acknowledgmentOf(client, tick.threadId) };
      }),
    );
    await expectIsolatedQueueJobs([fixture.first, fixture.later]);
    await startRuntime(fauxGateway(faux, (options) => headers.push(messageHeader(options))));
    await withCleanup(
      async () => {
        const rows = await poll(
          () =>
            tenantRows<{ id: string; status: string; text: string | null }>(
              "SELECT id, status, text FROM semp_messages WHERE id = ANY($1::uuid[]) ORDER BY created_at, id",
              [[fixture.first, fixture.later]],
              isolated.tenant,
            ),
          (current) => current.length === 2 && current.every((row) => row.status === "done"),
        );
        expect(rows).toEqual([
          { id: fixture.first, status: "done", text: "earlier answer" },
          { id: fixture.later, status: "done", text: "acknowledged" },
        ]);
        expect(headers).toEqual([fixture.first, fixture.later]);
      },
      () => stopRuntime(),
      () => closeIdleThreadSessions(pool),
    );
  });

  it("terminalizes a queued outcome without starting a disabled heartbeat", async () => {
    const fixture = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const tick = await createTickThread(client, "Disabled");
        await rejectApproval(client, tick.runId);
        const assistantMessageId = await acknowledgmentOf(client, tick.threadId);
        const disabled = await client.query("UPDATE project_heartbeats SET enabled = false WHERE id = $1", [
          tick.heartbeatId,
        ]);
        expect(disabled.rowCount).toBe(1);
        return { threadId: tick.threadId, assistantMessageId };
      }),
    );
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("must not run")]);
    await runTask(createSempMessageTask(pool, registry, fauxGateway(faux), createInFlightAgentRuns()), fixture);
    expect(
      await tenantRows("SELECT status, agent_run_id, text FROM semp_messages WHERE id = $1", [
        fixture.assistantMessageId,
      ]),
    ).toEqual([{ status: "error", agent_run_id: null, text: null }]);
    expect(faux.getPendingResponseCount()).toBe(1);
  });

  it("clears the current message attribution after a failed session turn", async () => {
    await stopRuntime();
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider refused" }),
      fauxAssistantMessage("next"),
    ]);
    const headers: (string | undefined)[] = [];
    const gateway = fauxGateway(faux, (options) => headers.push(messageHeader(options)));
    const project = await runInTenant(tenant, () => withTransaction(pool, inboxProject));
    const turn = await send("failed");
    const references: { current: string | null }[] = [];
    const conversation = new SempConversation(pool, {
      resolveProjectItemId: async () => project,
      createAgentSessionForRun: async (run, current) => {
        if (!current) throw new Error("Missing Semp attribution reference");
        references.push(current);
        return createAgentSessionFactoryForRun(pool, registry, gateway, run, current);
      },
    });
    await withCleanup(
      async () => {
        await expect(
          runInTenant(tenant, () =>
            conversation.send(
              "failed",
              { kind: "chat", threadId: turn.threadId },
              { messageId: turn.assistantMessageId },
            ),
          ),
        ).rejects.toThrow();
        expect(references[0]?.current).toBeNull();
        const next = await runInTenant(tenant, () =>
          conversation.send("next", { kind: "chat", threadId: turn.threadId }),
        );
        expect(next.ok).toBe(true);
        expect(references[1]?.current).toBeNull();
        expect(headers).toEqual([turn.assistantMessageId, undefined]);
      },
      () => conversation.clear(),
      () => closeIdleThreadSessions(pool),
      () => admin.query("SELECT graphile_worker.remove_job($1)", [`sempMessage:${turn.assistantMessageId}`]),
    );
  });

  it("wakes for a later queued pair and then reuses the reply actually completed", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
    const task = createSempMessageTask(pool, registry, fauxGateway(faux), createInFlightAgentRuns());
    const first = await send("first");
    await runTask(task, first);
    const second = await send("second", { threadId: first.threadId });
    const third = await send("third", { threadId: first.threadId });
    await runTask(task, second);
    await runTask(task, third);
    const rows = await tenantRows<{ status: string; agent_run_id: string }>(
      "SELECT status, agent_run_id FROM semp_messages WHERE id = ANY($1::uuid[]) ORDER BY created_at, id",
      [[first.assistantMessageId, second.assistantMessageId, third.assistantMessageId]],
    );
    expect(rows.map((row) => row.status)).toEqual(["done", "done", "done"]);
    expect(rows[0]?.agent_run_id).not.toBe(rows[1]?.agent_run_id);
    expect(rows[1]?.agent_run_id).toBe(rows[2]?.agent_run_id);
    await closeIdleThreadSessions(pool);
  });

  it("reconstructs a fitting checkpoint and paired tool tail on a later task wake", async () => {
    const faux = fauxProvider();
    const prompts: string[] = [];
    faux.setResponses([
      fauxAssistantMessage("first reply"),
      (context) => {
        prompts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("later reply");
      },
    ]);
    const gateway = fauxGateway(faux);
    const first = await send("first wake");
    await runTask(createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns()), first);
    const [previous] = await tenantRows<{ agent_run_id: string | null }>(
      "SELECT agent_run_id FROM semp_messages WHERE id = $1",
      [first.assistantMessageId],
    );
    const runId = previous?.agent_run_id;
    if (!runId) throw new Error("Missing first session run");
    await runInTenant(tenant, async () => {
      await insertAgentRunEvent(pool, runId, "compaction", [
        {
          id: "summary",
          parentId: null,
          seq: 0,
          timestamp: 0,
          message: { kind: "user_message", text: "checkpoint summary", context: [] },
        },
        {
          id: "assistant",
          parentId: "summary",
          seq: 1,
          timestamp: 0,
          message: {
            kind: "message",
            role: "assistant",
            content: [{ type: "toolCall", id: "pair", name: "search", arguments: {} }],
            stopReason: "toolUse",
          },
        },
        {
          id: "tool",
          parentId: "assistant",
          seq: 2,
          timestamp: 0,
          message: { kind: "tool_use", toolCallId: "pair", name: "search" },
        },
      ]);
      await insertAgentRunEvent(pool, runId, "tool_result", {
        kind: "tool_result",
        toolCallId: "pair",
        name: "search",
        isError: false,
        result: { content: [{ type: "text", text: "tail result" }] },
      });
    });
    await closeIdleThreadSessions(pool);
    const second = await send("later wake", { threadId: first.threadId });
    await runTask(createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns()), second);
    expect(prompts).toHaveLength(1);
    for (const text of ["checkpoint summary", '"toolCallId":"pair"', "tail result", "later wake"])
      expect(prompts[0]).toContain(text);
    expect(prompts[0]).not.toContain("first wake");
    await closeIdleThreadSessions(pool);
  });

  it("wakes when the completed reply's stored content changes under the same id", async () => {
    const other = await createTestTenant(admin);
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("original"), fauxAssistantMessage("after change")]);
    let calls = 0;
    const task = createSempMessageTask(
      pool,
      registry,
      fauxGateway(faux, () => calls++),
      createInFlightAgentRuns(),
    );
    const first = await send("first");
    await runTask(task, first);
    // Synthetic stored-row change exercises the cache frontier; no production writer of a completed reply is implied.
    const update = (tenantId: string, text: string) =>
      runInTenant(tenantId, () =>
        pool.query("UPDATE semp_messages SET text = $1 WHERE id = $2", [text, first.assistantMessageId]),
      );
    expect((await update(other, "foreign")).rowCount).toBe(0);
    expect((await update(tenant, "changed fixture")).rowCount).toBe(1);
    const second = await send("second", { threadId: first.threadId });
    await runTask(task, second, other);
    await runTask(task, { threadId: second.threadId, assistantMessageId: randomUUID() });
    expect(calls).toBe(1);
    await runTask(task, second);
    const rows = await tenantRows<{ id: string; agent_run_id: string; status: string }>(
      "SELECT id, agent_run_id, status FROM semp_messages WHERE id = ANY($1::uuid[]) ORDER BY created_at, id",
      [[first.assistantMessageId, second.assistantMessageId]],
    );
    expect(rows.map((row) => [row.id, row.status])).toEqual([
      [first.assistantMessageId, "done"],
      [second.assistantMessageId, "done"],
    ]);
    expect(rows[0]?.agent_run_id).not.toBe(rows[1]?.agent_run_id);
    expect(calls).toBe(2);
    await closeIdleThreadSessions(pool);
  });

  it("publishes the committed turn invalidation for the owning tenant", async () => {
    await stopRuntime();
    const { tenant: owner } = await createIsolatedQueueTenant();
    const other = await createTestTenant(admin);
    const turn = await send("notify", { tenantId: owner });
    await expectIsolatedQueueJobs([turn.assistantMessageId]);
    const listener = await admin.connect();
    const sentinelId = randomUUID();
    const observed: { tenantId: string; threadId: string }[] = [];
    listener.on("notification", (notification) => {
      if (notification.channel !== REALTIME_CHANNEL || !notification.payload) return;
      const parsed: unknown = JSON.parse(notification.payload);
      if (!isRecord(parsed) || typeof parsed.tenantId !== "string" || !isRecord(parsed.message)) return;
      const message = parsed.message;
      if (message.type !== "invalidation" || message.scope !== "sempThread" || typeof message.threadId !== "string")
        return;
      observed.push({ tenantId: parsed.tenantId, threadId: message.threadId });
    });
    const eventsFor = (threadId: string) =>
      observed.filter((value) => value.tenantId === owner && value.threadId === threadId);
    await withCleanup(
      async () => {
        await listener.query(`LISTEN ${REALTIME_CHANNEL}`);
        wireRealtimeHooks(pool);
        await runInTenant(owner, () =>
          publishRealtimeMessage(pool, { type: "invalidation", scope: "sempThread", threadId: sentinelId }),
        );
        await poll(
          async () => eventsFor(sentinelId).length,
          (count) => count > 0,
        );
        expect(observed).toContainEqual({ tenantId: owner, threadId: sentinelId });
        const faux = fauxProvider();
        faux.setResponses([
          fauxAssistantMessage("notified"),
          fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider refused" }),
        ]);
        await startRuntime(fauxGateway(faux));
        await poll(
          async () => eventsFor(turn.threadId).length,
          (count) => count > 0,
        );
        expect(await statusOf(turn.assistantMessageId, other)).toEqual([]);
        expect(await statusOf(randomUUID(), owner)).toEqual([]);
        expect(await statusOf(turn.assistantMessageId, owner)).toEqual([{ status: "done" }]);
        expect(eventsFor(turn.threadId)).toHaveLength(1);

        // A failed turn publishes its invalidation too.
        const failedTurn = await send("fail", { tenantId: owner, threadId: turn.threadId });
        await poll(
          async () => eventsFor(turn.threadId).length,
          (count) => count >= 2,
        );
        expect(await statusOf(failedTurn.assistantMessageId, owner)).toEqual([{ status: "error" }]);
        expect(eventsFor(turn.threadId)).toHaveLength(2);
        expect(observed.filter((value) => value.tenantId === other)).toEqual([]);
      },
      () => stopRuntime(),
      () => listener.release(true),
    );
  });
});
