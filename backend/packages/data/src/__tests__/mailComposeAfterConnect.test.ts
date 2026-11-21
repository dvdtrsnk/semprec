import "../domainWriteHooks.js";
import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import type { Pool } from "pg";
import { z } from "zod";
import { runInTenant } from "@semprec/shared";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUser } from "../auth/usersStore.js";
import { withTransaction } from "../db/pool.js";
import { ChokePointError } from "../errors.js";
import { createImapConnectionLimiter } from "../mail/imapConnectionLimiter.js";
import type { ImapMailClient } from "../mail/imapReconcile.js";
import { logger as mailLogger } from "../mail/logger.js";
import { createMailboxPasswordConnectRouteHandler } from "../mail/mailboxPasswordRouteHandlers.js";
import { createMailDraftCreateRouteHandler, createMailDraftSendRouteHandler } from "../mail/mailDraftRouteHandlers.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import {
  createMailOauthCompleteRouteHandler,
  createMailOauthStartRouteHandler,
} from "../mail/mailOauthRouteHandlers.js";
import { handleSyncMailAccountTask } from "../mail/mailSyncJob.js";
import { createSentCopySaver } from "../mail/mailTransport.js";
import { GOOGLE_TOKEN_URL, MICROSOFT_TOKEN_URL } from "../mail/oauthTokenExchange.js";
import { seedSystem } from "../seed/seedSystem.js";
import { FakeImapAccount } from "../testSupport/fakeImapAccount.js";
import { FakeImapServer } from "../testSupport/fakeImapServer.js";
import {
  connectLoopbackImapClient,
  IMAP_FIXTURE_ACCOUNT,
  noAttachmentStorage,
  plainMessage,
  PURELYMAIL_FOLDERS,
} from "../testSupport/imapMailboxFixture.js";
import { recordingTransport, sendAdapters, transportFor } from "../testSupport/mailSendFakes.js";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "../testSupport/testDb.js";

/** Unique per run, so a hit in a log call can only be this password. */
const PASSWORD = `pw-sentinel-${randomUUID()}`;
const PASSWORD_BODY = {
  provider: "generic",
  address: IMAP_FIXTURE_ACCOUNT,
  password: PASSWORD,
  imapHost: "imap.example.test",
  smtpHost: "smtp.example.test",
};
const RECIPIENT = { name: "Petr Novák", address: "petr@example.test" };

let admin: Pool;
let runtime: Pool;
let tenant: string;
let userId: string;

beforeAll(async () => {
  admin = getTestPool();
  runtime = await createRuntimeRolePool(admin, "semprec_data");
});

beforeEach(async () => {
  await resetDatabase(admin);
  tenant = await createTestTenant(admin);
  await runInTenant(tenant, () => seedSystem(runtime));
  userId = (await createUser(admin, { tenantId: tenant, email: `${randomUUID()}@example.test`, passwordHash: "x" })).id;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await runtime.end();
  await admin.end();
});

const user = () => ({ identity: { user: { id: userId, locale: "en" } } });

type ImapOpener = () => Promise<ImapMailClient>;

/** Through the production handler, with a verification that accepts the login and the given folder listing opener. */
async function connectPasswordMailbox(openImap: ImapOpener | undefined): Promise<string> {
  const handler = createMailboxPasswordConnectRouteHandler(runtime, {
    mailServerClients: {
      verifyPassword: async (input) => ({
        imap: { host: input.imapHost ?? "", port: 993, security: "tls" },
        smtp: { host: input.smtpHost ?? "", port: 465, security: "tls" },
      }),
      ...(openImap ? { openImap } : {}),
    },
    throttle: { tryAcquire: () => ({ granted: true }) },
  });
  const created = await runInTenant(tenant, () => handler({ ...user(), body: PASSWORD_BODY }));
  expect(created.status).toBe(201);
  return created.item.id;
}

interface FolderRow {
  purpose: string;
  provider_id: string;
  name: string;
}

/** The mailbox's Folder items, by purpose then provider id. */
async function foldersOf(mailboxId: string): Promise<FolderRow[]> {
  return runInTenant(tenant, () =>
    withTransaction(runtime, async (client) => {
      const { foldersDatabaseId } = await resolveMailModuleIds(client);
      const { rows } = await client.query<FolderRow>(
        `SELECT f.properties ->> 'specialPurpose' AS purpose, f.properties ->> 'providerId' AS provider_id,
                f.properties ->> 'name' AS name
           FROM items f JOIN item_relations r ON r.item_a = f.id OR r.item_b = f.id
          WHERE f.database_id = $1 AND f.deleted_at IS NULL AND (r.item_a = $2 OR r.item_b = $2)
          ORDER BY 1, 2`,
        [foldersDatabaseId, mailboxId],
      );
      return rows;
    }),
  );
}

/** The purposes of the folders an Emails item is filed in. */
async function folderPurposesOf(emailId: string): Promise<string[]> {
  return runInTenant(tenant, () =>
    withTransaction(runtime, async (client) => {
      const { foldersDatabaseId } = await resolveMailModuleIds(client);
      const { rows } = await client.query<{ purpose: string }>(
        `SELECT f.properties ->> 'specialPurpose' AS purpose
           FROM item_relations r JOIN items f ON f.id = CASE WHEN r.item_a = $1 THEN r.item_b ELSE r.item_a END
          WHERE (r.item_a = $1 OR r.item_b = $1) AND f.database_id = $2 AND f.deleted_at IS NULL
          ORDER BY 1`,
        [emailId, foldersDatabaseId],
      );
      return rows.map((row) => row.purpose);
    }),
  );
}

async function emailCount(): Promise<number> {
  return runInTenant(tenant, () =>
    withTransaction(runtime, async (client) => {
      const { emailsDatabaseId } = await resolveMailModuleIds(client);
      const { rows } = await client.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM items WHERE database_id = $1",
        [emailsDatabaseId],
      );
      return rows[0]?.n ?? -1;
    }),
  );
}

const draftBody = z.object({ id: z.uuid() }).loose();

/** `POST /api/mail/drafts` for a new message. */
function createDraft(mailboxId: string, from: string): Promise<{ status: number; body: unknown }> {
  return runInTenant(tenant, () =>
    createMailDraftCreateRouteHandler(runtime, { maxFileSizeBytes: 1024 * 1024 })({
      ...user(),
      params: {},
      body: { mailboxId, from, to: [RECIPIENT], cc: [], bcc: [], subject: "Hned po připojení", body: "Ahoj" },
    }),
  );
}

/** Creates a draft and sends it through `POST /api/mail/drafts/:id/send`; answers the draft id and what was sent. */
async function draftAndSend(mailboxId: string, from: string): Promise<{ draftId: string; sentCount: number }> {
  const created = await createDraft(mailboxId, from);
  expect(created.status).toBe(201);
  const draftId = draftBody.parse(created.body).id;
  expect(await folderPurposesOf(draftId)).toEqual(["drafts"]);

  const transport = recordingTransport();
  const sent = await runInTenant(tenant, () =>
    createMailDraftSendRouteHandler(runtime, { mailServerClients: { send: sendAdapters(transportFor(transport)) } })({
      ...user(),
      params: { id: draftId },
      body: undefined,
    }),
  );
  expect(sent.status).toBe(200);
  expect(await folderPurposesOf(draftId)).toEqual(["sent"]);
  return { draftId, sentCount: transport.sent.length };
}

describe("a password mailbox, right after POST /api/mail/mailboxes", () => {
  it("drafts, sends and keeps the Sent copy before any sync pass ran, and the first pass adds no second folder", async () => {
    const server = new FakeImapServer({ folders: PURELYMAIL_FOLDERS, capabilities: ["SPECIAL-USE"], latencyMs: 0 });
    const port = await server.listen();
    try {
      const mailboxId = await connectPasswordMailbox(() => connectLoopbackImapClient(port));

      expect(await foldersOf(mailboxId)).toEqual([
        { purpose: "drafts", provider_id: "Drafts", name: "Drafts" },
        { purpose: "sent", provider_id: "Sent", name: "Sent" },
      ]);
      expect(server.commands).toContain("LIST");
      expect(server.commands.at(-1)).toBe("LOGOUT");

      const { sentCount } = await draftAndSend(mailboxId, IMAP_FIXTURE_ACCOUNT);
      expect(sentCount).toBe(1);

      // The SMTP transport's Sent copy goes to the folder the connect found.
      const account = new FakeImapAccount([...PURELYMAIL_FOLDERS]);
      await runInTenant(tenant, () =>
        createSentCopySaver(runtime, mailboxId, { password: PASSWORD }, async () => account.client())(
          plainMessage("Hned po připojení"),
          Promise.resolve(true),
        ),
      );
      expect(account.countIn("Sent")).toBe(1);

      await runInTenant(tenant, async () => {
        const moduleIds = await withTransaction(runtime, (client) => resolveMailModuleIds(client));
        await handleSyncMailAccountTask(
          runtime,
          { mailboxItemId: mailboxId },
          { createImapClient: () => connectLoopbackImapClient(port) },
          moduleIds,
          noAttachmentStorage,
          undefined,
          createImapConnectionLimiter(),
        );
      });
      const folders = await foldersOf(mailboxId);
      expect(folders.map((folder) => folder.provider_id).sort()).toEqual(
        PURELYMAIL_FOLDERS.map((folder) => folder.path).sort(),
      );
      expect(folders.filter((folder) => folder.purpose === "drafts" || folder.purpose === "sent")).toHaveLength(2);
    } finally {
      await server.close();
    }
  });

  it("connects without folders when the listing fails, logs no user content, and refuses a draft with mail_drafts_folder_missing", async () => {
    const warn = vi.spyOn(mailLogger, "warn");
    const emailsBefore = await emailCount();

    const mailboxId = await connectPasswordMailbox(() =>
      Promise.reject(new Error(`login ${PASSWORD} for ${IMAP_FIXTURE_ACCOUNT} failed`)),
    );

    expect(await foldersOf(mailboxId)).toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      { stage: "listing", errorName: "Error" },
      "The connect could not list the IMAP folders; the first sync pass discovers them",
    );
    const logged = inspect(warn.mock.calls, { depth: 8 });
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(IMAP_FIXTURE_ACCOUNT);

    const refusal = await createDraft(mailboxId, IMAP_FIXTURE_ACCOUNT).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ChokePointError);
    expect(refusal).toMatchObject({ status: 409, code: "mail_drafts_folder_missing", details: { mailboxId } });
    expect(await emailCount()).toBe(emailsBefore);
  });

  it("fails with a configuration error before verifying any login when the composition root gave no IMAP opener", async () => {
    const verifyPassword = vi.fn();
    const handler = createMailboxPasswordConnectRouteHandler(runtime, {
      mailServerClients: { verifyPassword },
      throttle: { tryAcquire: () => ({ granted: true }) },
    });

    const error = await runInTenant(tenant, () => handler({ ...user(), body: PASSWORD_BODY })).catch(
      (failure: unknown) => failure,
    );

    expect(error).not.toBeInstanceOf(ChokePointError);
    expect(error).toMatchObject({
      message: 'custom route dependency "mailServerClients.openImap" is not configured by the composition root',
    });
    expect(verifyPassword).not.toHaveBeenCalled();
  });
});

describe("an OAuth mailbox, right after POST /api/mail/mailboxes/oauth/complete", () => {
  const OAUTH = {
    gmail: { clientId: "gmail-client-id", clientSecret: "gmail-client-secret" },
    msGraph: { clientId: "graph-client-id", clientSecret: "graph-client-secret" },
    redirectBaseUrl: "https://app.example.test",
  };
  const GRAPH_DRAFTS_URL = "https://graph.microsoft.com/v1.0/me/mailFolders/drafts?$select=id,displayName";
  const GRAPH_SENT_URL = "https://graph.microsoft.com/v1.0/me/mailFolders/sentitems?$select=id,displayName";
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const tokens = () =>
    json({ access_token: "access-token", expires_in: 3600, refresh_token: "refresh-token", token_type: "Bearer" });

  type Routes = Record<string, () => Response>;

  const GOOGLE: Routes = {
    [GOOGLE_TOKEN_URL]: tokens,
    "https://gmail.googleapis.com/gmail/v1/users/me/profile": () => json({ emailAddress: "connect.user@gmail.com" }),
    "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs": () => json({ sendAs: [] }),
  };
  const MICROSOFT: Routes = {
    [MICROSOFT_TOKEN_URL]: tokens,
    "https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,proxyAddresses": () =>
      json({ mail: "work.user@contoso.com" }),
    [GRAPH_DRAFTS_URL]: () => json({ id: "graph-drafts-id", displayName: "Koncepty" }),
    [GRAPH_SENT_URL]: () => json({ id: "graph-sent-id", displayName: "Odeslaná pošta" }),
  };

  async function connectOauthMailbox(provider: "gmail" | "outlook", routes: Routes): Promise<string> {
    const fetchImpl: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const route = routes[url];
      if (!route) throw new Error(`unexpected provider request to ${url}`);
      return route();
    };
    const started = await runInTenant(tenant, () =>
      createMailOauthStartRouteHandler(runtime, { oauth: OAUTH })({ ...user(), body: { provider } }),
    );
    const state = new URL(z.object({ authorizeUrl: z.string() }).parse(started.body).authorizeUrl).searchParams.get(
      "state",
    );
    const completed = await runInTenant(tenant, () =>
      createMailOauthCompleteRouteHandler(runtime, { oauth: OAUTH, outboundHttp: fetchImpl })({
        ...user(),
        body: { state, code: "authorization-code" },
      }),
    );
    expect(completed.status).toBe(201);
    return z.object({ mailboxId: z.uuid() }).parse(completed.body).mailboxId;
  }

  it.each([
    {
      name: "a Gmail account, from its fixed system labels",
      provider: "gmail" as const,
      routes: GOOGLE,
      from: "connect.user@gmail.com",
      folders: [
        { purpose: "drafts", provider_id: "DRAFT", name: "DRAFT" },
        { purpose: "sent", provider_id: "SENT", name: "SENT" },
      ],
    },
    {
      name: "an Outlook account, from its two well-known folders",
      provider: "outlook" as const,
      routes: MICROSOFT,
      from: "work.user@contoso.com",
      folders: [
        { purpose: "drafts", provider_id: "graph-drafts-id", name: "Koncepty" },
        { purpose: "sent", provider_id: "graph-sent-id", name: "Odeslaná pošta" },
      ],
    },
  ])("drafts and sends $name before any sync pass ran", async ({ provider, routes, from, folders }) => {
    const mailboxId = await connectOauthMailbox(provider, routes);

    expect(await foldersOf(mailboxId)).toEqual(folders);
    expect((await draftAndSend(mailboxId, from)).sentCount).toBe(1);
  });

  it("connects an Outlook account whose Drafts folder read fails, keeping the Sent folder it could read", async () => {
    const warn = vi.spyOn(mailLogger, "warn");

    const mailboxId = await connectOauthMailbox("outlook", {
      ...MICROSOFT,
      [GRAPH_DRAFTS_URL]: () => json({ error: { code: "ErrorAccessDenied" } }, 403),
    });

    expect(await foldersOf(mailboxId)).toEqual([
      { purpose: "sent", provider_id: "graph-sent-id", name: "Odeslaná pošta" },
    ]);
    expect(warn).toHaveBeenCalledWith(
      { wellKnownName: "drafts", errorName: "Error" },
      "The connect could not read a Microsoft Graph folder; the first sync pass discovers it",
    );
    await expect(createDraft(mailboxId, "work.user@contoso.com")).rejects.toMatchObject({
      status: 409,
      code: "mail_drafts_folder_missing",
    });
  });
});
