import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MalformedImapFetchResponseError, parseImapFetchResponse } from "../imapFetchResponseParser.js";
import { IMAP_LIGHT_FETCH_HEADERS, lightFetchedMessageOf } from "../imapFlowClient.js";
import { IMAP_SNIPPET_BYTES } from "../imapSnippet.js";
import { MAIL_HISTORY_FETCH_ITEMS } from "../mailHistoryUpload.js";
import { FakeImapServer } from "../../testSupport/fakeImapServer.js";
import { RawImapHistoryClient } from "../../testSupport/rawImapHistoryClient.js";

const CRLF = "\r\n";

const MESSAGES = {
  plain: [
    "Message-ID: <plain@sender.example.test>",
    "From: Sender <sender@sender.example.test>",
    "To: owner@example.test",
    "Subject: Plain one",
    "Date: Tue, 01 Mar 2022 10:00:00 GMT",
    "References: <a@sender.example.test> <b@sender.example.test>",
    "List-Id: <news.sender.example.test>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "Plain body",
    "",
  ].join(CRLF),
  html: [
    "Message-ID: <html@sender.example.test>",
    "From: sender@sender.example.test",
    "To: owner@example.test",
    "Subject: Html one",
    "Date: Tue, 01 Mar 2022 11:00:00 GMT",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<p>Html <b>body</b></p>",
    "",
  ].join(CRLF),
  attachment: [
    "Message-ID: <attachment@sender.example.test>",
    "From: Sender <sender@sender.example.test>",
    "To: owner@example.test",
    "Subject: With attachment",
    "Date: Tue, 01 Mar 2022 12:00:00 GMT",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="part-boundary"',
    "",
    "--part-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    `Dobr=C3=BD den. ${"Lorem ipsum dolor sit amet. ".repeat(100)}`,
    "--part-boundary",
    'Content-Type: application/pdf; name="report.pdf"',
    'Content-Disposition: attachment; filename="report.pdf"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(`%PDF-1.4 ${"x".repeat(300)}`).toString("base64"),
    "--part-boundary--",
    "",
  ].join(CRLF),
};

let server: FakeImapServer;
let port: number;
const uids = new Map<keyof typeof MESSAGES, number>();

/** The same message as `ImapFlow.fetch()` yields it for the data items of the upload contract. */
async function fetchedByImapflow(uid: number): Promise<FetchMessageObject> {
  const flow = new ImapFlow({
    host: "127.0.0.1",
    port,
    secure: false,
    auth: { user: "owner@example.test", pass: "app-password" },
    logger: false,
  });
  flow.on("error", () => {});
  await flow.connect();
  try {
    await flow.mailboxOpen("INBOX");
    const fetched = await flow.fetchOne(
      String(uid),
      {
        uid: true,
        flags: true,
        envelope: true,
        bodyStructure: true,
        headers: [...IMAP_LIGHT_FETCH_HEADERS],
        bodyParts: [{ key: "text", start: 0, maxLength: IMAP_SNIPPET_BYTES }],
      },
      { uid: true },
    );
    if (fetched === false) throw new Error("imapflow fetched nothing");
    return fetched;
  } finally {
    await flow.logout();
  }
}

async function rawResponse(uid: number): Promise<Buffer> {
  const client = await RawImapHistoryClient.connect(port);
  try {
    await client.select("INBOX");
    const raw = (await client.fetchHistory([uid])).get(uid);
    if (!raw) throw new Error("The server sent no FETCH response");
    return raw;
  } finally {
    await client.close();
  }
}

describe("parseImapFetchResponse over imapflow 1.7.6's own response parser", () => {
  beforeAll(async () => {
    server = new FakeImapServer({
      folders: [{ path: "INBOX", specialUse: "\\Inbox" }],
      capabilities: [],
      latencyMs: 0,
    });
    port = await server.listen();
    uids.set("plain", server.deliver("INBOX", ["\\Seen", "\\Flagged"], Buffer.from(MESSAGES.plain)));
    uids.set("html", server.deliver("INBOX", [], Buffer.from(MESSAGES.html)));
    uids.set("attachment", server.deliver("INBOX", ["\\Seen"], Buffer.from(MESSAGES.attachment)));
  });

  afterAll(async () => {
    await server.close();
  });

  it.each(Object.keys(MESSAGES) as Array<keyof typeof MESSAGES>)(
    "reads the %s message's raw response exactly as ImapFlow.fetch() reads the server",
    async (name) => {
      const uid = uids.get(name) ?? 0;
      const [parsed, library] = await Promise.all([
        parseImapFetchResponse(await rawResponse(uid)),
        fetchedByImapflow(uid),
      ]);

      expect(lightFetchedMessageOf(parsed.message)).toEqual(lightFetchedMessageOf(library));
      expect(parsed.message.envelope).toEqual(library.envelope);
      expect(parsed.message.flags).toEqual(library.flags);
      expect(parsed.message.headers).toEqual(library.headers);
      expect(parsed.hasHeaderFields).toBe(true);
      expect(parsed.sections.get("text")).toEqual(library.bodyParts?.get("text"));
    },
  );

  it.each([
    { name: "a status response", bytes: "* OK [UIDNEXT 5] next\r\n" },
    { name: "a tagged response", bytes: "h1 OK done\r\n" },
    { name: "two responses", bytes: "* 1 FETCH (UID 1 FLAGS ())\r\n* 2 FETCH (UID 2 FLAGS ())\r\n" },
    { name: "a literal cut short", bytes: "* 1 FETCH (UID 1 BODY[TEXT] {10}\r\nabc" },
    { name: "an unclosed list", bytes: "* 1 FETCH (UID 1 FLAGS (\\Seen)\r\n" },
    { name: "lists nested too deep", bytes: `* 1 FETCH (UID 1 FLAGS ${"(".repeat(40)}${")".repeat(40)})\r\n` },
    { name: "no UID", bytes: "* 1 FETCH (FLAGS ())\r\n" },
  ])("refuses $name as malformed", async ({ bytes }) => {
    await expect(parseImapFetchResponse(Buffer.from(bytes, "latin1"))).rejects.toBeInstanceOf(
      MalformedImapFetchResponseError,
    );
  });

  it("accepts a response without its closing line break", async () => {
    const parsed = await parseImapFetchResponse(Buffer.from("* 3 FETCH (UID 7 FLAGS (\\Seen))", "latin1"));
    expect(parsed.message).toMatchObject({ uid: 7, flags: new Set(["\\Seen"]) });
  });

  it("is the data item list the architecture document gives native clients", async () => {
    const doc = await readFile(
      fileURLToPath(new URL("../../../../../../docs/architecture/domain-mail-and-inbox.md", import.meta.url)),
      "utf8",
    );
    expect(doc.includes(MAIL_HISTORY_FETCH_ITEMS)).toBe(true);
  });
});
