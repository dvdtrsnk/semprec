import net from "node:net";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * Sent as the connection's first line. `env` is the server's whole environment over the launcher's fixed base, so
 * nothing from the caller's `process.env` may go in it.
 */
export interface SandboxedStdioServerParams {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** How long `close()` waits for the launcher to close its end after this side ended the socket. */
const CLOSE_GRACE_MS = 2_000;

/**
 * Client transport for a `stdio` server run under the sandbox launcher socket instead of as a child process
 * (docs/architecture/delivery-and-operations.md#stdio-mcp-sandbox). Same newline-delimited JSON-RPC framing as the
 * SDK's `StdioClientTransport`, after one header line naming the server.
 *
 * The header holds the decrypted credential, so `start()` takes it off the transport and keeps only the encoded
 * line, released once handed to the socket or on connect failure. After `start()` settles nothing here holds it;
 * only the socket's write queue holds the bytes until flushed.
 */
export class SandboxedStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private readonly socketPath: string;
  private header: SandboxedStdioServerParams | undefined;
  private socket: net.Socket | undefined;
  private readonly readBuffer = new ReadBuffer();
  private closeFired = false;

  constructor(socketPath: string, params: SandboxedStdioServerParams) {
    this.socketPath = socketPath;
    this.header = { command: params.command, args: [...params.args], env: { ...params.env } };
  }

  async start(): Promise<void> {
    if (this.socket !== undefined || this.header === undefined) {
      throw new Error("SandboxedStdioClientTransport already started");
    }
    // The socket keeps every listener (and so this closure) alive for the connection's lifetime, so the header lives
    // only in `line`, which is cleared below.
    let line: string | undefined = `${JSON.stringify(this.header)}\n`;
    this.header = undefined;
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    socket.on("close", () => this.fireClose());
    await new Promise<void>((resolve, reject) => {
      const settle = () => {
        socket.off("connect", onConnect);
        socket.off("error", onConnectError);
        socket.off("close", onCloseBeforeConnect);
        line = undefined;
      };
      const onConnect = () => {
        const pending = line;
        settle();
        socket.on("error", (error) => this.onerror?.(error));
        socket.on("data", (chunk: Buffer) => this.handleData(chunk));
        if (pending !== undefined) socket.write(pending);
        resolve();
      };
      const onConnectError = (error: Error) => {
        settle();
        reject(error);
      };
      // `close()` while still connecting destroys the socket without an `error`; without this the
      // connect would never settle.
      const onCloseBeforeConnect = () => {
        settle();
        reject(new Error("Socket closed before it connected"));
      };
      socket.once("connect", onConnect);
      socket.once("error", onConnectError);
      socket.once("close", onCloseBeforeConnect);
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    const socket = this.socket;
    if (socket === undefined || socket.destroyed || !socket.writable) {
      return Promise.reject(new Error("Not connected"));
    }
    return new Promise((resolve, reject) => {
      if (socket.write(serializeMessage(message))) {
        resolve();
        return;
      }
      // A socket that closes while the write is still buffered never drains.
      const onDrain = () => {
        socket.off("close", onClose);
        resolve();
      };
      const onClose = () => {
        socket.off("drain", onDrain);
        reject(new Error("Not connected"));
      };
      socket.once("drain", onDrain);
      socket.once("close", onClose);
    });
  }

  /** The server reads the end as EOF on stdin. Resolves only once the socket is closed. */
  async close(): Promise<void> {
    const socket = this.socket;
    if (socket !== undefined && !socket.closed) {
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.end();
      let timer: NodeJS.Timeout | undefined;
      const grace = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), CLOSE_GRACE_MS);
      });
      try {
        if ((await Promise.race([closed, grace])) === "timeout") {
          socket.destroy();
          await closed;
        }
      } finally {
        clearTimeout(timer);
      }
    }
    this.readBuffer.clear();
  }

  private handleData(chunk: Buffer): void {
    try {
      this.readBuffer.append(chunk);
    } catch (error) {
      // The server overran the read buffer's cap: the stream can no longer be framed.
      this.onerror?.(asError(error));
      this.socket?.destroy();
      return;
    }
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.readBuffer.readMessage();
      } catch (error) {
        // One malformed line: report it and carry on with the next one, as the SDK's stdio transport does.
        this.onerror?.(asError(error));
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }

  private fireClose(): void {
    if (this.closeFired) return;
    this.closeFired = true;
    this.onclose?.();
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
