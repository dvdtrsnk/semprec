import pino, { type Logger } from "pino";
import { currentTenantScope } from "./tenantScope.js";
import { getTraceContext } from "./traceContext.js";

export type { Logger } from "pino";

/**
 * Identifiers may be logged; property values, mail bodies, tool arguments and decrypted credentials may not. Wildcard
 * (`*`) path segments catch secrets at any nesting level, so a new level cannot bypass redaction.
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

// `fast-redact` supports a wildcard segment but no recursive wildcard, so the nesting is bounded explicitly: log
// payloads have at most eight object wrappers before sensitive data.
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

  // pino's serializer keeps `Error.cause`; redact every string in that tree, not just message and stack.
  return redactSerializedError(pino.stdSerializers.err(value));
}

/**
 * Log levels for every Alldots process:
 *
 * - `info`: lifecycle milestones and completed work.
 * - `warn`: unexpected but recoverable degradation or retry.
 * - `error`: failed work the current request or job cannot complete.
 * - `fatal`: process-terminating failure (the fatal handlers below, and a rejected `shutdown()` right before
 *   `process.exit(1)`).
 * - `debug` / `trace`: opt-in via `LOG_LEVEL`, under the same identity-not-content rule.
 */

/** Read on every `createLogger` call, never cached at module scope. */
function resolveLogLevel(): string {
  const raw = process.env.LOG_LEVEL;
  if (!raw) return DEFAULT_LEVEL;
  return VALID_LEVELS.has(raw) ? raw : DEFAULT_LEVEL;
}

/**
 * Newline-delimited JSON to stdout only, every record carrying the process name under `name` so multiplexed stdout can
 * be told apart. Defaults to `info`; `LOG_LEVEL` overrides.
 */
export function createLogger(name: string): Logger {
  return pino({
    name,
    level: resolveLogLevel(),
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    serializers: { err: serializeError },
    // Every record picks up the active trace context and, inside a tenant scope, `tenantId` from `currentTenantScope()`
    // (the single source of truth, deliberately not a trace binding). A field the call site passes explicitly wins:
    // pino merges the log object over the mixin result.
    mixin: () => {
      const trace = getTraceContext() ?? {};
      const scope = currentTenantScope();
      return scope?.kind === "tenant" ? { ...trace, tenantId: scope.tenantId } : trace;
    },
  });
}

/**
 * An uncaught exception or unhandled rejection logs one fatal record, then exits non-zero. Call once from the process
 * entrypoint, never from a module tests import, or a test's own rejection would kill the runner.
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
