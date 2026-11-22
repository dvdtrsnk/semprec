import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";

interface ServerMessage {
  uid: number;
  flags: Set<string>;
  modseq: number;
  raw: Buffer;
}

interface ServerFolder {
  specialUse?: string;
  uidValidity: number;
  uidNext: number;
  highestModSeq: number;
  messages: ServerMessage[];
  /** Expunged UIDs with the mod-sequence of their expunge, for `VANISHED (EARLIER)`. */
  expunged: Array<{ uid: number; modseq: number }>;
}

interface Session {
  selected: string | undefined;
  condstore: boolean;
  qresync: boolean;
  /** The tag of the IDLE command running on this connection. */
  idleTag: string | undefined;
  /** Queues `text` behind the responses already queued on this connection. */
  push(text: string): void;
}

export interface FakeImapServerOptions {
  folders: ReadonlyArray<{ path: string; specialUse?: string }>;
  /** Advertised after the greeting and the LOGIN; `IMAP4rev1` is always first. */
  capabilities: readonly string[];
  /** Delay before each response (the greeting included), standing in for one network round trip. */
  latencyMs: number;
  /** When set, a LOGIN with another password is refused with `AUTHENTICATIONFAILED`; otherwise every LOGIN succeeds. */
  password?: string;
  /** A SEARCH naming a CHARSET is refused with `NO [BADCHARSET (US-ASCII)]`, as a server without UTF-8 search does. */
  refuseSearchCharset?: boolean;
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

function quoted(value: string | undefined): string {
  return value === undefined ? "NIL" : `"${value.replace(/["\\]/g, (char) => `\\${char}`)}"`;
}

function literal(text: string): string {
  return `{${Buffer.byteLength(text, "latin1")}}\r\n${text}`;
}

/** A message's header block (with its blank line), its body and its unfolded header fields by lowercased name. */
function partsOf(raw: Buffer): { header: string; body: string; fields: Map<string, string> } {
  const text = raw.toString("latin1");
  const split = text.indexOf("\r\n\r\n");
  const header = split === -1 ? `${text}\r\n` : text.slice(0, split + 4);
  const body = split === -1 ? "" : text.slice(split + 4);
  const fields = new Map<string, string>();
  for (const line of header.replace(/\r\n[ \t]/g, " ").split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) fields.set(line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim());
  }
  return { header, body, fields };
}

/** An ENVELOPE address list for a header like `Name <local@host>` or `local@host`; NIL when absent. */
function envelopeAddresses(value: string | undefined): string {
  if (value === undefined) return "NIL";
  const match = /^(?:"?([^"<]*?)"?\s*)?<([^@>]+)@([^>]+)>$/.exec(value) ?? /^()([^@\s]+)@(\S+)$/.exec(value);
  if (!match) return "NIL";
  const name = match[1]?.trim();
  return `((${quoted(name ? name : undefined)} NIL ${quoted(match[2])} ${quoted(match[3])}))`;
}

function envelopeOf(raw: Buffer): string {
  const { fields } = partsOf(raw);
  const from = envelopeAddresses(fields.get("from"));
  return `(${[
    quoted(fields.get("date")),
    quoted(fields.get("subject")),
    from,
    from,
    from,
    envelopeAddresses(fields.get("to")),
    "NIL",
    "NIL",
    quoted(fields.get("in-reply-to")),
    quoted(fields.get("message-id")),
  ].join(" ")})`;
}

/** A Content-Type or Content-Disposition value: its lowercased value and its parameters by lowercased name. */
function headerValue(value: string | undefined): { value: string; params: Map<string, string> } {
  const [head = "", ...rest] = (value ?? "").split(";");
  const params = new Map<string, string>();
  for (const param of rest) {
    const eq = param.indexOf("=");
    if (eq > 0)
      params.set(
        param.slice(0, eq).trim().toLowerCase(),
        param
          .slice(eq + 1)
          .trim()
          .replace(/^"|"$/g, ""),
      );
  }
  return { value: head.trim().toLowerCase(), params };
}

/** The parts of a one-level `multipart/*` message, each with its header block and body; none for a single part. */
function mimePartsOf(raw: Buffer): Array<{ header: string; body: string; fields: Map<string, string> }> {
  const { body, fields } = partsOf(raw);
  const contentType = headerValue(fields.get("content-type"));
  const boundary = contentType.params.get("boundary");
  if (!contentType.value.startsWith("multipart/") || boundary === undefined) return [];
  return body
    .split(`--${boundary}`)
    .slice(1)
    .filter((chunk) => !chunk.startsWith("--"))
    .map((chunk) => partsOf(Buffer.from(chunk.replace(/^\r\n/, "").replace(/\r\n$/, ""), "latin1")));
}

/** One leaf's BODYSTRUCTURE from its header fields and body. */
function leafStructureOf(fields: Map<string, string>, body: string): string {
  const contentType = headerValue(fields.get("content-type") ?? "text/plain; charset=utf-8");
  const [type = "text", subtype = "plain"] = contentType.value.split("/");
  const params = [...contentType.params].map(([name, value]) => `${quoted(name.toUpperCase())} ${quoted(value)}`);
  const encoding = quoted((fields.get("content-transfer-encoding") ?? "7bit").toUpperCase());
  const size = Buffer.byteLength(body, "latin1");
  const disposition = fields.get("content-disposition");
  const dsp = disposition
    ? (() => {
        const parsed = headerValue(disposition);
        const dspParams = [...parsed.params].map(([name, value]) => `${quoted(name.toUpperCase())} ${quoted(value)}`);
        return `(${quoted(parsed.value.toUpperCase())} ${dspParams.length > 0 ? `(${dspParams.join(" ")})` : "NIL"})`;
      })()
    : "NIL";
  const head = `${quoted(type.toUpperCase())} ${quoted(subtype.toUpperCase())} ${params.length > 0 ? `(${params.join(" ")})` : "NIL"} NIL NIL ${encoding} ${size}`;
  return type === "text" ? `(${head} ${body.split("\r\n").length} NIL ${dsp} NIL NIL)` : `(${head} NIL ${dsp} NIL NIL)`;
}

/** A single part, or a one-level `multipart/*` message of leaf parts. */
function bodyStructureOf(raw: Buffer): string {
  const { body, fields } = partsOf(raw);
  const parts = mimePartsOf(raw);
  if (parts.length === 0) return leafStructureOf(fields, body);
  const contentType = headerValue(fields.get("content-type"));
  const subtype = contentType.value.split("/")[1] ?? "mixed";
  return `(${parts.map((part) => leafStructureOf(part.fields, part.body)).join("")} ${quoted(subtype.toUpperCase())} (${quoted("BOUNDARY")} ${quoted(contentType.params.get("boundary"))}) NIL NIL NIL)`;
}

/** The section a `BODY.PEEK[...]` item names, when it names a body part's bytes rather than header fields. */
function bodyPartSection(item: string): string | undefined {
  const section = /^BODY(?:\.PEEK)?\[([^\]]*)\]/i.exec(item)?.[1];
  return section === undefined || /^HEADER/i.test(section) || /\.MIME$/i.test(section) ? undefined : section;
}

/** The answer to one `BODY.PEEK[...]` item, named as the server returns it (`BODY[...]`, no origin octet). */
function bodySection(item: string, raw: Buffer): string | undefined {
  const match = /^BODY(?:\.PEEK)?\[([^\]]*)\](?:<(\d+)(?:\.(\d+))?>)?$/i.exec(item);
  if (!match) return undefined;
  const section = match[1] ?? "";
  const { header, body, fields } = partsOf(raw);
  const parts = mimePartsOf(raw);
  const partMatch = /^(\d+)(\.MIME)?$/i.exec(section);
  let text: string;
  const fieldList = /^HEADER\.FIELDS \(([^)]*)\)$/i.exec(section);
  if (partMatch && parts.length > 0) {
    const part = parts[Number(partMatch[1]) - 1];
    if (!part) return undefined;
    text = partMatch[2] ? part.header : part.body;
  } else if (fieldList) {
    const names = (fieldList[1] ?? "").split(/\s+/).filter(Boolean);
    text =
      names
        .flatMap((name) => {
          const value = fields.get(name.toLowerCase());
          return value === undefined ? [] : [`${name}: ${value}\r\n`];
        })
        .join("") + "\r\n";
  } else if (section.toUpperCase() === "HEADER") text = header;
  else if (section.toUpperCase() === "TEXT" || section === "1") text = body;
  else if (section === "") text = raw.toString("latin1");
  else return undefined;
  const start = match[2] === undefined ? 0 : Number(match[2]);
  const length = match[3] === undefined ? undefined : Number(match[3]);
  const sliced = text.slice(start, length === undefined ? undefined : start + length);
  return `BODY[${section}] ${literal(sliced)}`;
}

/** UIDs as an IMAP sequence set (`1:3,7`). */
function sequenceSet(uids: number[]): string {
  const sorted = [...uids].sort((a, b) => a - b);
  const ranges: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++;
    ranges.push(i === j ? String(sorted[i]) : `${sorted[i]}:${sorted[j]}`);
    i = j + 1;
  }
  return ranges.join(",");
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
 * A loopback IMAP server for sync-pass measurements: folders with UIDs, flags, CONDSTORE mod-sequences and messages of
 * one part or of one level of `multipart/*` parts, configurable capabilities, a fixed delay before every response, a
 * log of every command verb it received and of every body part a FETCH read. It answers what imapflow sends for a sync pass and an IDLE connection: LIST (with
 * LIST-STATUS), LSUB, STATUS, SELECT, UID SEARCH (by UID set, HEADER and [NOT] TEXT, literals included), UID FETCH of UIDs, flags, ENVELOPE, BODYSTRUCTURE and body sections
 * (whole or partial, `N` and `N.MIME` of a multipart message; with CHANGEDSINCE, and VANISHED once QRESYNC is enabled), UID STORE, ENABLE (CONDSTORE, QRESYNC), IDLE, NOOP and
 * LOGOUT. Another client's expunge or move is pushed to an idling connection as VANISHED (QRESYNC enabled) or EXPUNGE,
 * a delivery as EXISTS.
 */
export class FakeImapServer {
  /** Every command verb received, in order (`UID FETCH` is logged as `FETCH`). */
  readonly commands: string[] = [];
  /**
   * Every body part section a FETCH read (header fields and MIME headers aside), in order, with the octet count a
   * partial fetch asked for.
   */
  readonly bodyFetches: Array<{ path: string; uid: number; section: string; length?: number }> = [];
  /** Command verbs answered with `NO` instead of their result. */
  readonly refusedVerbs = new Set<string>();
  /** The criteria atoms of every SEARCH, in order (a quoted or literal string as its octets). */
  readonly searches: string[][] = [];
  private readonly folders = new Map<string, ServerFolder>();
  private readonly sockets = new Set<Socket>();
  private readonly sessions = new Set<Session>();
  private readonly server: Server = createServer((socket) => this.accept(socket));

  constructor(private readonly options: FakeImapServerOptions) {
    for (const folder of options.folders) {
      this.folders.set(folder.path, {
        ...(folder.specialUse ? { specialUse: folder.specialUse } : {}),
        uidValidity: 1,
        uidNext: 1,
        highestModSeq: 1,
        messages: [],
        expunged: [],
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

  /** Files a message under the next UID, as a delivery or APPEND would; without `raw`, a generated plain message. */
  deliver(path: string, flags: readonly string[] = [], raw?: Buffer): number {
    const folder = this.folder(path);
    const uid = folder.uidNext++;
    const bytes =
      raw ??
      Buffer.from(
        `Message-ID: <${randomUUID()}@fake-imap.test>\r\nFrom: sender@sender.example.test\r\nSubject: ${path} ${uid}\r\n\r\nbody\r\n`,
      );
    folder.messages.push({ uid, flags: new Set(flags), modseq: ++folder.highestModSeq, raw: bytes });
    this.notifyIdling(path, (session) => (session.selected === path ? `* ${folder.messages.length} EXISTS\r\n` : ""));
    return uid;
  }

  /**
   * Removes a message as another client's `\Deleted` and EXPUNGE would: the folder's mod-sequence rises and an idling
   * connection on the folder hears VANISHED (QRESYNC enabled) or EXPUNGE.
   */
  expunge(path: string, uid: number): void {
    const folder = this.folder(path);
    const index = folder.messages.findIndex((message) => message.uid === uid);
    if (index === -1) throw new Error(`No message ${uid} in ${path}`);
    folder.messages.splice(index, 1);
    folder.expunged.push({ uid, modseq: ++folder.highestModSeq });
    this.notifyIdling(path, (session) => (session.qresync ? `* VANISHED ${uid}\r\n` : `* ${index + 1} EXPUNGE\r\n`));
  }

  /** Another client's MOVE: the message is filed in `target` under its next UID, then expunged from `path`. */
  move(path: string, uid: number, target: string): number {
    const message = this.folder(path).messages.find((candidate) => candidate.uid === uid);
    if (!message) throw new Error(`No message ${uid} in ${path}`);
    const targetUid = this.deliver(target, [...message.flags], message.raw);
    this.expunge(path, uid);
    return targetUid;
  }

  /**
   * The folder rebuilt by the server: a new UIDVALIDITY, and its messages renumbered from `firstUid` in their order.
   * An idling connection hears nothing.
   */
  resetUidValidity(path: string, firstUid: number): void {
    const folder = this.folder(path);
    folder.uidValidity++;
    folder.messages.forEach((message, index) => {
      message.uid = firstUid + index;
    });
    folder.uidNext = firstUid + folder.messages.length;
    folder.expunged = [];
  }

  /** Replaces a message's flags, as another client's STORE would; raises the folder's mod-sequence. */
  setFlags(path: string, uid: number, flags: readonly string[]): void {
    const folder = this.folder(path);
    const message = folder.messages.find((candidate) => candidate.uid === uid);
    if (!message) throw new Error(`No message ${uid} in ${path}`);
    message.flags = new Set(flags);
    message.modseq = ++folder.highestModSeq;
  }

  /** Whether a connection is in IDLE with `path` selected. */
  isIdling(path: string): boolean {
    return [...this.sessions].some((session) => session.idleTag !== undefined && session.selected === path);
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

  private notifyIdling(path: string, text: (session: Session) => string): void {
    for (const session of this.sessions) {
      if (session.idleTag === undefined || session.selected !== path) continue;
      const line = text(session);
      if (line) session.push(line);
    }
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
    let queue = this.delay().then(() => {
      socket.write(`* OK [CAPABILITY ${this.capabilityLine()}] fake IMAP ready\r\n`);
    });
    const session: Session = {
      selected: undefined,
      condstore: false,
      qresync: false,
      idleTag: undefined,
      push: (text) => {
        queue = queue.then(async () => {
          await this.delay();
          if (!socket.destroyed) socket.write(text);
        });
      },
    };
    this.sessions.add(session);
    socket.on("close", () => this.sessions.delete(session));
    let buffered = "";
    let pendingLiteralAcknowledged = false;
    socket.on("data", (chunk) => {
      buffered += chunk.toString("latin1");
      let end: number;
      while ((end = buffered.indexOf("\r\n")) !== -1) {
        const line = buffered.slice(0, end);
        // A literal (`{N}` or `{N+}`) is read as a quoted string of its N octets; a synchronizing one is acknowledged.
        const literal = /\{(\d+)(\+?)\}$/.exec(line);
        if (literal) {
          const size = Number(literal[1]);
          if (literal[2] === "" && !pendingLiteralAcknowledged) {
            pendingLiteralAcknowledged = true;
            socket.write("+ go ahead\r\n");
          }
          if (buffered.length < end + 2 + size) break;
          const octets = buffered.slice(end + 2, end + 2 + size);
          buffered = `${line.slice(0, literal.index)}${quoted(octets)}${buffered.slice(end + 2 + size)}`;
          pendingLiteralAcknowledged = false;
          continue;
        }
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

  private respond(line: string, session: Session): { text: string; end?: boolean } {
    if (session.idleTag !== undefined && line.toUpperCase() === "DONE") {
      const tag = session.idleTag;
      session.idleTag = undefined;
      return { text: `${tag} OK IDLE terminated\r\n` };
    }
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
    if (this.refusedVerbs.has(verb)) return { text: `${String(tag)} NO ${verb} refused\r\n` };

    switch (verb) {
      case "CAPABILITY":
        return { text: `* CAPABILITY ${this.capabilityLine()}\r\n${ok()}` };
      case "LOGIN":
        if (this.options.password !== undefined && args[1] !== this.options.password) {
          return { text: `${String(tag)} NO [AUTHENTICATIONFAILED] Invalid credentials\r\n` };
        }
        return { text: ok(`[CAPABILITY ${this.capabilityLine()}] logged in`) };
      case "ENABLE": {
        const enabled = atoms(args).filter(
          (name) => (name === "CONDSTORE" || name === "QRESYNC") && this.options.capabilities.includes(name),
        );
        session.qresync = enabled.includes("QRESYNC");
        session.condstore = session.qresync || enabled.includes("CONDSTORE");
        return { text: `* ENABLED ${enabled.join(" ")}\r\n${ok()}` };
      }
      case "IDLE":
        session.idleTag = String(tag);
        return { text: "+ idling\r\n" };
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
        this.searches.push(criteria);
        if (this.options.refuseSearchCharset && criteria.some((token) => token.toUpperCase() === "CHARSET"))
          return { text: `${String(tag)} NO [BADCHARSET (US-ASCII)] charset not supported\r\n` };
        // `TEXT <string>` (after `NOT`: must not hold it): the raw message, read as UTF-8, holds the string,
        // case-insensitively. A quoted or literal argument arrives as its octets.
        const texts = criteria.flatMap((token, index) =>
          token.toUpperCase() === "TEXT" && criteria[index + 1] !== undefined
            ? [
                {
                  negated: criteria[index - 1]?.toUpperCase() === "NOT",
                  value: Buffer.from(criteria[index + 1]!, "latin1")
                    .toString("utf8")
                    .toLowerCase(),
                },
              ]
            : [],
        );
        const maxUid = selected.messages.at(-1)?.uid ?? 0;
        const uidIndex = criteria.findIndex((token) => token.toUpperCase() === "UID");
        const set = uidIndex === -1 ? undefined : criteria[uidIndex + 1];
        // `HEADER <field> <string>`: the field's value contains the string, case-insensitively.
        const headerIndex = criteria.findIndex((token) => token.toUpperCase() === "HEADER");
        const field = headerIndex === -1 ? undefined : criteria[headerIndex + 1]?.toLowerCase();
        const contained = headerIndex === -1 ? undefined : (criteria[headerIndex + 2] ?? "").toLowerCase();
        const found = selected.messages.filter(
          (message) =>
            (set === undefined || inRange(message.uid, set, maxUid)) &&
            (field === undefined ||
              (partsOf(message.raw).fields.get(field) ?? "").toLowerCase().includes(contained ?? "")) &&
            texts.every((text) => message.raw.toString("utf8").toLowerCase().includes(text.value) !== text.negated),
        );
        return { text: `* SEARCH${found.map((message) => ` ${message.uid}`).join("")}\r\n${ok()}` };
      }
      case "FETCH": {
        if (!selected) return { text: `${String(tag)} BAD no mailbox selected\r\n` };
        const [set = "", items, modifiers] = args;
        const requested = typeof items === "string" ? [items] : atoms(items);
        const plain = ["UID", "FLAGS", "MODSEQ", "ENVELOPE", "BODYSTRUCTURE", "RFC822.SIZE"];
        const unsupported = requested.filter(
          (item) => !plain.includes(item.toUpperCase()) && !/^BODY(\.PEEK)?\[/i.test(item),
        );
        if (unsupported.length > 0) return { text: `${String(tag)} BAD fetch items not supported\r\n` };
        const modifierAtoms = atoms(modifiers).map((token) => token.toUpperCase());
        const changedIndex = modifierAtoms.indexOf("CHANGEDSINCE");
        const changedSince = changedIndex === -1 ? undefined : Number(modifierAtoms[changedIndex + 1]);
        const maxUid = Math.max(selected.messages.at(-1)?.uid ?? 0, ...selected.expunged.map((entry) => entry.uid));
        let text = "";
        if (uidMode && session.qresync && changedSince !== undefined && modifierAtoms.includes("VANISHED")) {
          const vanished = selected.expunged
            .filter((entry) => entry.modseq > changedSince && inRange(entry.uid, String(set), maxUid))
            .map((entry) => entry.uid);
          if (vanished.length > 0) text += `* VANISHED (EARLIER) ${sequenceSet(vanished)}\r\n`;
        }
        selected.messages.forEach((message, index) => {
          const key = uidMode ? message.uid : index + 1;
          if (!inRange(key, String(set), uidMode ? maxUid : selected.messages.length)) return;
          if (changedSince !== undefined && message.modseq <= changedSince) return;
          const parts = [`UID ${message.uid}`];
          for (const item of requested) {
            const name = item.toUpperCase();
            if (name === "FLAGS") parts.push(`FLAGS (${[...message.flags].join(" ")})`);
            else if (name === "ENVELOPE") parts.push(`ENVELOPE ${envelopeOf(message.raw)}`);
            else if (name === "BODYSTRUCTURE") parts.push(`BODYSTRUCTURE ${bodyStructureOf(message.raw)}`);
            else if (name === "RFC822.SIZE") parts.push(`RFC822.SIZE ${message.raw.length}`);
            else {
              const section = bodySection(item, message.raw);
              if (section) parts.push(section);
              const fetchedSection = section ? bodyPartSection(item) : undefined;
              const length = /<\d+\.(\d+)>$/.exec(item)?.[1];
              if (fetchedSection !== undefined && session.selected !== undefined)
                this.bodyFetches.push({
                  path: session.selected,
                  uid: message.uid,
                  section: fetchedSection.toUpperCase(),
                  ...(length !== undefined ? { length: Number(length) } : {}),
                });
            }
          }
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
