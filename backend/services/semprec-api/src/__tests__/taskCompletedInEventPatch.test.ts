import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { z } from "zod";
import {
  createChokePoint,
  createUser,
  createViewTypeRegistry,
  getDatabaseByModuleId,
  hashPassword,
  loadFullModuleRegistry,
  LocalFsBlobStorageWriter,
  login,
  seedSystem,
  withTransaction,
  type PasswordResetMailer,
} from "@semprec/data";
import {
  createRuntimeRolePool,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
  tenantForNextTestUser,
} from "@semprec/data/testSupport";
import { runInTenant } from "@semprec/shared";
import { createDispatcher } from "../app.js";

const PASSWORD = "s3cret-password";
const noopMailer: PasswordResetMailer = {
  async sendPasswordResetEmail() {},
};
const moduleRegistry = await loadFullModuleRegistry();
const tmpBlobDir = join(tmpdir(), `semprec-test-blobs-${randomUUID()}`);

/** A calendar day `days` from the server's day, far enough from today that midnight cannot change a case. */
const dayFromNow = (days: number): string => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const completedTargets = z.object({
  relations: z.array(z.object({ propertyKey: z.string(), targetItemId: z.string() })),
});

describe("completing a task in an event through PATCH /api/items/:id (issue #1781)", () => {
  let admin: Pool;
  let runtime: Pool;
  let server: Server;
  let base: string;
  let headers: Record<string, string>;
  let foreignHeaders: Record<string, string>;
  let tasksId: string;
  let eventsId: string;

  async function authHeader(): Promise<Record<string, string>> {
    const user = await createUser(admin, {
      tenantId: await tenantForNextTestUser(admin),
      email: `${randomUUID()}@example.com`,
      passwordHash: await hashPassword(PASSWORD),
    });
    const { token } = await login(admin, { email: user.email, password: PASSWORD, platform: "ios", ip: "127.0.0.1" });
    return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  }

  beforeEach(async () => {
    admin = getTestPool();
    await resetDatabase(admin);
    await seedSystem(admin, createViewTypeRegistry());
    headers = await authHeader();
    foreignHeaders = await authHeader();
    runtime = await createRuntimeRolePool(admin, "semprec_data");
    const role = await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    const ids = await runInTenant(getTenantZeroId(), () =>
      withTransaction(runtime, async (client) => {
        const tasks = await getDatabaseByModuleId(client, "tasks");
        const events = await getDatabaseByModuleId(client, "events");
        if (!tasks || !events) throw new Error("Missing system database");
        return { tasks: tasks.id, events: events.id };
      }),
    );
    tasksId = ids.tasks;
    eventsId = ids.events;
    const dispatch = await createDispatcher(runtime, {
      passwordResetMailer: noopMailer,
      appBaseUrl: "http://localhost",
      setupToken: "unused-setup-token",
      moduleRegistry,
      blobStorage: new LocalFsBlobStorageWriter(tmpBlobDir),
      maxFileSizeBytes: 10 * 1024 * 1024,
    });
    server = createServer(dispatch);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected a bound TCP address");
    base = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await runtime.end();
  });

  afterAll(async () => {
    await admin?.end();
  });

  /**
   * A task of tenant zero placed, through the route of issue #1764, in an event on `eventDay` (with the times of
   * `eventTimes`, none for an event of the whole day).
   */
  async function taskInEvent(
    eventDay: string,
    eventTimes: { timeFrom: string; timeTo: string } | null = null,
  ): Promise<{ taskId: string; eventId: string }> {
    const cp = createChokePoint(runtime);
    const [task, event] = await runInTenant(getTenantZeroId(), () =>
      Promise.all([
        cp.createItem({ databaseId: tasksId, properties: { name: "Task", date: dayFromNow(1) } }),
        cp.createItem({ databaseId: eventsId, properties: { name: "Event", date: eventDay, ...eventTimes } }),
      ]),
    );
    const placed = await fetch(`${base}/api/tasks/${task.id}/host-events/${event.id}`, { method: "PUT", headers });
    expect(placed.status).toBe(200);
    return { taskId: task.id, eventId: event.id };
  }

  /** The version token a PATCH of the task must carry, read by the owner. */
  async function versionOf(taskId: string): Promise<string> {
    const response = await fetch(`${base}/api/items/${taskId}`, { headers });
    expect(response.status).toBe(200);
    return z.object({ updatedAt: z.string() }).parse(await response.json()).updatedAt;
  }

  const patch = async (taskId: string, status: string, requestHeaders = headers, ifVersion?: string) =>
    fetch(`${base}/api/items/${taskId}`, {
      method: "PATCH",
      headers: requestHeaders,
      body: JSON.stringify({ properties: { status }, ifVersion: ifVersion ?? (await versionOf(taskId)) }),
    });

  async function completedIn(taskId: string): Promise<string[]> {
    const response = await fetch(`${base}/api/items/${taskId}/relations?propertyKey=completedInEvent`, { headers });
    expect(response.status).toBe(200);
    return completedTargets
      .parse(await response.json())
      .relations.map((relation) => relation.targetItemId)
      .sort();
  }

  it("records the edge for a task set to done before its event has ended, and removes it again on notDone", async () => {
    const { taskId, eventId } = await taskInEvent(dayFromNow(2));
    expect((await patch(taskId, "done")).status).toBe(200);
    expect(await completedIn(taskId)).toEqual([eventId]);
    expect((await patch(taskId, "notDone")).status).toBe(200);
    expect(await completedIn(taskId)).toEqual([]);
  });

  it("removes the edge on wontDo", async () => {
    const { taskId, eventId } = await taskInEvent(dayFromNow(2));
    await patch(taskId, "done");
    expect(await completedIn(taskId)).toEqual([eventId]);
    expect((await patch(taskId, "wontDo")).status).toBe(200);
    expect(await completedIn(taskId)).toEqual([]);
  });

  it("records no edge for a completion after the event has ended", async () => {
    const { taskId } = await taskInEvent(dayFromNow(-2));
    expect((await patch(taskId, "done")).status).toBe(200);
    expect(await completedIn(taskId)).toEqual([]);
  });

  describe("a timed event of 15 October 13:00 to 14:00 in Europe/Prague, with only the clock controlled", () => {
    const TIMES = { timeFrom: "13:00", timeTo: "14:00" };

    // Only `Date` is faked, so the timers of the HTTP stack and the pool keep running.
    const setClock = (iso: string): void => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(iso));
    };

    it("records the edge for a completion at 13:30, before the event has ended", async () => {
      const { taskId, eventId } = await taskInEvent("2026-10-15", TIMES);
      setClock("2026-10-15T11:30:00.000Z");
      expect((await patch(taskId, "done")).status).toBe(200);
      expect(await completedIn(taskId)).toEqual([eventId]);
    });

    it("records no edge for a completion at 14:30, after the event has ended", async () => {
      const { taskId } = await taskInEvent("2026-10-15", TIMES);
      setClock("2026-10-15T12:30:00.000Z");
      expect((await patch(taskId, "done")).status).toBe(200);
      expect(await completedIn(taskId)).toEqual([]);
    });
  });

  it("answers a foreign tenant's PATCH like a random id and leaves the task and its edge alone", async () => {
    const { taskId, eventId } = await taskInEvent(dayFromNow(2));
    const ifVersion = await versionOf(taskId);
    const foreign = await patch(taskId, "done", foreignHeaders, ifVersion);
    const randomId = randomUUID();
    const random = await patch(randomId, "done", foreignHeaders, ifVersion);
    expect(foreign.status).toBe(404);
    expect(random.status).toBe(404);
    expect((await foreign.text()).replaceAll(taskId, "<id>")).toEqual(
      (await random.text()).replaceAll(randomId, "<id>"),
    );
    expect(await completedIn(taskId)).toEqual([]);
    expect((await patch(taskId, "done")).status).toBe(200);
    expect(await completedIn(taskId)).toEqual([eventId]);
  });
});
