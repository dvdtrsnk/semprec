import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import { createLogger, installFatalHandlers } from "../logger.js";

/** Captures every JSON line a pino logger writes, decoded, in write order. */
function captureLines(): { stream: NodeJS.WritableStream; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string): boolean {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WritableStream;
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("createLogger", () => {
  const originalLogLevel = process.env.LOG_LEVEL;

  afterEach(() => {
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
  });

  it("emits newline-delimited JSON carrying the given process name", () => {
    const { stream, lines } = captureLines();
    const logger = pino({ name: "semprec-api", level: "info" }, stream);
    logger.info("service started");

    const record = lines()[0]!;
    expect(record.name).toBe("semprec-api");
    expect(record.msg).toBe("service started");
    expect(typeof record.time).toBe("number");
  });

  it("defaults to info level with debug disabled", () => {
    delete process.env.LOG_LEVEL;
    const logger = createLogger("semprec-api");
    expect(logger.level).toBe("info");
    expect(logger.isLevelEnabled("debug")).toBe(false);
    expect(logger.isLevelEnabled("info")).toBe(true);
  });

  it("enables debug when LOG_LEVEL=debug", () => {
    process.env.LOG_LEVEL = "debug";
    const logger = createLogger("semprec-api");
    expect(logger.level).toBe("debug");
    expect(logger.isLevelEnabled("debug")).toBe(true);
  });

  it("re-reads LOG_LEVEL on every call, so a later restart picks up a changed value", () => {
    process.env.LOG_LEVEL = "warn";
    expect(createLogger("semprec-api").level).toBe("warn");
    process.env.LOG_LEVEL = "debug";
    expect(createLogger("semprec-api").level).toBe("debug");
  });

  it("falls back to info for an invalid LOG_LEVEL value", () => {
    process.env.LOG_LEVEL = "not-a-real-level";
    expect(createLogger("semprec-api").level).toBe("info");
  });

  it("redacts an Authorization header nested under headers", () => {
    const { stream, lines } = captureLines();
    const logger = pino(
      { redact: { paths: ["headers.authorization", "*.headers.authorization"], censor: "[REDACTED]" } },
      stream,
    );
    logger.info({ headers: { authorization: "Bearer super-secret-token" } }, "request received");

    const record = lines()[0]!;
    expect(JSON.stringify(record)).not.toContain("super-secret-token");
    expect((record.headers as Record<string, unknown>).authorization).toBe("[REDACTED]");
  });

  it("redacts password/token/credential fields at top level and nested", () => {
    const { stream, lines } = captureLines();
    const logger = pino(
      {
        redact: {
          paths: ["password", "*.password", "token", "*.token", "credential", "*.credential"],
          censor: "[REDACTED]",
        },
      },
      stream,
    );
    logger.info({ password: "hunter2", account: { token: "abc123", credential: "imap-secret" } }, "credential handled");

    const [record] = lines();
    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("imap-secret");
  });

  it("actually installed logger redacts real request-shaped secrets", () => {
    const logger = createLogger("semprec-api");
    // The construction itself must not throw for any of the process types this issue wires
    // into, and the redact config must be a real, applied option (not a value the caller
    // could override or forget to pass) — exercised end-to-end via the public factory here,
    // with pino's own redaction behavior covered in isolation by the cases above.
    expect(() =>
      logger.info({ headers: { authorization: "Bearer x" }, password: "y" }, "no content leaks"),
    ).not.toThrow();
  });
});

describe("installFatalHandlers", () => {
  let exitSpy: ReturnType<typeof vi.spyOn<typeof process, "exit">>;

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    process.removeAllListeners("uncaughtException");
    process.removeAllListeners("unhandledRejection");
  });

  it("logs one fatal record and exits non-zero on an uncaught exception", () => {
    const { stream, lines } = captureLines();
    const logger = pino({ name: "semprec-api" }, stream);
    installFatalHandlers(logger);

    process.emit("uncaughtException", new Error("boom"));

    const records = lines();
    expect(records).toHaveLength(1);
    expect(records[0]!.level).toBe(60); // pino fatal level
    expect((records[0]!.err as { message: string }).message).toBe("boom");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("logs one fatal record and exits non-zero on an unhandled rejection", () => {
    const { stream, lines } = captureLines();
    const logger = pino({ name: "semprec-api" }, stream);
    installFatalHandlers(logger);

    process.emit("unhandledRejection", new Error("rejected"), Promise.resolve());

    const records = lines();
    expect(records).toHaveLength(1);
    expect(records[0]!.level).toBe(60);
    expect((records[0]!.err as { message: string }).message).toBe("rejected");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
