import { describe, expect, it } from "vitest";
import { fnv1a32, libraryFallbackColorVar } from "../fallbackColor.js";

describe("fallback color hashing", () => {
  it("computes 32-bit FNV-1a over the UTF-8 bytes of the input", () => {
    expect(fnv1a32("item-1")).toBe(2941391840);
    expect(fnv1a32("item-2")).toBe(2991724697);
    expect(fnv1a32("a")).toBe(3826002220);
  });

  it("selects a deterministic --library-fallback-1..6 variable from the item id", () => {
    expect(libraryFallbackColorVar("item-1")).toBe("var(--library-fallback-3)");
    expect(libraryFallbackColorVar("item-2")).toBe("var(--library-fallback-6)");
    expect(libraryFallbackColorVar("item-1")).toBe(libraryFallbackColorVar("item-1"));
  });
});
