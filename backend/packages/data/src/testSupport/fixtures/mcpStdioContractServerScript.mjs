#!/usr/bin/env node
// Minimal MCP stdio contract server (issue #231): spawned by `StdioClientTransport` as a real
// child process, so it can only report what it observed back to the test process via a file on
// disk (there's no shared memory across the process boundary). `argv[2]` names that file. It
// writes its own pid immediately, then again once `initialize`/`initialized` completes, this
// time including whichever env var the test told it (via `MCP_CONTRACT_CREDENTIAL_ENV_VAR`) to
// read the injected credential back from — so the test can assert the factory placed the
// decrypted credential exactly where `connectionConfig.credentialEnvVar` declared.
import { writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const recordFile = process.argv[2];
if (!recordFile) {
  console.error("mcpStdioContractServerScript: missing record file path argument");
  process.exit(1);
}

function writeRecord(record) {
  writeFileSync(recordFile, JSON.stringify(record));
}

writeRecord({ pid: process.pid, initialized: false });

const server = new Server({ name: "mcp-contract-stdio", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });

server.oninitialized = () => {
  const credentialEnvVar = process.env.MCP_CONTRACT_CREDENTIAL_ENV_VAR;
  const credential = credentialEnvVar ? (process.env[credentialEnvVar] ?? null) : null;
  writeRecord({ pid: process.pid, initialized: true, credential });
};

const transport = new StdioServerTransport();
await server.connect(transport);
