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
 * The header holds the decrypted credential, so `start()` drops this transport's reference to it
 * once written: nothing reachable from the connected client keeps a copy.
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
    if (this.socket !== undefined) {
      throw new Error("SandboxedStdioClientTransport already started");
    }
    const header = this.header;
    this.header = undefined;
    if (header === undefined) {
      throw new Error("SandboxedStdioClientTransport cannot be restarted");
    }
    const socket = net.createConnection(this.socketPath);
    this.socket = socket;
    socket.on("close", () => this.fireClose());
    await new Promise<void>((resolve, reject) => {
      const onConnectError = (error: Error) => reject(error);
      socket.once("error", onConnectError);
      socket.once("connect", () => {
        socket.off("error", onConnectError);
        socket.on("error", (error) => this.onerror?.(error));
        socket.on("data", (chunk: Buffer) => this.handleData(chunk));
        socket.write(`${JSON.stringify(header)}\n`);
        resolve();
      });
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
