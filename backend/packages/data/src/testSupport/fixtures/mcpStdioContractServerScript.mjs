#!/usr/bin/env node
// Minimal MCP stdio contract server (issue #231): spawned by `StdioClientTransport` as a real
// child process, so it can only report what it observed back to the test process via a file on
// disk (there's no shared memory across the process boundary). `argv[2]` names that file. It
// writes its own pid immediately, then again once `initialize`/`initialized` completes, this
// time including whichever env var the test told it (via `MCP_CONTRACT_CREDENTIAL_ENV_VAR`) to
// read the injected credential back from — so the test can assert the factory placed the
// decrypted credential exactly where `connectionConfig.credentialEnvVar` declared.
//
// `handshakeCount` (not a boolean) matches `McpContractServer.getHandshakeCount()`'s documented
// contract of "how many handshakes completed" for the SSE/HTTP servers too: the record file is
// reused across however many times a test spawns a child against the same `connectionConfig`
// (connect, close, connect again), so this reads back whatever count the previous generation
// left behind and increments it, rather than a per-process boolean that a second spawn would
// silently reset to a fresh "1".
//
// `argv[3]` (issue #125) names a second file holding this run's `tools/list` answer — read once
// at startup, since `McpContractServer.setTools` (mcpContractServers.ts) can only rewrite that
// file before the *next* spawn, not reach into an already-running child.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const recordFile = process.argv[2];
if (!recordFile) {
  console.error("mcpStdioContractServerScript: missing record file path argument");
  process.exit(1);
}

const toolsFile = process.argv[3];
const tools = toolsFile && existsSync(toolsFile) ? JSON.parse(readFileSync(toolsFile, "utf8")) : [];

function readPreviousHandshakeCount() {
  if (!existsSync(recordFile)) return 0;
  try {
    const previous = JSON.parse(readFileSync(recordFile, "utf8"));
    return typeof previous.handshakeCount === "number" ? previous.handshakeCount : 0;
  } catch {
    return 0;
  }
}

let handshakeCount = readPreviousHandshakeCount();
// Kept alongside `handshakeCount` as module state (not read back from the record file) because
// `writeRecord` below always rewrites the whole file — every write must resupply whatever isn't
// changing this time, same as `credential` already had to.
let credential = null;
let lastToolCall = null;

function writeRecord(extra) {
  writeFileSync(recordFile, JSON.stringify({ pid: process.pid, handshakeCount, credential, lastToolCall, ...extra }));
}

writeRecord({});

const server = new Server(
  { name: "mcp-contract-stdio", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

// Same deterministic `tools/call` contract as the sse/http servers (mcpContractServers.ts) —
// duplicated here rather than imported, since this file runs as a standalone child process.
const FORCE_ERROR_ARG = "__forceError";
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const callArguments = request.params.arguments ?? {};
  lastToolCall = { name: request.params.name, arguments: callArguments };
  writeRecord({});
  if (callArguments[FORCE_ERROR_ARG] === true) {
    return { isError: true, content: [{ type: "text", text: "contract-server-forced-error" }] };
  }
  return { content: [{ type: "text", text: JSON.stringify({ name: request.params.name, arguments: callArguments }) }] };
});

server.oninitialized = () => {
  handshakeCount += 1;
  const credentialEnvVar = process.env.MCP_CONTRACT_CREDENTIAL_ENV_VAR;
  credential = credentialEnvVar ? (process.env[credentialEnvVar] ?? null) : null;
  writeRecord({});
};

const transport = new StdioServerTransport();
await server.connect(transport);
