import { afterAll, beforeAll, beforeEach, describe, expect, it as vitestIt, vi } from "vitest";
import type { Pool } from "pg";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { seedSystem } from "../seed/seedSystem.js";
import { GMAIL_SEND_PURPOSE } from "../mail/gmailTransport.js";
import { createMailTransportFactory } from "../mail/mailTransport.js";
import {
  MailReauthorizationRequiredError,
  MailRecipientRejectedError,
  MailTransportUnavailableError,
} from "../mail/providerTypes.js";
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

/** The Message-ID Gmail files every sent message under in these tests, never the one submitted. */
const GMAIL_OWN_MESSAGE_ID = "<CABH9a-gmail-own-1@mail.gmail.com>";
const METADATA_URL_PREFIX = "https://gmail.googleapis.com/gmail/v1/users/me/messages/";

function fakeGoogle(
  options: { tokenRefused?: boolean; sendReply?: () => Response; metadataReply?: () => Response } = {},
): FakeGoogle {
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
    if (target.startsWith(METADATA_URL_PREFIX) && target.includes("format=metadata")) {
      return options.metadataReply
        ? options.metadataReply()
        : Response.json({
            id: "gmail-sent-1",
            threadId: "gmail-thread-1",
            labelIds: ["SENT"],
            payload: { mimeType: "text/plain", headers: [{ name: "Message-ID", value: GMAIL_OWN_MESSAGE_ID }] },
          });
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

    expect(result).toEqual({
      providerMessageId: "gmail-sent-1",
      providerThreadId: "gmail-thread-1",
      messageId: GMAIL_OWN_MESSAGE_ID,
    });
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

  it("still reports a delivered send when reading back Gmail's Message-ID fails", async () => {
    const google = fakeGoogle({ metadataReply: () => new Response("backend error", { status: 500 }) });

    const result = await (
      await transportFor(google)
    ).send({ raw: RAW_MESSAGE, envelope: { from: "me@gmail.test", recipients: ["bob@gmail.test"] } });

    expect(result).toEqual({ providerMessageId: "gmail-sent-1", providerThreadId: "gmail-thread-1" });
    expect(google.sends).toHaveLength(1);
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
    expect(result).toMatchObject({ providerMessageId: "gmail-sent-2", providerThreadId: "gmail-thread-existing" });
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
    const error = await createMailTransportFactory(pool)
      .forMailbox(mailboxId, "gmail_api")
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MailTransportUnavailableError);
    expect(error).toMatchObject({
      message: expect.stringMatching(/No Gmail OAuth client is configured for this composition root/),
    });
  });
});
