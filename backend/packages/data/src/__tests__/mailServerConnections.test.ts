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
  readonly connections: () => number;
  readonly secureConnections: () => number;
  readonly closedConnections: () => number;
  readonly serverNames: string[];
  close(): Promise<void>;
}

type Protocol = "imap" | "smtp";
type Session = (socket: Socket) => void;

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
        ...["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", keyPath, "-out", certPath],
        ...["-days", "1", "-subj", `/CN=${commonName}`],
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Makes `tls.connect` trust `certificate` for this test's connections, so only the name check can refuse. */
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

/** A loopback server that runs `session` per connection; with `certificate` it speaks TLS first. */
async function startFakeServer(session: Session, certificate?: TestCertificate): Promise<FakeServer> {
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
        trackSocket(sockets, socket);
        session(socket);
      });
  server.on("connection", (socket) => {
    connections += 1;
    socket.once("close", () => {
      closedConnections += 1;
    });
  });
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

/** A server that accepts connections and never answers. */
const stalledServer = () => startFakeServer((socket) => socket.resume());

async function closedPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = portOf(server);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Calls `onLine` for each CRLF-terminated line `socket` receives until `stop` returns true. */
function readLines(socket: Socket, onLine: (line: string) => boolean | void): void {
  let pending = "";
  const onData = (chunk: Buffer) => {
    pending += chunk.toString("utf8");
    let end = pending.indexOf("\r\n");
    while (end !== -1) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 2);
      if (onLine(line) === true) {
        socket.removeListener("data", onData);
        return;
      }
      end = pending.indexOf("\r\n");
    }
  };
  socket.on("data", onData);
}

function imapSession(password: string, commands: string[] = [], holdLogin = false): Session {
  return (socket) => {
    socket.write("* OK fake IMAP server ready\r\n");
    readLines(socket, (line) => {
      commands.push(line);
      if (!(holdLogin && /\bLOGIN\b/i.test(line))) socket.write(imapReply(line, password));
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
function smtpSession(password: string, received: string[] = [], holdAuth = false): Session {
  return (socket) => {
    socket.write("220 mail.test ESMTP fake\r\n");
    readLines(socket, (line) => {
      received.push((line.split(" ")[0] ?? "").toUpperCase());
      if (!(holdAuth && /^AUTH\b/i.test(line))) socket.write(smtpReply(line, password));
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

interface StartTlsOptions {
  /** Receives the SNI name of each upgraded connection. */
  names?: string[];
  /** Receives `plain:<command>` and `secure:<command>` for each command. */
  commands?: string[];
  /** Answers nothing after the upgrade, calling `onSecureData` instead. */
  holdSecure?: boolean;
  onSecureData?: () => void;
  /** Accepts STARTTLS but never starts the handshake. */
  holdHandshake?: boolean;
}

/** A plaintext server that offers STARTTLS and upgrades to TLS with `certificate`. */
function startTlsSession(protocol: Protocol, certificate: TestCertificate, options: StartTlsOptions = {}): Session {
  const { names = [], commands = [], holdSecure = false, holdHandshake = false, onSecureData } = options;
  const commandOf = (line: string) => {
    const words = line.split(" ");
    return { tag: words[0], command: (protocol === "imap" ? words[1] : words[0])?.toUpperCase() ?? "" };
  };
  const reply = (line: string) =>
    protocol === "imap" ? imapReply(line, credential.password) : smtpReply(line, credential.password);
  const context = () => tls.createSecureContext({ key: certificate.key, cert: certificate.cert });
  return (socket) => {
    socket.write(protocol === "imap" ? "* OK fake IMAP server ready\r\n" : "220 mail.test ESMTP fake\r\n");
    readLines(socket, (line) => {
      const { tag, command } = commandOf(line);
      commands.push(`plain:${command}`);
      if (command === "STARTTLS") {
        socket.write(protocol === "imap" ? `${tag} OK Begin TLS\r\n` : "220 Ready for TLS\r\n", () => {
          if (holdHandshake) {
            socket.resume();
            return;
          }
          const secure = new tls.TLSSocket(socket, {
            isServer: true,
            secureContext: context(),
            SNICallback: (name, done) => {
              names.push(name);
              done(null, context());
            },
          });
          secure.on("error", () => undefined);
          if (holdSecure) {
            secure.on("data", () => onSecureData?.());
            return;
          }
          readLines(secure, (secureLine) => {
            commands.push(`secure:${commandOf(secureLine).command}`);
            secure.write(reply(secureLine));
          });
        });
        return true;
      }
      if (protocol === "imap" && command === "CAPABILITY")
        socket.write(`* CAPABILITY IMAP4rev1 STARTTLS\r\n${tag} OK completed\r\n`);
      else if (protocol === "smtp" && command === "EHLO") socket.write("250-mail.test\r\n250 STARTTLS\r\n");
      else socket.write(reply(line));
    });
  };
}

function settingsFor(host: string, port: number, security: MailServerSecurity = "tls"): MailServerConnectionSettings {
  const endpoint: MailServerEndpoint = { host, port, security };
  return { endpoint, username };
}

function useLoopbackPolicy(): void {
  restorePolicy = allowLoopbackOutboundForTests();
}

/** The loopback policy with `mail.test` resolving to loopback. */
function useMailHost(): void {
  useLoopbackPolicy();
  stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
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

/**
 * Replaces `tls.connect` or `net.connect` with a socket that only runs the lookup the caller handed it
 * for `hostname`, then fails as refused. Returns what the connector was given and what the lookup chose.
 */
function connectThroughPolicy(
  module: "tls" | "net",
  hostname: string,
): { host?: string; servername?: unknown; selected?: unknown } {
  const seen: { host?: string; servername?: unknown; selected?: unknown } = {};
  const connect = (options: tls.ConnectionOptions) => {
    seen.host = options.host;
    seen.servername = Reflect.get(options, "servername");
    const socket = module === "tls" ? new tls.TLSSocket(new NetSocket()) : new NetSocket();
    process.nextTick(() => {
      lookupThroughPolicy(options, hostname).then(
        (address) => {
          seen.selected = address;
          socket.destroy(Object.assign(new Error("test transport stopped"), { code: "ECONNREFUSED" }));
        },
        (error: unknown) => socket.destroy(error instanceof Error ? error : new Error("lookup failed")),
      );
    });
    return socket;
  };
  if (module === "tls") vi.spyOn(tls, "connect").mockImplementation(connect as typeof tls.connect);
  else {
    vi.spyOn(net, "connect").mockImplementation(connect as unknown as typeof net.connect);
    syncBuiltinESMExports();
  }
  return seen;
}

/** Replaces `dns.lookup` for `host` only; returns the restore. */
function overrideDnsLookup(host: string, handle: (callback: (...args: unknown[]) => void) => void): () => void {
  const original = dns.lookup;
  const lookup = (name: string, ...args: unknown[]) => {
    if (name !== host) return Reflect.apply(original, dns, [name, ...args]);
    const callback = args.at(-1);
    if (typeof callback !== "function") throw new Error("Missing DNS callback");
    handle((...result: unknown[]) => Reflect.apply(callback, undefined, result));
  };
  Object.defineProperty(dns, "lookup", { value: lookup, configurable: true, writable: true });
  return () => Object.defineProperty(dns, "lookup", { value: original, configurable: true, writable: true });
}

/** Runs `test` with the application log captured, restoring the log stream and level whatever happens. */
async function withCapturedLog(level: string, test: (lines: string[]) => Promise<void>): Promise<void> {
  const stream = Object.getOwnPropertySymbols(logger).find((symbol) => symbol.description === "pino.stream");
  if (!stream) throw new Error("Missing application log stream");
  const previous: unknown = Reflect.get(logger, stream);
  const previousLevel = logger.level;
  const lines: string[] = [];
  const capture = {
    write: (line: string) => {
      lines.push(line);
      return true;
    },
  };
  if (!Reflect.set(logger, stream, capture)) throw new Error("Could not capture application log stream");
  const failures: unknown[] = [];
  try {
    logger.level = level;
    await test(lines);
  } catch (error) {
    failures.push(error);
  }
  for (const restore of [
    () => {
      logger.level = previousLevel;
    },
    () => {
      if (!Reflect.set(logger, stream, previous)) throw new Error("Could not restore application log stream");
    },
  ]) {
    try {
      restore();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "IMAP diagnostic test and log cleanup failed");
}

/** Wraps `ImapFlow.prototype.connect`, observing the client before and after the real connect starts. */
function spyImapConnect(hooks: {
  before?: (client: ImapFlow) => void;
  started?: (client: ImapFlow, socket: NetSocket) => void;
  rejected?: (error: unknown, client: ImapFlow) => void;
}): void {
  const originalConnect: unknown = Object.getOwnPropertyDescriptor(ImapFlow.prototype, "connect")?.value;
  if (typeof originalConnect !== "function") throw new Error("Missing ImapFlow connect method");
  vi.spyOn(ImapFlow.prototype, "connect").mockImplementation(function (this: ImapFlow) {
    hooks.before?.(this);
    const operation: unknown = Reflect.apply(originalConnect, this, []);
    if (!(operation instanceof Promise)) throw new Error("Missing connect promise");
    if (hooks.started) {
      const socket: unknown = Object.getOwnPropertyDescriptor(this, "socket")?.value;
      if (!(socket instanceof NetSocket)) throw new Error("Missing owned socket");
      hooks.started(this, socket);
    }
    return operation.then(
      () => undefined,
      (error: unknown) => {
        hooks.rejected?.(error, this);
        throw error;
      },
    );
  });
}

/** Makes the first `ImapFlow.close` throw `failure`; later calls close normally. */
function failFirstImapClose(failure: Error): { injected: () => number } {
  const originalClose: unknown = Object.getOwnPropertyDescriptor(ImapFlow.prototype, "close")?.value;
  if (typeof originalClose !== "function") throw new Error("Missing ImapFlow close method");
  let injected = 0;
  vi.spyOn(ImapFlow.prototype, "close").mockImplementation(function (this: ImapFlow) {
    if (injected === 0) {
      injected += 1;
      throw failure;
    }
    Reflect.apply(originalClose, this, []);
  });
  return { injected: () => injected };
}

/** Calls `handle` on the first `destroy(error)` of `socket`, then destroys it unless `handle` throws. */
function onFirstErroredDestroy(socket: NetSocket, handle: (error: Error) => void): void {
  const destroy = socket.destroy.bind(socket);
  let seen = false;
  vi.spyOn(socket, "destroy").mockImplementation((error?: Error) => {
    if (error && !seen) {
      seen = true;
      handle(error);
    }
    return destroy(error);
  });
}

function verifyCredentials(password: string, options: Parameters<typeof verifyMailCredentialsForTests>[1]) {
  return verifyMailCredentialsForTests(
    { provider: "generic", address: username, username, password, imapHost: "mail.test", smtpHost: "mail.test" },
    options,
  );
}

const VERIFY = { imap: verifyImapServerConnection, smtp: verifySmtpServerConnection } as const;
const SESSION = { imap: imapSession, smtp: smtpSession } as const;

/** Verifies the `mail.test` endpoint at `port` with the test-only options. */
function verify(
  protocol: Protocol,
  port: number,
  security: MailServerSecurity = "tls",
  testOptions?: { deadlineMs?: number; ca?: string },
) {
  return VERIFY[protocol](settingsFor("mail.test", port, security), credential, {}, testOptions);
}

const loginSent = (commands: string[]) => commands.some((line) => /\b(LOGIN|AUTH)\b/i.test(line));

describe("mail credential verification", () => {
  it("verifies both protocols through real helpers and falls back to STARTTLS", async () => {
    useMailHost();
    const imapNames: string[] = [];
    const smtpNames: string[] = [];
    const imap = await startFakeServer(startTlsSession("imap", mailCertificate, { names: imapNames }));
    const smtp = await startFakeServer(startTlsSession("smtp", mailCertificate, { names: smtpNames }));
    const refused = await closedPort();
    await expect(
      verifyCredentials(credential.password, {
        ca: mailCertificate.cert,
        deadlineMs: 1_000,
        ports: { 993: refused, 143: imap.port, 465: refused, 587: smtp.port },
      }),
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
    useMailHost();
    const imap = await startFakeServer(imapSession("correct-password"), mailCertificate);
    const upgrade = await startFakeServer(startTlsSession("imap", mailCertificate));
    const smtp = await startFakeServer(smtpSession(credential.password), mailCertificate);
    const rejectedPassword = "SENTINEL-WRONG-PASSWORD";
    const error = await rejectionOf(
      verifyCredentials(rejectedPassword, {
        ca: mailCertificate.cert,
        deadlineMs: 1_000,
        ports: { 993: imap.port, 143: upgrade.port, 465: smtp.port, 587: smtp.port },
      }),
    );
    expect(error).toBeInstanceOf(MailAuthFailedError);
    if (!(error instanceof Error)) throw new Error("Missing authentication error");
    expect(`${error.message} ${error.stack} ${JSON.stringify(error)}`).not.toContain(rejectedPassword);
    expect(smtp.connections()).toBe(0);
    await expectServerSocketsClosed(imap);
    await expectServerSocketsClosed(upgrade);
  });

  it("returns unreachable after both real IMAP candidates expire and closes both sockets", async () => {
    useMailHost();
    const stalledTls = await stalledServer();
    const stalledGreeting = await stalledServer();
    await expect(
      verifyCredentials(credential.password, {
        deadlineMs: 80,
        ports: { 993: stalledTls.port, 143: stalledGreeting.port },
      }),
    ).rejects.toBeInstanceOf(MailServerUnreachableError);
    await expectServerSocketsClosed(stalledTls);
    await expectServerSocketsClosed(stalledGreeting);
  });

  it.each<Protocol>(["imap", "smtp"])(
    "enforces the production deadline for each real %s candidate",
    async (protocol) => {
      useMailHost();
      const imap =
        protocol === "smtp" ? await startFakeServer(imapSession(credential.password), mailCertificate) : undefined;
      const stalledTls = await stalledServer();
      const stalledGreeting = await stalledServer();
      const ports: Record<number, number> = imap
        ? { 993: imap.port, 465: stalledTls.port, 587: stalledGreeting.port }
        : { 993: stalledTls.port, 143: stalledGreeting.port };
      const started = performance.now();
      await expect(
        verifyCredentials(credential.password, { ...(imap ? { ca: mailCertificate.cert } : {}), ports }),
      ).rejects.toBeInstanceOf(MailServerUnreachableError);
      expect(performance.now() - started).toBeGreaterThanOrEqual(29_000);
      expect(stalledTls.connections()).toBe(1);
      expect(stalledGreeting.connections()).toBe(1);
      for (const server of [imap, stalledTls, stalledGreeting]) if (server) await expectServerSocketsClosed(server);
    },
    40_000,
  );
});

interface VerificationCase {
  title: string;
  protocol: Protocol;
  /** `implicit` speaks TLS first, `plain` never offers STARTTLS, `stalled` never answers, `silent` completes TLS and never greets. */
  server: "implicit" | "plain" | "starttls" | "stalled" | "silent";
  certificate?: "mail" | "other";
  password?: string;
  holdLogin?: boolean;
  holdSecure?: boolean;
  holdHandshake?: boolean;
  security?: MailServerSecurity;
  deadline?: boolean;
  ca?: "mail" | "other";
  expected: "success" | "authentication" | "tls" | "unreachable";
  /** Whether a login or AUTH command reached the server; `none` means no command at all. */
  login?: "sent" | "absent" | "none";
  secureConnections?: number;
  /** The connection upgraded with STARTTLS under the host name. */
  upgradedAs?: boolean;
  /** The client sent STARTTLS. */
  startTlsSent?: boolean;
}

const VERIFICATION_CASES: VerificationCase[] = [
  {
    title: "classifies required STARTTLS refusal before login",
    protocol: "imap",
    server: "plain",
    security: "starttls",
    expected: "tls",
    login: "absent",
  },
  {
    title: "authenticates over TLS and closes the connection",
    protocol: "imap",
    server: "implicit",
    ca: "mail",
    expected: "success",
    login: "sent",
    secureConnections: 1,
  },
  {
    title: "rejects an invalid certificate before login",
    protocol: "imap",
    server: "implicit",
    certificate: "other",
    ca: "other",
    expected: "tls",
    login: "none",
    secureConnections: 0,
  },
  {
    title: "identifies a rejected login after TLS",
    protocol: "imap",
    server: "implicit",
    password: "another-password",
    ca: "mail",
    expected: "authentication",
  },
  {
    title: "owns both sockets when STARTTLS replaces the initial socket",
    protocol: "imap",
    server: "starttls",
    security: "starttls",
    ca: "mail",
    expected: "success",
    upgradedAs: true,
  },
  {
    title: "cancels a stalled initial TLS handshake and closes the socket",
    protocol: "imap",
    server: "stalled",
    deadline: true,
    expected: "unreachable",
  },
  {
    title: "cancels a stalled greeting and closes the TLS socket",
    protocol: "imap",
    server: "silent",
    deadline: true,
    ca: "mail",
    expected: "unreachable",
    secureConnections: 1,
  },
  {
    title: "cancels a stalled login and closes the TLS socket",
    protocol: "imap",
    server: "implicit",
    holdLogin: true,
    deadline: true,
    ca: "mail",
    expected: "unreachable",
    login: "sent",
  },
  {
    title: "cancels a stalled session after STARTTLS socket replacement",
    protocol: "imap",
    server: "starttls",
    holdSecure: true,
    security: "starttls",
    deadline: true,
    ca: "mail",
    expected: "unreachable",
    upgradedAs: true,
  },
  {
    title: "cancels a stalled STARTTLS handshake without login",
    protocol: "imap",
    server: "starttls",
    holdHandshake: true,
    security: "starttls",
    deadline: true,
    expected: "unreachable",
    login: "absent",
    startTlsSent: true,
  },
  {
    title: "authenticates through SMTP over implicit TLS",
    protocol: "smtp",
    server: "implicit",
    ca: "mail",
    expected: "success",
    login: "sent",
  },
  {
    title: "classifies SMTP authentication refusal",
    protocol: "smtp",
    server: "implicit",
    password: "another-password",
    ca: "mail",
    expected: "authentication",
  },
  {
    title: "requires SMTP STARTTLS before authentication",
    protocol: "smtp",
    server: "plain",
    security: "starttls",
    expected: "tls",
    login: "absent",
  },
  {
    title: "completes SMTP STARTTLS before authentication",
    protocol: "smtp",
    server: "starttls",
    security: "starttls",
    ca: "mail",
    expected: "success",
    upgradedAs: true,
  },
  {
    title: "cancels a stalled SMTP greeting and closes its socket",
    protocol: "smtp",
    server: "stalled",
    security: "starttls",
    deadline: true,
    expected: "unreachable",
  },
  {
    title: "rejects an invalid SMTP certificate without attempting authentication",
    protocol: "smtp",
    server: "implicit",
    certificate: "other",
    ca: "other",
    expected: "unreachable",
    login: "absent",
  },
  {
    title: "rejects an invalid SMTP STARTTLS certificate before authentication",
    protocol: "smtp",
    server: "starttls",
    certificate: "other",
    security: "starttls",
    ca: "other",
    expected: "unreachable",
    login: "absent",
    startTlsSent: true,
  },
  {
    title: "cancels a stalled SMTP STARTTLS handshake without authenticating",
    protocol: "smtp",
    server: "starttls",
    holdHandshake: true,
    security: "starttls",
    deadline: true,
    expected: "unreachable",
    login: "absent",
    startTlsSent: true,
  },
  {
    title: "cancels a stalled SMTP TLS handshake and closes its socket",
    protocol: "smtp",
    server: "stalled",
    deadline: true,
    expected: "unreachable",
  },
  {
    title: "cancels stalled SMTP authentication and closes its socket",
    protocol: "smtp",
    server: "implicit",
    holdLogin: true,
    deadline: true,
    ca: "mail",
    expected: "unreachable",
    login: "sent",
  },
];

describe("verifyImapServerConnection and verifySmtpServerConnection", () => {
  it.each(VERIFICATION_CASES)("$protocol verification $title", async (testCase) => {
    useMailHost();
    const certificate = testCase.certificate === "other" ? otherCertificate : mailCertificate;
    const commands: string[] = [];
    const names: string[] = [];
    const password = testCase.password ?? credential.password;
    const server =
      testCase.server === "stalled"
        ? await stalledServer()
        : testCase.server === "silent"
          ? await startFakeServer(() => {}, certificate)
          : testCase.server === "starttls"
            ? await startFakeServer(
                startTlsSession(testCase.protocol, certificate, {
                  names,
                  commands,
                  holdSecure: testCase.holdSecure,
                  holdHandshake: testCase.holdHandshake,
                }),
              )
            : await startFakeServer(
                SESSION[testCase.protocol](password, commands, testCase.holdLogin),
                testCase.server === "implicit" ? certificate : undefined,
              );
    const ca =
      testCase.ca === undefined ? undefined : testCase.ca === "mail" ? mailCertificate.cert : otherCertificate.cert;
    const testOptions =
      ca === undefined && !testCase.deadline
        ? undefined
        : { ...(ca === undefined ? {} : { ca }), ...(testCase.deadline ? { deadlineMs: 80 } : {}) };

    await expect(verify(testCase.protocol, server.port, testCase.security, testOptions)).resolves.toBe(
      testCase.expected,
    );
    if (testCase.login === "none") expect(commands).toEqual([]);
    if (testCase.login !== undefined && testCase.login !== "none")
      expect(loginSent(commands)).toBe(testCase.login === "sent");
    if (testCase.startTlsSent) expect(commands).toContain("plain:STARTTLS");
    if (testCase.secureConnections !== undefined) expect(server.secureConnections()).toBe(testCase.secureConnections);
    if (testCase.upgradedAs) expect(names).toEqual(["mail.test"]);
    await expectServerSocketsClosed(server);
  });

  it.each<Protocol>(["imap", "smtp"])(
    "%s verification uses the production fifteen-second deadline and observes socket closure",
    async (protocol) => {
      useMailHost();
      const server = await stalledServer();
      const started = performance.now();
      await expect(verify(protocol, server.port, protocol === "smtp" ? "starttls" : "tls")).resolves.toBe(
        "unreachable",
      );
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(14_000);
      expect(elapsed).toBeLessThan(25_000);
      await expectServerSocketsClosed(server);
    },
    30_000,
  );

  it.each<Protocol>(["imap", "smtp"])(
    "%s verification refuses a policy-denied address without dialing",
    async (protocol) => {
      stub = stubDnsLookup({ "internal.test": ["127.0.0.1"] });
      const server = await startFakeServer(SESSION[protocol](credential.password));
      await expect(VERIFY[protocol](settingsFor("internal.test", server.port), credential)).resolves.toBe(
        "unreachable",
      );
      expect(server.connections()).toBe(0);
    },
  );

  it.each<Protocol>(["imap", "smtp"])(
    "%s verification settles the owned socket before discarding a late DNS result",
    async (protocol) => {
      useLoopbackPolicy();
      const server = await startFakeServer(SESSION[protocol](credential.password), mailCertificate);
      let finishLookup: (() => void) | undefined;
      let signalLookup: () => void = () => {};
      const entered = new Promise<void>((resolve) => (signalLookup = resolve));
      const restoreLookup = overrideDnsLookup("held.test", (callback) => {
        finishLookup = () => callback(null, [{ address: "127.0.0.1", family: 4 }]);
        signalLookup();
      });
      const work = VERIFY[protocol](settingsFor("held.test", server.port), credential, {}, { deadlineMs: 80 });
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
        restoreLookup();
      }
    },
  );
});

describe("IMAP verification failure and cleanup accounting", () => {
  it("does not claim successful verification when final client cleanup fails", async () => {
    useMailHost();
    const server = await startFakeServer(imapSession(credential.password), mailCertificate);
    const cleanupFailure = new Error("IMAP-CLEANUP-SENTINEL");
    const close = failFirstImapClose(cleanupFailure);
    expect(await rejectionOf(verify("imap", server.port, "tls", { ca: mailCertificate.cert }))).toBe(cleanupFailure);
    expect(close.injected()).toBe(1);
    await expectServerSocketsClosed(server);
  });

  it("retains the actual connection rejection and an independent cleanup failure through settlement", async () => {
    useMailHost();
    const commands: string[] = [];
    const server = await startFakeServer(imapSession(credential.password, commands), otherCertificate);
    let rejection: { value: unknown } | undefined;
    spyImapConnect({ rejected: (error) => (rejection = { value: error }) });
    const cleanup = new Error("independent cleanup sentinel");
    failFirstImapClose(cleanup);
    const outcome = await rejectionOf(verify("imap", server.port, "tls", { ca: otherCertificate.cert }));
    if (!(outcome instanceof AggregateError) || !rejection) throw new Error("Missing combined failure");
    expect(outcome.errors).toContain(rejection.value);
    expect(outcome.errors).toContain(cleanup);
    expect(commands).toEqual([]);
    await expectServerSocketsClosed(server);
  });

  it("does not claim clean cancellation when destroying the owned socket fails", async () => {
    useMailHost();
    const session = imapSession(credential.password, [], true);
    const server = await startFakeServer((socket) => {
      session(socket);
      setTimeout(() => socket.destroy(), 250);
    }, mailCertificate);
    const destroyFailure = new Error("owned destroy failed");
    let injected = false;
    let actualRejection: { value: unknown } | undefined;
    spyImapConnect({
      started: (_client, socket) =>
        onFirstErroredDestroy(socket, () => {
          injected = true;
          throw destroyFailure;
        }),
      rejected: (error) => (actualRejection = { value: error }),
    });
    const outcome = await rejectionOf(verify("imap", server.port, "tls", { deadlineMs: 80, ca: mailCertificate.cert }));
    expect(injected).toBe(true);
    if (!(outcome instanceof AggregateError) || !actualRejection) throw new Error("Missing unsettled failure");
    expect(outcome.errors).toContain(destroyFailure);
    expect(outcome.errors).toContain(actualRejection.value);
    await expectServerSocketsClosed(server);
  });

  it("preserves independently observed secondary values and logs only safe ordered diagnostics for an owned cancellation", async () => {
    useMailHost();
    const server = await startFakeServer(imapSession(credential.password, [], true), mailCertificate);
    const secondary = new Error("SENTINEL-SECONDARY-SECRET");
    let owner: Error | undefined;
    let rejected: { value: unknown } | undefined;
    const emitted: unknown[] = [];
    const observeEmission = (value: unknown) => emitted.push(value);
    const observedClients: ImapFlow[] = [];
    spyImapConnect({
      before: (client) => {
        observedClients.push(client);
        client.on("error", observeEmission);
      },
      started: (client, socket) =>
        onFirstErroredDestroy(socket, (error) => {
          owner = error;
          client.emit("error", secondary);
          client.emit("error", undefined);
        }),
      rejected: (error) => (rejected = { value: error }),
    });
    await withCapturedLog(logger.level, async (logged) => {
      try {
        await expect(verify("imap", server.port, "tls", { deadlineMs: 80, ca: mailCertificate.cert })).resolves.toBe(
          "unreachable",
        );
        await expectServerSocketsClosed(server);
        expect(owner).toBeInstanceOf(Error);
        expect(rejected).toEqual({ value: owner });
        expect(emitted).toHaveLength(3);
        expect(emitted[0]).toBe(secondary);
        expect(emitted[1]).toBeUndefined();
        expect(emitted[2]).toBeInstanceOf(Error);
        expect(emitted[2]).not.toBe(owner);
        expect(logged).toHaveLength(1);
        expect(logged[0]).not.toContain("SENTINEL-SECONDARY-SECRET");
        expect(logged[0]).not.toContain(credential.password);
        expect(JSON.parse(logged[0] ?? "null")).toMatchObject({
          count: 3,
          observations: [
            { order: 1, source: "client", category: "error" },
            { order: 2, source: "client", category: "non_error" },
            { order: 3, source: "client", category: "error" },
          ],
        });
      } finally {
        for (const client of observedClients) client.removeListener("error", observeEmission);
        vi.restoreAllMocks();
      }
    });
  });

  it("does not report a successful diagnostic when error logging is disabled", async () => {
    useMailHost();
    const server = await startFakeServer(imapSession(credential.password, [], true), mailCertificate);
    vi.spyOn(logger, "isLevelEnabled").mockReturnValue(false);
    const failure = await rejectionOf(verify("imap", server.port, "tls", { deadlineMs: 80, ca: mailCertificate.cert }));
    if (!(failure instanceof AggregateError)) throw new Error("Missing diagnostic failure");
    expect(failure.errors.length).toBeGreaterThanOrEqual(2);
    await expectServerSocketsClosed(server);
  });

  it("does not claim clean STARTTLS teardown when the replacement socket destroy fails", async () => {
    useMailHost();
    const failure = new Error("STARTTLS wrapper destroy failed");
    let client: ImapFlow | undefined;
    let initial: NetSocket | undefined;
    let initialClosed = false;
    let replacement: tls.TLSSocket | undefined;
    let injected = false;
    let rejected: { value: unknown } | undefined;
    spyImapConnect({
      started: (owner, socket) => {
        client = owner;
        initial = socket;
        socket.once("close", () => {
          initialClosed = true;
        });
      },
      rejected: (error) => (rejected = { value: error }),
    });
    const server = await startFakeServer((socket) => {
      const session = startTlsSession("imap", mailCertificate, {
        holdSecure: true,
        onSecureData: () => {
          if (replacement || !client) return;
          const candidate: unknown = Object.getOwnPropertyDescriptor(client, "socket")?.value;
          if (!(candidate instanceof tls.TLSSocket) || candidate === initial) return;
          replacement = candidate;
          onFirstErroredDestroy(candidate, () => {
            injected = true;
            throw failure;
          });
          setTimeout(() => socket.destroy(), 250);
        },
      });
      session(socket);
    });
    const outcome = await rejectionOf(
      verify("imap", server.port, "starttls", { deadlineMs: 100, ca: mailCertificate.cert }),
    );
    expect(replacement).toBeInstanceOf(tls.TLSSocket);
    expect(injected).toBe(true);
    expect(initialClosed).toBe(true);
    if (!(outcome instanceof AggregateError) || !rejected) throw new Error("Missing STARTTLS teardown failure");
    expect(outcome.errors).toContain(failure);
    expect(outcome.errors).toContain(rejected.value);
    await expectServerSocketsClosed(server);
  });

  it("rejects an invalid IMAP STARTTLS certificate before login and closes both sockets", async () => {
    useMailHost();
    const commands: string[] = [];
    const server = await startFakeServer(startTlsSession("imap", otherCertificate, { commands }));
    let initial: NetSocket | undefined;
    let replacement: unknown;
    let initialCloseObserved = false;
    spyImapConnect({
      started: (_client, socket) => {
        initial = socket;
        socket.once("close", () => {
          initialCloseObserved = true;
        });
      },
      rejected: (_error, client) => {
        replacement = Object.getOwnPropertyDescriptor(client, "socket")?.value;
      },
    });
    await expect(verify("imap", server.port, "starttls", { ca: otherCertificate.cert })).resolves.toBe("tls");
    expect(initialCloseObserved).toBe(true);
    if (!(replacement instanceof tls.TLSSocket)) throw new Error("Missing STARTTLS wrapper");
    expect(replacement).not.toBe(initial);
    expect(replacement.closed).toBe(true);
    expect(commands).toContain("plain:STARTTLS");
    expect(loginSent(commands)).toBe(false);
    await expectServerSocketsClosed(server);
  });

  // Runs after the close-failure tests, so that its client, still closing once the test ends, cannot
  // consume their injected close failure.
  it("serializes fixed connection diagnostics without an emitted error's secrets or host", async () => {
    stub = stubDnsLookup({ "mail.test": ["127.0.0.1"] });
    const original = Object.assign(new Error("IMAP-PRIVATE-SENTINEL"), {
      name: "IMAP-PRIVATE-SENTINEL",
      code: "IMAP-PRIVATE-SENTINEL",
    });
    let emitted: unknown;
    spyImapConnect({
      before: (client) => {
        emitted = original;
        client.emit("error", original);
      },
    });
    await withCapturedLog("warn", async (lines) => {
      const result = await rejectionOf(openImapFlow(settingsFor("mail.test", 993), credential));
      expect(result).toBeInstanceOf(MailServerUnreachableError);
      expect(emitted).toBe(original);
      expect(lines.some((line) => line.includes('"stage":"connect_event"'))).toBe(true);
      for (const secret of ["IMAP-PRIVATE-SENTINEL", "mail.test", credential.password])
        expect(lines.join("\n")).not.toContain(secret);
    });
  });

  it("preserves an unrelated actual connect failure that occurs before cancellation", async () => {
    const failure = Object.assign(new Error("Unrelated DNS failure"), { code: "EUNRELATED" });
    const restoreLookup = overrideDnsLookup("prior.test", (callback) => process.nextTick(() => callback(failure, [])));
    try {
      expect(await rejectionOf(verifyImapServerConnection(settingsFor("prior.test", 993), credential))).toBe(failure);
    } finally {
      restoreLookup();
    }
  });
});

/** Each connector opens `settings` and, for SMTP, also closes the transport it created. */
const CONNECTORS = {
  openImapConnection: (settings: MailServerConnectionSettings) => openImapConnection(settings, credential),
  openImapFlow: (settings: MailServerConnectionSettings) => openImapFlow(settings, credential),
  "SMTP verify": async (settings: MailServerConnectionSettings) => {
    const transport = createSmtpTransporter(settings, credential);
    try {
      return await transport.verify();
    } finally {
      transport.close();
    }
  },
  "SMTP send": (settings: MailServerConnectionSettings) =>
    createSmtpTransporter(settings, credential).sendMail({
      from: username,
      to: "someone@mail.test",
      subject: "hello",
      text: "hello",
    }),
} as const;
type ConnectorName = keyof typeof CONNECTORS;
const protocolOf = (name: ConnectorName): Protocol => (name.startsWith("SMTP") ? "smtp" : "imap");

describe("outbound address policy of the mail connectors", () => {
  it.each(
    (Object.keys(CONNECTORS) as ConnectorName[]).flatMap((connector) =>
      ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1"].map((address) => ({ connector, address })),
    ),
  )(
    "$connector refuses a name that resolves to $address under the default policy, with the unreachable error and no connection",
    async ({ connector, address }) => {
      stub = stubDnsLookup({ "internal.test": [address] });
      const server = await startFakeServer(SESSION[protocolOf(connector)](credential.password));
      expect(await rejectionOf(CONNECTORS[connector](settingsFor("internal.test", server.port)))).toBeInstanceOf(
        MailServerUnreachableError,
      );
      expect(server.connections()).toBe(0);
    },
  );

  it.each<ConnectorName>(["openImapConnection", "SMTP verify"])(
    "%s refuses an IP-literal host under the default policy before any connection is made",
    async (connector) => {
      const server = await startFakeServer(SESSION[protocolOf(connector)](credential.password));
      for (const host of ["127.0.0.1", "93.184.216.34"]) {
        expect(await rejectionOf(CONNECTORS[connector](settingsFor(host, server.port)))).toBeInstanceOf(
          MailServerUnreachableError,
        );
      }
      expect(server.connections()).toBe(0);
    },
  );

  it.each<ConnectorName>(["openImapConnection", "SMTP verify"])(
    "%s answers a refused address exactly like a closed port, naming neither the address nor a cause, and resolves the name once",
    async (connector) => {
      const port = await closedPort();
      useLoopbackPolicy();
      stub = stubDnsLookup({ "closed.test": ["127.0.0.1"] });
      const closed = await rejectionOf(CONNECTORS[connector](settingsFor("closed.test", port)));
      expect(stub.calls).toEqual(["closed.test"]);
      restorePolicy?.();
      restorePolicy = undefined;

      stub.restore();
      stub = stubDnsLookup({ "refused.test": ["127.0.0.1"] });
      const refused = await rejectionOf(CONNECTORS[connector](settingsFor("refused.test", port)));

      expect(closed).toBeInstanceOf(MailServerUnreachableError);
      expect(refused).toEqual(closed);
      expect(refused).toMatchObject({ code: "mail_server_unreachable", name: "MailServerUnreachableError" });
      if (!(refused instanceof Error)) throw new Error("Missing refusal");
      expect(refused.cause).toBeUndefined();
      expect(refused.message).not.toContain("127.0.0.1");
    },
  );

  it.each([
    { connector: "openImapConnection", module: "tls", port: 993, security: "tls", servername: true },
    { connector: "openImapConnection", module: "net", port: 143, security: "starttls", servername: true },
    { connector: "SMTP verify", module: "net", port: 587, security: "tls", servername: false },
    { connector: "SMTP verify", module: "net", port: 587, security: "starttls", servername: false },
  ] as const)(
    "$connector hands the $security connector the policy lookup, which vets a public address and keeps the host name",
    async ({ connector, module, port, security, servername }) => {
      stub = stubDnsLookup({ "public.test": ["93.184.216.34"] });
      const seen = connectThroughPolicy(module, "public.test");
      const error = await rejectionOf(CONNECTORS[connector](settingsFor("public.test", port, security)));
      expect(error).toBeInstanceOf(MailServerUnreachableError);
      expect(seen.host).toBe("public.test");
      if (servername) expect(seen.servername).toBe("public.test");
      expect(seen.selected).toBe("93.184.216.34");
      expect(stub.calls).toEqual(["public.test"]);
    },
  );
});

describe.each<{ connector: ConnectorName; opened: (result: unknown) => void; authFailure: Record<string, unknown> }>([
  {
    connector: "openImapConnection",
    opened: (client) => expect(client).toBeInstanceOf(ImapFlowMailClient),
    authFailure: { authenticationFailed: true },
  },
  {
    connector: "SMTP verify",
    opened: (verified) => expect(verified).toBe(true),
    authFailure: { code: "EAUTH" },
  },
])("$connector against a loopback mail server", ({ connector, opened, authFailure }) => {
  const protocol = protocolOf(connector);
  const open = (port: number, security?: MailServerSecurity) =>
    CONNECTORS[connector](settingsFor("mail.test", port, security));

  it("connects to the vetted address with the host name as the TLS server name, then logs in", async () => {
    useMailHost();
    trustCertificate(mailCertificate);
    const server = await startFakeServer(SESSION[protocol](credential.password), mailCertificate);
    opened(await open(server.port));
    expect(server.secureConnections()).toBe(1);
    expect(server.serverNames).toEqual(["mail.test"]);
    expect(stub?.calls).toEqual(["mail.test"]);
  });

  it("refuses a certificate issued for another name, and never completes the handshake", async () => {
    useMailHost();
    trustCertificate(otherCertificate);
    const server = await startFakeServer(SESSION[protocol](credential.password), otherCertificate);
    expect(await rejectionOf(open(server.port))).toBeInstanceOf(MailServerUnreachableError);
    expect(server.serverNames).toEqual(["mail.test"]);
    expect(server.secureConnections()).toBe(0);
  });

  it("reports a rejected login as an authentication failure, not as unreachable", async () => {
    useMailHost();
    trustCertificate(mailCertificate);
    const server = await startFakeServer(SESSION[protocol]("the-right-password"), mailCertificate);
    const error = await rejectionOf(open(server.port));
    expect(error).not.toBeInstanceOf(MailServerUnreachableError);
    expect(error).toMatchObject(authFailure);
  });

  it("requires STARTTLS for starttls endpoints, and maps a server that does not offer it as a TLS failure", async () => {
    useMailHost();
    const received: string[] = [];
    const server = await startFakeServer(SESSION[protocol](credential.password, received));
    expect(await rejectionOf(open(server.port, "starttls"))).toBeInstanceOf(MailServerUnreachableError);
    if (protocol === "smtp") expect(received).toContain("STARTTLS");
    expect(server.secureConnections()).toBe(0);
  });

  it("upgrades a local STARTTLS session, retains the host name and logs in", async () => {
    useMailHost();
    trustCertificate(mailCertificate);
    const names: string[] = [];
    const server = await startFakeServer(startTlsSession(protocol, mailCertificate, { names }));
    opened(await open(server.port, "starttls"));
    expect(names).toEqual(["mail.test"]);
    expect(stub?.calls).toEqual(["mail.test"]);
  });
});

describe("openImapFlow", () => {
  /**
   * imapflow 1.7.6 stores the idle options as the client's own `maxIdleTime` and `socketTimeout` fields,
   * undeclared in its typings. They are the only observable effect of those options, so the tests read them.
   */
  it.each([
    {
      title: "forwards maxIdleTime and socketTimeout",
      options: { maxIdleTime: 25 * 60_000, socketTimeout: 35 * 60_000 },
    },
    { title: "keeps imapflow's own defaults when the idle options are not given", options: undefined },
  ])("resolves with a connected, logged-in client and $title", async ({ options }) => {
    useMailHost();
    trustCertificate(mailCertificate);
    const server = await startFakeServer(imapSession(credential.password), mailCertificate);
    const client = await openImapFlow(settingsFor("mail.test", server.port), credential, options);
    try {
      expect(client).toBeInstanceOf(ImapFlow);
      expect(client.usable).toBe(true);
      expect(client.authenticated).toBeTruthy();
      expect(Reflect.get(client, "maxIdleTime")).toBe(options?.maxIdleTime ?? false);
      expect(Reflect.get(client, "socketTimeout")).toBe(options?.socketTimeout ?? 5 * 60_000);
    } finally {
      client.close();
    }
  });
});
