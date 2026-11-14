// Issue gh-1948: the ephemeral `agent:delta` frames of a run that rewrites a mail draft. The run's `mail.draft.update` is
// called as a session calls it (`resolveModuleAgentToolsForRun`), the frames travel through the wired realtime hooks, the
// NOTIFY channel and the real sync server, and the sockets are those of the run's user, of another user of the tenant and
// of another tenant.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { WebSocket, type RawData } from "ws";
import { runInTenant } from "@semprec/shared";
import {
  createAgentRun,
  createItemWithClient,
  createSempChatThread,
  createUser,
  getDatabaseByModuleId,
  listPropertiesByDatabase,
  loadFullModuleRegistry,
  notifyAgentRunDelta,
  resolveModuleAgentToolsForRun,
  seedSystem,
  setAgentRunDeltaHook,
  withTransaction,
  type ResolvedModuleAgentTool,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  createTestTenant,
  ensureFolderItem,
  getTestPool,
  resetDatabase,
  writeMailboxAddresses,
} from "@semprec/data/testSupport";
import type { MailDraftBodyDelta } from "../protocolV1.js";
import { logger } from "../logger.js";
import { createSyncServer, type SyncIdentity, type SyncServer } from "../syncServer.js";
import { wireRealtimeHooks } from "../wireHooks.js";

interface MailTenant {
  tenantId: string;
  userId: string;
  secondUserId: string;
  mailProjectId: string;
  mailboxId: string;
}

let admin: Pool;
let runtime: Pool;
let registry: Awaited<ReturnType<typeof loadFullModuleRegistry>>;
let server: SyncServer;
let http: Server;
let port: number;
let identityByToken: Map<string, SyncIdentity>;
let tenant: MailTenant;
let foreign: MailTenant;
const sockets: WebSocket[] = [];

function messageText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function waitUntil(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  expect(check()).toBe(true);
}

function settle(ms = 300): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A tenant with a mailbox that has a Drafts folder and a primary address, and two users. */
async function seededTenant(): Promise<MailTenant> {
  const tenantId = await createTestTenant(admin);
  // A tenant holds one user row; a socket's identity is only the ids it carries, so another user is another id.
  const userId = (
    await createUser(admin, { tenantId, email: `${randomUUID()}@example.test`, passwordHash: "unused", locale: "en" })
  ).id;
  const secondUserId = randomUUID();
  await runInTenant(tenantId, () => seedSystem(runtime));
  return runInTenant(tenantId, () =>
    withTransaction(runtime, async (client) => {
      const mailboxes = await getDatabaseByModuleId(client, "mailboxes");
      const folders = await getDatabaseByModuleId(client, "folders");
      if (!mailboxes?.ownerProjectItemId || !folders) throw new Error("Missing mail databases");
      const mailboxRelation = (await listPropertiesByDatabase(client, folders.id)).find(
        (property) => property.key === "mailbox",
      );
      if (!mailboxRelation) throw new Error("Missing the folder-mailbox relation");
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxes.id,
        properties: { name: "Personal", provider: "gmail" },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: mailboxes.id,
        mailboxItemId: mailbox.id,
        address: "me@example.test",
        aliases: [],
      });
      await ensureFolderItem(client, {
        foldersDatabaseId: folders.id,
        mailboxItemId: mailbox.id,
        mailboxRelationPropertyId: mailboxRelation.id,
        providerId: "DRAFTS",
        name: "drafts",
        behavior: "folder",
        specialPurpose: "drafts",
      });
      return { tenantId, userId, secondUserId, mailProjectId: mailboxes.ownerProjectItemId, mailboxId: mailbox.id };
    }),
  );
}

/** A run of the mail project of `t` for its first user, belonging to a Semp chat thread (a chat turn) or not. */
function runOf(t: MailTenant, withThread: boolean): Promise<{ id: string }> {
  return runInTenant(t.tenantId, async () => {
    const threadId = withThread ? await withTransaction(runtime, createSempChatThread) : null;
    return createAgentRun(runtime, {
      projectItemId: t.mailProjectId,
      userId: t.userId,
      triggeredBy: "user",
      task: "rewrite the draft",
      threadId,
    });
  });
}

async function toolNamed(t: MailTenant, runId: string, name: string): Promise<ResolvedModuleAgentTool> {
  const tools = await runInTenant(t.tenantId, () =>
    resolveModuleAgentToolsForRun(runtime, registry, runId, t.mailProjectId),
  );
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`The run has no tool ${name}`);
  return tool;
}

/** Calls a tool of the run as its session does, inside the tenant, and parses the answer. */
async function call(t: MailTenant, runId: string, name: string, args: unknown): Promise<unknown> {
  const tool = await toolNamed(t, runId, name);
  const { result, error } = await runInTenant(t.tenantId, () => tool.invoke(args));
  expect(error, result).toBe(false);
  return JSON.parse(result);
}

/** An open draft of the tenant's mailbox, created by the run through `mail.draft.create`. */
async function createdDraftId(t: MailTenant, runId: string): Promise<string> {
  const draft = await call(t, runId, "mail.draft.create", {
    mode: "new",
    mailboxId: t.mailboxId,
    to: [{ address: "petr@example.test" }],
    subject: "Offer",
    body: "First text",
  });
  if (!isRecord(draft) || typeof draft.id !== "string") throw new Error("The draft has no id");
  return draft.id;
}

async function connectAs(token: string, tenantId: string, userId: string): Promise<WebSocket> {
  identityByToken.set(token, { tenantId, userId, sessionId: `session-${token}` });
  const client = new WebSocket(`ws://127.0.0.1:${port}/api/sync?token=${token}`);
  sockets.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  return client;
}

/** The `agent:delta` frames the socket receives, in arrival order; other frame types are not what these tests observe. */
function collectDeltaFrames(client: WebSocket): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  client.on("message", (data) => {
    const frame: unknown = JSON.parse(messageText(data));
    if (isRecord(frame) && frame.type === "agent:delta") frames.push(frame);
  });
  return frames;
}

/** Collects every frame, to prove a watcher that is refused has been silent altogether. */
function collectAllFrames(client: WebSocket): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  client.on("message", (data) => {
    const frame: unknown = JSON.parse(messageText(data));
    if (isRecord(frame)) frames.push(frame);
  });
  return frames;
}

function watch(client: WebSocket, runId: string): void {
  client.send(JSON.stringify({ type: "agent:watch", runId, afterEventId: "0" }));
}

/** Puts the pieces of a chunked delta together, as a client does: the base64 of the JSON value. */
function reassemble(frames: Record<string, unknown>[]): unknown {
  const pieces = frames.map((frame) => {
    const { chunk, delta } = frame;
    if (!isRecord(chunk) || typeof chunk.index !== "number" || typeof delta !== "string")
      throw new Error("Expected a chunked delta frame");
    return { index: chunk.index, delta };
  });
  pieces.sort((a, b) => a.index - b.index);
  return JSON.parse(Buffer.from(pieces.map((piece) => piece.delta).join(""), "base64").toString("utf8"));
}

describe("mail draft body deltas of a run that rewrites a draft (issue gh-1948)", () => {
  beforeEach(async () => {
    admin ??= getTestPool();
    await resetDatabase(admin);
    registry ??= await loadFullModuleRegistry();
    // Row-level security applies only to a runtime role: the tools, the publisher and the server all use one.
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    wireRealtimeHooks(runtime);
    tenant = await seededTenant();
    foreign = await seededTenant();
    identityByToken = new Map();
    server = await createSyncServer(runtime, {
      authenticate: async (req: IncomingMessage) => {
        const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
        return token ? (identityByToken.get(token) ?? null) : null;
      },
      revalidateSession: async () => true,
      heartbeatIntervalMs: 30_000,
    });
    http = createServer();
    http.on("upgrade", (req, socket, head) => server.handleUpgrade(req, socket, head));
    await new Promise<void>((resolve) => http.listen(0, resolve));
    const address = http.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    port = address.port;
  });

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    await server.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    setAgentRunDeltaHook(async () => {});
    await runtime.end();
  });

  afterAll(async () => {
    await admin?.end();
  });

  it("sends the draft id and the new body to the run's user, and nothing to another user or another tenant", async () => {
    const run = await runOf(tenant, true);
    const draftId = await createdDraftId(tenant, run.id);
    const own = await connectAs("own", tenant.tenantId, tenant.userId);
    const sameTenantOther = await connectAs("sameTenantOther", tenant.tenantId, tenant.secondUserId);
    // The other tenant's socket claims the very user id of the run's user: only the tenant boundary can refuse it.
    const otherTenant = await connectAs("otherTenant", foreign.tenantId, tenant.userId);
    const ownFrames = collectDeltaFrames(own);
    const otherUserFrames = collectAllFrames(sameTenantOther);
    const otherTenantFrames = collectAllFrames(otherTenant);
    for (const client of [own, sameTenantOther, otherTenant]) watch(client, run.id);
    await settle();

    await call(tenant, run.id, "mail.draft.update", { draftId, body: "Rewritten by Semp" });

    await waitUntil(() => ownFrames.length === 1);
    const expected = { kind: "mailDraftBody", draftId, body: "Rewritten by Semp" } satisfies MailDraftBodyDelta;
    expect(ownFrames).toEqual([{ type: "agent:delta", agentRunId: run.id, delta: expected }]);
    await settle();
    expect(ownFrames).toHaveLength(1);
    expect(otherUserFrames).toEqual([]);
    expect(otherTenantFrames).toEqual([]);
  });

  it("does not deliver a frame to a socket that watches nothing, or after it stops watching", async () => {
    const run = await runOf(tenant, true);
    const draftId = await createdDraftId(tenant, run.id);
    const watching = await connectAs("watching", tenant.tenantId, tenant.userId);
    const idle = await connectAs("idle", tenant.tenantId, tenant.userId);
    const stopped = await connectAs("stopped", tenant.tenantId, tenant.userId);
    const watchingFrames = collectDeltaFrames(watching);
    const idleFrames = collectDeltaFrames(idle);
    const stoppedFrames = collectDeltaFrames(stopped);
    watch(watching, run.id);
    watch(stopped, run.id);
    await settle();
    stopped.send(JSON.stringify({ type: "agent:unwatch", runId: run.id }));
    await settle();

    await call(tenant, run.id, "mail.draft.update", { draftId, body: "Second text" });

    await waitUntil(() => watchingFrames.length === 1);
    await settle();
    expect(idleFrames).toEqual([]);
    expect(stoppedFrames).toEqual([]);
  });

  it("sends no frame for a run that was not started from a chat turn, though its draft is updated", async () => {
    const run = await runOf(tenant, false);
    const draftId = await createdDraftId(tenant, run.id);
    const own = await connectAs("own", tenant.tenantId, tenant.userId);
    const ownFrames = collectDeltaFrames(own);
    watch(own, run.id);
    await settle();

    const updated = await call(tenant, run.id, "mail.draft.update", { draftId, body: "Quiet text" });

    expect(updated).toMatchObject({ id: draftId, body: "Quiet text" });
    await settle();
    expect(ownFrames).toEqual([]);
  });

  it("sends no frame for a refused update of another tenant's draft, and the run's user still receives the next one", async () => {
    const run = await runOf(tenant, true);
    const foreignRun = await runOf(foreign, true);
    const draftId = await createdDraftId(tenant, run.id);
    const foreignDraftId = await createdDraftId(foreign, foreignRun.id);
    const own = await connectAs("own", tenant.tenantId, tenant.userId);
    const ownFrames = collectDeltaFrames(own);
    watch(own, run.id);
    await settle();
    const update = await toolNamed(tenant, run.id, "mail.draft.update");

    const refused = await runInTenant(tenant.tenantId, () => update.invoke({ draftId: foreignDraftId, body: "x" }));
    expect(refused.error).toBe(true);
    await settle();
    expect(ownFrames).toEqual([]);

    await call(tenant, run.id, "mail.draft.update", { draftId, body: "Accepted" });
    await waitUntil(() => ownFrames.length === 1);
    expect(ownFrames[0]?.delta).toEqual({ kind: "mailDraftBody", draftId, body: "Accepted" });
  });

  it("splits a large body into the existing chunks, which put together give the same payload", async () => {
    const run = await runOf(tenant, true);
    const draftId = await createdDraftId(tenant, run.id);
    const own = await connectAs("own", tenant.tenantId, tenant.userId);
    const ownFrames = collectDeltaFrames(own);
    watch(own, run.id);
    await settle();
    const body = `${"Lorem ipsum dolor sit amet. ".repeat(2_000)}End`;

    await call(tenant, run.id, "mail.draft.update", { draftId, body });

    await waitUntil(() => {
      const total = ownFrames[0]?.chunk;
      return isRecord(total) && typeof total.total === "number" && ownFrames.length === total.total;
    });
    expect(ownFrames.length).toBeGreaterThan(1);
    const ids = new Set(ownFrames.map((frame) => (isRecord(frame.chunk) ? frame.chunk.id : undefined)));
    expect(ids.size).toBe(1);
    for (const frame of ownFrames) {
      expect(frame).toMatchObject({ type: "agent:delta", agentRunId: run.id, chunk: { encoding: "base64json" } });
    }
    expect(reassemble(ownFrames)).toEqual({ kind: "mailDraftBody", draftId, body });
  });

  it("logs a delta it could not publish with the run id only, and resolves so the update it announces goes on", async () => {
    const unreachable = await createRuntimeRolePool(admin, "semprec_data");
    await unreachable.end();
    wireRealtimeHooks(unreachable);
    const logged = vi.spyOn(logger, "error").mockImplementation(() => {});
    const agentRunId = randomUUID();
    try {
      await expect(
        runInTenant(tenant.tenantId, () =>
          notifyAgentRunDelta({
            agentRunId,
            delta: { kind: "mailDraftBody", draftId: randomUUID(), body: "secret text" },
          }),
        ),
      ).resolves.toBeUndefined();

      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged).toHaveBeenCalledWith(
        expect.objectContaining({ agentRunId }),
        "Failed to publish agent_run_delta realtime message",
      );
      expect(JSON.stringify(logged.mock.calls[0]?.[0])).not.toContain("secret text");
    } finally {
      logged.mockRestore();
    }
  });
});
