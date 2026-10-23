import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { currentTenantScope, runInTenant, type TenantScope } from "@semprec/shared";
import { readJobPayloadsByIdentifier } from "@semprec/queue/testSupport";
import {
  createRuntimeRolePool,
  createTestTenant,
  getTenantZeroId,
  getTestPool,
  resetDatabase,
} from "../testSupport/testDb.js";
import { createDatabase } from "../chokePoint/databasesStore.js";
import { createItemWithClient } from "../chokePoint/itemWrites.js";
import { withTransaction } from "../db/pool.js";
import { seedSystem } from "../seed/seedSystem.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import {
  createMailLiveSyncRoot,
  createNoopMailLiveSyncLifecycleFactory,
  type MailAccountLifecycle,
  type MailLiveSyncAccount,
  type MailLiveSyncLifecycleFactory,
} from "../mail/mailLiveSyncRoot.js";
import {
  mailSyncProcessName,
  PROCESS_HEARTBEAT_INTERVAL_MS,
  startProcessHeartbeat,
} from "../health/processHeartbeats.js";

let pool: Pool;
let dataPool: Pool | undefined;

interface SpyLifecycle extends MailAccountLifecycle {
  starts: Array<TenantScope | undefined>;
  stops: Array<TenantScope | undefined>;
}

function spyFactory(): { factory: MailLiveSyncLifecycleFactory; byAccount: Map<string, SpyLifecycle> } {
  const byAccount = new Map<string, SpyLifecycle>();
  const factory: MailLiveSyncLifecycleFactory = (account: MailLiveSyncAccount) => {
    const lifecycle: SpyLifecycle = {
      starts: [],
      stops: [],
      async start() {
        lifecycle.starts.push(currentTenantScope());
      },
      async stop() {
        lifecycle.stops.push(currentTenantScope());
      },
    };
    byAccount.set(account.mailboxItemId, lifecycle);
    return lifecycle;
  };
  return { factory, byAccount };
}

/** Tenant zero's seeded mailbox, created through the runtime role inside tenant zero. */
async function addMailboxToTenantZero(runtimePool: Pool): Promise<string> {
  return runInTenant(getTenantZeroId(), () =>
    withTransaction(runtimePool, async (client) => {
      const { rows } = await client.query<{ id: string }>("SELECT id FROM databases WHERE owner_module_id = $1", [
        MAILBOXES_MODULE_ID,
      ]);
      const databaseId = rows[0]?.id;
      if (!databaseId) throw new Error("tenant zero has no Mailboxes database");
      const item = await createItemWithClient(client, { databaseId, properties: { provider: "generic" } });
      return item.id;
    }),
  );
}

/** Tenant B's minimal mail fixture: the four system databases, and one mailbox when asked. */
async function createMailFixture(runtimePool: Pool, tenantId: string, withMailbox: boolean): Promise<string | null> {
  return runInTenant(tenantId, () =>
    withTransaction(runtimePool, async (client) => {
      let mailboxesId = "";
      for (const ownerModuleId of [EMAILS_MODULE_ID, FILES_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID]) {
        // `key` stays unset: `databases_key_unique` is still global.
        const database = await createDatabase(client, { name: ownerModuleId, system: true, ownerModuleId });
        if (ownerModuleId === MAILBOXES_MODULE_ID) mailboxesId = database.id;
      }
      if (!withMailbox) return null;
      const item = await createItemWithClient(client, {
        databaseId: mailboxesId,
        properties: {},
      });
      return item.id;
    }),
  );
}

afterAll(async () => {
  await pool?.end();
});

describe("mail live-sync root across tenants (issue #990)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    await seedSystem(pool);
    dataPool = await createRuntimeRolePool(pool, "semprec_data");
  });

  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await dataPool?.end();
    dataPool = undefined;
  });

  it("hosts each tenant's mailbox inside its own scope, with no ambient scope on the caller", async () => {
    const tenantB = await createTestTenant(pool);
    const m0 = await addMailboxToTenantZero(dataPool!);
    const mb = (await createMailFixture(dataPool!, tenantB, true))!;

    const { factory, byAccount } = spyFactory();
    const root = createMailLiveSyncRoot(dataPool!, factory);
    expect(currentTenantScope()).toBeUndefined();
    await root.reconcileOnce();

    expect(byAccount.get(m0)?.starts).toEqual([{ kind: "tenant", tenantId: getTenantZeroId() }]);
    expect(byAccount.get(mb)?.starts).toEqual([{ kind: "tenant", tenantId: tenantB }]);

    const { rows } = await pool.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM mail_account_sync_state WHERE item_id = $1",
      [mb],
    );
    expect(rows).toEqual([{ tenant_id: tenantB }]);

    await root.stop();
  });

  it("stamps the noop lifecycle's mailAccountSync job with the mailbox's tenant", async () => {
    const tenantB = await createTestTenant(pool);
    const mb = (await createMailFixture(dataPool!, tenantB, true))!;

    const root = createMailLiveSyncRoot(dataPool!, createNoopMailLiveSyncLifecycleFactory(dataPool!));
    await root.reconcileOnce();
    await root.stop();

    const payloads = await readJobPayloadsByIdentifier(pool, "mailAccountSync");
    const forMb = payloads.filter((payload) => JSON.stringify(payload).includes(mb));
    expect(forMb).toHaveLength(1);
    expect(forMb[0]).toMatchObject({ tenantId: tenantB });
  });

  it("installs the discovery interval from inside the mail:liveSync system scope", async () => {
    const realSetInterval = globalThis.setInterval;
    let scopeAtSchedule: TenantScope | undefined;
    const spy = vi.spyOn(globalThis, "setInterval").mockImplementation((...args: Parameters<typeof setInterval>) => {
      scopeAtSchedule = currentTenantScope();
      return realSetInterval(...args);
    });

    const { factory } = spyFactory();
    const root = createMailLiveSyncRoot(dataPool!, factory);
    try {
      expect(currentTenantScope()).toBeUndefined();
      await root.start();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(scopeAtSchedule).toEqual({ kind: "system", reason: "mail:liveSync" });
    } finally {
      spy.mockRestore();
      await root.stop();
    }
  });

  it("isolates a tenant without mail databases: reports once, still hosts tenant zero", async () => {
    await createTestTenant(pool);
    const m0 = await addMailboxToTenantZero(dataPool!);

    const errors: Array<{ id: string; phase: string; err: unknown }> = [];
    const { factory, byAccount } = spyFactory();
    const root = createMailLiveSyncRoot(dataPool!, factory, {
      onLifecycleError: (id, phase, err) => errors.push({ id, phase, err }),
    });
    await expect(root.reconcileOnce()).resolves.toBeUndefined();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ id: "*", phase: "discover" });
    expect(String((errors[0]?.err as Error).message)).toContain(MAILBOXES_MODULE_ID);
    expect(byAccount.get(m0)?.starts).toHaveLength(1);

    await root.stop();
  });

  it("keeps a failed tenant's lifecycles, and does not restart them once it recovers", async () => {
    const tenantB = await createTestTenant(pool);
    const mb = (await createMailFixture(dataPool!, tenantB, true))!;

    const errors: Array<{ id: string; phase: string }> = [];
    const { factory, byAccount } = spyFactory();
    const root = createMailLiveSyncRoot(dataPool!, factory, {
      onLifecycleError: (id, phase) => errors.push({ id, phase }),
    });
    await root.reconcileOnce();
    const lifecycle = byAccount.get(mb);
    expect(lifecycle?.starts).toHaveLength(1);

    await pool.query("UPDATE databases SET owner_module_id = NULL WHERE tenant_id = $1 AND owner_module_id = $2", [
      tenantB,
      FILES_MODULE_ID,
    ]);
    await root.reconcileOnce();
    expect(errors).toEqual([{ id: "*", phase: "discover" }]);
    expect(lifecycle?.stops).toHaveLength(0);

    await pool.query("UPDATE databases SET owner_module_id = $2 WHERE tenant_id = $1 AND name = $2", [
      tenantB,
      FILES_MODULE_ID,
    ]);
    await root.reconcileOnce();
    expect(byAccount.get(mb)).toBe(lifecycle);
    expect(lifecycle?.starts).toHaveLength(1);
    expect(lifecycle?.stops).toHaveLength(0);

    await root.stop();
  });

  it("stops a deactivated tenant's lifecycle in its scope and leaves the others alone", async () => {
    const tenantB = await createTestTenant(pool);
    const m0 = await addMailboxToTenantZero(dataPool!);
    const mb = (await createMailFixture(dataPool!, tenantB, true))!;

    // Only the heartbeat's interval is faked, so the tick can be advanced without waiting 15 s.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { factory, byAccount } = spyFactory();
    const root = createMailLiveSyncRoot(dataPool!, factory);
    await root.reconcileOnce();

    await pool.query("UPDATE tenants SET status = 'suspended' WHERE id = $1", [tenantB]);
    await root.reconcileOnce();

    expect(byAccount.get(mb)?.stops).toEqual([{ kind: "tenant", tenantId: tenantB }]);
    expect(byAccount.get(m0)?.stops).toHaveLength(0);

    const beat = async (id: string): Promise<number | undefined> => {
      const { rows } = await pool.query<{ beat_at: Date }>(
        "SELECT beat_at FROM process_heartbeats WHERE process = $1",
        [mailSyncProcessName(id)],
      );
      return rows[0]?.beat_at.getTime();
    };
    // Each hosted account's first beat is a fire-and-forget write, so wait for both rows to exist.
    await vi.waitFor(
      async () => {
        expect(await beat(mb)).toBeDefined();
        expect(await beat(m0)).toBeDefined();
      },
      { timeout: 5000 },
    );
    const before = { mb: (await beat(mb))!, m0: (await beat(m0))! };
    await vi.advanceTimersByTimeAsync(PROCESS_HEARTBEAT_INTERVAL_MS);
    // M0's heartbeat ticks (a real write, awaited by polling); MB's was stopped with its lifecycle.
    await vi.waitFor(async () => expect(await beat(m0)).toBeGreaterThan(before.m0), { timeout: 5000 });
    expect(await beat(mb)).toBe(before.mb);

    await root.stop();
  });
});

describe("process heartbeat ticks (issue #990)", () => {
  beforeEach(async () => {
    pool ??= getTestPool();
    await resetDatabase(pool);
    dataPool = await createRuntimeRolePool(pool, "semprec_data");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await dataPool?.end();
    dataPool = undefined;
  });

  it("writes its row on every tick with no ambient scope, in strict mode, without onError", async () => {
    vi.stubEnv("SEMPREC_TENANT_SCOPE", "strict");
    const onError = vi.fn();
    const handle = startProcessHeartbeat(
      dataPool!,
      { process: "api", pid: 1, version: "1.0.0" },
      { intervalMs: 50, onError },
    );
    const read = async (): Promise<number> => {
      const { rows } = await pool.query<{ beat_at: Date }>(
        "SELECT beat_at FROM process_heartbeats WHERE process = 'api'",
      );
      return rows[0]?.beat_at.getTime() ?? 0;
    };
    await vi.waitFor(async () => expect(await read()).toBeGreaterThan(0), { timeout: 5000 });
    const first = await read();
    await vi.waitFor(async () => expect(await read()).toBeGreaterThan(first), { timeout: 5000 });
    handle.stop();

    expect(onError).not.toHaveBeenCalled();
  });
});
