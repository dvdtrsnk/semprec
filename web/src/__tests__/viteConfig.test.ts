import type { UserConfig } from "vite";

// Loading the real `vite` (and its bundled esbuild) under jsdom trips esbuild's environment
// invariant, so the config's two imports are replaced: `defineConfig` is an identity function
// in Vite itself, and the React plugin's shape is irrelevant to the proxy table under test.
vi.mock("vite", () => ({ defineConfig: (config: UserConfig) => config }));
vi.mock("@vitejs/plugin-react", () => ({ default: () => ({ name: "vite:react-stub" }) }));

describe("vite dev-server proxy", () => {
  let savedApiUrl: string | undefined;

  beforeEach(() => {
    savedApiUrl = process.env.SEMPREC_API_URL;
    delete process.env.SEMPREC_API_URL;
    // The config reads SEMPREC_API_URL at module evaluation, so each test re-imports it
    // after the variable is cleared.
    vi.resetModules();
  });

  afterEach(() => {
    if (savedApiUrl === undefined) {
      delete process.env.SEMPREC_API_URL;
    } else {
      process.env.SEMPREC_API_URL = savedApiUrl;
    }
  });

  async function loadProxy(): Promise<NonNullable<NonNullable<UserConfig["server"]>["proxy"]>> {
    const { default: config } = await import("../../vite.config.js");
    const proxy = config.server?.proxy;
    if (proxy === undefined) throw new Error("vite.config.ts defines no server.proxy");
    return proxy;
  }

  it("proxies exactly the backend-owned /api and /mcp prefixes", async () => {
    const proxy = await loadProxy();
    expect(Object.keys(proxy).sort()).toEqual(["/api", "/mcp"]);
  });

  it("forwards WebSocket upgrades under /api and targets localhost:3001 by default", async () => {
    const proxy = await loadProxy();
    expect(proxy["/api"]).toEqual({ target: "http://localhost:3001", ws: true });
    expect(proxy["/mcp"]).toEqual({ target: "http://localhost:3001" });
  });
});
