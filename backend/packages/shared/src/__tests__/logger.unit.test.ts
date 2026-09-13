import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
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

  it("the factory redacts real request-shaped secrets", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger("semprec-api");
    let output: unknown;
    try {
      logger.info(
        {
          headers: {
            authorization: "Bearer super-secret-token",
            Authorization: "Bearer canonical-header-secret",
          },
          password: "hunter2",
          token: "abc123",
        },
        "no content leaks",
      );
      output = writeSpy.mock.calls[0]![0];
    } finally {
      writeSpy.mockRestore();
    }

    const record = JSON.parse(String(output)) as Record<string, unknown>;
    expect(JSON.stringify(record)).not.toContain("super-secret-token");
    expect(JSON.stringify(record)).not.toContain("canonical-header-secret");
    expect(JSON.stringify(record)).not.toContain("hunter2");
    expect(JSON.stringify(record)).not.toContain("abc123");
    expect((record.headers as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect((record.headers as Record<string, unknown>).Authorization).toBe("[REDACTED]");
    expect(record.password).toBe("[REDACTED]");
    expect(record.token).toBe("[REDACTED]");
  });

  it("redacts credential values embedded in an error message and stack", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const logger = createLogger("mail-sync");
    let output: unknown;
    try {
      logger.error(
        { err: new Error("Authentication failed: Authorization: Bearer provider-access-secret") },
        "Mail sync failed",
      );
      output = writeSpy.mock.calls[0]![0];
    } finally {
      writeSpy.mockRestore();
    }

    const record = JSON.parse(String(output)) as { err: { message: string; stack: string } };
    expect(JSON.stringify(record)).not.toContain("provider-access-secret");
    expect(record.err.message).toContain("[REDACTED]");
    expect(record.err.stack).toContain("[REDACTED]");
  });
});

describe("installFatalHandlers", () => {
  let exitSpy: MockInstance<typeof process.exit>;
  const originalUncaughtExceptionListeners = new Set(process.listeners("uncaughtException"));
  const originalUnhandledRejectionListeners = new Set(process.listeners("unhandledRejection"));

  beforeEach(() => {
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    for (const listener of process.listeners("uncaughtException")) {
      if (!originalUncaughtExceptionListeners.has(listener)) {
        process.removeListener("uncaughtException", listener);
      }
    }
    for (const listener of process.listeners("unhandledRejection")) {
      if (!originalUnhandledRejectionListeners.has(listener)) {
        process.removeListener("unhandledRejection", listener);
      }
    }
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
