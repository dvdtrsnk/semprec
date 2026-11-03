import type { Pool } from "pg";
import {
  createBoundedImapIdleLifecycleFactory,
  createImapFlowIdleTransport,
  createNoopMailLiveSyncLifecycleFactory,
  getDecryptedCredential,
  getItemById,
  getMailServerSettings,
  imapConnectionLimitForProvider,
  openImapFlow,
  resolveMailModuleIds,
  withTransaction,
  type CreateIdleTunedImapFlowClient,
  type MailLiveSyncAccount,
  type MailLiveSyncLifecycleFactory,
} from "@semprec/data";
import { logger } from "./logger.js";

export interface MailLiveSyncLifecycleDispatchOptions {
  pool: Pool;
  /**
   * The lifecycle factory of each sync mode this process hosts. A mode without an entry gets the noop lifecycle.
   */
  hosted: Partial<Record<MailLiveSyncAccount["syncMode"], MailLiveSyncLifecycleFactory>>;
}

/**
 * Dispatches on `account.syncMode` to the factory that hosts that mode, or to the noop lifecycle when none does
 * (issue #1550). The noop lifecycle's `start()` enqueues one sync, so an account in a mode with no hosted lifecycle
 * is still synced by the periodic sweep.
 */
export function createMailLiveSyncLifecycleFactory(
  options: MailLiveSyncLifecycleDispatchOptions,
): MailLiveSyncLifecycleFactory {
  const noop = createNoopMailLiveSyncLifecycleFactory(options.pool);
  return (account) => (options.hosted[account.syncMode] ?? noop)(account);
}

/**
 * The IMAP IDLE lifecycle of every IMAP account, hosted by this process (issue #196, hosted by #1550). Each
 * connection opens through `openImapFlow`, the address-checked connect step, with the mailbox's stored server
 * settings and the IDLE options (docs/adr/2026-10-29-imap-idle-connections-through-the-shared-imap-connect-step.md).
 * The transport never connects the client it receives; the `createClient` below is what opens it.
 */
export function createImapIdleLifecycleFactory(pool: Pool): MailLiveSyncLifecycleFactory {
  const createClient: CreateIdleTunedImapFlowClient = async (mailboxItemId, password, idleOptions) => {
    const settings = await getMailServerSettings(pool, mailboxItemId);
    const endpoint = settings?.imap ?? null;
    if (settings === null || endpoint === null) {
      throw new Error(`Mailbox ${mailboxItemId} has no IMAP server settings; set the IMAP host before syncing it`);
    }
    return openImapFlow({ endpoint, username: settings.username }, { password }, idleOptions);
  };
  return createBoundedImapIdleLifecycleFactory(pool, createImapFlowIdleTransport(createClient), {
    // Passed `pool`, not a transaction, as mailSyncJob.ts does: the access-log insert commits on its own.
    getCredential: async (mailboxItemId) => {
      const credential = await getDecryptedCredential(pool, {
        itemId: mailboxItemId,
        actorType: "sync_worker",
        purpose: "imap_idle",
      });
      if (credential === null) throw new Error(`Mailbox ${mailboxItemId} has no stored credential`);
      return credential;
    },
    getConnectionLimit: (mailboxItemId) => connectionLimitOf(pool, mailboxItemId),
    onError: (mailboxItemId) => {
      logger.warn({ mailboxItemId, stage: "idle", category: "failure" }, "IMAP IDLE lifecycle failed");
    },
  });
}

/** The account's IMAP connection budget, read the way mailSyncJob.ts reads it for its reconcile passes. */
export async function connectionLimitOf(pool: Pool, mailboxItemId: string): Promise<number> {
  const mailbox = await withTransaction(pool, async (client) => {
    const { mailboxesDatabaseId } = await resolveMailModuleIds(client);
    return getItemById(client, mailboxesDatabaseId, mailboxItemId);
  });
  // A mailbox that is gone takes the default budget; the live-sync root stops its lifecycle on the next pass.
  const provider = typeof mailbox?.properties.provider === "string" ? mailbox.properties.provider : undefined;
  return imapConnectionLimitForProvider(provider, mailbox?.properties.connectionLimit);
}

/** The only parts of a connection error the lifecycle logs: its name and, when it has one, its code. */
export function errorNameAndCode(err: unknown): { errorName: string; errorCode?: string } {
  const errorName = err instanceof Error ? err.name : "NonError";
  const code = typeof err === "object" && err !== null && "code" in err ? err.code : undefined;
  return typeof code === "string" ? { errorName, errorCode: code } : { errorName };
}
