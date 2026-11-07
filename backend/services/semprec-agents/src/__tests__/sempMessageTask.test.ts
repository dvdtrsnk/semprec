import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import sharp from "sharp";
import { closeIdleThreadSessions, createBoundedSempHistory, SempConversation } from "@semprec/agent-runtime";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  claimSempMessage,
  createChokePoint,
  createAgentRun,
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
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  ensureFolderItem,
  getTestPool,
  ingestEmailMessage,
  resetDatabase,
  setTenantAiBudget,
} from "@semprec/data/testSupport";
import type { ModuleRegistry } from "@semprec/module-registry";
import { AGENT_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { REALTIME_CHANNEL, publishRealtimeMessage, wireRealtimeHooks } from "@semprec/realtime";
import { createInFlightAgentRuns } from "../inFlightAgentRuns.js";
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

type RefFixtureMessage =
  | { type: "ready"; port: number }
  | { type: "gatewayRequest"; sequence: number; bodyBytes: number }
  | {
      type: "observation";
      sequence: number;
      owner: boolean;
      foreign: boolean;
      mailFirst: boolean;
      mailReply: boolean;
      block: boolean;
      sibling: boolean;
      imageCount: number;
      imageMimes: string[];
      providerSerializedBytes: number;
    };

function parseRefFixtureMessage(value: unknown): RefFixtureMessage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  if (!("type" in value)) return null;
  if (
    value.type === "ready" &&
    Object.keys(value).length === 2 &&
    "port" in value &&
    typeof value.port === "number" &&
    Number.isInteger(value.port) &&
    value.port >= 1 &&
    value.port <= 65535
  )
    return { type: "ready", port: value.port };
  if (
    value.type === "gatewayRequest" &&
    Object.keys(value).length === 3 &&
    "sequence" in value &&
    typeof value.sequence === "number" &&
    Number.isInteger(value.sequence) &&
    value.sequence >= 1 &&
    value.sequence <= 20 &&
    "bodyBytes" in value &&
    typeof value.bodyBytes === "number" &&
    Number.isInteger(value.bodyBytes) &&
    value.bodyBytes > 0 &&
    value.bodyBytes <= 4 * 1024 * 1024
  )
    return { type: "gatewayRequest", sequence: value.sequence, bodyBytes: value.bodyBytes };
  if (
    value.type === "observation" &&
    Object.keys(value).length === 11 &&
    "sequence" in value &&
    typeof value.sequence === "number" &&
    Number.isInteger(value.sequence) &&
    value.sequence >= 1 &&
    value.sequence <= 20 &&
    "owner" in value &&
    typeof value.owner === "boolean" &&
    "foreign" in value &&
    typeof value.foreign === "boolean" &&
    "mailFirst" in value &&
    typeof value.mailFirst === "boolean" &&
    "mailReply" in value &&
    typeof value.mailReply === "boolean" &&
    "block" in value &&
    typeof value.block === "boolean" &&
    "sibling" in value &&
    typeof value.sibling === "boolean" &&
    "imageCount" in value &&
    typeof value.imageCount === "number" &&
    Number.isInteger(value.imageCount) &&
    value.imageCount >= 0 &&
    value.imageCount <= 100_000 &&
    "imageMimes" in value &&
    Array.isArray(value.imageMimes) &&
    value.imageMimes.length <= 4 &&
    value.imageMimes.every(
      (mime: unknown): mime is string =>
        typeof mime === "string" && ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime),
    ) &&
    "providerSerializedBytes" in value &&
    typeof value.providerSerializedBytes === "number" &&
    Number.isInteger(value.providerSerializedBytes) &&
    value.providerSerializedBytes > 0 &&
    value.providerSerializedBytes <= 4 * 1024 * 1024
  )
    return {
      type: "observation",
      sequence: value.sequence,
      owner: value.owner,
      foreign: value.foreign,
      mailFirst: value.mailFirst,
      mailReply: value.mailReply,
      block: value.block,
      sibling: value.sibling,
      imageCount: value.imageCount,
      imageMimes: value.imageMimes,
      providerSerializedBytes: value.providerSerializedBytes,
    };
  return null;
}

describe("queued Semp messages", () => {
  beforeAll(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    pool = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runAsSystem("test:role", () =>
      pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
        "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      ),
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    tenant = await createTestTenant(admin);
    userId = (
      await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "unused" })
    ).id;
    await runInTenant(tenant, () => seedSystem(pool));
    registry = await loadFullModuleRegistry();
  });

  afterAll(async () => {
    const errors: unknown[] = [];
    try {
      await runtime?.stop();
    } catch (error) {
      errors.push(error);
    }
    try {
      await pool?.end();
    } catch (error) {
      errors.push(error);
    }
    try {
      await admin?.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, "Semp test cleanup failed", { cause: errors[0] });
  });

  it("expands tenant references through the registered worker and real gateway without persisting content", async () => {
    await runtime?.stop();
    runtime = undefined;
    const backend = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
    const blockRoot = resolve(backend, "../shared/block-model");
    const fixture = join(backend, "services/semprec-ai-gateway/dist/__tests__/fixtures/refExpansionGateway.js");
    const fixtureSource = join(backend, "services/semprec-ai-gateway/src/__tests__/fixtures/refExpansionGateway.ts");
    const messages: RefFixtureMessage[] = [];
    let invalidOutput = false;
    let outputBytes = 0;
    let child: ChildProcess | undefined;
    let childExit: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }> | undefined;
    let exited = false;
    let blockDir: string | undefined;
    let mailRoot: string | undefined;
    let workerSettled: boolean;
    let failed = false;
    let failure: unknown;
    const cleanupFailures: unknown[] = [];
    try {
      if ((await stat(fixture)).mtimeMs < (await stat(fixtureSource)).mtimeMs)
        throw new Error("Stale reference gateway fixture build");
      blockDir = await mkdtemp(join(blockRoot, "node_modules/.batch09-"));
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
      const compiled = spawnSync(process.execPath, args, { cwd: backend, timeout: 25_000, maxBuffer: 1_000_000 });
      process.stderr.write(
        `ref block compiler pid=${compiled.pid} status=${compiled.status} signal=${compiled.signal} argv=${JSON.stringify([process.execPath, ...args])}\n`,
      );
      if (compiled.error) throw compiled.error;
      if (compiled.status !== 0) throw new Error("Reference fixture block-model build failed");
      const blockEntry = join(blockDir, "index.js");
      const fixtureHash = createHash("sha256")
        .update(await readFile(fixture))
        .digest("hex");
      const blockHash = createHash("sha256")
        .update(await readFile(blockEntry))
        .digest("hex");
      const databaseUrl = pool.options.connectionString;
      if (typeof databaseUrl !== "string") throw new Error("Missing runtime database URL");
      child = spawn(process.execPath, [fixture], {
        cwd: backend,
        detached: true,
        env: { ...process.env, BATCH09_BLOCK_MODEL_ENTRY: blockEntry, BATCH32_GATEWAY_DATABASE_URL: databaseUrl },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      const owned = child;
      if (!owned.pid) throw new Error("Reference gateway child did not start");
      childExit = new Promise((resolveExit) => {
        let childError: Error | undefined;
        owned.once("error", (error) => {
          childError = error;
        });
        owned.once("close", (code, signal) => {
          exited = true;
          resolveExit({ code, signal, ...(childError ? { error: childError } : {}) });
        });
      });
      const pgid = Number(execFileSync("ps", ["-o", "pgid=", "-p", String(owned.pid)], { encoding: "utf8" }).trim());
      if (pgid !== owned.pid) throw new Error("Unexpected reference gateway process group");
      process.stderr.write(
        `ref gateway argv=${JSON.stringify([process.execPath, fixture])} pid=${owned.pid} pgid=${pgid} sha256=${fixtureHash} blockSha256=${blockHash}\n`,
      );
      for (const output of [owned.stdout, owned.stderr])
        output?.on("data", (chunk: Buffer) => {
          outputBytes += chunk.length;
          if (outputBytes > 100_000) invalidOutput = true;
        });
      owned.on("message", (value: unknown) => {
        const parsed = parseRefFixtureMessage(value);
        if (!parsed || messages.length >= 50 || JSON.stringify(value).length > 512) invalidOutput = true;
        else messages.push(parsed);
      });
      await vi.waitFor(
        () => {
          expect(invalidOutput).toBe(false);
          expect(messages.some((entry) => entry.type === "ready")).toBe(true);
        },
        { timeout: 10_000 },
      );
      const ready = messages.find((entry) => entry.type === "ready");
      if (!ready || ready.type !== "ready") throw new Error("Missing reference gateway readiness");
      await setTenantAiBudget(admin, tenant, { dailyCapUsd: 100, monthlyCapUsd: 100 });
      const foreign = await createTestTenant(admin);
      await runInTenant(foreign, () => seedSystem(pool));
      const ids = await runInTenant(tenant, () =>
        withTransaction(pool, async (client) => {
          const database = await getDatabaseByModuleId(client, "areas");
          if (!database) throw new Error("Missing areas database");
          const item = await createItemWithClient(client, {
            databaseId: database.id,
            properties: { name: "Reference", note: "REF_OWNER_SENTINEL_32" },
          });
          return { databaseId: database.id, itemId: item.id };
        }),
      );
      mailRoot = await mkdtemp(join(tmpdir(), "semp-ref-worker-mail-"));
      const mailStorage = new LocalFsBlobStorageWriter(join(mailRoot, "mail"));
      const fileStorage = new LocalFsBlobStorageWriter(join(mailRoot, "files"));
      const mail = await runInTenant(tenant, () =>
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
          const folderId = await ensureFolderItem(client, {
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
            folderItemId: folderId,
            mailboxItemId: mailboxItem.id,
            subject: "Reference thread",
            envelope: {},
            attachments: [],
            storage: mailStorage,
            storageKeyPrefix: "reference-worker",
          };
          const first = await ingestEmailMessage(client, {
            ...common,
            messageId,
            bodyText: "REF_MAIL_FIRST_SENTINEL_32",
          });
          const reply = await ingestEmailMessage(client, {
            ...common,
            messageId: `<${randomUUID()}@example.test>`,
            inReplyTo: messageId,
            references: [messageId],
            bodyText: "REF_MAIL_REPLY_SENTINEL_32",
          });
          const threads = await client.query<{ item_id: string; thread_id: string | null }>(
            "SELECT item_id, thread_id FROM mail_message_meta WHERE item_id = ANY($1::uuid[]) ORDER BY item_id",
            [[first.itemId, reply.itemId]],
          );
          expect(threads.rows).toHaveLength(2);
          expect(threads.rows[0]?.thread_id).toBeTruthy();
          expect(threads.rows[0]?.thread_id).toBe(threads.rows[1]?.thread_id);
          return { databaseId: mailIds.emailsDatabaseId, itemId: first.itemId };
        }),
      );
      const blockId = randomUUID();
      const siblingId = randomUUID();
      const parentId = randomUUID();
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
        await docs.putBlock(ids.itemId, { id: parentId, flavour: "page", children: [blockId, siblingId] }, "user");
      });
      const imageBytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: "#2376af" } })
        .png()
        .toBuffer();
      const fileDatabase = await runInTenant(tenant, () =>
        withTransaction(pool, (client) => getDatabaseByModuleId(client, "files")),
      );
      if (!fileDatabase) throw new Error("Missing Files database");
      const imageRefs: Array<{ kind: "item"; databaseId: string; itemId: string }> = [];
      for (let index = 0; index < 10; index += 1) {
        const image = await runInTenant(tenant, async () => {
          const upload = await ingestUploadedBlob(pool, {
            mimeType: "image/png",
            source: Readable.from([imageBytes]),
            maxBytes: imageBytes.length + 1,
            storage: fileStorage,
          });
          return createChokePoint(pool).createItem({
            databaseId: fileDatabase.id,
            properties: { name: `Reference image ${index}`, file: { blobId: upload.blob.id } },
          });
        });
        imageRefs.push({ kind: "item", databaseId: fileDatabase.id, itemId: image.id });
      }
      const foreignIds = await runInTenant(foreign, () =>
        withTransaction(pool, async (client) => {
          const database = await getDatabaseByModuleId(client, "areas");
          if (!database) throw new Error("Missing foreign areas database");
          const item = await createItemWithClient(client, {
            databaseId: database.id,
            properties: { name: "REF_FOREIGN_SENTINEL_32" },
          });
          return { databaseId: database.id, itemId: item.id };
        }),
      );
      const refs = [
        { kind: "item" as const, ...ids },
        { kind: "item" as const, ...mail },
        { kind: "block" as const, itemId: ids.itemId, blockId },
        ...imageRefs.slice(0, 9),
      ];
      await expect(
        withTransaction(pool, (client) => readSempRefContext(client, { kind: "item", ...ids })),
      ).rejects.toThrow();
      expect(messages.filter((entry) => entry.type === "observation")).toHaveLength(0);
      const refused = [
        { kind: "item" as const, ...foreignIds },
        { kind: "item" as const, databaseId: ids.databaseId, itemId: randomUUID() },
      ];
      const countMessages = () =>
        runInTenant(tenant, () => pool.query<{ count: string }>("SELECT count(*)::text AS count FROM semp_messages"));
      const beforeRefusal = await countMessages();
      const jobsBeforeRefusal = await admin.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM graphile_worker.jobs",
      );
      for (const ref of refused) {
        await expect(
          runInTenant(tenant, () => withTransaction(pool, (client) => validateSempMessageRefs(client, [ref]))),
        ).rejects.toThrow();
        expect(
          await runInTenant(tenant, () => withTransaction(pool, (client) => readSempRefContext(client, ref))),
        ).toBeNull();
      }
      expect((await countMessages()).rows).toEqual(beforeRefusal.rows);
      expect(
        (await admin.query<{ count: string }>("SELECT count(*)::text AS count FROM graphile_worker.jobs")).rows,
      ).toEqual(jobsBeforeRefusal.rows);
      const turn = await runInTenant(tenant, () =>
        withTransaction(pool, async (client) =>
          sendSempMessage(client, {
            text: "Question",
            context: await validateSempMessageRefs(client, refs),
            hasContext: true,
          }),
        ),
      );
      const gateway = createGatewayModel({
        AI_GATEWAY_BASE_URL: `http://127.0.0.1:${ready.port}/internal/pi`,
        AI_GATEWAY_INTERNAL_TOKEN: "batch32-ref-test-token",
        AGENT_MODEL: "claude-haiku-4-5",
      });
      runtime = await createAgentsQueueRuntime(pool, registry, {
        sempMessageTask: createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns(), {
          files: fileStorage,
          mailAttachments: mailStorage,
        }),
      });
      let runId = "";
      await vi.waitFor(
        async () => {
          const result = await runInTenant(tenant, () =>
            pool.query<{ status: string; agent_run_id: string | null }>(
              "SELECT status, agent_run_id FROM semp_messages WHERE id = $1",
              [turn.assistantMessageId],
            ),
          );
          expect(result.rows[0]?.status).toBe("done");
          runId = result.rows[0]?.agent_run_id ?? "";
          expect(runId).not.toBe("");
        },
        { timeout: 20_000 },
      );
      await vi.waitFor(
        () =>
          expect(messages.filter((entry) => entry.type === "observation")).toEqual([
            expect.objectContaining({
              type: "observation",
              sequence: 1,
              owner: true,
              foreign: false,
              mailFirst: true,
              mailReply: true,
              block: true,
              sibling: true,
              imageCount: 9,
              imageMimes: ["image/jpeg"],
              providerSerializedBytes: expect.any(Number),
            }),
          ]),
        { timeout: 5000 },
      );
      const requestObservations = messages.filter((entry) => entry.type === "gatewayRequest");
      expect(requestObservations).toHaveLength(1);
      expect(requestObservations[0]?.bodyBytes).toBeLessThan(4 * 1024 * 1024);
      const evidence = await runInTenant(tenant, async () => {
        const run = await pool.query<{ task: string }>("SELECT task FROM agent_runs WHERE id = $1", [runId]);
        const events = await pool.query<{ payload: unknown }>(
          "SELECT payload FROM agent_run_events WHERE agent_run_id = $1 ORDER BY id",
          [runId],
        );
        const calls = await pool.query<{ status: string; agent_run_id: string; semp_message_id: string }>(
          "SELECT status, agent_run_id, semp_message_id FROM ai_gateway_calls WHERE agent_run_id = $1",
          [runId],
        );
        const storedMessages = await pool.query<{ id: string; context: unknown; reply_to_message_id: string | null }>(
          "SELECT id, context, reply_to_message_id FROM semp_messages WHERE id = ANY($1::uuid[])",
          [[turn.messageId, turn.assistantMessageId]],
        );
        return { run: run.rows, events: events.rows, calls: calls.rows, messages: storedMessages.rows };
      });
      expect(evidence.run).toEqual([{ task: "Question" }]);
      expect(evidence.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: turn.messageId, context: refs }),
          expect.objectContaining({ id: turn.assistantMessageId, reply_to_message_id: turn.messageId }),
        ]),
      );
      expect(JSON.stringify(evidence.events)).not.toContain("REF_OWNER_SENTINEL_32");
      expect(JSON.stringify(evidence.events)).not.toContain("REF_FOREIGN_SENTINEL_32");
      for (const sentinel of [
        "REF_MAIL_FIRST_SENTINEL_32",
        "REF_MAIL_REPLY_SENTINEL_32",
        "REF_BLOCK_SENTINEL_32",
        "REF_SIBLING_SENTINEL_32",
      ]) {
        expect(JSON.stringify(evidence.events)).not.toContain(sentinel);
        expect(JSON.stringify(evidence.run)).not.toContain(sentinel);
        expect(JSON.stringify(evidence.messages)).not.toContain(sentinel);
      }
      expect(evidence.events).toEqual(
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
              ]),
            }),
          }),
        ]),
      );
      expect(evidence.calls).toEqual([
        { status: "settled", agent_run_id: runId, semp_message_id: turn.assistantMessageId },
      ]);
      expect(JSON.stringify([evidence.events, evidence.messages])).not.toContain("image/jpeg");
      expect(JSON.stringify([evidence.events, evidence.messages])).not.toContain("base64");

      const lastImage = imageRefs[9];
      if (!lastImage) throw new Error("Missing final image fixture");
      const continued = await runInTenant(tenant, () =>
        withTransaction(pool, async (client) =>
          sendSempMessage(client, {
            threadId: turn.threadId,
            text: "Continue with an image",
            context: await validateSempMessageRefs(client, [lastImage]),
            hasContext: true,
          }),
        ),
      );
      const continuedRun = await vi.waitFor(
        async () => {
          const result = await runInTenant(tenant, () =>
            pool.query<{ status: string; agent_run_id: string | null }>(
              "SELECT status, agent_run_id FROM semp_messages WHERE id = $1",
              [continued.assistantMessageId],
            ),
          );
          expect(result.rows[0]?.status).toBe("done");
          expect(result.rows[0]?.agent_run_id).toBe(runId);
          return result.rows[0]?.agent_run_id;
        },
        { timeout: 20_000 },
      );
      expect(continuedRun).toBe(runId);
      await vi.waitFor(
        () => {
          const observation = messages.find((entry) => entry.type === "observation" && entry.sequence === 2);
          expect(observation).toMatchObject({ imageCount: 10, imageMimes: ["image/jpeg"] });
          const request = messages.find((entry) => entry.type === "gatewayRequest" && entry.sequence === 2);
          expect(request?.bodyBytes).toBeLessThan(4 * 1024 * 1024);
        },
        { timeout: 5000 },
      );
      const continuedCalls = await runInTenant(tenant, () =>
        pool.query<{ status: string; agent_run_id: string; semp_message_id: string }>(
          "SELECT status, agent_run_id, semp_message_id FROM ai_gateway_calls WHERE agent_run_id = $1 AND semp_message_id = $2",
          [runId, continued.assistantMessageId],
        ),
      );
      expect(continuedCalls.rows).toEqual([
        { status: "settled", agent_run_id: runId, semp_message_id: continued.assistantMessageId },
      ]);
      const closed = await closeIdleThreadSessions(pool);
      expect(closed.closedRunIds).toContain(runId);
      const wake = await runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          sendSempMessage(client, {
            threadId: turn.threadId,
            text: "Wake the image history",
            context: [],
            hasContext: false,
          }),
        ),
      );
      const wakeRun = await vi.waitFor(
        async () => {
          const result = await runInTenant(tenant, () =>
            pool.query<{ status: string; agent_run_id: string | null }>(
              "SELECT status, agent_run_id FROM semp_messages WHERE id = $1",
              [wake.assistantMessageId],
            ),
          );
          expect(result.rows[0]?.status).toBe("done");
          expect(result.rows[0]?.agent_run_id).toBeTruthy();
          return result.rows[0]?.agent_run_id;
        },
        { timeout: 20_000 },
      );
      if (!wakeRun) throw new Error("Missing wake run");
      await vi.waitFor(
        () => {
          const observation = messages.find((entry) => entry.type === "observation" && entry.sequence === 3);
          expect(observation).toMatchObject({ imageCount: 10, imageMimes: ["image/jpeg"] });
          const request = messages.find((entry) => entry.type === "gatewayRequest" && entry.sequence === 3);
          expect(request?.bodyBytes).toBeLessThan(4 * 1024 * 1024);
        },
        { timeout: 5000 },
      );
      const wakeEvidence = await runInTenant(tenant, async () => {
        const calls = await pool.query<{ status: string; agent_run_id: string; semp_message_id: string }>(
          "SELECT status, agent_run_id, semp_message_id FROM ai_gateway_calls WHERE agent_run_id = $1 AND semp_message_id = $2",
          [wakeRun, wake.assistantMessageId],
        );
        const events = await pool.query<{ payload: unknown }>(
          "SELECT payload FROM agent_run_events WHERE agent_run_id = ANY($1::uuid[]) ORDER BY id",
          [[runId, wakeRun]],
        );
        const messages = await pool.query<{ id: string; context: unknown }>(
          "SELECT id, context FROM semp_messages WHERE id = ANY($1::uuid[])",
          [[turn.messageId, continued.messageId, wake.messageId]],
        );
        return { calls: calls.rows, events: events.rows, messages: messages.rows };
      });
      expect(wakeEvidence.calls).toEqual([
        { status: "settled", agent_run_id: wakeRun, semp_message_id: wake.assistantMessageId },
      ]);
      expect(wakeEvidence.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: turn.messageId, context: refs }),
          expect.objectContaining({ id: continued.messageId, context: [lastImage] }),
          expect.objectContaining({ id: wake.messageId, context: [] }),
        ]),
      );
      expect(JSON.stringify([wakeEvidence.events, wakeEvidence.messages])).not.toContain("image/jpeg");
      expect(JSON.stringify([wakeEvidence.events, wakeEvidence.messages])).not.toContain("base64");
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      const active = runtime;
      runtime = undefined;
      await active?.stop();
      workerSettled = true;
    } catch (error) {
      workerSettled = false;
      cleanupFailures.push(error);
    }
    try {
      await closeIdleThreadSessions(pool);
    } catch (error) {
      workerSettled = false;
      cleanupFailures.push(error);
    }
    if (child && childExit && !exited) {
      try {
        child.send?.({ type: "stop" });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            childExit,
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error("Reference gateway stop timed out")), 10_000);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      } catch (error) {
        cleanupFailures.push(error);
        try {
          child.kill("SIGKILL");
          await childExit;
        } catch (killError) {
          cleanupFailures.push(killError);
        }
      }
    }
    if (childExit && exited) {
      try {
        const outcome = await childExit;
        process.stderr.write(`ref gateway exit=${outcome.code} signal=${outcome.signal}\n`);
        if (outcome.error) throw outcome.error;
        if (outcome.code !== 0 || outcome.signal !== null) throw new Error("Reference gateway did not exit cleanly");
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (blockDir && (!child || exited) && workerSettled) {
      try {
        await rm(blockDir, { recursive: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (mailRoot && (!child || exited) && workerSettled) {
      try {
        await rm(mailRoot, { recursive: true });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (failed && cleanupFailures.length)
      throw new AggregateError([failure, ...cleanupFailures], "Reference worker test and cleanup failed", {
        cause: failure,
      });
    if (failed)
      throw failure instanceof Error ? failure : new Error("Reference worker test failed", { cause: failure });
    if (cleanupFailures.length)
      throw new AggregateError(cleanupFailures, "Reference worker cleanup failed", { cause: cleanupFailures[0] });
  }, 60_000);

  it("refuses Semp enqueue outside a tenant scope without creating a job", async () => {
    const payload = { threadId: randomUUID(), assistantMessageId: randomUUID() };
    const key = `sempMessage:${payload.assistantMessageId}`;
    const jobs = () => admin.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = $1", [key]);
    expect((await jobs()).rows).toEqual([]);
    await expect(
      runAsSystem("test:semp-enqueue", () => withTransaction(pool, (client) => enqueueSempMessage(client, payload))),
    ).rejects.toThrow("Semp message enqueue requires a tenant scope");
    expect((await jobs()).rows).toEqual([]);
  });

  it("ignores running, failed, missing and foreign messages without model or queue effects", async () => {
    await runtime?.stop();
    runtime = undefined;
    const other = await createTestTenant(admin);
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("must not run")]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    const task = createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns());
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
    const keys = Object.values(turns).map((turn) => `sempMessage:${turn.assistantMessageId}`);
    const jobs = () =>
      admin.query<{ key: string }>("SELECT key FROM graphile_worker.jobs WHERE key = ANY($1::text[]) ORDER BY key", [
        keys,
      ]);
    const before = (await jobs()).rows;
    expect(before).toHaveLength(2);
    for (const turn of [turns.running, turns.failed]) {
      await runInTenant(tenant, () =>
        task({ threadId: turn.threadId, assistantMessageId: turn.assistantMessageId }, { job: { id: "noop" } }),
      );
    }
    await runInTenant(tenant, () =>
      task({ threadId: turns.running.threadId, assistantMessageId: randomUUID() }, { job: { id: "missing" } }),
    );
    await runInTenant(other, () =>
      task(
        { threadId: turns.running.threadId, assistantMessageId: turns.running.assistantMessageId },
        { job: { id: "foreign" } },
      ),
    );
    const states = await runInTenant(tenant, () =>
      pool.query<{ id: string; status: string }>("SELECT id, status FROM semp_messages WHERE id = ANY($1::uuid[])", [
        [turns.running.assistantMessageId, turns.failed.assistantMessageId],
      ]),
    );
    expect(states.rows).toEqual(
      expect.arrayContaining([
        { id: turns.running.assistantMessageId, status: "running" },
        { id: turns.failed.assistantMessageId, status: "error" },
      ]),
    );
    expect(states.rows).toHaveLength(2);
    expect((await jobs()).rows).toEqual(before);
    expect(faux.getPendingResponseCount()).toBe(1);
  });

  it("runs two queued turns in their stored order through the real agents runtime", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
    const messageHeaders: (string | undefined)[] = [];
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => {
        messageHeaders.push(options?.headers?.["x-semprec-semp-message-id"] ?? undefined);
        return faux.provider.streamSimple(model, context, options);
      },
      isBudgetRefusal: () => false,
    };
    runtime = await createAgentsQueueRuntime(pool, registry, {
      sempMessageTask: createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns()),
    });
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
    const first = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => sendSempMessage(client, { text: "first", context: [ref], hasContext: true })),
    );
    const second = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { threadId: first.threadId, text: "second", context: [], hasContext: false }),
      ),
    );
    const read = () =>
      runInTenant(tenant, () =>
        pool.query<{
          id: string;
          text: string | null;
          status: string | null;
          agent_run_id: string | null;
          event_from_id: string | null;
          event_to_id: string | null;
        }>(
          "SELECT id, text, status, agent_run_id, event_from_id, event_to_id FROM semp_messages WHERE id = ANY($1::uuid[]) ORDER BY created_at, id",
          [[first.assistantMessageId, second.assistantMessageId]],
        ),
      );
    const deadline = Date.now() + 15_000;
    let rows = (await read()).rows;
    while (rows.some((row) => row.status !== "done") && Date.now() < deadline) {
      await sleep(50);
      rows = (await read()).rows;
    }
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => [row.id, row.text, row.status])).toEqual([
      [first.assistantMessageId, "first answer", "done"],
      [second.assistantMessageId, "second answer", "done"],
    ]);
    for (const row of rows) {
      expect(row.agent_run_id).toEqual(expect.any(String));
      expect(row.event_from_id).toEqual(expect.any(String));
      expect(row.event_to_id).toEqual(expect.any(String));
    }
    expect(rows[0]?.agent_run_id).toBe(rows[1]?.agent_run_id);
    expect(messageHeaders).toEqual([first.assistantMessageId, second.assistantMessageId]);
    const userEvents = await runInTenant(tenant, () =>
      pool.query<{ payload: unknown }>(
        "SELECT payload FROM agent_run_events WHERE agent_run_id = $1 AND kind = 'user_message' ORDER BY id",
        [rows[0]?.agent_run_id],
      ),
    );
    expect(userEvents.rows).toEqual([
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
    await runtime?.stop();
    runtime = undefined;
    const turn = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { text: "title rollback", context: [], hasContext: false }),
      ),
    );
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
            `sempThreadTitle:${turn.threadId}`,
          ]);
          expect(job.rows).toEqual([{ key: `sempThreadTitle:${turn.threadId}` }]);
          throw new Error("rollback sentinel");
        }),
      ),
    ).rejects.toThrow("rollback sentinel");
    const after = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => ({
        message: await client.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [
          turn.assistantMessageId,
        ]),
        job: await client.query("SELECT key FROM graphile_worker.jobs WHERE key = $1", [
          `sempThreadTitle:${turn.threadId}`,
        ]),
      })),
    );
    expect(after.message.rows).toEqual([{ status: "running" }]);
    expect(after.job.rows).toEqual([]);
  });

  it("stores a provider failure once, continues the thread and ignores redelivery of its completed reply", async () => {
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider refused" }),
      fauxAssistantMessage("recovered"),
      fauxAssistantMessage("standalone answer"),
    ]);
    const headers: { messageId: string | undefined; runId: string | undefined }[] = [];
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => {
        headers.push({
          messageId: options?.headers?.["x-semprec-semp-message-id"] ?? undefined,
          runId: options?.headers?.["x-semprec-agent-run-id"] ?? undefined,
        });
        return faux.provider.streamSimple(model, context, options);
      },
      isBudgetRefusal: () => false,
    };
    const inFlight = createInFlightAgentRuns();
    runtime = await createAgentsQueueRuntime(pool, registry, {
      sempMessageTask: createSempMessageTask(pool, registry, gateway, inFlight),
    });
    const first = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => sendSempMessage(client, { text: "fail", context: [], hasContext: false })),
    );
    const read = (id: string) =>
      runInTenant(
        tenant,
        async () =>
          (
            await pool.query<{ status: string; text: string | null }>(
              "SELECT status, text FROM semp_messages WHERE id = $1",
              [id],
            )
          ).rows[0],
      );
    const awaitStatus = async (id: string, status: string) => {
      const deadline = Date.now() + 15_000;
      let row = await read(id);
      while (row?.status !== status && Date.now() < deadline) {
        await sleep(50);
        row = await read(id);
      }
      expect(row?.status).toBe(status);
      return row;
    };
    await awaitStatus(first.assistantMessageId, "error");
    const failedJob = await admin.query("SELECT id FROM graphile_worker.jobs WHERE key = $1", [
      `sempMessage:${first.assistantMessageId}`,
    ]);
    expect(failedJob.rows).toEqual([]);
    const second = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { threadId: first.threadId, text: "continue", context: [], hasContext: false }),
      ),
    );
    expect(await awaitStatus(second.assistantMessageId, "done")).toEqual({ status: "done", text: "recovered" });
    const redeliveryKey = `redelivery:${randomUUID()}`;
    await runInTenant(tenant, () =>
      enqueueJob(
        pool,
        AGENT_TASK_NAMES.SEMP_MESSAGE,
        { threadId: second.threadId, assistantMessageId: second.assistantMessageId },
        { jobKey: redeliveryKey, maxAttempts: 1 },
      ),
    );
    const deadline = Date.now() + 15_000;
    let job = await admin.query("SELECT id FROM graphile_worker.jobs WHERE key = $1", [redeliveryKey]);
    while (job.rowCount && Date.now() < deadline) {
      await sleep(50);
      job = await admin.query("SELECT id FROM graphile_worker.jobs WHERE key = $1", [redeliveryKey]);
    }
    expect(job.rows).toEqual([]);
    expect(await read(second.assistantMessageId)).toEqual({ status: "done", text: "recovered" });
    expect(faux.getPendingResponseCount()).toBe(1);
    expect(headers.map((entry) => entry.messageId)).toEqual([first.assistantMessageId, second.assistantMessageId]);
    const standalone = await runInTenant(tenant, async () => {
      const inbox = await withTransaction(pool, (client) => getDatabaseByModuleId(client, "inbox"));
      if (!inbox?.ownerProjectItemId) throw new Error("Missing Semprec project");
      return createAgentRun(pool, { projectItemId: inbox.ownerProjectItemId, triggeredBy: "user", task: "standalone" });
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

  it("runs turns for different tenants concurrently on the dedicated runner", async () => {
    await runtime?.stop();
    runtime = undefined;
    const other = await createTestTenant(admin);
    await createUser(admin, { tenantId: other, email: `${randomUUID()}@example.test`, passwordHash: "unused" });
    await runInTenant(other, () => seedSystem(pool));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const faux = fauxProvider();
    faux.setResponses([
      async () => {
        await gate;
        return fauxAssistantMessage("first tenant");
      },
      async () => {
        await gate;
        return fauxAssistantMessage("second tenant");
      },
    ]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    runtime = await createAgentsQueueRuntime(pool, registry, {
      sempMessageTask: createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns()),
    });
    try {
      const a = await runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          sendSempMessage(client, { text: "first tenant", context: [], hasContext: false }),
        ),
      );
      const b = await runInTenant(other, () =>
        withTransaction(pool, (client) =>
          sendSempMessage(client, { text: "second tenant", context: [], hasContext: false }),
        ),
      );
      const deadline = Date.now() + 15_000;
      while (faux.state.callCount < 2 && Date.now() < deadline) await sleep(50);
      expect(faux.state.callCount).toBe(2);
      for (const [scope, id] of [
        [tenant, a.assistantMessageId],
        [other, b.assistantMessageId],
      ] as const) {
        const row = await runInTenant(scope, () =>
          pool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [id]),
        );
        expect(row.rows).toEqual([{ status: "running" }]);
      }
    } finally {
      release();
      await runtime.stop();
      runtime = undefined;
    }
  });

  it("aborts a deactivated tenant's real Semp turn while another tenant completes", async () => {
    await runtime?.stop();
    runtime = undefined;
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
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const faux = fauxProvider();
    faux.setResponses([
      async (_context, options) => {
        if (!options?.signal) throw new Error("Missing provider abort signal");
        const signal = options.signal;
        entered();
        return new Promise((_, reject) => {
          if (signal.aborted) reject(new Error("provider aborted"));
          else signal.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true });
        });
      },
      fauxAssistantMessage("other tenant completed"),
    ]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    const listener = await startTenantDeactivationListener(pool, async (id) => {
      inFlight.abortTenant(id);
    });
    let failure: { error: unknown } | undefined;
    try {
      runtime = await createAgentsQueueRuntime(pool, registry, {
        sempMessageTask: createSempMessageTask(pool, registry, gateway, inFlight),
      });
      const stopped = await runInTenant(target, () =>
        withTransaction(pool, (client) => sendSempMessage(client, { text: "target", context: [], hasContext: false })),
      );
      await Promise.race([
        started,
        sleep(10_000).then(() => {
          throw new Error("Semp turn did not start");
        }),
      ]);
      const allowed = await runInTenant(tenant, () =>
        withTransaction(pool, (client) => sendSempMessage(client, { text: "other", context: [], hasContext: false })),
      );
      await runAsSystem("sempCancellationTest", () =>
        withTransaction(pool, (client) =>
          suspendAccount(client, { actorUserId: actor.id, targetUserId: targetUser.id }),
        ),
      );
      const read = (tenantId: string, id: string) =>
        runInTenant(tenantId, () =>
          pool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [id]),
        );
      const deadline = Date.now() + 15_000;
      let targetRows = (await read(target, stopped.assistantMessageId)).rows;
      let otherRows = (await read(tenant, allowed.assistantMessageId)).rows;
      while ((targetRows[0]?.status !== "error" || otherRows[0]?.status !== "done") && Date.now() < deadline) {
        await sleep(50);
        targetRows = (await read(target, stopped.assistantMessageId)).rows;
        otherRows = (await read(tenant, allowed.assistantMessageId)).rows;
      }
      expect(targetRows).toEqual([{ status: "error" }]);
      expect(otherRows).toEqual([{ status: "done" }]);
      expect((await read(tenant, stopped.assistantMessageId)).rows).toEqual([]);
      expect((await read(tenant, randomUUID())).rows).toEqual([]);
    } catch (error) {
      failure = { error };
    }
    const cleanup: unknown[] = [];
    try {
      inFlight.abortTenant(target);
      await runtime?.stop();
      runtime = undefined;
    } catch (error) {
      cleanup.push(error);
    }
    try {
      await listener.close();
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanup] : cleanup,
        "Semp deactivation test cleanup failed",
        {
          cause: failure?.error,
        },
      );
    if (failure) throw failure.error;
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
    const next = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { threadId: turn.threadId, text: "next", context: [], hasContext: false }),
      ),
    );
    await expect(
      runInTenant(tenant, () => createBoundedSempHistory()(pool, { threadId: turn.threadId, projectItemId: "unused" })),
    ).rejects.toThrow("Semp conversation history exceeds replay limits");
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("must not run")]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    runtime = await createAgentsQueueRuntime(pool, registry, {
      sempMessageTask: createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns()),
    });
    const deadline = Date.now() + 15_000;
    let rows = await runInTenant(tenant, () =>
      pool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [next.assistantMessageId]),
    );
    while (rows.rows[0]?.status !== "error" && Date.now() < deadline) {
      await sleep(50);
      rows = await runInTenant(tenant, () =>
        pool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [next.assistantMessageId]),
      );
    }
    expect(rows.rows).toEqual([{ status: "error" }]);
    expect(faux.state.callCount).toBe(0);
    const checkpoints = await runInTenant(tenant, () =>
      pool.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM agent_run_events e JOIN agent_runs r ON r.id = e.agent_run_id WHERE r.thread_id = $1 AND e.kind = 'compaction'",
        [turn.threadId],
      ),
    );
    expect(checkpoints.rows).toEqual([{ count: 0 }]);
  });

  it("rejects shutdown when a real worker absorbs a terminal persistence failure", async () => {
    await runtime?.stop();
    runtime = undefined;
    const shutdownPool = await createRuntimeRolePool(admin, "semprec_data");
    const inFlight = createInFlightAgentRuns();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const faux = fauxProvider();
    faux.setResponses([
      async () => {
        entered();
        await gate;
        return fauxAssistantMessage("reply");
      },
    ]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    let actualRuntime: AgentsQueueRuntime | undefined;
    let closed = false;
    let triggerInstalled = false;
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `test_semp_terminal_${suffix}`;
    const triggerName = `test_semp_terminal_${suffix}`;
    let failure: { error: unknown } | undefined;
    try {
      actualRuntime = await createAgentsQueueRuntime(shutdownPool, registry, {
        sempMessageTask: createSempMessageTask(shutdownPool, registry, gateway, inFlight),
      });
      const turn = await runInTenant(tenant, () =>
        withTransaction(shutdownPool, (client) =>
          sendSempMessage(client, { text: "fail terminal persistence", context: [], hasContext: false }),
        ),
      );
      await started;
      // Fault injection is scoped to this one synthetic message in this suite's owned database.
      // DDL identifiers contain only a fixed ASCII prefix and randomUUID hex; the embedded value is validated UUID text.
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(turn.assistantMessageId))
        throw new Error("Invalid fixture message UUID");
      await admin.query(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id = '${turn.assistantMessageId}'::uuid AND NEW.status IN ('done', 'error') THEN RAISE EXCEPTION 'terminal fixture failure'; END IF; RETURN NEW; END $$`,
      );
      await admin.query(
        `CREATE TRIGGER ${triggerName} BEFORE UPDATE ON semp_messages FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      );
      triggerInstalled = true;
      let runnerStopped = false;
      const currentRuntime = actualRuntime;
      const queueRuntime = {
        stopForShutdown: () => {
          const attempt = currentRuntime.stopForShutdown();
          return {
            general: attempt.general,
            chat: attempt.chat.then((result) => {
              if (result.status === "fulfilled") runnerStopped = true;
              return result;
            }),
          };
        },
      };
      const shutdown = createGracefulShutdown({
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
      release();
      const error: unknown = await shutdown.catch((reason: unknown) => reason);
      closed = true;
      expect(runnerStopped).toBe(true);
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error("Expected persistence failure");
      expect(error.errors).toHaveLength(2);
      expect(error.cause).toBe(error.errors[0]);
      const status = await runInTenant(tenant, () =>
        pool.query<{ status: string; error_code: string | null }>(
          "SELECT status, error_code FROM semp_messages WHERE id = $1",
          [turn.assistantMessageId],
        ),
      );
      expect(status.rows).toEqual([{ status: "running", error_code: null }]);
    } catch (error) {
      failure = { error };
    }
    release();
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      async () => {
        if (!closed) await actualRuntime?.stop();
      },
      async () => {
        if (!closed) await shutdownPool.end();
      },
      async () => {
        if (triggerInstalled) await admin.query(`DROP TRIGGER ${triggerName} ON semp_messages`);
      },
      async () => {
        await admin.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        "Semp shutdown test cleanup failed",
        { cause: failure?.error },
      );
    if (failure) throw failure.error;
  });

  it("preserves the turn and run-recovery failures through actual Semp settlement", async () => {
    await runtime?.stop();
    runtime = undefined;
    const shutdownPool = await createRuntimeRolePool(admin, "semprec_data");
    const inFlight = createInFlightAgentRuns();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const faux = fauxProvider();
    faux.setResponses([
      async () => {
        entered();
        await gate;
        return fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider fixture refused" });
      },
    ]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    const suffix = randomUUID().replaceAll("-", "");
    const functionName = `test_semp_recovery_${suffix}`;
    const triggerName = `test_semp_recovery_${suffix}`;
    let actualRuntime: AgentsQueueRuntime | undefined;
    let closed = false;
    let triggerInstalled = false;
    let failure: { error: unknown } | undefined;
    try {
      actualRuntime = await createAgentsQueueRuntime(shutdownPool, registry, {
        sempMessageTask: createSempMessageTask(shutdownPool, registry, gateway, inFlight),
      });
      const turn = await runInTenant(tenant, () =>
        withTransaction(shutdownPool, (client) =>
          sendSempMessage(client, { text: "fail run recovery", context: [], hasContext: false }),
        ),
      );
      await started;
      const rows = await runInTenant(tenant, () =>
        shutdownPool.query<{ agent_run_id: string }>("SELECT agent_run_id FROM semp_messages WHERE id = $1", [
          turn.assistantMessageId,
        ]),
      );
      const runId = rows.rows[0]?.agent_run_id;
      if (!runId) throw new Error("Missing active Semp run");
      // DDL identifiers contain only a fixed ASCII prefix and randomUUID hex; the embedded value is validated UUID text.
      if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(runId)) throw new Error("Invalid fixture run UUID");
      await admin.query(
        `CREATE FUNCTION ${functionName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.agent_run_id = '${runId}'::uuid AND NEW.kind = 'run_status' AND NEW.payload->>'status' = 'error' THEN RAISE EXCEPTION 'run recovery fixture failure'; END IF; RETURN NEW; END $$`,
      );
      await admin.query(
        `CREATE TRIGGER ${triggerName} BEFORE INSERT ON agent_run_events FOR EACH ROW EXECUTE FUNCTION ${functionName}()`,
      );
      triggerInstalled = true;
      const shutdown = createGracefulShutdown({
        queueRuntime: actualRuntime,
        tenantDeactivationListener: { close: async () => {} },
        pool: shutdownPool,
        logger,
        closeIdleThreadSessions,
        abortSempTurns: () => inFlight.abortSemp(),
        observeSempSettlement: () => inFlight.observeSempSettlement(),
      })("SIGTERM");
      release();
      const error: unknown = await shutdown.catch((reason: unknown) => reason);
      closed = true;
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error("Expected run recovery failure");
      expect(error.errors).toHaveLength(2);
      expect(error.cause).toBe(error.errors[0]);
      expect(error.errors[0]).toBeInstanceOf(Error);
      expect(error.errors[1]).toMatchObject({ message: "run recovery fixture failure" });
      const status = await runInTenant(tenant, () =>
        pool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [turn.assistantMessageId]),
      );
      expect(status.rows).toEqual([{ status: "error" }]);
    } catch (error) {
      failure = { error };
    }
    release();
    const cleanup: unknown[] = [];
    for (const action of [
      async () => {
        if (!closed) await actualRuntime?.stop();
      },
      async () => {
        if (!closed) await shutdownPool.end();
      },
      async () => {
        if (triggerInstalled) await admin.query(`DROP TRIGGER ${triggerName} ON agent_run_events`);
      },
      async () => {
        await admin.query(`DROP FUNCTION IF EXISTS ${functionName}()`);
      },
    ]) {
      try {
        await action();
      } catch (error) {
        cleanup.push(error);
      }
    }
    if (cleanup.length)
      throw new AggregateError(failure ? [failure.error, ...cleanup] : cleanup, "Run recovery test cleanup failed", {
        cause: failure?.error,
      });
    if (failure) throw failure.error;
  });

  it("stores interrupted status when the Semp shutdown controller aborts actual work", async () => {
    const shutdownPool = await createRuntimeRolePool(admin, "semprec_data");
    const inFlight = createInFlightAgentRuns();
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const faux = fauxProvider();
    faux.setResponses([
      async (_context, options) => {
        if (!options?.signal) throw new Error("Missing provider abort signal");
        const signal = options.signal;
        entered();
        return new Promise((_, reject) => {
          if (signal.aborted) reject(new Error("provider aborted"));
          else signal.addEventListener("abort", () => reject(new Error("provider aborted")), { once: true });
        });
      },
    ]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    let actualRuntime: AgentsQueueRuntime | undefined;
    let closed = false;
    let failure: { error: unknown } | undefined;
    try {
      actualRuntime = await createAgentsQueueRuntime(shutdownPool, registry, {
        sempMessageTask: createSempMessageTask(shutdownPool, registry, gateway, inFlight),
      });
      const turn = await runInTenant(tenant, () =>
        withTransaction(shutdownPool, (client) =>
          sendSempMessage(client, { text: "interrupt", context: [], hasContext: false }),
        ),
      );
      await started;
      const shutdown = createGracefulShutdown({
        queueRuntime: actualRuntime,
        tenantDeactivationListener: { close: async () => {} },
        pool: shutdownPool,
        logger,
        closeIdleThreadSessions,
        abortSempTurns: () => {
          inFlight.abortSemp();
        },
        observeSempSettlement: () => inFlight.observeSempSettlement(),
      })("SIGTERM");
      // Exercise the real deadline action without advancing or shortening the production timer.
      expect(inFlight.abortSemp()).toBe(1);
      await shutdown;
      closed = true;
      const status = await runInTenant(tenant, () =>
        pool.query<{ status: string; error_code: string | null }>(
          "SELECT status, error_code FROM semp_messages WHERE id = $1",
          [turn.assistantMessageId],
        ),
      );
      expect(status.rows).toEqual([{ status: "error", error_code: "interrupted" }]);
    } catch (error) {
      failure = { error };
    }
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      async () => {
        if (!closed) {
          inFlight.abortSemp();
          await actualRuntime?.stop();
        }
      },
      async () => {
        if (!closed) await shutdownPool.end();
      },
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        "Semp abort test cleanup failed",
        { cause: failure?.error },
      );
    if (failure) throw failure.error;
  });

  it("wakes stored history after a real intervening approval outcome", async () => {
    const faux = fauxProvider();
    const prompts: string[] = [];
    faux.setResponses([
      (context) => {
        prompts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("first answer");
      },
      (context) => {
        prompts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("second answer");
      },
    ]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    const task = createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns());
    const first = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { text: "first question", context: [], hasContext: false }),
      ),
    );
    await runInTenant(tenant, () =>
      task({ threadId: first.threadId, assistantMessageId: first.assistantMessageId }, { job: { id: "first" } }),
    );
    const previous = await runInTenant(tenant, () =>
      pool.query<{ agent_run_id: string; status: string }>(
        "SELECT agent_run_id, status FROM semp_messages WHERE id = $1",
        [first.assistantMessageId],
      ),
    );
    const runId = previous.rows[0]?.agent_run_id;
    if (!runId) throw new Error("First reply has no run");
    expect(previous.rows[0]?.status).toBe("done");
    await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => {
        const request = await createPendingApprovalRequest(client, {
          agentRunId: runId,
          toolName: "search_web",
          riskClass: "unclassified",
          payload: { mcpToolRegistrationId: randomUUID(), mcpServerItemId: randomUUID(), args: {} },
          resourceSnapshot: { kind: "test", resourceId: "test", sha256: null },
        });
        const result = await decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: request.id,
          decision: "rejected",
          decidedByUserId: userId,
        });
        expect(result?.outcome).toBe("decided");
      }),
    );
    const system = await runInTenant(tenant, () =>
      pool.query<{ system_key: string }>(
        "SELECT system_key FROM semp_messages WHERE thread_id = $1 AND role = 'system'",
        [first.threadId],
      ),
    );
    expect(system.rows).toEqual([{ system_key: "approval.outcome.rejected" }]);
    const second = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { threadId: first.threadId, text: "second question", context: [], hasContext: false }),
      ),
    );
    await runInTenant(tenant, () =>
      task({ threadId: second.threadId, assistantMessageId: second.assistantMessageId }, { job: { id: "second" } }),
    );
    const next = await runInTenant(tenant, () =>
      pool.query<{ agent_run_id: string; status: string }>(
        "SELECT agent_run_id, status FROM semp_messages WHERE id = $1",
        [second.assistantMessageId],
      ),
    );
    expect(next.rows[0]?.status).toBe("done");
    expect(next.rows[0]?.agent_run_id).not.toBe(runId);
    expect(prompts[1]).toContain("first question");
    expect(prompts[1]).toContain("first answer");
    expect(prompts[1]).toContain("second question");
    await closeIdleThreadSessions(pool);
  });

  it("clears the current message attribution after a failed session turn", async () => {
    await runtime?.stop();
    runtime = undefined;
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider refused" }),
      fauxAssistantMessage("next"),
    ]);
    const headers: (string | undefined)[] = [];
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => {
        headers.push(options?.headers?.["x-semprec-semp-message-id"] ?? undefined);
        return faux.provider.streamSimple(model, context, options);
      },
      isBudgetRefusal: () => false,
    };
    const project = await runInTenant(tenant, () =>
      withTransaction(pool, async (client) => (await getDatabaseByModuleId(client, "inbox"))?.ownerProjectItemId),
    );
    if (!project) throw new Error("Missing Semprec project");
    const turn = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => sendSempMessage(client, { text: "failed", context: [], hasContext: false })),
    );
    const references: { current: string | null }[] = [];
    const conversation = new SempConversation(pool, {
      resolveProjectItemId: async () => project,
      createAgentSessionForRun: async (run, current) => {
        if (!current) throw new Error("Missing Semp attribution reference");
        references.push(current);
        return createAgentSessionFactoryForRun(pool, registry, gateway, run, current);
      },
    });
    let failure: { error: unknown } | undefined;
    try {
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
    } catch (error) {
      failure = { error };
    }
    conversation.clear();
    const cleanupErrors: unknown[] = [];
    for (const cleanup of [
      async () => closeIdleThreadSessions(pool),
      async () => admin.query("SELECT graphile_worker.remove_job($1)", [`sempMessage:${turn.assistantMessageId}`]),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length)
      throw new AggregateError(
        failure ? [failure.error, ...cleanupErrors] : cleanupErrors,
        "Attribution test cleanup failed",
        { cause: failure?.error },
      );
    if (failure) throw failure.error;
  });

  it("wakes for a later queued pair and then reuses the reply actually completed", async () => {
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    const task = createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns());
    const send = (text: string, threadId?: string) =>
      runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          sendSempMessage(client, { text, context: [], hasContext: false, ...(threadId ? { threadId } : {}) }),
        ),
      );
    const execute = (turn: { threadId: string; assistantMessageId: string }) =>
      runInTenant(tenant, () =>
        task({ threadId: turn.threadId, assistantMessageId: turn.assistantMessageId }, { job: { id: "freshness" } }),
      );
    const first = await send("first");
    await execute(first);
    const second = await send("second", first.threadId);
    const third = await send("third", first.threadId);
    await execute(second);
    await execute(third);
    const rows = await runInTenant(tenant, () =>
      pool.query<{ id: string; status: string; agent_run_id: string }>(
        "SELECT id, status, agent_run_id FROM semp_messages WHERE id = ANY($1::uuid[]) ORDER BY created_at, id",
        [[first.assistantMessageId, second.assistantMessageId, third.assistantMessageId]],
      ),
    );
    expect(rows.rows.map((row) => row.status)).toEqual(["done", "done", "done"]);
    expect(rows.rows[0]?.agent_run_id).not.toBe(rows.rows[1]?.agent_run_id);
    expect(rows.rows[1]?.agent_run_id).toBe(rows.rows[2]?.agent_run_id);
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
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => faux.provider.streamSimple(model, context, options),
      isBudgetRefusal: () => false,
    };
    const first = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { text: "first wake", context: [], hasContext: false }),
      ),
    );
    await runInTenant(tenant, () =>
      createSempMessageTask(
        pool,
        registry,
        gateway,
        createInFlightAgentRuns(),
      )(
        { threadId: first.threadId, assistantMessageId: first.assistantMessageId },
        { job: { id: "checkpoint-first" } },
      ),
    );
    const previous = await runInTenant(tenant, () =>
      pool.query<{ agent_run_id: string }>("SELECT agent_run_id FROM semp_messages WHERE id = $1", [
        first.assistantMessageId,
      ]),
    );
    const runId = previous.rows[0]?.agent_run_id;
    if (!runId) throw new Error("Missing first session run");
    await runInTenant(tenant, () =>
      insertAgentRunEvent(pool, runId, "compaction", [
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
      ]),
    );
    await runInTenant(tenant, () =>
      insertAgentRunEvent(pool, runId, "tool_result", {
        kind: "tool_result",
        toolCallId: "pair",
        name: "search",
        isError: false,
        result: { content: [{ type: "text", text: "tail result" }] },
      }),
    );
    await closeIdleThreadSessions(pool);
    const second = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { threadId: first.threadId, text: "later wake", context: [], hasContext: false }),
      ),
    );
    await runInTenant(tenant, () =>
      createSempMessageTask(
        pool,
        registry,
        gateway,
        createInFlightAgentRuns(),
      )(
        { threadId: second.threadId, assistantMessageId: second.assistantMessageId },
        { job: { id: "checkpoint-second" } },
      ),
    );
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("checkpoint summary");
    expect(prompts[0]).toContain('"toolCallId":"pair"');
    expect(prompts[0]).toContain("tail result");
    expect(prompts[0]).toContain("later wake");
    expect(prompts[0]).not.toContain("first wake");
    await closeIdleThreadSessions(pool);
  });

  it("wakes when the completed reply's stored content changes under the same id", async () => {
    const other = await createTestTenant(admin);
    const faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage("original"), fauxAssistantMessage("after change")]);
    let calls = 0;
    const gateway: GatewayModel = {
      model: faux.getModel(),
      streamFn: (model, context, options) => {
        calls++;
        return faux.provider.streamSimple(model, context, options);
      },
      isBudgetRefusal: () => false,
    };
    const task = createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns());
    const first = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => sendSempMessage(client, { text: "first", context: [], hasContext: false })),
    );
    await runInTenant(tenant, () =>
      task({ threadId: first.threadId, assistantMessageId: first.assistantMessageId }, { job: { id: "fresh-first" } }),
    );
    // Synthetic stored-row change exercises the cache frontier; no production writer of a completed reply is implied.
    const foreign = await runInTenant(other, () =>
      pool.query("UPDATE semp_messages SET text = $1 WHERE id = $2", ["foreign", first.assistantMessageId]),
    );
    expect(foreign.rowCount).toBe(0);
    const changed = await runInTenant(tenant, () =>
      pool.query("UPDATE semp_messages SET text = $1 WHERE id = $2", ["changed fixture", first.assistantMessageId]),
    );
    expect(changed.rowCount).toBe(1);
    const second = await runInTenant(tenant, () =>
      withTransaction(pool, (client) =>
        sendSempMessage(client, { threadId: first.threadId, text: "second", context: [], hasContext: false }),
      ),
    );
    await runInTenant(other, () =>
      task({ threadId: second.threadId, assistantMessageId: second.assistantMessageId }, { job: { id: "foreign" } }),
    );
    await runInTenant(tenant, () =>
      task({ threadId: second.threadId, assistantMessageId: randomUUID() }, { job: { id: "missing" } }),
    );
    expect(calls).toBe(1);
    await runInTenant(tenant, () =>
      task(
        { threadId: second.threadId, assistantMessageId: second.assistantMessageId },
        { job: { id: "fresh-second" } },
      ),
    );
    const rows = await runInTenant(tenant, () =>
      pool.query<{ id: string; agent_run_id: string; status: string }>(
        "SELECT id, agent_run_id, status FROM semp_messages WHERE id = ANY($1::uuid[]) ORDER BY created_at, id",
        [[first.assistantMessageId, second.assistantMessageId]],
      ),
    );
    expect(rows.rows.map((row) => row.id)).toEqual([first.assistantMessageId, second.assistantMessageId]);
    expect(rows.rows.map((row) => row.status)).toEqual(["done", "done"]);
    expect(rows.rows[0]?.agent_run_id).not.toBe(rows.rows[1]?.agent_run_id);
    expect(calls).toBe(2);
    await closeIdleThreadSessions(pool);
  });

  it("publishes the committed turn invalidation for the owning tenant", async () => {
    await runtime?.stop();
    runtime = undefined;
    const other = await createTestTenant(admin);
    const turn = await runInTenant(tenant, () =>
      withTransaction(pool, (client) => sendSempMessage(client, { text: "notify", context: [], hasContext: false })),
    );
    const listener = await admin.connect();
    const sentinelId = randomUUID();
    const raw: string[] = [];
    let rawOverflow = 0;
    const publication: string[] = [];
    let publicationOverflow = 0;
    const handlerEvents: Array<{ jobId: string; phase: string }> = [];
    let handlerOverflow = 0;
    let providerCalls = 0;
    const recordRaw = (value: string) => {
      if (raw.length < 64) raw.push(value);
      else rawOverflow++;
    };
    const recordPublication = (value: string) => {
      if (publication.length < 32) publication.push(value);
      else publicationOverflow++;
    };
    const recordHandler = (jobId: string, phase: string) => {
      if (handlerEvents.length < 32) handlerEvents.push({ jobId, phase });
      else handlerOverflow++;
    };
    const category = (error: unknown) => (error instanceof Error ? "error" : typeof error);
    const observed: { tenantId: string; threadId: string }[] = [];
    let observedOverflow = 0;
    listener.on("notification", (notification) => {
      if (notification.channel !== REALTIME_CHANNEL || !notification.payload) {
        recordRaw("other-channel-or-empty");
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(notification.payload);
      } catch {
        recordRaw("invalid-json");
        return;
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("tenantId" in parsed) ||
        typeof parsed.tenantId !== "string" ||
        !("message" in parsed)
      ) {
        recordRaw("invalid-envelope");
        return;
      }
      const message = parsed.message;
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== "invalidation" ||
        !("scope" in message) ||
        message.scope !== "sempThread" ||
        !("threadId" in message) ||
        typeof message.threadId !== "string"
      ) {
        recordRaw("other-message");
        return;
      }
      recordRaw(
        message.threadId === turn.threadId ? "target" : message.threadId === sentinelId ? "sentinel" : "other-thread",
      );
      if (observed.length < 64) observed.push({ tenantId: parsed.tenantId, threadId: message.threadId });
      else observedOverflow++;
    });
    let failure: { error: unknown } | undefined;
    let restoreQuery: (() => void) | undefined;
    try {
      await listener.query(`LISTEN ${REALTIME_CHANNEL}`);
      wireRealtimeHooks(pool);
      const querySpy = vi.spyOn(pool, "query");
      restoreQuery = () => querySpy.mockRestore();
      // Preserve the real pool method, its receiver, arguments, return value and rejection identity.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      pool.query = new Proxy(pool.query, {
        apply(target, receiver, args: unknown[]) {
          const values: unknown = args[1];
          const matching =
            typeof args[0] === "string" &&
            args[0].includes("pg_notify") &&
            Array.isArray(values) &&
            values[0] === REALTIME_CHANNEL &&
            typeof values[1] === "string" &&
            values[1].includes(turn.threadId);
          if (matching) recordPublication("start");
          try {
            const result: unknown = Reflect.apply(target, receiver, args);
            if (matching && result instanceof Promise)
              void result.then(
                () => recordPublication("fulfilled"),
                (error: unknown) => recordPublication(`rejected:${category(error)}`),
              );
            return result;
          } catch (error) {
            if (matching) recordPublication(`threw:${category(error)}`);
            throw error;
          }
        },
      });
      const jobKey = `sempMessage:${turn.assistantMessageId}`;
      const readJob = async () => {
        const result = await admin.query<{
          id: string;
          key: string;
          task_identifier: string;
          attempts: number;
          max_attempts: number;
          locked_at: Date | null;
          has_error: boolean;
        }>(
          "SELECT id::text, key, task_identifier, attempts, max_attempts, locked_at, last_error IS NOT NULL AS has_error FROM graphile_worker.jobs WHERE key = $1",
          [jobKey],
        );
        return result.rows;
      };
      const initialJob = await readJob();
      expect(initialJob).toHaveLength(1);
      expect(initialJob[0]?.key).toBe(jobKey);
      expect(initialJob[0]?.task_identifier).toBe("sempMessage");
      const deadline = Date.now() + 15_000;
      await runInTenant(tenant, () =>
        publishRealtimeMessage(pool, { type: "invalidation", scope: "sempThread", threadId: sentinelId }),
      );
      while (
        !observed.some((value) => value.tenantId === tenant && value.threadId === sentinelId) &&
        Date.now() < deadline
      )
        await sleep(50);
      expect(observed).toContainEqual({ tenantId: tenant, threadId: sentinelId });
      const faux = fauxProvider();
      faux.setResponses([
        fauxAssistantMessage("notified"),
        fauxAssistantMessage("", { stopReason: "error", errorMessage: "provider refused" }),
      ]);
      const gateway: GatewayModel = {
        model: faux.getModel(),
        streamFn: (model, context, options) => {
          providerCalls++;
          return faux.provider.streamSimple(model, context, options);
        },
        isBudgetRefusal: () => false,
      };
      const realTask = createSempMessageTask(pool, registry, gateway, createInFlightAgentRuns());
      const observedTask: typeof realTask = async (payload, helpers) => {
        const matching =
          typeof payload === "object" &&
          payload !== null &&
          "assistantMessageId" in payload &&
          payload.assistantMessageId === turn.assistantMessageId;
        if (matching) recordHandler(helpers.job.id, "entry");
        try {
          await realTask(payload, helpers);
          if (matching) recordHandler(helpers.job.id, "fulfilled");
        } catch (error) {
          if (matching) recordHandler(helpers.job.id, `rejected:${category(error)}`);
          throw error;
        }
      };
      runtime = await createAgentsQueueRuntime(pool, registry, { sempMessageTask: observedTask });
      while (
        !observed.some((value) => value.tenantId === tenant && value.threadId === turn.threadId) &&
        Date.now() < deadline
      )
        await sleep(50);
      const readMessage = (tenantId: string, id: string) =>
        runInTenant(tenantId, () =>
          pool.query<{
            status: string;
            agent_run_id: string | null;
            event_from_id: string | null;
            event_to_id: string | null;
            run_status: string | null;
          }>(
            `SELECT m.status, m.agent_run_id, m.event_from_id, m.event_to_id, r.status AS run_status
             FROM semp_messages m LEFT JOIN agent_runs r ON r.id = m.agent_run_id AND r.tenant_id = m.tenant_id
            WHERE m.id = $1`,
            [id],
          ),
        );
      const snapshot = await Promise.allSettled([
        readJob(),
        readMessage(tenant, turn.assistantMessageId),
        readMessage(other, turn.assistantMessageId),
        readMessage(tenant, randomUUID()),
      ]);
      const diagnostic = snapshot.map((result) =>
        result.status === "fulfilled"
          ? { status: "fulfilled", value: Array.isArray(result.value) ? result.value : result.value.rows }
          : { status: "rejected", category: category(result.reason) },
      );
      process.stdout.write(
        `${JSON.stringify({ fixture: "semp-invalidation-diagnostic", threadId: turn.threadId, assistantMessageId: turn.assistantMessageId, jobKey, initialJob, snapshot: diagnostic, handlerEvents, handlerOverflow, providerCalls, publication, publicationOverflow, raw, rawOverflow, observedOverflow })}\n`,
      );
      if (snapshot[2]?.status !== "fulfilled" || Array.isArray(snapshot[2].value))
        throw new Error("Foreign read observation failed");
      if (snapshot[3]?.status !== "fulfilled" || Array.isArray(snapshot[3].value))
        throw new Error("Random read observation failed");
      expect(snapshot[2].value.rows).toEqual([]);
      expect(snapshot[3].value.rows).toEqual([]);
      expect(observedOverflow).toBe(0);
      expect(observed).toContainEqual({ tenantId: tenant, threadId: turn.threadId });
      expect(observed.filter((value) => value.tenantId === other)).toEqual([]);
      const message = await runInTenant(tenant, () =>
        pool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [turn.assistantMessageId]),
      );
      expect(message.rows).toEqual([{ status: "done" }]);
      const firstEvents = observed.filter((value) => value.tenantId === tenant && value.threadId === turn.threadId);
      expect(firstEvents).toHaveLength(1);
      const failedTurn = await runInTenant(tenant, () =>
        withTransaction(pool, (client) =>
          sendSempMessage(client, { threadId: turn.threadId, text: "fail", context: [], hasContext: false }),
        ),
      );
      const failedDeadline = Date.now() + 15_000;
      while (
        observed.filter((value) => value.tenantId === tenant && value.threadId === turn.threadId).length < 2 &&
        Date.now() < failedDeadline
      )
        await sleep(50);
      const failed = await runInTenant(tenant, () =>
        pool.query<{ status: string }>("SELECT status FROM semp_messages WHERE id = $1", [
          failedTurn.assistantMessageId,
        ]),
      );
      expect(failed.rows).toEqual([{ status: "error" }]);
      expect(observed.filter((value) => value.tenantId === tenant && value.threadId === turn.threadId)).toHaveLength(2);
      expect(observed.filter((value) => value.tenantId === other)).toEqual([]);
    } catch (error) {
      failure = { error };
    }
    const cleanup: unknown[] = [];
    try {
      await runtime?.stop();
      runtime = undefined;
    } catch (error) {
      cleanup.push(error);
    }
    try {
      restoreQuery?.();
    } catch (error) {
      cleanup.push(error);
    }
    try {
      listener.release(true);
    } catch (error) {
      cleanup.push(error);
    }
    if (cleanup.length)
      throw new AggregateError(failure ? [failure.error, ...cleanup] : cleanup, "Semp invalidation cleanup failed", {
        cause: failure?.error,
      });
    if (failure) throw failure.error;
  });
});
