import { describe, expect, it } from "vitest";
import { isBaselineOutboundUrl } from "../net/storedOutboundUrl.js";

describe("isBaselineOutboundUrl", () => {
  it.each([
    "https://mcp.example.com/mcp",
    "https://fcm.googleapis.com/fcm/send/abc?x=1",
    "https://mcp.example.com:443/mcp",
    "https://localhost.example.com/",
  ])("accepts %s", (url) => {
    expect(isBaselineOutboundUrl(url)).toBe(true);
  });

  it.each([
    "http://mcp.example.com/mcp",
    "https://user:pw@mcp.example.com/",
    "https://user@mcp.example.com/",
    "https://mcp.example.com:8443/",
    "https://localhost/",
    "https://localhost./",
    "https://app.localhost/",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://127.1/",
    "https://169.254.169.254/",
    "https://10.0.0.1/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "ftp://mcp.example.com/",
    "not a url",
    "",
  ])("rejects %s", (url) => {
    expect(isBaselineOutboundUrl(url)).toBe(false);
  });
});
