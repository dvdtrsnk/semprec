import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../auth/passwordHash.js";
import { generateOpaqueToken, hashToken, secureCompare } from "../auth/token.js";

describe("hashPassword / verifyPassword", () => {
  it("hashes with Argon2id and verifies the original password against it", async () => {
    const passwordHash = await hashPassword("correct horse battery staple");

    expect(passwordHash).toMatch(/^\$argon2id\$/);
    expect(passwordHash).not.toContain("correct horse battery staple");
    await expect(verifyPassword(passwordHash, "correct horse battery staple")).resolves.toBe(true);
  });

  it("rejects a wrong password", async () => {
    const passwordHash = await hashPassword("correct horse battery staple");
    await expect(verifyPassword(passwordHash, "wrong password")).resolves.toBe(false);
  });

  it("rejects a malformed hash instead of throwing", async () => {
    await expect(verifyPassword("not-a-real-hash", "anything")).resolves.toBe(false);
  });

  it("salts independently, so hashing the same password twice yields different hashes", async () => {
    const first = await hashPassword("same password");
    const second = await hashPassword("same password");
    expect(first).not.toBe(second);
  });
});

describe("generateOpaqueToken / hashToken", () => {
  it("generates a random token distinct from its own stored hash", () => {
    const { token, tokenHash } = generateOpaqueToken();
    expect(token).not.toBe(tokenHash);
    expect(tokenHash).toBe(hashToken(token));
  });

  it("generates distinct tokens across calls", () => {
    const a = generateOpaqueToken();
    const b = generateOpaqueToken();
    expect(a.token).not.toBe(b.token);
    expect(a.tokenHash).not.toBe(b.tokenHash);
  });
});

describe("secureCompare", () => {
  it("matches equal strings and rejects differing ones, including differing lengths", () => {
    expect(secureCompare("abc123", "abc123")).toBe(true);
    expect(secureCompare("abc123", "abc124")).toBe(false);
    expect(secureCompare("abc123", "abc1234")).toBe(false);
  });
});
