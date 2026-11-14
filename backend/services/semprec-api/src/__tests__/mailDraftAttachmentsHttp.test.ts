import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { runAsSystem, runInTenant } from "@semprec/shared";
import {
  createRuntimeRolePool,
  createTestTenant,
  ensureFolderItem,
  getTestPool,
  resetDatabase,
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
 * Issue gh-1895 through the production composition path: the real dispatcher mounts the draft attachment routes of
 * the mail module, and the limit of a mailbox without a provider limit is the `maxFileSizeBytes` the dispatcher was
 * given, the cap `POST /api/files` enforces. The data package's `mailDraftAttachments.test.ts` covers every branch
 * of the operations; this file covers the wiring from the HTTP request to the limit and the answer's status.
 */

const UPLOAD_LIMIT_BYTES = 1000;
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();
const blobStorage = new LocalFsBlobStorageWriter(
  join(tmpdir(), `semprec-test-blobs-draft-attachments-${randomUUID()}`),
);
const originalScopeMode = process.env.SEMPREC_TENANT_SCOPE;

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

/** A file of `size` bytes uploaded through `POST /api/files`, as the compose window does; answers its Files item id. */
async function upload(size: number): Promise<string> {
  const res = await fetch(`${baseUrl}/api/files`, {
    method: "POST",
    headers: { ...bearer, "Content-Type": "application/octet-stream", "X-Filename": `file-${randomUUID()}.bin` },
    // Content that differs per call: an identical upload would answer the Files item of the first.
    body: Buffer.from(
      randomUUID()
        .repeat(Math.ceil(size / 36))
        .slice(0, size),
    ),
  });
  expect(res.status).toBe(201);
  return z.object({ id: z.uuid() }).parse(await res.json()).id;
}

/** A mailbox of `provider` with an address and a Drafts folder, written the way the connect flow and folder discovery do. */
async function mailboxWithDrafts(provider: string): Promise<string> {
  const address = `${randomUUID()}@example.test`;
  const mailboxId = await runInTenant(tenantId, () =>
    withTransaction(pool, async (client) => {
      const ids = await resolveMailModuleIds(client);
      const folderProperties = await createChokePoint(pool).listProperties(ids.foldersDatabaseId);
      const mailboxProperty = folderProperties.find((property) => property.key === "mailbox");
      if (!mailboxProperty) throw new Error("the Folders database has no mailbox property");
      const mailbox = await createItemWithClient(client, {
        databaseId: ids.mailboxesDatabaseId,
        properties: { name: `Mailbox ${provider}`, provider },
      });
      await writeMailboxAddresses(client, {
        mailboxesDatabaseId: ids.mailboxesDatabaseId,
        mailboxItemId: mailbox.id,
        address,
      });
      await ensureFolderItem(client, {
        foldersDatabaseId: ids.foldersDatabaseId,
        mailboxItemId: mailbox.id,
        mailboxRelationPropertyId: mailboxProperty.id,
        providerId: "DRAFTS",
        name: "Drafts",
        behavior: "folder",
        specialPurpose: "drafts",
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
    subject: "With files",
    body: "See the files",
  });
  expect(draft.status).toBe(201);
  return z.object({ id: z.uuid() }).parse(draft.body).id;
}

const draftView = z.object({ attachments: z.array(z.object({ fileItemId: z.uuid(), byteSize: z.number() })) });

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
    setupToken: "draft-attachments-setup-token",
    moduleRegistry,
    blobStorage,
    maxFileSizeBytes: UPLOAD_LIMIT_BYTES,
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

describe("the draft attachment routes behind the REST adapter (issue gh-1895)", () => {
  it("attaches and detaches a file, answering the draft with its attachments", async () => {
    const draftId = await mailboxWithDrafts("generic");
    const fileId = await upload(100);

    const attached = await request("POST", `/api/mail/drafts/${draftId}/attachments`, { fileItemId: fileId });

    expect(attached.status).toBe(200);
    expect(draftView.parse(attached.body).attachments).toEqual([{ fileItemId: fileId, byteSize: 100 }]);
    const detached = await request("DELETE", `/api/mail/drafts/${draftId}/attachments/${fileId}`);
    expect(detached.status).toBe(200);
    expect(draftView.parse(detached.body).attachments).toEqual([]);
  });

  it("answers 413 mail_attachment_too_large when the total passes the upload cap of a mailbox without a provider limit", async () => {
    const draftId = await mailboxWithDrafts("generic");
    const first = await upload(600);
    const second = await upload(600);
    await request("POST", `/api/mail/drafts/${draftId}/attachments`, { fileItemId: first });

    const refused = await request("POST", `/api/mail/drafts/${draftId}/attachments`, { fileItemId: second });

    expect(refused.status).toBe(413);
    expect(refused.body).toEqual({
      error: {
        code: "mail_attachment_too_large",
        details: { limitBytes: UPLOAD_LIMIT_BYTES, totalBytes: 1200 },
      },
    });
    const draft = await request("GET", `/api/mail/drafts/${draftId}`);
    expect(draftView.parse(draft.body).attachments.map((attachment) => attachment.fileItemId)).toEqual([first]);
  });

  it("does not apply the upload cap to a Gmail mailbox, whose limit is the provider's", async () => {
    const draftId = await mailboxWithDrafts("gmail");
    const first = await upload(600);
    const second = await upload(600);
    await request("POST", `/api/mail/drafts/${draftId}/attachments`, { fileItemId: first });

    const answer = await request("POST", `/api/mail/drafts/${draftId}/attachments`, { fileItemId: second });

    expect(answer.status).toBe(200);
    expect(draftView.parse(answer.body).attachments).toHaveLength(2);
  });
});
