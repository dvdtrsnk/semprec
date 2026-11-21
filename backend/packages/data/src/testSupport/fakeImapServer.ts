import { createServer, type Server, type Socket } from "node:net";

interface ServerMessage {
  uid: number;
  flags: Set<string>;
  modseq: number;
}

interface ServerFolder {
  specialUse?: string;
  uidValidity: number;
  uidNext: number;
  highestModSeq: number;
  messages: ServerMessage[];
}

export interface FakeImapServerOptions {
  folders: ReadonlyArray<{ path: string; specialUse?: string }>;
  /** Advertised after the greeting and the LOGIN; `IMAP4rev1` is always first. */
  capabilities: readonly string[];
  /** Delay before each response (the greeting included), standing in for one network round trip. */
  latencyMs: number;
}

type Token = string | Token[];

/** Splits an IMAP command's arguments into atoms, quoted strings and parenthesized lists; no literals. */
function tokenize(input: string): Token[] {
  const root: Token[] = [];
  const stack: Token[][] = [root];
  let i = 0;
  const top = () => stack[stack.length - 1]!;
  while (i < input.length) {
    const char = input[i]!;
    if (char === " ") {
      i++;
    } else if (char === "(") {
      const list: Token[] = [];
      top().push(list);
      stack.push(list);
      i++;
    } else if (char === ")") {
      stack.pop();
      i++;
    } else if (char === '"') {
      let value = "";
      i++;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === "\\") i++;
        value += input[i] ?? "";
        i++;
      }
      i++;
      top().push(value);
    } else {
      let value = "";
      while (i < input.length && !" ()".includes(input[i]!)) {
        // A section like BODY.PEEK[HEADER.FIELDS (A B)] stays one atom.
        if (input[i] === "[") {
          const close = input.indexOf("]", i);
          value += input.slice(i, close + 1);
          i = close + 1;
          continue;
        }
        value += input[i];
        i++;
      }
      top().push(value);
    }
  }
  return root;
}

function atoms(list: Token | undefined): string[] {
  return Array.isArray(list) ? list.filter((token): token is string => typeof token === "string") : [];
}

function inRange(uid: number, set: string, maxUid: number): boolean {
  return set.split(",").some((part) => {
    const [startRaw = "", endRaw] = part.split(":");
    const resolve = (raw: string) => (raw === "*" ? maxUid : Number(raw));
    const start = resolve(startRaw);
    const end = endRaw === undefined ? start : resolve(endRaw);
    return uid >= Math.min(start, end) && uid <= Math.max(start, end);
  });
}

/**
 * A loopback IMAP server for sync-pass measurements: folders with UIDs, flags and CONDSTORE mod-sequences (no message
 * bodies), configurable capabilities, a fixed delay before every response and a log of every command verb it received.
 * It answers what imapflow sends for a pass that ingests nothing: LIST (with LIST-STATUS), LSUB, STATUS, SELECT, UID
 * SEARCH, UID FETCH of UIDs and flags (with CHANGEDSINCE), UID STORE, ENABLE, NOOP and LOGOUT.
 */
export class FakeImapServer {
  /** Every command verb received, in order (`UID FETCH` is logged as `FETCH`). */
  readonly commands: string[] = [];
  private readonly folders = new Map<string, ServerFolder>();
  private readonly sockets = new Set<Socket>();
  private readonly server: Server = createServer((socket) => this.accept(socket));

  constructor(private readonly options: FakeImapServerOptions) {
    for (const folder of options.folders) {
      this.folders.set(folder.path, {
        ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
        uidValidity: 1,
        uidNext: 1,
        highestModSeq: 1,
        messages: [],
      });
    }
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (address === null || typeof address === "string") throw new Error("No loopback port");
    return address.port;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** Files a message under the next UID, as a delivery or APPEND would. */
  deliver(path: string, flags: readonly string[] = []): number {
    const folder = this.folder(path);
    const uid = folder.uidNext++;
    folder.messages.push({ uid, flags: new Set(flags), modseq: ++folder.highestModSeq });
    return uid;
  }

  /** Replaces a message's flags, as another client's STORE would; raises the folder's mod-sequence. */
  setFlags(path: string, uid: number, flags: readonly string[]): void {
    const folder = this.folder(path);
    const message = folder.messages.find((candidate) => candidate.uid === uid);
    if (!message) throw new Error(`No message ${uid} in ${path}`);
    message.flags = new Set(flags);
    message.modseq = ++folder.highestModSeq;
  }

  flagsOf(path: string, uid: number): string[] {
    const message = this.folder(path).messages.find((candidate) => candidate.uid === uid);
    if (!message) throw new Error(`No message ${uid} in ${path}`);
    return [...message.flags].sort();
  }

  /** How many of each command verb were received since `from` (an index into `commands`). */
  countsSince(from: number): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const verb of this.commands.slice(from)) counts[verb] = (counts[verb] ?? 0) + 1;
    return counts;
  }

  private folder(path: string): ServerFolder {
    const folder = this.folders.get(path);
    if (!folder) throw new Error(`No folder ${path}`);
    return folder;
  }

  private capabilityLine(): string {
    return ["IMAP4rev1", ...this.options.capabilities].join(" ");
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => {});
    const session = { selected: undefined as string | undefined, condstore: false };
    let buffered = "";
    let queue = this.delay().then(() => {
      socket.write(`* OK [CAPABILITY ${this.capabilityLine()}] fake IMAP ready\r\n`);
    });
    socket.on("data", (chunk) => {
      buffered += chunk.toString("latin1");
      let end: number;
      while ((end = buffered.indexOf("\r\n")) !== -1) {
        const line = buffered.slice(0, end);
        buffered = buffered.slice(end + 2);
        queue = queue.then(async () => {
          const response = this.respond(line, session);
          await this.delay();
          if (socket.destroyed) return;
          socket.write(response.text);
          if (response.end) socket.end();
        });
      }
    });
  }

  private delay(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.options.latencyMs));
  }

  private respond(
    line: string,
    session: { selected: string | undefined; condstore: boolean },
  ): { text: string; end?: boolean } {
    const [tag = "*", ...rest] = tokenize(line);
    let args = rest;
    let verb = typeof args[0] === "string" ? args[0].toUpperCase() : "";
    let uidMode = false;
    if (verb === "UID") {
      uidMode = true;
      args = args.slice(1);
      verb = typeof args[0] === "string" ? args[0].toUpperCase() : "";
    }
    args = args.slice(1);
    this.commands.push(verb);
    const ok = (text = "done") => `${String(tag)} OK ${text}\r\n`;
    const selected = session.selected !== undefined ? this.folder(session.selected) : undefined;

    switch (verb) {
      case "CAPABILITY":
        return { text: `* CAPABILITY ${this.capabilityLine()}\r\n${ok()}` };
      case "LOGIN":
        return { text: ok(`[CAPABILITY ${this.capabilityLine()}] logged in`) };
      case "ENABLE": {
        const enabled = atoms(args).filter((name) => name === "CONDSTORE" && this.options.capabilities.includes(name));
        session.condstore = enabled.length > 0;
        return { text: `* ENABLED ${enabled.join(" ")}\r\n${ok()}` };
      }
      case "LIST": {
        const returnIndex = args.findIndex((token) => token === "RETURN");
        const returned = returnIndex === -1 ? [] : (args[returnIndex + 1] ?? []);
        const statusIndex = Array.isArray(returned) ? returned.findIndex((token) => token === "STATUS") : -1;
        const statusItems = statusIndex === -1 || !Array.isArray(returned) ? [] : atoms(returned[statusIndex + 1]);
        const pattern = typeof args[1] === "string" ? args[1] : "*";
        let text = "";
        for (const [path, folder] of this.folders) {
          if (pattern !== "*" && pattern.toUpperCase() !== path.toUpperCase()) continue;
          const attributes = ["\\HasNoChildren", ...(folder.specialUse && path !== "INBOX" ? [folder.specialUse] : [])];
          text += `* LIST (${attributes.join(" ")}) "/" ${path}\r\n`;
          if (statusItems.length > 0) text += `* STATUS ${path} (${this.statusItems(folder, statusItems)})\r\n`;
        }
        return { text: text + ok() };
      }
      case "LSUB": {
        let text = "";
        for (const path of this.folders.keys()) text += `* LSUB () "/" ${path}\r\n`;
        return { text: text + ok() };
      }
      case "STATUS": {
        const path = String(args[0]);
        return { text: `* STATUS ${path} (${this.statusItems(this.folder(path), atoms(args[1]))})\r\n${ok()}` };
      }
      case "SELECT":
      case "EXAMINE": {
        const path = String(args[0]);
        const folder = this.folder(path);
        session.selected = path;
        const modseq = this.options.capabilities.includes("CONDSTORE")
          ? `* OK [HIGHESTMODSEQ ${folder.highestModSeq}] modseq\r\n`
          : "";
        return {
          text:
            `* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)\r\n` +
            `* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] flags\r\n` +
            `* ${folder.messages.length} EXISTS\r\n* 0 RECENT\r\n` +
            `* OK [UIDVALIDITY ${folder.uidValidity}] uids\r\n* OK [UIDNEXT ${folder.uidNext}] next\r\n` +
            modseq +
            ok("[READ-WRITE] selected"),
        };
      }
      case "SEARCH": {
        if (!selected) return { text: `${String(tag)} BAD no mailbox selected\r\n` };
        const criteria = atoms(args);
        const maxUid = selected.messages.at(-1)?.uid ?? 0;
        const uidIndex = criteria.findIndex((token) => token.toUpperCase() === "UID");
        const set = uidIndex === -1 ? undefined : criteria[uidIndex + 1];
        const found = selected.messages.filter((message) => set === undefined || inRange(message.uid, set, maxUid));
        return { text: `* SEARCH${found.map((message) => ` ${message.uid}`).join("")}\r\n${ok()}` };
      }
      case "FETCH": {
        if (!selected) return { text: `${String(tag)} BAD no mailbox selected\r\n` };
        const [set = "", items, modifiers] = args;
        const requested = typeof items === "string" ? [items.toUpperCase()] : atoms(items).map((x) => x.toUpperCase());
        const unsupported = requested.filter((item) => !["UID", "FLAGS", "MODSEQ"].includes(item));
        if (unsupported.length > 0) return { text: `${String(tag)} BAD fetch items not supported\r\n` };
        const modifierAtoms = atoms(modifiers);
        const changedIndex = modifierAtoms.findIndex((token) => token.toUpperCase() === "CHANGEDSINCE");
        const changedSince = changedIndex === -1 ? undefined : Number(modifierAtoms[changedIndex + 1]);
        const maxUid = selected.messages.at(-1)?.uid ?? 0;
        let text = "";
        selected.messages.forEach((message, index) => {
          const key = uidMode ? message.uid : index + 1;
          if (!inRange(key, String(set), uidMode ? maxUid : selected.messages.length)) return;
          if (changedSince !== undefined && message.modseq <= changedSince) return;
          const parts = [`UID ${message.uid}`];
          if (requested.includes("FLAGS")) parts.push(`FLAGS (${[...message.flags].join(" ")})`);
          if (session.condstore) parts.push(`MODSEQ (${message.modseq})`);
          text += `* ${index + 1} FETCH (${parts.join(" ")})\r\n`;
        });
        return { text: text + ok() };
      }
      case "STORE": {
        if (!selected) return { text: `${String(tag)} BAD no mailbox selected\r\n` };
        const [set = "", action = "", flagList] = args;
        const flags = typeof flagList === "string" ? [flagList] : atoms(flagList);
        const maxUid = selected.messages.at(-1)?.uid ?? 0;
        let text = "";
        selected.messages.forEach((message, index) => {
          if (!inRange(uidMode ? message.uid : index + 1, String(set), maxUid)) return;
          const verbAction = String(action).toUpperCase();
          for (const flag of flags) {
            if (verbAction.startsWith("+")) message.flags.add(flag);
            else if (verbAction.startsWith("-")) message.flags.delete(flag);
          }
          message.modseq = ++selected.highestModSeq;
          const modseq = session.condstore ? ` MODSEQ (${message.modseq})` : "";
          text += `* ${index + 1} FETCH (UID ${message.uid} FLAGS (${[...message.flags].join(" ")})${modseq})\r\n`;
        });
        return { text: text + ok() };
      }
      case "LOGOUT":
        return { text: `* BYE logging out\r\n${ok()}`, end: true };
      default:
        return { text: ok() };
    }
  }

  private statusItems(folder: ServerFolder, items: string[]): string {
    const values: Record<string, number> = {
      MESSAGES: folder.messages.length,
      UIDNEXT: folder.uidNext,
      UIDVALIDITY: folder.uidValidity,
      HIGHESTMODSEQ: folder.highestModSeq,
      UNSEEN: folder.messages.filter((message) => !message.flags.has("\\Seen")).length,
      RECENT: 0,
    };
    return items
      .map((item) => item.toUpperCase())
      .filter((item) => values[item] !== undefined)
      .map((item) => `${item} ${values[item]}`)
      .join(" ");
  }
}
