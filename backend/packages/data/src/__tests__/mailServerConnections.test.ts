import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import dns from "node:dns";
import net from "node:net";
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
  verifyImapServerConnection,
  verifySmtpServerConnection,
  type MailServerConnectionSettings,
  type MailServerCredential,
} from "../mail/mailServerConnections.js";
import { MailAuthFailedError, MailServerUnreachableError } from "../mail/providerTypes.js";
import { logger } from "../mail/logger.js";
import { verifyMailCredentialsForTests } from "../mail/mailCredentialVerification.js";
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
  readonly closedConnections: () => number;
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
  syncBuiltinESMExports();
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
  let closedConnections = 0;
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
  server.on("connection", (socket) =>
    socket.once("close", () => {
      closedConnections += 1;
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const fake: FakeServer = {
    port: portOf(server),
    connections: () => connections,
    secureConnections: () => secureConnections,
    closedConnections: () => closedConnections,
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
function imapSession(password: string, commands: string[] = [], holdLogin = false): (socket: Socket) => void {
  return (socket) => {
    socket.write("* OK fake IMAP server ready\r\n");
    let pending = "";
    socket.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let end = pending.indexOf("\r\n");
      while (end !== -1) {
        const line = pending.slice(0, end);
        commands.push(line);
        pending = pending.slice(end + 2);
        end = pending.indexOf("\r\n");
        if (!(holdLogin && /\bLOGIN\b/i.test(line))) socket.write(imapReply(line, password));
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
function smtpSession(password: string, received: string[] = [], holdAuth = false): (socket: Socket) => void {
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
        if (!(holdAuth && /^AUTH\b/i.test(line))) socket.write(smtpReply(line, password));
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

function startTlsSession(
  protocol: "imap" | "smtp",
  certificate: TestCertificate,
  names: string[],
  holdSecure = false,
  commands: string[] = [],
  holdHandshake = false,
  onSecureData?: () => void,
): (socket: Socket) => void {
  return (socket) => {
    socket.write(protocol === "imap" ? "* OK fake IMAP server ready\r\n" : "220 mail.test ESMTP fake\r\n");
    let pending = "";
    const onPlainData = (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let end = pending.indexOf("\r\n");
      while (end !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const words = line.split(" ");
        const command = (protocol === "imap" ? words[1] : words[0])?.toUpperCase();
        commands.push(`plain:${command ?? ""}`);
        if (command === "STARTTLS") {
          socket.removeListener("data", onPlainData);
          socket.write(protocol === "imap" ? `${words[0]} OK Begin TLS\r\n` : "220 Ready for TLS\r\n", () => {
            if (holdHandshake) {
              socket.resume();
              return;
            }
            const secure = new tls.TLSSocket(socket, {
              isServer: true,
              secureContext: tls.createSecureContext({ key: certificate.key, cert: certificate.cert }),
              SNICallback: (name, done) => {
                names.push(name);
                done(null, tls.createSecureContext({ key: certificate.key, cert: certificate.cert }));
              },
            });
            secure.on("error", () => undefined);
            let securePending = "";
            secure.on("data", (data: Buffer) => {
              if (holdSecure) {
                onSecureData?.();
                return;
              }
              securePending += data.toString("utf8");
              let next = securePending.indexOf("\r\n");
              while (next !== -1) {
                const secureLine = securePending.slice(0, next);
                securePending = securePending.slice(next + 2);
                const secureWords = secureLine.split(" ");
                commands.push(`secure:${(protocol === "imap" ? secureWords[1] : secureWords[0])?.toUpperCase() ?? ""}`);
                secure.write(
                  protocol === "imap"
                    ? imapReply(secureLine, credential.password)
                    : smtpReply(secureLine, credential.password),
                );
                next = securePending.indexOf("\r\n");
              }
            });
          });
          return;
        }
        if (protocol === "imap" && command === "CAPABILITY")
          socket.write(`* CAPABILITY IMAP4rev1 STARTTLS\r\n${words[0]} OK completed\r\n`);
        else if (protocol === "smtp" && command === "EHLO") socket.write("250-mail.test\r\n250 STARTTLS\r\n");
        else
          socket.write(
            protocol === "imap" ? imapReply(line, credential.password) : smtpReply(line, credential.password),
          );
        end = pending.indexOf("\r\n");
      }
    };
    socket.on("data", onPlainData);
  };
}

function settingsFor(host: string, port: number, security: MailServerSecurity = "tls"): MailServerConnectionSettings {
  const endpoint: MailServerEndpoint = { host, port, security };
  return { endpoint, username };
}

function useLoopbackPolicy(): void {
  restorePolicy = allowLoopbackOutboundForTests();
}

async function expectServerSocketsClosed(server: FakeServer): Promise<void> {
  for (let attempt = 0; attempt < 100 && server.closedConnections() < server.connections(); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(server.connections()).toBeGreaterThan(0);
  expect(server.closedConnections()).toBe(server.connections());
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
  it("verifies both protocols through real helpers and falls back to STARTTLS", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const imapNames: string[] = [];
    const smtpNames: string[] = [];
    const imap = await startFakeServer(startTlsSession("imap", mailCertificate, imapNames));
    const smtp = await startFakeServer(startTlsSession("smtp", mailCertificate, smtpNames));
    const refused = await closedPort();
    await expect(
      verifyMailCredentialsForTests(
        {
          provider: "generic",
          address: username,
          username,
          password: credential.password,
          imapHost: "mail.test",
          smtpHost: "mail.test",
        },
        {
          ca: mailCertificate.cert,
          deadlineMs: 1_000,
          ports: { 993: refused, 143: imap.port, 465: refused, 587: smtp.port },
        },
      ),
    ).resolves.toEqual({
      imap: { host: "mail.test", port: 143, security: "starttls" },
      smtp: { host: "mail.test", port: 587, security: "starttls" },
    });
    expect(imapNames).toEqual(["mail.test"]);
    expect(smtpNames).toEqual(["mail.test"]);
    await expectServerSocketsClosed(imap);
    await expectServerSocketsClosed(smtp);
  });

  it("returns a safe authentication failure after both real IMAP candidates reject", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const imap = await startFakeServer(imapSession("correct-password"), mailCertificate);
    const upgrade = await startFakeServer(startTlsSession("imap", mailCertificate, []));
    const smtp = await startFakeServer(smtpSession(credential.password), mailCertificate);
    const rejectedPassword = "SENTINEL-WRONG-PASSWORD";
    const error = await rejectionOf(
      verifyMailCredentialsForTests(
        {
          provider: "generic",
          address: username,
          username,
          password: rejectedPassword,
          imapHost: "mail.test",
          smtpHost: "mail.test",
        },
        {
          ca: mailCertificate.cert,
          deadlineMs: 1_000,
          ports: { 993: imap.port, 143: upgrade.port, 465: smtp.port, 587: smtp.port },
        },
      ),
    );
    expect(error).toBeInstanceOf(MailAuthFailedError);
    if (!(error instanceof Error)) throw new Error("Missing authentication error");
    expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toContain(rejectedPassword);
    expect(smtp.connections()).toBe(0);
    await expectServerSocketsClosed(imap);
    await expectServerSocketsClosed(upgrade);
  });

  it("returns unreachable after both real IMAP candidates expire and closes both sockets", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const stalledTls = await startFakeServer((socket) => socket.resume());
    const stalledGreeting = await startFakeServer((socket) => socket.resume());
    await expect(
      verifyMailCredentialsForTests(
        {
          provider: "generic",
          address: username,
          username,
          password: credential.password,
          imapHost: "mail.test",
          smtpHost: "mail.test",
        },
        { deadlineMs: 80, ports: { 993: stalledTls.port, 143: stalledGreeting.port } },
      ),
    ).rejects.toBeInstanceOf(MailServerUnreachableError);
    await expectServerSocketsClosed(stalledTls);
    await expectServerSocketsClosed(stalledGreeting);
  });

  it("enforces the production deadline for each real IMAP candidate", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const stalledTls = await startFakeServer((socket) => socket.resume());
    const stalledGreeting = await startFakeServer((socket) => socket.resume());
    const started = performance.now();
    await expect(
      verifyMailCredentialsForTests(
        {
          provider: "generic",
          address: username,
          username,
          password: credential.password,
          imapHost: "mail.test",
          smtpHost: "mail.test",
        },
        { ports: { 993: stalledTls.port, 143: stalledGreeting.port } },
      ),
    ).rejects.toBeInstanceOf(MailServerUnreachableError);
    expect(performance.now() - started).toBeGreaterThanOrEqual(29_000);
    expect(stalledTls.connections()).toBe(1);
    expect(stalledGreeting.connections()).toBe(1);
    await expectServerSocketsClosed(stalledTls);
    await expectServerSocketsClosed(stalledGreeting);
  }, 40_000);

  it("enforces the production deadline for each real SMTP candidate", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const imap = await startFakeServer(imapSession(credential.password), mailCertificate);
    const stalledTls = await startFakeServer((socket) => socket.resume());
    const stalledGreeting = await startFakeServer((socket) => socket.resume());
    const started = performance.now();
    await expect(
      verifyMailCredentialsForTests(
        {
          provider: "generic",
          address: username,
          username,
          password: credential.password,
          imapHost: "mail.test",
          smtpHost: "mail.test",
        },
        { ca: mailCertificate.cert, ports: { 993: imap.port, 465: stalledTls.port, 587: stalledGreeting.port } },
      ),
    ).rejects.toBeInstanceOf(MailServerUnreachableError);
    expect(performance.now() - started).toBeGreaterThanOrEqual(29_000);
    expect(stalledTls.connections()).toBe(1);
    expect(stalledGreeting.connections()).toBe(1);
    await expectServerSocketsClosed(imap);
    await expectServerSocketsClosed(stalledTls);
    await expectServerSocketsClosed(stalledGreeting);
  }, 40_000);

  it("verification classifies required STARTTLS refusal before login", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const commands: string[] = [];
    const server = await startFakeServer(imapSession(credential.password, commands));
    await expect(
      verifyImapServerConnection(settingsFor("mail.test", server.port, "starttls"), credential),
    ).resolves.toBe("tls");
    expect(commands.some((line) => /\bLOGIN\b/i.test(line))).toBe(false);
  });

  it("serializes fixed connection diagnostics without an emitted error's secrets or host", async () => {
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const originalConnect: unknown = Object.getOwnPropertyDescriptor(ImapFlow.prototype, "connect")?.value;
    if (typeof originalConnect !== "function") throw new Error("Missing ImapFlow connect method");
    const original = Object.assign(new Error("IMAP-PRIVATE-SENTINEL"), {
      name: "IMAP-PRIVATE-SENTINEL",
      code: "IMAP-PRIVATE-SENTINEL",
    });
    let emitted: unknown;
    vi.spyOn(ImapFlow.prototype, "connect").mockImplementation(function (this: ImapFlow) {
      emitted = original;
      this.emit("error", original);
      const result: unknown = Reflect.apply(originalConnect, this, []);
      if (!(result instanceof Promise)) throw new Error("Missing connect operation");
      return result;
    });
    const stream = Object.getOwnPropertySymbols(logger).find((symbol) => symbol.description === "pino.stream");
    if (!stream) throw new Error("Missing application log stream");
    const previous: unknown = Reflect.get(logger, stream);
    const previousLevel = logger.level;
    const lines: string[] = [];
    if (
      !Reflect.set(logger, stream, {
        write: (line: string) => {
          lines.push(line);
          return true;
        },
      })
    ) {
      throw new Error("Could not capture application log stream");
    }
    const failures: unknown[] = [];
    try {
      logger.level = "warn";
      const result = await rejectionOf(openImapFlow(settingsFor("mail.test", 993), credential));
      expect(result).toBeInstanceOf(MailServerUnreachableError);
      expect(emitted).toBe(original);
      expect(lines.some((line) => line.includes('"stage":"connect_event"'))).toBe(true);
      expect(lines.join("\n")).not.toContain("IMAP-PRIVATE-SENTINEL");
      expect(lines.join("\n")).not.toContain("mail.test");
      expect(lines.join("\n")).not.toContain(credential.password);
    } catch (error) {
      failures.push(error);
    }
    try {
      logger.level = previousLevel;
    } catch (error) {
      failures.push(error);
    }
    try {
      if (!Reflect.set(logger, stream, previous)) throw new Error("Could not restore application log stream");
    } catch (error) {
      failures.push(error);
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "IMAP connection diagnostic test and cleanup failed");
  });

  it("verification refuses a policy-denied address without dialing", async () => {
    stub = stubDnsLookup({ "internal.test": ["127.0.0.1"] });
    const server = await startFakeServer(imapSession(credential.password));
    await expect(verifyImapServerConnection(settingsFor("internal.test", server.port), credential)).resolves.toBe(
      "unreachable",
    );
    expect(server.connections()).toBe(0);
  });

  it("verification authenticates over TLS and closes the connection", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const commands: string[] = [];
    const server = await startFakeServer(imapSession(credential.password, commands), mailCertificate);
    await expect(
      verifyImapServerConnection(settingsFor("mail.test", server.port), credential, {}, { ca: mailCertificate.cert }),
    ).resolves.toBe("success");
    expect(server.secureConnections()).toBe(1);
    expect(commands.some((line) => /\bLOGIN\b/i.test(line))).toBe(true);
  });

  it("does not claim successful verification when final client cleanup fails", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeServer(imapSession(credential.password), mailCertificate);
    const cleanupFailure = new Error("IMAP-CLEANUP-SENTINEL");
    const originalClose: unknown = Object.getOwnPropertyDescriptor(ImapFlow.prototype, "close")?.value;
    if (typeof originalClose !== "function") throw new Error("Missing ImapFlow close method");
    let injected = 0;
    const close = vi.spyOn(ImapFlow.prototype, "close").mockImplementation(function (this: ImapFlow) {
      if (injected === 0) {
        injected += 1;
        throw cleanupFailure;
      }
      Reflect.apply(originalClose, this, []);
    });
    const result = await rejectionOf(
      verifyImapServerConnection(settingsFor("mail.test", server.port), credential, {}, { ca: mailCertificate.cert }),
    );
    expect(result).toBe(cleanupFailure);
    expect(close).toHaveBeenCalled();
    expect(injected).toBe(1);
    await expectServerSocketsClosed(server);
  });

  it("retains the actual connection rejection and an independent cleanup failure through settlement", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const commands: string[] = [];
    const server = await startFakeServer(imapSession(credential.password, commands), otherCertificate);
    const originalConnect: unknown = Object.getOwnPropertyDescriptor(ImapFlow.prototype, "connect")?.value;
    const originalClose: unknown = Object.getOwnPropertyDescriptor(ImapFlow.prototype, "close")?.value;
    if (typeof originalConnect !== "function" || typeof originalClose !== "function")
      throw new Error("Missing ImapFlow methods");
    let rejection: { value: unknown } | undefined;
    const cleanup = new Error("independent cleanup sentinel");
    let injected = false;
    vi.spyOn(ImapFlow.prototype, "connect").mockImplementation(function (this: ImapFlow) {
      const result: unknown = Reflect.apply(originalConnect, this, []);
      if (!(result instanceof Promise)) throw new Error("Missing connect promise");
      return result.then(
        () => undefined,
        (error: unknown) => {
          rejection = { value: error };
          throw error;
        },
      );
    });
    vi.spyOn(ImapFlow.prototype, "close").mockImplementation(function (this: ImapFlow) {
      if (!injected) {
        injected = true;
        throw cleanup;
      }
      Reflect.apply(originalClose, this, []);
    });
    const outcome = await rejectionOf(
      verifyImapServerConnection(settingsFor("mail.test", server.port), credential, {}, { ca: otherCertificate.cert }),
    );
    expect(rejection).toBeDefined();
    expect(outcome).toBeInstanceOf(AggregateError);
    if (!(outcome instanceof AggregateError) || !rejection) throw new Error("Missing combined failure");
    expect(outcome.errors).toContain(rejection.value);
    expect(outcome.errors).toContain(cleanup);
    expect(commands).toEqual([]);
    await expectServerSocketsClosed(server);
  });

  it("verification rejects an invalid certificate before login", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const commands: string[] = [];
    const server = await startFakeServer(imapSession(credential.password, commands), otherCertificate);
    await expect(
      verifyImapServerConnection(settingsFor("mail.test", server.port), credential, {}, { ca: otherCertificate.cert }),
    ).resolves.toBe("tls");
    expect(server.secureConnections()).toBe(0);
    expect(commands).toEqual([]);
  });

  it("verification identifies a rejected login after TLS", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeServer(imapSession("another-password"), mailCertificate);
    await expect(
      verifyImapServerConnection(settingsFor("mail.test", server.port), credential, {}, { ca: mailCertificate.cert }),
    ).resolves.toBe("authentication");
  });

  it("verification owns both sockets when STARTTLS replaces the initial socket", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const names: string[] = [];
    const server = await startFakeServer(startTlsSession("imap", mailCertificate, names));
    await expect(
      verifyImapServerConnection(
        settingsFor("mail.test", server.port, "starttls"),
        credential,
        {},
        { ca: mailCertificate.cert },
      ),
    ).resolves.toBe("success");
    expect(names).toEqual(["mail.test"]);
    await expectServerSocketsClosed(server);
  });

  it("verification cancels a stalled initial TLS handshake and closes the socket", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeServer((socket) => socket.resume());
    await expect(
      verifyImapServerConnection(settingsFor("mail.test", server.port), credential, {}, { deadlineMs: 80 }),
    ).resolves.toBe("unreachable");
    await expectServerSocketsClosed(server);
  });

  it("uses the production fifteen-second IMAP deadline and observes socket closure", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeServer((socket) => socket.resume());
    const started = performance.now();
    await expect(verifyImapServerConnection(settingsFor("mail.test", server.port), credential)).resolves.toBe(
      "unreachable",
    );
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(14_000);
    expect(elapsed).toBeLessThan(25_000);
    await expectServerSocketsClosed(server);
  }, 30_000);

  it("verification cancels a stalled greeting and closes the TLS socket", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeServer(() => {}, mailCertificate);
    await expect(
      verifyImapServerConnection(
        settingsFor("mail.test", server.port),
        credential,
        {},
        { deadlineMs: 80, ca: mailCertificate.cert },
      ),
    ).resolves.toBe("unreachable");
    expect(server.secureConnections()).toBe(1);
    await expectServerSocketsClosed(server);
  });

  it("does not claim clean cancellation when destroying the owned socket fails", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const session = imapSession(credential.password, [], true);
    const server = await startFakeServer((socket) => {
      session(socket);
      setTimeout(() => socket.destroy(), 250);
    }, mailCertificate);
    const originalConnect: unknown = Object.getOwnPropertyDescriptor(ImapFlow.prototype, "connect")?.value;
    if (typeof originalConnect !== "function") throw new Error("Missing ImapFlow connect method");
    const destroyFailure = new Error("owned destroy failed");
    let injected = false;
    let actualRejection: { value: unknown } | undefined;
    vi.spyOn(ImapFlow.prototype, "connect").mockImplementation(function (this: ImapFlow) {
      const operation: unknown = Reflect.apply(originalConnect, this, []);
      if (!(operation instanceof Promise)) throw new Error("Missing connect promise");
      const socket: unknown = Object.getOwnPropertyDescriptor(this, "socket")?.value;
      if (!(socket instanceof NetSocket)) throw new Error("Missing owned socket");
      const destroy = socket.destroy.bind(socket);
      vi.spyOn(socket, "destroy").mockImplementation((error?: Error) => {
        if (error && !injected) {
          injected = true;
          throw destroyFailure;
        }
        return destroy(error);
      });
      return operation.then(
        () => undefined,
        (error: unknown) => {
          actualRejection = { value: error };
          throw error;
        },
      );
    });
    const outcome = await rejectionOf(
      verifyImapServerConnection(
        settingsFor("mail.test", server.port),
        credential,
        {},
        { deadlineMs: 80, ca: mailCertificate.cert },
      ),
    );
    expect(injected).toBe(true);
    expect(actualRejection).toBeDefined();
    expect(outcome).toBeInstanceOf(AggregateError);
    if (!(outcome instanceof AggregateError) || !actualRejection) throw new Error("Missing unsettled failure");
    expect(outcome.errors).toContain(destroyFailure);
    expect(outcome.errors).toContain(actualRejection.value);
    await expectServerSocketsClosed(server);
  });

  it("verification cancels a stalled login and closes the TLS socket", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const commands: string[] = [];
    const server = await startFakeServer(imapSession(credential.password, commands, true), mailCertificate);
    await expect(
      verifyImapServerConnection(
        settingsFor("mail.test", server.port),
        credential,
        {},
        { deadlineMs: 80, ca: mailCertificate.cert },
      ),
    ).resolves.toBe("unreachable");
    expect(commands.some((line) => /\bLOGIN\b/i.test(line))).toBe(true);
    await expectServerSocketsClosed(server);
  });

  it("preserves independently observed secondary values and logs only safe ordered diagnostics for an owned cancellation", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeServer(imapSession(credential.password, [], true), mailCertificate);
    const originalConnect: unknown = Object.getOwnPropertyDescriptor(ImapFlow.prototype, "connect")?.value;
    if (typeof originalConnect !== "function") throw new Error("Missing ImapFlow connect method");
    const secondary = new Error("SENTINEL-SECONDARY-SECRET");
    let owner: Error | undefined;
    let rejected: unknown;
    let rejectionObserved = false;
    const emitted: unknown[] = [];
    const observeEmission = (value: unknown) => emitted.push(value);
    const observedClients: ImapFlow[] = [];
    const logged: string[] = [];
    const streamSymbol = Object.getOwnPropertySymbols(logger).find((symbol) => symbol.description === "pino.stream");
    if (!streamSymbol) throw new Error("Missing application logger stream");
    const previousStream: unknown = Reflect.get(logger, streamSymbol);
    if (
      !Reflect.set(logger, streamSymbol, {
        write: (line: string) => {
          logged.push(line);
          return true;
        },
      })
    ) {
      throw new Error("Could not capture application log stream");
    }
    vi.spyOn(ImapFlow.prototype, "connect").mockImplementation(function (this: ImapFlow) {
      observedClients.push(this);
      this.on("error", observeEmission);
      const operation: unknown = Reflect.apply(originalConnect, this, []);
      if (!(operation instanceof Promise)) throw new Error("ImapFlow connect did not return a promise");
      const socket: unknown = Object.getOwnPropertyDescriptor(this, "socket")?.value;
      if (!(socket instanceof NetSocket)) throw new Error("Missing operation socket");
      const destroy = socket.destroy.bind(socket);
      let injected = false;
      vi.spyOn(socket, "destroy").mockImplementation((error?: Error) => {
        if (error && !injected) {
          injected = true;
          owner = error;
          this.emit("error", secondary);
          this.emit("error", undefined);
        }
        return destroy(error);
      });
      return operation.then(
        () => undefined,
        (error: unknown) => {
          rejectionObserved = true;
          rejected = error;
          throw error;
        },
      );
    });
    const failures: unknown[] = [];
    try {
      await expect(
        verifyImapServerConnection(
          settingsFor("mail.test", server.port),
          credential,
          {},
          { deadlineMs: 80, ca: mailCertificate.cert },
        ),
      ).resolves.toBe("unreachable");
      await expectServerSocketsClosed(server);
      expect(rejectionObserved).toBe(true);
      expect(rejected).toBe(owner);
      expect(owner).toBeInstanceOf(Error);
      expect(emitted).toHaveLength(3);
      expect(emitted[0]).toBe(secondary);
      expect(emitted[1]).toBeUndefined();
      expect(emitted[2]).toBeInstanceOf(Error);
      expect(emitted[2]).not.toBe(owner);
      expect(logged).toHaveLength(1);
      expect(logged[0]).not.toContain("SENTINEL-SECONDARY-SECRET");
      expect(logged[0]).not.toContain(credential.password);
      const record: unknown = JSON.parse(logged[0] ?? "null");
      expect(record).toMatchObject({
        count: 3,
        observations: [
          { order: 1, source: "client", category: "error" },
          { order: 2, source: "client", category: "non_error" },
          { order: 3, source: "client", category: "error" },
        ],
      });
    } catch (error) {
      failures.push(error);
    }
    for (const client of observedClients) client.removeListener("error", observeEmission);
    vi.restoreAllMocks();
    if (!Reflect.set(logger, streamSymbol, previousStream))
      failures.push(new Error("Could not restore application log stream"));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "IMAP verification test cleanup failed");
  });

  it("does not report a successful diagnostic when error logging is disabled", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeServer(imapSession(credential.password, [], true), mailCertificate);
    vi.spyOn(logger, "isLevelEnabled").mockReturnValue(false);
    const failure = await rejectionOf(
      verifyImapServerConnection(
        settingsFor("mail.test", server.port),
        credential,
        {},
        { deadlineMs: 80, ca: mailCertificate.cert },
      ),
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Missing diagnostic failure");
    expect(failure.errors.length).toBeGreaterThanOrEqual(2);
    await expectServerSocketsClosed(server);
  });

  it("verification cancels a stalled session after STARTTLS socket replacement", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const names: string[] = [];
    const server = await startFakeServer(startTlsSession("imap", mailCertificate, names, true));
    await expect(
      verifyImapServerConnection(
        settingsFor("mail.test", server.port, "starttls"),
        credential,
        {},
        { deadlineMs: 80, ca: mailCertificate.cert },
      ),
    ).resolves.toBe("unreachable");
    expect(names).toEqual(["mail.test"]);
    await expectServerSocketsClosed(server);
  });

  it("does not claim clean STARTTLS teardown when the replacement socket destroy fails", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const failure = new Error("STARTTLS wrapper destroy failed");
    const originalConnect: unknown = Object.getOwnPropertyDescriptor(ImapFlow.prototype, "connect")?.value;
    if (typeof originalConnect !== "function") throw new Error("Missing ImapFlow connect method");
    const clientRef: { current?: ImapFlow } = {};
    let initial: NetSocket | undefined;
    let initialClosed = false;
    let replacement: tls.TLSSocket | undefined;
    let injected = false;
    let rejected: { value: unknown } | undefined;
    vi.spyOn(ImapFlow.prototype, "connect").mockImplementation(function (this: ImapFlow) {
      clientRef.current = this;
      const operation: unknown = Reflect.apply(originalConnect, this, []);
      if (!(operation instanceof Promise)) throw new Error("Missing connect promise");
      const socket: unknown = Object.getOwnPropertyDescriptor(this, "socket")?.value;
      if (!(socket instanceof NetSocket)) throw new Error("Missing initial socket");
      initial = socket;
      socket.once("close", () => {
        initialClosed = true;
      });
      return operation.then(
        () => undefined,
        (error: unknown) => {
          rejected = { value: error };
          throw error;
        },
      );
    });
    const server = await startFakeServer((socket) => {
      const session = startTlsSession("imap", mailCertificate, [], true, [], false, () => {
        if (replacement || !clientRef.current) return;
        const candidate: unknown = Object.getOwnPropertyDescriptor(clientRef.current, "socket")?.value;
        if (!(candidate instanceof tls.TLSSocket) || candidate === initial) return;
        replacement = candidate;
        const destroy = candidate.destroy.bind(candidate);
        vi.spyOn(candidate, "destroy").mockImplementation((error?: Error) => {
          if (error && !injected) {
            injected = true;
            throw failure;
          }
          return destroy(error);
        });
        setTimeout(() => socket.destroy(), 250);
      });
      session(socket);
    });
    const outcome = await rejectionOf(
      verifyImapServerConnection(
        settingsFor("mail.test", server.port, "starttls"),
        credential,
        {},
        { deadlineMs: 100, ca: mailCertificate.cert },
      ),
    );
    expect(replacement).toBeInstanceOf(tls.TLSSocket);
    expect(injected).toBe(true);
    expect(initialClosed).toBe(true);
    expect(rejected).toBeDefined();
    expect(outcome).toBeInstanceOf(AggregateError);
    if (!(outcome instanceof AggregateError) || !rejected) throw new Error("Missing STARTTLS teardown failure");
    expect(outcome.errors).toContain(failure);
    expect(outcome.errors).toContain(rejected.value);
    await expectServerSocketsClosed(server);
  });

  it("verification rejects an invalid IMAP STARTTLS certificate before login", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const commands: string[] = [];
    const server = await startFakeServer(startTlsSession("imap", otherCertificate, [], false, commands));
    const originalConnect: unknown = Object.getOwnPropertyDescriptor(ImapFlow.prototype, "connect")?.value;
    if (typeof originalConnect !== "function") throw new Error("Missing ImapFlow connect method");
    let initial: NetSocket | undefined;
    let replacement: unknown;
    let initialCloseObserved = false;
    vi.spyOn(ImapFlow.prototype, "connect").mockImplementation(function (this: ImapFlow) {
      const operation: unknown = Reflect.apply(originalConnect, this, []);
      if (!(operation instanceof Promise)) throw new Error("ImapFlow connect did not return a promise");
      const socket: unknown = Object.getOwnPropertyDescriptor(this, "socket")?.value;
      if (!(socket instanceof NetSocket)) throw new Error("Missing initial transport socket");
      initial = socket;
      socket.once("close", () => {
        initialCloseObserved = true;
      });
      return operation.then(
        () => undefined,
        (error: unknown) => {
          replacement = Object.getOwnPropertyDescriptor(this, "socket")?.value;
          throw error;
        },
      );
    });
    await expect(
      verifyImapServerConnection(
        settingsFor("mail.test", server.port, "starttls"),
        credential,
        {},
        { ca: otherCertificate.cert },
      ),
    ).resolves.toBe("tls");
    expect(initialCloseObserved).toBe(true);
    expect(replacement).toBeInstanceOf(tls.TLSSocket);
    if (!(replacement instanceof tls.TLSSocket)) throw new Error("Missing STARTTLS wrapper");
    expect(replacement).not.toBe(initial);
    expect(replacement.closed).toBe(true);
    expect(commands).toContain("plain:STARTTLS");
    expect(commands).not.toContain("plain:LOGIN");
    expect(commands).not.toContain("secure:LOGIN");
    await expectServerSocketsClosed(server);
  });

  it("verification cancels a stalled IMAP STARTTLS handshake without login", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const commands: string[] = [];
    const server = await startFakeServer(startTlsSession("imap", mailCertificate, [], false, commands, true));
    await expect(
      verifyImapServerConnection(settingsFor("mail.test", server.port, "starttls"), credential, {}, { deadlineMs: 80 }),
    ).resolves.toBe("unreachable");
    expect(commands).toContain("plain:STARTTLS");
    expect(commands).not.toContain("plain:LOGIN");
    expect(commands).not.toContain("secure:LOGIN");
    await expectServerSocketsClosed(server);
  });

  it("verification settles the owned socket before discarding a late DNS result", async () => {
    useLoopbackPolicy();
    const server = await startFakeServer(imapSession(credential.password), mailCertificate);
    const original = dns.lookup;
    let finishLookup: (() => void) | undefined;
    let signalLookup: () => void = () => {};
    const entered = new Promise<void>((resolve) => (signalLookup = resolve));
    const lookup = (host: string, ...args: unknown[]) => {
      if (host !== "held.test") return Reflect.apply(original, dns, [host, ...args]);
      const callback = args.at(-1);
      if (typeof callback !== "function") throw new Error("Missing DNS callback");
      finishLookup = () => {
        Reflect.apply(callback, undefined, [null, [{ address: "127.0.0.1", family: 4 }]]);
      };
      signalLookup();
    };
    Object.defineProperty(dns, "lookup", { value: lookup, configurable: true, writable: true });
    const work = verifyImapServerConnection(settingsFor("held.test", server.port), credential, {}, { deadlineMs: 80 });
    try {
      await entered;
      await expect(work).resolves.toBe("unreachable");
      if (!finishLookup) throw new Error("DNS callback was not captured");
      finishLookup();
      finishLookup = undefined;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(server.connections()).toBe(0);
    } finally {
      finishLookup?.();
      await Promise.allSettled([work]);
      Object.defineProperty(dns, "lookup", { value: original, configurable: true, writable: true });
    }
  });

  it("preserves an unrelated actual connect failure that occurs before cancellation", async () => {
    const original = dns.lookup;
    const failure = Object.assign(new Error("Unrelated DNS failure"), { code: "EUNRELATED" });
    const lookup = (host: string, ...args: unknown[]) => {
      if (host !== "prior.test") return Reflect.apply(original, dns, [host, ...args]);
      const callback = args.at(-1);
      if (typeof callback !== "function") throw new Error("Missing DNS callback");
      process.nextTick(() => Reflect.apply(callback, undefined, [failure, []]));
    };
    Object.defineProperty(dns, "lookup", { value: lookup, configurable: true, writable: true });
    try {
      const error = await rejectionOf(verifyImapServerConnection(settingsFor("prior.test", 993), credential));
      expect(error).toBe(failure);
    } finally {
      Object.defineProperty(dns, "lookup", { value: original, configurable: true, writable: true });
    }
  });
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

  it("upgrades a local STARTTLS session, retains the host name and logs in", async () => {
    useLoopbackPolicy();
    trustCertificate(mailCertificate);
    const names: string[] = [];
    const server = await startFakeServer(startTlsSession("imap", mailCertificate, names));
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const client = await openImapConnection(settingsFor("mail.test", server.port, "starttls"), credential);
    expect(client).toBeInstanceOf(ImapFlowMailClient);
    expect(names).toEqual(["mail.test"]);
    expect(stub.calls).toEqual(["mail.test"]);
  });

  it("hands the socket the policy lookup, which vets a public address and keeps the host name as the server name", async () => {
    stub = stubDnsLookup({ "public.test": ["93.184.216.34"] });
    const seen: tls.ConnectionOptions[] = [];
    let selected: unknown;
    vi.spyOn(tls, "connect").mockImplementation(((options: tls.ConnectionOptions) => {
      seen.push(options);
      const socket = new tls.TLSSocket(new NetSocket());
      process.nextTick(() => {
        lookupThroughPolicy(options, "public.test").then(
          (address) => {
            selected = address;
            socket.destroy(Object.assign(new Error("test transport stopped"), { code: "ECONNREFUSED" }));
          },
          (error: unknown) => socket.destroy(error instanceof Error ? error : new Error("lookup failed")),
        );
      });
      return socket;
    }) as typeof tls.connect);

    const error = await rejectionOf(openImapConnection(settingsFor("public.test", 993), credential));
    expect(error).toBeInstanceOf(MailServerUnreachableError);

    const [options] = seen;
    expect(options?.servername).toBe("public.test");
    expect(options?.host).toBe("public.test");
    expect(selected).toBe("93.184.216.34");
    expect(stub.calls).toEqual(["public.test"]);
  });

  it("invokes its public-address policy lookup during the STARTTLS connector attempt", async () => {
    stub = stubDnsLookup({ "public.test": ["93.184.216.34"] });
    let selected: unknown;
    let hostname: string | undefined;
    let servername: unknown;
    vi.spyOn(net, "connect").mockImplementation(((options: net.TcpNetConnectOpts) => {
      hostname = options.host;
      servername = Reflect.get(options, "servername");
      const socket = new NetSocket();
      process.nextTick(() => {
        lookupThroughPolicy(options, "public.test").then(
          (address) => {
            selected = address;
            socket.destroy(Object.assign(new Error("test transport stopped"), { code: "ECONNREFUSED" }));
          },
          (error: unknown) => socket.destroy(error instanceof Error ? error : new Error("lookup failed")),
        );
      });
      return socket;
    }) as typeof net.connect);
    syncBuiltinESMExports();
    const error = await rejectionOf(openImapConnection(settingsFor("public.test", 143, "starttls"), credential));
    expect(error).toBeInstanceOf(MailServerUnreachableError);
    expect(hostname).toBe("public.test");
    expect(servername).toBe("public.test");
    expect(selected).toBe("93.184.216.34");
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
  it("verification authenticates through SMTP over implicit TLS", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const commands: string[] = [];
    const server = await startFakeServer(smtpSession(credential.password, commands), mailCertificate);
    await expect(
      verifySmtpServerConnection(settingsFor("mail.test", server.port), credential, {}, { ca: mailCertificate.cert }),
    ).resolves.toBe("success");
    expect(commands).toContain("AUTH");
    await expectServerSocketsClosed(server);
  });

  it("verification classifies SMTP authentication refusal", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeServer(smtpSession("another-password"), mailCertificate);
    await expect(
      verifySmtpServerConnection(settingsFor("mail.test", server.port), credential, {}, { ca: mailCertificate.cert }),
    ).resolves.toBe("authentication");
    await expectServerSocketsClosed(server);
  });

  it("verification requires SMTP STARTTLS before authentication", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const commands: string[] = [];
    const server = await startFakeServer(smtpSession(credential.password, commands));
    await expect(
      verifySmtpServerConnection(settingsFor("mail.test", server.port, "starttls"), credential),
    ).resolves.toBe("tls");
    expect(commands).not.toContain("AUTH");
    await expectServerSocketsClosed(server);
  });

  it("verification completes SMTP STARTTLS before authentication", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const names: string[] = [];
    const server = await startFakeServer(startTlsSession("smtp", mailCertificate, names));
    await expect(
      verifySmtpServerConnection(
        settingsFor("mail.test", server.port, "starttls"),
        credential,
        {},
        { ca: mailCertificate.cert },
      ),
    ).resolves.toBe("success");
    expect(names).toEqual(["mail.test"]);
    await expectServerSocketsClosed(server);
  });

  it("verification refuses a policy-denied SMTP address without dialing", async () => {
    stub = stubDnsLookup({ "internal.test": ["127.0.0.1"] });
    const server = await startFakeServer(smtpSession(credential.password));
    await expect(verifySmtpServerConnection(settingsFor("internal.test", server.port), credential)).resolves.toBe(
      "unreachable",
    );
    expect(server.connections()).toBe(0);
  });

  it("verification cancels a stalled SMTP greeting and closes its socket", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeServer((socket) => socket.resume());
    await expect(
      verifySmtpServerConnection(settingsFor("mail.test", server.port, "starttls"), credential, {}, { deadlineMs: 80 }),
    ).resolves.toBe("unreachable");
    await expectServerSocketsClosed(server);
  });

  it("uses the production fifteen-second SMTP deadline and observes socket closure", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeServer((socket) => socket.resume());
    const started = performance.now();
    await expect(
      verifySmtpServerConnection(settingsFor("mail.test", server.port, "starttls"), credential),
    ).resolves.toBe("unreachable");
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(14_000);
    expect(elapsed).toBeLessThan(25_000);
    await expectServerSocketsClosed(server);
  }, 30_000);

  it("verification rejects an invalid SMTP certificate without attempting authentication", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const commands: string[] = [];
    const server = await startFakeServer(smtpSession(credential.password, commands), otherCertificate);
    await expect(
      verifySmtpServerConnection(settingsFor("mail.test", server.port), credential, {}, { ca: otherCertificate.cert }),
    ).resolves.toBe("unreachable");
    expect(commands).not.toContain("AUTH");
  });

  it("verification rejects an invalid SMTP STARTTLS certificate before authentication", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const commands: string[] = [];
    const server = await startFakeServer(startTlsSession("smtp", otherCertificate, [], false, commands));
    await expect(
      verifySmtpServerConnection(
        settingsFor("mail.test", server.port, "starttls"),
        credential,
        {},
        { ca: otherCertificate.cert },
      ),
    ).resolves.toBe("unreachable");
    expect(commands).toContain("plain:STARTTLS");
    expect(commands).not.toContain("plain:AUTH");
    expect(commands).not.toContain("secure:AUTH");
    await expectServerSocketsClosed(server);
  });

  it("verification cancels a stalled SMTP STARTTLS handshake without authenticating", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const commands: string[] = [];
    const server = await startFakeServer(startTlsSession("smtp", mailCertificate, [], false, commands, true));
    await expect(
      verifySmtpServerConnection(settingsFor("mail.test", server.port, "starttls"), credential, {}, { deadlineMs: 80 }),
    ).resolves.toBe("unreachable");
    expect(commands).toContain("plain:STARTTLS");
    expect(commands).not.toContain("plain:AUTH");
    expect(commands).not.toContain("secure:AUTH");
    await expectServerSocketsClosed(server);
  });

  it("verification cancels a stalled SMTP TLS handshake and closes its socket", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const server = await startFakeServer((socket) => socket.resume());
    await expect(
      verifySmtpServerConnection(settingsFor("mail.test", server.port), credential, {}, { deadlineMs: 80 }),
    ).resolves.toBe("unreachable");
    await expectServerSocketsClosed(server);
  });

  it("verification cancels stalled SMTP authentication and closes its socket", async () => {
    useLoopbackPolicy();
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const commands: string[] = [];
    const server = await startFakeServer(smtpSession(credential.password, commands, true), mailCertificate);
    await expect(
      verifySmtpServerConnection(
        settingsFor("mail.test", server.port),
        credential,
        {},
        { deadlineMs: 80, ca: mailCertificate.cert },
      ),
    ).resolves.toBe("unreachable");
    expect(commands).toContain("AUTH");
    await expectServerSocketsClosed(server);
  });

  it("verification fences a late SMTP DNS result after its socket closes", async () => {
    useLoopbackPolicy();
    const server = await startFakeServer(smtpSession(credential.password), mailCertificate);
    const original = dns.lookup;
    let finishLookup: (() => void) | undefined;
    let signalLookup: () => void = () => {};
    const entered = new Promise<void>((resolve) => (signalLookup = resolve));
    const lookup = (host: string, ...args: unknown[]) => {
      if (host !== "held.test") return Reflect.apply(original, dns, [host, ...args]);
      const callback = args.at(-1);
      if (typeof callback !== "function") throw new Error("Missing DNS callback");
      finishLookup = () => {
        Reflect.apply(callback, undefined, [null, [{ address: "127.0.0.1", family: 4 }]]);
      };
      signalLookup();
    };
    Object.defineProperty(dns, "lookup", { value: lookup, configurable: true, writable: true });
    const work = verifySmtpServerConnection(settingsFor("held.test", server.port), credential, {}, { deadlineMs: 80 });
    try {
      await entered;
      await expect(work).resolves.toBe("unreachable");
      if (!finishLookup) throw new Error("DNS callback was not captured");
      finishLookup();
      finishLookup = undefined;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(server.connections()).toBe(0);
    } finally {
      finishLookup?.();
      await Promise.allSettled([work]);
      Object.defineProperty(dns, "lookup", { value: original, configurable: true, writable: true });
    }
  });
  it.each(["tls", "starttls"] as const)(
    "invokes its public-address policy lookup during the %s connector attempt",
    async (security) => {
      stub = stubDnsLookup({ "public.test": ["93.184.216.34"] });
      let selected: unknown;
      let hostname: string | undefined;
      vi.spyOn(net, "connect").mockImplementation(((options: net.TcpNetConnectOpts) => {
        hostname = options.host;
        const socket = new NetSocket();
        process.nextTick(() => {
          lookupThroughPolicy(options, "public.test").then(
            (address) => {
              selected = address;
              socket.destroy(Object.assign(new Error("test transport stopped"), { code: "ECONNREFUSED" }));
            },
            (error: unknown) => socket.destroy(error instanceof Error ? error : new Error("lookup failed")),
          );
        });
        return socket;
      }) as typeof net.connect);
      syncBuiltinESMExports();
      const transport = createSmtpTransporter(settingsFor("public.test", 587, security), credential);
      const error = await rejectionOf(transport.verify());
      transport.close();
      expect(error).toBeInstanceOf(MailServerUnreachableError);
      expect(hostname).toBe("public.test");
      expect(selected).toBe("93.184.216.34");
      expect(stub.calls).toEqual(["public.test"]);
    },
  );
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

  it("upgrades a local STARTTLS session, retains the host name and logs in", async () => {
    useLoopbackPolicy();
    trustCertificate(mailCertificate);
    const names: string[] = [];
    const server = await startFakeServer(startTlsSession("smtp", mailCertificate, names));
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const transport = createSmtpTransporter(settingsFor("mail.test", server.port, "starttls"), credential);
    expect(await transport.verify()).toBe(true);
    transport.close();
    expect(names).toEqual(["mail.test"]);
    expect(stub.calls).toEqual(["mail.test"]);
  });
});
