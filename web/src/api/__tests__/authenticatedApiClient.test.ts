import { describe, expect, it } from "vitest";
import { createAuthenticatedApiClient } from "../authenticatedApiClient.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("authenticated API client", () => {
  it("uses the authenticated routes, session cookie, and typed request bodies", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const api = createAuthenticatedApiClient({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), init });
        if (String(input).endsWith("/properties")) return jsonResponse([]);
        if (String(input).endsWith("/query")) return jsonResponse({ items: [], nextCursor: null });
        if (init?.method === "POST") {
          return jsonResponse({ id: "item-1", databaseId: "db-1", properties: {}, updatedAt: "2026-01-01" });
        }
        return jsonResponse({ id: "view-1", databaseId: "db-1", type: "library-grid", name: "Library", config: {} });
      },
    });

    await api.getView("view-1");
    await api.listProperties("db-1");
    await api.queryView("view-1", { cursor: null, limit: 20 });
    await api.createItem("db-1", { title: "Dune" });

    expect(calls.map(({ url }) => url)).toEqual([
      "/api/views/view-1",
      "/api/databases/db-1/properties",
      "/api/views/view-1/query",
      "/api/databases/db-1/items",
    ]);
    expect(calls.every(({ init }) => init?.credentials === "include")).toBe(true);
    expect(JSON.parse(String(calls[2]?.init?.body))).toEqual({ cursor: null, limit: 20 });
    expect(JSON.parse(String(calls[3]?.init?.body))).toEqual({ properties: { title: "Dune" } });
  });

  it("returns the stable API error code for a failed view query", async () => {
    const api = createAuthenticatedApiClient({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse({ error: { code: "not_found" } }, 404),
    });

    await expect(api.queryView("missing", { cursor: null, limit: 20 })).resolves.toEqual({ code: "not_found" });
  });
});
