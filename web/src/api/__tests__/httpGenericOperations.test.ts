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
        return jsonResponse({ items: [{ id: "e1", databaseId: "db", properties: { name: "Hi" }, updatedAt: "2026-01-01T00:00:00.000Z" }], nextCursor: null });
      },
    });

    const page = await operations.listItems("db", { filter: { type: "relation_contains", property: "folder", value: "f1" } });

    expect(calls[0]?.url).toBe("/api/databases/db/items/query");
    expect(calls[0]?.body).toEqual({ filter: { type: "relation_contains", property: "folder", value: "f1" } });
    expect(page.items[0]?.properties.name).toBe("Hi");
    expect(page.items[0]?.computed).toEqual({});
  });

  it("classifies a forbidden or missing resource as unavailable and a server error as retryable", async () => {
    const withStatus = (status: number) =>
      createHttpGenericOperations({ baseUrl: "/api", fetchImpl: async () => jsonResponse({}, status) }).countItems("db");

    await expect(withStatus(403)).rejects.toMatchObject({ kind: "unavailable" });
    await expect(withStatus(500)).rejects.toMatchObject({ kind: "retryable" });
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

  it("posts a named module operation to the operations endpoint, input and all", async () => {
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

  it("patches an item's properties and validates the item it gets back", async () => {
    const calls: Array<{ url: string; method?: string; body: unknown }> = [];
    const operations = createHttpGenericOperations({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), method: init?.method, body: JSON.parse(String(init?.body)) });
        return jsonResponse({ id: "e1", databaseId: "db", properties: { read: true }, updatedAt: "2026-01-01T00:00:00.000Z" });
      },
    });

    const item = await operations.updateItem("db", "e1", { read: true });

    expect(calls[0]).toMatchObject({ url: "/api/databases/db/items/e1", method: "PATCH", body: { properties: { read: true } } });
    expect(item.properties.read).toBe(true);
  });

  it("links and unlinks a relation edge by property key, accepting an empty response body", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const operations = createHttpGenericOperations({
      baseUrl: "/api",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return new Response(null, { status: 204 });
      },
    });

    await operations.linkItem("db", "e1", "folder", "f2");
    await operations.unlinkItem("db", "e1", "folder", "f1");

    expect(calls).toEqual([
      { url: "/api/databases/db/items/e1/relations/folder", method: "POST" },
      { url: "/api/databases/db/items/e1/relations/folder/f1", method: "DELETE" },
    ]);
  });

  it("reads a missing item as null rather than as a failed pane", async () => {
    const operations = createHttpGenericOperations({ baseUrl: "/api", fetchImpl: async () => jsonResponse({}, 404) });
    await expect(operations.getItem("db", "gone")).resolves.toBeNull();
  });
});
