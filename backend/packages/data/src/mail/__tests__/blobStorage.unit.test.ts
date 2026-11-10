import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { openBlobFromRoots } from "../../blobs/openBlobFromRoots.js";
import { LocalFsBlobStorageWriter } from "../blobStorage.js";

it("keeps the stream failure when partial-byte cleanup also fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "semprec-storage-failure-"));
  try {
    const storage = new LocalFsBlobStorageWriter(root);
    const original = new Error("primary stream failure");
    const cleanup = vi.spyOn(storage, "delete").mockRejectedValue(new Error("secondary cleanup failure"));
    const source = new Readable({
      read() {
        this.destroy(original);
      },
    });
    await expect(storage.writeStream("partial", source)).rejects.toBe(original);
    expect(cleanup).toHaveBeenCalledWith("partial");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("opens real primary and alternate roots, preserves ranges and reports both missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "semprec-roots-"));
  try {
    const primary = new LocalFsBlobStorageWriter(join(root, "primary"));
    const alternate = new LocalFsBlobStorageWriter(join(root, "alternate"));
    await primary.writeStream("first", Readable.from(["primary"]));
    await alternate.writeStream("second", Readable.from(["alternate"]));
    const primaryStream = await openBlobFromRoots({
      primary,
      alternate,
      storageKey: "first",
      range: { start: 1, end: 3 },
    });
    expect(primaryStream).not.toBeNull();
    const primaryBytes: Buffer[] = [];
    for await (const chunk of primaryStream!) primaryBytes.push(Buffer.from(chunk));
    expect(Buffer.concat(primaryBytes).toString()).toBe("rim");
    const alternateStream = await openBlobFromRoots({ primary, alternate, storageKey: "second" });
    expect(alternateStream).not.toBeNull();
    const alternateBytes: Buffer[] = [];
    for await (const chunk of alternateStream!) alternateBytes.push(Buffer.from(chunk));
    expect(Buffer.concat(alternateBytes).toString()).toBe("alternate");
    await expect(openBlobFromRoots({ primary, alternate, storageKey: "missing" })).resolves.toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("preserves a non-ENOENT primary error without opening the alternate", async () => {
  const root = await mkdtemp(join(tmpdir(), "semprec-roots-error-"));
  try {
    const primary = new LocalFsBlobStorageWriter(join(root, "primary"));
    const alternate = new LocalFsBlobStorageWriter(join(root, "alternate"));
    const original = Object.assign(new Error("controlled read error"), { code: "EACCES" });
    vi.spyOn(primary, "readStream").mockImplementation(
      () =>
        new Readable({
          read() {
            this.destroy(original);
          },
        }),
    );
    const alternateRead = vi.spyOn(alternate, "readStream");
    await expect(openBlobFromRoots({ primary, alternate, storageKey: "key" })).rejects.toBe(original);
    expect(alternateRead).not.toHaveBeenCalled();
  } finally {
    await rm(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  }
});

it("preserves the primary initial-read error and a separate stream cleanup error", async () => {
  const primary = new LocalFsBlobStorageWriter("/unused-primary");
  const alternate = new LocalFsBlobStorageWriter("/unused-alternate");
  const original = new Error("controlled primary read failure");
  const cleanup = new Error("controlled destroy failure");
  const stream = new Readable({
    read() {
      this.emit("error", original);
    },
  });
  vi.spyOn(primary, "readStream").mockReturnValue(stream);
  const destroy = vi.spyOn(stream, "destroy").mockImplementation(() => {
    queueMicrotask(() => {
      destroy.mockRestore();
      stream.destroy();
    });
    throw cleanup;
  });
  const other = vi.spyOn(alternate, "readStream");
  try {
    await expect(openBlobFromRoots({ primary, alternate, storageKey: "key" })).rejects.toMatchObject({
      cause: original,
      errors: [original, cleanup],
    });
    expect(other).not.toHaveBeenCalled();
  } finally {
    destroy.mockRestore();
    stream.destroy();
    vi.restoreAllMocks();
  }
});

it("waits for a delayed primary ENOENT cleanup before opening the alternate", async () => {
  const primary = new LocalFsBlobStorageWriter("/unused-primary");
  const alternate = new LocalFsBlobStorageWriter("/unused-alternate");
  const missing = Object.assign(new Error("controlled missing file"), { code: "ENOENT" });
  let release: (() => void) | undefined;
  const stream = new Readable({
    read() {
      this.emit("error", missing);
    },
    destroy(_error, callback) {
      release = () => {
        release = undefined;
        callback(null);
      };
    },
  });
  vi.spyOn(primary, "readStream").mockReturnValue(stream);
  const second = vi.spyOn(alternate, "readStream").mockImplementation(() => Readable.from(["alternate"]));
  const opened = openBlobFromRoots({ primary, alternate, storageKey: "key" });
  let settled = false;
  const observed = opened.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  let result: Readable | null = null;
  try {
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(settled).toBe(false);
    expect(second).not.toHaveBeenCalled();
    release?.();
    result = await opened;
    expect(stream.closed).toBe(true);
    expect(second).toHaveBeenCalledOnce();
    expect(result).not.toBeNull();
    if (result) {
      const closed = new Promise<void>((resolve) => result!.once("close", resolve));
      result.destroy();
      await closed;
    }
  } finally {
    release?.();
    await observed;
    const outcome = await Promise.allSettled([opened]);
    const returned = outcome[0]?.status === "fulfilled" ? outcome[0].value : null;
    if (returned && !returned.closed) {
      const closed = new Promise<void>((resolve) => returned.once("close", resolve));
      returned.destroy();
      await closed;
    }
    vi.restoreAllMocks();
  }
});

it("waits for delayed abort cleanup and observes emitClose false using public closed", async () => {
  const primary = new LocalFsBlobStorageWriter("/unused-primary");
  const alternate = new LocalFsBlobStorageWriter("/unused-alternate");
  let release: (() => void) | undefined;
  const stream = new Readable({
    emitClose: false,
    read() {},
    destroy(_error, callback) {
      release = () => {
        release = undefined;
        callback(null);
      };
    },
  });
  const control = new AbortController();
  vi.spyOn(primary, "readStream").mockReturnValue(stream);
  const second = vi.spyOn(alternate, "readStream");
  const opened = openBlobFromRoots({ primary, alternate, storageKey: "key", signal: control.signal });
  let settled = false;
  const observed = opened.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    control.abort();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(settled).toBe(false);
    expect(second).not.toHaveBeenCalled();
    release?.();
    await expect(opened).rejects.toMatchObject({ name: "AbortError" });
    expect(stream.closed).toBe(true);
    expect(stream.listenerCount("error")).toBe(0);
    expect(stream.listenerCount("close")).toBe(0);
  } finally {
    release?.();
    await observed;
    vi.restoreAllMocks();
  }
});

it("does not admit the alternate when cancellation occurs during ENOENT cleanup", async () => {
  const primary = new LocalFsBlobStorageWriter("/unused-primary");
  const alternate = new LocalFsBlobStorageWriter("/unused-alternate");
  const missing = Object.assign(new Error("controlled missing file"), { code: "ENOENT" });
  const reason = new Error("cancelled during cleanup");
  let release: (() => void) | undefined;
  const stream = new Readable({
    read() {
      this.emit("error", missing);
    },
    destroy(_error, callback) {
      release = () => {
        release = undefined;
        callback(null);
      };
    },
  });
  const control = new AbortController();
  vi.spyOn(primary, "readStream").mockReturnValue(stream);
  const second = vi.spyOn(alternate, "readStream");
  const opened = openBlobFromRoots({ primary, alternate, storageKey: "key", signal: control.signal });
  const observed = opened.then(
    () => {},
    () => {},
  );
  try {
    await vi.waitFor(() => expect(release).toBeDefined());
    control.abort(reason);
    expect(second).not.toHaveBeenCalled();
    release?.();
    await expect(opened).rejects.toBe(reason);
    expect(stream.closed).toBe(true);
    expect(second).not.toHaveBeenCalled();
  } finally {
    release?.();
    await observed;
    vi.restoreAllMocks();
  }
});

it("uses the same absolute cleanup allowance for both roots under a controlled clock", async () => {
  const primary = new LocalFsBlobStorageWriter("/unused-primary");
  const alternate = new LocalFsBlobStorageWriter("/unused-alternate");
  const firstMissing = Object.assign(new Error("first missing"), { code: "ENOENT" });
  const secondMissing = Object.assign(new Error("second missing"), { code: "ENOENT" });
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const first = new Readable({
    read() {
      this.emit("error", firstMissing);
    },
  });
  const second = new Readable({
    read() {
      this.emit("error", secondMissing);
    },
    destroy(_error, callback) {
      now = 5_001;
      callback(null);
    },
  });
  const secondClosed = new Promise<void>((resolve) => second.once("close", resolve));
  vi.spyOn(primary, "readStream").mockReturnValue(first);
  vi.spyOn(alternate, "readStream").mockImplementation(() => {
    now = 4_999;
    return second;
  });
  try {
    let failure: unknown;
    try {
      await openBlobFromRoots({ primary, alternate, storageKey: "key" });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected shared cleanup deadline failure");
    expect(failure.errors[0]).toBe(secondMissing);
    expect(failure.errors[1]).toMatchObject({
      message: "Blob stream cleanup closure was not observed within its deadline",
    });
    expect(first.closed).toBe(true);
    await secondClosed;
    expect(second.closed).toBe(true);
  } finally {
    if (!first.destroyed) first.destroy();
    if (!second.destroyed) second.destroy();
    await secondClosed;
    vi.restoreAllMocks();
  }
});

it("handles already closed and destroyed-but-not-yet-closed streams", async () => {
  const primary = new LocalFsBlobStorageWriter("/unused-primary");
  const alternate = new LocalFsBlobStorageWriter("/unused-alternate");
  const closedStream = new Readable({ read() {} });
  const closed = new Promise<void>((resolve) => closedStream.once("close", resolve));
  closedStream.destroy();
  await closed;
  const first = vi.spyOn(primary, "readStream").mockReturnValue(closedStream);
  const second = vi.spyOn(alternate, "readStream");
  try {
    await expect(openBlobFromRoots({ primary, alternate, storageKey: "key" })).rejects.toThrow(
      "closed before becoming readable",
    );
    expect(second).not.toHaveBeenCalled();
    const original = new Error("previously observed stream error");
    const failedStream = new Readable({ read() {} });
    const failureClosed = new Promise<void>((resolve) => failedStream.once("close", resolve));
    const observeFailure = () => {};
    failedStream.on("error", observeFailure);
    failedStream.destroy(original);
    await failureClosed;
    failedStream.off("error", observeFailure);
    first.mockReturnValue(failedStream);
    await expect(openBlobFromRoots({ primary, alternate, storageKey: "key" })).rejects.toBe(original);
    let release: (() => void) | undefined;
    const pending = new Readable({
      read() {},
      destroy(_error, callback) {
        release = () => {
          release = undefined;
          callback(null);
        };
      },
    });
    pending.destroy();
    const repeatDestroy = vi.spyOn(pending, "destroy");
    first.mockReturnValue(pending);
    const control = new AbortController();
    const opened = openBlobFromRoots({ primary, alternate, storageKey: "key", signal: control.signal });
    const observed = opened.then(
      () => {},
      () => {},
    );
    try {
      control.abort();
      await vi.waitFor(() => expect(release).toBeDefined());
      expect(pending.closed).toBe(false);
      release?.();
      await expect(opened).rejects.toMatchObject({ name: "AbortError" });
      expect(pending.closed).toBe(true);
      expect(repeatDestroy).not.toHaveBeenCalled();
    } finally {
      release?.();
      await observed;
    }
    expect(second).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

it("does not transfer a stream destroyed immediately after its readable event", async () => {
  const primary = new LocalFsBlobStorageWriter("/unused-primary");
  const alternate = new LocalFsBlobStorageWriter("/unused-alternate");
  const stream = new Readable({
    read() {
      this.emit("readable");
      this.destroy();
    },
  });
  vi.spyOn(primary, "readStream").mockReturnValue(stream);
  const second = vi.spyOn(alternate, "readStream");
  try {
    await expect(openBlobFromRoots({ primary, alternate, storageKey: "key" })).rejects.toThrow(
      "closed before ownership transfer",
    );
    expect(stream.closed).toBe(true);
    expect(second).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

it("preserves primary and asynchronous cleanup errors in order after close", async () => {
  const primary = new LocalFsBlobStorageWriter("/unused-primary");
  const alternate = new LocalFsBlobStorageWriter("/unused-alternate");
  const original = new Error("controlled primary");
  const cleanup = new Error("controlled asynchronous cleanup");
  const stream = new Readable({
    read() {
      this.emit("error", original);
    },
    destroy(_error, callback) {
      callback(cleanup);
    },
  });
  vi.spyOn(primary, "readStream").mockReturnValue(stream);
  const second = vi.spyOn(alternate, "readStream");
  try {
    await expect(openBlobFromRoots({ primary, alternate, storageKey: "key" })).rejects.toMatchObject({
      cause: original,
      errors: [original, cleanup],
    });
    expect(stream.closed).toBe(true);
    expect(second).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

it("preserves a falsy primary stream error after observed cleanup", async () => {
  const primary = new LocalFsBlobStorageWriter("/unused-primary");
  const alternate = new LocalFsBlobStorageWriter("/unused-alternate");
  const stream = new Readable({
    read() {
      this.emit("error", 0);
    },
  });
  vi.spyOn(primary, "readStream").mockReturnValue(stream);
  const second = vi.spyOn(alternate, "readStream");
  try {
    let caught = false;
    let value: unknown;
    try {
      await openBlobFromRoots({ primary, alternate, storageKey: "key" });
    } catch (error) {
      caught = true;
      value = error;
    }
    expect(caught).toBe(true);
    expect(value).toBe(0);
    expect(stream.closed).toBe(true);
    expect(second).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

it("reports an unobserved cleanup deadline and safely observes the eventual late close", async () => {
  const primary = new LocalFsBlobStorageWriter("/unused-primary");
  const alternate = new LocalFsBlobStorageWriter("/unused-alternate");
  const original = Object.assign(new Error("controlled missing file"), { code: "ENOENT" });
  const cleanup = new Error("controlled pending cleanup error");
  const late = new Error("controlled late cleanup error");
  let release: (() => void) | undefined;
  const stream = new Readable({
    read() {
      this.emit("error", original);
    },
    destroy(_error, callback) {
      release = () => {
        release = undefined;
        callback(late);
      };
    },
  });
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  vi.spyOn(primary, "readStream").mockReturnValue(stream);
  const second = vi.spyOn(alternate, "readStream");
  const opened = openBlobFromRoots({ primary, alternate, storageKey: "key" });
  const observed = opened.then(
    () => {},
    () => {},
  );
  try {
    await vi.waitFor(() => expect(release).toBeDefined());
    stream.emit("error", cleanup);
    let failure: unknown;
    try {
      await opened;
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error("Expected cleanup deadline failure");
    expect(failure.errors[0]).toBe(original);
    expect(failure.errors[1]).toBe(cleanup);
    expect(failure.errors[2]).toMatchObject({
      message: "Blob stream cleanup closure was not observed within its deadline",
    });
    expect(second).not.toHaveBeenCalled();
    expect(stream.closed).toBe(false);
  } finally {
    release?.();
    await observed;
    await closed;
    expect(stream.listenerCount("error")).toBe(0);
    expect(stream.listenerCount("close")).toBe(0);
    vi.restoreAllMocks();
  }
}, 15_000);

it("refuses an already aborted open without opening either root", async () => {
  const primary = new LocalFsBlobStorageWriter("/unused-primary");
  const alternate = new LocalFsBlobStorageWriter("/unused-alternate");
  const first = vi.spyOn(primary, "readStream");
  const second = vi.spyOn(alternate, "readStream");
  const reason = new Error("cancelled before open");
  try {
    await expect(
      openBlobFromRoots({ primary, alternate, storageKey: "key", signal: AbortSignal.abort(reason) }),
    ).rejects.toBe(reason);
    expect(first).not.toHaveBeenCalled();
    expect(second).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});

it.each(["primary", "alternate"] as const)(
  "settles an aborted stalled %s initial read without admitting another root",
  async (stalledRoot) => {
    const root = await mkdtemp(join(tmpdir(), "semprec-roots-abort-"));
    try {
      const primary = new LocalFsBlobStorageWriter(join(root, "primary"));
      const alternate = new LocalFsBlobStorageWriter(join(root, "alternate"));
      const stalled = new Readable({ read() {} });
      const closed = once(stalled, "close");
      const control = new AbortController();
      const target = stalledRoot === "primary" ? primary : alternate;
      const alternateRead = vi.spyOn(alternate, "readStream");
      vi.spyOn(target, "readStream").mockReturnValue(stalled);
      const opened = openBlobFromRoots({ primary, alternate, storageKey: "missing", signal: control.signal });
      if (stalledRoot === "alternate") await vi.waitFor(() => expect(alternateRead).toHaveBeenCalledOnce());
      control.abort();
      await expect(opened).rejects.toMatchObject({ name: "AbortError" });
      await closed;
      expect(stalled.destroyed).toBe(true);
      expect(stalled.listenerCount("readable")).toBe(0);
      if (stalledRoot === "primary") expect(alternateRead).not.toHaveBeenCalled();
    } finally {
      await rm(root, { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  },
);

it("does not fall back when cancellation races a primary missing-file event", async () => {
  const primary = new LocalFsBlobStorageWriter("/unused-primary");
  const alternate = new LocalFsBlobStorageWriter("/unused-alternate");
  const control = new AbortController();
  const missing = Object.assign(new Error("controlled missing file"), { code: "ENOENT" });
  const stream = new Readable({
    read() {
      this.emit("error", missing);
    },
  });
  const closed = new Promise<void>((resolve) => stream.once("close", resolve));
  stream.on("error", () => control.abort());
  vi.spyOn(primary, "readStream").mockReturnValue(stream);
  const alternateRead = vi.spyOn(alternate, "readStream");
  try {
    await expect(
      openBlobFromRoots({ primary, alternate, storageKey: "key", signal: control.signal }),
    ).rejects.toBeDefined();
    await closed;
    expect(stream.destroyed).toBe(true);
    expect(alternateRead).not.toHaveBeenCalled();
  } finally {
    vi.restoreAllMocks();
  }
});
