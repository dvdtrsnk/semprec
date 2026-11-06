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
