import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { escapeIdentifier, type Pool, type PoolClient } from "pg";
import yazl from "yazl";
import { CORE_TASK_NAMES, enqueueJob } from "@semprec/queue";
import { tenantBlobStorageKey } from "../blobs/blobsStore.js";
import { openBlobFromRoots } from "../blobs/openBlobFromRoots.js";
import { requireSingleRow, withTransaction } from "../db/pool.js";
import type { BlobStorageWriter } from "../mail/blobStorage.js";
import { forEachActiveTenant } from "./forEachActiveTenant.js";
import { logger } from "./logger.js";
import {
  deleteExpiredTenantExports,
  getTenantExportForUpdate,
  markTenantExportFailed,
  markTenantExportPending,
  markTenantExportReady,
  markTenantExportRunning,
  tenantExportJobKey,
} from "./tenantExportsStore.js";

/** Builds one tenant's export archive from the catalog-driven table set. */

/** Never exported: credential ciphertext, the wrapped tenant key, the exports themselves, and card-action responses (transient, 24 h). */
export const EXPORT_EXCLUDED_TABLES = [
  "external_credentials",
  "tenant_keys",
  "tenant_exports",
  "mail_oauth_states",
  "idempotent_responses",
] as const;

/** Written to `manifest.json`. */
const EXPORT_FORMAT_VERSION = 1;

const CURSOR_BATCH_ROWS = 500;

/** Both blob roots, since cross-root content-hash dedup can leave bytes in either. */
export interface TenantExportStorages {
  files: BlobStorageWriter;
  mailAttachments: BlobStorageWriter;
}

export interface TenantExportJobHelpers {
  abortSignal?: AbortSignal;
}

interface ManifestTable {
  name: string;
  file: string;
  rowCount: number;
}

/** Thrown between entries once the worker is shutting down; the handler queues the export again. */
class TenantExportInterruptedError extends Error {
  constructor() {
    super("Tenant export interrupted by worker shutdown");
    this.name = "TenantExportInterruptedError";
  }
}

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : typeof err;
}

/** Entries are added one at a time so no two read from the client at once; any failure surfaces once. */
class ArchiveWriter {
  private readonly zip = new yazl.ZipFile();
  private readonly output: Readable;
  private readonly written: Promise<{ byteSize: number }>;
  private readonly outputFinished: Promise<void>;
  private readonly writeFailed: Promise<never>;
  private currentSource: Readable | undefined;

  constructor(storage: BlobStorageWriter, storageKey: string) {
    const output = this.zip.outputStream;
    if (!(output instanceof Readable)) throw new Error("yazl's output stream is not a Readable");
    this.output = output;
    // Observe errors before writeStream can await storage initialization or a checkpoint can abort.
    this.outputFinished = finished(output);
    this.zip.on("error", (err: unknown) => {
      this.output.destroy(err instanceof Error ? err : new Error(String(err)));
    });
    this.written = storage.writeStream(storageKey, output);
    // Never resolves; rejects if storage or output fails. Each entry races against it.
    this.writeFailed = Promise.race([
      this.written.then(() => new Promise<never>(() => {})),
      this.outputFinished.then(() => new Promise<never>(() => {})),
    ]);
    // Marks the rejection handled until `addEntry`/`finish`/`abort` observe it; it is not dropped.
    this.writeFailed.catch(() => undefined);
  }

  async addEntry(name: string, source: Readable): Promise<void> {
    this.currentSource = source;
    this.zip.addReadStream(source, name);
    await Promise.race([finished(source), this.writeFailed]);
    this.currentSource = undefined;
  }

  /** Resolves with the stored size. */
  async finish(): Promise<number> {
    this.zip.end();
    const { byteSize } = await this.written;
    await this.outputFinished;
    return byteSize;
  }

  /** Stops the archive and settles output events and the storage write before the caller deletes the partial key. */
  async abort(cause: unknown): Promise<void> {
    this.currentSource?.destroy();
    this.output.destroy(cause instanceof Error ? cause : new Error(String(cause)));
    // The caller already caught and rethrows the original failure; settle both, including output errors
    // emitted before a pipeline attached.
    await Promise.allSettled([this.written, this.outputFinished]);
  }
}

/** `produce` runs lazily as yazl reads the entry. */
function lazySource(produce: () => AsyncGenerator<Buffer>): Readable {
  return Readable.from(produce(), { objectMode: false });
}

async function* accountEntry(client: PoolClient): AsyncGenerator<Buffer> {
  const { rows } = await client.query<{
    email: string;
    display_name: string | null;
    locale: string;
    role: string;
    created_at: Date;
  }>("SELECT email, display_name, locale, role, created_at FROM users WHERE tenant_id = app_current_tenant()");
  const user = rows[0];
  if (!user) throw new Error("The tenant in scope has no account to export");
  const account = {
    email: user.email,
    displayName: user.display_name,
    locale: user.locale,
    role: user.role,
    createdAt: user.created_at.toISOString(),
  };
  yield Buffer.from(JSON.stringify(account, null, 2));
}

/** One `to_jsonb` line per row of the tenant in scope, through a transaction-scoped cursor. */
async function* tableEntry(client: PoolClient, table: ManifestTable): AsyncGenerator<Buffer> {
  // `table.name` comes from `pg_class`, not from a caller, and is quoted by `escapeIdentifier`.
  await client.query(
    `DECLARE tenant_export_rows NO SCROLL CURSOR FOR
       SELECT to_jsonb(t)::text AS line FROM ${escapeIdentifier(table.name)} t WHERE t.tenant_id = app_current_tenant()`,
  );
  for (;;) {
    const { rows } = await client.query<{ line: string }>(`FETCH ${CURSOR_BATCH_ROWS} FROM tenant_export_rows`);
    if (rows.length === 0) break;
    table.rowCount += rows.length;
    yield Buffer.from(rows.map((row) => `${row.line}\n`).join(""));
  }
  await client.query("CLOSE tenant_export_rows");
}

async function exportedTables(client: PoolClient): Promise<string[]> {
  const { rows } = await client.query<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition
        AND obj_description(c.oid, 'pg_class') = 'semprec:tenancy=tenant'
      ORDER BY 1`,
  );
  const excluded: readonly string[] = EXPORT_EXCLUDED_TABLES;
  return rows.map((row) => row.relname).filter((name) => !excluded.includes(name));
}

interface ArchiveResult {
  storageKey: string;
  byteSize: number;
}

/** One snapshot for the whole archive; `signal` is checked before every entry. */
async function writeArchive(
  client: PoolClient,
  storages: TenantExportStorages,
  exportId: string,
  storageKey: string,
  signal: AbortSignal | undefined,
): Promise<ArchiveResult> {
  // The transaction's start time: the moment of the snapshot every entry reads.
  const { rows: clock } = await client.query<{ generated_at: Date }>("SELECT now() AS generated_at");
  const generatedAt = requireSingleRow(clock, "now()").generated_at.toISOString();
  const tables: ManifestTable[] = (await exportedTables(client)).map((name) => ({
    name,
    file: `tables/${name}.jsonl`,
    rowCount: 0,
  }));

  const archive = new ArchiveWriter(storages.files, storageKey);
  const checkpoint = (): void => {
    if (signal?.aborted) throw new TenantExportInterruptedError();
  };

  try {
    checkpoint();
    await archive.addEntry(
      "account.json",
      lazySource(() => accountEntry(client)),
    );

    for (const table of tables) {
      checkpoint();
      await archive.addEntry(
        table.file,
        lazySource(() => tableEntry(client, table)),
      );
    }

    let blobCount = 0;
    const missingBlobIds: string[] = [];
    await client.query(
      `DECLARE tenant_export_blobs NO SCROLL CURSOR FOR
         SELECT b.id, b.storage_key,
                EXISTS (SELECT 1 FROM mail_attachments m
                         WHERE m.blob_id = b.id AND m.tenant_id = app_current_tenant()) AS in_mail
           FROM blobs b WHERE b.tenant_id = app_current_tenant() ORDER BY b.id`,
    );
    for (;;) {
      const { rows } = await client.query<{ id: string; storage_key: string; in_mail: boolean }>(
        `FETCH ${CURSOR_BATCH_ROWS} FROM tenant_export_blobs`,
      );
      if (rows.length === 0) break;
      for (const blob of rows) {
        checkpoint();
        const storage = blob.in_mail ? storages.mailAttachments : storages.files;
        const alternate = blob.in_mail ? storages.files : storages.mailAttachments;
        // A reference selects the first root, but shared content-hash dedup can keep bytes in the other.
        const bytes = await openBlobFromRoots({ primary: storage, alternate, storageKey: blob.storage_key });
        if (!bytes) {
          missingBlobIds.push(blob.id);
          continue;
        }
        await archive.addEntry(`blobs/${blob.id}`, bytes);
        blobCount += 1;
      }
    }
    await client.query("CLOSE tenant_export_blobs");

    checkpoint();
    const manifest = {
      formatVersion: EXPORT_FORMAT_VERSION,
      exportId,
      generatedAt,
      tables,
      blobCount,
      missingBlobIds,
    };
    await archive.addEntry(
      "manifest.json",
      Readable.from([Buffer.from(JSON.stringify(manifest, null, 2))], { objectMode: false }),
    );
    return { storageKey, byteSize: await archive.finish() };
  } catch (err) {
    await archive.abort(err);
    throw err;
  }
}

/** Best effort: a failed delete leaves an unreachable file, since no row will point at it. */
async function deletePartialArchive(storage: BlobStorageWriter, exportId: string, storageKey: string): Promise<void> {
  try {
    await storage.delete(storageKey);
  } catch (err) {
    logger.error({ errorName: errorName(err), exportId }, "Deleting a partial tenant export archive failed");
  }
}

/**
 * Builds `payload.exportId` in one `repeatable_read` snapshot. On shutdown the partial archive is deleted and
 * the export requeued; on other failure it is deleted, the export marked `failed` and the error rethrown.
 */
export async function handleTenantExportTask(
  pool: Pool,
  storages: TenantExportStorages,
  payload: { exportId: string },
  helpers: TenantExportJobHelpers,
): Promise<void> {
  const { exportId } = payload;
  const status = await withTransaction(pool, async (client) => {
    const row = await getTenantExportForUpdate(client, exportId);
    if (!row || row.status !== "pending") return row?.status ?? "missing";
    await markTenantExportRunning(client, exportId);
    return "started";
  });
  if (status !== "started") {
    logger.info({ exportId, status }, "Skipping a tenant export that is not pending");
    return;
  }

  let storageKey: string | undefined;
  try {
    const archive = await withTransaction(
      pool,
      async (client) => {
        storageKey = await tenantBlobStorageKey(client, `exports/${exportId}.zip`);
        return writeArchive(client, storages, exportId, storageKey, helpers.abortSignal);
      },
      { isolation: "repeatable_read" },
    );
    await withTransaction(pool, (client) => markTenantExportReady(client, exportId, archive));
  } catch (err) {
    if (storageKey !== undefined) await deletePartialArchive(storages.files, exportId, storageKey);
    if (err instanceof TenantExportInterruptedError) {
      await requeueInterruptedExport(pool, exportId);
      return;
    }
    await markFailedPreservingCause(pool, exportId);
    throw err;
  }
}

/** One transaction; if it fails the export is marked `failed` so it cannot stay `running`. */
async function requeueInterruptedExport(pool: Pool, exportId: string): Promise<void> {
  try {
    await withTransaction(pool, async (client) => {
      await markTenantExportPending(client, exportId);
      await enqueueJob(
        client,
        CORE_TASK_NAMES.TENANT_EXPORT,
        { exportId },
        { jobKey: tenantExportJobKey(exportId), maxAttempts: 1 },
      );
    });
  } catch (err) {
    await markFailedPreservingCause(pool, exportId);
    throw err;
  }
  logger.info({ exportId }, "Tenant export interrupted by shutdown and queued again");
}

/** A failure to mark is logged, so the error that failed the export is the one that propagates. */
async function markFailedPreservingCause(pool: Pool, exportId: string): Promise<void> {
  try {
    await withTransaction(pool, (client) => markTenantExportFailed(client, exportId));
  } catch (markErr) {
    logger.error({ errorName: errorName(markErr), exportId }, "Marking a tenant export failed did not succeed");
  }
}

/** Per active tenant, deletes expired rows, then their archives after commit; storage failures are logged. */
export async function handleTenantExportExpirySweepTask(pool: Pool, filesStorage: BlobStorageWriter): Promise<void> {
  await forEachActiveTenant(pool, async (tenantId) => {
    const storageKeys = await withTransaction(pool, (client) => deleteExpiredTenantExports(client));
    for (const storageKey of storageKeys) {
      try {
        await filesStorage.delete(storageKey);
      } catch (err) {
        logger.error({ errorName: errorName(err), tenantId }, "Deleting an expired tenant export archive failed");
      }
    }
  });
}
