import { describe, expect, it } from "vitest";
import { toApprovalRequestArgumentValues } from "../mcp/approvalRequestArguments.js";

/** The UTF-8 size of the JSON text of `value`, as the cap of `toApprovalRequestArgumentValues` counts it. */
function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/** The record that `JSON.parse` makes of `text`, as a payload read from the database is. */
function parseRecord(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("expected an object");
  return Object.fromEntries(Object.entries(parsed));
}

describe("toApprovalRequestArgumentValues (issue #2021)", () => {
  describe("values that need no change", () => {
    it("returns the values of every JSON type as they are, untruncated", () => {
      const args = {
        to: "ada@example.com",
        subject: "Quarterly numbers",
        cc: ["bob@example.com", "eve@example.com"],
        options: { html: false, retries: 3, replyTo: null, nested: { depth: [1, { two: 2 }] } },
      };

      expect(toApprovalRequestArgumentValues(args)).toEqual({ arguments: args, argumentsTruncated: false });
    });

    it("returns an empty object for no arguments", () => {
      expect(toApprovalRequestArgumentValues({})).toEqual({ arguments: {}, argumentsTruncated: false });
    });

    it("does not change its input", () => {
      const args = { password: "hunter2", body: "x".repeat(3000), nested: { token: "t", items: [1, 2, 3] } };
      const before = JSON.stringify(args);

      toApprovalRequestArgumentValues(args);

      expect(JSON.stringify(args)).toBe(before);
    });

    it("turns a value that is no JSON into null", () => {
      const result = toApprovalRequestArgumentValues({ a: undefined, b: () => 1, c: 10n, d: [undefined] });

      expect(result).toEqual({ arguments: { a: null, b: null, c: null, d: [null] }, argumentsTruncated: false });
    });

    it("keeps a key named __proto__ as a key and does not touch the prototype", () => {
      const result = toApprovalRequestArgumentValues(parseRecord('{"__proto__": {"polluted": true}, "to": "a"}'));

      expect(Object.hasOwn(result.arguments, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(result.arguments)).toBe(Object.prototype);
      expect(Object.hasOwn({}, "polluted")).toBe(false);
      expect(JSON.stringify(result.arguments)).toBe('{"__proto__":{"polluted":true},"to":"a"}');
    });
  });

  describe("redaction", () => {
    it.each(["password", "secret", "token", "apikey", "api_key", "authorization", "cookie", "credential"])(
      "replaces the value of a key that contains %s, in any letter case",
      (part) => {
        const args = {
          [part]: "value-1",
          [part.toUpperCase()]: "value-2",
          [`user_${part}_v2`]: "value-3",
          [`${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`]: "value-4",
          subject: "kept",
        };

        const result = toApprovalRequestArgumentValues(args);

        expect(result.arguments).toEqual({
          [part]: "[redacted]",
          [part.toUpperCase()]: "[redacted]",
          [`user_${part}_v2`]: "[redacted]",
          [`${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`]: "[redacted]",
          subject: "kept",
        });
        expect(result.argumentsTruncated).toBe(false);
        expect(JSON.stringify(result)).not.toContain("value-");
      },
    );

    it("redacts camelCase keys such as apiKey and accessToken", () => {
      const result = toApprovalRequestArgumentValues({ apiKey: "k1", accessToken: "k2", clientSecret: "k3" });

      expect(result.arguments).toEqual({ apiKey: "[redacted]", accessToken: "[redacted]", clientSecret: "[redacted]" });
    });

    it("redacts at any depth: in objects, in objects of arrays and in a header named authorization", () => {
      const result = toApprovalRequestArgumentValues({
        to: "ada@example.com",
        request: {
          url: "https://example.com/hook",
          headers: { Authorization: "Bearer abc.def", "X-Trace": "t-1" },
          retries: [{ attempt: 1, cookie: "sid=1" }, { attempt: 2 }],
        },
      });

      expect(result).toEqual({
        arguments: {
          to: "ada@example.com",
          request: {
            url: "https://example.com/hook",
            headers: { Authorization: "[redacted]", "X-Trace": "t-1" },
            retries: [{ attempt: 1, cookie: "[redacted]" }, { attempt: 2 }],
          },
        },
        argumentsTruncated: false,
      });
    });

    it("replaces a value of any type, an object or an array included, by the string", () => {
      const result = toApprovalRequestArgumentValues({
        token: { value: "t", expires: 1 },
        secret: ["a", "b"],
        password: 12345,
        credential: null,
        cookie: true,
      });

      expect(result.arguments).toEqual({
        token: "[redacted]",
        secret: "[redacted]",
        password: "[redacted]",
        credential: "[redacted]",
        cookie: "[redacted]",
      });
    });

    it("redacts a long value without counting it as a truncation", () => {
      const result = toApprovalRequestArgumentValues({ password: "p".repeat(5000), secret: ["s".repeat(40_000)] });

      expect(result).toEqual({
        arguments: { password: "[redacted]", secret: "[redacted]" },
        argumentsTruncated: false,
      });
    });

    it("does not redact a key that has none of the parts", () => {
      const result = toApprovalRequestArgumentValues({ to: "a", subject: "b", tick: 1, keys: ["c"] });

      expect(result.arguments).toEqual({ to: "a", subject: "b", tick: 1, keys: ["c"] });
    });
  });

  describe("string length", () => {
    it("returns a string of exactly 2,000 characters whole", () => {
      const body = "b".repeat(2000);

      expect(toApprovalRequestArgumentValues({ body })).toEqual({ arguments: { body }, argumentsTruncated: false });
    });

    it("shortens a string of 2,001 characters to 2,000 and flags the truncation", () => {
      const result = toApprovalRequestArgumentValues({ body: `${"b".repeat(2000)}c`, subject: "short" });

      expect(result).toEqual({
        arguments: { body: "b".repeat(2000), subject: "short" },
        argumentsTruncated: true,
      });
    });

    it("shortens a 5,000-character body", () => {
      const result = toApprovalRequestArgumentValues({ to: "ada@example.com", body: "x".repeat(5000) });

      expect(result.arguments).toEqual({ to: "ada@example.com", body: "x".repeat(2000) });
      expect(result.argumentsTruncated).toBe(true);
    });

    it("shortens a string in a nested object and in an array", () => {
      const result = toApprovalRequestArgumentValues({
        message: { parts: ["short", "y".repeat(2500)] },
      });

      expect(result).toEqual({
        arguments: { message: { parts: ["short", "y".repeat(2000)] } },
        argumentsTruncated: true,
      });
    });

    it("does not leave half of a surrogate pair at the cut", () => {
      const result = toApprovalRequestArgumentValues({ body: `${"a".repeat(1999)}\u{1F600}tail` });

      expect(result.arguments).toEqual({ body: "a".repeat(1999) });
      expect(result.argumentsTruncated).toBe(true);
    });
  });

  describe("depth", () => {
    /** An object chain of `levels` objects, each holding the next under `n`; the innermost holds `leaf`. */
    function chain(levels: number): Record<string, unknown> {
      let value: Record<string, unknown> = { leaf: "x" };
      for (let level = 1; level < levels; level += 1) value = { n: value };
      return value;
    }

    it("keeps a value nested in 32 containers", () => {
      const result = toApprovalRequestArgumentValues(chain(32));

      expect(JSON.stringify(result.arguments)).toBe(`${'{"n":'.repeat(31)}{"leaf":"x"}${"}".repeat(31)}`);
      expect(result.argumentsTruncated).toBe(false);
    });

    it("replaces a container at the 33rd level by null and flags the truncation", () => {
      const result = toApprovalRequestArgumentValues(chain(33));

      expect(JSON.stringify(result.arguments)).toBe(`${'{"n":'.repeat(32)}null${"}".repeat(32)}`);
      expect(result.argumentsTruncated).toBe(true);
    });

    it("does not return a credential below the depth limit", () => {
      let value: Record<string, unknown> = { password: "deep-secret-value", safe: "deep-safe-value" };
      for (let level = 0; level < 40; level += 1) value = { n: value };

      const result = toApprovalRequestArgumentValues(value);

      expect(JSON.stringify(result)).not.toContain("deep-secret-value");
      expect(JSON.stringify(result)).not.toContain("deep-safe-value");
      expect(result.argumentsTruncated).toBe(true);
    });

    it("walks a document nested far deeper than the stack could, without recursing past the limit", () => {
      let value: Record<string, unknown> = { leaf: "x" };
      for (let level = 0; level < 200_000; level += 1) value = { n: value };

      const result = toApprovalRequestArgumentValues(value);

      expect(JSON.stringify(result.arguments)).toBe(`${'{"n":'.repeat(32)}null${"}".repeat(32)}`);
      expect(result.argumentsTruncated).toBe(true);
    });

    it("applies the limit to arrays as well", () => {
      let value: unknown = "leaf";
      for (let level = 0; level < 40; level += 1) value = [value];

      const result = toApprovalRequestArgumentValues({ list: value });

      expect(JSON.stringify(result.arguments)).toBe(`{"list":${"[".repeat(31)}null${"]".repeat(31)}}`);
      expect(result.argumentsTruncated).toBe(true);
    });
  });

  describe("the 16 KiB cap", () => {
    /** Entries `k0`, `k1`, ... of `count` strings of 2,000 characters each; one entry takes 2,007 bytes of JSON. */
    function bigEntries(count: number): Record<string, string> {
      return Object.fromEntries(Array.from({ length: count }, (_, index) => [`k${index}`, "a".repeat(2000)]));
    }

    it("keeps arguments of exactly 16,384 bytes whole", () => {
      const entries = bigEntries(8);
      const pad = "p".repeat(16 * 1024 - jsonBytes({ ...entries, p: "" }));
      const args = { ...entries, p: pad };
      expect(jsonBytes(args)).toBe(16 * 1024);

      expect(toApprovalRequestArgumentValues(args)).toEqual({ arguments: args, argumentsTruncated: false });
    });

    it("drops the entry that takes the arguments one byte over the cap, and flags the truncation", () => {
      const entries = bigEntries(8);
      const pad = "p".repeat(16 * 1024 - jsonBytes({ ...entries, p: "" }) + 1);
      expect(jsonBytes({ ...entries, p: pad })).toBe(16 * 1024 + 1);

      const result = toApprovalRequestArgumentValues({ ...entries, p: pad });

      expect(result).toEqual({ arguments: entries, argumentsTruncated: true });
    });

    it("keeps the first entries that fit, in order, and drops the rest", () => {
      const result = toApprovalRequestArgumentValues(bigEntries(10));

      expect(Object.keys(result.arguments)).toEqual(["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7"]);
      expect(jsonBytes(result.arguments)).toBeLessThanOrEqual(16 * 1024);
      expect(result.argumentsTruncated).toBe(true);
    });

    it("keeps a small entry that follows an entry that did not fit", () => {
      const result = toApprovalRequestArgumentValues({ ...bigEntries(9), subject: "Hello" });

      expect(Object.keys(result.arguments)).toEqual(["k0", "k1", "k2", "k3", "k4", "k5", "k6", "k7", "subject"]);
      expect(result.arguments.subject).toBe("Hello");
      expect(jsonBytes(result.arguments)).toBeLessThanOrEqual(16 * 1024);
      expect(result.argumentsTruncated).toBe(true);
    });

    it("counts UTF-8 bytes and not characters", () => {
      // 2,000 euro signs are 6,000 bytes: two entries fit, the third does not.
      const euros = "€".repeat(2000);

      const result = toApprovalRequestArgumentValues({ a: euros, b: euros, c: euros });

      expect(Object.keys(result.arguments)).toEqual(["a", "b"]);
      expect(jsonBytes(result.arguments)).toBeLessThanOrEqual(16 * 1024);
      expect(result.argumentsTruncated).toBe(true);
    });

    it("keeps a prefix of an array that does not fit whole", () => {
      const numbers = Array.from({ length: 10_000 }, (_, index) => index);

      const result = toApprovalRequestArgumentValues({ to: "ada@example.com", numbers });

      expect(result.arguments.to).toBe("ada@example.com");
      const kept = result.arguments.numbers;
      expect(Array.isArray(kept)).toBe(true);
      expect(kept).toEqual(numbers.slice(0, Array.isArray(kept) ? kept.length : 0));
      expect(Array.isArray(kept) ? kept.length : 0).toBeGreaterThan(1000);
      expect(Array.isArray(kept) ? kept.length : 0).toBeLessThan(numbers.length);
      expect(jsonBytes(result.arguments)).toBeLessThanOrEqual(16 * 1024);
      expect(result.argumentsTruncated).toBe(true);
    });

    it("ends the array at an element kept in part and does not fit the elements after it into the leftover room", () => {
      // Nine entries of 2,000 characters take 18 KiB, so the first element is kept in part (eight entries) and
      // leaves room for the two tiny elements that follow it.
      const big = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`e${index}`, "a".repeat(2000)]));

      const result = toApprovalRequestArgumentValues({ list: [big, { x: 1 }, { y: 2 }], after: 1 });

      const kept = result.arguments.list;
      expect(Array.isArray(kept) ? kept.length : 0).toBe(1);
      const first = Array.isArray(kept) ? kept[0] : undefined;
      expect(typeof first === "object" && first !== null && Object.keys(first).length).toBe(8);
      expect(jsonBytes(result.arguments)).toBeLessThanOrEqual(16 * 1024);
      expect(result.argumentsTruncated).toBe(true);
    });

    it("keeps as much of a nested object as fits", () => {
      const nested = Object.fromEntries(Array.from({ length: 5000 }, (_, index) => [`key${index}`, index]));

      const result = toApprovalRequestArgumentValues({ nested, last: "kept" });

      const kept = result.arguments.nested;
      expect(typeof kept === "object" && kept !== null && Object.keys(kept).length > 100).toBe(true);
      expect(result.arguments.last).toBe("kept");
      expect(Object.keys(result.arguments)).toEqual(["nested", "last"]);
      expect(jsonBytes(result.arguments)).toBeLessThanOrEqual(16 * 1024);
      expect(result.argumentsTruncated).toBe(true);
    });

    it("drops an entry whose key alone does not fit", () => {
      const result = toApprovalRequestArgumentValues({ [`k${"x".repeat(20_000)}`]: 1, to: "a" });

      expect(result).toEqual({ arguments: { to: "a" }, argumentsTruncated: true });
    });

    it("applies redaction and shortening before the cap, so a redacted or shortened value takes less room", () => {
      // Ten values of 40,000 characters would be 400,000 bytes; redacted they take 12 bytes each.
      const redacted = Object.fromEntries(
        Array.from({ length: 10 }, (_, index) => [`token${index}`, "t".repeat(40_000)]),
      );

      const result = toApprovalRequestArgumentValues({ ...redacted, body: "b".repeat(40_000) });

      expect(Object.keys(result.arguments)).toHaveLength(11);
      expect(result.arguments.body).toBe("b".repeat(2000));
      expect(result.argumentsTruncated).toBe(true);
    });
  });
});
