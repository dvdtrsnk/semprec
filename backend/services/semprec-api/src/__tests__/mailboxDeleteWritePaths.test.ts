import { ModuleRegistry } from "@semprec/module-registry";
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import {
  createTestProjectItem,
  ensureMailAccountSyncState,
  getTenantZeroId,
  getTestPool,
  inTenantZero,
  resetDatabase,
  storeCredential,
} from "@semprec/data/testSupport";
import {
  ApprovalRequiredError,
  ForbiddenError,
  createAgentRun,
  createChokePoint,
  createItemWithClient,
  createPendingApprovalRequest,
  createUser,
  createViewTypeRegistry,
  decideAndEnqueueApprovalRequest,
  getApprovalRequest,
  hashPassword,
  isGenericOperationApprovalRequestPayload,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  resolveMailModuleIds,
  seedSystem,
  upsertMailServerSettings,
  withTransaction,
  type CollectionMetadataResolver,
  type PasswordResetMailer,
} from "@semprec/data";
import { createGenericOperationGateway, replayApprovedGenericOperation } from "@semprec/application";
import { CAPABILITY_IDS, OPERATION_METADATA, type AuthenticatedActor } from "@semprec/shared";
import { createDispatcher } from "../app.js";
import { createMcpRequestListener } from "../mcp/mcpHandler.js";

/**
 * Issue gh-2031 through the production write paths: the generic `DELETE /api/items/:id` and the `/mcp`
 * `item.delete` of an MCP client reach the trash cascade whose delete hook refuses a Mailboxes item,
 * the `item.delete` of an agent run is refused by the approval preflight before a request is stored,
 * and `DELETE /api/mail/mailboxes/:id` passes. The data package's `mailboxDeleteHook.test.ts` covers
 * the hook and the approval projection on the runtime role with two tenants.
 */

const testMetadataResolver: CollectionMetadataResolver = {
  resolve: () => ({
    icon: null,
    color: null,
    overviewOrder: null,
    switcherOrder: null,
    clientVisible: true,
    overviewHidden: false,
  }),
  collectionFilter: () => undefined,
  overviewHideable: () => false,
};

const PASSWORD = "s3cret-password";
const REFUSAL_MESSAGE = /cannot be deleted as an item; it is removed through DELETE \/api\/mail\/mailboxes\/:id$/;
const ALL_CAPABILITIES = new Set(CAPABILITY_IDS);
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

const itemBody = z.object({ id: z.string(), deletedAt: z.string().nullable() }).passthrough();
const restError = z.object({ error: z.object({ code: z.string(), details: z.unknown().optional() }).strict() });
const mcpError = z.object({
  error: z.object({ code: z.number(), message: z.string(), data: z.unknown().optional() }).strict(),
});
/** The stored result of an approved request that ended as a conflict. */
const conflictResult = z.object({
  error: z.object({
    code: z.string(),
    details: z.object({ reason: z.string().optional(), currentResource: z.unknown() }),
  }),
});

/** Whether the mailbox's item is in the trash, its version, and how many rows a removal deletes exist. */
interface MailboxRows {
  trashed: boolean | null;
  updatedAt: string | null;
  credentials: number;
  syncStates: number;
  serverSettings: number;
}

let pool: Pool;

function mailboxRows(mailboxItemId: string): Promise<MailboxRows[]> {
  return inTenantZero(async () => {
    const { rows } = await pool.query<MailboxRows>(
      `SELECT (SELECT deleted_at IS NOT NULL FROM items WHERE id = $1) AS trashed,
              (SELECT updated_at::text FROM items WHERE id = $1) AS "updatedAt",
              (SELECT count(*)::int FROM external_credentials WHERE item_id = $1) AS credentials,
              (SELECT count(*)::int FROM mail_account_sync_state WHERE item_id = $1) AS "syncStates",
              (SELECT count(*)::int FROM mail_account_server_settings WHERE mailbox_item_id = $1) AS "serverSettings"`,
      [mailboxItemId],
    );
    return rows;
  });
}

/** A mailbox with a credential, a sync state row and server settings, written through the stores that own each row. */
function createConnectedMailbox(): Promise<string> {
  return inTenantZero(() =>
    withTransaction(pool, async (client) => {
      const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
      const mailbox = await createItemWithClient(client, {
        databaseId: mailboxesDatabaseId,
        properties: { name: `Mailbox ${randomUUID()}`, provider: "generic" },
      });
      await storeCredential(client, { itemId: mailbox.id, credentialType: "app_password", plaintext: randomUUID() });
      await ensureMailAccountSyncState(client, { itemId: mailbox.id, syncMode: "imap" });
      await upsertMailServerSettings(client, mailbox.id, {
        imap: { host: "imap.example.test", port: 993, security: "tls" },
        smtp: null,
        username: "user@example.test",
      });
      return mailbox.id;
    }),
  );
}

/** The rejection of `promise`, failing when it resolves. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

describe("a Mailboxes item is not deleted through the generic write paths (issue gh-2031)", () => {
  let server: Server;
  let mcpServer: Server;
  let baseUrl: string;
  let mcpUrl: string;
  let headers: Record<string, string>;
  let agentActor: AuthenticatedActor;
  /** The run behind `agentActor`, as an approval request names it. */
  let agentRun: { runId: string; agentProjectItemId: string; userId: string };
  const gateway = () => createGenericOperationGateway(pool, testMetadataResolver);

  async function listen(s: Server): Promise<string> {
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    const address = s.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    return `http://127.0.0.1:${address.port}`;
  }

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());

    const user = await createUser(pool, {
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
      tenantId: getTenantZeroId(),
    });
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}` };

    const projectItemId = await createTestProjectItem(pool);
    const run = await createAgentRun(pool, { projectItemId, triggeredBy: "user", task: "tidy the mailboxes" });
    agentRun = { runId: run.id, agentProjectItemId: projectItemId, userId: run.actorUserId };
    agentActor = { ...agentRun };

    server = createServer(
      await createDispatcher(pool, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      }),
    );
    baseUrl = await listen(server);
    mcpServer = createServer(
      await createMcpRequestListener(pool, gateway(), ALL_CAPABILITIES, new ModuleRegistry(() => new Set())),
    );
    mcpUrl = await listen(mcpServer);
  });

  afterEach(async () => {
    await Promise.all([server, mcpServer].map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  });

  afterAll(async () => {
    await pool?.end();
  });

  function restDelete(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { method: "DELETE", headers });
  }

  /** `tools/call` as an MCP client on the user's own session: an agent without a run, which no approval gates. */
  async function mcpCall(name: string, args: unknown): Promise<unknown> {
    const res = await fetch(`${mcpUrl}/mcp`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    expect(res.status).toBe(200);
    return res.json();
  }

  /** How many approval requests and `approval_pending` notifications exist. */
  async function approvalRows(): Promise<{ requests: number; notifications: number }> {
    const { rows } = await inTenantZero(() =>
      pool.query<{ requests: number; notifications: number }>(
        `SELECT (SELECT count(*)::int FROM approval_requests) AS requests,
                (SELECT count(*)::int FROM notifications WHERE kind = 'approval_pending') AS notifications`,
      ),
    );
    const counts = rows[0];
    if (!counts) throw new Error("expected one row of counts");
    return counts;
  }

  /** Approves request `requestId` as the run's user and answers it as the `approvalExecute` job loads it. */
  async function approve(requestId: string) {
    await inTenantZero(() =>
      withTransaction(pool, (client) =>
        decideAndEnqueueApprovalRequest(client, {
          approvalRequestId: requestId,
          decision: "approved",
          decidedByUserId: agentRun.userId,
        }),
      ),
    );
    const request = await inTenantZero(() => getApprovalRequest(pool, requestId));
    if (!request || !isGenericOperationApprovalRequestPayload(request.payload)) {
      throw new Error("expected the approved generic operation request");
    }
    return { ...request, payload: request.payload };
  }

  it("DELETE /api/items/:id on a Mailboxes item answers 403 forbidden and changes nothing", async () => {
    const mailbox = await createConnectedMailbox();
    const before = await mailboxRows(mailbox);
    expect(before).toMatchObject([{ trashed: false, credentials: 1, syncStates: 1, serverSettings: 1 }]);

    const response = await restDelete(`/api/items/${mailbox}`);

    expect(response.status).toBe(403);
    expect(restError.parse(await response.json())).toEqual({ error: { code: "forbidden" } });
    expect(await mailboxRows(mailbox)).toEqual(before);
  });

  it("the item.delete of an MCP client, an agent, is refused with the same error and changes nothing", async () => {
    const mailbox = await createConnectedMailbox();
    const before = await mailboxRows(mailbox);

    const answer = mcpError.parse(await mcpCall("semprec.item.delete", { itemId: mailbox }));

    expect(answer.error).toEqual({
      code: -32000,
      message: expect.stringMatching(REFUSAL_MESSAGE),
      data: { code: "forbidden" },
    });
    expect(await mailboxRows(mailbox)).toEqual(before);
  });

  it("the item.delete of an agent run is refused with the same error when it is requested: no approval request is stored and nothing changes", async () => {
    const mailbox = await createConnectedMailbox();
    const before = await mailboxRows(mailbox);
    expect(await approvalRows()).toEqual({ requests: 0, notifications: 0 });

    const refused = await rejection(gateway().invoke("item.delete", agentActor, ALL_CAPABILITIES, { itemId: mailbox }));

    expect(refused).toBeInstanceOf(ForbiddenError);
    expect(refused).toMatchObject({ status: 403, code: "forbidden", message: expect.stringMatching(REFUSAL_MESSAGE) });
    expect(await approvalRows()).toEqual({ requests: 0, notifications: 0 });
    expect(await mailboxRows(mailbox)).toEqual(before);
  });

  it("the item.delete of an agent run on an item of another database still waits for approval and trashes the item once it is approved", async () => {
    const chokePoint = createChokePoint(pool);
    const database = await inTenantZero(() => chokePoint.createDatabase({ name: "Notes" }));
    const note = await inTenantZero(() => chokePoint.createItem({ databaseId: database.id, properties: {} }));

    const gated = await rejection(gateway().invoke("item.delete", agentActor, ALL_CAPABILITIES, { itemId: note.id }));
    if (!(gated instanceof ApprovalRequiredError))
      throw new Error(`expected ApprovalRequiredError, got ${String(gated)}`);
    const requestId = gated.details.approvalRequestId;
    expect(await approvalRows()).toEqual({ requests: 1, notifications: 1 });
    const request = await approve(requestId);

    const outcome = await inTenantZero(() => replayApprovedGenericOperation(pool, request));

    expect(outcome.error).toBe(false);
    expect(await inTenantZero(() => getApprovalRequest(pool, requestId))).toMatchObject({
      status: "approved",
      executionStatus: "succeeded",
    });
    expect(await inTenantZero(() => chokePoint.findItemIncludingDeleted(note.id))).toMatchObject({
      id: note.id,
      deletedAt: expect.any(String),
    });
  });

  it("an approved item.delete of a mailbox that was stored before the preflight refused it ends as a conflict when it is executed, and changes nothing", async () => {
    const mailbox = await createConnectedMailbox();
    const before = await mailboxRows(mailbox);
    // The preflight no longer stores such a request, so it is written through the approval store, as
    // a release without the refusal left it. Its hash is not the mailbox's: the execution must end at
    // the refusal, which it reports as the conflict's reason, before it compares any hash.
    const resourceSnapshot = { kind: "item_delete", resourceId: mailbox, sha256: "0".repeat(64) };
    const stored = await inTenantZero(() =>
      withTransaction(pool, (client) =>
        createPendingApprovalRequest(client, {
          agentRunId: agentRun.runId,
          toolName: "item.delete",
          riskClass: OPERATION_METADATA["item.delete"].riskClass,
          payload: {
            operationName: "item.delete",
            canonicalInput: { itemId: mailbox },
            actor: agentRun,
            resourceSnapshot,
          },
          resourceSnapshot,
        }),
      ),
    );
    const request = await approve(stored.id);

    const outcome = await inTenantZero(() => replayApprovedGenericOperation(pool, request));

    expect(outcome.error).toBe(true);
    expect(conflictResult.parse(JSON.parse(outcome.result))).toMatchObject({
      error: { code: "version_conflict", details: { reason: "forbidden", currentResource: { id: mailbox } } },
    });
    expect(await inTenantZero(() => getApprovalRequest(pool, stored.id))).toMatchObject({
      status: "approved",
      executionStatus: "conflict",
    });
    expect(await mailboxRows(mailbox)).toEqual(before);
  });

  it("DELETE /api/mail/mailboxes/:id still removes the mailbox", async () => {
    const mailbox = await createConnectedMailbox();

    const response = await restDelete(`/api/mail/mailboxes/${mailbox}`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: mailbox });
    expect(await mailboxRows(mailbox)).toMatchObject([
      { trashed: true, credentials: 0, syncStates: 0, serverSettings: 0 },
    ]);
  });

  it("DELETE /api/items/:id on an item of another database trashes it as before", async () => {
    const mailbox = await createConnectedMailbox();
    const before = await mailboxRows(mailbox);
    const chokePoint = createChokePoint(pool);
    const database = await inTenantZero(() => chokePoint.createDatabase({ name: "Notes" }));
    const note = await inTenantZero(() => chokePoint.createItem({ databaseId: database.id, properties: {} }));

    const response = await restDelete(`/api/items/${note.id}`);

    expect(response.status).toBe(200);
    expect(itemBody.parse(await response.json())).toMatchObject({ id: note.id, deletedAt: expect.any(String) });
    expect(await mailboxRows(mailbox)).toEqual(before);
  });
});
