/// <reference types="vitest/config" />
/// <reference types="node" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Every route the API answers is now gated by the session cookie/bearer token issued at login
// (issue #143), except the documented exceptions (login, password reset, /api/setup) — the
// proxy just forwards requests as-is, cookies included, with no dev-only secret to attach.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api/ai-usage": { target: process.env.SEMPREC_API_URL ?? "http://localhost:3001" },
      "/api/approval-requests": { target: process.env.SEMPREC_API_URL ?? "http://localhost:3001" },
      "/api/agent-runs": { target: process.env.SEMPREC_API_URL ?? "http://localhost:3001" },
      "/api/setup": { target: process.env.SEMPREC_API_URL ?? "http://localhost:3001" },
    },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
  },
});
