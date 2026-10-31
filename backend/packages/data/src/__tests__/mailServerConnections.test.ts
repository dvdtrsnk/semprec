import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Socket as NetSocket, createServer as createNetServer, type Server as NetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { ImapFlow } from "imapflow";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MailServerEndpoint, MailServerSecurity } from "../mail/mailServerSettingsStore.js";
import { ImapFlowMailClient } from "../mail/imapFlowClient.js";
import {
  createSmtpTransporter,
  openImapConnection,
  openImapFlow,
  type MailServerConnectionSettings,
  type MailServerCredential,
} from "../mail/mailServerConnections.js";
import { MailServerUnreachableError } from "../mail/providerTypes.js";
import { allowLoopbackOutboundForTests } from "../net/outboundAddressPolicy.js";
import { stubDnsLookup, type DnsLookupStub } from "../testSupport/dnsLookupStub.js";

// Fake servers listen on loopback and are reached only under the test-only loopback policy. Their TLS
// certificates are made with the openssl CLI at test time, so nothing sensitive is committed, and the
// client trusts a test certificate by wrapping `tls.connect` for the duration of one test.

interface TestCertificate {
  readonly key: string;
  readonly cert: string;
}

interface FakeServer {
  readonly port: number;
  /** TCP connections accepted, before any TLS handshake. */
  readonly connections: () => number;
  /** TLS handshakes that completed. */
  readonly secureConnections: () => number;
  /** Server names the clients sent in SNI, in order. */
  readonly serverNames: string[];
  close(): Promise<void>;
}

const credential: MailServerCredential = { password: "app-password" };
const username = "mailbox@mail.test";

let mailCertificate: TestCertificate;
let otherCertificate: TestCertificate;

beforeAll(() => {
  mailCertificate = makeCertificate("mail.test");
  otherCertificate = makeCertificate("other.test");
});

const servers: FakeServer[] = [];
let stub: DnsLookupStub | undefined;
let restorePolicy: (() => void) | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  stub?.restore();
  stub = undefined;
  restorePolicy?.();
  restorePolicy = undefined;
  for (const server of servers.splice(0)) await server.close();
});

afterAll(() => {
  stub?.restore();
});

function makeCertificate(commonName: string): TestCertificate {
  const dir = mkdtempSync(join(tmpdir(), "mail-connections-"));
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

/** Makes `tls.connect` trust `certificate` for the connections of this test, so only the name check can refuse. */
function trustCertificate(certificate: TestCertificate): void {
  const connect = tls.connect;
  vi.spyOn(tls, "connect").mockImplementation(((options: tls.ConnectionOptions, listener?: () => void) =>
    connect({ ...options, ca: [certificate.cert] }, listener)) as typeof tls.connect);
}

function portOf(server: NetServer): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server is not listening on a TCP port");
  return address.port;
}

function trackSocket(sockets: Set<Socket>, socket: Socket): void {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  // Clients reset their connections on purpose in these tests; the fake server does not treat that as a failure.
  socket.on("error", () => undefined);
}

/** A loopback server that runs `session` for each connection. With `certificate` it speaks TLS and runs `session` after the handshake. */
async function startFakeServer(session: (socket: Socket) => void, certificate?: TestCertificate): Promise<FakeServer> {
  const sockets = new Set<Socket>();
  const serverNames: string[] = [];
  let connections = 0;
  let secureConnections = 0;
  const server: NetServer = certificate
    ? tls.createServer(
        {
          key: certificate.key,
          cert: certificate.cert,
          SNICallback: (name, done) => {
            serverNames.push(name);
            done(null, tls.createSecureContext({ key: certificate.key, cert: certificate.cert }));
          },
        },
        (secure) => {
          secureConnections += 1;
          trackSocket(sockets, secure);
          session(secure);
        },
      )
    : createNetServer((socket) => {
        connections += 1;
        trackSocket(sockets, socket);
        session(socket);
      });
  if (certificate) {
    server.on("connection", () => {
      connections += 1;
    });
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const fake: FakeServer = {
    port: portOf(server),
    connections: () => connections,
    secureConnections: () => secureConnections,
    serverNames,
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
  const port = portOf(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** A minimal IMAP4rev1 server: greets, answers CAPABILITY, and accepts LOGIN only with `password`. */
function imapSession(password: string): (socket: Socket) => void {
  return (socket) => {
    socket.write("* OK fake IMAP server ready\r\n");
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let end = pending.indexOf("\r\n");
      while (end !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        end = pending.indexOf("\r\n");
        socket.write(imapReply(line, password));
      }
    });
  };
}

function imapReply(line: string, password: string): string {
  const [tag = "*", command = "", ...args] = line.split(" ");
  switch (command.toUpperCase()) {
    case "CAPABILITY":
      return `* CAPABILITY IMAP4rev1 LOGIN\r\n${tag} OK CAPABILITY completed\r\n`;
    case "LOGIN": {
      const sent = (args[1] ?? "").replace(/^"|"$/g, "");
      return sent === password
        ? `${tag} OK LOGIN completed\r\n`
        : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n`;
    }
    default:
      return `${tag} OK completed\r\n`;
  }
}

/**
 * A minimal SMTP server: greets, advertises AUTH PLAIN only, and accepts PLAIN logins with `password`.
 * It refuses STARTTLS, and records the verb of every command it receives in `received`.
 */
function smtpSession(password: string, received: string[] = []): (socket: Socket) => void {
  return (socket) => {
    socket.write("220 mail.test ESMTP fake\r\n");
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let end = pending.indexOf("\r\n");
      while (end !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        end = pending.indexOf("\r\n");
        received.push((line.split(" ")[0] ?? "").toUpperCase());
        socket.write(smtpReply(line, password));
      }
    });
  };
}

function smtpReply(line: string, password: string): string {
  const [verb = "", mechanism = "", initial = ""] = line.split(" ");
  switch (verb.toUpperCase()) {
    case "EHLO":
      return "250-mail.test\r\n250 AUTH PLAIN\r\n";
    case "STARTTLS":
      return "502 5.5.1 STARTTLS is not supported\r\n";
    case "AUTH": {
      if (mechanism.toUpperCase() !== "PLAIN") return "504 5.5.4 mechanism not supported\r\n";
      const [, user = "", pass = ""] = Buffer.from(initial, "base64").toString("utf8").split("\0");
      return user === username && pass === password
        ? "235 2.7.0 authentication succeeded\r\n"
        : "535 5.7.8 authentication failed\r\n";
    }
    case "QUIT":
      return "221 2.0.0 bye\r\n";
    default:
      return "250 2.0.0 OK\r\n";
  }
}

function settingsFor(host: string, port: number, security: MailServerSecurity = "tls"): MailServerConnectionSettings {
  const endpoint: MailServerEndpoint = { host, port, security };
  return { endpoint, username };
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

function lookupThroughPolicy(options: tls.ConnectionOptions, hostname: string): Promise<unknown> {
  const lookup = options.lookup;
  return new Promise((resolve, reject) => {
    if (lookup === undefined) {
      reject(new Error("tls.connect was called without the policy lookup"));
      return;
    }
    lookup(hostname, { all: false }, (error, address) => (error ? reject(error) : resolve(address)));
  });
}

describe("openImapConnection (issue #1478)", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1"])(
    "refuses a name that resolves to %s under the default policy, with the unreachable error",
    async (address) => {
      stub = stubDnsLookup({ "internal.test": [address] });
      const server = await startFakeServer(imapSession(credential.password));
      const error = await rejectionOf(openImapConnection(settingsFor("internal.test", server.port), credential));
      expect(error).toBeInstanceOf(MailServerUnreachableError);
      expect(server.connections()).toBe(0);
    },
  );

  it("answers a refused address exactly like a closed port, naming neither the address nor a cause", async () => {
    const port = await closedPort();
    useLoopbackPolicy();
    stub = stubDnsLookup({ "closed.test": ["127.0.0.1"] });
    const closed = await rejectionOf(openImapConnection(settingsFor("closed.test", port), credential));
    restorePolicy?.();
    restorePolicy = undefined;

    stub.restore();
    stub = stubDnsLookup({ "refused.test": ["127.0.0.1"] });
    const refused = await rejectionOf(openImapConnection(settingsFor("refused.test", port), credential));

    expect(closed).toBeInstanceOf(MailServerUnreachableError);
    expect(refused).toBeInstanceOf(MailServerUnreachableError);
    expect(refused).toEqual(closed);
    expect(refused).toMatchObject({ code: "mail_server_unreachable", name: "MailServerUnreachableError" });
    expect((refused as Error).cause).toBeUndefined();
    expect((refused as Error).message).not.toContain("127.0.0.1");
  });

  it("refuses an IP-literal host under the default policy before any connection is made", async () => {
    const server = await startFakeServer(imapSession(credential.password));
    const loopback = await rejectionOf(openImapConnection(settingsFor("127.0.0.1", server.port), credential));
    const publicLiteral = await rejectionOf(openImapConnection(settingsFor("93.184.216.34", server.port), credential));
    expect(loopback).toBeInstanceOf(MailServerUnreachableError);
    expect(publicLiteral).toBeInstanceOf(MailServerUnreachableError);
    expect(server.connections()).toBe(0);
  });

  it("resolves the host name exactly once per connection", async () => {
    const port = await closedPort();
    useLoopbackPolicy();
    stub = stubDnsLookup({ "once.test": ["127.0.0.1"] });
    await rejectionOf(openImapConnection(settingsFor("once.test", port), credential));
    expect(stub.calls).toEqual(["once.test"]);
  });

  it("connects to the vetted address with the host name as the TLS server name, then logs in", async () => {
    useLoopbackPolicy();
    trustCertificate(mailCertificate);
    const server = await startFakeServer(imapSession(credential.password), mailCertificate);
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });

    const client = await openImapConnection(settingsFor("mail.test", server.port), credential);

    expect(client).toBeInstanceOf(ImapFlowMailClient);
    expect(server.secureConnections()).toBe(1);
    expect(server.serverNames).toEqual(["mail.test"]);
    expect(stub.calls).toEqual(["mail.test"]);
  });

  it("refuses a certificate issued for another name, and never completes the handshake", async () => {
    useLoopbackPolicy();
    trustCertificate(otherCertificate);
    const server = await startFakeServer(imapSession(credential.password), otherCertificate);
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });

    const error = await rejectionOf(openImapConnection(settingsFor("mail.test", server.port), credential));

    expect(error).toBeInstanceOf(MailServerUnreachableError);
    expect(server.serverNames).toEqual(["mail.test"]);
    expect(server.secureConnections()).toBe(0);
  });

  it("reports a rejected login as an authentication failure, not as unreachable", async () => {
    useLoopbackPolicy();
    trustCertificate(mailCertificate);
    const server = await startFakeServer(imapSession("the-right-password"), mailCertificate);
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });

    const error = await rejectionOf(openImapConnection(settingsFor("mail.test", server.port), credential));

    expect(error).not.toBeInstanceOf(MailServerUnreachableError);
    expect(error).toMatchObject({ authenticationFailed: true });
  });

  it("requires STARTTLS for starttls endpoints, and maps a server that does not offer it as a TLS failure", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeServer(imapSession(credential.password));

    const error = await rejectionOf(openImapConnection(settingsFor("mail.test", server.port, "starttls"), credential));

    expect(error).toBeInstanceOf(MailServerUnreachableError);
    expect(server.secureConnections()).toBe(0);
  });

  it("hands the socket the policy lookup, which vets a public address and keeps the host name as the server name", async () => {
    stub = stubDnsLookup({ "public.test": ["93.184.216.34"] });
    const seen: tls.ConnectionOptions[] = [];
    vi.spyOn(tls, "connect").mockImplementation(((options: tls.ConnectionOptions) => {
      seen.push(options);
      const socket = new tls.TLSSocket(new NetSocket());
      process.nextTick(() =>
        socket.destroy(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
      );
      return socket;
    }) as typeof tls.connect);

    const error = await rejectionOf(openImapConnection(settingsFor("public.test", 993), credential));
    expect(error).toBeInstanceOf(MailServerUnreachableError);

    const [options] = seen;
    expect(options?.servername).toBe("public.test");
    expect(options?.host).toBe("public.test");
    expect(await lookupThroughPolicy(options ?? {}, "public.test")).toBe("93.184.216.34");
    expect(stub.calls).toEqual(["public.test"]);
  });
});

/**
 * imapflow 1.7.6 stores the idle options it was constructed with as the client's own `maxIdleTime` and
 * `socketTimeout` fields, and its typings declare neither. This is the only observable effect of those
 * options on the client, so the tests read it here; `package.json` declares `^1.7.6` for imapflow.
 */
function imapflowField(client: ImapFlow, field: "maxIdleTime" | "socketTimeout"): unknown {
  return Reflect.get(client, field);
}

describe("openImapFlow (issue #1550)", () => {
  it("resolves with a connected, logged-in client for the fake server", async () => {
    useLoopbackPolicy();
    trustCertificate(mailCertificate);
    const server = await startFakeServer(imapSession(credential.password), mailCertificate);
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });

    const client = await openImapFlow(settingsFor("mail.test", server.port), credential);

    try {
      expect(client).toBeInstanceOf(ImapFlow);
      expect(client.usable).toBe(true);
      expect(client.authenticated).toBeTruthy();
    } finally {
      client.close();
    }
  });

  it.each(["127.0.0.1", "10.0.0.1"])(
    "refuses a name that resolves to %s with the unreachable error, before any connection is made",
    async (address) => {
      stub = stubDnsLookup({ "internal.test": [address] });
      const server = await startFakeServer(imapSession(credential.password));
      const error = await rejectionOf(openImapFlow(settingsFor("internal.test", server.port), credential));
      expect(error).toBeInstanceOf(MailServerUnreachableError);
      expect(server.connections()).toBe(0);
    },
  );

  it("forwards maxIdleTime and socketTimeout to the ImapFlow client it constructs", async () => {
    useLoopbackPolicy();
    trustCertificate(mailCertificate);
    const server = await startFakeServer(imapSession(credential.password), mailCertificate);
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });

    const client = await openImapFlow(settingsFor("mail.test", server.port), credential, {
      maxIdleTime: 25 * 60 * 1000,
      socketTimeout: 35 * 60 * 1000,
    });

    try {
      expect(imapflowField(client, "maxIdleTime")).toBe(25 * 60 * 1000);
      expect(imapflowField(client, "socketTimeout")).toBe(35 * 60 * 1000);
    } finally {
      client.close();
    }
  });

  it("keeps imapflow's own defaults when the idle options are not given", async () => {
    useLoopbackPolicy();
    trustCertificate(mailCertificate);
    const server = await startFakeServer(imapSession(credential.password), mailCertificate);
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });

    const client = await openImapFlow(settingsFor("mail.test", server.port), credential);

    try {
      expect(imapflowField(client, "maxIdleTime")).toBe(false);
      expect(imapflowField(client, "socketTimeout")).toBe(5 * 60 * 1000);
    } finally {
      client.close();
    }
  });
});

describe("createSmtpTransporter (issue #1478)", () => {
  it.each(["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1"])(
    "refuses a name that resolves to %s under the default policy, with the unreachable error",
    async (address) => {
      stub = stubDnsLookup({ "internal.test": [address] });
      const server = await startFakeServer(smtpSession(credential.password));
      const transporter = createSmtpTransporter(settingsFor("internal.test", server.port), credential);
      const error = await rejectionOf(transporter.verify());
      expect(error).toBeInstanceOf(MailServerUnreachableError);
      expect(server.connections()).toBe(0);
    },
  );

  it("refuses an IP-literal host under the default policy before any connection is made", async () => {
    const server = await startFakeServer(smtpSession(credential.password));
    const loopback = await rejectionOf(
      createSmtpTransporter(settingsFor("127.0.0.1", server.port), credential).verify(),
    );
    const publicLiteral = await rejectionOf(
      createSmtpTransporter(settingsFor("93.184.216.34", server.port), credential).verify(),
    );
    expect(loopback).toBeInstanceOf(MailServerUnreachableError);
    expect(publicLiteral).toBeInstanceOf(MailServerUnreachableError);
    expect(server.connections()).toBe(0);
  });

  it("maps a refused send the same way, and hands the server no message", async () => {
    const server = await startFakeServer(smtpSession(credential.password));
    stub = stubDnsLookup({ "internal.test": ["127.0.0.1"] });
    const transporter = createSmtpTransporter(settingsFor("internal.test", server.port), credential);
    const error = await rejectionOf(
      transporter.sendMail({ from: username, to: "someone@mail.test", subject: "hello", text: "hello" }),
    );
    expect(error).toBeInstanceOf(MailServerUnreachableError);
    expect(server.connections()).toBe(0);
  });

  it("answers a refused address exactly like a closed port", async () => {
    const port = await closedPort();
    useLoopbackPolicy();
    stub = stubDnsLookup({ "closed.test": ["127.0.0.1"] });
    const closed = await rejectionOf(createSmtpTransporter(settingsFor("closed.test", port), credential).verify());
    restorePolicy?.();
    restorePolicy = undefined;

    stub.restore();
    stub = stubDnsLookup({ "refused.test": ["127.0.0.1"] });
    const refused = await rejectionOf(createSmtpTransporter(settingsFor("refused.test", port), credential).verify());

    expect(refused).toBeInstanceOf(MailServerUnreachableError);
    expect(refused).toEqual(closed);
    expect((refused as Error).cause).toBeUndefined();
  });

  it("resolves the host name exactly once per connection", async () => {
    const port = await closedPort();
    useLoopbackPolicy();
    stub = stubDnsLookup({ "once.test": ["127.0.0.1"] });
    await rejectionOf(createSmtpTransporter(settingsFor("once.test", port), credential).verify());
    expect(stub.calls).toEqual(["once.test"]);
  });

  it("connects over implicit TLS to the vetted address with the host name as the server name, and logs in", async () => {
    useLoopbackPolicy();
    trustCertificate(mailCertificate);
    const server = await startFakeServer(smtpSession(credential.password), mailCertificate);
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });

    const verified = await createSmtpTransporter(settingsFor("mail.test", server.port), credential).verify();

    expect(verified).toBe(true);
    expect(server.serverNames).toEqual(["mail.test"]);
    expect(stub.calls).toEqual(["mail.test"]);
  });

  it("refuses a certificate issued for another name, and never completes the handshake", async () => {
    useLoopbackPolicy();
    trustCertificate(otherCertificate);
    const server = await startFakeServer(smtpSession(credential.password), otherCertificate);
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });

    const error = await rejectionOf(createSmtpTransporter(settingsFor("mail.test", server.port), credential).verify());

    expect(error).toBeInstanceOf(MailServerUnreachableError);
    expect(server.secureConnections()).toBe(0);
  });

  it("reports a rejected login as an authentication failure, not as unreachable", async () => {
    useLoopbackPolicy();
    trustCertificate(mailCertificate);
    const server = await startFakeServer(smtpSession("the-right-password"), mailCertificate);
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });

    const error = await rejectionOf(createSmtpTransporter(settingsFor("mail.test", server.port), credential).verify());

    expect(error).not.toBeInstanceOf(MailServerUnreachableError);
    expect(error).toMatchObject({ code: "EAUTH" });
  });

  it("requires STARTTLS for starttls endpoints, and maps a server that refuses the upgrade as a TLS failure", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const received: string[] = [];
    const server = await startFakeServer(smtpSession(credential.password, received));

    const error = await rejectionOf(
      createSmtpTransporter(settingsFor("mail.test", server.port, "starttls"), credential).verify(),
    );

    expect(received).toContain("STARTTLS");
    expect(error).toBeInstanceOf(MailServerUnreachableError);
    expect(server.secureConnections()).toBe(0);
  });
});
