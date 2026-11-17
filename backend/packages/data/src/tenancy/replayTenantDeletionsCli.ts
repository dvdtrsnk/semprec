import { runReplayCommand } from "./replayTenantDeletionsCommand.js";

// Post-restore operator procedure (deploy/README.md): `DATABASE_URL=… node replayTenantDeletionsCli.js <ledger file>`.
process.exitCode = await runReplayCommand({
  args: process.argv.slice(2),
  databaseUrl: process.env.DATABASE_URL,
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line),
});
