import { register } from "node:module";

register(
  new URL("../../../../semprec-transcribe/src/__tests__/fixtures/workspaceDistResolver.mjs", import.meta.url),
  import.meta.url,
);
register(new URL("../../../src/__tests__/fixtures/liveVoiceWorkerResolver.mjs", import.meta.url), import.meta.url);
const { createPool, loadFullModuleRegistry, LocalFsBlobStorageWriter } = await import("@semprec/data");
const { wireRealtimeHooks } = await import("@semprec/realtime");
const { runAsSystem } = await import("@semprec/shared");
const { closeIdleThreadSessions } = await import("@semprec/agent-runtime");
const { createAgentRunTask, createRunAgentForHeartbeats } = await import("../../agentRunTasks.js");
const { createInFlightAgentRuns } = await import("../../inFlightAgentRuns.js");
const { createGatewayModel } = await import("../../modelComposition.js");
const { createAgentsQueueRuntime } = await import("../../queueRuntime.js");
const { createSempMessageTask } = await import("../../sempMessageTask.js");
const databaseUrl = process.env.BATCH32_GATEWAY_DATABASE_URL;
const gatewayPort = process.env.BATCH32_GATEWAY_PORT;
const files = process.env.FILES_STORAGE_DIR;
const mail = process.env.MAIL_ATTACHMENTS_DIR;
if (!databaseUrl || !gatewayPort || !/^\d{1,5}$/.test(gatewayPort) || !files || !mail)
  throw new Error("Invalid worker fixture configuration");
const port = Number(gatewayPort);
if (port < 1 || port > 65535) throw new Error("Invalid worker fixture port");
const pool = createPool(databaseUrl);
const role = await runAsSystem("test:voice-worker-role", () =>
  pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
    "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user",
  ),
);
if (role.rows.length !== 1 || role.rows[0]?.rolsuper !== false || role.rows[0]?.rolbypassrls !== false)
  throw new Error("Invalid worker runtime role");
wireRealtimeHooks(pool);
const registry = await loadFullModuleRegistry();
const gateway = createGatewayModel({
  AI_GATEWAY_BASE_URL: `http://127.0.0.1:${port}/internal/pi`,
  AI_GATEWAY_INTERNAL_TOKEN: "batch32-test-token",
  AGENT_MODEL: "claude-haiku-4-5",
});
const inFlight = createInFlightAgentRuns();
const runtime = await createAgentsQueueRuntime(pool, registry, {
  runAgent: createRunAgentForHeartbeats(pool, registry, gateway, inFlight),
  agentRunTask: createAgentRunTask(pool, registry, gateway, inFlight),
  delegatedAgentRunTask: createAgentRunTask(pool, registry, gateway, inFlight),
  sempMessageTask: createSempMessageTask(pool, registry, gateway, inFlight, {
    files: new LocalFsBlobStorageWriter(files),
    mailAttachments: new LocalFsBlobStorageWriter(mail),
  }),
});
process.send?.({ type: "ready" });
let stopping = false;
const deadline = setTimeout(() => {
  process.exitCode = 1;
  shutdown();
}, 120_000);
function shutdown(): void {
  if (stopping) return;
  stopping = true;
  clearTimeout(deadline);
  void (async () => {
    const failures: unknown[] = [];
    const observer = inFlight.observeSempSettlement();
    try {
      await runtime.stop();
    } catch (error) {
      failures.push(error);
    }
    try {
      failures.push(...(await observer.wait()));
    } catch (error) {
      failures.push(error);
    }
    try {
      await closeIdleThreadSessions(pool);
    } catch (error) {
      failures.push(error);
    }
    try {
      await pool.end();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      process.stderr.write("Voice worker fixture cleanup failed\n");
      process.exitCode = 1;
    }
    process.disconnect?.();
  })();
}
process.on("message", (message: unknown) => {
  if (
    typeof message !== "object" ||
    message === null ||
    Array.isArray(message) ||
    !("type" in message) ||
    message.type !== "stop" ||
    Object.keys(message).length !== 1
  )
    process.exitCode = 1;
  shutdown();
});
process.on("disconnect", shutdown);
