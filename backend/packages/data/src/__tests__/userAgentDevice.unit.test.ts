import { describe, expect, it } from "vitest";
import { deviceFromUserAgent } from "../auth/userAgentDevice.js";

describe("deviceFromUserAgent", () => {
  it.each([
    [
      "Safari on macOS",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
      "Safari",
      "macOS",
    ],
    [
      "Chrome on Windows",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Chrome",
      "Windows",
    ],
    [
      "Edge on Windows",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
      "Edge",
      "Windows",
    ],
    ["Firefox on Linux", "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0", "Firefox", "Linux"],
    [
      "Safari on iPhone (iOS before macOS)",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
      "Safari",
      "iOS",
    ],
    [
      "Chrome on Android (Android before Linux)",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36",
      "Chrome",
      "Android",
    ],
  ])("%s", (_label, userAgent, deviceName, osVersion) => {
    expect(deviceFromUserAgent(userAgent)).toEqual({ deviceName, osVersion });
  });

  it("falls back to Other and null for an unknown or missing User-Agent", () => {
    expect(deviceFromUserAgent("curl/8.0")).toEqual({ deviceName: "Other", osVersion: null });
    expect(deviceFromUserAgent(null)).toEqual({ deviceName: "Other", osVersion: null });
    expect(deviceFromUserAgent(undefined)).toEqual({ deviceName: "Other", osVersion: null });
  });
});
