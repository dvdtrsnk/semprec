import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import dns from "node:dns";
import { createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ValidationError } from "../errors.js";
import { storeCredential } from "../credentials/externalCredentialsStore.js";
import { withTransaction } from "../db/pool.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { seedSystem } from "../seed/seedSystem.js";
import { getPropertyByKey } from "../chokePoint/propertiesStore.js";
import {
  createMailTransportFactory,
  createSentCopySaver,
  createSmtpMailTransport,
  type ImapConnectionOpener,
  type SmtpTransporterOpener,
} from "../mail/mailTransport.js";
import { ensureFolderItem } from "../mail/folderDiscovery.js";
import type { ImapConnectionLimiter } from "../mail/imapConnectionLimiter.js";
import type { ImapMailClient } from "../mail/imapReconcile.js";
import type { SyncMode } from "../mail/mailAccountSyncStateStore.js";
import { resolveMailModuleIds } from "../mail/mailModuleIds.js";
import { logger } from "../mail/logger.js";
import {
  createSmtpTransporter,
  type MailServerConnectionSettings,
  type MailServerCredential,
  type MailSmtpTransporter,
} from "../mail/mailServerConnections.js";
import type { MailServerEndpoint } from "../mail/mailServerSettingsStore.js";
import { upsertMailServerSettings } from "../mail/mailServerSettingsStore.js";
import { NodemailerSmtpClient } from "../mail/smtpClient.js";
import {
  MailRecipientRejectedError,
  MailSendAuthFailedError,
  MailServerUnreachableError,
} from "../mail/providerTypes.js";
import { allowLoopbackOutboundForTests } from "../net/outboundAddressPolicy.js";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { stubDnsLookup, type DnsLookupStub } from "../testSupport/dnsLookupStub.js";

// The fake SMTP server speaks implicit TLS on loopback, and its certificate is made with the openssl CLI at
// test time, so nothing sensitive is committed. The client trusts it by wrapping `tls.connect` for one test.
// The stored settings accept only the standard ports, so the transport is built directly with a loopback
// endpoint; the factory's own reads are tested against the database below.

interface TestCertificate {
  readonly key: string;
  readonly cert: string;
}

const username = "mailbox@mail.test";
const password = "app-password";
const credential: MailServerCredential = { password };
const mailboxItemId = "mailbox-under-test";

let mailCertificate: TestCertificate;

beforeAll(() => {
  mailCertificate = makeCertificate("mail.test");
});

function makeCertificate(commonName: string): TestCertificate {
  const dir = mkdtempSync(join(tmpdir(), "smtp-transport-"));
  try {
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        `/CN=${commonName}`,
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Makes `tls.connect` trust the test certificate for the connections of this test. */
function trustMailCertificate(): void {
  const connect = tls.connect;
  vi.spyOn(tls, "connect").mockImplementation(((options: tls.ConnectionOptions, listener?: () => void) =>
    connect({ ...options, ca: [mailCertificate.cert] }, listener)) as typeof tls.connect);
}

interface AcceptedMessage {
  from: string;
  recipients: string[];
  /** The message as the server received it, with the dot-stuffing removed. */
  data: string;
}

interface FakeSmtpOptions {
  /** The only password the server accepts for `username`; any other gets 535. */
  acceptedPassword?: string;
  /** Recipients the server refuses on RCPT TO. */
  refuseRecipients?: readonly string[];
  /** The reply to a refused recipient. */
  recipientRefusal?: string;
  /** Refuses the sender on MAIL FROM with a 550. */
  refuseSender?: boolean;
  /** Greets, then answers nothing, so a send stays in flight until the client gives up. */
  silent?: boolean;
}

interface FakeSmtp {
  readonly port: number;
  /** TCP connections accepted, before any TLS handshake. */
  readonly connections: () => number;
  /** Connections the client has closed, or that the server has seen end. */
  readonly closedConnections: () => number;
  /** Messages the server accepted with DATA, in order. */
  readonly accepted: AcceptedMessage[];
  close(): Promise<void>;
}

const servers: FakeSmtp[] = [];
let stub: DnsLookupStub | undefined;
let restorePolicy: (() => void) | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  stub?.restore();
  stub = undefined;
  restorePolicy?.();
  restorePolicy = undefined;
  for (const server of servers.splice(0)) await server.close();
});

function addressIn(line: string): string {
  return line.slice(line.indexOf("<") + 1, line.indexOf(">"));
}

/** One SMTP conversation: AUTH PLAIN, MAIL FROM, RCPT TO, DATA, RSET and QUIT, with the refusals the options name. */
function smtpSession(socket: Socket, options: FakeSmtpOptions, accepted: AcceptedMessage[]): void {
  const expectedPassword = options.acceptedPassword ?? password;
  const refused = new Set(options.refuseRecipients ?? []);
  const recipientRefusal = options.recipientRefusal ?? "550 5.1.1 user unknown";
  let authenticated = false;
  let envelope: { from: string; recipients: string[] } = { from: "", recipients: [] };
  let inData = false;
  let buffer = "";

  socket.write("220 mail.test ESMTP fake\r\n");
  if (options.silent) {
    // Flowing with nothing to answer: without reading, the server never sees the client's end.
    socket.resume();
    return;
  }
  socket.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (;;) {
      if (inData) {
        const end = buffer.indexOf("\r\n.\r\n");
        if (end === -1) return;
        const body = buffer.slice(0, end + 2);
        buffer = buffer.slice(end + 5);
        inData = false;
        accepted.push({ ...envelope, data: body.replace(/\r\n\.\./g, "\r\n.") });
        envelope = { from: "", recipients: [] };
        socket.write("250 2.0.0 queued\r\n");
        continue;
      }
      const end = buffer.indexOf("\r\n");
      if (end === -1) return;
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const verb = (line.split(" ")[0] ?? "").toUpperCase();
      if (verb === "EHLO") {
        socket.write("250-mail.test\r\n250 AUTH PLAIN\r\n");
      } else if (verb === "AUTH") {
        const initial = line.split(" ")[2] ?? "";
        const [, user = "", pass = ""] = Buffer.from(initial, "base64").toString("utf8").split("\0");
        authenticated = user === username && pass === expectedPassword;
        socket.write(authenticated ? "235 2.7.0 authentication succeeded\r\n" : "535 5.7.8 authentication failed\r\n");
      } else if (verb === "MAIL") {
        if (!authenticated) {
          socket.write("530 5.7.0 authentication required\r\n");
        } else if (options.refuseSender) {
          socket.write("550 5.1.8 sender refused\r\n");
        } else {
          envelope = { from: addressIn(line), recipients: [] };
          socket.write("250 2.1.0 sender OK\r\n");
        }
      } else if (verb === "RCPT") {
        const address = addressIn(line);
        if (refused.has(address)) {
          socket.write(`${recipientRefusal}\r\n`);
        } else {
          envelope.recipients.push(address);
          socket.write("250 2.1.5 recipient OK\r\n");
        }
      } else if (verb === "DATA") {
        if (envelope.recipients.length === 0) {
          socket.write("554 5.5.1 no valid recipients\r\n");
        } else {
          inData = true;
          socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        }
      } else if (verb === "RSET") {
        envelope = { from: "", recipients: [] };
        socket.write("250 2.0.0 reset\r\n");
      } else if (verb === "QUIT") {
        socket.write("221 2.0.0 bye\r\n");
        socket.end();
        return;
      } else {
        socket.write("250 2.0.0 OK\r\n");
      }
    }
  });
}

async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const sockets = new Set<Socket>();
  const accepted: AcceptedMessage[] = [];
  let connections = 0;
  let closedConnections = 0;
  const server = tls.createServer({ key: mailCertificate.key, cert: mailCertificate.cert }, (socket) => {
    sockets.add(socket);
    // The server keeps its half open after the client's FIN, so `end` is the client closing; `close` may never come.
    let ended = false;
    const markEnded = () => {
      if (ended) return;
      ended = true;
      closedConnections += 1;
    };
    socket.on("end", markEnded);
    socket.on("close", () => {
      markEnded();
      sockets.delete(socket);
    });
    // A client that resets its connection on purpose is not a failure of the fake server.
    socket.on("error", () => undefined);
    smtpSession(socket, options, accepted);
  });
  server.on("connection", () => {
    connections += 1;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake SMTP server is not on a TCP port");
  const fake: FakeSmtp = {
    port: address.port,
    connections: () => connections,
    closedConnections: () => closedConnections,
    accepted,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
  servers.push(fake);
  return fake;
}

/** A loopback port with nothing listening on it, so a connection to it is refused. */
async function closedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("probe server is not on a TCP port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function settingsFor(host: string, port: number, security: "tls" | "starttls" = "tls"): MailServerConnectionSettings {
  return { endpoint: { host, port, security }, username };
}

function useLoopbackPolicy(): void {
  restorePolicy = allowLoopbackOutboundForTests();
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

const rawMessage = Buffer.from(
  "From: me@mail.test\r\nTo: bob@mail.test\r\nSubject: Hello\r\nMessage-ID: <one@mail.test>\r\n\r\nhi bob\r\n",
  "utf8",
);

describe("createSmtpMailTransport (issue #1634): raw submission over SMTP", () => {
  it("submits the raw message with its envelope, bcc included, and the bcc address appears in no message header", async () => {
    useLoopbackPolicy();
    trustMailCertificate();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeSmtp();
    const transport = createSmtpMailTransport(mailboxItemId, settingsFor("mail.test", server.port), credential);

    const result = await transport.send({
      raw: rawMessage,
      envelope: { from: "me@mail.test", recipients: ["bob@mail.test", "carol@mail.test"] },
    });

    expect(result).toEqual({});
    expect(server.accepted).toHaveLength(1);
    const [message] = server.accepted;
    expect(message?.from).toBe("me@mail.test");
    expect(message?.recipients).toEqual(["bob@mail.test", "carol@mail.test"]);
    expect(message?.data).toBe(rawMessage.toString("utf8"));
    expect(message?.data).not.toContain("carol");
  });

  it("maps a 535 login refusal to MailSendAuthFailedError, sends nothing, and names no password", async () => {
    useLoopbackPolicy();
    trustMailCertificate();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeSmtp({ acceptedPassword: "another-password" });
    const transport = createSmtpMailTransport(mailboxItemId, settingsFor("mail.test", server.port), credential);

    const error = await rejectionOf(
      transport.send({ raw: rawMessage, envelope: { from: "me@mail.test", recipients: ["bob@mail.test"] } }),
    );

    expect(error).toBeInstanceOf(MailSendAuthFailedError);
    expect(error).toMatchObject({ code: "mail_send_auth_failed", name: "MailSendAuthFailedError" });
    expect((error as Error).message).not.toContain(password);
    expect(server.accepted).toHaveLength(0);
  });

  it("maps a permanent refusal of every recipient on RCPT TO to MailRecipientRejectedError, sending nothing", async () => {
    useLoopbackPolicy();
    trustMailCertificate();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeSmtp({ refuseRecipients: ["bob@mail.test"] });
    const transport = createSmtpMailTransport(mailboxItemId, settingsFor("mail.test", server.port), credential);

    const error = await rejectionOf(
      transport.send({ raw: rawMessage, envelope: { from: "me@mail.test", recipients: ["bob@mail.test"] } }),
    );

    expect(error).toBeInstanceOf(MailRecipientRejectedError);
    expect(error).toMatchObject({ code: "mail_recipient_rejected" });
    expect(server.accepted).toHaveLength(0);
  });

  it("maps a message the server accepted for only some recipients to MailRecipientRejectedError", async () => {
    useLoopbackPolicy();
    trustMailCertificate();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeSmtp({ refuseRecipients: ["carol@mail.test"] });
    const transport = createSmtpMailTransport(mailboxItemId, settingsFor("mail.test", server.port), credential);

    const error = await rejectionOf(
      transport.send({
        raw: rawMessage,
        envelope: { from: "me@mail.test", recipients: ["bob@mail.test", "carol@mail.test"] },
      }),
    );

    expect(error).toBeInstanceOf(MailRecipientRejectedError);
    // The server took the message for bob, so it was sent to him: this is the documented partial outcome.
    expect(server.accepted).toHaveLength(1);
    expect(server.accepted[0]?.recipients).toEqual(["bob@mail.test"]);
  });

  it("passes a temporary recipient refusal through unchanged, because it is not a permanent refusal", async () => {
    useLoopbackPolicy();
    trustMailCertificate();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeSmtp({
      refuseRecipients: ["bob@mail.test"],
      recipientRefusal: "451 4.4.1 try again later",
    });
    const transport = createSmtpMailTransport(mailboxItemId, settingsFor("mail.test", server.port), credential);

    const error = await rejectionOf(
      transport.send({ raw: rawMessage, envelope: { from: "me@mail.test", recipients: ["bob@mail.test"] } }),
    );

    expect(error).not.toBeInstanceOf(MailRecipientRejectedError);
    expect(error).toMatchObject({ code: "EENVELOPE", command: "RCPT TO", responseCode: 451 });
  });

  it("passes a refused sender through unchanged, because the refusal is of the sender, not of a recipient", async () => {
    useLoopbackPolicy();
    trustMailCertificate();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeSmtp({ refuseSender: true });
    const transport = createSmtpMailTransport(mailboxItemId, settingsFor("mail.test", server.port), credential);

    const error = await rejectionOf(
      transport.send({ raw: rawMessage, envelope: { from: "me@mail.test", recipients: ["bob@mail.test"] } }),
    );

    expect(error).not.toBeInstanceOf(MailRecipientRejectedError);
    expect(error).toMatchObject({ code: "EENVELOPE", command: "MAIL FROM" });
    expect(server.accepted).toHaveLength(0);
  });

  it("maps a refused connection to MailServerUnreachableError", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const port = await closedPort();
    const transport = createSmtpMailTransport(mailboxItemId, settingsFor("mail.test", port), credential);

    const error = await rejectionOf(
      transport.send({ raw: rawMessage, envelope: { from: "me@mail.test", recipients: ["bob@mail.test"] } }),
    );

    expect(error).toBeInstanceOf(MailServerUnreachableError);
  });

  it("refuses a name that resolves to a loopback address under the default policy, before any TCP connection", async () => {
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeSmtp();
    const transport = createSmtpMailTransport(mailboxItemId, settingsFor("mail.test", server.port), credential);

    const error = await rejectionOf(
      transport.send({ raw: rawMessage, envelope: { from: "me@mail.test", recipients: ["bob@mail.test"] } }),
    );

    expect(error).toBeInstanceOf(MailServerUnreachableError);
    expect(server.connections()).toBe(0);
    expect(server.accepted).toHaveLength(0);
  });

  it("closes the connection of a send still in flight: the server sees it close, and the send rejects", async () => {
    useLoopbackPolicy();
    trustMailCertificate();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeSmtp({ silent: true });
    const transporter = createSmtpTransporter(settingsFor("mail.test", server.port), credential);

    // Attached now, so the rejection is handled while the test waits for the server to see the close.
    const rejected = rejectionOf(
      transporter.sendMail({ raw: rawMessage, envelope: { from: "me@mail.test", to: ["bob@mail.test"] } }),
    );
    await vi.waitFor(() => {
      expect(server.connections()).toBe(1);
    });

    transporter.close();

    await vi.waitFor(() => {
      expect(server.closedConnections()).toBe(1);
    });
    expect(await rejected).toBeInstanceOf(Error);
  });

  it("ends a send that is still connecting when close() is called, and the send rejects as unreachable", async () => {
    // The name never resolves, so the socket is still connecting when close() runs. Nothing is connected to.
    let lookups = 0;
    const original = dns.lookup;
    Object.defineProperty(dns, "lookup", {
      value: () => {
        lookups += 1;
      },
      configurable: true,
      writable: true,
    });
    try {
      const transporter = createSmtpTransporter(settingsFor("mail.test", 465), credential);

      const rejected = rejectionOf(
        transporter.sendMail({ raw: rawMessage, envelope: { from: "me@mail.test", to: ["bob@mail.test"] } }),
      );
      await vi.waitFor(() => {
        expect(lookups).toBe(1);
      });

      transporter.close();

      expect(await rejected).toBeInstanceOf(MailServerUnreachableError);
    } finally {
      Object.defineProperty(dns, "lookup", { value: original, configurable: true, writable: true });
    }
  });
});

describe("createSmtpMailTransport closes its transporter on every path out (issue #1634)", () => {
  const envelope = { from: "me@mail.test", recipients: ["bob@mail.test"] };

  it("resolves the send when closing the transporter fails, because the send itself succeeded", async () => {
    const transporter: MailSmtpTransporter = {
      verify: () => Promise.resolve(true),
      sendMail: () => Promise.resolve({ refusedRecipientCount: 0 }),
      close: () => {
        throw new Error("close failed");
      },
    };
    const transport = createSmtpMailTransport(
      mailboxItemId,
      settingsFor("mail.test", 465),
      credential,
      () => transporter,
    );

    await expect(transport.send({ raw: rawMessage, envelope })).resolves.toEqual({});
  });

  it("rejects with the send's own error, not the close failure, when both fail", async () => {
    const sendError = Object.assign(new Error("Mail server response was lost"), { code: "ESOCKET" });
    const transporter: MailSmtpTransporter = {
      verify: () => Promise.resolve(true),
      sendMail: () => Promise.reject(sendError),
      close: () => {
        throw new Error("close failed");
      },
    };
    const transport = createSmtpMailTransport(
      mailboxItemId,
      settingsFor("mail.test", 465),
      credential,
      () => transporter,
    );

    await expect(transport.send({ raw: rawMessage, envelope })).rejects.toBe(sendError);
  });

  it("closes the transporter after a successful send", async () => {
    const close = vi.fn();
    const transporter: MailSmtpTransporter = {
      verify: () => Promise.resolve(true),
      sendMail: () => Promise.resolve({ refusedRecipientCount: 0 }),
      close,
    };
    const transport = createSmtpMailTransport(
      mailboxItemId,
      settingsFor("mail.test", 465),
      credential,
      () => transporter,
    );

    await transport.send({ raw: rawMessage, envelope });

    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("NodemailerSmtpClient send deadline (issue #1634)", () => {
  it("rejects a send the server has not answered within 30 seconds with MailServerUnreachableError", async () => {
    vi.useFakeTimers();
    const transporter = { sendMail: () => new Promise<{ refusedRecipientCount: number }>(() => undefined) };
    const client = new NodemailerSmtpClient(transporter);

    let outcome: unknown = "pending";
    client.sendRaw({ raw: rawMessage, envelope: { from: "me@mail.test", recipients: ["bob@mail.test"] } }).then(
      () => {
        outcome = "resolved";
      },
      (error: unknown) => {
        outcome = error;
      },
    );

    await vi.advanceTimersByTimeAsync(29_999);
    expect(outcome).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toBeInstanceOf(MailServerUnreachableError);
  });
});

describe("createMailTransportFactory (issue #1634)", () => {
  let pool: Pool;
  let mailboxId: string;
  const smtpEndpoint: MailServerEndpoint = { host: "mail.test", port: 465, security: "tls" };

  beforeAll(() => {
    pool = getTestPool();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedSystem(pool);
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
      "mailboxes",
    ]);
    const mailboxesId = rows[0]!.id;
    mailboxId = await withTransaction(pool, (client) =>
      createItemWithClient(client, {
        databaseId: mailboxesId,
        properties: { name: "Test", provider: "generic", addresses: "me@mail.test" },
      }),
    ).then((item) => item.id);
  });

  afterAll(async () => {
    await pool.end();
  });

  it("decrypts the password for the smtp_send purpose and logs the access under that purpose", async () => {
    await upsertMailServerSettings(pool, mailboxId, { imap: null, smtp: smtpEndpoint, username });
    await storeCredential(pool, { itemId: mailboxId, credentialType: "app_password", plaintext: password });

    await createMailTransportFactory(pool).forMailbox(mailboxId, "imap");

    const { rows } = await pool.query<{ actor_type: string; purpose: string }>(
      `SELECT actor_type, purpose FROM credential_access_log WHERE item_id = $1`,
      [mailboxId],
    );
    expect(rows).toEqual([{ actor_type: "smtp_send", purpose: "smtp_send" }]);
  });

  it("a send through the factory's transport to a host the outbound policy refuses fails as unreachable", async () => {
    await upsertMailServerSettings(pool, mailboxId, { imap: null, smtp: smtpEndpoint, username });
    await storeCredential(pool, { itemId: mailboxId, credentialType: "app_password", plaintext: password });
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });

    const transport = await createMailTransportFactory(pool).forMailbox(mailboxId, "imap");
    const error = await rejectionOf(
      transport.send({ raw: rawMessage, envelope: { from: "me@mail.test", recipients: ["bob@mail.test"] } }),
    );

    expect(error).toBeInstanceOf(MailServerUnreachableError);
    expect(stub.calls).toEqual(["mail.test"]);
  });

  it("refuses a sync mode that names no transport, before reading anything", async () => {
    // Every SYNC_MODES value now has a transport, so this value is outside the union, the way a stored row that
    // the store's type does not describe would reach the factory.
    const unnamedMode = "unsupported_mode" as unknown as SyncMode;
    await expect(createMailTransportFactory(pool).forMailbox(mailboxId, unnamedMode)).rejects.toThrow(
      /No mail transport for sync mode unsupported_mode/,
    );
  });

  it("refuses a mailbox with no server settings at all, with a ValidationError naming smtp", async () => {
    await storeCredential(pool, { itemId: mailboxId, credentialType: "app_password", plaintext: password });

    await expect(createMailTransportFactory(pool).forMailbox(mailboxId, "imap")).rejects.toMatchObject({
      name: "ValidationError",
      message: expect.stringContaining("has no SMTP server settings"),
    });
  });

  it("refuses a mailbox whose settings have no SMTP endpoint, an IMAP-only mailbox", async () => {
    await upsertMailServerSettings(pool, mailboxId, {
      imap: { host: "mail.test", port: 993, security: "tls" },
      smtp: null,
      username,
    });
    await storeCredential(pool, { itemId: mailboxId, credentialType: "app_password", plaintext: password });

    const error = await rejectionOf(createMailTransportFactory(pool).forMailbox(mailboxId, "imap"));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ details: { field: "smtp" } });
  });

  it("refuses a mailbox with SMTP settings but no stored credential", async () => {
    await upsertMailServerSettings(pool, mailboxId, { imap: null, smtp: smtpEndpoint, username });

    await expect(createMailTransportFactory(pool).forMailbox(mailboxId, "imap")).rejects.toThrow(
      /has no stored credential/,
    );
  });
});

/** A reconcile method the Sent-copy path never calls; it fails if it is called. */
async function notCalled(): Promise<never> {
  throw new Error("the Sent-copy path calls no reconcile method");
}

const unusedReconcileMethods: Omit<ImapMailClient, "appendMessage" | "close"> = {
  getCapabilities: notCalled,
  listFolders: notCalled,
  selectFolder: notCalled,
  fetchMessagesSince: notCalled,
  fetchVanishedSince: notCalled,
  fetchAllUids: notCalled,
  fetchFlagsChangedSince: notCalled,
  setMessageFlag: notCalled,
};

interface AppendRecord {
  path: string;
  raw: Buffer;
  flags: readonly string[];
}

interface RecordingImap {
  readonly appends: AppendRecord[];
  readonly opened: MailServerConnectionSettings[];
  readonly open: ImapConnectionOpener;
}

/** The IMAP opener of one test. It records each connection it opens, and each append and close into `events`. `appendError` makes every append fail. */
function recordingImap(events: string[], appendError?: Error): RecordingImap {
  const appends: AppendRecord[] = [];
  const opened: MailServerConnectionSettings[] = [];
  const open: ImapConnectionOpener = async (settings) => {
    opened.push(settings);
    events.push("imap-open");
    const client: ImapMailClient = {
      ...unusedReconcileMethods,
      appendMessage: async (path, raw, flags) => {
        appends.push({ path, raw, flags });
        events.push("imap-append");
        if (appendError) throw appendError;
      },
      close: async () => {
        events.push("imap-close");
      },
    };
    return client;
  };
  return { appends, opened, open };
}

/** The SMTP opener of one test: the production transporter, with its close recorded into `events`. */
function recordingSmtp(events: string[]): SmtpTransporterOpener {
  return (settings, credential) => {
    const transporter = createSmtpTransporter(settings, credential);
    return {
      ...transporter,
      close: () => {
        events.push("smtp-close");
        transporter.close();
      },
    };
  };
}

/** A connection limiter that records the account and limit each task runs under, then runs the task at once. */
function recordingLimiter(events: string[]): ImapConnectionLimiter {
  return {
    run<T>(accountId: string, limit: number, task: () => Promise<T>): Promise<T> {
      events.push(`limit:${accountId}:${limit}`);
      return task();
    },
  };
}

/** Makes the Folder item that `reconcileImapAccount` creates for a mailbox's Sent folder, so the Sent-copy path finds it. */
async function addSentFolder(pool: Pool, mailboxItemId: string, providerId: string): Promise<void> {
  await withTransaction(pool, async (client) => {
    const moduleIds = await resolveMailModuleIds(client);
    const mailboxRelation = await getPropertyByKey(client, moduleIds.foldersDatabaseId, "mailbox");
    if (!mailboxRelation) throw new Error("the Folders.mailbox relation property is not seeded");
    await ensureFolderItem(client, {
      foldersDatabaseId: moduleIds.foldersDatabaseId,
      mailboxItemId,
      mailboxRelationPropertyId: mailboxRelation.id,
      providerId,
      name: providerId,
      behavior: "folder",
      specialPurpose: "sent",
    });
  });
}

/** Creates a Mailboxes item the way production does, with the given user properties. */
async function createMailbox(pool: Pool, properties: Record<string, unknown>): Promise<string> {
  const moduleIds = await withTransaction(pool, (client) => resolveMailModuleIds(client));
  const item = await withTransaction(pool, (client) =>
    createItemWithClient(client, { databaseId: moduleIds.mailboxesDatabaseId, properties }),
  );
  return item.id;
}

describe("Sent-folder copy of an accepted SMTP send (issue #1641)", () => {
  let pool: Pool;
  let mailboxId: string;
  const imapEndpoint: MailServerEndpoint = { host: "mail.test", port: 993, security: "tls" };
  const smtpEndpoint: MailServerEndpoint = { host: "mail.test", port: 465, security: "tls" };
  const envelope = { from: "me@mail.test", recipients: ["bob@mail.test"] };

  beforeAll(() => {
    pool = getTestPool();
  });

  beforeEach(async () => {
    await resetDatabase(pool);
    await seedSystem(pool);
    mailboxId = await createMailbox(pool, { name: "Test", provider: "generic", addresses: "me@mail.test" });
    await upsertMailServerSettings(pool, mailboxId, { imap: imapEndpoint, smtp: smtpEndpoint, username });
  });

  afterAll(async () => {
    await pool.end();
  });

  it("keeps the accepted message in the Sent folder: the same bytes with \\Seen, appended after the SMTP connection closed", async () => {
    useLoopbackPolicy();
    trustMailCertificate();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    await addSentFolder(pool, mailboxId, "Sent Items");
    const server = await startFakeSmtp();
    const events: string[] = [];
    const imap = recordingImap(events);
    const transport = createSmtpMailTransport(
      mailboxId,
      settingsFor("mail.test", server.port),
      credential,
      recordingSmtp(events),
      createSentCopySaver(pool, mailboxId, credential, imap.open),
    );

    await expect(transport.send({ raw: rawMessage, envelope })).resolves.toEqual({});

    expect(server.accepted).toHaveLength(1);
    expect(imap.opened).toEqual([{ endpoint: imapEndpoint, username }]);
    expect(imap.appends).toEqual([{ path: "Sent Items", raw: rawMessage, flags: ["\\Seen"] }]);
    expect(events).toEqual(["smtp-close", "imap-open", "imap-append", "imap-close"]);
  });

  it("keeps no copy when the server refuses the submission", async () => {
    useLoopbackPolicy();
    trustMailCertificate();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    await addSentFolder(pool, mailboxId, "Sent Items");
    const server = await startFakeSmtp({ acceptedPassword: "another-password" });
    const imap = recordingImap([]);
    const transport = createSmtpMailTransport(
      mailboxId,
      settingsFor("mail.test", server.port),
      credential,
      createSmtpTransporter,
      createSentCopySaver(pool, mailboxId, credential, imap.open),
    );

    const error = await rejectionOf(transport.send({ raw: rawMessage, envelope }));

    expect(error).toBeInstanceOf(MailSendAuthFailedError);
    expect(server.accepted).toHaveLength(0);
    expect(imap.opened).toEqual([]);
    expect(imap.appends).toEqual([]);
  });

  it("a copy the server refuses leaves the send successful, logs only the error's name, and closes the IMAP connection", async () => {
    useLoopbackPolicy();
    trustMailCertificate();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    await addSentFolder(pool, mailboxId, "Sent Items");
    const server = await startFakeSmtp();
    const warn = vi.spyOn(logger, "warn");
    const events: string[] = [];
    const imap = recordingImap(events, new Error("[NO] Subject: quarterly numbers for bob@mail.test"));
    const transport = createSmtpMailTransport(
      mailboxId,
      settingsFor("mail.test", server.port),
      credential,
      createSmtpTransporter,
      createSentCopySaver(pool, mailboxId, credential, imap.open),
    );

    await expect(transport.send({ raw: rawMessage, envelope })).resolves.toEqual({});

    expect(server.accepted).toHaveLength(1);
    expect(events).toEqual(["imap-open", "imap-append", "imap-close"]);
    expect(warn).toHaveBeenCalledWith(
      { mailboxItemId: mailboxId, errorName: "Error" },
      "Keeping a copy of the sent message in the Sent folder failed",
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("quarterly numbers");
  });

  it("keeps no copy when the mailbox has no Sent folder yet, and logs the reason", async () => {
    const warn = vi.spyOn(logger, "warn");
    const events: string[] = [];
    const imap = recordingImap(events);

    await expect(createSentCopySaver(pool, mailboxId, credential, imap.open)(rawMessage)).resolves.toBeUndefined();

    expect(events).toEqual([]);
    expect(warn).toHaveBeenCalledWith({ mailboxItemId: mailboxId, reason: "no_sent_folder" }, expect.any(String));
  });

  it("fails the copy with a ValidationError that names imap when the mailbox has no IMAP settings, and opens nothing", async () => {
    await upsertMailServerSettings(pool, mailboxId, { imap: null, smtp: smtpEndpoint, username });
    await addSentFolder(pool, mailboxId, "Sent Items");
    const imap = recordingImap([]);

    const error = await rejectionOf(createSentCopySaver(pool, mailboxId, credential, imap.open)(rawMessage));

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ details: { field: "imap" } });
    expect(imap.opened).toEqual([]);
  });

  it("appends under the account's IMAP connection slot at the provider's default limit when the mailbox sets none", async () => {
    await addSentFolder(pool, mailboxId, "Sent Items");
    const events: string[] = [];
    const imap = recordingImap(events);

    await createSentCopySaver(pool, mailboxId, credential, imap.open, recordingLimiter(events))(rawMessage);

    expect(events).toEqual([`limit:${mailboxId}:2`, "imap-open", "imap-append", "imap-close"]);
  });

  it("appends under the limit the mailbox itself sets", async () => {
    const limitedMailboxId = await createMailbox(pool, {
      name: "Limited",
      provider: "generic",
      addresses: "me@mail.test",
      connectionLimit: 1,
    });
    await upsertMailServerSettings(pool, limitedMailboxId, { imap: imapEndpoint, smtp: smtpEndpoint, username });
    await addSentFolder(pool, limitedMailboxId, "Sent Items");
    const events: string[] = [];
    const imap = recordingImap(events);

    await createSentCopySaver(pool, limitedMailboxId, credential, imap.open, recordingLimiter(events))(rawMessage);

    expect(events).toEqual([`limit:${limitedMailboxId}:1`, "imap-open", "imap-append", "imap-close"]);
  });

  it("the production factory keeps no copy of a send the outbound policy refuses", async () => {
    await addSentFolder(pool, mailboxId, "Sent Items");
    await storeCredential(pool, { itemId: mailboxId, credentialType: "app_password", plaintext: password });
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const imap = recordingImap([]);
    const transport = await createMailTransportFactory(pool, { openImapConnection: imap.open }).forMailbox(
      mailboxId,
      "imap",
    );

    const error = await rejectionOf(transport.send({ raw: rawMessage, envelope }));

    expect(error).toBeInstanceOf(MailServerUnreachableError);
    expect(imap.opened).toEqual([]);
  });
});
