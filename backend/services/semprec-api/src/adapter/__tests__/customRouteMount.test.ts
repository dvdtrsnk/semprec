import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, inTenantZero, resetDatabase, tenantForNextTestUser } from "@semprec/data/testSupport";
import {
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  noopPasswordResetMailer,
  seedSystem,
} from "@semprec/data";
import type { ModuleCustomRouteDefinition } from "@semprec/module-registry";
import { createDispatcher } from "../../app.js";
import { createClientIpThrottle } from "../../clientIpThrottle.js";
import {
  CustomRouteConfigurationError,
  createCustomRouteDependencies,
  mountCustomRoutes,
  requireCustomRouteDependency,
  type CustomRouteDependencies,
  type CustomRouteHandlerFactory,
} from "../customRouteMount.js";

let pool: Pool;

const PASSWORD = "s3cret-password";

async function tokenFor(email: string): Promise<string> {
  await createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email,
    passwordHash: await hashPassword(PASSWORD),
  });
  const result = await login(pool, { email, password: PASSWORD, platform: "ios", ip: "1.2.3.4" });
  return result.token;
}

/** Mounts `definitions` with `dependencies` on a real in-memory server; a path matching none of them answers 404. */
async function listen(
  definitions: ModuleCustomRouteDefinition[],
  dependencies: CustomRouteDependencies,
): Promise<Server> {
  const dispatchCustomRoute = mountCustomRoutes(pool, definitions, dependencies);
  const server = createServer((req, res) => {
    if (dispatchCustomRoute(req, res)) return;
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  return server;
}

function baseUrlOf(server: Server): string {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
  return `http://127.0.0.1:${address.port}`;
}

/** A fixture handler factory echoing the extracted `:id` path parameter back as the response body. */
const echoIdHandlerFactory: CustomRouteHandlerFactory = () => async (ctx) => ({
  status: 200,
  body: { id: ctx.params.id },
});

const noParamHandlerFactory: CustomRouteHandlerFactory = () => async () => ({
  status: 200,
  body: { ok: true },
});

const DEFINITIONS: ModuleCustomRouteDefinition[] = [
  {
    moduleId: "fixture-module",
    name: "fixtureGetThing",
    method: "GET",
    path: "/api/fixture-things/:id",
    handler: echoIdHandlerFactory,
  },
  {
    moduleId: "fixture-module",
    name: "fixturePostThing",
    method: "POST",
    path: "/api/fixture-things",
    handler: noParamHandlerFactory,
  },
];

/** Reads the `oauth` member when it runs, never when the factory is mounted. */
const redirectBaseFactory: CustomRouteHandlerFactory = (_pool, dependencies) => async () => {
  const oauth = requireCustomRouteDependency(dependencies, "oauth");
  return { status: 200, body: { redirectBaseUrl: oauth.redirectBaseUrl } };
};

/** Reads the `mailLiveSync` member when it runs, never when the factory is mounted. */
const startMailboxFactory: CustomRouteHandlerFactory = (_pool, dependencies) => async () => {
  const liveSync = requireCustomRouteDependency(dependencies, "mailLiveSync");
  await liveSync.startMailbox("tenant-fixture", "mailbox-fixture");
  return { status: 200, body: { started: true } };
};

const REDIRECT_DEFINITION: ModuleCustomRouteDefinition = {
  moduleId: "fixture-module",
  name: "fixtureRedirectBase",
  method: "GET",
  path: "/api/fixture-redirect",
  handler: redirectBaseFactory,
};

const DEPENDENT_DEFINITIONS: ModuleCustomRouteDefinition[] = [
  REDIRECT_DEFINITION,
  {
    moduleId: "fixture-module",
    name: "fixtureStartMailbox",
    method: "POST",
    path: "/api/fixture-mailbox/start",
    handler: startMailboxFactory,
  },
];

describe("custom route mount (issue #239)", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);

    server = await listen(DEFINITIONS, createCustomRouteDependencies());
    baseUrl = baseUrlOf(server);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("extracts a `:id` path parameter and authenticates through the shared adapter", async () => {
    const token = await tokenFor("mount-id@example.com");
    const res = await fetch(`${baseUrl}/api/fixture-things/abc-123`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "abc-123" });
  });

  it("matches a route with no path parameters", async () => {
    const token = await tokenFor("mount-noparam@example.com");
    const res = await fetch(`${baseUrl}/api/fixture-things`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("requires authentication before a mounted custom route's handler runs", async () => {
    const res = await fetch(`${baseUrl}/api/fixture-things/abc-123`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("falls through to the caller's own dispatch for a path matching no custom route", async () => {
    const res = await fetch(`${baseUrl}/api/not-a-custom-route`);
    expect(res.status).toBe(404);
  });

  it("does not match a route on method alone", async () => {
    const token = await tokenFor("mount-method@example.com");
    const res = await fetch(`${baseUrl}/api/fixture-things`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("composition-root dependencies of custom routes (issue gh-1460)", () => {
  const openServers: Server[] = [];

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterEach(async () => {
    for (const server of openServers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("hands each factory the pool and the container given to the mount", () => {
    const seen: { pool?: Pool; dependencies?: CustomRouteDependencies } = {};
    const container = createCustomRouteDependencies();
    const capturing: CustomRouteHandlerFactory = (factoryPool, dependencies) => {
      seen.pool = factoryPool;
      seen.dependencies = dependencies;
      return async () => ({ status: 200, body: {} });
    };

    mountCustomRoutes(pool, [{ ...REDIRECT_DEFINITION, handler: capturing }], container);

    expect(seen.pool).toBe(pool);
    expect(seen.dependencies).toBe(container);
  });

  it("mounts a route whose member is absent without failing at startup", () => {
    expect(() => mountCustomRoutes(pool, DEPENDENT_DEFINITIONS, createCustomRouteDependencies())).not.toThrow();
  });

  it("a route that needs a member reads the substitute container it was mounted with", async () => {
    const token = await tokenFor("deps-substitute@example.com");
    const server = await listen(DEPENDENT_DEFINITIONS, {
      oauth: { redirectBaseUrl: "https://app.example.test" },
    });
    openServers.push(server);

    const res = await fetch(`${baseUrlOf(server)}/api/fixture-redirect`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ redirectBaseUrl: "https://app.example.test" });
  });

  it("a route whose member the root did not configure answers 500, and other routes still work", async () => {
    const token = await tokenFor("deps-missing@example.com");
    const server = await listen([...DEFINITIONS, ...DEPENDENT_DEFINITIONS], {
      oauth: { redirectBaseUrl: "https://app.example.test" },
    });
    openServers.push(server);
    const baseUrl = baseUrlOf(server);

    const missing = await fetch(`${baseUrl}/api/fixture-mailbox/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(missing.status).toBe(500);
    expect(await missing.json()).toEqual({ error: { code: "internal_error" } });

    const configured = await fetch(`${baseUrl}/api/fixture-redirect`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(configured.status).toBe(200);
    expect(await configured.json()).toEqual({ redirectBaseUrl: "https://app.example.test" });

    const untouched = await fetch(`${baseUrl}/api/fixture-things/abc-123`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(untouched.status).toBe(200);
    expect(await untouched.json()).toEqual({ id: "abc-123" });
  });

  it("requireCustomRouteDependency returns the member the container holds", () => {
    const fakeFetch: typeof fetch = async () => new Response("ok");

    expect(requireCustomRouteDependency({ outboundHttp: fakeFetch }, "outboundHttp")).toBe(fakeFetch);
  });

  it("requireCustomRouteDependency throws a configuration error that names a member the root did not configure", () => {
    expect(() => requireCustomRouteDependency({}, "mailLiveSync")).toThrow(CustomRouteConfigurationError);
    expect(() => requireCustomRouteDependency({}, "mailLiveSync")).toThrow(/"mailLiveSync"/);
  });

  it("createDispatcher copies the caller container and supplies its own registry provider", async () => {
    const moduleRegistry = await loadFullModuleRegistry();
    const registryRules = vi.spyOn(moduleRegistry, "getHeartbeatRuleKindDefinitions");
    const seen: { pool?: Pool; dependencies?: CustomRouteDependencies } = {};
    const capturing: CustomRouteHandlerFactory = (factoryPool, dependencies) => {
      seen.pool = factoryPool;
      seen.dependencies = dependencies;
      return async () => ({ status: 200, body: {} });
    };
    vi.spyOn(moduleRegistry, "getCustomRouteDefinitions").mockResolvedValue([
      { ...REDIRECT_DEFINITION, handler: capturing },
    ]);
    const callerProvider = vi.fn(async () => new Map());
    const container: CustomRouteDependencies = {
      oauth: { redirectBaseUrl: "https://app.example.test" },
      heartbeatRuleKinds: callerProvider,
    };

    await createDispatcher(pool, {
      passwordResetMailer: noopPasswordResetMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: "deps-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-blobs-${randomUUID()}`)),
      maxFileSizeBytes: 1024,
      customRouteDependencies: container,
    });

    expect(seen.pool).toBe(pool);
    expect(seen.dependencies).not.toBe(container);
    expect(seen.dependencies?.oauth).toBe(container.oauth);
    expect(seen.dependencies?.heartbeatRuleKinds).toEqual(expect.any(Function));
    // The container carried no limiter, so the dispatcher added its own to the copy (issue gh-1750).
    expect(seen.dependencies?.throttle?.tryAcquire("mailboxCredentialVerification", "user-fixture").granted).toBe(true);
    expect(container.oauth).toEqual({ redirectBaseUrl: "https://app.example.test" });
    expect(Object.keys(container).sort()).toEqual(["heartbeatRuleKinds", "oauth"]);
    expect(container.heartbeatRuleKinds).toBe(callerProvider);
    expect(registryRules).not.toHaveBeenCalled();
    await seen.dependencies?.heartbeatRuleKinds?.();
    expect(registryRules).toHaveBeenCalledOnce();
    expect(callerProvider).not.toHaveBeenCalled();
  });

  it("uses the injected mailbox control through the dispatcher and factory on a request", async () => {
    const moduleRegistry = await loadFullModuleRegistry();
    vi.spyOn(moduleRegistry, "getCustomRouteDefinitions").mockResolvedValue(DEPENDENT_DEFINITIONS);
    const startMailbox = vi.fn(async () => {});
    const stopMailbox = vi.fn(async () => {});
    const restartAccount = vi.fn(async () => {});
    const dispatcher = await createDispatcher(pool, {
      passwordResetMailer: noopPasswordResetMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: "deps-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-blobs-${randomUUID()}`)),
      maxFileSizeBytes: 1024,
      customRouteDependencies: { mailLiveSync: { startMailbox, stopMailbox, restartAccount } },
    });
    const server = createServer(dispatcher);
    openServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const token = await tokenFor("dispatcher-control@example.com");
    const response = await fetch(`${baseUrlOf(server)}/api/fixture-mailbox/start`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ started: true });
    expect(startMailbox).toHaveBeenCalledExactlyOnceWith("tenant-fixture", "mailbox-fixture");
    expect(stopMailbox).not.toHaveBeenCalled();
    expect(restartAccount).not.toHaveBeenCalled();
  });

  it("the password connect route answers 500 on a dispatcher built without its verification (issue gh-1736)", async () => {
    await inTenantZero(() => seedSystem(pool));
    const token = await tokenFor("password-connect@example.com");
    const moduleRegistry = await loadFullModuleRegistry();
    /** Serves the real custom routes of every module with `customRouteDependencies`, or with no container. */
    const serve = async (customRouteDependencies?: CustomRouteDependencies): Promise<string> => {
      const dispatcher = await createDispatcher(pool, {
        passwordResetMailer: noopPasswordResetMailer,
        appBaseUrl: "https://app.example.test",
        setupToken: "deps-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-blobs-${randomUUID()}`)),
        maxFileSizeBytes: 1024,
        customRouteDependencies,
      });
      const server = createServer(dispatcher);
      openServers.push(server);
      await new Promise<void>((resolve) => server.listen(0, resolve));
      return baseUrlOf(server);
    };
    const connect = (baseUrl: string): Promise<Response> =>
      fetch(`${baseUrl}/api/mail/mailboxes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "generic",
          address: "owner@example.test",
          password: "connect-password",
          imapHost: "imap.example.test",
          smtpHost: "smtp.example.test",
        }),
      });

    const unconfigured = await connect(await serve());

    expect(unconfigured.status).toBe(500);
    expect(await unconfigured.json()).toEqual({ error: { code: "internal_error" } });

    // The same request creates the mailbox once a root configures the member, so nothing else refused it above.
    const configured = await connect(
      await serve({
        mailServerClients: {
          verifyPassword: async () => ({
            imap: { host: "imap.example.test", port: 993, security: "tls" },
            smtp: { host: "smtp.example.test", port: 465, security: "tls" },
          }),
        },
      }),
    );

    expect(configured.status).toBe(201);
  });

  it("the password connect route answers 500 on a mount without a limiter, and verifies no login (issue gh-1750)", async () => {
    await inTenantZero(() => seedSystem(pool));
    const token = await tokenFor("password-connect-limiter@example.com");
    const definitions = await (await loadFullModuleRegistry()).getCustomRouteDefinitions();
    let verifications = 0;
    const mailServerClients: CustomRouteDependencies["mailServerClients"] = {
      verifyPassword: async () => {
        verifications += 1;
        return {
          imap: { host: "imap.example.test", port: 993, security: "tls" },
          smtp: { host: "smtp.example.test", port: 465, security: "tls" },
        };
      },
    };
    /** Mounts the real custom routes of every module with `dependencies` and nothing else, as no dispatcher does. */
    const connect = async (dependencies: CustomRouteDependencies): Promise<Response> => {
      const server = await listen(definitions, dependencies);
      openServers.push(server);
      return fetch(`${baseUrlOf(server)}/api/mail/mailboxes`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: "generic",
          address: "owner@example.test",
          password: "connect-password",
          imapHost: "imap.example.test",
          smtpHost: "smtp.example.test",
        }),
      });
    };

    const unconfigured = await connect({ mailServerClients });

    expect(unconfigured.status).toBe(500);
    expect(await unconfigured.json()).toEqual({ error: { code: "internal_error" } });
    expect(verifications).toBe(0);

    // The same request creates the mailbox once the mount has a limiter, so nothing else refused it above.
    const configured = await connect({ mailServerClients, throttle: createClientIpThrottle() });

    expect(configured.status).toBe(201);
    expect(verifications).toBe(1);
  });

  it("createDispatcher hands on the limiter of the caller's container instead of creating one (issue gh-1750)", async () => {
    const moduleRegistry = await loadFullModuleRegistry();
    const seen: { dependencies?: CustomRouteDependencies } = {};
    const capturing: CustomRouteHandlerFactory = (_factoryPool, dependencies) => {
      seen.dependencies = dependencies;
      return async () => ({ status: 200, body: {} });
    };
    vi.spyOn(moduleRegistry, "getCustomRouteDefinitions").mockResolvedValue([
      { ...REDIRECT_DEFINITION, handler: capturing },
    ]);
    const throttle = createClientIpThrottle();

    await createDispatcher(pool, {
      passwordResetMailer: noopPasswordResetMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: "deps-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-blobs-${randomUUID()}`)),
      maxFileSizeBytes: 1024,
      customRouteDependencies: { throttle },
    });

    expect(seen.dependencies?.throttle).toBe(throttle);
  });

  it("createDispatcher supplies only its registry provider and a limiter when the caller gives no container", async () => {
    const moduleRegistry = await loadFullModuleRegistry();
    const registryRules = vi.spyOn(moduleRegistry, "getHeartbeatRuleKindDefinitions");
    const seen: { dependencies?: CustomRouteDependencies } = {};
    const capturing: CustomRouteHandlerFactory = (_factoryPool, dependencies) => {
      seen.dependencies = dependencies;
      return async () => ({ status: 200, body: {} });
    };
    vi.spyOn(moduleRegistry, "getCustomRouteDefinitions").mockResolvedValue([
      { ...REDIRECT_DEFINITION, handler: capturing },
    ]);

    await createDispatcher(pool, {
      passwordResetMailer: noopPasswordResetMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: "deps-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-blobs-${randomUUID()}`)),
      maxFileSizeBytes: 1024,
    });

    expect(Object.keys(seen.dependencies ?? {}).sort()).toEqual(["heartbeatRuleKinds", "throttle"]);
    expect(seen.dependencies?.heartbeatRuleKinds).toEqual(expect.any(Function));
    expect(seen.dependencies?.throttle?.tryAcquire("mailboxCredentialVerification", "user-fixture").granted).toBe(true);
    expect(registryRules).not.toHaveBeenCalled();
    await seen.dependencies?.heartbeatRuleKinds?.();
    expect(registryRules).toHaveBeenCalledOnce();
  });
});
