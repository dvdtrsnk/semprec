import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it as vitestIt, vi } from "vitest";
import type { Pool } from "pg";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import { ingestEmailMessage } from "../mail/ingest.js";
import { upsertMailMessageMeta } from "../mail/mailMessageMetaStore.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { seedSystem } from "../seed/seedSystem.js";
import { GRAPH_SEND_MAIL_MAX_RAW_BYTES } from "../mail/graphRestClient.js";
import { GRAPH_SEND_PURPOSE } from "../mail/graphTransport.js";
import { logger } from "../mail/logger.js";
import { writeMailboxAddresses } from "../mail/mailboxAddresses.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { createMailTransportFactory } from "../mail/mailTransport.js";
import { MailReauthorizationRequiredError, MailRecipientRejectedError } from "../mail/providerTypes.js";
import { getTestPool, inTenantZero, resetDatabase } from "../testSupport/testDb.js";

// A fake Microsoft answers the token endpoint, Graph and the upload URLs through the `fetchImpl` seam. The token endpoint
// accepts only the refresh token it currently holds and rotates it on every refresh, as Microsoft does, so a refresh that
// presents a retired token is refused.

const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0/me";
const UPLOAD_HOST = "https://upload.graph.test";
const CLIENT_ID = "graph-test-client.example";
const CLIENT_SECRET = "graph-test-client-secret-value";
const STORED_REFRESH_TOKEN = "1.stored-refresh-token-for-graph-send";
const DRAFT_ID = "draft-1";
const ONE_MIB = 1024 * 1024;

type Route = "sendMail" | "createDraft" | "createUploadSession" | "sendDraft" | "deleteDraft";

interface GraphCall {
  route: Route;
  authorization: string | undefined;
  /** The request body as text: base64 MIME for sendMail, JSON for the other routes. */
  text: string;
}

interface UploadCall {
  uploadUrl: string;
  authorization: string | undefined;
  contentRange: string | undefined;
  bytes: Buffer;
}

interface FakeMicrosoftOptions {
  /** Makes the token endpoint refuse every refresh, the way a revoked refresh token is refused. */
  tokenRefused?: boolean;
  /** Replaces the reply of one Graph route. */
  replies?: Partial<Record<Route, () => Response>>;
}

function routeOf(method: string, path: string): Route | undefined {
  if (method === "POST" && path === "/sendMail") return "sendMail";
  if (method === "POST" && path === "/messages") return "createDraft";
  if (method === "POST" && /^\/messages\/[^/]+\/attachments\/createUploadSession$/.test(path)) {
    return "createUploadSession";
  }
  if (method === "POST" && /^\/messages\/[^/]+\/send$/.test(path)) return "sendDraft";
  if (method === "DELETE" && /^\/messages\/[^/]+$/.test(path)) return "deleteDraft";
  return undefined;
}

function requestTarget(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** True for the chunk whose last byte is the attachment's last byte. */
function isFinalChunk(contentRange: string | undefined): boolean {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange ?? "");
  if (!match) throw new Error(`upload chunk has no usable Content-Range: ${contentRange}`);
  return Number(match[2]) + 1 === Number(match[3]);
}

function fakeMicrosoft(options: FakeMicrosoftOptions = {}) {
  const refreshesPresented: string[] = [];
  const calls: GraphCall[] = [];
  const uploads: UploadCall[] = [];
  let currentRefreshToken = STORED_REFRESH_TOKEN;
  let rotations = 0;
  let sessions = 0;

  function replyFor(route: Route): Response {
    const override = options.replies?.[route];
    if (override) return override();
    switch (route) {
      case "sendMail":
        return new Response(null, { status: 202 });
      case "createDraft":
        return Response.json({ id: DRAFT_ID }, { status: 201 });
      case "createUploadSession":
        sessions += 1;
        return Response.json({ uploadUrl: `${UPLOAD_HOST}/session-${sessions}` }, { status: 201 });
      case "sendDraft":
        return new Response(null, { status: 202 });
      case "deleteDraft":
        return new Response(null, { status: 204 });
    }
  }

  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const target = requestTarget(input);
    if (target === TOKEN_URL) {
      const presented = init?.body instanceof URLSearchParams ? (init.body.get("refresh_token") ?? "") : "";
      refreshesPresented.push(presented);
      if (options.tokenRefused || presented !== currentRefreshToken) {
        return new Response("invalid_grant", { status: 400 });
      }
      rotations += 1;
      currentRefreshToken = `1.rotated-refresh-token-${rotations}`;
      return Response.json({
        access_token: `eyJ-access-token-${rotations}`,
        expires_in: 3600,
        refresh_token: currentRefreshToken,
      });
    }
    const headers = new Headers(init?.headers);
    const authorization = headers.get("Authorization") ?? undefined;
    if (target.startsWith(`${UPLOAD_HOST}/`)) {
      const body = init?.body;
      if (!(body instanceof Uint8Array)) throw new Error("an upload chunk must carry bytes");
      const contentRange = headers.get("Content-Range") ?? undefined;
      uploads.push({ uploadUrl: target, authorization, contentRange, bytes: Buffer.from(body) });
      return new Response(null, { status: isFinalChunk(contentRange) ? 201 : 202 });
    }
    if (!target.startsWith(`${GRAPH_BASE}/`)) throw new Error(`unexpected request to ${target}`);
    const method = init?.method ?? "GET";
    const route = routeOf(method, target.slice(GRAPH_BASE.length));
    if (!route) throw new Error(`unexpected Graph request ${method} ${target}`);
    calls.push({ route, authorization, text: typeof init?.body === "string" ? init.body : "" });
    return replyFor(route);
  });

  return { fetchImpl, refreshesPresented, calls, uploads };
}

type FakeMicrosoft = ReturnType<typeof fakeMicrosoft>;

/** The only call of a route; fails when the route was called another number of times. */
function onlyCallOf(calls: GraphCall[], route: Route): GraphCall {
  const [first, ...rest] = calls.filter((call) => call.route === route);
  if (!first || rest.length > 0) throw new Error(`expected exactly one ${route} call`);
  return first;
}

function routesOf(calls: GraphCall[]): Route[] {
  return calls.map((call) => call.route);
}

function patternedBytes(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) bytes[i] = i % 251;
  return bytes;
}

interface MimeAttachment {
  /** `false` leaves the attachment without a file name. */
  filename?: string | false;
  content: Buffer;
  cid?: string;
  inline?: boolean;
}

interface MimeOptions {
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  cc?: string[];
  text?: string;
  html?: string;
  attachments?: MimeAttachment[];
}

/**
 * Builds a message with nodemailer's composer, the library `buildOutgoingMime` uses. It carries no Bcc header, as the
 * production MIME does not. The subject is set unless the caller names the key with no value.
 */
async function composeMime(options: MimeOptions & { subject?: string }): Promise<Buffer> {
  const subject = "subject" in options ? options.subject : "Graph send";
  const composer = new MailComposer({
    from: "sender@graph.test",
    to: ["bob@graph.test"],
    cc: options.cc,
    subject,
    text: options.text,
    html: options.html,
    messageId: options.messageId,
    inReplyTo: options.inReplyTo,
    references: options.references,
    attachments: (options.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      cid: attachment.cid,
      contentDisposition: attachment.inline ? "inline" : "attachment",
    })),
  });
  return new Promise<Buffer>((resolve, reject) => {
    composer.compile().build((error, message) => (error ? reject(error) : resolve(message)));
  });
}

/** A message over the sendMail limit. Its 3 MB text body takes the draft path, whatever its attachments. */
async function largeMime(attachments: MimeAttachment[] = []): Promise<Buffer> {
  const raw = await composeMime({
    messageId: "<large-fail-1@graph.test>",
    text: "x".repeat(GRAPH_SEND_MAIL_MAX_RAW_BYTES),
    attachments,
  });
  expect(raw.byteLength).toBeGreaterThan(GRAPH_SEND_MAIL_MAX_RAW_BYTES);
  return raw;
}

/** A plain-text message of exactly `bytes` bytes, built by hand so its size is exact. `messageIdLine` null omits the header. */
function textMessageOfSize(bytes: number, messageIdLine: string | null): Buffer {
  const headers = [
    "From: sender@graph.test",
    "To: bob@graph.test",
    "Subject: Boundary",
    ...(messageIdLine ? [messageIdLine] : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "",
  ].join("\r\n");
  return Buffer.concat([Buffer.from(headers), Buffer.alloc(bytes - headers.length, "x")]);
}

const it = (name: string, fn: () => Promise<void>) => vitestIt(name, () => inTenantZero(fn));

describe("Graph mail transport (issue #1753)", () => {
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
      // `addresses` is system-owned, so it is written through the sanctioned writer rather than in the item create.
      mailboxId = await withTransaction(pool, async (client) => {
        const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
        const mailbox = await createItemWithClient(client, {
          databaseId: mailboxesDatabaseId,
          properties: { name: "Outlook", provider: "outlook" },
        });
        await writeMailboxAddresses(client, {
          mailboxesDatabaseId,
          mailboxItemId: mailbox.id,
          address: "me@graph.test",
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

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool.end();
  });

  async function transportFor(microsoft: FakeMicrosoft) {
    return createMailTransportFactory(pool, {
      graphOAuthClient: oauthClient,
      fetchImpl: microsoft.fetchImpl,
    }).forMailbox(mailboxId, "graph_api");
  }

  it("sends a message at the sendMail limit as its MIME, base64 encoded, and keeps its Message-ID", async () => {
    const microsoft = fakeMicrosoft();
    const raw = textMessageOfSize(GRAPH_SEND_MAIL_MAX_RAW_BYTES, "Message-ID: <boundary-1@graph.test>");

    const result = await (
      await transportFor(microsoft)
    ).send({ raw, envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] } });

    expect(result).toEqual({});
    expect(routesOf(microsoft.calls)).toEqual(["sendMail"]);
    const sendMail = onlyCallOf(microsoft.calls, "sendMail");
    expect(sendMail.authorization).toBe("Bearer eyJ-access-token-1");
    expect(Buffer.from(sendMail.text, "base64")).toEqual(raw);
    expect(Buffer.from(sendMail.text, "base64").toString("utf8")).toContain("Message-ID: <boundary-1@graph.test>");
    expect(microsoft.refreshesPresented).toEqual([STORED_REFRESH_TOKEN]);
  });

  it("takes the draft path one byte above the sendMail limit, with no sendMail call", async () => {
    const microsoft = fakeMicrosoft();
    const raw = textMessageOfSize(GRAPH_SEND_MAIL_MAX_RAW_BYTES + 1, "Message-ID: <boundary-2@graph.test>");

    await (
      await transportFor(microsoft)
    ).send({ raw, envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] } });

    expect(routesOf(microsoft.calls)).toEqual(["createDraft", "sendDraft"]);
    expect(JSON.parse(onlyCallOf(microsoft.calls, "createDraft").text)).toMatchObject({
      subject: "Boundary",
      internetMessageId: "<boundary-2@graph.test>",
      internetMessageHeaders: [],
    });
  });

  it("deduplicates later synced copies using the Message-ID from both Graph send paths", async () => {
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
    const microsoft = fakeMicrosoft();
    for (const [size, id] of [
      [1000, "<graph-small@x>"],
      [GRAPH_SEND_MAIL_MAX_RAW_BYTES + 1, "<graph-large@x>"],
    ] as const) {
      const raw = textMessageOfSize(size, `Message-ID: ${id}`);
      await (
        await transportFor(microsoft)
      ).send({ raw, envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] } });
      const sentId =
        size <= GRAPH_SEND_MAIL_MAX_RAW_BYTES
          ? /^Message-ID: (.+)$/im
              .exec(Buffer.from(onlyCallOf(microsoft.calls, "sendMail").text, "base64").toString("utf8"))?.[1]
              ?.trim()
          : (() => {
              const payload: unknown = JSON.parse(onlyCallOf(microsoft.calls, "createDraft").text);
              if (typeof payload !== "object" || payload === null || !("internetMessageId" in payload))
                return undefined;
              return typeof payload.internetMessageId === "string" ? payload.internetMessageId : undefined;
            })();
      expect(sentId).toBe(id);
      if (!sentId) throw new Error("Missing sent Message-ID");
      const result = await withTransaction(pool, async (client) => {
        const ids = await resolveMailModuleIds(client);
        const folderProperty = await getPropertyByKey(client, ids.emailsDatabaseId, "folder");
        const attachmentProperty = await getPropertyByKey(client, ids.emailsDatabaseId, "attachments");
        if (!folderProperty || !attachmentProperty) throw new Error("Missing Email relation properties");
        const item = await createItemWithClient(client, { databaseId: ids.emailsDatabaseId, properties: {} });
        const folder = await createItemWithClient(
          client,
          {
            databaseId: ids.foldersDatabaseId,
            properties: { name: "Sent", behavior: "folder", providerId: `sent-${size}` },
          },
          { allowedSystemKeys: ["name", "behavior", "providerId"] },
        );
        await upsertMailMessageMeta(client, {
          itemId: item.id,
          mailboxItemId: mailboxId,
          messageId: sentId,
          envelope: {},
        });
        const ingested = await ingestEmailMessage(client, {
          emailsDatabaseId: ids.emailsDatabaseId,
          filesDatabaseId: ids.filesDatabaseId,
          folderRelationPropertyId: folderProperty.id,
          attachmentsRelationPropertyId: attachmentProperty.id,
          folderItemId: folder.id,
          mailboxItemId: mailboxId,
          messageId: sentId,
          envelope: {},
          attachments: [],
          storage,
          storageKeyPrefix: "test",
        });
        return { itemId: item.id, ingested };
      });
      expect(result.ingested).toEqual({ itemId: result.itemId, created: false });
    }
  });

  it("keeps the Message-ID and the reply headers in a large reply, uploads its attachments in chunks and sends the draft", async () => {
    const report = patternedBytes(6 * ONE_MIB);
    const logo = Buffer.from([1, 2, 3]);
    const raw = await composeMime({
      messageId: "<large-1@graph.test>",
      inReplyTo: "<parent-1@graph.test>",
      references: ["<root-0@graph.test>", "<parent-1@graph.test>"],
      cc: ["carol@graph.test"],
      text: "Plain body.",
      html: '<p>See <img src="cid:logo@graph.test"></p>',
      attachments: [
        { filename: "logo.png", content: logo, cid: "logo@graph.test", inline: true },
        { filename: "report.bin", content: report },
      ],
    });
    expect(raw.toString("utf8")).toContain("Message-ID: <large-1@graph.test>");
    const microsoft = fakeMicrosoft();

    const result = await (
      await transportFor(microsoft)
    ).send({
      raw,
      envelope: { from: "sender@graph.test", recipients: ["bob@graph.test", "carol@graph.test", "dana@graph.test"] },
    });

    expect(result).toEqual({});
    expect(routesOf(microsoft.calls)).toEqual([
      "createDraft",
      "createUploadSession",
      "createUploadSession",
      "sendDraft",
    ]);
    // The envelope names dana, who is in neither To nor Cc, so dana is the bcc recipient.
    expect(JSON.parse(onlyCallOf(microsoft.calls, "createDraft").text)).toEqual({
      subject: "Graph send",
      body: { contentType: "html", content: '<p>See <img src="cid:logo@graph.test"></p>' },
      toRecipients: [{ emailAddress: { address: "bob@graph.test" } }],
      ccRecipients: [{ emailAddress: { address: "carol@graph.test" } }],
      bccRecipients: [{ emailAddress: { address: "dana@graph.test" } }],
      internetMessageId: "<large-1@graph.test>",
      internetMessageHeaders: [
        { name: "In-Reply-To", value: "<parent-1@graph.test>" },
        { name: "References", value: "<root-0@graph.test> <parent-1@graph.test>" },
      ],
    });
    expect(JSON.parse(microsoft.calls.filter((call) => call.route === "createUploadSession")[0]?.text ?? "")).toEqual({
      AttachmentItem: {
        attachmentType: "file",
        name: "logo.png",
        size: 3,
        isInline: true,
        contentType: "image/png",
        contentId: "logo@graph.test",
      },
    });
    expect(JSON.parse(microsoft.calls.filter((call) => call.route === "createUploadSession")[1]?.text ?? "")).toEqual({
      AttachmentItem: {
        attachmentType: "file",
        name: "report.bin",
        size: 6 * ONE_MIB,
        isInline: false,
        contentType: "application/octet-stream",
      },
    });
    // Each upload goes to its own session in order. The 6 MiB report is cut into a 5 MiB chunk and a 1 MiB chunk.
    expect(microsoft.uploads.map((upload) => upload.uploadUrl)).toEqual([
      `${UPLOAD_HOST}/session-1`,
      `${UPLOAD_HOST}/session-2`,
      `${UPLOAD_HOST}/session-2`,
    ]);
    expect(microsoft.uploads.map((upload) => upload.contentRange)).toEqual([
      "bytes 0-2/3",
      "bytes 0-5242879/6291456",
      "bytes 5242880-6291455/6291456",
    ]);
    expect(microsoft.uploads[0]?.bytes).toEqual(logo);
    expect(Buffer.concat(microsoft.uploads.slice(1).map((upload) => upload.bytes))).toEqual(report);
    // An upload URL is pre-authenticated, so no bearer token reaches it.
    expect(microsoft.uploads.map((upload) => upload.authorization)).toEqual([undefined, undefined, undefined]);
    // Each Graph request presents the token that the previous refresh stored, so every rotation is kept.
    expect(microsoft.refreshesPresented).toEqual([
      STORED_REFRESH_TOKEN,
      "1.rotated-refresh-token-1",
      "1.rotated-refresh-token-2",
      "1.rotated-refresh-token-3",
    ]);
  });

  it("names a nameless attachment attachment, and sends an attachments-only message with an empty text body", async () => {
    const raw = await composeMime({
      messageId: "<nameless-1@graph.test>",
      subject: undefined,
      attachments: [{ filename: false, content: patternedBytes(6 * ONE_MIB) }],
    });
    const microsoft = fakeMicrosoft();

    await (
      await transportFor(microsoft)
    ).send({ raw, envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] } });

    expect(JSON.parse(onlyCallOf(microsoft.calls, "createDraft").text)).toMatchObject({
      subject: "",
      body: { contentType: "text", content: "" },
      internetMessageId: "<nameless-1@graph.test>",
    });
    expect(JSON.parse(onlyCallOf(microsoft.calls, "createUploadSession").text)).toMatchObject({
      AttachmentItem: { name: "attachment" },
    });
  });

  it("records each token refresh under graph_api_send, not the sync purpose", async () => {
    const microsoft = fakeMicrosoft();

    await (
      await transportFor(microsoft)
    ).send({
      raw: textMessageOfSize(GRAPH_SEND_MAIL_MAX_RAW_BYTES, "Message-ID: <boundary-3@graph.test>"),
      envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] },
    });

    const { rows } = await pool.query<{ purpose: string }>(
      `SELECT purpose FROM credential_access_log WHERE item_id = $1`,
      [mailboxId],
    );
    expect(rows.map((row) => row.purpose)).toEqual([GRAPH_SEND_PURPOSE]);
  });

  it("throws MailReauthorizationRequiredError when the token is revoked, and sends nothing", async () => {
    const microsoft = fakeMicrosoft({ tokenRefused: true });

    const error = await (
      await transportFor(microsoft)
    )
      .send({
        raw: textMessageOfSize(GRAPH_SEND_MAIL_MAX_RAW_BYTES, "Message-ID: <boundary-4@graph.test>"),
        envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailReauthorizationRequiredError);
    expect(error instanceof Error ? error.message : "").not.toContain(STORED_REFRESH_TOKEN);
    expect(microsoft.calls).toEqual([]);
  });

  it("throws MailReauthorizationRequiredError when Graph rejects the access token on sendMail", async () => {
    const microsoft = fakeMicrosoft({
      replies: {
        sendMail: () => Response.json({ error: { code: "InvalidAuthenticationToken" } }, { status: 401 }),
      },
    });

    const error = await (
      await transportFor(microsoft)
    )
      .send({
        raw: textMessageOfSize(GRAPH_SEND_MAIL_MAX_RAW_BYTES, "Message-ID: <boundary-5@graph.test>"),
        envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailReauthorizationRequiredError);
    expect(error instanceof Error ? error.message : "").not.toContain("eyJ-access-token");
  });

  it("throws MailRecipientRejectedError when Graph refuses a recipient, without naming the address", async () => {
    const microsoft = fakeMicrosoft({
      replies: {
        sendMail: () =>
          Response.json(
            { error: { code: "ErrorInvalidRecipients", message: "Invalid recipient nobody@graph.test" } },
            { status: 400 },
          ),
      },
    });

    const error = await (
      await transportFor(microsoft)
    )
      .send({
        raw: textMessageOfSize(GRAPH_SEND_MAIL_MAX_RAW_BYTES, "Message-ID: <boundary-6@graph.test>"),
        envelope: { from: "sender@graph.test", recipients: ["nobody@graph.test"] },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailRecipientRejectedError);
    expect(error instanceof Error ? error.message : "").not.toContain("nobody@graph.test");
  });

  it("leaves any other Graph failure as an ordinary error, neither reauthorization nor recipient", async () => {
    const microsoft = fakeMicrosoft({
      replies: { sendMail: () => new Response("unavailable", { status: 503 }) },
    });

    const error = await (
      await transportFor(microsoft)
    )
      .send({
        raw: textMessageOfSize(GRAPH_SEND_MAIL_MAX_RAW_BYTES, "Message-ID: <boundary-7@graph.test>"),
        envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(MailReauthorizationRequiredError);
    expect(error).not.toBeInstanceOf(MailRecipientRejectedError);
    expect(error instanceof Error ? error.message : "").toBe("Microsoft Graph request failed with status 503");
  });

  it("deletes the draft when an upload fails after the draft was created, and raises the upload's error", async () => {
    const microsoft = fakeMicrosoft({
      replies: { createUploadSession: () => new Response("unavailable", { status: 500 }) },
    });

    const error = await (
      await transportFor(microsoft)
    )
      .send({
        raw: await largeMime([{ filename: "a.txt", content: Buffer.from("attached") }]),
        envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] },
      })
      .catch((e: unknown) => e);

    expect(error instanceof Error ? error.message : "").toBe("Microsoft Graph request failed with status 500");
    expect(routesOf(microsoft.calls)).toEqual(["createDraft", "createUploadSession", "deleteDraft"]);
    expect(onlyCallOf(microsoft.calls, "deleteDraft").text).toBe("");
  });

  it("keeps the upload error and reports only a closed cleanup stage when draft deletion fails", async () => {
    const warn = vi.spyOn(logger, "warn");
    const microsoft = fakeMicrosoft({
      replies: {
        createUploadSession: () => new Response("unavailable", { status: 503 }),
        deleteDraft: () => new Response("unavailable", { status: 500 }),
      },
    });

    const error = await (
      await transportFor(microsoft)
    )
      .send({
        raw: await largeMime([{ filename: "a.txt", content: Buffer.from("attached") }]),
        envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] },
      })
      .catch((e: unknown) => e);

    expect(error instanceof Error ? error.message : "").toBe("Microsoft Graph request failed with status 503");
    expect(warn).toHaveBeenCalledWith({ stage: "graph-draft-delete" }, "Mail send cleanup failed");
  });

  it("confines an unknown upload failure while attempting draft deletion even if diagnostics fail", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {
      throw new Error("PRIVATE-DIAGNOSTIC");
    });
    const microsoft = fakeMicrosoft({ replies: { deleteDraft: () => new Response("failure", { status: 500 }) } });
    const original = microsoft.fetchImpl.getMockImplementation();
    if (!original) throw new Error("Missing fake provider implementation");
    microsoft.fetchImpl.mockImplementation(async (input, init) => {
      if (requestTarget(input).startsWith(UPLOAD_HOST))
        // Provider boundaries can reject with non-Error values.
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        return Promise.reject({ name: "PRIVATE-NAME", url: "PRIVATE-UPLOAD-URL" });
      return original(input, init);
    });
    const transport = await transportFor(microsoft);
    const error: unknown = await transport
      .send({
        raw: await largeMime([{ filename: "a.txt", content: Buffer.from("attached") }]),
        envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] },
      })
      .then(
        () => null,
        (value: unknown) => value,
      );
    expect(error).toMatchObject({ message: "Mail send provider operation failed" });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain("PRIVATE");
    expect(routesOf(microsoft.calls)).toEqual(["createDraft", "createUploadSession", "deleteDraft"]);
    expect(warn).toHaveBeenCalledWith({ stage: "graph-draft-delete" }, "Mail send cleanup failed");
  });

  it("keeps a Graph-accepted draft send when response cleanup and its diagnostic fail", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {
      throw new Error("PRIVATE-DIAGNOSTIC");
    });
    const microsoft = fakeMicrosoft({
      replies: {
        sendDraft: () =>
          new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                throw new Error("PRIVATE-CLEANUP");
              },
            }),
            { status: 202 },
          ),
      },
    });
    const transport = await transportFor(microsoft);
    await expect(
      transport.send({
        raw: await largeMime([{ filename: "a.txt", content: Buffer.from("attached") }]),
        envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] },
      }),
    ).resolves.toEqual({});
    expect(routesOf(microsoft.calls)).toEqual(["createDraft", "createUploadSession", "sendDraft"]);
    expect(warn).toHaveBeenCalledWith({ stage: "graph-send-response" }, "Mail send cleanup failed");
  });

  it("deletes the draft and reports MailRecipientRejectedError when Graph refuses a recipient at send", async () => {
    const microsoft = fakeMicrosoft({
      replies: {
        sendDraft: () => Response.json({ error: { code: "ErrorInvalidRecipients" } }, { status: 400 }),
      },
    });

    const error = await (
      await transportFor(microsoft)
    )
      .send({
        raw: await largeMime([{ filename: "a.txt", content: Buffer.from("attached") }]),
        envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailRecipientRejectedError);
    expect(routesOf(microsoft.calls)).toEqual(["createDraft", "createUploadSession", "sendDraft", "deleteDraft"]);
  });

  it("creates no draft to delete when Graph refuses the draft itself", async () => {
    const microsoft = fakeMicrosoft({
      replies: {
        createDraft: () => Response.json({ error: { code: "ErrorInvalidRecipients" } }, { status: 400 }),
      },
    });

    const error = await (
      await transportFor(microsoft)
    )
      .send({
        raw: await largeMime(),
        envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] },
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MailRecipientRejectedError);
    expect(routesOf(microsoft.calls)).toEqual(["createDraft"]);
  });

  it("refuses a large message with no Message-ID before creating a draft", async () => {
    const microsoft = fakeMicrosoft();

    const error = await (
      await transportFor(microsoft)
    )
      .send({
        raw: textMessageOfSize(GRAPH_SEND_MAIL_MAX_RAW_BYTES + 1, null),
        envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] },
      })
      .catch((e: unknown) => e);

    expect(error instanceof Error ? error.message : "").toBe("The outgoing message has no Message-ID to keep");
    expect(microsoft.calls).toEqual([]);
  });

  it("refuses a large message with an empty attachment before creating a draft", async () => {
    const microsoft = fakeMicrosoft();

    const error = await (
      await transportFor(microsoft)
    )
      .send({
        raw: await largeMime([{ filename: "empty.txt", content: Buffer.alloc(0) }]),
        envelope: { from: "sender@graph.test", recipients: ["bob@graph.test"] },
      })
      .catch((e: unknown) => e);

    expect(error instanceof Error ? error.message : "").toMatch(/is empty and cannot be uploaded/);
    expect(microsoft.calls).toEqual([]);
  });

  it("refuses a graph_api mailbox when no Microsoft Graph OAuth client is configured, before reading anything", async () => {
    await expect(createMailTransportFactory(pool).forMailbox(mailboxId, "graph_api")).rejects.toThrow(
      /No Microsoft Graph OAuth client is configured for this composition root/,
    );
  });
});
