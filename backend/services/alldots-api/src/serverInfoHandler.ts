import type { IncomingMessage, ServerResponse } from "node:http";
import { sendJson } from "./adapter/http.js";

/** Exposes only the product name before a session exists. */
export function createServerInfoRequestListener() {
  return function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method !== "GET" || url.pathname !== "/api/server-info") {
      sendJson(res, 404, { status: "error" });
      return;
    }
    sendJson(res, 200, { product: "alldots" });
  };
}
