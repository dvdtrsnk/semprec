import { createPool } from "./pool.js";
import { formatSeedLines, runSeed, seedExitCode } from "./runSeed.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}
const args = process.argv.slice(2);
const unknownArgs = args.filter((arg) => arg !== "--strict");
if (unknownArgs.length > 0) {
  throw new Error(`Unknown argument(s): ${unknownArgs.join(" ")}; the only option is --strict`);
}

const pool = createPool(connectionString, { role: "semprec_data" });
try {
  const results = await runSeed(pool);
  for (const result of results) {
    for (const line of formatSeedLines(result)) console.log(line);
  }
  if (seedExitCode(results, args.includes("--strict")) !== 0) {
    console.error("seed: --strict: a system definition of an already seeded tenant differs from the seed");
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
