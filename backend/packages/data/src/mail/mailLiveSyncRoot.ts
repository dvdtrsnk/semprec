import type { Pool } from "pg";
import { withTransaction } from "../db/pool.js";
import { listItems } from "../chokePoint/itemsStore.js";
import { defaultSyncModeForProvider, ensureMailAccountSyncState, type SyncMode } from "./mailAccountSyncStateStore.js";
import { enqueueMailAccountSync } from "./mailSyncJob.js";

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
  onLifecycleError?: (mailboxItemId: string, phase: "discover" | "start" | "stop", err: unknown) => void;
}

export interface MailLiveSyncRoot {
  /** Runs discovery once, then re-runs on `discoveryIntervalMs` until `stop()`. */
  start(): Promise<void>;
  /** Stops every currently hosted lifecycle and the discovery timer. */
  stop(): Promise<void>;
  /** One discovery pass, exposed directly so callers (tests, an explicit "reconcile now" trigger) don't have to wait on the interval. */
  reconcileOnce(): Promise<void>;
}

interface HostedEntry {
  lifecycle: MailAccountLifecycle;
  syncMode: SyncMode;
}

/**
 * The mailsync composition root (issue #195): discovers active (non-deleted) rows in the
 * Mailboxes database and hosts exactly one lifecycle per account for as long as it stays
 * active — deactivation (a soft-deleted Mailbox item, `deleted_at` set, the same signal
 * `listItems` already filters on by default) stops that account's lifecycle and nothing else.
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
  mailboxesDatabaseId: string,
  lifecycleFactory: MailLiveSyncLifecycleFactory,
  options: MailLiveSyncRootOptions = {},
): MailLiveSyncRoot {
  const discoveryIntervalMs = options.discoveryIntervalMs ?? 60_000;
  const hosted = new Map<string, HostedEntry>();
  let timer: NodeJS.Timeout | undefined;

  async function discoverActiveAccounts(): Promise<Map<string, SyncMode>> {
    const active = new Map<string, SyncMode>();
    let cursor: string | null = null;
    do {
      const page = await withTransaction(pool, (client) => listItems(client, mailboxesDatabaseId, { cursor: cursor ?? undefined }));
      for (const item of page.items) {
        try {
          const provider = typeof item.properties.provider === "string" ? item.properties.provider : "generic";
          // Never overwrites an existing row's `syncMode` (mailAccountSyncStateStore.ts) — this
          // only seeds state for an account discovered here for the first time; a user's
          // subsequent manual `setSyncMode` switch is picked up below because we read it back
          // from the row itself, not from `defaultSyncModeForProvider` again.
          const state = await withTransaction(pool, (client) =>
            ensureMailAccountSyncState(client, { itemId: item.id, syncMode: defaultSyncModeForProvider(provider) }),
          );
          active.set(item.id, state.syncMode);
        } catch (err) {
          // One account's state failing to read/seed must not drop every other account on this
          // page from the active set, and must not throw out of discovery entirely.
          options.onLifecycleError?.(item.id, "discover", err);
        }
      }
      cursor = page.nextCursor;
    } while (cursor);
    return active;
  }

  async function stopHosted(mailboxItemId: string, entry: HostedEntry): Promise<void> {
    hosted.delete(mailboxItemId);
    try {
      await entry.lifecycle.stop();
    } catch (err) {
      options.onLifecycleError?.(mailboxItemId, "stop", err);
    }
  }

  async function reconcileOnce(): Promise<void> {
    const active = await discoverActiveAccounts();

    for (const [mailboxItemId, syncMode] of active) {
      const existing = hosted.get(mailboxItemId);
      if (existing && existing.syncMode === syncMode) continue;
      // Either newly active, or the user switched `syncMode` since the last pass — either way
      // the previous lifecycle (if any) no longer matches and is retired before the new one
      // starts, so an account never has two lifecycles hosted for it at once.
      if (existing) await stopHosted(mailboxItemId, existing);

      const lifecycle = lifecycleFactory({ mailboxItemId, syncMode });
      hosted.set(mailboxItemId, { lifecycle, syncMode });
      try {
        await lifecycle.start();
      } catch (err) {
        options.onLifecycleError?.(mailboxItemId, "start", err);
      }
    }

    for (const [mailboxItemId, entry] of [...hosted]) {
      if (active.has(mailboxItemId)) continue;
      await stopHosted(mailboxItemId, entry);
    }
  }

  return {
    reconcileOnce,
    async start() {
      await reconcileOnce();
      timer = setInterval(() => {
        reconcileOnce().catch((err) => options.onLifecycleError?.("*", "discover", err));
      }, discoveryIntervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      await Promise.all([...hosted].map(([mailboxItemId, entry]) => stopHosted(mailboxItemId, entry)));
    },
  };
}
