import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
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
