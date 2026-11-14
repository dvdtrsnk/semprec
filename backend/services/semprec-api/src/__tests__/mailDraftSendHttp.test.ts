import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  ensureFolderItem,
  getTestPool,
  resetDatabase,
  storeCredential,
  writeMailboxAddresses,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createItemWithClient,
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  provisionTenant,
  resolveMailModuleIds,
  withTransaction,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

/**
 * Issue gh-1896 through the production composition path: the real dispatcher mounts the send route of the mail module,
 * and when the caller's container carries no send adapters it builds the transports of the mailbox's provider from the
 * OAuth clients and the outbound `fetch` of that container, and reads attachment bytes from its blob storage. The data
 * package's `mailDraftSendRoute.test.ts` covers every branch of the operation; this file covers the wiring from the
 * HTTP request to the provider and the answers' statuses and bodies.
 */

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const REFRESH_TOKEN = "1//stored-refresh-token-for-the-http-send";
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();
const blobStorage = new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-blobs-draft-send-${randomUUID()}`));
const originalScopeMode = process.env.SEMPREC_TENANT_SCOPE;

/** What Google was asked, and whether it still accepts the stored refresh token. */
const google = { sends: [] as { threadId: string | undefined; raw: string }[], revoked: false };
const outboundHttp = vi.fn<typeof fetch>(async (input, init) => {
  const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (target === GOOGLE_TOKEN_URL) {
    const form = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
    if (google.revoked || form.get("refresh_token") !== REFRESH_TOKEN) {
      return new Response("invalid_grant", { status: 400 });
    }
    return Response.json({ access_token: "ya29.http-send", expires_in: 3600 });
  }
  if (target === GOOGLE_SEND_URL) {
    const body = z
      .object({ raw: z.string(), threadId: z.string().optional() })
      .parse(JSON.parse(typeof init?.body === "string" ? init.body : "{}"));
    google.sends.push({ threadId: body.threadId, raw: Buffer.from(body.raw, "base64url").toString("utf8") });
    return Response.json({ id: "gmail-sent-1", threadId: "gmail-thread-1" });
  }
  throw new Error(`unexpected request to ${target}`);
});

let adminPool: Pool;
let pool: Pool;
let tenantId: string;
let bearer: Record<string, string>;
let server: Server;
let baseUrl: string;

async function request(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = bearer,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const isJson = (res.headers.get("content-type") ?? "").startsWith("application/json");
  return { status: res.status, body: isJson ? JSON.parse(text) : text };
}

/** A Gmail mailbox with a stored refresh token, a Drafts folder and a Sent folder, and a draft in it; answers the draft's id. */
async function gmailDraft(draftBody: Record<string, unknown> = {}): Promise<{ draftId: string; mailboxId: string }> {
  const address = `${randomUUID()}@example.test`;
  const mailboxId = await runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const ids = await resolveMailModuleIds(client);
      const folderProperties = await createChokePoint(pool).listProperties(ids.foldersDatabaseId);
      const mailboxProperty = folderProperties.find((property) => property.key === "mailbox");
      if (!mailboxProperty) throw new Error("the Folders database has no mailbox property");
      const mailbox = await createItemWithClient(client, {
        databaseId: ids.mailboxesDatabaseId,
        properties: { name: "Gmail mailbox", provider: "gmail" },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: ids.mailboxesDatabaseId,
        mailboxItemId: mailbox.id,
        address,
      });
      for (const [providerId, name, specialPurpose] of [
        ["DRAFTS", "Drafts", "drafts"],
        ["SENT", "Sent", "sent"],
      ] as const) {
        await ensureFolderItem(client, {
          foldersDatabaseId: ids.foldersDatabaseId,
          mailboxItemId: mailbox.id,
          mailboxRelationPropertyId: mailboxProperty.id,
          providerId,
          name,
          behavior: "folder",
          specialPurpose,
        });
      }
      await storeCredential(client, {
        itemId: mailbox.id,
        credentialType: "oauth2_refresh_token",
        plaintext: REFRESH_TOKEN,
      });
      return mailbox.id;
    }),
  );
  const draft = await request("POST", "/api/mail/drafts", {
    mailboxId,
    from: address,
    to: [{ address: "recipient@example.test" }],
    cc: [],
    bcc: [],
    subject: "Over HTTP",
    body: "Sent through the dispatcher",
    ...draftBody,
  });
  expect(draft.status).toBe(201);
  return { draftId: z.object({ id: z.uuid() }).parse(draft.body).id, mailboxId };
}

const sentAnswer = z.object({
  emailId: z.uuid(),
  threadId: z.uuid(),
  sentAt: z.string(),
  mailbox: z.object({ id: z.uuid(), name: z.string() }),
});

beforeAll(async () => {
  process.env.SEMPREC_TENANT_SCOPE = "strict";
  adminPool = getTestPool();
  await resetDatabase(adminPool);
  pool = await createRuntimeRolePool(adminPool, "semprec_data");
  tenantId = await createTestTenant(adminPool);
  await provisionTenant(pool, tenantId);
  const email = `${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  const passwordHash = await hashPassword(password);
  // `users` is a global identity table, written outside any tenant as account creation does.
  await runAsSystem("test-fixture-create-user", () => createUser(adminPool, { email, passwordHash, tenantId }));

  const dispatch = await createDispatcher(pool, {
    passwordResetMailer: noopMailer,
    appBaseUrl: "https://app.example.test",
    setupToken: "draft-send-setup-token",
    moduleRegistry,
    blobStorage,
    maxFileSizeBytes: 1_000_000,
    customRouteDependencies: {
      oauth: { gmail: { clientId: "http-send-client", clientSecret: "http-send-secret" } },
      outboundHttp,
    },
  });
  server = createServer(dispatch);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  baseUrl = `http://127.0.0.1:${address.port}`;

  const login = await request("POST", "/api/auth/login", { email, password, platform: "ios" }, {});
  expect(login.status).toBe(200);
  bearer = { Authorization: `Bearer ${z.object({ token: z.string() }).parse(login.body).token}` };
}, 120_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await pool?.end();
  await adminPool?.end();
  if (originalScopeMode === undefined) delete process.env.SEMPREC_TENANT_SCOPE;
  else process.env.SEMPREC_TENANT_SCOPE = originalScopeMode;
});

describe("the draft send route behind the REST adapter (issue gh-1896)", () => {
  it("sends through the Gmail transport the dispatcher builds, answering the sent message", async () => {
    google.sends.length = 0;
    google.revoked = false;
    const { draftId, mailboxId } = await gmailDraft();

    const answer = await request("POST", `/api/mail/drafts/${draftId}/send`);

    expect(answer.status).toBe(200);
    expect(sentAnswer.parse(answer.body)).toMatchObject({
      emailId: draftId,
      mailbox: { id: mailboxId, name: "Gmail mailbox" },
    });
    expect(google.sends).toHaveLength(1);
    expect(google.sends[0]?.raw).toContain("Subject: Over HTTP");
    const read = await request("GET", `/api/mail/drafts/${draftId}`);
    expect(z.object({ sentAt: z.string() }).parse(read.body).sentAt).toBe(sentAnswer.parse(answer.body).sentAt);
  });

  it("answers the second call with 409 mail_draft_already_sent and the first call's ids, delivering once", async () => {
    google.sends.length = 0;
    google.revoked = false;
    const { draftId } = await gmailDraft();
    const first = sentAnswer.parse((await request("POST", `/api/mail/drafts/${draftId}/send`)).body);

    const second = await request("POST", `/api/mail/drafts/${draftId}/send`);

    expect(second).toEqual({
      status: 409,
      body: { error: { code: "mail_draft_already_sent", details: { emailId: draftId, threadId: first.threadId } } },
    });
    expect(google.sends).toHaveLength(1);
  });

  it("answers 409 mail_reauthorization_required when Google refuses the stored token, leaving the draft sendable", async () => {
    google.sends.length = 0;
    google.revoked = true;
    const { draftId } = await gmailDraft();

    const refused = await request("POST", `/api/mail/drafts/${draftId}/send`);

    expect(refused).toEqual({ status: 409, body: { error: { code: "mail_reauthorization_required" } } });
    expect(google.sends).toEqual([]);
    google.revoked = false;
    expect((await request("POST", `/api/mail/drafts/${draftId}/send`)).status).toBe(200);
  });

  it("answers 400 for a draft without a recipient and 404 for an id that names no draft", async () => {
    const { draftId } = await gmailDraft({ to: [] });

    const noRecipient = await request("POST", `/api/mail/drafts/${draftId}/send`);
    const unknown = await request("POST", `/api/mail/drafts/${randomUUID()}/send`);

    expect(noRecipient.status).toBe(400);
    expect(unknown.status).toBe(404);
  });

  it("answers 401 to a request with no session", async () => {
    const { draftId } = await gmailDraft();

    const answer = await request("POST", `/api/mail/drafts/${draftId}/send`, undefined, {});

    expect(answer.status).toBe(401);
  });
});
