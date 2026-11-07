import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import {
  getTestPool,
  registerItemDeleteHook,
  registerItemRestoreHook,
  resetDatabase,
  tenantForNextTestUser,
  type ItemDeleteHookContext,
  type ItemRestoreHookContext,
} from "@semprec/data/testSupport";
import {
  createChokePoint,
  createUser,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  ValidationError,
  type ChokePoint,
  type PasswordResetMailer,
} from "@semprec/data";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);
const noopMailer: PasswordResetMailer = { async sendPasswordResetEmail() {} };
const moduleRegistry = await loadFullModuleRegistry();

let pool: Pool;
let chokePoint: ChokePoint;

/**
 * The calls the delete and restore hooks of issue #1601 received. The recorders are registered once for
 * the file (a registry has no unregister); each test starts with empty lists, and `veto` names the item
 * whose hook call rejects.
 */
const calls: { delete: ItemDeleteHookContext[]; restore: ItemRestoreHookContext[] } = { delete: [], restore: [] };
let veto: string | null = null;

const itemBody = z.object({ id: z.string(), deletedAt: z.string().nullable() }).passthrough();

describe("item trash and restore routes run the delete and restore hooks (issue #1601)", () => {
  let server: Server;
  let baseUrl: string;
  let headers: Record<string, string>;
  let userId: string;

  beforeAll(() => {
    registerItemDeleteHook(async (context) => {
      calls.delete.push(context);
      if (veto === context.item.id) throw new ValidationError("delete vetoed", { field: "item" });
    });
    registerItemRestoreHook(async (context) => {
      calls.restore.push(context);
      if (veto === context.item.id) throw new ValidationError("restore vetoed", { field: "item" });
    });
  });

  beforeEach(async () => {
    pool ??= getTestPool();
    chokePoint ??= createChokePoint(pool);
    await resetDatabase(pool);
    calls.delete = [];
    calls.restore = [];
    veto = null;
    const user = await createUser(pool, {
      tenantId: await tenantForNextTestUser(pool),
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
    });
    userId = user.id;
    const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    headers = { Authorization: `Bearer ${token}` };
    server = createServer(
      await createDispatcher(pool, {
        passwordResetMailer: noopMailer,
        appBaseUrl: "http://localhost",
        setupToken: "unused-setup-token",
        moduleRegistry,
        blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
        maxFileSizeBytes: 10 * 1024 * 1024,
      }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a bound TCP address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await pool?.end();
  });

  async function makePage() {
    const rootDb = await chokePoint.createDatabase({ name: "Root" });
    const root = await chokePoint.createItem({ databaseId: rootDb.id, properties: {} });
    const childDb = await chokePoint.createInlineDatabase({ name: "Children", parentItemId: root.id });
    const kept = await chokePoint.createItem({ databaseId: childDb.id, properties: {} });
    const separate = await chokePoint.createItem({ databaseId: childDb.id, properties: {} });
    return { rootDb, root, childDb, kept, separate, ids: [root.id, kept.id, separate.id] };
  }

  async function deletedAt(ids: string[]): Promise<Record<string, string | null>> {
    const { rows } = await pool.query<{ id: string; deleted_at: string | null }>(
      `SELECT id::text, to_char(deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at
         FROM items WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return Object.fromEntries(rows.map((row) => [row.id, row.deleted_at]));
  }

  function trash(itemId: string) {
    return fetch(`${baseUrl}/api/items/${itemId}`, { method: "DELETE", headers });
  }

  function restore(itemId: string) {
    return fetch(`${baseUrl}/api/items/${itemId}/restore`, { method: "POST", headers });
  }

  it("DELETE runs the delete hook once per newly trashed row, root first, with one deletedAt and the user writer", async () => {
    const { root, kept, separate } = await makePage();
    const response = await trash(root.id);
    expect(response.status).toBe(200);
    const body = itemBody.parse(await response.json());

    expect(calls.delete[0]?.item.id).toBe(root.id);
    expect(calls.delete.map((call) => call.item.id).sort()).toEqual([root.id, kept.id, separate.id].sort());
    for (const call of calls.delete) {
      expect(call).toMatchObject({
        rootItemId: root.id,
        deletedAt: body.deletedAt,
        writerKind: "user",
        actingUserId: userId,
      });
      expect(Object.hasOwn(call, "agentRunId")).toBe(false);
    }
    expect(calls.restore).toEqual([]);
  });

  it("POST restore runs the restore hook only for the rows of the same cascade, not for a child trashed separately", async () => {
    const { root, kept, separate, ids } = await makePage();
    expect((await trash(separate.id)).status).toBe(200);
    expect((await trash(root.id)).status).toBe(200);
    const epoch = calls.delete.at(-1)?.deletedAt;
    calls.delete = [];

    const response = await restore(root.id);
    expect(response.status).toBe(200);

    expect(calls.restore.map((call) => call.item.id)).toEqual([root.id, kept.id]);
    for (const call of calls.restore) {
      expect(call).toMatchObject({ rootItemId: root.id, deletedAt: epoch, writerKind: "user", actingUserId: userId });
    }
    const states = await deletedAt(ids);
    expect(states[root.id]).toBeNull();
    expect(states[kept.id]).toBeNull();
    expect(states[separate.id]).not.toBeNull();
    expect(calls.delete).toEqual([]);
  });

  it("runs no hook for a DELETE of an already-trashed item or a restore of a live item", async () => {
    const { root } = await makePage();
    expect((await restore(root.id)).status).toBe(200);
    expect((await trash(root.id)).status).toBe(200);
    calls.delete = [];
    expect((await trash(root.id)).status).toBe(200);
    expect(calls.delete).toEqual([]);
    expect(calls.restore).toEqual([]);
  });

  it.each(["delete", "restore"] as const)(
    "fails the whole %s request and leaves every row of the cascade as it was when a hook throws",
    async (op) => {
      const { root, kept, ids } = await makePage();
      if (op === "restore") expect((await trash(root.id)).status).toBe(200);
      const before = await deletedAt(ids);
      veto = kept.id;

      const response = op === "delete" ? await trash(root.id) : await restore(root.id);

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation_failed" } });
      expect(await deletedAt(ids)).toEqual(before);
    },
  );
});
