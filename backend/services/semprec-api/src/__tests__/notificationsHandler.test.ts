import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import { getTenantZeroId, getTestPool, resetDatabase, tenantForNextTestUser } from "@semprec/data/testSupport";
import { createViewTypeRegistry, seedSystem, createUser, hashPassword, login } from "@semprec/data";
import { createNotificationsRequestListener } from "../notificationsHandler.js";
import { runFixtureGuardControl, runTranscriptionFixture, withFixtureStorage } from "./transcriptionHttpFixture.js";

const PASSWORD = "s3cret-password";

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
    const signaled: number[] = [];
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
        expect(result.closed).toBe(true);
        expect(result.temporaryRemoved).toBe(true);
        expect(result.poolClosed).toBe(true);
      });
    } finally {
      kill.mockRestore();
    }
  }, 15000);

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
