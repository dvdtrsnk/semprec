import { describe, expect, expectTypeOf, it } from "vitest";
import { mergeOps } from "../chokePoint/mergeOps.js";

describe("mergeOps", () => {
  it("merges disjoint parts, keeping each method's original type and this-free behavior", () => {
    const sectionA = { a: () => 1 };
    const sectionB = { b: () => "x" };
    const merged = mergeOps(sectionA, sectionB);

    expectTypeOf(merged).toEqualTypeOf<typeof sectionA & typeof sectionB>();
    expectTypeOf(merged.a).toEqualTypeOf<() => number>();
    expectTypeOf(merged.b).toEqualTypeOf<() => string>();
    // Inline parts: both keys are present with types assignable to the originals.
    const inline: { a: () => number; b: () => string } = mergeOps({ a: () => 1 }, { b: () => "x" });
    expect(inline.a()).toBe(1);
    expect(Object.keys(merged).sort()).toEqual(["a", "b"]);

    // Detached calls prove neither method depends on `this`.
    const { a, b } = merged;
    expect(a()).toBe(1);
    expect(b()).toBe("x");
  });

  it("throws on a key present in more than one part, naming the key", () => {
    expect(() => mergeOps({ a: () => 1, shared: () => 1 }, { b: () => 2 }, { shared: () => 3 })).toThrow(
      /duplicate key "shared"/,
    );
  });

  it("throws on a duplicate symbol key, naming it", () => {
    const key = Symbol("sectionKey");
    expect(() => mergeOps({ [key]: 1 }, { [key]: 2 })).toThrow(/Symbol\(sectionKey\)/);
  });

  it("ignores non-enumerable own keys when checking for duplicates", () => {
    const hidden = Object.defineProperty({ a: 1 }, "b", { value: 2, enumerable: false });
    const merged = mergeOps(hidden, { b: 3 });
    expect(merged).toEqual({ a: 1, b: 3 });
  });

  it("returns an empty object for zero parts", () => {
    const merged = mergeOps();
    expectTypeOf(merged).toEqualTypeOf<Record<never, never>>();
    expect(merged).toEqual({});
  });

  it("returns a copy of a single part, not the part itself", () => {
    const part = { a: () => 1 };
    const merged = mergeOps(part);
    expectTypeOf(merged).toEqualTypeOf<{ a: () => number }>();
    expect(merged).not.toBe(part);
    expect(merged.a).toBe(part.a);
  });

  it("does not mutate the parts, on success or on a duplicate", () => {
    const a = { a: () => 1 };
    const b = { b: () => "x" };
    const merged = mergeOps(a, b);
    expect(Object.keys(a)).toEqual(["a"]);
    expect(Object.keys(b)).toEqual(["b"]);
    expect(merged).not.toBe(a);
    expect(merged).not.toBe(b);

    const dupe = { a: () => 2 };
    expect(() => mergeOps(a, dupe)).toThrow();
    expect(Object.keys(a)).toEqual(["a"]);
    expect(Object.keys(dupe)).toEqual(["a"]);
    expect(a.a()).toBe(1);
  });
});
