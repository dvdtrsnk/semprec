import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { BlobReadCleanupError, settleBlobReadStream } from "../settleBlobReadStream.js";

describe("settleBlobReadStream", () => {
  it("waits for actual delayed closure and preserves a successful primary outcome", async () => {
    let release: (() => void) | undefined;
    const stream = new Readable({
      read() {},
      destroy(_error, callback) {
        release = () => callback(null);
      },
    });
    let returned = false;
    const settlement = settleBlobReadStream(stream, {}).then(() => {
      returned = true;
    });
    expect(stream.destroyed).toBe(true);
    expect(stream.closed).toBe(false);
    expect(returned).toBe(false);
    if (!release) throw new Error("Destroy was not entered");
    release();
    await settlement;
    expect(stream.closed).toBe(true);
    expect(stream.listenerCount("error")).toBe(0);
    await settleBlobReadStream(stream, {}, { error: false });
  });

  it.each([undefined, null, false])(
    "preserves tagged primary %s before a distinct asynchronous cleanup error",
    async (primary) => {
      const cleanup = new Error("synthetic cleanup failure");
      const stream = new Readable({
        read() {},
        destroy(_error, callback) {
          callback(cleanup);
        },
      });
      let caught: unknown;
      try {
        await settleBlobReadStream(stream, {}, { error: primary });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BlobReadCleanupError);
      if (!(caught instanceof BlobReadCleanupError)) throw new Error("Missing typed cleanup failure");
      expect(caught.errors).toEqual([primary, cleanup]);
      expect(caught.cause).toBe(primary);
      expect(stream.closed).toBe(true);
    },
  );

  it("observes public closed without a close event and handles a destroy already in progress", async () => {
    let release: (() => void) | undefined;
    const stream = new Readable({
      emitClose: false,
      read() {},
      destroy(_error, callback) {
        release = () => callback(null);
      },
    });
    stream.destroy();
    const settlement = settleBlobReadStream(stream, {});
    if (!release) throw new Error("Destroy was not entered");
    release();
    await settlement;
    expect(stream.closed).toBe(true);
    expect(stream.listenerCount("error")).toBe(0);
  });

  it("retains a synchronous cleanup failure after delegated destruction without a primary", async () => {
    const cleanup = new Error("synthetic synchronous destroy failure");
    const stream = new Readable({ read() {} });
    const destroy = stream.destroy.bind(stream);
    stream.destroy = (error?: Error) => {
      destroy(error);
      throw cleanup;
    };
    let caught: unknown;
    try {
      await settleBlobReadStream(stream, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BlobReadCleanupError);
    if (!(caught instanceof BlobReadCleanupError)) throw new Error("Missing typed cleanup failure");
    expect(caught.errors).toEqual([cleanup]);
    expect(caught.cause).toBe(cleanup);
    expect(stream.closed).toBe(true);
  });

  it("reports a bounded stalled cleanup and observes its eventual late error and close", async () => {
    const primary = new Error("synthetic read failure");
    const cleanup = new Error("synthetic asynchronous cleanup failure");
    const late = new Error("synthetic late cleanup failure");
    let release: (() => void) | undefined;
    const stream = new Readable({
      read() {},
      destroy(_error, callback) {
        release = () => callback(late);
      },
    });
    const closed = new Promise<void>((resolve) => stream.once("close", resolve));
    try {
      let caught: unknown;
      try {
        const settlement = settleBlobReadStream(stream, {}, { error: primary });
        stream.emit("error", cleanup);
        await settlement;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(BlobReadCleanupError);
      if (!(caught instanceof BlobReadCleanupError)) throw new Error("Missing typed cleanup failure");
      expect(caught.errors[0]).toBe(primary);
      expect(caught.errors[1]).toBe(cleanup);
      expect(caught.errors[2]).toBeInstanceOf(Error);
      expect(caught.cause).toBe(primary);
      expect(stream.closed).toBe(false);
    } finally {
      if (release) {
        release();
        await closed;
      }
    }
    expect(stream.listenerCount("error")).toBe(0);
  }, 15_000);
});
