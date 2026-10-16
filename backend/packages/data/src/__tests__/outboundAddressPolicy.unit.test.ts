import https from "node:https";
import type { LookupAddress } from "node:dns";
import { afterEach, describe, expect, it } from "vitest";
import {
  OutboundAddressNotAllowedError,
  allowLoopbackOutboundForTests,
  createOutboundHttp,
  currentOutboundAddressPolicy,
  isOutboundAddressNotAllowed,
  isPublicAddress,
  publicOnlyLookup,
} from "../net/outboundAddressPolicy.js";
import { stubDnsLookup, type DnsLookupStub } from "../testSupport/dnsLookupStub.js";

let stub: DnsLookupStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

type LookupResult = { err: NodeJS.ErrnoException | null; address: string | LookupAddress[]; family?: number };

function lookup(hostname: string, all: boolean): Promise<LookupResult> {
  return new Promise((resolve) => {
    publicOnlyLookup(hostname, { all }, (err, address, family) => resolve({ err, address, family }));
  });
}

describe("isPublicAddress (issue #1034)", () => {
  it.each([
    "0.1.2.3",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%eth0",
    "ff02::1",
    "2001:db8::1",
    "100::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
    "64:ff9b::10.1.2.3",
  ])("denies %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(["93.184.216.34", "2606:2800:220:1::1", "::ffff:93.184.216.34", "64:ff9b::5db8:d822"])(
    "allows %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it("denies a value that is not an IP address", () => {
    expect(isPublicAddress("example.com")).toBe(false);
  });
});

describe("publicOnlyLookup (issue #1034)", () => {
  it("fails with OutboundAddressNotAllowedError for a host resolving to loopback", async () => {
    stub = stubDnsLookup({ "loopback.test": ["127.0.0.1"] });
    const { err } = await lookup("loopback.test", false);
    expect(err).toBeInstanceOf(OutboundAddressNotAllowedError);
    expect(err?.message).toContain("loopback.test");
  });

  it("fails when one of several addresses is private", async () => {
    stub = stubDnsLookup({ "mixed.test": ["93.184.216.34", "10.0.0.5"] });
    const { err } = await lookup("mixed.test", true);
    expect(err).toBeInstanceOf(OutboundAddressNotAllowedError);
  });

  it("hands over the vetted address for a host resolving to public addresses only", async () => {
    stub = stubDnsLookup({ "public.test": ["93.184.216.34", "2606:2800:220:1::1"] });
    expect(await lookup("public.test", false)).toEqual({ err: null, address: "93.184.216.34", family: 4 });
    expect(await lookup("public.test", true)).toEqual({
      err: null,
      address: [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1::1", family: 6 },
      ],
      family: undefined,
    });
    // One resolution per lookup: the socket is handed the result instead of resolving again.
    expect(stub.calls).toEqual(["public.test", "public.test"]);
  });

  it("passes a resolution failure through unchanged", async () => {
    const { err } = await lookup("does-not-exist.invalid", false);
    expect(err).not.toBeNull();
    expect(err).not.toBeInstanceOf(OutboundAddressNotAllowedError);
  });
});

describe("isOutboundAddressNotAllowed (issue #1034)", () => {
  it("finds the refusal anywhere in the cause chain and nothing else", () => {
    const refusal = new OutboundAddressNotAllowedError("internal.test");
    expect(isOutboundAddressNotAllowed(refusal)).toBe(true);
    expect(
      isOutboundAddressNotAllowed(new TypeError("fetch failed", { cause: new Error("x", { cause: refusal }) })),
    ).toBe(true);
    expect(isOutboundAddressNotAllowed(new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") }))).toBe(
      false,
    );
    expect(isOutboundAddressNotAllowed("not an error")).toBe(false);
  });
});

describe("allowLoopbackOutboundForTests (issue #1034)", () => {
  it("switches the default policy and restores it", () => {
    expect(currentOutboundAddressPolicy().isTestPolicy).toBe(false);
    const restore = allowLoopbackOutboundForTests();
    try {
      expect(currentOutboundAddressPolicy().isTestPolicy).toBe(true);
    } finally {
      restore();
    }
    expect(currentOutboundAddressPolicy().isTestPolicy).toBe(false);
  });

  it("throws outside NODE_ENV=test", () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(() => allowLoopbackOutboundForTests()).toThrow(/only be called in tests/);
    } finally {
      process.env.NODE_ENV = original;
    }
    expect(currentOutboundAddressPolicy().isTestPolicy).toBe(false);
  });
});

describe("createOutboundHttp (issue #1034)", () => {
  it.each([
    ["an http: URL", "http://example.com/"],
    ["an IPv4 literal", "https://10.0.0.1/"],
    ["a public IPv4 literal", "https://93.184.216.34/"],
    ["an IPv6 literal", "https://[::1]/"],
  ])("refuses %s under the default policy before connecting", async (_label, url) => {
    const outbound = createOutboundHttp();
    try {
      await expect(outbound.fetch(url)).rejects.toBeInstanceOf(OutboundAddressNotAllowedError);
    } finally {
      await outbound.close();
    }
  });

  it("refuses a request body other than a string or URLSearchParams", async () => {
    const restore = allowLoopbackOutboundForTests();
    const outbound = createOutboundHttp();
    try {
      await expect(outbound.fetch("http://127.0.0.1:9/", { method: "POST", body: new Blob(["x"]) })).rejects.toThrow(
        /string or URLSearchParams/,
      );
    } finally {
      await outbound.close();
      restore();
    }
  });

  it("fails an https.Agent request to a denied IP-literal host with OutboundAddressNotAllowedError", async () => {
    const outbound = createOutboundHttp();
    try {
      const error = await new Promise<Error>((resolve, reject) => {
        const request = https.request("https://10.0.0.1/push", { agent: outbound.httpsAgent, method: "POST" });
        request.on("error", resolve);
        request.on("response", () => reject(new Error("unexpected response")));
        request.end();
      });
      expect(error).toBeInstanceOf(OutboundAddressNotAllowedError);
    } finally {
      await outbound.close();
    }
  });
});
