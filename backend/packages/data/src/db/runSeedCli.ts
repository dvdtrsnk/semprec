import { createPool } from "./pool.js";
import { formatSeedLine, runSeed } from "./runSeed.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const pool = createPool(connectionString, { role: "semprec_data" });
try {
  for (const result of await runSeed(pool)) {
    console.log(formatSeedLine(result));
  }
} finally {
  await pool.end();
}
