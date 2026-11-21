import { createServer, type Server, type Socket } from "node:net";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { createImapFlowIdleTransport, type CreateIdleTunedImapFlowClient } from "../mail/imapIdleClient.js";

/**
 * A loopback IMAP server with one INBOX that, like a real server, reports a new message only inside IDLE (or in the
 * response to a command): a delivery while the connection is not idling is announced when IDLE starts.
 */
class LoopbackImapServer {
  private exists = 1;
  private idling: Socket | undefined;
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
    this.idling?.write(`* ${this.exists} EXISTS\r\n`);
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
    let idleTag: string | undefined;
    socket.on("data", (chunk) => {
      buffered += chunk.toString("latin1");
      let end: number;
      while ((end = buffered.indexOf("\r\n")) !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        if (idleTag !== undefined && line.toUpperCase() === "DONE") {
          this.idling = undefined;
          socket.write(`${idleTag} OK IDLE terminated\r\n`);
          idleTag = undefined;
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
            idleTag = tag;
            this.idling = socket;
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
});
