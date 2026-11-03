import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Pool } from "pg";
import { MAX_RESTORE_LEDGER_BYTES, parseRestoreReplayLedger } from "./restoreReplayLedger.js";
import { validateRestoreLedger } from "./validateRestoreLedger.js";

async function readLedger(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let failure: { value: unknown } | undefined;
  let bytes: Buffer | undefined;
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Invalid restore ledger");
    const buffer = Buffer.alloc(MAX_RESTORE_LEDGER_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > MAX_RESTORE_LEDGER_BYTES) throw new Error("Invalid restore ledger");
    bytes = buffer.subarray(0, offset);
  } catch (error) {
    failure = { value: error };
  }
  try {
    await handle.close();
  } catch (error) {
    throw new AggregateError(failure ? [failure.value, error] : [error], "Restore ledger file cleanup failed", {
      cause: error,
    });
  }
  if (failure) throw failure.value;
  if (!bytes) throw new Error("Invalid restore ledger");
  return bytes;
}

async function main(): Promise<void> {
  const [mode, path, ...extra] = process.argv.slice(2);
  if ((mode !== "--file-only" && mode !== "--database") || !path || extra.length !== 0) {
    throw new Error("Invalid restore ledger command");
  }
  const tenantIds = parseRestoreReplayLedger(await readLedger(path));
  if (mode === "--file-only") return;
  if (!process.env.DATABASE_URL) throw new Error("Restore database is not configured");
  const targetRole = process.env.SEMPREC_RESTORE_TARGET_ROLE;
  if (targetRole !== undefined && targetRole !== "semprec_restore") throw new Error("Invalid restore target role");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ...(targetRole ? { options: `-c role=${targetRole}` } : {}),
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
  });
  let idleFailure: { value: unknown } | undefined;
  pool.on("error", (error: unknown) => {
    idleFailure ??= { value: error };
  });
  let failure: { value: unknown } | undefined;
  try {
    await validateRestoreLedger(pool, tenantIds);
  } catch (error) {
    failure = { value: error };
  }
  try {
    await pool.end();
  } catch (error) {
    throw new AggregateError(
      [...(failure ? [failure.value] : []), ...(idleFailure ? [idleFailure.value] : []), error],
      "Restore ledger pool cleanup failed",
      { cause: error },
    );
  }
  if (failure && idleFailure)
    throw new AggregateError([failure.value, idleFailure.value], "Restore ledger validation failed");
  if (failure) throw failure.value;
  if (idleFailure) throw idleFailure.value;
}

try {
  await main();
} catch {
  console.error("Restore ledger validation failed");
  process.exitCode = 1;
}
