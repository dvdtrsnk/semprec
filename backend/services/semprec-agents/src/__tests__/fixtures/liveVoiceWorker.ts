import { register } from "node:module";
import type { PoolClient } from "pg";

register(
  new URL("../../../../semprec-transcribe/src/__tests__/fixtures/workspaceDistResolver.mjs", import.meta.url),
  import.meta.url,
);
register(new URL("../../../src/__tests__/fixtures/liveVoiceWorkerResolver.mjs", import.meta.url), import.meta.url);
const { createPool, loadFullModuleRegistry, LocalFsBlobStorageWriter } = await import("@semprec/data");
const { wireRealtimeHooks } = await import("@semprec/realtime");
const { currentTenantScope, runAsSystem } = await import("@semprec/shared");
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
const gateEnabled = process.env.BATCH32_REGISTRATION_GATE === "1";
let armed = false;
let held = false;
let aborted = false;
let claimed = false;
let releaseGate: (() => void) | undefined;
const gate = new Promise<void>((resolve) => {
  releaseGate = resolve;
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const observed = new Set<Promise<unknown>>();
const active = new Map<PoolClient, PropertyDescriptor | undefined>();
const restorationErrors: unknown[] = [];
const retirements: Promise<void>[] = [];
const retireClient = (client: PoolClient, error: unknown): void => {
  restorationErrors.push(error);
  try {
    retirements.push(
      client.end().then(
        () => {
          active.delete(client);
        },
        (endError: unknown) => {
          restorationErrors.push(endError);
        },
      ),
    );
  } catch (endError) {
    restorationErrors.push(endError);
  }
};
const onRelease = (_error: Error | undefined, client: PoolClient): void => {
  if (!active.has(client)) return;
  const descriptor = active.get(client);
  try {
    if (descriptor) Object.defineProperty(client, "query", descriptor);
    else if (!Reflect.deleteProperty(client, "query")) throw new Error("Cannot restore worker query descriptor");
    active.delete(client);
  } catch (error) {
    retireClient(client, error);
  }
};
pool.on("release", onRelease);
const instrument = (client: PoolClient): void => {
  if (!gateEnabled || !armed || active.has(client)) return;
  try {
    const queryDescriptor = Object.getOwnPropertyDescriptor(client, "query");
    active.set(client, queryDescriptor);
    /* eslint-disable @typescript-eslint/unbound-method */
    const query = client.query;
    let identity: { tenantId: string; messageId: string; runId: string; eventId: string } | undefined;
    client.query = new Proxy(query, {
      apply(target, receiver, args: unknown[]) {
        const result: unknown = Reflect.apply(target, receiver, args);
        if (result instanceof Promise) {
          observed.add(result);
          void result.finally(() => observed.delete(result)).catch(() => {});
        }
        if (typeof args[0] !== "string") return result;
        if (
          armed &&
          !claimed &&
          args[0] ===
            "UPDATE semp_messages SET agent_run_id = $2, event_from_id = $3::bigint, updated_at = now() WHERE id = $1 AND status = 'running'"
        ) {
          claimed = true;
          const values = args[1];
          const scope = currentTenantScope();
          if (
            !Array.isArray(values) ||
            values.length !== 3 ||
            typeof values[0] !== "string" ||
            !uuid.test(values[0]) ||
            typeof values[1] !== "string" ||
            !uuid.test(values[1]) ||
            typeof values[2] !== "string" ||
            !/^[1-9][0-9]*$/.test(values[2]) ||
            scope?.kind !== "tenant"
          ) {
            const invalid = Promise.resolve(result).then(() => {
              throw new Error("Invalid worker gate identity");
            });
            observed.add(invalid);
            void invalid.finally(() => observed.delete(invalid)).catch(() => {});
            return invalid;
          }
          const selected = { tenantId: scope.tenantId, messageId: values[0], runId: values[1], eventId: values[2] };
          const next = Promise.resolve(result).then((actual: unknown) => {
            if (typeof actual !== "object" || actual === null || !("rowCount" in actual) || actual.rowCount !== 1)
              throw new Error("Worker gate update did not affect one row");
            identity = selected;
            return actual;
          });
          observed.add(next);
          void next.finally(() => observed.delete(next)).catch(() => {});
          return next;
        }
        if (args[0] === "COMMIT" && identity && armed && !held) {
          const selected = identity;
          const next = Promise.resolve(result).then(async (actual: unknown) => {
            held = true;
            process.send?.({ type: "gateHeld", ...selected });
            await gate;
            return actual;
          });
          observed.add(next);
          void next.finally(() => observed.delete(next)).catch(() => {});
          return next;
        }
        return result;
      },
    });
    /* eslint-enable @typescript-eslint/unbound-method */
  } catch (error) {
    retireClient(client, error);
  }
};
pool.on("acquire", instrument);
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
      await Promise.allSettled([...observed]);
      const expires = Date.now() + 5000;
      while (active.size > 0 && Date.now() < expires) await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (active.size > 0) throw new Error("Worker observer clients did not settle");
      pool.off("acquire", instrument);
      pool.off("release", onRelease);
      await Promise.all(retirements);
      failures.push(...restorationErrors);
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
    Object.keys(message).length !== 1 ||
    JSON.stringify(message).length > 256
  ) {
    process.exitCode = 1;
    shutdown();
    return;
  }
  if (gateEnabled && message.type === "arm" && !armed && !held) {
    armed = true;
    void (async () => {
      const client = await runAsSystem("test:voice-worker-gate", () => pool.connect());
      try {
        if (!active.has(client) || restorationErrors.length > 0) throw new Error("Worker observer was not installed");
      } finally {
        client.release();
      }
      const expires = Date.now() + 5000;
      while (active.has(client) && Date.now() < expires) await new Promise<void>((resolve) => setTimeout(resolve, 10));
      if (active.has(client) || restorationErrors.length > 0) throw new Error("Worker observer did not restore");
      process.send?.({ type: "gateArmed" });
    })().catch((error: unknown) => {
      restorationErrors.push(error);
      process.stderr.write("Voice worker gate arm failed\n");
      process.exitCode = 1;
      shutdown();
    });
    return;
  }
  if (gateEnabled && message.type === "abort" && held && !aborted) {
    const count = inFlight.abortSemp();
    if (count > 0) aborted = true;
    process.send?.({ type: "gateAborted", count });
    return;
  }
  if (gateEnabled && message.type === "release" && held && aborted) {
    armed = false;
    releaseGate?.();
    process.send?.({ type: "gateReleased" });
    return;
  }
  if (message.type !== "stop") process.exitCode = 1;
  shutdown();
});
process.on("disconnect", shutdown);
