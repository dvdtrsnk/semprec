import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool } from "pg";
import { currentTenantScope, runAsSystem, runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { listItems } from "../chokePoint/itemsStore.js";
import {
  defaultSyncModeForProvider,
  ensureMailAccountSyncStateOfLiveMailbox,
  type SyncMode,
} from "./mailAccountSyncStateStore.js";
import { enqueueMailAccountSync } from "./mailSyncJob.js";
import { resolveMailModuleIds } from "./mailModuleIds.js";
import { forEachActiveTenant } from "../tenancy/forEachActiveTenant.js";
import {
  mailSyncProcessName,
  startProcessHeartbeat,
  type ProcessHeartbeatHandle,
} from "../health/processHeartbeats.js";

export interface MailLiveSyncAccount {
  mailboxItemId: string;
  syncMode: SyncMode;
}

/**
 * What the root hosts per active account (a socket, a renewal timer, ...). Any signal it observes must become a call
 * to `enqueueMailAccountSync` and nothing else: that is the one idempotent, per-account-deduplicated reconcile path,
 * and a lifecycle that ingested messages itself would be a parallel ingestion path.
 */
export interface MailAccountLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type MailLiveSyncLifecycleFactory = (account: MailLiveSyncAccount) => MailAccountLifecycle;

/**
 * The lifecycle for a sync mode without a real transport. `start` enqueues an immediate reconcile so a newly
 * discovered account does not wait for the periodic sweep; `stop` has nothing to release.
 */
export function createNoopMailLiveSyncLifecycleFactory(pool: Pool): MailLiveSyncLifecycleFactory {
  return (account) => ({
    async start() {
      await enqueueMailAccountSync(pool, account.mailboxItemId);
    },
    async stop() {},
  });
}

export interface MailLiveSyncRootOptions {
  /** Defaults to 60s. */
  discoveryIntervalMs?: number;
  /** A single lifecycle's failure surfaces only here and never stops the root hosting other accounts. */
  onLifecycleError?: (mailboxItemId: string, phase: "discover" | "start" | "stop" | "heartbeat", err: unknown) => void;
}

export interface MailLiveSyncRoot {
  start(): Promise<void>;
  /** Stops every hosted lifecycle and the discovery timer, and waits for every stop already running. */
  stop(): Promise<void>;
  reconcileOnce(): Promise<void>;
  /**
   * Waits for passes and restarts in flight, then stops every lifecycle of `tenantId` once. Only the tenant no longer
   * being `active` keeps a later pass from hosting it again.
   */
  stopTenant(tenantId: string): Promise<void>;
  /**
   * Replaces the account's lifecycle with a new one created after the call began, so it reads what the caller committed
   * (a replaced credential). An account the root does not host is left to discovery; a caller in a tenant scope only
   * restarts that tenant's accounts. Runs in the root's async context, not the caller's.
   */
  restartAccount(mailboxItemId: string): Promise<void>;
  /**
   * Waits for passes and restarts in flight, then stops the mailbox's lifecycle once if hosted for `tenantId`. Discovery
   * skips trashed Mailboxes items and accounts with Mail switched off, so a later pass does not host it again.
   */
  stopMailbox(tenantId: string, mailboxItemId: string): Promise<void>;
}

interface HostedEntry {
  mailboxItemId: string;
  tenantId: string;
  lifecycle: MailAccountLifecycle;
  syncMode: SyncMode;
  heartbeat: ProcessHeartbeatHandle | null;
  /** The pass's `lifecycle.start()`, settled (never rejecting); a stop waits for it. */
  starting?: Promise<void>;
  /** Set by the `stopHosted` call that removed this entry; settles, never rejecting, once it stopped. */
  stopping?: Promise<void>;
}

/**
 * The mailsync composition root: hosts one lifecycle and one `mailsync:<id>` heartbeat per live mailbox of each active
 * tenant. A tenant whose discovery fails keeps its hosted lifecycles until a later pass succeeds. Lifecycles run in
 * their tenant's scope so their timers and sockets stay there. Restart-safe: state is rebuilt from persisted
 * `mail_account_sync_state`. Exactly one root per database is a deployment invariant; two would duplicate watchers.
 */
export function createMailLiveSyncRoot(
  pool: Pool,
  lifecycleFactory: MailLiveSyncLifecycleFactory,
  options: MailLiveSyncRootOptions = {},
): MailLiveSyncRoot {
  const discoveryIntervalMs = options.discoveryIntervalMs ?? 60_000;
  const hosted = new Map<string, HostedEntry>();
  let timer: NodeJS.Timeout | undefined;
  // Bumped by `stop()` and captured synchronously at the top of `start()`. A boolean is not enough: `start()` ->
  // `stop()` -> `start()` would set it again before the first call's await resumes, and it would schedule an interval.
  let generation = 0;

  // The pass most recently started by the interval, so `stop()` can wait for it. Never rejects.
  let inFlightDiscovery: Promise<unknown> = Promise.resolve();
  // Every pass and restart still running, as never-rejecting promises, so `stopTenant` and `stopMailbox` can wait.
  const runningPasses = new Set<Promise<void>>();
  // Entries whose stop is still running, so other stoppers wait for it instead of resolving ahead of it.
  const stoppingEntries = new Set<HostedEntry>();
  // Set synchronously (no await between check and set), so two un-awaited `start()` calls cannot both pass.
  let started = false;
  // `restartAccount` is called from a request's tenant scope and trace context, which lifecycles and heartbeats must
  // not inherit, so its work runs in the root's own context.
  const runInRootContext = AsyncLocalStorage.snapshot();

  interface DiscoveredAccount {
    tenantId: string;
    syncMode: SyncMode;
  }

  async function discoverActiveAccounts(): Promise<{
    active: Map<string, DiscoveredAccount>;
    failedTenants: Set<string>;
  }> {
    const active = new Map<string, DiscoveredAccount>();
    const failedTenants = new Set<string>();
    await forEachActiveTenant(pool, async (tenantId) => {
      // Merged only on success, so a tenant failing half-way never contributes a partial account list.
      const found = new Map<string, DiscoveredAccount>();
      try {
        let mailboxesDatabaseId: string | undefined;
        let cursor: string | null = null;
        do {
          const nextCursor = cursor;
          cursor = await withTransaction(pool, async (client) => {
            mailboxesDatabaseId ??= (await resolveMailModuleIds(client)).mailboxesDatabaseId;
            const page = await listItems(client, mailboxesDatabaseId, { cursor: nextCursor ?? undefined });
            for (const item of page.items) {
              // A failed statement aborts the whole transaction in Postgres; the savepoint keeps one bad account from
              // taking down the rest of the page.
              await client.query("SAVEPOINT discover_account");
              try {
                const provider = typeof item.properties.provider === "string" ? item.properties.provider : "generic";
                // Seeds state only for a first-seen account and never overwrites `syncMode`, so a user's
                // `setSyncMode` is read back from the row. The seed takes a non-waiting share lock on the live item:
                // `null` means trashed, gone or locked by a removal in flight, and leaves the account out of this pass,
                // as does Mail switched off.
                const state = await ensureMailAccountSyncStateOfLiveMailbox(client, {
                  itemId: item.id,
                  mailboxesDatabaseId,
                  syncMode: defaultSyncModeForProvider(provider),
                });
                if (state && state.syncPausedAt === null) found.set(item.id, { tenantId, syncMode: state.syncMode });
                await client.query("RELEASE SAVEPOINT discover_account");
              } catch (err) {
                // Reported before the rollback, so the original error surfaces even if the rollback throws.
                options.onLifecycleError?.(item.id, "discover", err);
                await client.query("ROLLBACK TO SAVEPOINT discover_account");
              }
            }
            return page.nextCursor;
          });
        } while (cursor);
      } catch (err) {
        // Isolated per tenant: the tenant is marked failed so its hosted lifecycles survive this pass.
        options.onLifecycleError?.("*", "discover", err);
        failedTenants.add(tenantId);
        return;
      }
      for (const [id, account] of found) active.set(id, account);
    });
    return { active, failedTenants };
  }

  /**
   * Stops `entry` once: callers pass entries from a snapshot of `hosted`, so an entry another caller removed is not
   * stopped again; the call waits for that stop instead. An entry still in `start()` is stopped after the start
   * settles, and its pass then installs no heartbeat.
   */
  function stopHosted(mailboxItemId: string, entry: HostedEntry): Promise<void> {
    if (entry.stopping) return entry.stopping;
    if (hosted.get(mailboxItemId) !== entry) return Promise.resolve();
    hosted.delete(mailboxItemId);
    stoppingEntries.add(entry);
    entry.stopping = (async () => {
      await entry.starting;
      entry.heartbeat?.stop();
      try {
        await runInTenant(entry.tenantId, () => entry.lifecycle.stop());
      } catch (err) {
        options.onLifecycleError?.(mailboxItemId, "stop", err);
      } finally {
        stoppingEntries.delete(entry);
      }
    })();
    return entry.stopping;
  }

  /** Stops already started for `tenantId` (all tenants when omitted), optionally narrowed to `mailboxItemId`. */
  function stopsInFlight(tenantId?: string, mailboxItemId?: string): Array<Promise<void>> {
    return [...stoppingEntries]
      .filter((entry) => tenantId === undefined || entry.tenantId === tenantId)
      .filter((entry) => mailboxItemId === undefined || entry.mailboxItemId === mailboxItemId)
      .map((entry) => entry.stopping ?? Promise.resolve());
  }

  function tracked(work: Promise<void>): Promise<void> {
    const forget = (): void => {
      runningPasses.delete(settled);
    };
    const settled = work.then(forget, forget);
    runningPasses.add(settled);
    return work;
  }

  function reconcileOnce(): Promise<void> {
    return tracked(runPass());
  }

  /** A start that fails is reported and leaves the entry hosted, so a later stop still reaches it. */
  async function host(mailboxItemId: string, tenantId: string, syncMode: SyncMode): Promise<void> {
    const lifecycle = lifecycleFactory({ mailboxItemId, syncMode });
    const entry: HostedEntry = { mailboxItemId, tenantId, lifecycle, syncMode, heartbeat: null };
    hosted.set(mailboxItemId, entry);
    const start = runInTenant(tenantId, () => lifecycle.start());
    entry.starting = start.then(
      () => {},
      () => {},
    );
    try {
      await start;
      // Retired while it started: its stop runs after this start, and a heartbeat installed now would outlive it.
      if (entry.stopping) return;
      entry.heartbeat = startProcessHeartbeat(
        pool,
        {
          process: mailSyncProcessName(mailboxItemId),
          pid: process.pid,
          version: process.env.APP_VERSION ?? "0.0.0",
        },
        { onError: (err) => options.onLifecycleError?.(mailboxItemId, "heartbeat", err) },
      );
    } catch (err) {
      options.onLifecycleError?.(mailboxItemId, "start", err);
    }
  }

  /** `callerTenantId` is the tenant scope the call came from, if any. */
  async function restartHosted(mailboxItemId: string, callerTenantId: string | undefined): Promise<void> {
    const existing = hosted.get(mailboxItemId);
    if (!existing) return;
    if (callerTenantId !== undefined && callerTenantId !== existing.tenantId) return;
    const myGeneration = generation;
    await stopHosted(mailboxItemId, existing);
    // `stop()` ran while the old lifecycle stopped: the root hosts nothing any more.
    if (generation !== myGeneration) return;
    // A pass hosted the account meanwhile; its lifecycle postdates this restart, so it is the replacement.
    const replacement = hosted.get(mailboxItemId);
    if (replacement) {
      await replacement.starting;
      return;
    }
    await host(mailboxItemId, existing.tenantId, existing.syncMode);
  }

  async function runPass(): Promise<void> {
    await runAsSystem("mail:liveSync", async () => {
      const { active, failedTenants } = await discoverActiveAccounts();

      for (const [mailboxItemId, { tenantId, syncMode }] of active) {
        const existing = hosted.get(mailboxItemId);
        if (existing && existing.syncMode === syncMode) continue;
        // New, or `syncMode` changed: the old lifecycle is retired first so an account never has two at once.
        if (existing) await stopHosted(mailboxItemId, existing);
        await host(mailboxItemId, tenantId, syncMode);
      }

      for (const [mailboxItemId, entry] of [...hosted]) {
        if (active.has(mailboxItemId) || failedTenants.has(entry.tenantId)) continue;
        await stopHosted(mailboxItemId, entry);
      }
    });
  }

  return {
    reconcileOnce,
    async restartAccount(mailboxItemId) {
      // Read in the caller's context, before the work moves to the root's.
      const caller = currentTenantScope();
      const callerTenantId = caller?.kind === "tenant" ? caller.tenantId : undefined;
      await runInRootContext(() =>
        runAsSystem("mail:liveSync", () => tracked(restartHosted(mailboxItemId, callerTenantId))),
      );
    },
    async stopTenant(tenantId) {
      await Promise.all([...runningPasses]);
      await Promise.all(
        [...hosted]
          .filter(([, entry]) => entry.tenantId === tenantId)
          .map(([mailboxItemId, entry]) => stopHosted(mailboxItemId, entry)),
      );
      await Promise.all(stopsInFlight(tenantId));
    },
    async stopMailbox(tenantId, mailboxItemId) {
      // An entry's `stop()` runs in its own tenant's scope, which cannot be entered from another tenant's: such a
      // caller would unhost the entry without stopping its lifecycle.
      const caller = currentTenantScope();
      if (caller?.kind === "tenant" && caller.tenantId !== tenantId) return;
      await Promise.all([...runningPasses]);
      const entry = hosted.get(mailboxItemId);
      if (entry?.tenantId === tenantId) await stopHosted(mailboxItemId, entry);
      await Promise.all(stopsInFlight(tenantId, mailboxItemId));
    },
    async start() {
      if (started) return;
      started = true;
      const myGeneration = generation;
      // The interval callback inherits the system scope through async context.
      await runAsSystem("mail:liveSync", async () => {
        try {
          await reconcileOnce();
        } catch (err) {
          // Otherwise every later `start()` would no-op at the guard. Only reset when nothing superseded this call.
          if (generation === myGeneration) started = false;
          throw err;
        }
        // Superseded by `stop()` during the initial reconcile: an interval now would leak.
        if (generation !== myGeneration) return;
        timer = setInterval(() => {
          // `clearInterval` does not stop a pass already running, which holds a pooled connection and writes sync
          // state; `stop()` awaits it so a shutdown or test TRUNCATE does not race it.
          inFlightDiscovery = reconcileOnce().catch((err) => options.onLifecycleError?.("*", "discover", err));
        }, discoveryIntervalMs);
        timer.unref?.();
      });
    },
    async stop() {
      generation++;
      started = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlightDiscovery;
      await Promise.all([...hosted].map(([mailboxItemId, entry]) => stopHosted(mailboxItemId, entry)));
      await Promise.all(stopsInFlight());
    },
  };
}
