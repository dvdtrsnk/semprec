/// <reference types="vitest/config" />
/// <reference types="node" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Every route the API answers is now gated by the session cookie/bearer token issued at login
// (issue #143), except the documented exceptions (login, password reset, /api/setup) — the
// proxy just forwards requests as-is, cookies included, with no dev-only secret to attach.
// The two proxied prefixes are the backend-owned URL space: `/api/*` (every REST route plus the
// `/api/sync` WebSocket upgrade, hence `ws: true`) and `/mcp` (the MCP JSON-RPC endpoint);
// `/healthz` is not needed in development. `deploy/Caddyfile` carries the same list for production
// (added there by the sibling production-routing issue).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: process.env.SEMPREC_API_URL ?? "http://localhost:3001", ws: true },
      "/mcp": { target: process.env.SEMPREC_API_URL ?? "http://localhost:3001" },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
