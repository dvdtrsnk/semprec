import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { getTestPool, resetDatabase } from "../testSupport/testDb.js";
import { ensureMailAccountSyncState } from "../mail/mailAccountSyncStateStore.js";
import {
  FIXED_PROCESS_NAMES,
  getExpectedProcessHeartbeatStatuses,
  getExpectedProcessNames,
  isProcessHeartbeatFresh,
  mailSyncProcessName,
  startProcessHeartbeat,
  upsertProcessHeartbeat,
} from "../health/processHeartbeats.js";

let pool: Pool;

describe("processHeartbeats", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("upserts an identity row for any process type, api/agents/transcribe/ai-gateway/mailsync alike", async () => {
    const startedAt = new Date("2026-01-01T00:00:00Z");
    for (const process of [...FIXED_PROCESS_NAMES, mailSyncProcessName(randomUUID())]) {
      await upsertProcessHeartbeat(pool, { process, pid: 1234, version: "1.2.3" }, startedAt);
      expect(await isProcessHeartbeatFresh(pool, process)).toBe(true);
    }
  });

  it("keeps started_at stable across repeated ticks for the same process, but resets it for a new instance", async () => {
    const firstStartedAt = new Date("2026-01-01T00:00:00Z");
    await upsertProcessHeartbeat(pool, { process: "api", pid: 100, version: "1.0.0" }, firstStartedAt);
    await upsertProcessHeartbeat(pool, { process: "api", pid: 100, version: "1.0.0" }, firstStartedAt);

    const { rows: afterTicks } = await pool.query<{ started_at: Date }>(
      "SELECT started_at FROM process_heartbeats WHERE process = 'api'",
    );
    expect(afterTicks[0]?.started_at.toISOString()).toBe(firstStartedAt.toISOString());

    const secondStartedAt = new Date("2026-01-02T00:00:00Z");
    await upsertProcessHeartbeat(pool, { process: "api", pid: 101, version: "1.0.1" }, secondStartedAt);
    const { rows: afterRestart } = await pool.query<{ started_at: Date; pid: number }>(
      "SELECT started_at, pid FROM process_heartbeats WHERE process = 'api'",
    );
    expect(afterRestart[0]?.started_at.toISOString()).toBe(secondStartedAt.toISOString());
    expect(afterRestart[0]?.pid).toBe(101);
  });

  it("a frozen loop becomes stale after 60 seconds", async () => {
    const staleStartedAt = new Date(Date.now() - 5 * 60_000);
    await pool.query(
      `INSERT INTO process_heartbeats (process, pid, version, started_at, beat_at)
       VALUES ('agents', 1, '1.0.0', $1, $1)`,
      [staleStartedAt],
    );

    expect(await isProcessHeartbeatFresh(pool, "agents")).toBe(false);

    const statuses = await getExpectedProcessHeartbeatStatuses(pool);
    const agents = statuses.find((s) => s.process === "agents");
    expect(agents?.present).toBe(true);
    expect(agents?.stale).toBe(true);
  });

  it("a process with no row at all is neither fresh nor present", async () => {
    expect(await isProcessHeartbeatFresh(pool, "transcribe")).toBe(false);

    const statuses = await getExpectedProcessHeartbeatStatuses(pool);
    const transcribe = statuses.find((s) => s.process === "transcribe");
    expect(transcribe?.present).toBe(false);
    expect(transcribe?.stale).toBe(true);
  });

  it("derives expected mail-sync rows from active mailboxes, and drops them once deactivated", async () => {
    const mailboxItemId = randomUUID();

    let expected = await getExpectedProcessNames(pool);
    expect(expected).toEqual([...FIXED_PROCESS_NAMES]);

    await ensureMailAccountSyncState(pool, { itemId: mailboxItemId, syncMode: "imap" });
    expected = await getExpectedProcessNames(pool);
    expect(expected).toContain(mailSyncProcessName(mailboxItemId));

    // "Active mailboxes" is read straight off `mail_account_sync_state` — a disconnected account
    // has no row there at all, so removing it is exactly what deactivation looks like to this query.
    await pool.query("DELETE FROM mail_account_sync_state WHERE item_id = $1", [mailboxItemId]);
    expected = await getExpectedProcessNames(pool);
    expect(expected).not.toContain(mailSyncProcessName(mailboxItemId));
  });

  it("startProcessHeartbeat ticks immediately and again every intervalMs, reporting the same started_at", async () => {
    vi.useFakeTimers();
    try {
      const handle = startProcessHeartbeat(pool, { process: "api", pid: 42, version: "9.9.9" }, { intervalMs: 15_000 });
      await vi.advanceTimersByTimeAsync(0);

      expect(await isProcessHeartbeatFresh(pool, "api")).toBe(true);
      const { rows: firstTick } = await pool.query<{ started_at: Date }>(
        "SELECT started_at FROM process_heartbeats WHERE process = 'api'",
      );

      await vi.advanceTimersByTimeAsync(15_000);
      const { rows: secondTick } = await pool.query<{ started_at: Date }>(
        "SELECT started_at FROM process_heartbeats WHERE process = 'api'",
      );
      expect(secondTick[0]?.started_at.toISOString()).toBe(firstTick[0]?.started_at.toISOString());

      handle.stop();
      await vi.advanceTimersByTimeAsync(30_000);
      const { rows: afterStop } = await pool.query<{ count: string }>(
        "SELECT count(*)::text FROM process_heartbeats WHERE process = 'api'",
      );
      expect(afterStop[0]?.count).toBe("1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("startProcessHeartbeat reports a tick failure through onError instead of throwing out of the interval", async () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      const failingPool = {
        query: () => Promise.reject(new Error("boom: simulated transient DB failure")),
      } as unknown as Pool;

      startProcessHeartbeat(
        failingPool,
        { process: "api", pid: 1, version: "1.0.0" },
        { onError: (err) => errors.push(err) },
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(errors).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
