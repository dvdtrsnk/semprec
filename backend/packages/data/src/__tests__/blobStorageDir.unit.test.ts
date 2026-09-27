import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveBlobStorageDir } from "../mail/blobStorage.js";

const VARIABLES = ["NODE_ENV", "FILES_STORAGE_DIR", "MAIL_ATTACHMENTS_DIR"] as const;

describe("resolveBlobStorageDir", () => {
  let saved: Record<(typeof VARIABLES)[number], string | undefined>;

  beforeEach(() => {
    saved = {
      NODE_ENV: process.env.NODE_ENV,
      FILES_STORAGE_DIR: process.env.FILES_STORAGE_DIR,
      MAIL_ATTACHMENTS_DIR: process.env.MAIL_ATTACHMENTS_DIR,
    };
  });

  afterEach(() => {
    for (const name of VARIABLES) {
      const value = saved[name];
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("falls back to the /tmp defaults under NODE_ENV=test when the variables are unset", () => {
    process.env.NODE_ENV = "test";
    delete process.env.FILES_STORAGE_DIR;
    delete process.env.MAIL_ATTACHMENTS_DIR;

    expect(resolveBlobStorageDir("FILES_STORAGE_DIR")).toBe("/tmp/semprec-files");
    expect(resolveBlobStorageDir("MAIL_ATTACHMENTS_DIR")).toBe("/tmp/semprec-mail-attachments");
  });

  it("treats an empty variable as unset", () => {
    process.env.NODE_ENV = "test";
    process.env.FILES_STORAGE_DIR = "";

    expect(resolveBlobStorageDir("FILES_STORAGE_DIR")).toBe("/tmp/semprec-files");
  });

  it.each(["test", "production"])("returns the configured value under NODE_ENV=%s", (nodeEnv) => {
    process.env.NODE_ENV = nodeEnv;
    process.env.FILES_STORAGE_DIR = "/opt/semprec/data/files";
    process.env.MAIL_ATTACHMENTS_DIR = "/opt/semprec/data/mail-attachments";

    expect(resolveBlobStorageDir("FILES_STORAGE_DIR")).toBe("/opt/semprec/data/files");
    expect(resolveBlobStorageDir("MAIL_ATTACHMENTS_DIR")).toBe("/opt/semprec/data/mail-attachments");
  });

  it("throws naming the variable outside NODE_ENV=test when it is unset", () => {
    process.env.NODE_ENV = "production";
    delete process.env.FILES_STORAGE_DIR;
    process.env.MAIL_ATTACHMENTS_DIR = "";

    expect(() => resolveBlobStorageDir("FILES_STORAGE_DIR")).toThrow("FILES_STORAGE_DIR is not set");
    expect(() => resolveBlobStorageDir("MAIL_ATTACHMENTS_DIR")).toThrow("MAIL_ATTACHMENTS_DIR is not set");
  });
});
