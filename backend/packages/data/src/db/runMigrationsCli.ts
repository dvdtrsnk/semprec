import { createPool } from "./pool.js";
import { runMigrations } from "./migrate.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const pool = createPool(connectionString);
try {
  await runMigrations(pool);
} finally {
  await pool.end();
}
