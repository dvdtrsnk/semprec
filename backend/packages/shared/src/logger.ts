import pino, { type Logger } from "pino";
import { getTraceContext } from "./traceContext.js";

export type { Logger } from "pino";

/**
 * Issue #166's redaction contract: identifiers may be logged, but property
 * values, mail bodies, tool arguments, and decrypted credentials may not.
 * These paths cover every shape a secret has been seen at a log call site —
 * an inbound `Authorization` header, a stored password/token/credential
 * field, however deep it sits in a logged object — using pino's wildcard
 * (`*`) path segments so a new nesting level doesn't silently bypass them.
 */
const SECRET_FIELD_NAMES = [
  "authorization",
  "Authorization",
  "password",
  "token",
  "accessToken",
  "refreshToken",
  "apiKey",
  "credential",
  "credentials",
];
const AUTHORIZATION_HEADER_NAMES = ["authorization", "Authorization"];

// `fast-redact`, which pino uses, supports a wildcard segment but not an unbounded
// recursive wildcard. Keep the supported nesting deliberately bounded and explicit:
// application log payloads have at most eight object wrappers before sensitive data.
const MAX_REDACTION_DEPTH = 8;
const REDACT_PATHS = Array.from({ length: MAX_REDACTION_DEPTH + 1 }, (_, depth) => {
  const prefix = Array.from({ length: depth }, () => "*");
  return [
    ...SECRET_FIELD_NAMES.map((field) => [...prefix, field].join(".")),
    ...AUTHORIZATION_HEADER_NAMES.map((header) => [...prefix, "headers", header].join(".")),
  ];
}).flat();

const DEFAULT_LEVEL = "info";
const VALID_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const SECRET_IN_ERROR_TEXT =
  /\b(authorization\s*[:=]\s*(?:bearer\s+)?|(?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|credential|token)\s*[:=]\s*)([^\s,;"']+)/gi;

function redactErrorText(value: string): string {
  return value.replace(SECRET_IN_ERROR_TEXT, "$1[REDACTED]");
}

function redactSerializedError(value: unknown, visited = new WeakSet<object>()): unknown {
  if (typeof value === "string") return redactErrorText(value);
  if (typeof value !== "object" || value === null) return value;
  if (visited.has(value)) return "[Circular]";
  visited.add(value);
  if (Array.isArray(value)) return value.map((entry) => redactSerializedError(entry, visited));
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSerializedError(entry, visited)]));
}

function serializeError(value: unknown): unknown {
  if (!(value instanceof Error)) {
    return typeof value === "string" ? redactErrorText(value) : value;
  }

  // pino's standard serializer retains `Error.cause` objects. Redact every string
  // in that serialized tree, not merely the top-level message and stack.
  return redactSerializedError(pino.stdSerializers.err(value));
}

/**
 * Log-level semantics for every Semprec process:
 *
 * - `info` records normal lifecycle milestones and completed work.
 * - `warn` records an unexpected but recoverable degradation or retry.
 * - `error` records failed work that the current request or job cannot complete.
 * - `fatal` records a process-terminating failure, exclusively via the shared
 *   fatal handlers below.
 * - `debug` and `trace` are opt-in diagnostics, enabled only through
 *   `LOG_LEVEL`; they must follow the same identity-not-content rule.
 */

/**
 * Read fresh on every `createLogger` call (never cached at module scope) so a
 * changed `LOG_LEVEL` takes effect on the next process restart without a rebuild.
 */
function resolveLogLevel(): string {
  const raw = process.env.LOG_LEVEL;
  if (!raw) return DEFAULT_LEVEL;
  return VALID_LEVELS.has(raw) ? raw : DEFAULT_LEVEL;
}

/**
 * Builds a named root logger for one process type (`"semprec-api"`,
 * `"agents"`, `"transcribe"`, `"semprec-ai-gateway"`, `"mail-sync"`, ...).
 * Emits newline-delimited JSON to stdout only — no file, no aggregator
 * transport — with every record carrying the process name under `name` so
 * multiplexed stdout (journald, `docker logs`) can still be told apart.
 * `debug` is opt-in only, via `LOG_LEVEL`; everything else defaults to `info`.
 */
export function createLogger(name: string): Logger {
  return pino({
    name,
    level: resolveLogLevel(),
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    serializers: { err: serializeError },
    // Issue #167: every record picks up the active trace context (traceId and whichever of
    // agentRunId/jobName/jobId/mailboxId are bound) without every call site passing it explicitly.
    // A field a call site also passes explicitly (e.g. gateway.ts's own `agentRunId`) wins, since
    // pino merges the log object over the mixin result.
    mixin: () => getTraceContext() ?? {},
  });
}

/**
 * Installs the shared fatal-failure path for one process: an uncaught
 * exception or unhandled promise rejection logs exactly one fatal record
 * through the given root logger, then exits non-zero. Call once, from the
 * process's own entrypoint (`serve.ts`) — never from a module a test file
 * also imports, or a test's own uncaught rejection would kill the test runner.
 */
export function installFatalHandlers(logger: Logger): void {
  process.once("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception — terminating process");
    process.exit(1);
  });
  process.once("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.fatal({ err }, "Unhandled promise rejection — terminating process");
    process.exit(1);
  });
}
