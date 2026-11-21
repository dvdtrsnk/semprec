import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";

// Loopback mail servers with a fixed delay per connection and per response, standing in for a remote provider's
// TLS handshake and round trips. They are reached only under the test-only loopback policy; the certificate is made
// with the openssl CLI at test time, so nothing sensitive is committed.

export interface TestCertificate {
  readonly key: string;
  readonly cert: string;
}

export function makeTestCertificate(commonName: string): TestCertificate {
  const dir = mkdtempSync(join(tmpdir(), "latent-mail-"));
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

/** One accepted connection: when it was accepted and, once it closed, when. */
export interface ConnectionSpan {
  readonly openedAt: number;
  closedAt: number | null;
}

export interface LatentServer {
  readonly port: number;
  /** Every connection accepted, in order. */
  readonly connections: readonly ConnectionSpan[];
  /** Resolves once every accepted connection has closed, or rejects after `timeoutMs`. */
  allClosed(timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listenLatent(
  certificate: TestCertificate,
  connectLatencyMs: number,
  session: (socket: tls.TLSSocket) => void,
): Promise<LatentServer> {
  const connections: ConnectionSpan[] = [];
  const sockets = new Set<Socket>();
  const server = tls.createServer({ key: certificate.key, cert: certificate.cert }, (secure) => {
    const span: ConnectionSpan = { openedAt: performance.now(), closedAt: null };
    connections.push(span);
    sockets.add(secure);
    secure.on("error", () => undefined);
    secure.once("close", () => {
      span.closedAt = performance.now();
      sockets.delete(secure);
    });
    // The handshake cost of a remote server, paid before the first byte of the session.
    void delay(connectLatencyMs).then(() => {
      if (!secure.destroyed) session(secure);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No loopback port");
  return {
    port: address.port,
    connections,
    async allClosed(timeoutMs = 2_000) {
      const until = performance.now() + timeoutMs;
      while (connections.some((span) => span.closedAt === null)) {
        if (performance.now() > until) throw new Error("A connection to the fake server is still open");
        await delay(5);
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/**
 * Implicit TLS in front of a plaintext loopback server (a `FakeImapServer`): each accepted connection waits
 * `connectLatencyMs`, then is piped to `targetPort`; either side closing closes the other.
 */
export function startTlsFront(
  targetPort: number,
  certificate: TestCertificate,
  connectLatencyMs: number,
): Promise<LatentServer> {
  return listenLatent(certificate, connectLatencyMs, (secure) => {
    const plain = connect({ host: "127.0.0.1", port: targetPort });
    plain.on("error", () => secure.destroy());
    secure.once("close", () => plain.destroy());
    plain.once("close", () => secure.destroy());
    secure.pipe(plain).pipe(secure);
  });
}

export interface FakeSmtpOptions {
  certificate: TestCertificate;
  username: string;
  password: string;
  connectLatencyMs: number;
  /** Delay before each reply, the greeting included. */
  commandLatencyMs: number;
}

export interface FakeSmtpServer extends LatentServer {
  /** The verb of every command received, in order. */
  readonly commands: readonly string[];
}

/** Implicit TLS SMTP that greets, advertises AUTH PLAIN only and accepts the one login. */
export async function startFakeSmtpServer(options: FakeSmtpOptions): Promise<FakeSmtpServer> {
  const commands: string[] = [];
  const reply = (line: string): string => {
    const [verb = "", mechanism = "", initial = ""] = line.split(" ");
    switch (verb.toUpperCase()) {
      case "EHLO":
        return "250-mail.test\r\n250 AUTH PLAIN\r\n";
      case "AUTH": {
        if (mechanism.toUpperCase() !== "PLAIN") return "504 5.5.4 mechanism not supported\r\n";
        const [, user = "", pass = ""] = Buffer.from(initial, "base64").toString("utf8").split("\0");
        return user === options.username && pass === options.password
          ? "235 2.7.0 authentication succeeded\r\n"
          : "535 5.7.8 authentication failed\r\n";
      }
      case "QUIT":
        return "221 2.0.0 bye\r\n";
      default:
        return "250 2.0.0 OK\r\n";
    }
  };
  const server = await listenLatent(options.certificate, options.connectLatencyMs, (secure) => {
    let queue = delay(options.commandLatencyMs).then(() => {
      if (!secure.destroyed) secure.write("220 mail.test ESMTP fake\r\n");
    });
    let pending = "";
    secure.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      let end: number;
      while ((end = pending.indexOf("\r\n")) !== -1) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 2);
        commands.push((line.split(" ")[0] ?? "").toUpperCase());
        queue = queue.then(async () => {
          await delay(options.commandLatencyMs);
          if (!secure.destroyed) secure.write(reply(line));
        });
      }
    });
  });
  return { ...server, commands };
}
