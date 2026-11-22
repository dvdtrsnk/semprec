import { connect, type Socket } from "node:net";
import { MAIL_HISTORY_FETCH_ITEMS } from "../mail/mailHistoryUpload.js";
import { IMAP_FIXTURE_ACCOUNT } from "./imapMailboxFixture.js";

const RESPONSE_TIMEOUT_MS = 10_000;

/** Where the response starting at `start` ends (after its final CRLF), literals included; `null` while incomplete. */
function responseEnd(buffer: Buffer, start: number): number | null {
  let position = start;
  for (;;) {
    const lineEnd = buffer.indexOf("\r\n", position);
    if (lineEnd === -1) return null;
    const literal = /\{(\d+)\}$/.exec(buffer.toString("latin1", position, lineEnd));
    if (!literal) return lineEnd + 2;
    position = lineEnd + 2 + Number(literal[1]);
    if (position > buffer.length) return null;
  }
}

/**
 * A native client's side of the history upload over a plain TCP connection to a loopback IMAP server, with no IMAP
 * library: it sends the commands the upload contract names and keeps each untagged response's bytes as the server sent
 * them.
 */
export class RawImapHistoryClient {
  private buffer = Buffer.alloc(0);
  private readonly listeners = new Set<() => void>();
  private tag = 0;

  private constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (const listener of this.listeners) listener();
    });
  }

  /** Connects, reads the greeting and logs in as the fixture account. */
  static async connect(port: number): Promise<RawImapHistoryClient> {
    const socket = connect({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const client = new RawImapHistoryClient(socket);
    await client.nextResponse();
    await client.command(`LOGIN ${IMAP_FIXTURE_ACCOUNT} app-password`);
    return client;
  }

  private nextResponse(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(check);
        reject(new Error("The IMAP server did not answer"));
      }, RESPONSE_TIMEOUT_MS);
      const check = () => {
        const end = responseEnd(this.buffer, 0);
        if (end === null) return;
        clearTimeout(timer);
        this.listeners.delete(check);
        const response = this.buffer.subarray(0, end);
        this.buffer = this.buffer.subarray(end);
        resolve(response);
      };
      this.listeners.add(check);
      check();
    });
  }

  /** Sends one command and returns the untagged responses before its tagged `OK`. */
  async command(text: string): Promise<Buffer[]> {
    const tag = `h${++this.tag}`;
    this.socket.write(`${tag} ${text}\r\n`);
    const untagged: Buffer[] = [];
    for (;;) {
      const response = await this.nextResponse();
      if (!response.toString("latin1").startsWith(`${tag} `)) {
        untagged.push(response);
        continue;
      }
      if (!response.toString("latin1").startsWith(`${tag} OK`)) throw new Error(`IMAP ${tag} was refused`);
      return untagged;
    }
  }

  async select(path: string): Promise<void> {
    await this.command(`SELECT ${path}`);
  }

  /** `UID SEARCH UID low:high`, ascending. */
  async searchUids(low: number, high: number): Promise<number[]> {
    const [search] = await this.command(`UID SEARCH UID ${low}:${high}`);
    return (search?.toString("latin1").trim().split(" ").slice(2) ?? []).map(Number);
  }

  /** `UID FETCH <uids> MAIL_HISTORY_FETCH_ITEMS`: each untagged FETCH response's bytes, by UID. */
  async fetchHistory(uids: readonly number[]): Promise<Map<number, Buffer>> {
    const responses =
      uids.length === 0 ? [] : await this.command(`UID FETCH ${uids.join(",")} ${MAIL_HISTORY_FETCH_ITEMS}`);
    const byUid = new Map<number, Buffer>();
    for (const response of responses) {
      const uid = /^\* \d+ FETCH \(.*?\bUID (\d+)/.exec(response.toString("latin1"))?.[1];
      if (uid !== undefined) byUid.set(Number(uid), response);
    }
    return byUid;
  }

  async close(): Promise<void> {
    try {
      await this.command("LOGOUT");
    } finally {
      this.socket.destroy();
    }
  }
}
