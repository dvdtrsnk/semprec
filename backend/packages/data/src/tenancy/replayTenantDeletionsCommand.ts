import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Pool } from "pg";
import { runAsSystem } from "@semprec/shared";
import { createPool } from "../db/pool.js";
import { parseTenantDeletionLedger } from "./tenantDeletionLedger.js";
import { replayTenantDeletions } from "./tenantPurgeJob.js";

/** Largest ledger file the command reads: a ledger line is 37 bytes, so this holds over 200 000 ids. */
export const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

export interface ReplayCommandInput {
  args: readonly string[];
  databaseUrl: string | undefined;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  /** Opens the pool the replay runs on; the command always ends it. */
  openPool?: (connectionString: string) => Pool;
}

/** Reads a regular file of at most `MAX_LEDGER_BYTES` through one handle, so the cap holds for what is actually read. */
async function readLedgerFile(path: string): Promise<string> {
  // O_NONBLOCK so that opening a FIFO returns at once and is then refused by the type check below.
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("not a regular file");
    const buffer = Buffer.alloc(MAX_LEDGER_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_LEDGER_BYTES) throw new Error(`larger than ${MAX_LEDGER_BYTES} bytes`);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * The replay CLI's behaviour, returning its exit code: 0 when nothing was refused, 1 when a tenant
 * was refused or the replay failed, 2 for bad input (a missing `DATABASE_URL`, a wrong argument
 * count, an unusable or malformed ledger), in which case nothing is connected or written.
 */
export async function runReplayCommand(input: ReplayCommandInput): Promise<number> {
  const { args, databaseUrl, stdout, stderr, openPool = createPool } = input;
  if (!databaseUrl) {
    stderr("DATABASE_URL is not set");
    return 2;
  }
  const ledgerPath = args[0];
  if (args.length !== 1 || ledgerPath === undefined) {
    stderr("usage: replayTenantDeletionsCli <ledger file>");
    return 2;
  }
  let tenantIds: string[];
  try {
    tenantIds = parseTenantDeletionLedger(await readLedgerFile(ledgerPath));
  } catch (err) {
    stderr(`cannot use the ledger file: ${err instanceof Error ? err.message : "unreadable"}`);
    return 2;
  }

  const pool = openPool(databaseUrl);
  try {
    const result = await runAsSystem("tenantDeletionReplay", () => replayTenantDeletions(pool, tenantIds));
    stdout(
      `marked ${result.marked.length}, alreadyDeleting ${result.alreadyDeleting.length}, ` +
        `absent ${result.absent.length}, refused ${result.refused.length}`,
    );
    for (const refused of result.refused) stdout(`refused ${refused.tenantId} (${refused.reason})`);
    return result.refused.length > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}
