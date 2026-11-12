import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool } from "pg";
import { currentTenantScope, runAsSystem, runInTenant } from "@semprec/shared";
import { withTransaction } from "../db/pool.js";
import { listItems } from "../chokePoint/itemsStore.js";
import { defaultSyncModeForProvider, ensureMailAccountSyncState, type SyncMode } from "./mailAccountSyncStateStore.js";
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
 * The unit this composition root hosts one-per-active-account: whatever a real transport
 * (issue #196's bounded IMAP IDLE, and Gmail/Graph push after it) needs to keep alive for as
 * long as the account stays active — a socket, a watch/subscription renewal timer, whatever.
 * Any signal it observes (EXISTS, a Pub/Sub push, a Graph notification) must be turned into a
 * call to `enqueueMailAccountSync` (mailSyncJob.ts) and nothing else: that entry point is
 * already the one idempotent, per-account-deduplicated (`jobKey`) reconcile path every sync
 * mode shares, so a lifecycle that ingested messages itself would create a second, parallel
 * ingestion path the issue's Task explicitly rules out ("Signals enter existing idempotent
 * reconcile, never parallel ingestion").
 */
export interface MailAccountLifecycle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type MailLiveSyncLifecycleFactory = (account: MailLiveSyncAccount) => MailAccountLifecycle;

/**
 * The default lifecycle for every sync mode until a real transport exists (issue #196+ supply
 * one factory per `SyncMode`, or a factory that dispatches on it) — this issue's Task is only
 * to host lifecycles, not to implement provider transports ("Provider transports/writeback
 * follow" is explicitly out of scope). `start` still does one useful thing on its own: it
 * enqueues an immediate reconcile through the existing idempotent job path so a newly
 * discovered/reactivated account doesn't have to wait for the periodic safety-net sweep
 * (mailSyncJob.ts's `handleMailAccountSyncSweepTask`) to pick it up. `stop` is a no-op because
 * there is no connection or timer of its own to release.
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
  /** How often re-discovery runs to pick up accounts (de)activated since the last pass. Defaults to 60s. */
  discoveryIntervalMs?: number;
  /**
   * A single hosted lifecycle failing (to start, to stop, or a discovery-time error reading
   * that one account's state) must not stop this root from hosting every other account — this
   * is the one place that failure surfaces, since `reconcileOnce` itself never rejects because
   * of it.
   */
  onLifecycleError?: (mailboxItemId: string, phase: "discover" | "start" | "stop" | "heartbeat", err: unknown) => void;
}

export interface MailLiveSyncRoot {
  /** Runs discovery once, then re-runs on `discoveryIntervalMs` until `stop()`. */
  start(): Promise<void>;
  /** Stops every currently hosted lifecycle and the discovery timer, and waits for every stop already running. */
  stop(): Promise<void>;
  /** One discovery pass, exposed directly so callers (tests, an explicit "reconcile now" trigger) don't have to wait on the interval. */
  reconcileOnce(): Promise<void>;
  /**
   * Waits for every discovery pass and every `restartAccount` in flight, then stops every hosted
   * lifecycle of `tenantId` through the same path a deactivated account takes. A lifecycle is
   * stopped once even when a pass started meanwhile retires it too, and the call resolves only
   * after that pass's stop of it finished. A second call for the same tenant finds nothing hosted
   * and does nothing. It does not stop a later pass from hosting the tenant again:
   * that is prevented by the tenant no longer being `active`, which discovery skips.
   */
  stopTenant(tenantId: string): Promise<void>;
  /**
   * Replaces the hosted lifecycle of one account (issue gh-1742): stops it through the same path a
   * deactivated account takes, then hosts a new one from the root's lifecycle factory for the same
   * tenant and sync mode, whether or not the old `start()` succeeded. The new lifecycle is created
   * after the call began, so its `start()` reads what the caller committed beforehand, such as a
   * replaced credential. Resolves once the new lifecycle started or its failed start was reported
   * through `onLifecycleError`.
   *
   * An account the root does not host is left alone: a discovery pass hosts it with a lifecycle
   * created then. That covers an account not discovered yet, one retired meanwhile, one whose
   * lifecycle another pass or restart is replacing at that moment, and every account after
   * `stop()`. A caller inside a tenant scope restarts only an account hosted for that tenant; any
   * other account is treated as not hosted.
   *
   * The work runs in the async context the root was created in, not in the caller's
   * (docs/adr/2026-11-11-mailbox-reauthorization-restarts-the-hosted-lifecycle-in-the-live-sync-roots-context.md).
   * When a discovery pass hosted the account while the old lifecycle stopped, that lifecycle is
   * kept and no second one is created. `stopTenant` waits for a restart in flight as it waits for
   * a pass, and a restart whose old lifecycle is still stopping when `stop()` runs hosts nothing.
   */
  restartAccount(mailboxItemId: string): Promise<void>;
  /**
   * Stops the lifecycle hosted for mailbox `mailboxItemId` when it is hosted for `tenantId` (issue
   * gh-2030). It first waits for every discovery pass and every `restartAccount` in flight, then
   * stops the entry through the same path a deactivated account takes. The lifecycle is stopped once
   * even when a pass started meanwhile retires it too, and the call resolves only after that stop
   * finished. A mailbox that is not hosted, or is hosted for another tenant, is left as it is, and
   * so is every mailbox when the caller is inside the scope of a tenant other than `tenantId`.
   *
   * It does not keep a later pass from hosting the mailbox again: a pass hosts what discovery
   * lists, and discovery lists no Mailboxes item that is in the trash. A `restartAccount` that
   * begins while this call waits is not waited for
   * (docs/adr/2026-11-11-a-removed-mailbox-is-cleaned-up-at-the-provider-from-memory-after-the-commit.md).
   */
  stopMailbox(tenantId: string, mailboxItemId: string): Promise<void>;
}

interface HostedEntry {
  mailboxItemId: string;
  tenantId: string;
  lifecycle: MailAccountLifecycle;
  syncMode: SyncMode;
  heartbeat: ProcessHeartbeatHandle | null;
  /** The pass's `lifecycle.start()`, settled (never rejecting) once it finished; a stop waits for it. */
  starting?: Promise<void>;
  /** Set by the `stopHosted` call that removed this entry; settles, never rejecting, once it stopped. */
  stopping?: Promise<void>;
}

/**
 * The mailsync composition root (issue #195): discovers, once per active tenant, the active
 * (non-deleted) rows in that tenant's Mailboxes database and hosts exactly one lifecycle per account for as long as it stays
 * active — deactivation (a soft-deleted Mailbox item, `deleted_at` set, the same signal
 * `listItems` already filters on by default) stops that account's lifecycle and nothing else.
 * Each hosted account also beats its own `mailsync:<id>` process heartbeat (`processHeartbeats.ts`)
 * for as long as it stays hosted, so `checkProcessHeartbeats` sees it as a live process rather
 * than a permanent `process_stale` alert.
 *
 * Discovery runs in a system scope and re-enters each active tenant in turn
 * (`forEachActiveTenant`); a tenant whose discovery fails is reported as `("*", "discover", err)`
 * and keeps its currently hosted lifecycles until a later pass succeeds for it. A lifecycle's
 * `start()` and `stop()` run inside its mailbox's tenant scope, so whatever it does later from
 * its own timers and sockets stays in that tenant; the per-account heartbeat beats in the
 * root's system scope. A tenant that is no longer active is not enumerated, so its lifecycles
 * stop on the next pass, or earlier through `stopTenant` when the tenant deactivation signal
 * reaches this process. A mailbox removed through `removeMailbox` is stopped by `stopMailbox`
 * when the removal's cleanup calls it, and otherwise on the next pass (issue gh-2030).
 *
 * Restart-safe by construction rather than by any explicit "am I already running" check: a
 * fresh process starts with an empty `hosted` map, and the only account state it ever reads is
 * whatever `mail_account_sync_state` already persisted (cursors, watch/subscription expiry via
 * `ensureMailAccountSyncState`, which never overwrites an existing row) — so restoring after a
 * restart is just discovery finding the same active accounts again and handing each one a
 * fresh lifecycle built from its already-persisted state, never resetting it. Running two
 * roots at once against the same database would duplicate watchers exactly like running two
 * copies of any other singleton worker would; avoiding that is a deployment invariant (run
 * exactly one), the same assumption `imapConnectionLimiter.ts`'s per-process limiter already
 * makes, not something this code can enforce on its own.
 */
export function createMailLiveSyncRoot(
  pool: Pool,
  lifecycleFactory: MailLiveSyncLifecycleFactory,
  options: MailLiveSyncRootOptions = {},
): MailLiveSyncRoot {
  const discoveryIntervalMs = options.discoveryIntervalMs ?? 60_000;
  const hosted = new Map<string, HostedEntry>();
  let timer: NodeJS.Timeout | undefined;
  // Bumped by `stop()` and captured synchronously at the top of `start()`, before the initial
  // `await reconcileOnce()`. A plain "already running" boolean isn't enough: `start()` -> `stop()`
  // -> `start()` would leave it set again by the time the first call's await resumes, so it would
  // schedule an interval anyway. Comparing the generation captured at entry against the current
  // one after the await catches that — a `stop()` in between means they no longer match.
  let generation = 0;

  // The discovery pass most recently started by the interval, so `stop()` can wait for it to
  // finish. Never rejects — the interval callback attaches its own handler before storing it.
  let inFlightDiscovery: Promise<unknown> = Promise.resolve();
  // Every `reconcileOnce` pass and every `restartAccount` still running, whoever started it, as a
  // promise that settles with it and never rejects, so `stopTenant` and `stopMailbox` can wait for
  // them. The promise of the pass or restart itself, and its rejection, still go to its caller.
  const runningPasses = new Set<Promise<void>>();
  // Every entry `stopHosted` has removed from `hosted` whose stop is still running, so `stopTenant`,
  // `stopMailbox` and `stop()` wait for a stop another caller started instead of resolving ahead of it.
  const stoppingEntries = new Set<HostedEntry>();
  // Guards against a second `start()` re-running the initial reconcile and scheduling a second
  // interval. Set synchronously at the top of `start()` (no `await` in between the check and the
  // set), so two un-awaited `start()` calls can't both observe it unset.
  let started = false;
  // The async context this root is created in, outside any request. `restartAccount` is called from
  // a request's tenant scope and trace context, which a lifecycle's timers and sockets and the
  // per-account heartbeat must not inherit, so it runs its work through this instead.
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
      // Collected per tenant and merged only on success, so a tenant failing half-way never
      // contributes a partial account list.
      const found = new Map<string, DiscoveredAccount>();
      try {
        // Resolved inside the first page's transaction, so a tenant costs one connection per page.
        let mailboxesDatabaseId: string | undefined;
        let cursor: string | null = null;
        do {
          const nextCursor = cursor;
          cursor = await withTransaction(pool, async (client) => {
            mailboxesDatabaseId ??= (await resolveMailModuleIds(client)).mailboxesDatabaseId;
            const page = await listItems(client, mailboxesDatabaseId, { cursor: nextCursor ?? undefined });
            for (const item of page.items) {
              // Each account's seed runs under its own SAVEPOINT: a failed statement aborts the
              // whole surrounding transaction in Postgres, so without this, one bad account would
              // poison the page's shared transaction and take every other account on it down too.
              await client.query("SAVEPOINT discover_account");
              try {
                const provider = typeof item.properties.provider === "string" ? item.properties.provider : "generic";
                // Never overwrites an existing row's `syncMode` (mailAccountSyncStateStore.ts) — this
                // only seeds state for an account discovered here for the first time; a user's
                // subsequent manual `setSyncMode` switch is picked up below because we read it back
                // from the row itself, not from `defaultSyncModeForProvider` again.
                const state = await ensureMailAccountSyncState(client, {
                  itemId: item.id,
                  syncMode: defaultSyncModeForProvider(provider),
                });
                found.set(item.id, { tenantId, syncMode: state.syncMode });
                await client.query("RELEASE SAVEPOINT discover_account");
              } catch (err) {
                // One account's state failing to read/seed must not drop every other account on this
                // page from the active set, and must not throw out of discovery entirely. Reported
                // before the rollback so the original error still surfaces even if the rollback itself throws.
                options.onLifecycleError?.(item.id, "discover", err);
                await client.query("ROLLBACK TO SAVEPOINT discover_account");
              }
            }
            return page.nextCursor;
          });
        } while (cursor);
      } catch (err) {
        // This tenant's failure is isolated: reported once, and the tenant is marked failed so its
        // hosted lifecycles survive this pass. Swallowing here is what keeps the other tenants
        // running and stops the helper from rethrowing.
        options.onLifecycleError?.("*", "discover", err);
        failedTenants.add(tenantId);
        return;
      }
      for (const [id, account] of found) active.set(id, account);
    });
    return { active, failedTenants };
  }

  /**
   * Stops `entry` once: callers pass entries from a snapshot of `hosted` (another pass's retire
   * loop, `restartAccount`, `stopTenant`, `stopMailbox`, `stop()`), so an entry another caller already
   * removed is not stopped again; the call instead waits for that caller's stop, if it is still running. An entry whose
   * `start()` is still running (an overlapping pass retired it) is stopped only after that start
   * settled, and the pass that started it then installs no heartbeat for it.
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

  /**
   * The stops another caller already started: of `tenantId`'s entries (every tenant's when omitted),
   * narrowed to the entries of `mailboxItemId` when it is given.
   */
  function stopsInFlight(tenantId?: string, mailboxItemId?: string): Array<Promise<void>> {
    return [...stoppingEntries]
      .filter((entry) => tenantId === undefined || entry.tenantId === tenantId)
      .filter((entry) => mailboxItemId === undefined || entry.mailboxItemId === mailboxItemId)
      .map((entry) => entry.stopping ?? Promise.resolve());
  }

  /** Registers `work` in `runningPasses` until it settles, and returns it unchanged. */
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

  /**
   * Hosts a new lifecycle for an account `hosted` holds no entry for, and waits for its `start()`.
   * A start that fails is reported and leaves the entry hosted, so a later stop still reaches it.
   */
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
      // Retired by an overlapping pass, a restart, `stopTenant` or `stop()` while it started: its
      // stop runs after this start, and a heartbeat installed now would outlive it.
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

  /** `restartAccount`'s work, run in the root's own context. `callerTenantId` is the tenant scope the call came from, if any. */
  async function restartHosted(mailboxItemId: string, callerTenantId: string | undefined): Promise<void> {
    const existing = hosted.get(mailboxItemId);
    if (!existing) return;
    if (callerTenantId !== undefined && callerTenantId !== existing.tenantId) return;
    const myGeneration = generation;
    await stopHosted(mailboxItemId, existing);
    // `stop()` ran while the old lifecycle stopped: the root hosts nothing any more.
    if (generation !== myGeneration) return;
    // A discovery pass hosted the account meanwhile. Its lifecycle was created after this restart
    // began, so it is the replacement; hosting another would be a second one.
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
        // Either newly active, or the user switched `syncMode` since the last pass — either way
        // the previous lifecycle (if any) no longer matches and is retired before the new one
        // starts, so an account never has two lifecycles hosted for it at once.
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
      // Read here, in the caller's context, before the work moves to the root's.
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
      // An entry's `stop()` runs in its own tenant's scope, which cannot be entered from another
      // tenant's: such a caller would unhost the entry without stopping its lifecycle.
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
      // The whole of `start()` runs in the system scope, so the interval callback it installs
      // inherits that scope through async context and every later discovery pass is system work too.
      await runAsSystem("mail:liveSync", async () => {
        try {
          await reconcileOnce();
        } catch (err) {
          // A failed initial reconcile must not leave `started` stuck `true` forever — that would
          // make every later `start()` call silently no-op at the guard check above. Only reset it
          // if nothing superseded this call in the meantime (a `stop()` already reset it itself,
          // and a `start()` after that `stop()` may have already set it back to `true`).
          if (generation === myGeneration) started = false;
          throw err;
        }
        // `stop()` bumped `generation` while this call was awaiting its initial reconcile —
        // scheduling here would install an interval nothing holds a reference to (the same leak
        // one step over), so skip it once superseded.
        if (generation !== myGeneration) return;
        timer = setInterval(() => {
          // Kept so `stop()` can await it: `clearInterval` cancels the *next* tick but has no
          // effect on a pass already running, and a discovery pass holds a pooled connection and
          // writes `mail_account_sync_state`. Without this, `stop()` resolves while that write is
          // still in flight — the caller believes the root is idle, then a shutdown closes the
          // pool underneath it, and a test's `resetDatabase()` TRUNCATE deadlocks against it.
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
