import net from "node:net";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

/**
 * What the sandbox launcher (`deploy/bin/semprec-mcp-launch`) execs: exactly these three fields,
 * sent as the connection's first line. `env` is the server's whole environment on top of the
 * launcher's fixed base, so the caller must not put anything from its own `process.env` in it.
 */
export interface SandboxedStdioServerParams {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** How long `close()` waits for the launcher to close its end after this side ended the socket. */
const CLOSE_GRACE_MS = 2_000;

/**
 * Client transport for a `stdio` MCP server that runs under the sandbox launcher's socket
 * (issue #1070, `docs/adr/2026-10-17-stdio-mcp-servers-run-in-a-socket-activated-sandbox.md`)
 * instead of as a child of this process. The connection carries the same newline-delimited
 * JSON-RPC framing as the SDK's `StdioClientTransport`, after one header line naming the server.
 *
 * The header holds the decrypted credential, so `start()` takes it off the transport before
 * connecting and keeps only the encoded line, which it releases once handed to the socket or once
 * the connect fails: after `start()` settles, neither the transport nor any listener it registered
 * holds the header. The socket's own write queue holds the line's bytes until they are flushed.
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
    // Every listener below shares this function's closure context, and the socket keeps them alive
    // for the connection's lifetime, so the header is held only in `line`, which is cleared below.
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

  /**
   * Ends the connection, which the launched server reads as EOF on its stdin, and waits up to
   * `CLOSE_GRACE_MS` for the launcher to close its end before destroying the socket. Resolves once
   * the socket is closed, so a caller never leaves one open behind it.
   */
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
