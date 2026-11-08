import { IncomingMessage } from "node:http";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
import { isAllowedOrigin } from "../originCheck.js";

function requestWith(headers: Record<string, string>): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  req.headers = headers;
  return req;
}

describe("isAllowedOrigin (issue #1044)", () => {
  it("allows a request with no Origin header", () => {
    expect(isAllowedOrigin(requestWith({ host: "app.example" }))).toBe(true);
  });

  it("allows an https Origin whose host equals Host", () => {
    expect(isAllowedOrigin(requestWith({ host: "app.example", origin: "https://app.example" }))).toBe(true);
  });

  it("allows an http localhost Origin whose host and port equal Host", () => {
    expect(isAllowedOrigin(requestWith({ host: "localhost:5173", origin: "http://localhost:5173" }))).toBe(true);
  });

  it("compares the host case-insensitively", () => {
    expect(isAllowedOrigin(requestWith({ host: "App.Example", origin: "https://app.example" }))).toBe(true);
  });

  it("refuses a different host", () => {
    expect(isAllowedOrigin(requestWith({ host: "app.example", origin: "https://evil.example" }))).toBe(false);
  });

  it("refuses a sibling subdomain, which shares the site but not the origin", () => {
    expect(isAllowedOrigin(requestWith({ host: "app.example", origin: "https://other.app.example" }))).toBe(false);
  });

  it("refuses a different port on the same host", () => {
    expect(isAllowedOrigin(requestWith({ host: "localhost:5173", origin: "http://localhost:3000" }))).toBe(false);
  });

  it("refuses the opaque Origin: null", () => {
    expect(isAllowedOrigin(requestWith({ host: "app.example", origin: "null" }))).toBe(false);
  });

  it("refuses an unparseable Origin", () => {
    expect(isAllowedOrigin(requestWith({ host: "app.example", origin: "not a url" }))).toBe(false);
  });

  it("refuses an empty Origin", () => {
    expect(isAllowedOrigin(requestWith({ host: "app.example", origin: "" }))).toBe(false);
  });

  it("refuses a non-http scheme even when the host matches", () => {
    expect(isAllowedOrigin(requestWith({ host: "app.example", origin: "file://app.example" }))).toBe(false);
  });

  it("refuses an Origin present with no Host", () => {
    expect(isAllowedOrigin(requestWith({ origin: "https://app.example" }))).toBe(false);
  });

  it("ignores X-Forwarded-Host, so a forwarded value cannot make a foreign Origin match", () => {
    expect(
      isAllowedOrigin(
        requestWith({ host: "app.example", origin: "https://evil.example", "x-forwarded-host": "evil.example" }),
      ),
    ).toBe(false);
  });
});
