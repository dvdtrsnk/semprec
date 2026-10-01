import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `serve.ts` throws its `PORT` check (issue #738) before anything that needs a real
 * database or network listener, so loading it with an out-of-range `PORT` and otherwise
 * valid startup env vars exercises the check without standing up a pool or a server.
 */
describe("serve.ts startup PORT check", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("rejects a PORT above 65535 with the service's own message", async () => {
    process.env.SEMPREC_API_DATABASE_URL = "postgres://localhost/unused";
    process.env.SETUP_TOKEN = "test-setup-token";
    process.env.PORT = "65536";

    await expect(import("../serve.js")).rejects.toThrow("PORT is not a valid port number: 65536");
  });
});
