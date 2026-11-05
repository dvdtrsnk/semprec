import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import {
  createRuntimeRolePool,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  tenantForNextTestUser,
} from "@semprec/data/testSupport";
import {
  createAgentRun,
  createViewTypeRegistry,
  resolveNotificationsBySource,
  seedSystem,
  createUser,
  hashPassword,
  login,
  withTransaction,
  writeNotification,
} from "@semprec/data";
import { runInTenant } from "@semprec/shared";
import { createNotificationsRequestListener } from "../notificationsHandler.js";
import {
  runFixtureGuardControl,
  runFixtureOverflowWithoutObservation,
  runTranscriptionFixture,
  withFixtureStorage,
} from "./transcriptionHttpFixture.js";

const PASSWORD = "s3cret-password";
const poolFault = vi.hoisted(() => ({ failNextClose: false, closed: Array<unknown>() }));

vi.mock("@semprec/data/testSupport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@semprec/data/testSupport")>();
  return {
    ...actual,
    createRuntimeRolePool: async (...args: Parameters<typeof actual.createRuntimeRolePool>) => {
      const owned = await actual.createRuntimeRolePool(...args);
      if (poolFault.failNextClose) {
        poolFault.failNextClose = false;
        const close = owned.end.bind(owned);
        Object.defineProperty(owned, "end", {
          value: async () => {
            await close();
            try {
              await owned.query("SELECT 1");
              throw new Error("Fixture pool remained open after close");
            } catch (error) {
              if (!(error instanceof Error && error.message.includes("after calling end"))) throw error;
            }
            poolFault.closed.push(owned);
            throw new Error("fixture pool close diagnostic");
          },
        });
      }
      return owned;
    },
  };
});

let pool: Pool;

async function authHeader(): Promise<{ Authorization: string }> {
  const user = await createUser(pool, {
    tenantId: await tenantForNextTestUser(pool),
    email: `${randomUUID()}@example.com`,
    passwordHash: await hashPassword(PASSWORD),
  });
  const { token } = await login(pool, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
  return { Authorization: `Bearer ${token}` };
}

describe("createNotificationsRequestListener", () => {
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool, createViewTypeRegistry());

    server = createServer(createNotificationsRequestListener(pool));
    await new Promise<void>((resolve) => server.listen(0, resolve));
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

  it("drains timestamp ties over authenticated runtime HTTP without tenant leakage", async () => {
    const tenant = getTenantZeroId();
    const makeUser = async (tenantId: string) => {
      const email = `${randomUUID()}@example.test`;
      const user = await createUser(pool, { tenantId, email, passwordHash: await hashPassword(PASSWORD) });
      const { token } = await login(pool, { email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
      return { id: user.id, headers: { Authorization: `Bearer ${token}` } };
    };
    const own = await makeUser(tenant);
    const foreignTenant = await tenantForNextTestUser(pool);
    const foreign = await makeUser(foreignTenant);
    const runtime = await createRuntimeRolePool(pool, "semprec_data");
    const runtimeServer = createServer(createNotificationsRequestListener(runtime));
    const failures: unknown[] = [];
    try {
      const role = await runInTenant(tenant, () =>
        runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
        ),
      );
      expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
      const seed = (tenantId: string, userId: string, count: number) =>
        runInTenant(tenantId, () =>
          withTransaction(runtime, async (client) => {
            const run = await createAgentRun(client, { triggeredBy: "user", userId, task: "HTTP resolved fixture" });
            const ids: string[] = [];
            for (let i = 0; i < count; i++)
              ids.push(
                await writeNotification(client, {
                  userId,
                  kind: "agent_run_error",
                  sourceTable: "agent_runs",
                  sourceId: run.id,
                  transitionInstance: `transition-${i}`,
                  linkHref: null,
                }),
              );
            await resolveNotificationsBySource(client, { sourceTable: "agent_runs", sourceId: run.id });
            // Synthetic timestamp fixture: the production resolver always uses the database clock.
            const fixed = await client.query(
              "UPDATE notifications SET resolved_at = $3::timestamptz WHERE tenant_id = app_tenant_default() AND user_id = $1 AND id = ANY($2::uuid[]) AND resolved_at IS NOT NULL",
              [userId, ids, "2025-01-01T00:00:00.123456Z"],
            );
            expect(fixed.rowCount).toBe(count);
            return ids.sort();
          }),
        );
      const expected = await seed(tenant, own.id, 503);
      const otherIds = await seed(foreignTenant, foreign.id, 1);
      await new Promise<void>((resolve) => runtimeServer.listen(0, "127.0.0.1", resolve));
      const address = runtimeServer.address();
      if (!address || typeof address === "string") throw new Error("Missing runtime server address");
      const base = `http://127.0.0.1:${address.port}/api/notifications/resolved`;
      const request = (since: string, afterId?: string, headers = own.headers) => {
        const params = new URLSearchParams({ since, ...(afterId ? { afterId } : {}) });
        return fetch(`${base}?${params.toString()}`, { headers });
      };
      const schema = z.object({
        resolved: z.array(z.object({ id: z.uuid(), resolvedAt: z.string() })),
        nextCursor: z.object({ since: z.string(), afterId: z.uuid() }).nullable(),
      });
      const firstResponse = await request("2000-01-01T00:00:00Z");
      expect(firstResponse.status).toBe(200);
      expect(firstResponse.headers.get("cache-control")).toBe("no-store");
      const first = schema.parse(await firstResponse.json());
      expect(first.resolved).toHaveLength(500);
      const offsetResponse = await request("2000-01-01T01:00:00+01:00");
      expect(offsetResponse.status).toBe(200);
      expect(schema.parse(await offsetResponse.json())).toEqual(first);
      expect(first.nextCursor?.since).toBe("2025-01-01T00:00:00.123456Z");
      if (!first.nextCursor) throw new Error("Missing cursor");
      const exactTime = first.nextCursor.since;
      const justBefore = await runInTenant(tenant, () =>
        withTransaction(runtime, (client) =>
          client.query<{ value: string }>(
            "SELECT to_char(($1::timestamptz - interval '1 microsecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS value",
            [exactTime],
          ),
        ),
      );
      expect(
        schema.parse(await (await request(justBefore.rows[0]!.value)).json()).resolved.map((row) => row.id),
      ).toEqual(expected.slice(0, 500));
      expect(schema.parse(await (await request(exactTime)).json())).toEqual({ resolved: [], nextCursor: null });
      expect(schema.parse(await (await request("2025-01-01T00:00:00.123000Z")).json()).resolved).toHaveLength(500);
      const second = schema.parse(await (await request(first.nextCursor.since, first.nextCursor.afterId)).json());
      expect(second.resolved).toHaveLength(3);
      expect([...first.resolved, ...second.resolved].map((row) => row.id)).toEqual(expected);
      expect([...first.resolved, ...second.resolved].map((row) => row.id)).not.toContain(otherIds[0]);
      if (!second.nextCursor) throw new Error("Missing final cursor");
      expect(schema.parse(await (await request(second.nextCursor.since, second.nextCursor.afterId)).json())).toEqual({
        resolved: [],
        nextCursor: null,
      });
      const other = schema.parse(await (await request("2000-01-01T00:00:00Z", undefined, foreign.headers)).json());
      expect(other.resolved.map((row) => row.id)).toEqual(otherIds);
      for (const id of [otherIds[0]!, randomUUID()]) {
        const cursorResponse = await request(exactTime, id);
        expect(cursorResponse.status).toBe(200);
        expect(cursorResponse.headers.get("cache-control")).toBe("no-store");
        const page = schema.parse(await cursorResponse.json());
        expect(page.resolved.map((row) => row.id)).toEqual(expected.filter((ownId) => ownId > id).slice(0, 500));
        expect(page.resolved.map((row) => row.id)).not.toContain(otherIds[0]);
      }
      const unauthorized = await fetch(base);
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("cache-control")).toBe("no-store");
      for (const query of [
        "",
        "?since=invalid",
        "?since=2026-02-29T00%3A00%3A00Z",
        "?since=2026-01-01T00%3A00%3A00%2B16%3A00",
        "?since=2026-01-01T00%3A00%3A00.1234567Z",
        "?since=2026-01-01T00%3A00%3A00Z&afterId=invalid",
      ]) {
        const response = await fetch(`${base}${query}`, { headers: own.headers });
        expect(response.status).toBe(400);
        expect(response.headers.get("cache-control")).toBe("no-store");
      }
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        if (runtimeServer.listening)
          await new Promise<void>((resolve, reject) =>
            runtimeServer.close((error) => (error ? reject(error) : resolve())),
          );
      } catch (error) {
        failures.push(error);
      }
      try {
        await runtime.end();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Resolved notification fixture and cleanup failed");
  });

  it("reads a real transcription failure through unread and visit without diagnostic text", async () => {
    const headers = await authHeader();
    const storageRoot = await mkdtemp(join(tmpdir(), "semprec-http-transcription-"));
    await withFixtureStorage(storageRoot, async () => {
      const child = await runTranscriptionFixture({ mode: "failure", tenantId: getTenantZeroId(), storageRoot }, pool);
      const sentinel = "BATCH09_PRIVATE_PROVIDER_DIAGNOSTIC";
      const automation = await pool.query<Record<string, unknown>>(
        "SELECT error, error_code FROM item_automation WHERE item_id = $1",
        [child.result.transcriptId],
      );
      expect(z.object({ error: z.string(), error_code: z.string() }).parse(automation.rows[0])).toEqual({
        error: sentinel,
        error_code: "unknown",
      });
      expect(child.stdout + child.stderr).not.toContain(sentinel);
      const unread = await fetch(`${baseUrl}/api/notifications/unread`, { headers });
      expect(unread.status).toBe(200);
      const unreadBody: unknown = await unread.json();
      expect(JSON.stringify(unreadBody)).not.toContain(sentinel);
      const parsed = z
        .object({
          notifications: z.array(z.object({ id: z.uuid(), kind: z.string(), linkHref: z.string().nullable() })),
        })
        .parse(unreadBody);
      const notification = parsed.notifications.find((entry) => entry.kind === "automation_error");
      expect(notification?.linkHref).toBe(`?page=transcript&id=${child.result.transcriptId}`);
      expect(parsed.notifications.filter((entry) => entry.kind === "automation_error")).toHaveLength(1);
      if (!notification) throw new Error("Missing transcription failure notification");
      const rawNotifications = z
        .object({ notifications: z.array(z.record(z.string(), z.unknown())) })
        .parse(unreadBody);
      const rawNotification = rawNotifications.notifications.find((entry) => entry.id === notification.id);
      expect(rawNotification).toBeDefined();
      expect(rawNotification).not.toHaveProperty("error");
      expect(rawNotification).not.toHaveProperty("error_code");
      const visit = await fetch(`${baseUrl}/api/notifications/${notification.id}/visit`, { method: "POST", headers });
      expect(visit.status).toBe(200);
      const visitBody: unknown = await visit.json();
      expect(JSON.stringify(visitBody)).not.toContain(sentinel);
      expect(
        z.object({ notification: z.object({ linkHref: z.string() }) }).parse(visitBody).notification.linkHref,
      ).toBe(`?page=transcript&id=${child.result.transcriptId}`);
    });
  });

  // The temporary compiler has a 25 s bound; the actual child deadline is another 25 s.
  it("stops the owned fixture and its observed descendant at the real deadline", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "semprec-fixture-guard-"));
    await withFixtureStorage(storageRoot, async () => {
      const result = await runFixtureGuardControl(
        "hang",
        { mode: "failure", tenantId: getTenantZeroId(), storageRoot },
        pool,
      );
      expect(result.message).toBe("Transcription fixture timed out");
      expect(result.pid).toEqual(expect.any(Number));
      expect(result.descendantPid).toEqual(expect.any(Number));
      expect(result.descendantPid).toBeGreaterThan(0);
      expect(result.descendantPid).not.toBe(result.pid);
      expect(result.closed).toBe(true);
      expect(result.descendantGoneAfterGroupKill).toBe(true);
      expect(result.emergencyCleanupError).toBeNull();
      expect(result.temporaryRemoved).toBe(true);
      expect(result.poolClosed).toBe(true);
    });
  }, 65000);

  it.each([
    ["overflow", "Transcription fixture output exceeds limit"],
    ["malformed", "Invalid transcription fixture frame"],
    ["duplicate", "Expected exactly one transcription fixture frame"],
    ["resolver", "Unlisted workspace export: @semprec/data/private"],
  ] as const)(
    "closes and cleans the owned fixture after %s",
    async (control, expected) => {
      const storageRoot = await mkdtemp(join(tmpdir(), "semprec-fixture-guard-"));
      await withFixtureStorage(storageRoot, async () => {
        const result = await runFixtureGuardControl(
          control,
          { mode: "failure", tenantId: getTenantZeroId(), storageRoot },
          pool,
        );
        expect(result.message).toContain(expected);
        expect(result.pid).toEqual(expect.any(Number));
        expect(result.pid).toBeGreaterThan(0);
        expect(result.closed).toBe(true);
        expect(result.temporaryRemoved).toBe(true);
        expect(result.poolClosed).toBe(true);
      });
    },
    15000,
  );

  it("settles the owned child when its group signal fails without masking the primary failure", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "semprec-fixture-guard-"));
    const originalKill = process.kill.bind(process);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    const signaled: number[] = [];
    const stderr = vi.spyOn(process.stderr, "write");
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      signaled.push(pid);
      if (pid < 0 && signal === "SIGKILL") throw Object.assign(new Error("group signal refused"), { code: "EPERM" });
      return originalKill(pid, signal);
    });
    try {
      await withFixtureStorage(storageRoot, async () => {
        const result = await runFixtureGuardControl(
          "overflow",
          { mode: "failure", tenantId: getTenantZeroId(), storageRoot },
          pool,
        );
        expect(result.message).toBe("Transcription fixture output exceeds limit");
        expect(result.pid).toEqual(expect.any(Number));
        if (result.pid === null) throw new Error("Missing fixture child PID");
        expect(signaled).toContain(-result.pid);
        expect(signaled).toContain(result.pid);
        expect(result.emergencyCleanupError).toContain("group signal refused");
        expect(
          stderr.mock.calls.some(
            ([chunk]) => typeof chunk === "string" && chunk.includes("Group kill failed: Error: group signal refused"),
          ),
        ).toBe(true);
        expect(result.closed).toBe(true);
        expect(result.temporaryRemoved).toBe(true);
        expect(result.poolClosed).toBe(true);
        const previousWrites = stderr.mock.calls.length;
        await expect(
          runFixtureOverflowWithoutObservation({ mode: "failure", tenantId: getTenantZeroId(), storageRoot }, pool),
        ).rejects.toThrow("Transcription fixture output exceeds limit");
        expect(
          stderr.mock.calls
            .slice(previousWrites)
            .some(
              ([chunk]) =>
                typeof chunk === "string" && chunk.includes("Group kill failed: Error: group signal refused"),
            ),
        ).toBe(true);
        stderr.mockImplementation((chunk, encoding, callback) => {
          if (typeof chunk === "string" && chunk.startsWith("Transcription fixture cleanup:"))
            throw new Error("fixture diagnostic output failed");
          return Reflect.apply(originalStderrWrite, process.stderr, [chunk, encoding, callback]);
        });
        const previousSignals = signaled.length;
        const reportingFailure = await runFixtureGuardControl(
          "overflow",
          { mode: "failure", tenantId: getTenantZeroId(), storageRoot },
          pool,
        );
        const caught = reportingFailure.error;
        expect(reportingFailure.pid).toEqual(expect.any(Number));
        if (reportingFailure.pid === null) throw new Error("Missing fixture child PID");
        expect(signaled.slice(previousSignals)).toContain(-reportingFailure.pid);
        expect(signaled.slice(previousSignals)).toContain(reportingFailure.pid);
        expect(reportingFailure.closed).toBe(true);
        expect(reportingFailure.temporaryRemoved).toBe(true);
        expect(reportingFailure.poolClosed).toBe(true);
        expect(caught).toBeInstanceOf(AggregateError);
        if (!(caught instanceof AggregateError)) throw new Error("Expected the original and reporting errors");
        expect(caught.message).toBe("Transcription fixture output exceeds limit");
        expect(caught.cause).toBe(caught.errors[0]);
        expect(caught.errors.map((error: unknown) => (error instanceof Error ? error.message : ""))).toEqual([
          "Transcription fixture output exceeds limit",
          "fixture diagnostic output failed",
        ]);
      });
    } finally {
      kill.mockRestore();
      stderr.mockRestore();
    }
  }, 15000);

  it("closes the runtime pool and preserves both errors when temporary cleanup fails", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "semprec-fixture-guard-"));
    const originalRemove = fs.rmSync;
    let ownedDirectory: string | undefined;
    const remove = vi.spyOn(fs, "rmSync").mockImplementation((path, options) => {
      if (typeof path === "string" && path.includes("/node_modules/.batch09-")) {
        ownedDirectory = path;
        throw new Error("temporary removal failed");
      }
      return originalRemove(path, options);
    });
    try {
      await withFixtureStorage(storageRoot, async () => {
        const result = await runFixtureGuardControl(
          "overflow",
          { mode: "failure", tenantId: getTenantZeroId(), storageRoot },
          pool,
        );
        expect(result.error).toBeInstanceOf(AggregateError);
        if (!(result.error instanceof AggregateError)) throw new Error("Expected both fixture errors");
        expect(result.error.message).toBe("Transcription fixture output exceeds limit");
        expect(result.error.cause).toBe(result.error.errors[0]);
        expect(result.error.errors.map((error: unknown) => (error instanceof Error ? error.message : ""))).toEqual([
          "Transcription fixture output exceeds limit",
          "temporary removal failed",
        ]);
        expect(result.closed).toBe(true);
        expect(result.poolClosed).toBe(true);
        expect(result.temporaryRemoved).toBe(false);
        expect(ownedDirectory).toBeDefined();
      });
    } finally {
      remove.mockRestore();
      if (ownedDirectory) originalRemove(ownedDirectory, { recursive: true, force: true });
    }
  }, 15000);

  it.each([true, false])(
    "reports an owned pool-close error with primary failure: %s",
    async (primaryFailure) => {
      const storageRoot = await mkdtemp(join(tmpdir(), "semprec-fixture-pool-"));
      poolFault.closed.length = 0;
      poolFault.failNextClose = true;
      try {
        await withFixtureStorage(storageRoot, async () => {
          let caught: unknown;
          try {
            if (primaryFailure) {
              const result = await runFixtureGuardControl(
                "overflow",
                { mode: "failure", tenantId: getTenantZeroId(), storageRoot },
                pool,
              );
              caught = result.error;
            } else {
              await runTranscriptionFixture({ mode: "failure", tenantId: getTenantZeroId(), storageRoot }, pool);
            }
          } catch (error) {
            caught = error;
          }
          expect(caught).toBeInstanceOf(AggregateError);
          if (!(caught instanceof AggregateError)) throw new Error("Expected a fixture cleanup error");
          expect(caught.message).toBe(
            primaryFailure ? "Transcription fixture output exceeds limit" : "Transcription fixture cleanup failed",
          );
          expect(caught.errors.map((error: unknown) => (error instanceof Error ? error.message : ""))).toEqual(
            primaryFailure
              ? ["Transcription fixture output exceeds limit", "fixture pool close diagnostic"]
              : ["fixture pool close diagnostic"],
          );
          if (primaryFailure) expect(caught.cause).toBe(caught.errors[0]);
          expect(poolFault.closed).toHaveLength(1);
        });
      } finally {
        poolFault.failNextClose = false;
        poolFault.closed.length = 0;
      }
    },
    15000,
  );

  it.each([true, false])("preserves storage removal failure with scenario failure: %s", async (scenarioFailure) => {
    const storageRoot = await mkdtemp(join(tmpdir(), "semprec-fixture-storage-"));
    const scenarioError = new Error("fixture scenario failed");
    const originalRemove = fsPromises.rm.bind(fsPromises);
    const remove = vi.spyOn(fsPromises, "rm").mockImplementation(async (path, options) => {
      if (path === storageRoot) throw new Error("fixture storage removal failed");
      return originalRemove(path, options);
    });
    try {
      let caught: unknown;
      try {
        await withFixtureStorage(storageRoot, async () => {
          if (scenarioFailure) throw scenarioError;
        });
      } catch (error) {
        caught = error;
      }
      if (scenarioFailure) {
        expect(caught).toBeInstanceOf(AggregateError);
        if (!(caught instanceof AggregateError)) throw new Error("Expected both storage errors");
        expect(caught.message).toBe("fixture scenario failed");
        expect(caught.cause).toBe(scenarioError);
        expect(caught.errors[0]).toBe(scenarioError);
        expect(caught.errors.map((error: unknown) => (error instanceof Error ? error.message : ""))).toEqual([
          "fixture scenario failed",
          "fixture storage removal failed",
        ]);
      } else {
        expect(caught).toBeInstanceOf(Error);
        if (!(caught instanceof Error)) throw new Error("Expected the storage cleanup error");
        expect(caught.message).toBe("fixture storage removal failed");
      }
    } finally {
      remove.mockRestore();
      await originalRemove(storageRoot, { recursive: true, force: true });
    }
  });

  it("removes the owned temporary build when the transcription producer fails", async () => {
    const storageRoot = await mkdtemp(join(tmpdir(), "semprec-http-transcription-"));
    const tempParent = join(process.cwd(), "../shared/block-model/node_modules");
    const before = (await readdir(tempParent)).filter((entry) => entry.startsWith(".batch09-")).sort();
    await withFixtureStorage(storageRoot, async () => {
      await expect(
        runTranscriptionFixture(
          {
            mode: "consume",
            tenantId: getTenantZeroId(),
            fileItemId: randomUUID(),
            storageRoot,
          },
          pool,
        ),
      ).rejects.toThrow("Transcription fixture failed");
      expect((await readdir(tempParent)).filter((entry) => entry.startsWith(".batch09-")).sort()).toEqual(before);
    });
  });

  describe("POST /api/notifications/:id/visit", () => {
    it("returns 400 validation_failed naming 'id' for a non-UUID notification id", async () => {
      const res = await fetch(`${baseUrl}/api/notifications/foo/visit`, {
        method: "POST",
        headers: await authHeader(),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { code: string; details?: unknown };
      expect(body.code).toBe("validation_failed");
      expect(body.details).toEqual({ field: "id" });
    });

    it("returns 404 for a well-formed but unknown notification id", async () => {
      const res = await fetch(`${baseUrl}/api/notifications/${randomUUID()}/visit`, {
        method: "POST",
        headers: await authHeader(),
      });
      expect(res.status).toBe(404);
    });
  });
});
