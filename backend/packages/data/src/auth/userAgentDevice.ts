export interface UserAgentDevice {
  /** The browser family, or `Other` when none matches. */
  deviceName: string;
  /** The operating-system family, or `null` when none matches. */
  osVersion: string | null;
}

// Order matters: Edge and Chrome UAs also contain "Safari"; iOS and Android UAs also contain
// "Mac OS X" and "Linux".
const BROWSERS: readonly (readonly [string, RegExp])[] = [
  ["Edge", /\b(Edg|Edge|EdgA|EdgiOS)\//],
  ["Chrome", /\b(Chrome|CriOS|Chromium)\//],
  ["Firefox", /\b(Firefox|FxiOS)\//],
  ["Safari", /\bSafari\//],
];

const OPERATING_SYSTEMS: readonly (readonly [string, RegExp])[] = [
  ["iOS", /\b(iPhone|iPad|iPod)\b/],
  ["Android", /\bAndroid\b/],
  ["macOS", /\b(Macintosh|Mac OS X)\b/],
  ["Windows", /\bWindows\b/],
  ["Linux", /\bLinux\b/],
];

/** Derives the web device name (browser family) and OS family from a `User-Agent` header value. */
export function deviceFromUserAgent(userAgent: string | null | undefined): UserAgentDevice {
  const ua = userAgent ?? "";
  return {
    deviceName: BROWSERS.find(([, re]) => re.test(ua))?.[0] ?? "Other",
    osVersion: OPERATING_SYSTEMS.find(([, re]) => re.test(ua))?.[0] ?? null,
  };
}
