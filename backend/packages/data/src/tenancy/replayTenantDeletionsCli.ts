import { readFile, stat } from "node:fs/promises";
import { runAsSystem } from "@semprec/shared";
import { createPool } from "../db/pool.js";
import { parseTenantDeletionLedger } from "./tenantDeletionLedger.js";
import { replayTenantDeletions } from "./tenantPurgeJob.js";

// Operator procedure after a restore (deploy/README.md, "Re-applying account deletions after a
// restore"): `DATABASE_URL=… node replayTenantDeletionsCli.js <ledger file>`.
// Exit 0: nothing refused. Exit 1: a tenant was refused or the replay failed. Exit 2: bad input,
// nothing written.
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

async function readLedgerIds(path: string): Promise<string[]> {
  if ((await stat(path)).size > MAX_LEDGER_BYTES)
    throw new Error(`Ledger file is larger than ${MAX_LEDGER_BYTES} bytes`);
  return parseTenantDeletionLedger(await readFile(path, "utf8"));
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const args = process.argv.slice(2);
const ledgerPath = args[0];
let tenantIds: string[] | undefined;
if (args.length !== 1 || ledgerPath === undefined) {
  console.error("usage: replayTenantDeletionsCli <ledger file>");
} else {
  try {
    tenantIds = await readLedgerIds(ledgerPath);
  } catch (err) {
    console.error(`cannot use the ledger file: ${err instanceof Error ? err.message : "unreadable"}`);
  }
}

if (tenantIds === undefined) {
  process.exitCode = 2;
} else {
  const ids = tenantIds;
  const pool = createPool(connectionString);
  try {
    const result = await runAsSystem("tenantDeletionReplay", () => replayTenantDeletions(pool, ids));
    console.log(
      `marked ${result.marked.length}, alreadyDeleting ${result.alreadyDeleting.length}, ` +
        `absent ${result.absent.length}, refused ${result.refused.length}`,
    );
    for (const refused of result.refused) console.log(`refused ${refused.tenantId} (${refused.reason})`);
    if (result.refused.length > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
