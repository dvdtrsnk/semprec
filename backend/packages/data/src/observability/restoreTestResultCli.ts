import { runAsSystem } from "@semprec/shared";
import { createPool } from "../db/pool.js";
import { recordRestoreTestResult } from "./restoreTestResult.js";
import { parseRestoreTestResultArgs } from "./restoreTestResultArgs.js";

// Invoked by deploy/systemd/scripts/semprec-restore-test.sh (issue #178), which bounds this
// process with `timeout`; a non-zero exit tells the script the result was not recorded.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const result = parseRestoreTestResultArgs(process.argv.slice(2));
const pool = createPool(connectionString);
try {
  const { notificationIds } = await runAsSystem("restore-test-result", () => recordRestoreTestResult(pool, result));
  if (result.status === "failed" && notificationIds.length === 0) {
    console.error("restore test failure recorded, but no admin exists to notify");
  }
} finally {
  await pool.end();
}
