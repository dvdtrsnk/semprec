import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFsBlobStorageWriter, MaxBytesExceededError } from "../blobStorage.js";

// The writer's `mkdir` waits for a gate the test controls, which makes the window between "writeStream is
// called" and "the directory exists" as long as the test needs, with no sleep and no load. Every other
// function of `node:fs/promises` is the real one.
const mkdirGate = vi.hoisted(() => ({ current: undefined as Promise<void> | undefined }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof mkdir>) => {
      await mkdirGate.current;
      return actual.mkdir(...args);
    },
  };
});

interface Gate {
  open(): void;
  fail(error: Error): void;
}

/** Closes the `mkdir` gate until `open` or `fail` is called. */
function closeMkdirGate(): Gate {
  let open!: () => void;
  let fail!: (error: Error) => void;
  mkdirGate.current = new Promise<void>((resolve, reject) => {
    open = resolve;
    fail = reject;
  });
  return { open, fail };
}

describe("LocalFsBlobStorageWriter.writeStream attaches to its source before it creates the directory", () => {
  let root: string;
  let storage: LocalFsBlobStorageWriter;
  const uncaught = vi.fn();

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "semprec-blob-attach-"));
    storage = new LocalFsBlobStorageWriter(root);
    uncaught.mockClear();
    process.on("uncaughtException", uncaught);
  });

  afterEach(async () => {
    process.off("uncaughtException", uncaught);
    mkdirGate.current = undefined;
    await rm(root, { recursive: true, force: true });
  });

  /** Resolves when `source` is closed; unlike `once(source, "close")` it does not reject on the source's error. */
  function closedPromise(source: Readable): Promise<void> {
    return new Promise((resolve) => source.once("close", resolve));
  }

  /** Lets every callback that is already queued run, so the stream chain has taken all it can before the test goes on. */
  function settled(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  async function exists(storageKey: string): Promise<boolean> {
    try {
      await stat(join(root, storageKey));
      return true;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  }

  it("stores everything a child process wrote when the child exits while the directory is still being created", async () => {
    const child = spawn(process.execPath, ["-e", "process.stdout.write(Buffer.alloc(8192, 7))"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const closed = once(child, "close");
    const gate = closeMkdirGate();
    void closed.then(() => gate.open());

    const stored = await storage.writeStream("tenant/child-output", child.stdout);

    const expected = Buffer.alloc(8192, 7);
    expect(stored.byteSize).toBe(8192);
    expect(stored.contentHash).toBe(createHash("sha256").update(expected).digest("hex"));
    expect(await readFile(join(root, "tenant/child-output"))).toEqual(expected);
  });

  it("consumes the source and observes its errors while the directory is pending", async () => {
    const gate = closeMkdirGate();
    const source = new Readable({ read() {} });
    source.push(Buffer.alloc(16, 1));

    const written = storage.writeStream("tenant/pending", source);

    expect(source.listenerCount("error")).toBeGreaterThan(0);
    expect(source.readableFlowing).toBe(true);
    gate.open();
    source.push(null);
    await expect(written).resolves.toMatchObject({ byteSize: 16 });
  });

  it("rejects with the source's own error when the source fails while the directory is pending, leaving no file", async () => {
    const gate = closeMkdirGate();
    const failure = new Error("source failed while the directory was pending");
    const source = new Readable({ read() {} });
    source.push(Buffer.alloc(16, 1));

    const written = storage.writeStream("tenant/source-fails", source);
    written.catch(() => undefined);
    const sourceClosed = closedPromise(source);
    source.destroy(failure);
    await sourceClosed;
    gate.open();

    await expect(written).rejects.toBe(failure);
    expect(await exists("tenant/source-fails")).toBe(false);
    expect(uncaught).not.toHaveBeenCalled();
  });

  it("rejects with the mkdir error, destroys the source with that same error and stores nothing", async () => {
    const gate = closeMkdirGate();
    const mkdirFailure = Object.assign(new Error("mkdir refused"), { code: "EACCES" });
    const source = new Readable({ read() {} });
    source.push(Buffer.alloc(16, 1));

    const written = storage.writeStream("tenant/mkdir-fails", source);
    written.catch(() => undefined);
    gate.fail(mkdirFailure);

    await expect(written).rejects.toBe(mkdirFailure);
    expect(source.errored).toBe(mkdirFailure);
    expect(source.destroyed).toBe(true);
    expect(await exists("tenant/mkdir-fails")).toBe(false);
  });

  it("rejects with MaxBytesExceededError when maxBytes is exceeded while the directory is pending, leaving no file", async () => {
    const gate = closeMkdirGate();
    const source = new Readable({ read() {} });
    source.push(Buffer.alloc(100, 1));

    const written = storage.writeStream("tenant/too-large", source, { maxBytes: 10 });
    written.catch(() => undefined);
    await settled();
    gate.open();

    const error: unknown = await written.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(MaxBytesExceededError);
    expect(source.errored).toBe(error);
    expect(await exists("tenant/too-large")).toBe(false);
  });

  it("stores a source larger than the intake buffers completely when the directory is created late", async () => {
    const chunkSize = 64 * 1024;
    const chunkCount = 64;
    const chunkAt = (index: number) => Buffer.alloc(chunkSize, index % 251);
    const expectedHash = createHash("sha256");
    for (let index = 0; index < chunkCount; index += 1) expectedHash.update(chunkAt(index));

    let produced = 0;
    async function* chunks(): AsyncGenerator<Buffer> {
      for (let index = 0; index < chunkCount; index += 1) {
        produced += 1;
        yield chunkAt(index);
      }
    }
    const gate = closeMkdirGate();

    const written = storage.writeStream("tenant/large", Readable.from(chunks()));
    // The streams in the chain are in memory and settle within a macrotask, so the producer is stable once it
    // stops advancing from one turn of the event loop to the next.
    let before: number;
    do {
      before = produced;
      await settled();
    } while (produced !== before);
    // The intake chain holds a bounded amount, so the producer is paused long before it has produced it all.
    const producedWhilePending = produced;
    gate.open();

    const stored = await written;

    expect(producedWhilePending).toBeLessThan(chunkCount);
    expect(stored.byteSize).toBe(chunkSize * chunkCount);
    expect(stored.contentHash).toBe(expectedHash.digest("hex"));
    expect((await stat(join(root, "tenant/large"))).size).toBe(chunkSize * chunkCount);
  });
});
