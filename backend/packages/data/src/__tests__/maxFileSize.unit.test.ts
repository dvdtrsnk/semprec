import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_FILE_SIZE_MB, readMaxFileSizeBytes } from "../mail/blobStorage.js";

describe("the upload limit of the deployment (MAX_FILE_SIZE_MB)", () => {
  it("is 100 MB, a megabyte counted as 1024 * 1024 bytes, when the variable is not set", () => {
    expect(DEFAULT_MAX_FILE_SIZE_MB).toBe(100);
    expect(readMaxFileSizeBytes({})).toBe(100 * 1024 * 1024);
  });

  it("is the value of the variable in bytes, a fraction of a megabyte included", () => {
    expect(readMaxFileSizeBytes({ MAX_FILE_SIZE_MB: "25" })).toBe(25 * 1024 * 1024);
    expect(readMaxFileSizeBytes({ MAX_FILE_SIZE_MB: "0.5" })).toBe(512 * 1024);
  });

  it.each(["0", "-1", "abc", "Infinity", "NaN"])("refuses the value %j as a deployment error", (value) => {
    expect(() => readMaxFileSizeBytes({ MAX_FILE_SIZE_MB: value })).toThrow(
      `MAX_FILE_SIZE_MB is not a valid positive number: ${value}`,
    );
  });
});
