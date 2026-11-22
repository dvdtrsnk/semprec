// imapflow 1.7.6's own response path, the one `ImapFlow` runs on every server response, applied to the bytes of one
// untagged FETCH response a native client received from its IMAP server: `ImapStream` splits the bytes into the
// response line and its literals, the `imap-handler` parser tokenizes them, and `tools.formatMessageResponse` turns the
// tokens into the object `ImapFlow.fetch()` yields. These are library internals under `imapflow/lib` without types:
// each is resolved at its first use behind a runtime shape check, and imapFetchResponseParser.unit.test.ts proves them
// against the real library's fetch of the same message. A library upgrade must re-prove them.
import { createRequire } from "node:module";
import { Transform } from "node:stream";
import type { FetchMessageObject, MessageAddressObject, MessageStructureObject } from "imapflow";
import { z } from "zod";

/** The bytes are not one well-formed untagged FETCH response; names nothing of their content. */
export class MalformedImapFetchResponseError extends Error {
  constructor(readonly reason: string) {
    super(`Not an untagged IMAP FETCH response: ${reason}`);
    this.name = "MalformedImapFetchResponseError";
  }
}

/** A library function, called through `Reflect` with its result read as `unknown` and checked. */
type Callable = (...args: never[]) => unknown;

function isCallable(value: unknown): value is Callable {
  return typeof value === "function";
}

interface ImapflowResponseInternals {
  ImapStream: Callable;
  parser: Callable;
  tools: object;
  formatMessageResponse: Callable;
}

let internals: ImapflowResponseInternals | undefined;

function loadInternals(): ImapflowResponseInternals {
  if (internals) return internals;
  const require = createRequire(import.meta.url);
  const streamModule: unknown = require("imapflow/lib/handler/imap-stream.js");
  const handlerModule: unknown = require("imapflow/lib/handler/imap-handler.js");
  const tools: unknown = require("imapflow/lib/tools.js");
  if (
    typeof streamModule !== "object" ||
    streamModule === null ||
    !("ImapStream" in streamModule) ||
    !isCallable(streamModule.ImapStream) ||
    typeof handlerModule !== "object" ||
    handlerModule === null ||
    !("parser" in handlerModule) ||
    !isCallable(handlerModule.parser) ||
    typeof tools !== "object" ||
    tools === null ||
    !("formatMessageResponse" in tools) ||
    !isCallable(tools.formatMessageResponse)
  ) {
    throw new Error("imapflow's response parser internals are not where imapflow 1.7.6 keeps them");
  }
  const loaded: ImapflowResponseInternals = {
    ImapStream: streamModule.ImapStream,
    parser: handlerModule.parser,
    tools,
    formatMessageResponse: tools.formatMessageResponse,
  };
  internals = loaded;
  return loaded;
}

/** imapflow's stream logs raw traffic only when asked to; this keeps any other line of it out of the process log. */
const SILENT_LOGGER = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => SILENT_LOGGER,
};

const streamedResponse = z.object({
  payload: z.instanceof(Buffer),
  literals: z.array(z.instanceof(Buffer)),
  next: z.custom<() => void>((value) => typeof value === "function"),
});

/** A stream limit error, the one kind of failure `ImapStream` reports on bytes it cannot frame. */
function isStreamLimitError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "LiteralTooLarge" || error.code === "LineTooLarge" || error.code === "ResponseTooLarge")
  );
}

/** Every response `bytes` frame into, each as its line (literal markers kept) and its literals, as `ImapFlow` reads. */
async function frameResponses(
  ImapStream: ImapflowResponseInternals["ImapStream"],
  bytes: Buffer,
): Promise<Array<{ payload: Buffer; literals: Buffer[] }>> {
  const stream: unknown = Reflect.construct(ImapStream, [
    {
      logger: SILENT_LOGGER,
      // Nothing inside the bytes may claim more than the bytes hold.
      maxLineLength: bytes.length,
      maxLiteralSize: bytes.length,
      maxResponseSize: bytes.length,
    },
  ]);
  if (!(stream instanceof Transform)) throw new Error("imapflow's ImapStream is no longer a Transform stream");
  const responses: Array<{ payload: Buffer; literals: Buffer[] }> = [];
  try {
    await new Promise<void>((resolve, reject) => {
      stream.on("data", (item: unknown) => {
        const parsed = streamedResponse.parse(item);
        responses.push({ payload: parsed.payload, literals: parsed.literals });
        // Releases the stream's backpressure wait, as `ImapFlow.releaseStreamData` does.
        parsed.next();
      });
      stream.once("error", reject);
      stream.once("end", resolve);
      stream.end(bytes);
    });
  } catch (error) {
    if (isStreamLimitError(error)) throw new MalformedImapFetchResponseError("a literal or line exceeds the bytes");
    throw error;
  }
  return responses;
}

/** A tokenizer refusal: imapflow's parser codes every one of them `ParserError<n>` or `MAX_IMAP_NESTING_REACHED`. */
function isParserError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if ("code" in error && typeof error.code === "string")
    return /^ParserError\d+$/.test(error.code) || error.code === "MAX_IMAP_NESTING_REACHED";
  // The one uncoded refusal of the token parser.
  return error.message.startsWith("Unexpected \\x00");
}

const untaggedFetch = z.object({
  tag: z.literal("*"),
  // An untagged FETCH is `* <sequence number> FETCH (...)`.
  command: z.string().regex(/^[1-9]\d{0,9}$/),
  attributes: z.tuple([
    z.object({ type: z.literal("ATOM"), value: z.string().regex(/^FETCH$/i) }),
    z.array(z.unknown()),
  ]),
});

const parameters = z.record(z.string(), z.string());

const structureNode: z.ZodType<MessageStructureObject> = z.lazy(() =>
  z.object({
    part: z.string().optional(),
    type: z.string(),
    parameters: parameters.optional(),
    id: z.string().optional(),
    encoding: z.string().optional(),
    size: z.number().optional(),
    disposition: z.string().optional(),
    dispositionParameters: parameters.optional(),
    childNodes: z.array(structureNode).optional(),
  }),
);

const address: z.ZodType<MessageAddressObject> = z.object({
  name: z.string().optional(),
  address: z.string().optional(),
});

const formattedFetch = z.object({
  seq: z.number().int().positive(),
  uid: z.number().int().positive().max(4_294_967_295),
  flags: z.set(z.string()).optional(),
  envelope: z
    .object({
      // imapflow keeps an unparseable Date header as its text; it reads as no Date.
      date: z
        .union([z.date(), z.string()])
        .optional()
        .transform((value) => (value instanceof Date ? value : undefined)),
      subject: z.string().optional(),
      messageId: z.string().optional(),
      inReplyTo: z.string().optional(),
      from: z.array(address).optional(),
      sender: z.array(address).optional(),
      replyTo: z.array(address).optional(),
      to: z.array(address).optional(),
      cc: z.array(address).optional(),
      bcc: z.array(address).optional(),
    })
    .optional(),
  bodyStructure: structureNode.optional(),
  headers: z.instanceof(Buffer).optional(),
  bodyParts: z.map(z.string(), z.instanceof(Buffer).optional()).optional(),
  emailId: z.string().optional(),
});

/** Which of the requested data items a response carried; a NIL or empty item still counts as carried. */
export interface ImapFetchResponse {
  message: FetchMessageObject;
  /** `BODY[HEADER.FIELDS (...)]` was in the response. */
  hasHeaderFields: boolean;
  /** The decoded `BODY[<section>]` items, by lowercased section (`text`); a NIL or empty one is an empty buffer. */
  sections: Map<string, Buffer>;
}

const CRLF = Buffer.from("\r\n");

/**
 * Parses the bytes of exactly one untagged FETCH response (`* <n> FETCH (...)`, literals inline, the closing CRLF
 * optional) as imapflow parses what a server sends. Bytes that do not frame into one response, do not tokenize or do
 * not form a FETCH throw `MalformedImapFetchResponseError`. imapflow's parser and formatter read nothing but the
 * bytes; their refusal of the bytes is that error, while any failure after them keeps its identity.
 */
export async function parseImapFetchResponse(bytes: Buffer): Promise<ImapFetchResponse> {
  const { ImapStream, parser, tools, formatMessageResponse } = loadInternals();
  const input = bytes.subarray(-2).equals(CRLF) ? bytes : Buffer.concat([bytes, CRLF]);
  const responses = await frameResponses(ImapStream, input);
  const [response] = responses;
  if (!response || responses.length !== 1) throw new MalformedImapFetchResponseError("not exactly one response");

  let tokens: unknown;
  try {
    tokens = await Reflect.apply(parser, undefined, [response.payload, { literals: response.literals }]);
  } catch (error) {
    if (isParserError(error)) throw new MalformedImapFetchResponseError("the response does not tokenize");
    throw error;
  }
  const untagged = untaggedFetch.safeParse(tokens);
  if (!untagged.success) throw new MalformedImapFetchResponseError("not an untagged FETCH");

  let formatted: unknown;
  try {
    // A scratch mailbox: the formatter records the highest UID and mod-sequence it sees on it.
    formatted = await Reflect.apply(formatMessageResponse, tools, [untagged.data, { path: "", uidValidity: 0 }]);
  } catch (error) {
    // The formatter dereferences the tokens as the FETCH grammar shapes them; a type error is tokens of another shape.
    if (error instanceof TypeError) throw new MalformedImapFetchResponseError("a data item has the wrong shape");
    throw error;
  }
  const parsed = formattedFetch.safeParse(formatted);
  if (!parsed.success) throw new MalformedImapFetchResponseError("a data item has the wrong shape");
  const { bodyParts, ...message } = parsed.data;
  const sections = new Map<string, Buffer>();
  for (const [key, value] of bodyParts ?? []) sections.set(key, value ?? Buffer.alloc(0));
  return {
    message,
    // imapflow records a header-fields item as `headers` even when its value is NIL.
    hasHeaderFields: typeof formatted === "object" && formatted !== null && "headers" in formatted,
    sections,
  };
}
