import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { restoreTenantKeys, RestoreStageUncertainError } from "./restoreTenantKeys.js";

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

async function readArchive(path: string): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  let result: Buffer | undefined;
  let failure: { value: unknown } | undefined;
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Invalid key archive");
    const buffer = Buffer.alloc(MAX_ARCHIVE_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const read = await handle.read(buffer, offset, buffer.length - offset, null);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset === 0 || offset > MAX_ARCHIVE_BYTES) throw new Error("Invalid key archive");
    result = buffer.subarray(0, offset);
  } catch (error) {
    failure = { value: error };
  }
  try {
    await handle.close();
  } catch (error) {
    throw new AggregateError(failure ? [failure.value, error] : [error], "Key archive cleanup failed", {
      cause: error,
    });
  }
  if (failure) throw failure.value;
  if (!result) throw new Error("Invalid key archive");
  return result;
}

async function main(): Promise<void> {
  const [archivePath, ...extra] = process.argv.slice(2);
  const {
    SEMPREC_RESTORE_ADMIN_URL: adminUrl,
    SEMPREC_RESTORE_TARGET_URL: targetUrl,
    SEMPREC_RESTORE_CONTAINER: container,
    SEMPREC_RESTORE_RECEIPT: receiptPath,
    SEMPREC_RESTORE_TARGET_ROLE: targetRole,
  } = process.env;
  if (
    !archivePath ||
    extra.length ||
    !adminUrl ||
    !targetUrl ||
    !container ||
    !receiptPath ||
    (targetRole !== undefined && targetRole !== "semprec_restore")
  ) {
    throw new Error("Invalid offline key restore configuration");
  }
  const archive = await readArchive(archivePath);
  const receipt = await open(
    receiptPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  let failure: { value: unknown } | undefined;
  let keepReceipt = false;
  try {
    await restoreTenantKeys({
      adminUrl,
      targetUrl,
      container,
      archive,
      ...(targetRole ? { targetRole } : {}),
      recordStage: async (name) => {
        await receipt.writeFile(`${name}\n`, "utf8");
        await receipt.sync();
      },
    });
  } catch (error) {
    failure = { value: error };
    if (error instanceof RestoreStageUncertainError) {
      keepReceipt = true;
    }
  }
  const cleanup: unknown[] = [];
  try {
    await receipt.close();
  } catch (error) {
    cleanup.push(error);
  }
  if (!keepReceipt) {
    try {
      await unlink(receiptPath);
    } catch (error) {
      cleanup.push(error);
    }
  }
  if (cleanup.length)
    throw new AggregateError(failure ? [failure.value, ...cleanup] : cleanup, "Restore receipt cleanup failed");
  if (failure) throw failure.value;
}

try {
  await main();
} catch {
  console.error("Offline key restore failed");
  process.exitCode = 1;
}
