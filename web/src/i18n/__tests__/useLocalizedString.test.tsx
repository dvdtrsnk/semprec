import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { AuthenticatedWebProvider } from "../../authenticatedWebContext.js";
import { createAuthenticatedApiClient } from "../../api/authenticatedApiClient.js";
import { resolveLocalizedString, useLocalizedString } from "../useLocalizedString.js";

describe("localized strings", () => {
  it("falls back from the requested locale to English and then the raw key", () => {
    expect(resolveLocalizedString("cs", "common.loading")).toBe("Načítání");
    expect(resolveLocalizedString("de", "common.loading")).toBe("Loading");
    expect(resolveLocalizedString("de", "missing.key")).toBe("missing.key");
  });

  it("uses the authenticated user's locale", () => {
    const api = createAuthenticatedApiClient({ baseUrl: "/api", fetchImpl: async () => new Response(null) });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <AuthenticatedWebProvider value={{ user: { locale: "cs" }, api }}>{children}</AuthenticatedWebProvider>
    );

    const { result } = renderHook(() => useLocalizedString(), { wrapper });
    expect(result.current("common.loading")).toBe("Načítání");
  });
});
