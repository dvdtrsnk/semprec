import { describe, expect, it } from "vitest";
import { OperationError } from "../genericOperations.js";
import { createHttpGenericOperations } from "../httpGenericOperations.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("http generic operations", () => {
  it("posts a filter tree to the generic query endpoint and validates the response", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const operations = createHttpGenericOperations({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return jsonResponse({
          items: [{ id: "e1", databaseId: "db", properties: { name: "Hi" }, updatedAt: "2026-01-01T00:00:00.000Z" }],
          nextCursor: null,
        });
      },
    });

    const page = await operations.listItems("db", {
      filter: { type: "relation_contains", property: "folder", value: "f1" },
    });

    expect(calls[0]?.url).toBe("/api/databases/db/query");
    expect(calls[0]?.body).toEqual({ filter: { type: "relation_contains", property: "folder", value: "f1" } });
    expect(page.items[0]?.properties.name).toBe("Hi");
    expect(page.items[0]?.computed).toEqual({});
  });

  const itemBody = (overrides: Record<string, unknown> = {}) => ({
    id: "e1",
    databaseId: "db",
    properties: { read: false },
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  it("counts by following nextCursor across pages and summing the items", async () => {
    const calls: unknown[] = [];
    const operations = createHttpGenericOperations({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        const body = JSON.parse(String(init?.body));
        calls.push({ url: String(input), body });
        const first = body.cursor === undefined;
        const count = first ? 200 : 3;
        return jsonResponse({
          items: Array.from({ length: count }, (_, n) => itemBody({ id: `e${n}` })),
          nextCursor: first ? "c1" : null,
        });
      },
    });

    const filter = { type: "relation_contains", property: "folder", value: "f1" } as const;
    await expect(operations.countItems("db", { filter })).resolves.toBe(203);
    expect(calls).toEqual([
      { url: "/api/databases/db/query", body: { filter, limit: 200 } },
      { url: "/api/databases/db/query", body: { filter, limit: 200, cursor: "c1" } },
    ]);
  });

  it("classifies a forbidden or missing resource as unavailable and a server error as retryable", async () => {
    const withStatus = (status: number) =>
      createHttpGenericOperations({ baseUrl: "/api", fetchImpl: async () => jsonResponse({}, status) }).countItems(
        "db",
      );

    await expect(withStatus(403)).rejects.toMatchObject({ kind: "unavailable" });
    await expect(withStatus(500)).rejects.toMatchObject({ kind: "retryable" });
  });

  it("rejects the whole count when a later page fails", async () => {
    let n = 0;
    const operations = createHttpGenericOperations({
      baseUrl: "/api",
      fetchImpl: async () => (n++ === 0 ? jsonResponse({ items: [], nextCursor: "c1" }) : jsonResponse({}, 500)),
    });
    await expect(operations.countItems("db")).rejects.toMatchObject({ kind: "retryable" });
  });

  it("classifies a transport failure as retryable", async () => {
    const operations = createHttpGenericOperations({
      baseUrl: "/api",
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    });

    await expect(operations.getView("v1")).rejects.toBeInstanceOf(OperationError);
    await expect(operations.getView("v1")).rejects.toMatchObject({ kind: "retryable" });
  });

  it("posts a named module operation to the operations endpoint (no backend route currently serves it)", async () => {
    const calls: Array<{ url: string; method?: string; body: unknown }> = [];
    const operations = createHttpGenericOperations({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
        return jsonResponse({ itemId: "e1", messageId: "<m1@example.com>" });
      },
    });

    const result = await operations.callOperation("email.send", { draftItemId: "e1" });

    expect(calls[0]).toMatchObject({ url: "/api/operations/email.send", method: "POST", body: { draftItemId: "e1" } });
    expect(result).toEqual({ itemId: "e1", messageId: "<m1@example.com>" });
  });

  it("reads the item, then patches it with the version it read", async () => {
    const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
    const operations = createHttpGenericOperations({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          method: init?.method,
          body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        });
        return init?.method === "PATCH"
          ? jsonResponse(itemBody({ properties: { read: true }, updatedAt: "2026-02-02T00:00:00.000Z" }))
          : jsonResponse(itemBody());
      },
    });

    const item = await operations.updateItem("db", "e1", { read: true });

    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("/api/items/e1");
    expect(calls[0]?.method ?? "GET").toBe("GET");
    expect(calls[1]).toMatchObject({
      url: "/api/items/e1",
      method: "PATCH",
      body: { properties: { read: true }, ifVersion: "2026-01-01T00:00:00.000Z" },
    });
    expect(item.properties.read).toBe(true);
  });

  it("rejects an update as unavailable, without a PATCH, when the item is missing or in another database", async () => {
    for (const read of [jsonResponse({}, 404), jsonResponse(itemBody({ databaseId: "other" }))]) {
      const methods: Array<string | undefined> = [];
      const operations = createHttpGenericOperations({
        baseUrl: "/api",
        fetchImpl: async (_input, init) => {
          methods.push(init?.method);
          return read.clone();
        },
      });
      await expect(operations.updateItem("db", "e1", { read: true })).rejects.toMatchObject({
        kind: "unavailable",
        status: 404,
      });
      expect(methods).not.toContain("PATCH");
    }
  });

  it("surfaces a version conflict on the patch as retryable", async () => {
    const operations = createHttpGenericOperations({
      baseUrl: "/api",
      fetchImpl: async (_input, init) =>
        init?.method === "PATCH"
          ? jsonResponse({ error: { code: "version_conflict" } }, 409)
          : jsonResponse(itemBody()),
    });
    await expect(operations.updateItem("db", "e1", { read: true })).rejects.toMatchObject({ kind: "retryable" });
  });

  it("links with a body-less PUT, accepting a JSON answer or a 204", async () => {
    for (const answer of [() => jsonResponse({ ok: true }), () => new Response(null, { status: 204 })]) {
      const calls: Array<{ url: string; method?: string; body?: unknown }> = [];
      const operations = createHttpGenericOperations({
        baseUrl: "/api",
        fetchImpl: async (input, init) => {
          calls.push({ url: String(input), method: init?.method, body: init?.body });
          return answer();
        },
      });
      await operations.linkItem("db", "e1", "folder", "f2");
      expect(calls).toEqual([{ url: "/api/items/e1/relations/folder/f2", method: "PUT", body: undefined }]);
    }
  });

  describe("unlinkItem", () => {
    const unlinkWith = (response: () => Response, calls: Array<{ url: string; method?: string }> = []) =>
      createHttpGenericOperations({
        baseUrl: "/api",
        fetchImpl: async (input, init) => {
          calls.push({ url: String(input), method: init?.method });
          return response();
        },
      }).unlinkItem("db", "e1", "folder", "f1");
    const notFound = (resource: string) => jsonResponse({ error: { code: "not_found", details: { resource } } }, 404);

    it("deletes the edge and resolves on 200", async () => {
      const calls: Array<{ url: string; method?: string }> = [];
      await expect(unlinkWith(() => jsonResponse({ ok: true }), calls)).resolves.toBeUndefined();
      expect(calls).toEqual([{ url: "/api/items/e1/relations/folder/f1", method: "DELETE" }]);
    });

    it("treats an absent edge as a no-op", async () => {
      await expect(unlinkWith(() => notFound("relationEdge"))).resolves.toBeUndefined();
    });

    it("rejects as unavailable on any other 404", async () => {
      await expect(unlinkWith(() => notFound("relationProperty"))).rejects.toMatchObject({
        kind: "unavailable",
        status: 404,
      });
      await expect(unlinkWith(() => notFound("item"))).rejects.toMatchObject({ kind: "unavailable" });
      await expect(unlinkWith(() => new Response("<html>", { status: 404 }))).rejects.toMatchObject({
        kind: "unavailable",
        status: 404,
      });
      await expect(unlinkWith(() => new Response(null, { status: 404 }))).rejects.toMatchObject({
        kind: "unavailable",
      });
    });

    it("keeps the ordinary classification for other statuses", async () => {
      await expect(unlinkWith(() => jsonResponse({}, 500))).rejects.toMatchObject({ kind: "retryable" });
    });
  });

  it("reads an item by id alone and returns it", async () => {
    const urls: string[] = [];
    const operations = createHttpGenericOperations({
      baseUrl: "/api",
      fetchImpl: async (input) => {
        urls.push(String(input));
        return jsonResponse(itemBody());
      },
    });
    await expect(operations.getItem("db", "e1")).resolves.toMatchObject({ id: "e1", databaseId: "db" });
    expect(urls).toEqual(["/api/items/e1"]);
  });

  it("reads a missing item, or one from another database, as null rather than as a failed pane", async () => {
    const missing = createHttpGenericOperations({ baseUrl: "/api", fetchImpl: async () => jsonResponse({}, 404) });
    await expect(missing.getItem("db", "gone")).resolves.toBeNull();
    const foreign = createHttpGenericOperations({
      baseUrl: "/api",
      fetchImpl: async () => jsonResponse(itemBody({ databaseId: "other" })),
    });
    await expect(foreign.getItem("db", "e1")).resolves.toBeNull();
  });

  it("percent-encodes every path segment", async () => {
    const urls: string[] = [];
    const operations = createHttpGenericOperations({
      baseUrl: "/api",
      fetchImpl: async (input) => {
        urls.push(String(input));
        return new Response(null, { status: 204 });
      },
    });
    await operations.linkItem("db", "a/b", "k?x", "t/1");
    await operations.unlinkItem("db", "a/b", "k?x", "t?1");
    expect(urls).toEqual(["/api/items/a%2Fb/relations/k%3Fx/t%2F1", "/api/items/a%2Fb/relations/k%3Fx/t%3F1"]);
  });
});
