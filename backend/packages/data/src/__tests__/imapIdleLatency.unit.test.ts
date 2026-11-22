import { createServer, type Server, type Socket } from "node:net";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createImapFlowIdleTransport,
  ImapIdleStoppedError,
  type CreateIdleTunedImapFlowClient,
} from "../mail/imapIdleClient.js";

/**
 * A loopback IMAP server with one INBOX that, like a real server, reports a new message only inside IDLE (or in the
 * response to a command): a delivery while the connection is not idling is announced when IDLE starts.
 */
class LoopbackImapServer {
  private exists = 1;
  private idling: { socket: Socket; tag: string } | undefined;
  /** IDLE commands received, renewals included. */
  idleCommands = 0;
  private readonly sockets = new Set<Socket>();
  readonly server: Server = createServer((socket) => this.accept(socket));

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("No loopback port");
    return address.port;
  }

  deliver(): void {
    this.exists++;
    this.idling?.socket.write(`* ${this.exists} EXISTS\r\n`);
  }

  get isIdling(): boolean {
    return this.idling !== undefined;
  }

  /** Ends the running IDLE from the server side, as a server's tagged reply without the client's DONE would. */
  endIdle(): void {
    if (!this.idling) throw new Error("No connection is idling");
    this.idling.socket.write(`${this.idling.tag} OK IDLE terminated by the server\r\n`);
    this.idling = undefined;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    socket.write("* OK loopback IMAP ready\r\n");
    let buffered = "";
    socket.on("data", (chunk) => {
      buffered += chunk.toString("latin1");
      let end: number;
      while ((end = buffered.indexOf("\r\n")) !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (this.idling?.socket === socket && line.toUpperCase() === "DONE") {
          socket.write(`${this.idling.tag} OK IDLE terminated\r\n`);
          this.idling = undefined;
          continue;
        }
        const [tag = "*", verb = ""] = line.split(" ");
        switch (verb.toUpperCase()) {
          case "CAPABILITY":
            socket.write(`* CAPABILITY IMAP4rev1 IDLE\r\n${tag} OK done\r\n`);
            break;
          case "LOGIN":
            socket.write(`${tag} OK [CAPABILITY IMAP4rev1 IDLE] logged in\r\n`);
            break;
          case "SELECT":
          case "EXAMINE":
            socket.write(
              `* ${this.exists} EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT ${this.exists + 1}] ok\r\n` +
                `* FLAGS (\\Seen)\r\n${tag} OK [READ-WRITE] selected\r\n`,
            );
            break;
          case "IDLE":
            this.idleCommands++;
            this.idling = { socket, tag };
            socket.write(`+ idling\r\n* ${this.exists} EXISTS\r\n`);
            break;
          case "LOGOUT":
            socket.write(`* BYE bye\r\n${tag} OK done\r\n`);
            socket.end();
            break;
          case "LIST":
            socket.write(`* LIST (\\HasNoChildren) "/" INBOX\r\n${tag} OK done\r\n`);
            break;
          default:
            socket.write(`${tag} OK done\r\n`);
        }
      }
    });
  }
}

describe("IMAP IDLE signal latency right after connecting", () => {
  let server: LoopbackImapServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it("reports a message delivered just after the folder was selected within a second", async () => {
    server = new LoopbackImapServer();
    const port = await server.listen();
    const createClient: CreateIdleTunedImapFlowClient = async (_mailboxItemId, password, idleOptions) => {
      const client = new ImapFlow({
        host: "127.0.0.1",
        port,
        secure: false,
        auth: { user: "account", pass: password },
        logger: false,
        ...idleOptions,
      });
      await client.connect();
      return client;
    };
    let signalled!: () => void;
    const signal = new Promise<void>((resolve) => {
      signalled = resolve;
    });
    const connection = await createImapFlowIdleTransport(createClient).connect("mailbox", "secret", "INBOX", () =>
      signalled(),
    );
    try {
      const delivered = performance.now();
      server.deliver();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        signal.then(() => performance.now() - delivered),
        new Promise<"late">((resolve) => {
          timer = setTimeout(() => resolve("late"), 1_000);
        }),
      ]);
      clearTimeout(timer);
      expect(outcome).not.toBe("late");
    } finally {
      await connection.close();
    }
  });

  it("ends the session when the server ends IDLE on a connection it keeps open", async () => {
    server = new LoopbackImapServer();
    const port = await server.listen();
    const createClient: CreateIdleTunedImapFlowClient = async (_mailboxItemId, password, idleOptions) => {
      const client = new ImapFlow({
        host: "127.0.0.1",
        port,
        secure: false,
        auth: { user: "account", pass: password },
        logger: false,
        ...idleOptions,
      });
      await client.connect();
      return client;
    };
    const connection = await createImapFlowIdleTransport(createClient, { idleCheckIntervalMs: 20 }).connect(
      "mailbox",
      "secret",
      "INBOX",
      () => {},
    );
    try {
      await vi.waitFor(() => expect(server?.isIdling).toBe(true), { timeout: 1_000, interval: 5 });
      let outcome: { value: unknown } | undefined;
      void connection.waitForEnd().then((value) => {
        outcome = { value };
      });
      // A healthy IDLE outlasts many checks.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(outcome).toBeUndefined();

      server.endIdle();
      await vi.waitFor(() => expect(outcome?.value).toBeInstanceOf(ImapIdleStoppedError), {
        timeout: 1_000,
        interval: 5,
      });
      // imapflow did not start IDLE again on its own.
      expect(server.idleCommands).toBe(1);
    } finally {
      await connection.close();
    }
  });
});
