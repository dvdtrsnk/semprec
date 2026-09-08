/// <reference types="vitest/config" />
/// <reference types="node" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/**
 * `SEMPREC_API_TOKEN` (no `VITE_` prefix) is read here, in this file's own Node process, and
 * never referenced from `src/` — a `VITE_`-prefixed name would have Vite bake its value into
 * the browser bundle, which is exactly what issue #121's `/api/ai-usage` review flagged as a
 * secret leak. Attaching it to the proxied request server-side is a dev-only stand-in for
 * whatever the production reverse proxy (or the auth-v1 epic's session) does instead.
 */
const semprecApiToken = process.env.SEMPREC_API_TOKEN;

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/ai-usage": {
        target: process.env.SEMPREC_API_URL ?? "http://localhost:3001",
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            if (semprecApiToken) proxyReq.setHeader("Authorization", `Bearer ${semprecApiToken}`);
          });
        },
      },
      "/api/approval-requests": {
        target: process.env.SEMPREC_API_URL ?? "http://localhost:3001",
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            if (semprecApiToken) proxyReq.setHeader("Authorization", `Bearer ${semprecApiToken}`);
          });
        },
      },
      "/api/agent-runs": {
        target: process.env.SEMPREC_API_URL ?? "http://localhost:3001",
        configure(proxy) {
          proxy.on("proxyReq", (proxyReq) => {
            if (semprecApiToken) proxyReq.setHeader("Authorization", `Bearer ${semprecApiToken}`);
          });
        },
      },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
