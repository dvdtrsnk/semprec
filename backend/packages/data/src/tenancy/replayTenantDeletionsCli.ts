import { runReplayCommand } from "./replayTenantDeletionsCommand.js";

// Operator procedure after a restore (deploy/README.md, "Re-applying account deletions after a
// restore"): `DATABASE_URL=… node replayTenantDeletionsCli.js <ledger file>`. Exit codes are
// documented on `runReplayCommand`.
process.exitCode = await runReplayCommand({
  args: process.argv.slice(2),
  databaseUrl: process.env.DATABASE_URL,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
