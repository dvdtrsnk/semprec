import { afterAll, beforeAll, beforeEach, describe, expect, it as vitestIt, vi } from "vitest";
import type { Pool } from "pg";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { upsertMailMessageMeta } from "../mail/mailMessageMetaStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { seedSystem } from "../seed/seedSystem.js";
import { GMAIL_SEND_PURPOSE } from "../mail/gmailTransport.js";
import { createMailTransportFactory } from "../mail/mailTransport.js";
import { MailReauthorizationRequiredError, MailRecipientRejectedError } from "../mail/providerTypes.js";
import { getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";

// A fake Google answers the token endpoint and the send endpoint through the `fetchImpl` seam. The stored
// refresh token is the only one it accepts, so a refresh that presents anything else is refused.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const CLIENT_ID = "gmail-test-client.example";
const CLIENT_SECRET = "gmail-test-client-secret-value";
const STORED_REFRESH_TOKEN = "1//stored-refresh-token-for-gmail-send";
const ACCESS_TOKEN = "ya29.access-token-for-gmail-send";
const RAW_MESSAGE = Buffer.from(
  [
    "From: me@gmail.test",
    "To: bob@gmail.test",
    "Subject: Hello",
    "Message-ID: <sent-1@gmail.test>",
    "In-Reply-To: <source-1@gmail.test>",
    "",
    "The body of the message.",
    "",
  ].join("\r\n"),
);

interface SendCall {
  authorization: string | undefined;
  body: { raw: string; threadId?: string };
}

interface FakeGoogle {
  refreshTokensPresented: string[];
  sends: SendCall[];
  fetchImpl: typeof fetch;
}

/**
 * `sendReply` answers each send. `tokenRefused` makes the token endpoint reject every refresh, the way Google
 * answers a revoked refresh token.
 */
function fakeGoogle(options: { tokenRefused?: boolean; sendReply?: () => Response } = {}): FakeGoogle {
  const refreshTokensPresented: string[] = [];
  const sends: SendCall[] = [];
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (target === TOKEN_URL) {
      const form = init?.body instanceof URLSearchParams ? init.body : new URLSearchParams();
      const presented = form.get("refresh_token") ?? "";
      refreshTokensPresented.push(presented);
      if (options.tokenRefused || presented !== STORED_REFRESH_TOKEN) {
        return new Response("invalid_grant", { status: 400 });
      }
      return Response.json({ access_token: ACCESS_TOKEN, expires_in: 3600 });
    }
    if (target === SEND_URL) {
      const headers = init?.headers as Record<string, string> | undefined;
      const requestBody = typeof init?.body === "string" ? init.body : "";
      sends.push({
        authorization: headers?.Authorization,
        body: JSON.parse(requestBody) as SendCall["body"],
      });
      return options.sendReply
        ? options.sendReply()
        : Response.json({ id: "gmail-sent-1", threadId: "gmail-thread-1" });
    }
    throw new Error(`unexpected request to ${target}`);
  });
  return { refreshTokensPresented, sends, fetchImpl };
}

function decodeRaw(call: SendCall): string {
  return Buffer.from(call.body.raw, "base64url").toString("utf8");
}

const it = (name: string, fn: () => Promise<void>) => vitestIt(name, () => inTenantZero(fn));

describe("Gmail API mail transport (issue #1637)", () => {
  let pool: Pool;
  let mailboxId: string;
  const oauthClient = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };

  beforeAll(() => {
    pool = getTestPool();
  });

  beforeEach(() =>
    inTenantZero(async () => {
      await resetDatabase(pool);
      await seedSystem(pool);
      const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
        "mailboxes",
      ]);
      const mailboxesId = rows[0]!.id;
      mailboxId = await withTransaction(pool, async (client) => {
        const mailbox = await createItemWithClient(client, {
          databaseId: mailboxesId,
          properties: { name: "Gmail", provider: "gmail" },
        });
        await writeMailboxAddresses(client, {
          mailboxesDatabaseId: mailboxesId,
          mailboxItemId: mailbox.id,
          address: "me@gmail.test",
        });
        return mailbox.id;
      });
      await storeCredential(pool, {
        itemId: mailboxId,
        credentialType: "oauth2_refresh_token",
        plaintext: STORED_REFRESH_TOKEN,
      });
    }),
  );

  afterAll(async () => {
    await pool.end();
  });

  async function transportFor(google: FakeGoogle) {
    return createMailTransportFactory(pool, { gmailOAuthClient: oauthClient, fetchImpl: google.fetchImpl }).forMailbox(
      mailboxId,
      "gmail_api",
    );
  }

  it("refreshes the access token from the stored refresh token and sends the raw MIME with it", async () => {
    const google = fakeGoogle();

    const result = await (
      await transportFor(google)
    ).send({
      raw: RAW_MESSAGE,
      envelope: { from: "me@gmail.test", recipients: ["bob@gmail.test"] },
    });

    expect(result).toEqual({ providerMessageId: "gmail-sent-1" });
    expect(google.refreshTokensPresented).toEqual([STORED_REFRESH_TOKEN]);
    expect(google.sends).toHaveLength(1);
    expect(google.sends[0]!.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(decodeRaw(google.sends[0]!)).toBe(RAW_MESSAGE.toString("utf8"));
  });

  it("keeps the Message-ID from the MIME in the bytes Gmail receives", async () => {
    const google = fakeGoogle();

    await (
      await transportFor(google)
    ).send({
      raw: RAW_MESSAGE,
      envelope: { from: "me@gmail.test", recipients: ["bob@gmail.test"] },
    });

    expect(decodeRaw(google.sends[0]!)).toContain("Message-ID: <sent-1@gmail.test>");
  });

  it("deduplicates a later synced Gmail copy using the Message-ID actually sent", async () => {
    const google = fakeGoogle();
    const transport = await transportFor(google);
    await transport.send({ raw: RAW_MESSAGE, envelope: { from: "me@gmail.test", recipients: ["bob@gmail.test"] } });
    const [sent] = google.sends;
    if (!sent) throw new Error("Missing Gmail send");
    const match = /^Message-ID: (.+)$/im.exec(decodeRaw(sent));
    if (!match?.[1]) throw new Error("Missing sent Message-ID");
    const messageId = match[1].trim();
    const storage: BlobStorageWriter = {
      async writeStream() {
        throw new Error("Unexpected attachment write");
      },
      async delete() {
        throw new Error("Unexpected attachment delete");
      },
      readStream() {
        throw new Error("Unexpected attachment read");
      },
    };
    const { originalId, ingested } = await withTransaction(pool, async (client) => {
      const ids = await resolveMailModuleIds(client);
      const folderProperty = await getPropertyByKey(client, ids.emailsDatabaseId, "folder");
      const attachmentProperty = await getPropertyByKey(client, ids.emailsDatabaseId, "attachments");
      if (!folderProperty || !attachmentProperty) throw new Error("Missing Email relation properties");
      const item = await createItemWithClient(client, { databaseId: ids.emailsDatabaseId, properties: {} });
      const folder = await createItemWithClient(
        client,
        { databaseId: ids.foldersDatabaseId, properties: { name: "Sent", behavior: "folder", providerId: "SENT" } },
        { allowedSystemKeys: ["name", "behavior", "providerId"] },
      );
      await upsertMailMessageMeta(client, { itemId: item.id, mailboxItemId: mailboxId, messageId, envelope: {} });
      const ingested = await ingestEmailMessage(client, {
        emailsDatabaseId: ids.emailsDatabaseId,
        filesDatabaseId: ids.filesDatabaseId,
        folderRelationPropertyId: folderProperty.id,
        attachmentsRelationPropertyId: attachmentProperty.id,
        folderItemId: folder.id,
        mailboxItemId: mailboxId,
        messageId,
        envelope: {},
        attachments: [],
        storage,
        storageKeyPrefix: "test",
      });
      return { originalId: item.id, ingested };
    });
    expect(ingested).toEqual({ itemId: originalId, created: false });
  });

  it("names the provider thread id of a reply as the send's threadId, so the message joins that thread", async () => {
    const google = fakeGoogle({
      sendReply: () => Response.json({ id: "gmail-sent-2", threadId: "gmail-thread-existing" }),
    });

    const result = await (
      await transportFor(google)
    ).send({
      raw: RAW_MESSAGE,
      envelope: { from: "me@gmail.test", recipients: ["bob@gmail.test"] },
      providerThreadId: "gmail-thread-existing",
    });

    expect(google.sends[0]!.body.threadId).toBe("gmail-thread-existing");
    expect(result).toEqual({ providerMessageId: "gmail-sent-2" });
  });

  it("sends no threadId for a message that is not a reply", async () => {
    const google = fakeGoogle();

    await (
      await transportFor(google)
    ).send({
      raw: RAW_MESSAGE,
      envelope: { from: "me@gmail.test", recipients: ["bob@gmail.test"] },
    });

    expect(google.sends[0]!.body).not.toHaveProperty("threadId");
  });

  it("records the token refresh under the gmail_api_send purpose, not the sync purpose", async () => {
    const google = fakeGoogle();

    await (
      await transportFor(google)
    ).send({
      raw: RAW_MESSAGE,
      envelope: { from: "me@gmail.test", recipients: ["bob@gmail.test"] },
    });

    const { rows } = await pool.query<{ purpose: string }>(
      `SELECT purpose FROM credential_access_log WHERE item_id = $1`,
      [mailboxId],
    );
    expect(rows.map((row) => row.purpose)).toEqual([GMAIL_SEND_PURPOSE]);
  });

  it("throws MailReauthorizationRequiredError when the token is revoked, and sends nothing", async () => {
    const google = fakeGoogle({ tokenRefused: true });

    const error = await (
      await transportFor(google)
    )
      .send({ raw: RAW_MESSAGE, envelope: { from: "me@gmail.test", recipients: ["bob@gmail.test"] } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailReauthorizationRequiredError);
    expect((error as Error).message).not.toContain(STORED_REFRESH_TOKEN);
    expect(google.sends).toHaveLength(0);
  });

  it("throws MailReauthorizationRequiredError when Gmail rejects the access token on send", async () => {
    const google = fakeGoogle({
      sendReply: () => new Response(JSON.stringify({ error: { message: "Invalid Credentials" } }), { status: 401 }),
    });

    const error = await (
      await transportFor(google)
    )
      .send({ raw: RAW_MESSAGE, envelope: { from: "me@gmail.test", recipients: ["bob@gmail.test"] } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailReauthorizationRequiredError);
    expect((error as Error).message).not.toContain(ACCESS_TOKEN);
  });

  it("throws MailRecipientRejectedError when Gmail names an invalid recipient", async () => {
    const google = fakeGoogle({
      sendReply: () =>
        new Response(JSON.stringify({ error: { code: 400, message: "Invalid To header" } }), { status: 400 }),
    });

    const error = await (
      await transportFor(google)
    )
      .send({ raw: RAW_MESSAGE, envelope: { from: "me@gmail.test", recipients: ["not-an-address"] } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailRecipientRejectedError);
    expect((error as Error).message).not.toContain("not-an-address");
  });

  it("leaves any other send failure as an ordinary error, neither reauthorization nor recipient", async () => {
    const google = fakeGoogle({ sendReply: () => new Response("unavailable", { status: 503 }) });

    const error = await (
      await transportFor(google)
    )
      .send({ raw: RAW_MESSAGE, envelope: { from: "me@gmail.test", recipients: ["bob@gmail.test"] } })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MailReauthorizationRequiredError);
    expect(error).not.toBeInstanceOf(MailRecipientRejectedError);
    expect((error as Error).message).toBe("Gmail send failed with status 503");
  });

  it("fails before any Gmail request when the mailbox has no stored refresh token", async () => {
    await pool.query(`DELETE FROM external_credentials WHERE item_id = $1`, [mailboxId]);
    const google = fakeGoogle();

    await expect(
      (await transportFor(google)).send({
        raw: RAW_MESSAGE,
        envelope: { from: "me@gmail.test", recipients: ["bob@gmail.test"] },
      }),
    ).rejects.toThrow(/No OAuth credential is stored/);
    expect(google.sends).toHaveLength(0);
  });

  it("refuses a gmail_api mailbox when no Gmail OAuth client is configured, before reading anything", async () => {
    await expect(createMailTransportFactory(pool).forMailbox(mailboxId, "gmail_api")).rejects.toThrow(
      /No Gmail OAuth client is configured for this composition root/,
    );
  });
});
