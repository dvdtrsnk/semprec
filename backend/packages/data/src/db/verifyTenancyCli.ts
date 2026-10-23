import { createPool } from "./pool.js";
import { logger } from "./logger.js";
import { verifyTenancy } from "./tenancyInvariants.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const pool = createPool(connectionString);
try {
  process.exitCode = await verifyTenancy(pool, {
    info: (line) => console.log(line),
    error: (line) => console.error(line),
  });
} finally {
  // Guarded so a failing end never replaces the verification's own error or outcome.
  try {
    await pool.end();
  } catch (err) {
    const name = err instanceof Error ? err.name : typeof err;
    logger.error({ errName: name }, "Failed to end the tenancy verification pool");
  }
}
