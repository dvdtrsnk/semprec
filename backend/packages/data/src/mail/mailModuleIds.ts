import type { PoolClient } from "pg";
import { getDatabaseByModuleId } from "../chokePoint/databasesStore.js";
import { EMAILS_MODULE_ID, FOLDERS_MODULE_ID, MAILBOXES_MODULE_ID } from "../seed/emailModuleKeys.js";
import { FILES_MODULE_ID } from "../seed/tenDatabaseKeys.js";
import type { MailModuleIds } from "./mailSyncJob.js";

export type { MailModuleIds };

/**
 * Resolves the four seeded databases the mail sync jobs write into, by their `owner_module_id`.
 * Throws naming every missing module id (and the seed CLI) when the system seed has not run, so a
 * composition root fails at startup instead of every mail job failing at run time.
 */
export async function resolveMailModuleIds(client: PoolClient): Promise<MailModuleIds> {
  const missing: string[] = [];
  const resolve = async (moduleId: string): Promise<string> => {
    const database = await getDatabaseByModuleId(client, moduleId);
    if (database === null) missing.push(moduleId);
    return database?.id ?? "";
  };

  const ids: MailModuleIds = {
    emailsDatabaseId: await resolve(EMAILS_MODULE_ID),
    filesDatabaseId: await resolve(FILES_MODULE_ID),
    foldersDatabaseId: await resolve(FOLDERS_MODULE_ID),
    mailboxesDatabaseId: await resolve(MAILBOXES_MODULE_ID),
  };
  if (missing.length > 0) {
    throw new Error(
      `Mail module databases are not seeded (missing: ${missing.join(", ")}) — run packages/data/dist/db/runSeedCli.js`,
    );
  }
  return ids;
}
