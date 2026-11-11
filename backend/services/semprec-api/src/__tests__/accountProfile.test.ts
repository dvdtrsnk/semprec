import { randomUUID } from "node:crypto";
import { createServer, IncomingMessage, type Server } from "node:http";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { CORE_TASK_NAMES, runOnce } from "@semprec/queue";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import { runInTenant } from "@semprec/shared";
import { createRuntimeRolePool, createTestTenant, getTestPool, resetDatabase } from "@semprec/data/testSupport";
import {
  buildItemSearchQuery,
  createActionRegistry,
  createApiCoreTaskList,
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  NotFoundError,
  seedSystem,
  withTransaction,
  writeNotification,
  type LoginResult,
  type PasswordResetMailer,
  type UserRole,
} from "@semprec/data";
import { createAccountRoutes } from "../accountHandler.js";
import { createDispatcher, type AppOptions } from "../app.js";

const PASSWORD = "s3cret-password";
const BACKFILL = CORE_TASK_NAMES.ITEM_SEARCH_BACKFILL;
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

// Strict, so a field the session's user object does not have (a password hash, say) fails the parse.
const userShape = z
  .object({
    id: z.string(),
    email: z.string(),
    displayName: z.string().nullable(),
    locale: z.string(),
    createdAt: z.string(),
    role: z.string(),
    personId: z.string().nullable(),
  })
  .strict();
const profileBody = z.object({ user: userShape }).strict();
const sessionBody = z.object({ user: userShape });
const databasesBody = z.object({
  databases: z.array(z.object({ id: z.string(), ownerModuleId: z.string().nullable(), name: z.string() })),
});
const itemBody = z.object({ id: z.string() });
const notificationsBody = z.object({ notifications: z.array(z.object({ id: z.string(), title: z.string() })) });

interface Account {
  tenantId: string;
  userId: string;
  email: string;
  signedIn: LoginResult;
  headers: { Authorization: string };
}

describe("PATCH /api/account/profile (issue #1704)", () => {
  let adminPool: Pool;
  let pool: Pool;
  let options: AppOptions;
  let server: Server;
  let baseUrl: string;

  async function signUp(role: UserRole = "member"): Promise<Account> {
    const tenantId = await createTestTenant(adminPool);
    const email = `${randomUUID()}@example.com`;
    const user = await createUser(adminPool, { email, passwordHash: await hashPassword(PASSWORD), tenantId, role });
    const signedIn = await login(adminPool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    return { tenantId, userId: user.id, email, signedIn, headers: { Authorization: `Bearer ${signedIn.token}` } };
  }

  /** Sends `body` as JSON, verbatim when it is already a string, and no body at all when it is `undefined`. */
  function patchProfile(headers: Record<string, string>, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}/api/account/profile`, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    });
  }

  async function sessionUser(account: Account): Promise<z.infer<typeof userShape>> {
    const res = await fetch(`${baseUrl}/api/auth/session`, { headers: account.headers });
    expect(res.status).toBe(200);
    return sessionBody.parse(await res.json()).user;
  }

  /** The whole stored row, read as the superuser: `users` is a global identity table. */
  async function storedUser(userId: string): Promise<Record<string, unknown>> {
    const { rows } = await adminPool.query<Record<string, unknown>>("SELECT * FROM users WHERE id = $1", [userId]);
    const row = rows[0];
    if (!row) throw new Error(`no user ${userId}`);
    return row;
  }

  async function storedLocale(userId: string): Promise<unknown> {
    return (await storedUser(userId)).locale;
  }

  /** The queued tenant-wide search rebuilds, as the envelopes the queue stores. */
  function queuedReindexes(): Promise<unknown[]> {
    return readJobPayloadsByIdentifier(adminPool, BACKFILL);
  }

  const reindexOf = (account: Account) =>
    expect.objectContaining({ tenantId: account.tenantId, payload: { onlyMissing: false } });

  /** Runs the queued search rebuilds with the production API task list's handler until none is left. */
  async function runReindexes(): Promise<void> {
    const backfill = createApiCoreTaskList(pool, createActionRegistry())[BACKFILL];
    if (!backfill) throw new Error("the production API task list has no item search backfill task");
    // A full chunk queues its continuation, which a later run picks up.
    let remaining = (await queuedReindexes()).length;
    while (remaining > 0) {
      await runOnce({ pgPool: adminPool }, { [BACKFILL]: backfill });
      const left = (await queuedReindexes()).length;
      if (left >= remaining) throw new Error(`the search rebuild stopped making progress with ${left} job(s) queued`);
      remaining = left;
    }
  }

  async function seed(account: Account): Promise<void> {
    await runInTenant(account.tenantId, () => seedSystem(pool));
  }

  async function databaseOf(account: Account, moduleId: string): Promise<{ id: string; name: string }> {
    const res = await fetch(`${baseUrl}/api/databases?limit=200`, { headers: account.headers });
    expect(res.status).toBe(200);
    const database = databasesBody.parse(await res.json()).databases.find((db) => db.ownerModuleId === moduleId);
    if (!database) throw new Error(`no '${moduleId}' database`);
    return database;
  }

  /** Creates a person through the item route and returns the item id. */
  async function createPerson(account: Account, properties: Record<string, unknown>): Promise<string> {
    const people = await databaseOf(account, "people");
    const res = await fetch(`${baseUrl}/api/databases/${people.id}/items`, {
      method: "POST",
      headers: { ...account.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ properties }),
    });
    expect(res.status).toBe(201);
    return itemBody.parse(await res.json()).id;
  }

  /** The ids of the tenant's indexed items a search for `text` matches, through the production query builder. */
  async function searchHits(account: Account, text: string): Promise<string[]> {
    const built = buildItemSearchQuery(text);
    const { rows } = await runInTenant(account.tenantId, () =>
      pool.query<{ item_id: string }>(
        // `built.sql` is the builder's own tsquery expression over bind positions; the text itself is bound.
        `SELECT item_id FROM item_search_index WHERE search_vector @@ ${built.sql} ORDER BY item_id`,
        built.params,
      ),
    );
    return rows.map((row) => row.item_id);
  }

  /** Writes a heartbeat failure notification for the account through the production writer and returns its id. */
  function notifyHeartbeatFailure(account: Account, name: string): Promise<string> {
    return runInTenant(account.tenantId, () =>
      withTransaction(pool, (client) =>
        writeNotification(client, {
          userId: account.userId,
          kind: "heartbeat_error",
          titleParams: { name },
          linkHref: null,
          sourceTable: "project_heartbeats",
          sourceId: randomUUID(),
          transitionInstance: "1",
        }),
      ),
    );
  }

  async function notificationTitle(account: Account, id: string): Promise<string> {
    const res = await fetch(`${baseUrl}/api/notifications/unread`, { headers: account.headers });
    expect(res.status).toBe(200);
    const notification = notificationsBody.parse(await res.json()).notifications.find((entry) => entry.id === id);
    if (!notification) throw new Error(`notification ${id} is not listed`);
    return notification.title;
  }

  beforeAll(async () => {
    adminPool = getTestPool();
    pool = await createRuntimeRolePool(adminPool, "semprec_data");
  });

  afterAll(async () => {
    await pool?.end();
    await adminPool?.end();
  });

  beforeEach(async () => {
    await resetDatabase(adminPool);
    options = {
      passwordResetMailer: noopMailer,
      appBaseUrl: "https://app.example.test",
      setupToken: "account-profile-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(join(tmpdir(), `semprec-test-account-profile-${randomUUID()}`)),
      maxFileSizeBytes: 10 * 1024 * 1024,
    };
    server = createServer(await createDispatcher(pool, options));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("stores en and answers 200 with the user object the session endpoint returns, then stores cs again", async () => {
    const account = await signUp("admin");

    const res = await patchProfile(account.headers, { locale: "en" });

    expect(res.status).toBe(200);
    const changed = profileBody.parse(await res.json()).user;
    expect(changed).toEqual({
      id: account.userId,
      email: account.email,
      displayName: null,
      locale: "en",
      createdAt: account.signedIn.user.createdAt,
      role: "admin",
      personId: null,
    });
    expect(await sessionUser(account)).toEqual(changed);
    expect(await storedLocale(account.userId)).toBe("en");

    const back = await patchProfile(account.headers, { locale: "cs" });

    expect(back.status).toBe(200);
    const restored = profileBody.parse(await back.json()).user;
    expect(restored).toEqual({ ...changed, locale: "cs" });
    expect(await sessionUser(account)).toEqual(restored);
    expect(await storedLocale(account.userId)).toBe("cs");
  });

  it("returns a member's role and the person the account is linked to, as the session endpoint does", async () => {
    const account = await signUp("member");
    await seed(account);
    const personId = await createPerson(account, { name: "Ctibor" });
    const linked = await fetch(`${baseUrl}/api/auth/self-person`, {
      method: "PUT",
      headers: { ...account.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ personId }),
    });
    expect(linked.status).toBe(200);

    const res = await patchProfile(account.headers, { locale: "en" });

    expect(res.status).toBe(200);
    const user = profileBody.parse(await res.json()).user;
    expect(user).toMatchObject({ id: account.userId, locale: "en", role: "member", personId });
    expect(await sessionUser(account)).toEqual(user);
  });

  it("changes only the caller's row and queues only the caller's tenant's rebuild", async () => {
    const a = await signUp();
    const b = await signUp();
    const aBefore = await storedUser(a.userId);

    const res = await patchProfile(b.headers, { locale: "en" });

    expect(res.status).toBe(200);
    expect(profileBody.parse(await res.json()).user).toMatchObject({ id: b.userId, locale: "en" });
    expect(await storedLocale(b.userId)).toBe("en");
    expect(await storedUser(a.userId)).toEqual(aBefore);
    expect((await sessionUser(a)).locale).toBe("cs");
    expect(await queuedReindexes()).toEqual([reindexOf(b)]);
  });

  it("queues the tenant's search rebuild when the stored locale changes and nothing when it stays the same", async () => {
    const account = await signUp();

    // The account is created with cs.
    const same = await patchProfile(account.headers, { locale: "cs" });
    expect(same.status).toBe(200);
    expect(profileBody.parse(await same.json()).user.locale).toBe("cs");
    expect(await queuedReindexes()).toEqual([]);

    expect((await patchProfile(account.headers, { locale: "en" })).status).toBe(200);
    expect(await queuedReindexes()).toEqual([reindexOf(account)]);
    await runReindexes();
    expect(await queuedReindexes()).toEqual([]);

    const again = await patchProfile(account.headers, { locale: "en" });
    expect(again.status).toBe(200);
    expect(profileBody.parse(await again.json()).user.locale).toBe("en");
    expect(await queuedReindexes()).toEqual([]);

    expect((await patchProfile(account.headers, { locale: "cs" })).status).toBe(200);
    expect(await queuedReindexes()).toEqual([reindexOf(account)]);
  });

  it.each<[string, unknown, string]>([
    ["no body", undefined, "locale"],
    ["an empty object", {}, "locale"],
    ["an unsupported locale", { locale: "de" }, "locale"],
    ["a blank locale", { locale: "" }, "locale"],
    ["an upper-case locale", { locale: "EN" }, "locale"],
    ["a null locale", { locale: null }, "locale"],
    ["a non-string locale", { locale: 1 }, "locale"],
    ["a display name beside the locale", { locale: "en", displayName: "Ada" }, "displayName"],
    ["an avatar colour beside the locale", { locale: "en", avatarColor: "#FF9500" }, "avatarColor"],
    ["a display name alone", { displayName: "Ada" }, "displayName"],
    ["a user id beside the locale", { locale: "en", userId: randomUUID() }, "userId"],
  ])("answers %s with 400 validation_failed naming the field, and writes nothing", async (_name, body, field) => {
    const account = await signUp();
    const before = await storedUser(account.userId);

    const res = await patchProfile(account.headers, body);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "validation_failed", details: { field } } });
    expect(await storedUser(account.userId)).toEqual(before);
    expect(await queuedReindexes()).toEqual([]);
  });

  it.each<[string, string]>([
    ["the JSON literal null", "null"],
    ["a JSON array", '["en"]'],
    ["a JSON string", '"en"'],
    ["malformed JSON", "{"],
  ])("answers a body that is %s with 400 validation_failed and writes nothing", async (_name, raw) => {
    const account = await signUp();
    const before = await storedUser(account.userId);

    const res = await patchProfile(account.headers, raw);

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { code: "validation_failed" } });
    expect(await storedUser(account.userId)).toEqual(before);
    expect(await queuedReindexes()).toEqual([]);
  });

  it("refuses a body that names another account's user id, and neither account's row changes", async () => {
    const victim = await signUp();
    const caller = await signUp();
    const victimBefore = await storedUser(victim.userId);
    const callerBefore = await storedUser(caller.userId);

    const res = await patchProfile(caller.headers, { locale: "en", userId: victim.userId });

    expect(res.status).toBe(400);
    expect(await storedUser(victim.userId)).toEqual(victimBefore);
    expect(await storedUser(caller.userId)).toEqual(callerBefore);
  });

  it("answers 401 without a session and writes nothing", async () => {
    const account = await signUp();

    const res = await patchProfile({}, { locale: "en" });

    expect(res.status).toBe(401);
    expect(await storedLocale(account.userId)).toBe("cs");
    expect(await queuedReindexes()).toEqual([]);
  });

  it("answers 404 to another method on the path", async () => {
    const account = await signUp();

    const res = await fetch(`${baseUrl}/api/account/profile`, {
      method: "POST",
      headers: { ...account.headers, "Content-Type": "application/json" },
      body: JSON.stringify({ locale: "en" }),
    });

    expect(res.status).toBe(404);
    expect(await storedLocale(account.userId)).toBe("cs");
  });

  it("answers 413 to a body over the adapter's cap and writes nothing", async () => {
    const account = await signUp();

    const res = await patchProfile(account.headers, { locale: "en", padding: "x".repeat(2 * 1024 * 1024) });

    expect(res.status).toBe(413);
    expect(await storedLocale(account.userId)).toBe("cs");
    expect(await queuedReindexes()).toEqual([]);
  });

  it("answers not_found when the account has no row by the time the handler runs", async () => {
    const account = await signUp();
    const route = createAccountRoutes(pool, options).find(
      (candidate) => candidate.method === "PATCH" && candidate.path === "/api/account/profile",
    );
    if (!route) throw new Error("the profile route is not registered");
    // No request reaches this state through the dispatcher, which refuses a session without a user with
    // 401 first, so the handler is called with the identity of an account whose row is gone.
    const identity = {
      session: account.signedIn.session,
      user: { ...account.signedIn.user, id: randomUUID() },
      tenantId: account.tenantId,
      role: account.signedIn.role,
    };

    const outcome = await runInTenant(account.tenantId, () =>
      route.handler({ req: new IncomingMessage(new Socket()), identity, params: {}, body: { locale: "en" } }),
    ).catch((err: unknown) => err);

    expect(outcome).toBeInstanceOf(NotFoundError);
    expect(outcome).toMatchObject({ status: 404, code: "not_found" });
    expect(await storedLocale(account.userId)).toBe("cs");
    expect(await queuedReindexes()).toEqual([]);
  });

  it("names the collections of /api/databases in the new language after the change, and in Czech again after changing back", async () => {
    const account = await signUp();
    await seed(account);
    expect((await databaseOf(account, "tasks")).name).toBe("Úkoly");
    expect((await databaseOf(account, "people")).name).toBe("Lidé");

    expect((await patchProfile(account.headers, { locale: "en" })).status).toBe(200);

    expect((await databaseOf(account, "tasks")).name).toBe("Tasks");
    expect((await databaseOf(account, "people")).name).toBe("People");

    expect((await patchProfile(account.headers, { locale: "cs" })).status).toBe(200);

    expect((await databaseOf(account, "tasks")).name).toBe("Úkoly");
  });

  it("writes a notification created after the change in the new language and leaves an earlier one as it was", async () => {
    const account = await signUp();
    const earlier = await notifyHeartbeatFailure(account, "Ranní");
    expect(await notificationTitle(account, earlier)).toBe("Heartbeat „Ranní“ selhal");

    expect((await patchProfile(account.headers, { locale: "en" })).status).toBe(200);
    const later = await notifyHeartbeatFailure(account, "Ranní");

    expect(await notificationTitle(account, later)).toBe('Heartbeat "Ranní" failed');
    expect(await notificationTitle(account, earlier)).toBe("Heartbeat „Ranní“ selhal");
  });

  it("lets a search find the English label of a select option once the queued rebuild has run, in the caller's tenant only", async () => {
    const account = await signUp();
    const other = await signUp();
    await seed(account);
    await seed(other);
    const neighbor = await createPerson(account, { name: "Ctibor", relationship: "neighbor" });
    const otherNeighbor = await createPerson(other, { name: "Drahomíra", relationship: "neighbor" });
    expect(await searchHits(account, "Soused")).toEqual([neighbor]);
    expect(await searchHits(account, "Neighbor")).toEqual([]);

    expect((await patchProfile(account.headers, { locale: "en" })).status).toBe(200);

    // The rebuild is a queued job: until it runs, the document still holds the Czech label.
    expect(await searchHits(account, "Soused")).toEqual([neighbor]);
    expect(await searchHits(account, "Neighbor")).toEqual([]);

    await runReindexes();

    expect(await searchHits(account, "Neighbor")).toEqual([neighbor]);
    expect(await searchHits(account, "Soused")).toEqual([]);
    expect(await searchHits(other, "Soused")).toEqual([otherNeighbor]);
    expect(await searchHits(other, "Neighbor")).toEqual([]);
  });
});
