import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import * as credentials from "@semprec/credentials";
import {
  generateDataKey,
  openSecret,
  sealSecret,
  unwrapDataKey,
  wrapDataKey,
  type EncryptedSecret,
} from "@semprec/credentials";

const ad = (text: string): Uint8Array => new TextEncoder().encode(text);

async function expectOpenFailure(promise: Promise<unknown>): Promise<void> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe(
    "Failed to open sealed secret: wrong key, associated data or corrupted ciphertext",
  );
  expect("code" in (error as Error)).toBe(false);
}

describe("sealSecret / openSecret", () => {
  it("round-trips with the same key and associated data", async () => {
    const key = await generateDataKey();
    expect(key).toHaveLength(32);
    const sealed = await sealSecret("hunter2", key, ad("a"));
    expect((await openSecret(sealed, key, ad("a"))).toString("utf8")).toBe("hunter2");
  });

  it("round-trips binary plaintext", async () => {
    const key = await generateDataKey();
    const bytes = Uint8Array.from([0, 1, 2, 255]);
    const sealed = await sealSecret(bytes, key, ad("a"));
    expect([...(await openSecret(sealed, key, ad("a")))]).toEqual([...bytes]);
  });

  it("refuses different associated data", async () => {
    const key = await generateDataKey();
    const sealed = await sealSecret("x", key, ad("a"));
    await expectOpenFailure(openSecret(sealed, key, ad("b")));
  });

  it("refuses a flipped ciphertext byte", async () => {
    const key = await generateDataKey();
    const sealed = await sealSecret("x", key, ad("a"));
    const tampered: EncryptedSecret = { ciphertext: Buffer.from(sealed.ciphertext), nonce: sealed.nonce };
    tampered.ciphertext[0] = (tampered.ciphertext[0] ?? 0) ^ 1;
    await expectOpenFailure(openSecret(tampered, key, ad("a")));
  });

  it("refuses a different key", async () => {
    const sealed = await sealSecret("x", await generateDataKey(), ad("a"));
    await expectOpenFailure(openSecret(sealed, await generateDataKey(), ad("a")));
  });

  it("uses a fresh nonce for every seal", async () => {
    const key = await generateDataKey();
    const first = await sealSecret("same", key, ad("a"));
    const second = await sealSecret("same", key, ad("a"));
    expect(first.nonce).toHaveLength(24);
    expect(first.nonce.equals(second.nonce)).toBe(false);
    expect(first.ciphertext.equals(second.ciphertext)).toBe(false);
  });

  it("rejects a key that is not 32 bytes", async () => {
    await expect(sealSecret("x", Buffer.alloc(31), ad("a"))).rejects.toThrow("Data key must be 32 bytes");
    await expect(sealSecret("x", Buffer.alloc(33), ad("a"))).rejects.toThrow("Data key must be 32 bytes");
  });
});

describe("wrapDataKey / unwrapDataKey", () => {
  it("round-trips for the same tenant", async () => {
    const masterKey = await generateDataKey();
    const dataKey = await generateDataKey();
    const tenantId = randomUUID();
    const wrapped = await wrapDataKey(dataKey, masterKey, tenantId);
    expect((await unwrapDataKey(wrapped, masterKey, tenantId)).equals(dataKey)).toBe(true);
  });

  it("refuses another tenant id", async () => {
    const masterKey = await generateDataKey();
    const wrapped = await wrapDataKey(await generateDataKey(), masterKey, randomUUID());
    await expectOpenFailure(unwrapDataKey(wrapped, masterKey, randomUUID()));
  });

  it.each([0, 16, 31, 33])("refuses to wrap a %i-byte data key", async (length) => {
    const masterKey = await generateDataKey();
    const error = await wrapDataKey(Buffer.alloc(length), masterKey, randomUUID()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(`Data key to wrap must be 32 bytes, got ${length}`);
    expect("code" in (error as Error)).toBe(false);
  });

  it("refuses an unwrapped value that is not a 32-byte key", async () => {
    const masterKey = await generateDataKey();
    const tenantId = randomUUID();
    // Sealed directly because wrapDataKey now refuses a short key; same associated data as wrapDataKey.
    const wrapped = await sealSecret(Buffer.alloc(16), masterKey, ad(`semprec:tenant-key:v1:${tenantId}`));
    await expect(unwrapDataKey(wrapped, masterKey, tenantId)).rejects.toThrow(
      "Unwrapped data key must be 32 bytes, got 16",
    );
  });
});

describe("@semprec/credentials exports (issue #1069)", () => {
  it("no longer exports the retired secretbox encryptSecret/decryptSecret", () => {
    expect(Object.keys(credentials)).not.toContain("encryptSecret");
    expect(Object.keys(credentials)).not.toContain("decryptSecret");
    expect(Object.keys(credentials)).toEqual(expect.arrayContaining(["sealSecret", "openSecret", "unwrapDataKey"]));
  });
});
