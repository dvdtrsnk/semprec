import { createPool } from "./pool.js";
import { runSeed } from "./runSeed.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const pool = createPool(connectionString);
try {
  const outcome = await runSeed(pool);
  console.log(outcome === "created" ? "seed: created system databases" : "seed: already seeded");
} finally {
  await pool.end();
}
