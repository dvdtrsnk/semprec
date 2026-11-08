import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServerInfoRequestListener } from "../serverInfoHandler.js";

describe("public server identity (issue #1355)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    // No pool or session is supplied to this listener.
    server = createServer(createServerInfoRequestListener());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  it("returns exactly the product name without a session or database connection", async () => {
    const response = await fetch(`${baseUrl}/api/server-info`, { signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"product":"semprec"}');
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])("returns 404 for %s", async (method) => {
    const response = await fetch(`${baseUrl}/api/server-info`, { method, signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(404);
  });

  it("returns 404 for another path", async () => {
    const response = await fetch(`${baseUrl}/other`, { signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('{"status":"error"}');
  });
});
