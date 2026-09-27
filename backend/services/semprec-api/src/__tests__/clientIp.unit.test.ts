import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { clientIpFromRequest } from "../clientIp.js";

function fakeRequest(forwardedFor: string | undefined, remoteAddress: string | undefined): IncomingMessage {
  const headers = forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor };
  return { headers, socket: { remoteAddress } } as unknown as IncomingMessage;
}

describe("clientIpFromRequest", () => {
  it("ignores X-Forwarded-For when trustProxy is off", () => {
    const req = fakeRequest("198.51.100.4", "127.0.0.1");
    expect(clientIpFromRequest(req, { trustProxy: false })).toBe("127.0.0.1");
  });

  it("returns the last forwarded hop, never an earlier client-supplied entry", () => {
    const req = fakeRequest("203.0.113.9, 198.51.100.4", "127.0.0.1");
    expect(clientIpFromRequest(req, { trustProxy: true })).toBe("198.51.100.4");
  });

  it("falls back to the socket address when the header is absent", () => {
    const req = fakeRequest(undefined, "127.0.0.1");
    expect(clientIpFromRequest(req, { trustProxy: true })).toBe("127.0.0.1");
  });

  it("trims the forwarded hop", () => {
    const req = fakeRequest(" 198.51.100.4 ", "127.0.0.1");
    expect(clientIpFromRequest(req, { trustProxy: true })).toBe("198.51.100.4");
  });

  it("falls back to the socket address when the last forwarded hop is empty", () => {
    const req = fakeRequest("203.0.113.9, ", "127.0.0.1");
    expect(clientIpFromRequest(req, { trustProxy: true })).toBe("127.0.0.1");
  });

  it("returns 0.0.0.0 when the socket has no address", () => {
    const req = fakeRequest(undefined, undefined);
    expect(clientIpFromRequest(req, { trustProxy: true })).toBe("0.0.0.0");
  });
});
