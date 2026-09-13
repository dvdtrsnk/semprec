import pino, { type Logger } from "pino";

export type { Logger } from "pino";

/**
 * Issue #166's redaction contract: identifiers may be logged, but property
 * values, mail bodies, tool arguments, and decrypted credentials may not.
 * These paths cover every shape a secret has been seen at a log call site —
 * an inbound `Authorization` header, a stored password/token/credential
 * field, however deep it sits in a logged object — using pino's wildcard
 * (`*`) path segments so a new nesting level doesn't silently bypass them.
 */
const REDACT_PATHS = [
  "headers.authorization",
  "headers.Authorization",
  "*.headers.authorization",
  "*.headers.Authorization",
  "*.*.headers.authorization",
  "*.*.headers.Authorization",
  "req.headers.authorization",
  "authorization",
  "Authorization",
  "*.authorization",
  "*.Authorization",
  "*.*.authorization",
  "*.*.Authorization",
  "password",
  "*.password",
  "*.*.password",
  "token",
  "*.token",
  "*.*.token",
  "accessToken",
  "*.accessToken",
  "*.*.accessToken",
  "refreshToken",
  "*.refreshToken",
  "*.*.refreshToken",
  "apiKey",
  "*.apiKey",
  "*.*.apiKey",
  "credential",
  "*.credential",
  "*.*.credential",
  "credentials",
  "*.credentials",
  "*.*.credentials",
];

const DEFAULT_LEVEL = "info";
const VALID_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

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
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "Uncaught exception — terminating process");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.fatal({ err }, "Unhandled promise rejection — terminating process");
    process.exit(1);
  });
}
